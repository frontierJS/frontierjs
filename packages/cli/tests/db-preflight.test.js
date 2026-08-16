/**
 * tests/db-preflight.test.js
 *
 * The warning that exists because nothing else says it: an app with an empty
 * database boots clean, serves every route, answers every request correctly,
 * and shows a person a blank screen. Nothing is broken, so nothing speaks.
 *
 * Three things are worth pinning here and each one has already been wrong:
 *
 *   · the DATABASE PATH comes from the schema's `database` declaration, which
 *     is what litestone actually opens — the CLI's own `resolveDb` assumes
 *     `development.db` and would look at a file basecamp has never had.
 *   · `env("DATABASE_URL", "./db/x.db")` resolves the VARIABLE when it is set,
 *     because otherwise the check reports on a file the app will not open.
 *   · the RUNNER is found by walking UP for a lockfile. A package inside a
 *     workspace has none of its own, so looking beside package.json reported
 *     "npm" for every package in a bun monorepo — and then ran npm.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
// bun:sqlite, because these tests run under bun — and `db-preflight.js` takes
// either binding for the same reason: `fli`'s shebang is node, but nothing
// stops it being run under bun, and a node-only import makes the check blind
// rather than wrong.
import { Database } from 'bun:sqlite'

import { declaredDatabases, databaseState, detectRunner } from '../core/db-preflight.js'

let dir
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fli-preflight-')) })
afterAll(()  => { rmSync(dir, { recursive: true, force: true }) })

/** An app tree: a db/ with a schema, and whatever else the case needs. */
function app(name, { schema, config, lockfile, scripts } = {}) {
  const root = join(dir, name)
  mkdirSync(join(root, 'db'), { recursive: true })
  if (schema)   writeFileSync(join(root, 'db', 'schema.lite'), schema)
  if (config)   writeFileSync(join(root, 'db', 'litestone.config.js'), config)
  if (lockfile) writeFileSync(join(root, lockfile), '')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, scripts: scripts ?? {} }))
  return root
}

describe('declaredDatabases — where the app actually keeps its data', () => {

  test('reads the schema declaration, not a convention', () => {
    const root = app('declared', {
      schema: 'database main { path "./db/fleet.db" }\n\nmodel A {\n  id String @id\n}\n',
    })
    expect(declaredDatabases(root, join(root, 'db')))
      .toEqual([{ name: 'main', path: join(root, 'db', 'fleet.db') }])
  })

  test('env() falls back to its default, and yields to the variable', () => {
    const root = app('envpath', {
      schema: 'database main { path env("TEST_DB_URL", "./db/fallback.db") }\n',
    })
    expect(declaredDatabases(root, join(root, 'db'))[0].path).toBe(join(root, 'db', 'fallback.db'))

    process.env.TEST_DB_URL = '/tmp/pointed-elsewhere.db'
    try {
      // The variable WINS at runtime, so it wins here — reporting on the
      // fallback would describe a file the app is not going to open.
      expect(declaredDatabases(root, join(root, 'db'))[0].path).toBe('/tmp/pointed-elsewhere.db')
    } finally { delete process.env.TEST_DB_URL }
  })

  test('a non-sqlite database is skipped — "no rows" says nothing about jsonl', () => {
    const root = app('logger', {
      schema: 'database main { path "./db/a.db" }\n\ndatabase audit { path "./db/audit/" driver logger retention 90d }\n',
    })
    expect(declaredDatabases(root, join(root, 'db')).map(d => d.name)).toEqual(['main'])
  })

  test('falls back to litestone.config.js, resolved against the CONFIG', () => {
    const root = app('configonly', { config: "export default { db: './app.db' }\n" })
    expect(declaredDatabases(root, join(root, 'db')))
      .toEqual([{ name: 'main', path: join(root, 'db', 'app.db') }])
  })

  test('an app with neither is not something to have an opinion about', () => {
    const root = app('bare')
    expect(declaredDatabases(root, join(root, 'db'))).toEqual([])
  })
})

describe('databaseState', () => {

  test('a file that is not there', () => {
    expect(databaseState(join(dir, 'nothing-here.db'))).toBe('missing')
  })

  test('migrated but unseeded is `no-rows`, which is the case worth naming', () => {
    const path = join(dir, 'migrated.db')
    const db   = new Database(path)
    db.exec('CREATE TABLE thing (id TEXT PRIMARY KEY)')
    db.close()
    expect(databaseState(path)).toBe('no-rows')
  })

  test('one row anywhere is enough to say nothing', () => {
    const path = join(dir, 'seeded.db')
    const db   = new Database(path)
    db.exec('CREATE TABLE thing (id TEXT PRIMARY KEY)')
    db.exec("INSERT INTO thing VALUES ('a')")
    db.close()
    expect(databaseState(path)).toBe('has-rows')
  })

  test('a migrations table alone is still empty', () => {
    // The state after `migrate apply` on a fresh file: litestone's own
    // bookkeeping has rows and the app has none. Counting it would make the
    // check silent in exactly the case it exists for.
    const path = join(dir, 'onlybookkeeping.db')
    const db   = new Database(path)
    db.exec('CREATE TABLE _migrations (name TEXT)')
    db.exec("INSERT INTO _migrations VALUES ('001_init.sql')")
    db.close()
    expect(databaseState(path)).toBe('no-tables')
  })
})

describe('detectRunner — the lockfile is at the WORKSPACE root', () => {

  test('bun, found by walking up out of a package', () => {
    const ws = join(dir, 'ws')
    mkdirSync(join(ws, 'packages', 'thing'), { recursive: true })
    writeFileSync(join(ws, 'bun.lock'), '')
    // The package has no lockfile of its own — that is the whole point.
    expect(detectRunner(join(ws, 'packages', 'thing'))).toBe('bun')
  })

  test('npm when that is what the lockfile says', () => {
    const root = app('npmapp', { lockfile: 'package-lock.json' })
    expect(detectRunner(root)).toBe('npm')
  })
})
