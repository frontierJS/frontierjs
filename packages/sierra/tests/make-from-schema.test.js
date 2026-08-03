/**
 * tests/make-from-schema.test.js
 *
 * make() is what a schema-seeded UI actually gets from db/schema.lite, so what
 * it does with each field shape is the contract.
 *
 * The case that mattered: generateJsonSchema emits an enum-typed field as
 * `{"$ref":"#/$defs/Plan"}`. Nothing here resolved refs, so the field had no
 * `type` to read and fell through to null — while Junction's autoValidate,
 * derived from the same .lite file, resolved the ref and required a member of
 * the enum. `leads.make()` therefore produced a payload its own server rejected.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@frontierjs/sierra/junction', () => ({ getClient: () => null }))

const { createMakeFromSchema } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

// Exactly what generateJsonSchema produces for an enum + a model that uses it.
const DEFS = {
  Lead: {
    type: 'object',
    title: 'Lead',
    properties: {
      name:   { type: 'string' },
      plan:   { $ref: '#/$defs/Plan' },
      tier:   { $ref: '#/$defs/Plan', default: 'pro' },
      maybe:  { anyOf: [{ $ref: '#/$defs/Plan' }, { type: 'null' }] },
      active: { type: 'boolean', default: true },
      score:  { type: 'number' },
      due:    { type: 'string', format: 'date-time' },
      meta:   { $ref: '#/$defs/Meta' },
      blob:   {},
    },
  },
  Plan: { type: 'string', enum: ['starter', 'pro', 'enterprise'], title: 'Plan' },
  Meta: { type: 'object', title: 'Meta', properties: { k: { type: 'string' } } },
}

describe('make() resolves $ref through the registry', () => {

  beforeEach(() => registerSchemas(DEFS, ['Lead']))

  test('an enum field with @default gets that default', () => {
    expect(createMakeFromSchema(DEFS.Lead.properties)().tier).toBe('pro')
  })

  test('an enum field without a default is left unset, not blank-stringed', () => {
    // '' is not a member of the enum, and picking the first member would invent
    // a choice. null says "the form still has to ask".
    expect(createMakeFromSchema(DEFS.Lead.properties)().plan).toBeNull()
  })

  test('a nullable enum resolves through anyOf', () => {
    expect(createMakeFromSchema(DEFS.Lead.properties)().maybe).toBeNull()
  })

  test('a $ref to an object type yields an object, not null', () => {
    expect(createMakeFromSchema(DEFS.Lead.properties)().meta).toEqual({})
  })

  test('plain fields are unaffected', () => {
    const made = createMakeFromSchema(DEFS.Lead.properties)()
    expect(made.name).toBe('')
    expect(made.active).toBe(true)
    expect(made.score).toBe(0)
    expect(made.due).toBeUndefined()
    expect(made.blob).toBeNull()
  })

  test('server-managed fields stay out', () => {
    const made = createMakeFromSchema({
      id: { type: 'integer' }, createdAt: { type: 'string' }, name: { type: 'string' },
    })()
    expect(Object.keys(made)).toEqual(['name'])
  })

  test('an explicit resolver overrides the registry', () => {
    const make = createMakeFromSchema(
      { plan: { $ref: '#/$defs/Plan' } },
      ['id', 'createdAt', 'updatedAt'],
      () => ({ type: 'string', enum: ['x'], default: 'x' }),
    )
    expect(make().plan).toBe('x')
  })

  test('an unresolvable $ref degrades to null instead of throwing', () => {
    registerSchemas({}, [])
    expect(createMakeFromSchema({ plan: { $ref: '#/$defs/Gone' } })().plan).toBeNull()
  })
})

describe('make() does not throw on things that are not properties maps', () => {

  test('an enum definition passed where properties were expected', () => {
    // createResource used to reach this when a service name resolved to an enum:
    // `'default' in 'string'` → TypeError, i.e. a white screen at module load.
    const enumDef = { type: 'string', enum: ['a', 'b'], title: 'Plan' }
    expect(() => createMakeFromSchema(enumDef)()).not.toThrow()
  })

  test('null and undefined', () => {
    expect(createMakeFromSchema(null)()).toEqual({})
    expect(createMakeFromSchema(undefined)()).toEqual({})
  })
})
