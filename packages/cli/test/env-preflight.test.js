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
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { encryptionKeyState, envValue, fillKey } from '../core/env-preflight.js'

let dir
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'fli-env-')) })
afterAll(()  => { rmSync(dir, { recursive: true, force: true }) })

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
