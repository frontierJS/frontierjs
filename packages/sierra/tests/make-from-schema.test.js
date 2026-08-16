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

/**
 * A relation's local key must not default to 0.
 *
 * Reported from a real form: not picking a customer produced
 * `500 FOREIGN KEY constraint failed` instead of "customer is required".
 *
 * `0` is not "no customer" — it is customer #0, a claim the user never made,
 * and it is the one invented default nothing downstream can catch. A bad enum
 * value fails validation with the field's name on it; `0` is a perfectly good
 * integer, so coerce() keeps it, validate() approves it, and SQLite is the
 * first thing to object — as a 500, from the server, after a round trip.
 *
 * The property carries no marker: a belongsTo is emitted as a plain integer and
 * `x-relations` is the only place the relation exists on the client. So the FK
 * columns have to be handed in.
 */
describe('foreign keys default to null, not 0', () => {
  const ORDER = {
    type: 'object',
    properties: {
      reference:  { type: 'string' },
      total:      { type: 'number', default: 0 },
      quantity:   { type: 'integer' },              // NOT a relation
      customerId: { type: 'integer' },              // the relation's local key
    },
    required: ['reference', 'customerId'],
    'x-relations': [
      { field: 'customer', model: 'Customer', type: 'belongsTo',
        fields: ['customerId'], references: ['id'], optional: false },
    ],
  }
  const fks = ORDER['x-relations'].flatMap(r => r.fields)

  test('the FK is null; a plain integer still gets 0', () => {
    const make = createMakeFromSchema(ORDER.properties, undefined, undefined, fks)
    expect(make()).toEqual({
      reference:  '',
      total:      0,        // an explicit @default wins, as before
      quantity:   0,        // not a relation — unchanged
      customerId: null,     // the fix
    })
  })

  test('an explicit default still wins over the null', () => {
    const make = createMakeFromSchema(
      { ...ORDER.properties, customerId: { type: 'integer', default: 7 } },
      undefined, undefined, fks,
    )
    expect(make().customerId).toBe(7)
  })

  test('passing no FK list leaves every integer at 0 — the old behaviour', () => {
    const make = createMakeFromSchema(ORDER.properties)
    expect(make().customerId).toBe(0)
  })

  test('a compound foreign key nulls every column it names', () => {
    const props = { aId: { type: 'integer' }, bId: { type: 'integer' }, other: { type: 'integer' } }
    const make  = createMakeFromSchema(props, undefined, undefined, ['aId', 'bId'])
    expect(make()).toEqual({ aId: null, bId: null, other: 0 })
  })

  test('the null reaches the required check instead of the database', async () => {
    const { validateAgainstFields, buildFieldRules } =
      await import('../src/junction/field-rules.js')
    registerSchemas({ Order: ORDER }, ['Order'])
    const rules = buildFieldRules(ORDER)
    const make  = createMakeFromSchema(ORDER.properties, undefined, undefined, fks)

    const errors = validateAgainstFields(rules, make(), 'create')
    expect(errors.map(e => e.field)).toContain('customerId')
    expect(errors.find(e => e.field === 'customerId').message).toMatch(/required/)

    // And with 0 — what used to be produced — nothing objects at all.
    const withZero = validateAgainstFields(rules, { ...make(), customerId: 0 }, 'create')
    expect(withZero.find(e => e.field === 'customerId')).toBeUndefined()
  })

  // ── readOnly ────────────────────────────────────────────────────────────────

  test('a readOnly column is not seeded — it is not the caller\'s to write', () => {
    // @system, @computed, @generated and @from all arrive readOnly. A blank
    // seeded for one is a KEY in the payload, and the Data boundary refuses a
    // @system key by name — so a form that never showed the field could not
    // submit at all. Found by example's order form the day @system landed.
    const props = {
      reference:    { type: 'string' },
      trackingCode: { type: ['string', 'null'], readOnly: true, 'x-litestone-kind': 'system' },
      lineCount:    { type: 'integer', readOnly: true, 'x-litestone-kind': 'from' },
    }
    const make = createMakeFromSchema(props)

    expect(make()).toEqual({ reference: '' })
    expect('trackingCode' in make()).toBe(false)
  })

  test('and an explicit value still wins, because make(spec) is the caller talking', () => {
    const props = { trackingCode: { type: ['string', 'null'], readOnly: true } }
    const make  = createMakeFromSchema(props)
    expect(make({ trackingCode: 'TRK-1' }).trackingCode).toBe('TRK-1')
  })
})
