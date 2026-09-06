/**
 * tests/public-routes.test.js — `auth.publicRoutes` is a list of EXCEPTIONS.
 *
 * The guard's public branch returns before `await sessionReady`, so a path that
 * matches skips the redirect and the boot restore both. The wildcard was a bare
 * `startsWith` on the prefix, which made `/blog*` cover `/blogadmin` and
 * `/blog-internal` — the wrong direction for a list whose whole purpose is
 * naming what is outside the guard. Invariant 6 caps what it costs: the Data
 * boundary refuses the same caller whatever this decides, so the harm is a page
 * that renders before the session is known rather than a bypass.
 *
 * Driven through the REAL router and a REAL junction client — the guard is
 * registered by `initJunction` and reached only by navigating. No server is
 * needed and none is faked: with no credential in storage `initSession`
 * resolves `sessionReady` without asking anybody, which is exactly the state a
 * stranger arrives in and the state the guard exists for. Only the browser is
 * stubbed, as every router test here stubs it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'

const DEAD = 'http://127.0.0.1:7929'   // nothing listens; nothing needs to

let _currentPath = '/'

function installEnv(initialPath) {
  _currentPath = initialPath
  const store = new Map()
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }
  globalThis.sessionStorage = globalThis.localStorage
  globalThis.WebSocket = class { constructor() { this.readyState = 0 } close() {} send() {} addEventListener() {} }
  globalThis.window = {
    history: {
      scrollRestoration: 'auto', state: { index: 0 },
      replaceState(st, _t, path) { if (path) _currentPath = path; this.state = { ...st } },
      pushState(st, _t, path) { if (path) _currentPath = path; this.state = { ...st } },
      back() {}, forward() {},
    },
    location: {
      origin: 'http://localhost',
      get pathname() { return _currentPath.split('?')[0] },
      get search() { return _currentPath.includes('?') ? '?' + _currentPath.split('?')[1] : '' },
    },
    scrollY: 0, scrollTo() {}, addEventListener() {},
  }
  globalThis.document = {
    addEventListener() {}, getElementById() { return null },
    querySelectorAll() { return [] },
    body: { querySelectorAll: () => [], addEventListener() {} },
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
}

function makeTree() {
  const leaf = (id, path) => ({
    id, path, file: `src/routes/${id}.mesa`,
    companion: null, layout: null, meta: {}, params: [], children: [],
  })
  return {
    id: 'root', path: '/', file: 'src/routes/index.mesa',
    companion: null, layout: null, meta: {}, params: [], children: [
      leaf('login',     '/login/'),
      leaf('blog',      '/blog/'),
      leaf('blogadmin', '/blogadmin/'),
      leaf('docs',      '/docs/'),
      leaf('docsa',     '/docs/a/'),
    ],
  }
}

function makeComponents(tree) {
  const map = {}
  ;(function walk(n) {
    if (n.file) map[n.id] = () => Promise.resolve({ default: function () {} })
    n.children?.forEach(walk)
  })(tree)
  return map
}

const settle = () => new Promise(r => setTimeout(r, 30))

/**
 * Boot the router at `path` with a live junction guard over `publicRoutes`, and
 * answer the route it landed on.
 *
 * `vi.resetModules()` is load-bearing: the router keeps its guard list in module
 * scope and never clears it, and `initJunction` returns no unsubscribe, so
 * without a fresh graph per boot the previous test's guard is still voting.
 */
async function bootAt(path, publicRoutes) {
  vi.resetModules()
  installEnv(path)

  const R = await import('../src/router/index.js')
  const J = await import('../src/junction/index.js')

  const tree = makeTree()
  R.initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, {})
  J.initJunction({ url: DEAD, auth: { publicRoutes, redirectTo: '/login/' } })
  await settle()
  return R.page.route?.id
}

afterEach(() => {
  delete globalThis.window
  delete globalThis.document
  delete globalThis.WebSocket
})

describe('a wildcard public route stops at a segment boundary', () => {
  test('the declared prefix is public', async () => {
    expect(await bootAt('/blog/', ['/login/', '/blog*'])).toBe('blog')
  })

  test('a route that merely SHARES the prefix is not', async () => {
    // `/blogadmin/` was public, and the guard returned true without ever
    // awaiting the boot restore.
    expect(await bootAt('/blogadmin/', ['/login/', '/blog*'])).toBe('login')
  })

  test('the base matches on its own, and so does what is under it', async () => {
    // The negative control for the row above: a rule that only ever matched a
    // deeper segment would refuse `/docs/` itself and pass that test too.
    expect(await bootAt('/docs/', ['/login/', '/docs*'])).toBe('docs')
    expect(await bootAt('/docs/a/', ['/login/', '/docs*'])).toBe('docsa')
  })

  test('a guarded route absent from the list still redirects', async () => {
    expect(await bootAt('/blog/', ['/login/'])).toBe('login')
  })
})

describe('the matcher, stated', () => {
  let isPublicRoute
  beforeEach(async () => {
    vi.resetModules()
    installEnv('/')
    ;({ isPublicRoute } = await import('../src/junction/index.js'))
  })

  test('a trailing * is a segment, not a string prefix', () => {
    expect(isPublicRoute('/blog*', '/blog')).toBe(true)
    expect(isPublicRoute('/blog*', '/blog/')).toBe(true)
    expect(isPublicRoute('/blog*', '/blog/post/1')).toBe(true)
    expect(isPublicRoute('/blog*', '/blogadmin')).toBe(false)
    expect(isPublicRoute('/blog*', '/blog-internal')).toBe(false)
  })

  test('a rule with no * is exact', () => {
    expect(isPublicRoute('/login', '/login')).toBe(true)
    expect(isPublicRoute('/login', '/login/')).toBe(false)
    expect(isPublicRoute('/login', '/login2')).toBe(false)
  })

  test('a bare * is every path, which is what it reads as', () => {
    expect(isPublicRoute('*', '/anything/at/all')).toBe(true)
  })
})
