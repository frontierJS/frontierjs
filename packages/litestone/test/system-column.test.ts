// `@system` — the column an application writes and its caller does not.
//
// The gap it closes: nothing in a schema could say *the system writes this*, so
// a form generated from the schema offered a person a text box whose value a
// worker overwrote a second later (`FJS-095`), and a model whose REQUIRED
// columns are server-side could not be created from a browser at all — every
// create refused before the request, naming fields the caller was never meant
// to send.
//
// It is the orthogonal sibling of `@guarded`:
//
//              read          write
//   @guarded    system only   system only
//   @system     anyone        system only
//
// Two rules the suite exists to hold. **A refused write throws by name** — the
// client is told `readOnly` and a generated form does not offer the column, so
// a payload naming it is code that meant to write it, and a silent drop is the
// shape being fixed. And **the hatch keeps every other rule**: `system: ['col']`
// names one column, where `asSystem()` drops the gate, the row policies and the
// audit actor to write the same value.

import { describe, it, expect } from 'bun:test'
import { createClient, generateJsonSchema, AccessDeniedError, ValidationError } from '../src/index.js'
import { parse } from '../src/core/parser.js'

const SCHEMA = `
model Order {
  id           Int      @id
  reference    String   @unique
  trackingCode String?  @system
  note         String?
  @@gate("2.4.4.5")
}

model Key {
  id        Int    @id
  name      String
  tokenHint String @system
}
`

const client = () => createClient({ schema: SCHEMA, db: ':memory:' })
const USER   = { id: 1, isAdmin: true }

describe('the declaration', () => {

  it('parses, and takes no argument — it is a lock, not a level', () => {
    expect(parse(`model T { id Int @id  c String? @system }`).valid).toBe(true)

    const bad = parse(`model T { id Int @id  c String? @system(all) }`)
    expect(bad.valid).toBe(false)
    expect(bad.errors.join(' ')).toMatch(/takes no arguments/)
  })

  it('composes with @guarded — the pair could not be spelled at all before', () => {
    // Invisible to a client AND unwritable by one. `@guarded` alone answers both
    // halves for a column nobody may READ either; this is the other combination.
    expect(parse(`model T { id Int @id  c String? @guarded(all) @system }`).valid).toBe(true)
  })

  it("refuses @allow('write', …) beside it — one says nobody, the other says it depends", () => {
    const r = parse(`model T { id Int @id  c String? @system @allow('write', auth().isAdmin) }`)
    expect(r.valid).toBe(false)
    expect(r.errors.join(' ')).toMatch(/@system conflicts with @allow\('write'/)
  })

  it('refuses a field with no column to lock', () => {
    for (const decl of ['@computed', '@generated("1 + 1")']) {
      const r = parse(`model T { id Int @id  c String? ${decl} @system }`)
      expect(r.valid).toBe(false)
      expect(r.errors.join(' ')).toMatch(/nothing to lock/)
    }
  })
})

describe('the write is refused, by name', () => {

  it('on create', async () => {
    const db = await client()
    const p  = db.$setAuth(USER).order.create({ data: { reference: 'A', trackingCode: 'X' } })

    await expect(p).rejects.toThrow(AccessDeniedError)
    await expect(p).rejects.toThrow(/"trackingCode" is @system/)
  })

  it('on update', async () => {
    const db = await client()
    await db.$setAuth(USER).order.create({ data: { reference: 'B' } })

    await expect(db.$setAuth(USER).order.update({ where: { id: 1 }, data: { trackingCode: 'X' } }))
      .rejects.toThrow(/@system/)
  })

  it('and the message says how to write it', async () => {
    const db = await client()
    try {
      await db.$setAuth(USER).order.create({ data: { reference: 'C', trackingCode: 'X' } })
      throw new Error('should have refused')
    } catch (err: any) {
      expect(err.message).toContain(`system: ['trackingCode']`)
      expect(err.message).toContain('asSystem()')
    }
  })

  it('but the column reads back like any other', async () => {
    const db = await client()
    await db.$setAuth(USER).order.create({ data: { reference: 'D' } })
    await db.$setAuth(USER).order.update({ where: { id: 1 }, data: { trackingCode: 'T-1' }, system: ['trackingCode'] })

    const row = await db.$setAuth(USER).order.findUnique({ where: { id: 1 } })
    expect(row.trackingCode).toBe('T-1')      // @guarded would have stripped it
  })
})

describe('the hatch names one column and keeps every other rule', () => {

  it('writes the column it names', async () => {
    const db = await client()
    await db.$setAuth(USER).order.create({ data: { reference: 'E' } })

    const row = await db.$setAuth(USER).order.update({
      where: { id: 1 }, data: { trackingCode: 'T-2' }, system: ['trackingCode'],
    })
    expect(row.trackingCode).toBe('T-2')
  })

  it('and only that one', async () => {
    const db = await client()
    await db.$setAuth(USER).order.create({ data: { reference: 'F' } })

    await expect(db.$setAuth(USER).order.update({
      where: { id: 1 }, data: { trackingCode: 'T-3' }, system: ['note'],
    })).rejects.toThrow(/@system/)
  })

  it('the gate still refuses a caller who could not write the row at all', async () => {
    // This is the whole difference from asSystem(): one column is unlocked, not
    // the boundary. An anonymous caller is STRANGER(0) and Order wants 4.
    const db = await client()
    await db.$setAuth(USER).order.create({ data: { reference: 'G' } })

    await expect(db.$setAuth(null).order.update({
      where: { id: 1 }, data: { trackingCode: 'T-4' }, system: ['trackingCode'],
    })).rejects.toThrow(/requires level 4/)
  })

  it('asSystem() writes it too, as it writes everything', async () => {
    const db = await client()
    await db.$setAuth(USER).order.create({ data: { reference: 'H' } })

    const row = await db.asSystem().order.update({ where: { id: 1 }, data: { trackingCode: 'T-5' } })
    expect(row.trackingCode).toBe('T-5')
  })

  it('reaches every write path, not just update', async () => {
    const db = await client()
    const created = await db.$setAuth(USER).order.create({
      data: { reference: 'I', trackingCode: 'T-6' }, system: ['trackingCode'],
    })
    expect(created.trackingCode).toBe('T-6')

    const many = await db.$setAuth(USER).order.createMany({
      data: [{ reference: 'J', trackingCode: 'T-7' }], system: ['trackingCode'],
    })
    expect(many.count).toBe(1)

    await db.$setAuth(USER).order.updateMany({
      where: { reference: 'J' }, data: { trackingCode: 'T-8' }, system: ['trackingCode'],
    })
    const row = await db.$setAuth(USER).order.findFirst({ where: { reference: 'J' } })
    expect(row.trackingCode).toBe('T-8')
  })
})

describe('a REQUIRED @system column', () => {

  it('is not asked of the caller — which is what made basecamp uncreatable', async () => {
    const create = generateJsonSchema(parse(SCHEMA).schema, { mode: 'create' })
    expect(create.$defs.Key.required).toEqual(['name'])
    expect(create.$defs.Key.properties.tokenHint).toMatchObject({
      readOnly: true, 'x-litestone-kind': 'system',
    })
  })

  it('but the write still fails if the application forgets, and says which side is missing', async () => {
    const db = await client()
    const p  = db.$setAuth(USER).key.create({ data: { name: 'ci' } })

    await expect(p).rejects.toThrow(ValidationError)
    await expect(p).rejects.toThrow(/is @system and was not supplied/)
  })

  it('and lands when the application fills it', async () => {
    const db = await client()
    const row = await db.$setAuth(USER).key.create({
      data: { name: 'ci', tokenHint: 'sk_…9f2' }, system: ['tokenHint'],
    })
    expect(row.tokenHint).toBe('sk_…9f2')
  })
})

describe('what the client is told', () => {

  it('readOnly plus the kind, which is what a form generator skips on', () => {
    const create = generateJsonSchema(parse(SCHEMA).schema, { mode: 'create' })
    expect(create.$defs.Order.properties.trackingCode).toMatchObject({
      readOnly: true, 'x-litestone-kind': 'system',
    })
    // Present, not absent: a client that never hears of the column cannot
    // display the value either, and reading it is allowed.
    expect(Object.keys(create.$defs.Order.properties)).toContain('trackingCode')
  })

  it('and a schema declaring one counts as declaring access rules', async () => {
    // Which is what makes raw SQL refuse — `sql` enforces none of this.
    const db = await createClient({
      schema: `model T { id Int @id  c String? @system }`, db: ':memory:',
    })
    expect(() => db.sql`SELECT 1`).toThrow(/access rules/)
  })
})
