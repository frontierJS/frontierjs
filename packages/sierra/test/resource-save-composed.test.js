/**
 * test/resource-save-composed.test.js
 *
 * `save()` hands a patch the model's own columns and never a COMPOSED key
 * (`FJS-1576`). A form opened on `record(id, { composed: true })` holds a
 * child list the service owns the write of; whether that list rode the patch
 * used to depend on whether it was the identical reference the last read held.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

const calls = []
let row

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => ({
      get:   async (id) => { calls.push(['get', id]); return row },
      find:  async () => ({ data: [row] }),
      patch: async (id, data) => { calls.push(['patch', id, data]); return { ...row, ...data } },
      on: () => {},
    }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { createResource } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

const { schema, valid, errors } = parse(`
  model Blueprint {
    id     Int    @id
    name   String
    meta   Json?
    params BlueprintParam[]
  }

  model BlueprintParam {
    id          Int       @id
    key         String
    blueprintId Int
    blueprint   Blueprint @relation(fields: [blueprintId], references: [id])
  }
`)
if (!valid) throw new Error(`fixture schema is invalid: ${errors.join('; ')}`)
const DEFS = generateJsonSchema(schema, { mode: 'update' }).$defs

const lastPatch = () => calls.filter(c => c[0] === 'patch').at(-1)?.[2]

beforeEach(() => {
  registerSchemas(DEFS, ['Blueprint', 'BlueprintParam'])
  calls.length = 0
  row = { id: 1, name: 'Deploy', meta: { a: 1 }, params: [{ id: 9, key: 'env' }] }
})

describe('a patch carries columns, never a composed key', () => {
  test('a composed list that is a different reference than the read is not sent', async () => {
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)

    await r.save({ ...row, name: 'Ship', params: row.params.map(p => ({ ...p })) })

    expect(lastPatch()).toEqual({ id: 1, name: 'Ship' })
  })

  test('with no read to compare against, the composed list is still not sent', async () => {
    const r = createResource('blueprints', { model: 'Blueprint' })

    await r.save({ id: 1, name: 'Ship', params: [{ id: 9, key: 'env' }] }, { mode: 'patch' })

    expect(lastPatch().params).toBeUndefined()
    expect(lastPatch().name).toBe('Ship')
  })

  test('a declared Json column that changed still travels', async () => {
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)

    await r.save({ ...row, meta: { a: 2 } })

    expect(lastPatch()).toEqual({ id: 1, meta: { a: 2 } })
  })
})
