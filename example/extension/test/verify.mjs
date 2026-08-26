/**
 * extension/test/verify.mjs — the shop, in the toolbar.
 *
 * Started by `bun run verify:extension`. Starts everything itself: the API,
 * the storefront origin, and Chrome with the extension loaded into a throwaway
 * profile. Needs `bun run build:site` to have happened — the island runs on the
 * PRERENDERED storefront, and a missing build is reported rather than guessed
 * at.
 *
 * ─── Why this drive exists ────────────────────────────────────────────────
 *
 * `extension/` was the last surface with no instance in a real app (`FJS-280`).
 * Everything about it was proved by unit tests and by hand: the manifest, the
 * permissions, and the harbor↔dock port protocol. And the thing under all of
 * them could not work at all — jetty's only Junction adapter was a placeholder
 * whose envelope is not Junction's (`FJS-279`), so no jetty app had ever spoken
 * to a real API.
 *
 * ─── The mechanism, which is not the one the docs describe ────────────────
 *
 * `--load-extension` no longer loads anything when a debugging port is open;
 * the page it names answers ERR_BLOCKED_BY_CLIENT, which reads as a broken
 * extension rather than as a flag Chrome stopped honouring. The way in is the
 * CDP command — `Extensions.loadUnpacked`, behind
 * `--enable-unsafe-extension-debugging` — and it answers the extension's id,
 * which is the other thing there was no way to get: an unpacked extension's id
 * is a hash of its absolute path, so it is different on every machine.
 *
 * A popup page is not web-accessible, so it cannot be reached by navigating a
 * tab. `Target.createTarget` at the extension URL is browser-initiated and is
 * how a person opening the popup reaches it.
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const EXT  = join(HERE, '..')
const ROOT = join(EXT, '..')
const DIST = join(EXT, 'dist/chrome')
const SITE = join(ROOT, 'site/dist')

const API    = process.env.API_URL ?? 'http://localhost:8110'
// 7 test · 7 siteServe · 1 example · 0 — the same slot `verify:site` uses. The
// two drives do not run at once, and the extension's manifest declares this
// origin: a host permission is in a file the build emits, so a drive cannot
// pick its port at run time the way every other one here does.
const SITE_PORT = 7710
const DEBUG_PORT = 9224
const CHROME = process.env.FJS_CHROME ?? 'google-chrome'

// ─── plumbing ──────────────────────────────────────────────────────────────

const procs   = []
const servers = []
function start(cmd, args, name, cwd = ROOT) {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  p.stdout.on('data', d => { if (process.env.DEBUG) process.stdout.write(`[${name}] ${d}`) })
  p.stderr.on('data', d => { if (process.env.DEBUG) process.stderr.write(`[${name}] ${d}`) })
  procs.push(p)
  return p
}
const stopAll = () => {
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGTERM') } catch { try { p.kill('SIGTERM') } catch {} }
  }
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

async function waitFor(url, label, tries = 160) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await sleep(250)
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

// ─── preflight ─────────────────────────────────────────────────────────────

if (!existsSync(join(SITE, 'index.html'))) {
  console.error(`No storefront build at ${SITE}.\nRun: bun run build:site`)
  process.exit(1)
}
for (const [port, what] of [[8110, 'the API'], [SITE_PORT, 'the storefront origin']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.`)
    process.exit(1)
  }
}

// The extension is BUILT here rather than required, because a stale
// dist/chrome is a drive that passes against the previous edit — the same trap
// as a dev server serving the code it started with. It is a second's work.
execFileSync('bunx', ['jetty-build-ext', '--root=extension', '--browser=chrome'],
             { cwd: ROOT, stdio: process.env.DEBUG ? 'inherit' : 'ignore' })

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })
start('bun', ['run', 'api/index.ts'], 'api')
if (!await waitFor(`${API}/api/health`, 'the API')) { stopAll(); process.exit(1) }

// Sierra's own static server — the one `bun run serve:site` runs and the one a
// container runs, so the origin the island crosses is the origin that ships.
const { serveSite } = await import('@frontierjs/sierra/site/serve')
const site = await serveSite({ dir: SITE, port: SITE_PORT })
servers.push(site.server ?? { close() {} })

// ─── the shop, over HTTP ───────────────────────────────────────────────────
//
// Two orders are made here rather than taken from the seed: the seed's one paid
// order is shipped by whichever drive ran last, and a count asserted against
// leftovers is a count that passes for the wrong reason.

const ADMIN = { email: 'alex@shop.test', password: 'correct-horse-battery' }

const login = await fetch(`${API}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(ADMIN),
})
const token = (await login.json())?.token
if (!token) { console.error('could not sign in over HTTP — is the login limiter tripped?'); stopAll(); process.exit(1) }
const asAdmin = (path, init = {}) => fetch(`${API}/api${path}`, {
  ...init,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
})

const stamp = Date.now().toString().slice(-6)
async function makePaidOrder(suffix) {
  const customers  = await (await asAdmin('/customers?$limit=1')).json()
  const customerId = (customers?.data ?? customers)[0]?.id
  const created    = await (await asAdmin('/orders', {
    method: 'POST',
    body: JSON.stringify({ reference: `EXT-${stamp}${suffix}`, customerId, total: 42 }),
  })).json()
  const id = created?.id ?? created?.data?.id
  if (!id) throw new Error(`could not make an order: ${JSON.stringify(created)}`)
  const paid = await (await asAdmin(`/orders/${id}`, {
    method: 'POST', headers: { 'x-service-method': 'pay' }, body: '{}',
  })).json()
  if (paid?.status !== 'paid') throw new Error(`could not pay order ${id}: ${JSON.stringify(paid)}`)
  return id
}

const before = await makePaidOrder('A')

console.log('\n  the extension — a surface loaded into a browser profile\n')

// ─── Chrome, with the extension in it ──────────────────────────────────────

const profile = mkdtempSync(join(tmpdir(), 'fjs-shop-desk-'))
start(CHROME, [
  '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--disable-gpu', '--no-sandbox',
  `--user-data-dir=${profile}`,
  // Without this the CDP command below is not registered, and `--load-extension`
  // is not an alternative: with a debugging port open it loads nothing.
  '--enable-unsafe-extension-debugging',
  'about:blank',
], 'chrome')

let wsUrl = null
for (let i = 0; i < 80 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://localhost:${DEBUG_PORT}/json/version`)).json()).webSocketDebuggerUrl }
  catch { await sleep(250) }
}
if (!wsUrl) { console.error('chrome never came up'); stopAll(); process.exit(1) }

const ws = new WebSocket(wsUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

let msgId = 0
const pending  = new Map()
const harborLog = []
const pageErrors = []
ws.onmessage = e => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args?.map(a => a.value ?? a.description).join(' ') ?? ''
    harborLog.push(text)
    if (m.params.type === 'error') pageErrors.push(text)
  }
  if (m.method === 'Runtime.exceptionThrown')
    pageErrors.push(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '')
}
const send = (method, params = {}, sessionId) =>
  new Promise(res => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, sessionId })) })

// The id is a hash of the absolute path, so it differs on every machine and
// there is nothing to hardcode. This is the only thing that answers it.
const loaded = await send('Extensions.loadUnpacked', { path: resolve(DIST) })
const extId  = loaded.result?.id
check('the built extension loads unpacked, manifest and all', typeof extId === 'string' && extId.length === 32, true)
if (!extId) { console.error(JSON.stringify(loaded.error)); stopAll(); process.exit(1) }

// ─── the harbor ────────────────────────────────────────────────────────────
//
// The service worker is lazy. Opening the popup is what a person does and what
// wakes it, so the dock is created first and the harbor asserted after.

const { result: dockTarget } = await send('Target.createTarget', { url: `chrome-extension://${extId}/dock.html` })
const { result: dockSession } = await send('Target.attachToTarget', { targetId: dockTarget.targetId, flatten: true })
const dock = dockSession.sessionId
await send('Page.enable', {}, dock)
await send('Runtime.enable', {}, dock)

async function evaluate(expr, sessionId = dock) {
  const { result } = await send('Runtime.evaluate', {
    expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true,
  }, sessionId)
  if (result?.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result?.result?.value
}
async function until(fn, tries = 100) {
  for (let i = 0; i < tries; i++) {
    let v = null
    try { v = await fn() } catch {}
    if (v) return v
    await sleep(200)
  }
  return null
}

const swTarget = await until(async () => {
  await send('Target.setDiscoverTargets', { discover: true })
  const { result } = await send('Target.getTargets')
  return result.targetInfos.find(t => t.type === 'service_worker' && t.url.includes(extId)) ?? null
})
check('opening the popup woke the harbor', !!swTarget, true)

const { result: swSession } = await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })
await send('Runtime.enable', {}, swSession.sessionId)

// The harbor holds the ONLY connection, and this is the line that says whether
// it reached a real Junction. Read off the worker itself rather than off the
// log, because a service worker that was already awake logged before anything
// here was listening.
const reachable = await until(async () => await evaluate(
  `(await chrome.storage.local.get('lastWake')).lastWake ? true : null`, swSession.sessionId))
check('and the harbor ran, writing through the extension storage a page has not got', reachable, true)

// ─── the dock ──────────────────────────────────────────────────────────────

const signedOut = await until(async () => await evaluate(
  `document.querySelector('[data-status]')?.textContent ?? null`))
check('the dock is Mesa, compiled and mounted in the popup', signedOut, 'signed out')

await evaluate(`(() => {
  const set = (sel, v) => {
    const el = document.querySelector(sel)
    el.value = v
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  set('[data-email]', ${JSON.stringify(ADMIN.email)})
  set('[data-password]', ${JSON.stringify(ADMIN.password)})
  document.querySelector('[data-signin]').click()
  return true
})()`)

// Sign-in is `adapter.auth`, over the real /auth/login route, with the token
// persisted by the HARBOR into extension storage — a service worker has no
// localStorage, which is why the client is built with `tokenStorage: null`.
const who = await until(async () => await evaluate(
  `document.querySelector('[data-who]')?.textContent ?? null`))
check('signing in from the popup reaches the app\'s own /auth/login', who, ADMIN.email)

const listed = await until(async () => {
  const n = await evaluate(`document.querySelector('[data-count]')?.textContent ?? null`)
  return n && Number(n) > 0 ? Number(n) : null
})
check('and the despatch queue is the shop\'s own orders, over the port protocol', listed > 0, true)

const hasOurs = await until(async () => await evaluate(
  `!!document.querySelector('[data-order="${before}"]')`))
check('including the one made before the popup opened', hasOurs, true)

// ─── live ──────────────────────────────────────────────────────────────────
//
// The second order is paid over HTTP while the popup is open and nobody
// refreshes. Junction announces `orders pay` on the `orders` channel, the
// harbor's one subscription fans it out to every port, and the dock's resource
// upserts it. Three hops, none of which anything else here can see.

const during = await makePaidOrder('B')
const arrived = await until(async () => await evaluate(
  `!!document.querySelector('[data-order="${during}"]')`))
check('an order paid elsewhere reaches the popup with nothing refreshing', arrived, true)

// ─── a transition, from the toolbar ────────────────────────────────────────

await evaluate(`(() => { document.querySelector('[data-ship="${before}"]').click(); return true })()`)
const shipped = await until(async () => {
  const row = await (await asAdmin(`/orders/${before}`)).json()
  return row?.status === 'shipped' ? row.status : null
})
check('the Ship button runs the declared transition, not a PATCH of status', shipped, 'shipped')

// …and it leaves the queue. The row comes BACK on the channel as `orders ship`
// and jetty's store upserts whatever arrives, so this is the dock filtering on
// render rather than the store removing it — see `FJS-493`, and the comment in
// App.mesa that will be deleted with it.
const dropped = await until(async () => await evaluate(
  `document.querySelector('[data-order="${before}"]') ? null : true`))
check('and the shipped order leaves the despatch queue', dropped, true)

// ─── the island ────────────────────────────────────────────────────────────
//
// A content script on the shop's own storefront, registered by the harbor
// through chrome.scripting on every wake — the manifest carries no
// content_scripts block, which is why `scripting` is a declared permission.
//
// The page is PRERENDERED and the stock number is deliberately not baked into
// it: this is staff looking at their own public site and seeing the shelf.

const slug = await (async () => {
  const r = await (await asAdmin('/products?active=true&$limit=1')).json()
  return (r?.data ?? r)[0]?.slug
})()

const { result: pageTarget } = await send('Target.createTarget', { url: 'about:blank' })
const { result: pageSession } = await send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true })
const page = pageSession.sessionId
await send('Page.enable', {}, page)
await send('Runtime.enable', {}, page)
await send('Page.navigate', { url: `http://localhost:${SITE_PORT}/products/${slug}/` }, page)

const badge = await until(async () => await evaluate(`(() => {
  for (const el of document.querySelectorAll('*')) {
    const t = el.shadowRoot?.querySelector('[data-stock]')
    if (t && t.textContent && t.textContent !== '…') return t.textContent
  }
  return null
})()`, page), 150)
check('the island mounted on the storefront, cross-origin, in a shadow root',
      /^\d+ on the shelf · \d+ variants$/.test(badge ?? ''), true)

// And it is not in the published page: a customer loading the same file sees
// nothing of this. The badge is the extension's, not the site's.
const plain = await (await fetch(`http://localhost:${SITE_PORT}/products/${slug}/`)).text()
check('and nothing about it is in the file the storefront serves',
      plain.includes('data-stock'), false)

// ─── the quiet assertion ───────────────────────────────────────────────────

const noisy = pageErrors.filter(t => t && !/favicon|ERR_FILE_NOT_FOUND/.test(t))
check('no console errors anywhere in it', noisy, [])

console.log(`\n  ${pass} passed, ${fail} failed\n`)
stopAll()
process.exit(fail > 0 ? 1 : 0)
