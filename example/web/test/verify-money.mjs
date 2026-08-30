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

/** Dollars → the whole number of CENTS every money column stores. Every
 *  expectation below is written in the unit a person reads, exactly as
 *  `db/seed.ts` writes the fixture — `cents(4.95)` beside a shipping charge is
 *  checkable at a glance where `495` is a number you have to decode. */
const cents = (major) => Math.round(major * 100)

/** `Discount.value` is `@scale(2)` and not `@money`, because half its rows are
 *  a percentage (the schema says why). Same two places, different unit, and a
 *  different name so a reader can see which one an expectation means. */
const scaled = (n) => Math.round(n * 100)

/** A figure the shop produced, against one this drive computed.
 *
 *  It used to be a half-penny tolerance, and the tolerance was floating point:
 *  two doubles that both round to 4.95 are the same price. In cents both sides
 *  are integers wherever the shop did arithmetic, so what is left is the ONE
 *  place a rate is applied — and the honest comparison is to round the
 *  expectation the way `pricing.ts` rounds and then demand equality. */
const near = (a, b) => Number(a) === Math.round(Number(b))

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
    body:   JSON.stringify({ code, label: `drive code ${code}`, kind: 'percent', value: scaled(10), ...fields }),
  })
  const body = await r.json()
  if (!body?.id) throw new Error(`could not mint ${code}: ${JSON.stringify(body)}`)
  return body
}

// ─── The rules that span two columns ───────────────────────────────────────
//
// Five `@@check` constraints, and what makes them a feature rather than five
// validators is that not one of them can be written as a field rule: each reads
// a SECOND column of the same row. `value <= 100` is only true when `kind` is
// `percent`; a window is two nullable columns of which each is individually
// fine; and the receipt identity reads five.
//
// The other half is WHERE they hold. A `@@check` is in the table, so it fires
// for a migration, a seed, `fli tinker`, an atomic `{ increment: 1 }` — which
// computes inside SQLite, where nothing in this package runs — and for
// `asSystem()`, the bypass that drops the gate, the row policies and
// `@@softDelete` and cannot drop this. `carts.service.ts` counts a redemption
// with a read-modify-write PRECISELY so a validator can see the new value; the
// check is what makes that refusal true rather than merely usual.
//
// Which is why this section is in two halves and the split is not arbitrary:
// three of the five columns are `@system`, so no caller can reach them and the
// only boundary that can be asked is the Data one. Each case is otherwise a
// VALID payload with one value moved, and each refusal is paired with the
// acceptance next door — a refusal that cannot be shown to come from the rule
// it names proves nothing about that rule (`FJS-351`).

console.log('\n  the rules that span two columns')

let probed = 0
/** Post a discount that is valid but for the one value under test. Answers the
 *  status and, on a refusal, the declared message — not a class name: the whole
 *  point of the second argument to `@@check` is that the sentence the author
 *  wrote is the sentence the caller reads. */
async function tryMint(fields) {
  const code = `${PREFIX}X${String(++probed).padStart(2, '0')}`
  const r = await asStaff('/discounts', {
    method: 'POST',
    body:   JSON.stringify({ code, label: `probe ${code}`, kind: 'percent', value: scaled(10), ...fields }),
  })
  const body = await r.json()
  // Cleaned up on the way out: an accepted one is a row this drive made, and
  // `code` is @unique, so leaving it makes the next run's mint collide.
  if (r.ok && body?.id) await asStaff(`/discounts/${body.id}`, { method: 'DELETE' })
  return { status: r.status, message: (body?.data ?? [])[0]?.message ?? body?.message ?? null }
}

const overHundred = await tryMint({ value: scaled(150) })
check('a percentage over 100 is refused',       overHundred.status,  400)
check('…in the words the schema wrote',         overHundred.message, 'a percentage discount cannot be more than 100%')
check('…and exactly 100 is not',                (await tryMint({ value: scaled(100) })).status, 201)
// The one that separates this from `@lte(100)` on the field: the same number,
// the other kind. A fixed discount of 150 is £150 off, which is a real thing a
// shop sells, and a field rule could not tell the two apart.
check('…while 150 OFF is a discount, not an error',
      (await tryMint({ kind: 'fixed', value: scaled(150) })).status, 201)

const backwards = await tryMint({ endsAt: '2026-01-01T00:00:00.000Z', startsAt: '2026-12-01T00:00:00.000Z' })
check('a window that closes before it opens is refused', backwards.status,  400)
check('…in the words the schema wrote',                  backwards.message, 'a discount must end after it starts')
check('…the same two dates the right way round are not',
      (await tryMint({ startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' })).status, 201)
// Both columns are nullable and the rule says so: one date alone is a code that
// opens and never closes, which is the ordinary case.
check('…and a one-sided window is ordinary',
      (await tryMint({ endsAt: '2026-12-01T00:00:00.000Z' })).status, 201)

// ── The three no caller can reach ─────────────────────────────────────────
//
// `redemptions`, `subtotal`, `discount`, `shipping` and `tax` are all `@system`
// — the server writes them and a caller may not — so there is no request that
// can put a bad value in any of them, and the boundary that has to be asked is
// the Data one. A separate process under bun, because this file runs on node
// and the app's client is TypeScript; the API is up throughout, which is the
// point: SQLite enforces this for whoever is writing.
const dataBoundary = JSON.parse(execFileSync('bun', ['-e', `
import { sys } from './api/src/core/db.ts'

const P   = 'CHK' + Date.now().toString(36).slice(-5).toUpperCase()
const out = {}
const made = []

async function ask(name, fn) {
  try { const row = await fn(); made.push(row); out[name] = 'accepted' }
  catch (e) { out[name] = e?.errors?.[0]?.message ?? e?.message ?? String(e) }
}

// The receipt identity. 100 - 0 + 5 + 20 is 125, and this claims 999.
await ask('receiptRefused', () => sys.order.create({ data: {
  reference: P + '-1', status: 'pending', customerId: 1,
  subtotal: 100, discount: 0, shipping: 5, tax: 20, total: 999 } }))
await ask('receiptAccepted', () => sys.order.create({ data: {
  reference: P + '-2', status: 'pending', customerId: 1,
  subtotal: 100, discount: 0, shipping: 5, tax: 20, total: 125 } }))

// Off by ONE CENT, which is the smallest wrong answer that exists now. The
// rule used to carry a half-penny tolerance and accepted this class, because
// both sides were binary floating point and the drift was real; every one of
// these columns is \`@money(USD)\` and therefore an integer, so the identity is
// an equality and the nearest miss is refused like any other.
await ask('offByOneRefused', () => sys.order.create({ data: {
  reference: P + '-3', status: 'pending', customerId: 1,
  subtotal: 100, discount: 0, shipping: 5, tax: 20, total: 126 } }))

// A discount larger than the subtotal, with a breakdown that still adds up
// (10 - 50 + 45 + 0 = 5) — so the refusal can only be the rule under test.
await ask('discountRefused', () => sys.order.create({ data: {
  reference: P + '-4', status: 'pending', customerId: 1,
  subtotal: 10, discount: 50, shipping: 45, tax: 0, total: 5 } }))

// The exemption, and it is a real order rather than a loophole: staff raise one
// by hand with a total and nothing to itemise. A CHECK may not hold a subquery,
// so 'no lines' cannot be said and 'subtotal = 0' is what stands in for it.
await ask('handRaisedAccepted', () => sys.order.create({ data: {
  reference: P + '-5', status: 'pending', customerId: 1, subtotal: 0, total: 40 } }))

// The redemption ceiling. \`redemptions\` is the counter \`carts.checkout\`
// moves inside the sale's own transaction; this is the same column written from
// outside it.
const d = await sys.discount.create({ data: {
  code: P + 'D', label: 'check probe', kind: 'fixed', value: 5, maxRedemptions: 2 } })
await ask('redemptionsRefused', () => sys.discount.update({ where: { id: d.id }, data: { redemptions: 3 } }))
await ask('redemptionsAccepted', () => sys.discount.update({ where: { id: d.id }, data: { redemptions: 2 } }))

// Hard-deleted, not hidden: \`Order\` is @@softDelete and a hidden row keeps its
// @unique reference, so a soft delete here makes the next run collide.
for (const row of made) if (row?.reference) await sys.order.deleteMany({ where: { reference: row.reference }, withDeleted: true })
await sys.discount.deleteMany({ where: { code: P + 'D' } })

console.log(JSON.stringify(out))
`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop())

check('a receipt that does not add up is refused at the Data boundary',
      dataBoundary.receiptRefused,  'the breakdown does not add up to the total')
check('…and the same numbers made consistent are not',
      dataBoundary.receiptAccepted, 'accepted')
check('…and one cent out is refused, because cents do not drift',
      dataBoundary.offByOneRefused, 'the breakdown does not add up to the total')
check('a discount larger than the subtotal is refused',
      dataBoundary.discountRefused, 'a discount cannot be larger than the subtotal')
check('…while an order with no lines to itemise is exempt',
      dataBoundary.handRaisedAccepted, 'accepted')
check('a redemption past the limit is refused — with the gate bypassed',
      dataBoundary.redemptionsRefused, 'a code cannot be redeemed more times than its limit')
check('…and one up to it is not',
      dataBoundary.redemptionsAccepted, 'accepted')

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
const HOOD = priced(cents(65))
const MUG  = priced(cents(18))

console.log('\n  the shop\'s own rates')

check('a default tax rate is declared',   VAT?.rate,   0.2)
check('…and it is called something',      VAT?.label,  'VAT')
check('three delivery methods are offered', methods.length, 3)
check('…in the merchant\'s order, not alphabetically',
      methods.map(m => m.name), ['Standard', 'Express', 'Collect'])
check('…and one of them is free over a threshold', STANDARD?.freeOver, cents(75))

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
  body:   JSON.stringify({ code: `${PREFIX}XX`, label: 'forged', kind: 'fixed', value: scaled(1), redemptions: 99 }),
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
      cart.subtotal, HOOD.price + MUG.price)
check('…which is what the lines themselves add up to',
      cart.lines.reduce((n, l) => n + l.total, 0), cart.subtotal)
check('tax is charged on the subtotal where nothing else applies',
      near(cart.tax, cart.subtotal * VAT.rate), true)
check('the breakdown adds up to the total',
      cart.subtotal - cart.discount + cart.shipping + cart.tax, cart.total)
// Every money column is `@money(USD)`, so what comes back over the wire is a
// whole number of cents. This used to ask whether each figure survived a
// round trip through `toFixed(2)`, which is the closest a float can get to the
// question; the honest one is whether it is an integer at all.
check('every figure is cents, not a float',
      [cart.subtotal, cart.discount, cart.shipping, cart.tax, cart.total]
        .every(Number.isInteger), true)

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
const tenth   = await mint({ kind: 'percent', value: scaled(10) })
const fiver   = await mint({ kind: 'fixed',   value: scaled(5), minSubtotal: cents(200) })
const expired = await mint({ kind: 'percent', value: scaled(50), endsAt: new Date(Date.now() - day).toISOString() })
const future  = await mint({ kind: 'percent', value: scaled(50), startsAt: new Date(Date.now() + day).toISOString() })
const off     = await mint({ kind: 'percent', value: scaled(50), active: false })
const huge    = await mint({ kind: 'fixed',   value: scaled(10_000) })

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
      cart.subtotal - cart.discount + cart.shipping + cart.tax, cart.total)

// A fixed code worth more than the basket takes the basket, not more. The
// alternative is a negative subtotal that tax is then charged on and, at the
// end of it, a shop paying somebody to take its stock.
cart = await on(plain, 'applyDiscount', { code: huge.code })
check('a fixed code is capped at the subtotal', cart.discount, cart.subtotal)
// The tax is rounded once, on the delivery charge alone; adding it and then
// rounding the sum is a different figure by a cent, which is the whole reason
// `pricing.ts` rounds each component as it is produced.
check('…so the goods cost nothing and the delivery still does not',
      cart.total, cart.shipping + Math.round(cart.shipping * VAT.rate))

cart = await on(plain, 'removeDiscount')
check('removing a code puts the price back', [cart.discount, cart.discountCode], [0, null])
check('…including the delivery it had cost', cart.shipping, 0)

// ─── The limit, and the race ──────────────────────────────────────────────

console.log('\n  a code worth one redemption')

const once = await mint({ kind: 'fixed', value: scaled(3), maxRedemptions: 1 })

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
      lines.reduce((n, l) => n + l.lineTotal, 0), row?.subtotal)
check('…and the receipt adds up to the total',
      row.subtotal - row.discount + row.shipping + row.tax, row.total)

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
// The one comparison here that is NOT in cents, and the tolerance is back for
// exactly that reason: these five numbers were scraped out of rendered text, so
// they are the major-unit strings a person reads and adding them is floating
// point again. What the shop computed is asserted exactly, above; this asks
// whether what was printed can be checked by eye.
const sameOnScreen = (a, b) => Math.abs(a - b) < 0.005
check('the column on screen adds up to the figure at the bottom',
      sameOnScreen(shown.subtotal - Math.abs(shown.discount) + shown.shipping + shown.tax, shown.total), true)

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
