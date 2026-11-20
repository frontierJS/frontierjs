// api/test/prototypes.test.ts — the prototypes catalog: records, the scan, the merge, the view.
//
// Real git over a temp folder, as local-git.test.ts does: which folder is a
// repository is git's answer. The real CATALOG.json is read, never written —
// the round-trip test works on a copy.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { LEVELS } from '@frontierjs/litestone'
import {
  catalogFile, listPrototypes, readCatalog, readView, serializeCatalog, validateRecord, writeRecord, writeView,
} from '../src/domain/prototypes/catalog.ts'
import { declaredModels, findCandidates } from '../src/domain/prototypes/candidates.ts'
import { movePrototype } from '../src/domain/prototypes/move.ts'
import { createWorkbench } from '../src/domain/workbench/workbench.ts'
import prototypes from '../src/services/prototypes/prototypes.service.ts'

// The owner's checkout beside this repo; skipped where there is none.
const REAL = catalogFile(resolve(import.meta.dir, '../../../../../fjs-prototypes'))

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

  test('a folded entry is a group, so a repo name or an unknown group is dropped on read', () => {
    writeView({ folded: ['owner:kobami', 'status:paused', 'unsorted', 'recorded', 'owner:nobody'] }, wb)
    expect(readView(['recorded'], wb).folded).toEqual(['owner:kobami', 'status:paused', 'unsorted'])
  })
})

describe('merge candidates', () => {
  const SCAFFOLD = 'model User {\n}\nmodel AuditTrail {\n}\n'
  const r = (kind: string, related: Array<{ to: string, why: string }> = []) =>
    rec('/x', { kind, related }) as unknown as Parameters<typeof findCandidates>[0][string]

  test('a declaration starts the line, so an indented field named model is not one', () => {
    expect(declaredModels('model Lead {\n  model String\n}\nmodel Lead @@external\n// model Gone {\n')).toEqual(['Lead'])
  })

  test('same kind and two shared models pair; a model every schema declares does not count', () => {
    const records = { a: r('stressor'), b: r('stressor'), c: r('stressor'), d: r('client') }
    const schemas: Record<string, string> = {
      a: SCAFFOLD + 'model Issue {}\nmodel Label {}\nmodel Card {}\n',
      b: SCAFFOLD + 'model Issue {}\nmodel Label {}\nmodel Card {}\nmodel Team {}\nmodel Board {}\n',
      c: SCAFFOLD + 'model Issue {}\n',
      d: SCAFFOLD + 'model Issue {}\nmodel Team {}\nmodel Board {}\n',
    }
    const out = findCandidates(records, n => schemas[n])
    expect(out.common).toEqual(['AuditTrail', 'Issue', 'User'])
    // b and d share Team and Board too, but d is a client.
    expect(out.candidates).toEqual([{ a: 'a', b: 'b', kind: 'stressor', related: [], shared: ['Card', 'Label'] }])
    // One shared model is under MIN_SHARED.
    expect(findCandidates(records, n => n === 'a' ? SCAFFOLD + 'model Label {}\n' : schemas[n]).candidates).toEqual([])
  })

  test('a related link pairs any two records, both directions fold into one pair, and a link to no record is skipped', () => {
    const records = {
      x: r('client', [{ to: 'y', why: 'merges later' }, { to: 'ghost', why: 'gone' }]),
      y: r('product', [{ to: 'x', why: 'its source' }]),
    }
    expect(findCandidates(records, () => null).candidates).toEqual([{
      a: 'x', b: 'y', kind: null, shared: [],
      related: [{ from: 'x', to: 'y', why: 'merges later' }, { from: 'y', to: 'x', why: 'its source' }],
    }])
  })
})

describe('move', () => {
  // A world of its own: the prototypes folder, a destination, Workbench's dir and Claude's.
  let root: string, protos: string, dest: string, wbDir: string, claude: string
  const enc = (p: string) => p.replace(/[^a-zA-Z0-9]/g, '-')
  const OLD_MTIME = new Date('2026-01-02T03:04:05Z')
  const line = (cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', cwd, sessionId: 's', ...extra })
  const history = (cwd: string, lines: string[]) => {
    const folder = join(claude, 'projects', enc(cwd))
    mkdirSync(join(folder, 'memory'), { recursive: true })
    const file = join(folder, '11111111-2222-3333-4444-555555555555.jsonl')
    writeFileSync(file, lines.join('\n') + '\n')
    utimesSync(file, OLD_MTIME, OLD_MTIME)
    return file
  }
  const opts = () => ({ dir: protos, wb: wbDir, claudeDir: claude, cwds: () => [] as string[] })

  beforeAll(() => {
    root   = mkdtempSync(join(tmpdir(), 'prototypes-move-'))
    protos = join(root, 'protos')
    // One level deeper than protos/, so a relative link out of the repo breaks unless re-pointed.
    dest   = join(root, 'KOBAMI', 'clients')
    wbDir  = join(root, 'wb')
    claude = join(root, 'claude')
    for (const d of [join(protos, 'catalog'), join(protos, 'ela', 'web'), join(protos, 'ela-device'), join(protos, 'pinned'), dest, wbDir])
      mkdirSync(d, { recursive: true })
    writeFileSync(join(protos, 'ela', 'README.md'), 'ela\n')
    // As bun links @frontierjs/* from the framework checkout: relative, out of the repo.
    mkdirSync(join(root, 'frontierjs', 'packages', 'auth'), { recursive: true })
    writeFileSync(join(root, 'frontierjs', 'packages', 'auth', 'package.json'), '{}')
    mkdirSync(join(protos, 'ela', 'node_modules', '@frontierjs'), { recursive: true })
    mkdirSync(join(protos, 'ela', 'node_modules', '.bin'), { recursive: true })
    symlinkSync('../../../../frontierjs/packages/auth', join(protos, 'ela', 'node_modules', '@frontierjs', 'auth'))
    symlinkSync('../../README.md', join(protos, 'ela', 'node_modules', '.bin', 'inside'))
    symlinkSync(join(root, 'frontierjs'), join(protos, 'ela', 'node_modules', 'absolute'))
    spawnSync('git', ['init', '-q', '-b', 'main', join(protos, 'ela')])
    const r = (path: string) => ({ path, owner: 'kobami', kind: 'client', status: 'active' })
    writeFileSync(catalogFile(protos), JSON.stringify({ ela: r(join(protos, 'ela')), 'ela-device': r(join(protos, 'ela-device')), pinned: r(join(protos, 'pinned')) }))
    writeFileSync(join(wbDir, 'pins.json'), JSON.stringify({ pins: [{ path: join(protos, 'pinned') }] }))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('a refusal moves nothing', () => {
    const ela = join(protos, 'ela')
    expect(movePrototype('ghost', dest, opts())).toMatchObject({ refused: expect.stringMatching(/no prototype is recorded/) })
    expect(movePrototype('ela', join(root, 'nope'), opts())).toMatchObject({ refused: expect.stringMatching(/does not exist/) })
    expect(movePrototype('ela', 'relative/dir', opts())).toMatchObject({ refused: expect.stringMatching(/must start with/) })
    expect(movePrototype('ela', protos, opts())).toMatchObject({ refused: expect.stringMatching(/already in/) })
    expect(movePrototype('ela', join(ela, 'web'), opts())).toMatchObject({ refused: expect.stringMatching(/inside ela itself/) })
    expect(movePrototype('pinned', dest, opts())).toMatchObject({ refused: expect.stringMatching(/pinned in Workbench/) })
    expect(movePrototype('ela', dest, { ...opts(), cwds: () => [join(ela, 'web')] })).toMatchObject({ refused: expect.stringMatching(/a process is running in .*ela\/web/) })
    // Claude Code already keeps history at the destination's name.
    history(join(ela, 'web'), [line(join(ela, 'web'))])
    const squatter = join(claude, 'projects', enc(join(dest, 'ela', 'web')))
    mkdirSync(squatter, { recursive: true })
    expect(movePrototype('ela', dest, opts())).toMatchObject({ refused: expect.stringMatching(/already has history/) })
    rmSync(squatter, { recursive: true })
    expect(existsSync(join(ela, 'README.md'))).toBe(true)
    expect(readCatalog(protos).records.ela.path).toBe(ela)
  })

  test('the folder, its record, its own and its subfolders\' history move; a sibling\'s history stays', () => {
    const ela = join(protos, 'ela'), next = join(dest, 'ela')
    const own = history(ela, [
      line(ela),
      line(join(ela, 'web'), { message: { content: `see ${ela}/db` } }),
      line('/elsewhere'),
      '{ not json',
    ])
    const sibling = history(join(protos, 'ela-device'), [line(join(protos, 'ela-device'))])

    const out = movePrototype('ela', dest, opts())
    expect(out).toMatchObject({ name: 'ela', from: ela, to: next, path: next })
    expect(existsSync(ela)).toBe(false)
    expect(readFileSync(join(next, 'README.md'), 'utf8')).toBe('ela\n')
    expect(readCatalog(protos).records.ela.path).toBe(next)
    expect((out as { links: number }).links).toBe(1)
    expect(readFileSync(join(next, 'node_modules', '@frontierjs', 'auth', 'package.json'), 'utf8')).toBe('{}')
    expect(readlinkSync(join(next, 'node_modules', '@frontierjs', 'auth'))).toBe('../../../../../frontierjs/packages/auth')
    expect(readlinkSync(join(next, 'node_modules', '.bin', 'inside'))).toBe('../../README.md')
    expect(readlinkSync(join(next, 'node_modules', 'absolute'))).toBe(join(root, 'frontierjs'))

    const histories = (out as { histories: Array<{ from: string, to: string, transcripts: number }> }).histories
    expect(histories.map(h => [h.from, h.to, h.transcripts]).sort()).toEqual([
      [join(claude, 'projects', enc(ela)), join(claude, 'projects', enc(next)), 1],
      [join(claude, 'projects', enc(join(ela, 'web'))), join(claude, 'projects', enc(join(next, 'web'))), 1],
    ].sort())
    const moved = own.replace(enc(ela), enc(next))
    expect(existsSync(own)).toBe(false)
    expect(existsSync(join(claude, 'projects', enc(next), 'memory'))).toBe(true)
    // Only the top-level cwd changes: text that names the old path is the conversation's.
    expect(readFileSync(moved, 'utf8')).toBe([
      line(next),
      line(join(next, 'web'), { message: { content: `see ${ela}/db` } }),
      line('/elsewhere'),
      '{ not json',
    ].join('\n') + '\n')
    expect(statSync(moved).mtime.toISOString()).toBe(OLD_MTIME.toISOString())
    expect(readFileSync(sibling, 'utf8')).toBe(line(join(protos, 'ela-device')) + '\n')
  })

  test('Workbench offers the moved session to a pin at the new path', async () => {
    const next = join(dest, 'ela')
    const wbk = createWorkbench({ dir: join(root, 'wb-after'), configDir: claude })
    const pinned = wbk.pin(next)
    if (!('pin' in pinned)) throw new Error(pinned.refused)
    expect((await wbk.importable(pinned.pin.id)).map(i => i.session)).toEqual(['11111111-2222-3333-4444-555555555555'])
  })
})

test('every method of the service is gated at ADMINISTRATOR', () => {
  const methods = (prototypes as unknown as { methods: Array<{ method: string, gate?: number }> }).methods
  expect(methods.map(m => m.method).sort()).toEqual(['candidates', 'list', 'move', 'open', 'saveRecord', 'saveView'])
  for (const m of methods) expect([m.method, m.gate]).toEqual([m.method, LEVELS.ADMINISTRATOR])
})
