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

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({
      get:   async (id, params) => { calls.push(['get', id, params]); return row },
      find:  async () => ({ data: [row] }),
      patch: async (id, data) => { calls.push(['patch', id, data]); return { ...row, ...data } },
      on: () => {},
    }),
    resource: () => ({
      tether: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { createResource } = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

const { schema, valid, errors } = parse(`
  model Blueprint {
    id     Int    @id
    name   String
    meta   Json?
    prefs  Json @type(Prefs)
    params BlueprintParam[]
    tags   Tag[]
  }

  model Tag {
    id         Int         @id
    name       String
    blueprints Blueprint[]
  }

  type Prefs {
    theme String
    size  Int
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
  registerSchemas(DEFS, ['Blueprint', 'BlueprintParam', 'Tag'])
  calls.length = 0
  row = { id: 1, name: 'Deploy', meta: { a: 1 }, prefs: { theme: 'dark', size: 2 }, params: [{ id: 9, key: 'env' }] }
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

  // FJS-1759: a whole Json document overwrites a key another session set
  test('a changed Json column travels as a $merge of the keys that moved', async () => {
    row = { ...row, meta: { a: 1, b: 1, nest: { x: 1, y: 2 } } }
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)

    await r.save({ ...row, meta: { ...row.meta, a: 2 } })
    expect(lastPatch()).toEqual({ id: 1, meta: { $merge: { a: 2 } } })

    await r.service.get(1)
    await r.save({ ...row, meta: { a: 1, b: 1, nest: { x: 1 } } })
    expect(lastPatch()).toEqual({ id: 1, meta: { $merge: { nest: { y: null } } } })

    await r.service.get(1)
    await r.save({ ...row, meta: { a: 1, nest: { x: 1, y: 2 } } })
    expect(lastPatch()).toEqual({ id: 1, meta: { $merge: { b: null } } })
  })

  test('a Json column replaced by a non-object, or read as one, travels whole', async () => {
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)

    await r.save({ ...row, meta: [1, 2] })
    expect(lastPatch()).toEqual({ id: 1, meta: [1, 2] })

    await r.service.get(1)
    await r.save({ ...row, meta: null })
    expect(lastPatch()).toEqual({ id: 1, meta: null })
  })

  test('a Json column rebuilt to the same document is not sent', async () => {
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)

    await r.save({ ...row, name: 'Ship', meta: { a: 1 } })
    expect(lastPatch()).toEqual({ id: 1, name: 'Ship' })
  })

  test('a typed Json column sends its $merge past the browser-side validation', async () => {
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)

    await r.save({ ...row, prefs: { ...row.prefs, size: 3 } })
    expect(lastPatch()).toEqual({ id: 1, prefs: { $merge: { size: 3 } } })
  })
})

// FJS-D1002: an m2m a form draws is a field of the row, read populated and
// written as one op, unlike the composed keys above.
describe('an m2m is read with the row and saved as one op', () => {
  test('the rule, the control, and no list column', async () => {
    const { buildFieldRules, controlFor, displayFor } = await import('../src/resource/field-rules.js')
    const rule = buildFieldRules(DEFS.Blueprint).tags
    expect(rule).toMatchObject({ type: 'array', relation: { kind: 'm2m', model: 'Tag', field: 'tags' } })
    expect(controlFor(rule)).toMatchObject({ control: 'multiselect', model: 'Tag', relation: 'tags' })
    expect(displayFor(rule).display).toBeNull()
  })

  test('formFields offers it with the related label and allowNew', () => {
    const r = createResource('blueprints', { model: 'Blueprint' })
    const tags = r.formFields().find(f => f.name === 'tags')
    expect(tags).toMatchObject({ control: 'multiselect', valueField: 'id', labelField: 'name', allowNew: true })
  })

  test('a get populates the members', async () => {
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)
    expect(JSON.stringify(calls.find(c => c[0] === 'get'))).toContain('tags')
  })

  test('a changed list after a read is a set; an untouched one is not sent', async () => {
    row = { ...row, tags: [{ id: 1, name: 'a' }] }
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)

    await r.save({ ...row, name: 'Ship' })
    expect(lastPatch()).toEqual({ id: 1, name: 'Ship' })

    await r.save({ ...row, name: 'Ship', tags: [1, 2] })
    expect(lastPatch()).toEqual({ id: 1, tags: { set: [{ id: 1 }, { id: 2 }] } })
  })

  test('a typed member is created beside the set', async () => {
    row = { ...row, tags: [{ id: 1, name: 'a' }] }
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.service.get(1)

    await r.save({ ...row, tags: [1, { name: 'new' }] })
    expect(lastPatch()).toEqual({ id: 1, tags: { set: [{ id: 1 }], create: [{ name: 'new' }] } })
  })

  test('with no read of the members, picks connect rather than replace', async () => {
    const r = createResource('blueprints', { model: 'Blueprint' })
    await r.save({ id: 1, tags: [2] }, { mode: 'patch' })
    expect(lastPatch()).toEqual({ id: 1, tags: { connect: [{ id: 2 }] } })
  })
})
