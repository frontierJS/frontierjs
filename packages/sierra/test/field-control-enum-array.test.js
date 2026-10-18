/**
 * test/field-control-enum-array.test.js
 *
 * A column holding a list of an enum's members (`Capability[]`, `Role[]`)
 * (`FJS-2640`). Its items are a `$ref`, so the rule carried no `items` and the
 * table fell through to the `json` textarea: a role was authored by typing the
 * array, and a misspelled member was refused only by the save.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service:  () => ({ find: async () => ({ data: [] }), on: () => {} }),
    resource: () => ({
      tether: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const {
  createResource, controlFor, buildFieldRules, validateAgainstFields,
} = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')

// What generateJsonSchema emits for:
//   enum Verb { read write }   (read labeled "View")
//   model Role { id Int @id  name String  verbs Verb[] @default([])  tags String[] }
const DEFS = {
  Role: {
    type: 'object', title: 'Role',
    properties: {
      name:  { type: 'string' },
      verbs: { type: 'array', items: { $ref: '#/$defs/Verb' }, default: [] },
      tags:  { type: 'array', items: { type: 'string' } },
    },
    required: ['name'],
  },
  Verb: { type: 'string', enum: ['read', 'write', 'delete'], 'x-labels': { read: 'View' } },
}

beforeEach(() => registerSchemas(DEFS, ['Role']))

const rules = () => buildFieldRules(DEFS.Role, (ref) => DEFS[ref.split('/').pop()])

describe('a list of an enum', () => {
  test('is a closed multiselect, not a JSON document', () => {
    const c = controlFor(rules().verbs, { field: 'verbs', model: 'Role' })

    expect(c.control).toBe('multiselect')
    expect(c.task).toBe('select')
    expect(c.allowNew).toBeFalsy()
  })

  test('a list of free strings is still the open multiselect', () => {
    const c = controlFor(rules().tags)

    expect(c).toMatchObject({ control: 'multiselect', allowNew: true })
  })

  test('options() answers the members, labeled, with no request', async () => {
    const roles = createResource('roles', { model: 'Role' })

    const { options, total, truncated } = await roles.options('verbs')

    expect(options).toEqual([
      { value: 'read',   label: 'View' },
      { value: 'write',  label: 'write' },
      { value: 'delete', label: 'delete' },
    ])
    expect(total).toBe(3)
    expect(truncated).toBe(false)
  })

  test('a member the enum does not declare is refused in the browser', () => {
    const errors = validateAgainstFields(rules(), { name: 'x', verbs: ['read', 'wrtie'] }, 'create')

    expect(errors).toEqual([{ field: 'verbs', message: expect.stringMatching(/wrtie/) }])
    expect(validateAgainstFields(rules(), { name: 'x', verbs: ['read', 'write'] }, 'create')).toEqual([])
  })
})
