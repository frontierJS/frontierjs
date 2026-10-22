// test/file-tree.test.js — core/file-tree.js and `fli tree`
//
// Color is off under the runner (stdout is not a terminal), so a row here is
// the plain text a pipe receives. The counts are graded beside the rows,
// because a closed or compacted folder is where a file can fall out of the
// total while the drawing still looks right.

import { test, expect, describe, afterAll } from 'bun:test'
import { spawnSync }                        from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir }                           from 'node:os'
import { join, resolve }                    from 'node:path'
import {
  buildTree, compactTree, renderTree, treeDepth, fileIcon, folderColor, listPaths,
  visibleWidth, buildLanes, layoutLanes, drawLanes,
} from '../core/file-tree.js'

const FLI = resolve(import.meta.dir, '../bin/fli.js')

const PATHS = [
  'README.md',
  'package.json',
  'db/schema.lite',
  'db/migrations/main/001.sql',
  'api/src/app.ts',
  'api/test/app.test.ts',
  'web/src/resources/Lead.mesa',
  'zeta.js',
  'Alpha.js',
]

describe('renderTree', () => {
  test('folders first, then files, case-insensitive; guides nest', () => {
    const { rows } = renderTree(buildTree(PATHS), { icons: false, compact: false })
    expect(rows).toEqual([
      '├── api',
      '│   ├── src',
      '│   │   └── app.ts',
      '│   └── test',
      '│       └── app.test.ts',
      '├── db',
      '│   ├── migrations',
      '│   │   └── main',
      '│   │       └── 001.sql',
      '│   └── schema.lite',
      '├── web',
      '│   └── src',
      '│       └── resources',
      '│           └── Lead.mesa',
      '├── Alpha.js',
      '├── package.json',
      '├── README.md',
      '└── zeta.js',
    ])
  })

  test('a compacted chain is one row and still counts every folder in it', () => {
    const { rows, counts } = renderTree(compactTree(buildTree(PATHS)), { icons: false })
    expect(rows).toContain('│   ├── migrations/main')
    expect(rows).toContain('├── web/src/resources')
    expect(counts).toEqual({ dirs: 9, files: 9 })
  })

  test('a folder past the depth is closed, shows its file count, and its files are still counted', () => {
    const { rows, counts } = renderTree(buildTree(PATHS), { icons: false, depth: 1 })
    expect(rows.slice(0, 3)).toEqual(['├── api (2)', '├── db (2)', '├── web (1)'])
    expect(counts.files).toBe(9)
  })

  test('--dirs draws no file and counts them all', () => {
    const { rows, counts } = renderTree(buildTree(PATHS), { icons: false, dirsOnly: true })
    expect(rows.some(r => /\.(md|js|json|ts|lite|mesa|sql)$/.test(r))).toBe(false)
    expect(counts.files).toBe(9)
  })

  test('icons sit before the name; a folder past the depth is the closed one', () => {
    const { rows } = renderTree(buildTree(['db/schema.lite', 'a.mesa']), { depth: 1 })
    expect(rows).toEqual(['├── 📁 db (1)', '└── 🌵 a.mesa'])
  })
})

describe('icons and colors', () => {
  test('a name outranks a pattern, and a pattern outranks an extension', () => {
    expect(fileIcon('package.json')[0]).toBe('📦')
    expect(fileIcon('tsconfig.json')[0]).toBe('🔧')
    expect(fileIcon('app.test.ts')[0]).toBe('🧪')
    expect(fileIcon('ddl.snapshot.sql')[0]).toBe('🧊')
    expect(fileIcon('.env.production')[0]).toBe('🔑')
    expect(fileIcon('Makefile')[0]).toBe('📄')
  })

  // An emoji that needs U+FE0F is one cell in some terminals and two in others.
  test('every icon is a single code point with emoji presentation', () => {
    const all = ['package.json', 'README.md', 'x.lite', 'x.mesa', 'x.ts', 'x.js', 'x.json', 'x.css', 'x.html',
      'x.db', 'x.sh', 'x.png', 'x.svg', 'x.pdf', 'x.wasm', 'x.yml', '.gitignore', 'Dockerfile', 'x.test.js']
    for (const n of all) {
      const [emoji] = fileIcon(n)
      expect([...emoji]).toHaveLength(1)
      expect(/\p{Emoji_Presentation}/u.test(emoji)).toBe(true)
    }
  })

  test('a compacted folder takes the color of its deepest named segment', () => {
    expect(folderColor('db')).toBe(folderColor('migrations/main'))
    expect(folderColor('cli/src/routes')).toBe(folderColor('routes'))
    expect(folderColor('.github/workflows')).toBe('#9e9e9e')
    expect(folderColor('shell')).toBe(null)
  })
})

describe('lanes', () => {
  const lane = (name, n) => ({ rows: [name, ...Array.from({ length: n - 1 }, (_, i) => `${name}${i}`)], cont: `${name}+` })

  test('a row is measured in cells — escapes are zero, an emoji is two', () => {
    expect(visibleWidth('\x1b[1m📂 \x1b]8;;file:///x\x1b\\ab\x1b]8;;\x1b\\\x1b[22m')).toBe(5)
    expect(visibleWidth('│   ├── x')).toBe(9)
  })

  test('one lane per top-level folder, then the files at the root', () => {
    const lanes = buildLanes(buildTree(PATHS), { icons: false })
    expect(lanes.map(l => l.rows[0])).toEqual(['api', 'db', 'web', 'files'])
    expect(lanes[0].rows).toEqual(['api', '├── src', '│   └── app.ts', '└── test', '    └── app.test.ts'])
    expect(buildLanes(buildTree(PATHS), { icons: false, dirsOnly: true }).map(l => l.rows[0])).toEqual(['api', 'db', 'web'])
  })

  test('at depth 1 every lane is one closed row with its count', () => {
    const lanes = buildLanes(buildTree(PATHS), { icons: false, depth: 1 })
    expect(lanes.slice(0, 3).map(l => l.rows)).toEqual([['api (2)'], ['db (2)'], ['web (1)']])
  })

  test('lanes go down a column, then across, kept whole when that fits the height', () => {
    // Three columns are 12 cells; at 10 the shortest layout stacks b and c.
    const layout = layoutLanes([lane('a', 4), lane('b', 2), lane('c', 3)], { width: 10, height: 10 })
    expect(drawLanes(layout)).toEqual([
      'a    b',
      'a0   b0',
      'a1',
      'a2   c',
      '     c0',
      '     c1',
    ])
  })

  test('a lane taller than the screen is cut, and its next piece is headed (cont.)', () => {
    const layout = layoutLanes([lane('a', 12), lane('b', 2)], { width: 40, height: 6 })
    expect(layout.height).toBeLessThanOrEqual(8)
    const cols = layout.columns.map(c => c.cells.map(x => x[0]))
    expect(cols[1][0]).toBe('a+')
    expect(cols.flat().filter(r => r && r !== 'a+')).toHaveLength(14)
  })

  test('two one-row lanes stack with no blank between them', () => {
    const layout = layoutLanes([lane('a', 1), lane('b', 1), lane('c', 3)], { width: 3, height: 10 })
    expect(drawLanes(layout)).toEqual(['a', 'b', '', 'c', 'c0', 'c1'])
  })

  test('nothing fits the width: one column, never a crash', () => {
    const layout = layoutLanes([lane('wide-lane', 2), lane('other', 2)], { width: 3 })
    expect(layout.columns).toHaveLength(1)
  })

  test('columns are padded by cells, so an emoji row lines up', () => {
    const layout = layoutLanes([{ rows: ['📂 a'], cont: '' }, { rows: ['bbbb'], cont: '' }], { width: 20, height: 1 })
    expect(drawLanes(layout, { gap: 1 })).toEqual(['📂 a bbbb'])
  })

  test('treeDepth counts a compacted chain as one level', () => {
    expect(treeDepth(buildTree(PATHS))).toBe(4)
    expect(treeDepth(compactTree(buildTree(PATHS)))).toBe(3)
  })
})

describe('listPaths', () => {
  const dirs = []
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

  test('outside git it reads the disk and skips node_modules', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-tree-'))
    dirs.push(root)
    mkdirSync(join(root, 'node_modules/x'), { recursive: true })
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'node_modules/x/index.js'), '')
    writeFileSync(join(root, 'src/a.js'), '')
    writeFileSync(join(root, 'README.md'), '')
    expect(listPaths(root).sort()).toEqual(['README.md', 'src/a.js'])
  })

  test('inside git it leaves ignored files out', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-tree-'))
    dirs.push(root)
    spawnSync('git', ['init', '-q'], { cwd: root })
    writeFileSync(join(root, '.gitignore'), 'dist/\n')
    mkdirSync(join(root, 'dist'))
    writeFileSync(join(root, 'dist/out.js'), '')
    writeFileSync(join(root, 'a.js'), '')
    expect(listPaths(root).sort()).toEqual(['.gitignore', 'a.js'])
  })
})

describe('fli tree', () => {
  test('piped, it prints plain rows and the count', () => {
    const root = mkdtempSync(join(tmpdir(), 'fli-tree-'))
    mkdirSync(join(root, 'db'))
    writeFileSync(join(root, 'db/schema.lite'), '')
    writeFileSync(join(root, 'README.md'), '')
    const run = spawnSync(process.execPath, [FLI, 'tree', root], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
    rmSync(root, { recursive: true, force: true })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('├── db\n│   └── schema.lite\n└── README.md\n')
    expect(run.stdout).toContain('1 folder, 2 files')
  })
})

// FJS-3145: a suite that builds into `test/tmp-*` is read as a clone's file by
// treePaths while the suite deletes it, so every reader of the tree races it.
describe('tmp- scratch dirs beside a test', () => {
  test('are ignored, so treePaths never lists one', () => {
    const REPO = resolve(import.meta.dir, '../../..')
    const probe = 'packages/sierra/test/tmp-probe/src/blocks/Badge.mesa'
    const run = spawnSync('git', ['check-ignore', '-q', probe], { cwd: REPO })
    expect(run.status).toBe(0)
  })
})
