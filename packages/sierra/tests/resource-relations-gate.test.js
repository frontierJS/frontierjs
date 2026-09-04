/**
 * tests/resource-relations-gate.test.js
 *
 * Two things the schema has always carried to the browser and nothing read.
 *
 * x-relations became load-bearing when implicit m2m fields were removed from
 * `properties` (they are relations, not columns, and were being emitted as
 * required arrays-of-string). That was the right removal, but it means this is
 * now the ONLY place `User.tags → Tag` exists on the client.
 *
 * x-gate lets the UI avoid offering a control the server is going to 403. It is
 * an affordance, never a boundary — the assertions below pin the permissive
 * behavior that follows from that.
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

const { createResource, buildRelations, buildGate, canAtLevel, buildFieldRules } =
  await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

// Exactly what generateJsonSchema emits for:
//   model Account { id Int @id  name String  users User[]  @@gate("2.4.4.5") }
//   model User    { id Int @id  name String  accountId Int
//                   account Account @relation(fields:[accountId], references:[id], onDelete: Cascade)
//                   tags Tag[]  @@gate("4") }
//   model Tag     { id Int @id  name String  users User[] }
const DEFS = {
  Account: {
    type: 'object', title: 'Account',
    properties: { name: { type: 'string' } },
    required: ['name'],
    'x-gate': { read: 2, create: 4, update: 4, delete: 5 },
    'x-relations': [
      { field: 'users', model: 'User', type: 'hasMany', fields: [], references: [], onDelete: null, optional: false },
    ],
  },
  User: {
    type: 'object', title: 'User',
    properties: { name: { type: 'string' }, accountId: { type: 'integer' } },
    required: ['name', 'accountId'],
    'x-gate': { read: 4, create: 4, update: 4, delete: 4 },
    'x-relations': [
      { field: 'account', model: 'Account', type: 'belongsTo', fields: ['accountId'], references: ['id'], onDelete: 'Cascade', optional: false },
      { field: 'tags', model: 'Tag', type: 'm2m' },
    ],
  },
  Tag: {
    type: 'object', title: 'Tag',
    properties: { name: { type: 'string' } },
    'x-relations': [{ field: 'users', model: 'User', type: 'm2m' }],
  },
}

beforeEach(() => registerSchemas(DEFS, ['Account', 'User', 'Tag']))

describe('buildRelations', () => {

  test('belongsTo carries its local FK columns and target', () => {
    expect(buildRelations(DEFS.User).account).toEqual({
      field: 'account', type: 'belongsTo', model: 'Account',
      foreignKeys: ['accountId'], references: ['id'],
      optional: false, onDelete: 'Cascade',
    })
  })

  test('m2m is reported with no FK columns', () => {
    // hasMany and m2m have no local columns; empty arrays would imply otherwise.
    expect(buildRelations(DEFS.User).tags).toEqual({
      field: 'tags', type: 'm2m', model: 'Tag',
    })
  })

  test('hasMany is reported', () => {
    expect(buildRelations(DEFS.Account).users.type).toBe('hasMany')
  })

  test('the target model name is one schemaFor() accepts', () => {
    const { model } = buildRelations(DEFS.User).account
    expect(model).toBe('Account')
  })

  test('falls back to the declared name when the registry cannot resolve it', () => {
    registerSchemas({}, [])
    expect(buildRelations(DEFS.User).account.model).toBe('Account')
  })

  test('a model with no relations yields none', () => {
    expect(buildRelations({ type: 'object', properties: {} })).toEqual({})
    expect(buildRelations(undefined)).toEqual({})
  })
})

describe('foreign keys are marked on the field rules', () => {

  test('a FK column says what it points at', () => {
    // Without this, accountId is just `{ type: 'integer' }` and a generated
    // form renders a number spinner for a reference.
    expect(buildFieldRules(DEFS.User).accountId.references).toEqual({
      model: 'Account', field: 'id', relation: 'account',
    })
  })

  test('ordinary columns are not marked', () => {
    expect(buildFieldRules(DEFS.User).name.references).toBeUndefined()
  })

  test('the FK keeps its own rules', () => {
    const fk = buildFieldRules(DEFS.User).accountId
    expect(fk.type).toBe('integer')
    expect(fk.required).toBe(true)
  })
})

describe('buildGate', () => {

  test('reads the four operations', () => {
    expect(buildGate(DEFS.Account)).toEqual({ read: 2, create: 4, update: 4, delete: 5 })
  })

  test('a model with no @@gate has no gate', () => {
    expect(buildGate(DEFS.Tag)).toBeNull()
    expect(buildGate(undefined)).toBeNull()
  })
})

describe('canAtLevel — an affordance, so unknowns are permissive', () => {
  const gate = { read: 2, create: 4, update: 4, delete: 5 }

  test('compares the level against the operation', () => {
    expect(canAtLevel(gate, 'read', 2)).toBe(true)
    expect(canAtLevel(gate, 'create', 3)).toBe(false)
    expect(canAtLevel(gate, 'delete', 5)).toBe(true)
    expect(canAtLevel(gate, 'delete', 4)).toBe(false)
  })

  test('accepts service method names as well as gate operations', () => {
    expect(canAtLevel(gate, 'find', 2)).toBe(true)     // → read
    expect(canAtLevel(gate, 'patch', 3)).toBe(false)   // → update
    expect(canAtLevel(gate, 'remove', 4)).toBe(false)  // → delete
    expect(canAtLevel(gate, 'restore', 4)).toBe(true)  // → update
  })

  test('no gate declared → permissive', () => {
    expect(canAtLevel(null, 'delete', 0)).toBe(true)
  })

  test('no level known → permissive', () => {
    // Hiding a control the user could have used is a worse, quieter failure
    // than showing one that errors — and the server is what actually says no.
    expect(canAtLevel(gate, 'delete', undefined)).toBe(true)
    expect(canAtLevel(gate, 'delete', null)).toBe(true)
  })

  test('an operation the gate does not mention → permissive', () => {
    expect(canAtLevel(gate, 'somethingElse', 0)).toBe(true)
  })
})

describe('on the resource', () => {

  test('relations, gate and can() are exposed', () => {
    const users = createResource('users')
    expect(users.relations.account.model).toBe('Account')
    expect(users.gate).toEqual({ read: 4, create: 4, update: 4, delete: 4 })
    expect(users.can('delete', 4)).toBe(true)
    expect(users.can('delete', 3)).toBe(false)
  })

  test('a model without a gate reports null and permits everything', () => {
    const tags = createResource('tags')
    expect(tags.gate).toBeNull()
    expect(tags.can('delete', 0)).toBe(true)
  })

  test('a resource with no schema reports nothing rather than guessing', () => {
    registerSchemas({}, [])
    const r = createResource('whatever')
    expect(r.relations).toEqual({})
    expect(r.gate).toBeNull()
    expect(r.can('delete', 0)).toBe(true)
  })

  test('a relation target can be turned into its own resource', () => {
    // The point of normalizing `model`: it round-trips.
    const users = createResource('users')
    const target = createResource('accounts', { model: users.relations.account.model })
    expect(target.fields.name.required).toBe(true)
  })
})
