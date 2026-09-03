// Who assigns the key (FJS-608).
//
// `jsonschema.js` excluded every `@id` from create mode as *server-assigned*,
// and `client.js`'s required pre-flight answered a narrower version of the same
// question. Two readers, two answers, and both wrong in opposite directions:
// the schema left out keys the caller must supply, and the pre-flight waved
// through an `Int` member of a composite key that SQLite would refuse.
//
// `isServerAssignedId` in core/ids.js is the one owner. The grid below is the
// whole of the rule, and it is asserted by RUNNING each case rather than by
// reading the helper — a create that omits the key either succeeds or does not.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'
import { generateJsonSchema } from '../src/jsonschema.js'
import { ValidationError } from '../src/core/validate.js'

const createDef = (src: string, model = 'M') =>
  generateJsonSchema(parse(src).schema, { mode: 'create' }).$defs[model]

/** Does a create that names no key succeed? Runs it. */
async function omitKey(src: string) {
  const db = await createClient({ schema: src, db: ':memory:' })
  try {
    const row = await db.m.create({ data: { x: 'a' } })
    return { assigned: true as const, row }
  } catch (e) {
    return { assigned: false as const, error: e as Error }
  } finally { await db.$close() }
}

describe('the server assigns it — the key stays out of the create schema', () => {
  const CASES: [string, string][] = [
    ['a bare `Int @id` — SQLite\'s rowid alias', `model M { id Int @id  x String }`],
    ['`@default(autoincrement())`',              `model M { id Int @id @default(autoincrement())  x String }`],
    ['`@default(uuid())`',                       `model M { id String @id @default(uuid())  x String }`],
    ['`@default(cuid())`',                       `model M { id String @id @default(cuid())  x String }`],
    ['a literal `@default`',                     `model M { id String @id @default("only")  x String }`],
  ]

  for (const [label, src] of CASES) {
    it(`${label}: assigned on a create that omits it, and absent from the schema`, async () => {
      const r = await omitKey(src)
      expect(r.assigned).toBe(true)
      expect(Object.keys(createDef(src).properties)).toEqual(['x'])
      expect(createDef(src).required).toEqual(['x'])
    })
  }
})

describe('the caller supplies it — the key is offered, and required', () => {
  const CASES: [string, string, string[]][] = [
    ['a `String @id` with no default', `model M { id String @id  x String }`,          ['id', 'x']],
    ['every member of a composite key', `model M { a String  b String  x String  @@id([a, b]) }`, ['a', 'b', 'x']],
    // The one the pre-flight got wrong. `PRIMARY KEY (a, b)` is never a rowid
    // alias, so an Int member auto-assigns nothing — it was skipped for having
    // the type of one.
    ['an INT member of a composite key', `model M { a Int  b Int  x String  @@id([a, b]) }`, ['a', 'b', 'x']],
  ]

  for (const [label, src, expected] of CASES) {
    it(`${label}: in properties and in required`, async () => {
      expect(Object.keys(createDef(src).properties)).toEqual(expected)
      expect(createDef(src).required).toEqual(expected)
    })

    it(`${label}: and omitting it is a ValidationError naming the column`, async () => {
      const r = await omitKey(src)
      expect(r.assigned).toBe(false)
      // Not SQLite's `NOT NULL constraint failed`, which names a physical table
      // and is the error shape every required field exists to avoid.
      expect(r.error).toBeInstanceOf(ValidationError)
      for (const col of expected.filter(c => c !== 'x'))
        expect(r.error.message).toContain(`${col} is required`)
    })
  }
})

describe('the two readers agree, which is the whole point of one owner', () => {
  // A schema-derived `required` that the client does not enforce is a form that
  // asks for a value nothing checks; a client refusal the schema does not
  // declare is the FJS-608 shape. Asserted as a property over the grid rather
  // than case by case.
  const ALL = [
    `model M { id Int @id  x String }`,
    `model M { id Int @id @default(autoincrement())  x String }`,
    `model M { id String @id @default(uuid())  x String }`,
    `model M { id String @id @default("only")  x String }`,
    `model M { id String @id  x String }`,
    `model M { a String  b String  x String  @@id([a, b]) }`,
    `model M { a Int  b Int  x String  @@id([a, b]) }`,
  ]

  it('a key the schema asks for is one the client refuses to do without', async () => {
    for (const src of ALL) {
      const idFields = parse(src).schema.models[0].fields
        .filter((f: any) => f.attributes.some((a: any) => a.kind === 'id'))
        .map((f: any) => f.name)
      const asked   = idFields.every((n: string) => (createDef(src).required ?? []).includes(n))
      const refused = !(await omitKey(src)).assigned
      expect([src, asked]).toEqual([src, refused])
    }
  })
})
