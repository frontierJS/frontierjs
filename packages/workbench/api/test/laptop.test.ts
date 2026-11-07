/**
 * laptop.test.ts -- the Disk screen's reads and its Clear verb, over a temp
 * home so the laptop's own folders are never sized or touched. `home` pins the
 * four roots as `paths.js` takes it; Workbench's folder follows `WORKBENCH_DIR`.
 * Lane removal is not here: the lanes script is bound to this checkout's real
 * `~/.fli/lanes`, so only its refusals are tested (see `scripts/lanes.mjs`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { disk, clear, removeLane } from '../src/domain/laptop/laptop.ts'

const home   = mkdtempSync(join(tmpdir(), 'wb-laptop-'))
const SECRET = 'sk_live_NEVER_IN_A_RESPONSE'
const saved  = process.env.WORKBENCH_DIR

const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const cached = join(home, '.cache', 'fli', 'registry-0bdb23e170.json')

beforeAll(() => {
  process.env.WORKBENCH_DIR = join(home, 'wb')
  put(cached, 'y'.repeat(300))
  put(join(home, '.cache', 'fli', 'stray.txt'), 'not fli\'s')
  put(join(home, '.config', 'fli', '.env'), `TOKEN=${SECRET}`)
  put(join(home, '.config', 'fli', 'basecamps.json'), `{"apiKey":"${SECRET}"}`)
  put(join(home, 'wb', 'peer.json'), `{"secret":"${SECRET}"}`)
})

afterAll(() => {
  saved === undefined ? delete process.env.WORKBENCH_DIR : (process.env.WORKBENCH_DIR = saved)
  rmSync(home, { recursive: true, force: true })
})

describe('disk', () => {
  test('lists the five classes with sizes, and the seeded cache entry as reclaimable', async () => {
    const out = await disk({ home })
    expect(out.classes.map(c => c.root)).toEqual(['config', 'data', 'cache', 'state', 'workbench'])
    const cache = out.classes.find(c => c.root === 'cache')!
    const row   = cache.entries.find(e => e.name === 'registry-0bdb23e170.json')!
    expect(row).toMatchObject({ bytes: 300, reclaim: 'clear', known: true })
    expect(cache.reclaimable).toBe(300)
    expect(cache.bytes).toBe(300 + 'not fli\'s'.length)
    expect(cache.entries.find(e => e.name === 'stray.txt')).toMatchObject({ known: false, what: null })
    expect(out.classes.find(c => c.root === 'workbench')!.bytes).toBeGreaterThan(0)
    expect(typeof out.walkMs).toBe('number')
  })

  test('no response carries a value out of a secret file', async () => {
    expect(JSON.stringify(await disk({ home }))).not.toContain(SECRET)
  })
})

describe('clear', () => {
  test('refuses anything outside the cache root, an unknown name, and a name that is not a catalog row', () => {
    expect(clear('config', '.env', { home })).toHaveProperty('refused')
    expect(clear('cache', 'stray.txt', { home })).toHaveProperty('refused')
    expect(clear('cache', '../../.config/fli/.env', { home })).toHaveProperty('refused')
    expect(clear('cache', 'nothing-here', { home })).toHaveProperty('refused')
    expect(existsSync(join(home, '.config', 'fli', '.env'))).toBe(true)
    expect(existsSync(join(home, '.cache', 'fli', 'stray.txt'))).toBe(true)
  })

  test('removes a registry cache entry and says what it freed', () => {
    expect(clear('cache', 'registry-0bdb23e170.json', { home })).toEqual({ freed: 300 })
    expect(existsSync(cached)).toBe(false)
  })
})

describe('removeLane', () => {
  test('refuses a number that is not a lane and a lane that does not exist', async () => {
    expect(await removeLane(0)).toHaveProperty('refused')
    expect(await removeLane(1.5)).toHaveProperty('refused')
    expect(await removeLane(97)).toHaveProperty('refused')
  })
})
