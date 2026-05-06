// Phase 1 unit tests.
//
// Tests Phase 1 surfaces in isolation w/o real Chrome:
//   - HarborRegistry: add/remove/sendTo/broadcast routing
//   - handleConnect: version mismatch flow w/ mock port
//   - PagePort: send/on/off/session, lazy reconnect, protocol-upgrade reload
//   - Browser shim: typed surfaces, audit-miss warning, permission errors
//   - browser.idb: open + put + get roundtrip (uses fake-indexeddb)

import 'fake-indexeddb/auto'

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- mock chrome.runtime ---

function mockPort(name) {
  const messages = []
  const msgListeners        = []
  const disconnectListeners = []
  let connected = true

  const port = {
    name,
    postMessage(msg) {
      if (!connected) throw new Error('port closed')
      messages.push(msg)
    },
    disconnect() {
      if (!connected) return
      connected = false
      for (const fn of disconnectListeners) fn()
    },
    onMessage:    { addListener(fn) { msgListeners.push(fn) } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn) } },

    // Test-only helpers
    _emitMessage(msg) { for (const fn of msgListeners) fn(msg) },
    _emitDisconnect() { connected = false; for (const fn of disconnectListeners) fn() },
    _isConnected: () => connected,
    _messages:    () => messages,
  }
  return port
}

function mockRuntime() {
  const onConnectListeners = []
  return {
    id: 'mock-extension-id',
    onConnect: { addListener(fn) { onConnectListeners.push(fn) } },
    connect({ name }) { return mockPort(name) },
    getManifest() {
      return { permissions: ['storage', 'tabs'] }
    },

    // Test helper — emit an incoming connection
    _emitConnect(port) { for (const fn of onConnectListeners) fn(port) },
  }
}

// --- HarborRegistry ---

group('harbor-registry')
{
  const { makeHarborRegistry, registryKey, makePagesApi } = await import('../src/runtime/harbor-registry.js')
  const r = makeHarborRegistry()

  if (registryKey({ type: 'dock',    id: 'dock' })       === 'dock')          ok('registryKey: dock')
  if (registryKey({ type: 'options', id: 'options' })    === 'options')       ok('registryKey: options')
  if (registryKey({ type: 'pier',    id: 'welcome' })    === 'pier:welcome')  ok('registryKey: pier composite')
  if (registryKey({ type: 'island',  id: 'sa' })         === 'island:sa')     ok('registryKey: island composite')

  const pDock = mockPort('dock:dock:v1')
  const pPier = mockPort('pier:welcome:v1')
  r.add(pDock, { type: 'dock',    id: 'dock'    })
  r.add(pPier, { type: 'pier',    id: 'welcome' })

  if (r.total() === 2) ok('registry total = 2 after two adds')
  else bad('total wrong', r.total())

  if (r.countFor('dock') === 1)         ok('countFor(dock) = 1')
  else bad('countFor(dock) wrong')
  if (r.countFor('pier:welcome') === 1) ok('countFor(pier:welcome) = 1')
  else bad('countFor(pier:welcome) wrong')

  if (r.sendTo('dock', 'hello', { x: 1 }) === true) ok('sendTo(dock) returns true when port connected')
  else bad('sendTo true case wrong')
  if (pDock._messages().length === 1 && pDock._messages()[0].type === 'hello') ok('dock port received message')
  else bad('dock port did not receive', JSON.stringify(pDock._messages()))

  if (r.sendTo('options', 'x', {}) === false) ok('sendTo missing key returns false')
  else bad('sendTo missing key should be false')

  // broadcast hits both
  r.broadcast('tick', { n: 1 })
  if (pDock._messages().length === 2 && pPier._messages().length === 1) ok('broadcast hits all ports')
  else bad('broadcast distribution wrong', `dock=${pDock._messages().length} pier=${pPier._messages().length}`)

  // remove
  r.remove(pDock, { type: 'dock', id: 'dock' })
  if (r.countFor('dock') === 0) ok('remove drops port')
  else bad('remove failed')
  if (r.sendTo('dock', 'x', {}) === false) ok('sendTo to emptied key returns false')
  else bad('emptied key should not deliver')

  // pages API surface
  const pages = makePagesApi(r)
  if (typeof pages.dock.send    === 'function') ok('pages.dock.send exists')
  if (typeof pages.options.send === 'function') ok('pages.options.send exists')
  if (typeof pages.broadcast    === 'function') ok('pages.broadcast exists')

  if (typeof pages.piers.welcome.send === 'function') ok('pages.piers.<id> proxy works')
  else bad('pages.piers proxy broken')

  // pages.piers.welcome.send hits the registered pier port
  if (pages.piers.welcome.send('msg', { y: 2 }) === true) ok('pages.piers.welcome.send delivers')
  else bad('pages.piers.welcome.send did not deliver')
}

// --- handleConnect: version mismatch ---

group('handleConnect version handling')
{
  const { handleConnect } = await import('../src/define/harbor.js')
  const { makeHarborRegistry } = await import('../src/runtime/harbor-registry.js')
  const { PROTOCOL_VERSION }   = await import('../src/runtime/protocol.js')

  // Case 1: invalid name → disconnect, no registry add
  {
    const r = makeHarborRegistry()
    const p = mockPort('garbage')
    handleConnect(p, r)
    if (!p._isConnected()) ok('invalid name → port disconnected')
    else bad('invalid name → port should be disconnected')
    if (r.total() === 0) ok('invalid name → not added to registry')
    else bad('invalid name → leaked into registry')
  }

  // Case 2: client older → protocol:upgrade sent, then disconnect
  {
    const r = makeHarborRegistry()
    const p = mockPort('dock:dock:v0') // older
    handleConnect(p, r)
    const sent = p._messages()
    if (sent.length === 1 && sent[0].type === 'protocol:upgrade') ok('older client → protocol:upgrade sent')
    else bad('older client message wrong', JSON.stringify(sent))
    if (!p._isConnected()) ok('older client → port disconnected')
    if (r.total() === 0) ok('older client → not added to registry')
  }

  // Case 3: client newer → runtime:reload-tab sent, then disconnect
  {
    const r = makeHarborRegistry()
    const p = mockPort(`dock:dock:v${PROTOCOL_VERSION + 1}`)
    handleConnect(p, r)
    const sent = p._messages()
    if (sent.length === 1 && sent[0].type === 'runtime:reload-tab') ok('newer client → runtime:reload-tab sent')
    else bad('newer client message wrong', JSON.stringify(sent))
    if (!p._isConnected()) ok('newer client → port disconnected')
    if (r.total() === 0) ok('newer client → not added to registry')
  }

  // Case 4: version match → registered + session sent
  {
    const r = makeHarborRegistry()
    const p = mockPort(`dock:dock:v${PROTOCOL_VERSION}`)
    handleConnect(p, r)
    if (r.total() === 1) ok('version match → added to registry')
    else bad('version match → not registered', r.total())
    const sent = p._messages()
    if (sent.length === 1 && sent[0].type === 'session') ok('version match → session ack sent')
    else bad('version match session not sent', JSON.stringify(sent))
    if (sent[0].payload?.protocolVersion === PROTOCOL_VERSION) ok('session payload includes protocolVersion')
    else bad('session payload protocolVersion wrong')
  }

  // Case 5: disconnect after register removes from registry
  {
    const r = makeHarborRegistry()
    const p = mockPort(`dock:dock:v${PROTOCOL_VERSION}`)
    handleConnect(p, r)
    if (r.total() === 1) {
      p._emitDisconnect()
      if (r.total() === 0) ok('disconnect → removed from registry')
      else bad('disconnect → not removed', r.total())
    } else {
      bad('register precondition failed')
    }
  }
}

// --- PagePort ---

group('page-port')
{
  const { PagePort } = await import('../src/runtime/page-port.js')

  // Need a mockRuntime that returns mockPorts. PagePort calls runtime.connect.
  let lastPort = null
  const runtime = {
    connect({ name }) {
      lastPort = mockPort(name)
      return lastPort
    },
  }

  const port = new PagePort({ type: 'dock', id: 'dock', runtime })

  if (port._isConnected) ok('connect on construction')
  if (lastPort.name === 'dock:dock:v1') ok('port name uses makePortName')
  else bad('port name wrong', lastPort.name)

  // session field updates from session message
  lastPort._emitMessage({ type: 'session', payload: { user: null, phase: 1 } })
  if (port.session?.phase === 1) ok('session field updated from session message')
  else bad('session field not updated', JSON.stringify(port.session))

  // on() handler fires
  let received = null
  const off = port.on('hello', (payload) => { received = payload })
  lastPort._emitMessage({ type: 'hello', payload: { x: 42 } })
  if (received?.x === 42) ok('on() handler fires with payload')
  else bad('on() handler did not fire')

  // off() unsubscribes
  off()
  received = null
  lastPort._emitMessage({ type: 'hello', payload: { x: 99 } })
  if (received === null) ok('off() returned by on() unsubscribes')
  else bad('off() did not unsubscribe')

  // send() returns true when connected
  if (port.send('ping', { n: 1 }) === true) ok('send() returns true when connected')
  else bad('send() should return true')
  const lastMsg = lastPort._messages().slice(-1)[0]
  if (lastMsg?.type === 'ping' && lastMsg.payload?.n === 1) ok('send delivered correct shape')
  else bad('send shape wrong', JSON.stringify(lastMsg))

  // disconnect → reconnect on next send
  let disconnectFired = 0
  port.onDisconnect(() => { disconnectFired++ })

  lastPort._emitDisconnect()
  if (disconnectFired === 1) ok('onDisconnect fires on port disconnect')
  else bad('onDisconnect did not fire')

  // next send triggers reconnect
  let reconnectFired = 0
  port.onReconnect(() => { reconnectFired++ })
  const oldPortRef = lastPort
  port.send('post-reconnect', {})
  if (lastPort !== oldPortRef) ok('send after disconnect creates new port (lazy reconnect)')
  else bad('did not reconnect on send')
  if (reconnectFired === 1) ok('onReconnect fires after lazy reconnect')
  else bad('onReconnect did not fire')

  // protocol:upgrade triggers reload — verify by stubbing location.reload
  {
    let reloaded = 0
    const originalLocation = globalThis.location
    globalThis.location = { reload() { reloaded++ } }

    const port2 = new PagePort({ type: 'dock', id: 'dock', runtime })
    const port2_underlying = lastPort
    port2_underlying._emitMessage({ type: 'protocol:upgrade', payload: {} })
    if (reloaded === 1) ok('protocol:upgrade triggers location.reload')
    else bad('protocol:upgrade did not reload')

    port2_underlying._emitMessage({ type: 'runtime:reload-tab', payload: {} })
    if (reloaded === 2) ok('runtime:reload-tab triggers location.reload')
    else bad('runtime:reload-tab did not reload')

    globalThis.location = originalLocation
  }

  // No runtime → inert PagePort (send returns false, doesn't throw)
  {
    const inert = new PagePort({ type: 'dock', id: 'dock', runtime: null })
    if (inert.send('x', {}) === false) ok('PagePort with no runtime: send returns false')
    else bad('inert PagePort send should return false')
  }
}

// --- Browser shim ---

group('browser shim')
{
  const { _resetPermissionsCache } = await import('../src/browser/permissions.js')
  _resetPermissionsCache()

  // Without chrome global → throws on storage access
  delete globalThis.chrome
  delete globalThis.browser
  const { browser } = await import('../src/browser/index.js?v=test1')
  let threw = false
  try { await browser.storage.local.get('x') }
  catch (e) { threw = true; if (!/storage\.local/.test(e.message)) bad('error message not surface-specific', e.message); else ok('shim throws clear error on missing API') }
  if (!threw) bad('shim should have thrown')

  // With chrome global stubbed
  let warnLog = []
  const origWarn = console.warn
  console.warn = (...args) => { warnLog.push(args.join(' ')) }

  globalThis.chrome = {
    runtime: {
      id: 'mock',
      getManifest: () => ({ permissions: ['storage'] }), // tabs NOT declared
    },
    storage: {
      local: {
        get: async (keys) => ({ _stored: keys }),
        set: async (items) => undefined,
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: 'about:blank' }],
    },
  }
  _resetPermissionsCache()

  const { browser: browser2 } = await import('../src/browser/index.js?v=test2')

  // storage.local.get works (permission declared)
  const got = await browser2.storage.local.get('foo')
  if (got._stored === 'foo') ok('storage.local.get works when permission declared')
  else bad('storage.local.get returned unexpected', JSON.stringify(got))

  if (warnLog.filter(l => l.includes('storage')).length === 0) {
    ok('no audit warning when permission declared')
  } else {
    bad('false-positive audit warning', warnLog.join('\n'))
  }

  // tabs.query → audit warns (perm not declared)
  warnLog = []
  await browser2.tabs.query({ active: true })
  const tabsWarnings = warnLog.filter(l => l.includes('tabs') && l.includes('not declared'))
  if (tabsWarnings.length === 1) ok('audit warning when permission missing')
  else bad('audit warning count wrong', tabsWarnings.length + ': ' + warnLog.join('|'))

  // Repeat call → no duplicate warning
  warnLog = []
  await browser2.tabs.query({ active: true })
  if (warnLog.filter(l => l.includes('tabs')).length === 0) {
    ok('audit warning not repeated for same surface+perm')
  } else {
    bad('audit warning duplicated', warnLog.join('|'))
  }

  console.warn = origWarn

  // browser.raw escape hatch
  if (browser2.raw.chrome === globalThis.chrome) ok('browser.raw.chrome exposes native')
  else bad('browser.raw.chrome wrong')
}

// --- browser.idb ---

group('browser.idb')
{
  const { idb } = await import('../src/browser/idb.js')

  const db = await idb.open('jetty-test-db', {
    version: 1,
    schema(d) {
      if (!d.objectStoreNames.contains('items')) {
        d.createObjectStore('items', { keyPath: 'id' })
      }
    },
  })
  ok('idb.open returns wrapped db')

  await db.put('items', { id: 'a', value: 42 })
  const got = await db.get('items', 'a')
  if (got?.value === 42) ok('put + get roundtrip')
  else bad('put/get failed', JSON.stringify(got))

  await db.put('items', { id: 'b', value: 100 })
  const all = await db.getAll('items')
  if (all.length === 2) ok('getAll returns all rows')
  else bad('getAll wrong count', all.length)

  if (await db.count('items') === 2) ok('count works')
  else bad('count wrong')

  await db.delete('items', 'a')
  if (await db.get('items', 'a') === undefined) ok('delete removes row')
  else bad('delete failed')

  // Multi-op transaction
  await db.transaction('items', 'readwrite', (s) => {
    s.put({ id: 'c', value: 1 })
    s.put({ id: 'd', value: 2 })
  })
  if (await db.count('items') === 3) ok('multi-op transaction commits all writes')
  else bad('multi-op tx count wrong', await db.count('items'))

  await db.clear('items')
  if (await db.count('items') === 0) ok('clear empties store')

  db.close()
  await idb.deleteDatabase('jetty-test-db')
  ok('idb.deleteDatabase succeeds')
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
