// Phase 5 unit tests — Dev tooling.
//
// Coverage:
//   - FJS port validation (assertExtDevPort, range checks, decode)
//   - Classifier: every row of the precision matrix
//   - DevServer: start, broadcast, multiple clients, identify, stop
//   - End-to-end: server + WebSocket client, broadcast → client receives
//
// What's NOT covered here:
//   - The orchestrator's chokidar wiring (file-system races; manual smoke)
//   - dev-plugin.js Vite chunk transforms (covered by build-output check)
//   - web-ext browser launch (Phase 5 ships WS infra; web-ext launch optional)

import { WebSocket } from 'ws'

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- FJS port scheme ---

group('FJS port scheme')
{
  const { assertExtDevPort, isValidExtDevPort, decodePort, FJS_DEV_EXT_RANGE } = await import('../src/dev/fjs-ports.js')

  if (FJS_DEV_EXT_RANGE[0] === 8400 && FJS_DEV_EXT_RANGE[1] === 8499) ok('dev/ext range = 8400–8499')

  // Valid
  if (isValidExtDevPort(8400)) ok('8400 is valid')
  if (isValidExtDevPort(8410)) ok('8410 is valid')
  if (isValidExtDevPort(8499)) ok('8499 is valid')

  // Invalid
  if (!isValidExtDevPort(8399)) ok('8399 below range rejected')
  if (!isValidExtDevPort(8500)) ok('8500 above range rejected')
  if (!isValidExtDevPort(7400)) ok('7400 (test category) rejected')
  if (!isValidExtDevPort(9400)) ok('9400 (prod) rejected')
  if (!isValidExtDevPort('8400')) ok('string rejected')
  if (!isValidExtDevPort(undefined)) ok('undefined rejected')

  // assert throws clearly
  try { assertExtDevPort(undefined); bad('undefined accepted by assert') }
  catch (e) {
    if (/required/.test(e.message)) ok('assertExtDevPort: undefined → required error')
  }
  try { assertExtDevPort(8500); bad('out-of-range accepted') }
  catch (e) {
    if (/8400.*8499/.test(e.message)) ok('assertExtDevPort: out-of-range → range error')
  }
  try { assertExtDevPort(8410); ok('assertExtDevPort: valid passes through') }
  catch (e) { bad('assertExtDevPort threw on valid', e.message) }

  // Decode
  const decoded = decodePort(8410)
  if (decoded?.envName === 'dev' && decoded.catName === 'ext' && decoded.project === 1 && decoded.service === 0) {
    ok('decodePort: 8410 = dev/ext/project-1/service-0')
  } else {
    bad('decodePort 8410 wrong', JSON.stringify(decoded))
  }
}

// --- classifier ---

group('classifier — precision matrix')
{
  const { classifyChange } = await import('../src/dev/classifier.js')

  function classify(relPath, found = { islands: [{ id: 'demo' }] }) {
    return classifyChange({ relPath, found })
  }

  // Config
  if (classify('config/jetty.config.js').kind === 'extension:reload') ok('jetty.config.js → extension:reload')

  // Harbor
  if (classify('src/harbor/index.js').kind === 'extension:reload') ok('src/harbor/* → extension:reload')
  if (classify('src/harbor/utils/foo.js').kind === 'extension:reload') ok('src/harbor/utils/* → extension:reload')

  // Island known
  {
    const e = classify('src/islands/demo.js')
    if (e.kind === 'island:reload-tabs' && e.islandId === 'demo') ok('known island → island:reload-tabs')
    else bad('known island wrong', JSON.stringify(e))
  }

  // Island unknown (new file not yet in found.islands)
  {
    const e = classify('src/islands/new.js', { islands: [] })
    if (e.kind === 'extension:reload' && e.reason === 'island:added') ok('new island file → extension:reload (full register)')
    else bad('new island wrong', JSON.stringify(e))
  }

  // Pages — .mesa files trigger HMR; other files trigger full reload.
  {
    const e = classify('src/dock/App.mesa')
    if (e.kind === 'mesa:hot-update' && e.target === 'dock' && e.moduleId === 'src/dock/App.mesa') ok('dock .mesa → mesa:hot-update (target=dock)')
    else bad('dock .mesa classify wrong', JSON.stringify(e))
  }
  {
    const e = classify('src/dock/styles.css')
    if (e.kind === 'page:reload' && e.target === 'dock') ok('dock non-mesa → page:reload (target=dock)')
    else bad('dock non-mesa classify wrong', JSON.stringify(e))
  }
  {
    const e = classify('src/options/index.html')
    if (e.kind === 'page:reload' && e.target === 'options') ok('options change → page:reload (target=options)')
    else bad('options classify wrong', JSON.stringify(e))
  }

  // Pier
  {
    const e = classify('src/piers/welcome/App.mesa')
    if (e.kind === 'mesa:hot-update' && e.target === 'pier:welcome' && e.moduleId === 'src/piers/welcome/App.mesa') ok('pier .mesa → mesa:hot-update (target=pier:welcome)')
    else bad('pier .mesa classify wrong', JSON.stringify(e))
  }
  {
    const e = classify('src/piers/welcome/styles.css')
    if (e.kind === 'page:reload' && e.target === 'pier:welcome') ok('pier non-mesa → page:reload (target=pier:welcome)')
    else bad('pier non-mesa classify wrong', JSON.stringify(e))
  }

  // Public
  if (classify('public/icons/icon.png').kind === 'extension:reload') ok('public/* → extension:reload')

  // Other src files → rebuild
  if (classify('src/shared/util.js').kind === 'rebuild') ok('shared/* → rebuild')

  // Outside watched scope → noop
  if (classify('README.md').kind === 'noop') ok('README.md (outside scope) → noop')
  if (classify('docs/foo.md').kind === 'noop') ok('docs/* → noop')
}

// --- DevServer lifecycle ---

group('DevServer — lifecycle + broadcast')
{
  const { DevServer } = await import('../src/dev/server.js')

  // Use a port jetty's tests own (7400 — test/ext/project-0/service-0)
  const TEST_PORT = 7400

  const silentLogger = {
    log:   () => {},
    error: () => {},
  }

  // Start + stop cycle
  {
    const server = new DevServer({ port: TEST_PORT, logger: silentLogger })
    await server.start()
    ok('server starts on test port')
    await server.stop()
    ok('server stops cleanly')
  }

  // Reject second start on same port
  {
    const a = new DevServer({ port: TEST_PORT, logger: silentLogger })
    await a.start()
    const b = new DevServer({ port: TEST_PORT, logger: silentLogger })
    try {
      await b.start()
      bad('two servers same port allowed')
    } catch (e) {
      if (/in use/i.test(e.message)) ok('second server on same port → EADDRINUSE')
    }
    await a.stop()
  }

  // Broadcast — start server, connect a client, send event, verify receipt
  {
    const server = new DevServer({ port: TEST_PORT, logger: silentLogger })
    await server.start()

    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)

    const messages = []
    ws.on('message', (data) => {
      try { messages.push(JSON.parse(data.toString())) } catch {}
    })

    await new Promise((r) => ws.once('open', r))
    // Hello arrives on connect
    await new Promise((r) => setTimeout(r, 50))
    if (messages[0]?.kind === 'hello' && messages[0].port === TEST_PORT) ok('hello sent on connect')

    // Identify
    ws.send(JSON.stringify({ kind: 'identify', clientType: 'harbor' }))
    await new Promise((r) => setTimeout(r, 50))
    // Server doesn't reply, but no error
    ok('identify accepted (no error)')

    // Broadcast
    server.broadcast({ kind: 'page:reload', target: 'dock', file: 'src/dock/App.mesa' })
    await new Promise((r) => setTimeout(r, 50))

    const reload = messages.find((m) => m.kind === 'page:reload')
    if (reload?.target === 'dock') ok('broadcast event received by client')
    else bad('broadcast not received', JSON.stringify(messages))

    // noop is dropped (not broadcast)
    const beforeCount = messages.length
    server.broadcast({ kind: 'noop' })
    await new Promise((r) => setTimeout(r, 30))
    if (messages.length === beforeCount) ok('noop events suppressed')

    ws.close()
    await new Promise((r) => setTimeout(r, 50))
    await server.stop()
  }

  // Multi-client broadcast
  {
    const server = new DevServer({ port: TEST_PORT, logger: silentLogger })
    await server.start()

    const c1 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
    const c2 = new WebSocket(`ws://127.0.0.1:${TEST_PORT}`)
    const c1msgs = [], c2msgs = []
    c1.on('message', (d) => { try { c1msgs.push(JSON.parse(d.toString())) } catch {} })
    c2.on('message', (d) => { try { c2msgs.push(JSON.parse(d.toString())) } catch {} })

    await Promise.all([
      new Promise((r) => c1.once('open', r)),
      new Promise((r) => c2.once('open', r)),
    ])
    await new Promise((r) => setTimeout(r, 30))

    server.broadcast({ kind: 'extension:reload', reason: 'harbor:changed' })
    await new Promise((r) => setTimeout(r, 50))

    const c1got = c1msgs.find((m) => m.kind === 'extension:reload')
    const c2got = c2msgs.find((m) => m.kind === 'extension:reload')
    if (c1got && c2got) ok('broadcast reaches multiple clients')
    else bad('broadcast missed clients', `c1=${!!c1got} c2=${!!c2got}`)

    c1.close(); c2.close()
    await new Promise((r) => setTimeout(r, 50))
    await server.stop()
  }
}

// --- Mesa HMR registry ---
//
// `globalThis.__jettyMesa.hot_update` is what jetty's whole dev loop rests on,
// and until now nothing ran it: `phase8` audits the classic-script shape of the
// bundle it lives in, not its behaviour. The DOM swap inside it is Mesa's
// (`@frontierjs/mesa/vite/swap`, `FJS-259`); what is asserted here is jetty's
// half — the two module shapes it accepts, the mark it seeds, and the fact that
// an updated instance re-registers so the SECOND edit lands too. That last one
// is not hypothetical: putting `__setMark` on the wrong module is exactly how
// Mesa's own HMR worked once per page load and then reported no instances.

group('Mesa HMR registry')
{
  const { JSDOM } = await import('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>')

  const saved = { window: globalThis.window, document: globalThis.document, Node: globalThis.Node }
  globalThis.window   = dom.window
  globalThis.document = dom.window.document
  globalThis.Node     = dom.window.Node

  // Importing the module installs the registry — the same top-level side effect
  // the injected dev client has in a page.
  await import('../src/dev/dev-client.js')
  const jm = globalThis.__jettyMesa

  // The warnings below are the module reporting correctly; a passing run should
  // not look like a failing one.
  const quiet = { warn: console.warn, debug: console.debug, error: console.error }
  console.warn  = () => {}
  console.debug = () => {}
  console.error = () => {}

  const doc  = dom.window.document
  const host = doc.getElementById('host')

  /** What a mounted Mesa component leaves behind: mark, its render, anchor. */
  function mountInstance(id, text) {
    const mark   = doc.createComment(`mesa:hmr:${id}`)
    const anchor = doc.createComment('')
    host.append(mark, anchor)
    host.insertBefore(doc.createTextNode(text), anchor)
    jm.register(id, mark, anchor, { seq: 1 }, null, () => {})
    return { mark, anchor }
  }

  /** What the new module hands back. `marks` records what __setMark was given. */
  function newVersion(id, text, marks, { throwsOnce = false } = {}) {
    let mark = null
    let thrown = false
    const fn = (anchor, props, block) => {
      if (throwsOnce && !thrown) { thrown = true; throw new Error('boom') }
      anchor.parentNode.insertBefore(anchor.ownerDocument.createTextNode(text), anchor)
      // A compiled component's wrapper registers on every render. Without this
      // the entry is gone after one update and the next edit finds nothing.
      jm.register(id, mark, anchor, props, block, fn)
    }
    fn.__setMark = (m) => { mark = m; marks.push(m) }
    return fn
  }

  /** Everything between the two markers, which is what a swap replaces. */
  function between(mark, anchor) {
    let out = ''
    for (let n = mark.nextSibling; n && n !== anchor; n = n.nextSibling) out += n.textContent
    return out
  }

  {
    const id = 'src/A.mesa'
    const { mark, anchor } = mountInstance(id, 'old')
    const marks = []
    const count = jm.hot_update(id, newVersion(id, 'new', marks))

    if (count === 1) ok('hot_update returns the number of instances it re-rendered')
    else bad('hot_update count wrong', String(count))

    if (between(mark, anchor) === 'new') ok('the old render is replaced between the two markers')
    else bad('DOM not swapped', JSON.stringify(between(mark, anchor)))

    if (marks[0] === mark) ok('__setMark is seeded with the EXISTING mark, not a new one')
    else bad('__setMark got the wrong mark')

    // The failure this catches is silent and looks like a broken watcher: the
    // first edit lands, every one after it reports "no live instances".
    const marks2 = []
    const second = jm.hot_update(id, newVersion(id, 'newer', marks2))
    if (second === 1 && between(mark, anchor) === 'newer') ok('a second update lands too — the re-render re-registered')
    else bad('second update lost the instance', `count=${second} dom=${between(mark, anchor)}`)
  }

  {
    const id = 'src/B.mesa'
    const { anchor } = mountInstance(id, 'old')
    anchor.remove()
    const count = jm.hot_update(id, newVersion(id, 'new', []))
    if (count === 0) ok('a detached instance is dropped rather than re-rendered')
    else bad('detached instance re-rendered', String(count))
    if (!jm.has(id)) ok('and it is pruned from the registry')
    else bad('detached instance left in the registry')
  }

  {
    // Module shape: the dev client re-imports the rebuilt entry, so what
    // arrives is a module namespace, not a function.
    const id = 'src/C.mesa'
    const { mark, anchor } = mountInstance(id, 'old')
    const marks = []
    const fn = newVersion(id, 'new', marks)
    const count = jm.hot_update(id, { default: () => {}, __mesaOrigFn: fn, __setMark: fn.__setMark })
    if (count === 1 && between(mark, anchor) === 'new') ok('a module namespace is accepted, and __mesaOrigFn wins over default')
    else bad('module shape not handled', `count=${count} dom=${between(mark, anchor)}`)
  }

  {
    // One instance throwing must not cost the others their update — a page
    // holding a mix of old and new renders says nothing about which is which.
    const id = 'src/D.mesa'
    const a = mountInstance(id, 'old-a')
    const b = mountInstance(id, 'old-b')
    const count = jm.hot_update(id, newVersion(id, 'new', [], { throwsOnce: true }))
    if (count === 1) ok('one instance throwing does not stop the rest')
    else bad('throw stopped the swap', String(count))
    const swapped = [between(a.mark, a.anchor), between(b.mark, b.anchor)]
    if (swapped.filter((t) => t === 'new').length === 1) ok('and the survivors are the ones that rendered')
    else bad('wrong instances updated', JSON.stringify(swapped))
  }

  {
    const count = jm.hot_update('src/never-mounted.mesa', () => {})
    if (count === 0) ok('an id with no instances answers 0 rather than throwing')
    else bad('unknown id did not answer 0', String(count))
  }

  {
    const id = 'src/E.mesa'
    mountInstance(id, 'old')
    const count = jm.hot_update(id, { default: null })
    if (count === 0) ok('a module carrying no component function is refused, not called')
    else bad('invalid newFn accepted', String(count))
  }

  console.warn  = quiet.warn
  console.debug = quiet.debug
  console.error = quiet.error
  globalThis.window   = saved.window
  globalThis.document = saved.document
  globalThis.Node     = saved.Node
}

// --- the dev client's Mesa import, resolved ---
//
// `dev-client.js` imports Mesa's DOM swap by name. Nothing in a prod build
// exercises that (the dev client is not injected), and a specifier that fails
// to resolve takes the whole dev build down — so both answers are asserted
// here: Mesa's real module when it is installed, jetty's fallback when it is
// not. Stub mode is a supported path, and an extension without Mesa must not
// fail to build over a feature it cannot use.

group('dev client → Mesa swap resolution')
{
  const { mesaPlugin } = await import('../src/build/mesa-plugin.js')
  const { resolve } = await import('node:path')

  const found = mesaPlugin({ extRoot: resolve(import.meta.dirname, '..') })
  found.configResolved({ command: 'build', root: resolve(import.meta.dirname, '..') })
  await found.buildStart()
  const swap = found.resolveId('@frontierjs/mesa/vite/swap')
  if (swap && /mesa-vite[\\/]swap\.js$/.test(swap)) ok("'@frontierjs/mesa/vite/swap' resolves to Mesa's own module")
  else bad('swap did not resolve to mesa', String(swap))

  // Stub mode: no compiler anywhere above either root.
  const quietWarn = console.warn
  console.warn = () => {}
  const missing = mesaPlugin({ extRoot: '/nonexistent-ext-root' })
  missing.configResolved({ command: 'build', root: '/nonexistent-vite-root' })
  await missing.buildStart()
  console.warn = quietWarn
  const fallback = missing.resolveId('@frontierjs/mesa/vite/swap')
  if (fallback && /mesa-swap-fallback\.js$/.test(fallback)) ok('and to jetty\'s no-op fallback when Mesa is not installed')
  else bad('stub mode did not fall back', String(fallback))

  const { swapInstances } = await import('../src/dev/mesa-swap-fallback.js')
  if (swapInstances(new Set(), () => {}) === 0) ok('the fallback answers 0 — nothing can register without a compiled component')
  else bad('fallback did not answer 0')
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
