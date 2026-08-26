/**
 * tests/resource-readonly.test.js
 *
 * The columns the SERVER owns, on the way OUT.
 *
 * `@system`, `@generated`, `@computed`, `@from`, `@version` and a tenancy stamp
 * all reach the browser as `readOnly`. Two things already read that: a generated
 * form does not offer the control, and `make()` does not seed the value. Neither
 * covers the case an EDIT form is.
 *
 * `<Form record={row}>` is handed a row the SERVER sent. That row carries every
 * column the caller could read, the whole record is what gets written back, and
 * the Data boundary refuses `@system` BY NAME — deliberately, because a payload
 * naming one is code that meant to write it. So a form nobody typed a
 * server-owned value into produced a 403 about a column that is not on screen.
 * Found on `example`'s customers screen; `Customer.userId` is `@system` and
 * every save failed.
 *
 * The one that must NOT be dropped is the `@version` column: it is marked
 * readOnly and an update is REQUIRED to hand it back. That is why the strip
 * takes a keep list rather than being spelled "delete every readOnly key".
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

const _calls = []
let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { buildFieldRules, stripReadOnly } = await import('../src/junction/field-rules.js')
const { createResource } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

beforeEach(() => {
  _calls.length = 0
  _proxy = {
    find:    (q, p)   => { _calls.push(['find', q, p]);      return Promise.resolve([]) },
    get:     (id, p)  => { _calls.push(['get', id, p]);      return Promise.resolve(row()) },
    create:  (data)   => { _calls.push(['create', data]);    return Promise.resolve(data) },
    patch:   (id, d)  => { _calls.push(['patch', id, d]);    return Promise.resolve(d) },
    remove:  (id)     => { _calls.push(['remove', id]);      return Promise.resolve({}) },
    restore: (id)     => { _calls.push(['restore', id]);     return Promise.resolve({}) },
    upsert:  (data)   => { _calls.push(['upsert', data]);    return Promise.resolve(data) },
    on: () => {}, call: () => Promise.resolve(),
  }
})

// What generateJsonSchema emits for a model carrying one of each kind. `readOnly`
// is the single flag all five arrive under — which is the reason one function
// can answer for all of them, and the reason it needs the exception.
const CUSTOMER = {
  type: 'object',
  title: 'Customer',
  properties: {
    id:         { type: 'integer', readOnly: true },
    name:       { type: 'string', minLength: 1 },
    email:      { type: 'string', format: 'email' },
    notes:      { type: ['string', 'null'] },
    fullName:   { type: ['string', 'null'], readOnly: true, 'x-litestone-kind': 'generated' },
    userId:     { type: ['string', 'null'], readOnly: true, 'x-litestone-kind': 'system' },
    orderCount: { type: 'integer', readOnly: true, 'x-litestone-kind': 'from' },
    version:    { type: 'integer', readOnly: true, 'x-litestone-kind': 'version' },
  },
  required: ['name', 'email'],
  'x-version': 'version',
}

const fields = () => buildFieldRules(CUSTOMER)

// A row exactly as a GET answers it — which is the payload an edit form sends.
const row = () => ({
  id: 7, name: 'Ada', email: 'ada@x.test', notes: 'prefers email',
  fullName: 'Ada Ashby', userId: 'usr_1', orderCount: 2, version: 3,
})

describe('stripReadOnly', () => {
  test('drops the columns the caller may not write', () => {
    const out = stripReadOnly(fields(), row())
    expect('userId'     in out).toBe(false)
    expect('fullName'   in out).toBe(false)
    expect('orderCount' in out).toBe(false)
  })

  test('keeps what the caller typed', () => {
    expect(stripReadOnly(fields(), row())).toMatchObject({
      name: 'Ada', email: 'ada@x.test', notes: 'prefers email',
    })
  })

  test('the version column survives when it is named — an update requires it', () => {
    const out = stripReadOnly(fields(), row(), { keep: ['version'] })
    expect(out.version).toBe(3)
  })

  test('…and is dropped when it is not, so the rule has no hidden exception', () => {
    expect('version' in stripReadOnly(fields(), row())).toBe(false)
  })

  test('a key the rules do not know is left alone', () => {
    // A @transient, a custom method's own argument. Guessing about these is how
    // a strip becomes the thing that breaks a working app.
    const out = stripReadOnly(fields(), { ...row(), acceptedTerms: true })
    expect(out.acceptedTerms).toBe(true)
  })

  test('a payload that names none of them is not copied', () => {
    const clean = { name: 'Ada' }
    expect(stripReadOnly(fields(), clean)).toBe(clean)
  })

  test('an absent readOnly key is not introduced', () => {
    expect('userId' in stripReadOnly(fields(), { name: 'Ada' })).toBe(false)
  })

  test('an array of rows is handled row by row', () => {
    const out = stripReadOnly(fields(), [row(), row()])
    expect(out).toHaveLength(2)
    expect(out.every(r => !('userId' in r))).toBe(true)
  })

  test('a non-object travels untouched', () => {
    expect(stripReadOnly(fields(), null)).toBe(null)
    expect(stripReadOnly(fields(), 3)).toBe(3)
  })

  test('no rules at all is a no-op, not an empty object', () => {
    const r = row()
    expect(stripReadOnly({}, r)).toBe(r)
  })
})

// ── through the resource, which is where it has to happen ───────────────────
//
// The unit above is the rule; this is that the write pipeline actually applies
// it. A refactor that dropped the call would leave every test above green and
// put the 403 straight back.

describe('a save does not send the server its own columns back', () => {
  beforeEach(() => registerSchemas({ Customer: CUSTOMER }, ['Customer']))

  test('patch — the row a GET answered, written straight back', async () => {
    const customers = createResource('customers', 'id', { model: 'Customer' })
    await customers.save(row(), { mode: 'patch' })

    const [verb, id, data] = _calls.at(-1)
    expect([verb, id]).toEqual(['patch', 7])
    expect('userId'     in data).toBe(false)
    expect('fullName'   in data).toBe(false)
    expect('orderCount' in data).toBe(false)
    expect(data.name).toBe('Ada')
  })

  test('…and the revision it read goes with it', async () => {
    const customers = createResource('customers', 'id', { model: 'Customer' })
    await customers.save(row(), { mode: 'patch' })
    expect(_calls.at(-1)[2].version).toBe(3)
  })

  test('create — a seeded blank carrying a stray server column', async () => {
    const customers = createResource('customers', 'id', { model: 'Customer' })
    await customers.save({ name: 'Ada', email: 'ada@x.test', userId: 'usr_9' }, { mode: 'create' })

    const data = _calls.at(-1)[1]
    expect('userId' in data).toBe(false)
    expect(data.email).toBe('ada@x.test')
  })
})
