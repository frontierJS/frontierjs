/**
 * tests/options-recent.test.js
 *
 * The HEAD of a picker's list — `recent(Model.column, clock)` (`FJS-D121`,
 * `FJS-964`): the values this caller reached for last, above the ordinary page.
 *
 * The design claim these assert is that a head is not a sort. A picker's list
 * is capped, so ranking the whole thing by recency would change WHICH rows are
 * offered rather than only their order — and *an order is not membership* is
 * the property this axis was separated from strength to keep. So: two bounded
 * queries, the rank prepended, the page beneath minus what the head showed, and
 * the total untouched.
 *
 * Two things here would be invisible without a recorded call log. The head is
 * fetched through the SET's own filter, or a value the scope retired comes back
 * at the top of the list it was retired out of. And a set that declares no head
 * must issue no rank at all — a mechanism that always asked would pass every
 * assertion about ordering while costing every picker in the app a second
 * request.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

/** Every call the picker made, in order. */
let CALLS = []

const ROWS = [
  { id: 1, name: 'Default' },
  { id: 2, name: 'Clay' },
  { id: 3, name: 'Ochre' },
  { id: 4, name: 'Black' },
]

/**
 * What the rank answers, and whether it answers at all.
 *
 * Deliberately NOT in the order the set's own read comes back in — the rows
 * arrive as Clay then Black, so a head that kept the fetch's order would look
 * correct against any rank that happened to agree with it.
 */
let RANK = ['Black', 'Clay']

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: (name) => ({
      on: () => {},
      find: async (filter, directives) => {
        CALLS.push({ name, kind: 'find', filter, directives })
        const wanted = filter?.name?.in
        const rows   = wanted ? ROWS.filter(r => wanted.includes(r.name)) : ROWS
        return { data: rows, total: ROWS.length }
      },
      invoke: async (method, id, spec) => {
        CALLS.push({ name, kind: method, spec })
        if (RANK === null) throw new Error('no such service')
        return { kind: 'list', data: RANK.map(v => ({ color: v })) }
      },
    }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

const str = { type: 'string' }
const SWATCH = { type: 'object', title: 'Swatch', properties: { name: str }, 'x-label-field': 'name' }

const defsFor = (extra) => ({
  Variant: {
    type: 'object', title: 'Variant',
    properties: {
      sku:   str,
      color: {
        ...str,
        'x-values': {
          set: 'Swatches', strength: 'required', model: 'Swatch',
          value: 'name', label: 'name', scopes: ['current'],
          order: [{ field: 'name', dir: 'asc' }],
          ...extra,
        },
      },
    },
  },
  Swatch: SWATCH,
})

const RECENT = { recent: { model: 'Variant', field: 'color', clock: 'createdAt' } }

const ask = async (extra, opts) => {
  registerSchemas(defsFor(extra), ['Variant', 'Swatch'])
  const r = createResource('variants', { model: 'Variant' })
  return r.options('color', opts)
}

const ranks = () => CALLS.filter(c => c.kind === 'aggregate')
const finds = () => CALLS.filter(c => c.kind === 'find')

let warn
beforeEach(() => { CALLS = []; RANK = ['Black', 'Clay']; warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warn.mockRestore())

describe('a declared head', () => {
  test('asks for the rank, by the clock the schema named', async () => {
    await ask(RECENT)
    expect(ranks()).toHaveLength(1)
    expect(ranks()[0].spec).toEqual({
      by:      ['color'],
      _max:    { createdAt: true },
      orderBy: { _max: { createdAt: 'desc' } },
      limit:   5,
    })
  })

  test('puts those values first, in the RANK order rather than the list order', async () => {
    const { options } = await ask(RECENT)
    // The read that fetched them came back in the set's own order; re-sorting
    // it into the rank's is the whole point of the head.
    expect(options.slice(0, 2).map(o => o.value)).toEqual(['Black', 'Clay'])
    expect(options.slice(0, 2).every(o => o.recent)).toBe(true)
  })

  test('and the page beneath does not repeat them', async () => {
    const { options } = await ask(RECENT)
    expect(options.map(o => o.value)).toEqual(['Black', 'Clay', 'Default', 'Ochre'])
    expect(options.filter(o => o.recent)).toHaveLength(2)
  })

  // The head is a member of the same list shown at the top, so it is not two
  // more rows: a total that grew with the head would report a list longer than
  // the one the set contains.
  test('does not change what the list says it holds', async () => {
    const withHead = await ask(RECENT)
    const without  = await ask({})
    expect(withHead.total).toBe(without.total)
    expect(withHead.truncated).toBe(without.truncated)
  })

  // Without this the head is a way back in for a value the set retired — the
  // scope narrows the page and the head arrives beside it ungraded.
  test('fetches the head rows through the SET filter, scope included', async () => {
    await ask(RECENT)
    const head = finds().find(c => c.filter?.name?.in)
    expect(head.filter).toEqual({ $scope: ['current'], name: { in: ['Black', 'Clay'] } })
    expect(head.directives).toEqual({ limit: 2 })
  })

  test('a rank that answers nothing leaves the ordinary list', async () => {
    RANK = []
    const { options } = await ask(RECENT)
    expect(options.map(o => o.value)).toEqual(ROWS.map(r => r.name))
    expect(options.some(o => o.recent)).toBe(false)
  })

  // A head is an affordance, so losing it is not losing the picker.
  test('an unreachable rank leaves the list and says so once', async () => {
    RANK = null
    const { options } = await ask(RECENT)
    expect(options.map(o => o.value)).toEqual(ROWS.map(r => r.name))
    expect(warn.mock.calls.map(c => String(c[0])).filter(m => /recent\(/.test(m))).toHaveLength(1)
  })
})

describe('when a head is not wanted', () => {
  // The control for every assertion above: a set with no head must cost no
  // rank. A mechanism that asked unconditionally would pass all of them.
  test('a set that declares none issues no rank at all', async () => {
    const { options } = await ask({})
    expect(ranks()).toHaveLength(0)
    expect(options.some(o => o.recent)).toBe(false)
  })

  // Searching is the other mode — the person knows the value they want, and a
  // head above the matches is noise between the query and the answer.
  test('a search issues none either', async () => {
    await ask(RECENT, { search: 'cl' })
    expect(ranks()).toHaveLength(0)
  })

  // Stated directives are the caller's own ordering, and a head would sit on
  // top of it uninvited.
  test('and neither do stated directives', async () => {
    await ask(RECENT, { directives: { limit: 5, orderBy: 'name' } })
    expect(ranks()).toHaveLength(0)
  })
})
