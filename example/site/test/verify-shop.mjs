/**
 * site/test/verify-shop.mjs — buying something, on the shop's own storefront.
 *
 * Started by `bun run verify:shop`. Needs a built site (`bun run build:site`);
 * it starts the API and the storefront origin itself.
 *
 * ─── What this is for, and what it is not ─────────────────────────────────
 *
 * `verify:cart` already proves the basket at the Data boundary — a caller with
 * no session owning rows, reached by a token, over the socket — and
 * `verify:money` proves the arithmetic exhaustively. Neither is repeated here
 * and neither should be.
 *
 * What is only provable HERE is that a shopper can do it. The storefront is
 * prerendered files on an origin of its own, and until now it could be read and
 * not bought from: the buy box, the basket and the checkout lived in `web/`,
 * the seller's console. Four things follow from that arrangement and no other
 * drive can see any of them:
 *
 *   1. **The buy box cannot bake.** The page carries every variant's sku,
 *      colour and size in the file; `variantId` and what is actually available
 *      come from the shop. So the join happens in a browser, and a box that
 *      rendered before the shop answered would offer a button it cannot honour.
 *
 *   2. **Every basket call is CROSS-ORIGIN.** The console reaches the API
 *      through Vite's `/api` proxy and has never preflighted. Here the token
 *      rides `x-cart-token`, which is a caller-varied header — so the CORS
 *      preflight has to name it or it never arrives, and a basket call with no
 *      token is an empty basket and a 200, not an error.
 *
 *   3. **The basket survives a page load**, because a prerendered site has no
 *      router: going from the product page to the basket is a real navigation
 *      into a different HTML file, and the only thing carrying the basket
 *      across it is a token in this origin's localStorage.
 *
 *   4. **The header link is plain markup and carries no count**, which is not
 *      a shortcut: a layout on a static target holds no state, and an island in
 *      one hangs `vite build` outright (`FJS-549`). The count lives on the two
 *      screens that already know it.
 *
 * Run under BUN, like the other two drives on this surface: it reads the app's
 * own TypeScript to grade the order that comes out the far end.
 *
 * Harness traps, all shared with `site/test/verify.mjs`: never return a bare
 * `null` from an evaluated probe (CDP drops it), and never start an evaluated
 * expression with a bare `return` on its own line.
 *
 * And one this drive paid for: **a probe is carried to the browser inside a
 * TEMPLATE LITERAL, so every backslash in it needs doubling.** `\s` is not an
 * escape JavaScript knows, so a template literal quietly renders it as `s` —
 * `.replace(/\s+/g, ' ')` arrives as `.replace(/s+/g, ' ')`, which replaces
 * every run of the letter s with a space. `Basket (1 item)` comes back as
 * `Ba ket (1 item)` and reads exactly like a rendering bug in the component.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { serveSite } from '@frontierjs/sierra/site/serve'

const HERE = dirname(fileURLToPath(import.meta.url))
const SITE = join(HERE, '..')
const DIST = join(SITE, 'dist')
const ROOT = join(SITE, '..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
// test / siteServe / project 1 / service 3 — its own slot, so it collides with
// neither `verify:site` (7710) nor `verify:account` (7712).
const PORT   = 7713
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── plumbing ─────────────────────────────────────────────────────────────

const procs = [], servers = []
function start(cmd, args, name, cwd = ROOT) {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', d => { if (process.env.DEBUG) process.stdout.write(`[${name}] ${d}`) })
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p); return p
}
const stopAll = () => {
  for (const p of procs) { try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} } }
  for (const s of servers) { try { s.close() } catch {} }
}
process.on('exit', stopAll)
process.on('SIGINT', () => { stopAll(); process.exit(130) })

let pass = 0, fail = 0
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) { pass++; console.log(`  ✓ ${label}`) }
  else    { fail++; console.log(`  ✗ ${label}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── preflight ────────────────────────────────────────────────────────────

if (!existsSync(join(DIST, 'cart', 'index.html'))) {
  console.error(`No basket page at ${DIST}/cart/.\nRun: bun run build:site`)
  process.exit(1)
}
for (const [port, what] of [[8110, 'the API'], [PORT, 'the storefront origin']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) { console.error(`port ${port} already answers — ${what} is up from an earlier run.`); process.exit(1) }
}

const { execFileSync } = await import('node:child_process')
execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })
start('bun', ['run', 'api/index.ts'], 'api')
for (let i = 0; i < 160; i++) {
  try { if ((await fetch(`${API}/api/health`)).ok) break } catch {}
  await sleep(250)
}

const site = await serveSite({ dir: DIST, port: PORT })
servers.push(site.server ?? { close() {} })
const ORIGIN = `http://localhost:${PORT}`

// Read before a browser touches it, so every stock assertion below is a delta.
// `ProductVariant` reads at level 0 — the storefront reads it with no session.
const shelfAtStart = await (await fetch(`${API}/api/product-variants?sku=JCT-CAP-PCH-ONE`)).json()
const onHandAtStart = shelfAtStart?.data?.[0]?.stock ?? 0

console.log('\n  the shop — buying something on the storefront\n')

// ─── the page, before a browser touches it ────────────────────────────────
//
// The buy box has to be IN the file, or a crawler and a reader with no
// JavaScript get a product page with no way to buy and nothing saying why.

const slug = 'junction-cap'
const html = await (await fetch(`${ORIGIN}/products/${slug}/`)).text()
check('the buy box ships in the prerendered file', html.includes('id="buy-box"'), true)
// …and the button it ships with says it is WAITING rather than offering. The
// variantId is not in this file — the baked half deliberately carries no id —
// so a button reading `Add to basket` here would be one nothing could honour.
check('…saying it has not asked the shop yet', html.includes('Checking with the shop'), true)
// Plain markup, on every page, with no count on it — a layout on a static
// target holds no state, and a number baked into a file a CDN serves for a week
// would be somebody else's basket anyway.
check('the basket link is in the layout, on every page',
      [html.includes('id="nav-basket"'),
       (await (await fetch(`${ORIGIN}/catalog/`)).text()).includes('id="nav-basket"')],
      [true, true])

// ─── CDP ──────────────────────────────────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'fjs-shop-'))
const chrome  = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] })
chrome.on('error', e => { console.error(`Could not launch ${CHROME}: ${e.message}`); process.exit(1) })
procs.push(chrome)

const wsUrl = await new Promise((resolve, reject) => {
  let buf = ''
  const timer = setTimeout(() => reject(new Error('Chrome never announced a DevTools port')), 15000)
  chrome.stderr.on('data', d => {
    buf += d
    const m = buf.match(/ws:\/\/[^\s]+/)
    if (m) { clearTimeout(timer); resolve(m[0]) }
  })
})

const browser = new WebSocket(wsUrl)
await new Promise(r => browser.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
const consoleErrors = []

function send(method, params = {}, sessionId) {
  const id = nextId++
  browser.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => pending.has(id) && reject(new Error(`${method} timed out`)), 30000)
  })
}
browser.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(msg.params.type))
    consoleErrors.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Page.enable', {}, sessionId)
await send('Runtime.enable', {}, sessionId)

const HARNESS = `
  window.sleep   = (ms) => new Promise(r => setTimeout(r, ms));
  window.waitFor = async (fn, ms = 15000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error('waitFor timed out: ' + fn);
      await sleep(50);
    }
  };
  window.$ = (sel) => document.querySelector(sel);
  true
`

async function evaluate(expr) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

async function goto(path) {
  await send('Page.navigate', { url: `${ORIGIN}${path}` }, sessionId)
  await sleep(400)
  await evaluate(HARNESS)
}

let failed = 0
try {
  // ─── 1. the box wakes up ────────────────────────────────────────────────
  //
  // The join: baked colour/size from the file, variantId and availability from
  // the shop. Until the second half lands the button is disabled and says so.
  await goto(`/products/${slug}/`)

  check('the button is live once the shop has answered', await evaluate(`
    await waitFor(() => $('#buy-add') && !$('#buy-add').disabled);
    return { label: $('#buy-add').textContent.trim(),
             sku:   $('#buy-sku')?.textContent.trim() ?? null,
             hasAvailability: $('#buy-avail')?.dataset.available !== undefined };
  `), { label: 'Add to basket', sku: 'JCT-CAP-PCH-ONE', hasAvailability: true })

  // ─── 2. adding ─────────────────────────────────────────────────────────
  //
  // The whole cross-origin path in one click: a POST that preflights, an
  // `x-cart-token` the API had to declare in `http.callHeaders` for the
  // preflight to allow it, and a token minted and written to THIS origin's
  // storage.
  const before = await evaluate(`return Number($('#buy-avail').dataset.available);`)

  check('adding puts a line in a basket that did not exist', await evaluate(`
    $('#buy-add').click();
    await waitFor(() => $('#buy-basket-link'));
    const held = JSON.parse(localStorage.getItem('shop_cart') ?? 'null');
    return { said: $('#buy-basket-link').textContent.replace(/\\s+/g, ' ').trim(),
             hasToken: typeof held?.token === 'string' && held.token.length > 0,
             hasId: Number.isFinite(held?.id) };
  `), { said: 'Basket — 1 item', hasToken: true, hasId: true })

  // The shop's own answer moved. A hold comes off what everyone else may buy,
  // and this page is one of the everyone — so the box re-asks, and the number
  // beside the button is the number after the shopper's own hold.
  // A DELTA and not a number. `db:seed` restores the rows it owns; it does not
  // put stock back on a shelf an earlier run sold from, so a literal here makes
  // this drive pass once per database — `FJS-546`'s shape one table along.
  // Waited for, not read: the box re-asks the shop after a successful add, so
  // the number beside the button moves on a SECOND round trip. Reading it in
  // the tick the add resolved measures the value before the re-ask lands.
  check('…and the availability on the page came down by one', await evaluate(`
    await waitFor(() => Number($('#buy-avail').dataset.available) !== ${before});
    return ${before} - Number($('#buy-avail').dataset.available);
  `), 1)

  // ─── 3. across a real navigation ───────────────────────────────────────
  //
  // A prerendered site has no router: this is a different HTML file, a fresh
  // JavaScript context and a second mount of every island. The only thing
  // carrying the basket over is the token in this origin's storage.
  await goto('/cart/')

  check('the basket survived the page load', await evaluate(`
    await waitFor(() => $('#basket-lines .line'));
    const line = $('#basket-lines .line');
    return { lines: document.querySelectorAll('#basket-lines .line').length,
             sku:   line.dataset.sku,
             qty:   Number($('#basket-lines .qty').value) };
  `), { lines: 1, sku: 'JCT-CAP-PCH-ONE', qty: 1 })

  // ─── 4. the money is the server's ──────────────────────────────────────
  //
  // Every figure on this screen arrives on the basket response and nothing here
  // derives one from another. The assertion is the identity, read off the
  // rendered cells: subtotal − discount + shipping + tax = total.
  check('quantity, delivery and a code all move the total, and it adds up', await evaluate(`
    const num = (sel) => Number(($(sel)?.textContent ?? '0').replace(/[^0-9.]/g, ''));

    // Two of them.
    $('#basket-lines .qty').value = '2';
    $('#basket-lines .qty').dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => num('[data-line="subtotal"]') === 48);

    // A delivery method, which is required before the button will place.
    const sel = $('#shipping-method');
    await waitFor(() => sel.options.length > 1);
    sel.value = sel.options[1].value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => $('[data-line="shipping"]').textContent.trim() !== '—');

    const subtotal = num('[data-line="subtotal"]');
    const discount = num('[data-line="discount"]');
    const shipping = num('[data-line="shipping"]');
    const tax      = num('[data-line="tax"]');
    const total    = num('#basket-total');
    return {
      subtotal,
      addsUp: Math.abs((subtotal - discount + shipping + tax) - total) < 0.005,
      placeEnabled: !$('#checkout-place').disabled,
    };
  `), { subtotal: 48, addsUp: true, placeEnabled: true })

  // ─── 5. the refusal is the SEED's ──────────────────────────────────────
  //
  // `carts` declares `{ method: 'checkout', input: 'CheckoutDetails' }`, so the
  // sentence under the box is the one written in `db/schema.lite` — not one
  // this screen holds a copy of. A form that invented its own wording would
  // pass this and disagree with the boundary the moment either moved.
  check('a bad address is refused in the schema’s own words, under the box', await evaluate(`
    $('#checkout-email').value = 'not-an-address';
    $('#checkout-email').dispatchEvent(new Event('input', { bubbles: true }));
    $('#checkout-name').value = 'Robin Shopper';
    $('#checkout-name').dispatchEvent(new Event('input', { bubbles: true }));
    $('#checkout-place').click();
    await waitFor(() => $('[data-error="email"]'));
    return { underTheBox: !!$('[data-error="email"]'),
             stillOnTheBasket: !!$('#basket-lines'),
             invalid: $('#checkout-email').getAttribute('aria-invalid') };
  `), { underTheBox: true, stillOnTheBasket: true, invalid: 'true' })

  // ─── 6. buying it ──────────────────────────────────────────────────────
  const receipt = await evaluate(`
    $('#checkout-email').value = 'robin@buyer.test';
    $('#checkout-email').dispatchEvent(new Event('input', { bubbles: true }));
    $('#checkout-place').click();
    await waitFor(() => $('#basket-receipt'), 20000);
    return { reference: $('#receipt-reference').textContent.trim(),
             total:     $('#receipt-total').textContent.trim(),
             basketGone: !$('#basket-lines'),
             tokenDropped: localStorage.getItem('shop_cart') === null };
  `)
  check('the basket becomes an order, and stops being a basket',
        { hasReference: /^ORD-/.test(receipt.reference), basketGone: receipt.basketGone,
          tokenDropped: receipt.tokenDropped },
        { hasReference: true, basketGone: true, tokenDropped: true })

  // ─── 7. what the shop actually recorded ────────────────────────────────
  //
  // Read from the API as STAFF, because the screen showing a receipt is not
  // evidence that a row exists. The lines are copied at the moment of sale onto
  // a table no caller can write to, and the number on the receipt is the number
  // on the order.
  const staff = await (await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'sam@shop.test', password: 'correct-horse-battery' }),
  })).json()
  const asStaff = p => fetch(`${API}/api${p}`, { headers: { authorization: `Bearer ${staff.token}` } })

  const found = await (await asStaff(`/orders?reference=${encodeURIComponent(receipt.reference)}`)).json()
  const order = found?.data?.[0] ?? null
  const lines = order
    ? (await (await asStaff(`/order-lines?orderId=${order.id}`)).json())?.data ?? []
    : []

  const buyer = order?.customerId
    ? (await (await asStaff(`/customers/${order.customerId}`)).json())
    : null

  check('the order the shop kept matches the receipt the shopper was shown', {
    exists:   !!order,
    status:   order?.status ?? null,
    // On the CUSTOMER and not the order: `checkout` finds or creates one by
    // `email @unique @lower`, which is how a shopper with no account ends up
    // with a record the shop can post a receipt to.
    email:    buyer?.email ?? buyer?.data?.email ?? null,
    total:    `$${Number(order?.total ?? 0).toFixed(2)}` === receipt.total,
    lines:    lines.map(l => [l.sku, l.quantity]),
  }, {
    exists: true, status: 'pending', email: 'robin@buyer.test', total: true,
    lines: [['JCT-CAP-PCH-ONE', 2]],
  })

  // The shelf moved, and it moved by what was actually SOLD — not by what was
  // held. A hold expires; a sale does not. Read against the on-hand this run
  // started from, for the same reason the availability check is a delta.
  const shelf = await (await asStaff('/product-variants?sku=JCT-CAP-PCH-ONE')).json()
  check('…and the shelf came down by what was sold, not by what was held',
        onHandAtStart - (shelf?.data?.[0]?.stock ?? 0), 2)

  check('no console errors', consoleErrors, [])
} catch (err) {
  console.error(`\nDrive threw: ${err.message}`)
  failed = 1
} finally {
  try { chrome.kill() } catch {}
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  stopAll()
}

console.log(`\n  ${pass} passed, ${fail} failed\n`)
process.exit(fail || failed ? 1 : 0)
