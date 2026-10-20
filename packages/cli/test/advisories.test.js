// advisories.js — what the advisories CI phase fails on (THREATS B16).
//
// The walk is graded twice: over a fixture node_modules, where every shape is
// known, and over this repo's own install, where bun's `.bun/` layout is the
// one a path guess gets wrong. Either alone passes on a walk that finds
// nothing — and an empty closure reports every advisory as dev-only.
//
// The walk runs under NODE, which is what runs ci.mjs: bun resolves
// `<name>/package.json` past an exports map that node refuses, so under bun
// the walk that skipped @modelcontextprotocol/client passes this file.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { gradeAdvisories } from '../core/advisories.js'

const REPO   = join(import.meta.dir, '..', '..', '..')
const MODULE = join(import.meta.dir, '..', 'core', 'advisories.js')

const runtimeClosure = (root, dirs) => {
  const script = `import { runtimeClosure } from ${JSON.stringify(MODULE)}\n` +
    `console.log(JSON.stringify([...runtimeClosure(${JSON.stringify(root)}, ${JSON.stringify(dirs)})]))`
  const r = spawnSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return new Map(JSON.parse(r.stdout))
}

const pkg = (dir, manifest) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

describe('runtimeClosure — a fixture install', () => {
  let root
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'fjs-advisories-'))
    const nm = join(root, 'node_modules')
    pkg(join(root, 'packages/pub'), {
      name: '@frontierjs/pub', dependencies: { '@frontierjs/sib': '*', exported: '*' }, devDependencies: { devtool: '*' },
    })
    pkg(join(root, 'packages/priv'), { name: '@frontierjs/priv', private: true, dependencies: { privdep: '*' } })
    pkg(join(nm, '@frontierjs/sib'), { name: '@frontierjs/sib', dependencies: { sibdep: '*' } })
    // An exports map without ./package.json — what @modelcontextprotocol/client ships.
    pkg(join(nm, 'exported'), { name: 'exported', version: '2.0.0', exports: { '.': './index.js' }, dependencies: { deep: '*' } })
    pkg(join(nm, 'deep'),     { name: 'deep', version: '1.0.0' })
    pkg(join(nm, 'sibdep'),   { name: 'sibdep', version: '3.0.0' })
    pkg(join(nm, 'privdep'),  { name: 'privdep', version: '1.0.0' })
    pkg(join(nm, 'devtool'),  { name: 'devtool', version: '1.0.0' })
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  test('a runtime dependency is found though its exports map hides package.json', () => {
    const ships = runtimeClosure(root, ['packages/pub', 'packages/priv'])
    expect(ships.get('exported')).toBe('2.0.0')
    expect(ships.get('deep')).toBe('1.0.0')
  })

  test('a workspace sibling is walked through and not counted', () => {
    const ships = runtimeClosure(root, ['packages/pub'])
    expect(ships.get('sibdep')).toBe('3.0.0')
    expect(ships.has('@frontierjs/sib')).toBe(false)
  })

  test('a private package and a devDependency ship nothing', () => {
    const ships = runtimeClosure(root, ['packages/pub', 'packages/priv'])
    expect(ships.has('privdep')).toBe(false)
    expect(ships.has('devtool')).toBe(false)
  })
})

describe('runtimeClosure — this repo', () => {
  test('every third-party runtime dependency a published package declares is in the closure', () => {
    const dirs = readdirSync(join(REPO, 'packages')).map(d => `packages/${d}`)
      .filter(d => existsSync(join(REPO, d, 'package.json')))
    const declared = []
    for (const d of dirs) {
      const m = JSON.parse(readFileSync(join(REPO, d, 'package.json'), 'utf8'))
      if (m.private) continue
      declared.push(...Object.keys(m.dependencies ?? {}).filter(n => !n.startsWith('@frontierjs/')))
    }
    expect(declared.length).toBeGreaterThan(0)
    const ships = runtimeClosure(REPO, dirs)
    expect(declared.filter(n => !ships.has(n))).toEqual([])
  })
})

describe('gradeAdvisories', () => {
  const advisory = { severity: 'high', title: 't', vulnerable_versions: '<2', url: 'u' }
  const ships    = new Map([['shipped', '1.0.0'], ['excused', '1.0.0']])

  test('a shipping advisory is shipping, a dev-only one is not', () => {
    const g = gradeAdvisories({ shipped: [advisory], devtool: [advisory] }, ships)
    expect(g.shipping.map(a => a.name)).toEqual(['shipped'])
    expect(g.shipping[0].at).toBe('1.0.0')
    expect(g.devOnly.map(a => a.name)).toEqual(['devtool'])
  })

  test('a known entry excuses only its own package', () => {
    const g = gradeAdvisories({ shipped: [advisory], excused: [advisory] }, ships, { excused: 'why' })
    expect(g.known.map(a => a.name)).toEqual(['excused'])
    expect(g.shipping.map(a => a.name)).toEqual(['shipped'])
    expect(g.stale).toEqual([])
  })

  test('a known entry that excused nothing is stale', () => {
    const g = gradeAdvisories({ devtool: [advisory] }, ships, { excused: 'fixed since', devtool: 'dev only' })
    expect(g.stale.sort()).toEqual(['devtool', 'excused'])
  })
})
