/**
 * test/determined-fields.test.js
 *
 * A column a create policy pins to the caller (`hostId == auth().id`) arrives as
 * `x-determined`. The form offers no choice for it, validation does not demand
 * it of the person, and the create fills it from the session — so the form a
 * scaffold ships is not a guaranteed 403 (`FJS-1229`, `FJS-D492`).
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

const _calls = []
const _finds = []

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => ({
      create: (data) => { _calls.push(data); return Promise.resolve(data) },
      find:   (filter) => { _finds.push(filter); return Promise.resolve({ data: [{ id: 's1', name: 'Mine' }], total: 1 }) },
      on: () => {},
    }),
    resource: () => ({
      service: {},
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { buildFieldRules, formFieldList, validateAgainstFields } = await import('../src/resource/field-rules.js')
const { createResource }  = await import('../src/resource/resource.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { session }         = await import('../src/resource/session.js')

const EVENT = {
  type: 'object',
  title: 'Event',
  properties: {
    id:     { type: 'string', readOnly: true },
    name:   { type: 'string', minLength: 1 },
    hostId: { type: 'string' },
  },
  required: ['name', 'hostId'],
  'x-relations': [{ type: 'belongsTo', field: 'host', model: 'User', fields: ['hostId'], references: ['id'] }],
  'x-determined': { hostId: 'auth().id' },
}

describe('buildFieldRules', () => {
  test('carries the claim and stops demanding the value of the person', () => {
    const rule = buildFieldRules(EVENT).hostId
    expect(rule.determined).toBe('auth().id')
    expect(rule.required).toBe(false)
  })

  test('a form with no hostId passes validation', () => {
    expect(validateAgainstFields(buildFieldRules(EVENT), { name: 'Intro' }, 'create')).toEqual([])
  })
})

describe('formFieldList', () => {
  test('leaves a determined column out of the generated set', () => {
    const names = formFieldList(buildFieldRules(EVENT)).map(f => f.name)
    expect(names).toContain('name')
    expect(names).not.toContain('hostId')
  })

  test('`only` naming it is the person saying they will draw it', () => {
    const names = formFieldList(buildFieldRules(EVENT), { only: ['hostId'] }).map(f => f.name)
    expect(names).toEqual(['hostId'])
  })
})

describe('create', () => {
  beforeEach(() => {
    _calls.length = 0
    registerSchemas({ Event: EVENT }, ['Event'])
  })
  afterEach(() => { session.user = null })

  test('fills the column from the session', async () => {
    session.user = { userId: 'usr_9' }
    await createResource('events',{ model: 'Event' }).save({ name: 'Intro' }, { mode: 'create' })
    expect(_calls[0]).toMatchObject({ name: 'Intro', hostId: 'usr_9' })
  })

  test('a blank seed from make() is replaced, a stated value is not', async () => {
    session.user = { userId: 'usr_9' }
    const events = createResource('events',{ model: 'Event' })
    await events.save({ name: 'A', hostId: '' }, { mode: 'create' })
    await events.save({ name: 'B', hostId: 'usr_2' }, { mode: 'create' })
    expect(_calls[0].hostId).toBe('usr_9')
    expect(_calls[1].hostId).toBe('usr_2')
  })

  test('with no session nothing is invented, and the boundary refuses', async () => {
    await createResource('events',{ model: 'Event' }).save({ name: 'Intro' }, { mode: 'create' })
    expect('hostId' in _calls[0]).toBe(false)
  })
})

// FJS-1672, FJS-D669 — the rows a create policy will accept for a relation column
const BOOKING = {
  type: 'object',
  title: 'Booking',
  properties: { id: { type: 'string', readOnly: true }, scheduleId: { type: 'string' } },
  required: ['scheduleId'],
  'x-relations': [{ type: 'belongsTo', field: 'schedule', model: 'Schedule', fields: ['scheduleId'], references: ['id'] }],
  'x-pick-where': { scheduleId: { hostId: 'auth().id' } },
}
const SCHEDULE = { type: 'object', title: 'Schedule', properties: { id: { type: 'string' }, name: { type: 'string' } }, 'x-label-field': 'name' }

describe('options() under x-pick-where', () => {
  beforeEach(() => {
    _finds.length = 0
    registerSchemas({ Booking: BOOKING, Schedule: SCHEDULE }, ['Booking', 'Schedule'])
  })
  afterEach(() => { session.user = null })

  test('the picker asks for the caller\'s rows, the claim filled from the session', async () => {
    session.user = { userId: 'usr_9' }
    await createResource('bookings',{ model: 'Booking' }).options('scheduleId', { reload: true })
    expect(_finds[0]).toMatchObject({ hostId: 'usr_9' })
  })

  test('a filter the caller states wins over the derived one', async () => {
    session.user = { userId: 'usr_9' }
    await createResource('bookings',{ model: 'Booking' }).options('scheduleId', { query: { hostId: 'usr_2' }, reload: true })
    expect(_finds[0].hostId).toBe('usr_2')
  })

  test('with no session nothing is invented and the boundary decides', async () => {
    await createResource('bookings',{ model: 'Booking' }).options('scheduleId', { reload: true })
    expect('hostId' in _finds[0]).toBe(false)
  })
})
