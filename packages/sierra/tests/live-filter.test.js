/**
 * tests/live-filter.test.js
 *
 * The SEAM: does `createResource` actually hand the matcher down to Junction,
 * built over the model it resolved?
 *
 * `matchesQuery` itself is `@frontierjs/toolbelt/match` and is asserted there,
 * in `test/specs/match.spec.js` — it moved because there are two live stores
 * and they had one implementation between them (`FJS-493`). Restating its 31
 * cases here would be two owners again by another route.
 *
 * What only this side can answer is the wiring. Junction owns the store and
 * holds no schema; Sierra owns the schema and hands the decision down. A
 * resource that quietly stopped passing one would go back to leaking in
 * silence, and nothing else looks.
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

describe('one owner', () => {
  test('what Sierra exports IS the toolbelt function', async () => {
    // The re-export, asserted rather than assumed. A copy made here to "fix" an
    // import would pass every case in this file and put the second
    // implementation straight back (`FJS-493`).
    const toolbelt = await import('@frontierjs/toolbelt/match')
    expect(matchesQuery).toBe(toolbelt.matchesQuery)
  })
})

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
