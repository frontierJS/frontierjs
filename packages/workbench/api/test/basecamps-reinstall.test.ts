/**
 * basecamps-reinstall.test.ts -- `startReinstall` refuses before it spawns.
 * Nothing here spawns: every case is refused first, because a reinstall that
 * got as far as the child would ssh to a box. `basecamps.json` is a temp one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join }   from 'node:path'
import { writeBasecamp } from '@frontierjs/cli/core/basecamps.js'

import { reinstallArgv, reinstallationOf, startReinstall } from '../src/domain/basecamps/basecamps-reinstall.ts'

const root = mkdtempSync(join(tmpdir(), 'wb-reinstall-'))
const home = join(root, 'home')
const opts = { dir: join(root, 'workbench'), home, env: { ...process.env, HOME: home } }

beforeAll(() => {
  writeBasecamp('box',    { url: 'https://box.example.com', host: 'box', apiKey: 'admin', scopedKey: 'run', runs: true }, { home })
  writeBasecamp('nokey',  { url: 'https://nokey.example.com', host: 'nokey', scopedKey: 'run' }, { home })
  writeBasecamp('nohost', { url: 'https://nohost.example.com', apiKey: 'admin' }, { home })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('reinstallArgv', () => {
  // FJS-D2031: --basecamp is the entry itself, so the backup and a fresh
  // install's new admin key land there and never on another entry.
  test('names the box and the entry, restore by default, --plan only when asked', () => {
    expect(reinstallArgv('box', 'box', { name: 'box' })).toEqual(['basecamp:reinstall', 'box', '--basecamp', 'box', '--yes', '--restore'])
    expect(reinstallArgv('box', 'box', { name: 'box', mode: 'fresh', plan: true })).toEqual(['basecamp:reinstall', 'box', '--basecamp', 'box', '--yes', '--fresh', '--plan'])
  })

  test('refuses a mode it does not know', () => {
    expect(reinstallArgv('box', 'box', { name: 'box', mode: 'purge' })).toEqual({ refused: expect.stringContaining('restore or fresh') })
  })
})

describe('startReinstall', () => {
  test('refuses an unknown entry, one with no ssh Host, and one with only a run key', async () => {
    expect(await startReinstall({ name: 'gone', approved: true }, opts)).toEqual({ refused: expect.stringContaining("No Basecamp named 'gone'") })
    expect(await startReinstall({ name: 'nohost', approved: true }, opts)).toEqual({ refused: expect.stringContaining('no ssh Host') })
    expect(await startReinstall({ name: 'nokey', approved: true }, opts)).toEqual({ refused: expect.stringContaining('no admin API key') })
  })

  test('refuses a run nobody approved, before it spawns', async () => {
    expect(await startReinstall({ name: 'box', plan: true }, opts)).toEqual({ refused: expect.stringContaining('not approved') })
    expect(reinstallationOf()).toBeNull()
  })
})
