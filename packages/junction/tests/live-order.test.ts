/**
 * tests/live-order.test.ts — a pushed row has a POSITION, and a page has an end
 *
 * `FJS-011` made the store answer *is this row in the query*. This is the other
 * half (`FJS-270`): where the row goes, and what to do when the list cannot say.
 *
 *   • ordered list  → sorted insertion, and a patch that moves a sort key moves
 *                     the row. It used to append, so a list loaded
 *                     `orderBy: '-createdAt'` received new rows at the BOTTOM.
 *   • first page    → the overflow row genuinely belongs to page 2, so trimming
 *                     is correct. It used to grow past its own limit.
 *   • past page 1   → nothing can know whether a new row belongs here without
 *                     asking, so it is refused and COUNTED. A guess produces a
 *                     list that is quietly wrong past the fold.
 *
 * The comparator is asserted against SQLite's ordering, not JavaScript's: NULLs
 * first ascending, numbers before text, Booleans as the 0/1 they are stored as.
 * A list ordered one way on the server and another in the browser is the same
 * class of defect as the filter leak, one field along.
 */

import { describe, it, expect } from 'bun:test'
import { createJunctionClient, Store, type QueryDirectives } from '../src/client/index.ts'
import { RESERVED_PARAMS, DIRECTIVE_PARAMS } from '@frontierjs/toolbelt/directives'
import { normalizeOrderBy, comparatorFor, compareValues } from '../src/core/sort.ts'

// ─── the shared reading of orderBy ────────────────────────────────────────────

describe('normalizeOrderBy', () => {
  it('reads the three spellings the wire carries', () => {
    expect(normalizeOrderBy('name')).toEqual([{ name: 'asc' }])
    expect(normalizeOrderBy('-createdAt')).toEqual([{ createdAt: 'desc' }])
    expect(normalizeOrderBy('status,-createdAt')).toEqual([{ status: 'asc' }, { createdAt: 'desc' }])
    expect(normalizeOrderBy({ createdAt: 'desc' })).toEqual([{ createdAt: 'desc' }])
    expect(normalizeOrderBy({ a: 1, b: -1 })).toEqual([{ a: 'asc' }, { b: 'desc' }])
    expect(normalizeOrderBy([{ a: 'asc' }])).toEqual([{ a: 'asc' }])
  })

  it('is the same function the server parses a query with', async () => {
    // parseSort in core/litestone.ts IS this — one reading of `-createdAt`, or
    // the browser sorts a list differently from the query that filled it.
    const mod = await import('../src/core/litestone.ts')
    expect(typeof mod.parseQuery).toBe('function')
    expect(mod.parseQuery({}, 20, 100, { orderBy: '-createdAt' }).orderBy)
      .toEqual(normalizeOrderBy('-createdAt'))
  })
})

describe('compareValues follows SQLite, not JavaScript', () => {
  it('NULL sorts before everything, so ascending puts it first', () => {
    expect(compareValues(null, 0)).toBeLessThan(0)
    expect(compareValues(null, 'a')).toBeLessThan(0)
    expect(compareValues(null, null)).toBe(0)
  })

  it('numbers sort before text', () => {
    expect(compareValues(9, '1')).toBeLessThan(0)
  })

  it('numbers compare numerically — 10 after 9, which string order gets wrong', () => {
    expect(compareValues(9, 10)).toBeLessThan(0)
  })

  it('a Boolean compares as the 0/1 it is stored as', () => {
    expect(compareValues(false, true)).toBeLessThan(0)
    expect(compareValues(true, 0)).toBeGreaterThan(0)
  })

  it('ISO-8601 text compares as text, which is the comparison the column gets', () => {
    expect(compareValues('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z')).toBeLessThan(0)
  })
})

describe('comparatorFor', () => {
  it('is null when there is nothing to order by — leave the list alone', () => {
    expect(comparatorFor(undefined)).toBeNull()
    expect(comparatorFor(null)).toBeNull()
    expect(comparatorFor([])).toBeNull()
  })

  it('falls through to the next key', () => {
    const cmp = comparatorFor('status,-score')!
    expect(cmp({ status: 'a', score: 1 }, { status: 'b', score: 9 })).toBeLessThan(0)
    expect(cmp({ status: 'a', score: 1 }, { status: 'a', score: 9 })).toBeGreaterThan(0)
    expect(cmp({ status: 'a', score: 1 }, { status: 'a', score: 1 })).toBe(0)
  })

  it('descending puts NULLs last, as SQLite does', () => {
    const cmp = comparatorFor('-score')!
    expect(cmp({ score: 1 }, { score: null })).toBeLessThan(0)
  })
})

// ─── Store.place ──────────────────────────────────────────────────────────────

describe('Store.place', () => {
  const byId = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    (a.id as number) - (b.id as number)

  it('inserts at its sorted position, not at the end', () => {
    const s = new Store([{ id: 1 }, { id: 3 }])
    s.place({ id: 2 }, 'id', byId)
    expect(s.get().map(r => r.id)).toEqual([1, 2, 3])
  })

  it('MOVES a row whose sort key changed', () => {
    const byN = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      (a.n as number) - (b.n as number)
    const s = new Store([{ id: 1, n: 1 }, { id: 2, n: 2 }, { id: 3, n: 3 }])
    s.place({ id: 2, n: 9 }, 'id', byN)
    expect(s.get().map(r => r.id)).toEqual([1, 3, 2])
    expect(s.get()).toHaveLength(3)   // moved, not duplicated
  })

  it('trims the tail when told to, in one notification', () => {
    const s = new Store([{ id: 2 }, { id: 3 }])
    const seen: number[] = []
    s.subscribe(rows => seen.push(rows.length))
    s.place({ id: 1 }, 'id', byId, 2)
    expect(s.get().map(r => r.id)).toEqual([1, 2])
    expect(seen).toEqual([2, 2])   // the initial emit, then one for the place
  })

  it('refuses a record with no id, like upsert', () => {
    const s = new Store<Record<string, unknown>>([{ id: 1 }])
    s.place({ name: 'x' }, 'id', byId)
    expect(s.get()).toEqual([{ id: 1 }])
  })
})

// ─── the live list ────────────────────────────────────────────────────────────

function mockList(rows: unknown[], meta: Record<string, unknown> = {}) {
  const original = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ kind: 'list', object: 'items', data: rows, errors: [], total: rows.length, ...meta }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )) as unknown as typeof fetch
  return { restore: () => { globalThis.fetch = original } }
}

const client = () => createJunctionClient({ url: 'http://localhost:3000' })

describe('a live list keeps its order', () => {
  it('a created row lands where it sorts, not at the bottom', async () => {
    const { restore } = mockList([{ id: 3, n: 3 }, { id: 1, n: 1 }], { limit: 20, offset: 0, total: 2 })
    const { service, store, load } = client().resource('items')
    await load({}, { orderBy: '-n' })
    restore()

    service._receive('created', { id: 2, n: 2 })
    expect(store.get().map(r => r.n)).toEqual([3, 2, 1])
  })

  it('a patch that changes the sort key moves the row', async () => {
    const { restore } = mockList([{ id: 1, n: 1 }, { id: 2, n: 2 }], { limit: 20, offset: 0, total: 2 })
    const { service, store, load } = client().resource('items')
    await load({}, { orderBy: 'n' })
    restore()

    service._receive('patched', { id: 1, n: 9 })
    expect(store.get().map(r => r.id)).toEqual([2, 1])
  })

  it('with no orderBy the row is appended and nothing is reordered', async () => {
    const { restore } = mockList([{ id: 3 }, { id: 1 }], { limit: 20, offset: 0, total: 2 })
    const { service, store, load } = client().resource('items')
    await load()
    restore()

    service._receive('created', { id: 2 })
    expect(store.get().map(r => r.id)).toEqual([3, 1, 2])
  })
})

describe('a live list keeps its page', () => {
  it('the first page stays its own length, and the overflow row is page 2', async () => {
    const { restore } = mockList([{ id: 1, n: 1 }, { id: 2, n: 2 }], { limit: 2, offset: 0, total: 5 })
    const { service, store, load, stale } = client().resource('items')
    await load({}, { orderBy: 'n' })
    restore()

    service._receive('created', { id: 0, n: 0 })
    expect(store.get().map(r => r.n)).toEqual([0, 1])
    // Not stale: the first `limit` rows in order IS page 1, exactly.
    expect(stale.get()).toBe(0)
  })

  it('past page 1 a new row is refused and counted, not guessed at', async () => {
    const { restore } = mockList([{ id: 5, n: 5 }, { id: 6, n: 6 }], { limit: 2, offset: 4, total: 9 })
    const { service, store, load, stale } = client().resource('items')
    await load({}, { orderBy: 'n', limit: 2, offset: 4 })
    restore()

    service._receive('created', { id: 0, n: 0 })
    expect(store.get().map(r => r.n)).toEqual([5, 6])
    expect(stale.get()).toBe(1)
  })

  it('a row already on a later page is still updated in place', async () => {
    const { restore } = mockList([{ id: 5, n: 5 }, { id: 6, n: 6 }], { limit: 2, offset: 4, total: 9 })
    const { service, store, load, stale } = client().resource('items')
    await load({}, { orderBy: 'n', limit: 2, offset: 4 })
    restore()

    service._receive('patched', { id: 5, n: 5, name: 'edited' })
    expect(store.get()[0]).toEqual({ id: 5, n: 5, name: 'edited' })
    expect(stale.get()).toBe(0)
  })

  it('a removal from a list with more rows behind it leaves a gap only the server can fill', async () => {
    const { restore } = mockList([{ id: 1 }, { id: 2 }], { limit: 2, offset: 0, total: 7 })
    const { service, store, load, stale } = client().resource('items')
    await load()
    restore()

    service._receive('removed', { id: 1 })
    expect(store.get().map(r => r.id)).toEqual([2])
    expect(stale.get()).toBe(1)
  })

  it('a removal from a list that IS everything leaves no gap', async () => {
    const { restore } = mockList([{ id: 1 }, { id: 2 }], { limit: 20, offset: 0, total: 2 })
    const { service, store, load, stale } = client().resource('items')
    await load()
    restore()

    service._receive('removed', { id: 1 })
    expect(stale.get()).toBe(0)
  })

  it('an unordered list that outgrows its page says so rather than dropping a row at random', async () => {
    const { restore } = mockList([{ id: 1 }, { id: 2 }], { limit: 2, offset: 0, total: 2 })
    const { service, store, load, stale } = client().resource('items')
    await load()
    restore()

    service._receive('created', { id: 3 })
    expect(store.get()).toHaveLength(3)   // the row the user just made is not thrown away
    expect(stale.get()).toBe(1)
  })

  it('load() clears it — that answer is current by definition', async () => {
    const { restore } = mockList([{ id: 1 }, { id: 2 }], { limit: 2, offset: 0, total: 7 })
    const { service, load, stale } = client().resource('items')
    await load()
    service._receive('removed', { id: 1 })
    expect(stale.get()).toBe(1)

    await load()
    expect(stale.get()).toBe(0)
    restore()
  })

  it('subscribers hear the count, in the shape a store has', async () => {
    const { restore } = mockList([{ id: 1 }], { limit: 1, offset: 0, total: 4 })
    const { service, load, stale } = client().resource('items')
    await load()
    restore()

    const seen: number[] = []
    stale.subscribe(n => seen.push(n))
    service._receive('removed', { id: 1 })
    expect(seen).toEqual([0, 1])
  })
})

// ─── the `$` table, both directions ───────────────────────────────────────────
// The bridge STRIPS `$` names (`@frontierjs/toolbelt/directives`); this client
// WRITES them, on two paths that share nothing downstream (`buildQueryString`
// for HTTP, `buildWsQuery` for the socket). Two properties to hold, and they
// fail differently:
//
//   • every name emitted is a name stripped — a directive missing from the
//     table lands in the WHERE clause as a column nobody declared, and the Data
//     boundary reports it as a filter typo three layers from the cause;
//   • every directive DECLARED is a directive emitted — the quieter half, and
//     the one that was broken. `FindParams` named five of the eight, so
//     `$search`, `$withDeleted` and `$onlyDeleted` had a server that read them,
//     a URL grammar that carried them, and no way for a caller to ask
//     (`FJS-290`). An app whose `.lite` declares `@@softDelete` got a restore
//     flow it could not build a list screen for.
//
// The second is asserted against DIRECTIVE_PARAMS rather than a hand-written
// list, so a directive added to the grammar and not to the client fails here.

describe('every directive the client sends is one the bridge strips', () => {
  // All eight, and filters are the FIRST argument — they are not a directive
  // and the container no longer pretends otherwise.
  const ALL: QueryDirectives = {
    limit: 10, offset: 20, orderBy: '-createdAt', select: ['a', 'b'], populate: 'customer',
    search: 'acme', withDeleted: true, onlyDeleted: false,
    withTemplates: true, onlyTemplates: false,
  }
  const FILTERS = { status: 'active' }

  it('over HTTP', async () => {
    let asked = ''
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      asked = String(url)
      return new Response(JSON.stringify({ kind: 'list', object: 'items', data: [], total: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch

    await client().service('items').find(FILTERS, ALL)
    globalThis.fetch = original

    const params = new URL(asked).searchParams
    const sent = [...params.keys()].filter(k => k.startsWith('$'))
    for (const k of sent) expect([...RESERVED_PARAMS]).toContain(k)
    // Every directive with a structured form reaches the wire.
    for (const k of DIRECTIVE_PARAMS) expect(sent).toContain(k)
    // and the filter is NOT a directive, or the split would eat it
    expect(params.get('status')).toBe('active')
  })

  it('over the socket', async () => {
    const c = client() as unknown as {
      _wsReady: boolean
      _wsCall: (svc: string, method: string, id: unknown, data: unknown, q: Record<string, unknown>) => Promise<unknown>
      service(name: string): { find(q?: unknown, d?: QueryDirectives): Promise<unknown> }
    }
    let sent: Record<string, unknown> = {}
    c._wsReady = true
    c._wsCall = async (_s, _m, _i, _d, q) => { sent = q; return { kind: 'list', object: 'items', data: [], total: 0 } }

    await c.service('items').find(FILTERS, ALL)

    const keys = Object.keys(sent).filter(k => k.startsWith('$'))
    for (const k of keys) expect([...RESERVED_PARAMS]).toContain(k)
    // The client prefers the socket whenever one is up, so a directive on one
    // path only is a difference nothing can see from the call site.
    for (const k of DIRECTIVE_PARAMS) expect(keys).toContain(k)
    expect(sent.status).toBe('active')
  })
})
