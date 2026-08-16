// Junction Adapter Contract
//
// Jetty does not bundle the real @frontierjs/junction client. Instead, it
// depends on a thin adapter interface that any client (real Junction, mock
// for tests, or future replacement) must implement.
//
// Real Junction integration: in your jetty.config.js, supply
// `junction.adapter = (opts) => yourAdapter` to replace the default placeholder.
//
// Adapter shape (all methods optional unless marked REQUIRED):
//
//   {
//     // REQUIRED — Connect to the server. opts: { url, token }.
//     connect(opts): Promise<void>
//
//     // REQUIRED — Disconnect cleanly.
//     disconnect(): Promise<void>
//
//     // REQUIRED — Current connection state.
//     isConnected(): boolean
//
//     // REQUIRED — Make an RPC-style call. Errors throw.
//     call(service, method, args): Promise<result>
//
//     // OPTIONAL — Re-auth without disconnecting. Default: disconnect+reconnect.
//     setToken(token): Promise<void>
//
//     // OPTIONAL — Subscribe to a server-pushed channel. Returns unsubscribe.
//     // The handler is called (data, event) where `event` is the WIRE event
//     // name Junction sends — `posts created`, space-separated, past tense.
//     // A channel carries many events; a subscriber that is handed only the
//     // data cannot tell a create from a remove (FJS-059).
//     subscribe(channel, handler): Promise<unsubscribe>
//
//     // OPTIONAL — Lifecycle observability.
//     on(event, fn): unsubscribe       // events: connect, disconnect, reconnect, error
//
//     // OPTIONAL — Schema introspection. Returns null if not supported.
//     fetchSchema(): Promise<{ version, schema } | null>
//
//     // OPTIONAL — Quick version check for cache invalidation.
//     getServerSchemaVersion(): Promise<string | null>
//   }
//
// The default placeholder adapter (./default-adapter.js) implements REQUIRED
// + a minimal WebSocket protocol so Phase 2 can boot without external code.
// Treat it as a stand-in — replace before production.

const REQUIRED_METHODS = ['connect', 'disconnect', 'isConnected', 'call']

export function validateAdapter(adapter, label = 'adapter') {
  if (adapter == null || typeof adapter !== 'object') {
    throw new Error(`${label}: expected object, got ${typeof adapter}`)
  }
  const missing = REQUIRED_METHODS.filter((m) => typeof adapter[m] !== 'function')
  if (missing.length > 0) {
    throw new Error(
      `${label}: missing required methods: ${missing.join(', ')}. ` +
      `See JunctionAdapter contract in src/junction/adapter.js.`
    )
  }
  return adapter
}

// Optional-method shims — used by jetty internals to call optional methods
// safely. If adapter doesn't implement, these return sensible defaults rather
// than throwing.

export function callOptional(adapter, method, ...args) {
  if (typeof adapter?.[method] === 'function') {
    return adapter[method](...args)
  }
  return undefined
}

export async function safeFetchSchema(adapter) {
  if (typeof adapter?.fetchSchema !== 'function') return null
  try { return await adapter.fetchSchema() }
  catch (e) {
    console.warn('[jetty] adapter.fetchSchema threw:', e.message)
    return null
  }
}

export async function safeGetServerSchemaVersion(adapter) {
  if (typeof adapter?.getServerSchemaVersion !== 'function') return null
  try { return await adapter.getServerSchemaVersion() }
  catch (e) { return null }
}

export async function safeSubscribe(adapter, channel, handler) {
  if (typeof adapter?.subscribe !== 'function') {
    throw new Error('Junction adapter does not implement subscribe() — channels unavailable')
  }
  return adapter.subscribe(channel, handler)
}

export function safeOn(adapter, event, fn) {
  if (typeof adapter?.on === 'function') {
    return adapter.on(event, fn)
  }
  // Inert unsubscribe.
  return () => {}
}

export async function safeSetToken(adapter, token) {
  if (typeof adapter?.setToken === 'function') {
    return adapter.setToken(token)
  }
  // Fallback: disconnect + reconnect with new token. Adapter must support
  // this contract — if .connect() doesn't accept a token in opts, this
  // adapter is non-conformant.
  if (adapter.isConnected()) await adapter.disconnect()
  // The reconnect URL must be remembered by the adapter or stored elsewhere.
  // Adapters that don't implement setToken should at minimum re-connect on
  // their own when next called. Conservatively, we return without action.
  return undefined
}
