// surface.test.js — what a package exports, and what anyone outside reaches.
//
// A fixture workspace, not this repo: the snapshot over the real tree is the
// `snapshots` CI phase's job, and a test pinned to the repo's current counts
// would fail on every honest change. What is pinned here is the READING — a
// re-export followed, a type told from a value, a token in a test counting as
// reach, a compiler's emitted name counted apart, and a `.d.ts` not counting.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { collectSurface, renderSurface, exportedNames, entryPoints, sourceFiles } from '../core/surface.js'

let ROOT

const files = {
  'packages/alpha/package.json': JSON.stringify({
    name: '@x/alpha',
    exports: { '.': './index.ts', './side': './src/side.ts', './gen': './src/gen.ts', './schema.lite': './db/a.lite', './widgets/*': './widgets/*.js' },
  }),
  'packages/alpha/index.ts': [
    'export function used() {}',
    'export function onlyInTest() {}',
    'export function nobody() {}',
    'export function emittedName() {}',
    'export class AlphaError extends Error {}',
    'export type Shape = { a: 1 }',
    'export interface Unused { b: 2 }',
    'export { inner as renamed, type Hidden } from "./src/inner"',
    'export * from "./src/star"',
    'export default 1',
  ].join('\n'),
  'packages/alpha/src/inner.ts':  'export const inner = 1\nexport type Hidden = 2\n',
  'packages/alpha/src/star.ts':   'export const fromStar = 1\nexport function starFn() {}\n',
  'packages/alpha/src/side.ts':   'export const side = 1\n',
  'packages/alpha/src/gen.ts':    'export const gen = 1\n',
  'packages/alpha/src/emit.ts':   'const w = s => s\nconst re = /`/\nw(`$$runtime.emittedName(x)`)\nw("import { gen } from \'@x/alpha/gen\'")\n',
  'packages/alpha/src/emit.test.ts': "import { describe } from 'bun:test'\ndescribe('nobody calls AlphaError', () => {})\n",
  'packages/alpha/widgets/w1.js': 'export const w1 = 1\n',
  'packages/alpha/db/a.lite':     'model A { id Int @id }\n',

  'packages/beta/package.json':   JSON.stringify({ name: '@x/beta', main: 'index.js' }),
  'packages/beta/index.js':       'export const betaThing = 1\n// export function commentedOut() {}\n',

  'example/api/app.ts': [
    "import { used, renamed, starFn } from '@x/alpha'",
    "import w from '@x/alpha/widgets/w1'",
    'export type S = import("@x/alpha").Shape',
    'used(); renamed; starFn(); w',
  ].join('\n'),
  'example/api/app.test.ts': "import { onlyInTest } from '../../packages/alpha/index.ts'\nonlyInTest()\n",
  'example/api/types.d.ts':  "import type { Unused, AlphaError } from '@x/alpha'\n",
  'example/web/note.md':     'prose that says nobody and betaThing and AlphaError',
}

const PACKAGES = [
  { folder: 'alpha', pkg: JSON.parse(files['packages/alpha/package.json']) },
  { folder: 'beta',  pkg: JSON.parse(files['packages/beta/package.json']) },
]

beforeAll(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'fli-surface-'))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(ROOT, p, '..'), { recursive: true })
    writeFileSync(join(ROOT, p), body)
  }
})
afterAll(() => { try { rmSync(ROOT, { recursive: true, force: true }) } catch {} })

const surface = () => collectSurface({ root: ROOT, packages: PACKAGES })
const alpha   = () => surface().packages.find(p => p.folder === 'alpha')
const named   = (p, n) => p.names.find(x => x.name === n)

describe('files', () => {
  test('a tree without git is walked; .d.ts, .md and .lite are not sources', () => {
    const list = sourceFiles(ROOT)
    expect(list).toContain('example/api/app.ts')
    expect(list).toContain('example/api/app.test.ts')
    expect(list).not.toContain('example/api/types.d.ts')
    expect(list).not.toContain('example/web/note.md')
    expect(list).not.toContain('packages/alpha/db/a.lite')
  })
})

describe('entry points', () => {
  test('every exports key, main when there is no map', () => {
    expect(entryPoints(PACKAGES[0].pkg).map(e => e.key)).toEqual(['.', './side', './gen', './schema.lite', './widgets/*'])
    expect(entryPoints(PACKAGES[1].pkg)).toEqual([{ key: '.', file: 'index.js' }])
  })
  test('a condition map naming one file under two conditions is one entry', () => {
    expect(entryPoints({ exports: { '.': { import: './a.js', default: './a.js' } } })).toEqual([{ key: '.', file: 'a.js' }])
  })
  test('imported, unimported, pattern and not-source are told apart', () => {
    const e = Object.fromEntries(alpha().entries.map(x => [x.key, x]))
    expect(e['.'].importers).toBe(2)             // app.ts and app.test.ts (relative import resolves too)
    expect(e['./side'].importers).toBe(0)
    expect(e['./widgets/*'].importers).toBe(1)
    expect(e['./schema.lite'].importers).toBeNull()
    expect(alpha().totals.entriesUnimported).toBe(1)
  })
  test('an entry whose specifier the package writes into a string is emitted, not unimported', () => {
    const e = Object.fromEntries(alpha().entries.map(x => [x.key, x]))
    expect(e['./gen'].importers).toBe(0)
    expect(e['./gen'].emitted).toBe(true)
    expect(e['./side'].emitted).toBe(false)
    expect(alpha().totals.entriesEmitted).toBe(1)
  })
})

describe('exported names', () => {
  test('declarations, braces with rename and type marker, star-as, and a followed export *', () => {
    const text  = files['packages/alpha/index.ts']
    const texts = { 'packages/alpha/src/star.ts': files['packages/alpha/src/star.ts'] }
    const names = exportedNames('packages/alpha/index.ts', text, (from, spec) => {
      const p = 'packages/alpha/' + spec.replace('./', '') + '.ts'
      return texts[p] ? { path: p, text: texts[p] } : null
    })
    const kinds = Object.fromEntries(names.map(n => [n.name, n.kind]))
    expect(kinds.used).toBe('value')
    expect(kinds.AlphaError).toBe('value')
    expect(kinds.Shape).toBe('type')
    expect(kinds.Unused).toBe('type')
    expect(kinds.renamed).toBe('value')
    expect(kinds.inner).toBeUndefined()
    expect(kinds.Hidden).toBe('type')
    expect(kinds.fromStar).toBe('value')
    expect(kinds.starFn).toBe('value')
    expect(kinds.default).toBe('value')
  })
  test('a commented-out export is not one', () => {
    const beta = surface().packages.find(p => p.folder === 'beta')
    expect(beta.names.map(n => n.name)).toEqual(['betaThing'])
  })
})

describe('reach', () => {
  test('a token in any outside source file is reach, a test included', () => {
    const a = alpha()
    expect(named(a, 'used').reached).toBe(true)
    expect(named(a, 'onlyInTest').reached).toBe(true)
    expect(named(a, 'renamed').reached).toBe(true)
    expect(named(a, 'starFn').reached).toBe(true)
  })
  test('a type named in a type position is reached', () => {
    expect(named(alpha(), 'Shape').reached).toBe(true)
  })
  test('a .d.ts and a markdown file are not callers, and a suite string in the package does not emit', () => {
    const a = alpha()
    expect(named(a, 'Unused').reached).toBe(false)
    expect(named(a, 'AlphaError').reached).toBe(false)
    expect(named(a, 'AlphaError').emitted).toBe(false)
    expect(named(a, 'nobody').reached).toBe(false)
    expect(named(a, 'nobody').emitted).toBe(false)
  })
  test('a name the package writes into a string is emitted, not unreached', () => {
    const n = named(alpha(), 'emittedName')
    expect(n.reached).toBe(false)
    expect(n.emitted).toBe(true)
  })
  test('default is not graded', () => {
    expect(named(alpha(), 'default')).toBeUndefined()
  })
  test('totals split value from type and leave emitted out of unreached', () => {
    const t = alpha().totals
    expect(t.value).toBe(10)           // used onlyInTest nobody emittedName AlphaError renamed fromStar starFn side gen
    expect(t.valueUnreached).toBe(4)   // nobody AlphaError fromStar side
    expect(t.emitted).toBe(2)          // emittedName gen
    expect(t.type).toBe(3)             // Shape Unused Hidden
    expect(t.typeUnreached).toBe(2)
  })
})

describe('render', () => {
  test('names the generator, records crossings only, and is stable across runs', () => {
    const a = renderSurface(surface())
    expect(a.startsWith('<!-- generated by: fli ws:surface -->')).toBe(true)
    expect(a).toContain('**Entries imported by nothing outside (1):** `./side`')
    expect(a).toContain('**Entries emitted (1):** `./gen`')
    expect(a).toContain('**Unreached values (4):** `AlphaError` `fromStar` `nobody` `side`')
    expect(a).toContain('**Emitted (2):** `emittedName` `gen`')
    expect(a).toContain('**Unreached types (2):** `Hidden` `Unused`')
    expect(a).not.toMatch(/importers?: \d/)
    expect(renderSurface(surface())).toBe(a)
  })
})
