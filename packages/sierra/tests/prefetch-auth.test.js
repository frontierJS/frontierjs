/**
 * tests/prefetch-auth.test.js
 *
 * A prefetch asks the server a question on the user's behalf, so it has to ask
 * as the user. It did not: `runPrefetch` handed load() `window.fetch`, while the
 * router hands a navigated load() `sierraFetch`, which attaches the session
 * token. The request therefore went out signed-out and came back refused — and
 * the refusal was CACHED, then served on the navigation that followed, so
 * hovering a link could make the page you then visited render as signed-out
 * (`FJS-041`).
 *
 * The second half is the one a token alone does not fix: a payload is an answer
 * to *what may this person see*, so it cannot outlive the identity that asked
 * for it. Signing in, signing out and a mid-session 401 all drop it.
 *
 * The component chunks are deliberately NOT dropped — a route's JavaScript is
 * the same file whoever asks — and asserting that is what stops the fix being
 * "clear everything", which would throw away the half of prefetch that was never
 * wrong.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  prefetchHref, initPrefetch, invalidatePrefetch,
  _prefetchCache, _resetPrefetch,
} from '../src/router/prefetch.js'
import { sierraFetch, configureFetch } from '../src/fetch/index.js'

// ─── Fixture ──────────────────────────────────────────────────────────────────

const TREE = {
  id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
  layout: null, meta: {}, params: [], children: [
    {
      id: 'orders', path: '/orders/', file: 'src/routes/orders/index.mesa',
      companion: 'src/routes/orders/index.meta.js',
      layout: null, meta: {}, params: [], children: [],
    },
  ],
}

let seen          // what load() was handed, call by call
let chunkImports
let requests      // every request sierraFetch actually made

function makeLoaders() {
  return {
    orders: () => Promise.resolve({
      load: async (ctx) => {
        seen.push(ctx)
        const res = await ctx.fetch('/api/orders')
        return { status: res.status }
      },
    }),
  }
}

function installDom() {
  globalThis.window = {
    location: { origin: 'http://localhost', pathname: '/', search: '' },
    addEventListener() {},
    // Deliberately distinguishable from the global: if prefetch reaches for
    // window.fetch again, the request never reaches `requests`.
    fetch: () => Promise.resolve(new Response('{}', { status: 401 })),
  }
  globalThis.document = {
    addEventListener() {},
    querySelectorAll() { return [] },
    body: { addEventListener() {}, querySelectorAll: () => [] },
  }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.requestIdleCallback = (fn) => setTimeout(fn, 0)
  globalThis.localStorage = {
    _v: {},
    getItem(k) { return this._v[k] ?? null },
    setItem(k, v) { this._v[k] = String(v) },
    removeItem(k) { delete this._v[k] },
  }
}

const settle = () => new Promise(r => setTimeout(r, 5))

beforeEach(() => {
  seen = []
  chunkImports = []
  requests = []
  installDom()

  globalThis.fetch = async (url, init) => {
    requests.push({ url, headers: new Headers(init?.headers ?? {}) })
    const authed = new Headers(init?.headers ?? {}).has('Authorization')
    return new Response('{}', { status: authed ? 200 : 401 })
  }
  configureFetch({ tokenKey: 'junction_token' })

  _resetPrefetch()
  initPrefetch(
    TREE,
    { orders: () => { chunkImports.push('orders'); return Promise.resolve({ default() {} }) } },
    makeLoaders(),
    { trailingSlash: 'always' },
  )
})

afterEach(() => {
  _resetPrefetch()
  vi.useRealTimers()
  delete globalThis.window
  delete globalThis.document
  delete globalThis.localStorage
})

describe('a prefetched load() asks as the signed-in user', () => {
  test('it is handed the same fetch a navigated load() is', async () => {
    await prefetchHref('http://localhost/orders/')
    await settle()
    // The router passes `sierraFetch` (router/index.js). Anything else here is
    // a second fetch path, which is how the two came to disagree.
    expect(seen[0].fetch).toBe(sierraFetch)
  })

  test('the session token is attached', async () => {
    localStorage.setItem('junction_token', 'tok-1')
    await prefetchHref('http://localhost/orders/')
    await settle()

    expect(requests).toHaveLength(1)
    expect(requests[0].headers.get('Authorization')).toBe('Bearer tok-1')
    expect(_prefetchCache.get('orders:/orders/').value).toEqual({ status: 200 })
  })

  test('signed out it is refused, exactly as the navigation would be', async () => {
    await prefetchHref('http://localhost/orders/')
    await settle()
    // Not a bug — the point is that prefetch and navigation now agree. What
    // must not happen is this answer surviving a sign-in, which is next.
    expect(_prefetchCache.get('orders:/orders/').value).toEqual({ status: 401 })
  })
})

describe('a payload does not outlive the identity that asked for it', () => {
  test('invalidating drops the payload and lets the URL be asked again', async () => {
    await prefetchHref('http://localhost/orders/')
    await settle()
    expect(_prefetchCache.size).toBe(1)

    invalidatePrefetch()
    expect(_prefetchCache.size).toBe(0)

    // The per-URL gate has to go with it, or the same URL can never be
    // prefetched again this session and the cache stays empty for good.
    localStorage.setItem('junction_token', 'tok-1')
    await prefetchHref('http://localhost/orders/')
    await settle()
    expect(seen).toHaveLength(2)
    expect(_prefetchCache.get('orders:/orders/').value).toEqual({ status: 200 })
  })

  test('the component chunk is kept — a route\'s JavaScript is nobody\'s in particular', async () => {
    await prefetchHref('http://localhost/orders/')
    await settle()
    invalidatePrefetch()
    await prefetchHref('http://localhost/orders/')
    await settle()
    expect(chunkImports).toEqual(['orders'])
  })

  // Signing in and out used to be sierra's own login(token)/logout(), which is
  // where the invalidation hung. Both are gone: the client owns the token now,
  // and this hangs off its 'token' event — so it covers every way the identity
  // can change, including client.auth.signIn() and a 401 clearing it, which the
  // old pair could not see.
  test('a change of identity on the client invalidates', async () => {
    globalThis.WebSocket = class { constructor() { this.readyState = 0 } close() {} send() {} }
    const { initJunction, getClient } = await import('../src/junction/index.js')

    initJunction({ url: 'http://localhost:8110' })
    const client = getClient()

    await prefetchHref('http://localhost/orders/')
    await settle()
    expect(_prefetchCache.size).toBe(1)

    client.setToken('tok-1')
    expect(_prefetchCache.size).toBe(0)

    await prefetchHref('http://localhost/orders/')
    await settle()
    expect(_prefetchCache.size).toBe(1)

    client.setToken(null)
    expect(_prefetchCache.size).toBe(0)
  })
})
