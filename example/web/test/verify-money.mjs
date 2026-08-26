/**
 * web/test/verify-money.mjs — what a basket costs, and why.
 *
 * Started by `bun run verify:money`. Starts both servers and Chrome itself,
 * like verify:cart and verify:catalogue, because what it proves spans them and
 * a dev server serves the code it started with.
 *
 * ─── What is under test ───────────────────────────────────────────────────
 *
 * Three things stand between the sum of the lines and what a card is charged,
 * and each is a different kind of thing: a discount is the shop giving
 * something up, shipping is a service it is buying on the shopper's behalf, and
 * tax is money that was never the shop's. `api/src/pricing.ts` is the one owner
 * of the arithmetic that combines them, and the whole point of this file is
 * that NOTHING ELSE computes any of it — not the basket screen, not the
 * receipt, not this drive. Every figure asserted below is compared against
 * another figure the server answered, or against arithmetic done here on
 * numbers the server also answered.
 *
 * ─── The two that no unit test can reach ──────────────────────────────────
 *
 *   the crossing   free delivery over 75, and a code that takes an 83 basket to
 *                  74.70. The threshold is measured AFTER the discount, so
 *                  applying a code can put the shipping charge back — which is
 *                  a rule that only exists where both features do
 *
 *   the race       a code worth one redemption, and two checkouts in flight at
 *                  once. The counter is a read-modify-write inside the sale's
 *                  own transaction; the interleaving that lets both past is
 *                  precisely what `BEGIN IMMEDIATE` is there to prevent, and a
 *                  test that checks them out one after another proves nothing
 *
 * ─── Why it mints its own codes ───────────────────────────────────────────
 *
 * `redemptions` is a counter that only goes up, so a drive using the seeded
 * `ONLYONCE` would pass once and fail on every later run — the shape `FJS-080`
 * cost this app before. Every code here is created through the STAFF service
 * under a run prefix and swept at the start, which also exercises the half of
 * `discounts` a shopper may never reach.
 */
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const UI   = process.env.UI_URL  ?? 'http://localhost:8010'

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

/** Every code this drive creates. Swept at the start, so a run that died half
 *  way does not poison the next one. */
const PREFIX = 'DRV'

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
// Detached, so stopAll can signal the GROUP: `npx vite` is a launcher, and a
// SIGTERM to the process this holds leaves vite itself on 8010 for the next
// drive to refuse.
function start(cmd, args, name) {
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
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

for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

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

const api = (path, opts = {}) => fetch(`${API}/api${path}`, opts)

/** Money compared as money. Two doubles that both round to 4.95 are the same
 *  price, and asserting on the bits instead is a flake nobody can read. */
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005

// ─── Staff, for the half of this a shopper may not touch ──────────────────

const staffToken = (await (await api('/auth/login', {
  method:  'POST',
  headers: { 'content-type': 'application/json' },
  body:    JSON.stringify({ email: 'alex@shop.test', password: 'correct-horse-battery' }),
})).json())?.token

const asStaff = (path, opts = {}) => api(path, {
  ...opts,
  headers: { 'content-type': 'application/json', ...(opts.headers ?? {}),
             authorization: `Bearer ${staffToken}` },
})

// A run that died half way leaves its codes behind, and `code` is `@unique` —
// so the next run's create answers 409 and the drive reports "the shop refused
// a valid code", which is true and about the wrong thing.
for (const stale of ((await (await asStaff(`/discounts?$limit=100`)).json()).data ?? [])
                    .filter(d => d.code?.startsWith(PREFIX))) {
  await asStaff(`/discounts/${stale.id}`, { method: 'DELETE' })
}

let minted = 0
/** A code of this shop's, made by staff through the ordinary service. */
async function mint(fields) {
  const code = `${PREFIX}${String(++minted).padStart(2, '0')}`
  const r = await asStaff('/discounts', {
    method: 'POST',
    body:   JSON.stringify({ code, label: `drive code ${code}`, kind: 'percent', value: 10, ...fields }),
  })
  const body = await r.json()
  if (!body?.id) throw new Error(`could not mint ${code}: ${JSON.stringify(body)}`)
  return body
}

// ─── Baskets ───────────────────────────────────────────────────────────────

const call = (method, id, body, token) => api(id == null ? '/carts' : `/carts/${id}`, {
  method:  'POST',
  headers: { 'content-type': 'application/json', 'X-Service-Method': method,
             ...(token ? { 'x-cart-token': token } : {}) },
  body:    JSON.stringify(body ?? {}),
})

/** A fresh basket holding exactly these variants. Anonymous throughout — a
 *  basket needs no session, which is what `verify:cart` is about and is assumed
 *  here. */
async function basket(items) {
  const opened = await (await call('open', null)).json()
  for (const { variantId, quantity = 1 } of items) {
    await call('addLine', opened.id, { variantId, quantity }, opened.token)
  }
  return opened
}
const on = (cart, method, body) => call(method, cart.id, body, cart.token).then(r => r.json())
/** Read the basket back. A plain GET rather than `on(cart, 'get')`: `get` is
 *  CRUD and the POST + `X-Service-Method` form is for the custom methods. */
const read = (cart) => api(`/carts/${cart.id}`, { headers: { 'x-cart-token': cart.token } })
  .then(r => r.json())

// The two rows every arithmetic assertion below is built from, read rather than
// typed: a price edited in the seed must move this drive's expectations with it.
const methods = (await (await api('/shipping-methods?$orderBy=position')).json()).data ?? []
const STANDARD = methods.find(m => m.name === 'Standard')
const EXPRESS  = methods.find(m => m.name === 'Express')
const VAT      = (await (await api('/tax-rates?isDefault=true')).json()).data?.[0]

const variants = (await (await api('/product-variants?$limit=50&$orderBy=id')).json()).data ?? []
const priced   = (want) => variants.find(v => v.price === want && v.active && v.stock > 5)
/** A hoodie and a mug: 83, which is over the free-delivery threshold of 75 and
 *  under it once a tenth is taken off. The whole crossing case is these two
 *  rows, so they are found by PRICE rather than by SKU — a catalogue edit that
 *  moves them should fail here loudly rather than quietly stop testing it. */
const HOOD = priced(65)
const MUG  = priced(18)

console.log('\n  the shop\'s own rates')

check('a default tax rate is declared',   VAT?.rate,   0.2)
check('…and it is called something',      VAT?.label,  'VAT')
check('three delivery methods are offered', methods.length, 3)
check('…in the merchant\'s order, not alphabetically',
      methods.map(m => m.name), ['Standard', 'Express', 'Collect'])
check('…and one of them is free over a threshold', STANDARD?.freeOver, 75)

// ─── The gate that separates the two tables ───────────────────────────────
//
// Both are read by the same basket screen, one of them by a caller with no
// session at all. `ShippingMethod` is `@@gate("0.5.5.5")` and `Discount` is
// `@@gate("5.5.5.5")`, and the difference is not decoration: `GET /api/discounts`
// answering the table hands every unreleased code to whoever asks for it.

console.log('\n  who may read what')

check('a stranger reads the delivery options', (await api('/shipping-methods')).status, 200)
check('a stranger reads the tax rate',         (await api('/tax-rates')).status,        200)
check('a stranger may NOT list the codes',     (await api('/discounts')).status,        401)
check('staff may',                             (await asStaff('/discounts')).status,    200)

// `redemptions` is `@system` — readable by anyone, refused on write by name, so
// a merchant editing a code cannot set the count and neither can anybody else.
// A counter a person can write is not a count of anything.
const forgedCount = await asStaff('/discounts', {
  method: 'POST',
  body:   JSON.stringify({ code: `${PREFIX}XX`, label: 'forged', kind: 'fixed', value: 1, redemptions: 99 }),
})
// 403 and not 400: `@system` is an ACCESS refusal at the Data boundary naming
// the field, where a 400 would mean the value was the wrong shape.
check('nobody writes the redemption count', forgedCount.status, 403)

// ─── The arithmetic ───────────────────────────────────────────────────────

console.log('\n  what a basket costs')

const empty = await (await call('open', null)).json()
check('an empty basket costs nothing',
      [empty.subtotal, empty.discount, empty.shipping, empty.tax, empty.total], [0, 0, 0, 0, 0])
// The RATE is on the response even where the tax is zero: it is a fact about
// the shop, not about this basket, and a storefront showing tax-inclusive
// prices needs it before anything is in the basket at all.
check('…and still names the shop\'s rate', empty.taxRate, 0.2)

const plain = await basket([{ variantId: HOOD.id, quantity: 1 }, { variantId: MUG.id, quantity: 1 }])
let cart = await read(plain)

check('the subtotal is the lines',
      cart.subtotal, Number((HOOD.price + MUG.price).toFixed(2)))
check('…which is what the lines themselves add up to',
      near(cart.lines.reduce((n, l) => n + l.total, 0), cart.subtotal), true)
check('tax is charged on the subtotal where nothing else applies',
      near(cart.tax, cart.subtotal * VAT.rate), true)
check('the breakdown adds up to the total',
      near(cart.subtotal - cart.discount + cart.shipping + cart.tax, cart.total), true)
// Each component is rounded as it is produced and the total is the sum of the
// rounded ones — so every figure on the response is already a price, and a
// screen printing them is printing money rather than a float.
check('every figure is a price, not a float',
      [cart.subtotal, cart.discount, cart.shipping, cart.tax, cart.total]
        .every(n => Number(n.toFixed(2)) === n), true)

// ─── Delivery ─────────────────────────────────────────────────────────────

console.log('\n  delivery')

cart = await on(plain, 'setShipping', { shippingMethodId: EXPRESS.id })
check('a chosen method is charged',      cart.shipping,      EXPRESS.price)
check('…and named',                      cart.shippingLabel, 'Express')
check('…and taxed with everything else',
      near(cart.tax, (cart.subtotal + EXPRESS.price) * VAT.rate), true)

cart = await on(plain, 'setShipping', { shippingMethodId: STANDARD.id })
// 83 is over 75, so Standard costs nothing — and it is still NAMED, because a
// zero against a method reads as free delivery and a zero against nothing reads
// as an unanswered question.
check('a threshold met is free delivery', cart.shipping,      0)
check('…and the method is still named',   cart.shippingLabel, 'Standard')

const undecided = await on(plain, 'setShipping', { shippingMethodId: null })
check('choosing nothing is a choice',     undecided.shippingLabel, null)

const refused = await on(plain, 'setShipping', { shippingMethodId: 999999 })
check('a method the shop does not offer is refused by name',
      /no longer available/.test(refused.message ?? ''), true)

// ─── Codes, and the four ways one is worth nothing ────────────────────────

console.log('\n  discount codes')

const day     = 24 * 60 * 60 * 1000
const tenth   = await mint({ kind: 'percent', value: 10 })
const fiver   = await mint({ kind: 'fixed',   value: 5, minSubtotal: 200 })
const expired = await mint({ kind: 'percent', value: 50, endsAt: new Date(Date.now() - day).toISOString() })
const future  = await mint({ kind: 'percent', value: 50, startsAt: new Date(Date.now() + day).toISOString() })
const off     = await mint({ kind: 'percent', value: 50, active: false })
const huge    = await mint({ kind: 'fixed',   value: 10_000 })

await on(plain, 'setShipping', { shippingMethodId: STANDARD.id })

const nosuch = await on(plain, 'applyDiscount', { code: 'NOSUCHCODE' })
check('a code the shop never issued',
      /not one this shop issued/.test(nosuch.message ?? ''), true)
check('…and it is a 400, not a 404 — the basket is fine, the code is not',
      nosuch.code, 400)

check('a code that has ended',
      /has expired/.test((await on(plain, 'applyDiscount', { code: expired.code })).message ?? ''), true)
check('a code that has not started',
      /not valid yet/.test((await on(plain, 'applyDiscount', { code: future.code })).message ?? ''), true)
check('a code that was switched off',
      /no longer available/.test((await on(plain, 'applyDiscount', { code: off.code })).message ?? ''), true)
check('a code below its minimum spend',
      /at least/.test((await on(plain, 'applyDiscount', { code: fiver.code })).message ?? ''), true)

// A refused code leaves the basket exactly as it was. Four rejections in a row
// and the money must not have moved — the alternative is a basket that prices
// differently for having been typed at.
cart = await read(plain)
check('a refused code changes nothing', [cart.discount, cart.discountCode], [0, null])

// Typed in lower case, because a code read off a poster will be. The column is
// `@upper`, so the stored form and the typed form are never the same string.
cart = await on(plain, 'applyDiscount', { code: tenth.code.toLowerCase() })
check('a code is matched however it is typed', cart.discountCode, tenth.code)
check('…a percentage comes off the subtotal',
      near(cart.discount, cart.subtotal * 0.1), true)
check('…and the shop\'s own wording is on the basket', cart.discountLabel, tenth.label)

// ── The crossing ─────────────────────────────────────────────────────────
//
// The headline. 83 is over the 75 threshold, so Standard was free; a tenth off
// takes it to 74.70, which is not, so the delivery charge comes BACK. Neither
// feature can produce this on its own, and no unit test of either sees it.
check('a code can take a basket back below the free-delivery threshold',
      cart.shipping, STANDARD.price)
check('…and the tax follows the new figures',
      near(cart.tax, (cart.subtotal - cart.discount + cart.shipping) * VAT.rate), true)
check('…and it still adds up',
      near(cart.subtotal - cart.discount + cart.shipping + cart.tax, cart.total), true)

// A fixed code worth more than the basket takes the basket, not more. The
// alternative is a negative subtotal that tax is then charged on and, at the
// end of it, a shop paying somebody to take its stock.
cart = await on(plain, 'applyDiscount', { code: huge.code })
check('a fixed code is capped at the subtotal', cart.discount, cart.subtotal)
check('…so the goods cost nothing and the delivery still does not',
      near(cart.total, cart.shipping + cart.shipping * VAT.rate), true)

cart = await on(plain, 'removeDiscount')
check('removing a code puts the price back', [cart.discount, cart.discountCode], [0, null])
check('…including the delivery it had cost', cart.shipping, 0)

// ─── The limit, and the race ──────────────────────────────────────────────

console.log('\n  a code worth one redemption')

const once = await mint({ kind: 'fixed', value: 3, maxRedemptions: 1 })

// Two baskets, both holding the code, both checking out at the same instant.
// Both passed the apply-time check — at that moment the count really was 0 —
// so the only thing standing between them and two redemptions of a
// one-redemption code is the read-modify-write inside the sale's transaction.
const racers = await Promise.all([
  basket([{ variantId: MUG.id, quantity: 1 }]),
  basket([{ variantId: MUG.id, quantity: 1 }]),
])
const applied = await Promise.all(racers.map(c => on(c, 'applyDiscount', { code: once.code })))
check('both baskets take the code', applied.map(a => a.discountCode), [once.code, once.code])

const settled = await Promise.all(racers.map((c, i) =>
  on(c, 'checkout', { email: `racer${i}@drive.test`, name: `Racer ${i}` })))

const won  = settled.filter(r => r.reference)
const lost = settled.filter(r => !r.reference)
check('exactly one of them gets the discount', won.length, 1)
check('…and the other is refused by name',
      /maximum number of times/.test(lost[0]?.message ?? ''), true)
check('…the winner was charged for it', won[0]?.discountCode, once.code)

const spent = await (await asStaff(`/discounts/${once.id}`)).json()
check('the counter moved exactly once', spent.redemptions, 1)

// A basket that carried the code and never paid redeemed nothing. The count is
// incremented in the checkout's own transaction, so an abandoned basket — which
// is most baskets — costs a limited code nothing.
const abandoned = await basket([{ variantId: MUG.id, quantity: 1 }])
await on(abandoned, 'applyDiscount', { code: tenth.code })
const untouched = await (await asStaff(`/discounts/${tenth.id}`)).json()
check('an abandoned basket redeems nothing', untouched.redemptions, 0)

// ─── The receipt ──────────────────────────────────────────────────────────

console.log('\n  what the sale wrote down')

const buying = await basket([{ variantId: HOOD.id, quantity: 1 }, { variantId: MUG.id, quantity: 1 }])
await on(buying, 'setShipping', { shippingMethodId: EXPRESS.id })
const quoted  = await on(buying, 'applyDiscount', { code: tenth.code })
const receipt = await on(buying, 'checkout', { email: 'receipt@drive.test', name: 'Rita Receipt' })

check('checkout answers the whole breakdown, not just a figure',
      ['subtotal', 'discount', 'discountCode', 'shipping', 'shippingLabel', 'tax', 'taxRate', 'taxLabel', 'total']
        .every(k => k in receipt), true)
// The basket quoted a price and the order charged one. They are computed by the
// same function from the same rows a moment apart, and if they can differ the
// shopper agreed to one number and paid another.
check('…and it is the figure the basket quoted', receipt.total, quoted.total)

const order = await (await asStaff(`/orders?reference=${receipt.reference}`)).json()
const row   = order.data?.[0]
const lines = (await (await asStaff(`/order-lines?orderId=${row?.id}&$orderBy=id`)).json()).data ?? []

check('the order stores the subtotal',        row?.subtotal,      receipt.subtotal)
check('…the code it was given',               row?.discountCode,  tenth.code)
check('…and the wording, not just the code',  row?.discountLabel, tenth.label)
check('…the delivery method by name',         row?.shippingLabel, 'Express')
check('…the tax and the rate it came from',   [row?.tax, row?.taxRate], [receipt.tax, VAT.rate])
check('…and the total the card was charged',  row?.total,         receipt.total)

check('the lines add up to the subtotal',
      near(lines.reduce((n, l) => n + l.lineTotal, 0), row?.subtotal), true)
check('…and the receipt adds up to the total',
      near(row.subtotal - row.discount + row.shipping + row.tax, row.total), true)

// The rate is COPIED and not joined. A merchant editing the rate tomorrow must
// not reprice a sale from today, which is the whole reason nine columns exist
// where two references would have done.
await asStaff(`/tax-rates/${VAT.id}`, { method: 'PATCH', body: JSON.stringify({ rate: 0.05 }) })
const later = (await (await asStaff(`/orders?reference=${receipt.reference}`)).json()).data?.[0]
check('a rate edited afterwards does not reprice the sale',
      [later?.tax, later?.taxRate, later?.total], [row.tax, row.taxRate, row.total])
await asStaff(`/tax-rates/${VAT.id}`, { method: 'PATCH', body: JSON.stringify({ rate: VAT.rate }) })

// ─── Chrome ────────────────────────────────────────────────────────────────

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

const errors = []
await send('Runtime.enable', {}, sessionId)
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
    errors.push((m.params.args ?? []).map(a => a.value ?? a.description).join(' '))
  }
})

async function evaluate(expr) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}

async function waitSel(sel, atLeast = 1, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(`document.querySelectorAll('${sel}').length`) >= atLeast) return true
    await new Promise(r => setTimeout(r, 150))
  }
  return false
}
/** Wait for a node's text to be something other than what it was. Every write
 *  on this screen is a round trip, so an assertion read straight after a click
 *  reads the figure that was there before it. */
async function waitText(sel, was, tries = 100) {
  for (let i = 0; i < tries; i++) {
    const now = await evaluate(`document.querySelector('${sel}')?.textContent?.trim() ?? null`)
    if (now !== was) return now
    await new Promise(r => setTimeout(r, 150))
  }
  return await evaluate(`document.querySelector('${sel}')?.textContent?.trim() ?? null`)
}
const text = (sel) => evaluate(`document.querySelector('${sel}')?.textContent?.trim() ?? null`)
const click = (sel) => evaluate(`(document.querySelector('${sel}')?.click(), true)`)

console.log('\n  the basket screen')

// The browser gets a basket of its own by holding the token in localStorage —
// the same shape `cart.js` uses, because there is no other way in: `Cart.token`
// is `@guarded` and `open` is the one call that ever answers one.
const shopper = await basket([{ variantId: HOOD.id, quantity: 1 }, { variantId: MUG.id, quantity: 1 }])
await send('Page.navigate', { url: `${UI}/` }, sessionId)
await waitSel('body')
await evaluate(`localStorage.setItem('shop_cart', ${JSON.stringify(JSON.stringify({ token: shopper.token, id: shopper.id }))})`)

await send('Page.navigate', { url: `${UI}/cart/` }, sessionId)
if (!await waitSel('#basket-total')) { console.error('the basket screen never rendered its total'); stopAll(); process.exit(1) }

check('the screen shows the subtotal',   await text('#basket-subtotal'), t => /\d/.test(t ?? ''))
check('…and the tax, named',             await text('[data-line="tax"]'), t => /VAT/.test(t ?? ''))
check('…and the grand total',            await text('#basket-total'),    t => /\d/.test(t ?? ''))
check('…and no discount line, because there is no code yet',
      await evaluate(`!!document.querySelector('[data-line="discount"]')`), false)

// Delivery, picked in the browser. 83 is over the threshold, so Standard reads
// as free — a word rather than a zero, because `$0.00` beside a method reads as
// a bug and `Free` does not.
if (!await waitSel('[data-shipping="Standard"]')) { console.error('no delivery options'); stopAll(); process.exit(1) }
const beforeShip = await text('#basket-total')
await click('[data-shipping="Standard"]')
await waitText('#basket-total', beforeShip)
check('picking free delivery says so', await text('#basket-shipping'), 'Free')

const beforeExpress = await text('#basket-total')
await click('[data-shipping="Express"]')
await waitText('#basket-total', beforeExpress)
check('picking a paid method charges for it',
      await text('#basket-shipping'), t => /\d/.test(t ?? ''))
check('…and the total moves with it',
      await text('#basket-total'), t => t !== beforeExpress)

// A code, typed. The box sends a string; every figure that changes comes back
// from the server.
await click('[data-shipping="Standard"]')
await new Promise(r => setTimeout(r, 400))
const beforeCode = await text('#basket-total')
await evaluate(`(() => {
  const el = document.querySelector('#discount-code')
  el.value = ${JSON.stringify(tenth.code)}
  el.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
// Apply is disabled while the box is empty, and the box being filled is a
// render away: clicking in the same tick clicks a disabled button, which does
// nothing and looks exactly like a broken handler.
for (let i = 0; i < 40; i++) {
  if (await evaluate(`!document.querySelector('#apply-discount')?.disabled`)) break
  await new Promise(r => setTimeout(r, 100))
}
check('the Apply button waits for a code to be typed',
      await evaluate(`!document.querySelector('#apply-discount')?.disabled`), true)
await click('#apply-discount')
await waitText('#basket-total', beforeCode)

check('an applied code names itself on the basket', await text('#applied-code'), tenth.code)
check('…and draws its own line',
      await text('[data-line="discount"]'), t => /−|-/.test(t ?? ''))
// The crossing again, this time as a person sees it: the delivery that was free
// a moment ago is not, because the code took the basket under the threshold.
check('…and the free delivery it lost comes back as a charge',
      await text('#basket-shipping'), t => /\d/.test(t ?? ''))

// What is on screen has to add up. Every figure is parsed back out of the
// rendered text rather than read off the store, because a screen that prints a
// breakdown the eye cannot check is the failure this whole feature is about.
const shown = await evaluate(`(() => {
  const num = (sel) => {
    const t = document.querySelector(sel)?.textContent ?? ''
    const m = t.replace(/[^0-9.\\-−]/g, '').replace('−', '-')
    return m ? Number(m) : 0
  }
  return {
    subtotal: num('#basket-subtotal'),
    discount: num('#basket-discount'),
    shipping: num('#basket-shipping'),
    tax:      num('#basket-tax'),
    total:    num('#basket-total'),
  }
})()`)
check('the column on screen adds up to the figure at the bottom',
      near(shown.subtotal - Math.abs(shown.discount) + shown.shipping + shown.tax, shown.total), true)

// Removing it from the screen, and the price going back.
const beforeRemove = await text('#basket-total')
await click('#remove-discount')
await waitText('#basket-total', beforeRemove)
check('removing the code from the screen puts the price back',
      await evaluate(`!!document.querySelector('[data-line="discount"]')`), false)
check('…and the delivery is free again',  await text('#basket-shipping'), 'Free')

// ─── The receipt, on screen ───────────────────────────────────────────────

console.log('\n  the receipt')

await evaluate(`(() => {
  for (const [sel, v] of [['#co-email', 'browser@drive.test'], ['#co-name', 'Bea Rowser']]) {
    const el = document.querySelector(sel)
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return true
})()`)
await click('#co-submit')
if (!await waitSel('#receipt')) { console.error('the order never completed'); stopAll(); process.exit(1) }

check('the receipt states what was charged', await text('#receipt-total'), t => /\d/.test(t ?? ''))
check('…and explains it',
      await text('#receipt-breakdown'), t => /in items/.test(t ?? '') && /VAT/.test(t ?? ''))

// ─── The order, as staff read it ──────────────────────────────────────────

const placedRef = await evaluate(
  `document.querySelector('#receipt')?.innerText.match(/ORD-[A-Z0-9]{6}/)?.[0] ?? null`)
const placed = (await (await asStaff(`/orders?reference=${placedRef}`)).json()).data?.[0]

console.log('\n  the order screen')

// Signed in as staff in the browser, because `Order` is `@@gate("1.4.4.5")`
// with two allows — a stranger reading the ledger is exactly what `FJS-498`
// closed, and this screen is staff's.
await send('Page.navigate', { url: `${UI}/` }, sessionId)
await waitSel('body')
// The key is the app's own — `tokenKey: 'shop_token'` in web/config/sierra.config.js
// — and the value is the RAW token: `localTokenStore` calls `setItem(key, token)`
// with no JSON around it, so a stringified one is a token with quotes in it and
// every call comes back 401.
await evaluate(`localStorage.setItem('shop_token', ${JSON.stringify(staffToken)})`)
await send('Page.navigate', { url: `${UI}/orders/${placed.id}/` }, sessionId)

if (!await waitSel('#items-order-total')) {
  console.error('the order screen never rendered its total')
} else {
  check('the order screen shows the subtotal',  await text('#items-subtotal'),  t => /\d/.test(t ?? ''))
  check('…the delivery charge',                 await text('[data-receipt="shipping"]'), t => /Standard|Express|Free/.test(t ?? ''))
  check('…the tax with the rate it came from',  await text('[data-receipt="tax"]'), t => /VAT at 20%/.test(t ?? ''))
  check('…and the total the card was charged',  await text('#items-order-total'), t => /\d/.test(t ?? ''))
}

check('no console errors', errors.filter(e => !/favicon/i.test(e)), [])

console.log(`\n  ${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail ? 1 : 0)
