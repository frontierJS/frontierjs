// api/test/prototypes.test.ts — the prototypes catalog: records, the scan, the merge, the view.
//
// Real git over a temp folder, as local-git.test.ts does: which folder is a
// repository is git's answer. The real CATALOG.json is read, never written —
// the round-trip test works on a copy.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LEVELS } from '@frontierjs/litestone'
import {
  catalogFile, listPrototypes, readCatalog, readView, serializeCatalog, validateRecord, writeRecord, writeView,
} from '../src/domain/prototypes/catalog.ts'
import prototypes from '../src/services/prototypes/prototypes.service.ts'

const REAL = '/home/j/code/FRONTIER/fjs-prototypes/catalog/CATALOG.json'

let dir: string
let wb: string
const sh = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
}
const repo = (rel: string) => {
  const p = join(dir, rel)
  mkdirSync(p, { recursive: true })
  sh(p, 'init', '-q', '-b', 'main')
  return p
}
const rec = (path: string, extra: Record<string, unknown> = {}) =>
  ({ path, owner: 'personal', kind: 'test', status: 'active', purpose: 'p', related: [], ...extra })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'prototypes-'))
  wb  = mkdtempSync(join(tmpdir(), 'prototypes-wb-'))
  repo('recorded')
  repo('loose')
  repo('catalog')                                  // holds CATALOG.json
  mkdirSync(join(dir, 'plan-only'))                // a recorded folder, not a repository
  writeFileSync(join(dir, 'plan-only', 'PLAN.md'), '# plan')
  writeFileSync(catalogFile(dir), `{
  "recorded": {
    "path": "${join(dir, 'recorded')}",
    "owner": "kobami",
    "kind": "client",
    "status": "active",
    "purpose": "a recorded repo",
    "mine": { "keep": true },
    "related": [
      { "to": "gone", "why": "was a sibling" }
    ]
  },
  "plan-only": {
    "path": "${join(dir, 'plan-only')}",
    "owner": "personal",
    "kind": "spike",
    "status": "paused",
    "related": []
  },
  "gone": {
    "path": "${join(dir, 'gone')}",
    "owner": "personal",
    "kind": "test",
    "status": "archived",
    "related": []
  },
  "broken": { "path": "/x", "owner": "nobody", "kind": "test", "status": "active" }
}
`)
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(wb, { recursive: true, force: true })
})

describe('validateRecord', () => {
  test('owner, kind and status come from their sets', () => {
    expect(validateRecord('a', rec('/x'))).toBeNull()
    expect(validateRecord('a', rec('~/x'))).toBeNull()
    expect(validateRecord('a', rec('/x', { owner: 'nobody' }))).toMatch(/owner must be one of/)
    expect(validateRecord('a', rec('/x', { kind: 'app' }))).toMatch(/kind must be one of/)
    expect(validateRecord('a', rec('/x', { status: 'done' }))).toMatch(/status must be one of/)
  })

  test('a path is absolute or ~/, and related is { to, why }', () => {
    expect(validateRecord('a', rec('code/x'))).toMatch(/must start with/)
    expect(validateRecord('a', rec('/x', { related: [{ to: 'b' }] }))).toMatch(/related entry/)
    expect(validateRecord('a b', rec('/x'))).toMatch(/not a usable name/)
  })
})

describe('the file', () => {
  test.skipIf(!existsSync(REAL))('the real CATALOG.json reads clean and round-trips byte for byte', () => {
    const root = mkdtempSync(join(tmpdir(), 'prototypes-copy-'))
    try {
      mkdirSync(join(root, 'catalog'))
      copyFileSync(REAL, catalogFile(root))
      const before = readFileSync(catalogFile(root), 'utf8')
      const read = readCatalog(root)
      expect(read.error).toBeNull()
      expect(read.problems).toEqual([])
      expect(Object.keys(read.records).length).toBeGreaterThan(50)
      expect(serializeCatalog(JSON.parse(before))).toBe(before)
      // A write that changes nothing leaves the file as it was.
      const name = Object.keys(read.records)[0]
      expect('record' in writeRecord(name, { status: read.records[name].status }, root)).toBe(true)
      expect(readFileSync(catalogFile(root), 'utf8')).toBe(before)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a record that fails validation is listed as a problem, not dropped from the file', () => {
    const read = readCatalog(dir)
    expect(Object.keys(read.records)).toEqual(['recorded', 'plan-only', 'gone'])
    expect(read.problems).toEqual([{ name: 'broken', error: expect.stringMatching(/owner must be one of/) }])
  })
})

describe('the merge', () => {
  test('each repo lands in its bucket and catalog lands in none', async () => {
    const out = await listPrototypes({ dir, wb })
    expect(out.recorded.map(r => r.name).sort()).toEqual(['plan-only', 'recorded'])
    expect(out.recorded.find(r => r.name === 'recorded')!.git).toMatchObject({ name: 'recorded', branch: 'main' })
    expect(out.recorded.find(r => r.name === 'plan-only')!.git).toBeNull()
    expect(out.unsorted.map(r => r.name)).toEqual(['loose'])
    expect(out.missing.map(r => r.name)).toEqual(['gone'])
    const everywhere = JSON.stringify([out.recorded, out.unsorted, out.missing])
    expect(everywhere).not.toContain(join(dir, 'catalog') + '"')
  })

  test('an absent CATALOG.json is no records and every repo unsorted, not an error', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'prototypes-empty-'))
    try {
      mkdirSync(join(empty, 'one', '.git'), { recursive: true })
      const out = await listPrototypes({ dir: empty, wb })
      expect(out.error).toBeNull()
      expect(out.recorded).toEqual([])
      expect(out.unsorted.map(r => r.name)).toEqual(['one'])
    } finally { rmSync(empty, { recursive: true, force: true }) }
  })
})

describe('writes', () => {
  test('saveRecord keeps unknown fields and key order, and null clears', () => {
    const out = writeRecord('recorded', { status: 'paused', purpose: null }, dir)
    expect(out).toMatchObject({ record: { status: 'paused', mine: { keep: true } } })
    const text = readFileSync(catalogFile(dir), 'utf8')
    expect(JSON.parse(text).recorded).not.toHaveProperty('purpose')
    expect(Object.keys(JSON.parse(text))).toEqual(['recorded', 'plan-only', 'gone', 'broken'])
    expect(Object.keys(JSON.parse(text).recorded)).toEqual(['path', 'owner', 'kind', 'status', 'mine', 'related'])
    expect(text).toContain('{ "to": "gone", "why": "was a sibling" }')
    expect(text.endsWith('}\n')).toBe(true)
  })

  test('a new record is appended with the canonical key order; a bad one is refused and writes nothing', () => {
    const before = readFileSync(catalogFile(dir), 'utf8')
    expect(writeRecord('bad', { path: '/x', owner: 'nobody', kind: 'test', status: 'active' }, dir)).toHaveProperty('refused')
    expect(readFileSync(catalogFile(dir), 'utf8')).toBe(before)
    const ok = writeRecord('fresh', { status: 'active', kind: 'test', owner: 'personal', path: join(dir, 'fresh') }, dir)
    expect('record' in ok).toBe(true)
    const parsed = JSON.parse(readFileSync(catalogFile(dir), 'utf8'))
    expect(Object.keys(parsed).at(-1)).toBe('fresh')
    expect(Object.keys(parsed.fresh)).toEqual(['path', 'owner', 'kind', 'status'])
  })

  test('a file that is not JSON refuses a write rather than being replaced', () => {
    const bad = mkdtempSync(join(tmpdir(), 'prototypes-bad-'))
    try {
      mkdirSync(join(bad, 'catalog'))
      writeFileSync(catalogFile(bad), '{ nope')
      expect(writeRecord('a', rec('/x'), bad)).toMatchObject({ refused: expect.stringMatching(/not valid JSON/) })
      expect(readFileSync(catalogFile(bad), 'utf8')).toBe('{ nope')
      expect(readCatalog(bad).error).toMatch(/not valid JSON/)
    } finally { rmSync(bad, { recursive: true, force: true }) }
  })

  test('the view round-trips, and a name matching no record is ignored on read', () => {
    expect(readView(['recorded'], wb)).toEqual({ favorites: [], order: [], folded: [] })
    expect(writeView({ favorites: ['recorded', 'ghost'], order: ['plan-only', 'recorded'], folded: [] }, wb)).toHaveProperty('view')
    expect(JSON.parse(readFileSync(join(wb, 'prototypes.json'), 'utf8')).favorites).toEqual(['recorded', 'ghost'])
    expect(readView(['recorded', 'plan-only'], wb)).toEqual({ favorites: ['recorded'], order: ['plan-only', 'recorded'], folded: [] })
    expect(writeView({ favorites: 'recorded' }, wb)).toHaveProperty('refused')
  })
})

test('every method of the service is gated at ADMINISTRATOR', () => {
  const methods = (prototypes as unknown as { methods: Array<{ method: string, gate?: number }> }).methods
  expect(methods.map(m => m.method).sort()).toEqual(['list', 'saveRecord', 'saveView'])
  for (const m of methods) expect([m.method, m.gate]).toEqual([m.method, LEVELS.ADMINISTRATOR])
})
