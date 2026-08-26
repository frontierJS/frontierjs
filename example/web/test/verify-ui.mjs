/**
 * web/test/verify-ui.mjs — drive the screens built from @frontierjs/ui's
 * BEHAVIOURAL components and assert what a user would see.
 *
 * `verify.mjs` is the framework drive: schema → API → UI, one claim per
 * assertion. This one is the kit drive. It exists because the things these
 * components add over `@frontierjs/css` — a roving tablist, a focus-trapped
 * dialog, a combobox, a command palette — are exactly the things a compile
 * test and a static render cannot reach, and 51 of the 63 components had
 * never been opened in a browser at all.
 *
 * Both servers must be running:
 *
 *   bun run api
 *   bun run web
 *   node web/test/verify-ui.mjs        # or: bun run verify:ui
 *
 * It signs in ONCE (login is rate-limited to 10 per 15 minutes), and it is
 * idempotent: every move it makes it makes on an order it created, and it
 * deletes that order at the end — including any left behind by a run that
 * threw before its cleanup.
 *
 * Run `verify.mjs` BEFORE this one if you run both: that drive counts the rows
 * in the orders table, and the delete here is one round trip behind.
 *
 * Harness rules, learned the hard way and repeated from verify.mjs: never
 * return a bare `null` from a probe (CDP omits `value`, so it reads back as
 * `undefined` — wrap it in an object), and never start an evaluated expression
 * with `return` on its own line (ASI turns it into `return;`).
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UI     = process.env.UI_URL  ?? 'http://localhost:8010'
const API    = process.env.API_URL ?? 'http://localhost:8110'
// The dev payment provider, started by `bun run api` beside the mail sink.
const PSP    = process.env.PSP_URL ?? 'http://localhost:8112'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

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

const profile = mkdtempSync(join(tmpdir(), 'fjs-verify-ui-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })

chrome.on('error', (e) => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })

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

async function evaluate(expression) {
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

/** Press a key through the input pipeline — a dispatched KeyboardEvent is not
 *  trusted and will not move focus or type into a field.
 *
 *  A printable key also needs `text`: keyDown alone moves nothing into the
 *  field, so a search box stays empty and the list "fails to filter" for a
 *  reason that has nothing to do with the component. */
async function key(k, code, keyCode, modifiers = 0) {
  const printable = k.length === 1 && modifiers === 0
  const base = {
    key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers,
    ...(printable ? { text: k, unmodifiedText: k } : {}),
  }
  // `keyDown` carrying `text` inserts the character by itself. Sending a
  // separate `char` event as well types everything TWICE — the query came out
  // as "oorrdd", which reads exactly like a component that cannot filter.
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

async function goto(path) {
  await cmd('Page.navigate', { url: UI + path })
  await evaluate(`
    if (document.readyState !== 'complete')
      await new Promise(r => window.addEventListener('load', r, { once: true }));
    return true;
  `)
  await evaluate(`return await waitFor(() => document.querySelector('#app .shell'))`)
}

const HELPERS = `
  window.waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('waitFor timed out: ' + fn.toString());
      await new Promise(r => setTimeout(r, 50));
    }
  };
  window.byText = (sel, text) =>
    [...document.querySelectorAll(sel)].find(el => el.textContent.trim().includes(text));
  window.click = (el) => { el.click(); return true };
`
await cmd('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS })

/**
 * Sign in from the header and wait for the level badge.
 *
 * Waits for the badge OR the header's error alert, because the failure that
 * actually happens is a 429: createAuthPlugin rate-limits login to 10 per 15
 * minutes, and this drive shares that window with `verify.mjs`, which signs in
 * twice per run. Waiting only for the badge turns that into
 * "waitFor timed out: () => byText('header .badge', 'level 5')", which reads
 * like a broken app rather than a limiter doing its job. Same check as
 * `verify.mjs` — change one, change both.
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
    if (problem.alert.includes('429')) {
      console.error(
        `\nSign-in was rate limited (HTTP 429).\n` +
        `Login allows 10 attempts per 15 minutes; this drive signs in once per run and\n` +
        `shares the window with \`bun run verify\`, which signs in twice. Wait, or restart\n` +
        `the API to reset the window.`
      )
      throw new Error('rate limited')
    }
    throw new Error(`sign-in failed: ${problem.alert}`)
  }
  await evaluate(`await waitFor(() => byText('header .badge', 'level ${level}')); return true;`)
}

const got = {}
const t = (name, value) => { got[name] = value }

try {
  // ─── sign in once, as admin ───────────────────────────────────────────
  await goto('/')
  await signIn('admin', 5)

  // Work on an order this drive creates, so a failed run cannot poison the
  // next one and the seeded orders keep their seeded state.
  const token = await evaluate(`return localStorage.getItem('shop_token')`)
  const auth  = { authorization: 'Bearer ' + token }

  // A run that threw before its cleanup leaves the row behind, and `reference`
  // is @unique — so the next run's create is a 500 that has nothing to do with
  // what is being tested. Clear it first rather than requiring `bun run reset`.
  const stale = await (await fetch(`${API}/api/orders?reference=ORD-UI-1`, { headers: auth })).json()
  for (const row of stale.data ?? [])
    await fetch(`${API}/api/orders/${row.id}`, { method: 'DELETE', headers: auth })

  const created = await (await fetch(`${API}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ reference: 'ORD-UI-1', status: 'pending', total: 9.5, customerId: 1 }),
  })).json()
  const orderId = created?.id ?? created?.data?.id
  if (!orderId) throw new Error('could not create the order this drive works on: ' + JSON.stringify(created))

  // ─── 1. Order detail — Breadcrumbs, Steps, Tabs, DropdownMenu, Modal ──
  await goto(`/orders/${orderId}/`)

  t('detail.heading', await evaluate(`
    await waitFor(() => document.querySelector('h1'));
    return document.querySelector('h1').textContent.trim();
  `))

  t('detail.breadcrumbs', await evaluate(`
    const nav = document.querySelector('nav[aria-label="Breadcrumb"]');
    return { items: [...nav.querySelectorAll('li')].map(li => li.textContent.trim()) };
  `))

  // The lifecycle is fields.status.enum minus the exits — and the CURRENT step
  // is the row's own status, marked with aria-current, not with a class.
  t('detail.steps', await evaluate(`
    return {
      labels:  [...document.querySelectorAll('.steps .step-label')].map(s => s.textContent.trim()),
      current: document.querySelector('.steps [aria-current="step"] .step-label')?.textContent.trim(),
    };
  `))

  // A tablist is a roving tabindex: exactly one tab is focusable, the rest are
  // -1, and ArrowRight moves both focus and selection.
  t('tabs.initial', await evaluate(`
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    return {
      labels:   tabs.map(x => x.textContent.trim()),
      selected: tabs.filter(x => x.getAttribute('aria-selected') === 'true').map(x => x.textContent.trim()),
      tabindex: tabs.map(x => x.tabIndex),
      panels:   [...document.querySelectorAll('[role="tabpanel"]')].filter(p => p.offsetParent !== null).length,
    };
  `))

  t('tabs.click', await evaluate(`
    byText('[role="tab"]', 'Moves').click();
    await waitFor(() => byText('[role="tab"]', 'Moves').getAttribute('aria-selected') === 'true');
    const shown = [...document.querySelectorAll('[role="tabpanel"]')].filter(p => p.offsetParent !== null);
    return { selected: 'Moves', shownPanels: shown.length, hasMoveButton: !!byText('[role="tabpanel"] button', 'pay') };
  `))

  await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]').focus(); return true`)
  await key('ArrowRight', 'ArrowRight', 39)
  t('tabs.arrowKey', await evaluate(`
    await waitFor(() => document.activeElement?.getAttribute('role') === 'tab');
    return {
      focused:  document.activeElement.textContent.trim(),
      selected: document.querySelector('[role="tab"][aria-selected="true"]').textContent.trim(),
    };
  `))

  // The actions menu is the transitions table again — the same list the Moves
  // tab renders, so a mismatch here is a component bug and not a data one.
  // Visible, not merely present. Every overlay in the kit fades in with
  // el.animate(..., { fill: 'forwards' }) from an {@attach}, and an attachment
  // used to run before the element was in the document — where that animation
  // never starts and the element paints at keyframe 0. A menu, a toast and the
  // palette were all fully transparent while every assertion about them passed
  // (`FJS-110`). Opacity is now part of the claim.
  t('menu.items', await evaluate(`
    document.querySelector('#order-actions').click();
    await waitFor(() => document.querySelector('[role="menu"]'));
    return {
      expanded: document.querySelector('#order-actions').getAttribute('aria-expanded'),
      items: [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(i => i.textContent.trim().split(/\\s+/)[0]),
      opacity: getComputedStyle(document.querySelector('[role="menu"]')).opacity,
    };
  `))

  // ─── 1b. The Payments tab ─────────────────────────────────────────────
  //
  // The order above is pending and nothing has been taken for it, which is the
  // empty state — asserted here because it is the state most screens get wrong
  // by rendering an empty list and saying nothing.
  t('payments.emptyState', await evaluate(`
    byText('[role="tab"]', 'Payments').click();
    await waitFor(() => byText('[role="tab"]', 'Payments').getAttribute('aria-selected') === 'true');
    return {
      said: !!document.querySelector('#no-payments'),
      rows: document.querySelectorAll('[data-payment]').length,
    };
  `))

  await key('Escape', 'Escape', 27)
  t('menu.escapeCloses', await evaluate(`
    await waitFor(() => !document.querySelector('[role="menu"]'), 3000).catch(() => {});
    return { open: !!document.querySelector('[role="menu"]') };
  `))

  // A move with no way back asks first. The dialog is a real <dialog>, so
  // "open" is the element's own state and Escape is the platform's.
  t('modal.opens', await evaluate(`
    byText('[role="tabpanel"] button', 'cancel').click();
    await waitFor(() => document.querySelector('dialog[open]'));
    const d = document.querySelector('dialog[open]');
    return {
      title: d.querySelector('h2').textContent.trim(),
      focusInside: d.contains(document.activeElement),
      body: d.textContent.replace(/\\s+/g, ' ').includes('no way back'),
    };
  `))

  t('modal.keepIt', await evaluate(`
    byText('dialog button', 'Keep it').click();
    await waitFor(() => !document.querySelector('dialog[open]'));
    return { open: !!document.querySelector('dialog[open]'), status: document.querySelector('.steps [aria-current="step"] .step-label')?.textContent.trim() };
  `))

  /*
   * Confirming runs the move, the record reloads, and ONE toast reports it —
   * first that the move is in flight, then how it went, in place.
   *
   * The node is marked while it is still the loading toast and looked for
   * again after it settles, because that is the only way to tell an update
   * from a remove-and-add: both look identical on screen, and only one of them
   * keeps the reader's place in the stack. `toasts.loading()` is the handle
   * FJS-119 added, and this is the drive it asked for.
   */
  t('modal.confirmRuns', await evaluate(`
    byText('[role="tabpanel"] button', 'cancel').click();
    await waitFor(() => document.querySelector('dialog[open]'));
    byText('dialog button', 'Yes,').click();
    await waitFor(() => !document.querySelector('dialog[open]'));
    const loading = await waitFor(() => document.querySelector('.toast'));
    const spun = !!loading.querySelector('.spinner');
    loading.dataset.mark = 'move';
    const settled = await waitFor(() => {
      const el = document.querySelector('.toast[data-mark=move]');
      return el && !el.querySelector('.spinner') ? el : null;
    });
    return {
      toast: !!document.querySelector('.toast'),
      startedWithSpinner: spun,
      settledInPlace: settled.classList.contains('success') || settled.classList.contains('danger'),
      // cancelled is not on the lifecycle, so no step is current any more
      current: { step: document.querySelector('.steps [aria-current="step"]') ? 'some' : null },
    };
  `))

  t('detail.afterCancel', await (async () => {
    const r = await (await fetch(`${API}/api/orders/${orderId}`, { headers: auth })).json()
    return r?.status ?? r?.data?.status ?? null
  })())

  // ─── 1c. A settled order, and a refund a PERSON performs ──────────────
  //
  // A second order, because the one above has to stay `pending` for the menu
  // and modal assertions. This one is taken through the real money path —
  // `payments.start` out to the provider on :8112, the shopper confirming
  // there, and the provider's signed webhook coming back — so what the panel
  // renders was written by a webhook and not by this drive.
  //
  // The API half is `verify:pay`'s, exhaustively. What is only reachable here
  // is the half a person does: seeing what was taken, and clicking Refund.
  const staleB = await (await fetch(`${API}/api/orders?reference=ORD-UI-2`, { headers: auth })).json()
  for (const row of staleB.data ?? [])
    await fetch(`${API}/api/orders/${row.id}`, { method: 'DELETE', headers: auth })

  const orderB = (await (await fetch(`${API}/api/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ reference: 'ORD-UI-2', status: 'pending', total: 24, customerId: 1 }),
  })).json())?.id

  const intent = await (await fetch(`${API}/api/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-service-method': 'start' },
    body: JSON.stringify({ orderId: orderB }),
  })).json()
  await fetch(`${PSP}/v1/intents/${intent.providerRef}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeeded' }),
  })

  await goto(`/orders/${orderB}/`)

  t('payments.settled', await evaluate(`
    await waitFor(() => document.querySelector('h1'));
    byText('[role="tab"]', 'Payments').click();
    await waitFor(() => document.querySelector('[data-payment]'));
    // The payment row and its EVENTS arrive separately. The row exists as soon
    // as the intent was started; the event is written by the provider's
    // webhook, which is a second HTTP round trip the confirm above only kicks
    // off — so waiting on the row alone read no events about one run in three
    // and reported the ledger as missing when it was merely later.
    await waitFor(() => document.querySelector('[data-payment] [data-events] li'), 5000)
      .catch(() => {});
    const row = document.querySelector('[data-payment]');
    return {
      rows:   document.querySelectorAll('[data-payment]').length,
      status: row.querySelector('.pill')?.textContent.trim(),
      amount: row.querySelector('[data-amount]')?.textContent.trim(),
      // The button only appears while something is left to give back.
      refundable: !!row.querySelector('[data-refund]'),
      events: row.querySelectorAll('[data-events] li').length,
    };
  `))

  // The order-level `refund` move warns that it is not the money — and only
  // because this order HAS a settled payment. Opened and closed without
  // running it: what is being asserted is the sentence, not the move.
  t('payments.moveIsNotMoney', await evaluate(`
    document.querySelector('#order-actions').click();
    await waitFor(() => document.querySelector('[role="menu"]'));
    byText('[role="menu"] [role="menuitem"]', 'refund').click();
    await waitFor(() => document.querySelector('#refund-not-money'), 3000).catch(() => {});
    const warned = !!document.querySelector('#refund-not-money');
    byText('[role="dialog"] button', 'Keep it')?.click();
    await waitFor(() => !document.querySelector('[role="dialog"]'), 3000).catch(() => {});
    return { warned };
  `))

  // And the refund itself, from the panel. The box is left blank, which is
  // what the service reads as "all of what is left".
  const refunded = await evaluate(`
    byText('[role="tab"]', 'Payments').click();
    await waitFor(() => document.querySelector('[data-refund]'));
    document.querySelector('[data-refund]').click();
    await waitFor(() => document.querySelector('#refund-amount'));
    document.querySelector('#refund-confirm').click();

    // The provider's webhook lands inside the request, so the reload the
    // handler does already holds the moved rows — waiting on the ROW rather
    // than on a toast, because a toast is a message and this is the claim.
    await waitFor(() => document.querySelector('[data-refunded]'), 15000);
    const row = document.querySelector('[data-payment]');
    return {
      payment:  row.querySelector('.pill')?.textContent.trim(),
      refunded: row.querySelector('[data-refunded]')?.textContent.trim(),
      events:   row.querySelectorAll('[data-events] li').length,
    };
  `)

  // The order's own status is asked of the API rather than read off the Steps:
  // `refunded` is filtered OUT of the lifecycle strip (it is an exit, not a
  // step), so there is deliberately no step to be current.
  refunded.order = (await (await fetch(`${API}/api/orders/${orderB}`, { headers: auth })).json())?.status
  t('payments.refunded', refunded)

  // ─── 2. Products — Combobox, MultiSelect, Slider, Pagination, EmptyState ──
  await goto('/products/')

  t('filters.present', await evaluate(`
    await waitFor(() => document.querySelectorAll('tbody tr').length);
    return {
      combobox:    !!document.querySelector('#f-name'),
      multiselect: !!document.querySelector('#f-status'),
      slider:      document.querySelectorAll('[role="slider"]').length,
      rows:        document.querySelectorAll('tbody tr').length,
    };
  `))

  // Picking one product by name narrows the table to it. The options are the
  // names that arrived, so the combobox cannot offer a product the API did not
  // return.
  t('combobox.filters', await evaluate(`
    const box = document.querySelector('#f-name');
    box.focus(); box.click();
    await waitFor(() => document.querySelector('[role="listbox"] [role="option"]'));
    const options = [...document.querySelectorAll('[role="listbox"] [role="option"]')].map(o => o.textContent.trim());
    document.querySelector('[role="listbox"] [role="option"]').click();
    await waitFor(() => document.querySelectorAll('tbody tr').length === 1);
    return { options, rows: document.querySelectorAll('tbody tr').length, first: document.querySelector('tbody td').textContent.trim() };
  `))

  t('filters.clear', await evaluate(`
    document.querySelector('#f-clear').click();
    await waitFor(() => document.querySelectorAll('tbody tr').length > 1);
    return { rows: document.querySelectorAll('tbody tr').length };
  `))

  // A filter that matches nothing is a different situation from an empty
  // catalogue, and the empty snippet says so.
  //
  // `retired` ALONE is not an empty filter: the catalogue seeds one retired
  // product on purpose, so that status matches exactly one row. The drive has
  // to ask for a combination that really is empty — an ACTIVE product's name
  // AND the retired status (FJS-260).
  t('emptyState.shows', await evaluate(`
    const name = document.querySelector('#f-name');
    name.focus(); name.click();
    await waitFor(() => document.querySelector('.fjs-combobox-panel [role="option"]'));
    byText('.fjs-combobox-panel [role="option"]', 'Junction Notebook').click();
    await waitFor(() => document.querySelectorAll('tbody tr').length === 1);

    const box = document.querySelector('#f-status');
    box.focus(); box.click();
    await waitFor(() => document.querySelector('.fjs-multiselect-panel [role="option"]'));
    byText('.fjs-multiselect-panel [role="option"]', 'retired').click();
    await waitFor(() => document.querySelector('.empty') || document.querySelectorAll('tbody tr').length === 0);
    return {
      title: document.querySelector('.empty-title, .empty h3, .empty p')?.textContent.trim() ?? null,
      hasAction: !!byText('.empty button', 'Clear filters'),
    };
  `))

  t('pagination.info', await evaluate(`
    document.querySelector('#f-clear').click();
    await waitFor(() => document.querySelectorAll('tbody tr').length > 1);
    const nav = document.querySelector('nav[aria-label="Pagination"], .pagination');
    return {
      present: !!nav,
      // 4 products, 10 per page — one page, and it says so rather than
      // offering a second one.
      pages:   nav ? [...nav.querySelectorAll('button, a')].map(b => b.textContent.trim()).filter(x => /^\\d+$/.test(x)) : [],
    };
  `))

  // ─── 3. Settings — Accordion, Switch, RadioGroup, NumberInput, Toast ──────
  await goto('/settings/')

  // AccordionItem is a native <details>/<summary>: the open state is the
  // element's own, so it survives with JavaScript disabled and needs no
  // aria-expanded to stay honest.
  t('settings.accordion', await evaluate(`
    await waitFor(() => document.querySelector('details.disclosure'));
    const items = [...document.querySelectorAll('details.disclosure')];
    return {
      sections:    items.map(d => d.querySelector('summary').textContent.trim()),
      openAtStart: items.filter(d => d.open).map(d => d.querySelector('summary').textContent.trim()),
    };
  `))

  t('settings.expand', await evaluate(`
    const item = [...document.querySelectorAll('details.disclosure')]
      .find(d => d.querySelector('summary').textContent.trim().startsWith('Lists'));
    item.querySelector('summary').click();
    await waitFor(() => item.open);
    return {
      expanded:    item.open,
      numberInput: !!document.querySelector('#p-per-page'),
      radiogroup:  !!document.querySelector('#p-status[role="radiogroup"]'),
    };
  `))

  // A switch is a checkbox with role="switch" — the state is native, so what a
  // screen reader announces and what the page does cannot drift.
  t('settings.switch', await evaluate(`
    const sw = document.querySelector('#p-dense');
    const before = sw.checked;
    sw.click();
    await waitFor(() => sw.checked !== before);
    return { role: sw.getAttribute('role'), toggled: sw.checked !== before };
  `))

  // Saving writes localStorage and says so with a toast.
  t('settings.save', await evaluate(`
    document.querySelector('#p-save').click();
    await waitFor(() => document.querySelector('.toast'));
    return {
      toast: document.querySelector('.toast').textContent.trim(),
      // Wait for the enter animation to finish rather than sampling mid-fade —
      // the claim is that it ends up visible, not that it is visible instantly.
      toastOpacity: await (async () => {
        const el = document.querySelector('.toast');
        await Promise.all(el.getAnimations().map(a => a.finished));
        return getComputedStyle(el).opacity;
      })(),
      stored: JSON.parse(localStorage.getItem('shop_prefs') ?? '{}').dense,
    };
  `))

  // ── The preferences document, edited as a document ───────────────────────
  //
  // The one screen here with no schema behind it, which is exactly the shape
  // <Json editable> is for. Two claims that nothing else in this repo makes:
  // that the tree and the form are editors of ONE object (edit the tree, the
  // spinner follows), and that a key the screen does not own is dropped OUT
  // LOUD rather than vanishing between two frames.
  t('settings.jsonTree', await evaluate(`
    const tree = document.querySelector('#prefs-doc');
    const at   = '[data-path=' + JSON.stringify('["perPage"]') + ']';
    const row  = tree.querySelector(at + ' .fjs-json-edit');
    row.click();
    // Scoped to the row on purpose: the root add row is always on screen, so
    // an unscoped input lookup answers that box and types into the wrong one.
    // (No backticks in here — this whole probe is a template literal.)
    await waitFor(() => tree.querySelector(at + ' input'));

    const box = tree.querySelector(at + ' input');
    box.value = '25';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // The spinner above is the other editor of the same object.
    await waitFor(() => document.querySelector('#p-per-page input, #p-per-page')?.value === '25');
    return {
      spinner: document.querySelector('#p-per-page input, #p-per-page')?.value,
      stillMono: !!tree.querySelector('code[language=json]'),
    };
  `))

  t('settings.jsonStray', await evaluate(`
    const tree = document.querySelector('#prefs-doc');
    // No disclosure to open — the add row is always on screen, which is the
    // one thing on an editable tree that says it can be written to.
    const [key, val] = tree.querySelectorAll('[data-add=root] input');
    key.value = 'notAThing';
    key.dispatchEvent(new Event('input', { bubbles: true }));
    val.value = '1';
    val.dispatchEvent(new Event('input', { bubbles: true }));
    tree.querySelector('[data-add=root] .fjs-json-confirm').click();

    await waitFor(() => [...document.querySelectorAll('.toast')].some(el => el.textContent.includes('Ignored')));
    return { said: true };
  `))

  // The theme has to change a TOKEN, and the class has to land on the root.
  //
  // Nothing asserted this before, and nothing could: Sierra's theme module set
  // `data-theme`, which `@frontierjs/css` reads nowhere, so this app shipped
  // its own applier and the framework's was dead code with no caller. The two
  // halves are separate questions — a class on the wrong element and a class
  // no stylesheet defines look identical from the outside.
  t('settings.themeApplies', await evaluate(`
    const root   = document.documentElement;
    const before = getComputedStyle(root).getPropertyValue('--color-primary').trim();

    const pick = [...document.querySelectorAll('#p-theme input[type=radio]')]
      .find(r => r.value === 'theme-forest');
    pick.click();
    document.querySelector('#p-save').click();
    await new Promise(r => setTimeout(r, 50));

    const after = getComputedStyle(root).getPropertyValue('--color-primary').trim();
    return {
      onRoot:   root.classList.contains('theme-forest'),
      // The one it replaced is gone — two theme classes at once is a question
      // about stylesheet order rather than about the setting.
      replaced: !root.classList.contains('theme-default'),
      changed:  before !== '' && after !== '' && before !== after,
      // It survives a reload, which is the <head> script's job and the reason
      // the key is in sierra.config.js rather than in this app's prefs bundle.
      stored:   localStorage.getItem('shop_theme'),
    };
  `))

  // Put it back, so the screens after this one are asserted on the theme every
  // other check in this file was written against.
  await evaluate(`
    [...document.querySelectorAll('#p-theme input[type=radio]')]
      .find(r => r.value === 'theme-default').click();
    document.querySelector('#p-save').click();
    return true;
  `)

  // The preference has to change something. Dense tables put .compact on every
  // table the app draws — assert it on a different screen, after a real
  // navigation (assigning location.href from an evaluated expression kills the
  // CDP target mid-call).
  await goto('/products/')
  t('settings.densityApplies', await evaluate(`
    await waitFor(() => document.querySelector('table'));
    return { compact: document.querySelector('table').classList.contains('compact') };
  `))

  // Currency is a preference with arithmetic behind it, so the assertion is
  // the NUMBER and not the glyph. A toggle that only swapped the symbol would
  // show one price as two different amounts, and asserting `£` alone would
  // pass against exactly that bug.
  await goto('/settings/')
  await evaluate(`
    [...document.querySelectorAll('#p-currency input[type=radio]')]
      .find(r => r.value === 'GBP').click();
    document.querySelector('#p-save').click();
    return true;
  `)
  await goto('/products/')
  t('settings.currencyApplies', await evaluate(`
    await waitFor(() => document.querySelectorAll('.product-row td').length);
    const cell = [...document.querySelectorAll('.product-row td')]
      .map(td => td.textContent.trim()).find(t => /[£$€]/.test(t));
    return { symbol: (cell.match(/[£$€]/) ?? [])[0], converted: !/28\.00/.test(cell) };
  `))

  // Back to the shop's own currency, so every screen after this is asserted in
  // the one the rest of this file was written against.
  await goto('/settings/')
  await evaluate(`
    [...document.querySelectorAll('#p-currency input[type=radio]')]
      .find(r => r.value === 'USD').click();
    document.querySelector('#p-save').click();
    return true;
  `)

  // ─── 4. Command palette — the global one ─────────────────────────────────
  //
  // Opened by CLICKING the header button first. ⌘K and the button are two
  // callers of one store and only the keyboard one was ever driven — which is
  // how the palette could be a full-screen invisible backdrop that swallowed
  // every click while this drive reported 26/26 (`FJS-110`). The user's report
  // was "clicking Search does nothing and the app freezes".
  await goto('/')
  t('palette.opensOnClick', await evaluate(`
    document.getElementById('palette-open').click();
    await waitFor(() => document.querySelector('.fjs-cp-panel'));
    // The enter animation is 120ms; wait for it to finish rather than sampling
    // mid-fade, and read the backdrop too — it is the thing that covers the page.
    await Promise.all(document.querySelector('.fjs-cp-panel').getAnimations().map(a => a.finished));
    const panel = document.querySelector('.fjs-cp-panel'), backdrop = document.querySelector('.fjs-cp-backdrop');
    const box = panel.getBoundingClientRect();
    return {
      panelOpacity:    getComputedStyle(panel).opacity,
      backdropOpacity: getComputedStyle(backdrop).opacity,
      // A backdrop that covers the page and shows nothing is the failure being
      // guarded against, so ask the page what is actually on top.
      topmostIsPalette: !!document.elementFromPoint(innerWidth / 2, 140)?.closest('.fjs-cp-panel'),
      hasSize: box.width > 200 && box.height > 100,
    };
  `))

  await key('Escape', 'Escape', 27)
  await evaluate(`await waitFor(() => !document.querySelector('.fjs-cp-panel'), 3000).catch(() => {}); return true`)

  await evaluate(`document.body.focus(); return true`)
  await key('k', 'KeyK', 75, 2 /* Ctrl */)

  t('palette.opensOnCtrlK', await evaluate(`
    await waitFor(() => document.querySelector('[role="dialog"] input, .fjs-cp-input, input[placeholder*="Search"]'));
    return { open: true, focused: document.activeElement.tagName };
  `))

  await key('o', 'KeyO', 79)
  await key('r', 'KeyR', 82)
  await key('d', 'KeyD', 68)
  // The typed VALUE is asserted alongside the result: if the harness fails to
  // deliver keystrokes, that shows up as a wrong query rather than as a
  // component that "does not filter".
  t('palette.filters', await evaluate(`
    const input = document.querySelector('.fjs-cp-input, [role="dialog"] input, input[placeholder*="Search"]');
    await waitFor(() => document.querySelectorAll('[role="option"]').length || document.querySelector('.fjs-cp-empty'));
    return {
      query:   input.value,
      options: [...document.querySelectorAll('[role="option"]')].map(o => o.textContent.trim().split('\\n')[0].trim()),
    };
  `))

  await key('Enter', 'Enter', 13)
  t('palette.runsCommand', await evaluate(`
    await waitFor(() => location.pathname !== '/');
    return { path: location.pathname, open: !!document.querySelector('.fjs-cp-panel, [role="dialog"] input') };
  `))

  // ─── clean up the order this drive created ───────────────────────────────
  await evaluate(`
    await fetch('/api/orders/${orderId}', {
      method: 'DELETE',
      headers: { authorization: 'Bearer ' + localStorage.getItem('shop_token') },
    });
    return true;
  `)

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
  'detail.heading':     'ORD-UI-1',
  'detail.breadcrumbs': { items: ['Orders', 'ORD-UI-1'] },

  // pending → paid → shipped. cancelled and refunded are exits, not stages.
  'detail.steps': { labels: ['pending', 'paid', 'shipped'], current: 'pending' },

  'tabs.initial': {
    labels:   ['Summary', 'Items', 'Moves', 'Payments', 'Raw record'],
    selected: ['Summary'],
    tabindex: [0, -1, -1, -1, -1], // roving tabindex: one stop for the whole strip
    panels:   1,                   // exactly one panel visible
  },
  'tabs.click':    { selected: 'Moves', shownPanels: 1, hasMoveButton: true },
  'tabs.arrowKey': { focused: 'Payments', selected: 'Payments' },

  // A pending order can be paid or cancelled — the schema's answer, reached
  // through a menu this time.
  'menu.items':         { expanded: 'true', items: ['pay', 'cancel'], opacity: '1' },
  'menu.escapeCloses':  { open: false },

  // ── The money, on the screen that spends it ──────────────────────────
  //
  // An order with nothing taken says so, and says it in the shop's words
  // rather than by rendering an empty list.
  'payments.emptyState':  { said: true, rows: 0 },

  // A settled payment: the provider's id, what it took, and what is still
  // refundable — which is arithmetic over two columns rather than a flag.
  'payments.settled':     { rows: 1, status: 'succeeded', amount: '$24.00', refundable: true, events: 1 },

  // The trap this whole panel exists to remove. `orders.refund` is a real move
  // and a legitimate one — a sale settled some other way — and it does not
  // touch the card. The confirmation says so, and only when there IS money to
  // be confused about.
  'payments.moveIsNotMoney': { warned: true },

  // A person clicks Refund, leaves the box blank meaning all of it, and the
  // provider's webhook is what moves every row.
  'payments.refunded':    { payment: 'refunded', refunded: '$24.00 of $24.00', events: 2, order: 'refunded' },

  'modal.opens':        { title: 'Confirm cancel', focusInside: true, body: true },
  'modal.keepIt':       { open: false, status: 'pending' },
  'modal.confirmRuns':  { toast: true, startedWithSpinner: true, settledInPlace: true, current: { step: null } },
  'detail.afterCancel': 'cancelled',

  // Ten rows and not thirteen: the page size is a preference, default 10.
  'filters.present':  { combobox: true, multiselect: true, slider: 2, rows: 10 },
  'combobox.filters': {
    options: [
      'FrontierJS Explorer Tee', 'FrontierJS Explorer Hoodie',
      'Junction Tee', 'Junction Hoodie', 'Junction Cap', 'Junction Camp Mug',
      'Junction Notebook', 'Junction Sticker Pack',
      'Litestone Tee', 'Litestone Hoodie', 'Litestone Cap', 'Litestone Camp Mug',
      'Litestone Tote',
    ],
    rows: 1, first: 'FrontierJS Explorer Tee',
  },
  'filters.clear':    { rows: 10 },
  'emptyState.shows': { title: 'No product matches those filters', hasAction: true },
  // Two pages: thirteen products at ten per page.
  'pagination.info':  { present: true, pages: ['1', '2'] },

  'settings.accordion': { sections: ['Appearance', 'Lists', 'Order notes'], openAtStart: ['Appearance'] },
  'settings.expand':    { expanded: true, numberInput: true, radiogroup: true },
  'settings.switch':    { role: 'switch', toggled: true },
  'settings.save':      { toast: 'Preferences saved', toastOpacity: '1', stored: true },
  'settings.jsonTree':  { spinner: '25', stillMono: true },
  'settings.jsonStray': { said: true },
  'settings.themeApplies': { onRoot: true, replaced: true, changed: true, stored: 'theme-forest' },
  'settings.densityApplies': { compact: true },
  'settings.currencyApplies': { symbol: '£', converted: true },

  'palette.opensOnClick': { panelOpacity: '1', backdropOpacity: '1', topmostIsPalette: true, hasSize: true },
  'palette.opensOnCtrlK': { open: true, focused: 'INPUT' },
  'palette.filters':      { query: 'ord', options: ['Orders', 'New order'] },
  'palette.runsCommand':  { path: '/orders/', open: false },

  'consoleErrors': [],
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
