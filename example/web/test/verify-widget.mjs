/**
 * web/test/verify-widget.mjs — a buy button on a page the shop does not own.
 *
 * Started by `bun run verify:widget`. Starts everything itself: the API, the
 * SPA, the widget origin, a host-page origin, and Chrome.
 *
 * ─── Four origins, and that is the point ──────────────────────────────────
 *
 *   :8110  the API              the shop's data, cross-origin to everything
 *   :8010  the shop's own site  where a basket is checked out
 *   :7310  the widget origin    static files, served by the module that deploys
 *   :7311  a host page          somebody's blog. Owns none of the above
 *
 * Nothing in the SPA's own drives can see any of this. `verify:cart` proves a
 * stranger can own a basket, but it does so from the shop's own origin behind
 * Vite's `/api` proxy, so every call there is SAME-origin and no preflight ever
 * happens. Here the widget is a guest: CORS is real, the shadow root is real,
 * and the host page's CSS is written to be hostile.
 *
 * ─── The handoff is the hard part ─────────────────────────────────────────
 *
 * `localStorage` is per origin, so a basket started by a widget on somebody's
 * blog is invisible to the shop's own site — they cannot read each other's
 * storage and no amount of wanting changes that. What crosses is a ONE-TIME
 * CODE in the URL fragment (never sent to a server, in no `Referer` and no
 * access log), redeemed once for the token and cleared in the same transaction
 * that read it. Both halves are asserted: that it works, and that it works
 * exactly once.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API  = process.env.API_URL ?? 'http://localhost:8110'
const UI   = process.env.UI_URL  ?? 'http://localhost:8010'

// Test-env ports: 7 = test, 3 = widgetServe, 1 = example. Service 0 is the
// widget origin and 1 is the host page — both are static origins in the embed
// story, so they share a category. The DEV pair is 8310/—; using it here would
// collide with a `bun run serve:widgets` somebody has open.
const WIDGETS = 7310
const HOST    = 7311

const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
function start(cmd, args, name) {
  // detached, so stopAll can signal the GROUP: `npx vite` is a launcher and
  // killing it leaves vite itself holding 8010 for the next drive.
  const p = spawn(cmd, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', () => {})
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}

const servers = []
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
  for (const s of servers) { try { s.close() } catch {} }
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

for (const [port, what] of [[8110, 'the API'], [8010, 'the dev server'], [WIDGETS, 'the widget origin'], [HOST, 'the host page']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

// The widgets have to be BUILT before they can be served, and a stale
// dist/embeds is a drive that passes against the previous edit — the same trap
// as a dev server serving the code it started with.
await new Promise((res, rej) => {
  const p = spawn('bunx', ['sierra', 'widgets', '--config', 'config/sierra.config.js'],
                  { cwd: join(ROOT, 'widgets'), stdio: process.env.DEBUG ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
  p.on('exit', code => code === 0 ? res() : rej(new Error(`widget build failed (${code})`)))
})

// Seeding is a step, not a boot side effect, so this drive takes it. Against an
// empty database every assertion below fails as "the row is not there", which
// reads as a regression in whatever was just changed. Idempotent — a seeded
// database costs one pass of existence checks.
execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })

start('bun', ['run', 'api/index.ts'], 'api')
start('npx', ['vite', '-c', 'web/config/vite.config.js'], 'web')

// The widget origin is SIERRA'S OWN server — the one `sierra widgets --serve`
// runs and the one widgets/deploy/serve.js runs in a container. A second server
// written for this test would prove nothing about the headers that ship.
const { serveWidgets } = await import('@frontierjs/sierra/widget/serve')
const widgetOrigin = await serveWidgets({ dir: join(ROOT, 'widgets/dist/embeds'), port: WIDGETS })
servers.push(widgetOrigin.server ?? { close() {} })

// The host page. A plain static server on its own origin, because what makes
// this a cross-origin test is that the page and the script have different ones.
const hostPage = createServer(async (req, res) => {
  try {
    const file = await readFile(join(ROOT, 'widgets/test/fjs-buy-button.html'), 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    // One string, not a second copy of the page: the committed host page points
    // at the DEV widget origin so it can be opened by hand.
    res.end(file.replaceAll('http://localhost:8310', `http://localhost:${WIDGETS}`))
  } catch (e) {
    res.writeHead(500); res.end(String(e))
  }
})
await new Promise(r => hostPage.listen(HOST, r))
servers.push(hostPage)

if (!await waitFor(`${API}/api/products`, 'api')) { stopAll(); process.exit(1) }
if (!await waitFor(UI, 'web'))                    { stopAll(); process.exit(1) }

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

const post = (svc, method, id, body, headers = {}) =>
  fetch(id == null ? `${API}/api/${svc}` : `${API}/api/${svc}/${id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Service-Method': method, ...headers },
    body: JSON.stringify(body ?? {}),
  })

const SKU = 'FJS-TEE-NVY-M'

// ─── One call, everything a button needs ───────────────────────────────────

console.log('\n  widget — what the shop answers an embed')

const embed = await (await post('product-variants', 'embed', null, { sku: SKU })).json()
check('one call carries the product, the price and what may be sold',
      [typeof embed.product, typeof embed.price, typeof embed.available, embed.sku],
      ['string', 'number', 'number', SKU])
check('and a photograph as a URL, not a stored reference',
      String(embed.image).startsWith('http'), true)
// `held` is a fact about other people's baskets. The number that crosses is
// what may be sold; the rows behind it stay at level 5.
check('but nothing about anybody else\'s basket', 'held' in embed, false)

check('a SKU the merchant typed in lower case still finds the product',
      (await (await post('product-variants', 'embed', null, { sku: SKU.toLowerCase() })).json()).variantId,
      embed.variantId)

const missing = await post('product-variants', 'embed', null, { sku: 'NO-SUCH-SKU' })
check('a SKU the shop never issued is a 404 in the shop\'s words',
      [missing.status, (await missing.json()).message], [404, 'No product with SKU NO-SUCH-SKU'])

// ─── CORS, which nothing else here needs ───────────────────────────────────
//
// The SPA is served by Vite, which proxies /api, so every call it makes is
// same-origin and no preflight ever happens. A widget is the first thing in
// this app that is a guest on another origin.

const pre = await fetch(`${API}/api/carts`, {
  method: 'OPTIONS',
  headers: {
    origin: `http://localhost:${HOST}`,
    'access-control-request-method':  'POST',
    'access-control-request-headers': 'content-type,x-service-method,x-cart-token',
  },
})
const allowed = String(pre.headers.get('access-control-allow-headers') ?? '').toLowerCase()
check('a preflight from a stranger\'s origin is answered', pre.status < 400, true)
check('and allows the header a custom method is addressed by',
      allowed.includes('x-service-method'), true)
// Declared ONCE, in http.callHeaders, and read by both the CORS allow-list and
// the WebSocket frame merge. An app that had to remember both works until it is
// served from a second origin.
check('and the basket token, because http.callHeaders is what the allow-list reads',
      allowed.includes('x-cart-token'), true)

// ─── The served origin ─────────────────────────────────────────────────────

const script = await fetch(`http://localhost:${WIDGETS}/BuyButton.js`)
check('the widget origin answers the bundle', script.status, 200)
check('with CORS, because everything after the load needs it',
      script.headers.get('access-control-allow-origin'), '*')
// The entry's URL is what a host page pasted into their CMS a year ago and
// cannot change, so a long max-age is a widget nobody can ship a fix to.
check('and a cache answer that leaves the entry shippable',
      /must-revalidate/.test(script.headers.get('cache-control') ?? ''), true)

const bundle = await script.text()
check('the bundle is self-contained — no import of anything',
      /(^|[^.\w])import\s*[({'"]/.test(bundle), false)
check('and carries its own CSS rather than asking for a second file',
      bundle.includes('inline-flex'), true)

// ─── The browser ───────────────────────────────────────────────────────────

console.log('\n  widget — on somebody else\'s page')

const chrome = start(CHROME, [
  '--headless=new', '--remote-debugging-port=9222', '--disable-gpu',
  '--no-sandbox', '--window-size=1400,1000', 'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch('http://localhost:9222/json/version')).json()).webSocketDebuggerUrl }
  catch { await new Promise(r => setTimeout(r, 250)) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending = new Map()
const consoleErrors = []
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning'))
    consoleErrors.push(m.params.args?.map(a => a.value ?? a.description).join(' '))
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

async function until(fn, tries = 120) {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}

async function goto(url) {
  await send('Page.navigate', { url }, sessionId)
  await until(async () => await evaluate(`document.readyState === 'complete'`))
}

await goto(`http://localhost:${HOST}/`)

// The element upgrades on its own — a custom element definition, no init call.
const upgraded = await until(async () => await evaluate(
  `!!document.querySelector('fjs-buy-button')?.shadowRoot`))
check('the custom element upgraded and opened a shadow root', upgraded, true)

const shown = await until(async () => await evaluate(`(() => {
  const r = document.querySelector('fjs-buy-button').shadowRoot
  const name = r.querySelector('[data-name]')?.textContent?.trim()
  return name ? { name, price: r.querySelector('[data-price]')?.textContent?.trim() } : null
})()`))
check('and filled itself in from the shop, cross-origin',
      [shown?.name, /^\$\d/.test(shown?.price ?? '')], [embed.product, true])

// ── Isolation, both directions ────────────────────────────────────────────

const styles = await evaluate(`(() => {
  const r  = document.querySelector('fjs-buy-button').shadowRoot
  const b  = r.querySelector('[data-add]')
  const cs = getComputedStyle(b)
  const host = getComputedStyle(document.querySelector('h1'))
  return {
    // The host page's \`button { background: red !important }\`
    bg:   cs.backgroundColor,
    // ...its \`font-size: 40px !important\`
    size: cs.fontSize,
    // ...and the INHERITED 28px/Comic Sans on <body>, which a shadow root does
    // NOT stop. Only the widget declaring its own does.
    font: getComputedStyle(r.querySelector('.buy')).fontFamily,
    // The other direction: the widget's own rules must not have reached out.
    hostH1: host.color,
  }
})()`)
check('the host page\'s !important button rule does not reach in',
      styles.bg !== 'rgb(255, 0, 0)', true)
check('nor does its 40px font-size', styles.size !== '40px', true)
// This is the one that actually lands: a shadow root blocks RULES and not
// INHERITANCE, so a widget that assumes a reset renders in the host's font.
check('and the inherited font is the widget\'s own, not the host\'s',
      /system-ui/.test(styles.font), true)
check('while the host page\'s own styling is untouched',
      styles.hostH1, 'rgb(208, 0, 208)')

check('a SKU the shop never issued says so on the page',
      await evaluate(`document.querySelector('#nonesuch').shadowRoot.querySelector('[data-state="error"]')?.textContent.trim()`),
      'No product with SKU NO-SUCH-SKU')

check('the script really did come from another origin',
      await evaluate(`new URL(document.querySelector('script[src*="BuyButton"]').src).origin !== location.origin`),
      true)

// ─── Buying from the widget ────────────────────────────────────────────────

console.log('\n  widget — buying from a page the shop does not own')

const before = (await (await post('product-variants', 'embed', null, { sku: SKU })).json()).available

await evaluate(`(document.querySelector('fjs-buy-button').shadowRoot.querySelector('[data-add]').click(), true)`)

const checkoutLabel = await until(async () => await evaluate(
  `document.querySelector('fjs-buy-button').shadowRoot.querySelector('[data-checkout]')?.textContent.trim()`))
check('one click mints a basket and the widget says what is in it',
      checkoutLabel, 'Checkout — 1 item')

check('the basket lives in the HOST page\'s storage, not the shop\'s',
      await evaluate(`!!JSON.parse(localStorage.getItem('fjs-shop-widget-cart') ?? 'null')?.token`), true)

check('the shop set the stock aside, so what may be sold went down by one',
      (await (await post('product-variants', 'embed', null, { sku: SKU })).json()).available,
      before - 1)

check('and the widget re-read it rather than showing a stale number',
      await until(async () => await evaluate(`(() => {
        const r = document.querySelector('fjs-buy-button').shadowRoot
        return r.querySelector('[data-add]') && !r.querySelector('[data-add]').disabled
      })()`)),
      true)

// ─── The handoff ───────────────────────────────────────────────────────────

console.log('\n  widget — handing the basket to the shop')

const heldToken = await evaluate(`JSON.parse(localStorage.getItem('fjs-shop-widget-cart')).token`)
const heldId    = await evaluate(`JSON.parse(localStorage.getItem('fjs-shop-widget-cart')).id`)

const spare = await (await post('carts', 'handoff', heldId, {}, { 'x-cart-token': heldToken })).json()
check('a basket\'s holder can mint a handoff code', /^[0-9a-f]{32}$/.test(spare.code ?? ''), true)

const first  = await post('carts', 'redeem', null, { code: spare.code })
const second = await post('carts', 'redeem', null, { code: spare.code })
check('redeeming it answers the token', (await first.json()).token, heldToken)
// Cleared in the same transaction that read it. A code that survives its own
// redemption is a bearer token with a nicer name.
check('and the same code cannot be redeemed twice', second.status, 404)

const bogus = await post('carts', 'redeem', null, { code: 'f'.repeat(32) })
check('a code nobody issued is refused', bogus.status, 404)
const malformed = await post('carts', 'redeem', null, { code: 'not-a-code' })
check('and one that is not even the right shape never reaches the database',
      malformed.status, 400)

// ── The click, through the browser ────────────────────────────────────────

await evaluate(`(document.querySelector('fjs-buy-button').shadowRoot.querySelector('[data-checkout]').click(), true)`)

const landed = await until(async () => await evaluate(
  `location.origin === '${UI}' ? location.href : null`))
check('clicking Checkout lands on the shop\'s own site', !!landed, true)

// The fragment is stripped as soon as it is redeemed — belt and braces, since
// the code is already spent by then, but a URL in history that looks like a
// credential is a URL somebody will paste.
check('and the code is gone from the URL',
      await until(async () => await evaluate(`location.hash === '' ? 'clean' : null`)),
      'clean')

check('the shop\'s own site is now holding the basket',
      await until(async () => await evaluate(
        `document.querySelectorAll('#basket-lines .line').length || null`)),
      1)

check('and it holds the same token, so it is the same basket',
      await evaluate(`JSON.parse(localStorage.getItem('shop_cart') ?? 'null')?.token`),
      heldToken)

// ── A link that has already been spent ────────────────────────────────────
//
// The API refusal is asserted above; this is what the SHOPPER sees, and it is
// a different question. A code is worth one basket, for two minutes, once — so
// arriving with a used one is the ORDINARY way to land here, from a link
// somebody bookmarked or hit back onto, and the screen has to say which rather
// than showing an empty basket.
//
// Nothing asserted it until now, which is how `FJS-505` hid: `$: (handoffError)`
// beside a local `let` switched that variable's own reactivity off, so the
// alert never appeared however the redemption failed. The happy path had a
// drive and the failure path had none.
// Away from `/cart/` first, and it is not tidiness: the browser is already
// there, and navigating to the same path with only the FRAGMENT changed is not
// a navigation — the document is never reloaded, nothing boots, and the code is
// never read. The assertion would fail against a perfectly good screen.
await goto(`${UI}/products/`)
await goto(`${UI}/cart/#h=${spare.code}`)
check('landing with a spent checkout link says so',
      await until(async () => await evaluate(
        `document.querySelector('#handoff-error')?.textContent?.trim() || null`)),
      t => /already been used|never issued/.test(t ?? ''))

// Back on the host page, the widget must stop claiming a basket it handed over
// — otherwise it shows a count for something somebody else is now checking out.
await goto(`http://localhost:${HOST}/`)
check('the widget origin has let the basket go',
      await evaluate(`localStorage.getItem('fjs-shop-widget-cart')`), null)

const noisy = consoleErrors.filter(m => m && !/favicon/i.test(m))
check('no console errors on either page', noisy, [])

console.log(`\n  ${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail ? 1 : 0)
