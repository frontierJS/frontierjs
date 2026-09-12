/**
 * tests/resource-list.test.js — `resource.list()`, driven by a real navigation
 *
 * A list is five wirings a page used to restate: the store, where the filters
 * live, the load, its re-run, and the window. Every claim here is about one of
 * those going wrong in SILENCE, which is the only way they go wrong: a list that
 * forgot to re-run shows the previous rows, a default filter that reached every
 * `find()` narrows a picker, and a list re-asked with the next route's filters
 * reads as a flicker nobody reports.
 *
 * So the router is the REAL one over a window mock, and the client is
 * Junction's real one over a fetch that records the query string it was sent —
 * a hand-built fake would agree with whatever `list.js` sends. Every refusal is
 * paired with the same call one step away still working, because a list that
 * never reloaded satisfies every row asserting it did not reload.
 */

import { describe, test, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createJunctionClient } from '../../junction/src/client/index.ts'
import { setRenderEnvironment, flushSync } from '@frontierjs/mesa/runtime'
import { initRouter, goto, page, _resetPage } from '../src/router/index.js'

// ─── The server ─────────────────────────────────────────────────────────────

const ROWS = [
  { id: 1, number: 'INV-1', status: 'paid',  total: 100 },
  { id: 2, number: 'INV-2', status: 'open',  total: 200 },
  { id: 3, number: 'INV-3', status: 'open',  total: 300 },
]

let sent = []        // one URLSearchParams per list read
let failNext = false
let total = ROWS.length

const original = globalThis.fetch
globalThis.fetch = (async (url, init) => {
  const u = new URL(String(url))
  if ((init?.method ?? 'GET') !== 'GET') return json({})
  sent.push(u.searchParams)
  if (failNext) {
    failNext = false
    return new Response(JSON.stringify({ message: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
  return json({ kind: 'list', object: 'invoices', data: ROWS, errors: [], total, limit: 20, offset: 0 })
})

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let client
vi.mock('@frontierjs/sierra/junction', () => ({ getClient: () => client }))
const { createResource } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

// ─── The router ─────────────────────────────────────────────────────────────

const TREE = {
  id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
  layout: null, meta: {}, params: [], children: [
    { id: 'invoices', path: '/invoices/', file: 'src/routes/invoices/index.mesa',
      companion: null, layout: null, meta: {}, params: [], children: [] },
    { id: 'orders', path: '/orders/', file: 'src/routes/orders/index.mesa',
      companion: null, layout: null, meta: {}, params: [], children: [] },
  ],
}
const components = () => ({
  root:     () => Promise.resolve({ default() {} }),
  invoices: () => Promise.resolve({ default() {} }),
  orders:   () => Promise.resolve({ default() {} }),
})

let path = '/'
function installWindowMock(initial) {
  path = initial
  globalThis.window = {
    history: {
      scrollRestoration: 'auto',
      state: { index: 0 },
      entries: 0,
      replaceState(state, _, p) { if (p) path = p; this.state = { ...state } },
      pushState(state, _, p)    { if (p) path = p; this.entries++; this.state = { ...state } },
    },
    location: {
      get pathname() { return path.split('?')[0] },
      get search()   { return path.includes('?') ? '?' + path.split('?')[1] : '' },
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

// A load is a fetch and a store write, several microtasks deep.
const settle = async () => {
  for (let i = 0; i < 5; i++) { flushSync(); await new Promise(r => setTimeout(r, 0)) }
  flushSync()
}

async function boot(url) {
  installWindowMock(url)
  initRouter(TREE, components(), {}, { trailingSlash: 'always' })
  await settle()
}

const invoicesResource = (opts = {}) => createResource('invoices', {
  model: null,
  listQuery: { directives: { orderBy: '-issuedAt' } },
  ...opts,
})

const last = () => sent[sent.length - 1]
const lists = []
const track = (l) => { lists.push(l); return l }

beforeEach(() => {
  setRenderEnvironment(true)
  _resetPage()
  client = createJunctionClient({ url: 'http://localhost:3000' })
  sent = []
  failNext = false
  total = ROWS.length
})

afterEach(() => {
  while (lists.length) lists.pop().destroy()
  delete globalThis.window
  delete globalThis.document
})

// ─── Where the state lives: the URL ─────────────────────────────────────────

describe("state: 'url' — the address bar is the list", () => {
  test('loads what the URL says, over the resource file\'s default order', async () => {
    await boot('/invoices/?status=open')
    const list = track(invoicesResource().list())
    await settle()

    expect(last().get('status')).toBe('open')
    expect(last().get('$orderBy')).toBe('-issuedAt')
    expect(list.rows.map(r => r.id)).toEqual([1, 2, 3])
    expect(list.query).toEqual({ status: 'open' })
    expect(list.directives).toEqual({ orderBy: '-issuedAt' })
  })

  test('a URL ordering beats the declared one, key for key', async () => {
    await boot('/invoices/?$orderBy=number&$limit=5')
    track(invoicesResource().list())
    await settle()

    expect(last().get('$orderBy')).toBe('number')
    expect(last().get('$limit')).toBe('5')
  })

  test('a navigation on its own route re-runs the load with the new filters', async () => {
    await boot('/invoices/')
    track(invoicesResource().list())
    await settle()
    const before = sent.length

    await goto('/invoices/', { status: 'paid' })
    await settle()

    expect(sent.length).toBe(before + 1)
    expect(last().get('status')).toBe('paid')
  })

  test('apply NAVIGATES — the change arrives back through the router', async () => {
    await boot('/invoices/')
    const list = track(invoicesResource().list())
    await settle()

    await list.apply({ status: 'open' }, { orderBy: 'number' })
    await settle()

    expect(path).toContain('status=open')
    expect(path).toContain('$orderBy=number')
    expect(page.query).toEqual({ status: 'open' })
    expect(last().get('status')).toBe('open')
    expect(last().get('$orderBy')).toBe('number')
  })

  test('a navigation AWAY does not re-ask with the next route\'s filters', async () => {
    await boot('/invoices/')
    track(invoicesResource().list())
    await settle()
    const before = sent.length

    await goto('/orders/', { customerId: 9 })
    await settle()

    expect(sent.length).toBe(before)
  })
})

// ─── Where the state lives: here ────────────────────────────────────────────

describe("state: 'local' — embedded, and must not navigate", () => {
  test('apply changes the list and leaves the address bar alone', async () => {
    await boot('/invoices/?status=paid')
    const list = track(invoicesResource().list({ state: 'local' }))
    await settle()
    // The URL's filter belongs to the page, not to an embedded list.
    expect(last().get('status')).toBe(null)

    list.apply({ status: 'open' }, list.directives)
    await settle()

    expect(last().get('status')).toBe('open')
    expect(list.query).toEqual({ status: 'open' })
    expect(path).toBe('/invoices/?status=paid')
  })

  test('`where` is applied over the filters and is never part of `query`', async () => {
    await boot('/invoices/')
    const list = track(invoicesResource().list({ state: 'local', where: { customerId: 7 } }))
    await settle()
    expect(last().get('customerId')).toBe('7')
    expect(list.query).toEqual({})

    // A bar handing back the scope's key cannot widen it.
    list.apply({ customerId: 8, status: 'open' }, list.directives)
    await settle()

    expect(last().get('customerId')).toBe('7')
    expect(last().get('status')).toBe('open')
  })

  test('an unknown state is refused by name rather than read as local', async () => {
    await boot('/invoices/')
    expect(() => invoicesResource().list({ state: 'session' })).toThrow(/state must be 'url' or 'local'/)
  })
})

// ─── The halves a bar and a table hand back ─────────────────────────────────

describe('apply and sort', () => {
  test('clearing the search removes it — each half REPLACES', async () => {
    await boot('/invoices/')
    const list = track(invoicesResource().list({ state: 'local', debounce: 0 }))
    await settle()

    list.apply({}, { ...list.directives, search: 'acme' })
    await settle()
    expect(last().get('$search')).toBe('acme')

    // What `<FilterBar>` emits when the box is emptied: the key left out.
    const { search, ...rest } = list.directives
    list.apply({}, rest)
    await settle()
    expect(last().get('$search')).toBe(null)
    expect(last().get('$orderBy')).toBe('-issuedAt')
  })

  test('sort lays one ordering over the directives and keeps the rest', async () => {
    await boot('/invoices/')
    const list = track(invoicesResource().list({ state: 'local', directives: { limit: 5 } }))
    await settle()

    list.sort('-total')
    await settle()

    expect(last().get('$orderBy')).toBe('-total')
    expect(last().get('$limit')).toBe('5')
  })

  test('a search alone waits for the typing to stop; a filter goes at once', async () => {
    await boot('/invoices/')
    const list = track(invoicesResource().list({ state: 'local', debounce: 40 }))
    await settle()
    const before = sent.length

    list.apply({}, { ...list.directives, search: 'a' })
    list.apply({}, { ...list.directives, search: 'ac' })
    await settle()
    expect(sent.length).toBe(before)

    await new Promise(r => setTimeout(r, 60))
    await settle()
    expect(sent.length).toBe(before + 1)
    expect(last().get('$search')).toBe('ac')

    list.apply({ status: 'open' }, list.directives)
    await settle()
    expect(sent.length).toBe(before + 2)
  })

  test('in the URL, a debounced search REPLACES the entry; a filter pushes one', async () => {
    await boot('/invoices/')
    const list = track(invoicesResource().list({ debounce: 10 }))
    await settle()
    const pushed = window.history.entries

    list.apply({}, { ...list.directives, search: 'acme' })
    await new Promise(r => setTimeout(r, 30))
    await settle()
    expect(path).toContain('search=acme')
    expect(window.history.entries).toBe(pushed)

    await list.apply({ status: 'open' }, list.directives)
    await settle()
    expect(window.history.entries).toBe(pushed + 1)
  })
})

// ─── The resource file's defaults ───────────────────────────────────────────

describe('listQuery reaches list() and nothing else', () => {
  test('a bare load() does not read it — list() does', async () => {
    await boot('/invoices/')
    const invoices = invoicesResource({ listQuery: { query: { status: 'open' }, directives: { orderBy: '-issuedAt' } } })

    await invoices.load({})
    expect(last().get('status')).toBe(null)
    expect(last().get('$orderBy')).toBe(null)

    track(invoices.list({ state: 'local' }))
    await settle()
    expect(last().get('status')).toBe('open')
    expect(last().get('$orderBy')).toBe('-issuedAt')
  })

  test('a URL carrying a DIFFERENT filter does not also carry the default', async () => {
    // Merged under the URL key for key, a default filter could never be cleared
    // from a bar — clearing removes a key and the default puts it back.
    await boot('/invoices/?customerId=3')
    const invoices = invoicesResource({ listQuery: { query: { status: 'open' } } })
    track(invoices.list())
    await settle()
    expect(last().get('customerId')).toBe('3')
    expect(last().get('status')).toBe(null)
  })

  test('its filters apply while the URL carries none, and yield to the URL\'s', async () => {
    await boot('/invoices/?status=paid')
    const invoices = invoicesResource({ listQuery: { query: { status: 'open' } } })
    track(invoices.list())
    await settle()
    expect(last().get('status')).toBe('paid')

    await goto('/invoices/', {})
    await settle()
    expect(last().get('status')).toBe('open')
  })
})

describe('columns: in the resource file', () => {
  const { schema } = parse(`
    model Invoice {
      id       Int    @id
      number   String
      status   String
      total    Int
      memo     String?
    }
  `)
  const defs = generateJsonSchema(schema, { mode: 'full' }).$defs

  test('columns() takes the file\'s set, and a call naming its own replaces it', () => {
    registerSchemas(defs, ['Invoice'])
    const invoices = createResource('invoices', { model: 'Invoice', columns: { only: ['number', 'total'] } })

    expect(invoices.columns().columns.map(c => c.name)).toEqual(['number', 'total'])
    expect(invoices.columns({ only: ['status'] }).columns.map(c => c.name)).toEqual(['status'])
    // The control: the same model with nothing declared ranks on its own.
    expect(createResource('invoices', { model: 'Invoice' }).columns().columns.map(c => c.name))
      .not.toEqual(['number', 'total'])
  })
})

// ─── The window, and what can go wrong ──────────────────────────────────────

describe('loading, error, the window, teardown', () => {
  test('hasMore answers the server\'s count, and a full page says no', async () => {
    await boot('/invoices/')
    total = 10
    const list = track(invoicesResource().list({ state: 'local' }))
    await settle()
    expect(list.hasMore).toBe(true)

    total = ROWS.length
    list.reload()
    await settle()
    expect(list.hasMore).toBe(false)
  })

  test('a failed load is reported on `error` and clears on the next good one', async () => {
    await boot('/invoices/')
    failNext = true
    const list = track(invoicesResource().list({ state: 'local' }))
    await settle()
    expect(list.error).toBeTruthy()
    expect(list.loading).toBe(false)

    list.reload()
    await settle()
    expect(list.error).toBe(null)
  })

  test('destroy stops the list answering a navigation', async () => {
    await boot('/invoices/')
    const list = invoicesResource().list()
    await settle()
    list.destroy()
    const before = sent.length

    await goto('/invoices/', { status: 'paid' })
    await settle()
    expect(sent.length).toBe(before)
  })
})

afterAll(() => { globalThis.fetch = original })
