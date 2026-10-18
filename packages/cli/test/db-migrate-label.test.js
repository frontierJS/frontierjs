/**
 * test/db-migrate-label.test.js
 *
 * `litestone migrate create|dev [label]` names the file `<stamp>_<label>.sql`.
 * `fli db:migrate` declared no positional, so the word typed after it was
 * dropped without a sound and every migration was `<stamp>_migration.sql`
 * (FJS-2043). Read from the `--dry` line, which names the command it would run.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
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
