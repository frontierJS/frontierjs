// proofs.test.js — which drive proves the change I just made.
//
// The module reads `CLAUDE.md` § *Which drive proves a change* and resolves both
// of its columns. What is worth testing is exactly that: the parse survives the
// prose the table is written in, and neither column is resolved by guessing.
//
// The `run` column is the sharp half. It is written as `` `where`: `target` ``
// with prose after an em-dash, and that prose is full of backticks — *the only
// drive that prerenders a DYNAMIC route (`getStaticPaths`)*. A scan that takes
// every backtick turns each of those into a target that resolves to nothing,
// which is the exact shape of the failure the `proof-target` rule exists to
// report. So a false target is worse than a missed one, and it is asserted.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { readProofs, resolveRun, matchChanged, provesFor, packageDirs } from '../core/proofs.js'
import { runnables } from '../core/runnables.js'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/** A workspace with a proof table and two packages that can answer it. */
function fixture(table) {
  const root = mkdtempSync(join(tmpdir(), 'fli-proofs-'))
  const w = (rel, body) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), body)
  }

  w('package.json', JSON.stringify({ name: 'ws' }))
  w('packages/sierra/package.json', JSON.stringify({
    name: '@frontierjs/sierra', scripts: { test: 'vitest run', 'test:widgets': 'node x.mjs' },
  }))
  w('packages/sierra/src/build/prerender.js', '')
  w('packages/sierra/src/router.js', '')
  w('packages/sierra/tests/live-filter.test.js', '')
  w('shop/db/schema.lite', 'model Order {\n  id Int @id\n}\n')
  w('shop/package.json', JSON.stringify({ name: 'shop', scripts: { 'verify:live': 'node x.mjs' } }))
  w('shop/web/src/cart.js', '')

  w('CLAUDE.md', [
    '# thing', '', '**Which drive proves a change.**', '',
    '| Changed | Run |', '| --- | --- |', ...table, '',
    'prose after the table, `with backticks`, which must not be read as a row.',
  ].join('\n'))

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

describe('the parse', () => {

  test('reads the rows and stops at the end of the table', () => {
    const { root, cleanup } = fixture([
      '| sierra router/resource/build | `shop`: `verify:live` |',
      '| the basket (`web/src/cart.js`) | `shop`: `verify:live` |',
    ])
    try {
      const rows = readProofs(root)
      expect(rows.length).toBe(2)
      expect(rows[0].changed).toBe('sierra router/resource/build')
      expect(rows[0].line).toBeGreaterThan(0)
    } finally { cleanup() }
  })

  test('a project with no such table answers nothing rather than inventing rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-proofs-empty-'))
    try { expect(readProofs(root)).toEqual([]) } finally { rmSync(root, { recursive: true, force: true }) }
  })

})

describe('resolving the run column', () => {

  const run = (text, root) => resolveRun(text, { root, rows: runnables(root) })

  test('a script the package declares as a drive resolves to a row that can be pressed', () => {
    const { root, cleanup } = fixture([])
    try {
      const [t] = run('`shop`: `verify:live`', root)
      expect(t.kind).toBe('row')
      expect(t.dir).toBe('shop')
      expect(t.command).toBe('bun run verify:live')
    } finally { cleanup() }
  })

  test('a package name resolves through packages/ without a table saying so', () => {
    // `sierra` is `packages/sierra`. A hardcoded map would go stale the first
    // time a package moves; the tree already answers.
    const { root, cleanup } = fixture([])
    try {
      const [t] = run('`sierra`: `test:widgets`', root)
      expect(t.dir).toBe('packages/sierra')
      // A real script that is not a runnable row — named honestly rather than
      // invented as a row or dropped.
      expect(t.kind).toBe('script')
      expect(t.command).toBe('bun run test:widgets')
    } finally { cleanup() }
  })

  test('several targets under one where, joined by + and and', () => {
    const { root, cleanup } = fixture([])
    try {
      const t = run('`shop`: `verify:live` + `verify:live` **and** `verify:live`', root)
      expect(t.length).toBe(3)
      expect(t.every(x => x.dir === 'shop')).toBe(true)
    } finally { cleanup() }
  })

  test('prose after the em-dash is not read as a target', () => {
    // The failure this guards: `getStaticPaths` becoming a target that resolves
    // to nothing, which is indistinguishable from a drive that was renamed.
    const { root, cleanup } = fixture([])
    try {
      const t = run('`shop`: `verify:live` — the only drive that prerenders a DYNAMIC route (`getStaticPaths`), a layout, and a `head()`', root)
      expect(t.map(x => x.name)).toEqual(['verify:live'])
    } finally { cleanup() }
  })

  test('a test file is a file, and is never given a made-up command', () => {
    // The runner differs per package — sierra is vitest, litestone is bun — so
    // guessing `bun test <file>` is worse than saying nothing.
    const { root, cleanup } = fixture([])
    try {
      const [t] = run('`sierra`: `tests/live-filter.test.js`', root)
      expect(t.kind).toBe('file')
      expect(t.command).toBeNull()
    } finally { cleanup() }
  })

  test('a target nothing answers to is `unknown`, which is the whole finding', () => {
    const { root, cleanup } = fixture([])
    try {
      expect(run('`shop`: `verify:renamed`', root)[0].kind).toBe('unknown')
      expect(run('`nosuchpkg`: `verify`', root)[0].kind).toBe('unknown')
    } finally { cleanup() }
  })

})

describe('matching the changed column', () => {

  const pkgs = [{ name: 'sierra', dir: 'packages/sierra' }]

  test('a backticked path is the strongest match', () => {
    const m = matchChanged('the basket store (`web/src/cart.js`)', { files: ['shop/web/src/cart.js'], packages: pkgs })
    expect(m.tier).toBe('path')
    expect(m.files).toEqual(['shop/web/src/cart.js'])
  })

  test("the package is narrowed by the row's own words", () => {
    // Four rows name sierra, so the package tier alone answers *run everything*.
    // The narrowing is read out of the row rather than declared beside it.
    const m = matchChanged('sierra prerender/islands/static-safety', {
      files: ['packages/sierra/src/build/prerender.js'], packages: pkgs,
    })
    expect(m.tier).toBe('area')
    expect(m.on).toContain('prerender')
  })

  test('and falls back to the package when none of its words match', () => {
    const m = matchChanged('sierra prerender/islands/static-safety', {
      files: ['packages/sierra/src/something-else.js'], packages: pkgs,
    })
    expect(m.tier).toBe('package')
  })

  test('a symbol matches only against the diff, never against the file list', () => {
    const changed = 'litestone migrations (`autoMigrate`, `diffSchemas`)'
    const files   = ['packages/litestone/src/core/migrate.js']

    // No diff: nothing to read the symbol out of, so it must not claim a match.
    expect(matchChanged(changed, { files, packages: [] })).toBeNull()

    const m = matchChanged(changed, { files, diff: '+  await autoMigrate(db)', packages: [] })
    expect(m.tier).toBe('symbol')
    expect(m.on).toContain('autoMigrate')
  })

  test('a short backticked token is not a symbol', () => {
    // `id` and `db` appear in every diff ever written.
    expect(matchChanged('a row keyed by `id`', { files: [], diff: 'const id = 1', packages: [] })).toBeNull()
  })

  test('a change nothing covers answers null rather than everything', () => {
    expect(matchChanged('sierra router', { files: ['docs/readme.md'], packages: pkgs })).toBeNull()
  })

})

describe('over this repo', () => {

  test('every row of the real table resolves to something that exists', () => {
    // This is the assertion the `proof-target` rule makes in CI, made once here
    // too — the table had never been checked by anything before it.
    const rows = runnables(REPO)
    const bad  = []
    for (const p of readProofs(REPO)) {
      for (const t of resolveRun(p.run, { root: REPO, rows })) {
        if (t.kind === 'unknown') bad.push(`CLAUDE.md:${p.line} ${t.where}: ${t.name}`)
      }
    }
    expect(bad).toEqual([])
  })

  test('the table is read, and it is not empty', () => {
    expect(readProofs(REPO).length).toBeGreaterThan(20)
    expect(packageDirs(REPO).some(p => p.name === 'sierra')).toBe(true)
  })

  test('strongest match first, so the top of the list is the thing to run', () => {
    const rows = provesFor(REPO, {
      files: ['packages/sierra/src/build/prerender.js', 'packages/junction/src/core/app.ts'],
      rows:  runnables(REPO),
    })
    expect(rows.length).toBeGreaterThan(0)
    const tiers = rows.map(r => r.match.tier)
    const order = { path: 0, area: 1, symbol: 2, package: 3 }
    expect(tiers.map(t => order[t])).toEqual([...tiers.map(t => order[t])].sort((a, b) => a - b))
  })

})
