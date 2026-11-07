/*
 * test/home.test.js
 *
 * `core/home.js` is the catalog of what fli writes under its four roots. The
 * walk never reads a file's contents; the join scan is what keeps the catalog
 * honest, since a writer added without a row is an entry no screen can size,
 * clear or check the mode of.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { homeReport, entries, holdsOf } from '../core/home.js'
import { LOG_NAMES } from '../core/autopilot.js'

// `os.homedir()` is read once at bun's startup, so HOME set here would not move
// the state root. A pinned `home` does, and the XDG variables are exercised on
// the three roots they own.
const VARS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
const saved = Object.fromEntries(VARS.map(v => [v, process.env[v]]))
let tmp

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'fli-home-'))
  for (const v of VARS) delete process.env[v]
})
afterEach(() => {
  for (const v of VARS) saved[v] === undefined ? delete process.env[v] : (process.env[v] = saved[v])
  rmSync(tmp, { recursive: true, force: true })
})

const put = (path, text) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }

function seed() {
  put(join(tmp, '.config', 'fli', 'autopilot.json'), '{}')
  put(join(tmp, '.local', 'share', 'fli', 'basecamp', 'yuma', 'db.sqlite'), 'x'.repeat(100))
  put(join(tmp, '.cache', 'fli', 'registry-0bdb23e170.json'), 'y'.repeat(40))
  put(join(tmp, '.fli', 'lanes', 'a', 'f.txt'), 'z'.repeat(10))
  put(join(tmp, '.fli', 'lanes', 'a', 'g.txt'), 'z'.repeat(5))
  put(join(tmp, '.fli', 'sessions.lock'), '{}')
  put(join(tmp, '.fli', 'stray.txt'), 'who wrote me')
}

describe('homeReport', () => {
  test('finds a seeded entry in each root and marks a file the catalog lacks as unknown', () => {
    seed()
    const { roots } = homeReport({ home: tmp })
    const byName = (root, name) => roots[root].entries.find(e => e.name === name)

    expect(byName('config', 'autopilot.json')).toMatchObject({ known: true, present: true, writer: 'core/autopilot.js', reclaim: null })
    expect(byName('data', 'basecamp')).toMatchObject({ known: true, present: true })
    expect(byName('cache', 'registry-0bdb23e170.json')).toMatchObject({ known: true, reclaim: 'clear' })
    expect(byName('state', 'lanes')).toMatchObject({ known: true, reclaim: 'remove-lane' })
    expect(byName('state', 'sessions.lock').known).toBe(true)
    expect(byName('state', 'stray.txt')).toMatchObject({ known: false, present: true, secret: false })
    expect(roots.state.path).toBe(join(tmp, '.fli'))
    expect(roots.state.exists).toBe(true)
  })

  test('sizes are off by default and recursive when asked', () => {
    seed()
    const plain = homeReport({ home: tmp }).roots.state.entries.find(e => e.name === 'lanes')
    expect('bytes' in plain).toBe(false)

    const { roots, walkMs } = homeReport({ home: tmp, sizes: true })
    expect(roots.state.entries.find(e => e.name === 'lanes').bytes).toBe(15)
    expect(roots.data.entries.find(e => e.name === 'basecamp').bytes).toBe(100)
    expect(roots.cache.entries[0].bytes).toBe(40)
    expect(typeof walkMs).toBe('number')
  })

  test('mode is octal text and a secret that is absent still has a row', () => {
    put(join(tmp, '.config', 'fli', '.env'), 'K=v')
    chmodSync(join(tmp, '.config', 'fli', '.env'), 0o600)
    const { roots } = homeReport({ home: tmp })
    expect(roots.config.entries.find(e => e.name === '.env')).toMatchObject({ present: true, mode: '600', secret: true })
    expect(roots.config.entries.find(e => e.name === 'basecamps.json')).toMatchObject({ present: false, mode: null, secret: true })
  })

  test('a root that does not exist is reported, not thrown', () => {
    const { roots } = homeReport({ home: tmp })
    expect(roots.cache.exists).toBe(false)
    expect(roots.cache.entries).toEqual([])
  })

  test('without a home, config, data and cache follow their XDG variables', () => {
    process.env.XDG_CONFIG_HOME = join(tmp, 'c')
    process.env.XDG_DATA_HOME   = join(tmp, 'd')
    process.env.XDG_CACHE_HOME  = join(tmp, 'k')
    put(join(tmp, 'c', 'fli', 'commands', 'x.md'), 'x')
    put(join(tmp, 'd', 'fli', 'basecamp', 'a'), 'aa')
    put(join(tmp, 'k', 'fli', 'fli-top-c'), 'b')
    put(join(tmp, 'k', 'fli', 'odd.bin'), 'b')
    const { roots } = homeReport({ sizes: true })
    expect(roots.config.path).toBe(join(tmp, 'c', 'fli'))
    expect(roots.config.entries.find(e => e.name === 'commands').known).toBe(true)
    expect(roots.data.entries.find(e => e.name === 'basecamp').bytes).toBe(2)
    expect(roots.cache.entries.map(e => [e.name, e.known])).toEqual([['fli-top-c', true], ['odd.bin', false]])
  })
})

describe('the catalog', () => {
  test('the loop log pattern matches every log autopilot.js names', () => {
    const logs = entries.find(e => e.name === '<loop>-loop.jsonl')
    for (const n of LOG_NAMES) expect(logs.pattern.test(n)).toBe(true)
  })

  test('every row names a real root, and nothing is listed twice', () => {
    const keys = entries.map(e => `${e.root}/${e.name}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const e of entries) {
      expect(['config', 'data', 'cache', 'state']).toContain(e.root)
      expect(e.what.length).toBeGreaterThan(10)
      expect([null, 'clear', 'remove-lane']).toContain(e.reclaim)
    }
    expect(holdsOf('config')).toContain('basecamps.json')
  })

  // Tolerant on purpose: only a join whose first name is a string literal
  // is read, so a template name or a computed one passes unseen.
  test('every join under a root in core/ and commands/ names an entry the catalog has', () => {
    const pkg = join(fileURLToPath(import.meta.url), '..', '..')
    const files = []
    const walk = (dir, ext) => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) walk(p, ext)
        else if (n.endsWith(ext)) files.push(p)
      }
    }
    walk(join(pkg, 'core'), '.js'); walk(join(pkg, 'commands'), '.md')

    const shape = /join\(\s*(configDir|dataDir|cacheDir|stateDir)\([^)]*\)\s*,\s*'([^']+)'/g
    const rootOf = { configDir: 'config', dataDir: 'data', cacheDir: 'cache', stateDir: 'state' }
    const missing = []
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(shape)) {
        const root = rootOf[m[1]]
        const name = m[2].split('/')[0]
        const known = entries.some(e => e.root === root && (e.pattern ? e.pattern.test(name) : e.name === name))
        if (!known) missing.push(`${relative(pkg, f)}: ${m[1]}() / ${name}`)
      }
    }
    expect(missing).toEqual([])
  })
})
