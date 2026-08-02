/**
 * tests/junction-boot.test.js
 *
 * virtual:sierra used to emit `await initJunction(sierraConfig.junction)` at the
 * top level of the app entry module, so every importer — including whatever
 * mounted the app — waited for it. Nothing rendered until it resolved.
 *
 * What it waited for, with the real @frontierjs/junction client:
 *
 *   client.setToken(stored)   → opens the WebSocket
 *   await new Promise(...)    → resolves on the client's 'connect' event,
 *                               or a 2 000 ms timeout, whichever is first
 *
 * and the client only emits 'connect' when the *server* sends
 * `{ type: 'connected' }`, at the end of its open handler after verifySession
 * and connection registration. So the stall was a full round-trip plus
 * server-side session verification — not merely a socket open — and every
 * returning visitor has a stored token, so it was the common path.
 *
 * The justification was that the first resource load() should see
 * `_wsReady === true` and use WebSocket rather than HTTP. But the client's
 * `_wsCall()` already opens with:
 *
 *   if (!this._wsReady || !this._ws) return this._httpFallback(...)
 *
 * so calls made before the socket is ready work fine — they just take the HTTP
 * path. Blocking first paint for up to two seconds bought a transport
 * preference, not correctness.
 *
 * initJunction is now synchronous and exposes `whenReady` for anything that
 * genuinely needs the socket. These tests pin that, using fake timers so they
 * assert structure rather than wall-clock timings.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

// ─── Scripted WebSocket ───────────────────────────────────────────────────────

let sockets = []
let CONNECT_AFTER = 100        // ms until the server's {type:'connected'} arrives

class ScriptedWS {
  static OPEN = 1
  constructor(url) {
    this.url = url
    this.readyState = 0
    sockets.push(this)
    setTimeout(() => {
      this.readyState = 1
      this.onopen?.({})
      if (CONNECT_AFTER !== Infinity) {
        setTimeout(() => {
          this.onmessage?.({ data: JSON.stringify({ type: 'connected' }) })
        }, CONNECT_AFTER)
      }
    }, 5)
  }
  send() {}
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }) }
}

// ─── Environment ──────────────────────────────────────────────────────────────

let store

function installEnv() {
  store = new Map()
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  globalThis.sessionStorage = globalThis.localStorage
  globalThis.WebSocket = ScriptedWS
  globalThis.window = {
    location: { origin: 'http://localhost', pathname: '/', search: '' },
    addEventListener() {},
  }
  globalThis.document = {
    addEventListener() {}, querySelectorAll: () => [],
    body: { addEventListener() {}, querySelectorAll: () => [] },
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
}

const CONFIG = {
  url: 'ws://localhost:3001',
  tokenKey: 'junction_token',
  auth: { publicRoutes: ['/'], redirectTo: '/login/' },
}

/** Fresh module instance so _client state doesn't leak between tests. */
async function freshInitJunction() {
  const mod = await import('../src/junction/index.js?t=' + Math.random())
  return mod.initJunction
}

/** Fresh module instance, returning both entry points. */
async function freshModule() {
  return import('../src/junction/index.js?t=' + Math.random())
}

/** Advance fake time in steps until `flag()` is true; report where it settled. */
async function advanceUntil(flag, steps) {
  let advanced = 0
  for (const step of steps) {
    await vi.advanceTimersByTimeAsync(step - advanced)
    advanced = step
    if (flag()) break
  }
  return advanced
}

beforeEach(() => {
  sockets = []
  CONNECT_AFTER = 100
  installEnv()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete globalThis.WebSocket
  delete globalThis.window
  delete globalThis.document
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('initJunction does not block boot', () => {
  test('returns synchronously for a returning visitor', async () => {
    store.set('junction_token', 'stored-token')
    CONNECT_AFTER = Infinity          // server never replies — worst case

    const { initJunction } = await freshModule()
    const returned = initJunction(CONFIG)

    // Not a promise: nothing downstream can accidentally await it, and
    // virtual:sierra emits a bare call rather than `await`.
    expect(returned).toBeUndefined()
    // The socket is opening in the background regardless.
    expect(sockets).toHaveLength(1)
  })

  test('returns synchronously for a new visitor', async () => {
    const { initJunction } = await freshModule()
    expect(initJunction(CONFIG)).toBeUndefined()
    expect(sockets).toHaveLength(0)   // no token, nothing to connect
  })

  test('no junction config is a no-op', async () => {
    const { initJunction } = await freshModule()
    expect(initJunction(undefined)).toBeUndefined()
    expect(sockets).toHaveLength(0)
  })
})

describe('whenReady exposes the connection for callers that need it', () => {
  test('already resolved when there is no stored token', async () => {
    const mod = await freshModule()
    mod.initJunction(CONFIG)
    let done = false
    mod.whenReady.then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(done).toBe(true)
  })

  test('resolves when the server confirms the connection', async () => {
    store.set('junction_token', 'stored-token')
    CONNECT_AFTER = 100

    const mod = await freshModule()
    mod.initJunction(CONFIG)
    let done = false
    mod.whenReady.then(() => { done = true })

    const at = await advanceUntil(() => done, [50, 105, 300])
    expect(done).toBe(true)
    expect(at).toBeGreaterThanOrEqual(105)
    expect(at).toBeLessThan(300)
  })

  test('falls back to the 2s cap when the server never replies', async () => {
    store.set('junction_token', 'stored-token')
    CONNECT_AFTER = Infinity

    const mod = await freshModule()
    mod.initJunction(CONFIG)
    let done = false
    mod.whenReady.then(() => { done = true })

    await vi.advanceTimersByTimeAsync(1999)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(done).toBe(true)
  })
})

describe('setToken already opens the socket', () => {
  test('the explicit connect() call after setToken is a no-op', async () => {
    store.set('junction_token', 'stored-token')
    const initJunction = await freshInitJunction()
    const p = initJunction(CONFIG)
    await vi.advanceTimersByTimeAsync(200)
    await p

    // initJunction does `client.setToken(t)` and then `client.connect()`.
    // setToken opens a socket when one isn't already open; connect() returns
    // early if readyState < 2. Exactly one socket must exist.
    expect(sockets).toHaveLength(1)
  })
})
