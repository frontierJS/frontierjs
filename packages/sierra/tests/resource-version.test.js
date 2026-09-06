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
// Off by default — most tests here assert what went over the wire, not what a
// server would do with it. The tests that need a server which actually enforces
// @version turn it on, because a fake that accepts every version cannot show the
// write being erased, which is the whole defect.
let enforceVersions = false
// load() snapshots its rows BEFORE the delay, so a slow request answers with
// what was there when it was ISSUED — which is what makes a superseded load
// something this file can construct at all.
let loadDelay = 0

/**
 * What a VersionConflictError looks like by the time the browser catches it:
 * junction's toJSON() on the outside, litestone's own payload two `data`s deep.
 * Written once so the fake service and the assertions cannot drift apart.
 */
function conflictError(actual, expected = 3) {
  return Object.assign(
    new Error(`Version conflict on Order: expected version ${expected}, row is at ${actual}`),
    { code: 409, data: {
        name: 'Conflict', code: 409, retryable: true,
        data: { model: 'Order', field: 'version', expected, actual },
    } })
}

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => ({
      get: async (id) => { calls.push(['get', id, null]); return rows.get(id) ?? null },
      find: async () => ({ data: [...rows.values()] }),
      create: async (data) => { calls.push(['create', null, data]); return { ...data, version: 1 } },
      patch: async (id, data) => {
        calls.push(['patch', id, data])
        if (nextError) { const e = nextError; nextError = null; throw e }
        if (enforceVersions && data.version != null && rows.get(id)?.version !== data.version) {
          throw conflictError(rows.get(id)?.version)
        }
        const next = { ...(rows.get(id) ?? {}), ...data, version: (rows.get(id)?.version ?? 0) + 1 }
        rows.set(id, next)
        return next
      },
      on: () => {},
    }),
    // Junction's REAL Store, not a stub with a no-op set(): a push has to reach
    // the store the way one really does, since what this file asserts is that
    // it moves the rows and does NOT move the version this tab holds.
    // load() mirrors junction's — read rows, write them to the store.
    resource: () => {
      const store = new Store()
      return {
        store,
        load: async () => {
          const list = [...rows.values()]
          if (loadDelay) await new Promise(res => setTimeout(res, loadDelay))
          store.set(list)
          return list
        },
      }
    },
  }),
}))

const { createResource, buildVersion, isStaleWrite, toConflict, toFieldErrors, STALE_WRITE_MESSAGE } =
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
  enforceVersions = false
  loadDelay = 0
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

  // A second tab's patch arrives as a WS upsert into the store. It moves the
  // rows and it must NOT move the version this tab carries: nothing on this
  // screen has read the pushed revision, and answering with it is what erased a
  // concurrent write (`FJS-341`).
  test('a push into the store does not move the version this tab holds', async () => {
    const r = createResource('orders', { model: 'Order' })
    await r.load()
    expect(r.version(1)).toBe(3)
    r.store.upsert({ id: 1, note: 'edited elsewhere', version: 4 })
    expect(r.store.get().find(row => row.id === 1).note).toBe('edited elsewhere')
    expect(r.version(1)).toBe(3)
    await r.service.patch(1, { note: 'mine' })
    expect(lastPatch().version).toBe(3)
  })

  // The defect itself, end to end against a fake that really enforces the
  // column. Before the push stopped moving the version, this patch went up
  // carrying 4 — a revision nobody on this screen had read — and overwrote the
  // other writer's note with values read from revision 3. Measured in basecamp:
  // the guard was declared, the server enforced it, and the write was erased
  // with no error anywhere.
  test('a draft saved after a push loses the race instead of erasing it', async () => {
    enforceVersions = true
    const r = createResource('orders', { model: 'Order' })
    await r.load()

    // What the form is holding: the row as this tab read it, at version 3.
    const draft = { ...r.store.get().find(row => row.id === 1) }

    // The other tab writes. The change reaches this one as a push, and the
    // draft on screen does not move with it.
    rows.set(1, { id: 1, note: 'theirs', version: 4 })
    r.store.upsert({ id: 1, note: 'theirs', version: 4 })
    expect(draft.note).toBe('first')

    await expect(r.service.patch(1, { note: `${draft.note} + mine` }))
      .rejects.toThrow(/Version conflict/)
    expect(rows.get(1).note).toBe('theirs')
  })

  // A caller who HAS read the newer revision still wins, which is what keeps the
  // 409 above from being a screen nobody can get past.
  test('an explicit newer version goes through', async () => {
    enforceVersions = true
    const r = createResource('orders', { model: 'Order' })
    await r.load()
    rows.set(1, { id: 1, note: 'theirs', version: 4 })
    r.store.upsert({ id: 1, note: 'theirs', version: 4 })
    await r.service.patch(1, { note: 'mine', version: 4 })
    expect(rows.get(1).note).toBe('mine')
  })

  // Junction stamps the STORE so a superseded load cannot overwrite a newer one
  // (`FJS-082`); the versions need the same rule, or the slow answer leaves a
  // revision behind that the rows on screen never came from.
  test('a superseded load does not leave its versions behind', async () => {
    const r = createResource('orders', { model: 'Order' })

    loadDelay = 30
    const slow = r.load()                       // issued first, answers last, at v3
    await new Promise(res => setTimeout(res, 5))

    loadDelay = 0
    rows.set(1, { id: 1, note: 'newer', version: 7 })
    await r.load()                              // issued second, answers first, at v7
    await slow

    expect(r.version(1)).toBe(7)
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
  const conflict = () => conflictError(4, 3)
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

  // The sentence is what a form shows. The numbers are what a screen offering
  // *reload* against *overwrite* needs, and no status can carry them.
  test('the two revisions cross the wire', () => {
    expect(toConflict(conflict()))
      .toEqual({ model: 'Order', field: 'version', expected: 3, actual: 4 })
  })

  test('a race whose error carried no numbers answers null, not half of one', () => {
    const bare = Object.assign(new Error('Version conflict on Order'),
      { code: 409, data: { name: 'Conflict', code: 409, retryable: true } })
    expect(isStaleWrite(bare)).toBe(true)
    expect(toConflict(bare)).toBeNull()
  })

  test('a domain refusal is not a conflict', () => {
    expect(toConflict(violation())).toBeNull()
  })

  test('the resource answers it too', () => {
    const r = createResource('orders', { model: 'Order' })
    expect(r.conflict(conflict()).actual).toBe(4)
    expect(r.conflict(violation())).toBeNull()
  })

  test('a per-field 400 is unaffected', () => {
    const err = Object.assign(new Error('Bad Request'),
      { code: 400, data: { data: [{ field: 'note', message: 'Too short' }] } })
    expect(toFieldErrors(err)).toEqual({ fields: { note: 'Too short' }, message: '', committed: false })
  })
})
