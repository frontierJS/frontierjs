// Regression tests: an optional field may be OMITTED, not merely set to null.
//
// `body String?` declares two separate permissions — the value may be null, AND
// the key may be absent. Conflating them is an easy mistake to make, and an
// expensive one: almost every model has an optional field, so treating absence
// as a type violation makes almost every model impossible to create without
// sending explicit nulls for every optional column.
//
//   create({ data: { title: 'Hi' } })               must work
//   create({ data: { title: 'Hi', body: null } })   must also work
//
// Junction hit exactly this on the API side — its schema validator guarded the
// absent-value branch with `!nullable`, making it unreachable for nullable
// fields, so `POST /api/posts {"title":"Hi"}` came back
// `400 body: body must be a string`. Litestone itself was correct throughout,
// at the ORM layer and in the JSON Schema it generates.
//
// These tests exist because that correctness was UNPINNED — nothing in this
// suite asserted it, and Junction derives its validation from the schema
// generated here. If generateJsonSchema ever starts listing an optional field
// in `required`, or drops the "null" member of its type union, every FrontierJS
// app's writes break at the API boundary and nothing here would have noticed.

import { describe, it, expect } from 'bun:test'
import { createClient, generateJsonSchema, ValidationError } from '../src/index.js'

const SCHEMA = `
model Post {
  id        Int      @id
  title     String   @length(1, 20)
  body      String?
  note      String?  @length(1, 10)
  email     String?  @email
  score     Float?   @gte(0)
  tags      Json?
  at        DateTime?
  published Boolean  @default(false)
  createdAt DateTime @default(now())
}
`

const mk = () => createClient({ db: ':memory:', schema: SCHEMA })

describe('optional fields may be omitted', () => {

  it('create with only the required field', async () => {
    const db = await mk()
    const row = await db.asSystem().post.create({ data: { title: 'A' } })

    expect(row.title).toBe('A')
    // Omitted optionals read back as null, not undefined — one shape downstream.
    expect(row.body).toBeNull()
    expect(row.note).toBeNull()
    expect(row.score).toBeNull()
  })

  it('omitting an optional field that also carries a constraint', async () => {
    // @length / @email / @gte must not fire on a value that was never supplied.
    const db = await mk()
    const row = await db.asSystem().post.create({ data: { title: 'B' } })
    expect(row.email).toBeNull()
  })

  it('an explicit null is equivalent to omission', async () => {
    const db  = await mk()
    const sys = db.asSystem()

    const omitted  = await sys.post.create({ data: { title: 'C' } })
    const explicit = await sys.post.create({ data: { title: 'D', body: null, note: null } })

    expect(omitted.body).toBe(explicit.body)
    expect(omitted.note).toBe(explicit.note)
  })

  it('an explicit undefined is treated as omission', async () => {
    const db = await mk()
    const row = await db.asSystem().post.create({ data: { title: 'E', body: undefined } })
    expect(row.body).toBeNull()
  })

  it('defaults still apply when the field is omitted', async () => {
    const db = await mk()
    const row = await db.asSystem().post.create({ data: { title: 'F' } })
    expect(row.published).toBe(false)
    expect(row.createdAt).toBeDefined()
  })

  it('update need not restate optional fields', async () => {
    const db  = await mk()
    const sys = db.asSystem()
    const row = await sys.post.create({ data: { title: 'G', body: 'keep me' } })

    const updated = await sys.post.update({ where: { id: row.id }, data: { title: 'G2' } })
    expect(updated.title).toBe('G2')
    expect(updated.body).toBe('keep me')     // untouched, not nulled
  })

  it('createMany accepts rows that omit optionals', async () => {
    const db = await mk()
    const res = await db.asSystem().post.createMany({ data: [{ title: 'H' }, { title: 'I' }] })
    expect(res.count).toBe(2)
  })

  it('a scoped (non-system) client behaves the same', async () => {
    const db  = await mk()
    const row = await db.$setAuth({ userId: 'u1', role: 'user' })
      .post.create({ data: { title: 'J' } })
    expect(row.body).toBeNull()
  })

  it('omission is permitted — bad VALUES are still rejected', async () => {
    // The whole point: relaxing presence must not relax validation.
    const db = await mk()
    await expect(
      db.asSystem().post.create({ data: { title: 'K', email: 'not-an-email' } })
    ).rejects.toThrow(ValidationError)
  })

  it('a genuinely required field is still required', async () => {
    const db = await mk()
    await expect(
      db.asSystem().post.create({ data: { body: 'no title' } })
    ).rejects.toThrow(ValidationError)
  })
})

describe('generateJsonSchema describes optionality the way consumers read it', () => {

  // This is the contract Junction compiles its 400s from. Each assertion below
  // maps to a way the API layer would break if the shape drifted.

  it('optional fields are absent from `required`', async () => {
    const db = await mk()
    const def = generateJsonSchema(db.$schema).$defs.Post

    expect(def.required).toContain('title')
    for (const optional of ['body', 'note', 'email', 'score', 'tags', 'at']) {
      expect(def.required ?? []).not.toContain(optional)
    }
  })

  it('a field with a default is not required', async () => {
    const db = await mk()
    const def = generateJsonSchema(db.$schema).$defs.Post
    expect(def.required ?? []).not.toContain('published')
    expect(def.properties.published.default).toBe(false)
  })

  it('optional fields admit null in their type union', async () => {
    const db = await mk()
    const def = generateJsonSchema(db.$schema).$defs.Post
    // ['string','null'] — consumers read the non-null member as the type and
    // the presence of 'null' as nullability.
    expect(def.properties.body.type).toContain('null')
    expect(def.properties.body.type).toContain('string')
  })

  it('server-generated columns are not demanded from the client', async () => {
    const db = await mk()
    const def = generateJsonSchema(db.$schema).$defs.Post
    expect(def.required ?? []).not.toContain('id')
    expect(def.required ?? []).not.toContain('createdAt')
  })
})
