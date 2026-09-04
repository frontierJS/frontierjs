// verify-revisions.mjs — taking a row back, and two people editing one.
//
//   bun run api && bun run web, then: bun run verify:revisions
//
// The two Data-boundary features on `Customer` that no service file mentions:
//
//   @@softDelete   remove() stamps `deletedAt` instead of destroying the row.
//                  Every read filters on it, `restore()` is the way back, and
//                  `orders Order[] @keep` says the receipts do NOT go with the
//                  person — which is the assertion a cascade would fail and a
//                  unit test on either table would pass.
//
//   @version       update() carries back the revision it read, and a row that
//                  moved refuses with both numbers rather than overwriting the
//                  other edit. The failure it exists for is SILENT: without the
//                  column both saves succeed and the first one is gone.
//
// Both halves are asked twice, and they are not the same question. Over HTTP
// answers *is the boundary enforcing it*; in the browser answers *does a screen
// do anything sensible when it does* — and the second is where `FJS-341` lived,
// because a version remembered off the store rather than off what the screen
// READ wins the race the column exists to lose.
//
// ─── Traps ────────────────────────────────────────────────────────────────
//
//  · The drive mints its own customer under a run prefix. `email` is @unique
//    and a soft-deleted row KEEPS its value, so a drive re-using a seeded
//    address passes once and then 409s for the reason it is testing.
//  · No backticks inside an evaluate() template literal — the whole expression
//    is one, and a nested one ends it. Two drives here have been broken by it.
//  · Never start an evaluated expression with `return` on its own line: ASI
//    makes it `return;` and the assertion reads back `undefined`.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requireServers } from './lib/preflight.mjs'

const UI     = process.env.UI_URL  ?? 'http://localhost:8010'
const API    = process.env.API_URL ?? 'http://localhost:8110'
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

await requireServers([['api (bun run api)', `${API}/api/health`], ['web (bun run web)', UI]])

// ─── assertions ───────────────────────────────────────────────────────────

let pass = 0, fail = 0
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
function ok(name, got, want) {
  if (eq(got, want)) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}\n      want ${JSON.stringify(want)}\n      have ${JSON.stringify(got)}`) }
}
const section = (s) => console.log(`\n  ${s}\n`)

// ─── the API, over HTTP ───────────────────────────────────────────────────

const body = async (r) => { const t = await r.text(); try { return JSON.parse(t) } catch { return t } }

async function login(email) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct-horse-battery' }),
  })
  const b = await body(r)
  if (!b?.token) throw new Error(`login failed for ${email}: ${JSON.stringify(b).slice(0, 200)}`)
  return b.token
}

const adminToken = await login('alex@shop.test')
const H = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }

const get   = (path)       => fetch(`${API}/api${path}`, { headers: H }).then(body)
const raw   = (path, init) => fetch(`${API}/api${path}`, { headers: H, ...init })
const post  = (path, data) => raw(path, { method: 'POST',   body: JSON.stringify(data) })
const patch = (path, data) => raw(path, { method: 'PATCH',  body: JSON.stringify(data) })
const del   = (path)       => raw(path, { method: 'DELETE' })

// A run prefix, because @unique survives a soft delete — see the traps above.
const RUN   = Date.now().toString(36).slice(-6)
const EMAIL = `revisions-${RUN}@buyer.test`

section('a customer, and an order that outlives them')

const made = await body(await post('/customers', {
  name: `Revisions ${RUN}`, firstName: 'Rev', lastName: 'Isions', email: EMAIL,
}))
ok('a customer is created at revision 1', { id: typeof made.id, version: made.version }, { id: 'number', version: 1 })

// An order for them, so removal has something to leave behind. Written through
// the orders service like any other — `@keep` is not a special write path.
const order = await body(await post('/orders', {
  reference: `ORD-REV-${RUN}`.toUpperCase().slice(0, 20), customerId: made.id, total: 1250,
}))
ok('…and an order under them', typeof order.id, 'number')

const before = await get(`/customers/${made.id}`)
ok('the Orders count is a @from over the live orders', before.orderCount, 1)

section('removal is a visibility rule')

const removed = await del(`/customers/${made.id}`)
ok('remove answers 200', removed.status, 200)

const live = await get(`/customers?email=${encodeURIComponent(EMAIL)}`)
ok('they are out of every ordinary read', live.total, 0)

const byId = await raw(`/customers/${made.id}`)
ok('and unreachable by id — not an empty row, a 404', byId.status, 404)

// The assertion this whole feature turns on. `Order.customerId` is
// `onDelete: Cascade`, so before @@softDelete this DESTROYED the order; with
// @@softDelete(cascade) on the customer it would have hidden it instead. Both
// are wrong, and both look like success from the customer's side alone.
const theirOrder = await raw(`/orders/${order.id}`)
ok('their order is still in the ledger — @keep', theirOrder.status, 200)
ok('…and still readable in full', (await body(theirOrder)).reference, order.reference.toUpperCase())

const onlyDeleted = await get(`/customers?$onlyDeleted=true&email=${encodeURIComponent(EMAIL)}`)
ok('$onlyDeleted finds them', onlyDeleted.total, 1)
ok('…still carrying their order count', onlyDeleted.data?.[0]?.orderCount, 1)
ok('…and a deletedAt that says when', typeof onlyDeleted.data?.[0]?.deletedAt, 'string')

const withDeleted = await get(`/customers?$withDeleted=true&email=${encodeURIComponent(EMAIL)}`)
ok('$withDeleted has both kinds', withDeleted.total, 1)

section('the slot a deleted row keeps')

// The refusal that separates "hidden" from "gone". A partial index would let a
// stranger take the address, and then restore() could not work.
const retaken = await post('/customers', {
  name: 'Impostor', firstName: 'Im', lastName: 'Postor', email: EMAIL,
})
const retakenBody = await body(retaken)
ok('re-using a removed customer’s email is refused', retaken.status, 409)
ok('…by name, so a form can say what to do', retakenBody.name, 'Conflict')
ok('…naming the column', /email/i.test(JSON.stringify(retakenBody)), true)

section('the way back')

// restore() is its own verb, not a patch of `deletedAt` — a caller may not write
// that column at all. Over HTTP it is `PUT /{service}/{id}` naming the method,
// the same shape a custom method takes, because REST has no spelling for
// un-delete and inventing one would put a second answer beside `x-service-method`.
const restoreRes = await raw(`/customers/${made.id}`, {
  method: 'PUT', headers: { ...H, 'x-service-method': 'restore' },
})
ok('restore answers the row', restoreRes.status, 200)

const back = await get(`/customers?email=${encodeURIComponent(EMAIL)}`)
ok('they are in the ordinary read again', back.total, 1)
ok('…the same row, not a new one', back.data?.[0]?.id, made.id)
ok('…and the order never moved', (await get(`/customers/${made.id}`)).orderCount, 1)

section('two people editing one customer')

const read1 = await get(`/customers/${made.id}`)
const read2 = await get(`/customers/${made.id}`)
ok('both read the same revision', read1.version === read2.version, true)

const first = await patch(`/customers/${made.id}`, { notes: 'first writer', version: read1.version })
ok('the first save lands', first.status, 200)
ok('…and the revision moves', (await body(first)).version, read1.version + 1)

const second = await patch(`/customers/${made.id}`, { notes: 'second writer', version: read2.version })
const conflict = await body(second)
ok('the second save is refused', second.status, 409)
// `retryable` is a sibling of `data` on the wire and lands at `err.data.retryable`
// in the browser, because the client assigns the whole parsed body to `.data`.
// Same list-two-`data`s-deep shape `toFieldErrors` documents.
ok('…as a race rather than a rule', conflict.retryable, true)
ok('…naming both revisions', { expected: conflict.data?.expected, actual: conflict.data?.actual },
                             { expected: read2.version, actual: read1.version + 1 })
ok('…and the first writer’s value is what the row holds',
   (await get(`/customers/${made.id}`)).notes, 'first writer')

// The other half of the rule at the top of db/schema.lite: a model deliberately
// WITHOUT the column. Order is guarded by @@transitions on the one contended
// column, so a second patch of a different field is last-write-wins on purpose
// and there is no 409 nobody can act on.
const o1 = await get(`/orders/${order.id}`)
await patch(`/orders/${order.id}`, { note: 'from one screen' })
const o2 = await patch(`/orders/${order.id}`, { note: 'from another' })
ok('an Order takes two writes off one read — it declares no @version', o2.status, 200)
ok('…because @@transitions already guards the column two writers contend for',
   'version' in o1, false)

// ─── the browser ──────────────────────────────────────────────────────────

section('the screen')

const profile = mkdtempSync(join(tmpdir(), 'fjs-revisions-'))
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
const pending = new Map()
const noise   = []

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
  if (msg.method === 'Runtime.exceptionThrown')
    noise.push('exception: ' + (msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text))
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type))
    noise.push(msg.params.type + ': ' + msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const { targetId }  = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

const WAIT = `
  const waitFor = async (fn, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 40)); }
    throw new Error('waitFor timed out: ' + fn.toString());
  };
`

async function goto(path) {
  await send('Page.navigate', { url: UI + path }, sessionId)
  await evaluate(`${WAIT} await waitFor(() => document.querySelector('#app .shell') && location.pathname === '${path}'); return true;`)
}

await goto('/')
await evaluate(`
  const r = await fetch('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
  });
  const b = await r.json();
  localStorage.setItem('shop_token', b.token);
  return b.token ? 'ok' : 'no token';
`)

await goto('/customers/')
await evaluate(`${WAIT} await waitFor(() => document.querySelectorAll('tbody tr').length); return true;`)

const CID = made.id

ok('the customer is on screen', await evaluate(`
  ${WAIT}
  await waitFor(() => document.querySelector('[data-customer="${CID}"]'));
  const tr = document.querySelector('[data-customer="${CID}"]');
  return { name: tr.querySelector('[data-name]').textContent.trim(),
           orders: tr.querySelector('[data-orders]').textContent.trim() };
`), { name: `Revisions ${RUN}`, orders: '1' })

// ── the conflict, in a drawer ──────────────────────────────────────────────
//
// The drawer reads the row it was opened with, so the version it holds is the
// one this screen READ. A second writer moves the row underneath it; the save
// then carries a revision the row has passed, which is exactly the shape a
// person hits and nothing else here reproduces.

await evaluate(`
  ${WAIT}
  const tr = document.querySelector('[data-customer="${CID}"]');
  tr.querySelector('[data-edit]').click();
  await waitFor(() => document.querySelector('#c-save'));
  return true;
`)

ok('the edit form is generated from the schema, not written in the page', await evaluate(`
  const names = [...document.querySelectorAll('dialog form .field-group input, dialog form .field-group textarea')]
    .map(el => el.getAttribute('name')).filter(Boolean);
  return { hasEmail: names.includes('email'),
           noGenerated: !names.includes('fullName'),
           noSystem: !names.includes('userId'),
           noVersion: !names.includes('version') };
`), { hasEmail: true, noGenerated: true, noSystem: true, noVersion: true })

// The second writer. Deliberately from OUTSIDE the page — a write the screen
// has no way to have heard about, which a WS push would otherwise mask.
const outside = await get(`/customers/${CID}`)
const moved   = await patch(`/customers/${CID}`, { notes: 'the other person', version: outside.version })
ok('somebody else saves while the drawer is open', moved.status, 200)

ok('the save is refused and the screen says which two revisions disagreed', await evaluate(`
  ${WAIT}
  const box = document.querySelector('dialog form textarea[name="notes"], dialog form input[name="notes"]');
  box.value = 'mine';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#c-save').click();
  await waitFor(() => document.querySelector('#c-conflict'));
  return { expected: document.querySelector('[data-expected]').textContent.trim(),
           actual:   document.querySelector('[data-actual]').textContent.trim() };
`), { expected: String(outside.version), actual: String(outside.version + 1) })

ok('reloading theirs shows what the row actually holds', await evaluate(`
  ${WAIT}
  document.querySelector('#c-take-theirs').click();
  await waitFor(() => !document.querySelector('#c-conflict'));
  const box = document.querySelector('dialog form textarea[name="notes"], dialog form input[name="notes"]');
  return box.value;
`), 'the other person')

ok('…and overwriting takes the current revision and wins', await evaluate(`
  ${WAIT}
  const box = document.querySelector('dialog form textarea[name="notes"], dialog form input[name="notes"]');
  box.value = 'mine after all';
  box.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#c-save').click();
  await waitFor(() => !document.querySelector('dialog[open]'));
  const r = await fetch('/api/customers/${CID}', { headers: { authorization: 'Bearer ' + localStorage.getItem('shop_token') } });
  const row = await r.json();
  return row.notes;
`), 'mine after all')

// ── removing and restoring, from the screen ────────────────────────────────

ok('Remove takes the row off the list', await evaluate(`
  ${WAIT}
  const tr = document.querySelector('[data-customer="${CID}"]');
  tr.querySelector('[data-remove]').click();
  await waitFor(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Remove' && b.closest('[role=dialog], .popover, [popover]')));
  const confirm = [...document.querySelectorAll('button')].reverse()
    .find(b => b.textContent.trim() === 'Remove' && b.closest('[role=dialog], .popover, [popover]'));
  confirm.click();
  await waitFor(() => !document.querySelector('[data-customer="${CID}"]'));
  return true;
`), true)

ok('the Removed view finds them, with their orders still counted', await evaluate(`
  ${WAIT}
  document.querySelector('#c-removed').click();
  await waitFor(() => document.querySelector('#c-removed-note'));
  await waitFor(() => document.querySelector('[data-customer="${CID}"]'));
  const tr = document.querySelector('[data-customer="${CID}"]');
  return { orders: tr.querySelector('[data-orders]').textContent.trim(),
           restore: !!tr.querySelector('[data-restore]') };
`), { orders: '1', restore: true })

ok('Restore puts them back in the ordinary list', await evaluate(`
  ${WAIT}
  document.querySelector('[data-customer="${CID}"] [data-restore]').click();
  await waitFor(() => !document.querySelector('[data-customer="${CID}"]'));
  document.querySelector('#c-removed').click();
  await waitFor(() => !document.querySelector('#c-removed-note'));
  await waitFor(() => document.querySelector('[data-customer="${CID}"]'));
  return true;
`), true)

ok('no console errors', noise, [])

// ─── clean up after itself ────────────────────────────────────────────────
//
// The drive is repeatable, so it takes its own rows with it. A hard delete is
// the only thing that frees the @unique email, and there is no route for one —
// which is the schema's point, not an omission: releasing a slot is a decision
// an app makes. The run prefix is what keeps the next run out of its way.

await del(`/orders/${order.id}`)
await del(`/customers/${CID}`)

// Chrome writes its profile out as it goes down, so removing it the instant
// after kill() races the last write and throws ENOTEMPTY about a directory that
// is about to be empty. Wait for the exit, and treat the sweep as best-effort:
// a temp directory left behind is not a failed drive.
chrome.kill()
await new Promise((r) => chrome.once('exit', r))
try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch {}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
