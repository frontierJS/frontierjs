// preflight.test.js — what a drive needs started before it.
//
// `CLAUDE.md`'s drive table carries a *Start first* column and until this module
// nothing read it, so the dashboard's start button ran `verify:live` into the
// exit 1 that names the missing process.
//
// The parse is the sharp half and for the same reason `proofs.js`'s is: the
// cell is prose with backticks in it — *`bun run build:site` — it starts the API
// and the storefront itself* — so a scan that takes every backtick invents steps
// that resolve to nothing, which is indistinguishable from a step that has been
// renamed. A false step is worse than a missed one, and it is asserted.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { readPreambles, preambleIndex, resolveNeeds } from '../core/preflight.js'
import { runnables } from '../core/runnables.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** A workspace with a drive table and one app that can answer it. */
function fixture(table) {
  const root = mkdtempSync(join(tmpdir(), 'fli-preflight-'))
  const w = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }

  w('package.json', JSON.stringify({ name: 'ws' }))
  w('shop/db/schema.lite', 'model Order {\n  id Int @id\n}\n')
  // A surface is a DIRECTORY beside `db/` (Invariant 3), which is what
  // `appPorts` reads — without these, `api` and `web` fall through to the task
  // reader and the test would be asserting the bug it is here to catch.
  w('shop/api/index.ts', '')
  w('shop/web/src/main.js', '')
  w('shop/package.json', JSON.stringify({
    name: 'shop',
    scripts: { api: 'bun api/index.ts', web: 'vite', 'db:seed': 'bun db/seed.ts', 'verify:live': 'node t.mjs' },
  }))
  w('packages/sierra/package.json', JSON.stringify({ name: '@frontierjs/sierra', scripts: { 'test:widgets': 'node x.mjs' } }))

  w('CLAUDE.md', [
    '# thing', '', '**The browser drives.**', '',
    '| Drive | Start first | Covers |', '| --- | --- | --- |', ...table, '',
    'prose after the table, `bun run nonsense`, which must not be read as a row.',
  ].join('\n'))

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('the parse', () => {

  test('reads the rows and stops at the end of the table', () => {
    const { root, cleanup } = fixture([
      '| `shop`: `verify:live` | `bun run db:seed`, then `bun run api` + `bun run web` | a thing |',
      '| `sierra`: `test:widgets` | nothing — builds the fixture itself | another |',
    ])
    try {
      const rows = readPreambles(root)
      expect(rows.length).toBe(2)
      expect(rows[0].dir).toBe('shop')
      expect(rows[0].script).toBe('verify:live')
      expect(rows[0].line).toBeGreaterThan(0)
      expect(rows[1].dir).toBe('packages/sierra')
    } finally { cleanup() }
  })

  test('the order is the content', () => {
    // The cell is ordered prose and the order is the whole of what a caller
    // needs — a seed after the servers is a drive reading rows that are gone.
    const { root, cleanup } = fixture([
      '| `shop`: `verify:live` | `bun run db:seed`, then `bun run api` + `bun run web` | x |',
    ])
    try {
      expect(readPreambles(root)[0].needs.map(n => n.script)).toEqual(['db:seed', 'api', 'web'])
    } finally { cleanup() }
  })

  test('`nothing` is the explicit empty answer, not a blank cell', () => {
    // A blank cell would read as *nobody has written this down yet*, which is a
    // different fact from *this drive starts its own servers*.
    const { root, cleanup } = fixture([
      '| `shop`: `verify:live` | nothing — starts and stops both servers itself | x |',
    ])
    try { expect(readPreambles(root)[0].needs).toEqual([]) } finally { cleanup() }
  })

  test('and `nothing` wins over a command named in the same breath', () => {
    // The em-dash cut covers most of these; a cell that qualifies itself with a
    // parenthesis instead has nothing to cut, and the word is what the row
    // means. Without this the drive would be sent to start a server it starts
    // itself, which is a port collision rather than a missing step.
    const { root, cleanup } = fixture([
      '| `shop`: `verify:live` | nothing (it starts `bun run api` itself) | x |',
    ])
    try { expect(readPreambles(root)[0].needs).toEqual([]) } finally { cleanup() }
  })

  test('prose after the em-dash is not read as a step', () => {
    // The failure this guards: a parenthetical becoming a step that resolves to
    // nothing, which reads exactly like a script that has been renamed.
    const { root, cleanup } = fixture([
      '| `shop`: `verify:live` | `bun run api` — it also starts `bun run nonsense` on 8112 | x |',
    ])
    try {
      expect(readPreambles(root)[0].needs.map(n => n.script)).toEqual(['api'])
    } finally { cleanup() }
  })

  test('the drive key is one spelling, so `bun run verify` and `verify` are one row', () => {
    // One row of the real table writes its target with the runner and the rest
    // write the bare script. Both have to key, or a whole package's drives go
    // unmatched in silence.
    const { root, cleanup } = fixture([
      '| `shop`: `bun run verify:live` | `bun run api` | x |',
    ])
    try {
      expect(readPreambles(root)[0].script).toBe('verify:live')
      expect(preambleIndex(root).has('shop/verify:live')).toBe(true)
    } finally { cleanup() }
  })

  test('a project with no such table answers nothing rather than inventing rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-preflight-empty-'))
    try { expect(readPreambles(root)).toEqual([]) } finally { rmSync(root, { recursive: true, force: true }) }
  })

})

describe('resolving a step against what can run', () => {

  test('a step becomes a row in the drive`s own directory', () => {
    const { root, cleanup } = fixture([
      '| `shop`: `verify:live` | `bun run db:seed`, then `bun run api` | x |',
    ])
    try {
      const rows  = runnables(root)
      const [p]   = readPreambles(root)
      const needs = resolveNeeds(p.needs, p.dir, rows)

      // The seed is a task and the API a surface, and the difference is what
      // tells a caller whether to wait for an exit or for a port.
      expect(needs[0].id).toBe('task:shop/db:seed')
      expect(needs[0].kind).toBe('task')
      expect(needs[0].port).toBeNull()

      expect(needs[1].kind).toBe('surface')
      expect(needs[1].port).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  test('a step the directory does not declare resolves to null, which is the finding', () => {
    const { root, cleanup } = fixture([
      '| `shop`: `verify:live` | `bun run db:reseed` | x |',
    ])
    try {
      const [p] = readPreambles(root)
      expect(resolveNeeds(p.needs, p.dir, runnables(root))[0].id).toBeNull()
    } finally { cleanup() }
  })

  test('a step is resolved in the drive`s directory and never in another`s', () => {
    // Two apps can both declare `db:seed`, and running the wrong one seeds a
    // database the drive will not read.
    const { root, cleanup } = fixture([
      '| `sierra`: `test:widgets` | `bun run db:seed` | x |',
    ])
    try {
      const [p] = readPreambles(root)
      expect(p.dir).toBe('packages/sierra')
      expect(resolveNeeds(p.needs, p.dir, runnables(root))[0].id).toBeNull()
    } finally { cleanup() }
  })

})

describe('what the inventory does with it', () => {

  test('a drive carries its preamble, resolved', () => {
    const { root, cleanup } = fixture([
      '| `shop`: `verify:live` | `bun run db:seed`, then `bun run api` | x |',
    ])
    try {
      const drive = runnables(root).find(r => r.id === 'drive:shop/verify:live')
      expect(drive.needs.map(n => n.id)).toEqual(['task:shop/db:seed', 'surface:shop/api'])
    } finally { cleanup() }
  })

  test('a drive the table does not name carries none, rather than a guess', () => {
    const { root, cleanup } = fixture([])
    try {
      expect(runnables(root).find(r => r.id === 'drive:shop/verify:live').needs).toEqual([])
    } finally { cleanup() }
  })

  test('an app`s scripts are rows, because a preamble names them', () => {
    // `db:seed` and `build:site` are what most drives begin with, and while the
    // task reader looked at the workspace root alone they were not rows at all
    // — so the one thing a start button may be handed, an id, did not exist.
    const { root, cleanup } = fixture([])
    try {
      const ids = new Set(runnables(root).map(r => r.id))
      expect(ids.has('task:shop/db:seed')).toBe(true)
    } finally { cleanup() }
  })

  test('one script is one row — a surface`s script is not also a task', () => {
    const { root, cleanup } = fixture([])
    try {
      const rows = runnables(root)
      expect(rows.filter(r => r.dir === 'shop' && r.start === 'bun run api').length).toBe(1)
      expect(rows.find(r => r.dir === 'shop' && r.start === 'bun run api').kind).toBe('surface')
      // And a drive stays a drive.
      expect(rows.some(r => r.kind === 'task' && r.name === 'verify:live')).toBe(false)
    } finally { cleanup() }
  })

})

describe('over this repo', () => {

  test('every step of the real table is a script that exists', () => {
    // The assertion the `drive-preamble` rule makes in CI, made once here too —
    // the column had never been checked by anything before it, and the
    // dashboard now presses it rather than only printing it.
    const rows = runnables(REPO)
    const bad  = []
    for (const p of readPreambles(REPO)) {
      for (const n of resolveNeeds(p.needs, p.dir, rows)) {
        if (!n.id) bad.push(`CLAUDE.md:${p.line} ${p.dir}/${p.script} → ${n.run}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('the table is read, and the drives that declare a preamble carry one', () => {
    const withNeeds = runnables(REPO).filter(r => r.kind === 'drive' && r.needs.length)
    expect(withNeeds.length).toBeGreaterThan(5)
    for (const d of withNeeds) for (const n of d.needs) expect(n.run.startsWith('bun run ')).toBe(true)
  })

})
