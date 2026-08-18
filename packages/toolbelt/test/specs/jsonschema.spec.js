/*
 * jsonschema.spec.js
 *
 * `make()` is what a blank record looks like, and every case below is a value
 * that reached a real form. The three that matter are the ones the older copy
 * got wrong (`FJS-059`): a `readOnly` column seeded a key the Data boundary
 * refuses by name, an enum seeded a value that is not a member of it, and a
 * foreign key seeded `0` — which is not "no customer", it is customer #0, and
 * it passes coercion and validation to be refused by SQLite as a 500.
 */

import { createMakeFromSchema, derefFieldSchema } from '../../src/jsonschema/jsonschema.js'

/* ── derefFieldSchema ──────────────────────────────────────────────── */

test('jsonschema: a $ref is followed, and the field\'s own keywords win', function () {
  const defs = { '#/$defs/Plan': { type: 'string', enum: ['free', 'pro'], default: 'free' } }
  const out = derefFieldSchema({ $ref: '#/$defs/Plan', default: 'pro' }, (r) => defs[r])
  assert.equal(out.default, 'pro', 'the field\'s @default is not shadowed by the enum\'s')
  assert.deepEqual(out.enum, ['free', 'pro'])
})

test('jsonschema: a $ref nobody can resolve answers the field\'s own keywords', function () {
  const out = derefFieldSchema({ $ref: '#/$defs/Plan', default: 'pro' }, undefined)
  assert.deepEqual(out, { default: 'pro' }, 'and the $ref itself is gone rather than left to confuse a type read')
})

test('jsonschema: anyOf follows the non-null branch and keeps an outer default', function () {
  const out = derefFieldSchema({ anyOf: [{ type: 'null' }, { type: 'integer' }], default: 3 }, undefined)
  assert.equal(out.type, 'integer')
  assert.equal(out.default, 3)
})

/* ── createMakeFromSchema ──────────────────────────────────────────── */

test('jsonschema: each type gets its own blank, and instances share nothing', function () {
  const make = createMakeFromSchema({
    name:   { type: 'string' },
    count:  { type: 'integer' },
    ratio:  { type: 'number' },
    active: { type: 'boolean' },
    tags:   { type: 'array' },
    meta:   { type: 'object' },
  })
  assert.deepEqual(make(), { name: '', count: 0, ratio: 0, active: false, tags: [], meta: {} })

  const a = make()
  const b = make()
  a.tags.push('x')
  a.meta.k = 1
  assert.deepEqual(b.tags, [], 'the array is cloned per instance')
  assert.deepEqual(b.meta, {}, 'and so is the object')
})

test('jsonschema: the server-managed columns are skipped, and the list is overridable', function () {
  const props = { id: { type: 'integer' }, createdAt: { type: 'string' }, updatedAt: { type: 'string' }, name: { type: 'string' } }
  assert.deepEqual(Object.keys(createMakeFromSchema(props)()), ['name'])
  assert.deepEqual(Object.keys(createMakeFromSchema(props, { skip: [] })()).sort(), ['createdAt', 'id', 'name', 'updatedAt'])
})

test('jsonschema: a readOnly column is not seeded at all', function () {
  // `@system`, `@computed`, `@generated` and `@from` all arrive readOnly. A key
  // in the payload for one is refused BY NAME at the Data boundary, so a form
  // that never showed the field could not submit.
  const make = createMakeFromSchema({ name: { type: 'string' }, trackingCode: { type: 'string', readOnly: true } })
  assert.deepEqual(Object.keys(make()), ['name'])
})

test('jsonschema: an enum with no default is null, not the first member', function () {
  const defs = { '#/$defs/Plan': { type: 'string', enum: ['free', 'pro'] } }
  const make = createMakeFromSchema({ plan: { $ref: '#/$defs/Plan' } }, { resolve: (r) => defs[r] })
  assert.equal(make().plan, null, 'picking a member would invent a choice nobody made')
})

test('jsonschema: an enum WITH a default takes it', function () {
  const defs = { '#/$defs/Plan': { type: 'string', enum: ['free', 'pro'], default: 'free' } }
  const make = createMakeFromSchema({ plan: { $ref: '#/$defs/Plan' } }, { resolve: (r) => defs[r] })
  assert.equal(make().plan, 'free')
})

test('jsonschema: a foreign key is null, never 0', function () {
  // 0 is a perfectly good integer, so coercion keeps it and validation approves
  // it; the first thing to object is a FOREIGN KEY constraint, as a 500.
  const make = createMakeFromSchema(
    { customerId: { type: 'integer' }, quantity: { type: 'integer' } },
    { foreignKeys: ['customerId'] },
  )
  assert.equal(make().customerId, null, 'so the required check fires in the browser instead')
  assert.equal(make().quantity, 0, 'a plain integer still gets its blank')
})

test('jsonschema: a date-time is left undefined rather than guessed', function () {
  const make = createMakeFromSchema({ dueAt: { type: 'string', format: 'date-time' } })
  assert.ok('dueAt' in make(), 'the key exists')
  assert.equal(make().dueAt, undefined, 'with no value invented for it')
})

test('jsonschema: spec wins over every default', function () {
  const make = createMakeFromSchema({ name: { type: 'string' }, count: { type: 'integer', default: 7 } })
  assert.deepEqual(make({ name: 'x', count: 0 }), { name: 'x', count: 0 })
})

test('jsonschema: something that is not a properties map does not throw', function () {
  // An enum definition used to arrive here and throw on the `in` check.
  assert.deepEqual(createMakeFromSchema(undefined)(), {})
  assert.deepEqual(createMakeFromSchema({ enum: ['a', 'b'] })(), {}, 'a non-object entry is skipped, not read')
})
