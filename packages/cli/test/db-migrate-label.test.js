/**
 * test/db-migrate-label.test.js
 *
 * `litestone migrate create|dev [label]` names the file `<stamp>_<label>.sql`.
 * `fli db:migrate` declared no positional, so the word typed after it was
 * dropped without a sound and every migration was `<stamp>_migration.sql`
 * (FJS-2043). Read from the `--dry` line, which names the command it would run.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
global.fliRoot = ROOT

import { Command } from '../core/runtime.js'
import { buildRegistry } from '../core/registry.js'

let dir
const file = join(ROOT, 'commands/db/migrate.md')

beforeAll(() => {
  mkdirSync(join(ROOT, '.fli-tmp'), { recursive: true })
  dir = mkdtempSync(join(ROOT, '.fli-tmp', 'migrate-label-'))
  mkdirSync(join(dir, 'db'), { recursive: true })
  writeFileSync(join(dir, 'db', 'schema.lite'), 'database main { path env("DATABASE_URL", "./db/app.db") }\nmodel Note {\n  id Int @id\n}\n')
  global.projectRoot = dir
  buildRegistry()
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

async function dry(arg, flag = {}) {
  const events = []
  const emit = (e) => { events.push(e); return Promise.resolve() }
  const cmd = await Command({ file, arg, flag: { dry: true, ...flag }, emit })
  await cmd()
  return events.map(e => e.text ?? '').join('\n')
}

describe('db:migrate label', () => {
  test('the word after db:migrate names the migration (dev)', async () => {
    expect(await dry(['data_move'])).toContain("migrate dev 'data_move'")
  })

  test('and with --create-only', async () => {
    expect(await dry(['data_move'], { 'create-only': true })).toContain("migrate create 'data_move'")
  })

  test('no word, no label', async () => {
    expect(await dry([])).toContain('migrate dev  (drift')
  })
})

// FJS-2252: `migrate create` exits 0 under a green check when the schema needs
// nothing, so the command reads the migrations directory and not the exit code.
describe('db:migrate --create-only reports what was written', () => {
  async function real(flag = {}) {
    const events = []
    const emit = (e) => { events.push(e); return Promise.resolve() }
    const cmd = await Command({ file, arg: [], flag: { 'create-only': true, ...flag }, emit })
    await cmd()
    return events.map(e => e.text ?? '').join('\n')
  }

  test('a file written is named, and a second run with nothing to do says none was', async () => {
    const first = await real()
    expect(first).toContain('Migration file created')
    expect(first).toMatch(/\.sql/)
    const second = await real()
    expect(second).not.toContain('Migration file created')
    expect(second).toContain('No migration file written')
  })
})

// FJS-1304: the JSON Schema `db:migrate` regenerates is the one `db:push` and
// `db:jsonschema` write, `<db>/.json/schema.json`, never a second copy beside
// the .lite.
describe('db:migrate JSON Schema', () => {
  test('is written to the derived path, not beside the .lite', async () => {
    const cwd = process.cwd()
    process.chdir(dir)
    try {
      const emit = () => Promise.resolve()
      const cmd = await Command({ file, arg: [], flag: {}, emit })
      await cmd()
    } finally { process.chdir(cwd) }
    expect(existsSync(join(dir, 'db', '.json', 'schema.json'))).toBe(true)
    expect(existsSync(join(dir, 'db', 'schema.json'))).toBe(false)
  })
})

// FJS-1722: `migrate dev` prints *no migration needed* and exits 0 when the
// schema change has no DDL (a @@gate edit), so the success line is earned by a
// file appearing, as it is for --create-only.
describe('db:migrate reports what was written', () => {
  async function real() {
    const events = []
    const emit = (e) => { events.push(e); return Promise.resolve() }
    const cmd = await Command({ file, arg: [], flag: {}, emit })
    await cmd()
    return events.map(e => e.text ?? '').join('\n')
  }

  test('a file written is named, and a run with nothing to do says none was', async () => {
    const schema = join(dir, 'db', 'schema.lite')
    writeFileSync(schema, readFileSync(schema, 'utf8') + '\nmodel Tag {\n  id Int @id\n}\n')
    const first = await real()
    expect(first).toContain('Migration created and applied')
    expect(first).toMatch(/\.sql/)
    const second = await real()
    expect(second).not.toContain('Migration created and applied')
    expect(second).toContain('No migration file written')
  })
})
