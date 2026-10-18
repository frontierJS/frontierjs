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
import { generateDDL } from '../src/core/ddl.js'

const SCHEMA = `
model Order {
  id           Int      @id
  reference    String   @unique
  trackingCode String?  @system
  note         String?
  @@gate(2.4.4.5)
}

model Key {
  id        Int    @id
  name      String
  tokenHint String @system
  @@gate(0)
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
    expect(parse(`model T { id Int @id  c String? @guarded @system }`).valid).toBe(true)
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

  // FJS-1937: `message` crosses junction's boundary as the 403 body, so it names
  // the column and nothing a caller cannot act on; the remedy is the server-side `hint`.
  it('the message names the column and the hint says how to write it', async () => {
    const db = await client()
    try {
      await db.$setAuth(USER).order.create({ data: { reference: 'C', trackingCode: 'X' } })
      throw new Error('should have refused')
    } catch (err: any) {
      expect(err.message).toContain('"trackingCode"')
      expect(err.message).not.toContain('asSystem')
      expect(err.message).not.toContain('system: [')
      expect(err.hint).toContain(`system: ['trackingCode']`)
      expect(err.hint).toContain('asSystem()')
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

// `FJS-1212`. The ladder writes the fixture as its caller would, and the
// application names a `@system` column through `system: [...]`. Passed as
// ordinary data it is refused with an AccessDeniedError — which the ladder
// then counted as the gate's deny at every level.
describe('a required @system column on the gate ladder', () => {
  it('the ladder is clean', async () => {
    const { createTestEnv } = await import('../src/testing.js')
    const env = await createTestEnv({ schema: `
model Booking {
  id     Int    @id
  hostId Int    @system
  note   String
  @@gate(0)
}
` })
    expect(await env.verifyGateLadder()).toEqual([])
  })
})

// `FJS-1487`. The fixture is built as SYSTEM, which stamps nobody, and fills
// every optional column on the default value of a discriminated model. A
// required `@createdBy` and a variant column's field `@check` each took the
// model's writes — and every model below it — off the ladder as ungraded.
describe('fixtures the ladder can build for an ordinary schema', () => {
  it('a required @createdBy and a field @check leave the ladder clean', async () => {
    const { createTestEnv } = await import('../src/testing.js')
    const env = await createTestEnv({ schema: `
model Page {
  id      Int    @id
  ownerId String @createdBy
  title   String
  @@gate(0)
}
model Block {
  id      Int      @id
  type    String   @default("paragraph")
  checked Boolean? @check("type = 'todo' OR checked IS NULL")
  @@gate(0)
}
model Application {
  id          Int    @id
  candidateId Int    @immutable
  candidate   Candidate @relation(fields: [candidateId], references: [id])
  @@gate(0)
}
model Candidate {
  id   Int    @id
  name String
  @@gate(0)
}
model Document {
  id   Int  @id
  file File @accept("application/pdf")
  @@gate(0)
}
` })
    expect(await env.verifyGateLadder()).toEqual([])
  })
})

// `@@mirror(key:)` writes `@system` into every stored column but `@local`, the
// key's `@immutable` and `@unique`, and `missingSince` (`FJS-D843`). A Provider's
// column a caller could write is one the next sync overwrites in silence, so the
// refusal is the derivation's whole job and is graded through a real client.
describe('a @@mirror model', () => {
  const MIRROR = `
model Post {
  id         Int      @id
  externalId String
  message    String
  status     PostStatus @default(open)
  starred    Boolean  @default(false) @local
  @@gate(0)
  @@mirror(key: externalId)
}
enum PostStatus { open closed }
model Credit {
  id         Int    @id
  accountId  String
  externalId String
  crewId     Int?   @local
  @@unique([accountId, externalId])
  @@mirror(key: externalId)
}`
  const kinds = (model: string, field: string) =>
    parse(MIRROR).schema.models.find((m: any) => m.name === model).fields.find((f: any) => f.name === field)?.attributes.map((a: any) => a.kind)

  it('derives @system on every stored column but @local, and the key @immutable and @unique', () => {
    expect(kinds('Post', 'message')).toEqual(['system'])
    expect(kinds('Post', 'externalId')).toEqual(['system', 'immutable', 'unique'])
    expect(kinds('Post', 'starred')).toEqual(['default', 'local'])
    expect(kinds('Post', 'missingSince')).toEqual(['system'])
  })

  it('leaves the key to a @@unique that already names it, so two accounts may hold one Provider id', () => {
    expect(kinds('Credit', 'externalId')).toEqual(['system', 'immutable'])
  })

  it('refuses a caller writing a Provider column by name, and takes a @local one', async () => {
    const db = await createClient({ schema: MIRROR, db: ':memory:' })
    await expect(db.post.create({ data: { externalId: 'p1', message: 'hi' } })).rejects.toThrow('"externalId", "message" are @system')
    const row = await db.asSystem().post.create({ data: { externalId: 'p1', message: 'hi' } })
    expect(row.missingSince).toBe(null)
    await expect(db.post.update({ where: { id: row.id }, data: { message: 'x' } })).rejects.toThrow('"message" is @system')
    expect((await db.post.update({ where: { id: row.id }, data: { starred: true } })).starred).toBe(true)
    await expect(db.asSystem().post.update({ where: { id: row.id }, data: { externalId: 'p2' } })).rejects.toThrow('@immutable')
  })

  // The Provider sends a child before its parent, so its reference is the
  // Provider's to keep; a @local key is the app's and keeps the constraint.
  it('lands a child before its parent, and keeps the foreign key a @local column holds', async () => {
    const REL = `
model Channel { id Int @id  externalId String  posts Post[]  @@mirror(key: externalId)  @@allow('read', true) }
model Crew    { id Int @id  posts Post[] }
model Post {
  id                Int     @id
  externalId        String
  channelExternalId String
  channel           Channel @relation(fields: [channelExternalId], references: [externalId])
  crewId            Int?    @local
  crew              Crew?   @relation(fields: [crewId], references: [id])
  @@mirror(key: externalId)
  @@allow('read', check(channel))
}`
    const db = await createClient({ schema: REL, db: ':memory:' })
    const sys = db.asSystem()
    await sys.post.create({ data: { externalId: 'p1', channelExternalId: 'c1' } })
    expect((await sys.post.findFirst({ where: { externalId: 'p1' }, include: { channel: true } })).channel).toBe(null)
    // A dangling key is not a null one (FJS-3130): no parent row, so check() refuses.
    expect(await db.$setAuth({ id: 'u' }).post.findMany()).toEqual([])
    await sys.channel.create({ data: { externalId: 'c1' } })
    expect((await db.$setAuth({ id: 'u' }).post.findMany()).length).toBe(1)
    expect((await sys.post.findFirst({ where: { externalId: 'p1' }, include: { channel: true } })).channel.externalId).toBe('c1')
    await expect(sys.post.create({ data: { externalId: 'p2', channelExternalId: 'c1', crewId: 9 } })).rejects.toThrow('names no Crew')
  })

  it('reaches the client as readOnly where the Provider owns the column', () => {
    const props = generateJsonSchema(parse(MIRROR).schema, { mode: 'update' }).$defs.Post.properties
    expect(props.message.readOnly).toBe(true)
    expect(props.starred.readOnly).toBeUndefined()
  })

  it('asks a mirror for no state machine, since its status moves where the Provider moves it', async () => {
    const { checkOpportunities } = await import('../src/core/opportunities.js')
    expect(checkOpportunities(parse(MIRROR).schema).filter(o => o.id === 'enum-column-with-no-state-machine')).toEqual([])
  })

  for (const [why, src, says] of [
    ['@local off a mirror', `model T { id Int @id  c String @local }`, 'T is not @@mirror'],
    ['@local on the key', `model T { id Int @id  k String @local  @@mirror(key: k) }`, '@local is on the key'],
    ['@local beside @system', `model T { id Int @id  k String  c String @local @system  @@mirror(key: k) }`, '@local and @system disagree'],
    ['a declared missingSince', `model T { id Int @id  k String  missingSince DateTime?  @@mirror(key: k) }`, "derives the column 'missingSince'"],
    ['an optional key', `model T { id Int @id  k String?  @@mirror(key: k) }`, "'k' is optional"],
    ['onDelete on a Provider-keyed relation', `model P { id Int @id  k String  cs C[]  @@mirror(key: k) }
model C { id Int @id  k String  pk String  p P @relation(fields: [pk], references: [k], onDelete: Cascade)  @@mirror(key: k) }`, "relation 'p' is keyed by the Provider's ids"],
  ] as const) {
    it(`refuses ${why}`, () => {
      const r = parse(src)
      expect(r.valid).toBe(false)
      expect(r.errors.join('\n')).toContain(says)
    })
  }
})

// `FJS-D1177`. A reference the database cannot promise, written by an author:
// what `@@mirror` sets on a Provider-keyed relation, and what a mirror leaves
// behind once it stops — a reply whose root was past the history cap.
describe('@relation(enforced: false)', () => {
  const SRC = (arg: string) => `
model Post {
  id      Int     @id
  key     String  @unique
  rootKey String?
  root    Post?   @relation("thread", fields: [rootKey], references: [key]${arg})
  replies Post[]  @relation("thread")
}`

  it('emits no foreign key, so a dangling reference lands and reads as no row', async () => {
    expect(generateDDL(parse(SRC('')).schema)).toContain('FOREIGN KEY')
    expect(generateDDL(parse(SRC(', enforced: false')).schema)).not.toContain('FOREIGN KEY')
    const db = await createClient({ schema: SRC(', enforced: false'), db: ':memory:' })
    await db.post.create({ data: { key: 'reply', rootKey: 'gone' } })
    expect((await db.post.findFirst({ where: { key: 'reply' }, include: { root: true } })).root).toBe(null)
  })

  for (const [why, src, says] of [
    ['enforced: true', SRC(', enforced: true'), 'what every relation already is'],
    ['onDelete beside it', SRC(', enforced: false, onDelete: Cascade'), 'onDelete would act on nothing'],
    ['the side with no fields', SRC('').replace('@relation("thread")', '@relation("thread", enforced: false)'), "belongs on the side that names fields"],
  ] as const) {
    it(`refuses ${why}`, () => {
      const r = parse(src)
      expect(r.valid).toBe(false)
      expect(r.errors.join('\n')).toContain(says)
    })
  }
})

// `FJS-D1178`. Deleting `@@mirror` deletes what it derived: the key's unique,
// which every relation over it needs, and `missingSince` with its values. The
// exit writes the derivation out, and the claim is that no table changes.
describe('litestone mirror exit', () => {
  const MIRRORED = `model Channel {
  id         Int    @id
  externalId String
  posts      Post[]
  @@mirror(key: externalId)
}

model Crew {
  id    Int    @id
  posts Post[]
}

model Post {
  id                Int     @id
  externalId        String
  channelExternalId String
  channel           Channel @relation(fields: [channelExternalId], references: [externalId]) // the Provider's
  message           String
  crewId            Int?    @local
  crew              Crew?   @relation(fields: [crewId], references: [id])
  @@mirror(key: externalId)
}

model Credit {
  id         Int    @id
  accountId  String
  externalId String
  @@unique([accountId, externalId])
  @@mirror(key: externalId)
}
`
  const exit = async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { mirrorExit } = await import('../src/mirror-exit.js')
    const file = join(mkdtempSync(join(tmpdir(), 'mirror-exit-')), 'schema.lite')
    writeFileSync(file, MIRRORED)
    return mirrorExit(file)
  }

  it('writes the key unique, missingSince and each Provider reference unenforced, and nothing else', async () => {
    const { text, models } = await exit()
    expect(models).toEqual(['Channel', 'Post', 'Credit'])
    expect(text).not.toContain('@@mirror')
    expect(text).not.toContain('@local')
    expect(text).toContain('  externalId String @unique\n  posts      Post[]\n  missingSince DateTime?\n')
    expect(text).toContain('references: [externalId], enforced: false) // the Provider\'s')
    expect(text).toContain('@relation(fields: [crewId], references: [id])\n')
    // A key a @@unique already names gets no unique of its own.
    expect(text).toContain('  externalId String\n  missingSince DateTime?\n  @@unique([accountId, externalId])')
  })

  it('changes no table, and the app may now write what the Provider wrote', async () => {
    const { text } = await exit()
    expect(generateDDL(parse(text).schema)).toBe(generateDDL(parse(MIRRORED).schema))
    const db = await createClient({ schema: text, db: ':memory:' })
    const row = await db.post.create({ data: { externalId: 'p1', channelExternalId: 'gone', message: 'hi' } })
    expect((await db.post.update({ where: { id: row.id }, data: { message: 'edited' } })).message).toBe('edited')
  })
})
