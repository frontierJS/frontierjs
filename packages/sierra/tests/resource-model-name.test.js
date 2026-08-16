/**
 * tests/resource-model-name.test.js
 *
 * A resource is addressed by SERVICE name ('leads') but seeded from a MODEL
 * ('Lead'). The registry bridges the two with `@frontierjs/toolbelt/inflect` —
 * English's regular rules plus a fixed irregular table — and `opts.model` is
 * the override for everything those cannot reach.
 *
 * Both halves matter. Without the -es rule a plainly regular plural — a
 * `model Status` behind a `statuses` service — silently resolved to nothing,
 * and the failure was a console warning, not an error: make() quietly returned
 * a bare object and fields was empty.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => ({ find: async () => ({ data: [] }), on: () => {} }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource } = await import('../src/junction/resource.js')
const { registerSchemas, schemaFor, suggestModel } = await import('../src/junction/schema-registry.js')

const model = (name) => ({
  type: 'object', title: name, properties: { name: { type: 'string' } }, required: ['name'],
})

const DEFS = {
  Lead:    model('Lead'),
  Company: model('Company'),
  Status:  model('Status'),
  Box:     model('Box'),
  Church:  model('Church'),
  Bus:     model('Bus'),
  Person:  model('Person'),
  Child:   model('Child'),
}
const NAMES = Object.keys(DEFS)

beforeEach(() => registerSchemas(DEFS, NAMES))

describe('plurals resolve without help, irregular ones included', () => {

  test.each([
    ['leads',     'Lead'],       // -s
    ['companies', 'Company'],    // consonant + y → -ies
    ['statuses',  'Status'],     // sibilant → -es
    ['boxes',     'Box'],
    ['churches',  'Church'],
    ['buses',     'Bus'],
    // In the irregular table, so no `model:` is needed to say them any more.
    ['people',    'Person'],
    ['children',  'Child'],
  ])('%s → %s', (service, expected) => {
    expect(createResource(service).context.model).toBe(expected)
    expect(schemaFor(service).title).toBe(expected)
  })

  test('the model name and the accessor also resolve', () => {
    expect(schemaFor('Lead').title).toBe('Lead')
    expect(schemaFor('lead').title).toBe('Lead')
  })

  test('a vowel + y is not turned into -ies', () => {
    // 'day' → 'days', never 'daies'.
    registerSchemas({ Day: model('Day') }, ['Day'])
    expect(schemaFor('days')?.title).toBe('Day')
    expect(schemaFor('daies')).toBeNull()
  })
})

describe('opts.model overrides the lookup', () => {

  test('an irregular plural resolves when the model is named', () => {
    const r = createResource('people', { model: 'Person' })
    expect(r.context.model).toBe('Person')
    expect(r.fields.name.required).toBe(true)     // seeded, not bare
  })

  test('works in the schema-second signature', () => {
    const r = createResource('children', DEFS.Child, { model: 'Child' })
    expect(r.context.model).toBe('Child')
    expect(r.fields.name).toBeTruthy()
  })

  test('works in the object form', () => {
    const r = createResource({ service: 'people', model: 'Person' })
    expect(r.context.model).toBe('Person')
    expect(r.fields.name).toBeTruthy()
  })

  test('a service named nothing like its model still resolves', () => {
    // Not a plural problem at all — the service is just named differently.
    const r = createResource('roster', { model: 'Person' })
    expect(r.fields.name).toBeTruthy()
  })

  test('the accessor spelling is accepted too', () => {
    expect(createResource('people', { model: 'person' }).fields.name).toBeTruthy()
  })

  test('the service name is still what is called on the wire', () => {
    const r = createResource('people', { model: 'Person' })
    expect(r.context.service).toBe('people')
  })
})

describe('when nothing resolves, the warning names the fix', () => {

  test('suggests a model whose name resembles the service', () => {
    // A typo, not an irregular — the irregulars resolve on their own now. No
    // rule turns `companie` into anything, and the lenient accessor + s
    // spelling the registry also indexes does not cover it, so this is a real
    // miss and the warning has to earn its place by naming the fix.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createResource('companie')
    const msg = warn.mock.calls[0][0]
    expect(msg).toContain("createResource('companie', { model: 'Company' })")
    expect(msg).toContain('Known models:')
    warn.mockRestore()
  })

  test('offers no guess when no string rule could have known', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createResource('gadgets')
    const msg = warn.mock.calls[0][0]
    // 'gadget' resembles nothing registered — claiming a match would be noise.
    expect(msg).not.toContain('looks like the one')
    expect(msg).toContain('Person')            // still listed among known models
    expect(msg).toContain('{ model:')          // and the fix is still named
    warn.mockRestore()
  })

  test('stays quiet when the build supplied no schemas at all', () => {
    registerSchemas({}, [])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createResource('anything')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('suggestModel', () => {

  test('matches on a shared prefix of at least three characters', () => {
    expect(suggestModel('children')).toBe('Child')
    expect(suggestModel('statuses')).toBe('Status')
  })

  test('returns null rather than guessing', () => {
    expect(suggestModel('people')).toBeNull()
    expect(suggestModel('zzz')).toBeNull()
    expect(suggestModel('')).toBeNull()
    expect(suggestModel(undefined)).toBeNull()
  })
})
