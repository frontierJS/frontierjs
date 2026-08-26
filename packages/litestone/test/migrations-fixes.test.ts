// Regression tests for the migration executor fix chain:
//   1. rebuildSQL copies only columns the old table has (added columns are
//      filled by DEFAULT/NULL, never selected from the old table — SQLite
//      resolves unknown double-quoted identifiers as string literals).
//   2. splitStatements treats a bare BEGIN as a transaction statement; only
//      CREATE TRIGGER opens a BEGIN...END body.
//   3. apply()/autoMigrate() own the transaction: ROLLBACK on failure, no
//      partial state, bookkeeping committed atomically, FK pragma restored.
import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs'
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
    const res = autoMigrate({ $db: db }, pr2)
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
