/**
 * test/field-rules-patch-required.test.js
 *
 * A non-null column with a default on an EDIT (`FJS-2065`).
 *
 * `schema.required` is the create-required set, so `extraHours Float @default(0)`
 * is never `required` — yet it is not nullable either. On a patch the badge said
 * "Optional" while blanking the box was refused, because the badge read create's
 * rule and the refusal a patch's.
 */

import { describe, test, expect, vi } from 'vitest'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({}),
    resource: () => ({
      service: {},
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { buildFieldRules, requiredFor, validateAgainstFields, createResource } = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')

const SOURCE = `
model UserDaily {
  id         Int    @id @default(autoincrement())
  extraHours Float  @default(0)
  note       String?
  @@gate("0.0.0.0")
}
`

const json = generateJsonSchema(parse(SOURCE).schema)
const fields = buildFieldRules(json.$defs.UserDaily, ref => json.$defs[ref.split('/').pop()] ?? null)

describe('a non-null defaulted column is necessary on a patch', () => {
  test('create-required is still false, and the column is not nullable', () => {
    expect(fields.extraHours.required).toBe(false)
    expect(fields.extraHours.nullable).toBe(false)
  })

  test('requiredFor answers true on a patch and false on a create', () => {
    expect(requiredFor(fields.extraHours, {}, 'patch')).toBe(true)
    expect(requiredFor(fields.extraHours, {})).toBe(false)
    expect(requiredFor(fields.extraHours, {}, 'create')).toBe(false)
  })

  test('a nullable column stays optional on a patch', () => {
    expect(requiredFor(fields.note, {}, 'patch')).toBe(false)
  })

  test('a blank box and an explicit null are refused as required on a patch', () => {
    expect(validateAgainstFields(fields, { extraHours: '' }, 'patch'))
      .toEqual([{ field: 'extraHours', message: 'extraHours is required' }])
    expect(validateAgainstFields(fields, { extraHours: null }, 'patch'))
      .toEqual([{ field: 'extraHours', message: 'extraHours is required' }])
  })

  test('a create leaves a blank defaulted column to its default', () => {
    expect(validateAgainstFields(fields, { extraHours: null }, 'create')).toEqual([])
  })

  test('requiredFields lists it for a patch only', () => {
    registerSchemas(json.$defs, ['UserDaily'])
    const resource = createResource('userDaily')
    expect(resource.requiredFields({ id: 1 }, 'patch')).toContain('extraHours')
    expect(resource.requiredFields({ id: 1 }, 'patch')).not.toContain('note')
    expect(resource.requiredFields({})).not.toContain('extraHours')
  })
})
