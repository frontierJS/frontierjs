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
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

// ─── The server ─────────────────────────────────────────────────────────────

const ROWS = [
  { id: 1, number: 'INV-1', status: 'paid',  total: 100 },
  { id: 2, number: 'INV-2', status: 'open',  total: 200 },
  { id: 3, number: 'INV-3', status: 'open',  total: 300 },
]

let sent = []        // one URLSearchParams per list read
let failNext = false
let total = ROWS.length
// What a service whose `find()` includes a relation answers: the row PLUS a
// key no push carries.
let includes = false
let extra    = null   // keys laid over every row, for the shapes an include is not
let delayMs  = 0

const original = globalThis.fetch
globalThis.fetch = (async (url, init) => {
  const u = new URL(String(url))
  if ((init?.method ?? 'GET') !== 'GET') return json({})
  sent.push(u.searchParams)
  if (delayMs) await new Promise(r => setTimeout(r, delayMs))
  if (failNext) {
    failNext = false
    return new Response(JSON.stringify({ message: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
  let data = includes ? ROWS.map(r => ({ ...r, customer: { id: 9, name: 'Acme' } })) : ROWS
  if (extra) data = data.map(r => ({ ...r, ...extra }))
  const one = u.pathname.match(/^\/invoices\/(\d+)$/)
  if (one) return json(data.find(r => r.id === Number(one[1])))
  return json({ kind: 'list', object: 'invoices', data, errors: [], total, limit: 20, offset: 0 })
})

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

let client
vi.mock('@frontierjs/sierra/junction', () => ({ getClient: () => client }))
const { createResource } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')
const { generateSchemas }  = await import('../src/build/schema-plugin.js')

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
  includes = false
  extra = null
  delayMs = 0
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
  // Through the build's own schema step, because what reaches the browser is a
  // create table plus the read and update patches — a hand-registered `full`
  // document hands every column a control and leaves summary() nothing to say.
  async function build(source) {
    const dir  = mkdtempSync(join(tmpdir(), 'sierra-list-'))
    const file = join(dir, 'schema.lite')
    writeFileSync(file, source)
    const g = await generateSchemas(file, () => {}, SIERRA_ROOT)
    registerSchemas(g.defs, g.models, g.updatePatch, g.readPatch)
  }
  const SOURCE = `
    model Invoice {
      id       Int       @id
      number   String
      status   String
      total    Int
      memo     String?
    }
  `

  test('columns() takes the file\'s set, and a call naming its own replaces it', async () => {
    await build(SOURCE)
    const invoices = createResource('invoices', { model: 'Invoice', columns: { only: ['number', 'total'] } })

    expect(invoices.columns().columns.map(c => c.name)).toEqual(['number', 'total'])
    expect(invoices.columns({ only: ['status'] }).columns.map(c => c.name)).toEqual(['status'])
    // A detail screen's summary is not a table and does not take its set: the
    // key is read-only, so it is a summary column, and the file's table set
    // does not name it.
    expect(invoices.summary().columns.map(c => c.name)).toContain('id')
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

// ─── A composed list ────────────────────────────────────────────────────────

describe('composed: the rows carry what a push does not', () => {
  // What the socket delivers when somebody patches INV-2: the row, and nothing
  // that hangs off it.
  const push = (event = 'patched') =>
    client.service('invoices').emit(event, { id: 2, number: 'INV-2', status: 'paid', total: 200 })

  test('a push re-reads the window and the relation survives it; a store-backed list loses it', async () => {
    await boot('/invoices/')
    includes = true

    const plain = track(invoicesResource().list({ state: 'local' }))
    await settle()
    expect(plain.rows[1].customer).toEqual({ id: 9, name: 'Acme' })
    push()
    await settle()
    // The control: the hazard is real, or the composed row below proves nothing.
    const inv2 = plain.rows.find(r => r.id === 2)
    expect(inv2.status).toBe('paid')
    expect(inv2.customer).toBeUndefined()

    const list = track(invoicesResource().list({ state: 'local', composed: true }))
    await settle()
    const before = sent.length
    push()
    await settle()
    expect(sent.length).toBe(before + 1)
    expect(list.rows.find(r => r.id === 2).customer).toEqual({ id: 9, name: 'Acme' })
  })

  test('its rows never enter the store, so another list over the model is not handed them', async () => {
    await boot('/invoices/')
    includes = true
    const invoices = invoicesResource()
    const list = track(invoices.list({ state: 'local', composed: true }))
    await settle()
    expect(list.rows).toHaveLength(3)
    expect(invoices.store.get()).toEqual([])

    track(invoices.list({ state: 'local' }))
    await settle()
    expect(invoices.store.get()).toHaveLength(3)

    // Nor does it START on the store's rows: those carry no relation, and would
    // show until the first read answered.
    expect(track(invoices.list({ state: 'local', composed: true })).rows).toEqual([])
  })

  test('a burst of pushes during a read is ONE more read, not one each', async () => {
    await boot('/invoices/')
    const list = track(invoicesResource().list({ state: 'local', composed: true }))
    await settle()
    delayMs = 20
    const before = sent.length

    push(); await settle()
    push(); push(); push('removed')
    await new Promise(r => setTimeout(r, 80))
    await settle()

    expect(sent.length).toBe(before + 2)
    expect(list.loading).toBe(false)
  })

  test('growing the window widens the limit and re-reads from the top', async () => {
    await boot('/invoices/')
    total = 10
    const list = track(invoicesResource().list({ state: 'local', composed: true }))
    await settle()
    expect(list.hasMore).toBe(true)

    await list.more()
    await settle()
    expect(last().get('$limit')).toBe('23')
    expect(last().get('$after')).toBe(null)

    // A change of state is a new question and starts from its own limit.
    list.apply({ status: 'open' }, list.directives)
    await settle()
    expect(last().get('$limit')).toBe(null)
  })

  test('a reconnect re-reads; a list that is not composed leaves that to the store', async () => {
    await boot('/invoices/')
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const list = track(invoicesResource().list({ state: 'local', composed: true }))
    await settle()
    const before = sent.length

    client.emit('resync', { downMs: 10 })
    await settle()
    expect(sent.length).toBe(before + 1)

    list.destroy()
    client.emit('resync', { downMs: 10 })
    push()
    await settle()
    expect(sent.length).toBe(before + 1)
    vi.restoreAllMocks()
  })
})

// ─── Telling an author who forgot the flag ─────────────────────────────────

describe('a read that answered more than the row, on a view that is not composed', () => {
  // The schema reaches the browser through the build's own step, because the
  // question is what the MODEL declares — and `createdAt` is in no mode that
  // step emits, which is the row that keeps the check from warning on everything.
  async function build() {
    const dir  = mkdtempSync(join(tmpdir(), 'sierra-composed-'))
    const file = join(dir, 'schema.lite')
    writeFileSync(file, `
      model Customer {
        id    Int    @id
        name  String
      }
      model Invoice {
        id          Int       @id
        number      String
        status      String
        total       Int
        customerId  Int?
        customer    Customer? @relation(fields: [customerId], references: [id])
        createdAt   DateTime  @default(now())
      }
    `)
    const g = await generateSchemas(file, () => {}, SIERRA_ROOT)
    registerSchemas(g.defs, g.models, g.updatePatch, g.readPatch)
  }
  const warnings = () => warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('composed: true'))
  let warn
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => warn.mockRestore())

  test('an include on a plain list is named, once, with the flag that fixes it', async () => {
    await build()
    await boot('/invoices/')
    includes = true
    const invoices = createResource('invoices', { model: 'Invoice' })
    const list = track(invoices.list({ state: 'local' }))
    await settle()
    list.reload()
    await settle()

    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain("'customer'")
    expect(warnings()[0]).toContain('list({ composed: true })')
  })

  test('the same read declared composed, and a plain read with no include, say nothing', async () => {
    await build()
    await boot('/invoices/')
    includes = true
    track(createResource('invoices', { model: 'Invoice' }).list({ state: 'local', composed: true }))
    await settle()
    includes = false
    // `createdAt` is undeclared in every emitted mode and must not read as composed.
    ROWS.forEach(r => { r.createdAt = '2026-09-12T00:00:00.000Z' })
    try {
      track(createResource('invoices', { model: 'Invoice' }).list({ state: 'local' }))
      await settle()
    } finally {
      ROWS.forEach(r => { delete r.createdAt })
    }
    expect(warnings()).toEqual([])
  })

  test('both shapes are named: a relation left null, and a child list no relation declares', async () => {
    await build()
    await boot('/invoices/')
    // An optional include that found nothing is still an include.
    extra = { customer: null }
    track(createResource('invoices', { model: 'Invoice' }).list({ state: 'local' }))
    await settle()
    expect(warnings().at(-1)).toContain("'customer'")

    extra = { lines: [{ sku: 'A' }] }
    track(createResource('invoices', { model: 'Invoice' }).list({ state: 'local' }))
    await settle()
    expect(warnings()).toHaveLength(2)
    expect(warnings().at(-1)).toContain("'lines'")
  })

  test('record() asks the same question of its first read', async () => {
    await build()
    await boot('/invoices/')
    includes = true
    const invoices = createResource('invoices', { model: 'Invoice' })
    await invoices.record(2).ready
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain('record(id, { composed: true })')

    await createResource('invoices', { model: 'Invoice' }).record(3, { composed: true }).ready
    expect(warnings()).toHaveLength(1)
  })
})

afterAll(() => { globalThis.fetch = original })
