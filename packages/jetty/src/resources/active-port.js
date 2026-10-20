// active-port.js — module-level registry holding the active PagePort.
//
// Sierra has `getClient()` returning a Junction client; jetty has a port
// instead. The registry is set by jetty's auto-generated main.js right after
// connectHarbor resolves and before mount(). Components that import resource
// helpers (createResource, signIn, etc.) read the port from here.
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
  // A password accepted and a code still owed — the expiry, or null. Here and
  // not only on the broadcast, because a popup opened after the password gets
  // its session in reply to `init`, which can land before the page has a
  // listener of its own; this cache is what such a page starts from.
  awaitingCode: null,
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
      awaitingCode:  payload?.awaitingCode ?? null,
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
// Sierra's signIn / completeSignIn / signOut, the client's verbs (`FJS-D1315`),
// routed through the harbor port.
// Jetty's harbor handles the Junction setToken + token storage in Phase 2 —
// these helpers just kick off that flow via service:call.

/**
 * Sign in via harbor. Returns the session payload the harbor broadcasts after
 * success, or `{ awaitingCode }` when a second factor is owed. Throws on failure.
 *
 * @param {string} email
 * @param {string} password
 */
export async function signIn(email, password) {
  const port = _activePort
  if (!port) throw new Error('jetty.signIn: no active port (call after page mount)')
  return port.request('service:call', {
    service: 'auth',
    method:  'signIn',
    args:    { email, password },
  })
}

/**
 * Finish a sign-in that owed a second factor. `signIn()` resolved with
 * `awaitingCode` set, and the harbor holds the attempt — a page never sees the
 * ticket. A TOTP code or a recovery code; the person typing it cannot be asked
 * which kind of string they hold.
 *
 * @param {string} code
 */
export async function completeSignIn(code) {
  const port = _activePort
  if (!port) throw new Error('jetty.completeSignIn: no active port (call after page mount)')
  return port.request('service:call', {
    service: 'auth',
    method:  'completeSignIn',
    args:    { code },
  })
}

/**
 * Sign out via harbor. Harbor clears its stored token and broadcasts a
 * signed-out session.
 */
export async function signOut() {
  const port = _activePort
  if (!port) throw new Error('jetty.signOut: no active port')
  return port.request('service:call', {
    service: 'auth',
    method:  'signOut',
    args:    {},
  })
}
