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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse } from '../src/core/parser.js'
import { splitStatements } from '../src/core/migrate.js'
import { create, apply, status, autoMigrate, appliedMigrations } from '../src/core/migrations.js'

const V1 = `
model Post {
  id     Int    @id
  title  String
  views  Int    @default(0)
}
`

const freshLab = () => {
  const dir = mkdtempSync(join(tmpdir(), 'litestone-mig-'))
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
