/**
 * web/test/verify-stock.mjs — the shelf, the holds against it, and the tape.
 *
 * Started by `bun run verify:stock`. Starts BOTH servers itself, like
 * verify-cart and verify-catalogue, because what it proves spans them.
 *
 * ─── What is under test ───────────────────────────────────────────────────
 *
 * `ProductVariant.stock` is ON HAND. What the shop may sell is AVAILABLE — on
 * hand less every unexpired `StockReservation` some open basket is carrying —
 * and it is not a column anywhere. Three things follow, and each one is a way
 * this can be broken silently:
 *
 *   · A hold must move AVAILABLE and leave ON HAND alone. Decrementing the
 *     column on add is unrecoverable (an abandoned basket is a permanent
 *     stockout); not holding at all oversells the last one to two shoppers.
 *   · A shopper's own hold must not count against THEM. Summing every hold is
 *     the obvious implementation and it refuses a shopper the stock that is
 *     being kept for them — a bug that looks exactly like a stock shortage.
 *   · The expiry must be in the READ. If availability only becomes right after
 *     a sweep has run, a queue outage quietly stops the shop selling, and it
 *     looks identical from outside until the day it happens.
 *
 * And the ledger: every write to `stock` is paired with an `InventoryMovement`
 * in one transaction, so the running total and the tape behind it reconcile.
 * A unit test on either side of that pairing passes with the pairing broken.
 *
 * The drive puts the shop back before it exits — the holds it takes are real
 * and would sit on the shelf for twenty minutes, which the drives that run
 * after it would read as a stock shortage.
 */
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const UI   = process.env.UI_URL  ?? 'http://localhost:8010'

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
// `detached` is what makes stopAll work. `npx vite` is a launcher: SIGTERM to
// the process this holds kills the launcher and leaves vite itself on 8010, so
// the NEXT drive refuses the port and says a dev server is running from an
// earlier run — which it is, and nothing said which run. Detached puts each
// server in its own process group, and stopAll signals the group.
function start(cmd, args, name) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    // The GROUP, negative pid. Falls back to the process itself where the
    // group is already gone, so a second call is not an error.
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

async function waitFor(url, label, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

// A dev server serves the code it STARTED with, so a leftover from an earlier
// run would be tested instead of this one — and would pass, against the old
// build. Refuse the port rather than joining it.
for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

// Seeding is a step, not a boot side effect, so this drive takes it. Against an
// empty database every assertion below fails as "the row is not there", which
// reads as a regression in whatever was just changed. Idempotent — a seeded
// database costs one pass of existence checks.
execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start('npx', ['vite', '-c', 'web/config/vite.config.js'], 'web')

if (!await waitFor(`${API}/api/products`, 'api')) { stopAll(); process.exit(1) }
if (!await waitFor(UI, 'web'))                    { stopAll(); process.exit(1) }

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

const api  = (path, opts = {}) => fetch(`${API}/api${path}`, opts)
const post = (svc, method, id, body, headers = {}) =>
  api(id == null ? `/${svc}` : `/${svc}/${id}`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', 'X-Service-Method': method, ...headers },
    body:    JSON.stringify(body ?? {}),
  })
const cart = (method, id, body, token) => post('carts', method, id, body, token ? { 'x-cart-token': token } : {})

const availabilityOf = async (variantId) => {
  const r = await (await post('product-variants', 'availability', null, { variantIds: [variantId] })).json()
  return r.variants[0]
}

async function bearerFor(who) {
  const r = await api('/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email:    who === 'admin' ? 'alex@shop.test' : 'sam@shop.test',
      password: 'correct-horse-battery',
    }),
  })
  const j = await r.json()
  const token = j.accessToken ?? j.token ?? j.data?.accessToken
  if (!token) throw new Error(`sign-in as ${who} failed: ${JSON.stringify(j).slice(0, 200)}`)
  return { authorization: `Bearer ${token}` }
}

const admin = await bearerFor('admin')
const user  = await bearerFor('user')

// ─── Pick a shelf ──────────────────────────────────────────────────────────
//
// Chosen rather than hard-coded. Every number below is relative to what this
// shelf holds when the drive starts, so re-running against a database other
// drives have already bought from asserts the same facts — which is the shape
// FJS-080 was, and it reads as a regression in whatever you changed last.

const catalogue = await (await api('/product-variants?$limit=500&$orderBy=sku')).json()
const shelf = catalogue.data.find(v => v.active && v.stock >= 4 && v.stock <= 30)
if (!shelf) { console.error('no shelf between 4 and 30 to test with'); stopAll(); process.exit(1) }

const V = shelf.id
const SKU = shelf.sku

console.log(`\n  stock — the shelf (${SKU})`)

const start0 = await availabilityOf(V)
check('nothing is held, so available IS on hand',
      [start0.onHand, start0.available], [shelf.stock, shelf.stock])

// ─── A hold moves one number and not the other ─────────────────────────────

const A = await (await cart('open', null)).json()
const half = Math.ceil(start0.available / 2)
const addA = await cart('addLine', A.id, { variantId: V, quantity: half }, A.token)
check('a shopper may hold what is available', addA.status, 200)

const held1 = await availabilityOf(V)
check('the hold moves AVAILABLE and leaves ON HAND alone',
      [held1.onHand, held1.available], [start0.onHand, start0.available - half])

const basketA = await addA.json()
check('the basket says when the hold runs out',
      typeof basketA.heldUntil === 'string' && Date.parse(basketA.heldUntil) > Date.now(), true)
check('and how long a hold lasts, so the screen and the sweep cannot drift',
      basketA.holdMinutes > 0, true)
// ON HAND, not `available` — the shopper holds `half` of it themselves and
// their own hold must not count against them. The number a stepper's max comes
// from is a question about THIS basket, and summing every hold answers a
// smaller number that looks entirely plausible.
check("the line's ceiling excludes the shopper's OWN hold",
      basketA.lines[0].available, start0.onHand)

// ─── A second shopper is refused, by name ──────────────────────────────────

const B = await (await cart('open', null)).json()
const rest = start0.available - half

const tooMuch = await cart('addLine', B.id, { variantId: V, quantity: rest + 1 }, B.token)
const refusal = await tooMuch.json()
check('a second shopper is refused past what is left', tooMuch.status, 409)
check('the refusal names the SKU and the number', refusal.message, `Only ${rest} of ${SKU} left`)
// 409 and `retryable`, not 400. The request was well formed and was true when
// the shopper was shown it — what changed is the world, and a browser holding a
// stale count should re-read rather than show the shopper their own input as an
// error. `retryable` is the one thing a status cannot carry.
check('and says it is worth re-reading rather than worth correcting',
      refusal.data?.retryable ?? refusal.retryable, true)

const exact = await cart('addLine', B.id, { variantId: V, quantity: rest }, B.token)
check('but may take exactly what is left', exact.status, 200)
check('which leaves nothing available', (await availabilityOf(V)).available, 0)

// ─── The shopper's own hold is theirs ──────────────────────────────────────
//
// The whole shelf is now held and none of it is available — and shopper A must
// still be able to re-state their own line. Summing every hold answers 0 and
// refuses them the stock that is being kept for them, which looks exactly like
// a stock shortage and is not one.

const lineA = basketA.lines[0].id
const resame = await cart('setQuantity', A.id, { lineId: lineA, quantity: half }, A.token)
check('with the shelf fully held, a shopper may still re-state their own line',
      resame.status, 200)
const oneMore = await cart('setQuantity', A.id, { lineId: lineA, quantity: half + 1 }, A.token)
check('but not raise it past what is left over', oneMore.status, 409)

// ─── Giving it back ────────────────────────────────────────────────────────

const removed = await cart('removeLine', A.id, { lineId: lineA }, A.token)
check('removing a line gives the stock back at once', removed.status, 200)
check('the shelf is available again immediately, with no sweep',
      (await availabilityOf(V)).available, half)

// ─── The expiry is in the READ ─────────────────────────────────────────────
//
// The job passes the SAME comparison the schedule passes, with a different
// cutoff — a `releaseAll` flag would be a second code path proving nothing
// about the first.

const run = await api('/jobs/run/release-holds', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ before: '2099-01-01T00:00:00.000Z' }),
})
const { id: jobId } = await run.json()
let jobRow = null
for (let i = 0; i < 60 && !jobRow; i++) {
  const j = await (await api(`/jobs/${jobId}`)).json()
  if (j.status === 'done' || j.status === 'failed') jobRow = j
  else await new Promise(r => setTimeout(r, 200))
}
check('release-holds runs on demand', jobRow?.status, 'done')
check('and an expired hold is gone', (await availabilityOf(V)).available, start0.onHand)

const badCutoff = await api('/jobs/run/release-holds', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ before: 'last tuesday' }),
})
const { id: badId } = await badCutoff.json()
let badRow = null
for (let i = 0; i < 60 && !badRow; i++) {
  const j = await (await api(`/jobs/${badId}`)).json()
  if (j.status === 'done' || j.status === 'failed' || j.status === 'dead') badRow = j
  else await new Promise(r => setTimeout(r, 200))
}
// `expiresAt` is TEXT and the comparison is lexicographic, so a cutoff that is
// not an instant does not fail — it matches an arbitrary prefix of the table
// and deletes LIVE holds. A shop overselling because somebody typo'd a
// timestamp is worth one line of validation.
check('a cutoff that is not an instant is refused rather than guessed at',
      badRow?.status !== 'done', true)

// ─── Checkout: the shelf comes down and the tape records it ────────────────

console.log('\n  stock — checkout writes the ledger')

const C = await (await cart('open', null)).json()
await cart('addLine', C.id, { variantId: V, quantity: 2 }, C.token)
const receipt = await (await cart('checkout', C.id,
  { email: 'stock-drive@shop.test', name: 'Stock Drive' }, C.token)).json()

const sold = await availabilityOf(V)
check('on hand falls by what was bought', sold.onHand, start0.onHand - 2)
check('and the hold is gone with it, so available follows on hand',
      sold.available, sold.onHand)

const ledger = await (await api(`/inventory?variantId=${V}&$orderBy=-id&$limit=5`, { headers: admin })).json()
const saleRow = ledger.data.find(m => m.kind === 'sold')
check('the sale is on the tape, signed, with both ends of the shelf',
      [saleRow?.quantity, saleRow?.stockBefore, saleRow?.stockAfter],
      [-2, start0.onHand, start0.onHand - 2])
check('and it names the order it belongs to', saleRow?.reference, receipt.reference)

// ─── The gate ──────────────────────────────────────────────────────────────

console.log('\n  stock — who may look and who may move it')

check('a stranger cannot read the ledger', (await api('/inventory')).status, 401)
check('nor can a signed-in shopper at level 4',
      (await api('/inventory', { headers: user })).status, 403)
check('an administrator can',
      (await api('/inventory', { headers: admin })).status, 200)

// No hook in `inventory.service.ts` checks a level. `InventoryMovement` is
// `@@gate("5.5.9.9")` and `receive` writes the movement through the CALLER's
// own client, so the Data boundary is what refuses this — for every route in,
// including ones nobody has thought of yet.
const receiveAsUser = await post('inventory', 'receive', null, { variantId: V, quantity: 5 }, user)
check('receiving stock is refused at level 4 by the Data boundary, not by a hook',
      receiveAsUser.status, 403)

const received = await (await post('inventory', 'receive', null,
  { variantId: V, quantity: 5, reference: 'DRIVE-DN' }, admin)).json()
check('an administrator receives a delivery',
      [received.before, received.after], [start0.onHand - 2, start0.onHand + 3])

const afterReceipt = await (await api(`/inventory?variantId=${V}&$orderBy=-id&$limit=1`, { headers: admin })).json()
check('which is on the tape as a receipt',
      [afterReceipt.data[0]?.kind, afterReceipt.data[0]?.quantity, afterReceipt.data[0]?.reference],
      ['received', 5, 'DRIVE-DN'])

const asSale = await post('inventory', 'adjust', null,
  { variantId: V, quantity: -1, kind: 'sold', note: 'trying it on' }, admin)
check('a sale cannot be filed by hand', asSale.status, 400)

const damaged = await (await post('inventory', 'adjust', null,
  { variantId: V, quantity: -1, kind: 'damaged', note: 'crushed in transit' }, admin)).json()
check('a breakage takes one off the shelf', damaged.after, start0.onHand + 2)

const noReason = await post('inventory', 'adjust', null,
  { variantId: V, quantity: -1, kind: 'damaged' }, admin)
check("an adjustment with no reason is refused in the seed's own words",
      (await noReason.json()).data?.[0]?.message ?? (await noReason.status),
      'An adjustment with no reason is a number nobody can audit')

// Append-only, from the outside: the service names no verb that edits a row,
// so there is nothing to send. The other half is the gate — update and delete
// are 9, which nothing passes including `asSystem()` — and that one cannot be
// reached from here at all, which is the point of putting it in the schema.
check('the ledger offers no way to edit a row',
      (await api(`/inventory/${saleRow.id}`, {
        method: 'PATCH', headers: { ...admin, 'content-type': 'application/json' },
        body: '{"quantity":0}',
      })).status, 405)

// ─── The browser ───────────────────────────────────────────────────────────

console.log('\n  stock — on screen')

const chrome = start(CHROME, [
  '--headless=new', '--remote-debugging-port=9222', '--disable-gpu',
  '--no-sandbox', '--window-size=1400,1000', 'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try {
    const v = await (await fetch('http://localhost:9222/json/version')).json()
    wsUrl = v.webSocketDebuggerUrl
  } catch { await new Promise(r => setTimeout(r, 250)) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
}
function send(method, params = {}, sessionId) {
  const id = ++msgId
  return new Promise(res => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })) })
}

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function evaluate(expr) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}

async function goto(path, waitSel, atLeast = 1) {
  await send('Page.navigate', { url: UI + path }, sessionId)
  for (let i = 0; i < 120; i++) {
    const n = await evaluate(`document.querySelectorAll('${waitSel}').length`)
    if (n >= atLeast) return
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`${path}: never rendered ${atLeast}× \`${waitSel}\``)
}

async function until(fn, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}

// A hold somebody else is carrying, so the page has two different numbers to
// show. Taken over the API rather than by clicking, because what is being
// tested is that the SCREEN separates them.
const D = await (await cart('open', null)).json()
const nowAvail = (await availabilityOf(V)).available
await cart('addLine', D.id, { variantId: V, quantity: nowAvail }, D.token)

await goto(`/products/${shelf.productId}/`, '#stat-available', 1)

const shelfState = await until(async () => await evaluate(`(() => {
  const num = (sel) => Number(document.querySelector(sel)?.textContent.replace(/\\D+/g, '') ?? NaN)
  const onHand    = num('#stat-onhand')
  const available = num('#stat-available')
  return Number.isFinite(onHand) && available < onHand ? { onHand, available } : null
})()`))
check('the product page shows two numbers, and they differ while stock is held',
      shelfState !== null && shelfState.available < shelfState.onHand, true)

// The grid marks the difference per shelf, and it is a different WORD from
// sold out on purpose: one of them comes back on its own in twenty minutes and
// the other does not. Telling a shopper "sold out" about stock sitting in
// somebody's basket is a customer the shop did not need to lose.
check('a fully held shelf says so, and does not say sold out',
      await evaluate(`document.body.innerText.includes('all held')`), true)
// The browser's number against the server's, for the same product. Two code
// paths — `product-variants.availability` computing it as the shop, and this
// page summing what it was handed — and a unit test on either side passes with
// the crossing broken.
const productAvail = await (await post('product-variants', 'availability', null,
  { productId: shelf.productId })).json()
check("the page's total is the server's, not the browser's own arithmetic",
      shelfState?.available,
      productAvail.variants.reduce((n, v) => n + v.available, 0))

// ── The basket screen's countdown ─────────────────────────────────────────
//
// The browser carries its own token, so this basket is a fresh one taken by
// clicking rather than the one held over the API above.
await evaluate(`(localStorage.removeItem('shop_cart'), true)`)
const spare = catalogue.data.find(v => v.active && v.stock > 0 && v.id !== V)
await goto(`/products/${spare.productId}/`, '#buy-add', 1)
await until(async () => await evaluate(`document.querySelector('#buy-add') && !document.querySelector('#buy-add').disabled`))
await evaluate(`(document.querySelector('#buy-add').click(), true)`)
await until(async () => await evaluate(`!!document.querySelector('#nav-basket-count')`))

await goto('/cart/', '#basket-lines .line', 1)
const countdown = await until(async () => await evaluate(
  `document.querySelector('#basket-hold-left')?.textContent.trim() || null`))
check('the basket says how long its stock is held for',
      /^\d+:\d\d$/.test(countdown ?? ''), true)

// ── The inventory screen ──────────────────────────────────────────────────

await goto('/inventory/', '#inventory-denied, .level-row', 1)
check('a signed-out visitor is told it is not for them',
      await evaluate(`!!document.querySelector('#inventory-denied')`), true)

await evaluate(`(() => {
  const b = [...document.querySelectorAll('header button')].find(b => b.textContent.includes('Sign in (admin)'))
  b.click(); return true
})()`)
await until(async () => await evaluate(`!!document.querySelector('#nav-inventory')`))
check('an administrator gets the nav link', await evaluate(`!!document.querySelector('#nav-inventory')`), true)

await goto('/inventory/', '.level-row', 1)
const row = await until(async () => await evaluate(`(() => {
  const tr = document.querySelector('.level-row[data-sku="${SKU}"]')
  if (!tr) return null
  return {
    held:      Number(tr.dataset.held),
    onHand:    Number(tr.querySelector('[data-onhand]')?.textContent.trim()),
    available: Number(tr.querySelector('[data-available]')?.textContent.trim()),
  }
})()`))
check('the inventory screen separates on hand from held from available',
      row && row.held > 0 && row.available === row.onHand - row.held, true)

check('and the ledger shows what happened to this shelf',
      await until(async () => await evaluate(
        `document.querySelectorAll('.movement[data-kind="sold"]').length > 0`)),
      true)

// ─── Put the shop back ─────────────────────────────────────────────────────
//
// The holds above are real and would sit on the shelf for twenty minutes. The
// drives that run after this one read that as a stock shortage and fail on rows
// this file moved, which is exactly the shape of FJS-080 and reads as a
// regression in whatever you changed last.

const cleanup = await api('/jobs/run/release-holds', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ before: '2099-01-01T00:00:00.000Z' }),
})
const { id: cleanupId } = await cleanup.json()
await until(async () => {
  const j = await (await api(`/jobs/${cleanupId}`)).json()
  return j.status === 'done' || j.status === 'failed'
})
check('the drive leaves no hold behind', (await availabilityOf(V)).available,
      (await availabilityOf(V)).onHand)

console.log(`\n  ${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail ? 1 : 0)
