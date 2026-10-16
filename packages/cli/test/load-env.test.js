/*
 * test/load-env.test.js
 *
 * Precedence of the three places a variable can come from: the shell beats the
 * project .env, which beats ~/.config/fli/.env. `DATABASE_URL=./other.db fli
 * db:migrate` migrated the .env's database when the project file overrode the
 * shell (FJS-2631).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadFliEnv } from '../core/utils.js'

const KEYS = ['FJS2631_SHELL', 'FJS2631_BOTH', 'FJS2631_GLOBAL']
let home, root

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fli-env-home-'))
  root = mkdtempSync(join(tmpdir(), 'fli-env-root-'))
  mkdirSync(join(home, '.config', 'fli'), { recursive: true })
  writeFileSync(join(home, '.config', 'fli', '.env'), 'FJS2631_SHELL=global\nFJS2631_BOTH=global\nFJS2631_GLOBAL=global\n')
  writeFileSync(join(root, '.env'), 'FJS2631_SHELL=project\nFJS2631_BOTH=project\n')
  for (const k of KEYS) delete process.env[k]
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
  for (const k of KEYS) delete process.env[k]
})

describe('loadFliEnv', () => {
  test('a variable already in the shell beats the project .env and the global one', () => {
    process.env.FJS2631_SHELL = 'shell'
    loadFliEnv(root, home)
    expect(process.env.FJS2631_SHELL).toBe('shell')
  })

  test('the project .env beats the global one', () => {
    loadFliEnv(root, home)
    expect(process.env.FJS2631_BOTH).toBe('project')
  })

  test('the global .env fills what the project leaves unset', () => {
    loadFliEnv(root, home)
    expect(process.env.FJS2631_GLOBAL).toBe('global')
  })
})
