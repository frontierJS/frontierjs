// test/generated-template.test.ts
//
// `@generated(`{firstName} {lastName}`)` — the second language `@generated`
// takes, and the QUOTE is what says which. Double quotes are SQL; backticks are
// a template, the string it produces. `{field}` means this row's column in
// both, so the delimiter changes only what the text AROUND the braces is.
//
// One attribute rather than two spellings: the field reads as generated,
// because that is what it is. The template compiles at parse and everything
// below sees an ordinary generated column — the DDL emitter, the write refusal,
// the unknown-field and cycle checks, filtering, sorting and the JSON Schema
// all unchanged. What this suite holds is that the compile produces the RIGHT
// SQL, because the reason to reach for a template is a null rule that is easy
// to spell wrong.
//
// The rule: **a NULL column takes the separator beside it.** Spelled by hand as
// `coalesce(a,'') || ' ' || coalesce(b,'')`, a missing middle name leaves a
// double space and a missing first name a leading one — a plausible string, no
// error, and nothing to see. Every assertion about a null field here fails
// against that spelling.

import { describe, test, expect, beforeEach } from 'bun:test'
import { createClient } from '../src/index.js'
import { parse, compileFormat } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'

const SCHEMA = `
  model Person {
    id        Int     @id
    firstName String
    middle    String?
    lastName  String?
    code      String
    year      Int

    fullName String? @generated(\`{firstName} {middle} {lastName}\`)
    ref      String? @generated(\`[{code}-{year}]\`)
    stamped  String? @generated(\`{firstName} {lastName}\`, stored)
    doubled  Float?  @generated("{year} * 2")
  }
`

let db: any
beforeEach(async () => { db = await createClient({ db: ':memory:', schema: SCHEMA }) })

describe('a backtick template — what it compiles to', () => {
  // Uniform gaps and nothing outside the fields is exactly concat_ws, which
  // drops a NULL argument together with the separator that would have followed.
  test('uniform separator compiles to concat_ws', () => {
    expect(compileFormat('{firstName} {lastName}')).toBe(`concat_ws(' ', "firstName", "lastName")`)
    expect(compileFormat('{a}|{b}|{c}')).toBe(`concat_ws('|', "a", "b", "c")`)
    expect(compileFormat('{code}-{year}')).toBe(`concat_ws('-', "code", "year")`)
  })

  // No single separator exists, so each field carries the text in front of it
  // and the pair vanishes together.
  test('mixed or outer literals compile to a coalesce chain', () => {
    expect(compileFormat('{a}, {b} {c}'))
      .toBe(`trim(coalesce("a", '') || coalesce(', ' || "b", '') || coalesce(' ' || "c", ''))`)
    expect(compileFormat('[{sku}]'))
      .toBe(`trim(coalesce('[' || "sku", '') || ']')`)
  })

  test('a literal quote is escaped, not interpolated', () => {
    expect(compileFormat(`{a}'s {b}`)).toContain(`''s `)
  })

  test('a template naming no field is refused', () => {
    expect(() => compileFormat('just text')).toThrow(/names no field/)
  })

  // The other language is untouched: a double-quoted argument is still SQL,
  // and `{field}` still expands to a quoted column inside it.
  test('a double-quoted argument is still raw SQL', () => {
    const ddl = generateDDL(parse(SCHEMA).schema)
    expect(ddl).toContain(`"doubled" REAL GENERATED ALWAYS AS ("year" * 2) VIRTUAL`)
  })

  // A template is its own token, so an attribute that wants a plain string
  // refuses one rather than quietly taking it and meaning nothing by it.
  test('a backtick is refused where a plain string is expected', () => {
    const r = parse('model T { id Int @id  a String @map(`x`) }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain('Expected STRING')
  })

  test('an unterminated template is refused by name', () => {
    expect(() => parse('model T { id Int @id  a String  v String? @generated(`{a} ) }')).toThrow(/Unterminated template/)
  })

  test('a brace that is not a field name is refused', () => {
    expect(() => compileFormat('{not a name}')).toThrow(/is not a field name/)
  })
})

describe('a backtick template — the null rule', () => {
  // The three cases the hand-spelled version gets wrong. Every expectation is
  // an exact string: a double space would pass a `toContain`.
  test('a missing interior field takes its separator with it', async () => {
    const row = await db.person.create({ data: { id: 1, firstName: 'Ada', lastName: 'Lovelace', code: 'AB', year: 1815 } })
    expect(row.fullName).toBe('Ada Lovelace')
  })

  test('a missing trailing field leaves no trailing separator', async () => {
    const row = await db.person.create({ data: { id: 2, firstName: 'Cher', code: 'EF', year: 1946 } })
    expect(row.fullName).toBe('Cher')
  })

  test('every field present reads as written', async () => {
    const row = await db.person.create({ data: { id: 3, firstName: 'Ada', middle: 'M', lastName: 'Lovelace', code: 'CD', year: 1816 } })
    expect(row.fullName).toBe('Ada M Lovelace')
  })

  test('outer literals survive and a non-string column is coerced', async () => {
    const row = await db.person.create({ data: { id: 4, firstName: 'A', code: 'XY', year: 2026 } })
    expect(row.ref).toBe('[XY-2026]')
  })
})

describe('a backtick template — it is a generated column', () => {
  test('VIRTUAL by default, STORED on request', () => {
    const ddl = generateDDL(parse(SCHEMA).schema)
    expect(ddl).toContain(`"fullName" TEXT GENERATED ALWAYS AS (concat_ws(' ', "firstName", "middle", "lastName")) VIRTUAL`)
    expect(ddl).toContain(`"stamped" TEXT GENERATED ALWAYS AS (concat_ws(' ', "firstName", "lastName")) STORED`)
  })

  test('it can be filtered and sorted by, which is the point of it being SQL', async () => {
    await db.person.create({ data: { id: 1, firstName: 'Ada',  lastName: 'Lovelace', code: 'A', year: 1 } })
    await db.person.create({ data: { id: 2, firstName: 'Cher', code: 'B', year: 2 } })
    expect((await db.person.findMany({ where: { fullName: { contains: 'Love' } } })).map((r: any) => r.id)).toEqual([1])
    expect((await db.person.findMany({ orderBy: { fullName: 'desc' } })).map((r: any) => r.id)).toEqual([2, 1])
  })

  // The refusal names @generated — which is what the schema wrote — and says
  // 'template' rather than 'expression', which is the half a reader needs to
  // know which of the two languages the field is in.
  test('a write naming it is refused, and the message says template', async () => {
    await expect(db.person.create({ data: { id: 9, firstName: 'X', code: 'C', year: 3, fullName: 'nope' } }))
      .rejects.toThrow(/is @generated — its value comes from its template/)
  })

  // Inherited from the desugar rather than reimplemented — these are the
  // existing @generated checks, and the assertion is that they still fire and
  // that they name the attribute the schema actually wrote.
  test('an unknown field reference is refused at parse', () => {
    const r = parse('model T { id Int @id  a String  v String? @generated(`{a} {nope}`) }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain(`@generated references unknown field 'nope'`)
  })

  test('a self reference is refused at parse', () => {
    const r = parse('model T { id Int @id  a String  v String? @generated(`{v}`) }')
    expect(r.valid).toBe(false)
    expect(r.errors.join('\n')).toContain(`@generated cannot reference itself`)
  })
})
