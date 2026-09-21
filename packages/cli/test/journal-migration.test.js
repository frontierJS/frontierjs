// ─── journal-migration.test.js — the journal moving from one format to the next ─
//
// Phase 3b-i. `formatVersion` shipped able to refuse a journal from the future
// and unable to reach the next format at all: the column was written, read and
// compared, and nothing in the codebase could move it. The DDL is
// `CREATE TABLE IF NOT EXISTS` throughout and is sent on every call, so a target
// that has deployed once holds a table the new DDL cannot reach — and the first
// thing to need reaching was one widened CHECK.
//
// Everything here runs against a REAL SQLite file through the REAL
// `core/journal-runner.mjs`, because a migration asserted as a string is
// asserted against the author's memory of SQLite. The one that matters most is
// the FOREIGN KEY control: `transition_step` cascades from `transition`, so the
// rebuild deletes every step of every transition ever recorded unless the keys
// are off — and a test that only ran the correct version could not tell the two
// apart.

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { spawnSync } from 'child_process'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { resolve } from 'path'
import { JOURNAL_FORMAT, TABLE, journalClient, JournalError, migrationPlan } from '../core/journal.js'

const ROOT   = resolve(import.meta.dir, '..')
const RUNNER = `${ROOT}/core/journal-runner.mjs`
const DDL    = readFileSync(`${ROOT}/db/ddl.snapshot.sql`, 'utf8')
const DDL_1  = readFileSync(`${import.meta.dir}/fixtures/journal-ddl-format-1.sql`, 'utf8')

const exec = (stdin) => spawnSync('bun', [RUNNER], { input: stdin, encoding: 'utf8' }).stdout

let dir
beforeEach(() => { dir = mkdtempSync(`${tmpdir()}/fjs-jmig-`) })
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

/**
 * A journal as a target that deployed before Phase 3b is holding it: the old
 * DDL, a Release, a succeeded deploy, and a step under it.
 *
 * The step is the point. It is what the cascade would take.
 */
const atFormat1 = (db) => {
  const d = new Database(db, { create: true })
  d.exec('PRAGMA foreign_keys = ON')
  d.exec(DDL_1)
  d.exec(`INSERT INTO "${TABLE.journal}" ("id","formatVersion","app","host","createdAt")
          VALUES ('journal', 1, 'shop', 'deploy@prod', '2026-01-01T00:00:00.000Z')`)
  d.exec(`INSERT INTO "${TABLE.release}" ("id","app","environment","bindingsHash","generation","schemaHash","pivot","pivotDeclared","pivotFindings","audienceKey","createdAt")
          VALUES ('r1','shop','production','bh',1,'sh','expand',0,'[]','everyone','2026-01-01T00:00:00.000Z')`)
  d.exec(`INSERT INTO "${TABLE.transition}" ("id","kind","app","environment","releaseId","generation","status","crossesPivot","plan","actor","startedAt","finishedAt")
          VALUES ('t1','deploy','shop','production','r1',1,'succeeded',0,'[]','jordan','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z')`)
  d.exec(`INSERT INTO "${TABLE.step}" ("id","transitionId","name","ordinal","status","precondition")
          VALUES ('s1','t1','06-swap',1,'succeeded','{}')`)
  d.close()
  return db
}

const open = (db) => new Database(db, { readonly: true })
const rows = (db, sql) => { const d = open(db); const r = d.query(sql).all(); d.close(); return r }
const clientFor = (db, ddl = DDL) => journalClient({ db, ddl, exec })

// ─── the fixture is the format it claims to be ───────────────────────────────

describe('the fixture', () => {
  test('is a format-1 database and refuses a pause on its own', () => {
    const db = atFormat1(`${dir}/f.db`)
    expect(rows(db, `SELECT "formatVersion" AS v FROM "${TABLE.journal}"`)[0].v).toBe(1)
    const d = new Database(db)
    // The whole reason 3b-i exists: without a migration this is what a pause
    // does on the target, mid-command.
    expect(() => d.exec(`INSERT INTO "${TABLE.transition}" ("id","kind","app","environment","releaseId","generation","status","crossesPivot","plan")
                         VALUES ('t2','pause','shop','production','r1',1,'running',0,'[]')`))
      .toThrow(/CHECK constraint/i)
    d.close()
  })
})

// ─── the walk ────────────────────────────────────────────────────────────────

describe('migrationPlan', () => {
  test('a journal already at this format has nothing to do', () => {
    expect(migrationPlan(JOURNAL_FORMAT)).toMatchObject({ ok: true, statements: [] })
  })

  test('every step ends by moving the format, guarded on the one it came from', () => {
    const plan = migrationPlan(1)
    const last = plan.statements.at(-1)
    expect(last.name).toBe('1→2:format')
    expect(last.sql).toMatch(/UPDATE .* SET "formatVersion" = \? WHERE "id" = 'journal' AND "formatVersion" = \?/)
    expect(last.params).toEqual([2, 1])
  })

  test('a format with no way forward refuses rather than skipping it', () => {
    const plan = migrationPlan(0)
    expect(plan.ok).toBe(false)
    expect(plan.reason).toContain('journal format 0')
  })

  // Invariant 8, and it costs nothing to keep asking.
  test('no statement interpolates a value', () => {
    for (const s of migrationPlan(1).statements)
      expect(s.sql).not.toMatch(/'\s*\|\|/)
  })
})

// ─── through the real runner ─────────────────────────────────────────────────

describe('opening a journal that is behind', () => {
  test('moves it forward and says so', async () => {
    const db = atFormat1(`${dir}/a.db`)
    const opened = await clientFor(db).open({ app: 'shop', host: 'deploy@prod' })
    expect(opened.migrated).toMatchObject({ from: 1, to: JOURNAL_FORMAT })
    expect(rows(db, `SELECT "formatVersion" AS v FROM "${TABLE.journal}"`)[0].v).toBe(JOURNAL_FORMAT)
  })

  test('and a pause is then a row it accepts', async () => {
    const db = atFormat1(`${dir}/b.db`)
    await clientFor(db).open({ app: 'shop', host: 'deploy@prod' })
    const d = new Database(db)
    d.exec(`INSERT INTO "${TABLE.transition}" ("id","kind","app","environment","releaseId","generation","status","crossesPivot","plan")
            VALUES ('t2','pause','shop','production','r1',1,'running',0,'[]')`)
    d.close()
    expect(rows(db, `SELECT "kind" AS k FROM "${TABLE.transition}" WHERE "id" = 't2'`)[0].k).toBe('pause')
  })

  // The one that matters. `transition_step` cascades, so the rebuild takes every
  // step of every transition ever recorded if the keys are on.
  test('the history it already held survives — transitions AND their steps', async () => {
    const db = atFormat1(`${dir}/c.db`)
    await clientFor(db).open({ app: 'shop', host: 'deploy@prod' })
    expect(rows(db, `SELECT * FROM "${TABLE.transition}"`)).toHaveLength(1)
    expect(rows(db, `SELECT * FROM "${TABLE.step}"`)).toHaveLength(1)
    expect(rows(db, `SELECT "name" AS n FROM "${TABLE.step}"`)[0].n).toBe('06-swap')
  })

  // The control for the row above. Run the SAME statements with foreign keys on
  // and the steps are gone — which is what makes the flag a fix rather than a
  // line nobody can see the effect of.
  test('with foreign keys ON the same rebuild deletes every step', async () => {
    const db = atFormat1(`${dir}/d.db`)
    const j  = clientFor(db)
    await j.send(migrationPlan(1).statements, { foreignKeys: true })
    expect(rows(db, `SELECT * FROM "${TABLE.transition}"`)).toHaveLength(1)
    expect(rows(db, `SELECT * FROM "${TABLE.step}"`)).toHaveLength(0)
  })

  test('the indexes come back with the table', async () => {
    const db = atFormat1(`${dir}/e.db`)
    await clientFor(db).open({ app: 'shop', host: 'deploy@prod' })
    const names = rows(db, `SELECT "name" AS n FROM sqlite_master WHERE type = 'index' AND tbl_name = '${TABLE.transition}'`)
      .map(r => r.n).filter(Boolean)
    expect(names).toContain('idx_transition_app_environment_startedAt')
    expect(names).toContain('idx_transition_releaseId')
    expect(names).toContain('idx_transition_status')
  })

  test('a foreign key check over the migrated file is clean', async () => {
    const db = atFormat1(`${dir}/g.db`)
    await clientFor(db).open({ app: 'shop', host: 'deploy@prod' })
    const d = new Database(db)
    expect(d.query('PRAGMA foreign_key_check').all()).toEqual([])
    d.close()
  })
})

// ─── the oracle ──────────────────────────────────────────────────────────────
//
// The migration's table definition is FROZEN in `core/journal.js` and is not
// read off the shipped DDL, because a snapshot is what the table looks like now
// and a migration is what it looked like at one format. This is what holds the
// frozen copy honest: migrate a format-1 database and compare its schema against
// one built fresh from `db/ddl.snapshot.sql`. A model change with no migration
// beside it fails here and nowhere else.

describe('a migrated database and a fresh one are the same database', () => {
  const normalize = (sql) => String(sql ?? '')
    .replace(/IF NOT EXISTS\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  test('the transition table, character for character', async () => {
    const migrated = atFormat1(`${dir}/m.db`)
    await clientFor(migrated).open({ app: 'shop', host: 'deploy@prod' })

    const fresh = `${dir}/n.db`
    await clientFor(fresh).open({ app: 'shop', host: 'deploy@prod' })

    const sqlOf = (db) => normalize(
      rows(db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${TABLE.transition}'`)[0].sql)

    expect(sqlOf(migrated)).toBe(sqlOf(fresh))
  })

  test('and every other table, so a migration cannot fix one and break another', async () => {
    const migrated = atFormat1(`${dir}/m2.db`)
    await clientFor(migrated).open({ app: 'shop', host: 'deploy@prod' })
    const fresh = `${dir}/n2.db`
    await clientFor(fresh).open({ app: 'shop', host: 'deploy@prod' })

    const shape = (db) => Object.fromEntries(
      rows(db, `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
        .map(r => [r.name, normalize(r.sql)]))

    expect(shape(migrated)).toEqual(shape(fresh))
  })
})

// ─── a reader does not migrate ───────────────────────────────────────────────

describe('migrate: false', () => {
  test('reports the format it found and writes nothing', async () => {
    const db = atFormat1(`${dir}/r.db`)
    const opened = await clientFor(db).open({ app: 'shop', host: 'deploy@prod', migrate: false })
    expect(opened.verdict).toMatchObject({ kind: 'behind', from: 1 })
    expect(opened.migrated).toBeNull()
    expect(rows(db, `SELECT "formatVersion" AS v FROM "${TABLE.journal}"`)[0].v).toBe(1)
  })

  // The control: the same file, opened the ordinary way, does move.
  test('while an ordinary open of the same file does move it', async () => {
    const db = atFormat1(`${dir}/r2.db`)
    await clientFor(db).open({ app: 'shop', host: 'deploy@prod', migrate: false })
    await clientFor(db).open({ app: 'shop', host: 'deploy@prod' })
    expect(rows(db, `SELECT "formatVersion" AS v FROM "${TABLE.journal}"`)[0].v).toBe(JOURNAL_FORMAT)
  })
})

// ─── still refused ───────────────────────────────────────────────────────────

describe('what a migration does not make readable', () => {
  test('a journal from the future is still refused, and names the upgrade', async () => {
    const db = `${dir}/future.db`
    const d  = new Database(db, { create: true })
    d.exec(DDL)
    d.exec(`INSERT INTO "${TABLE.journal}" ("id","formatVersion","app","host","createdAt")
            VALUES ('journal', ${JOURNAL_FORMAT + 1}, 'shop', 'deploy@prod', '2026-01-01T00:00:00.000Z')`)
    d.close()
    await expect(clientFor(db).open({ app: 'shop', host: 'deploy@prod' })).rejects.toThrow(JournalError)
  })

  // Order: the app and host verdicts come first, so a path pointed at somebody
  // else's journal is refused rather than upgraded.
  test("another app's journal is refused before it is migrated", async () => {
    const db = atFormat1(`${dir}/other.db`)
    await expect(clientFor(db).open({ app: 'other', host: 'deploy@prod' })).rejects.toThrow(/belongs to "shop"/)
    expect(rows(db, `SELECT "formatVersion" AS v FROM "${TABLE.journal}"`)[0].v).toBe(1)
  })
})
