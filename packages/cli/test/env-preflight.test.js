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
 */

import { test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { encryptionKeyState, envValue } from '../core/env-preflight.js'

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
