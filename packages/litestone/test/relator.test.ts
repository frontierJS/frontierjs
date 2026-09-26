// @@relator — whether a relationship may happen twice.
//
// The word exists because that question was answered eleven times across this
// workspace's two apps, in four different spellings, and stated zero times:
// `AppServer` and `AppNetwork` sit eighteen lines apart in basecamp with
// identical relata and opposite answers, and no reader can tell deliberate from
// forgotten. So the assertions that matter are not that a UNIQUE is emitted —
// they are that the declaration is the ONLY origin (a hand-written copy beside
// it is refused), that a row which cannot hold the shape is refused at parse,
// and that a relator whose relatum is already indexed does not get a second,
// dead b-tree for the privilege.
import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateModelDDL } from '../src/core/ddl.js'
import { createClient } from '../src/index.js'

const BASE = `
model Workspace { id Int @id @default(autoincrement())  members Member[] }
model User      { id Int @id @default(autoincrement())  members Member[] }
`

const member = (body: string, cols = '') => `${BASE}
model Member {
  id          Int       @id @default(autoincrement())
  workspaceId Int
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId      Int
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  seat        Int       @default(0)
  note        String?
${cols}  ${body}
}`

const errorsOf = (src: string) => {
  try { const r = parse(src); return r.valid ? [] : r.errors.map(String) }
  catch (e) { return [String((e as Error).message)] }
}
const joined = (src: string) => errorsOf(src).join('\n')

const indexesOf = (src: string, model = 'Member') => {
  const r = parse(src)
  expect(r.valid, joined(src)).toBe(true)
  const m = r.schema.models.find((x: any) => x.name === model)!
  return generateModelDDL(m, r.schema).split('\n').map(l => l.trim())
    .filter(l => /^UNIQUE |^CREATE INDEX/.test(l))
    .map(l => l.replace(/,$/, '').replace(/ IF NOT EXISTS/, ''))
    .sort()
}

// ─── the three forms ──────────────────────────────────────────────────────────

describe('what each form emits', () => {
  it('once keys the relata and indexes the end the key cannot reach', () => {
    // The UNIQUE leads with workspaceId, and an index is prefix-matched, so the
    // leading relatum needs nothing. `userId` would have none — which is
    // `FJS-413` exactly, four times over in basecamp.
    expect(indexesOf(member('@@relator([workspaceId, userId], once)'))).toEqual([
      'CREATE INDEX "idx_member_userId" ON "member" ("userId");',
      'UNIQUE ("workspaceId", "userId")',
    ])
  })

  it('many: <column> keys the relata PLUS the column that tells two apart', () => {
    expect(indexesOf(member('@@relator([workspaceId, userId], many: seat)'))).toEqual([
      'CREATE INDEX "idx_member_userId" ON "member" ("userId");',
      'UNIQUE ("workspaceId", "userId", "seat")',
    ])
  })

  it('bare many keys nothing and therefore indexes BOTH ends', () => {
    // The half the design got wrong on paper. With no unique there is no
    // prefix to ride, so the leading relatum is as unindexed as the trailing
    // one and a cascade from either side scans the child table.
    expect(indexesOf(member('@@relator([workspaceId, userId], many)'))).toEqual([
      'CREATE INDEX "idx_member_userId" ON "member" ("userId");',
      'CREATE INDEX "idx_member_workspaceId" ON "member" ("workspaceId");',
    ])
  })
})

// ─── the declaration is the only origin ───────────────────────────────────────

describe('one origin', () => {
  it('refuses a @@unique over the columns it already emits', () => {
    expect(joined(member('@@relator([workspaceId, userId], once)\n  @@unique([workspaceId, userId])')))
      .toContain('the same constraint written twice')
  })

  it('refuses a hand-written copy of the reverse index', () => {
    expect(joined(member('@@relator([workspaceId, userId], once)\n  @@index([userId])')))
      .toContain('Delete the @@index([userId])')
  })

  it('refuses an @@index the emitted key already answers by prefix', () => {
    // A second b-tree written on every row and read by nothing. basecamp's
    // WorkspaceMember carried exactly this one.
    expect(joined(member('@@relator([workspaceId, userId], once)\n  @@index([workspaceId, userId])')))
      .toContain('read by nothing')
    expect(joined(member('@@relator([workspaceId, userId], once)\n  @@index([workspaceId])')))
      .toContain('read by nothing')
  })

  it('leaves a LEADING composite alone and emits nothing beside it', () => {
    // `@@index([userId, note])` answers the reverse lookup AND more. Emitting
    // `([userId])` next to it would be the cost this word exists to stop
    // paying, arriving from the other direction. example's StockReservation is
    // this case.
    expect(indexesOf(member('@@relator([workspaceId, userId], once)\n  @@index([userId, note])'))).toEqual([
      'CREATE INDEX "idx_member_userId_note" ON "member" ("userId", "note");',
      'UNIQUE ("workspaceId", "userId")',
    ])
  })
})

// ─── repeatability is never defaulted ─────────────────────────────────────────

describe('the question must be answered', () => {
  it('refuses a bare list and names the three choices', () => {
    const e = joined(member('@@relator([workspaceId, userId])'))
    expect(e).toContain('does not say whether this relationship may happen twice')
    expect(e).toContain('once')
    expect(e).toContain('many: <column>')
  })

  it('refuses a word that is neither', () => {
    expect(joined(member('@@relator([workspaceId, userId], sometimes)')))
      .toContain("expected 'once' or 'many'")
  })

  it('refuses a column beside once', () => {
    expect(joined(member('@@relator([workspaceId, userId], once: seat)')))
      .toContain('takes no column')
  })
})

// ─── existential dependence ───────────────────────────────────────────────────

describe('a relator cannot outlive what it relates', () => {
  const optional = `${BASE}
model Member {
  id          Int        @id @default(autoincrement())
  workspaceId Int?
  workspace   Workspace? @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId      Int
  user        User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@relator([workspaceId, userId], once)
}`

  const setNull = optional.replace('onDelete: Cascade)\n  userId', 'onDelete: SetNull)\n  userId')

  it('refuses an optional relatum', () => {
    expect(joined(optional)).toContain('which is optional')
  })

  it('refuses SetNull, and says it ONCE', () => {
    // SetNull requires a nullable column, so the two tests are one mistake seen
    // from two sides. Reporting both names the symptom beside the cause.
    const e = errorsOf(setNull).filter(x => x.includes('@@relator'))
    expect(e.join('\n')).toContain('onDelete: SetNull')
    expect(e.filter(x => x.includes('which is optional'))).toEqual([])
  })

  it('takes Cascade and Restrict both', () => {
    for (const action of ['Cascade', 'Restrict']) {
      const src = member('@@relator([workspaceId, userId], once)')
        .replace(/onDelete: Cascade/g, `onDelete: ${action}`)
      expect(parse(src).valid, action).toBe(true)
    }
  })
})

// ─── what a relatum IS ────────────────────────────────────────────────────────

describe('the relata', () => {
  it('refuses a column that is not a foreign key', () => {
    expect(joined(member('@@relator([workspaceId, seat], once)')))
      .toContain('is not a foreign key column')
  })

  it('refuses one relatum — a relationship needs two things', () => {
    expect(joined(member('@@relator([workspaceId], once)'))).toContain('mediates at least two')
  })

  it('refuses two columns of ONE composite foreign key', () => {
    // A composite FK is two columns naming one thing. Counting columns instead
    // of relations would let this through.
    const src = `
model Plan { id Int  version Int  @@id([id, version])  holders Holder[] }
model Holder {
  id        Int  @id @default(autoincrement())
  planId    Int
  planVer   Int
  plan      Plan @relation(fields: [planId, planVer], references: [id, version], onDelete: Cascade)
  @@relator([planId, planVer], once)
}`
    expect(joined(src)).toContain('they all belong to one relation')
  })

  it('refuses a repeated member', () => {
    expect(joined(member('@@relator([userId, userId], once)'))).toContain('more than once')
  })
})

// ─── the discriminator ────────────────────────────────────────────────────────

describe('what tells two apart', () => {
  it('refuses one that is optional', () => {
    // Two NULLs never compare equal, so the rows leaving it unset would be
    // unconstrained — the key would silently stop being one.
    expect(joined(member('@@relator([workspaceId, userId], many: note)'))).toContain('two NULLs never compare equal')
  })

  it('refuses one that is already a relatum', () => {
    expect(joined(member('@@relator([workspaceId, userId], many: userId)'))).toContain('already a relatum')
  })

  it('refuses one that is not a column', () => {
    expect(joined(member('@@relator([workspaceId, userId], many: nope)'))).toContain("'nope' is not a column")
  })
})

// ─── it is a real constraint, not a label ─────────────────────────────────────

describe('against a live database', () => {
  it('once refuses the second membership', async () => {
    const db = await createClient({ schema: member('@@relator([workspaceId, userId], once)'), db: ':memory:' })
    await db.workspace.create({ data: {} })
    await db.user.create({ data: {} })
    await db.member.create({ data: { workspaceId: 1, userId: 1 } })
    await expect(db.member.create({ data: { workspaceId: 1, userId: 1 } })).rejects.toThrow()
  })

  it('many: <column> admits a second one under a different value', async () => {
    const db = await createClient({ schema: member('@@relator([workspaceId, userId], many: seat)'), db: ':memory:' })
    await db.workspace.create({ data: {} })
    await db.user.create({ data: {} })
    await db.member.create({ data: { workspaceId: 1, userId: 1, seat: 0 } })
    await db.member.create({ data: { workspaceId: 1, userId: 1, seat: 1 } })
    await expect(db.member.create({ data: { workspaceId: 1, userId: 1, seat: 0 } })).rejects.toThrow()
    expect(await db.member.count()).toBe(2)
  })

  it('many admits the same pair over and over', async () => {
    const db = await createClient({ schema: member('@@relator([workspaceId, userId], many)'), db: ':memory:' })
    await db.workspace.create({ data: {} })
    await db.user.create({ data: {} })
    for (let i = 0; i < 3; i++) await db.member.create({ data: { workspaceId: 1, userId: 1 } })
    expect(await db.member.count()).toBe(3)
  })
})

// ─── upsert ───────────────────────────────────────────────────────────────────
//
// The seam the word settles on the write side. `upsert`'s fast path needs ONE
// unique column, so a pair never reaches it and every relator upsert falls to
// findFirst-then-update — which on a repeatable relationship overwrites an
// earlier occurrence rather than recording a new one. Refused, not answered.

describe('upsert addressed by the relata', () => {
  const place = (rel: string) => `
model App    { id Int @id @default(autoincrement())  places Place[] }
model Server { id Int @id @default(autoincrement())  places Place[] }
model Place {
  id       Int    @id @default(autoincrement())
  appId    Int
  app      App    @relation(fields: [appId], references: [id], onDelete: Cascade)
  serverId Int
  server   Server @relation(fields: [serverId], references: [id], onDelete: Cascade)
  replica  Int    @default(0)
  note     String @default("a")
  ${rel}
}`

  const seeded = async (rel: string) => {
    const db = await createClient({ schema: place(rel), db: ':memory:' })
    await db.app.create({ data: {} })
    await db.server.create({ data: {} })
    await db.place.create({ data: { appId: 1, serverId: 1, replica: 0, note: 'first' } })
    return db
  }
  const up = (db: any, where: any) => db.place.upsert({
    where, create: { appId: 1, serverId: 1, replica: 0, note: 'new' }, update: { note: 'clobbered' },
  })

  it('refuses a bare many — the pair names no row', async () => {
    const db = await seeded('@@relator([appId, serverId], many)')
    await expect(up(db, { appId: 1, serverId: 1 })).rejects.toThrow(/may happen any number of times/)
    // and the earlier occurrence is still what it was
    expect((await db.place.findMany())[0].note).toBe('first')
  })

  it('refuses many: <column> when the where leaves the column out, and names it', async () => {
    const db = await seeded('@@relator([appId, serverId], many: replica)')
    await expect(up(db, { appId: 1, serverId: 1 })).rejects.toThrow(/names replica nowhere/)
    expect((await db.place.findMany())[0].note).toBe('first')
  })

  it('takes many: <column> once the where carries the whole key', async () => {
    const db = await seeded('@@relator([appId, serverId], many: replica)')
    await up(db, { appId: 1, serverId: 1, replica: 0 })
    const rows = await db.place.findMany()
    expect(rows.length).toBe(1)
    expect(rows[0].note).toBe('clobbered')
  })

  it('takes once by the pair — the relata ARE the conflict target', async () => {
    const db = await seeded('@@relator([appId, serverId], once)')
    await up(db, { appId: 1, serverId: 1 })
    expect((await db.place.findMany())[0].note).toBe('clobbered')
  })

  it('leaves an ordinary upsert by id alone', async () => {
    const db = await seeded('@@relator([appId, serverId], many)')
    await up(db, { id: 1 })
    expect((await db.place.findMany())[0].note).toBe('clobbered')
  })
})

// ─── the derived check ────────────────────────────────────────────────────────

describe('verifyConstraints grades the declaration', () => {
  const memberSchema = (rel: string) => member(rel)

  it('finds nothing to report when the database agrees with the word', async () => {
    const { createTestEnv } = await import('../src/testing.js')
    for (const rel of ['once', 'many', 'many: seat']) {
      const env = await createTestEnv({ schema: memberSchema(`@@relator([workspaceId, userId], ${rel})`) })
      const found = (await env.verifyConstraints()).filter((m: any) => String(m.rule ?? '').startsWith('@@relator'))
      expect(found, `${rel}: ${JSON.stringify(found)}`).toEqual([])
    }
  })
})

// ─── the workspace's own schemas ──────────────────────────────────────────────

describe("the apps that measured it", () => {
  it('basecamp and example declare every relator they have', async () => {
    const { parseFile } = await import('../src/core/parser.js')
    for (const [file, expected] of [
      ['../../basecamp/db/schema.lite', {
        WorkspaceMember: 'once', ServerNetwork: 'once', AppNetwork: 'once',
        FlagOverride: 'once', AlertRuleChannel: 'once',
        AppServer: 'many:replicaIndex', RecipeRun: 'many',
      }],
      ['../../../example/db/schema.lite', {
        CartLine: 'once', StockReservation: 'once', Subscription: 'many',
      }],
    ] as const) {
      const r = parseFile(new URL(file, import.meta.url).pathname)
      expect(r.valid, (r.errors ?? []).join('\n')).toBe(true)
      for (const [model, want] of Object.entries(expected)) {
        const m = r.schema.models.find((x: any) => x.name === model)
        const rel = m?.attributes.find((a: any) => a.kind === 'relator')
        expect(rel, `${model} declares no @@relator`).toBeDefined()
        const got = rel!.discriminator ? 'many:*' : rel!.repeat
        expect(got, model).toBe(want.startsWith('many:') ? 'many:*' : want)
      }
    }
  })
})
