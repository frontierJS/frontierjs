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

// ─── Reading the ledger from node ─────────────────────────────────────────
//
// `Order` and `Customer` read at level 1 with a row policy apiece, so the
// assertions below that check what LANDED — as opposed to what the screen
// shows — need a caller. They used to ask anonymously and be answered, which
// is the leak those gates closed: the catalogue's `@@gate("0.4.4.5")` had been
// pasted onto the sales ledger.
let _staff = null
async function ledger(path) {
  _staff ??= (await (await fetch(`${API}/api/auth/login`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
  })).json())?.token
  return fetch(`${API}/api${path}`, { headers: { authorization: `Bearer ${_staff}` } })
}
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
  // The alert on screen BEFORE the click, because there may legitimately be
  // one: signing in from a page a stranger could not read leaves that page's
  // own 401 showing, and a helper that treats any `.alert.danger` as a failed
  // sign-in reports "Authentication required" about a sign-in that worked.
  const stale = await evaluate(`
    return document.querySelector('.alert.danger')?.textContent.trim() ?? null;
  `)
  await evaluate(`
    byText('header button', 'Sign in (${who})').click();
    await waitFor(() => byText('header .badge', 'level')
      || (document.querySelector('.alert.danger')?.textContent.trim() ?? null)
         !== ${JSON.stringify(stale)});
    return true;
  `)
  const problem = await evaluate(`
    const now = document.querySelector('.alert.danger')?.textContent.trim() ?? null;
    return { alert: now === ${JSON.stringify(stale)} ? null : now };
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
  // A price on this screen is a RANGE over the family's variants, which is the
  // one number no COLUMN holds — it is `@from(ProductVariant, min/max: price)`
  // on Product, answered by SQLite on the row. The list used to load every
  // variant in the shop to compute it here, so this assertion proved it read
  // two services; it now proves a derived column survives the whole crossing —
  // subquery, service, wire, table cell.
  t('products.priceRange', await evaluate(`
    return [...document.querySelectorAll('tbody tr td')].some(td => /\\$\\d+\\.\\d\\d–\\$\\d+\\.\\d\\d/.test(td.textContent));
  `))
  // `barcode String? @unique` moved to ProductVariant with the rest of the
  // buyable columns, and no screen edits a variant yet — so the claim it
  // carried is asked of the API here rather than deleted. SQLite accepts any
  // number of NULLs in a UNIQUE column and rejects a second '', which is why
  // blankToNull exists; every seeded variant leaves it unset, so a NULL that
  // had become '' would fail on the second row and there would be no
  // catalogue at all.
  //
  // Asked from NODE and not from inside the page. The page can only reach the
  // API through the dev server's proxy, and this same drive is run against the
  // BUILT site by verify-build.mjs, where the preview server serves dist/ and
  // proxies nothing — the app installs no CORS, so a cross-origin fetch from
  // the page is a `TypeError: Failed to fetch` that kills the run mid-way. The
  // drive has no such limit.
  t('products.manyNullBarcodes', await (async () => {
    const r = await (await fetch(`${API}/api/product-variants?$limit=200`)).json()
    return { nulls: r.data.filter(v => v.barcode === null).length,
             none:  r.data.every(v => v.barcode !== '') }
  })())

  // ─── Stale rows from a run that did not finish ──────────────────────────
  //
  // Step 8 creates ORD-CDP-1 through the form and step 10 deletes it. A run
  // that stopped in between leaves it behind, and the next run's create is
  // refused by `@unique` — the form stays put, the drive times out waiting for
  // a navigation, and it reports as *the create page is broken*. Every other
  // drive here sweeps its own references first; this one did not, because until
  // something went wrong in the middle it never had to.
  //
  // **Since `Order` declared `@@softDelete` the sweep has to look with
  // `$withDeleted` and RELEASE the value, not delete the row again.** A deleted
  // row keeps its `@unique` values — deliberately, or `restore()` would fail
  // whenever a stranger had taken the reference in the meantime — so step 10
  // now leaves ORD-CDP-1 held by a row no ordinary read returns, and a second
  // DELETE is a no-op against something already gone. Moving the value aside is
  // the documented way out of `SoftDeletedUniqueError`, and it is what makes
  // this drive repeatable rather than green-once-per-seed.
  for (const ref of ['ORD-CDP-1', 'ORD-LIVE-1']) {
    const stale = await (await ledger(`/orders?reference=${ref}&$withDeleted=true`)).json()
    for (const row of stale.data ?? []) {
      const freed = `${ref}-X${row.id}`.slice(0, 20)
      await fetch(`${API}/api/orders/${row.id}?$withDeleted=true`, {
        method:  'PATCH',
        headers: { authorization: `Bearer ${_staff}`, 'content-type': 'application/json' },
        body:    JSON.stringify({ reference: freed }),
      })
      // Live rows are then removed as before; an already-deleted one is done.
      if (!row.deletedAt) {
        await fetch(`${API}/api/orders/${row.id}`, {
          method: 'DELETE', headers: { authorization: `Bearer ${_staff}` },
        })
      }
    }
  }

  // 3 ─ a stranger reads no customers at all
  //
  // This used to assert the field-level policy from here — `notes` is
  // `@allow('read', auth().role == 'admin')`, so the column was ABSENT rather
  // than blank for an anonymous caller. That worked because `Customer` read at
  // level 0, which is the catalogue's gate on the shop's address book. The
  // field policy is still asserted, twice, at level 4 and level 5 — where the
  // rows exist and the difference is the one the policy is about.
  await goto('/customers/')
  t('customers.anonSeesNothing', await evaluate(`
    await waitFor(() => document.querySelector('tbody'));
    return {
      rows: [...document.querySelectorAll('tbody tr td:first-child')]
              .filter(td => !td.hasAttribute('colspan')).length,
      told: !!document.querySelector('.alert.danger, [data-empty], .empty-state, tbody td[colspan]'),
    };
  `))

  // 4 ─ orders list, delete disabled below level 5
  await goto('/orders/')
  // The SEEDED orders, and not every row in the table.
  //
  // This drive shares one database with the others, and two of them create real
  // orders as their whole point — `verify:jobs` sweeps one, `verify:cart`
  // checks a basket out. An exact row count made running the drives in sequence
  // a failure in whichever one ran second, reported as a transition defect. What
  // these assertions are about is the three orders the seed writes and the moves
  // each one offers, so they say so: `ORD-100x` and nothing else.
  // The tab, on a client navigation. `title: Orders` is in this route's own
  // frontmatter, and until FJS-389 the SPA never read it — every route of this
  // app showed index.html's one string, so a bookmark and a screen reader both
  // named the app instead of the page. The static target has always written a
  // real <title>; this is the half that was missing.
  t('orders.title', await evaluate(`
    await waitFor(() => document.title === 'Orders');
    return document.title;
  `))

  // ─── Signed out, the ledger is not there at all ─────────────────────────
  //
  // This used to assert the AFFORDANCES a stranger sees — every move button
  // rendered disabled, delete disabled — over a table full of real orders. That
  // was only ever possible because `Order` read at level 0, which is the
  // catalogue's gate pasted onto the sales ledger: every order in the shop was
  // answerable to `curl` with no token.
  //
  // The affordance assertions are still made, twice, at level 4 and level 5 —
  // which is where they belong, because `x-gate` is about what a signed-in
  // caller may do and a stranger is not a caller with fewer buttons. What a
  // stranger gets now is nothing, and the screen has to SAY so rather than
  // render an empty table that looks like a shop with no orders.
  t('orders.anonSeesNothing', await evaluate(`
    return {
      orders: [...document.querySelectorAll('tbody tr code')]
                .filter(c => /^ORD-/.test(c.textContent.trim())).length,
      told:   !!document.querySelector('.alert.danger, [data-empty], .empty-state, tbody tr td[colspan]'),
    };
  `))

  // …and everything below is a member of staff, because there is nothing to
  // read otherwise. Sign-in used to happen further down, which only worked
  // while a stranger could read the whole ledger.
  await signIn('admin', 5)
  t('signedIn.badge', await evaluate(`return byText('header .badge', 'level').textContent.trim()`))

  // Re-opened, because signing in does not re-run a load() that already
  // answered — the anonymous one answered NOTHING, which is the correct answer
  // to the question it asked. A person does this by clicking Orders again.
  await goto('/orders/')

  t('orders.rows', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    return [...document.querySelectorAll('tbody tr code')]
      .filter(c => /^ORD-100\\d$/.test(c.textContent.trim())).length;
  `))
  t('orders.statuses', await evaluate(`
    // Paired with the reference and sorted, for the reason in readMoves below.
    return [...document.querySelectorAll('tbody tr')]
      .map(tr => [tr.querySelector('code')?.textContent.trim(),
                  tr.querySelector('.pill')?.textContent.trim()])
      .filter(([ref]) => /^ORD-100\\d$/.test(ref ?? ''))
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
      })).filter(r => /^ORD-100\\d$/.test(r.ref ?? ''))
        .sort((a, b) => a.ref.localeCompare(b.ref));
    })()`

  // 5 ─ the affordances, as an administrator
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
  // Found through its HEADER, the lesson readMoves already carries: this used
  // to be `td:nth-child(3)`, and the Orders column that makes `@keep` visible
  // moved Notes one to the right — which would have read as "the field policy
  // stopped working" rather than "the table grew a column".
  t('customers.notesValue', await evaluate(`
    const col = [...document.querySelectorAll('thead th')]
      .findIndex(th => th.textContent.trim() === 'Notes') + 1;
    if (!col) return null;
    return document.querySelector('tbody tr td:nth-child(' + col + ')')?.textContent.trim() ?? null;
  `))

  // 7 ─ the generated form
  await goto('/orders/create/')
  t('form.controls', await evaluate(`
    await waitFor(() => document.querySelectorAll('form .field-group').length);
    return [...document.querySelectorAll('form .field-group')].map(g => {
      const el = g.querySelector('.field, input');
      // A picker is a text input that ANNOUNCES itself as a combobox, so
      // reporting its type alone would call it a plain text box — which is the
      // one thing it is not.
      return g.querySelector('label span').textContent.trim() + ':' +
             (el.tagName === 'SELECT' ? 'select'
              : el.getAttribute('role') === 'combobox' ? 'combobox'
              : el.type);
    });
  `))
  t('form.statusOptions', await evaluate(`
    return [...document.querySelectorAll('[name="status"] option')].map(o => o.value).filter(Boolean);
  `))
  // A picker is a SEARCHABLE select (`FJS-459`), so its rows are listbox
  // options that exist while it is open — not `<option>` elements sitting in
  // the document. Opening it is part of the assertion.
  t('form.customerOptions', await evaluate(`
    document.querySelector('[name="customerId"]').focus();
    await waitFor(() => document.querySelectorAll('[role="option"]').length > 1);
    // The seeded two. A checkout in verify:cart makes a real customer, which is
    // that drive working — this one is asserting that the picker is built from
    // the relation at all.
    const rows = [...document.querySelectorAll('[role="option"]')].map(o => o.textContent.trim())
      .filter(x => x === 'Acme Corp' || x === 'Globex');
    document.querySelector('[name="customerId"]').blur();
    return rows;
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
    // Not set(): writing an input's value and firing an input event types into
    // the search box, it does not CHOOSE a row. A picker's value is the option
    // the person clicked, which is the whole difference between the label on
    // screen and the id that gets written.
    const cb = document.querySelector('[name="customerId"]');
    cb.focus();
    await waitFor(() => document.querySelectorAll('[role="option"]').length > 0);
    document.querySelectorAll('[role="option"]')[0].click();
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
  const created = await (await ledger('/orders?reference=ORD-CDP-1')).json()
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

  // 9c ─ what the order was BILLED FOR, on the detail screen.
  //
  // ORD-1002 is a SEEDED order and is read by reference rather than by id: this
  // drive shares one database with the others and ids move. It has two lines on
  // purpose — a one-line order of one thing renders correctly whatever the
  // arithmetic does.
  const seeded = await (await ledger('/orders?reference=ORD-1002')).json()
  await goto(`/orders/${(seeded.data ?? [])[0]?.id}/`)
  t('order.items', await evaluate(`
    // Wait for the tab before clicking it. A goto() resolves on the ROUTE, and
    // the detail screen's tabs arrive with its first read — so an unguarded
    // click is a TypeError on undefined whenever the API is a beat slower than
    // the router, which reads as the tablist being broken.
    await waitFor(() => byText('[role="tab"]', 'Items'));
    byText('[role="tab"]', 'Items').click();
    await waitFor(() => document.querySelectorAll('#items-table tbody tr').length);
    return [...document.querySelectorAll('#items-table tbody tr')].map(tr =>
      [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
  `))

  // The lines add up to the SUBTOTAL, and the receipt adds up to the total —
  // two separate claims, and they became two the day shipping and tax arrived.
  // What the itemisation explains is the goods; what the card was charged is the
  // goods plus a delivery, less a code, plus somebody else's tax.
  //
  // Every figure is read off the SCREEN and compared against a number with
  // different provenance. The footer deliberately does not re-add the rows above
  // it: a sum of what is on screen can never disagree with what is on screen.
  //
  // ORD-1002 carries a code and a delivery method precisely so this assertion
  // has all four lines to add up — a seeded order with none of them would make
  // the two claims one claim again.
  t('order.itemsSum', await evaluate(`
    const num = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const raw = el.textContent.replace(/[^0-9.\\-−]/g, '').replace('−', '-');
      return raw ? Number(raw) : 0;
    };
    const lines = [...document.querySelectorAll('#items-table [data-line-total]')]
      .map(td => Number(td.textContent.replace(/[^0-9.]/g, '')));
    const sum      = Number(lines.reduce((n, v) => n + v, 0).toFixed(2));
    const subtotal = num('#items-subtotal');
    const discount = Math.abs(num('#items-discount') ?? 0);
    const shipping = num('#items-shipping') ?? 0;
    const tax      = num('#items-tax') ?? 0;
    const total    = num('#items-order-total');
    return {
      sum, subtotal,
      // The breakdown, added up here and compared to the figure the shop
      // stored. Free delivery renders as a word, so the shipping line parses
      // to 0 — which is the number it is.
      addsUp: Math.abs(subtotal - discount + shipping + tax - total) < 0.005,
      // A code on the receipt means the line is drawn and the wording is on it.
      discounted: discount > 0,
    };
  `))

  // And the order this drive raised BY HAND has none. A line is written by
  // `carts.checkout` at the moment of sale and by nothing else — `OrderLine` is
  // @@gate("0.8.8.8") and the service declares find and get — so the empty state
  // here is the feature working rather than the feature missing, and the page
  // says which.
  const raised = await (await ledger('/orders?reference=ORD-CDP-1')).json()
  await goto(`/orders/${(raised.data ?? [])[0]?.id}/`)
  t('order.itemsHandRaised', await evaluate(`
    await waitFor(() => byText('[role="tab"]', 'Items'));
    byText('[role="tab"]', 'Items').click();
    await waitFor(() => document.querySelector('#no-items'));
    return !!document.querySelector('#no-items');
  `))

  // Back to the list, and waited for: the delete below reads a row without one.
  await goto('/orders/')
  await evaluate(`await waitFor(() => byText('tbody tr', 'ORD-CDP-1')); return true;`)

  // 10 ─ delete it again as admin, then sign out and confirm the affordance drops
  //
  // Two clicks, because Delete asks first. The trigger opens a
  // ConfirmationPopover portaled to <body> — so the confirm button is NOT in
  // the row, and a `row.querySelector` for it finds nothing.
  t('afterDelete.gone', await evaluate(`
    const row = byText('tbody tr', 'ORD-CDP-1');
    row.querySelector('button.danger').click();
    await waitFor(() => document.querySelector('.popover button.danger'));
    document.querySelector('.popover button.danger').click();
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

  // The field policy, from the side that can see the rows. `notes` is
  // `@allow('read', auth().role == 'admin')`, so a member of staff at level 4
  // gets the column ABSENT rather than blank — stripped by the Data boundary,
  // with nothing in the component saying so. Admin's side of the same
  // assertion is `customers.headersAdmin` above.
  await goto('/customers/')
  t('customers.headersUser', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    return [...document.querySelectorAll('thead th')].map(th => th.textContent.trim());
  `))

  await goto('/orders/')
  t('moves.user', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    await waitFor(() => byText('header .badge', 'level 4'));
    return ${readMoves};
  `))

  // Signing out takes the ledger with it. This used to wait for every delete
  // button to be DISABLED, which a table with no rows in it satisfies without
  // deciding anything — `every()` over an empty list is true. What it says now
  // is that the rows are gone.
  t('signOut.ledgerGoes', await evaluate(`
    byText('header button', 'Sign out').click();
    await waitFor(() => byText('header button', 'Sign in (admin)'));
    await waitFor(() => [...document.querySelectorAll('tbody tr code')]
      .filter(c => /^ORD-/.test(c.textContent.trim())).length === 0);
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
  'nav.links':           ['Home', 'Orders', 'New order', 'Products', 'Customers', 'Basket', 'Settings'],
  'nav.current':         'Home',

  // TEN, not thirteen: the page size is a preference set on /settings/, and the
  // catalogue is now longer than one page of it.
  'products.rows':         10,
  'products.priceRange':   true,
  'products.manyNullBarcodes': { nulls: 43, none: true },

  // The whole point: for an anonymous caller the column is not in the table at
  // all, because it was not in the response at all.
  // A stranger reads no customers at all — the address book is not the
  // catalogue, and the screen says so rather than showing an empty table.
  'customers.anonSeesNothing': { rows: 0, told: true },
  // The field policy, both sides. `notes` is @allow('read', role == 'admin'),
  // so the column is ABSENT at level 4 and present at 5 — stripped at the Data
  // boundary, with nothing in the component saying so.
  // `Orders` is a @from count and is what makes `orders Order[] @keep` visible:
  // a removed customer still reads its real number. `Actions` is present for
  // both, because Customer is @@gate("1.4.4.5") — update is 4, so a USER may
  // edit and only an ADMINISTRATOR may remove, and the buttons say which.
  'customers.headersUser':  ['Name', 'Email', 'Orders', 'Actions'],
  'customers.headersAdmin': ['Name', 'Email', 'Orders', 'Notes', 'Actions'],
  'customers.notesValue':   'Net-30. Always disputes shipping.',

  'orders.title':              'Orders',
  'orders.rows':               3,
  'orders.statuses':           ['pending', 'paid', 'shipped'],
  // Signed out there is no ledger to render affordances over — `Order` reads at
  // level 1 with a row policy, so a stranger gets none of it and the screen
  // says so rather than showing an empty table. The affordance assertions are
  // below, at level 4 and level 5, which is where `x-gate` means anything.
  // One row, and it is the empty state — not an order. What matters is that
  // the screen tells the reader, rather than rendering a table that looks like
  // a shop with no orders in it.
  'orders.anonSeesNothing': { orders: 0, told: true },
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
  // Two lines, in the order they were written. Every cell is a COPY taken at
  // the moment of sale — editing the catalogue does not move them.
  'order.items': [
    ['Junction Camp Mug — Coal · one', 'JCT-MUG-COL-ONE', '1', '$18.00', '$18.00'],
    ['Junction Cap — Parchment · one', 'JCT-CAP-PCH-ONE', '1', '$24.00', '$24.00'],
  ],
  // The lines are the goods; the total is what the card was charged. ORD-1002
  // has a code and a delivery method on it, so the two are deliberately not the
  // same number — `verify:money` is where the arithmetic itself is proved.
  'order.itemsSum':         { sum: 42, subtotal: 42, addsUp: true, discounted: true },
  'order.itemsHandRaised':  true,

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
    // Customer is a `combobox`, not a `select`: a relation picker is a
    // searchable one, because the rows come from a service that caps them and
    // a native select cannot reach past the page it was handed (`FJS-459`).
    'Reference:text', 'Status:select', 'Total:number', 'Note:text', 'Customer:combobox',
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
  'signOut.ledgerGoes':      true,
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
