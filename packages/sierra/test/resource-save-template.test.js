/**
 * test/resource-save-template.test.js
 *
 * `save()` reaches a template (`FJS-2626`). The Data boundary leaves a
 * `@@hasTemplates` row out of every write that does not ask for it, so a
 * template's own edit form — read with `$withTemplates` — answered 404 to its
 * save. The model says which column marks one (`x-templates`), and a save of a
 * row that is a template, or was one as this resource read it, asks.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

const calls = []
let row

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({
      get:   async (id, params) => { calls.push(['get', id, params]); return row },
      find:  async () => ({ data: [row] }),
      patch: async (id, data, params) => { calls.push(['patch', id, data, params]); return { ...row, ...data } },
      on: () => {},
    }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { createResource } = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

const { schema, valid, errors } = parse(`
  model Checklist {
    id    Int    @id
    title String
    @@hasTemplates
  }

  model Note {
    id    Int    @id
    title String
  }
`)
if (!valid) throw new Error(`fixture schema is invalid: ${errors.join('; ')}`)
const DEFS = generateJsonSchema(schema, { mode: 'update' }).$defs

const lastPatch = () => calls.filter(c => c[0] === 'patch').at(-1)

beforeEach(() => {
  registerSchemas(DEFS, ['Checklist', 'Note'])
  calls.length = 0
})

describe('a save reaches a template', () => {
  test('the model names its marker column', () => {
    expect(DEFS.Checklist['x-templates']).toBe('isTemplate')
    expect(DEFS.Note['x-templates']).toBeUndefined()
  })

  test('a template read and saved asks for templates', async () => {
    row = { id: 1, title: 'Onboarding', isTemplate: true }
    const r = createResource('checklists', { model: 'Checklist' })
    await r.service.get(1, { withTemplates: true })
    await r.save({ ...row, title: 'Onboarding, v2' })
    expect(lastPatch()).toEqual(['patch', 1, { id: 1, title: 'Onboarding, v2' }, { withTemplates: true }])
  })

  test('a demote asks too: the row it read was a template', async () => {
    row = { id: 2, title: 'Old', isTemplate: true }
    const r = createResource('checklists', { model: 'Checklist' })
    await r.service.get(2, { withTemplates: true })
    await r.save({ ...row, isTemplate: false })
    expect(lastPatch()[3]).toEqual({ withTemplates: true })
  })

  test('an instance, and a model with no templates, send no directive', async () => {
    row = { id: 3, title: 'A run', isTemplate: false }
    const r = createResource('checklists', { model: 'Checklist' })
    await r.service.get(3)
    await r.save({ ...row, title: 'A run, renamed' })
    expect(lastPatch()[3]).toBeUndefined()

    row = { id: 4, title: 'Plain' }
    const n = createResource('notes', { model: 'Note' })
    await n.save({ id: 4, title: 'Plainer' }, { mode: 'patch' })
    expect(lastPatch()[3]).toBeUndefined()
  })
})
