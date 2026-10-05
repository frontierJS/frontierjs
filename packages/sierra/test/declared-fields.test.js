/**
 * test/declared-fields.test.js
 *
 * A generated list on an @@extensible model and the custom fields one
 * workspace declared on it (`FJS-D487`, `FJS-1388`).
 *
 * The schema is shared by every tenant, so it cannot name `fields.severity`;
 * the service answers the list per caller and the resource merges it. Every
 * claim is a PAIR with the model that declares nothing, because a merge that
 * always adds a column and one that never does each pass a one-sided test.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

let CALLS = []
let ANSWER = []
let FAIL = false

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: (name) => ({
      on: () => {},
      invoke: async (method) => {
        CALLS.push([name, method])
        if (FAIL) { FAIL = false; throw new Error('boom') }
        return { kind: 'list', data: ANSWER }
      },
    }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource, resetResourcesForIdentityChange } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

const str = { type: 'string' }
const DEFS = {
  Customer: {
    type: 'object', title: 'Customer',
    properties: { id: { type: 'integer' }, name: str, fields: { type: 'object' } },
    'x-label-field': 'name',
    'x-extensible': 'fields',
  },
  Tag: {
    type: 'object', title: 'Tag',
    properties: { id: { type: 'integer' }, name: str },
    'x-label-field': 'name',
  },
}

beforeEach(() => {
  CALLS = []
  FAIL = false
  ANSWER = [
    { key: 'severity', type: 'text',   slot: 't1' },
    { key: 'ltv',      type: 'number', slot: null },
  ]
  registerSchemas(DEFS, ['Customer', 'Tag'])
})

const names = (r) => r.columns.map(c => c.name)

describe('columns() and filters()', () => {
  test('name no declared field until the list has been loaded', () => {
    const customers = createResource('customers', { model: 'Customer' })
    expect(names(customers.columns())).not.toContain('fields.severity')
    expect(CALLS).toEqual([])
  })

  test('offer each declared key as fields.<key> once it has', async () => {
    const customers = createResource('customers', { model: 'Customer' })
    await customers.declaredFields()
    const cols = customers.columns({ limit: 99 })

    expect(names(cols)).toEqual(expect.arrayContaining(['fields.severity', 'fields.ltv']))
    expect(cols.columns.find(c => c.name === 'fields.severity').label).toBe('Severity')
    expect(cols.columns.find(c => c.name === 'fields.severity').sortable).toBe(false)
  })

  test('a slotted key filters through its slot, an unslotted one is refused by name', async () => {
    const customers = createResource('customers', { model: 'Customer' })
    await customers.declaredFields()
    const { filters } = customers.filters({ limit: 99 })

    const slotted = filters.find(f => f.name === 'fields.severity')
    expect(slotted.op).toBeTruthy()
    expect(slotted.queryKey).toBe('t1')

    const pooled = filters.find(f => f.name === 'fields.ltv')
    expect(pooled.op).toBe(null)
    expect(pooled.reason).toMatch(/no slot/)
  })

  test('the number kind filters as a number', async () => {
    ANSWER = [{ key: 'ltv', type: 'number', slot: 'n1' }]
    const customers = createResource('customers', { model: 'Customer' })
    await customers.declaredFields()
    const f = customers.filters({ limit: 99 }).filters.find(x => x.name === 'fields.ltv')
    expect(f.queryKey).toBe('n1')
    expect(f.op).toBeTruthy()
  })
})

describe('declaredFields()', () => {
  test('asks the service once however often it is read', async () => {
    const customers = createResource('customers', { model: 'Customer' })
    await Promise.all([customers.declaredFields(), customers.declaredFields()])
    await customers.declaredFields()
    expect(CALLS).toEqual([['customers', 'declaredFields']])
  })

  test('a model that is not @@extensible answers [] and sends nothing', async () => {
    const tags = createResource('tags', { model: 'Tag' })
    expect(await tags.declaredFields()).toEqual([])
    expect(names(tags.columns({ limit: 99 })).some(n => n.startsWith('fields.'))).toBe(false)
    expect(CALLS).toEqual([])
  })

  test('a failed ask is not remembered', async () => {
    const customers = createResource('customers', { model: 'Customer' })
    FAIL = true
    await expect(customers.declaredFields()).rejects.toThrow('boom')
    await customers.declaredFields()
    expect(CALLS.length).toBe(2)
    expect(names(customers.columns({ limit: 99 }))).toContain('fields.severity')
  })

  test('a change of identity drops it, so the next person is asked', async () => {
    const customers = createResource('customers', { model: 'Customer' })
    await customers.declaredFields()
    resetResourcesForIdentityChange()
    expect(names(customers.columns({ limit: 99 }))).not.toContain('fields.severity')
    await customers.declaredFields()
    expect(CALLS.length).toBe(2)
  })
})
