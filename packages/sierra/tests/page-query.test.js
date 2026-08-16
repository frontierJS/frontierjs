/**
 * tests/page-query.test.js — the URL's search string, on `page`
 *
 * It was reachable only by calling `parseQueryParams(window.location.search)` by
 * hand, so a filtered or paginated list could not be URL-driven without wiring
 * it per page — and what the router DID put on `page.params` was the search
 * params merged into the path captures, one value with two homes and nothing
 * saying which kind it was (`FJS-083`).
 *
 * The split is the API realm's own, over the same table: `query` is the filters,
 * `directives` is `{ limit, offset, orderBy, select, … }`, and the `$` that
 * tells them apart is transport syntax that reaches neither (repo Invariant 10).
 * That is what makes `resource.load(page.query, page.directives)` a whole
 * URL-driven list with nothing to translate.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { initRouter, goto, setParams, page, _resetPage } from '../src/router/index.js'
import { PAGE_RESERVED } from '../src/router/page-fields.js'
import { RESERVED_PARAMS } from '@frontierjs/toolbelt/directives'

// ─── Fixture ──────────────────────────────────────────────────────────────────

const TREE = {
  id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
  layout: null, meta: {}, params: [], children: [
    {
      id: 'orders', path: '/orders/', file: 'src/routes/orders/index.mesa',
      companion: null, layout: null, meta: {}, params: [], children: [
        {
          id: 'orders.[id]', path: '/orders/:id/', file: 'src/routes/orders/[id].mesa',
          companion: null, layout: null, meta: {}, params: ['id'], children: [],
        },
      ],
    },
  ],
}

const components = () => ({
  root: () => Promise.resolve({ default() {} }),
  orders: () => Promise.resolve({ default() {} }),
  'orders.[id]': () => Promise.resolve({ default() {} }),
})

let _path = '/'

function installWindowMock(initial = '/') {
  _path = initial
  globalThis.window = {
    history: {
      scrollRestoration: 'auto',
      state: { index: 0 },
      replaceState(state, _, p) { if (p) _path = p; this.state = { ...state } },
      pushState(state, _, p)    { if (p) _path = p; this.state = { ...state } },
    },
    location: {
      get pathname() { return _path.split('?')[0] },
      get search()   { return _path.includes('?') ? '?' + _path.split('?')[1] : '' },
    },
    scrollY: 0,
    scrollTo() {},
    addEventListener() {},
  }
  globalThis.document = {
    addEventListener() {}, getElementById: () => null, querySelectorAll: () => [],
    body: { addEventListener() {}, querySelectorAll: () => [] },
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
}

const settle = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => { installWindowMock('/'); _resetPage() })
afterEach(() => { delete globalThis.window; delete globalThis.document })

// ─── The split ────────────────────────────────────────────────────────────────

describe('the search string is filters and directives', () => {
  test('filters land on page.query, coerced', async () => {
    installWindowMock('/orders/?status=active&tier=3&open=true')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()

    expect(page.query).toEqual({ status: 'active', tier: 3, open: true })
  })

  test('`$` params land on page.directives, structured', async () => {
    installWindowMock('/orders/?$limit=20&$offset=40&$orderBy=-createdAt')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()

    expect(page.directives).toEqual({ limit: 20, offset: 40, orderBy: '-createdAt' })
  })

  test('neither half ever contains a `$` — it is transport syntax', async () => {
    installWindowMock('/orders/?status=active&$limit=20')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()

    expect(page.query).toEqual({ status: 'active' })
    expect(Object.keys(page.query).some(k => k.startsWith('$'))).toBe(false)
    expect(Object.keys(page.directives).some(k => k.startsWith('$'))).toBe(false)
  })

  test('the two are ready to be a call, with nothing to translate', async () => {
    installWindowMock('/orders/?status=active&$limit=20&$orderBy=-createdAt')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()

    // resource.load(query, params) takes exactly this pair.
    expect([page.query, page.directives]).toEqual([
      { status: 'active' },
      { limit: 20, orderBy: '-createdAt' },
    ])
  })

  test('it reads the same table the API boundary strips by', () => {
    // One grammar, two boundaries. A directive named in one and not the other
    // becomes a filter on a column nobody declared.
    expect([...RESERVED_PARAMS]).toContain('$limit')
    expect([...RESERVED_PARAMS]).toContain('$populate')
  })
})

describe('params is path captures, and only those', () => {
  test('a route param is on params, a search param is not', async () => {
    installWindowMock('/orders/7/?status=active')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()

    expect(page.params).toEqual({ id: '7' })
    expect(page.query).toEqual({ status: 'active' })
  })

  test('a search param cannot shadow a path capture any more', async () => {
    // Both used to be spread into one object, search params last — so
    // `?id=99` on `/orders/7/` silently answered 99 to `page.params.id`.
    installWindowMock('/orders/7/?id=99')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()

    expect(page.params.id).toBe('7')
    expect(page.query.id).toBe(99)
  })
})

// ─── Reactivity ───────────────────────────────────────────────────────────────

describe('a navigation that did not change the search does not replace it', () => {
  test('same search → same object; different search → a new one', async () => {
    installWindowMock('/orders/?status=active')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()
    const first = page.query

    // A layout outlives a navigation, so a filter bar watching `page.query`
    // would re-ask the server on every navigation under it if a fresh object
    // arrived each time.
    await goto('/orders/7/', { status: 'active' })
    await settle()
    expect(page.query).toBe(first)

    await setParams({ status: 'draft' })
    await settle()
    expect(page.query).not.toBe(first)
    expect(page.query).toEqual({ status: 'draft' })
  })

  test('leaving the search behind empties it', async () => {
    installWindowMock('/orders/?status=active')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()
    expect(page.query).toEqual({ status: 'active' })

    await goto('/orders/7/')
    await settle()
    expect(page.query).toEqual({})
  })
})

// ─── The reserved list ────────────────────────────────────────────────────────

describe('both names are the router\'s', () => {
  test('frontmatter cannot claim them', () => {
    // The scanner warns on a route declaring one of these; without the entry a
    // page's `query:` frontmatter would be overwritten on every navigation with
    // nothing said.
    expect(PAGE_RESERVED).toContain('query')
    expect(PAGE_RESERVED).toContain('directives')
  })

  test('_resetPage clears them', async () => {
    installWindowMock('/orders/?status=active')
    initRouter(TREE, components(), {}, { trailingSlash: 'always' })
    await settle()
    _resetPage()
    expect(page.query).toEqual({})
    expect(page.directives).toEqual({})
  })
})
