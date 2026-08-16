/**
 * tests/live-filter.test.js
 *
 * matchesQuery — does a pushed record belong in the list a query filled?
 *
 * The store a `load(query)` filled means "the rows matching that query", so an
 * event about a row is only an update to that list if the row is still in it
 * (`FJS-011`). The answers are three: in, out, and *cannot be decided from this
 * record*, which is the one that keeps the guessing out.
 *
 * The operators asserted here are exactly the ones the wire carries — Junction's
 * `parseWhere`/`translateOps` and Litestone's `buildWhere` between them — and the
 * expectations are what SQL would answer, NULL semantics included: `col != 'x'`
 * does not match a NULL column, `NOT IN` does. Reading them as JavaScript gives
 * the wrong answer for both.
 */

import { describe, test, expect, vi } from 'vitest'
import { matchesQuery } from '../src/junction/field-rules.js'

// What Junction was handed, so the last section can ask whether the resource
// actually built a matcher over the model it resolved.
const _given = {}

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => ({ find: async () => ({ data: [] }), on: () => {} }),
    resource: (name, idField, opts) => {
      _given.opts = opts
      return {
        store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
        stale: { get: () => 3, subscribe: (fn) => { fn(3); return () => {} } },
        load:  async () => [],
      }
    },
  }),
}))

const FIELDS = {
  id:        { type: 'integer', required: true },
  name:      { type: 'string' },
  status:    { type: 'string', enum: ['draft', 'active', 'archived'] },
  score:     { type: 'number', nullable: true },
  active:    { type: 'boolean' },
  tags:      { type: 'array' },
  createdAt: { type: 'string', format: 'date-time' },
}

const row = (over = {}) => ({
  id: 1, name: 'Acme', status: 'active', score: 50, active: true,
  tags: ['a', 'b'], createdAt: '2026-08-01T00:00:00.000Z', ...over,
})

const match = (record, query) => matchesQuery(FIELDS, record, query)

describe('equality', () => {
  test('a matching field is in', () => {
    expect(match(row(), { status: 'active' })).toBe(true)
  })

  test('a differing field is out', () => {
    expect(match(row({ status: 'draft' }), { status: 'active' })).toBe(false)
  })

  test('every key must hold', () => {
    expect(match(row(), { status: 'active', name: 'Acme' })).toBe(true)
    expect(match(row(), { status: 'active', name: 'Other' })).toBe(false)
  })

  test('an empty query matches everything', () => {
    expect(match(row(), {})).toBe(true)
  })

  test('null asks IS NULL', () => {
    expect(match(row({ score: null }), { score: null })).toBe(true)
    expect(match(row({ score: 0 }),    { score: null })).toBe(false)
  })

  test('a string operand is read as the column type', () => {
    // A query built from a URL or a form control sends strings; SQLite's type
    // affinity converts on comparison and `5 === '5'` does not.
    expect(match(row({ id: 5 }),       { id: '5' })).toBe(true)
    expect(match(row({ score: 12.5 }), { score: '12.5' })).toBe(true)
    expect(match(row({ active: true }), { active: 'true' })).toBe(true)
  })
})

describe('operators', () => {
  test('$in / $nin', () => {
    expect(match(row(), { status: { $in: ['active', 'draft'] } })).toBe(true)
    expect(match(row(), { status: { $in: ['draft'] } })).toBe(false)
    expect(match(row(), { status: { $nin: ['draft'] } })).toBe(true)
  })

  test('$nin matches a NULL column, because NOT IN would not', () => {
    // Litestone ORs `IS NULL` back in for exactly this.
    expect(match(row({ score: null }), { score: { $nin: [1, 2] } })).toBe(true)
  })

  test('$ne does not match a NULL column, because != would not', () => {
    expect(match(row({ score: null }), { score: { $ne: 1 } })).toBe(false)
    expect(match(row({ score: 2 }),    { score: { $ne: 1 } })).toBe(true)
  })

  test('$ne null is IS NOT NULL', () => {
    expect(match(row({ score: 5 }),    { score: { $ne: null } })).toBe(true)
    expect(match(row({ score: null }), { score: { $ne: null } })).toBe(false)
  })

  test('comparisons', () => {
    expect(match(row({ score: 50 }), { score: { $gte: 50, $lt: 100 } })).toBe(true)
    expect(match(row({ score: 50 }), { score: { $gt: 50 } })).toBe(false)
    expect(match(row({ score: null }), { score: { $gt: 0 } })).toBe(false)
  })

  test('an ISO date column compares as text, which is what the server does', () => {
    expect(match(row(), { createdAt: { $gte: '2026-07-01' } })).toBe(true)
    expect(match(row(), { createdAt: { $lt:  '2026-07-01' } })).toBe(false)
  })

  test('$like / $start / $end are case-insensitive, as LIKE is', () => {
    expect(match(row(), { name: { $like:  'CM' } })).toBe(true)
    expect(match(row(), { name: { $ilike: 'acme' } })).toBe(true)
    expect(match(row(), { name: { $start: 'ac' } })).toBe(true)
    expect(match(row(), { name: { $end:   'ME' } })).toBe(true)
    expect(match(row(), { name: { $like:  'zzz' } })).toBe(false)
  })

  test('a bare array is membership, not equality', () => {
    expect(match(row(), { status: ['active', 'draft'] })).toBe(true)
    expect(match(row(), { status: ['draft'] })).toBe(false)
  })

  test('on an array column a bare array is hasSome', () => {
    expect(match(row(), { tags: ['b', 'z'] })).toBe(true)
    expect(match(row(), { tags: ['z'] })).toBe(false)
  })

  test('$null', () => {
    expect(match(row({ score: null }), { score: { $null: true } })).toBe(true)
    expect(match(row({ score: 1 }),    { score: { $null: true } })).toBe(false)
    expect(match(row({ score: 1 }),    { score: { $null: false } })).toBe(true)
  })

  test('the bare Litestone spelling reaches the same place', () => {
    // parseWhere only looks for a leading `$`, so an unprefixed operator block
    // travels through to buildWhere untouched.
    expect(match(row(), { score: { gte: 50 } })).toBe(true)
    expect(match(row(), { tags: { has: 'a' } })).toBe(true)
    expect(match(row(), { tags: { hasNone: ['z'] } })).toBe(true)
    expect(match(row(), { tags: { isEmpty: true } })).toBe(false)
  })

  test('equals on an array column is the exact set, in order', () => {
    expect(match(row(), { tags: { equals: ['a', 'b'] } })).toBe(true)
    expect(match(row(), { tags: { equals: ['b', 'a'] } })).toBe(false)
  })
})

describe('$or / $and / $not', () => {
  test('$or', () => {
    expect(match(row(), { $or: [{ status: 'draft' }, { name: 'Acme' }] })).toBe(true)
    expect(match(row(), { $or: [{ status: 'draft' }, { name: 'Other' }] })).toBe(false)
  })

  test('$and', () => {
    expect(match(row(), { $and: [{ status: 'active' }, { name: 'Acme' }] })).toBe(true)
    expect(match(row(), { $and: [{ status: 'active' }, { name: 'Other' }] })).toBe(false)
  })

  test('$not', () => {
    expect(match(row(), { $not: { status: 'draft' } })).toBe(true)
    expect(match(row(), { $not: { status: 'active' } })).toBe(false)
  })

  test('an undecidable branch loses to a decided one, and wins over a false one', () => {
    // `owner` is a relation this record does not carry.
    expect(match(row(), { $or: [{ status: 'active' }, { owner: { name: 'x' } }] })).toBe(true)
    expect(match(row(), { $or: [{ status: 'draft' },  { owner: { name: 'x' } }] })).toBe(null)
    expect(match(row(), { $and: [{ status: 'draft' }, { owner: { name: 'x' } }] })).toBe(false)
  })
})

describe('what it refuses to decide', () => {
  test('a column the record does not carry', () => {
    // A `select` dropped the filtered column — the row is here, the answer is not.
    expect(match({ id: 1, name: 'Acme' }, { status: 'active' })).toBe(null)
  })

  test('a filter over a relation', () => {
    expect(match(row(), { owner: { name: 'Jordan' } })).toBe(null)
  })

  test('a path into a JSON document', () => {
    expect(match({ ...row(), addr: { city: 'NYC' } }, { addr: { city: 'NYC' } })).toBe(null)
  })

  test('$search, $onlyDeleted and $raw', () => {
    expect(match(row(), { $search: 'acme' })).toBe(null)
    expect(match(row(), { $onlyDeleted: true })).toBe(null)
    expect(match(row(), { $raw: 'price > 100' })).toBe(null)
  })

  test('an operator it has never heard of', () => {
    expect(match(row(), { name: { $soundsLike: 'acme' } })).toBe(null)
  })

  test('but a decided false still wins — nothing is reloaded to confirm a miss', () => {
    expect(match(row(), { status: 'draft', $search: 'acme' })).toBe(false)
  })

  test('a directive is not a filter', () => {
    expect(match(row(), { status: 'active', $limit: 20, $orderBy: 'id' })).toBe(true)
  })

  test('no record at all', () => {
    expect(match(null, { status: 'active' })).toBe(null)
  })
})

describe('without a schema', () => {
  test('it still matches structurally', () => {
    // A resource with no model resolved has no field rules; what it loses is the
    // string-operand conversion, not the filter.
    expect(matchesQuery({}, row(), { status: 'active' })).toBe(true)
    expect(matchesQuery({}, row(), { status: 'draft'  })).toBe(false)
    expect(matchesQuery({}, row({ id: 5 }), { id: '5' })).toBe(false)
  })
})

// ── the seam ──────────────────────────────────────────────────────────────────
// Junction owns the store and holds no schema; Sierra owns the schema and hands
// the decision down. Nothing else asserts that the two are connected, and a
// resource that quietly stopped passing one would go back to leaking in silence.

describe('createResource hands the matcher to Junction', () => {
  test('built over the resolved model, not over nothing', async () => {
    const { createResource } = await import('../src/junction/resource.js')
    const { registerSchemas } = await import('../src/junction/schema-registry.js')

    registerSchemas({
      Lead: {
        type: 'object',
        properties: {
          id:     { type: 'integer' },
          status: { type: 'string' },
          score:  { type: 'number' },
        },
      },
    }, ['Lead'])

    createResource('leads')
    const { match } = _given.opts

    expect(match({ id: 1, status: 'active' }, { status: 'active' })).toBe(true)
    expect(match({ id: 1, status: 'draft'  }, { status: 'active' })).toBe(false)
    expect(match({ id: 1 },                   { status: 'active' })).toBe(null)
    // The field rules reached it: `'40'` off a query string is a Float here.
    expect(match({ id: 1, score: 40 }, { score: '40' })).toBe(true)
  })

  test('`stale` comes through, in the shape useStore takes', async () => {
    const { createResource } = await import('../src/junction/resource.js')
    const leads = createResource('leads')
    // A live list can place a row and cannot fill a gap paging left; the count
    // is how a view offers the reload. Same `{ get, subscribe }` as a store, so
    // it bridges to a signal unchanged.
    expect(leads.stale.get()).toBe(3)
    const seen = []
    leads.stale.subscribe(n => seen.push(n))
    expect(seen).toEqual([3])
  })
})
