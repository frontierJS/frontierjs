/**
 * tests/navigation.test.js — navigation engine tests
 *
 * Tests initRouter, goto, beforeNavigate, afterNavigate, load() integration,
 * pageSlots clearing, meta-redirect, guard cancel/redirect, and signal commits.
 *
 * The router's browser-dependent code (window.history, scroll, click delegation,
 * popstate) is mocked via globalThis before each test. Navigation logic,
 * signal commits, and hook execution are fully testable in Node.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

// ─── Router imports ───────────────────────────────────────────────────────────
// Import signals and functions directly so we can observe state changes.
import {
  initRouter,
  goto,
  beforeNavigate,
  afterNavigate,
  setParams,
  updateParams,
  isActive,
  activeRoute,
  pendingRoute,
  params,
  meta,
  data,
  loadError,
  pageSlots,
  page,
  provideSlot,
  nodes,
} from '../src/router/index.js'

// ─── Fixture tree ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(__dirname, 'fixtures/basic-spa')

// Build a minimal hand-crafted tree mirroring the fixture structure
// (avoids async scan in beforeEach which would slow tests down)
function makeTree() {
  return {
    id: 'root',
    path: '/',
    file: 'src/routes/index.mesa',
    companion: null,
    layout: 'src/routes/_module.mesa',
    meta: { robots: 'index', title: 'Home' },
    params: [],
    children: [
      {
        id: 'blog',
        path: '/blog/',
        file: 'src/routes/blog/index.mesa',
        companion: null,
        layout: 'src/routes/_module.mesa',
        meta: { title: 'Blog' },
        params: [],
        children: [
          {
            id: 'blog.[slug]',
            path: '/blog/:slug/',
            file: 'src/routes/blog/[slug].mesa',
            companion: null,
            layout: 'src/routes/_module.mesa',
            meta: { title: 'Blog Post', dynamic: true },
            params: ['slug'],
            children: [],
          },
        ],
      },
      {
        id: 'leads',
        path: '/leads/',
        file: 'src/routes/leads/index.mesa',
        companion: null,
        layout: 'src/routes/leads/_module.mesa',
        meta: { title: 'Leads' },
        params: [],
        children: [
          {
            id: 'leads.[leadId]',
            path: '/leads/:leadId/',
            file: 'src/routes/leads/[leadId].mesa',
            companion: 'src/routes/leads/[leadId].meta.js',
            layout: 'src/routes/leads/_module.mesa',
            meta: { title: 'Lead Detail', dynamic: true },
            params: ['leadId'],
            children: [],
          },
        ],
      },
      {
        id: 'login',
        path: '/login/',
        file: 'src/routes/login/index.mesa',
        companion: null,
        layout: null,
        meta: { title: 'Login', reset: true },
        params: [],
        children: [],
      },
      {
        id: '[...404]',
        path: '/*',
        file: 'src/routes/[...404].mesa',
        companion: null,
        layout: 'src/routes/_module.mesa',
        meta: { title: 'Not Found', spread: true },
        params: ['404'],
        children: [],
      },
    ],
  }
}

// ─── Window mock ──────────────────────────────────────────────────────────────
// The navigation engine uses window.history and window.location.
// We install minimal mocks on globalThis before initRouter runs.

let _historyIndex = 0
let _currentPath = '/'
const _listeners = {}

function installWindowMock(initialPath = '/') {
  _currentPath = initialPath
  _historyIndex = 0

  globalThis.window = {
    history: {
      scrollRestoration: 'auto',
      state: { index: 0 },
      replaceState(state, _, path) {
        if (path) _currentPath = path
        this.state = { ...state }
      },
      pushState(state, _, path) {
        if (path) _currentPath = path
        _historyIndex++
        this.state = { ...state, index: _historyIndex }
      },
      back() {},
      forward() {},
    },
    location: {
      get pathname() { return _currentPath.split('?')[0] },
      get search()   { return _currentPath.includes('?') ? '?' + _currentPath.split('?')[1] : '' },
    },
    scrollY: 0,
    scrollTo() {},
    addEventListener(event, handler) {
      if (!_listeners[event]) _listeners[event] = []
      _listeners[event].push(handler)
    },
  }

  // Stub MutationObserver — prefetch.js uses it to watch for [prefetch] links.
  // In tests we don't need real DOM observation; a no-op is sufficient.
  globalThis.MutationObserver = class MutationObserver {
    constructor() {}
    observe() {}
    disconnect() {}
  }

  const bodyStub = {
    querySelectorAll() { return [] },
    addEventListener() {},
  }

  globalThis.document = {
    addEventListener() {},
    getElementById() { return null },
    querySelectorAll() { return [] },
    body: bodyStub,
  }
}

function teardownWindowMock() {
  delete globalThis.window
  delete globalThis.document
}

// ─── Component/loader factories ───────────────────────────────────────────────

function makeComponent(name) {
  return { default: function() {}, _name: name }
}

function makeComponents(tree) {
  const map = {}
  function walk(node) {
    if (node.file) map[node.id] = () => Promise.resolve(makeComponent(node.id))
    node.children?.forEach(walk)
  }
  walk(tree)
  return map
}

// ─── Helper: wait for async navigation to settle ─────────────────────────────

function waitForNav() {
  return new Promise(r => setTimeout(r, 0))
}

// ─── Reset router state between tests ────────────────────────────────────────
// The router module uses module-level state (_tree, _components, signals).
// We re-init before each test to get a clean baseline.

beforeEach(() => {
  installWindowMock('/')
  // Reset signals
  activeRoute.set(null)
  pendingRoute.set(null)
  params.set({})
  meta.set({})
  data.set(null)
  loadError.set(null)
  pageSlots.set({})
})

afterEach(() => {
  teardownWindowMock()
})

// ─── initRouter ───────────────────────────────────────────────────────────────

describe('initRouter', () => {
  test('sets nodes to the tree', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    // activeRoute is set during the initial _navigate() call, which is async
    expect(activeRoute.get()).not.toBeNull()
  })

  test('navigates to current URL on boot', async () => {
    installWindowMock('/leads/')
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    expect(activeRoute.get()?.id).toBe('leads')
  })

  test('sets params from boot URL', async () => {
    installWindowMock('/blog/hello-world/')
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    expect(params.get().slug).toBe('hello-world')
  })

  test('sets meta from matched route on boot', async () => {
    installWindowMock('/login/')
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    expect(meta.get().title).toBe('Login')
  })
})

// ─── goto ─────────────────────────────────────────────────────────────────────

describe('goto', () => {
  test('updates activeRoute signal', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/blog/')
    expect(activeRoute.get()?.id).toBe('blog')
  })

  test('updates params signal for dynamic route', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/blog/my-post/')
    expect(params.get().slug).toBe('my-post')
  })

  test('updates meta signal', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/login/')
    expect(meta.get().title).toBe('Login')
    expect(meta.get().reset).toBe(true)
  })

  test('sets pendingRoute during navigation then clears it', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    const pendingValues = []
    const unsub = pendingRoute.subscribe(v => pendingValues.push(v))
    await goto('/blog/')
    unsub()

    // Should have gone: null → context object → null
    const nonNulls = pendingValues.filter(v => v !== null)
    expect(nonNulls.length).toBeGreaterThan(0)
    expect(pendingRoute.get()).toBeNull()
  })

  test('with query params builds URL and sets them in params signal', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/blog/', { page: 2, q: 'hello' })
    expect(params.get().page).toBe(2)
    expect(params.get().q).toBe('hello')
  })

  test('clears pageSlots on navigation', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    // Simulate a page having provided a slot
    provideSlot('sidebar', function() {})
    expect(pageSlots.get().sidebar).toBeDefined()

    await goto('/blog/')
    expect(pageSlots.get()).toEqual({})
  })

  test('falls through to catch-all for unmatched path', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/does-not-exist/')
    expect(activeRoute.get()?.id).toBe('[...404]')
  })
})

// ─── beforeNavigate guards ────────────────────────────────────────────────────

describe('beforeNavigate', () => {
  test('guard can cancel navigation (return false)', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/')
    const routeBefore = activeRoute.get()?.id

    const unsub = beforeNavigate(() => false)
    await goto('/login/')
    unsub()

    expect(activeRoute.get()?.id).toBe(routeBefore)
  })

  test('guard can redirect (return path string)', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    // Redirect any nav to /login/ → always goes to /blog/ instead
    const unsub = beforeNavigate(({ to }) => {
      if (to.path === '/login/') return '/blog/'
    })
    await goto('/login/')
    unsub()

    expect(activeRoute.get()?.id).toBe('blog')
  })

  test('guard receives from and to context', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/')

    let capturedFrom, capturedTo
    const unsub = beforeNavigate(({ from, to }) => {
      capturedFrom = from
      capturedTo = to
    })
    await goto('/login/')
    unsub()

    expect(capturedFrom?.id).toBe('blog')
    expect(capturedTo.path).toBe('/login/')
  })

  test('guard returning undefined allows navigation', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    const unsub = beforeNavigate(() => undefined)
    await goto('/login/')
    unsub()

    expect(activeRoute.get()?.id).toBe('login')
  })

  test('guard returning true allows navigation', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    const unsub = beforeNavigate(() => true)
    await goto('/login/')
    unsub()

    expect(activeRoute.get()?.id).toBe('login')
  })

  test('unsubscribe removes the guard', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    const unsub = beforeNavigate(() => false)
    unsub() // remove immediately

    await goto('/login/')
    expect(activeRoute.get()?.id).toBe('login')
  })

  test('multiple guards all run in order', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    const order = []
    const u1 = beforeNavigate(() => { order.push(1) })
    const u2 = beforeNavigate(() => { order.push(2) })
    const u3 = beforeNavigate(() => { order.push(3) })
    await goto('/blog/')
    u1(); u2(); u3()

    expect(order).toEqual([1, 2, 3])
  })

  test('first cancelling guard stops subsequent guards from running', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/')

    const ran = []
    const u1 = beforeNavigate(() => { ran.push(1); return false })
    const u2 = beforeNavigate(() => { ran.push(2) })
    await goto('/login/')
    u1(); u2()

    expect(ran).toEqual([1])
    expect(activeRoute.get()?.id).toBe('blog')
  })
})

// ─── afterNavigate hooks ──────────────────────────────────────────────────────

describe('afterNavigate', () => {
  test('hook fires after navigation completes', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    const fired = []
    const unsub = afterNavigate(({ to }) => fired.push(to.path))
    await goto('/blog/')
    await goto('/login/')
    unsub()

    expect(fired).toContain('/blog/')
    expect(fired).toContain('/login/')
  })

  test('hook receives from and to context', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/')

    let capturedFrom, capturedTo
    const unsub = afterNavigate(({ from, to }) => {
      capturedFrom = from
      capturedTo = to
    })
    await goto('/login/')
    unsub()

    expect(capturedFrom?.id).toBe('blog')
    expect(capturedTo.path).toBe('/login/')
  })

  test('hook fires after activeRoute is already updated', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    let routeIdAtHookTime
    const unsub = afterNavigate(() => {
      routeIdAtHookTime = activeRoute.get()?.id
    })
    await goto('/login/')
    unsub()

    expect(routeIdAtHookTime).toBe('login')
  })

  test('unsubscribe removes the hook', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    const fired = []
    const unsub = afterNavigate(() => fired.push(true))
    unsub()
    await goto('/blog/')

    expect(fired).toHaveLength(0)
  })
})

// ─── load() integration ───────────────────────────────────────────────────────

describe('load() integration', () => {
  test('page signal merges meta + path + params on navigation', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/leads/')
    expect(page.get().path).toBe('/leads/')
    expect(page.get().params).toEqual({})

    await goto('/leads/42/')
    expect(page.get().path).toBe('/leads/42/')
    expect(page.get().params).toMatchObject({ leadId: '42' })
  })

  test('page signal contains route meta fields', async () => {
    const tree = makeTree()
    // Add meta to a route node
    const leadsNode = tree.children.find(n => n.id === 'leads')
    if (leadsNode) leadsNode.meta = { ...leadsNode.meta, section: 'CRM', icon: '👥' }

    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/leads/')
    expect(page.get().section).toBe('CRM')
    expect(page.get().icon).toBe('👥')
  })

    test('load() result is committed to data signal', async () => {
    const tree = makeTree()
    const loaders = {
      'leads.[leadId]': () => Promise.resolve({
        load: async ({ params }) => ({ lead: { id: params.leadId, name: 'Acme' } })
      })
    }
    initRouter(tree, makeComponents(tree), loaders, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/leads/lead-001/')
    expect(data.get()?.lead?.id).toBe('lead-001')
    expect(data.get()?.lead?.name).toBe('Acme')
  })

  test('load() receives params from URL', async () => {
    const tree = makeTree()
    let receivedParams
    const loaders = {
      'leads.[leadId]': () => Promise.resolve({
        load: async ({ params }) => { receivedParams = params; return {} }
      })
    }
    initRouter(tree, makeComponents(tree), loaders, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/leads/lead-abc/')
    expect(receivedParams.leadId).toBe('lead-abc')
  })

  test('load() can return a redirect string', async () => {
    const tree = makeTree()
    const loaders = {
      'leads.[leadId]': () => Promise.resolve({
        load: async () => '/blog/'  // redirect
      })
    }
    initRouter(tree, makeComponents(tree), loaders, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/leads/lead-001/')
    expect(activeRoute.get()?.id).toBe('blog')
  })

  test('routes without loaders leave data as null', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    data.set({ stale: true })  // simulate previous nav data

    await goto('/blog/')
    expect(data.get()).toBeNull()
  })

  test('failed load() sets loadError signal', async () => {
    const tree = makeTree()
    const err = new Error('API down')
    const loaders = {
      'leads.[leadId]': () => Promise.resolve({
        load: async () => { throw err }
      })
    }
    initRouter(tree, makeComponents(tree), loaders, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/leads/lead-001/')
    expect(loadError.get()).toBe(err)
  })

  test('failed load() stays on route and sets loadError (not redirected to 404)', async () => {
    // load() errors are data errors (not found, API failure) — the page handles
    // them via {#if loadError}. Sierra should NOT redirect to catch-all.
    const tree = makeTree()
    const err = new Error('Not found')
    const loaders = {
      'leads.[leadId]': () => Promise.resolve({
        load: async () => { throw err }
      })
    }
    initRouter(tree, makeComponents(tree), loaders, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/leads/lead-001/')
    // Stays on the matched route, not redirected to 404
    expect(activeRoute.get()?.id).toBe('leads.[leadId]')
    // loadError signal carries the error for the page to display
    expect(loadError.get()).toBe(err)
    // data is null when load() threw
    expect(data.get()).toBeNull()
  })

  test('successful load() clears loadError', async () => {
    const tree = makeTree()
    loadError.set(new Error('stale error'))

    const loaders = {
      'leads.[leadId]': () => Promise.resolve({
        load: async () => ({ lead: { id: 'x' } })
      })
    }
    initRouter(tree, makeComponents(tree), loaders, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/leads/lead-001/')
    expect(loadError.get()).toBeNull()
  })
})

// ─── meta redirect ────────────────────────────────────────────────────────────

describe('meta redirect', () => {
  test('route with meta.redirect navigates to target instead', async () => {
    const tree = makeTree()
    // Insert redirect route BEFORE the catch-all (which must stay last to avoid
    // swallowing the static route — the scanner guarantees this ordering).
    const catchAllIdx = tree.children.findIndex(c => c.id === '[...404]')
    tree.children.splice(catchAllIdx, 0, {
      id: 'old-blog',
      path: '/old-blog/',
      file: 'src/routes/old-blog.mesa',
      companion: null,
      layout: null,
      meta: { redirect: '/blog/' },
      params: [],
      children: [],
    })
    const components = makeComponents(tree)

    initRouter(tree, components, {}, { trailingSlash: 'always' })
    await waitForNav()

    await goto('/old-blog/')
    expect(activeRoute.get()?.id).toBe('blog')
  })
})

// ─── setParams / updateParams ─────────────────────────────────────────────────

describe('setParams / updateParams', () => {
  test('setParams replaces all query params', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/', { page: 1, q: 'old' })

    await setParams({ page: 2 })
    await waitForNav()
    expect(params.get().page).toBe(2)
    expect(params.get().q).toBeUndefined()
  })

  test('updateParams merges into current params', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/', { page: 1, q: 'hello' })

    await updateParams(cur => ({ ...cur, page: 2 }))
    await waitForNav()
    expect(params.get().page).toBe(2)
    expect(params.get().q).toBe('hello')
  })
})

// ─── isActive ─────────────────────────────────────────────────────────────────

describe('isActive', () => {
  test('returns true when current path starts with target', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/my-post/')

    expect(isActive('/blog/')).toBe(true)
  })

  test('returns false when path does not match', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/')

    expect(isActive('/leads/')).toBe(false)
  })

  test('exact: true requires full match', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    await goto('/blog/my-post/')

    expect(isActive('/blog/', { exact: true })).toBe(false)
    expect(isActive('/blog/my-post/', { exact: true })).toBe(true)
  })
})

// ─── pageSlots clearing on navigation ────────────────────────────────────────

describe('pageSlots lifecycle', () => {
  test('pageSlots is cleared when navigation commits', async () => {
    const tree = makeTree()
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()

    provideSlot('sidebar', function sidebar() {})
    provideSlot('toolbar', function toolbar() {})
    expect(Object.keys(pageSlots.get())).toHaveLength(2)

    await goto('/blog/')
    expect(pageSlots.get()).toEqual({})
  })

  test('pageSlots is cleared even when load() fails', async () => {
    const tree = makeTree()
    const loaders = {
      'leads.[leadId]': () => Promise.resolve({
        load: async () => { throw new Error('fail') }
      })
    }
    initRouter(tree, makeComponents(tree), loaders, { trailingSlash: 'always' })
    await waitForNav()

    provideSlot('sidebar', function() {})
    await goto('/leads/lead-001/')
    expect(pageSlots.get()).toEqual({})
  })

  test('provideSlot within same nav cycle accumulates slots', () => {
    pageSlots.set({})
    const fn1 = function a() {}
    const fn2 = function b() {}
    provideSlot('a', fn1)
    provideSlot('b', fn2)
    const slots = pageSlots.get()
    expect(slots.a).toBe(fn1)
    expect(slots.b).toBe(fn2)
  })
})

// ─── Layout component map helper ─────────────────────────────────────────────
// Simulates the layouts map that generate-manifest now produces.

function makeLayouts(tree) {
  const layoutPaths = new Set()
  function walk(node) {
    if (node.layout) layoutPaths.add(node.layout)
    node.children?.forEach(walk)
  }
  walk(tree)
  const map = {}
  for (const p of layoutPaths) {
    map[p] = () => Promise.resolve({
      default: function LayoutComponent() {},
      _layoutPath: p,
    })
  }
  return map
}

// ─── Layout eager loading ─────────────────────────────────────────────────────

describe('layouts eager loading', () => {
  test('layout components are registered after initRouter with layouts map', async () => {
    const tree = makeTree()
    const layouts = makeLayouts(tree)
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, layouts)
    // Wait for all layout promises to resolve
    await new Promise(r => setTimeout(r, 20))

    const { resolveChain, getComponents } = await import('../src/router/internals.js')
    // Navigate to a route that uses the root layout
    await goto('/blog/')
    const chain = resolveChain(activeRoute.get())
    // Chain should have 2 entries: layout + page
    expect(chain.length).toBe(2)
    // Layout entry (index 0, not last) should have a component function
    expect(typeof chain[0].component).toBe('function')
    // Page entry (index 1, last) should also have a component
    expect(typeof chain[1].component).toBe('function')
  })

  test('initRouter without layouts argument still works (backward compat)', async () => {
    const tree = makeTree()
    // No layouts argument — defaults to {}
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' })
    await waitForNav()
    expect(activeRoute.get()?.id).toBe('root')
  })

  test('layouts map with empty object does not throw', async () => {
    const tree = makeTree()
    expect(() => {
      initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, {})
    }).not.toThrow()
  })
})
