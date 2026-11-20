// export-names.test.js — the duplicate-name ratchet behind `fli ws:exports` (FJS-D2278).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sharedNames, parseBaseline, newDuplicates, sectionLines, SECTION_TITLE } from '../core/export-names.js'

let root

// One package per entry: `{ name, 'index.js': source }`, each published at `.`.
const workspace = (specs) => specs.map(({ name, source }) => {
  const dir = join(root, name.replace(/\W/g, '_'))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.js'), source)
  return { pkg: { name, exports: { '.': './index.js' } }, dir }
})

beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'export-names-')) })
afterAll(() => { rmSync(root, { recursive: true, force: true }) })

describe('sharedNames', () => {
  test('a name two packages each declare is shared', () => {
    const pkgs = workspace([
      { name: '@t/a', source: 'export const kebab = 1\n' },
      { name: '@t/b', source: 'export function kebab() {}\n' },
    ])
    expect(sharedNames(pkgs).map(s => s.name)).toEqual(['kebab'])
  })

  test('import-then-export is a re-export, not a second declaration', () => {
    const pkgs = workspace([
      { name: '@t/base', source: 'export const humanize = 1\nexport const shout = 2\nexport const dflt = 3\n' },
      { name: '@t/viaimport', source: "import { humanize } from '@t/base'\nexport { humanize }\n" },
      { name: '@t/viaalias', source: "import { shout as loud } from '@t/base'\nexport { loud as shout }\n" },
      { name: '@t/viadefault', source: "import dflt from '@t/base'\nexport { dflt }\n" },
    ])
    expect(sharedNames(pkgs)).toEqual([])
  })

  test('a bare export of a local binding is still a declaration', () => {
    const pkgs = workspace([
      { name: '@t/one', source: 'const mine = 1\nexport { mine }\n' },
      { name: '@t/two', source: 'export const mine = 2\n' },
    ])
    expect(sharedNames(pkgs).map(s => s.name)).toEqual(['mine'])
  })
})

describe('the ratchet', () => {
  const shared = (name, ...pkgs) => ({ name, packages: pkgs.map(pkg => ({ pkg, subpath: '.' })) })
  const decisions = '### <a id="fjs-d1"></a>2026-11-19 · `FJS-D1` — Is `ruled` one thing in `@t/a` and `@t/b`\n'

  test('the section round-trips through its own parser', () => {
    const lines = sectionLines([shared('x', '@t/a', '@t/b')], decisions)
    const baseline = parseBaseline(`# t\n\n${SECTION_TITLE}\n\nprose\n\n${lines.join('\n')}\n\n## \`@t/a\`\n`)
    expect([...baseline.get('x')]).toEqual(['@t/a', '@t/b'])
  })

  test('a snapshot with no section has no baseline, so nothing is new', () => {
    expect(parseBaseline('# t\n')).toBeNull()
    expect(newDuplicates([shared('x', '@t/a', '@t/b')], null, '')).toEqual([])
  })

  test('a name already in the baseline passes; a new pair fails', () => {
    const baseline = new Map([['old', new Set(['@t/a', '@t/b'])]])
    expect(newDuplicates([shared('old', '@t/a', '@t/b')], baseline, '')).toEqual([])
    expect(newDuplicates([shared('fresh', '@t/a', '@t/b')], baseline, ''))
      .toEqual([{ name: 'fresh', packages: [{ pkg: '@t/a', subpath: '.' }, { pkg: '@t/b', subpath: '.' }] }])
  })

  test('a third package joining a baseline name is a new pair', () => {
    const baseline = new Map([['old', new Set(['@t/a', '@t/b'])]])
    const [hit] = newDuplicates([shared('old', '@t/a', '@t/b', '@t/c')], baseline, '')
    expect(hit.packages.map(p => p.pkg)).toEqual(['@t/c', '@t/a'])
  })

  test('a ruling whose heading names the name and every package lets the pair pass', () => {
    expect(newDuplicates([shared('ruled', '@t/a', '@t/b')], new Map(), decisions)).toEqual([])
    expect(newDuplicates([shared('ruled', '@t/a', '@t/c')], new Map(), decisions)).toHaveLength(1)
  })

  test('a name that stopped being shared is absent from the next section', () => {
    expect(sectionLines([], decisions)).toEqual([])
  })
})
