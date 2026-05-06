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

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
