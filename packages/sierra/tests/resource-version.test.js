/**
 * tests/resource-version.test.js
 *
 * The fourth thing the schema carries to the browser: `x-version`, the column an
 * update has to hand back.
 *
 * Litestone enforces optimistic concurrency at the Data boundary — a patch on a
 * `@version` model that does not carry the version it read is refused outright
 * (`VersionRequiredError`, 400), and one carrying a version that has moved is a
 * `VersionConflictError` (409, retryable). Neither is something the client can
 * check. Its entire job is to return the value it was given, which is exactly
 * why leaving it to the app was wrong: every app would have written the same
 * three lines, and the ones that forgot would look fine until two people opened
 * the same record.
 *
 * `FJS-105` was that gap — the framework enforcing a guarantee its own client
 * could not satisfy.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
// Junction by relative path — `bun install` resolves workspace:* to a copy, so a
// package-name import would test yesterday's Store.
import { Store } from '../../junction/src/client/index.ts'

// The fake service records what actually went over the wire, which is the only
// thing worth asserting here: the version is not a property of the resource, it
// is a value in the payload.
const calls = []
let nextError = null
const rows = new Map()

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => ({
      get: async (id) => { calls.push(['get', id, null]); return rows.get(id) ?? null },
      find: async () => ({ data: [...rows.values()] }),
      create: async (data) => { calls.push(['create', null, data]); return { ...data, version: 1 } },
      patch: async (id, data) => {
        calls.push(['patch', id, data])
        if (nextError) { const e = nextError; nextError = null; throw e }
        const next = { ...(rows.get(id) ?? {}), ...data, version: (rows.get(id)?.version ?? 0) + 1 }
        rows.set(id, next)
        return next
      },
      on: () => {},
    }),
    // Junction's REAL Store, not a stub with a no-op set(): the versions this
    // file asserts are recorded off the store's notifications now, so a stub
    // that never notifies would pass every test here while an app read nothing.
    // load() mirrors junction's — read rows, write them to the store.
    resource: () => {
      const store = new Store()
      return {
        store,
        load: async () => { const list = [...rows.values()]; store.set(list); return list },
      }
    },
  }),
}))

const { createResource, buildVersion, isStaleWrite, toFieldErrors, STALE_WRITE_MESSAGE } =
  await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

// Litestone by relative path — `bun install` resolves workspace:* to a copy, so
// a package-name import would test a stale snapshot of the generator that
// produced these defs. Same reasoning as resource-transitions.test.js.
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

const LITE = `
  model Order {
    id      Int    @id
    note    String?
    version Int    @version
  }

  model Note { id Int @id  body String }
`

const { schema, valid, errors } = parse(LITE)
if (!valid) throw new Error(`fixture schema is invalid: ${errors.join('; ')}`)
const DEFS = generateJsonSchema(schema, { mode: 'update' }).$defs

beforeEach(() => {
  registerSchemas(DEFS, ['Order', 'Note'])
  calls.length = 0
  nextError = null
  rows.clear()
  rows.set(1, { id: 1, note: 'first', version: 3 })
})

const lastPatch = () => calls.filter(c => c[0] === 'patch').at(-1)?.[2]

describe('the schema carries the column name', () => {
  test('generateJsonSchema names it on the model', () => {
    expect(DEFS.Order['x-version']).toBe('version')
  })

  test('and marks the field readOnly so a generated form does not offer an input', () => {
    expect(DEFS.Order.properties.version.readOnly).toBe(true)
  })

  test('buildVersion reads it back; a model without one has none', () => {
    expect(buildVersion(DEFS.Order)).toBe('version')
    expect(buildVersion(DEFS.Note)).toBeNull()
    expect(buildVersion(undefined)).toBeNull()
  })

  test('the resource exposes which column it is', () => {
    expect(createResource('orders', { model: 'Order' }).versionField).toBe('version')
    expect(createResource('notes',  { model: 'Note'  }).versionField).toBeNull()
  })
})

describe('the version rides the patch', () => {
  test('a patch after a get carries the version the get returned', async () => {
    const r = createResource('orders', { model: 'Order' })
    await r.service.get(1)
    await r.service.patch(1, { note: 'edited' })
    expect(lastPatch()).toEqual({ note: 'edited', version: 3 })
  })

  test('a patch after load() carries it too — load bypasses the call path', async () => {
    const r = createResource('orders', { model: 'Order' })
    await r.load()
    expect(r.version(1)).toBe(3)
    await r.service.patch(1, { note: 'edited' })
    expect(lastPatch().version).toBe(3)
  })

  test('the patch response updates it, so a second edit sends the new one', async () => {
    const r = createResource('orders', { model: 'Order' })
    await r.service.get(1)
    await r.service.patch(1, { note: 'a' })
    await r.service.patch(1, { note: 'b' })
    expect(lastPatch()).toEqual({ note: 'b', version: 4 })
  })

  // A second tab's patch arrives as a WS upsert into the store and never passes
  // through a call result here, so this tab used to keep the version it read at
  // load time and 409 on its next patch against a number nobody had read.
  test('a push into the store moves the version with it', async () => {
    const r = createResource('orders', { model: 'Order' })
    await r.load()
    expect(r.version(1)).toBe(3)
    r.store.upsert({ id: 1, note: 'edited elsewhere', version: 4 })
    expect(r.version(1)).toBe(4)
    await r.service.patch(1, { note: 'mine' })
    expect(lastPatch().version).toBe(4)
  })

  test('create records the version of the row it made', async () => {
    const r = createResource('orders', { model: 'Order' })
    await r.service.create({ id: 9, note: 'new' })
    expect(r.version(9)).toBe(1)
  })

  // Someone doing their own concurrency control has to be able to.
  test('an explicit version wins over the remembered one', async () => {
    const r = createResource('orders', { model: 'Order' })
    await r.service.get(1)
    await r.service.patch(1, { note: 'edited', version: 99 })
    expect(lastPatch().version).toBe(99)
  })

  // Inventing a number would silently win a race. Letting the server refuse is
  // the honest failure.
  test('nothing read means nothing sent — the server gets to refuse', async () => {
    const r = createResource('orders', { model: 'Order' })
    expect(r.version(1)).toBeNull()
    await r.service.patch(1, { note: 'edited' })
    expect(lastPatch()).toEqual({ note: 'edited' })
  })

  test('a model with no @version is untouched', async () => {
    const r = createResource('notes', { model: 'Note' })
    await r.service.patch(1, { body: 'x' })
    expect(lastPatch()).toEqual({ body: 'x' })
    expect(r.version(1)).toBeNull()
  })
})

describe('a stale write says something a person can act on', () => {
  // A 409 alone cannot tell these apart, which is why junction carries
  // `retryable` on the wire.
  const conflict = () => Object.assign(new Error('Version conflict on Order: expected version 3, row is at 4'),
    { code: 409, data: { name: 'Conflict', code: 409, retryable: true } })
  const violation = () => Object.assign(new Error("Cannot transition order.status from 'shipped' to 'pending'"),
    { code: 409, data: { name: 'Conflict', code: 409, retryable: false } })

  test('isStaleWrite is true only for the retryable 409', () => {
    expect(isStaleWrite(conflict())).toBe(true)
    expect(isStaleWrite(violation())).toBe(false)
    expect(isStaleWrite(Object.assign(new Error('nope'), { code: 400 }))).toBe(false)
    expect(isStaleWrite(new Error('plain'))).toBe(false)
    expect(isStaleWrite(null)).toBe(false)
  })

  test('a race becomes the sentence, not the column and two integers', () => {
    const { fields, message } = toFieldErrors(conflict())
    expect(fields).toEqual({})
    expect(message).toBe(STALE_WRITE_MESSAGE)
  })

  // The domain refusal's own message IS the right thing to show — replacing it
  // with "reload and try again" would tell someone to retry a move that will
  // never be legal.
  test('a non-retryable 409 keeps its own message', () => {
    expect(toFieldErrors(violation()).message).toContain('Cannot transition')
  })

  test('through the resource, a failed patch reads the same way', async () => {
    const r = createResource('orders', { model: 'Order' })
    await r.service.get(1)
    nextError = conflict()
    await expect(r.service.patch(1, { note: 'edited' })).rejects.toThrow()
    expect(r.fieldErrors(conflict()).message).toBe(STALE_WRITE_MESSAGE)
  })

  test('a per-field 400 is unaffected', () => {
    const err = Object.assign(new Error('Bad Request'),
      { code: 400, data: { data: [{ field: 'note', message: 'Too short' }] } })
    expect(toFieldErrors(err)).toEqual({ fields: { note: 'Too short' }, message: '' })
  })
})
