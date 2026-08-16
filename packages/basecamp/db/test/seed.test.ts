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

function counts(dir: string): Record<string, number> {
  const db  = new Database(join(dir, 'db', 'basecamp.db'), { readonly: true })
  const out: Record<string, number> = {}
  // TABLE names, which are snake_case of the model — `api_key`, not the
  // `db.apiKey` accessor. Asked of the database rather than through a client on
  // purpose: this test's subject is a process that already exited.
  for (const t of ['user', 'workspace', 'project', 'environment', 'app', 'server',
                   'deployment', 'job', 'secret', 'api_key', 'alert_rule', 'recipe',
                   'dashboard', 'disk_usage',
                   // The delivery chain. Both were models the seeder never
                   // wrote, so /channels/ read as broken in a seeded fleet and
                   // the join Phase 5 introduced had no example anywhere.
                   'notification_channel', 'alert_rule_channel'])
    out[t] = (db.query(`SELECT count(*) c FROM "${t}"`).get() as { c: number }).c
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
    // the difference. These are the tables the app's own screens read.
    for (const [table, n] of Object.entries(counts(dir)))
      expect({ table, seeded: n > 0 }).toEqual({ table, seeded: true })
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
