/**
 * test/resource-collations.test.js
 *
 * `resource.collations` (`FJS-3402`): the column -> `@collate` map a
 * `<Table>` that sorts its own rows is handed, since the kit holds no schema.
 * Paired with a model that declares none, because a map that always names a
 * column and one that never does each pass a one-sided test.
 */

import { describe, test, expect, vi } from 'vitest'

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({ on: () => {}, invoke: async () => [] }),
    resource: () => ({
      tether: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource } = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')

const str = { type: 'string' }
registerSchemas({
  Source: {
    type: 'object', title: 'Source',
    properties: { id: { type: 'integer' }, label: { ...str, 'x-collate': 'nocase' }, code: str },
  },
  Plain: {
    type: 'object', title: 'Plain',
    properties: { id: { type: 'integer' }, label: str },
  },
}, ['Source', 'Plain'])

describe('resource.collations', () => {
  test('names the columns the schema declares a collation on, and no other', () => {
    expect(createResource('sources', { model: 'Source' }).collations).toEqual({ label: 'nocase' })
  })

  test('is empty for a model that declares none', () => {
    expect(createResource('plains', { model: 'Plain' }).collations).toEqual({})
  })
})
