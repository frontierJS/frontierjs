// Phase 2 unit tests.
//
// Coverage:
//   - Adapter contract: validateAdapter accepts/rejects
//   - Schema cache: load, persist, reconcile w/ mock adapter
//   - Auth flow: login/logout/hydrate, token storage + broadcast
//   - Message routing: init, service:call (generic + auth special case), errors
//   - PagePort.request(): RPC pattern, timeout, error response

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- mocks ---

function mockPort(name) {
  const messages            = []
  const msgListeners        = []
  const disconnectListeners = []
  let connected = true
  return {
    name,
    postMessage(msg) {
      if (!connected) throw new Error('port closed')
      messages.push(msg)
    },
    disconnect() { if (connected) { connected = false; for (const fn of disconnectListeners) fn() } },
    onMessage:    { addListener(fn) { msgListeners.push(fn) } },
    onDisconnect: { addListener(fn) { disconnectListeners.push(fn) } },
    _emitMessage(msg) { for (const fn of msgListeners) fn(msg) },
    _emitDisconnect() { connected = false; for (const fn of disconnectListeners) fn() },
    _isConnected: () => connected,
    _messages:    () => messages,
  }
}

function mockStorage() {
  const m = new Map()
  const area = {
    get(keys) {
      const out = {}
      const list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : null)
      if (list) {
        for (const k of list) if (m.has(k)) out[k] = m.get(k)
      } else if (keys && typeof keys === 'object') {
        for (const k of Object.keys(keys)) out[k] = m.has(k) ? m.get(k) : keys[k]
      } else {
        for (const [k, v] of m) out[k] = v
      }
      return Promise.resolve(out)
    },
    set(items) { for (const [k, v] of Object.entries(items)) m.set(k, v); return Promise.resolve() },
    remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) m.delete(k)
      return Promise.resolve()
    },
    clear() { m.clear(); return Promise.resolve() },
  }
  return { local: area, sync: area, session: area, _map: m }
}

function mockAdapter({ schemaVersion = null, schema = null, services = {}, autoConnect = true } = {}) {
  let connected = autoConnect
  let token = null
  let url = null
  const subs   = new Map()
  const events = { connect: new Set(), disconnect: new Set(), reconnect: new Set(), error: new Set() }
  const calls  = []
  return {
    async connect(opts = {}) { connected = true; url = opts.url; token = opts.token ?? null; for (const fn of events.connect) fn() },
    async disconnect()       { connected = false; for (const fn of events.disconnect) fn() },
    isConnected()            { return connected },
    async setToken(t)        { token = t },
    async call(service, method, args) {
      calls.push({ service, method, args })
      const key = `${service}.${method}`
      if (services[key]) return services[key](args)
      throw new Error(`no mock for ${key}`)
    },
    async subscribe(channel, handler) { subs.set(channel, handler); return () => subs.delete(channel) },
    on(event, fn) { events[event]?.add(fn); return () => events[event]?.delete(fn) },
    async fetchSchema() { return schema ? { version: schemaVersion, schema } : null },
    async getServerSchemaVersion() { return schemaVersion },
    // test helpers
    _calls: () => calls,
    _emit:  (event, ...args) => { for (const fn of events[event] || []) fn(...args) },
    _token: () => token,
  }
}

// --- adapter contract ---

group('adapter contract')
{
  const { validateAdapter } = await import('../src/junction/adapter.js')

  // Conformant adapter passes
  const good = mockAdapter()
  try { validateAdapter(good); ok('validateAdapter accepts conformant adapter') }
  catch (e) { bad('rejected conformant adapter', e.message) }

  // Missing required method
  const bad1 = { connect: () => {}, disconnect: () => {}, isConnected: () => true /* no .call */ }
  try { validateAdapter(bad1); bad('validateAdapter accepted missing .call') }
  catch (e) {
    if (/call/.test(e.message)) ok('validateAdapter reports missing .call')
    else bad('error message lacks method name', e.message)
  }

  // Non-object
  try { validateAdapter(null); bad('validateAdapter accepted null') }
  catch (e) { ok('validateAdapter rejects null') }
}

// --- schema cache ---

group('schema cache')
{
  const { makeSchemaCache } = await import('../src/junction/schema-cache.js')

  // No prior cache; server has v1 schema
  {
    const adapter = mockAdapter({ schemaVersion: 'v1', schema: { tables: ['x'] } })
    const storage = mockStorage()
    const cache = makeSchemaCache({ adapter, storage })

    await cache.load() // empty
    if (cache.current === null) ok('cache empty after load() w/ no storage')

    await cache.reconcile()
    if (cache.current?.version === 'v1') ok('reconcile fetches schema when no cache')
    else bad('reconcile did not populate', JSON.stringify(cache.current))

    if (storage._map.has('__jetty_schema__')) ok('schema persisted to storage')
    else bad('schema not persisted')
  }

  // Cache valid, server reports same version → no refetch
  {
    const adapter = mockAdapter({ schemaVersion: 'v1', schema: { tables: ['ignored'] } })
    const storage = mockStorage()
    storage._map.set('__jetty_schema__', { version: 'v1', schema: { tables: ['cached'] } })

    const cache = makeSchemaCache({ adapter, storage })
    await cache.load()
    if (cache.current?.schema?.tables?.[0] === 'cached') ok('load() restores from storage')

    await cache.reconcile()
    if (cache.current.schema.tables[0] === 'cached') ok('reconcile no-op when version matches')
    else bad('reconcile refetched unnecessarily')
  }

  // Cache stale, server reports new version → refetch
  {
    const adapter = mockAdapter({ schemaVersion: 'v2', schema: { tables: ['fresh'] } })
    const storage = mockStorage()
    storage._map.set('__jetty_schema__', { version: 'v1', schema: { tables: ['stale'] } })

    const cache = makeSchemaCache({ adapter, storage })
    await cache.load()
    await cache.reconcile()

    if (cache.current?.version === 'v2' && cache.current.schema.tables[0] === 'fresh') {
      ok('reconcile refetches on version mismatch')
    } else {
      bad('reconcile did not refetch', JSON.stringify(cache.current))
    }
  }

  // Invalidate clears cache + storage
  {
    const adapter = mockAdapter()
    const storage = mockStorage()
    storage._map.set('__jetty_schema__', { version: 'v1', schema: {} })
    const cache = makeSchemaCache({ adapter, storage })
    await cache.load()
    await cache.invalidate()
    if (cache.current === null) ok('invalidate clears in-memory cache')
    if (!storage._map.has('__jetty_schema__')) ok('invalidate clears storage')
  }
}

// --- auth flow ---

group('auth flow')
{
  const { makeAuthFlow } = await import('../src/junction/auth.js')

  function setup(services = {}) {
    const adapter = mockAdapter({ services })
    const storage = mockStorage()
    const broadcasts = []
    const pages = { broadcast: (type, payload) => { broadcasts.push({ type, payload }); return true } }
    const auth = makeAuthFlow({ adapter, storage, pages, tokenKey: 'tok' })
    return { adapter, storage, pages, broadcasts, auth }
  }

  // Successful login
  {
    const { adapter, storage, broadcasts, auth } = setup({
      'auth.login': async (creds) => ({ token: 'T1', user: { id: 7, email: creds.email }, expiresAt: null }),
    })
    const result = await auth.login({ email: 'a@b' })
    if (result.user?.id === 7) ok('login returns session')
    if (storage._map.get('tok') === 'T1') ok('token persisted')
    if (adapter._token() === 'T1') ok('adapter.setToken called w/ new token')
    if (broadcasts.length === 1 && broadcasts[0].type === 'session' && broadcasts[0].payload.authenticated) {
      ok('session broadcast sent after login')
    } else {
      bad('broadcast wrong', JSON.stringify(broadcasts))
    }
    if (auth.session.user?.id === 7) ok('session getter reflects login')
  }

  // Login failure (no token in response)
  {
    const { auth } = setup({
      'auth.login': async () => ({ user: { id: 1 } }), // missing token
    })
    try { await auth.login({}); bad('login should throw on missing token') }
    catch (e) { ok('login throws on missing token in response') }
  }

  // Logout clears
  {
    const { adapter, storage, broadcasts, auth } = setup({
      'auth.login':  async () => ({ token: 'T2', user: { id: 1 } }),
      'auth.logout': async () => ({ ok: true }),
    })
    await auth.login({})
    broadcasts.length = 0
    await auth.logout()
    if (!storage._map.has('tok')) ok('logout clears stored token')
    if (adapter._token() === null) ok('logout clears adapter token')
    if (auth.session.user === null && auth.session.authenticated === false) ok('logout clears session')
    if (broadcasts.length === 1 && !broadcasts[0].payload.authenticated) ok('logout broadcasts session w/ authenticated:false')
  }

  // Hydrate w/ valid stored token
  {
    const { adapter, storage, auth } = setup({
      'auth.verify': async ({ token }) => token === 'STORED' ? { user: { id: 9 }, expiresAt: 999 } : null,
    })
    storage._map.set('tok', 'STORED')
    await auth.hydrate()
    if (auth.session.user?.id === 9) ok('hydrate verifies stored token w/ server')
    if (adapter._token() === 'STORED') ok('hydrate sets adapter token')
  }

  // Hydrate w/ invalid stored token clears it
  {
    const { storage, auth } = setup({
      'auth.verify': async () => { throw new Error('expired') },
    })
    storage._map.set('tok', 'BAD')
    await auth.hydrate()
    if (!storage._map.has('tok')) ok('hydrate clears invalid token')
    if (!auth.session.authenticated) ok('hydrate session remains logged out on bad token')
  }
}

// --- message routing via handleConnect ---

group('message routing')
{
  const { defineHarbor, handleConnect } = await import('../src/define/harbor.js')
  const { makeHarborRegistry } = await import('../src/runtime/harbor-registry.js')
  const { PROTOCOL_VERSION } = await import('../src/runtime/protocol.js')

  // Simulate a connected port + a fake bootContext
  function setup(services = {}) {
    const adapter = mockAdapter({ services })
    const storage = mockStorage()
    const { makePagesApi } = require0('runtime/harbor-registry.js') // helper below
    const registry = makeHarborRegistry()
    const pages = makePagesApi(registry)
    return { adapter, storage, registry, pages }
  }

  // Helper to import dynamically — Node ESM doesn't support require
  async function im(p) { return await import(`../src/${p}`) }

  // Service:call generic forwarding
  {
    const adapter = mockAdapter({ services: {
      'foo.bar': async (args) => ({ echoed: args.x }),
    }})
    const registry = makeHarborRegistry()
    const { makePagesApi } = await im('runtime/harbor-registry.js')
    const pages = makePagesApi(registry)
    const { makeAuthFlow }  = await im('junction/auth.js')
    const storage = mockStorage()
    const authFlow = makeAuthFlow({ adapter, storage, pages, tokenKey: 'tk' })
    const ctx = { adapter, storage, pages, authFlow, schemaCache: null }

    const port = mockPort(`dock:dock:v${PROTOCOL_VERSION}`)
    handleConnect(port, registry, () => ctx)
    // First message: session ack auto-sent on connect
    const initial = port._messages().find((m) => m.type === 'session')
    if (initial) ok('session ack sent on connect')

    port._messages().length = 0

    // Send service:call
    port._emitMessage({
      type: 'service:call',
      payload: { service: 'foo', method: 'bar', args: { x: 42 }, _requestId: 'req1' },
    })

    // Wait for async routing
    await new Promise((r) => setTimeout(r, 10))

    const response = port._messages().find((m) => m.type === 'response:req1')
    if (response?.payload?.value?.echoed === 42) ok('service:call routes to adapter.call and replies w/ result')
    else bad('service:call response wrong', JSON.stringify(port._messages()))
  }

  // Service:call missing service/method
  {
    const adapter = mockAdapter()
    const registry = makeHarborRegistry()
    const { makePagesApi } = await im('runtime/harbor-registry.js')
    const pages = makePagesApi(registry)
    const { makeAuthFlow }  = await im('junction/auth.js')
    const storage = mockStorage()
    const authFlow = makeAuthFlow({ adapter, storage, pages, tokenKey: 'tk' })
    const ctx = { adapter, storage, pages, authFlow, schemaCache: null }

    const port = mockPort(`dock:dock:v${PROTOCOL_VERSION}`)
    handleConnect(port, registry, () => ctx)
    port._messages().length = 0

    port._emitMessage({ type: 'service:call', payload: { _requestId: 'req2' } })
    await new Promise((r) => setTimeout(r, 10))
    const response = port._messages().find((m) => m.type === 'response:req2')
    if (response?.payload?._error) ok('service:call without service/method returns _error')
    else bad('expected _error response', JSON.stringify(port._messages()))
  }

  // Service:call before boot completes → not-ready error
  {
    const registry = makeHarborRegistry()
    const port = mockPort(`dock:dock:v${PROTOCOL_VERSION}`)
    // getBootContext returns null = boot not done
    handleConnect(port, registry, () => null)
    port._messages().length = 0

    port._emitMessage({
      type: 'service:call',
      payload: { service: 'x', method: 'y', _requestId: 'req3' },
    })
    await new Promise((r) => setTimeout(r, 10))
    const response = port._messages().find((m) => m.type === 'response:req3')
    if (response?.payload?._error?.includes('booting')) ok('service:call before boot returns booting error')
    else bad('expected booting error', JSON.stringify(port._messages()))
  }

  // Auth login special-cased
  {
    const adapter = mockAdapter({ services: {
      'auth.login': async (creds) => ({ token: 'AT', user: { email: creds.email }, expiresAt: null }),
    }})
    const registry = makeHarborRegistry()
    const { makePagesApi } = await im('runtime/harbor-registry.js')
    const pages = makePagesApi(registry)
    const { makeAuthFlow } = await im('junction/auth.js')
    const storage = mockStorage()
    const authFlow = makeAuthFlow({ adapter, storage, pages, tokenKey: 'tk' })
    const ctx = { adapter, storage, pages, authFlow, schemaCache: null }

    const port = mockPort(`dock:dock:v${PROTOCOL_VERSION}`)
    handleConnect(port, registry, () => ctx)
    port._messages().length = 0

    port._emitMessage({
      type: 'service:call',
      payload: { service: 'auth', method: 'login', args: { email: 'x@y' }, _requestId: 'r4' },
    })
    await new Promise((r) => setTimeout(r, 10))

    const response = port._messages().find((m) => m.type === 'response:r4')
    if (response?.payload?.value?.user?.email === 'x@y') ok('auth.login routes via authFlow')
    else bad('auth.login response wrong', JSON.stringify(response))

    if (storage._map.get('tk') === 'AT') ok('auth.login persists token via authFlow')

    // Should also see a session broadcast on the same port (since registry has it)
    const sessionMsg = port._messages().filter((m) => m.type === 'session' && m.payload?.authenticated)
    if (sessionMsg.length >= 1) ok('auth.login broadcasts session')
    else bad('expected session broadcast')
  }
}

// --- PagePort.request() ---

group('PagePort.request')
{
  const { PagePort } = await import('../src/runtime/page-port.js')

  let lastPort = null
  const runtime = { connect({ name }) { lastPort = mockPort(name); return lastPort } }
  const port = new PagePort({ type: 'dock', id: 'dock', runtime })

  // Successful request: send msg, simulate response with matching _requestId
  {
    const promise = port.request('service:call', { service: 'x', method: 'y' })

    // Find the sent message; extract the request ID
    const sent = lastPort._messages().slice(-1)[0]
    if (sent?.type === 'service:call' && sent.payload?._requestId) {
      ok('request() sends w/ _requestId in payload')
      // Simulate response
      lastPort._emitMessage({
        type: `response:${sent.payload._requestId}`,
        payload: { value: { ok: true } },
      })
      const result = await promise
      if (result?.ok === true) ok('request() resolves w/ payload.value')
      else bad('request resolution wrong', JSON.stringify(result))
    } else {
      bad('request() did not send w/ _requestId')
    }
  }

  // _error response rejects
  {
    const promise = port.request('service:call', { service: 'x', method: 'y' })
    const sent = lastPort._messages().slice(-1)[0]
    lastPort._emitMessage({
      type: `response:${sent.payload._requestId}`,
      payload: { _error: 'boom' },
    })
    try { await promise; bad('request should have rejected') }
    catch (e) {
      if (e.message === 'boom') ok('request() rejects with _error message')
      else bad('error message wrong', e.message)
    }
  }

  // Timeout
  {
    const promise = port.request('service:call', { service: 'x', method: 'y' }, { timeout: 50 })
    try { await promise; bad('request should have timed out') }
    catch (e) {
      if (/timeout/.test(e.message)) ok('request() times out')
      else bad('expected timeout error', e.message)
    }
  }

  // No runtime → reject
  {
    const inert = new PagePort({ type: 'dock', id: 'dock', runtime: null })
    try { await inert.request('x'); bad('inert request should reject') }
    catch (e) { ok('request rejects when no runtime') }
  }
}

// --- defineHarbor full boot in node (no chrome) ---

group('defineHarbor boot')
{
  const { defineHarbor } = await import('../src/define/harbor.js')

  // No junction.url → boot completes without connecting, no errors
  {
    let ranWith = null
    const harbor = defineHarbor({
      run: async (ctx) => { ranWith = ctx },
    })
    await harbor._boot()
    if (ranWith?.junction) ok('boot exposes ctx.junction (default adapter)')
    if (ranWith?.pages?.broadcast) ok('boot exposes ctx.pages')
    if (ranWith?.storage?.local) ok('boot exposes ctx.storage')
    if (ranWith?.channels) ok('boot exposes ctx.channels (stubbed in Phase 2)')
  }

  // Custom adapter via config
  {
    const factory = (cfg) => mockAdapter()
    let ctxCaptured = null
    const harbor = defineHarbor({
      junction: { adapter: factory, url: null }, // no URL → no connect attempt
      run: async (ctx) => { ctxCaptured = ctx },
    })
    await harbor._boot()
    if (ctxCaptured?.junction?.isConnected !== undefined) ok('custom adapter wired via junction.adapter config')
  }

  // Bad adapter (missing required) → boot fails
  {
    const badFactory = () => ({ connect: () => {} /* missing rest */ })
    const harbor = defineHarbor({
      junction: { adapter: badFactory },
      run: async () => {},
    })
    try { await harbor._boot(); bad('boot should fail w/ bad adapter') }
    catch (e) {
      if (/missing required methods/.test(e.message)) ok('boot fails fast w/ bad adapter')
      else bad('boot error message wrong', e.message)
    }
  }
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
