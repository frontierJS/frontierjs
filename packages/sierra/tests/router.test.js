/**
 * tests/router.test.js — router tests
 *
 * Tests the pure functions: URL matching, param parsing, URL building.
 * Navigation engine tests require a browser and are integration-tested separately.
 */

import { describe, test, expect } from 'vitest'
import { matchRoute, normalizePath, buildUrl, parseQueryParams } from '../src/router/match.js'
import { signal, derived } from '../src/router/signals.js'

// ─── Fixture tree ─────────────────────────────────────────────────────────────

// Mirrors a real Sierra route tree for testing
const tree = {
  id: 'root',
  path: '/',
  file: 'src/routes/index.mesa',
  layout: null,
  meta: { title: 'Home' },
  params: [],
  children: [
    {
      id: 'leads',
      path: '/leads/',
      file: 'src/routes/leads/index.mesa',
      layout: 'src/routes/_module.mesa',
      meta: { title: 'Leads' },
      params: [],
      children: [
        {
          id: 'leads.create',
          path: '/leads/create/',
          file: 'src/routes/leads/create.mesa',
          layout: 'src/routes/leads/_module.mesa',
          meta: {},
          params: [],
          children: [],
        },
        {
          id: 'leads.[leadId]',
          path: '/leads/:leadId/',
          file: 'src/routes/leads/[leadId].mesa',
          layout: 'src/routes/leads/_module.mesa',
          meta: { dynamic: true },
          params: ['leadId'],
          children: [],
        },
      ],
    },
    {
      id: 'blog',
      path: '/blog/',
      file: 'src/routes/blog/index.mesa',
      layout: 'src/routes/_module.mesa',
      meta: { title: 'Blog' },
      params: [],
      children: [
        {
          id: 'blog.[slug]',
          path: '/blog/:slug/',
          file: 'src/routes/blog/[slug].mesa',
          layout: 'src/routes/_module.mesa',
          meta: { dynamic: true },
          params: ['slug'],
          children: [],
        },
      ],
    },
    {
      id: 'account.settings',
      path: '/account/settings/',
      file: 'src/routes/account/settings/index.mesa',
      layout: 'src/routes/_module.mesa',
      meta: {},
      params: [],
      children: [],
    },
    {
      id: '404',
      path: '/*',
      file: 'src/routes/[...404].mesa',
      layout: 'src/routes/_module.mesa',
      meta: { dynamic: true, spread: true },
      params: ['404'],
      children: [],
    },
  ],
}

// ─── normalizePath ────────────────────────────────────────────────────────────

describe('normalizePath', () => {
  test("'always' appends trailing slash", () => {
    expect(normalizePath('/leads', 'always')).toBe('/leads/')
    expect(normalizePath('/leads/', 'always')).toBe('/leads/')
    expect(normalizePath('/', 'always')).toBe('/')
  })

  test("'never' removes trailing slash", () => {
    expect(normalizePath('/leads/', 'never')).toBe('/leads')
    expect(normalizePath('/leads', 'never')).toBe('/leads')
    expect(normalizePath('/', 'never')).toBe('/')
  })

  test("'preserve' leaves path unchanged", () => {
    expect(normalizePath('/leads', 'preserve')).toBe('/leads')
    expect(normalizePath('/leads/', 'preserve')).toBe('/leads/')
  })

  test('strips query string and hash', () => {
    expect(normalizePath('/leads?page=1', 'always')).toBe('/leads/')
    expect(normalizePath('/leads#section', 'always')).toBe('/leads/')
    expect(normalizePath('/leads?page=1#top', 'always')).toBe('/leads/')
  })
})

// ─── matchRoute ──────────────────────────────────────────────────────────────

describe('matchRoute', () => {
  const opts = { trailingSlash: 'always' }

  test('matches root', () => {
    const result = matchRoute('/', tree, opts)
    expect(result).not.toBeNull()
    expect(result.node.id).toBe('root')
    expect(result.params).toEqual({})
  })

  test('matches static route', () => {
    const result = matchRoute('/leads/', tree, opts)
    expect(result).not.toBeNull()
    expect(result.node.id).toBe('leads')
    expect(result.params).toEqual({})
  })

  test('static beats dynamic — /leads/create matches create not [leadId]', () => {
    const result = matchRoute('/leads/create/', tree, opts)
    expect(result).not.toBeNull()
    expect(result.node.id).toBe('leads.create')
  })

  test('matches dynamic route and extracts param', () => {
    const result = matchRoute('/leads/abc123/', tree, opts)
    expect(result).not.toBeNull()
    expect(result.node.id).toBe('leads.[leadId]')
    expect(result.params.leadId).toBe('abc123')
  })

  test('matches nested dynamic route', () => {
    const result = matchRoute('/blog/my-post/', tree, opts)
    expect(result).not.toBeNull()
    expect(result.node.id).toBe('blog.[slug]')
    expect(result.params.slug).toBe('my-post')
  })

  test('matches deeply nested static route', () => {
    const result = matchRoute('/account/settings/', tree, opts)
    expect(result).not.toBeNull()
    expect(result.node.id).toBe('account.settings')
  })

  test('falls through to catch-all for unmatched paths', () => {
    const result = matchRoute('/totally-unknown/', tree, opts)
    expect(result).not.toBeNull()
    expect(result.node.id).toBe('404')
    expect(result.node.meta.spread).toBe(true)
  })

  test('URL-decodes param values', () => {
    const result = matchRoute('/leads/hello%20world/', tree, opts)
    expect(result.params.leadId).toBe('hello world')
  })

  test('returns null for completely invalid paths when no catch-all', () => {
    // Build a tree without catch-all
    const noFallback = { ...tree, children: tree.children.filter(c => c.id !== '404') }
    const result = matchRoute('/totally-unknown/', noFallback, opts)
    expect(result).toBeNull()
  })
})

// ─── parseQueryParams ────────────────────────────────────────────────────────

describe('parseQueryParams', () => {
  test('empty / missing', () => {
    expect(parseQueryParams('')).toEqual({})
    expect(parseQueryParams('?')).toEqual({})
    expect(parseQueryParams(null)).toEqual({})
  })

  test('coerces numbers', () => {
    const result = parseQueryParams('?page=2&limit=50')
    expect(result.page).toBe(2)
    expect(result.limit).toBe(50)
  })

  test('coerces booleans', () => {
    const result = parseQueryParams('?active=true&deleted=false')
    expect(result.active).toBe(true)
    expect(result.deleted).toBe(false)
  })

  test('preserves strings', () => {
    const result = parseQueryParams('?q=hello+world&sort=name')
    expect(result.q).toBe('hello world')
    expect(result.sort).toBe('name')
  })

  test('parses arrays with [] notation', () => {
    const result = parseQueryParams('?ids[]=1&ids[]=2&ids[]=3')
    expect(result.ids).toEqual([1, 2, 3])
  })

  test('parses nested objects with [key] notation', () => {
    const result = parseQueryParams('?filter[min]=10&filter[max]=100')
    expect(result.filter).toEqual({ min: 10, max: 100 })
  })

  test('handles leading ? or not', () => {
    const a = parseQueryParams('page=1')
    const b = parseQueryParams('?page=1')
    expect(a).toEqual(b)
  })
})

// ─── buildUrl ────────────────────────────────────────────────────────────────

describe('buildUrl', () => {
  test('path only', () => {
    expect(buildUrl('/leads', {}, 'always')).toBe('/leads/')
  })

  test('with query params', () => {
    const result = buildUrl('/leads', { page: 2, sort: 'name' }, 'always')
    expect(result).toContain('/leads/')
    expect(result).toContain('page=2')
    expect(result).toContain('sort=name')
  })

  test('omits null/undefined/empty params', () => {
    const result = buildUrl('/leads', { page: null, sort: undefined, q: '' }, 'always')
    expect(result).toBe('/leads/')
  })

  test('serializes arrays with [] notation', () => {
    const result = buildUrl('/leads', { ids: [1, 2, 3] }, 'always')
    expect(result).toContain('ids%5B%5D=1')
  })
})

// ─── signals ─────────────────────────────────────────────────────────────────

describe('signal', () => {
  test('holds initial value', () => {
    const s = signal(42)
    expect(s.get()).toBe(42)
    expect(s.value).toBe(42)
  })

  test('set updates value', () => {
    const s = signal(0)
    s.set(99)
    expect(s.get()).toBe(99)
  })

  test('subscribe receives current value immediately', () => {
    const s = signal('hello')
    let received
    s.subscribe(v => { received = v })
    expect(received).toBe('hello')
  })

  test('subscribe called on change', () => {
    const s = signal(0)
    const values = []
    s.subscribe(v => values.push(v))  // initial call
    s.set(1)
    s.set(2)
    expect(values).toEqual([0, 1, 2])
  })

  test('unsubscribe stops updates', () => {
    const s = signal(0)
    const values = []
    const unsub = s.subscribe(v => values.push(v))
    s.set(1)
    unsub()
    s.set(2)
    expect(values).toEqual([0, 1])
  })

  test('same value does not trigger subscribers', () => {
    const s = signal('x')
    let count = 0
    s.subscribe(() => count++)  // initial call → count=1
    s.set('x')  // same value — should not trigger
    expect(count).toBe(1)
  })
})

describe('derived', () => {
  test('computes from sources', () => {
    const a = signal(2)
    const b = signal(3)
    const sum = derived([a, b], (av, bv) => av + bv)
    expect(sum.get()).toBe(5)
    expect(sum.value).toBe(5)
  })

  test('updates when source changes', () => {
    const a = signal(1)
    const b = signal(2)
    const sum = derived([a, b], (av, bv) => av + bv)
    a.set(10)
    expect(sum.get()).toBe(12)
  })

  test('derived subscribe works', () => {
    const a = signal(1)
    const doubled = derived([a], av => av * 2)
    const values = []
    doubled.subscribe(v => values.push(v))
    a.set(5)
    a.set(10)
    expect(values).toEqual([2, 10, 20])
  })
})

// ─── findCatchAll (via load() error path) ─────────────────────────────────────

import { _findCatchAll } from '../src/router/index.js'

describe('catch-all discovery', () => {
  test('finds spread node in tree', () => {
    const tree = {
      id: 'root', path: '/', file: null, meta: {}, params: [], children: [
        { id: 'leads', path: '/leads/', file: 'leads.mesa', meta: {}, params: [], children: [] },
        { id: '404', path: '/*', file: '404.mesa', meta: { spread: true }, params: ['404'], children: [] },
      ]
    }
    const result = _findCatchAll(tree)
    expect(result.id).toBe('404')
    expect(result.meta.spread).toBe(true)
  })

  test('finds spread node nested inside children', () => {
    const tree = {
      id: 'root', path: '/', file: null, meta: {}, params: [], children: [
        {
          id: 'leads', path: '/leads/', file: 'leads.mesa', meta: {}, params: [], children: [
            { id: '404', path: '/*', file: '404.mesa', meta: { spread: true }, params: [], children: [] },
          ]
        },
      ]
    }
    expect(_findCatchAll(tree)?.id).toBe('404')
  })

  test('returns null when no catch-all exists', () => {
    const tree = {
      id: 'root', path: '/', file: null, meta: {}, params: [], children: [
        { id: 'leads', path: '/leads/', file: 'leads.mesa', meta: {}, params: [], children: [] },
      ]
    }
    expect(_findCatchAll(tree)).toBeNull()
  })

  test('returns null for empty tree', () => {
    const tree = { id: 'root', path: '/', file: null, meta: {}, params: [], children: [] }
    expect(_findCatchAll(tree)).toBeNull()
  })
})
