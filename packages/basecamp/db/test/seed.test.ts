// db/test/seed.test.ts
// `bun run db:seed` is the only thing here that writes EVERY model, and nothing
// ran it.
//
// It had been broken for two phases when that was noticed: Phase 3 turned
// `severity` into an enum and left the seed writing `'high'`; Phase 5 replaced
// `AlertRule.channels` with a join and left it writing the dead column; the
// `--force` delete list had drifted eleven models behind the schema, so a
// `--force` left those rows in place and the next run collided with rows it
// could not see. `bun run verify` cannot see any of it — it drives screens, and
// the screens are fed by the wizard.
//
// So this runs the REAL script, as a process, the way a person does. Not the
// seeder classes imported and called: the script owns its own migrate step, its
// auth wiring and its `--force` list, and every failure above was in that half.
//
// Everything lands in a throwaway directory — the script resolves DATABASE_URL
// and the declared `audit` logger path against the CWD, so running it from a
// tmpdir keeps the developer's own fleet and audit trail untouched.

import { test, expect, describe, afterAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SEED = join(import.meta.dir, '..', 'seed.js')
const dirs: string[] = []

/** A directory the seeder can own completely. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'basecamp-seed-'))
  mkdirSync(join(dir, 'db'), { recursive: true })
  dirs.push(dir)
  return dir
}

async function runSeed(dir: string, args: string[] = []): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', SEED, ...args], {
    cwd:   dir,
    env:   { ...process.env, DATABASE_URL: join(dir, 'db', 'basecamp.db') },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, out: out + err }
}

/**
 * Tables the seeder legitimately leaves empty, each with the reason.
 *
 * This list is the whole point of the shape below. `counts()` used to hold a
 * hand-written list of tables to CHECK, which is the same drift the header of
 * this file describes — a model added to the schema and forgotten there is a
 * model nothing asks about, and six of them accumulated in one afternoon. The
 * question is asked the other way round now: every table in the database must
 * have rows, unless it is named here.
 *
 * So adding a model is a choice between seeding it and saying why not. Neither
 * one is silence.
 */
const NOT_SEEDED: Record<string, string> = {
  // Framework bookkeeping, not models.
  _litestone_migrations: 'the migration ledger',
  _litestone_seeds:      'the seed history — written by the run, empty before it',
  sqlite_stat1:          "SQLite's own query planner statistics",

  // Credential machinery. A seeded SESSION would be somebody signed in with no
  // browser, and a VERIFICATION is a token in flight — both are states, not data.
  session:      'a live sign-in, which nothing here has done',
  verification: 'a token in flight',
  oauth_flow:   'an authorization in flight',

  // Empty because they describe something that has not happened.
  alert_event:  'nothing evaluates an alert rule (FJS-123)',
  invitation:   'an offer nobody has made — accepting one is the flow, not a row to look at',
  server_event: 'written by the outpost, which is not running in a seeded fleet',

  // Empty and worth a screen having something: candidates for a later seeder.
  domain:        'no app in the seeded fleet has a hostname yet',
  network:       'the mesh is unconfigured, so ServerNetwork and AppNetwork are too',
  server_network: 'see network',
  app_network:    'see network',
  feature_flag:   'no flag in the seeded fleet',
  flag_override:  'see feature_flag',
}

/** Every table in the database, with its row count. Asked of the database
 *  rather than through a client on purpose: this test's subject is a process
 *  that already exited. */
function counts(dir: string): Record<string, number> {
  const db  = new Database(join(dir, 'db', 'basecamp.db'), { readonly: true })
  const out: Record<string, number> = {}
  const tables = db.query(
    `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`
  ).all() as { name: string }[]
  for (const { name } of tables)
    out[name] = (db.query(`SELECT count(*) c FROM "${name}"`).get() as { c: number }).c
  db.close()
  return out
}

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

describe('db/seed.js', () => {

  test('seeds an empty database end to end', async () => {
    const dir = scratch()
    const { code, out } = await runSeed(dir)
    expect(out).not.toContain('SQLiteError')
    expect(code).toBe(0)

    // Every table asserted non-empty rather than a total: a seeder that stops
    // three models in still writes hundreds of rows, and a total cannot tell
    // the difference. EVERY table, discovered from the database rather than
    // listed — a list of tables to check is the same thing as the `--force`
    // list that rotted, and six models were added in one afternoon without it
    // noticing.
    const rows = counts(dir)
    for (const [table, n] of Object.entries(rows)) {
      if (table in NOT_SEEDED) continue
      expect({ table, seeded: n > 0 }).toEqual({ table, seeded: true })
    }

    // And the other direction, so the exemption list cannot go stale either: a
    // table that starts being seeded would otherwise keep its exemption forever
    // with the reason beside it quietly false.
    for (const table of Object.keys(NOT_SEEDED)) {
      if (table.startsWith('_') || table === 'sqlite_stat1') continue
      expect({ table, rows: rows[table] ?? 0 }).toEqual({ table, rows: 0 })
    }
  }, 120_000)

  test('…and --force re-seeds the same database', async () => {
    // The half that rotted. `--force` deletes by an explicit model list, so a
    // model added to the schema and forgotten there survives the wipe and the
    // next run collides with a row it cannot see — `UNIQUE constraint failed`,
    // naming a table nobody touched. Running it twice is what asks.
    //
    // What it catches, measured by removing entries and rerunning: a model
    // whose rows do NOT cascade — dropping `account` fails here exactly as it
    // did by hand, on `account.slug`. A cascading child (`server`) left out
    // passes, and correctly: the workspace delete takes those rows anyway.
    const dir = scratch()
    expect((await runSeed(dir)).code).toBe(0)
    const first = counts(dir)

    const { code, out } = await runSeed(dir, ['--force'])
    expect(out).not.toContain('UNIQUE constraint failed')
    expect(code).toBe(0)
    // Deterministic RNG: the same fleet, not a doubled one.
    expect(counts(dir)).toEqual(first)
  }, 180_000)

  test('a second plain run is a no-op rather than a duplicate', async () => {
    const dir = scratch()
    expect((await runSeed(dir)).code).toBe(0)
    const first = counts(dir)
    // once() records the seed key, so this must not write a second fleet. It
    // fails on `account.slug` if the history row is missing.
    const { code } = await runSeed(dir)
    expect(code).toBe(0)
    expect(counts(dir)).toEqual(first)
  }, 180_000)
})
