/**
 * tests/label-field.test.js
 *
 * Which column a picker SHOWS for a related row — the client half of
 * `@@label(field)`, which reaches here as `x-label-field`.
 *
 * A foreign key holds an id and nobody recognizes an id. Before the
 * declaration existed the only mechanism was a scan of eight hardcoded column
 * names, and each step down it is a worse answer that was given in silence
 * (`FJS-392`): a `Person` with `firstName`/`lastName` labels every option
 * *Ada, Ada, Ada* and looks like it worked, and a model whose strings are all
 * enums or foreign keys offers `1, 2, 3`.
 *
 * Two halves are asserted here and they are separable. **The declaration wins**
 * — including over shapes the scan deliberately refuses, because the case the
 * attribute exists for (a `@generated` full name) is `readOnly` and absent from
 * a create-mode registry. And **a guess says so**, which is what turns the
 * remaining silence into a message naming the model and the fix.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'

let LAST = null   // what the picker asked the service for

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    // `service.getOptions()` is sugar over `find`, so `find` is what a picker
    // ultimately sends and what is recorded here.
    service: (name) => ({
      on: () => {},
      find: async (filter, directives) => {
        LAST = { name, filter, directives }
        return {
          data: [
            { id: 1, firstName: 'Ada', lastName: 'Lovelace', fullName: 'Ada Lovelace' },
            { id: 2, firstName: 'Ada', lastName: 'Byron',    fullName: 'Ada Byron' },
          ],
          total: 2,
        }
      },
    }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const { createResource, labelFieldFor, labelFieldInfo } =
  await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')

const str = { type: 'string' }

/**
 * `model Person { id Int @id  firstName String  lastName String
 *                 fullName String? @generated(`{firstName} {lastName}`, stored)
 *                 @@label(fullName) }`
 * — as create mode emits it. Note `fullName` is NOT in `properties`: a
 * generated column is full-mode only, and the declaration still names it.
 */
const PERSON = {
  type: 'object', title: 'Person',
  properties: { firstName: str, lastName: str },
  'x-label-field': 'fullName',
}

/** The same model with nothing declared — the scan's *Ada, Ada, Ada* case. */
const UNNAMED = { type: 'object', title: 'Unnamed', properties: { firstName: str, lastName: str } }

/** Nothing readable at all — the `1, 2, 3` case. */
const OPAQUE = {
  type: 'object', title: 'Opaque',
  properties: { status: { type: 'string', enum: ['a', 'b'] }, ownerId: { type: 'integer' } },
}

const named = (title) => ({ type: 'object', title, properties: { name: str } })

const defsFor = (related, relatedName) => ({
  Order: {
    type: 'object', title: 'Order',
    properties: { ref: str, personId: { type: 'integer' } },
    'x-relations': [{
      field: 'person', model: relatedName, type: 'belongsTo',
      fields: ['personId'], references: ['id'], onDelete: null, optional: false,
    }],
  },
  [relatedName]: related,
})

let warn
beforeEach(() => { LAST = null; warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warn.mockRestore())

describe('labelFieldInfo — four tiers, and it says which one answered', () => {
  test('a declaration is authoritative', () => {
    expect(labelFieldInfo({ name: str }, 'id', 'fullName'))
      .toEqual({ field: 'fullName', source: 'declared' })
  })

  test('a conventional name is next', () => {
    expect(labelFieldInfo({ firstName: str, name: str })).toEqual({ field: 'name', source: 'conventional' })
  })

  test('the first plain string is a guess, and is reported as one', () => {
    expect(labelFieldInfo({ firstName: str, lastName: str }))
      .toEqual({ field: 'firstName', source: 'scan' })
  })

  test('nothing readable falls to the caller-supplied value', () => {
    expect(labelFieldInfo({ status: { ...str, enum: ['a'] } }, 'id'))
      .toEqual({ field: 'id', source: 'fallback' })
  })

  test('the declaration is NOT checked against the rules map', () => {
    // The two shapes that make checking it wrong: a readOnly column, which the
    // scan skips by design, and a column absent from a create-mode registry
    // altogether — which is what a @generated one is.
    expect(labelFieldInfo({ fullName: { ...str, readOnly: true } }, 'id', 'fullName').source).toBe('declared')
    expect(labelFieldInfo({ firstName: str }, 'id', 'fullName').field).toBe('fullName')
  })

  test('labelFieldFor is the name alone, and its old two-argument call is unchanged', () => {
    expect(labelFieldFor({ firstName: str, lastName: str })).toBe('firstName')
    expect(labelFieldFor({}, 'sku')).toBe('sku')
    expect(labelFieldFor({ name: str }, 'id', 'fullName')).toBe('fullName')
  })
})

describe('a resource carries its own display column', () => {
  test('from x-label-field', () => {
    registerSchemas(defsFor(PERSON, 'Person'), ['Order', 'Person'])
    const r = createResource('people', { model: 'Person' })
    expect(r.labelField).toBe('fullName')
    expect(r.labelSource).toBe('declared')
  })

  test('and says so when it guessed', () => {
    registerSchemas(defsFor(UNNAMED, 'Unnamed'), ['Order', 'Unnamed'])
    const r = createResource('unnamed', { model: 'Unnamed' })
    expect(r.labelField).toBe('firstName')
    expect(r.labelSource).toBe('scan')
  })

  test('a resource with no schema at all still answers something pickable', () => {
    registerSchemas({}, [])
    const r = createResource('nothing', { model: 'Nothing' })
    expect(typeof r.labelField).toBe('string')
  })
})

describe('the picker uses the declared column end to end', () => {
  beforeEach(() => registerSchemas(defsFor(PERSON, 'Person'), ['Order', 'Person']))

  test('options are labeled with it', async () => {
    const r = await createResource('orders').options('personId')
    // The scan would have answered `firstName` here and both rows read *Ada*.
    expect(r.options).toEqual([
      { value: 1, label: 'Ada Lovelace' },
      { value: 2, label: 'Ada Byron' },
    ])
  })

  test('the list is ordered by it, and search matches it — the same column', () => {
    // Ranking by one string and matching against another is the shape this
    // avoids by asking one question of one column.
    const res = createResource('orders')
    return res.options('personId', { search: 'love' }).then(() => {
      expect(LAST.filter).toEqual({ fullName: { contains: 'love' } })
      expect(LAST.directives.orderBy).toBe('fullName')
    })
  })

  test('an explicit labelField still wins over the declaration', async () => {
    const out = await createResource('orders').options('personId', { labelField: 'lastName' })
    expect(out.options[0].label).toBe('Lovelace')
    expect(LAST.directives.orderBy).toBe('lastName')
  })
})

describe('a guessed display column is said out loud', () => {
  const said = () => warn.mock.calls.map(c => String(c[0])).join('\n')

  test('the scan tier names the model and the fix', async () => {
    registerSchemas(defsFor(UNNAMED, 'Unnamed'), ['Order', 'Unnamed'])
    await createResource('orders').options('personId')

    expect(said()).toContain('the first plain string column, which is a guess')
    expect(said()).toContain('@@label(<column>) on model Unnamed')
  })

  test('the fallback tier says the options are labeled with their id', async () => {
    registerSchemas(defsFor(OPAQUE, 'Opaque'), ['Order', 'Opaque'])
    const out = await createResource('orders').options('personId')

    expect(said()).toContain('no readable string column')
    // …and it is not a bluff: the label really is the id.
    expect(out.options[0].label).toBe(1)
  })

  test('once per field, not once per call', async () => {
    registerSchemas(defsFor(UNNAMED, 'Unnamed'), ['Order', 'Unnamed'])
    const res = createResource('orders')
    await res.options('personId')
    await res.options('personId', { reload: true })
    await res.options('personId', { search: 'ad' })

    expect(warn.mock.calls.filter(c => String(c[0]).includes('@@label')).length).toBe(1)
  })

  test('silent for a declaration, and for a conventional name', async () => {
    registerSchemas(defsFor(PERSON, 'Person'), ['Order', 'Person'])
    await createResource('orders').options('personId')
    registerSchemas(defsFor(named('Named'), 'Named'), ['Order', 'Named'])
    await createResource('orders').options('personId')

    // `name` and `title` are right often enough that warning about them would
    // teach everyone to skip the message.
    expect(said()).not.toContain('@@label')
  })

  test('and silent when the caller stated the column itself', async () => {
    registerSchemas(defsFor(UNNAMED, 'Unnamed'), ['Order', 'Unnamed'])
    await createResource('orders').options('personId', { labelField: 'lastName' })
    expect(said()).not.toContain('@@label')
  })
})
