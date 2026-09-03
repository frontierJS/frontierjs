// Regression tests for the migration executor fix chain:
//   1. rebuildSQL copies only columns the old table has (added columns are
//      filled by DEFAULT/NULL, never selected from the old table — SQLite
//      resolves unknown double-quoted identifiers as string literals).
//   2. splitStatements treats a bare BEGIN as a transaction statement; only
//      CREATE TRIGGER opens a BEGIN...END body.
//   3. apply()/autoMigrate() own the transaction: ROLLBACK on failure, no
//      partial state, bookkeeping committed atomically, FK pragma restored.
import { describe, it, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, mkdtempSync, rmSync } from 'fs'
import { tempDir } from '../src/tmp-dirs.js'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse } from '../src/core/parser.js'
import { splitStatements, parseChecks } from '../src/core/migrate.js'
import { createClient } from '../src/index.js'
import { create, apply, status, autoMigrate, appliedMigrations,
         listMigrationFiles, nextMigrationName } from '../src/core/migrations.js'

const V1 = `
model Post {
  id     Int    @id
  title  String
  views  Int    @default(0)
}
`

const freshLab = () => {
  const dir = tempDir('litestone-mig-')
  const db  = new Database(join(dir, 'lab.db'))
  return { dir: join(dir, 'migrations'), db }
}

const seedV1 = async (db: Database, dir: string) => {
  const pr1 = parse(V1)
  expect(pr1.valid).toBe(true)
  create(db, pr1, 'initial', dir)
  await apply(db, dir)
  db.run(`INSERT INTO post (title, views) VALUES ('Hello', 42), ('World', 7)`)
}

describe('splitStatements — transaction BEGIN vs trigger body', () => {
  it('splits a transaction-wrapped migration into individual statements', () => {
    const stmts = splitStatements(
      `PRAGMA foreign_keys = OFF;\nBEGIN;\nCREATE TABLE a (id INTEGER);\nINSERT INTO a VALUES (1);\nCOMMIT;\nPRAGMA foreign_keys = ON;`
    )
    expect(stmts).toHaveLength(6)
    expect(stmts[1]).toBe('BEGIN')
    expect(stmts[4]).toBe('COMMIT')
  })

  it('keeps a CREATE TRIGGER body (including CASE...END) as one statement', () => {
    const stmts = splitStatements(
      `CREATE TRIGGER trg AFTER INSERT ON a FOR EACH ROW BEGIN ` +
      `UPDATE a SET n = CASE WHEN new.n > 0 THEN 1 ELSE 0 END; ` +
      `DELETE FROM b; END;\nSELECT 1;`
    )
    expect(stmts).toHaveLength(2)
    expect(stmts[0]).toContain('CREATE TRIGGER')
    expect(stmts[0]).toContain('DELETE FROM b')
    expect(stmts[1]).toBe('SELECT 1')
  })
})

describe('rebuild migrations — data survives', () => {
  it('rebuild with an added nullable column preserves rows and NULLs the new column', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)

    const pr2 = parse(`
model Post {
  id     Int     @id
  title  String
  bio    String?
}
`)
    expect(pr2.valid).toBe(true)
    const made = create(db, pr2, 'evolve', dir)
    expect(made.created).toBe(true)
    // The copy step must not name the added column
    expect(made.sql).not.toMatch(/SELECT[^;]*"bio"/)

    const res = await apply(db, dir)
    expect(res.failed).toBeUndefined()

    const rows = db.query(`SELECT * FROM post ORDER BY id`).all() as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: 1, title: 'Hello', bio: null })
    expect(rows[1]).toEqual({ id: 2, title: 'World', bio: null })
  })

  it('rebuild with an added @default column fills the default for existing rows', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)

    const pr2 = parse(`
model Post {
  id     Int    @id
  title  String
  stars  Int    @default(5)
}
`)
    create(db, pr2, 'stars', dir)
    const res = await apply(db, dir)
    expect(res.failed).toBeUndefined()

    const rows = db.query(`SELECT id, stars FROM post ORDER BY id`).all() as Record<string, unknown>[]
    expect(rows).toEqual([{ id: 1, stars: 5 }, { id: 2, stars: 5 }])
  })

  it('rebuild adding a NOT NULL column with no default is BLOCKED — data and old shape intact', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)

    const pr2 = parse(`
model Post {
  id     Int    @id
  title  String
  rating Int
}
`)
    const made = create(db, pr2, 'blocked', dir)
    expect(made.created).toBe(true)
    expect(made.sql).toContain('BLOCKED')

    const res = await apply(db, dir)
    expect(res.failed).toBeUndefined()   // applies as a recorded no-op

    const cols = db.query(`PRAGMA table_info(post)`).all().map((c: { name: string }) => c.name)
    expect(cols).toContain('views')      // old shape untouched
    expect(cols).not.toContain('rating')
    expect((db.query(`SELECT COUNT(*) c FROM post`).get() as { c: number }).c).toBe(2)
  })
})

// ─── The copy is checked before the original is dropped (FJS-D09) ─────────────
//
// A rebuild is INSERT…SELECT then DROP TABLE. A copy that read fewer rows than
// the original holds is not an error to SQLite or to the runner, and one
// statement later the rows it missed are gone.

describe('rebuild — the row count is asserted before the drop', () => {
  const V2_DROPS_A_COLUMN = `
model Post {
  id     Int    @id
  title  String
}
`

  it('the generated rebuild carries the guard, named for the table', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)

    const made = create(db, parse(V2_DROPS_A_COLUMN), 'drop_views', dir)
    expect(made.sql).toContain('_litestone_rowcount')
    expect(made.sql).toContain('rebuild of post lost rows')
    // Before the DROP, or it is describing rows that no longer exist.
    expect(made.sql!.indexOf('_litestone_rowcount')).toBeLessThan(made.sql!.indexOf('DROP TABLE "post"'))
  })

  it('a copy that loses rows fails the migration and leaves the table whole', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)

    const made = create(db, parse(V2_DROPS_A_COLUMN), 'drop_views', dir)
    // A migration file is meant to be reviewed and edited — this is the edit
    // that used to destroy a row and report success.
    const tampered = readFileSync(made.filePath!, 'utf8')
      .replace(/ SELECT (.*) FROM "post";/, ' SELECT $1 FROM "post" WHERE "id" > 1;')
    expect(tampered).toContain('WHERE "id" > 1')
    writeFileSync(made.filePath!, tampered, 'utf8')

    const res = await apply(db, dir)
    expect(res.failed).toBe(made.name)
    expect(res.error).toContain('rebuild of post lost rows')

    const rows = db.query(`SELECT id, title, views FROM post ORDER BY id`).all()
    expect(rows).toEqual([
      { id: 1, title: 'Hello', views: 42 },
      { id: 2, title: 'World', views: 7 },
    ])
    expect(appliedMigrations(db).map(m => m.name)).not.toContain(made.name)
  })
})

// ─── Filename order is apply order (FJS-D09) ──────────────────────────────────
//
// The clock is second-granular and nothing else records when a file was
// written, so two migrations made inside one second either overwrite each other
// (same label) or apply in alphabetical order (different labels).

describe('migration filenames', () => {
  it('sort in creation order even when three are made in the same second', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)                                        // "initial"

    const evolve = create(db, parse(`
model Post {
  id     Int     @id
  title  String
  bio    String?
}
`), 'evolve', dir)
    await apply(db, dir)

    const again = create(db, parse(`
model Post {
  id     Int     @id
  title  String
  bio    String?
  stars  Int     @default(1)
}
`), 'again', dir)

    // Alphabetically this is again, evolve, initial — the reverse of the order
    // they have to run in.
    const files = listMigrationFiles(dir)
    expect(files).toHaveLength(3)
    expect(files[1]).toBe(evolve.name)
    expect(files[2]).toBe(again.name)
  })

  it('name after the last file in the directory, not after the clock', () => {
    const { dir } = freshLab()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '29990101000000_future.sql'), '')

    expect(nextMigrationName(dir, 'next')).toBe('29990101000001_next.sql')
  })

  it('never hand back a name that is already taken', () => {
    const { dir } = freshLab()
    mkdirSync(dir, { recursive: true })

    const first = nextMigrationName(dir, 'same')
    writeFileSync(join(dir, first), '')
    const second = nextMigrationName(dir, 'same')

    expect(second).not.toBe(first)
    expect(second > first).toBe(true)
  })
})

describe('apply — failure atomicity', () => {
  it('rolls back everything, records nothing, restores FK pragma, leaves connection clean', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)

    writeFileSync(join(dir, '20990101000001_bad.sql'), [
      `CREATE TABLE ok1 (id INTEGER);`,
      `INSERT INTO ok1 VALUES (1);`,
      `INSERT INTO ok1 VALUES ('x', 'y', 'z');`,   // fails: 1 column, 3 values
      `CREATE TABLE ok2 (id INTEGER);`,
    ].join('\n'))

    const res = await apply(db, dir)
    expect(res.failed).toBe('20990101000001_bad.sql')
    expect(res.error).toBeTruthy()

    const tables = db.query(`SELECT name FROM sqlite_master WHERE type='table'`).all()
      .map((r: { name: string }) => r.name)
    expect(tables).not.toContain('ok1')            // rolled back, not partially applied
    expect(tables).not.toContain('ok2')
    expect(appliedMigrations(db).map(m => m.name)).not.toContain('20990101000001_bad.sql')

    expect((db.query(`PRAGMA foreign_keys`).get() as { foreign_keys: number }).foreign_keys).toBe(1)
    db.run('BEGIN'); db.run('ROLLBACK')            // no open transaction left behind

    // Retry still sees it as pending and fails the same way — no half state
    const again = await apply(db, dir)
    expect(again.failed).toBe('20990101000001_bad.sql')
  })
})

describe('autoMigrate — same guarantees', () => {
  it('rebuild via autoMigrate preserves data', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)

    const pr2 = parse(`
model Post {
  id     Int     @id
  title  String
  bio    String?
}
`)
    // `views` goes and `bio` arrives, so this is a destructive change and is
    // refused by default since `FJS-641`. The flag is what this test is NOT
    // about: its subject is that a rebuild carries the SURVIVING values across,
    // so it says the loss is intended and then asserts `title` came through.
    expect(autoMigrate({ $db: db }, pr2).main.state).toBe('blocked')

    const res = autoMigrate({ $db: db }, pr2, { acceptDataLoss: true })
    expect(res.main.state).toBe('migrated')

    const rows = db.query(`SELECT * FROM post ORDER BY id`).all() as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ id: 1, title: 'Hello', bio: null })
  })

  it('blocked rebuild reports state: blocked, touches nothing, and stays blocked (no hash write)', async () => {
    const { dir, db } = freshLab()
    await seedV1(db, dir)

    const pr2 = parse(`
model Post {
  id     Int    @id
  title  String
  rating Int
}
`)
    const first = autoMigrate({ $db: db }, pr2)
    expect(first.main.state).toBe('blocked')
    expect(first.main.reason).toContain('rating')

    const cols = db.query(`PRAGMA table_info(post)`).all().map((c: { name: string }) => c.name)
    expect(cols).toContain('views')
    expect(cols).not.toContain('rating')
    expect((db.query(`SELECT COUNT(*) c FROM post`).get() as { c: number }).c).toBe(2)

    const second = autoMigrate({ $db: db }, pr2)
    expect(second.main.state).toBe('blocked')     // hash was not written — still surfaces
  })
})

// ─── A file the name pattern rejects (FJS-193) ────────────────────────────────
//
// The ordering guarantee comes from the 14-digit timestamp, so the pattern
// cannot be loosened. What it must not do is read "none of these matched" as
// "there are none" — that is a deploy migrating nothing and reporting success.

describe('unmatched migration files are named, never silently skipped', () => {
  it('apply() refuses a directory whose files all fail the name pattern', async () => {
    const { dir, db } = freshLab()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '001_initial_schema.sql'), 'CREATE TABLE t (id INTEGER);')

    const res = await apply(db, dir)

    expect(res.unmatched).toBe(true)
    expect(res.skipped).toEqual(['001_initial_schema.sql'])
    expect(res.message).toContain('001_initial_schema.sql')
    expect(res.message).not.toBe('no migration files found')
    // The table it names is the proof nothing ran.
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 't'`).get()).toBeNull()
  })

  it('an empty directory is still an empty directory', async () => {
    const { dir, db } = freshLab()
    mkdirSync(dir, { recursive: true })

    const res = await apply(db, dir)

    expect(res.unmatched).toBeUndefined()
    expect(res.skipped).toEqual([])
    expect(res.message).toBe('no migration files found')
  })

  it('a valid migration still applies, and the misnamed sibling is reported', async () => {
    const { dir, db } = freshLab()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '20240101000000_init.sql'), 'CREATE TABLE t (id INTEGER);')
    writeFileSync(join(dir, 'backfill.sql'),            'CREATE TABLE u (id INTEGER);')

    const res = await apply(db, dir)

    expect(res.applied.map((r: { file: string }) => r.file)).toEqual(['20240101000000_init.sql'])
    expect(res.skipped).toEqual(['backfill.sql'])
    expect(res.unmatched).toBeUndefined()
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'u'`).get()).toBeNull()
  })

  it('status() reports the same file apply() skipped', async () => {
    const { dir, db } = freshLab()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '001_initial_schema.sql'), 'CREATE TABLE t (id INTEGER);')

    const rows = status(db, dir)

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ file: '001_initial_schema.sql', state: 'skipped' })
  })

  it('a non-migration file in the directory is not a candidate', async () => {
    const { dir, db } = freshLab()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'README.md'), '# how migrations work here')

    const res = await apply(db, dir)

    expect(res.skipped).toEqual([])
    expect(res.message).toBe('no migration files found')
  })
})

// ─── FJS-466 ────────────────────────────────────────────────────────────────
//
// A CHECK constraint was never compared. The diff read columns, indexes,
// foreign keys and STRICT; this file's own header has listed *change CHECK* as
// a full-rebuild trigger since it was written, and nothing implemented it.
//
// The case is an enum gaining a member, which is the commonest schema change
// there is: SQLite has no ENUM type, so litestone enforces one with
// `CHECK (col IN (...))`, and that text is frozen at CREATE TABLE. The new
// member reached the DDL, the snapshot, and every generated form — and every
// write of it was refused at runtime with SQLite's words about a constraint.
//
// The narrowing direction is deliberately asserted too. It is NOT the
// fail-open twin it looks like: litestone's own validator refuses a value the
// enum no longer declares before any SQL is built, so a removed member stops
// being writable whether the constraint migrated or not.

describe('a CHECK constraint migrates (FJS-466)', () => {

  const MOOD_V1 = `
    enum Mood { happy sad }
    model Note { id Int @id  mood Mood @default(happy)  body String }
  `
  const MOOD_V2 = `
    enum Mood { happy sad furious }
    model Note { id Int @id  mood Mood @default(happy)  body String }
  `

  /** Open at v1, write a row, migrate to v2, hand back the live client. */
  const grown = async (from: string, to: string) => {
    const dir = tempDir('litestone-check-')
    const path = join(dir, 'check.db')
    const a = await createClient({ db: path, schema: from })
    autoMigrate(a)
    await a.note.create({ data: { mood: 'sad', body: 'before' } })
    await a.$close()

    const b = await createClient({ db: path, schema: to })
    autoMigrate(b)
    return b
  }

  it('a new enum member is writable after the migration', async () => {
    const db = await grown(MOOD_V1, MOOD_V2)
    const row = await db.note.create({ data: { mood: 'furious', body: 'after' } })
    expect(row.mood).toBe('furious')
    await db.$close()
  })

  it('the rebuild keeps the rows that were already there', async () => {
    const db = await grown(MOOD_V1, MOOD_V2)
    const rows = await db.note.findMany({}) as Array<{ mood: string; body: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ mood: 'sad', body: 'before' })
    await db.$close()
  })

  it('a removed enum member stops being writable — the validator, not the CHECK', async () => {
    const db = await grown(MOOD_V2, MOOD_V1)
    await expect(db.note.create({ data: { mood: 'furious', body: 'x' } })).rejects.toThrow(/furious/)
    await db.$close()
  })

  it('an unchanged enum migrates nothing — no rebuild on every boot', async () => {
    const dir  = tempDir('litestone-check-')
    const path = join(dir, 'stable.db')
    const a = await createClient({ db: path, schema: MOOD_V2 })
    autoMigrate(a)
    await a.$close()

    // The second open must find the schema in sync. A CHECK compared by text
    // is exactly the shape that rebuilds forever if the two sides spell it
    // differently, and a rebuild nobody asked for is worse than a diff that
    // says nothing.
    const b = await createClient({ db: path, schema: MOOD_V2 })
    const result = autoMigrate(b)
    expect(result?.applied ?? 0).toBe(0)
    await b.$close()
  })

  it('parseChecks reads a column-level and a table-level constraint alike', () => {
    const sql = `CREATE TABLE "n" (
      "id" INTEGER PRIMARY KEY,
      "mood" TEXT NOT NULL CHECK ("mood" IN ('happy', 'sad')),
      "tags" TEXT,
      CHECK (json_valid("tags") AND json_type("tags") = 'array')
    )`
    expect(parseChecks(sql)).toEqual([
      `"mood" IN ('happy', 'sad')`,
      `json_valid("tags") AND json_type("tags") = 'array'`,
    ].sort())
  })
})

/**
 * A blocked column add reports `blocked`, on the ALTER path as well as the
 * rebuild one (`FJS-604`).
 *
 * The hole was narrow and the consequence was not: adding one NOT NULL column
 * with no default to a populated table does not need a rebuild, so the diff
 * collected it as `blockedAdds` and `autoMigrate` looked only at the rebuild
 * list. The SQL generator wrote the ALTER out as a comment — correctly — and
 * the run reported `migrated` with `applied: 0`. An application then ran
 * against a table missing a column its own seed declares, and every write of
 * that column was stripped by mass-assignment protection.
 */
describe('a blocked column add is reported, not reported as success', () => {
  test('the ALTER path answers `blocked` and applies nothing', async () => {
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-blocked-'))
    const path = join(dir, 'b.db')
    const v1 = `database main { path "${path}" }\nmodel Doc { id Int @id @default(autoincrement())  n String }`
    const v2 = `database main { path "${path}" }\nmodel Doc { id Int @id @default(autoincrement())  n String  dueAt DateTime }`

    const a = await createClient({ schema: v1, resolveFrom: dir })
    autoMigrate(a)
    await a.doc.create({ data: { n: 'one' } })

    const b = await createClient({ schema: v2, resolveFrom: dir })
    const out = autoMigrate(b) as Record<string, { state: string, reason?: string }>

    expect(out.main.state).toBe('blocked')
    expect(out.main.reason).toMatch(/doc\.dueAt/)
    // The negative control: `migrated` with `applied: 0` was the old answer, and
    // it is indistinguishable from a schema that had nothing to do.
    expect(out.main).not.toHaveProperty('applied')
    rmSync(dir, { recursive: true, force: true })
  })

  test('an OPTIONAL column on the same table still migrates', async () => {
    // The rule has to be about the column, not about the path — otherwise the
    // fix above turns every ordinary column add into a refusal.
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-blocked-ok-'))
    const path = join(dir, 'b.db')
    const v1 = `database main { path "${path}" }\nmodel Doc { id Int @id @default(autoincrement())  n String }`
    const v2 = `database main { path "${path}" }\nmodel Doc { id Int @id @default(autoincrement())  n String  dueAt DateTime? }`

    const a = await createClient({ schema: v1, resolveFrom: dir })
    autoMigrate(a)
    await a.doc.create({ data: { n: 'one' } })

    const b = await createClient({ schema: v2, resolveFrom: dir })
    const out = autoMigrate(b) as Record<string, { state: string }>
    expect(out.main.state).toBe('migrated')
    expect(await b.doc.findFirst({})).toHaveProperty('dueAt', null)
    rmSync(dir, { recursive: true, force: true })
  })
})

/**
 * An EXPRESSION default routes through the rebuild, because `ALTER TABLE ADD
 * COLUMN` cannot take one (`FJS-605`).
 *
 * SQLite allows an expression default in `CREATE TABLE` and refuses it in an
 * ALTER, where it wants a constant. `@default(now())` emits
 * `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`, so the generated ALTER
 * threw `near "(": syntax error` out of `autoMigrate` — naming no column, no
 * table and no schema line, at application boot.
 *
 * The rebuild path already did the right thing: it omits added columns from the
 * copy, so the new table's own DEFAULT fills them for every existing row. What
 * was missing was the classification.
 */
describe('an expression default cannot be ALTERed in', () => {
  test('it rebuilds instead of throwing, and existing rows get the value', async () => {
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-exprdefault-'))
    const path = join(dir, 'e.db')
    const v1 = `database main { path "${path}" }\nmodel Doc { id Int @id @default(autoincrement())  n String }`
    const v2 = `database main { path "${path}" }\nmodel Doc { id Int @id @default(autoincrement())  n String  dueAt DateTime @default(now()) }`

    const a = await createClient({ schema: v1, resolveFrom: dir })
    autoMigrate(a)
    await a.doc.create({ data: { n: 'one' } })

    const b = await createClient({ schema: v2, resolveFrom: dir })
    const out = autoMigrate(b) as Record<string, { state: string }>
    expect(out.main.state).toBe('migrated')

    const row = await b.doc.findFirst({}) as { dueAt: string }
    // The row that existed BEFORE the column did has a value, which is the
    // whole reason a rebuild is the right path rather than a refusal.
    expect(typeof row.dueAt).toBe('string')
    expect(Number.isNaN(Date.parse(row.dueAt))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('a CONSTANT default still takes the cheap ALTER', async () => {
    // The negative control. Treating every default as an expression would
    // rebuild every table that gains an ordinary column, which is slow and
    // takes the app's own indexes and triggers with it (`FJS-183`).
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-constdefault-'))
    const path = join(dir, 'c.db')
    const v1 = `database main { path "${path}" }\nmodel Doc { id Int @id @default(autoincrement())  n String }`
    const v2 = `database main { path "${path}" }\nmodel Doc { id Int @id @default(autoincrement())  n String  hits Int @default(0) }`

    const a = await createClient({ schema: v1, resolveFrom: dir })
    autoMigrate(a)
    await a.doc.create({ data: { n: 'one' } })

    const b = await createClient({ schema: v2, resolveFrom: dir })
    const out = autoMigrate(b) as Record<string, { state: string, sql?: string }>
    expect(out.main.state).toBe('migrated')
    expect(out.main.sql).toMatch(/ALTER TABLE "doc" ADD COLUMN "hits"/)
    expect(out.main.sql).not.toMatch(/rebuild "doc"/)
    rmSync(dir, { recursive: true, force: true })
  })
})

// ─── destructive changes ──────────────────────────────────────────────────────
//
// `diffColumns` is a name-set diff with no rename detection, so a rename is a
// drop plus an add and the rebuild copies only what the two tables share
// (`FJS-641`). Three shapes had three behaviours and two of them were silent:
// a rename destroyed values reporting `migrated`, a plain drop did the same,
// and a type change SQLite could not satisfy threw a raw `SQLiteError` out of
// `autoMigrate` and killed the app at boot (`FJS-645`).
//
// The negative control is the point of every case here: `keep` is asserted to
// survive alongside, because a migration that refused everything would look
// identical from the refused side.

describe('autoMigrate — a change that destroys data', () => {
  const D1 = `model Doc { id Int @id @default(autoincrement())  body String?  keep String? }`
  const lab = async (schema = D1) => {
    const dir = tempDir('litestone-loss-')
    const db  = await createClient({ schema, db: join(dir, 'a.db'), resolveFrom: dir })
    autoMigrate(db, parse(schema))
    await db.doc.create({ data: { body: 'the payload', keep: 'kept' } })
    return db
  }
  const rows = (db: any) => db.asSystem().sql`SELECT * FROM doc`

  it('blocks a rename, and says what it thinks you meant', async () => {
    const db = await lab()
    const r  = autoMigrate(db, parse(`model Doc { id Int @id @default(autoincrement())  content String?  keep String? }`))
    expect(r.main.state).toBe('blocked')
    expect(r.main.dataLoss).toEqual([{ table: 'doc', columns: ['body'], renameTo: 'content' }])
    expect((await rows(db))[0].body).toBe('the payload')
    db.$close()
  })

  it('blocks a plain drop too — it is the same mechanism and equally silent', async () => {
    const db = await lab()
    const r  = autoMigrate(db, parse(`model Doc { id Int @id @default(autoincrement())  keep String? }`))
    expect(r.main.state).toBe('blocked')
    expect(r.main.dataLoss[0].renameTo).toBe(null)   // nothing was added, so no guess
    expect((await rows(db))[0].body).toBe('the payload')
    db.$close()
  })

  it('re-announces on the next boot rather than going quiet', async () => {
    // The hash is withheld, which is what the two older blocked rules do and
    // what stops a blocked schema from looking in-sync a moment later.
    const db = await lab()
    const V2 = parse(`model Doc { id Int @id @default(autoincrement())  keep String? }`)
    expect(autoMigrate(db, V2).main.state).toBe('blocked')
    expect(autoMigrate(db, V2).main.state).toBe('blocked')
    db.$close()
  })

  it('applies it when the caller says the loss is intended', async () => {
    const db = await lab()
    const r  = autoMigrate(db, parse(`model Doc { id Int @id @default(autoincrement())  keep String? }`),
                           { acceptDataLoss: true })
    expect(r.main.state).toBe('migrated')
    const after = await rows(db)
    expect('body' in after[0]).toBe(false)
    expect(after[0].keep).toBe('kept')      // the control: only the named column went
    db.$close()
  })

  it('does not block a change that takes nothing away', async () => {
    const db = await lab()
    const r  = autoMigrate(db, parse(`model Doc { id Int @id @default(autoincrement())  body String?  keep String?  extra String? }`))
    expect(r.main.state).toBe('migrated')
    expect((await rows(db))[0].body).toBe('the payload')
    db.$close()
  })

  it('grades a rebuild SQLite refuses instead of throwing out of the migrator', async () => {
    // A STRICT table takes no TEXT into an INTEGER column, so the copy fails.
    // The transaction rolls back either way — what was missing is that the
    // caller heard about it in the same vocabulary as the other refusals.
    const db = await lab()
    const r  = autoMigrate(db, parse(`model Doc { id Int @id @default(autoincrement())  body Int?  keep String? }`))
    expect(r.main.state).toBe('failed')
    expect(r.main.reason).toContain('SQLite refused the rebuild')
    expect((await rows(db))[0].body).toBe('the payload')
    db.$close()
  })
})

describe('create — a destructive migration is banner-marked in the file', () => {
  it('names the columns whose values the file will delete', async () => {
    // The file IS the review step here, which is why this warns rather than
    // refusing: the header already listed `- col body` at the same weight as
    // every other line of the diff.
    const { dir, db } = freshLab()
    create(db, parse(V1), 'initial', dir)
    await apply(db, dir)
    db.run(`INSERT INTO post (title, views) VALUES ('Hello', 42)`)

    create(db, parse(`model Post { id Int @id  heading String  views Int @default(0) }`), 'rename', dir)
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    const sql   = readFileSync(join(dir, files[files.length - 1]), 'utf8')
    expect(sql).toContain('DESTRUCTIVE')
    expect(sql).toContain('post.title')
    expect(sql).toContain('RENAME COLUMN "title" TO "heading"')
  })

  it('leaves an additive migration unmarked', async () => {
    const { dir, db } = freshLab()
    create(db, parse(V1), 'initial', dir)
    await apply(db, dir)
    create(db, parse(`model Post { id Int @id  title String  views Int @default(0)  extra String? }`), 'add', dir)
    const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    expect(readFileSync(join(dir, files[files.length - 1]), 'utf8')).not.toContain('DESTRUCTIVE')
  })
})
