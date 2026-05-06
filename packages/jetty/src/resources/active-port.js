// active-port.js — module-level registry holding the active PagePort.
//
// Sierra has `getClient()` returning a Junction client; jetty has a port
// instead. The registry is set by jetty's auto-generated main.js right after
// connectHarbor resolves and before mount(). Components that import resource
// helpers (createResource, login, etc.) read the port from here.
//
// Module-level state is the right answer for Pages: each Page is its own JS
// realm (one popup/options page/pier per realm) so there's exactly one active
// port per realm. Islands also have one port per content-script instance.

/** @type {import('../runtime/page-port.js').PagePort | null} */
let _activePort = null

const _connectionListeners = new Set()

// Connection state — bridged to a Mesa signal in mesa-bridge.js.
// The session message from harbor flips authenticated; protocol-level reconnects
// flip the connected/reconnecting fields based on PagePort lifecycle events.
let _connection = {
  connected:    false,
  reconnecting: null,  // null when stable, { attempt, delay } when reconnecting
  authenticated: false,
  user:         null,
  schema:       null,
}

function _notifyConnection() {
  for (const fn of _connectionListeners) {
    try { fn(_connection) }
    catch (e) { console.error('[jetty] connection listener threw', e) }
  }
}

/**
 * Register the active PagePort. Called by jetty's auto-generated main.js
 * after connectHarbor() resolves. Components do not call this directly.
 *
 * @param {import('../runtime/page-port.js').PagePort} port
 */
export function _registerActivePort(port) {
  _activePort = port
  if (!port) return

  // Wire connection state from port lifecycle.
  _connection = { ..._connection, connected: true }
  _notifyConnection()

  port.onDisconnect(() => {
    _connection = { ..._connection, connected: false }
    _notifyConnection()
  })

  port.onReconnect(() => {
    _connection = { ..._connection, connected: true, reconnecting: null }
    _notifyConnection()
  })

  // Session events from harbor update authentication state.
  port.on('session', (payload) => {
    _connection = {
      ..._connection,
      authenticated: !!payload?.authenticated,
      user:          payload?.user ?? null,
    }
    _notifyConnection()
  })

  // Schema events update cached schema for components that want introspection.
  port.on('schema', (payload) => {
    _connection = { ..._connection, schema: payload }
    _notifyConnection()
  })
}

/**
 * Returns the active port, or null if jetty hasn't booted (e.g. during SSR
 * or before connectHarbor resolves).
 */
export function getActivePort() {
  return _activePort
}

/**
 * Subscribe to connection state changes. Calls fn(state) immediately with
 * the current state, then on every change. Returns unsubscribe fn.
 *
 * Used by mesa-bridge.js to drive Mesa signals; can also be used directly
 * by non-Mesa code or for debugging.
 */
export function onConnectionChange(fn) {
  _connectionListeners.add(fn)
  try { fn(_connection) } catch (e) { console.error('[jetty] init notify threw', e) }
  return () => _connectionListeners.delete(fn)
}

/** Read current connection state synchronously. */
export function getConnectionState() {
  return _connection
}

// --- auth helpers ---
//
// Mirror of Sierra's login()/logout() but routed through the harbor port.
// Jetty's harbor handles the Junction setToken + token storage in Phase 2 —
// these helpers just kick off that flow via service:call.

/**
 * Trigger login via harbor. Returns the session payload the harbor broadcasts
 * after success. Throws on failure.
 *
 * @param {object} credentials — passed as `args` to harbor's auth.login service
 */
export async function login(credentials) {
  const port = _activePort
  if (!port) throw new Error('jetty.login: no active port (call after page mount)')
  return port.request('service:call', {
    service: 'auth',
    method:  'login',
    args:    credentials,
  })
}

/**
 * Trigger logout via harbor. Harbor clears its stored token and broadcasts
 * a logged-out session.
 */
export async function logout() {
  const port = _activePort
  if (!port) throw new Error('jetty.logout: no active port')
  return port.request('service:call', {
    service: 'auth',
    method:  'logout',
    args:    {},
  })
}
