/**
 * tests/layout-loading.test.js
 *
 * initRouter used to invoke every factory in the `layouts` map on boot, so every
 * layout chunk landed on the critical path regardless of route — including for
 * `reset: true` routes that render no layout at all. The stated reason was that
 * resolveChain() would otherwise see component === undefined on first visit.
 *
 * That is a sequencing problem, not a preloading one. _navigate() now awaits
 * loadLayoutChain() for the target route before committing, so the chain is
 * complete by the time page.route is set, and layouts a session never visits are
 * never fetched.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { initRouter, goto, page, _resetPage } from '../src/router/index.js'
import { resolveChain, _resetInternals } from '../src/router/internals.js'

let _currentPath = '/'

function installWindowMock(initialPath = '/') {
  _currentPath = initialPath
  globalThis.window = {
    history: {
      scrollRestoration: 'auto', state: { index: 0 },
      replaceState(st, _, path) { if (path) _currentPath = path; this.state = { ...st } },
      pushState(st, _, path) { if (path) _currentPath = path; this.state = { ...st } },
      back() {}, forward() {},
    },
    location: {
      get pathname() { return _currentPath.split('?')[0] },
      get search() { return _currentPath.includes('?') ? '?' + _currentPath.split('?')[1] : '' },
    },
    scrollY: 0, scrollTo() {}, addEventListener() {},
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.document = {
    addEventListener() {}, getElementById() { return null },
    querySelectorAll() { return [] },
    body: { querySelectorAll: () => [], addEventListener() {} },
  }
}

function teardownWindowMock() {
  delete globalThis.window
  delete globalThis.document
}

const ROOT  = 'src/routes/_module.mesa'
const LEADS = 'src/routes/leads/_module.mesa'
const DEEP  = 'src/routes/deep/_module.mesa'

function makeTree() {
  return {
    id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
    layout: ROOT, meta: {}, params: [], children: [
      {
        id: 'leads', path: '/leads/', file: 'src/routes/leads/index.mesa',
        companion: null, layout: LEADS, meta: {}, params: [], children: [
          {
            id: 'leads.[leadId]', path: '/leads/:leadId/',
            file: 'src/routes/leads/[leadId].mesa', companion: null,
            layout: LEADS, meta: { dynamic: true }, params: ['leadId'], children: [],
          },
        ],
      },
      {
        id: 'login', path: '/login/', file: 'src/routes/login/index.mesa',
        companion: null, layout: null, meta: {}, params: [], children: [],
      },
      {
        id: 'deep', path: '/deep/', file: 'src/routes/deep/index.mesa',
        companion: null, layout: DEEP, meta: {}, params: [], children: [],
      },
    ],
  }
}

let layoutLoads = []

function makeLayouts() {
  const mk = (path) => () => { layoutLoads.push(path); return Promise.resolve({ default() {} }) }
  return { [ROOT]: mk(ROOT), [LEADS]: mk(LEADS), [DEEP]: mk(DEEP) }
}

function makeComponents(tree) {
  const map = {}
  ;(function walk(n) {
    if (n.file) map[n.id] = () => Promise.resolve({ default() {} })
    n.children?.forEach(walk)
  })(tree)
  return map
}

const settle = () => new Promise(r => setTimeout(r, 15))

beforeEach(() => {
  layoutLoads = []
  // internals.js keeps its registries at module scope and nothing clears them
  // between initRouter calls — without this, a layout loaded by an earlier test
  // is still registered and the next test sees zero loads.
  _resetInternals()
  _resetPage()
  installWindowMock('/')
})
afterEach(teardownWindowMock)

describe('layouts load per route, not eagerly', () => {

  test('initRouter alone loads no layouts', async () => {
    const tree = makeTree()
    installWindowMock('/login/')          // reset: true — needs no layout
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, makeLayouts())
    await settle()
    expect(layoutLoads).toEqual([])
  })

  test('boot loads only the layouts the landing route needs', async () => {
    const tree = makeTree()
    installWindowMock('/leads/')
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, makeLayouts())
    await settle()

    expect(layoutLoads.sort()).toEqual([LEADS, ROOT].sort())
    expect(layoutLoads).not.toContain(DEEP)
  })

  test('navigating to a new section loads only that section layout', async () => {
    const tree = makeTree()
    installWindowMock('/')
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, makeLayouts())
    await settle()
    expect(layoutLoads).toEqual([ROOT])

    await goto('/deep/')
    await settle()
    expect(layoutLoads.sort()).toEqual([DEEP, ROOT].sort())
  })

  test('each layout is fetched at most once', async () => {
    const tree = makeTree()
    installWindowMock('/leads/')
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, makeLayouts())
    await settle()

    await goto('/leads/lead-1/')
    await settle()
    await goto('/leads/lead-2/')
    await settle()

    expect(layoutLoads.filter(p => p === LEADS)).toHaveLength(1)
    expect(layoutLoads.filter(p => p === ROOT)).toHaveLength(1)
  })
})

describe('the chain is complete before page.route commits', () => {

  test('resolveChain has a component for every depth on first visit', async () => {
    const tree = makeTree()
    installWindowMock('/')
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, makeLayouts())
    await settle()

    // First ever visit to /leads/ — its layout has not been loaded before now.
    await goto('/leads/')
    await settle()

    const chain = resolveChain(page.route)
    expect(chain.length).toBeGreaterThan(0)
    for (const entry of chain) {
      expect(entry.component).toBeTypeOf('function')
    }
  })

  test('a reset:true route resolves to a chain with no layouts', async () => {
    const tree = makeTree()
    installWindowMock('/')
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, makeLayouts())
    await settle()

    await goto('/login/')
    await settle()

    expect(page.route?.id).toBe('login')
    expect(resolveChain(page.route)).toHaveLength(1)
  })

  test('a failing layout does not make the route unreachable', async () => {
    const tree = makeTree()
    const layouts = makeLayouts()
    layouts[LEADS] = () => Promise.reject(new Error('boom'))
    installWindowMock('/')
    initRouter(tree, makeComponents(tree), {}, { trailingSlash: 'always' }, layouts)
    await settle()

    await goto('/leads/')
    await settle()

    // Navigation still commits; resolveChain omits the missing layout.
    expect(page.route?.id).toBe('leads')
  })
})
