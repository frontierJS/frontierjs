// Regression tests for the elegance-audit fixes (2026-08-01):
//   1. @@gate is enforced by default (FrontierGateGetLevel) when declared;
//      ungated models stay completely open; a user GatePlugin overrides.
//   2. Unknown where-fields: WARN on reads (once), ERROR on writes.
//      take/skip rejected with a limit/offset pointer.
//      Unknown data keys silently stripped (mass-assignment protection).
//   3. Missing required fields on create are a ValidationError, not a raw
//      SQLite NOT NULL error.
import { describe, it, expect, afterEach } from 'bun:test'
import { createClient, GatePlugin, LEVELS, ValidationError, AccessDeniedError } from '../src/index.js'

const SCHEMA = `
enum Status { new active closed }

model Lead {
  id        Int      @id
  name      String
  email     String?  @email
  status    Status   @default(new)
  value     Float?
  createdAt DateTime @default(now())

  @@gate("0.4.4.5")
}

model Note {
  id    Int    @id
  body  String
}
`

const fresh = (opts: Record<string, unknown> = {}) =>
  createClient({ schema: SCHEMA, db: ':memory:', ...opts })

const VERIFIED = { id: 1, verifiedAt: '2026-01-01', activatedAt: '2026-01-01', role: 'user' }

describe('default gate enforcement', () => {
  it('denies an anonymous write on a @@gate model with NO GatePlugin installed', async () => {
    const db = await fresh()
    await expect(db.lead.create({ data: { name: 'Acme' } }))
      .rejects.toThrow(/requires level/)
  })

  it('allows public reads (gate position R=0) anonymously', async () => {
    const db = await fresh()
    await db.asSystem().lead.create({ data: { name: 'Acme' } })
    expect(await db.lead.findMany()).toHaveLength(1)
  })

  it('allows a verified USER (level 4) to create', async () => {
    const db = await fresh()
    const scoped = db.$setAuth(VERIFIED)
    const row = await scoped.lead.create({ data: { name: 'Acme' } })
    expect(row.name).toBe('Acme')
  })

  it('leaves models WITHOUT @@gate completely open', async () => {
    const db = await fresh()
    const row = await db.note.create({ data: { body: 'hi' } })   // anonymous, ungated
    expect(row.body).toBe('hi')
    expect(await db.note.findMany()).toHaveLength(1)
  })

  it('a user-supplied GatePlugin overrides the default resolver', async () => {
    const db = await fresh({
      plugins: [new GatePlugin({ getLevel: async () => LEVELS.SYSADMIN })],
    })
    const row = await db.lead.create({ data: { name: 'Acme' } })  // anonymous but resolver says 7
    expect(row.name).toBe('Acme')
  })

  it('asSystem() still bypasses gates', async () => {
    const db = await fresh()
    const row = await db.asSystem().lead.create({ data: { name: 'Acme' } })
    expect(row.name).toBe('Acme')
  })
})

describe('where-field validation', () => {
  const origWarn = console.warn
  afterEach(() => { console.warn = origWarn })

  it('rejects an unknown where-field in a read, and keeps the did-you-mean hint', async () => {
    const db = await fresh()
    await db.asSystem().lead.create({ data: { name: 'Acme' } })
    const warnings: string[] = []
    console.warn = (msg: string) => { warnings.push(String(msg)) }

    // It warned and executed, on the reading that a typo'd read filter was
    // merely empty. It was not empty, it was WRONG: SQLite reads the
    // unresolvable quoted identifier as a string literal, so the query asked
    // `'nam' = 'Acme'` and answered no rows (`FJS-D169`).
    await expect(db.lead.findMany({ where: { nam: 'Acme' } }))
      .rejects.toThrow(/Unknown field 'nam'.*Did you mean: name/)
    expect(warnings).toHaveLength(0)
  })

  it('rejects an unknown where-field on a write', async () => {
    const db = await fresh()
    const scoped = db.$setAuth(VERIFIED)
    await scoped.lead.create({ data: { name: 'Keep' } })

    await expect(scoped.lead.updateMany({ where: { nam: 'Keep' }, data: { name: 'Gone' } }))
      .rejects.toThrow(/Unknown field 'nam'/)
    // Nothing was touched
    const rows = await db.asSystem().lead.findMany({ where: { name: 'Keep' } })
    expect(rows).toHaveLength(1)
  })

  it('descends into AND/OR/NOT combinators', async () => {
    const db = await fresh()
    const scoped = db.$setAuth(VERIFIED)
    await expect(scoped.lead.deleteMany({ where: { OR: [{ nam: 'x' }] } }))
      .rejects.toThrow(/Unknown field 'nam'/)
  })

  it('rejects take/skip with a pointer to limit/offset', async () => {
    const db = await fresh()
    await expect(db.lead.findMany({ take: 5 })).rejects.toThrow(/'limit'/)
    await expect(db.lead.findMany({ skip: 2 })).rejects.toThrow(/'offset'/)
  })
})

describe('data-key stripping', () => {
  it('silently drops unknown keys in create data', async () => {
    const db = await fresh()
    const row = await db.asSystem().lead.create({
      data: { name: 'Acme', totallyUnknown: 'x', another: 1 },
    })
    expect(row.name).toBe('Acme')
    expect('totallyUnknown' in row).toBe(false)
  })

  it('silently drops unknown keys in update data', async () => {
    const db = await fresh()
    const sys = db.asSystem()
    const made = await sys.lead.create({ data: { name: 'Acme' } })
    const row  = await sys.lead.update({ where: { id: made.id }, data: { name: 'Two', ghost: true } })
    expect(row.name).toBe('Two')
    expect('ghost' in row).toBe(false)
  })
})

describe('required-field pre-flight', () => {
  it('missing required field on create is a ValidationError naming the field', async () => {
    const db = await fresh()
    await expect(db.asSystem().lead.create({ data: { email: 'a@b.co' } }))
      .rejects.toThrow(/name is required/)
  })

  it('a typo on a required field surfaces as required (strip + pre-flight together)', async () => {
    const db = await fresh()
    await expect(db.asSystem().lead.create({ data: { nam: 'Acme' } }))
      .rejects.toThrow(/name is required/)
  })

  it('does not fire for optional, @default, @updatedAt, or Int @id fields', async () => {
    const db = await fresh()
    const row = await db.asSystem().lead.create({ data: { name: 'Acme' } })
    expect(row.id).toBe(1)               // Int @id autoincrement
    expect(row.status).toBe('new')       // @default
    expect(row.email).toBeNull()         // optional
  })

  it('does not fire on partial updates', async () => {
    const db = await fresh()
    const sys = db.asSystem()
    const made = await sys.lead.create({ data: { name: 'Acme' } })
    const row  = await sys.lead.update({ where: { id: made.id }, data: { value: 9 } })
    expect(row.name).toBe('Acme')
  })

  it('an FK satisfied through a nested relation write does not false-positive', async () => {
    const db = await createClient({
      db: ':memory:',
      schema: `
model Account {
  id    Int    @id
  name  String
  users User[]
}
model User {
  id        Int     @id
  email     String
  account   Account @relation(fields: [accountId], references: [id])
  accountId Int
}`,
    })
    const sys = db.asSystem()
    const user = await sys.user.create({
      data: { email: 'a@b.co', account: { create: { name: 'Acme' } } },
    })
    expect(user.accountId).toBe(1)
  })
})
