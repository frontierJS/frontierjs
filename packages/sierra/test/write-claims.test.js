/**
 * test/write-claims.test.js
 *
 * A field `@allow('write', auth().isStaff)` arrives as `x-litestone-write-claims`
 * beside the bit. A caller who fails it is not offered the column: the resource
 * reports it among the frozen fields, which `<Form>` already draws disabled and
 * drops from the payload. The boundary enforces regardless (Invariant 6), so an
 * unknown answer — no session, or a claim the session does not carry — locks
 * nothing (`FJS-1671`, `FJS-D578`).
 */

import { describe, test, expect, vi, afterEach } from 'vitest'

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({ on: () => {} }),
    resource: () => ({
      service: {},
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { buildFieldRules } = await import('../src/resource/field-rules.js')
const { createResource }  = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { session }         = await import('../src/resource/session.js')

const ACCOUNT = {
  type: 'object',
  title: 'Account',
  properties: {
    id:      { type: 'string', readOnly: true },
    name:    { type: 'string' },
    channel: { type: 'string', 'x-litestone-write-policy': true, 'x-litestone-write-claims': { isStaff: true } },
    kind:    { type: 'string', 'x-litestone-write-policy': true, 'x-litestone-write-claims': { role: 'admin', isStaff: true } },
    notes:   { type: 'string', 'x-litestone-write-policy': true },
  },
}

describe('buildFieldRules', () => {
  test('carries the claims onto the policed column only', () => {
    const fields = buildFieldRules(ACCOUNT)
    expect(fields.channel['x-litestone-write-claims']).toEqual({ isStaff: true })
    expect(fields.notes['x-litestone-write-claims']).toBeUndefined()
    expect(fields.name['x-litestone-write-claims']).toBeUndefined()
  })
})

describe('sealedFields', () => {
  const locked = (user, record) => {
    registerSchemas({ Account: ACCOUNT }, ['Account'])
    session.user = user
    return createResource('accounts', 'id', { model: 'Account' }).sealedFields(record).sort()
  }
  afterEach(() => { session.user = null })

  test('a caller failing the claims is locked out of the column, on a create too', () => {
    expect(locked({ userId: 'u1', isStaff: false, role: 'admin' })).toEqual(['channel', 'kind'])
    expect(locked({ userId: 'u1', isStaff: false, role: 'admin' }, { id: 'a1' })).toEqual(['channel', 'kind'])
  })

  test('a caller holding every claim is locked out of nothing', () => {
    expect(locked({ userId: 'u1', isStaff: true, role: 'admin' })).toEqual([])
  })

  test('an equality claim compares the value, not its truthiness', () => {
    expect(locked({ userId: 'u1', isStaff: true, role: 'editor' })).toEqual(['kind'])
  })

  test('unknown answers are permissive: no session, or a claim the session does not carry', () => {
    expect(locked(null)).toEqual([])
    expect(locked({ userId: 'u1' })).toEqual([])
  })

  test('a predicate carried only as the bit locks nothing', () => {
    expect(locked({ userId: 'u1', isStaff: false, role: 'admin' })).not.toContain('notes')
  })
})
