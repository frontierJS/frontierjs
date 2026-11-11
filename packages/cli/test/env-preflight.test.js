/**
 * test/env-preflight.test.js
 *
 * A clone has `.env.example` and no `.env`, and the API refused at load over
 * ENCRYPTION_KEY while the web surface came up beside it. Pinned here:
 *
 *   · the example is the app's claim that it wants the key — no mention, no ask.
 *   · a blank `KEY=` is not a value, including one above a comment line and one
 *     carrying a trailing comment.
 *   · a value in the environment fli started with wins: that is where `.env`
 *     already landed, or a shell export.
 *   · `fillKey` (deploy:setup's first seed) writes a key only where the example
 *     names one and the file has none, mode 600, and never replaces a value.
 *   · `offerKey` never writes a key that cannot read what the database already
 *     holds: a generated key only over nothing encrypted, a pasted one only if
 *     it opens a value. Run against the real litestone CLI.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { createClient } from '@frontierjs/litestone'
import { encryptionKeyState, envValue, fillKey, fileColumns, filesProviderNote, offerKey } from '../core/env-preflight.js'

let dir
const ambient = {}
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fli-env-'))
  for (const k of ['ENCRYPTION_KEY', 'ENCRYPTION_KEY_FILE', 'LITESTONE_KEY']) { ambient[k] = process.env[k]; delete process.env[k] }
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  for (const [k, v] of Object.entries(ambient)) if (v !== undefined) process.env[k] = v
})

function app(name, { example, dotenv } = {}) {
  const root = join(dir, name)
  mkdirSync(root, { recursive: true })
  if (example != null) writeFileSync(join(root, '.env.example'), example)
  if (dotenv  != null) writeFileSync(join(root, '.env'), dotenv)
  return root
}

const EXAMPLE = '# Required\nENCRYPTION_KEY=\n\nDATABASE_URL=./db/app.db\n'

test('a clone with only the example has no .env to start from', () => {
  expect(encryptionKeyState(app('clone', { example: EXAMPLE }), {})).toBe('no-env')
})

test('a .env copied from the example is blank', () => {
  expect(encryptionKeyState(app('copied', { example: EXAMPLE, dotenv: EXAMPLE }), {})).toBe('blank')
})

test('a .env with a value is set', () => {
  expect(encryptionKeyState(app('filled', { example: EXAMPLE, dotenv: 'ENCRYPTION_KEY=ab12\n' }), {})).toBe('set')
})

test('an example that never names the key is not asked', () => {
  expect(encryptionKeyState(app('nokey', { example: 'PORT=8100\n' }), {})).toBe('undeclared')
  expect(encryptionKeyState(app('noexample'), {})).toBe('undeclared')
})

test('a value in the environment wins over a blank file', () => {
  const root = app('exported', { example: EXAMPLE, dotenv: EXAMPLE })
  expect(encryptionKeyState(root, { ENCRYPTION_KEY: 'ab12' })).toBe('set')
})

test('a blank above a comment, or with one trailing, is not a value', () => {
  expect(envValue('ENCRYPTION_KEY=\n# next\n', 'ENCRYPTION_KEY')).toBe('')
  expect(envValue('ENCRYPTION_KEY=   # 64 hex chars\n', 'ENCRYPTION_KEY')).toBe('')
  expect(envValue('ENCRYPTION_KEY=ab12  # note\n', 'ENCRYPTION_KEY')).toBe('ab12')
})

test('fillKey starts a missing file from the example, with a key, mode 600', () => {
  const root = app('seed', { example: EXAMPLE })
  const file = join(root, '.env.production')
  expect(fillKey(root, file)).toBe('made')
  const text = readFileSync(file, 'utf8')
  expect(envValue(text, 'ENCRYPTION_KEY')).toMatch(/^[0-9a-f]{64}$/)
  expect(text).toContain('DATABASE_URL=./db/app.db')
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('fillKey fills a blank, appends to a file without the line, and keeps a value', () => {
  const root = app('fill', { example: EXAMPLE })
  const blank = join(root, 'blank.env')
  writeFileSync(blank, 'ENCRYPTION_KEY=\nPORT=1\n')
  expect(fillKey(root, blank)).toBe('made')
  expect(readFileSync(blank, 'utf8')).toMatch(/^ENCRYPTION_KEY=[0-9a-f]{64}\nPORT=1\n$/)

  const without = join(root, 'without.env')
  writeFileSync(without, 'PORT=1')
  expect(fillKey(root, without)).toBe('made')
  expect(readFileSync(without, 'utf8')).toMatch(/^PORT=1\nENCRYPTION_KEY=[0-9a-f]{64}\n$/)

  const kept = join(root, 'kept.env')
  writeFileSync(kept, 'ENCRYPTION_KEY=ab12\n')
  expect(fillKey(root, kept)).toBe('set')
  expect(readFileSync(kept, 'utf8')).toBe('ENCRYPTION_KEY=ab12\n')
})

test('fillKey writes nothing for an app whose example never names the key', () => {
  const root = app('fill-nokey', { example: 'PORT=8100\n' })
  expect(fillKey(root, join(root, '.env.production'))).toBe('undeclared')
  expect(() => statSync(join(root, '.env.production'))).toThrow()
})

// ─── FJS-D1549: a File column with FILES_PROVIDER unset is said, never refused ─

const SCHEMA = `model Lead {
  id    String @id
  // photo File   <- a comment is not a column
  photo File?
  docs  File[]
  name  String
}

model Note {
  id   String @id
  body String
  scan File   @accept("image/png")
}
`

test('fileColumns names every File column, comments and other types left out', () => {
  expect(fileColumns(SCHEMA)).toEqual(['Lead.photo', 'Lead.docs', 'Note.scan'])
  expect(fileColumns('model A {\n  id String @id\n}\n')).toEqual([])
})

test('filesProviderNote warns on a File schema with no provider, naming columns, folder and fixes', () => {
  const note = filesProviderNote({ columns: fileColumns(SCHEMA), env: 'PORT=3000\nFILES_PROVIDER=\n', dir: '/srv/app/db/files' })
  expect(note).toContain('Lead.photo')
  expect(note).toContain('Note.scan')
  expect(note).toContain('/srv/app/db/files')
  expect(note).toContain('FILES_PROVIDER=local')
  expect(note).toMatch(/r2|s3/)
  expect(note).toContain('FILES_BUCKET')
})

test('filesProviderNote is silent once FILES_PROVIDER is set, or when no column is a File', () => {
  const columns = fileColumns(SCHEMA)
  expect(filesProviderNote({ columns, env: 'FILES_PROVIDER=local\n', dir: '/d' })).toBeNull()
  expect(filesProviderNote({ columns, env: '# FILES_PROVIDER=local\n', dir: '/d' })).not.toBeNull()
  expect(filesProviderNote({ columns, env: '', set: ['FILES_PROVIDER'], dir: '/d' })).toBeNull()
  expect(filesProviderNote({ columns: [], env: '', dir: '/d' })).toBeNull()
})

// ─── offerKey ─────────────────────────────────────────────────────────────────

const LITESTONE = resolve(import.meta.dir, '../../litestone/src/tools/cli.js')
const SEALED_KEY = 'a'.repeat(64)
const ENCRYPTS = 'database main {\n  path "./app.db"\n}\n\nmodel User {\n  id  Int @id\n  ssn String @encrypted\n}\n'

function project(name, schemaText = ENCRYPTS) {
  const root = join(dir, name)
  mkdirSync(join(root, 'db'), { recursive: true })
  writeFileSync(join(root, 'db/schema.lite'), schemaText)
  return { root, schema: join(root, 'db/schema.lite') }
}

async function sealOneValue(schema) {
  const db = await createClient({ path: schema, resolveFrom: 'schema', encryptionKey: SEALED_KEY })
  await db.asSystem().user.create({ data: { id: 1, ssn: 'x' } })
  db.$close()
}

function terminal(root, { interactive = true, line = '', secret = '' } = {}) {
  const said = []
  const push = (m) => said.push(m)
  return {
    said,
    paths: { root },
    bin:   () => `bun ${LITESTONE}`,
    exec:  ({ command, env }) => {
      try { return execSync(command, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'ignore'] }) }
      catch (err) { return err }
    },
    tty:   { interactive, line: async () => line, secret: async () => secret },
    log:   { warn: push, error: push },
    echo:  Object.assign((s, ...v) => push(String.raw(s, ...v)), { lines: () => {} }),
    chalk: { dim: (s) => s },
  }
}

const dotenv = (root) => join(root, '.env')

test('offerKey generates a key over a database with nothing encrypted, and creates no database', async () => {
  const { root, schema } = project('offer-new')
  const env = await offerKey(terminal(root), schema)
  expect(env.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/)
  expect(envValue(readFileSync(dotenv(root), 'utf8'), 'ENCRYPTION_KEY')).toBe(env.ENCRYPTION_KEY)
  expect(statSync(dotenv(root)).mode & 0o777).toBe(0o600)
  expect(existsSync(join(root, 'db/app.db'))).toBe(false)
})

test('offerKey stops when the generated key is declined', async () => {
  const { root, schema } = project('offer-declined')
  expect(await offerKey(terminal(root, { line: 'n' }), schema)).toBeNull()
  expect(existsSync(dotenv(root))).toBe(false)
})

test('offerKey never generates over encrypted values, and writes a pasted key only if it opens one', async () => {
  const { root, schema } = project('offer-held')
  await sealOneValue(schema)

  expect(await offerKey(terminal(root, { line: 'y', secret: '' }), schema)).toBeNull()
  expect(await offerKey(terminal(root, { secret: 'not-a-key' }), schema)).toBeNull()
  expect(await offerKey(terminal(root, { secret: 'b'.repeat(64) }), schema)).toBeNull()
  expect(existsSync(dotenv(root))).toBe(false)

  expect(await offerKey(terminal(root, { secret: SEALED_KEY }), schema)).toEqual({ ENCRYPTION_KEY: SEALED_KEY })
  expect(envValue(readFileSync(dotenv(root), 'utf8'), 'ENCRYPTION_KEY')).toBe(SEALED_KEY)
})

test('offerKey with no terminal refuses over encrypted values and leaves a fresh schema to litestone', async () => {
  const held = project('offer-held-ci')
  await sealOneValue(held.schema)
  const $ = terminal(held.root, { interactive: false })
  expect(await offerKey($, held.schema)).toBeNull()
  expect($.said.join('\n')).toContain('Add the key that encrypted them')
  expect(existsSync(dotenv(held.root))).toBe(false)

  const fresh = project('offer-fresh-ci')
  expect(await offerKey(terminal(fresh.root, { interactive: false }), fresh.schema)).toEqual({})
  expect(existsSync(dotenv(fresh.root))).toBe(false)
})

test('offerKey asks nothing of a schema that encrypts nothing', async () => {
  const { root, schema } = project('offer-plain', 'database main {\n  path "./app.db"\n}\n\nmodel User {\n  id Int @id\n}\n')
  expect(await offerKey(terminal(root, { line: 'y' }), schema)).toEqual({})
  expect(existsSync(dotenv(root))).toBe(false)
})
