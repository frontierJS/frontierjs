/**
 * core/codegraph.js — a project drawn as one tile per tracked file.
 *
 * A tile is four quadrants, and dark means look here in every one: HEAT
 * (commits, each fading by half every 30 days) and BLAST radius (source files
 * that name it) on top, COMPLEXITY and EXPOSURE (complexity no test covers)
 * below — one scale for those two, so they match when nothing tests the file.
 * The SCORE folds three of them into one number per file. AGE, CHURN and TESTED
 * are still graded, for the page's `more` views. The four packages that matter
 * most sit at the center, one per quadrant, and every other package is laid as
 * a block beside the one it imports most (`coreLayout`); the page can switch to
 * plain path order along a generalized Hilbert curve. Everything is read
 * statically: no parser, no test run.
 *
 * ── Not a snapshot ─────────────────────────────────────────────────────────
 *
 * Heat and age are measured against a clock and TESTED may come from a coverage
 * report nobody commits, so two runs over one tree differ. Nothing here writes a
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

// Each band list is ascending, one threshold fewer than MIX has steps; a value
// past the last threshold is the strong band. Age reads backwards: recent is strong.
// Exposure bands on INDENT_SUM, which is what lets its square be compared with
// complexity's.
export const HEAT          = [0.25, 1, 3]
export const BLAST         = [0, 3, 15]
export const INDENT_SUM    = [100, 400, 1600]
export const AGE_DAYS      = [7, 30, 90]
export const CHURN_COMMITS = [0, 3, 7]
export const COVERED_PCT   = 80

// One commit counts 1 on its day and half as much every HALF_LIFE_DAYS after, so
// a file edited heavily last year reads cold and one edited this week reads hot.
export const HALF_LIFE_DAYS = 30

// How much of a file's complexity counts as covered when no report names it.
// `partly` is a file a tested file imports, which is a guess, so it is half.
export const COVERAGE = { tested: 1, partly: 0.5, untested: 0 }

const BINARY_LIMIT = 2_000_000
const ASSET        = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|pdf|zip|gz|wasm)$/i
const DOC          = /\.(md|mdx|txt|rst)$/i
const CONFIG       = /\.(json|jsonc|ya?ml|toml|ini|env)$/i
const LOCKFILE     = /^(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/
// Code that demonstrates the project rather than being it. Counted as source, a
// kitchen-sink app is the biggest package on the map and its imports decide
// which package reads most used.
const EXAMPLE      = /(^|\/)(examples?|website)\//

export const KINDS = ['source', 'example', 'test', 'doc', 'config', 'generated', 'asset']

export function kindOf(path) {
  const base = posix.basename(path)
  if (/\.snapshot\./.test(base) || /(^|\/)(dist|out|build)\//.test(path) || LOCKFILE.test(base)) return 'generated'
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//.test(path) || /\.(test|spec)\.[a-z]+$/i.test(base)) return 'test'
  if (ASSET.test(base))                                                                              return 'asset'
  if (DOC.test(base) || /^(LICENSE|CHANGELOG)$/.test(base))                                          return 'doc'
  if (CONFIG.test(base) || base.startsWith('.') || /\.config\.[cm]?[jt]s$/.test(base) || /^(Dockerfile|Makefile|tsconfig.*)$/.test(base)) return 'config'
  if (EXAMPLE.test(path))                                                                            return 'example'
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
  const times   = new Map()
  const first   = new Map()
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
      // newest first, so the last write is the commit that created it — a sweep included
      first.set(p, at)
      if (sweep) continue
      if (!last.has(p)) last.set(p, at)
      churn.set(p, (churn.get(p) ?? 0) + 1)
      if (!times.has(p)) times.set(p, [])
      times.get(p).push(at)
    }
  }
  return { churn, last, lastAny, times, first, commits, sweeps }
}

/** Commits decayed by age: each counts `0.5 ** (days ago / HALF_LIFE_DAYS)`. */
export const heatOf = (times = [], nowSeconds) =>
  times.reduce((sum, at) => sum + 0.5 ** (Math.max(0, nowSeconds - at) / 86400 / HALF_LIFE_DAYS), 0)

/** Complexity no test covers, or null where coverage has no answer. */
export function exposureOf(file) {
  const t = file.tested
  if (file.kind !== 'source' || file.complexity == null || !t?.level) return null
  const covered = t.from === 'lcov' ? t.pct / 100 : COVERAGE[t.level]
  return Math.round(file.complexity * (1 - covered))
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
const NAME   = /['"`]([\w.-]+)['"`]/g

// The conditions a runtime import takes, in the order a bundler asks them;
// `types` is not on it, since a declaration file is not the module.
const CONDITIONS = ['bun', 'import', 'module', 'node', 'default', 'require']

/** `name → { dir, exports, main }` for every package.json in the tree, keyed by the name it declares. */
export function packageIndex(manifests) {
  const out = new Map()
  for (const { path, json } of manifests) {
    if (json && typeof json.name === 'string') out.set(json.name, { dir: posix.dirname(path) === '.' ? '' : posix.dirname(path), exports: json.exports, main: json.module ?? json.main })
  }
  return out
}

function pickTarget(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) { for (const v of value) { const t = pickTarget(v); if (t) return t } return null }
  if (value && typeof value === 'object') { for (const c of CONDITIONS) if (c in value) { const t = pickTarget(value[c]); if (t) return t } }
  return null
}

/**
 * What an `exports` map sends `key` (`.` or `./sub`) to. A `*` in a key is
 * Node's subpath pattern and matches across `/`, which a shell glob does not.
 */
export function exportTarget(exports, key) {
  if (exports == null) return null
  if (typeof exports === 'string' || Array.isArray(exports)) return key === '.' ? pickTarget(exports) : null
  const keys = Object.keys(exports)
  if (keys.length && !keys[0].startsWith('.')) return key === '.' ? pickTarget(exports) : null
  if (key in exports) return pickTarget(exports[key])
  for (const k of keys) {
    const star = k.indexOf('*')
    if (star < 0) continue
    const [pre, post] = [k.slice(0, star), k.slice(star + 1)]
    if (key.length >= pre.length + post.length && key.startsWith(pre) && key.endsWith(post)) {
      const t = pickTarget(exports[k])
      if (t) return t.split('*').join(key.slice(pre.length, key.length - post.length))
    }
  }
  return null
}

/**
 * Which source files each file names. A string resolves relatively, as a
 * package of this tree (through its own `exports`, else its directory), or as a
 * path suffix inside the same region.
 */
export function referenceGraph(texts, { isSource, regionOf, packages = new Map() }) {
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
  const inPackage = spec => {
    const seg  = spec.split('/')
    const name = spec.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0]
    const pkg  = packages.get(name)
    if (!pkg) return undefined
    const sub  = spec.slice(name.length + 1)
    const at   = rel => posix.normalize(posix.join(pkg.dir, rel))
    const target = exportTarget(pkg.exports, sub ? './' + sub : '.')
    if (target) return first(at(target)) ?? null
    return sub ? first(at(sub)) ?? first(at('src/' + sub)) ?? null
               : (pkg.main && first(at(pkg.main))) ?? first(at('index')) ?? first(at('src/index')) ?? null
  }
  const graph = new Map()
  for (const [from, text] of texts) {
    const names = new Set()
    const add = hit => { if (hit) names.add(hit) }
    for (const m of text.matchAll(STRING)) {
      const s = m[1]
      if (s.startsWith('.')) { add(first(posix.normalize(posix.join(posix.dirname(from), s)))); continue }
      const hit = inPackage(s)
      if (hit !== undefined) { add(hit); continue }
      for (const t of TRY) for (const c of bySuffix.get(regionOf(from) + '|' + s.replace(/^\/+/, '') + t) ?? []) names.add(c)
    }
    // an unscoped package imported by its bare name carries no slash for STRING to catch
    if (packages.size) for (const m of text.matchAll(NAME)) if (packages.has(m[1])) add(inPackage(m[1]))
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

export function collectCodegraph({ root, now = Date.now() }) {
  const git   = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 29 })
  const paths = git('ls-files', '-z').split('\0').filter(Boolean).sort()
  const known = new Set(paths)
  const regionOf   = regionReader(paths)
  const sweepLimit = Math.max(SWEEP_FLOOR, Math.round(paths.length * SWEEP_SHARE))

  // --relative keeps a project inside a larger repo to its own paths.
  const history = parseGitLog(git('log', '-M', '--relative', '--name-status', '--format=%x1e%ct'), { known, sweepLimit })

  const files     = new Map()
  const texts     = new Map()
  const manifests = []
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
          if (posix.basename(p) === 'package.json') { try { manifests.push({ path: p, json: JSON.parse(text) }) } catch {} }
        }
      }
    } catch {}
    const at    = history.last.get(p) ?? history.lastAny.get(p) ?? null
    const first = history.first.get(p) ?? null
    files.set(p, {
      path: p, kind, region: regionOf(p),
      committedAt: at,
      age:     at == null ? null : Math.max(0, (now / 1000 - at) / 86400),
      created: first == null ? null : Math.max(0, (now / 1000 - first) / 86400),
      churn:   history.churn.get(p) ?? 0,
      heat:    Math.round(heatOf(history.times.get(p), now / 1000) * 100) / 100,
      complexity, lines,
      tested: kind === 'source' ? { level: 'untested', from: 'refs', refs: 0 } : null,
      usedBy:     kind === 'source' ? 0 : null,
      usedAcross: kind === 'source' ? 0 : null,
    })
  }

  // references — who names a file. A test makes it tested and one hop further
  // partly; a source file makes it used, and across a region, shared.
  const graph = referenceGraph(texts, { isSource: p => files.get(p)?.kind === 'source', regionOf, packages: packageIndex(manifests) })
  const uses = {}
  for (const [from, names] of graph) {
    if (files.get(from).kind !== 'source') continue
    const region = files.get(from).region
    for (const n of names) {
      const f = files.get(n)
      f.usedBy++
      if (f.region === region) continue
      f.usedAcross++
      uses[region] ??= {}
      uses[region][f.region] = (uses[region][f.region] ?? 0) + 1
    }
  }
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

  // exposure last, because a coverage report may just have replaced `tested`
  for (const f of files.values()) f.exposure = exposureOf(f)

  return {
    root,
    head:   git('rev-parse', '--short', 'HEAD').trim(),
    builtAt: Math.round(now / 1000),
    commits: history.commits, sweeps: history.sweeps, sweepLimit,
    reports,
    uses,
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

/**
 * The regions that matter most, for the center of the core layout: each one's
 * share of the source lines plus its share of the use that crosses a region.
 * Size alone crowns an app nobody imports; use alone crowns a kit nobody edits.
 */
export function coreRegions(files, k = 4) {
  const by = new Map()
  for (const f of files) {
    if (f.kind !== 'source') continue
    const r = by.get(f.region) ?? { region: f.region, lines: 0, across: 0 }
    r.lines += f.lines ?? 0; r.across += f.usedAcross ?? 0
    by.set(f.region, r)
  }
  const rows = [...by.values()]
  const lines = rows.reduce((a, r) => a + r.lines, 0) || 1
  const across = rows.reduce((a, r) => a + r.across, 0) || 1
  return rows
    .map(r => ({ region: r.region, score: r.lines / lines + r.across / across }))
    .sort((a, b) => b.score - a.score || (a.region < b.region ? -1 : 1))
    .slice(0, k)
    .map(r => r.region)
}

/**
 * The core layout. `core[q]` owns quadrant q (top left, top right, bottom left,
 * bottom right) and fills a square at the center outward, most used file first,
 * one ring at a time and the diagonal first — so four regions of one size are
 * mirror images and a difference between them is a difference in the code.
 *
 * Every other region joins the quadrant of the core region it imports most
 * (`uses[region][coreRegion]`, ties to the emptiest quadrant) and is laid by
 * `gilbert` through the L the core square leaves, so it stays a block. Poured
 * ring by ring instead, a region is a line wrapped around the middle. A region
 * too large for the room left is split across quadrants, fullest preference first.
 * The page serializes this with `toString()` beside `gilbert`.
 */
export function coreLayout(files, core, uses = {}) {
  const byPath  = (a, b) => files[a].path < files[b].path ? -1 : 1
  const members = core.map(() => [])
  const others  = new Map()
  files.forEach((f, k) => {
    const q = core.indexOf(f.region)
    if (q >= 0) { members[q].push(k); return }
    if (!others.has(f.region)) others.set(f.region, [])
    others.get(f.region).push(k)
  })
  for (const m of members) m.sort((a, b) => (files[b].usedBy ?? 0) - (files[a].usedBy ?? 0) || byPath(a, b))
  for (const ks of others.values()) ks.sort(byPath)

  // A region goes WHOLE to the quadrant it pulls hardest toward among those with
  // room for it, and is split only when no quadrant has room; a square too small
  // to avoid a split is grown twice before one is accepted.
  const attempt = S => {
    const half = S / 2
    const side = members.map(m => Math.min(half, Math.ceil(Math.sqrt(m.length))))
    const room = side.map(c => half * half - c * c)
    const groups = [...others]
    const prefer = new Map()
    members.forEach((m, q) => { if (m.length > side[q] ** 2) { const key = core[q] + ' '; groups.push([key, m.slice(side[q] ** 2)]); prefer.set(key, q) } })
    if (groups.reduce((a, g) => a + g[1].length, 0) > room.reduce((a, r) => a + r, 0)) return null
    groups.sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
    const slots = core.map(() => [])
    let splits = 0
    for (const [region, ks] of groups) {
      const pull = core.map((name, q) => prefer.has(region) ? (prefer.get(region) === q ? 1 : 0) : uses[region]?.[name] ?? 0)
      const rank = qs => qs.sort((a, b) => pull[b] - pull[a] || room[b] - room[a] || a - b)
      const whole = rank(core.map((_, q) => q).filter(q => room[q] >= ks.length))[0]
      if (whole !== undefined) { slots[whole].push([region, ks]); room[whole] -= ks.length; continue }
      splits++
      const left = ks.slice()
      for (const q of rank(core.map((_, q) => q))) {
        if (!left.length) break
        const take = left.splice(0, room[q])
        if (take.length) { slots[q].push([region, take]); room[q] -= take.length }
      }
    }
    return { S, half, side, slots, splits }
  }
  let S = Math.max(2, 2 * Math.ceil(Math.ceil(Math.sqrt(files.length)) / 2)), plan = null, first = 0
  for (;;) {
    const next = attempt(S)
    if (next) { first ||= S; plan = next }
    if (next && (next.splits === 0 || S >= first + 4)) break
    S += 2
  }
  const { half, side, slots } = plan

  const signs = [[-1, -1], [1, -1], [-1, 1], [1, 1]]
  const place = (q, i, j) => [signs[q][0] > 0 ? half + i : half - 1 - i, signs[q][1] > 0 ? half + j : half - 1 - j]
  const ring  = []
  for (let r = 0; r < half; r++) {
    const cells = []
    for (let i = 0; i <= r; i++) { cells.push([i, r]); if (i !== r) cells.push([r, i]) }
    cells.sort((a, b) => Math.abs(a[0] - a[1]) - Math.abs(b[0] - b[1]) || a[0] - b[0])
    ring.push(...cells)
  }

  const cells = new Array(files.length)
  members.forEach((m, q) => m.slice(0, side[q] ** 2).forEach((k, n) => { cells[k] = place(q, ring[n][0], ring[n][1]) }))
  core.forEach((_, q) => {
    const c = side[q], order = []
    // One path through the L: the band under the core square ENDS on its outer
    // corner at the seam, and the band beside it STARTS on the cell across. Each
    // band walked from its own origin left the region at the seam in two blocks.
    // A curve ends on a corner of its rectangle — a 2×odd strip one cell short —
    // so flipping each axis toward the wanted corner is enough.
    const endingAt = (w, h, tx, ty) => {
      if (w <= 0 || h <= 0) return []
      const path = gilbert(w, h), [ex, ey] = path[path.length - 1]
      const fx = Math.abs(w - 1 - ex - tx) < Math.abs(ex - tx), fy = Math.abs(h - 1 - ey - ty) < Math.abs(ey - ty)
      return path.map(([x, y]) => [fx ? w - 1 - x : x, fy ? h - 1 - y : y])
    }
    for (const [x, y] of endingAt(c, half - c, c - 1, half - c - 1)) order.push([x, c + y])
    for (const [x, y] of endingAt(half - c, half, 0, half - 1).reverse()) order.push([c + x, y])
    slots[q].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0).flatMap(slot => slot[1])
      .forEach((k, n) => { cells[k] = place(q, order[n][0], order[n][1]) })
  })
  return { w: plan.S, h: plan.S, cells, splits: plan.splits }
}

/**
 * Every region as a square of its own, side `ceil(√files)`, with a cell of
 * ground between squares — the packages side by side, where the core layout
 * reads them as neighborhoods. Largest first, packed in shelves at whichever
 * width makes the squarest picture. Inside a square files run in path order along the curve,
 * as they do in the whole-project path order. `boxes` names each square for the
 * page's labels. The page serializes this with `toString()` beside `gilbert`.
 */
export function packageGrid(files) {
  const by = new Map()
  files.forEach((f, k) => { if (!by.has(f.region)) by.set(f.region, []); by.get(f.region).push(k) })
  const groups = [...by].map(([region, ks]) => ({ region, ks: ks.sort((a, b) => files[a].path < files[b].path ? -1 : 1), side: Math.ceil(Math.sqrt(ks.length)) }))
    .sort((a, b) => b.side - a.side || b.ks.length - a.ks.length || (a.region < b.region ? -1 : 1))
  const pack = w => {
    const boxes = []
    let x = 0, y = 0, shelf = 0
    for (const g of groups) {
      if (x > 0 && x + g.side > w) { x = 0; y += shelf + 1; shelf = 0 }
      boxes.push({ region: g.region, x, y, side: g.side })
      x += g.side + 1
      shelf = Math.max(shelf, g.side)
    }
    return { w, h: Math.max(1, y + shelf), boxes }
  }
  // Shelves waste the space beside a short square, so no one width is right:
  // every width is tried and the squarest picture kept, the smaller on a tie.
  const widest = groups.reduce((sum, g) => sum + g.side + 1, 0)
  let plan = pack(groups.length ? groups[0].side : 1)
  for (let w = plan.w + 1; w <= widest; w++) {
    const next = pack(w)
    if (Math.max(next.w, next.h) < Math.max(plan.w, plan.h) || (Math.max(next.w, next.h) === Math.max(plan.w, plan.h) && next.w * next.h < plan.w * plan.h)) plan = next
  }
  const cells = new Array(files.length)
  groups.forEach((g, i) => {
    const { x, y } = plan.boxes[i], curve = gilbert(g.side, g.side)
    g.ks.forEach((k, n) => { cells[k] = [x + curve[n][0], y + curve[n][1]] })
  })
  return { w: plan.w, h: plan.h, cells, boxes: plan.boxes }
}

// ─── bands per file ───────────────────────────────────────────────────────────

/** The reading order of a tile's quadrants: top left, top right, bottom left, bottom right. */
export const QUADRANTS = ['heat', 'blast', 'complexity', 'exposure']

/** Graded like a quadrant and drawn one at a time, behind the page's `more`. */
export const MORE = ['age', 'churn', 'tested']

/** A band per metric, 0 to STRONG; `null` where the metric does not apply. */
export function tileBands(file) {
  const source = file.kind === 'source'
  return {
    heat:       band(file.heat ?? 0, HEAT),
    blast:      source ? band(file.usedBy ?? 0, BLAST) : null,
    complexity: band(file.complexity, INDENT_SUM),
    exposure:   source ? band(file.exposure, INDENT_SUM) : null,
    age:        file.age == null ? null : STRONG - band(file.age, AGE_DAYS),
    churn:      band(file.churn, CHURN_COMMITS),
    tested:     file.tested?.level ? TESTED_BAND[file.tested.level] : null,
  }
}

// ─── the score ────────────────────────────────────────────────────────────────
//
// One number per source file: exposure × (1 + heat) × (1 + blast), each a LEVEL
// from 0 to 3. A level passes through its band cutoffs rather than snapping to
// them — exposure 100 is 1, 400 is 2, 1600 is 3 — because snapped bands zero
// the product for any file under the first exposure cutoff and left three files
// in this repo's top two steps. A product and not a sum, so a file is red only
// when several things are wrong at once: a tested file scores 0 however hot.

const clamp3 = x => Math.max(0, Math.min(3, x))
const log4   = x => Math.log(x) / Math.log(4)

export const LEVEL = {
  exposure: v => v > 0 ? clamp3(1 + log4(v / INDENT_SUM[0])) : 0,
  heat:     v => v > 0 ? clamp3(2 + log4(v / HEAT[1])) : 0,
  blast:    v => clamp3(Math.log2(1 + v) / Math.log2(1 + BLAST[2]) * 3),
}
export const SCORE_MAX   = 3 * 4 * 4
export const SCORE_STEPS = [1, 2, 4, 6, 9, 13, 20]
// the step from which a score is a warning — over 9
export const SCORE_WARN  = 5

/** `{ value, step, levels: [exposure, heat, blast] }`, or null for a file that is not scored. */
export function scoreOf(file) {
  if (file.kind !== 'source' || file.exposure == null) return null
  const levels = [LEVEL.exposure(file.exposure), LEVEL.heat(file.heat ?? 0), LEVEL.blast(file.usedBy ?? 0)]
  const value  = levels[0] * (1 + levels[1]) * (1 + levels[2])
  return { value, step: band(value, SCORE_STEPS), levels }
}

// ─── color ────────────────────────────────────────────────────────────────────
//
// A metric is a TONE of `@frontierjs/css` mixed over the theme's ground, one
// step per band (Invariant 13). The page writes the mix as `color-mix()` and the
// PNG computes the same mix in oklab here, so a theme — or a line of TONES —
// moves both pictures together. Band 0 is mostly ground: faint means quiet.

export const TONES = {
  heat: 'info', blast: 'primary', complexity: 'warning', exposure: 'danger',
  age:  'success', churn: 'info', tested: 'danger',
}
export const MIX   = [10, 40, 70, 100]
export const STRONG = MIX.length - 1

// Tested has three answers, so it skips a step: partly sits next to quiet rather
// than next to untested, which is the one worth seeing from across the room.
export const TESTED_BAND = { tested: 0, partly: 1, untested: STRONG }

for (const [name, t] of Object.entries({ HEAT, BLAST, INDENT_SUM, AGE_DAYS, CHURN_COMMITS }))
  if (t.length !== STRONG) throw new Error(`${name} has ${t.length} thresholds; MIX has ${MIX.length} steps, so it needs ${STRONG}`)

// The score is one tone, danger, over eight steps: [mix over the ground %, hue
// turn in degrees]. The mix is what carries the score — each step stands
// further from the ground than the last in every theme the package ships
// (tested) — and the turn only decorates it, purple into red into orange. A
// second tone for purple would not work: `secondary` is navy, green or rust
// depending on the theme, and nearer the ground than danger on a light one.
export const SCORE_RAMP = [[8, -80], [30, -70], [45, -58], [58, -44], [70, -30], [82, -16], [92, 0], [100, 24]]
if (SCORE_RAMP.length !== SCORE_STEPS.length + 1) throw new Error(`SCORE_STEPS has ${SCORE_STEPS.length} cutoffs; SCORE_RAMP has ${SCORE_RAMP.length} steps, so it needs ${SCORE_RAMP.length - 1}`)

// What is not a band: the ground, a slot at the end of the curve, a region's
// edge, and a quadrant the metric does not apply to.
export const GROUND = { surface: 'surface', empty: 'rule-strong', boundary: 'ink-mute', na: 'surface-sunken' }

/** Every `.theme-<name>` the stylesheet declares. */
export const themesIn = css => [...new Set([...css.matchAll(/\.theme-([a-z0-9-]+)\s*\{/g)].map(m => m[1]))].sort()

/**
 * The custom properties a theme resolves to: every `:root` block, then the
 * theme's own block over them. A value must come to a hex through `var()` —
 * anything else is refused by name, because a PNG cannot ask a browser.
 */
export function themeTokens(css, theme) {
  const props = new Map()
  const take = body => { for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+)(?:;|$)/g)) props.set(m[1], m[2].trim()) }
  for (const m of css.matchAll(/:root[^{]*\{([^{}]*)\}/g)) take(m[1])
  const own = [...css.matchAll(new RegExp(`\\.theme-${theme}\\s*\\{([^{}]*)\\}`, 'g'))]
  if (!own.length) throw new Error(`no theme "${theme}" in @frontierjs/css — one of: ${themesIn(css).join(', ')}`)
  for (const m of own) take(m[1])
  const resolve = (name, seen = new Set()) => {
    if (seen.has(name)) throw new Error(`--${name} refers to itself`)
    const value = props.get(name)
    if (value == null) throw new Error(`theme "${theme}" does not define --${name}`)
    const ref = /^var\(--([\w-]+)\)$/.exec(value)
    if (ref) return resolve(ref[1], new Set([...seen, name]))
    if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) throw new Error(`--${name} is "${value}" in theme "${theme}"; a PNG needs a hex`)
    return value.length === 4 ? '#' + [...value.slice(1)].map(c => c + c).join('') : value.toLowerCase()
  }
  return resolve
}

const toLinear = c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const toByte   = c => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)))

function toOklab(hex) {
  const [r, g, b] = [1, 3, 5].map(i => toLinear(parseInt(hex.slice(i, i + 2), 16)))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
          1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
          0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s]
}

function fromOklab([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
  return '#' + [ 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s].map(c => toByte(c).toString(16).padStart(2, '0')).join('')
}

/** `color-mix(in oklab, tone pct%, ground)`, as the browser computes it. */
export function mixOklab(tone, ground, pct) {
  const [x, y] = [toOklab(tone), toOklab(ground)]
  return fromOklab(x.map((v, i) => v * pct / 100 + y[i] * (1 - pct / 100)))
}

/** `oklch(from tone l c calc(h + deg))`, as the browser computes it. */
export function turnOklch(tone, deg) {
  const [L, a, b] = toOklab(tone), c = Math.hypot(a, b), h = Math.atan2(b, a) + deg * Math.PI / 180
  return fromOklab([L, c * Math.cos(h), c * Math.sin(h)])
}

/** Distance between two colors in oklab, ×100 — the scale a ΔE floor is stated in. */
export const deltaOklab = (x, y) => { const [p, q] = [toOklab(x), toOklab(y)]; return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) }

/** The score's eight hexes, from a theme's danger and its ground. */
export const scoreRamp = (danger, surface) => SCORE_RAMP.map(([p, deg]) => mixOklab(turnOklch(danger, deg), surface, p))

/** The hexes a PNG draws in, for one theme. */
export function paletteFrom(css, theme) {
  const token = themeTokens(css, theme)
  const surface = token(GROUND.surface)
  const out = Object.fromEntries(Object.entries(GROUND).map(([k, name]) => [k, token(name)]))
  for (const [metric, tone] of Object.entries(TONES)) out[metric] = MIX.map(p => mixOklab(token(`color-${tone}`), surface, p))
  out.score = scoreRamp(token('color-danger'), surface)
  return out
}

/** The same ramps as CSS custom properties, for the page. No hex: the theme decides. */
export function paletteCss() {
  const lines = []
  for (const [metric, tone] of Object.entries(TONES))
    MIX.forEach((p, b) => lines.push(`--tile-${metric}-${b}: color-mix(in oklab, var(--color-${tone}) ${p}%, var(--${GROUND.surface}));`))
  SCORE_RAMP.forEach(([p, deg], s) =>
    lines.push(`--tile-score-${s}: color-mix(in oklab, oklch(from var(--color-danger) l c calc(h + ${deg})) ${p}%, var(--${GROUND.surface}));`))
  for (const [k, name] of Object.entries(GROUND)) lines.push(`--tile-${k}: var(--${name});`)
  return lines.join('\n  ')
}

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const colorOf = (palette, metric, b) => rgb(b == null ? palette.na : palette[metric][b])

/** Source in the top two bands of both heat and exposure — changing now, and untested. */
export function isHotspot(file) {
  const b = tileBands(file)
  return file.kind === 'source' && b.heat >= STRONG - 1 && b.exposure >= STRONG - 1
}

/** What each band means, in words, off the same thresholds that grade it. */
export function bandLabels() {
  const upTo = (t, unit = '') => [`≤${t[0]}${unit}`, ...t.slice(1).map(x => `≤${x}${unit}`), `>${t.at(-1)}${unit}`]
  const churn = CHURN_COMMITS.map((t, i) => i === 0 ? `${t}` : CHURN_COMMITS[i - 1] + 1 === t ? `${t}` : `${CHURN_COMMITS[i - 1] + 1}–${t}`)
  return {
    heat:       ['cold', ...upTo(HEAT).slice(1)],
    blast:      ['unused', ...upTo(BLAST).slice(1)],
    complexity: upTo(INDENT_SUM),
    exposure:   upTo(INDENT_SUM),
    age:        [`>${AGE_DAYS.at(-1)}d`, ...AGE_DAYS.slice().reverse().map(d => `≤${d}d`)],
    churn:      [...churn, `${CHURN_COMMITS.at(-1) + 1}+`],
    tested:     Array.from(MIX, (_, b) => Object.keys(TESTED_BAND).find(k => TESTED_BAND[k] === b) ?? null),
    score:      upTo(SCORE_STEPS),
  }
}

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
export function renderMap(model, { palette, scale = 8, all = false }) {
  const files = all ? model.files : model.files.filter(f => f.kind === 'source')
  const { w, h, cells } = coreLayout(files, coreRegions(model.files), model.uses)
  const B     = Math.max(3, Math.round(scale))
  const gap   = B >= 6 ? 1 : 0
  const inner = B - gap
  const qa    = Math.ceil(inner / 2), qb = inner - qa
  const cv    = new Canvas(w * B + gap, h * B + gap, rgb(palette.surface))
  const at    = new Int32Array(w * h).fill(-1)
  files.forEach((_, d) => { const [x, y] = cells[d]; at[y * w + x] = d })
  const region = (x, y) => x < w && y < h && at[y * w + x] >= 0 ? files[at[y * w + x]].region : null

  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const bx = x * B + gap, by = y * B + gap
    const file = files[at[y * w + x]]
    if (!file) { cv.rect(bx + (inner >> 1), by + (inner >> 1), 1, 1, rgb(palette.empty)); continue }
    const bands = tileBands(file)
    QUADRANTS.forEach((m, q) => cv.rect(bx + (q % 2) * qa, by + (q >> 1) * qa, q % 2 ? qb : qa, q >> 1 ? qb : qa, colorOf(palette, m, bands[m])))
    if (!gap) continue
    const here = file.region
    const line = rgb(palette.boundary)
    if (region(x + 1, y) !== here && region(x + 1, y) !== null) cv.rect(bx + inner, by - gap, gap, B + gap, line)
    if (region(x, y + 1) !== here && region(x, y + 1) !== null) cv.rect(bx - gap, by + inner, B + gap, gap, line)
  }
  return cv.png()
}

// ─── the badge ────────────────────────────────────────────────────────────────

/**
 * Four 4×4 waffles, one per quadrant of a tile, over SOURCE files: sixteen cells
 * split by how many files sit in each band, strongest band first. The split is
 * `allocate`, so the sixteen always sum to sixteen.
 */
export function badgeCells(model) {
  const source = model.files.filter(f => f.kind === 'source')
  const out = {}
  const NA = STRONG + 1
  for (const metric of QUADRANTS) {
    const counts = Array(NA + 1).fill(0)
    for (const f of source) { const b = tileBands(f)[metric]; counts[b == null ? NA : STRONG - b]++ }
    if (!source.length) { out[metric] = Array(16).fill(null); continue }
    const cells = []
    allocate(16, counts).forEach((n, i) => { for (let k = 0; k < n; k++) cells.push(i === NA ? null : STRONG - i) })
    out[metric] = cells
  }
  return out
}

export function renderBadge(model, { palette, scale = 6 }) {
  const s    = Math.max(2, Math.round(scale))
  const pad  = Math.max(2, s >> 1)
  const half = 4 * s + 3
  const size = pad * 2 + half * 2 + pad
  const cv   = new Canvas(size, size, rgb(palette.surface))
  const cells = badgeCells(model)
  QUADRANTS.forEach((metric, q) => {
    const ox = pad + (q % 2) * (half + pad), oy = pad + (q >> 1) * (half + pad)
    cells[metric].forEach((b, i) => cv.rect(ox + (i % 4) * (s + 1), oy + (i >> 2) * (s + 1), s, s, colorOf(palette, metric, b)))
  })
  return cv.png()
}

// ─── json ─────────────────────────────────────────────────────────────────────

export function codegraphJson(model) {
  return JSON.stringify({
    ...model,
    rules: {
      sweepShare: SWEEP_SHARE, heat: HEAT, halfLifeDays: HALF_LIFE_DAYS, blast: BLAST, indentSum: INDENT_SUM,
      coverage: COVERAGE, ageDays: AGE_DAYS, churnCommits: CHURN_COMMITS, coveredPct: COVERED_PCT,
      score: { max: SCORE_MAX, steps: SCORE_STEPS, warnFrom: SCORE_WARN },
      tones: TONES, mix: MIX, quadrants: QUADRANTS, more: MORE,
    },
    badge: badgeCells(model),
    files: model.files.map(f => ({ ...f, bands: tileBands(f), score: scoreOf(f), hotspot: isHotspot(f) })),
  }, null, 2)
}
