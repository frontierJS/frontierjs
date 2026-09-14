/**
 * core/tiles.js — a project drawn as one tile per tracked file.
 *
 * A tile is four quadrants: AGE (days since the last commit) and CHURN (commits
 * over its life) from git, TESTED and COMPLEXITY from the files. Files are laid
 * in path order along a generalized Hilbert curve, so a package is one region
 * of the picture. Everything is read statically: no parser, no test run.
 *
 * ── Not a snapshot ─────────────────────────────────────────────────────────
 *
 * Age is measured against a clock and TESTED may come from a coverage report
 * nobody commits, so two runs over one tree differ. Nothing here writes a
 * generator line and nothing rechecks the output.
 *
 * ── Bands are absolute ─────────────────────────────────────────────────────
 *
 * Every metric bins against fixed thresholds rather than this project's own
 * percentiles. A percentile band is always a fifth of the files, so the badge
 * would draw the same complexity for every project there is.
 *
 * ── Where TESTED comes from ────────────────────────────────────────────────
 *
 * A `coverage/lcov.info` found under the project wins for every file it names.
 * Otherwise a test file must NAME the file — an import or a path string — and a
 * file imported by one so named reads as `partly`. A test reaching code over
 * HTTP or by a job's name reads as `untested`; `from` on each row says which of
 * the two answered, and a report older than a commit to a file it covers is
 * marked stale rather than trusted quietly.
 */

import { execFileSync }                                     from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, posix, resolve, relative, isAbsolute, sep } from 'node:path'
import { allocate }                                         from '@frontierjs/toolbelt/units'
import { encodePng }                                        from './png.js'

// ─── the rules ────────────────────────────────────────────────────────────────

// A commit touching more than this share of the tree is a sweep — a reformat, a
// mass rename, a docs pass. Counting one makes every file read fresh and hot.
export const SWEEP_SHARE = 0.10
export const SWEEP_FLOOR = 50

// Each band list is ascending; a value past the last threshold is band 4, the
// strong one. Age is the exception and reads backwards: recent is strong.
export const AGE_DAYS      = [1, 7, 30, 90]
export const CHURN_COMMITS = [0, 1, 3, 7]
export const INDENT_SUM    = [25, 100, 400, 1600]
export const COVERED_PCT   = 80

const BINARY_LIMIT = 2_000_000
const ASSET        = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|wasm)$/i
const DOC          = /\.(md|mdx|txt|rst)$/i
const CONFIG       = /\.(json|jsonc|ya?ml|toml|ini|env)$/i
const LOCKFILE     = /^(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/

export const KINDS = ['source', 'test', 'doc', 'config', 'generated', 'asset']

export function kindOf(path) {
  const base = posix.basename(path)
  if (/\.snapshot\./.test(base) || /(^|\/)(dist|out|build)\//.test(path) || LOCKFILE.test(base)) return 'generated'
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//.test(path) || /\.(test|spec)\.[a-z]+$/i.test(base)) return 'test'
  if (ASSET.test(base))                                                                              return 'asset'
  if (DOC.test(base) || /^(LICENSE|CHANGELOG)$/.test(base))                                          return 'doc'
  if (CONFIG.test(base) || base.startsWith('.') || /\.config\.[cm]?[jt]s$/.test(base) || /^(Dockerfile|Makefile|tsconfig.*)$/.test(base)) return 'config'
  return 'source'
}

export const band = (value, thresholds) => value == null ? null : thresholds.filter(t => value > t).length

// ─── git ──────────────────────────────────────────────────────────────────────

/**
 * `git log -M --name-status --format=%x1e%ct`, newest first — so a rename is
 * seen before the commits made under the old name, and those are counted for
 * the file as it is named now.
 */
export function parseGitLog(text, { known, sweepLimit }) {
  const alias   = new Map()
  const current = p => alias.get(p) ?? p
  const churn   = new Map()
  const last    = new Map()
  const lastAny = new Map()
  let commits = 0, sweeps = 0

  for (const chunk of text.split('\x1e').slice(1)) {
    const lines   = chunk.split('\n').filter(Boolean)
    const at      = Number(lines.shift())
    const touched = new Set()
    for (const line of lines) {
      const [status, a, b] = line.split('\t')
      if (status[0] === 'R' || status[0] === 'C') {
        const now = current(b)
        if (status[0] === 'R') alias.set(a, now)
        touched.add(now)
      } else {
        touched.add(current(a))
      }
    }
    commits++
    const sweep = touched.size > sweepLimit
    if (sweep) sweeps++
    for (const p of touched) {
      if (!known.has(p)) continue
      if (!lastAny.has(p)) lastAny.set(p, at)
      if (sweep) continue
      if (!last.has(p)) last.set(p, at)
      churn.set(p, (churn.get(p) ?? 0) + 1)
    }
  }
  return { churn, last, lastAny, commits, sweeps }
}

// ─── complexity ───────────────────────────────────────────────────────────────

/**
 * Leading indent summed over non-blank lines, in LEVELS. The unit is the file's
 * most common step between neighbouring lines, so a 4-space file and a 2-space
 * file of one shape score the same; a tab is one level.
 */
export function indentSum(text) {
  const levels = []
  const widths = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const lead = /^[ \t]*/.exec(line)[0]
    if (lead.includes('\t')) { levels.push(lead.split('\t').length - 1); widths.push(null) }
    else { levels.push(null); widths.push(lead.length) }
  }
  const steps = new Map()
  let prev = null
  for (const w of widths) {
    if (w == null) { prev = null; continue }
    if (prev != null) { const d = Math.abs(w - prev); if (d >= 1 && d <= 8) steps.set(d, (steps.get(d) ?? 0) + 1) }
    prev = w
  }
  const unit = [...steps].sort((x, y) => y[1] - x[1] || x[0] - y[0])[0]?.[0] ?? 2
  let sum = 0
  for (let i = 0; i < widths.length; i++) sum += levels[i] ?? Math.floor(widths[i] / unit)
  return { sum, lines: widths.length }
}

// ─── coverage ─────────────────────────────────────────────────────────────────

/** lcov records → `[{ file, found, hit }]`, `file` exactly as the report wrote it. */
export function parseLcov(text) {
  const out = []
  let row = null
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:'))           row = { file: line.slice(3).trim(), found: 0, hit: 0 }
    else if (row && line.startsWith('LF:')) row.found = Number(line.slice(3))
    else if (row && line.startsWith('LH:')) row.hit   = Number(line.slice(3))
    else if (row && line.trim() === 'end_of_record') { out.push(row); row = null }
  }
  return out
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.bun', '.cache'])

function findReports(root, depth = 6) {
  const found = []
  const walk = (dir, d) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.name === 'coverage' && existsSync(join(full, 'lcov.info'))) found.push(join(full, 'lcov.info'))
      else if (d > 0) walk(full, d - 1)
    }
  }
  walk(root, depth)
  return found.sort()
}

// ─── references ───────────────────────────────────────────────────────────────

const TRY    = ['', '.js', '.ts', '.mjs', '.cjs', '.jsx', '.tsx', '.mesa', '.lite', '/index.js', '/index.ts', '/index.mjs']
const STRING = /['"`]([@.\w][\w@.\/-]*\/[\w@.\/-]*|[\w-]+\.(?:js|ts|mjs|cjs|mesa|lite))['"`]/g

/**
 * Which source files each file names. A string resolves relatively, as an
 * `@frontierjs/<pkg>/<sub>` subpath, or as a path suffix inside the same region.
 */
export function referenceGraph(texts, { isSource, regionOf }) {
  const bySuffix = new Map()
  for (const p of texts.keys()) {
    if (!isSource(p)) continue
    const seg = p.split('/')
    for (let i = 1; i < seg.length; i++) {
      const key = regionOf(p) + '|' + seg.slice(i).join('/')
      if (!bySuffix.has(key)) bySuffix.set(key, [])
      bySuffix.get(key).push(p)
    }
  }
  const first = c => TRY.map(t => c + t).find(isSource)
  const graph = new Map()
  for (const [from, text] of texts) {
    const names = new Set()
    for (const m of text.matchAll(STRING)) {
      const s = m[1]
      if (s.startsWith('.')) { const hit = first(posix.normalize(posix.join(posix.dirname(from), s))); if (hit) names.add(hit); continue }
      const fjs = /^@frontierjs\/([\w-]+)\/(.+)$/.exec(s)
      if (fjs) { const hit = first(`packages/${fjs[1]}/${fjs[2]}`) ?? first(`packages/${fjs[1]}/src/${fjs[2]}`); if (hit) names.add(hit); continue }
      for (const t of TRY) for (const c of bySuffix.get(regionOf(from) + '|' + s.replace(/^\/+/, '') + t) ?? []) names.add(c)
    }
    names.delete(from)
    graph.set(from, names)
  }
  return graph
}

// ─── collect ──────────────────────────────────────────────────────────────────

/**
 * A region is the nearest directory below the root holding a `package.json`,
 * else the top-level directory, else `(root)`. Derived from the tree, so a
 * repo that is not a workspace still gets regions.
 */
export function regionReader(paths) {
  const packages = new Set(paths.filter(p => posix.basename(p) === 'package.json' && p.includes('/')).map(posix.dirname))
  return p => {
    let dir = posix.dirname(p)
    while (dir !== '.') { if (packages.has(dir)) return dir; dir = posix.dirname(dir) }
    return p.includes('/') ? p.split('/')[0] : '(root)'
  }
}

export function collectTiles({ root, now = Date.now() }) {
  const git   = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 29 })
  const paths = git('ls-files', '-z').split('\0').filter(Boolean).sort()
  const known = new Set(paths)
  const regionOf   = regionReader(paths)
  const sweepLimit = Math.max(SWEEP_FLOOR, Math.round(paths.length * SWEEP_SHARE))

  // --relative keeps a project inside a larger repo to its own paths.
  const history = parseGitLog(git('log', '-M', '--relative', '--name-status', '--format=%x1e%ct'), { known, sweepLimit })

  const files = new Map()
  const texts = new Map()
  for (const p of paths) {
    const kind = kindOf(p)
    let complexity = null, lines = null
    try {
      const full = join(root, p)
      if (!ASSET.test(p) && statSync(full).size < BINARY_LIMIT) {
        const buf = readFileSync(full)
        if (!buf.subarray(0, 8000).includes(0)) {
          const text = buf.toString('utf8')
          ;({ sum: complexity, lines } = indentSum(text))
          if (kind === 'source' || kind === 'test') texts.set(p, text)
        }
      }
    } catch {}
    const at = history.last.get(p) ?? history.lastAny.get(p) ?? null
    files.set(p, {
      path: p, kind, region: regionOf(p),
      committedAt: at,
      age:   at == null ? null : Math.max(0, (now / 1000 - at) / 86400),
      churn: history.churn.get(p) ?? 0,
      complexity, lines,
      tested: kind === 'source' ? { level: 'untested', from: 'refs', refs: 0 } : null,
    })
  }

  // references — a test naming a file, then one hop along the source's own imports
  const graph = referenceGraph(texts, { isSource: p => files.get(p)?.kind === 'source', regionOf })
  for (const [from, names] of graph) {
    if (files.get(from).kind !== 'test') continue
    for (const n of names) { const t = files.get(n).tested; t.level = 'tested'; t.refs++ }
  }
  for (const [from, names] of graph) {
    if (files.get(from).tested?.level !== 'tested') continue
    for (const n of names) { const t = files.get(n).tested; if (t.level === 'untested') t.level = 'partly' }
  }

  // coverage — a report wins for every file it names
  const reports = []
  for (const report of findReports(root)) {
    const base = resolve(report, '..', '..')
    const made = statSync(report).mtimeMs / 1000
    let covered = 0, newest = 0
    for (const r of parseLcov(readFileSync(report, 'utf8'))) {
      const abs = isAbsolute(r.file) ? r.file : resolve(base, r.file)
      const rel = relative(root, abs).split(sep).join('/')
      const f   = files.get(rel)
      if (!f || f.kind !== 'source') continue
      covered++
      newest = Math.max(newest, f.committedAt ?? 0)
      const pct = r.found ? Math.round(r.hit / r.found * 1000) / 10 : null
      f.tested = { level: pct == null ? null : pct >= COVERED_PCT ? 'tested' : pct > 0 ? 'partly' : 'untested', from: 'lcov', pct }
    }
    reports.push({ path: relative(root, report).split(sep).join('/'), files: covered, madeAt: Math.round(made), stale: covered > 0 && newest > made })
  }

  return {
    root,
    head:   git('rev-parse', '--short', 'HEAD').trim(),
    builtAt: Math.round(now / 1000),
    commits: history.commits, sweeps: history.sweeps, sweepLimit,
    reports,
    files: [...files.values()],
  }
}

// ─── layout ───────────────────────────────────────────────────────────────────

/** A 4:3 grid just big enough for `count` tiles. */
export function gridFor(count) {
  const w = Math.max(1, Math.ceil(Math.sqrt(count * 4 / 3)))
  return { w, h: Math.max(1, Math.ceil(count / w)) }
}

/**
 * Every cell of a width × height rectangle, in curve order — Červený's
 * generalized Hilbert. A power-of-two Hilbert square would leave up to three
 * quarters of the picture empty for a project of the wrong size.
 */
export function gilbert(width, height) {
  const out = []
  const gen = (x, y, ax, ay, bx, by) => {
    const w = Math.abs(ax + ay), h = Math.abs(bx + by)
    const dax = Math.sign(ax), day = Math.sign(ay), dbx = Math.sign(bx), dby = Math.sign(by)
    if (h === 1) { for (let i = 0; i < w; i++) { out.push([x, y]); x += dax; y += day } return }
    if (w === 1) { for (let i = 0; i < h; i++) { out.push([x, y]); x += dbx; y += dby } return }
    let ax2 = Math.floor(ax / 2), ay2 = Math.floor(ay / 2), bx2 = Math.floor(bx / 2), by2 = Math.floor(by / 2)
    const w2 = Math.abs(ax2 + ay2), h2 = Math.abs(bx2 + by2)
    if (2 * w > 3 * h) {
      if ((w2 % 2) && w > 2) { ax2 += dax; ay2 += day }
      gen(x, y, ax2, ay2, bx, by)
      gen(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by)
    } else {
      if ((h2 % 2) && h > 2) { bx2 += dbx; by2 += dby }
      gen(x, y, bx2, by2, ax2, ay2)
      gen(x + bx2, y + by2, ax, ay, bx - bx2, by - by2)
      gen(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby), -bx2, -by2, -(ax - ax2), -(ay - ay2))
    }
  }
  width >= height ? gen(0, 0, width, 0, 0, height) : gen(0, 0, 0, height, width, 0)
  return out
}

// ─── bands per file ───────────────────────────────────────────────────────────

const TESTED_BAND = { untested: 4, partly: 2, tested: 0 }

/** 0–4 per quadrant, 4 the strong one; `null` where the metric does not apply. */
export function tileBands(file) {
  return {
    age:        file.age == null ? null : 4 - band(file.age, AGE_DAYS),
    churn:      band(file.churn, CHURN_COMMITS),
    tested:     file.tested?.level ? TESTED_BAND[file.tested.level] : null,
    complexity: band(file.complexity, INDENT_SUM),
  }
}

// ─── color ────────────────────────────────────────────────────────────────────

export const PALETTE = {
  surface:    '#fcfcfb',
  empty:      '#d9d8de',
  boundary:   '#8f8c9c',
  na:         '#f1f0ee',
  age:        ['#efeef4', '#dcd8f0', '#a198dc', '#6f62c4', '#4a3aa7'],
  churn:      ['#f2efe8', '#efe0bd', '#e6b54f', '#c98500', '#8f5f00'],
  complexity: ['#ebf1ee', '#d0e9dd', '#7fd0ab', '#1baf7a', '#0f7a55'],
  tested:     ['#e9e8ec', null, '#ec9a74', null, '#d03b3b'],
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const colorOf = (metric, b) => rgb(b == null ? PALETTE.na : PALETTE[metric][b])

class Canvas {
  constructor(w, h, fill) {
    this.w = w; this.h = h
    this.px = Buffer.alloc(w * h * 4)
    this.rect(0, 0, w, h, fill)
  }
  rect(x, y, w, h, [r, g, b]) {
    for (let j = Math.max(0, y); j < Math.min(this.h, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(this.w, x + w); i++) this.px.set([r, g, b, 255], (j * this.w + i) * 4)
  }
  png() { return encodePng(this.w, this.h, this.px) }
}

// ─── the map ──────────────────────────────────────────────────────────────────

/**
 * One tile per file, in curve order, with a region boundary drawn in the gaps.
 * Source files only unless `all`: the badge counts source, TESTED is grey on
 * every other kind, and a map that disagrees with its own badge reads twice.
 * The grid is sized from what is drawn, so a source map is not mostly empty.
 */
export function renderMap(model, { scale = 8, all = false } = {}) {
  const files = all ? model.files : model.files.filter(f => f.kind === 'source')
  const { w, h } = gridFor(files.length)
  const B     = Math.max(3, Math.round(scale))
  const gap   = B >= 6 ? 1 : 0
  const inner = B - gap
  const qa    = Math.ceil(inner / 2), qb = inner - qa
  const cv    = new Canvas(w * B + gap, h * B + gap, rgb(PALETTE.surface))
  const cells = gilbert(w, h)
  const at    = new Int32Array(w * h).fill(-1)
  files.forEach((_, d) => { const [x, y] = cells[d]; at[y * w + x] = d })
  const region = (x, y) => x < w && y < h && at[y * w + x] >= 0 ? files[at[y * w + x]].region : null

  for (let d = 0; d < cells.length; d++) {
    const [x, y] = cells[d], bx = x * B + gap, by = y * B + gap
    const file = files[d]
    if (!file) { cv.rect(bx + (inner >> 1), by + (inner >> 1), 1, 1, rgb(PALETTE.empty)); continue }
    const bands = tileBands(file)
    cv.rect(bx,      by,      qa, qa, colorOf('age', bands.age))
    cv.rect(bx + qa, by,      qb, qa, colorOf('churn', bands.churn))
    cv.rect(bx,      by + qa, qa, qb, colorOf('tested', bands.tested))
    cv.rect(bx + qa, by + qa, qb, qb, colorOf('complexity', bands.complexity))
    if (!gap) continue
    const here = file.region
    const line = rgb(PALETTE.boundary)
    if (region(x + 1, y) !== here && region(x + 1, y) !== null) cv.rect(bx + inner, by - gap, gap, B + gap, line)
    if (region(x, y + 1) !== here && region(x, y + 1) !== null) cv.rect(bx - gap, by + inner, B + gap, gap, line)
  }
  return cv.png()
}

// ─── the badge ────────────────────────────────────────────────────────────────

const BADGE_ORDER = ['age', 'churn', 'tested', 'complexity']

/**
 * Four 4×4 waffles, one per quadrant of a tile, over SOURCE files: sixteen cells
 * split by how many files sit in each band, strongest band first. The split is
 * `allocate`, so the sixteen always sum to sixteen.
 */
export function badgeCells(model) {
  const source = model.files.filter(f => f.kind === 'source')
  const out = {}
  for (const metric of BADGE_ORDER) {
    const counts = [0, 0, 0, 0, 0, 0]
    for (const f of source) { const b = tileBands(f)[metric]; counts[b == null ? 5 : 4 - b]++ }
    if (!source.length) { out[metric] = Array(16).fill(null); continue }
    const cells = []
    allocate(16, counts).forEach((n, i) => { for (let k = 0; k < n; k++) cells.push(i === 5 ? null : 4 - i) })
    out[metric] = cells
  }
  return out
}

export function renderBadge(model, { scale = 6 } = {}) {
  const s    = Math.max(2, Math.round(scale))
  const pad  = Math.max(2, s >> 1)
  const half = 4 * s + 3
  const size = pad * 2 + half * 2 + pad
  const cv   = new Canvas(size, size, rgb(PALETTE.surface))
  const cells = badgeCells(model)
  BADGE_ORDER.forEach((metric, q) => {
    const ox = pad + (q % 2) * (half + pad), oy = pad + (q >> 1) * (half + pad)
    cells[metric].forEach((b, i) => cv.rect(ox + (i % 4) * (s + 1), oy + (i >> 2) * (s + 1), s, s, colorOf(metric, b)))
  })
  return cv.png()
}

// ─── json ─────────────────────────────────────────────────────────────────────

export function tilesJson(model) {
  return JSON.stringify({
    ...model,
    rules: { sweepShare: SWEEP_SHARE, ageDays: AGE_DAYS, churnCommits: CHURN_COMMITS, indentSum: INDENT_SUM, coveredPct: COVERED_PCT },
    badge: badgeCells(model),
    files: model.files.map(f => ({ ...f, bands: tileBands(f) })),
  }, null, 2)
}
