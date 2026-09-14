// ─── tiles ──────────────────────────────────────────────────────────────────
// core/tiles.js against a REAL git repository in a temp directory, because the
// two readers that can be wrong in silence are git's rename output and a
// coverage report's paths — a fixture string of either agrees with the parser
// that wrote it. Every refusal is paired with the case one step away that must
// still count, or a reader that counted nothing would pass.

import { test, expect, describe } from 'bun:test'
import { execFileSync }            from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir }                  from 'node:os'
import { join, dirname }           from 'node:path'
import { inflateSync }             from 'node:zlib'
import {
  gilbert, parseGitLog, indentSum, kindOf, band, parseLcov, collectTiles,
  tileBands, badgeCells, renderBadge, renderMap, regionReader, gridFor, PALETTE, AGE_DAYS,
} from '../core/tiles.js'
import { encodePng } from '../core/png.js'

// ─── helpers ────────────────────────────────────────────────────────────────

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fli-tiles-'))
  execFileSync('git', ['init', '-q', dir])
  write(dir, files)
  return dir
}
function write(dir, files) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), text)
  }
}
function commit(dir, message, at) {
  const env = { ...process.env, GIT_AUTHOR_DATE: `@${at} +0000`, GIT_COMMITTER_DATE: `@${at} +0000` }
  execFileSync('git', ['-C', dir, 'add', '-A'], { env })
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message], { env })
}

function decodePng(buf) {
  let at = 8, w = 0, h = 0
  const idat = []
  while (at < buf.length) {
    const len  = buf.readUInt32BE(at)
    const type = buf.toString('ascii', at + 4, at + 8)
    const data = buf.subarray(at + 8, at + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4) }
    if (type === 'IDAT') idat.push(data)
    at += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const pixel = (x, y) => [...raw.subarray(y * (w * 4 + 1) + 1 + x * 4, y * (w * 4 + 1) + 1 + x * 4 + 3)]
  return { w, h, pixel }
}
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

// ─── layout ─────────────────────────────────────────────────────────────────

describe('gilbert', () => {
  for (const [w, h] of [[66, 49], [8, 8], [5, 3], [1, 7], [7, 1], [2, 9]]) {
    test(`${w}×${h} visits every cell exactly once`, () => {
      const cells = gilbert(w, h)
      expect(cells.length).toBe(w * h)
      expect(new Set(cells.map(([x, y]) => `${x},${y}`)).size).toBe(w * h)
      expect(cells.every(([x, y]) => x >= 0 && y >= 0 && x < w && y < h)).toBe(true)
    })
  }

  // locality is the whole reason for the curve: a jump breaks a region in two
  test('an even rectangle never jumps between neighbors in path order', () => {
    const cells = gilbert(66, 50)
    const jumps = cells.slice(1).filter(([x, y], i) => Math.abs(x - cells[i][0]) + Math.abs(y - cells[i][1]) !== 1)
    expect(jumps).toEqual([])
  })
})

// ─── git ────────────────────────────────────────────────────────────────────

describe('parseGitLog', () => {
  const log = (...commits) => commits.map(([at, lines]) => `\x1e${at}\n\n${lines.join('\n')}\n`).join('')

  test('a rename carries the commits made under the old name', () => {
    const text = log(
      [300, ['R100\tsrc/old.js\tsrc/new.js']],
      [200, ['M\tsrc/old.js']],
      [100, ['A\tsrc/old.js']],
    )
    const out = parseGitLog(text, { known: new Set(['src/new.js']), sweepLimit: 50 })
    expect(out.churn.get('src/new.js')).toBe(3)
    expect(out.churn.has('src/old.js')).toBe(false)
  })

  test('a sweep is left out of churn and age, and one file fewer is not a sweep', () => {
    const names = n => Array.from({ length: n }, (_, i) => `M\tf${i}.js`)
    const known = new Set(Array.from({ length: 4 }, (_, i) => `f${i}.js`))
    const sweep = parseGitLog(log([200, names(4)], [100, ['A\tf0.js']]), { known, sweepLimit: 3 })
    expect(sweep.sweeps).toBe(1)
    expect(sweep.churn.get('f0.js')).toBe(1)
    expect(sweep.last.get('f0.js')).toBe(100)
    expect(sweep.lastAny.get('f1.js')).toBe(200)
    expect(sweep.last.has('f1.js')).toBe(false)

    const counted = parseGitLog(log([200, names(3)], [100, ['A\tf0.js']]), { known, sweepLimit: 3 })
    expect(counted.sweeps).toBe(0)
    expect(counted.churn.get('f0.js')).toBe(2)
    expect(counted.last.get('f0.js')).toBe(200)
  })
})

// ─── file readings ──────────────────────────────────────────────────────────

describe('indentSum', () => {
  test('two spaces, four spaces and tabs of one shape score the same', () => {
    const shape = unit => ['a {', `${unit}b {`, `${unit}${unit}c`, `${unit}}`, '}'].join('\n')
    const two = indentSum(shape('  ')), four = indentSum(shape('    ')), tab = indentSum(shape('\t'))
    expect(two.sum).toBe(4)
    expect(four.sum).toBe(two.sum)
    expect(tab.sum).toBe(two.sum)
    expect(two.lines).toBe(5)
  })
  test('blank lines count for nothing', () => {
    expect(indentSum('a\n\n\n  b\n').lines).toBe(2)
  })
})

test('kindOf reads the path', () => {
  expect(kindOf('src/app.ts')).toBe('source')
  expect(kindOf('tests/app.test.js')).toBe('test')
  expect(kindOf('src/app.spec.ts')).toBe('test')
  expect(kindOf('README.md')).toBe('doc')
  expect(kindOf('tsconfig.json')).toBe('config')
  expect(kindOf('web/vite.config.js')).toBe('config')
  expect(kindOf('db/ddl.snapshot.sql')).toBe('generated')
  expect(kindOf('bun.lock')).toBe('generated')
  expect(kindOf('public/logo.png')).toBe('asset')
})

test('band thresholds are exclusive below and the last one is strong', () => {
  expect([0, 1, 2, 3, 4, 7, 8].map(c => band(c, [0, 1, 3, 7]))).toEqual([0, 1, 2, 2, 3, 3, 4])
  expect(tileBands({ age: AGE_DAYS[0], churn: 0, complexity: null, tested: null }).age).toBe(4)
  expect(tileBands({ age: AGE_DAYS[0] + 0.1, churn: 0, complexity: null, tested: null }).age).toBe(3)
  expect(tileBands({ age: null, churn: 0, complexity: null, tested: null })).toEqual({ age: null, churn: 0, tested: null, complexity: null })
})

test('parseLcov reads each record and ignores the lines it does not use', () => {
  const text = 'TN:\nSF:src/a.js\nFN:1,f\nLF:10\nLH:9\nend_of_record\nSF:/abs/b.js\nLF:0\nLH:0\nend_of_record\n'
  expect(parseLcov(text)).toEqual([{ file: 'src/a.js', found: 10, hit: 9 }, { file: '/abs/b.js', found: 0, hit: 0 }])
})

test('a region is the nearest package below the root, else the top directory', () => {
  const regionOf = regionReader(['package.json', 'packages/a/package.json', 'packages/a/src/x.js', 'docs/y.md', 'z.md'])
  expect(regionOf('packages/a/src/x.js')).toBe('packages/a')
  expect(regionOf('docs/y.md')).toBe('docs')
  expect(regionOf('z.md')).toBe('(root)')
})

// ─── collect, over a real repository ────────────────────────────────────────

describe('collectTiles', () => {
  const T0 = 1_750_000_000

  test('tested comes from a test that names the file, one hop further is partly', () => {
    const dir = repo({
      'src/a.js':        "import { b } from './b.js'\nexport const a = b\n",
      'src/b.js':        'export const b = 1\n',
      'src/c.js':        'export const c = 1\n',
      'test/a.test.js':  "import { a } from '../src/a.js'\n",
      'README.md':       '# x\n',
    })
    commit(dir, 'one', T0)
    try {
      const model = collectTiles({ root: dir, now: (T0 + 86400 * 3) * 1000 })
      const by = Object.fromEntries(model.files.map(f => [f.path, f]))
      expect(by['src/a.js'].tested).toEqual({ level: 'tested', from: 'refs', refs: 1 })
      expect(by['src/b.js'].tested.level).toBe('partly')
      expect(by['src/c.js'].tested.level).toBe('untested')
      expect(by['README.md'].tested).toBeNull()
      expect(Math.round(by['src/c.js'].age)).toBe(3)
      expect(by['src/c.js'].churn).toBe(1)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('a coverage report wins for the files it names, and one older than a commit says so', () => {
    const dir = repo({
      'pkg/package.json':  '{}',
      'pkg/src/c.js':      'export const c = 1\n',
      'pkg/src/d.js':      'export const d = 1\n',
      'pkg/src/e.js':      'export const e = 1\n',
      '.gitignore':        'coverage/\n',
    })
    commit(dir, 'one', T0)
    write(dir, { 'pkg/coverage/lcov.info': 'SF:src/c.js\nLF:10\nLH:10\nend_of_record\nSF:' + join(dir, 'pkg/src/d.js') + '\nLF:10\nLH:3\nend_of_record\n' })
    try {
      utimesSync(join(dir, 'pkg/coverage/lcov.info'), T0 + 60, T0 + 60)
      const fresh = collectTiles({ root: dir, now: (T0 + 120) * 1000 })
      const by = Object.fromEntries(fresh.files.map(f => [f.path, f]))
      expect(by['pkg/src/c.js'].tested).toEqual({ level: 'tested', from: 'lcov', pct: 100 })
      expect(by['pkg/src/d.js'].tested).toEqual({ level: 'partly', from: 'lcov', pct: 30 })
      expect(by['pkg/src/e.js'].tested.from).toBe('refs')
      expect(fresh.reports).toEqual([{ path: 'pkg/coverage/lcov.info', files: 2, madeAt: T0 + 60, stale: false }])
      expect(by['pkg/src/c.js'].region).toBe('pkg')

      utimesSync(join(dir, 'pkg/coverage/lcov.info'), T0 - 60, T0 - 60)
      expect(collectTiles({ root: dir, now: (T0 + 120) * 1000 }).reports[0].stale).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ─── the pictures ───────────────────────────────────────────────────────────

const file = (over) => ({ path: 'src/x.js', kind: 'source', region: 'src', age: 0.5, churn: 9, complexity: 5000, lines: 1, tested: { level: 'untested', from: 'refs', refs: 0 }, ...over })

describe('badge', () => {
  test('every quadrant is sixteen cells, strongest band first', () => {
    const model = { files: [file(), file(), file({ age: 400, churn: 0, complexity: 1, tested: { level: 'tested' } }), file({ kind: 'doc', tested: null })] }
    const cells = badgeCells(model)
    for (const q of Object.values(cells)) expect(q.length).toBe(16)
    expect(cells.age.slice(0, 11)).toEqual(Array(11).fill(4))
    expect(cells.age.slice(11)).toEqual(Array(5).fill(0))
    expect(cells.tested.filter(b => b === 4).length).toBe(11)
  })

  test('a project with no source draws every cell as not applicable', () => {
    const cells = badgeCells({ files: [file({ kind: 'doc' })] })
    expect(cells.churn).toEqual(Array(16).fill(null))
  })

  test('the first cell of each waffle is painted in its strongest band', () => {
    const png = decodePng(renderBadge({ files: [file()] }, { scale: 6 }))
    expect(png.w).toBe(png.h)
    expect(png.pixel(3, 3)).toEqual(rgb(PALETTE.age[4]))
    expect(png.pixel(3 + 27 + 3, 3)).toEqual(rgb(PALETTE.churn[4]))
  })
})

test('gridFor is just big enough, at about 4:3', () => {
  for (const n of [1, 2, 7, 1223, 3184]) {
    const { w, h } = gridFor(n)
    expect(w * h).toBeGreaterThanOrEqual(n)
    expect(w * (h - 1)).toBeLessThan(n)
  }
})

test('the map draws source only, and --all draws every kind', () => {
  const model = { files: [file(), file({ path: 'README.md', kind: 'doc', tested: null }), file({ path: 'src/z.js' })] }
  const source = decodePng(renderMap(model, { scale: 8 }))
  const every  = decodePng(renderMap(model, { scale: 8, all: true }))
  expect([source.w, source.h]).toEqual([gridFor(2).w * 8 + 1, gridFor(2).h * 8 + 1])
  expect([every.w, every.h]).toEqual([gridFor(3).w * 8 + 1, gridFor(3).h * 8 + 1])
  // the second tile is the doc on --all and src/z.js without it; the TESTED quadrant says which
  const second = ({ w, h }) => gilbert(w, h)[1]
  const [ex, ey] = second(gridFor(3)), [sx, sy] = second(gridFor(2))
  expect(every.pixel(ex * 8 + 1, ey * 8 + 6)).toEqual(rgb(PALETTE.na))
  expect(source.pixel(sx * 8 + 1, sy * 8 + 6)).toEqual(rgb(PALETTE.tested[4]))
})

test('the map is one tile per grid cell, with its four quadrants where the legend says', () => {
  const model = { files: [file(), file({ path: 'src/y.js', age: 400, churn: 0, complexity: 1, tested: { level: 'tested' } })] }
  const png = decodePng(renderMap(model, { scale: 8 }))
  expect([png.w, png.h]).toEqual([gridFor(2).w * 8 + 1, gridFor(2).h * 8 + 1])
  expect(png.pixel(1, 1)).toEqual(rgb(PALETTE.age[4]))
  expect(png.pixel(6, 1)).toEqual(rgb(PALETTE.churn[4]))
  expect(png.pixel(1, 6)).toEqual(rgb(PALETTE.tested[4]))
  expect(png.pixel(6, 6)).toEqual(rgb(PALETTE.complexity[4]))
  expect(png.pixel(9 + 1, 1)).toEqual(rgb(PALETTE.age[0]))
})

test('a stored PNG over one deflate block still inflates to its pixels', () => {
  const rgba = Buffer.alloc(200 * 100 * 4, 7)
  const png = decodePng(encodePng(200, 100, rgba, { stored: true }))
  expect(png.pixel(199, 99)).toEqual([7, 7, 7])
})
