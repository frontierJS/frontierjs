/*
 * verify-mcp-view.mjs — a built MCP App view, run inside a host, in Chrome.
 *
 * `verify:mcp` proves the plugin serves the views this tree built and only to
 * the callers whose tools point at them. This is the half no protocol client
 * reaches: the document running where a host runs it, speaking to the host and
 * through it to the app, with nothing of its own.
 *
 *   bun run verify:mcp-view
 *
 * ─── Three origins, and the third is the point ────────────────────────────
 *
 *   :7110  the API          `/api/mcp`, reached by the drive's MCP client only
 *   :7117  the host page    ext-apps' `AppBridge`, and `/call`, the host's
 *                           server half, which holds the MCP session
 *   :7118  the sandbox      serves the bytes `resources/read` answered, under
 *                           the CSP the listing's `_meta.ui.csp` asks for
 *
 * The spec requires the view's origin to be neither the host's nor the app's,
 * and the frame runs `sandbox="allow-scripts allow-same-origin"`. So a view
 * that reached for the network would reach for the SANDBOX's origin or be
 * refused by the CSP, and both are counted below: the sandbox server logs
 * every request, and Chrome reports every request the frame made.
 *
 * ─── The host is the oracle, so it is not written here ────────────────────
 *
 * `fixtures/mcp-host/host.js` is ext-apps' `AppBridge`, bundled at start with
 * `Bun.build`. The view's channel is hand-written (`sierra/src/mcp/host.js`)
 * and its method strings, protocol version and handshake order are graded by
 * the reference host accepting them — a fake host restating the spec would
 * agree with a view that misread it the same way.
 *
 * Runs under **bun**, for the bundle. Starts its own API, seeds, and builds
 * the views first, which is most of the run. The seed resets the shared
 * example database.
 */

// What `fli prove` queues on: this checkout's ports.
export const holds = ['ports']

import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { portFor } from '@frontierjs/cli/core/ports.js'
import { PORTS } from './lib/preflight.mjs'
import { watchReloads } from './lib/reload.mjs'
import { openChrome } from '../../../packages/mesa/src/drive.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../..')
const API_PORT = process.env.API_PORT ?? String(PORTS.apiTest)
const API  = process.env.FRONTIER_API_URL ?? `http://localhost:${API_PORT}`
const BASE = `${API}/api`
const MCP  = new URL(`${BASE}/mcp`)

// Stand-ins this drive binds itself, on the API's test row beside 7114–7116.
const HOST_PORT    = await portFor(import.meta.url, 'be', { env: 'test', service: 7 })
const SANDBOX_PORT = await portFor(import.meta.url, 'be', { env: 'test', service: 8 })
const HOST    = `http://localhost:${HOST_PORT}`
const SANDBOX = `http://localhost:${SANDBOX_PORT}`

const PASSWORD = 'correct-horse-battery'
const ADMIN    = 'alex@shop.test'
const URI      = 'ui://shop/Product'

// ─── Servers ───────────────────────────────────────────────────────────────

const procs = []
const servers = []
function start(cmd, args, name) {
  const p = spawn(cmd, args, {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, API_PORT, SHOP_MCP_UI: '1' },
  })
  p.stdout.on('data', () => {})
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

async function waitFor(url, label, tries = 120) {
  for (let i = 0; i < tries; i++) {
    try { if ((await fetch(url)).ok) return true } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  console.error(`${label} never answered on ${url}`)
  return false
}

for (const [port, what] of [[API_PORT, 'the API'], [HOST_PORT, 'the host page'], [SANDBOX_PORT, 'the sandbox']]) {
  let busy = false
  try { await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(500) }); busy = true } catch {}
  if (busy) {
    console.error(`port ${port} already answers — ${what} is still running from an earlier run.\n` +
                  `stop it first (\`bun run stop\`); this drive starts its own.`)
    process.exit(1)
  }
}

const bundle = await Bun.build({
  entrypoints: [join(HERE, 'fixtures/mcp-host/host.js')], target: 'browser', format: 'esm',
})
if (!bundle.success) {
  console.error('the host page did not bundle:\n' + bundle.logs.map(String).join('\n'))
  process.exit(1)
}
const hostScript = await bundle.outputs[0].text()

execFileSync('bun', ['run', 'db/seed.ts'], { cwd: ROOT, stdio: 'ignore' })
// Built here, so the view in the frame is one this tree built.
execFileSync('fli', ['mcp:build'], { cwd: ROOT, stdio: process.env.DEBUG ? 'inherit' : 'ignore' })
start('bun', ['run', 'api/index.ts'], 'api')
if (!await waitFor(`${BASE}/products`, 'api')) { stopAll(); process.exit(1) }

// ─── Assertions ────────────────────────────────────────────────────────────

let pass = 0, fail = 0
function check(name, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else    { fail++; console.log(`  ✗ ${name}\n      got      ${JSON.stringify(actual)}\n      expected ${typeof expected === 'function' ? '(predicate)' : JSON.stringify(expected)}`) }
}

// ─── The host's server half ────────────────────────────────────────────────

const token = (await (await fetch(`${BASE}/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ADMIN, password: PASSWORD }),
})).json()).token
const mcp = new Client({ name: 'verify-mcp-view', version: '1.0.0' })
await mcp.connect(new StreamableHTTPClientTransport(MCP, {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
}))

const tools  = (await mcp.listTools()).tools
const listed = (await mcp.listResources()).resources.find(r => r.uri === URI)
const html   = (await mcp.readResource({ uri: URI })).contents?.[0]?.text ?? ''

const call = async (name, args) => {
  const res = await mcp.callTool({ name, arguments: args })
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`)
  return res.structuredContent ?? JSON.parse(res.content[0].text)
}
const found   = await call('products_find', { query: { active: true }, directives: { limit: 1 } })
const product = (found.data ?? found)[0]
const args    = { id: product.id }
// The agent's call this view belongs to, answered as the host would hand it on.
const result  = await mcp.callTool({ name: 'products_get', arguments: args })

console.log('\nthe agent\'s call names this view')
check('products_get points at the Product view',
      tools.find(t => t.name === 'products_get')?._meta?.ui?.resourceUri, URI)
check('which is listed, and read as a document', [!!listed, /<html/i.test(html)], [true, true])

// The CSP a host builds from the listing's `_meta.ui.csp`. No connect domain
// is the plugin's answer, so the frame may open no connection at all.
const cspFor = (csp = {}) => {
  const list = (domains, fallback) => domains?.length ? domains.join(' ') : fallback
  return [
    `default-src 'none'`,
    `script-src 'self' 'unsafe-inline' ${list(csp.resourceDomains, '')}`.trim(),
    `style-src 'self' 'unsafe-inline' ${list(csp.resourceDomains, '')}`.trim(),
    `img-src 'self' data: ${list(csp.resourceDomains, '')}`.trim(),
    `font-src 'self' data: ${list(csp.resourceDomains, '')}`.trim(),
    `connect-src ${list(csp.connectDomains, `'none'`)}`,
    `frame-src ${list(csp.frameDomains, `'none'`)}`,
    `base-uri ${list(csp.baseUriDomains, `'self'`)}`,
  ].join('; ')
}
const csp = cspFor(listed?._meta?.ui?.csp)
check('the listing asks for no connection, so the frame gets connect-src \'none\'',
      /connect-src 'none'/.test(csp), true)

// ─── The two origins ───────────────────────────────────────────────────────

const sandboxAsked = []
const sandbox = createServer((req, res) => {
  sandboxAsked.push(`${req.method} ${req.url}`)
  if (req.method === 'GET' && req.url === '/view') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp })
    return res.end(html)
  }
  res.writeHead(404); res.end()
})
await new Promise(r => sandbox.listen(SANDBOX_PORT, r))
servers.push(sandbox)

const hostCalls = []
const body = (req) => new Promise((resolve) => { let s = ''; req.on('data', d => s += d); req.on('end', () => resolve(s)) })
const hostPage = createServer(async (req, res) => {
  const send = (type, text) => { res.writeHead(200, { 'content-type': type }); res.end(text) }
  if (req.url === '/') return send('text/html; charset=utf-8',
    `<!doctype html><meta charset="utf-8"><title>host</title><body><script type="module" src="/host.js"></script>`)
  if (req.url === '/host.js') return send('text/javascript', hostScript)
  if (req.url === '/favicon.ico') { res.writeHead(204); return res.end() }
  if (req.url === '/session') return send('application/json',
    JSON.stringify({ view: `${SANDBOX}/view`, result, args, hostContext: { theme: 'dark' } }))
  if (req.url === '/call' && req.method === 'POST') {
    const params = JSON.parse(await body(req))
    hostCalls.push(params)
    try { return send('application/json', JSON.stringify(await mcp.callTool(params))) }
    catch (err) { return send('application/json', JSON.stringify({ isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] })) }
  }
  res.writeHead(404); res.end()
})
await new Promise(r => hostPage.listen(HOST_PORT, r))
servers.push(hostPage)

// ─── The browser ───────────────────────────────────────────────────────────

const browser = await openChrome({ windowSize: '1000,900' }).catch((e) => {
  console.error(e.message); stopAll(); process.exit(1)
})
watchReloads(browser)
const { cmd } = browser

// Every request, by frame. The frame is same-SITE with the host page
// (localhost on two ports), so it shares the page's renderer and its network
// events arrive on this session; the document request is the control that
// says they did.
const requests = new Map()
const failed   = []
browser.on('Network.requestWillBeSent', (p) => requests.set(p.requestId, { frameId: p.frameId, url: p.request.url }))
browser.on('Network.loadingFailed', (p) => failed.push({ ...requests.get(p.requestId), error: p.errorText, blocked: p.blockedReason }))
await cmd('Network.enable')

// What the BROWSER says rather than a script: a CSP refusal and a blocked form
// submission are logged here and never reach the console API the driver reads.
const logged = []
browser.on('Log.entryAdded', ({ entry }) => {
  if (entry.level === 'error' || entry.level === 'warning') logged.push(`${entry.source}: ${entry.text}`)
})
await cmd('Log.enable')

await browser.navigate(HOST, 'window.__host?.initialized')

const until = async (fn, tries = 150) => {
  for (let i = 0; i < tries; i++) {
    const v = await fn()
    if (v) return v
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}
const host = (expr) => browser.evaluate(`return (${expr})`)

const tree  = await cmd('Page.getFrameTree')
const child = tree.frameTree.childFrames?.[0]?.frame
const { executionContextId } = await cmd('Page.createIsolatedWorld', { frameId: child.id, worldName: 'drive' })
// The frame's DOM, from a world of the drive's own: the view's globals are not
// reachable from here, and nothing below needs them.
const inView = async (expr) => {
  const r = await cmd('Runtime.evaluate', {
    expression: `(async () => { return (${expr}) })()`,
    contextId: executionContextId, awaitPromise: true, returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// A trusted click, through the input pipeline, at the element's place on the
// HOST page: the frame's coordinates plus the element's within it. A script's
// click() is not what a person does, and the sandbox treats a submit the same
// either way, so the one a person does is the one asserted.
const clickInView = async (selector) => {
  const at = await inView(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  const frame = await host(`(() => {
    const f = document.querySelector('iframe')
    f.scrollIntoView({ block: 'start' })
    const r = f.getBoundingClientRect()
    return { x: r.left, y: r.top }
  })()`)
  const x = frame.x + at.x, y = frame.y + at.y
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 })
  }
}

console.log('\nthe reference host accepts the handshake')
{
  const field = await until(() => inView(`document.querySelector('[name="name"]')?.value ?? null`))
  check('the view mounted the tool\'s row in its form', field, product.name)
  check('and its description, as the row has it',
        await inView(`document.querySelector('[name="description"]')?.value ?? null`), product.description ?? '')

  const sent = await host(`window.__host.sent`)
  check('the view opened with ui/initialize, which the bridge answered', [sent[0], await host(`window.__host.initialized`)], ['ui/initialize', true])
  check('and sent nothing a view may not send',
        sent.filter(m => !['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed', 'tools/call', 'response'].includes(m)), [])
  check('the row was read with no tools/call — the agent\'s answer, not a second ask',
        await host(`window.__host.calls.length`), 0)

  const sizes = await host(`window.__host.sizes`)
  check('the view reported its size, and the host sized the frame to it',
        [sizes.length > 0, sizes.at(-1)?.height > 0,
         await host(`document.querySelector('iframe').getBoundingClientRect().height`) === sizes.at(-1)?.height],
        [true, true, true])
  check('nothing on the page says the view stopped', await inView(`document.querySelector('[role="alert"]')?.textContent ?? ''`), '')
}

console.log('\nthe host\'s context is the theme')
{
  check('hostContext.theme dark is the app\'s dark theme on <html>',
        await inView(`document.documentElement.classList.contains('theme-dark')`), true)
  await host(`(window.__bridge.sendHostContextChange({ theme: 'light' }), true)`)
  check('and a host-context-changed to light moves it to the light one',
        await until(() => inView(`document.documentElement.classList.contains('theme-default') && !document.documentElement.classList.contains('theme-dark')`)),
        true)
}

console.log('\na save round-trips through the host')
const typed = `Written in a host frame ${Date.now()}`
{
  // Typed through the input pipeline: the frame is focused by the element's
  // own focus(), and the keys go to whichever frame holds focus.
  await inView(`(() => { const el = document.querySelector('[name="description"]'); el.focus(); el.select(); return true })()`)
  await browser.type(typed)
  check('the keys landed in the view\'s field', await inView(`document.querySelector('[name="description"]').value`), typed)

  await clickInView('button[type="submit"]')
  const calls = await until(async () => { const c = await host(`window.__host.calls`); return c.length ? c : null })
  const patch = calls?.[0]
  check('the save left as one tools/call, to products_patch', calls?.map(c => c.name), ['products_patch'])
  check('naming the row', patch?.arguments?.id, product.id)
  // The diff against the row the view read: a column the form did not change
  // rides along only as an overwrite of whoever wrote it since.
  check('and carrying what changed, not the whole record',
        Object.keys(patch?.arguments?.data ?? {}).filter(k => k !== 'version').sort(), ['description'])
  check('the host\'s server half made that call', hostCalls.map(c => c.name), ['products_patch'])

  const after = await call('products_get', args)
  check('the app holds the new description', after.description, typed)
  check('and the other columns as they were', [after.name, after.slug], [product.name, product.slug])
  check('the view says nothing went wrong', await inView(`document.querySelector('[role="alert"]')?.textContent ?? ''`), '')

  // Enter in a text field is the form's default button clicked, which the
  // sandbox drops the same way. Heard and stopped before <Form> sees it, so
  // the probe writes nothing.
  await inView(`(() => {
    window.__heard = 0
    document.addEventListener('submit', (e) => { window.__heard++; e.preventDefault(); e.stopImmediatePropagation() }, { capture: true, once: true })
    document.querySelector('[name="name"]').focus()
    return true
  })()`)
  await browser.press('Enter')
  check('Enter in a field submits the form too', await until(() => inView(`window.__heard`)), 1)

  // Put back, so a peer reading the shared database sees the seed's copy.
  await call('products_patch', { id: product.id, data: { description: product.description, version: after.version } })
}

console.log('\nthe view has no network of its own')
{
  // A `data:` URL is a stylesheet's own bytes, not a request to anybody.
  const ofFrame = [...requests.values()].filter(r => r.frameId === child.id && !r.url.startsWith('data:'))
  check('Chrome saw the frame\'s document request at all — the control', ofFrame.map(r => r.url), [`${SANDBOX}/view`])
  check('so every request the frame made is its document, and none reached the app',
        ofFrame.filter(r => r.url.startsWith(API)).length, 0)
  check('nor did any page in the browser speak to the app', [...requests.values()].filter(r => r.url.startsWith(API)).length, 0)
  check('the sandbox origin was asked for the document and nothing else', sandboxAsked, ['GET /view'])
  check('and no request of the frame failed, CSP-blocked or otherwise',
        failed.filter(f => f.frameId === child.id), [])
}

console.log('\nthe host refuses what it does not implement')
{
  // Asked from the frame, as the view would: a host built with no MCP client
  // answers nothing but what was registered. The view's own channel ignores
  // an answer to an id it never sent.
  const answer = await inView(`new Promise((resolve) => {
    addEventListener('message', (e) => { if (e.data?.id === 'drive-probe') resolve(e.data) })
    parent.postMessage({ jsonrpc: '2.0', id: 'drive-probe', method: 'resources/read', params: { uri: '${URI}' } }, '*')
    setTimeout(() => resolve({ timeout: true }), 3000)
  })`)
  check('resources/read from the frame is refused -32601', answer?.error?.code, -32601)
}

check('no page error and no console error, host or view', browser.errors, [])
check('and nothing the browser itself refused', logged, [])

// ─── Result ────────────────────────────────────────────────────────────────

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass}/${pass + fail} checks passed\n`)
await browser.close()
try { await mcp.close() } catch {}
stopAll()
process.exit(fail === 0 ? 0 : 1)
