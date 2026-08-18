// `@transient` — the payload key the API accepts and nothing stores.
//
// The gap it closes: a wire-only field was a convention held by a hook and a
// comment (`FJS-D23`). Nothing could tell one from a typo, nothing documented
// it, and the symptom of forgetting the hook was the service reporting the
// field as *missing* on a request that carried it.
//
// It is the mirror of `@computed`, and the two split by direction:
//
//              column   caller writes   caller reads
//   @computed   no       no              yes
//   @transient  no       yes             no
//   @system     yes      no              yes
//   @guarded    yes      no              no
//
// Two rules this suite exists to hold. **It has no column anywhere** — not in
// the DDL, not in a filter, not in a sort, not in a policy — because SQLite
// reads an identifier it cannot bind as a string literal, so every one of those
// would answer plausibly and wrongly. And **the value is refused HERE by name**:
// the Data boundary is where a transient value should never arrive, and the
// message names the place it should have been read from instead.

import { describe, it, expect } from 'bun:test'
import { createClient, generateJsonSchema, ValidationError } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'

const SCHEMA = `
model Channel {
  id     Int      @id
  name   String   @unique
  secret String?  @transient @length(4, 64) @label("Credential")
  note   String?
}

model Signup {
  id     Int    @id
  email  String
  invite String @transient
}
`

const client = () => createClient({ schema: SCHEMA, db: ':memory:' })
const decl   = (attrs: string) => parse(`model T { id Int @id  c String? ${attrs} }`)

describe('the declaration', () => {

  it('parses, and takes no argument — a field is stored or it is not', () => {
    expect(decl('@transient').valid).toBe(true)

    const bad = decl('@transient(all)')
    expect(bad.valid).toBe(false)
    expect(bad.errors.join(' ')).toMatch(/takes no arguments/)
  })

  it('composes with the validators — that is most of the point', () => {
    // A declared field is validated like any other, so the wording written once
    // in the schema is what the server and the browser both say.
    expect(decl('@transient @length(4, 64) @label("Credential")').valid).toBe(true)
    expect(decl('@transient @email').valid).toBe(true)
    expect(decl('@transient @regex("^sk-")').valid).toBe(true)
  })

  it('refuses every attribute that describes storage, by name', () => {
    for (const [attrs, why] of [
      ['@transient @unique',            /uniqueness is a property of a column/],
      ['@transient @default("x")',      /a default fills a column/],
      ['@transient @encrypted',         /ciphertext is what gets stored/],
      ['@transient @guarded',           /@guarded locks the write/],
      ['@transient @system',            /opposite ends/],
      ['@transient @computed',          /read-only or write-only, not both/],
      ['@transient @updatedAt',         /no stored value for a write to stamp/],
      ['@transient @omit',              /never in a result/],
    ] as const) {
      const r = decl(attrs)
      expect(r.valid).toBe(false)
      expect(r.errors.join(' ')).toMatch(why)
    }
  })

  it("refuses @allow beside it — the rule would be declared and never evaluated", () => {
    const r = decl(`@transient @allow('write', auth().isAdmin)`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/never reaches the Data boundary/)
  })

  it('refuses a model attribute that names it — there is nothing to index', () => {
    const r = parse(`model T { id Int @id  c String? @transient  @@index([c]) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/@@index names 'c', which is @transient/)
  })

  it('refuses a policy that reads it — the read would compile to a string constant', async () => {
    // Judged when the client is built, with every other predicate whose answer
    // no row can satisfy: a policy naming a column that does not exist reads as
    // an empty table rather than as an error.
    await expect(createClient({
      db:     ':memory:',
      schema: `model T {
        id    Int    @id
        owner String @transient
        @@allow('read', owner == auth().id)
      }`,
    })).rejects.toThrow(/is @transient/)
  })
})

describe('it has no column anywhere', () => {

  it('is absent from the DDL', () => {
    const ddl = generateDDL(parse(SCHEMA).schema!, {})
    expect(ddl).toContain('"name"')
    expect(ddl).not.toContain('"secret"')
    expect(ddl).not.toContain('"invite"')
  })

  it('cannot be filtered by, and the refusal says why', async () => {
    const db = await client()
    // A write's where-key check THROWS (a read's warns) — same split as any
    // other unusable key.
    await expect(db.channel.updateMany({ where: { secret: 'x' } as any, data: { note: 'n' } }))
      .rejects.toThrow(/@transient/)

    const [problem] = db.$checkWhere('channel', { secret: 'x' })
    expect(problem.reason).toBe('transient')
    expect(problem.message).toMatch(/no column to filter by/)
  })

  it('cannot be sorted by — a wrong sort returns the right rows in the wrong order', async () => {
    const db = await client()
    const [problem] = db.$checkOrderBy('channel', { secret: 'asc' })
    expect(problem.reason).toBe('transient')

    await expect(db.channel.findMany({ orderBy: { secret: 'asc' } as any }))
      .rejects.toThrow(/@transient/)
  })

  it('is absent from a row', async () => {
    const db = await client()
    await db.channel.create({ data: { name: 'ops' } })
    const row = await db.channel.findUnique({ where: { id: 1 } })
    expect('secret' in row).toBe(false)
  })
})

describe('the write is refused here, by name', () => {

  it('names ctx.transients rather than dropping the key', async () => {
    const db = await client()
    const p  = db.channel.create({ data: { name: 'alerts', secret: 'hunter2' } as any })

    await expect(p).rejects.toThrow(ValidationError)
    await expect(p).rejects.toThrow(/is @transient/)
    await expect(p).rejects.toThrow(/ctx\.transients/)
  })

  it('on update too', async () => {
    const db = await client()
    await db.channel.create({ data: { name: 'page' } })
    await expect(db.channel.update({ where: { id: 1 }, data: { secret: 'x' } as any }))
      .rejects.toThrow(/is @transient/)
  })

  it('and a REQUIRED one does not make the model uncreatable', async () => {
    // The API asks the caller for it; nothing below the boundary can, because
    // there is no column for a NOT NULL to catch. A write that never carries it
    // is the normal case, not a missing field.
    const db = await client()
    const row = await db.signup.create({ data: { email: 'a@b.test' } })
    expect(row.email).toBe('a@b.test')
  })
})

describe('the wire schema is the mirror of @computed', () => {

  const defs = (mode: 'create' | 'update' | 'full') =>
    (generateJsonSchema(parse(SCHEMA).schema!, { mode }) as any).$defs.Channel.properties

  it('is in the write modes, marked writeOnly', () => {
    for (const mode of ['create', 'update'] as const) {
      expect(defs(mode).secret.writeOnly).toBe(true)
      expect(defs(mode).secret['x-litestone-kind']).toBe('transient')
      // Validators travel with it — one wording, both sides of the wire.
      // Optional, so the rules sit inside the anyOf that carries the null branch.
      expect(defs(mode).secret.anyOf[0].minLength).toBe(4)
      expect(defs(mode).secret.title).toBe('Credential')
    }
  })

  it('is absent from the read shape — nothing ever answers it', () => {
    expect(defs('full').secret).toBeUndefined()
  })

  it('is required OF THE CALLER when it is not optional', () => {
    const created = (generateJsonSchema(parse(SCHEMA).schema!, { mode: 'create' }) as any).$defs.Signup
    expect(created.required).toContain('invite')

    // …and never on update, where every field is optional by construction.
    const updated = (generateJsonSchema(parse(SCHEMA).schema!, { mode: 'update' }) as any).$defs.Signup
    expect(updated.required ?? []).not.toContain('invite')
  })
})
