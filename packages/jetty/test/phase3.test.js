// Phase 3 — a page's Resources, which are sierra's, over Harbor.
//
// A page holds no connection: MV3 keeps it in the service worker. So the page's
// Junction client RELAYS (`harborApp()`), and sierra's own Resource runs on top
// of it — the live store, query matching, the patch baseline — rather than a
// copy of it that drifted (`FJS-D650`, `FJS-2024`).
//
// The first group is the whole chain and nothing in it is a fake: a PagePort,
// Harbor's real message router, `createJunctionAdapter`, and a real Junction
// app on a real socket. The port between page and Harbor is the one stand-in,
// and it serializes through JSON the way a chrome.runtime port does — which is
// what turned a refusal into a bare message before (`code` and `data` lost).
//
// Runs under BUN, not node: a Junction app is Bun-only.
//
// Coverage:
//   - load → rows and the store, over the relay
//   - a push the server sends lands in the page's store, graded by the query
//   - save() patches what changed against the row read
//   - a refusal crosses the port with its status and data
//   - a call only HTTP can carry is refused by name
//   - a custom method relays
//   - login/logout (mocked port)
//   - getConnectionState reflects port lifecycle + session events

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- mock PagePort ---
//
// Just enough surface to drive resources: send + on (for channel:event) +
// onDisconnect + onReconnect + subscribe + request. The real PagePort tests
// (Phase 1/2.5) cover the underlying behavior; here we focus on resources.

function mockPagePort() {
  const handlers       = new Map()
  const subscriptions  = new Map() // channel → handler
  const lifecycleHooks = { disconnect: new Set(), reconnect: new Set() }
  let _requestHandlers = []  // shifts out as requests come in
  const _sentMessages  = []

  const port = {
    type: 'dock', id: 'dock', session: null,
    send(type, payload) { _sentMessages.push({ type, payload }); return true },
    on(type, fn) {
      let set = handlers.get(type)
      if (!set) { set = new Set(); handlers.set(type, set) }
      set.add(fn)
      return () => set.delete(fn)
    },
    off(type, fn) { handlers.get(type)?.delete(fn) },
    onDisconnect(fn) { lifecycleHooks.disconnect.add(fn); return () => lifecycleHooks.disconnect.delete(fn) },
    onReconnect(fn)  { lifecycleHooks.reconnect.add(fn);  return () => lifecycleHooks.reconnect.delete(fn) },
    subscribe(channel, handler) {
      subscriptions.set(channel, handler)
      return () => subscriptions.delete(channel)
    },
    async request(type, payload, opts) {
      // Test injects expected responses via _enqueueResponse.
      const responder = _requestHandlers.shift()
      if (!responder) {
        throw new Error(`mockPagePort: unexpected request "${type}" — no responder enqueued`)
      }
      return responder(type, payload, opts)
    },

    // Test helpers
    _emit(type, payload) {
      const set = handlers.get(type)
      if (!set) return
      for (const fn of set) fn(payload, { type, payload })
    },
    // (channel, data, event) — a channel carries MANY events, and `event` is the
    // wire name Junction sends: `widgets created`, space-separated, past tense.
    // The mock used to take only a channel, which is how a test came to pin the
    // bug: it asserted four subscriptions to names the server never publishes.
    _emitChannel(channel, data, event) {
      const handler = subscriptions.get(channel)
      if (handler) handler(data, { channel, data, event })
    },
    _emitDisconnect() { for (const fn of lifecycleHooks.disconnect) fn() },
    _emitReconnect()  { for (const fn of lifecycleHooks.reconnect) fn() },
    _enqueueResponse(fn) { _requestHandlers.push(fn) },
    _sentMessages: () => _sentMessages,
    _activeSubscriptions: () => [...subscriptions.keys()],
  }

  return port
}

// --- the whole chain ---

group('a Resource over Harbor, against a real Junction app')
{
  const { createApp, createService, channels, defaultConfig } = await import('../../junction/index.ts')
  const { Conflict }               = await import('../../junction/src/core/errors.ts')
  const { createResource }         = await import('../../sierra/src/resource/index.js')
  const { createJunctionAdapter }  = await import('../src/junction/junction-adapter.js')
  const { handleConnect }          = await import('../src/define/harbor.js')
  const { makeHarborRegistry, makePagesApi } = await import('../src/runtime/harbor-registry.js')
  const { makeChannelRegistry }    = await import('../src/runtime/channel-registry.js')
  const { PagePort }               = await import('../src/runtime/page-port.js')
  const { _registerActivePort }    = await import('../src/resources/active-port.js')
  const { harborApp }              = await import('../src/resources/index.js')

  const ROOM = 'everyone'
  const rows = [
    { id: 1, status: 'paid',  note: '' },
    { id: 2, status: 'paid',  note: '' },
    { id: 3, status: 'draft', note: '' },
  ]
  const patches = []

  const app = createApp({
    config: { port: 0, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http } },
  })
  app.configure(channels((a) => {
    a.channels.on('connection', (_s, conn) => { a.channel(ROOM).join(conn) })
  }))
  app.services.register(createService({
    name:    'orders',
    methods: ['find', 'get', 'patch', 'ship'],
    async find(ctx) {
      return rows.filter(r => ctx.query?.status === undefined || r.status === ctx.query.status)
    },
    async get(ctx) { return rows.find(r => r.id === Number(ctx.id)) ?? null },
    async patch(ctx) {
      patches.push(ctx.data)
      if (ctx.data?.note === 'refuse') throw new Conflict('somebody else got there', { reason: 'raced' })
      const row = rows.find(r => r.id === Number(ctx.id))
      Object.assign(row, ctx.data)
      return row
    },
    async ship(ctx) {
      const row = rows.find(r => r.id === Number(ctx.id))
      row.status = 'shipped'
      return row
    },
  }))
  await app.start()
  const url = `http://127.0.0.1:${app.http.port}`

  // Harbor: the real adapter on a real socket, and the real router.
  const adapter = createJunctionAdapter({ url })
  await adapter.connect()
  // connect() builds the client and opens the socket; `connect` is the server's
  // frame, which cannot have arrived yet. Pushes need the socket up.
  await new Promise((r) => { const off = adapter.on('connect', () => { off(); r() }) })
  const registry = makeHarborRegistry()
  const ctx = {
    adapter,
    pages:           makePagesApi(registry),
    channelRegistry: makeChannelRegistry({ adapter }),
    authFlow:        null,
    schemaCache:     null,
  }

  // A chrome.runtime port carries JSON, so every message is cloned through it.
  function pipe(name) {
    const a = { on: [], off: [] }, b = { on: [], off: [] }
    const end = (self, other) => ({
      name,
      postMessage(msg) {
        const copy = JSON.parse(JSON.stringify(msg))
        queueMicrotask(() => { for (const fn of other.on) fn(copy) })
      },
      disconnect() { for (const fn of other.off) fn() },
      onMessage:    { addListener(fn) { self.on.push(fn) } },
      onDisconnect: { addListener(fn) { self.off.push(fn) } },
    })
    return [end(a, b), end(b, a)]
  }
  const runtime = {
    connect({ name }) {
      const [page, harbor] = pipe(name)
      handleConnect(harbor, registry, () => ctx)
      return page
    },
  }
  const port = new PagePort({ type: 'dock', id: 'dock', runtime })
  _registerActivePort(port)

  const settle = async (pred, ms = 2000) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (pred()) return true; await new Promise(r => setTimeout(r, 20)) }
    return pred()
  }

  const orders = createResource('orders', { app: harborApp() })

  // load → the rows, and the store
  const loaded = await orders.load({ status: 'paid' })
  if (loaded.map(r => r.id).join() === '1,2') ok('load() relays through Harbor and answers the rows')
  else bad('load() rows', JSON.stringify(loaded))
  if (orders.store.get().map(r => r.id).join() === '1,2') ok('…and the store holds them')
  else bad('store after load', JSON.stringify(orders.store.get()))

  // A push the server sends, graded by the query this store answers.
  rows[2].status = 'paid'
  app.channel(ROOM).send('orders patched', { ...rows[2] })
  if (await settle(() => orders.store.get().some(r => r.id === 3))) ok('a push that enters the filter lands in the page store')
  else bad('push into the filter never arrived', JSON.stringify(orders.store.get()))

  app.channel(ROOM).send('orders patched', { ...rows[0], status: 'shipped' })
  if (await settle(() => !orders.store.get().some(r => r.id === 1))) ok('a push that LEAVES the filter removes the row (FJS-493)')
  else bad('row that left the filter stayed', JSON.stringify(orders.store.get()))

  // save() sends what changed against the row this screen read (FJS-2024) —
  // the key travels too, since it addresses the write. `status` did not
  // change, so a concurrent write to it is not overwritten.
  const read = await orders.service.get(2)
  patches.length = 0
  await orders.save({ ...read, note: 'fragile' })
  const sent = patches[0] ?? {}
  if (!('status' in sent) && sent.note === 'fragile') ok('save() patches only the changed column (FJS-2024)')
  else bad('save() sent the whole record', JSON.stringify(sent))

  // A refusal crosses the port with its status and its data.
  try {
    await orders.service.patch(2, { note: 'refuse' })
    bad('a refused patch resolved')
  } catch (e) {
    if (e.code === 409) ok('a refusal keeps its status across the port')
    else bad('status lost across the port', JSON.stringify({ code: e.code, message: e.message }))
    if (e.data?.data?.reason === 'raced') ok('…and its data, where a form reads the reason')
    else bad('data lost across the port', JSON.stringify(e.data))
  }

  // Only a framed call crosses; a findFirst travels as a URL.
  try {
    await orders.service.get({ status: 'paid' })
    bad('a findFirst relayed')
  } catch (e) {
    if (/cannot be relayed/.test(e.message)) ok('a call only HTTP can carry is refused by name')
    else bad('wrong refusal for an HTTP-only call', e.message)
  }

  // A custom method relays like CRUD.
  const shipped = await orders.service.call('ship', 2, null)
  if (shipped?.status === 'shipped') ok('a custom method relays')
  else bad('custom method answer', JSON.stringify(shipped))

  await adapter.disconnect()
  await app.stop()
}

// --- login / logout ---

group('login / logout')
{
  const { _registerActivePort, login, logout } = await import('../src/resources/active-port.js')

  const port = mockPagePort()
  _registerActivePort(port)

  port._enqueueResponse((type, payload) => {
    if (payload.service === 'auth' && payload.method === 'login' && payload.args.email === 'a@b') {
      return { token: 'T', user: { id: 1, email: 'a@b' } }
    }
    return Promise.reject(new Error('wrong'))
  })
  const session = await login({ email: 'a@b', password: 'x' })
  if (session?.user?.id === 1) ok('login → service:call(auth, login) returns session')

  port._enqueueResponse((type, payload) => {
    if (payload.method === 'logout') return { ok: true }
    return Promise.reject(new Error('wrong'))
  })
  const logoutResult = await logout()
  if (logoutResult?.ok) ok('logout → service:call(auth, logout)')

  // No port → throws
  _registerActivePort(null)
  try { await login({}); bad('login w/o port should throw') }
  catch (e) {
    if (/no active port/.test(e.message)) ok('login throws clearly when no port')
  }
}

// --- connection state tracking ---

group('connection state')
{
  const { _registerActivePort, getConnectionState, onConnectionChange } = await import('../src/resources/active-port.js')

  const port = mockPagePort()
  _registerActivePort(port)

  let state = getConnectionState()
  if (state.connected === true) ok('connected = true after register')

  // Simulate harbor session message
  port._emit('session', { user: { id: 5 }, authenticated: true })
  state = getConnectionState()
  if (state.authenticated === true && state.user?.id === 5) ok('session message updates auth state')

  // A waiting attempt is part of the cached state, and leaves it again. A page
  // opened after the password reads this before any listener of its own exists,
  // so a cache carrying only `authenticated` shows that page a password form.
  port._emit('session', { user: null, authenticated: false, awaitingCode: '2030-01-01T00:00:00.000Z' })
  state = getConnectionState()
  if (state.awaitingCode === '2030-01-01T00:00:00.000Z' && !state.authenticated) ok('a waiting attempt reaches the cached state')
  else bad('the cached state dropped awaitingCode', JSON.stringify(state))
  port._emit('session', { user: { id: 5 }, authenticated: true })
  state = getConnectionState()
  if (state.awaitingCode === null && state.authenticated) ok('…and a session clears it')
  else bad('awaitingCode outlived the session', JSON.stringify(state))

  // Simulate disconnect
  port._emitDisconnect()
  state = getConnectionState()
  if (state.connected === false) ok('disconnect flips connected')

  // Reconnect
  port._emitReconnect()
  state = getConnectionState()
  if (state.connected === true) ok('reconnect flips connected back')

  // onConnectionChange fires
  let lastState = null
  const off = onConnectionChange((s) => { lastState = s })
  if (lastState?.connected === true) ok('onConnectionChange fires immediately with current')

  port._emit('schema', { version: 'v1', schema: {} })
  if (lastState?.schema?.version === 'v1') ok('schema message threads through state')

  off()
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
