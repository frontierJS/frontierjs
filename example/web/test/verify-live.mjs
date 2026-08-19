/**
 * web/test/verify-live.mjs — does a change made by ONE client reach ANOTHER?
 *
 * The other two drives watch the tab that made the change, so they cannot tell
 * a real broadcast from a tab seeing its own echo — and for a year they did
 * not. This one opens a watcher tab, signed out, sitting on /orders/ touching
 * nothing, and makes every change from somewhere the watcher has no part in
 * (node, over plain HTTP). Two questions, and they fail separately:
 *
 *   • did a WS frame arrive?              → Junction's publish path
 *   • did the table change with no reload? → Sierra's store wiring
 *
 * It found the gap it was written for: a custom ACTION announced nothing.
 * `orders created` and `orders removed` crossed to the watcher; the `pay`
 * between them did not, and the row it was looking at silently kept saying
 * `pending`. The browser client had listened for action events since it was
 * written; callService only announced the five CRUD methods. Every app hid it
 * by re-issuing find() after each action — which is why `frameCount` is
 * asserted here and not just the rendered result. Fixed in junction 2026-08-06.
 *
 * Both servers must be up:
 *
 *   bun run api     # terminal 1
 *   bun run web     # terminal 2
 *   bun run verify:live
 *
 * It signs in ONCE, over HTTP, and shares the 10-per-15-minutes login window
 * with the other two drives.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const UI     = process.env.UI_URL  ?? 'http://localhost:8010'
const API    = process.env.API_URL ?? 'http://localhost:8110'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// Its own reference, so a failed run cannot poison the next one and the seeded
// orders keep the states verify.mjs expects.
const REF = 'ORD-LIVE-1'

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

const profile = mkdtempSync(join(tmpdir(), 'fjs-live-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
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
const pending      = new Map()
const inbound      = []      // WS frames the watcher received
const consoleErrors = []

function send(method, params = {}, sessionId) {
  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 30000)
  })
}

browser.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
    return
  }
  if (msg.method === 'Network.webSocketFrameReceived')
    inbound.push(msg.params.response.payloadData)
  if (msg.method === 'Runtime.exceptionThrown')
    consoleErrors.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
    consoleErrors.push(msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)
await send('Network.enable', {}, sessionId)     // the only reason we see frames

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// Installed per navigation — a reload wipes them, which is a mistake worth
// making only once.
const HELPERS = `
  window.rowsOf = () => [...document.querySelectorAll('tbody tr')].map(tr =>
    [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
  window.refs = () => rowsOf().map(r => r[0]);
  window.rowFor = (ref) => rowsOf().find(r => r[0] === ref);
  window.waitFor = async (fn, ms = 6000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) return false;
      await new Promise(r => setTimeout(r, 50));
    }
  };
`
await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS }, sessionId)

async function goto(path) {
  await send('Page.navigate', { url: UI + path }, sessionId)
  await evaluate(`
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      if (document.querySelector('#app .shell')) return true;
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('the app never mounted — #app .shell absent after 10s');
  `)
}

// ─── the drive ────────────────────────────────────────────────────────────

const got = {}
const t = (label, value) => { got[label] = value }
let orderId = null
let auth    = null

try {
  // The watcher: signed out, on the orders table, and it does nothing else for
  // the rest of this file. Orders are publicly readable, so it needs no session
  // — which also proves the broadcast is not merely an echo to the writer.
  await goto('/orders/')

  t('watcher.live', await evaluate(`
    const live = await waitFor(() => [...document.querySelectorAll('header *')]
      .some(el => el.textContent.trim() === 'live'));
    return { socket: live };
  `))
  // Sorted: `verify:jobs` re-creates a seeded order it cancels, which changes
  // that row's id and therefore where it sorts. What matters here is which rows
  // the watcher started with, not the order they came back in.
  t('watcher.rowsBefore', await evaluate(`return { refs: refs().sort() }`))

  const framesBefore = inbound.length

  // ── sign in OUT of band. Nothing below touches the browser. ─────────────
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
  })
  if (!login.ok) {
    if (login.status === 429) console.error(
      `\nSign-in was rate limited (HTTP 429).\n` +
      `Login allows 10 attempts per 15 minutes and the three drives share the window.\n` +
      `Wait, or restart the API to reset it.`)
    throw new Error(`sign-in failed: HTTP ${login.status}`)
  }
  const token = (await login.json()).token
  auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  // A run that threw before its cleanup leaves the row behind, and `reference`
  // is @unique — so the next create would be a 500 about nothing being tested.
  const stale = await (await fetch(`${API}/api/orders?reference=${REF}`)).json()
  for (const row of stale.data ?? [])
    await fetch(`${API}/api/orders/${row.id}`, { method: 'DELETE', headers: auth })

  // 1 ─ create
  const created = await fetch(`${API}/api/orders`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ reference: REF, total: 9.5, status: 'pending', customerId: 1 }),
  })
  const body = await created.json()
  orderId = body.id ?? body.data?.id
  t('http.create', { status: created.status })
  t('watcher.sawCreate', await evaluate(`
    return { appeared: await waitFor(() => refs().includes('${REF}')) };
  `))

  // 2 ─ a custom ACTION. The case that was broken: the row changes, and until
  //     2026-08-06 nothing was announced, so only the acting tab ever knew.
  const paid = await fetch(`${API}/api/orders/${orderId}`, {
    method: 'POST', headers: { ...auth, 'x-service-method': 'pay' }, body: '{}',
  })
  t('http.pay', { status: paid.status })
  t('watcher.sawPay', await evaluate(`
    const ok = await waitFor(() => rowFor('${REF}')?.[1] === 'paid');
    return { status: rowFor('${REF}')?.[1] ?? '(row gone)', updated: ok };
  `))

  // The Moves column is derived from the row's status, so a re-graded row is
  // the store having really replaced the record rather than patched a cell.
  // Read the MOVES column by its header rather than every button in the row
  // minus a list of names: the Actions column grows (Delete, quick view) and an
  // exclusion list quietly stops being complete, which reads as a regrade that
  // did not happen.
  t('watcher.movesRegraded', await evaluate(`
    const col = [...document.querySelectorAll('thead th')]
      .findIndex(th => th.textContent.trim() === 'Moves') + 1;
    const row = [...document.querySelectorAll('tbody tr')]
      .find(tr => tr.querySelector('td')?.textContent.trim() === '${REF}');
    return { moves: [...row.querySelectorAll('td:nth-child(' + col + ') button')]
      .map(b => b.textContent.trim()) };
  `))

  // 3 ─ a JOB's write, which nobody requested at all
  //
  // `ship` moves the order and queues `book-courier` (@frontierjs/caravan). The
  // job runs off the request, books a courier, and patches the tracking code
  // back through the orders SERVICE — so the announcement is the ordinary one
  // and this tab, which has still done nothing, fills the cell in.
  //
  // This is the only assertion in the repo where the writer is not a request.
  const ship = await fetch(`${API}/api/orders/${orderId}`, {
    method: 'POST', headers: { ...auth, 'x-service-method': 'ship' }, body: '{}',
  })
  t('http.ship', { status: ship.status, trackingInResponse: (await ship.json()).trackingCode })

  t('watcher.sawJobWrite', await evaluate(`
    const cell = () => rowFor('${REF}')?.[5];
    const ok = await waitFor(() => cell() && cell() !== 'booking…' && cell() !== '—', 15000);
    return { tracking: cell() ?? '(row gone)', arrived: ok };
  `))

  // 4 ─ remove
  const gone = await fetch(`${API}/api/orders/${orderId}`, { method: 'DELETE', headers: auth })
  t('http.delete', { status: gone.status })
  if (gone.ok) orderId = null
  t('watcher.sawDelete', await evaluate(`
    return { left: await waitFor(() => !refs().includes('${REF}')) };
  `))

  // 5 ─ what actually crossed the wire. Asserted separately from the rendered
  //     result: a page can look right because it refetched, and that is exactly
  //     how the action gap stayed invisible.
  // Only this service's events. Presence heartbeats (`presence:join`) share the
  // socket and arrive on their own schedule, so leaving them in would make the
  // assertion depend on timing rather than on what the writes announced.
  const events = inbound.slice(framesBefore)
    .map(p => { try { return JSON.parse(p) } catch { return null } })
    .filter(m => m?.type === 'event' && String(m.event).startsWith('orders '))
  t('watcher.events', { names: events.map(e => e.event) })
  t('watcher.payload', {
    ofPay: (() => {
      const e = events.find(e => e.event === 'orders pay')
      return e ? { reference: e.data.reference, status: e.data.status } : null
    })(),
  })

  t('consoleErrors', consoleErrors)
} catch (e) {
  console.error('\nThe drive threw:', e.message)
  console.error('collected so far:', got)
  process.exitCode = 1
} finally {
  if (orderId && auth) await fetch(`${API}/api/orders/${orderId}`, {
    method: 'DELETE', headers: auth,
  }).catch(() => {})
  browser.close()
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch {}
}

if (process.exitCode) process.exit(1)

// ─── the report ───────────────────────────────────────────────────────────

const expected = {
  'watcher.live':       { socket: true },
  'watcher.rowsBefore': { refs: ['ORD-1001', 'ORD-1002', 'ORD-1003'] },

  'http.create':      { status: 201 },
  'watcher.sawCreate': { appeared: true },

  'http.pay':          { status: 200 },
  'watcher.sawPay':    { status: 'paid', updated: true },
  'watcher.movesRegraded': { moves: ['ship', 'refund', 'cancel'] },

  // Deterministic from the reference — see api/jobs/book-courier.job.ts.
  'http.ship':          { status: 200, trackingInResponse: null },
  'watcher.sawJobWrite': { tracking: 'TRK-1BFG', arrived: true },

  'http.delete':       { status: 200 },
  'watcher.sawDelete': { left: true },

  // Three changes, three announcements. The middle one is the regression guard:
  // without it the page above still passes, because the row was created paid-
  // less and deleted before anyone reloaded.
  //
  // `orders recordTracking` and not `orders patched`: the courier job writes the
  // `@system` column through a named action, which announces under its own name.
  // That is the whole difference between the two — the job used to patch, and a
  // patch is what a caller may not do to a `@system` column.
  'watcher.events':  { names: ['orders created', 'orders pay', 'orders ship', 'orders recordTracking', 'orders removed'] },
  'watcher.payload': { ofPay: { reference: 'ORD-LIVE-1', status: 'paid' } },

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
