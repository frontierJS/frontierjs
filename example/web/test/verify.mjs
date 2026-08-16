/**
 * web/test/verify.mjs — drive the app in a real browser and assert what happened.
 *
 * Unit tests cannot settle the claims this example makes. "The form is
 * generated from the schema", "the delete button appears only for an admin",
 * "the notes column is absent rather than blank" are all statements about what
 * a browser ends up showing after a router, a compiler, a JSON Schema registry
 * and an HTTP round trip have all had their turn. So this clicks.
 *
 * Both servers must already be running:
 *
 *   bun run api     # terminal 1 — Junction + Litestone on :8110
 *   bun run web     # terminal 2 — Sierra + Vite on :8010
 *   node web/test/verify.mjs
 *
 * Needs Chrome on PATH or $FJS_CHROME, same as the css package's harness.
 * Exits non-zero and prints what differed.
 *
 * One harness trap: NEVER return a bare `null` from a probe. CDP serialises it
 * as {type:'object', subtype:'null'} with no `value` key at all, so it reads
 * back as `undefined` and an assertion expecting null fails for a reason that
 * has nothing to do with the page. Nulls nested inside an object survive, so
 * wrap: `return { hint: … }`.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UI     = process.env.UI_URL  ?? 'http://localhost:8010'
const API    = process.env.API_URL ?? 'http://localhost:8110'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── preflight ────────────────────────────────────────────────────────────
// A 502 from Vite because the API is down produces a page full of plausible
// empty tables, which reads as a product failure. Say which process is missing.
for (const [name, url] of [['api (bun run api)', `${API}/api/health`], ['web (bun run web)', UI]]) {
  try {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.error(`Cannot reach ${name} at ${url} — ${e.message}`)
    process.exit(1)
  }
}

// ─── CDP ──────────────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'fjs-verify-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })

// Chrome prints the actual port on stderr — asking for 0 and reading it back is
// what keeps concurrent runs from fighting over 9222.
const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const t = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', (d) => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(t); resolve(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise((r) => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()

function send(socket, method, params = {}, sessionId) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 30000)
  })
}

const consoleErrors = []

browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.exceptionThrown')
    consoleErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
    consoleErrors.push(msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const { targetId } = await send(browser, 'Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send(browser, 'Target.attachToTarget', { targetId, flatten: true })

const cmd = (method, params) => send(browser, method, params, sessionId)

await cmd('Page.enable')
await cmd('Runtime.enable')

/** Evaluate in the page and return the value. Throws what the page threw. */
async function evaluate(expression) {
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

async function goto(path) {
  await cmd('Page.navigate', { url: UI + path })
  await evaluate(`
    if (document.readyState !== 'complete')
      await new Promise(r => window.addEventListener('load', r, { once: true }));
    return true;
  `)
  // The router mounts from a module script; #app has no children until it has.
  await evaluate(`return await waitFor(() => document.querySelector('#app .shell'))`)
    .catch(async () => {
      // waitFor is installed per-navigation below; on the very first call it is
      // not there yet, so fall back to an inline poll.
      await evaluate(`
        const t0 = Date.now();
        while (Date.now() - t0 < 8000) {
          if (document.querySelector('#app .shell')) return true;
          await new Promise(r => setTimeout(r, 40));
        }
        throw new Error('the app never mounted — #app .shell absent after 8s');
      `)
    })
  await installHelpers()
}

async function installHelpers() {
  await evaluate(`
    window.waitFor = async (fn, ms = 8000) => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('waitFor timed out: ' + fn);
        await new Promise(r => setTimeout(r, 40));
      }
    };
    window.byText = (sel, text) =>
      [...document.querySelectorAll(sel)].find(el => el.textContent.trim().includes(text));
    return true;
  `)
}

/**
 * Sign in from the header and wait for the level badge.
 *
 * Waits for the badge OR the header's error alert, because the failure that
 * actually happens is a 429: createAuthPlugin rate-limits login to 10 per 15
 * minutes and this file signs in twice per run, so the sixth run in a quarter
 * hour is refused. Waiting only for the badge turns that into
 * "waitFor timed out: () => byText('header .badge', 'level')", which reads like
 * a broken app rather than a limiter doing its job.
 */
async function signIn(who, level) {
  await evaluate(`
    byText('header button', 'Sign in (${who})').click();
    await waitFor(() => byText('header .badge', 'level') || document.querySelector('.alert.danger'));
    return true;
  `)
  const problem = await evaluate(`
    return { alert: document.querySelector('.alert.danger')?.textContent.trim() ?? null };
  `)
  if (problem.alert) {
    // The message is the SERVER's now — junction's client keeps the body of a
    // refusal rather than replacing it with the status — so this matches the
    // limiter's own sentence as well as the old "HTTP 429".
    if (/429|rate limit/i.test(problem.alert)) {
      console.error(
        `\nSign-in was rate limited (HTTP 429).\n` +
        `Login allows 10 attempts per 15 minutes and this drive signs in twice per run,\n` +
        `so roughly 5 runs in a quarter hour. Wait, or restart the API to reset the window.`
      )
      throw new Error('rate limited')
    }
    throw new Error(`sign-in failed: ${problem.alert}`)
  }
  await evaluate(`await waitFor(() => byText('header .badge', 'level ${level}')); return true;`)
}

// ─── the drive ────────────────────────────────────────────────────────────

const got = {}
const t = (label, value) => { got[label] = value }

try {
  // 1 ─ signed out
  await goto('/')
  t('home.heading', await evaluate(`return document.querySelector('h1').textContent.trim()`))
  t('home.signedOutAlert', await evaluate(`return !!byText('.alert.info', 'Signed out')`))
  t('nav.links', await evaluate(`return [...document.querySelectorAll('nav .navlink')].map(a => a.textContent.trim())`))
  t('nav.current', await evaluate(`return document.querySelector('nav [aria-current="page"]').textContent.trim()`))

  // 2 ─ public reads work with no session
  await goto('/products/')
  t('products.rows', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    return document.querySelectorAll('tbody tr').length;
  `))
  t('products.nullBarcode', await evaluate(`
    return [...document.querySelectorAll('tbody tr')].some(tr => tr.textContent.includes('null'));
  `))

  // 3 ─ notes column is ABSENT, not blank, for an anonymous caller
  await goto('/customers/')
  t('customers.headersAnon', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    return [...document.querySelectorAll('thead th')].map(th => th.textContent.trim());
  `))

  // 4 ─ orders list, delete disabled below level 5
  await goto('/orders/')
  t('orders.rows', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    return document.querySelectorAll('tbody tr').length;
  `))
  t('orders.statuses', await evaluate(`
    // Paired with the reference and sorted, for the reason in readMoves below.
    return [...document.querySelectorAll('tbody tr')]
      .map(tr => [tr.querySelector('code')?.textContent.trim(),
                  tr.querySelector('.pill')?.textContent.trim()])
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, status]) => status);
  `))

  // The Moves column is @@transitions read back through x-transitions — no list
  // of moves exists in the component. Read it as "name" or "name(disabled)" so
  // one assertion covers both which moves exist and which are offered.
  // NOTE the leading `(` on the same line as this backtick. Every use is
  // `return ${readMoves}`, and a `return` followed by a newline is a `return;`
  // — automatic semicolon insertion silently discards the value and the
  // assertion fails against `undefined` for a reason that has nothing to do
  // with the page.
  //
  // The Moves cell is found through its HEADER, not by position. It used to be
  // `td:nth-child(6)`, and adding a Tracking column ahead of it turned every
  // moves assertion into `[]` — which reads as "@@transitions stopped reaching
  // the browser", not as "the table grew a column". A drive should fail for the
  // reason it is testing.
  const readMoves = `(() => {
      const col = [...document.querySelectorAll('thead th')]
        .findIndex(th => th.textContent.trim() === 'Moves') + 1;
      // Sorted by reference. The table declares no order, and verify:jobs
      // re-creates a seeded order it cancels -- which gives that row a new id
      // and moves it to the end. These assertions are about which moves each
      // order offers, not about what order the rows arrived in.
      return [...document.querySelectorAll('tbody tr')].map(tr => ({
        ref:    tr.querySelector('code')?.textContent.trim(),
        status: tr.querySelector('.pill')?.textContent.trim(),
        moves:  [...tr.querySelectorAll('td:nth-child(' + col + ') button')]
                  .map(b => b.textContent.trim() + (b.disabled ? '(disabled)' : '')),
      })).sort((a, b) => a.ref.localeCompare(b.ref));
    })()`

  t('moves.anon', await evaluate(`return ${readMoves}`))

  t('orders.deleteDisabledAnon', await evaluate(`
    return [...document.querySelectorAll('tbody button.danger')].every(b => b.disabled);
  `))

  // 5 ─ sign in as admin, from the header
  await signIn('admin', 5)
  t('signedIn.badge', await evaluate(`return byText('header .badge', 'level').textContent.trim()`))
  t('moves.admin', await evaluate(`return ${readMoves}`))

  // An illegal move is a client error, not a 500 — nothing leaves `shipped`.
  t('moves.illegalStatus', await evaluate(`
    const res = await fetch('/api/orders/3', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Service-Method': 'pay',
        authorization: 'Bearer ' + localStorage.getItem('shop_token'),
      },
      body: '{}',
    });
    const body = await res.json();
    return { status: res.status, name: body.name };
  `))

  t('orders.deleteEnabledAdmin', await evaluate(`
    await waitFor(() => [...document.querySelectorAll('tbody button.danger')].some(b => !b.disabled));
    return [...document.querySelectorAll('tbody button.danger')].every(b => !b.disabled);
  `))

  // 6 ─ the guarded column appears for an admin — same page, same code
  await goto('/customers/')
  t('customers.headersAdmin', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    return [...document.querySelectorAll('thead th')].map(th => th.textContent.trim());
  `))
  t('customers.notesValue', await evaluate(`
    return document.querySelector('tbody tr td:nth-child(3)')?.textContent.trim() ?? null;
  `))

  // 7 ─ the generated form
  await goto('/orders/create/')
  t('form.controls', await evaluate(`
    await waitFor(() => document.querySelectorAll('form .field-group').length);
    return [...document.querySelectorAll('form .field-group')].map(g => {
      const el = g.querySelector('.field, input');
      return g.querySelector('label span').textContent.trim() + ':' +
             (el.tagName === 'SELECT' ? 'select' : el.type);
    });
  `))
  t('form.statusOptions', await evaluate(`
    return [...document.querySelectorAll('[name="status"] option')].map(o => o.value).filter(Boolean);
  `))
  t('form.customerOptions', await evaluate(`
    await waitFor(() => document.querySelectorAll('[name="customerId"] option').length > 1);
    return [...document.querySelectorAll('[name="customerId"] option')].map(o => o.textContent.trim()).filter(x => x !== '—');
  `))
  t('form.referenceMaxLength', await evaluate(`return document.querySelector('[name="reference"]').maxLength`))
  t('form.totalMin', await evaluate(`return document.querySelector('[name="total"]').min`))

  // 7b ─ a relation key must arrive as null, not 0. `0` is a perfectly good
  // integer, so it passes coerce and validate and reaches SQLite as
  // FOREIGN KEY constraint failed / 500 — the required check never fires.
  t('form.customerStartsEmpty', await evaluate(`
    return document.querySelector('[name="customerId"]').value;
  `))

  // 7c ─ live validation. The rule is: on input an error may only be REMOVED.
  // Typing into an untouched field must not light up every other required one.
  const set = (sel, value) => `
    (() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`
  // Controls are selected by the NAME the schema gave them, not by an id the
  // page invented: <Form> generates its own field list now, so each control
  // makes its own unique id and there is no `f-<column>` convention to lean on.
  // The name is the better handle anyway — it is the thing the form routes a
  // message back to, and the thing the server sees.
  const hint = (sel) => `
    (() => {
      const g = document.querySelector(${JSON.stringify(sel)}).closest('.field-group');
      const h = g.querySelector('.field-hint.danger');
      return h ? h.textContent.trim() : null;
    })()`

  // Two characters into `reference` — too short, but nothing has been left yet.
  t('live.noErrorWhileTyping', await evaluate(`
    ${set('[name="reference"]', 'ab')};
    await new Promise(r => setTimeout(r, 60));
    return { reference: ${hint('[name="reference"]')}, customer: ${hint('[name="customerId"]')} };
  `))

  // Leave the field. NOW it may complain — and only it.
  t('live.errorOnLeave', await evaluate(`
    document.querySelector('[name="reference"]').dispatchEvent(new Event('blur'));
    await waitFor(() => ${hint('[name="reference"]')});
    return { reference: ${hint('[name="reference"]')}, customer: ${hint('[name="customerId"]')} };
  `))

  // Fix it. The message must go on the keystroke that fixes it — no blur needed.
  t('live.clearsOnInput', await evaluate(`
    ${set('[name="reference"]', 'abc')};
    await waitFor(() => ${hint('[name="reference"]')} === null);
    return { hint: ${hint('[name="reference"]')} };
  `))

  // Break it again: an already-revealed field may re-show. That is not
  // "adding on input" — the field is already speaking.
  t('live.reappearsOnceRevealed', await evaluate(`
    ${set('[name="reference"]', 'ab')};
    await waitFor(() => ${hint('[name="reference"]')});
    return { hint: ${hint('[name="reference"]')} };
  `))

  // Tabbing out of a field never typed in stays silent — submit reveals those.
  t('live.untypedStaysQuiet', await evaluate(`
    document.querySelector('[name="note"]').dispatchEvent(new Event('blur'));
    await new Promise(r => setTimeout(r, 60));
    return { hint: ${hint('[name="customerId"]')} };
  `))

  // Submit with the relation still unpicked: the browser must say so, by name,
  // rather than the server answering 500 FOREIGN KEY constraint failed.
  t('live.submitRevealsRelation', await evaluate(`
    ${set('[name="reference"]', 'ORD-LIVE-1')};
    byText('form button', 'Create order').click();
    await waitFor(() => ${hint('[name="customerId"]')});
    return { customer: ${hint('[name="customerId"]')}, stillOnForm: location.pathname };
  `))

  // 8 ─ fill it in and submit. Typing means dispatching the events Mesa binds to.
  await evaluate(`
    const set = (sel, value) => {
      const el = document.querySelector(sel);
      const proto = el.tagName === 'SELECT'
        ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('[name="reference"]', 'ord-cdp-1');
    set('[name="total"]', '42.5');
    set('[name="status"]', 'pending');
    set('[name="customerId"]', document.querySelectorAll('[name="customerId"] option')[1].value);
    // note deliberately left blank — it must store NULL, not ''
    return true;
  `)
  await evaluate(`
    byText('form button', 'Create order').click();
    await waitFor(() => location.pathname === '/orders/');
    return true;
  `)
  t('afterSubmit.path', await evaluate(`return location.pathname`))
  t('afterSubmit.row', await evaluate(`
    await waitFor(() => byText('tbody tr', 'ORD-CDP-1'));
    const tds = [...byText('tbody tr', 'ORD-CDP-1').querySelectorAll('td')].map(td => td.textContent.trim());
    return tds.slice(0, 5);
  `))

  // 9 ─ what actually landed in the database, over the API rather than the DOM
  const created = await (await fetch(`${API}/api/orders?reference=ORD-CDP-1`)).json()
  t('stored.record', (() => {
    const r = (created.data ?? [])[0]
    return r ? { reference: r.reference, total: r.total, note: r.note, status: r.status } : null
  })())

  // 9b ─ move the order this drive created, not a seeded one. Paying ORD-1001
  // would leave the database changed and the second run of this file would find
  // no `pay` button at all — a verification that only works once is not one.
  t('moves.afterPay', await evaluate(`
    const col = [...document.querySelectorAll('thead th')]
      .findIndex(th => th.textContent.trim() === 'Moves') + 1;
    const row = () => byText('tbody tr', 'ORD-CDP-1');
    const moves = () => [...row().querySelectorAll('td:nth-child(' + col + ') button')];
    const before = moves().map(b => b.textContent.trim());
    moves().find(b => b.textContent.trim() === 'pay').click();
    await waitFor(() => row().querySelector('.pill').textContent.trim() === 'paid');
    return {
      before,
      after:  moves().map(b => b.textContent.trim()),
      status: row().querySelector('.pill').textContent.trim(),
    };
  `))

  // 10 ─ delete it again as admin, then sign out and confirm the affordance drops
  t('afterDelete.gone', await evaluate(`
    const row = byText('tbody tr', 'ORD-CDP-1');
    row.querySelector('button.danger').click();
    await waitFor(() => !byText('tbody tr', 'ORD-CDP-1'));
    return true;
  `))
  // Sign back in one level down: `refund` carries @gate(5) and every other move
  // carries none, so this is the assertion that the gate is PER MOVE and not the
  // model's. signOut() navigates to '/', so come back before reading the table —
  // the home page has a table too, and reading THAT reports no moves at all for
  // a reason that has nothing to do with the machine.
  await evaluate(`
    byText('header button', 'Sign out').click();
    await waitFor(() => byText('header button', 'Sign in (user)'));
    return true;
  `)
  await signIn('user', 4)
  await goto('/orders/')
  t('moves.user', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    await waitFor(() => byText('header .badge', 'level 4'));
    return ${readMoves};
  `))

  t('signOut.deleteDisabled', await evaluate(`
    byText('header button', 'Sign out').click();
    await waitFor(() => byText('header button', 'Sign in (admin)'));
    await waitFor(() => [...document.querySelectorAll('tbody button.danger')].every(b => b.disabled));
    return true;
  `))

  t('consoleErrors', consoleErrors)
} catch (e) {
  console.error('\nThe drive threw:', e.message)
  console.error('collected so far:', JSON.stringify(got, null, 2))
  console.error('console errors:', consoleErrors)
  chrome.kill()
  await new Promise(r => chrome.on('close', r))
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  process.exit(1)
}

chrome.kill()
await new Promise(r => chrome.on('close', r))
rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })

// ─── assertions ───────────────────────────────────────────────────────────

const expected = {
  'home.heading':        'Kitchen sink',
  'home.signedOutAlert': true,
  'nav.links':           ['Home', 'Orders', 'New order', 'Products', 'Customers', 'Settings'],
  'nav.current':         'Home',

  'products.rows':        4,
  'products.nullBarcode': true,       // blankToNull kept a NULL out of a UNIQUE column

  // The whole point: for an anonymous caller the column is not in the table at
  // all, because it was not in the response at all.
  'customers.headersAnon':  ['Name', 'Email'],
  'customers.headersAdmin': ['Name', 'Email', 'Notes'],
  'customers.notesValue':   'Net-30. Always disputes shipping.',

  'orders.rows':               3,
  'orders.statuses':           ['pending', 'paid', 'shipped'],
  // Signed out, every move renders but none is offered: a transition is an
  // update, and the model's @@gate wants level 4 for that. `shipped` offers
  // nothing at any level, because nothing leaves `shipped`.
  'moves.anon': [
    { ref: 'ORD-1001', status: 'pending', moves: ['pay(disabled)', 'cancel(disabled)'] },
    { ref: 'ORD-1002', status: 'paid',    moves: ['ship(disabled)', 'refund(disabled)', 'cancel(disabled)'] },
    { ref: 'ORD-1003', status: 'shipped', moves: [] },
  ],
  'orders.deleteDisabledAnon': true,
  'moves.admin': [
    { ref: 'ORD-1001', status: 'pending', moves: ['pay', 'cancel'] },
    { ref: 'ORD-1002', status: 'paid',    moves: ['ship', 'refund', 'cancel'] },
    { ref: 'ORD-1003', status: 'shipped', moves: [] },
  ],
  // Paying re-grades the row: `pending` offered pay+cancel, `paid` offers
  // ship+refund+cancel. Nothing in the component knows that — the buttons come
  // from x-transitions, evaluated against the row's new state.
  'moves.afterPay': {
    before: ['pay', 'cancel'],
    after:  ['ship', 'refund', 'cancel'],
    status: 'paid',
  },
  // Was a 500 GeneralError until the Litestone error classes carried a status.
  'moves.illegalStatus': { status: 409, name: 'Conflict' },
  'orders.deleteEnabledAdmin': true,
  'signedIn.badge':            'alex@shop.test · level 5',

  // Five controls, none of them named in the component: four from the model's
  // own fields, plus the relation picker. `id` and `createdAt` are not offered.
  //
  // The LABELS are schema-derived as of 2026-08-06, which is why they are no
  // longer the raw column names. The page used to pass `label={name}` to every
  // control and `label={fk.relation}` to the picker; now it passes neither, and
  // a control inside <Form> resolves its own from the field rule — `@label`
  // where the schema declares one, the title-cased column name otherwise.
  // `Customer` rather than `Customer Id` is the whole point of `@label`, and it
  // was previously unreachable: every control passed its own nameToLabel() down
  // as an explicit label, so the schema's was shadowed and never seen.
  'form.controls': [
    'Reference:text', 'Status:select', 'Total:number', 'Note:text', 'Customer:select',
  ],
  'form.statusOptions':     ['pending', 'paid', 'shipped', 'refunded', 'cancelled'],
  'form.customerOptions':   ['Acme Corp', 'Globex'],
  'form.referenceMaxLength': 20,      // @length(3, 20)
  'form.totalMin':           '0',     // @gte(0)

  // make() must not invent customer #0 for an unpicked relation.
  'form.customerStartsEmpty': '',

  // Live validation: input may only remove an error, never reveal one.
  'live.noErrorWhileTyping':    { reference: null, customer: null },
  // The sentence is authored once in db/schema.lite and said by the browser,
  // the client-side check and the API alike — see @length(3, 20, "…") there.
  'live.errorOnLeave':          { reference: 'A reference is 3 to 20 characters, like ORD-1001', customer: null },
  'live.clearsOnInput':         { hint: null },
  'live.reappearsOnceRevealed': { hint: 'A reference is 3 to 20 characters, like ORD-1001' },
  'live.untypedStaysQuiet':     { hint: null },
  // @required("…") on customerId. Before it, this read "customerId is required"
  // under a form label that says "customer".
  'live.submitRevealsRelation': { customer: 'Please select a customer from the list', stillOnForm: '/orders/create/' },

  'afterSubmit.path': '/orders/',
  'afterSubmit.row':  ['ORD-CDP-1', 'pending', '42.5', '#1', '—'],

  // @upper uppercased it, coerce made 42.5 a number and not "42.5", and the
  // blank note stored as NULL rather than ''.
  'stored.record': { reference: 'ORD-CDP-1', total: 42.5, note: null, status: 'pending' },

  'afterDelete.gone':        true,
  // Level 4: everything except refund, which wants 5. The per-move gate.
  'moves.user': [
    { ref: 'ORD-1001', status: 'pending', moves: ['pay', 'cancel'] },
    { ref: 'ORD-1002', status: 'paid',    moves: ['ship', 'refund(disabled)', 'cancel'] },
    { ref: 'ORD-1003', status: 'shipped', moves: [] },
  ],
  'signOut.deleteDisabled':  true,
  'consoleErrors':           [],
}

let failed = 0
for (const [key, want] of Object.entries(expected)) {
  const have = got[key]
  const ok = JSON.stringify(have) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) {
    console.log(`         want ${JSON.stringify(want)}`)
    console.log(`         have ${JSON.stringify(have)}`)
  }
}

console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${Object.keys(expected).length} assertions passed`)
process.exit(failed ? 1 : 0)
