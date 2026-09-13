// The residue tripwire, and the seventh dimension it found.
//
// `diffSchemas` compares an enumerated list of dimensions. Six issues of this
// package's history are one dimension arriving in the DDL emitter and not in
// that list, each one reading "in sync" over a database that is not the
// declared one. The tripwire is the catch-all underneath: once the enumeration
// has had its say, the two `sqlite_master`s are compared whole.
//
// Every assertion here is a PAIR — a difference beside an identical database —
// because a tripwire that fires on everything reports the same thing as one
// that works, from the firing side.
import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { tempDir } from '../src/tmp-dirs.js'
import { parse } from '../src/core/parser.js'
import { buildPristine, introspect, diffSchemas, normalizeDdl, summarizeDiff } from '../src/core/migrate.js'
import { autoMigrate } from '../src/core/migrations.js'

const SCHEMA = `
model Account {
  id    String @id
  email String @unique
}
`

const rel = (onUpdate: string | null) => `
model Author {
  id    String @id
  name  String
  books Book[]
}
model Book {
  id       String @id
  title    String
  authorId String
  author   Author @relation(fields: [authorId], references: [id], onDelete: Cascade${onUpdate ? `, onUpdate: ${onUpdate}` : ''})
}
`

/** A live database built by hand, diffed against the schema's pristine one. */
function against(schemaText: string, handmade: string[]) {
  const parsed = parse(schemaText, { path: '/x/db/schema.lite' })
  const dir    = tempDir('litestone-residue-')
  const live   = new Database(join(dir, 'live.db'))
  const pris   = new Database(join(dir, 'pristine.db'))
  for (const stmt of handmade) live.run(stmt)
  buildPristine(pris, parsed)
  const diff = diffSchemas(introspect(pris), introspect(live), parsed, 'main', {})
  return { diff, live, parsed }
}

const AS_DECLARED = `CREATE TABLE "account" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL UNIQUE) STRICT`

describe('the residue tripwire', () => {
  it('names a dimension the enumeration cannot read — and says nothing about the same database declared', () => {
    // COLLATE is the adoption door's case: a real database has one, this
    // language cannot say it, so no enumeration will ever grow to cover it.
    const bad = against(SCHEMA, [
      `CREATE TABLE "account" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL UNIQUE COLLATE NOCASE) STRICT`,
    ])
    expect(bad.diff.hasChanges).toBe(false)
    expect(bad.diff.residue).toHaveLength(1)
    expect(bad.diff.residue[0].name).toBe('account')
    expect(bad.diff.residue[0].live).toContain('COLLATE NOCASE')
    expect(bad.diff.residue[0].pristine).not.toContain('COLLATE')

    const good = against(SCHEMA, [AS_DECLARED])
    expect(good.diff.hasChanges).toBe(false)
    expect(good.diff.residue).toEqual([])
  })

  it('an index the APP owns is nobody\'s difference; one litestone owns is the ENUMERATION\'s', () => {
    // `diffIndexes` deliberately never drops an index litestone did not name.
    // A tripwire that overturned that from behind would report every app index
    // in every database as a difference nobody can act on.
    const app = against(SCHEMA, [AS_DECLARED, `CREATE INDEX "by_email_lower" ON "account" (lower("email"))`])
    expect(app.diff.hasChanges).toBe(false)
    expect(app.diff.residue).toEqual([])

    // The same index under a name litestone owns is already spoken for — and
    // the residue must not say it a second time, or every real migration comes
    // with a leftover attached to it.
    const ours = against(SCHEMA, [AS_DECLARED, `CREATE INDEX "idx_account_whatever" ON "account" ("email")`])
    expect(ours.diff.hasChanges).toBe(true)
    expect(ours.diff.residue).toEqual([])
  })

  it('says nothing the enumeration already said — an index whose COLLATE or sort moved is read, not left over', () => {
    const withIndex = `
model Account {
  id    String @id
  email String
  @@index([email])
}
`
    const table = `CREATE TABLE "account" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL) STRICT`
    for (const live of [
      `CREATE INDEX "idx_account_email" ON "account" ("email" COLLATE NOCASE)`,
      `CREATE INDEX "idx_account_email" ON "account" ("email" DESC)`,
    ]) {
      const { diff } = against(withIndex, [table, live])
      expect(diff.hasChanges).toBe(true)
      expect(diff.residue).toEqual([])
    }

    const same = against(withIndex, [table, `CREATE INDEX "idx_account_email" ON "account" ("email")`])
    expect(same.diff.hasChanges).toBe(false)
    expect(same.diff.residue).toEqual([])
  })

  it('is not part of hasChanges — a difference nothing can migrate must not migrate every boot', () => {
    const { diff } = against(SCHEMA, [
      `CREATE TABLE "account" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL UNIQUE COLLATE NOCASE) STRICT`,
    ])
    expect(diff.residue.length).toBeGreaterThan(0)
    expect(diff.hasChanges).toBe(false)
  })

  it('reaches the summary, where "in sync — no changes needed" was the false sentence', () => {
    const bad  = against(SCHEMA, [`CREATE TABLE "account" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL UNIQUE COLLATE NOCASE) STRICT`])
    const good = against(SCHEMA, [AS_DECLARED])
    expect(summarizeDiff(bad.diff)).toContain('COLLATE NOCASE')
    expect(summarizeDiff(good.diff)).toBe('✓ schema is in sync — no changes needed')
  })
})

describe('normalizeDdl', () => {
  it('does not report the spacing ALTER TABLE ADD COLUMN leaves behind', () => {
    // Measured before it was written: 162 of 694 objects across the corpus
    // schemas differ by exactly this after a real v1 → v2 migration, and not
    // one of them is a difference.
    const created = `CREATE TABLE "t" ( "a" TEXT NOT NULL, "b" INTEGER ) STRICT`
    const altered = `CREATE TABLE "t" ( "a" TEXT NOT NULL , "b" INTEGER) STRICT`
    expect(normalizeDdl(created)).toBe(normalizeDdl(altered))
  })

  it('still reports a difference that is one', () => {
    expect(normalizeDdl(`CREATE TABLE "t" ("a" TEXT)`))
      .not.toBe(normalizeDdl(`CREATE TABLE "t" ("a" TEXT COLLATE NOCASE)`))
  })
})

describe('a column added anywhere but last — FJS-1092', () => {
  // `ALTER TABLE ADD COLUMN` can only append, so a field declared in the middle of
  // a model lands at the END of the live table and the declared table has it in
  // the middle. The two differ by position and nothing else, and the tripwire read
  // that as residue on every boot of every app that upgraded the model — which
  // is how a tripwire trains its readers to skip the line that is a real one.
  const v1 = `
model Credential {
  id        String   @id
  type      String
  createdAt DateTime @default(now())
}
`
  const v2 = `
model Credential {
  id           String   @id
  type         String
  lastStep     Int?
  createdAt    DateTime @default(now())
}
`
  const migrate = (a: string, b: string) => {
    const dir  = tempDir('litestone-position-')
    const live = new Database(join(dir, 'live.db'))
    autoMigrate({ $rawDbs: { main: live } } as any, parse(a, { path: '/x/db/schema.lite' }))
    const out  = autoMigrate({ $rawDbs: { main: live } } as any, parse(b, { path: '/x/db/schema.lite' }))
    return { out: out.main, live, parsed: parse(b, { path: '/x/db/schema.lite' }) }
  }

  it('a field declared mid-model migrates and leaves NO residue behind', () => {
    const { live, parsed } = migrate(v1, v2)
    const sql = (live.query(`SELECT sql FROM sqlite_master WHERE name='credential'`).get() as { sql: string }).sql
    // The premise, asserted rather than assumed: the live column really is last.
    expect(sql.trimEnd().replace(/\)\s*STRICT$/i, '').trimEnd().endsWith('"lastStep" INTEGER')).toBe(true)

    const dir  = tempDir('litestone-position-p-')
    const pris = new Database(join(dir, 'pristine.db'))
    buildPristine(pris, parsed)
    expect(diffSchemas(introspect(pris), introspect(live), parsed, 'main', {}).residue).toEqual([])
  })

  it('…and the same table with a column that REALLY differs is still named', () => {
    const { diff } = against(SCHEMA, [
      `CREATE TABLE "account" ("email" TEXT NOT NULL UNIQUE COLLATE NOCASE, "id" TEXT NOT NULL PRIMARY KEY) STRICT`,
    ])
    expect(diff.residue.map((r: any) => r.name)).toEqual(['account'])
  })

  it('a residue an older reading RECORDED goes quiet on the fast path — the collation one below still re-announces', () => {
    // The fast path replays what the last full diff stored while the schema hash
    // holds still, so without a re-grade every database that heard the position
    // verdict once would go on hearing it on every boot.
    const { live, parsed } = migrate(v1, v2)
    const shim   = { $rawDbs: { main: live } } as any
    const pSql   = `CREATE TABLE "credential"("id" TEXT NOT NULL PRIMARY KEY,"lastStep" INTEGER,"createdAt" TEXT)STRICT`
    const lSql   = `CREATE TABLE "credential"("id" TEXT NOT NULL PRIMARY KEY,"createdAt" TEXT,"lastStep" INTEGER)STRICT`
    live.run(`INSERT INTO "_litestone_meta" (key, value) VALUES ('autoMigrate.residue', ?)
              ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
             JSON.stringify([{ type: 'table', name: 'credential', table: 'credential', pristine: pSql, live: lSql }]))

    expect(autoMigrate(shim, parsed).main.residue).toBeUndefined()
    expect(live.query(`SELECT value FROM "_litestone_meta" WHERE key = 'autoMigrate.residue'`).get()).toBeNull()
  })

  it('…and the declared columns in another ORDER are not', () => {
    const { diff } = against(SCHEMA, [
      `CREATE TABLE "account" ("email" TEXT NOT NULL UNIQUE, "id" TEXT NOT NULL PRIMARY KEY) STRICT`,
    ])
    expect(diff.residue).toEqual([])
  })
})

describe('a foreign key\'s ON UPDATE — the seventh missed dimension', () => {
  const migrateAcross = (v1: string | null, v2: string | null) => {
    const p1  = parse(rel(v1), { path: '/x/db/schema.lite' })
    const p2  = parse(rel(v2), { path: '/x/db/schema.lite' })
    const dir = tempDir('litestone-onupdate-')
    const live = new Database(join(dir, 'live.db'))
    autoMigrate({ $rawDbs: { main: live } } as any, p1)
    const applied = autoMigrate({ $rawDbs: { main: live } } as any, p2)
    const sql = live.query(`SELECT sql FROM sqlite_master WHERE name='book'`).get() as { sql: string }
    return { state: applied.main.state, sql: sql.sql }
  }

  it('migrates when it moves', () => {
    // `introspect` has always read onUpdate; `fkKey` dropped it, so the two
    // sides compared equal and autoMigrate answered in-sync over a foreign key
    // with the wrong action on it.
    const moved = migrateAcross('Cascade', 'Restrict')
    expect(moved.state).toBe('migrated')
    expect(moved.sql).toContain('ON UPDATE RESTRICT')
  })

  it('migrates when it appears', () => {
    const added = migrateAcross(null, 'Cascade')
    expect(added.state).toBe('migrated')
    expect(added.sql).toContain('ON UPDATE CASCADE')
  })

  it('migrates NOTHING when it did not move — the control that keeps the fix from being a rebuild on every boot', () => {
    expect(migrateAcross('Cascade', 'Cascade').state).toBe('in-sync')
    expect(migrateAcross(null, null).state).toBe('in-sync')
  })
})

describe('autoMigrate carries the residue', () => {
  const withCollation = () => {
    const parsed = parse(SCHEMA, { path: '/x/db/schema.lite' })
    const dir    = tempDir('litestone-residue-boot-')
    const live   = new Database(join(dir, 'live.db'))
    live.run(`CREATE TABLE "account" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL UNIQUE COLLATE NOCASE) STRICT`)
    return { shim: { $rawDbs: { main: live } } as any, parsed }
  }

  it('re-announces off the FAST PATH, which is where saying it once would go quiet', () => {
    const { shim, parsed } = withCollation()
    const first  = autoMigrate(shim, parsed)          // the full diff
    const second = autoMigrate(shim, parsed)          // the ddlHash fast path
    expect(first.main.state).toBe('in-sync')
    expect(first.main.residue).toHaveLength(1)
    expect(second.main.residue).toHaveLength(1)
  })

  it('goes quiet when the caller states it, and stays quiet', () => {
    const { shim, parsed } = withCollation()
    autoMigrate(shim, parsed)
    expect(autoMigrate(shim, parsed, { acceptResidue: true }).main.residue).toBeUndefined()
    expect(autoMigrate(shim, parsed).main.residue).toBeUndefined()
  })

  it('says nothing at all about a database it built itself', () => {
    const parsed = parse(SCHEMA, { path: '/x/db/schema.lite' })
    const dir    = tempDir('litestone-residue-clean-')
    const shim   = { $rawDbs: { main: new Database(join(dir, 'live.db')) } } as any
    expect(autoMigrate(shim, parsed).main.residue).toBeUndefined()
    expect(autoMigrate(shim, parsed).main.residue).toBeUndefined()
  })
})
