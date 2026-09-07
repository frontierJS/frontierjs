/**
 * tests/options-order.test.js
 *
 * What order a picker's list arrives in — the client half of a value set's
 * `order` (`FJS-D121`), and the crossing that had no test at all.
 *
 * The gap this covers is not the feature, it is where the feature had to go.
 * `optionsQuery` reads like the place an app states a picker's order, and it is
 * not: `options(field)` asks the field's SOURCE model, whose resource is minted
 * inside `relatedResource` and carries nobody's declaration. Sierra's suite
 * asserted `getOptions()` — the method an app calls directly — and never
 * `options()`, so for its whole life every picker in every app sorted
 * alphabetically on the display column with no way to say otherwise, and
 * nothing was red.
 *
 * So every assertion here reads the directives the picker actually SENT, and
 * the default is asserted beside the declaration: a mechanism that sent the
 * declared order and a mechanism that sent nothing at all are the same
 * observation from a test that only asks about the declared case.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

let LAST = null   // what the picker asked the service for

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: (name) => ({
      on: () => {},
      // `getOptions()` is sugar over `find`, so `find` is what a picker
      // ultimately sends and what is recorded here.
      find: async (filter, directives) => {
        LAST = { name, filter, directives }
        return { data: [{ id: 1, name: 'Clay' }, { id: 2, name: 'Ochre' }], total: 2 }
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

/** A model whose `color` column binds to a value set, with or without an order. */
const defsFor = (order) => ({
  Variant: {
    type: 'object', title: 'Variant',
    properties: {
      sku:   str,
      color: {
        ...str,
        'x-values': {
          set: 'Swatches', strength: 'required', model: 'Swatch',
          value: 'name', label: 'name',
          ...(order ? { order } : {}),
        },
      },
    },
  },
  Swatch: SWATCH,
})

/** The other provenance: a plain foreign key, which has no set to declare one. */
const FK_DEFS = {
  Order: {
    type: 'object', title: 'Order',
    properties: { ref: str, swatchId: { type: 'integer' } },
    'x-relations': [{
      field: 'swatch', model: 'Swatch', type: 'belongsTo',
      fields: ['swatchId'], references: ['id'], onDelete: null, optional: false,
    }],
  },
  Swatch: SWATCH,
}

const askFor = async (order, opts) => {
  registerSchemas(defsFor(order), ['Variant', 'Swatch'])
  const r = createResource('variants', { model: 'Variant' })
  await r.options('color', opts)
  return LAST.directives
}

beforeEach(() => { LAST = null })

describe("a picker's order", () => {
  test('is the display column ascending when the set states none', async () => {
    expect(await askFor(null)).toEqual({ limit: 100, orderBy: 'name' })
  })

  test('is what the set declared when it declares one', async () => {
    expect(await askFor([{ field: 'sortOrder', dir: 'asc' }, { field: 'name', dir: 'asc' }]))
      .toEqual({ limit: 100, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] })
  })

  test('carries a direction per column', async () => {
    expect((await askFor([{ field: 'createdAt', dir: 'desc' }])).orderBy)
      .toEqual([{ createdAt: 'desc' }])
  })

  // The declaration is a default, not a lock: a screen that wants this one list
  // in another order still says so, which is the per-call half of the axis.
  test('a caller-stated directives argument still wins', async () => {
    const declared = [{ field: 'sortOrder', dir: 'asc' }]
    expect(await askFor(declared, { directives: { limit: 5, orderBy: 'name' } }))
      .toEqual({ limit: 5, orderBy: 'name' })
  })

  // Searching narrows on the column a person READS, which is not necessarily
  // the column the list is ordered by once a set declares one — the two used to
  // be the same name by construction.
  test('search narrows on the label column and leaves the order alone', async () => {
    registerSchemas(defsFor([{ field: 'sortOrder', dir: 'asc' }]), ['Variant', 'Swatch'])
    const r = createResource('variants', { model: 'Variant' })
    await r.options('color', { search: 'cl' })
    expect(LAST.filter).toEqual({ name: { contains: 'cl' } })
    expect(LAST.directives.orderBy).toEqual([{ sortOrder: 'asc' }])
  })

  test('a plain foreign key has no set, so it is the display column', async () => {
    registerSchemas(FK_DEFS, ['Order', 'Swatch'])
    const r = createResource('orders', { model: 'Order' })
    await r.options('swatchId')
    expect(LAST.directives).toEqual({ limit: 100, orderBy: 'name' })
  })

  // A literal set is the case that needs no declaration: its members travel in
  // the order they were written, and this is the assertion that says the picker
  // does not sort them on arrival.
  test('an enum is offered in declaration order, not alphabetically', async () => {
    registerSchemas({
      Task: {
        type: 'object', title: 'Task',
        properties: { priority: { ...str, enum: ['low', 'medium', 'high'] } },
      },
    }, ['Task'])
    const r = createResource('tasks', { model: 'Task' })
    const { options } = await r.options('priority')
    expect(options.map(o => o.value)).toEqual(['low', 'medium', 'high'])
  })
})
