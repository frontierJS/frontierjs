/**
 * web/test/verify-cart.mjs — a stranger fills a basket and buys, in a real
 * browser.
 *
 * Started by `bun run verify:cart`. Like verify-catalogue it starts BOTH
 * servers itself, because what it proves spans them and a dev server serves
 * the code it started with.
 *
 * What is actually under test is not the screens. It is that a caller with NO
 * SESSION can own rows:
 *
 *   · `Cart` and `CartLine` are `@@gate("0.0.0.5")` — readable at level 0 —
 *     and their rows are reached by `@@allow('read', token == auth().cartToken)`.
 *   · The claim comes from `createApp({ principal })`, which junction runs for
 *     a caller with no session and whose claims never become one. A guest
 *     graded USER(4) would be the whole bug.
 *   · The token rides `x-cart-token`, declared in `http.callHeaders`. Over the
 *     socket there are no per-call headers, so it travels on the frame — which
 *     is why this drive checks the connection is LIVE before it adds anything.
 *     With the socket up and the header lost, every basket call answers 404
 *     and the shop looks broken in a way no HTTP test can see.
 *
 * A wrong policy here is an EMPTY SCREEN and not an error, so the negative
 * cases below (a stranger's token, no token) assert 404 rather than a message.
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

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

// Refuse a port that already answers rather than joining it. Vite hops to the
// next free port in silence and a dev server serves the code it STARTED with,
// so a leftover from the previous run would be tested instead of this one —
// and it would pass, against the old build.
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

// ─── Chrome over CDP ───────────────────────────────────────────────────────

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
  return new Promise(res => {
    pending.set(id, res)
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
}

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' })
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

async function goto(path, waitSel, atLeast = 1) {
  await send('Page.navigate', { url: UI + path }, sessionId)
  // Settle on the CONTENT this page is about, never on a fixed sleep and never
  // on the shell. The layout's nav and heading are in `main` before a single
  // row has been fetched, so a text-length check passes while the table is
  // still empty — which is a drive that fails on a slow run and passes on a
  // fast one, in whichever assertion happened to be first.
  for (let i = 0; i < 100; i++) {
    const n = await evaluate(`document.querySelectorAll('${waitSel}').length`)
    if (n >= atLeast) return
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error(`${path}: never rendered ${atLeast}× \`${waitSel}\``)
}

async function settleImages(sel) {
  // An <img> is in the DOM the moment the row renders and has naturalWidth 0
  // until the bytes arrive. Every image assertion below reads naturalWidth, so
  // they all have to wait for this rather than for the row.
  for (let i = 0; i < 60; i++) {
    const ok = await evaluate(`(() => {
      const els = [...document.querySelectorAll('${sel}')]
      return els.length > 0 && els.every(i => i.complete && i.naturalWidth > 0)
    })()`)
    if (ok) return
    await new Promise(r => setTimeout(r, 150))
  }
}

async function evaluate(expr) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

const api = (path, opts = {}) => fetch(`${API}/api${path}`, opts)

// ─── Reading the ledger, which is not a stranger's to read ────────────────
//
// The basket half of this drive is deliberately anonymous — that is the point
// of it. The ASSERTIONS about what the sale produced are not: `Order`,
// `OrderLine` and `Customer` read at level 1 with a row policy apiece, so a
// stranger asking gets 401 and a shopper asking gets their own. This drive is
// checking the shop's books, which is a member of staff's question.
//
// It used to ask anonymously and be answered, which is the leak these gates
// closed — the catalogue's `@@gate("0.4.4.5")` had been pasted onto the ledger.
let staffToken = null
async function asStaff(path) {
  staffToken ??= (await (await fetch(`${API}/api/auth/login`, {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
  })).json())?.token
  return fetch(`${API}/api${path}`, { headers: { authorization: `Bearer ${staffToken}` } })
}
const call = (method, id, body, token) => api(id == null ? '/carts' : `/carts/${id}`, {
  method:  'POST',
  headers: { 'content-type': 'application/json', 'X-Service-Method': method,
             ...(token ? { 'x-cart-token': token } : {}) },
  body:    JSON.stringify(body ?? {}),
})

// ─── The API, as a stranger ────────────────────────────────────────────────

console.log('\n  basket — the API, with no session at all')

const opened = await (await call('open', null)).json()
check('open answers a basket',           typeof opened.id, 'number')
check('open answers the token, once',    /^c[0-9a-z]{24}$/.test(opened.token ?? ''), true)
check('a new basket is empty',           [opened.count, opened.total], [0, 0])

const { id: cartId, token } = opened

const added = await (await call('addLine', cartId, { variantId: 1, quantity: 2 }, token)).json()
check('a line carries what a screen shows',
      [added.lines[0].sku?.startsWith('FJS-'), typeof added.lines[0].product, added.lines[0].total],
      [true, 'string', added.lines[0].unitPrice * 2])
check('a line photograph is a URL, not a stored ref',
      String(added.lines[0].image).startsWith('http'), true)
check('the basket does not repeat the token back',
      'token' in added.lines[0] || 'token' in added, false)

const again = await (await call('addLine', cartId, { variantId: 1, quantity: 1 }, token)).json()
check('the same variant is a quantity, not a second line',
      [again.lines.length, again.lines[0].quantity, again.count], [1, 3, 3])

// The whole security model in two requests. A policy FILTERS, so the wrong
// token is not a refusal — there is simply no such row, and 404 is the honest
// answer to "get this basket".
const stranger = await api(`/carts/${cartId}`, { headers: { 'x-cart-token': 'c' + 'z'.repeat(24) } })
check("another stranger's token finds nothing", stranger.status, 404)
const bare = await api(`/carts/${cartId}`)
check('no token at all finds nothing',            bare.status, 404)
const held = await api(`/carts/${cartId}`, { headers: { 'x-cart-token': token } })
check('the holder reads their own basket',        held.status, 200)

// ─── The browser ───────────────────────────────────────────────────────────

console.log('\n  basket — the buy box')

await goto('/products/1/', '#buy-add', 1)

// The socket has to be up BEFORE the click, or this drive proves the HTTP path
// and says nothing about the frame. `x-cart-token` cannot ride a WS frame
// unless the app declared it in `http.callHeaders`, and the failure is a 404
// on every basket call rather than an error anywhere.
for (let i = 0; i < 60; i++) {
  if (await evaluate(`document.body.innerText.includes('live')`)) break
  await new Promise(r => setTimeout(r, 200))
}
check('the WebSocket is connected, so the add goes over a frame',
      await evaluate(`document.body.innerText.includes('live')`), true)

check('the buy box defaults to something buyable',
      await evaluate(`document.querySelector('#buy-add')?.disabled`), false)
check('the button says what it does',
      await evaluate(`document.querySelector('#buy-add')?.textContent.trim()`), 'Add to basket')
check('the price shown is the VARIANT’s, not the family range',
      await evaluate(`/^\\$\\d+\\.\\d\\d$/.test(document.querySelector('.buy-price')?.textContent.trim() ?? '')`), true)

const chosenSku = await evaluate(`document.querySelector('.buy-line code, .buy-line .mono')?.textContent.trim()
                                  ?? [...document.querySelectorAll('.buy-line *')].map(e => e.textContent.trim()).find(t => /^FJS-/.test(t))`)
check('the buy box names one SKU', /^FJS-/.test(chosenSku ?? ''), true)

await evaluate(`(document.querySelector('#buy-add').click(), true)`)
for (let i = 0; i < 60; i++) {
  if (await evaluate(`!!document.querySelector('#nav-basket-count')`)) break
  await new Promise(r => setTimeout(r, 200))
}
check('the header count appears after one add',
      await evaluate(`document.querySelector('#nav-basket-count')?.textContent.trim()`), '1')

console.log('\n  basket — the screen')

await goto('/cart/', '#basket-lines .line', 1)
await settleImages('#basket-lines img.thumb')

check('the line is the one that was chosen',
      await evaluate(`document.querySelector('#basket-lines .line')?.dataset.sku`), chosenSku)
check('its thumbnail decoded',
      await evaluate(`(document.querySelector('#basket-lines img.thumb')?.naturalWidth ?? 0) > 0`), true)

const before = await evaluate(`document.querySelector('#basket-total')?.textContent.trim()`)
await evaluate(`(document.querySelector('[data-more]').click(), true)`)
for (let i = 0; i < 60; i++) {
  if (await evaluate(`document.querySelector('[data-qty]')?.textContent.trim() === '2'`)) break
  await new Promise(r => setTimeout(r, 200))
}
check('the stepper raises the quantity',
      await evaluate(`document.querySelector('[data-qty]')?.textContent.trim()`), '2')
check('and the total follows it',
      await evaluate(`document.querySelector('#basket-total')?.textContent.trim()`), t => t !== before)

console.log('\n  basket — checkout')

// A bad payload comes back keyed by field and worded by the SEED. Nothing in
// the browser knows the rule: `type CheckoutDetails` in db/schema.lite carries
// the @required message, junction derives the validator from it, and
// toFieldErrors puts it under the right box.
await evaluate(`(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel)
    el.value = v
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  set('#co-email', 'not-an-email')
  set('#co-name',  'A')
  document.querySelector('#co-submit').click()
  return true
})()`)
for (let i = 0; i < 60; i++) {
  if (await evaluate(`document.body.innerText.toLowerCase().includes('valid email')`)) break
  await new Promise(r => setTimeout(r, 200))
}
check('a bad email is refused in the seed’s own words',
      await evaluate(`document.body.innerText.toLowerCase().includes('valid email')`), true)
check('the refusal did not place an order',
      await evaluate(`!document.querySelector('#receipt')`), true)

const stockBefore = (await (await api('/product-variants?$limit=200')).json())
  .data.find(v => v.sku === chosenSku).stock

// The browser's own basket, read before checkout closes it and cart.js drops
// the token. The basket opened at the top of this file is a different one and
// is still open — asserting against it would prove nothing.
const shopper = JSON.parse(await evaluate(`localStorage.getItem('shop_cart')`) ?? 'null')

await evaluate(`(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel)
    el.value = v
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  set('#co-email', 'Drive@Shop.test')
  set('#co-name',  'Drive Shopper')
  set('#co-note',  'leave it with the neighbor')
  document.querySelector('#co-submit').click()
  return true
})()`)
for (let i = 0; i < 80; i++) {
  if (await evaluate(`!!document.querySelector('#receipt')`)) break
  await new Promise(r => setTimeout(r, 200))
}
check('the order is placed and the reference shown',
      await evaluate(`/ORD-[A-Z0-9]{6}/.test(document.querySelector('#receipt')?.innerText ?? '')`), true)
check('the basket is gone from the header',
      await evaluate(`!document.querySelector('#nav-basket-count')`), true)

const stockAfter = (await (await api('/product-variants?$limit=200')).json())
  .data.find(v => v.sku === chosenSku).stock
check('stock came down by what was bought', stockBefore - stockAfter, 2)

const customers = await (await asStaff('/customers?$limit=200')).json()
check('the guest became exactly one customer, lowercased',
      customers.data.filter(c => c.email === 'drive@shop.test').length, 1)

// ── What the order was billed for ─────────────────────────────────────────
//
// The basket is a shopper's object with a shopper's lifetime — swept when it is
// abandoned, emptiable after the order was placed — so an order that pointed at
// one for its itemisation would lose it. `carts.checkout` copies the lines at
// the moment of sale, and these are the assertions that the copy is a copy: the
// price, the quantity and the wording, written down and not looked up.
const reference = await evaluate(
  `document.querySelector('#receipt')?.innerText.match(/ORD-[A-Z0-9]{6}/)?.[0] ?? null`)
const placed = (await (await asStaff(`/orders?reference=${reference}`)).json()).data?.[0]
const billed = (await (await asStaff(`/order-lines?orderId=${placed?.id}&$orderBy=id`)).json()).data ?? []

check('the order records what was bought', billed.length, 1)
check('…the variant it was bought from', billed[0]?.sku, chosenSku)
check('…how many', billed[0]?.quantity, 2)
// The one that matters: the lines have to add up to the SUBTOTAL. Two numbers,
// two writes, one transaction — and the rounding is done once, on the server,
// which is why `lineTotal` is a column rather than a multiplication a screen
// does for itself.
//
// The subtotal and not the total, since shipping and tax arrived: `total` is
// what the card is charged and `subtotal` is what the itemisation explains.
// `verify:money` is where the rest of the breakdown is proved to add up.
check('…and the lines add up to the subtotal',
      billed.reduce((n, l) => n + l.lineTotal, 0), placed?.subtotal)

// A line is written by the shop recording its own sale — `OrderLine` is
// @@gate("0.8.8.8") and `order-lines` declares find and get — so there is no
// door for a caller to add one through. 405 at the service, before the Data
// boundary is ever asked.
const forged = await api('/order-lines', {
  method:  'POST',
  headers: { 'content-type': 'application/json' },
  body:    JSON.stringify({ orderId: placed?.id, sku: 'FORGED', description: 'free',
                            quantity: 1, unitPrice: 0, lineTotal: 0, variantId: 1 }),
})
check('nobody can add a line to an order', forged.status, 405)

// The basket is closed, and it says so rather than quietly accepting more.
const closed = await (await call('addLine', shopper.id, { variantId: 2 }, shopper.token)).json()
check('a checked-out basket refuses another line',
      /already been checked out/.test(closed.message ?? ''), true)

console.log(`\n  ${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail ? 1 : 0)
