// mesa-bridge.js — Harbor's connection state as Mesa signals.
//
// The state is jetty's own: Junction lives in Harbor, so `connected` follows
// the port's lifecycle and the session broadcasts rather than a socket in the
// page. A Resource's store goes through sierra's `useStore`, like any other.
//
// Mesa loads lazily, as in runtime/mount.js; without it the accessors fall back
// to plain getters so non-component code still works.

import { onConnectionChange, getConnectionState } from './active-port.js'

let _mesaRuntime = null
let _warned = false

async function loadRuntime() {
  if (_mesaRuntime !== null) return _mesaRuntime
  try {
    _mesaRuntime = await import('@frontierjs/mesa/runtime')
  } catch {
    _mesaRuntime = false
    if (!_warned) {
      console.warn('[jetty] @frontierjs/mesa/runtime not available — Mesa bridge in fallback mode')
      _warned = true
    }
  }
  return _mesaRuntime
}

/**
 * Mesa signal pair factory. Returns [read, write] where:
 *   read()       — gets current value (Mesa-tracked when called inside an effect)
 *   write(value) — updates value, notifies trackers
 *
 * Falls back to a plain getter/setter if Mesa runtime isn't available.
 */
async function makeSignal(initial) {
  const rt = await loadRuntime()
  if (rt && typeof rt.createSignal === 'function') {
    return rt.createSignal(initial)
  }
  // Fallback — non-reactive but API-compatible.
  let v = initial
  return [() => v, (next) => { v = next }]
}

// --- connection state signals ---
//
// We expose the same shape Sierra does:
//   connected        — boolean
//   reconnecting     — { attempt, delay } | null
//   authenticated    — boolean
//   user             — object | null
//   schema           — object | null
//
// These are async-initialized because Mesa runtime loads lazily. Apps can
// either await getConnected() at startup, or read connectionState() synchronously
// for non-reactive snapshot.

const _signals = {}
let _initPromise = null

function _initSignals() {
  if (_initPromise) return _initPromise
  _initPromise = (async () => {
    const initial = getConnectionState()
    const [readConnected,     writeConnected]     = await makeSignal(initial.connected)
    const [readReconnecting,  writeReconnecting]  = await makeSignal(initial.reconnecting)
    const [readAuthenticated, writeAuthenticated] = await makeSignal(initial.authenticated)
    const [readUser,          writeUser]          = await makeSignal(initial.user)
    const [readSchema,        writeSchema]        = await makeSignal(initial.schema)

    Object.assign(_signals, {
      connected:     readConnected,
      reconnecting:  readReconnecting,
      authenticated: readAuthenticated,
      user:          readUser,
      schema:        readSchema,
    })

    onConnectionChange((state) => {
      writeConnected(state.connected)
      writeReconnecting(state.reconnecting)
      writeAuthenticated(state.authenticated)
      writeUser(state.user)
      writeSchema(state.schema)
    })
  })()
  return _initPromise
}

/**
 * Returns Mesa signal accessors for connection state. Each returned function
 * is a Mesa signal read — calling it inside a Mesa effect/render registers a
 * dependency and re-fires on change.
 *
 * Usage in a component (.mesa file):
 *   const { connected, authenticated } = await getConnectionSignals()
 *   ...
 *   <button disabled={!connected()}>Send</button>
 *
 * Sierra exposes these as already-evaluated signals (sync from import). Jetty
 * is async because Mesa loads lazily — but in practice you can also read
 * `getConnectionState()` synchronously if you don't need reactivity.
 */
export async function getConnectionSignals() {
  await _initSignals()
  return _signals
}
