// mesa-bridge.js — Mesa interop helpers.
//
// These helpers turn jetty's plain-JS state into Mesa-reactive signals so
// components can consume them with normal `$:` path watching or expression
// reading.
//
// Sierra has equivalent helpers in @frontierjs/sierra/junction:
//   connected, reconnecting (Mesa signals)
//   useStore(store) — bridges a Junction store into a component
//
// Jetty mirrors the API. The shape diverges underneath because:
//   - Sierra's `connected` is driven by Junction client lifecycle directly
//     (live in the page).
//   - Jetty's `connected` is driven by harbor port lifecycle + session events
//     (Junction lives in the SW, page sees only the proxy).
//
// Mesa runtime availability: same lazy-load pattern as runtime/mount.js. If
// Mesa isn't installed (sandbox), the Mesa-flavored signals fall back to
// plain getter-style values so non-component code still works.

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

/**
 * Wrap a jetty store as a Mesa-compatible signal. Mirrors Sierra's useStore —
 * call this once per component instance (at the top of your <script> block,
 * not inside a reactive computation) so the subscription is created once.
 *
 * Returns { get, value, unsubscribe }. Pass unsubscribe to $onDestroy:
 *
 *   const { get, unsubscribe } = await useStore(leadsStore)
 *   $onDestroy(unsubscribe)
 *
 * Falls back to non-reactive read if Mesa runtime is unavailable.
 *
 * @param {{ get(): any, subscribe(fn: (v: any) => void): () => void }} store
 */
export async function useStore(store) {
  const rt = await loadRuntime()
  if (rt && typeof rt.createSignal === 'function') {
    const [read, write] = rt.createSignal(store.get())
    const unsubscribe = store.subscribe((v) => write(v))
    return {
      get: read,
      get value() { return read() },
      unsubscribe,
    }
  }
  // Fallback — direct passthrough.
  let v = store.get()
  const unsubscribe = store.subscribe((next) => { v = next })
  return {
    get: () => v,
    get value() { return v },
    unsubscribe,
  }
}
