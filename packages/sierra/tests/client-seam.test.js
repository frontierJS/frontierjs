/**
 * tests/client-seam.test.js
 *
 * The three things Sierra tells the Junction client, and the one thing it hears
 * back — asserted against a REAL client and a REAL Junction app.
 *
 * That is the whole point of the file. Every defect graded here lived at a seam
 * whose existing test wrote its own junction client: `tests/session.test.js`
 * hand-writes a `hasCredential` accessor *including the `cookieAuth` term Sierra
 * never supplied*, so it drove `cookieAuth: true` through a client Sierra could
 * not construct and passed green for as long as the real thing was broken
 * (`FJS-787`). A stand-in encodes what the code under test wishes were on the
 * other side, so it can only ever agree with it.
 *
 *   · FJS-787 — cookie mode reaches the client, so the boot restore runs and
 *     sign-out reaches the server.
 *   · FJS-788 — the session Bearer goes to the app's own audience and nowhere
 *     else, and the token is read from the client rather than from storage.
 *   · FJS-812 — the client's staleness verdict reaches `status`.
 *
 * Every acceptance is PAIRED with the refusal of the same call one key
 * different: a fix that refused everything, or attached nothing anywhere, would
 * satisfy any assertion that only checked the refusal (`FJS-351`).
 *
 * The Junction app is a bun subprocess (`fixtures/client-seam-server.ts`)
 * because junction is Bun-only and this suite runs under node.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const API_PORT   = 7921   // the real junction app
const APP_PORT   = 7922   // "the app's own API", for the fetch audience tests
const THIRD_PORT = 7923   // a third party a load() might reach for

const API   = `http://127.0.0.1:${API_PORT}`
const APP   = `http://127.0.0.1:${APP_PORT}`
const THIRD = `http://127.0.0.1:${THIRD_PORT}`

// ─── The real junction app ───────────────────────────────────────────────────

let server

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`[client-seam] nothing answered ${url} within ${ms}ms`)
}

const hits      = () => fetch(`${API}/__hits`).then(r => r.json())
const resetHits = () => fetch(`${API}/__hits/reset`, { method: 'POST' })

beforeAll(async () => {
  server = spawn('bun', ['tests/fixtures/client-seam-server.ts', String(API_PORT)], {
    cwd: PKG, stdio: 'ignore',
  })
  await waitFor(`${API}/ping`)
}, 30000)

afterAll(() => { server?.kill() })

// ─── Environment ─────────────────────────────────────────────────────────────

/** A socket that never opens, so every call takes the client's HTTP path. */
class DeadSocket {
  static OPEN = 1
  constructor() { this.readyState = 0 }
  send() {}
  close() { this.readyState = 3 }
}

function installEnv() {
  const store = new Map()
  globalThis.localStorage = {
    getItem: k => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  }
  globalThis.sessionStorage = globalThis.localStorage
  globalThis.WebSocket = DeadSocket
  globalThis.window = { location: { origin: APP, pathname: '/', search: '' }, addEventListener() {} }
  globalThis.document = { addEventListener() {}, querySelectorAll: () => [] }
}

function clearEnv() {
  delete globalThis.localStorage
  delete globalThis.sessionStorage
  delete globalThis.WebSocket
  delete globalThis.window
  delete globalThis.document
}

/**
 * `initJunction` writes module state and `ready` resolves once, so a test that
 * boots the app needs its own instance of the module graph.
 */
async function freshJunction() {
  vi.resetModules()
  return import('../src/junction/index.js')
}

beforeEach(installEnv)
afterEach(() => { clearEnv(); vi.unstubAllEnvs() })

// ─── FJS-787 — cookie mode reaches the client ────────────────────────────────

describe('the credential mode Sierra hands the client', () => {

  test('cookieAuth:true makes the real client answer hasCredential', async () => {
    const J = await freshJunction()
    J.initJunction({ url: API, cookieAuth: true })
    // No token anywhere — the credential is a cookie no script can read.
    expect(J.getClient().token).toBeFalsy()
    expect(J.getClient().hasCredential).toBe(true)
  })

  test('and without it the same call answers false — the option is the only difference', async () => {
    const J = await freshJunction()
    J.initJunction({ url: API })
    expect(J.getClient().hasCredential).toBe(false)
  })

  test('so the boot restore asks the server, and the session comes back', async () => {
    await resetHits()
    const J = await freshJunction()
    J.initJunction({ url: API, cookieAuth: true })
    await J.ready

    expect(await hits()).toContain('GET /account/me')
    expect(J.session.user).toMatchObject({ userId: 'restored-person' })
    expect(J.session.level).toBe(4)
  })

  test('and a Bearer app with no token asks nothing, which is what makes the row above about cookieAuth', async () => {
    await resetHits()
    const J = await freshJunction()
    J.initJunction({ url: API })
    await J.ready

    expect(await hits()).not.toContain('GET /account/me')
    expect(J.session.user).toBeNull()
  })
})

describe('signing out reaches the server', () => {
  // junction's own gate, reached through the client Sierra builds. It read
  // `token`, so cookie mode never sent POST /auth/logout and still answered
  // { revoked: true } — the person is told the session was revoked while it
  // stays valid in the jar.

  async function signOutThrough(config, token = null) {
    await resetHits()
    const J = await freshJunction()
    J.initJunction(config)
    if (token) J.getClient().setToken(token)
    const result = await J.signOut()
    return { result, hits: await hits() }
  }

  test('in cookie mode', async () => {
    const { result, hits: h } = await signOutThrough({ url: API, cookieAuth: true })
    expect(h).toContain('POST /auth/logout')
    expect(result.revoked).toBe(true)
  })

  test('in Bearer mode', async () => {
    const { hits: h } = await signOutThrough({ url: API }, 'tok-A')
    expect(h).toContain('POST /auth/logout')
  })

  test('and not at all for a caller who was never signed in — the gate still refuses', async () => {
    const { hits: h } = await signOutThrough({ url: API })
    expect(h).not.toContain('POST /auth/logout')
  })
})

// ─── FJS-812 — the staleness verdict reaches `status` ────────────────────────

describe('a browser left open across a deploy', () => {
  // The app states build `server-2`. The whole x-fjs-build channel exists so a
  // bundle that is not that build can be told; it ended at Sierra, which passed
  // `build:` so `stale` could fire and then subscribed to nothing.

  test('is told, on `status.stale`, which build it is and which the server is', async () => {
    vi.stubEnv('VITE_FJS_BUILD', 'client-1')
    const J = await freshJunction()
    J.initJunction({ url: API })
    await J.getClient()._request('GET', '/ping')

    expect(J.status.stale).toEqual({ client: 'client-1', server: 'server-2' })
  })

  test('and a browser on the build the server is running is told nothing', async () => {
    vi.stubEnv('VITE_FJS_BUILD', 'server-2')
    const J = await freshJunction()
    J.initJunction({ url: API })
    await J.getClient()._request('GET', '/ping')

    expect(J.status.stale).toBeNull()
  })
})

// ─── FJS-788 — the fetch every load() is handed ──────────────────────────────

describe('the credential sierraFetch attaches has one audience', () => {
  // sierraFetch is what the router hands load() and what the prefetcher runs
  // loaders with. It attached the session Bearer with no reference to the
  // request's origin, so a page geocoding a postcode with the fetch the docs
  // tell it to use handed that vendor a replayable session.

  let app, third, seen, inits

  beforeAll(async () => {
    seen = {}
    const record = (label) => (req, res) => {
      seen[label] = req.headers.authorization ?? null
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }
    app   = createServer(record('app'))
    third = createServer(record('third'))
    await new Promise(r => app.listen(APP_PORT, '127.0.0.1', r))
    await new Promise(r => third.listen(THIRD_PORT, '127.0.0.1', r))
  })

  afterAll(() => { app?.close(); third?.close() })

  /** A real junction client pointed at the app, with a real token on it. */
  async function configured({ token = null, cookieAuth = false, baseUrl } = {}) {
    const { createJunctionClient, localTokenStore } =
      await import('@frontierjs/junction/client')
    const { configureFetch, sierraFetch } = await import('../src/fetch/index.js')

    const client = createJunctionClient({
      url: APP,
      tokenStorage: localTokenStore('junction_token'),
      cookieAuth,
    })
    if (token) client.setToken(token)

    inits = []
    const real = globalThis.fetch
    globalThis.fetch = (url, init) => { inits.push({ url: String(url), init }); return real(url, init) }

    configureFetch({ client, baseUrl })
    return { sierraFetch, client, restore: () => { globalThis.fetch = real } }
  }

  test('it goes to the app', async () => {
    const { sierraFetch, restore } = await configured({ token: 'SESSION-abc' })
    seen = {}
    await sierraFetch(`${APP}/orders`)
    restore()
    expect(seen.app).toBe('Bearer SESSION-abc')
  })

  test('and not to a third party — the same token, the same call, another origin', async () => {
    const { sierraFetch, restore } = await configured({ token: 'SESSION-abc' })
    seen = {}
    await sierraFetch(`${THIRD}/postcodes/SW1A1AA`)
    restore()
    expect(seen.third).toBeNull()
  })

  test('a relative path under the configured baseUrl still carries it, or every load() in every app is anonymous', async () => {
    const { sierraFetch, restore } = await configured({ token: 'SESSION-abc', baseUrl: APP })
    seen = {}
    // What a page actually writes: fetch('/orders'). The wrapper resolves it
    // against baseUrl, and baseUrl's origin is one of the three the credential
    // is for.
    await sierraFetch('/orders')
    restore()
    expect(seen.app).toBe('Bearer SESSION-abc')
  })

  test('and a baseUrl does not widen the audience — an absolute third-party URL is still refused', async () => {
    const { sierraFetch, restore } = await configured({ token: 'SESSION-abc', baseUrl: APP })
    seen = {}
    await sierraFetch(`${THIRD}/postcodes/SW1A1AA`)
    restore()
    expect(seen.third).toBeNull()
  })

  test('the token is the CLIENT\'s, not storage\'s', async () => {
    const { sierraFetch, client, restore } = await configured({ token: 'SESSION-abc' })
    // A second owner is how the two halves of "signed in" came to disagree:
    // rotate the token on its owner and leave storage holding the old one.
    client.setToken('SESSION-rotated')
    localStorage.setItem('junction_token', 'SESSION-abc')
    seen = {}
    await sierraFetch(`${APP}/orders`)
    restore()
    expect(seen.app).toBe('Bearer SESSION-rotated')
  })

  test('in cookie mode the request carries credentials, and only to our own audience', async () => {
    const { sierraFetch, restore } = await configured({ cookieAuth: true })
    await sierraFetch(`${APP}/orders`)
    await sierraFetch(`${THIRD}/anything`)
    restore()

    const mine    = inits.find(i => i.url.startsWith(APP))
    const foreign = inits.find(i => i.url.startsWith(THIRD))
    expect(mine.init.credentials).toBe('include')
    expect(foreign.init.credentials).toBeUndefined()
  })

  test('and a Bearer app sends no credentials at all', async () => {
    const { sierraFetch, restore } = await configured({ token: 'SESSION-abc' })
    await sierraFetch(`${APP}/orders`)
    restore()
    expect(inits.at(-1).init.credentials).toBeUndefined()
  })
})

// ─── FJS-786 — the call site for the live stores' half of a token change ─────

describe('a live store when the person at the machine changes', () => {
  // The mechanism is resource.js's; what is graded here is that `_tokenChanged`
  // CALLS it — the same hook that has dropped the prefetch cache since FJS-041,
  // for the same reason. A Resource is created once at import (Invariant 18), so
  // its store lives for the tab: on a shared machine the next person renders the
  // previous person's rows until their own load() resolves, and for ever on a
  // screen whose load() never runs.

  async function bootedWithAResource() {
    const J = await freshJunction()
    J.initJunction({ url: API })
    J.getClient().setToken('tok-A')
    const orders = J.createResource('order')
    orders.store.set([{ id: 1, secret: 'ALICE-PRIVATE-1' }])
    return { J, orders }
  }

  test('is emptied when the token changes', async () => {
    const { J, orders } = await bootedWithAResource()
    expect(orders.store.get()).toHaveLength(1)
    J.getClient().setToken(null)
    expect(orders.store.get()).toEqual([])
  })

  test('and is left alone while nobody signs out — a reset that fired on everything would pass the row above', async () => {
    const { orders } = await bootedWithAResource()
    expect(orders.store.get()).toHaveLength(1)
  })
})
