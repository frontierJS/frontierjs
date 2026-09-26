// ─── codegraph ──────────────────────────────────────────────────────────────
// core/codegraph.js against a REAL git repository in a temp directory, because the
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
  gilbert, parseGitLog, indentSum, band, parseLcov, collectCodegraph, heatOf, exposureOf, scoreOf, LEVEL,
  tileBands, badgeCells, renderBadge, renderMap, regionReader, gridFor, AGE_DAYS, HALF_LIFE_DAYS, SCORE_RAMP, SCORE_WARN,
  themesIn, themeTokens, mixOklab, turnOklch, deltaOklab, scoreRamp, paletteFrom, paletteCss, isHotspot, bandLabels, MIX, TONES, STRONG, QUADRANTS, MORE,
  exportTarget, packageIndex, referenceGraph, coreRegions, coreLayout, packageGrid, depthLayout, unpublishedDirs, isCode,
  importGraph, layerGraph, stripComments, CYCLE_SIZE, COGNITIVE,
} from '../core/codegraph.js'
import { renderPage } from '../core/codegraph-page.js'
import { typeScriptAt, measureFunctions, worstFunction, PARSABLE } from '../core/functions.js'
import { ownStyleBundle } from '../core/assets.js'
import { encodePng } from '../core/png.js'

// ─── helpers ────────────────────────────────────────────────────────────────

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'fli-codegraph-'))
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

// A stylesheet shaped like @frontierjs/css's: a :root block, then themes that
// override some of it — one through var(), one leaving a token to the root.
const CSS = `@layer tokens{:root,:host{--surface:#ffffff;--surface-sunken:#f5f5f5;--rule-strong:#dddddd;--ink-mute:#777777;--color-info:#0000ff;--color-warning:#ff8800;--color-danger:#ff0000;--color-success:#00aa00;--color-primary:#8800ff;--brand:#123456}}
@layer themes{.theme-light{--color-info:var(--brand)}.theme-night{--surface:#000;--color-danger:oklch(60% 0.2 30)}}`
const PALETTE = paletteFrom(CSS, 'light')

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

  test('heat reads the commits a sweep leaves out, and created reads the oldest commit, sweep or not', () => {
    const names = n => Array.from({ length: n }, (_, i) => `M\tf${i}.js`)
    const known = new Set(Array.from({ length: 4 }, (_, i) => `f${i}.js`))
    const out = parseGitLog(log([300, ['M\tf0.js']], [200, names(4)], [100, ['A\tf0.js']]), { known, sweepLimit: 3 })
    expect(out.times.get('f0.js')).toEqual([300, 100])
    expect(out.times.has('f1.js')).toBe(false)
    expect(out.first.get('f0.js')).toBe(100)
    expect(out.first.get('f1.js')).toBe(200)
  })
})

test('heat is one per commit today, halving every half-life', () => {
  const now = 1_750_000_000, day = 86400
  expect(heatOf([now], now)).toBe(1)
  expect(heatOf([now - HALF_LIFE_DAYS * day], now)).toBeCloseTo(0.5)
  expect(heatOf([now, now - 2 * HALF_LIFE_DAYS * day], now)).toBeCloseTo(1.25)
  expect(heatOf([], now)).toBe(0)
})

test('exposure is the complexity coverage leaves, half for partly, and nothing where coverage has no answer', () => {
  const src = (tested, complexity = 1000) => ({ kind: 'source', complexity, tested })
  expect(exposureOf(src({ level: 'untested', from: 'refs' }))).toBe(1000)
  expect(exposureOf(src({ level: 'partly', from: 'refs' }))).toBe(500)
  expect(exposureOf(src({ level: 'tested', from: 'refs' }))).toBe(0)
  expect(exposureOf(src({ level: 'partly', from: 'lcov', pct: 30 }))).toBe(700)
  expect(exposureOf(src({ level: null, from: 'lcov', pct: null }))).toBeNull()
  expect(exposureOf({ kind: 'doc', complexity: 1000, tested: null })).toBeNull()
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

test('band thresholds are exclusive below and the last one is strong', () => {
  expect([0, 1, 2, 3, 4, 7, 8].map(c => band(c, [0, 1, 3, 7]))).toEqual([0, 1, 2, 2, 3, 3, 4])
  expect(tileBands({ age: AGE_DAYS[0], churn: 0, complexity: null, tested: null }).age).toBe(STRONG)
  expect(tileBands({ age: AGE_DAYS[0] + 0.1, churn: 0, complexity: null, tested: null }).age).toBe(STRONG - 1)
  // not source: blast radius and exposure do not apply, and a file with no commits is cold
  expect(tileBands({ age: null, churn: 0, complexity: null, tested: null }))
    .toEqual({ heat: 0, blast: null, complexity: null, exposure: null, age: null, churn: 0, tested: null, cycle: null, cognitive: null })
  expect(Object.keys(tileBands({}))).toEqual([...QUADRANTS, ...MORE])
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

describe('collectCodegraph', () => {
  const T0 = 1_750_000_000

  test('tested comes from a test that names the file, one hop further is partly', () => {
    const dir = repo({
      'src/a.js':        "import { b } from './b.js'\nexport const a = b\n",
      'src/b.js':        'export function b() {\n  return 1\n}\n',
      'src/c.js':        'export function c() {\n  return 1\n}\n',
      'test/a.test.js':  "import { a } from '../src/a.js'\n",
      'README.md':       '# x\n',
    })
    commit(dir, 'one', T0)
    write(dir, { 'src/c.js': 'export function c() {\n  return 2\n}\n' })
    commit(dir, 'two', T0 + 86400)
    try {
      const model = collectCodegraph({ root: dir, now: (T0 + 86400 * 3) * 1000 })
      const by = Object.fromEntries(model.files.map(f => [f.path, f]))
      expect(by['src/a.js'].tested).toEqual({ level: 'tested', from: 'refs', refs: 1 })
      expect(by['src/b.js'].tested.level).toBe('partly')
      expect(by['src/c.js'].tested.level).toBe('untested')
      expect(by['README.md'].tested).toBeNull()
      expect(Math.round(by['src/c.js'].age)).toBe(2)
      expect(Math.round(by['src/c.js'].created)).toBe(3)
      expect(by['src/c.js'].churn).toBe(2)
      expect(by['src/c.js'].heat).toBeCloseTo(0.5 ** (2 / HALF_LIFE_DAYS) + 0.5 ** (3 / HALF_LIFE_DAYS), 2)
      // one level of indent over one line: untested keeps all of it, partly half
      expect([by['src/c.js'].exposure, by['src/b.js'].exposure, by['README.md'].exposure]).toEqual([1, 1, null])
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
      const fresh = collectCodegraph({ root: dir, now: (T0 + 120) * 1000 })
      const by = Object.fromEntries(fresh.files.map(f => [f.path, f]))
      expect(by['pkg/src/c.js'].tested).toEqual({ level: 'tested', from: 'lcov', pct: 100 })
      expect(by['pkg/src/d.js'].tested).toEqual({ level: 'partly', from: 'lcov', pct: 30 })
      expect(by['pkg/src/e.js'].tested.from).toBe('refs')
      expect(fresh.reports).toEqual([{ path: 'pkg/coverage/lcov.info', files: 2, madeAt: T0 + 60, stale: false }])
      expect(by['pkg/src/c.js'].region).toBe('pkg')

      utimesSync(join(dir, 'pkg/coverage/lcov.info'), T0 - 60, T0 - 60)
      expect(collectCodegraph({ root: dir, now: (T0 + 120) * 1000 }).reports[0].stale).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ─── the pictures ───────────────────────────────────────────────────────────

// loud in every quadrant; `quiet` below is faint in every one
const file = (over) => ({ path: 'src/x.js', kind: 'source', region: 'src', age: 0.5, churn: 9, heat: 5, usedBy: 20, complexity: 5000, exposure: 5000, lines: 1, tested: { level: 'untested', from: 'refs', refs: 0 }, ...over })
const quiet = over => file({ path: 'src/y.js', age: 400, churn: 0, heat: 0, usedBy: 0, complexity: 1, exposure: 0, tested: { level: 'tested' }, ...over })

describe('badge', () => {
  test('every quadrant is sixteen cells, strongest band first', () => {
    const model = { files: [file(), file(), quiet(), file({ kind: 'doc', tested: null })] }
    const cells = badgeCells(model)
    expect(Object.keys(cells)).toEqual(QUADRANTS)
    for (const q of Object.values(cells)) expect(q.length).toBe(16)
    expect(cells.heat.slice(0, 11)).toEqual(Array(11).fill(STRONG))
    expect(cells.heat.slice(11)).toEqual(Array(5).fill(0))
    expect(cells.exposure.filter(b => b === STRONG).length).toBe(11)
  })

  test('a project with no source draws every cell as not applicable', () => {
    const cells = badgeCells({ files: [file({ kind: 'doc' })] })
    expect(cells.blast).toEqual(Array(16).fill(null))
  })

  test('the first cell of each waffle is painted in its strongest band', () => {
    const png = decodePng(renderBadge({ files: [file()] }, { palette: PALETTE, scale: 6 }))
    expect(png.w).toBe(png.h)
    expect(png.pixel(3, 3)).toEqual(rgb(PALETTE.heat[STRONG]))
    expect(png.pixel(3 + 27 + 3, 3)).toEqual(rgb(PALETTE.blast[STRONG]))
  })
})

test('gridFor is just big enough, at about 4:3', () => {
  for (const n of [1, 2, 7, 1223, 3184]) {
    const { w, h } = gridFor(n)
    expect(w * h).toBeGreaterThanOrEqual(n)
    expect(w * (h - 1)).toBeLessThan(n)
  }
})

// Where coreLayout puts file k of the set the map draws, in pixels at scale 8.
const tileAt = (model, drawn, k) => {
  const { w, h, cells } = coreLayout(drawn, coreRegions(model.files), model.uses)
  return { w: w * 8 + 1, h: h * 8 + 1, x: cells[k][0] * 8, y: cells[k][1] * 8 }
}

test('the map draws source only, and --all draws every kind', () => {
  const doc   = file({ path: 'README.md', kind: 'doc', tested: null })
  const model = { files: [file(), doc, file({ path: 'src/z.js' })] }
  const source = decodePng(renderMap(model, { palette: PALETTE, scale: 8 }))
  const every  = decodePng(renderMap(model, { palette: PALETTE, scale: 8, all: true }))
  // the doc's EXPOSURE quadrant is ground; a source file's is untested complexity
  const s = tileAt(model, [model.files[0], model.files[2]], 1)
  const e = tileAt(model, model.files, 1)
  expect([source.w, source.h]).toEqual([s.w, s.h])
  expect([every.w, every.h]).toEqual([e.w, e.h])
  expect(every.pixel(e.x + 6, e.y + 6)).toEqual(rgb(PALETTE.na))
  expect(source.pixel(s.x + 6, s.y + 6)).toEqual(rgb(PALETTE.exposure[STRONG]))
})

test('the map lays files around the core, with each tile\'s four quadrants where the legend says', () => {
  const model = { files: [file(), quiet()] }
  const png = decodePng(renderMap(model, { palette: PALETTE, scale: 8 }))
  const loud = tileAt(model, model.files, 0), calm = tileAt(model, model.files, 1)
  expect([png.w, png.h]).toEqual([loud.w, loud.h])
  expect(QUADRANTS).toEqual(['heat', 'blast', 'complexity', 'exposure'])
  expect(png.pixel(loud.x + 1, loud.y + 1)).toEqual(rgb(PALETTE.heat[STRONG]))
  expect(png.pixel(loud.x + 6, loud.y + 1)).toEqual(rgb(PALETTE.blast[STRONG]))
  expect(png.pixel(loud.x + 1, loud.y + 6)).toEqual(rgb(PALETTE.complexity[STRONG]))
  expect(png.pixel(loud.x + 6, loud.y + 6)).toEqual(rgb(PALETTE.exposure[STRONG]))
  expect(png.pixel(calm.x + 1, calm.y + 1)).toEqual(rgb(PALETTE.heat[0]))
  expect(png.pixel(calm.x + 6, calm.y + 6)).toEqual(rgb(PALETTE.exposure[0]))
})

test('a stored PNG over one deflate block still inflates to its pixels', () => {
  const rgba = Buffer.alloc(200 * 100 * 4, 7)
  const png = decodePng(encodePng(200, 100, rgba, { stored: true }))
  expect(png.pixel(199, 99)).toEqual([7, 7, 7])
})

// ─── color ──────────────────────────────────────────────────────────────────

describe('palette', () => {
  test('a theme overrides the root, resolves var(), and a token it leaves falls to the root', () => {
    expect(themesIn(CSS)).toEqual(['light', 'night'])
    const light = themeTokens(CSS, 'light')
    expect(light('color-info')).toBe('#123456')
    expect(light('color-danger')).toBe('#ff0000')
    expect(themeTokens(CSS, 'night')('surface')).toBe('#000000')
  })

  test('a value a PNG cannot draw is refused by name, and so is a theme nobody declared', () => {
    expect(() => themeTokens(CSS, 'night')('color-danger')).toThrow(/--color-danger is "oklch/)
    expect(() => themeTokens(CSS, 'nope')).toThrow(/one of: light, night/)
  })

  test('the mix is oklab: black and white halfway is oklab mid-grey, and the ends are the inputs', () => {
    expect(mixOklab('#000000', '#ffffff', 50)).toBe('#636363')
    expect(mixOklab('#ff8800', '#ffffff', 100)).toBe('#ff8800')
    expect(mixOklab('#ff8800', '#ffffff', 0)).toBe('#ffffff')
  })

  test('each metric ramps from mostly ground to its tone, one step per band', () => {
    for (const m of [...QUADRANTS, ...MORE]) expect(PALETTE[m]).toHaveLength(MIX.length)
    expect(PALETTE.heat[STRONG]).toBe('#123456')
    expect(PALETTE[Object.keys(TONES).find(m => TONES[m] === 'warning')][0]).toBe(mixOklab('#ff8800', '#ffffff', MIX[0]))
    expect(PALETTE.na).toBe('#f5f5f5')
  })

  test('a hue turn in oklch keeps lightness and chroma, and a whole turn is the input', () => {
    expect(turnOklch('#dc2626', 360)).toBe('#dc2626')
    expect(deltaOklab(turnOklch('#dc2626', -80), '#dc2626')).toBeGreaterThan(10)
  })

  // The claim the score's colors rest on: each step further from the ground than
  // the one before. Graded over every theme the real stylesheet ships, because
  // the steps are one tone turned and mixed, and a theme is what moves the tone.
  test('the score ramp climbs away from the ground in every theme @frontierjs/css ships', () => {
    const css = ownStyleBundle()
    const themes = themesIn(css)
    expect(themes.length).toBeGreaterThan(1)
    for (const theme of themes) {
      const token = themeTokens(css, theme), surface = token('surface')
      const far = scoreRamp(token('color-danger'), surface).map(c => deltaOklab(c, surface))
      expect(far).toHaveLength(SCORE_RAMP.length)
      far.slice(1).forEach((d, i) => expect(d, `${theme} step ${i + 1}`).toBeGreaterThan(far[i]))
    }
    expect(PALETTE.score).toEqual(scoreRamp('#ff0000', '#ffffff'))
  })

  test('the page states the same ramps as color-mix over the same tones, with no hex', () => {
    const css = paletteCss()
    for (const [metric, tone] of Object.entries(TONES))
      expect(css).toContain(`--tile-${metric}-${STRONG}: color-mix(in oklab, var(--color-${tone}) ${MIX[STRONG]}%, var(--surface));`)
    const [p, deg] = SCORE_RAMP.at(-1)
    expect(css).toContain(`--tile-score-${SCORE_RAMP.length - 1}: color-mix(in oklab, oklch(from var(--color-danger) l c calc(h + ${deg})) ${p}%, var(--surface));`)
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i)
  })
})

test('band labels come off the thresholds that grade', () => {
  expect(bandLabels().heat).toEqual(['cold', '≤1', '≤3', '>3'])
  expect(bandLabels().blast).toEqual(['unused', '≤3', '≤15', '>15'])
  expect(bandLabels().churn).toEqual(['0', '1–3', '4–7', '8+'])
  expect(bandLabels().tested).toEqual(['tested', 'partly', null, 'untested'])
  expect(bandLabels().age.at(-1)).toBe(`≤${AGE_DAYS[0]}d`)
  expect(bandLabels().score).toHaveLength(SCORE_RAMP.length)
})

test('a hotspot is source in the top two bands of both heat and exposure', () => {
  expect(isHotspot(file())).toBe(true)
  expect(isHotspot(file({ kind: 'test' }))).toBe(false)
  expect(isHotspot(file({ heat: 0.5 }))).toBe(false)
  expect(isHotspot(file({ exposure: 50 }))).toBe(false)
})

describe('score', () => {
  test('each level passes through its band cutoffs rather than snapping to them', () => {
    expect([100, 400, 1600, 3200].map(LEVEL.exposure)).toEqual([1, 2, 3, 3])
    expect([0.25, 1, 4].map(LEVEL.heat)).toEqual([1, 2, 3])
    expect(LEVEL.exposure(200)).toBeCloseTo(1.5)
    expect([0, 15].map(LEVEL.blast)).toEqual([0, 3])
  })

  test('a product: tested scores 0 however hot and used, and the worst file scores the most', () => {
    expect(scoreOf(file({ exposure: 0 })).value).toBe(0)
    expect(scoreOf(file())).toEqual({ value: 3 * 4 * 4, step: SCORE_RAMP.length - 1, levels: [3, 3, 3] })
    // untested but cold and unused keeps its exposure alone
    expect(scoreOf(file({ heat: 0, usedBy: 0 })).value).toBe(3)
    expect(scoreOf(file({ heat: 0, usedBy: 0 })).step).toBeLessThan(SCORE_WARN)
  })

  test('a file that is not source, or has no coverage answer, is not scored', () => {
    expect(scoreOf(file({ kind: 'doc' }))).toBeNull()
    expect(scoreOf(file({ exposure: null }))).toBeNull()
  })
})

// ─── the page ───────────────────────────────────────────────────────────────

describe('page', () => {
  const model = { head: 'abc123', builtAt: 1_750_000_000, commits: 3, sweeps: 0, sweepLimit: 50, reports: [],
    files: [file(), file({ path: 'docs/a.md', kind: 'doc', tested: null, region: 'docs' }), file({ path: 'src/</script>.js' })] }
  const page = renderPage(model, { css: CSS, theme: 'light', name: 'demo' })
  const script = page.slice(page.lastIndexOf('<script>') + 8, page.lastIndexOf('</script>'))
  const local = page.split('<style id="codegraph">')[1].split('</style>')[0]

  test('its own stylesheet writes no hex; the theme decides every color', () => {
    for (const m of [...QUADRANTS, ...MORE, 'score']) expect(local).toContain(`--tile-${m}-0`)
    expect(local).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    expect(page).toContain('<body class="app theme-light">')
  })

  test('offers every theme the stylesheet declares', () => {
    expect(page).toContain('<option value="light" selected>light</option>')
    expect(page).toContain('<option value="night">night</option>')
  })

  test('carries every file, a path cannot close the script, and the curve is the module’s', () => {
    expect(script.split('</script>').length).toBe(1)
    const D = new Function(`${script.split('\n')[0]}; return D`)()
    expect(D.rows.map(r => r[0])).toEqual(model.files.map(f => f.path))
    expect(D.all).toBe(false)
    // the score is graded in node: the loud source file carries the top step, the doc none
    expect(D.rows[0][22]).toBe(SCORE_RAMP.length - 1)
    expect(D.rows[1][22]).toBeNull()
    const curve = new Function(`${gilbert.toString()}; return gilbert(5, 3)`)()
    expect(curve).toEqual(gilbert(5, 3))
    expect(script).toContain(gilbert.toString())
    expect(renderPage(model, { css: CSS, theme: 'light', name: 'demo', all: true })).toContain('"all":true')
  })

  test('every layout the buttons offer is a function the page carries', () => {
    const layouts = [...page.matchAll(/data-layout="(\w+)"/g)].map(m => m[1])
    expect(layouts).toContain('depth')
    expect(script).toContain(depthLayout.toString())
    // the rows carry what that layout places by, and the cycle band the more menu colors by
    const D = new Function(`${script.split('\n')[0]}; return D`)()
    const cols = script.match(/^const COLS = (\[.*\])$/m)[1]
    const at = new Function(`return ${cols}`)()
    expect(at).toContain('depth')
    expect(at).toContain('bCycle')
    expect(D.rows[0].length).toBe(at.length)
    expect(D.more).toContain('cycle')
  })

  test('the script parses', () => {
    expect(() => new Function(script)).not.toThrow()
  })
})

// ─── references ─────────────────────────────────────────────────────────────

describe('exportTarget', () => {
  test('a string or a conditions object answers the package root, and types is not a module', () => {
    expect(exportTarget('./lib/main.js', '.')).toBe('./lib/main.js')
    expect(exportTarget('./lib/main.js', './x')).toBeNull()
    expect(exportTarget({ types: './index.d.ts', import: './index.js' }, '.')).toBe('./index.js')
  })
  test('a subpath is looked up exactly, then as a pattern whose star crosses a slash', () => {
    const map = { '.': './index.ts', './client': { bun: './src/client.ts' }, './components/*': './components/*' }
    expect(exportTarget(map, './client')).toBe('./src/client.ts')
    expect(exportTarget(map, './components/forms/Button.mesa')).toBe('./components/forms/Button.mesa')
    expect(exportTarget(map, './nope')).toBeNull()
  })
})

describe('referenceGraph', () => {
  const manifests = [
    { path: 'packages/core/package.json', json: { name: '@acme/core', exports: { '.': './index.ts', './x/*': './src/x/*.ts' } } },
    { path: 'packages/util/package.json', json: { name: 'util-kit', main: 'lib/main.js' } },
    { path: 'packages/bare/package.json', json: { name: '@acme/bare' } },
  ]
  const sources = ['packages/core/index.ts', 'packages/core/src/x/deep/one.ts', 'packages/util/lib/main.js', 'packages/bare/src/thing.js', 'app/src/utils.js']
  const regionOf = regionReader([...manifests.map(m => m.path), ...sources])
  const graphOf = text => referenceGraph(new Map([...sources.map(p => [p, '']), ['app/src/main.js', text]]),
    { isSource: p => sources.includes(p) || p === 'app/src/main.js', regionOf, packages: packageIndex(manifests) }).get('app/src/main.js')

  test('a package named bare resolves through its exports, its main, or its directory', () => {
    expect([...graphOf("import a from '@acme/core'")]).toEqual(['packages/core/index.ts'])
    expect([...graphOf("import b from 'util-kit'")]).toEqual(['packages/util/lib/main.js'])
    expect([...graphOf("import c from '@acme/core/x/deep/one'")]).toEqual(['packages/core/src/x/deep/one.ts'])
    expect([...graphOf("import d from '@acme/bare/thing'")]).toEqual(['packages/bare/src/thing.js'])
  })

  test('a quoted word that names no package names nothing, and a path in the same region still does', () => {
    expect([...graphOf("const x = 'lodash'; const y = 'utils'")]).toEqual([])
    expect([...graphOf("import u from 'src/utils.js'")]).toEqual(['app/src/utils.js'])
  })
})

test('used by counts source files naming a file, and across counts those from another region', () => {
  const dir = repo({
    'package.json':               '{"name":"root","private":true}',
    'packages/lib/package.json':  '{"name":"@acme/lib","exports":"./index.js"}',
    'packages/lib/index.js':      "export * from './helper.js'\n",
    'packages/lib/helper.js':     'export const h = 1\n',
    'packages/app/package.json':  '{"name":"app"}',
    'packages/app/a.js':          "import '@acme/lib'\n",
    'packages/app/b.js':          "import { h } from '@acme/lib'\n",
    'packages/app/test/a.test.js': "import '../a.js'\nimport '@acme/lib'\n",
  })
  commit(dir, 'one', 1_750_000_000)
  try {
    const by = Object.fromEntries(collectCodegraph({ root: dir, now: 1_750_000_000_000 }).files.map(f => [f.path, f]))
    expect([by['packages/lib/index.js'].usedBy, by['packages/lib/index.js'].usedAcross]).toEqual([2, 2])
    expect([by['packages/lib/helper.js'].usedBy, by['packages/lib/helper.js'].usedAcross]).toEqual([1, 0])
    // a test names a.js and the lib; neither is USE
    expect(by['packages/app/a.js'].usedBy).toBe(0)
    expect(by['packages/app/a.js'].tested.level).toBe('tested')
    expect(by['packages/lib/index.js'].tested.level).toBe('tested')
    expect(by['packages/app/test/a.test.js'].usedBy).toBeNull()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ─── the core layout ────────────────────────────────────────────────────────

describe('core layout', () => {
  const tree = (sizes, rest = 0) => {
    const files = []
    for (const [region, n] of Object.entries(sizes)) for (let i = 0; i < n; i++) files.push({ path: `${region}/${String(i).padStart(3, '0')}`, region, kind: 'source', usedBy: n - i })
    for (let i = 0; i < rest; i++) files.push({ path: `zz/${i}`, region: 'zz', kind: 'source', usedBy: 0 })
    return files
  }

  test('the core is ranked by share of lines plus share of use across regions, not either alone', () => {
    const files = [
      { region: 'app', kind: 'source', lines: 6000, usedAcross: 0 },
      { region: 'kit', kind: 'source', lines: 1000, usedAcross: 90 },
      { region: 'lib', kind: 'source', lines: 5000, usedAcross: 10 },
      { region: 'doc', kind: 'doc',    lines: 99999, usedAcross: 999 },
    ]
    // app is the largest and kit the most imported; lib is second on both and beats app
    expect(coreRegions(files, 2)).toEqual(['kit', 'lib'])
  })

  test('every file gets its own cell inside the square', () => {
    const files = tree({ a: 30, b: 7, c: 12, d: 1 }, 40)
    const { w, h, cells } = coreLayout(files, ['a', 'b', 'c', 'd'])
    expect(w).toBe(h)
    expect(w * h).toBeGreaterThanOrEqual(files.length)
    expect(new Set(cells.map(([x, y]) => y * w + x)).size).toBe(files.length)
    expect(cells.every(([x, y]) => x >= 0 && y >= 0 && x < w && y < h)).toBe(true)
  })

  test('four regions of one size are mirror images, most used file at the center', () => {
    const files = tree({ a: 9, b: 9, c: 9, d: 9 })
    const { w, cells } = coreLayout(files, ['a', 'b', 'c', 'd'])
    const at = region => files.map((f, k) => f.region === region ? cells[k] : null).filter(Boolean)
    const mirrorX = ([x, y]) => [w - 1 - x, y], mirrorY = ([x, y]) => [x, w - 1 - y]
    expect(at('b')).toEqual(at('a').map(mirrorX))
    expect(at('c')).toEqual(at('a').map(mirrorY))
    expect(at('d')).toEqual(at('a').map(c => mirrorY(mirrorX(c))))
    expect(cells[0]).toEqual([w / 2 - 1, w / 2 - 1])
  })

  test('a region that outgrows its quadrant keeps every file, the overflow placed with the rest', () => {
    const files = tree({ a: 60, b: 1, c: 1, d: 1 })
    const { w, cells } = coreLayout(files, ['a', 'b', 'c', 'd'])
    expect(new Set(cells.map(([x, y]) => y * w + x)).size).toBe(files.length)
  })
})

describe('package grid', () => {
  const region = (name, n) => Array.from({ length: n }, (_, i) => ({ path: `${name}/${String(i).padStart(3, '0')}`, region: name, kind: 'source' }))

  test('each region fills a square of its own, and no two squares touch', () => {
    const files = [...region('big', 50), ...region('mid', 12), ...region('one', 1), ...region('two', 2), ...region('odd', 7)]
    const { w, h, cells, boxes } = packageGrid(files)
    expect(new Set(cells.map(([x, y]) => y * w + x)).size).toBe(files.length)
    expect(cells.every(([x, y]) => x >= 0 && y >= 0 && x < w && y < h)).toBe(true)
    for (const box of boxes) {
      const mine = files.map((f, k) => f.region === box.region ? cells[k] : null).filter(Boolean)
      expect(box.side).toBe(Math.ceil(Math.sqrt(mine.length)))
      expect(mine.every(([x, y]) => x >= box.x && x < box.x + box.side && y >= box.y && y < box.y + box.side)).toBe(true)
    }
    // a cell of ground between any two squares: no file has a 4-neighbor from another region
    const regionAt = new Map(files.map((f, k) => [cells[k].join(), f.region]))
    const touching = files.filter((f, k) => { const [x, y] = cells[k]; return [[1, 0], [0, 1]].some(([dx, dy]) => { const r = regionAt.get([x + dx, y + dy].join()); return r && r !== f.region }) })
    expect(touching).toEqual([])
  })

  test('largest square first, and files inside it run in path order along the curve', () => {
    const files = [...region('small', 4), ...region('large', 16)].reverse()
    const { cells, boxes } = packageGrid(files)
    expect(boxes.map(b => b.region)).toEqual(['large', 'small'])
    const large = files.map((f, k) => [f.path, cells[k]]).filter(([p]) => p.startsWith('large/')).sort((a, b) => a[0] < b[0] ? -1 : 1).map(([, c]) => c)
    expect(large).toEqual(gilbert(4, 4))
  })
})

describe('core neighborhoods', () => {
  const region = (name, n, usedBy = 0) => Array.from({ length: n }, (_, i) => ({ path: `${name}/${String(i).padStart(3, '0')}`, region: name, kind: 'source', usedBy }))
  const quadrant = (w, [x, y]) => (y >= w / 2 ? 2 : 0) + (x >= w / 2 ? 1 : 0)
  const blocks = (w, cells) => {
    const set = new Set(cells.map(([x, y]) => y * w + x)), seen = new Set()
    let parts = 0
    for (const start of set) {
      if (seen.has(start)) continue
      parts++
      const stack = [start]; seen.add(start)
      while (stack.length) {
        const c = stack.pop(), x = c % w, y = (c - x) / w
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          const k = ny * w + nx
          if (nx >= 0 && ny >= 0 && nx < w && set.has(k) && !seen.has(k)) { seen.add(k); stack.push(k) }
        }
      }
    }
    return parts
  }

  test('a region joins the quadrant of the core region it imports most, whole', () => {
    const files = [...region('a', 16, 1), ...region('b', 16, 1), ...region('c', 16, 1), ...region('d', 16, 1), ...region('x', 20), ...region('y', 20)]
    const { w, cells, splits } = coreLayout(files, ['a', 'b', 'c', 'd'], { x: { c: 5, a: 1 }, y: { b: 2 } })
    const at = name => files.map((f, k) => f.region === name ? cells[k] : null).filter(Boolean)
    expect(splits).toBe(0)
    expect(new Set(at('x').map(c => quadrant(w, c)))).toEqual(new Set([2]))
    expect(new Set(at('y').map(c => quadrant(w, c)))).toEqual(new Set([1]))
  })

  // The L is two bands, and r is laid across the seam between them: 12×12, a
  // 4×4 core square, p's 5 cells then 3 of r's in the band below it, r's other 7
  // in the band beside. Each band walked from its own origin cut r in two.
  test('a region laid across the seam of its L stays one block', () => {
    const files = [...region('a', 16, 1), ...region('b', 16, 1), ...region('c', 16, 1), ...region('d', 16, 1), ...region('p', 5), ...region('r', 10)]
    const { w, cells } = coreLayout(files, ['a', 'b', 'c', 'd'], { p: { a: 1 }, r: { a: 1 } })
    const at = name => files.map((f, k) => f.region === name ? cells[k] : null).filter(Boolean)
    expect(w).toBe(12)
    expect(new Set([...at('p'), ...at('r')].map(c => quadrant(w, c)))).toEqual(new Set([0]))
    expect([blocks(w, at('p')), blocks(w, at('r'))]).toEqual([1, 1])
  })

  test('a region with no pull goes to the emptiest quadrant; one that fits nowhere is split and counted', () => {
    const small = [...region('a', 25, 1), ...region('b', 1, 1), ...region('c', 25, 1), ...region('d', 25, 1), ...region('q', 5)]
    const one = coreLayout(small, ['a', 'b', 'c', 'd'])
    expect(new Set(small.map((f, k) => f.region === 'q' ? quadrant(one.w, one.cells[k]) : null).filter(q => q !== null))).toEqual(new Set([1]))

    const huge = [...region('a', 1, 1), ...region('b', 1, 1), ...region('c', 1, 1), ...region('d', 1, 1), ...region('big', 400)]
    const two = coreLayout(huge, ['a', 'b', 'c', 'd'], { big: { a: 1 } })
    expect(two.splits).toBe(1)
    expect(new Set(two.cells.map(([x, y]) => y * two.w + x)).size).toBe(huge.length)
  })
})

// ─── the import graph ─────────────────────────────────────────────────────────

test('a comment naming a module is not an import', () => {
  const texts = new Map([
    ['a.js', "// import x from './b.js'\n/* import './c.js' */\nimport y from './d.js'\n"],
    ['b.js', ''], ['c.js', ''], ['d.js', ''],
  ])
  const g = importGraph(texts, { isFile: p => texts.has(p) })
  expect([...g.get('a.js').keys()]).toEqual(['d.js'])
})

test('a string holding a comment marker survives the strip', () => {
  expect(stripComments("const u = 'http://x/y' // gone\n").trim()).toBe("const u = 'http://x/y'")
})

test('every statement form is read, and a type import is marked as one', () => {
  const texts = new Map([
    ['a.ts', [
      "import a from './b.js'",
      "import type { T } from './c.js'",
      "export { z } from './d.js'",
      "const e = await import('./e.js')",
      "const f = require('./f.js')",
      "import './g.js'",
    ].join('\n')],
    ...['b', 'c', 'd', 'e', 'f', 'g'].map(n => [n + '.js', '']),
  ])
  const edges = importGraph(texts, { isFile: p => texts.has(p) }).get('a.ts')
  expect([...edges.keys()].sort()).toEqual(['b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'g.js'])
  expect(edges.get('c.js')).toBe(true)
  expect(edges.get('b.js')).toBe(false)
})

test('a type query is not a dynamic import, and the awaited one still is', () => {
  const texts = new Map([
    ['a.ts', "let x: import('./b.js').App\nconst y = await import('./c.js')\nimport('./d.js').then(m => m)\n"],
    ['b.js', ''], ['c.js', ''], ['d.js', ''],
  ])
  const edges = importGraph(texts, { isFile: p => texts.has(p) }).get('a.ts')
  // all three are edges — a type is a compile-time dependency — and only the first is erased at runtime
  expect([...edges.keys()].sort()).toEqual(['b.js', 'c.js', 'd.js'])
  expect(edges.get('b.js')).toBe(true)
  expect(edges.get('c.js')).toBe(false)
  expect(edges.get('d.js')).toBe(false)
})

test('a bare specifier resolves through the package own exports, and an npm one is dropped', () => {
  const packages = packageIndex([{ path: 'packages/kit/package.json', json: { name: '@x/kit', exports: { './parse': './src/parse.js' } } }])
  const texts = new Map([['app.js', "import { p } from '@x/kit/parse'\nimport React from 'react'\n"], ['packages/kit/src/parse.js', '']])
  const g = importGraph(texts, { isFile: p => texts.has(p), packages })
  expect([...g.get('app.js').keys()]).toEqual(['packages/kit/src/parse.js'])
})

test('depth is the longest path down, never the shortest', () => {
  // a → b → c → d and a → d: the short way is one hop and a still sits on three
  const g = new Map([
    ['a', new Map([['b', false], ['d', false]])],
    ['b', new Map([['c', false]])],
    ['c', new Map([['d', false]])],
    ['d', new Map()],
  ])
  const l = layerGraph(g)
  expect([l.get('a').depth, l.get('b').depth, l.get('c').depth, l.get('d').depth]).toEqual([3, 2, 1, 0])
  expect([...l.values()].every(v => v.cycle === 1)).toBe(true)
})

test('a cycle counts its files and cannot make the longest path infinite', () => {
  const g = new Map([
    ['a', new Map([['b', false]])],
    ['b', new Map([['c', false]])],
    ['c', new Map([['a', false], ['d', false]])],
    ['d', new Map()],
  ])
  const l = layerGraph(g)
  expect([l.get('a').cycle, l.get('b').cycle, l.get('c').cycle, l.get('d').cycle]).toEqual([3, 3, 3, 1])
  expect([l.get('a').depth, l.get('d').depth]).toEqual([1, 0])
})

test('a pair is the mildest cycle band and a file in none has no band', () => {
  expect(tileBands({ heat: 0, churn: 0, complexity: null, tested: null, cycle: 1 }).cycle).toBe(null)
  expect(tileBands({ heat: 0, churn: 0, complexity: null, tested: null, cycle: 2 }).cycle).toBe(0)
  expect(tileBands({ heat: 0, churn: 0, complexity: null, tested: null, cycle: CYCLE_SIZE.at(-1) + 1 }).cycle).toBe(STRONG)
})

test('the depth layout stacks a band per layer, deepest at the top, one blank row between', () => {
  const files = [
    { path: 'top.js', depth: 2 },
    ...Array.from({ length: 5 }, (_, i) => ({ path: 'mid' + i + '.js', depth: 1 })),
    ...Array.from({ length: 9 }, (_, i) => ({ path: 'leaf' + i + '.js', depth: 0 })),
  ]
  const { w, h, cells } = depthLayout(files)
  expect(cells.length).toBe(files.length)
  const rowOf = d => cells[d][1]
  // the deepest file is alone on the top row, and every shallower file is below it
  expect(rowOf(0)).toBe(0)
  expect(Math.min(...files.map((_, d) => rowOf(d)).slice(1))).toBeGreaterThan(0)
  // a layer never shares a row with another layer
  const layerAtRow = new Map()
  files.forEach((f, d) => { const r = rowOf(d); expect(layerAtRow.get(r) ?? f.depth).toBe(f.depth); layerAtRow.set(r, f.depth) })
  // and no two files land on one cell
  expect(new Set(cells.map(c => c.join(','))).size).toBe(files.length)
  expect(cells.every(([x, y]) => x < w && y < h)).toBe(true)
})

test('the depth layout keeps path order inside a layer', () => {
  const files = Array.from({ length: 6 }, (_, i) => ({ path: 'f' + i + '.js', depth: 0 }))
  const { cells } = depthLayout(files)
  const seen = cells.map(([x, y], d) => [y, x, d]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(c => c[2])
  expect(seen).toEqual([0, 1, 2, 3, 4, 5])
})

test('the collected model carries a depth and a cycle count per source file', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-depth-'))
  try {
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'T')
    writeFileSync(join(root, 'leaf.js'), 'export const x = 1\n')
    writeFileSync(join(root, 'mid.js'), "import { x } from './leaf.js'\nexport const y = x\n")
    writeFileSync(join(root, 'top.js'), "import { y } from './mid.js'\n// import { x } from './leaf.js'\nconsole.log(y)\n")
    writeFileSync(join(root, 'ring-a.js'), "import './ring-b.js'\n")
    writeFileSync(join(root, 'ring-b.js'), "import './ring-a.js'\n")
    git('add', '-A'); git('commit', '-qm', 'one')
    const at = p => collectCodegraph({ root }).files.find(f => f.path === p)
    expect(at('leaf.js').depth).toBe(0)
    expect(at('mid.js').depth).toBe(1)
    expect(at('top.js').depth).toBe(2)
    expect(at('leaf.js').cycle).toBe(1)
    expect(at('ring-a.js').cycle).toBe(2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ─── what the project ships, and what is built on it ──────────────────────────

test('a package the workspace does not publish is read off its own manifest, never a list of names', () => {
  const dirs = unpublishedDirs([
    { path: 'package.json', json: { name: 'ws', private: true } },
    { path: 'packages/app/package.json', json: { name: '@x/app', private: true } },
    { path: 'packages/kit/package.json', json: { name: '@x/kit' } },
  ])
  // the root says private too and means something else there: nobody publishes a workspace
  expect([...dirs]).toEqual(['packages/app'])
})

test('source in an unpublished package is private, and everything else keeps its kind', () => {
  const root = mkdtempSync(join(tmpdir(), 'codegraph-private-'))
  try {
    const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' })
    git('init', '-q')
    git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'T')
    const write = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text) }
    write('package.json', JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }))
    write('packages/kit/package.json', JSON.stringify({ name: '@x/kit' }))
    write('packages/kit/src/index.js', 'export const k = 1\n')
    write('packages/app/package.json', JSON.stringify({ name: '@x/app', private: true }))
    write('packages/app/src/main.js', "import { k } from '@x/kit'\nexport const m = k\n")
    write('packages/app/test/main.test.js', "import { m } from '../src/main.js'\n")
    write('packages/app/README.md', '# app\n')
    git('add', '-A'); git('commit', '-qm', 'one')
    const model = collectCodegraph({ root })
    const kind = p => model.files.find(f => f.path === p).kind
    expect(kind('packages/kit/src/index.js')).toBe('source')
    expect(kind('packages/app/src/main.js')).toBe('private')
    expect(kind('packages/app/test/main.test.js')).toBe('test')
    expect(kind('packages/app/README.md')).toBe('doc')
    // private is CODE: it is graded, and what it imports counts as used
    const app = model.files.find(f => f.path === 'packages/app/src/main.js')
    const kit = model.files.find(f => f.path === 'packages/kit/src/index.js')
    expect(isCode(app)).toBe(true)
    expect(app.exposure).not.toBeNull()
    expect(app.depth).toBe(1)
    expect(kit.usedBy).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ─── what is inside a file ────────────────────────────────────────────────────

// the parser is the PROJECT's, and this repo has one — a tree without is the other test below
const ts = await typeScriptAt(process.cwd().replace(/\/packages\/cli$/, ''))

describe('functions', () => {

  test('the parser is found in the project, never beside the CLI', async () => {
    expect(ts).not.toBeNull()
    expect(await typeScriptAt(mkdtempSync(join(tmpdir(), 'codegraph-bare-')))).toBeNull()
  })

  test('nesting costs more than the same decisions written flat', () => {
    const flat = `function a(x) {
      if (x === 1) return 1
      if (x === 2) return 2
      if (x === 3) return 3
      return 0
    }`
    const deep = `function b(x) {
      if (x) {
        for (const i of x) {
          if (i) return i
        }
      }
      return 0
    }`
    const f = measureFunctions(ts, 'a.ts', flat)[0]
    const d = measureFunctions(ts, 'b.ts', deep)[0]
    // same three decisions each, and cyclomatic cannot tell them apart
    expect(f.cyclo).toBe(4)
    expect(d.cyclo).toBe(4)
    expect(f.cognitive).toBe(3)       // 1 + 1 + 1
    expect(d.cognitive).toBe(6)       // 1 + 2 + 3
    expect(d.nest).toBe(3)
    expect(f.nest).toBe(1)
  })

  test('a function is named by whatever declares it, and a one-liner is not a function anybody reads', () => {
    const src = `
      export function named() { if (1) return 2
        return 3 }
      const assigned = (a) => { if (a) return 1
        return 0 }
      const obj = { method() { if (1) return 1
        return 0 } }
      const tiny = x => x + 1
    `
    const found = measureFunctions(ts, 'n.ts', src)
    expect(found.map(f => f.name).sort()).toEqual(['assigned', 'method', 'named'])
  })

  test('the worst function is the file reading, and the hardest one wins', () => {
    const src = `
      function easy() { if (1) return 1
        return 0 }
      function hard(x) { for (const a of x) { for (const b of a) { if (b) return b } }
        return null }
    `
    const found = measureFunctions(ts, 'w.ts', src)
    const worst = worstFunction(found)
    expect(worst.name).toBe('hard')
    expect(worstFunction([])).toBeNull()
    expect(worst.cognitive).toBeGreaterThan(found.find(f => f.name === 'easy').cognitive)
  })

  test('a syntax error answers nothing rather than throwing, and a .mesa is not offered to it', () => {
    expect(PARSABLE.test('a.mesa')).toBe(false)
    expect(PARSABLE.test('a.ts')).toBe(true)
    expect(PARSABLE.test('a.mjs')).toBe(true)
    // tsc parses loosely and recovers, so the contract is only that it cannot throw
    expect(() => measureFunctions(ts, 'broken.ts', 'function ( { { {')).not.toThrow()
  })

  test('a collected file carries its hardest function, its size, and a band for it', () => {
    const root = mkdtempSync(join(tmpdir(), 'codegraph-fns-'))
    try {
      const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8' })
      git('init', '-q')
      git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'T')
      writeFileSync(join(root, 'deep.js'), `export function knot(x) {
  for (const a of x) { for (const b of a) { for (const c of b) { if (c) return c } } }
  return null
}
`)
      git('add', '-A'); git('commit', '-qm', 'one')
      const withParser = collectCodegraph({ root, ts }).files.find(f => f.path === 'deep.js')
      expect(withParser.worst.name).toBe('knot')
      expect(withParser.cognitive).toBe(10)          // 1 + 2 + 3 + 4
      expect(withParser.fns).toBe(1)
      expect(withParser.bytes).toBeGreaterThan(0)
      expect(tileBands(withParser).cognitive).toBe(band(10, COGNITIVE))

      // with no parser every other reading holds and this one is ABSENT, never 0
      const without = collectCodegraph({ root }).files.find(f => f.path === 'deep.js')
      expect(without.cognitive).toBeNull()
      expect(without.worst).toBeNull()
      expect(tileBands(without).cognitive).toBeNull()
      expect(without.complexity).toBe(withParser.complexity)
      expect(without.bytes).toBe(withParser.bytes)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
