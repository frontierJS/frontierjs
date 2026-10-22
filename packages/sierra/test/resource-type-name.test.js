/**
 * test/resource-type-name.test.js
 *
 * `type AssignShift { … }` is the shape a custom method is validated against
 * on the server. A Resource naming it must be seeded from it, not from the
 * model its service is named for, and an explicit `model:` that resolves to
 * nothing must say so rather than fall through to the service name (FJS-1254).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({ find: async () => ({ data: [] }), on: () => {} }),
    resource: () => ({
      tether: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource } = await import('../src/resource/resource.js')
const { registerSchemas, schemaFor, modelNameFor, typeFor, allSchemas } =
  await import('../src/resource/schema-registry.js')

const shape = (name, props, required = []) => ({
  type: 'object', title: name, properties: props, required,
})

const DEFS = {
  Shift: shape('Shift', {
    siteId: { type: 'integer' }, ruleId: { type: 'integer' }, onDate: { type: 'string' },
  }, ['siteId', 'onDate']),
  AssignShift: shape('AssignShift', {
    siteId: { type: 'integer' }, onDate: { type: 'string' }, ignoreAvailability: { type: 'boolean' },
  }, ['siteId', 'onDate']),
  Status: { type: 'string', enum: ['open', 'closed'] },
}

beforeEach(() => registerSchemas(DEFS, ['Shift']))

describe('a Resource naming a type', () => {

  test('is seeded from the type, not from the service\'s model', () => {
    const r = createResource('shifts', { model: 'AssignShift' })
    const names = Object.keys(r.fields)
    expect(names).toContain('ignoreAvailability')
    expect(names).not.toContain('ruleId')
    expect(r.context.model).toBe('AssignShift')
  })

  test('make() seeds the type\'s required fields', () => {
    const r = createResource('shifts', { model: 'AssignShift' })
    expect(Object.keys(r.make()).sort()).toEqual(['onDate', 'siteId'])
    expect(r.validate({}, 'create').map(e => e.field).sort()).toEqual(['onDate', 'siteId'])
  })

  test('the type is not a model: the registry\'s model lookups do not see it', () => {
    expect(modelNameFor('AssignShift')).toBeNull()
    expect(schemaFor('AssignShift')).toBeNull()
    expect(Object.keys(allSchemas())).toEqual(['Shift'])
    expect(typeFor('AssignShift').title).toBe('AssignShift')
  })

  test('an enum is not a type', () => {
    expect(typeFor('Status')).toBeNull()
  })

  test('only the explicit name reaches it — a service of that name does not', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    createResource('assignShifts')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('an explicit model that resolves to nothing', () => {

  test('warns and does not fall through to the service name', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = createResource('shifts', { model: 'Nonesuch' })
    expect(Object.keys(r.fields)).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toContain('Nonesuch')
    warn.mockRestore()
  })

  test('the service name still resolves when no model is named', () => {
    expect(createResource('shifts').context.model).toBe('Shift')
  })
})
