// Phase 2.5 unit tests — channels.
//
// Coverage:
//   - ChannelRegistry: subscribePort/unsubscribePort, refcount upstream, fan-out
//   - Multi-port subscription: one Junction sub, many ports get events
//   - Port disconnect → unsubscribeAllForPort
//   - Last subscriber leaving → upstream unsubscribe called
//   - channels.publish (harbor-side fan-out without Junction round-trip)
//   - channels.on('connection', fn) lifecycle hook fires on port connect
//   - PagePort.subscribe/unsubscribe end-to-end via mocked harbor
//   - PagePort auto-resubscribe after reconnect

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- mock helpers ---

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

/**
 * Mock adapter w/ subscribe support — emit events via `_emit(channel, data)`.
 */
function mockAdapter() {
  const subs = new Map()       // channel → handler (one per channel)
  const unsubCalls = []        // record unsubscribe calls
  return {
    async connect() {},
    async disconnect() {},
    isConnected() { return true },
    async call() { throw new Error('not used') },
    async subscribe(channel, handler) {
      if (subs.has(channel)) throw new Error(`already subscribed to ${channel}`)
      subs.set(channel, handler)
      return () => { unsubCalls.push(channel); subs.delete(channel) }
    },
    on() { return () => {} },
    _emit(channel, data) { subs.get(channel)?.(data) },
    _activeSubs: () => [...subs.keys()],
    _unsubCalls: () => unsubCalls,
  }
}

// --- ChannelRegistry ---

group('channel registry — subscribe & fan-out')
{
  const { makeChannelRegistry } = await import('../src/runtime/channel-registry.js')
  const adapter = mockAdapter()
  const reg = makeChannelRegistry({ adapter })

  const p1 = mockPort('dock:dock:v1')
  const p2 = mockPort('options:options:v1')

  await reg.subscribePort(p1, 'leads')
  if (reg.countSubscribers('leads') === 1) ok('subscribePort: 1st port → count = 1')
  if (adapter._activeSubs().includes('leads')) ok('first port → upstream subscribe called')

  await reg.subscribePort(p2, 'leads')
  if (reg.countSubscribers('leads') === 2) ok('subscribePort: 2nd port → count = 2')
  if (adapter._activeSubs().filter((c) => c === 'leads').length === 1) ok('refcount — only ONE upstream sub for shared channel')

  // Emit upstream event → both ports receive
  adapter._emit('leads', { id: 1, name: 'Acme' })
  const p1Events = p1._messages().filter((m) => m.type === 'channel:event')
  const p2Events = p2._messages().filter((m) => m.type === 'channel:event')
  if (p1Events.length === 1 && p1Events[0].payload?.channel === 'leads' && p1Events[0].payload?.data?.id === 1) {
    ok('fan-out: p1 received channel:event w/ payload')
  } else {
    bad('p1 fan-out wrong', JSON.stringify(p1Events))
  }
  if (p2Events.length === 1) ok('fan-out: p2 received same event')
  else bad('p2 fan-out missed', p2Events.length)
}

group('channel registry — unsubscribe & refcount')
{
  const { makeChannelRegistry } = await import('../src/runtime/channel-registry.js')
  const adapter = mockAdapter()
  const reg = makeChannelRegistry({ adapter })

  const p1 = mockPort('a:a:v1')
  const p2 = mockPort('b:b:v1')
  await reg.subscribePort(p1, 'tasks')
  await reg.subscribePort(p2, 'tasks')

  await reg.unsubscribePort(p1, 'tasks')
  if (reg.countSubscribers('tasks') === 1) ok('unsubscribePort: count -= 1')
  if (adapter._unsubCalls().length === 0) ok('upstream NOT unsubscribed while other ports remain')

  await reg.unsubscribePort(p2, 'tasks')
  if (reg.countSubscribers('tasks') === 0) ok('unsubscribePort: count = 0')
  if (adapter._unsubCalls().length === 1 && adapter._unsubCalls()[0] === 'tasks') {
    ok('upstream unsubscribed when last port leaves')
  } else {
    bad('upstream unsub did not fire', JSON.stringify(adapter._unsubCalls()))
  }
}

group('channel registry — port disconnect cleanup')
{
  const { makeChannelRegistry } = await import('../src/runtime/channel-registry.js')
  const adapter = mockAdapter()
  const reg = makeChannelRegistry({ adapter })

  const p = mockPort('island:sa:v1')
  await reg.subscribePort(p, 'leads')
  await reg.subscribePort(p, 'jobs')
  await reg.subscribePort(p, 'invoices')

  if (reg.activeChannels().length === 3) ok('precondition: 3 active channels')

  await reg.unsubscribeAllForPort(p)
  if (reg.activeChannels().length === 0) ok('unsubscribeAllForPort: all channels released')
  if (adapter._unsubCalls().length === 3) ok('all upstream subs released')
  else bad('unsub call count wrong', adapter._unsubCalls().length)
}

group('channel registry — publish (harbor-side fan-out)')
{
  const { makeChannelRegistry } = await import('../src/runtime/channel-registry.js')
  const adapter = mockAdapter()
  const reg = makeChannelRegistry({ adapter })

  const p1 = mockPort('dock:dock:v1')
  const p2 = mockPort('options:options:v1')
  await reg.subscribePort(p1, 'sync')
  await reg.subscribePort(p2, 'sync')

  const delivered = reg.publish('sync', { kind: 'cache:invalidate', key: 'leads' })
  if (delivered === true) ok('publish returns true when subs exist')

  const e1 = p1._messages().filter((m) => m.type === 'channel:event' && m.payload?.data?.kind === 'cache:invalidate')
  const e2 = p2._messages().filter((m) => m.type === 'channel:event' && m.payload?.data?.kind === 'cache:invalidate')
  if (e1.length === 1 && e2.length === 1) ok('publish fans out to all subscribed ports')

  if (reg.publish('nonexistent', {}) === false) ok('publish returns false for empty channel')
}

// --- channels API surface ---

group('channels API (run ctx)')
{
  const { makeChannelRegistry, makeChannelsApi } = await import('../src/runtime/channel-registry.js')
  const adapter = mockAdapter()
  const channelRegistry = makeChannelRegistry({ adapter })
  const lifecycleHooks  = { connection: new Set() }
  const channels = makeChannelsApi({ adapter, channelRegistry, lifecycleHooks })

  // on('connection') — lifecycle hook
  let connected = []
  const off = channels.on('connection', (info) => connected.push(info))

  // Simulate connection event firing via lifecycleHooks.connection set
  for (const fn of lifecycleHooks.connection) fn({ type: 'dock', id: 'dock' })
  if (connected.length === 1 && connected[0].type === 'dock') ok('channels.on(connection) hook fires')

  off()
  for (const fn of lifecycleHooks.connection) fn({ type: 'pier', id: 'welcome' })
  if (connected.length === 1) ok('channels.on returns unsubscribe')

  // on with unknown event throws
  try { channels.on('not-a-real-event', () => {}); bad('channels.on(unknown) accepted') }
  catch (e) {
    if (/unknown event/.test(e.message)) ok('channels.on(unknown) throws clearly')
    else bad('error message wrong', e.message)
  }

  // direct subscribe via adapter
  let received = null
  const offSub = await channels.subscribe('events', (data) => { received = data })
  adapter._emit('events', { x: 1 })
  if (received?.x === 1) ok('channels.subscribe routes adapter events to handler')
  await offSub()

  // publish reaches subscribed ports
  const p = mockPort('dock:dock:v1')
  await channelRegistry.subscribePort(p, 'broadcast-test')
  if (channels.publish('broadcast-test', { hello: 1 }) === true) ok('channels.publish via API works')
}

// --- handleConnect: connection lifecycle hook fires ---

group('handleConnect — connection lifecycle')
{
  const { handleConnect } = await import('../src/define/harbor.js')
  const { makeHarborRegistry } = await import('../src/runtime/harbor-registry.js')
  const { PROTOCOL_VERSION } = await import('../src/runtime/protocol.js')

  const lifecycleHooks = { connection: new Set() }
  const seen = []
  lifecycleHooks.connection.add((info) => seen.push(info))

  const registry = makeHarborRegistry()
  const port = mockPort(`pier:welcome:v${PROTOCOL_VERSION}`)
  handleConnect(port, registry, () => null, lifecycleHooks)

  if (seen.length === 1 && seen[0].type === 'pier' && seen[0].id === 'welcome') {
    ok('connection hook fires w/ parsed type+id on valid port')
  } else {
    bad('connection hook did not fire correctly', JSON.stringify(seen))
  }

  // Invalid port name → no connection hook fire
  const bad1 = mockPort('garbage')
  handleConnect(bad1, registry, () => null, lifecycleHooks)
  if (seen.length === 1) ok('connection hook does NOT fire on invalid port')
  else bad('connection hook fired on invalid port')
}

// --- routeMessage: channel:subscribe / channel:unsubscribe ---

group('routeMessage — channel:subscribe / channel:unsubscribe')
{
  const { handleConnect } = await import('../src/define/harbor.js')
  const { makeHarborRegistry, makePagesApi } = await import('../src/runtime/harbor-registry.js')
  const { makeChannelRegistry } = await import('../src/runtime/channel-registry.js')
  const { PROTOCOL_VERSION } = await import('../src/runtime/protocol.js')

  const adapter = mockAdapter()
  const registry = makeHarborRegistry()
  const channelRegistry = makeChannelRegistry({ adapter })
  const pages = makePagesApi(registry)
  const ctx = { adapter, pages, channelRegistry, authFlow: { session: { user: null } }, schemaCache: null }

  const port = mockPort(`dock:dock:v${PROTOCOL_VERSION}`)
  handleConnect(port, registry, () => ctx, { connection: new Set() })
  port._messages().length = 0 // clear initial session ack

  // Subscribe
  port._emitMessage({ type: 'channel:subscribe', payload: { channel: 'leads', _requestId: 's1' } })
  await new Promise((r) => setTimeout(r, 10))
  const ackSub = port._messages().find((m) => m.type === 'response:s1')
  if (ackSub?.payload?.value?.ok && ackSub.payload?.value?.channel === 'leads') ok('channel:subscribe returns ok ack')
  else bad('subscribe ack wrong', JSON.stringify(ackSub))

  if (channelRegistry.countSubscribers('leads') === 1) ok('subscribe registered port in registry')

  // Emit upstream event → port receives channel:event
  adapter._emit('leads', { id: 99 })
  const evt = port._messages().find((m) => m.type === 'channel:event')
  if (evt?.payload?.channel === 'leads' && evt.payload.data?.id === 99) ok('upstream event delivered to port')
  else bad('upstream event not delivered', JSON.stringify(port._messages()))

  // Unsubscribe
  port._emitMessage({ type: 'channel:unsubscribe', payload: { channel: 'leads', _requestId: 'u1' } })
  await new Promise((r) => setTimeout(r, 10))
  if (channelRegistry.countSubscribers('leads') === 0) ok('channel:unsubscribe removed port')
  if (adapter._unsubCalls().includes('leads')) ok('upstream unsubscribed when last port leaves')

  // Subscribe missing channel → error response
  port._emitMessage({ type: 'channel:subscribe', payload: { _requestId: 's2' } })
  await new Promise((r) => setTimeout(r, 10))
  const ackBad = port._messages().find((m) => m.type === 'response:s2')
  if (ackBad?.payload?._error) ok('channel:subscribe w/o channel returns _error')
}

// --- handleConnect: port disconnect cleans up channels ---

group('handleConnect — disconnect cleans channels')
{
  const { handleConnect } = await import('../src/define/harbor.js')
  const { makeHarborRegistry } = await import('../src/runtime/harbor-registry.js')
  const { makeChannelRegistry } = await import('../src/runtime/channel-registry.js')
  const { PROTOCOL_VERSION } = await import('../src/runtime/protocol.js')

  const adapter = mockAdapter()
  const registry = makeHarborRegistry()
  const channelRegistry = makeChannelRegistry({ adapter })
  const ctx = { adapter, channelRegistry, authFlow: { session: { user: null } }, schemaCache: null,
                pages: { broadcast: () => false } }

  const port = mockPort(`island:sa:v${PROTOCOL_VERSION}`)
  handleConnect(port, registry, () => ctx, { connection: new Set() })

  port._emitMessage({ type: 'channel:subscribe', payload: { channel: 'a' } })
  port._emitMessage({ type: 'channel:subscribe', payload: { channel: 'b' } })
  await new Promise((r) => setTimeout(r, 10))
  if (channelRegistry.activeChannels().length === 2) ok('precondition: port subscribed to 2 channels')

  port._emitDisconnect()
  await new Promise((r) => setTimeout(r, 10)) // let async cleanup complete
  if (channelRegistry.activeChannels().length === 0) ok('disconnect → all channels released')
  if (adapter._unsubCalls().length === 2) ok('disconnect → upstream unsubscribed for each')
}

// --- PagePort.subscribe ---

group('PagePort.subscribe')
{
  const { PagePort } = await import('../src/runtime/page-port.js')

  let lastPort = null
  const runtime = { connect({ name }) { lastPort = mockPort(name); return lastPort } }
  const port = new PagePort({ type: 'dock', id: 'dock', runtime })

  // Subscribe sends channel:subscribe
  let received = []
  const off = port.subscribe('leads', (data, full) => received.push({ data, full }))

  const subMsg = lastPort._messages().find((m) => m.type === 'channel:subscribe')
  if (subMsg?.payload?.channel === 'leads') ok('subscribe sends channel:subscribe w/ channel name')

  // Emit a channel:event for THIS channel → handler fires
  lastPort._emitMessage({ type: 'channel:event', payload: { channel: 'leads', data: { id: 1 } } })
  if (received.length === 1 && received[0].data.id === 1) ok('handler fires on matching channel:event')

  // Emit a channel:event for a DIFFERENT channel → handler ignored
  lastPort._emitMessage({ type: 'channel:event', payload: { channel: 'tasks', data: { id: 99 } } })
  if (received.length === 1) ok('handler ignores other channels (filter by channel name)')

  // Unsubscribe sends channel:unsubscribe and stops handler
  off()
  const unsubMsg = lastPort._messages().find((m) => m.type === 'channel:unsubscribe')
  if (unsubMsg?.payload?.channel === 'leads') ok('off() sends channel:unsubscribe')

  lastPort._emitMessage({ type: 'channel:event', payload: { channel: 'leads', data: { id: 2 } } })
  if (received.length === 1) ok('handler does not fire after off()')

  // subscribe with bad args throws
  try { port.subscribe('', () => {}); bad('subscribe accepted empty channel') }
  catch { ok('subscribe rejects empty channel') }
  try { port.subscribe('x', null); bad('subscribe accepted non-fn handler') }
  catch { ok('subscribe rejects non-function handler') }
}

group('PagePort.subscribe — auto-resubscribe on reconnect')
{
  const { PagePort } = await import('../src/runtime/page-port.js')

  let lastPort = null
  const runtime = { connect({ name }) { lastPort = mockPort(name); return lastPort } }
  const port = new PagePort({ type: 'dock', id: 'dock', runtime })
  const initialPort = lastPort

  port.subscribe('leads', () => {})

  const subCount0 = lastPort._messages().filter((m) => m.type === 'channel:subscribe').length
  if (subCount0 === 1) ok('initial subscribe sent')

  // Disconnect → next send triggers reconnect
  initialPort._emitDisconnect()
  port.send('keepalive', {})  // forces reconnect

  // After reconnect, the new port should have received another channel:subscribe
  const subCount1 = lastPort._messages().filter((m) => m.type === 'channel:subscribe').length
  if (subCount1 >= 1 && lastPort !== initialPort) ok('auto-resubscribe sent after reconnect')
  else bad('auto-resubscribe missing', `same port: ${lastPort === initialPort}, count: ${subCount1}`)
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
