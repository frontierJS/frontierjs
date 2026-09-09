// test/typed-json-depth.test.ts
//
// `@type(T)` says the value is validated on every write. It was true at depth 0
// and at depth 0 only: a field typed as another type, and every element of an
// array, fell off the end of a chain that had arms for the builtin scalars and
// for `Json @type(Other)` and for nothing else. So `type Set { fields Def[] }`
// — the shape a LIST of anything takes — validated nothing at all, and an enum
// member was unchecked even at the top (`FJS-1030`, `FJS-1031`).
//
// The failure was silent in the direction that matters most: the JSON Schema
// emits the nested type with every constraint intact, so a generated form
// refused what the Data boundary accepted.
//
// Every refusal here is PAIRED with the same document one value different,
// because a validator that refused whole types would satisfy any test that only
// asked about the refusals — and because the depth-0 rows are the control that
// says a fix reached DOWN rather than switching everything off.
//
// Why it survived: eleven `type`s across this repo, zero nested, and zero used
// as `Json @type(T)` on a column — they are all service `input:` contracts.
// Shipped complete, never run.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse }        from '../src/core/parser.js'

const SCHEMA = `
  enum Kind { text number }

  type Leaf   { key String @regex("^[a-z]+$")  kind Kind  n Int? }
  type Single { one Leaf }
  type Many   { list Leaf[] }
  type Deep   { inner Json? @type(Many) }

  model M {
    id Int @id
    a  Json? @type(Leaf)
    b  Json? @type(Single)
    c  Json? @type(Many)
    d  Json? @type(Deep)
  }

  database main { path ":memory:" }
`

let db: any
beforeEach(async () => { db = (await createClient({ schema: SCHEMA, db: ':memory:' })).asSystem() })

const write = (data: any) => db.m.create({ data })
const refused = async (data: any) => {
  try { await write(data); return null } catch (e: any) { return e.message }
}

describe('a type inside a type', () => {
  test('depth 0 still refuses, and still accepts — the control', async () => {
    expect(await refused({ a: { key: 'BAD', kind: 'text' } })).toMatch(/must match pattern/)
    expect(await refused({ a: { key: 'ok',  kind: 'text' } })).toBeNull()
  })

  test('one level down, as an OBJECT', async () => {
    expect(await refused({ b: { one: { key: 'BAD', kind: 'text' } } })).toMatch(/b\.one\.key/)
    expect(await refused({ b: { one: { key: 'ok',  kind: 'text' } } })).toBeNull()
  })

  test('one level down, as an ARRAY, and the path names the index', async () => {
    const err = await refused({ c: { list: [{ key: 'ok', kind: 'text' }, { key: 'BAD', kind: 'text' }] } })
    expect(err).toMatch(/c\.list\.1\.key/)
    expect(await refused({ c: { list: [{ key: 'ok', kind: 'text' }] } })).toBeNull()
  })

  test('a required key MISSING one level down is still required', async () => {
    expect(await refused({ b: { one: { kind: 'text' } } })).toMatch(/b\.one\.key/)
    expect(await refused({ c: { list: [{ kind: 'text' }] } })).toMatch(/c\.list\.0\.key/)
  })

  test('two levels down, through a Json @type hop', async () => {
    expect(await refused({ d: { inner: { list: [{ key: 'BAD', kind: 'text' }] } } })).toMatch(/d\.inner\.list\.0\.key/)
    expect(await refused({ d: { inner: { list: [{ key: 'ok',  kind: 'text' }] } } })).toBeNull()
  })

  test('an empty list is not a violation', async () => {
    expect(await refused({ c: { list: [] } })).toBeNull()
  })

  test('a null ELEMENT is refused rather than skipped', async () => {
    expect(await refused({ c: { list: [null] } })).toMatch(/c\.list\.0/)
  })

  test('a list handed a scalar is still refused by the array check', async () => {
    expect(await refused({ c: { list: 'nope' } })).toMatch(/must be an array of Leaf/)
  })
})

describe('an enum inside a type', () => {
  test('a member outside the set is refused, and a member in it is not', async () => {
    expect(await refused({ a: { key: 'ok', kind: 'nope' } })).toMatch(/must be one of: text, number/)
    expect(await refused({ a: { key: 'ok', kind: 'number' } })).toBeNull()
  })

  test('and the same one level down', async () => {
    expect(await refused({ b: { one: { key: 'ok', kind: 'nope' } } })).toMatch(/b\.one\.kind/)
    expect(await refused({ c: { list: [{ key: 'ok', kind: 'nope' }] } })).toMatch(/c\.list\.0\.kind/)
  })

  test('a scalar beside it still validates — the arm did not replace the chain', async () => {
    expect(await refused({ a: { key: 'ok', kind: 'text', n: 1.5 } })).toMatch(/must be an integer/)
    expect(await refused({ a: { key: 'ok', kind: 'text', n: 2   } })).toBeNull()
  })
})

describe('a @default the column @type refuses', () => {
  const parses = (src: string) => parse(src)

  test('a default missing a required key is a parse error naming both', () => {
    const r = parses(`type T { care String }\nmodel M { id Int @id  d Json @default("{}") @type(T) }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@default\("\{\}"\) is a value @type\(T\) refuses/)
    expect(r.errors[0]).toMatch(/care: is required/)
  })

  test('the same default against an all-optional type is fine — the control', () => {
    expect(parses(`type T { care String? }\nmodel M { id Int @id  d Json @default("{}") @type(T) }`).valid).toBe(true)
  })

  test('a default that satisfies the type is fine', () => {
    expect(parses(`type T { care String }\nmodel M { id Int @id  d Json @default("{\\"care\\":\\"x\\"}") @type(T) }`).valid).toBe(true)
  })

  test('a default that is not JSON is named as such', () => {
    const r = parses(`type T { care String? }\nmodel M { id Int @id  d Json @default("nope") @type(T) }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/@default is not JSON/)
  })

  test('a Json column with no @type is not graded at all', () => {
    expect(parses(`model M { id Int @id  d Json @default("nope") }`).valid).toBe(true)
  })

  // The check calls the WRITE-PATH validator rather than restating the rule, so
  // these two are only refused because the depth fix above reached them. A
  // second implementation in the parser would have passed them.
  test('the parse check inherits the depth fix — a nested violation in a default', () => {
    const r = parses(`type L { key String }\ntype T { one L? }\nmodel M { id Int @id  d Json @default("{\\"one\\":{}}") @type(T) }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/one\.key: is required/)
  })

  test('…and an enum violation in a default', () => {
    const r = parses(`enum K { a b }\ntype T { k K? }\nmodel M { id Int @id  d Json @default("{\\"k\\":\\"zzz\\"}") @type(T) }`)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toMatch(/must be one of: a, b/)
  })
})
