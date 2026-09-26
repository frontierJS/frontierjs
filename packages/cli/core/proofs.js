// ─── proofs.js — which drive proves the change I just made ───────────────────
//
// `DRIVES.md` § *Which drive proves a change* holds the most
// expensive knowledge in this repository: each row was paid for once, usually by
// a defect that got through. It is prose, so it answers nobody at the moment
// somebody has just changed sierra's router, and — the sharper half — nothing
// has ever checked that a row still names a drive that exists.
//
// This module reads that table and resolves both of its columns: `run` onto
// things that can actually be run, `changed` onto a matcher over a file list.
//
// ── The table stays where people read it ────────────────────────────────────
//
// A copy in this file would be the exact duplication the control surface was
// built against, so this is a PARSE and never a second table. `repo-map.js` and
// `preflight.js` read the same file through `DRIVES_FILE` rather than naming
// the path again. It is not the root `CLAUDE.md`, because that file is loaded
// on every agent turn and a turn that proves nothing never needs these rows.
//
// ── What this is not ────────────────────────────────────────────────────────
//
// Not a build graph. `nx affected` and Tilt derive *what to rebuild* from what
// imports what, which is a different question with a different answer — half
// these rows are not import edges at all. *A `@@gate` on a model a SCREEN
// reads → `verify:account`* is a statement about what a drive can SEE, and no
// import graph produces it. The rows are the asset; this is only the reader.
//
// Zero dependencies, plain ESM, node or bun — same rule as its neighbors.

import { execFileSync }                          from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join }                                  from 'node:path'

import { kindOf }                                from './file-kind.js'

// ─── the parse ────────────────────────────────────────────────────────────────

/** Where both drive tables live, relative to the workspace root. */
export const DRIVES_FILE = 'DRIVES.md'

/**
 * The rows of `DRIVES.md` § *Which drive proves a change*, as written.
 *
 * `[]` where the file or the table is absent, which is correct for any project
 * that is not this one — a client app has no such table, and a reader that
 * invented rows for it would be worse than one that is short.
 */
export function readProofs(root) {
  const src = read(join(root, DRIVES_FILE))
  if (!src) return []

  const out = []
  let inTable = false
  let lineNo  = 0

  for (const line of src.split('\n')) {
    lineNo++
    if (/^\|\s*Changed\s*\|\s*Run\s*\|/i.test(line)) { inTable = true; continue }
    if (inTable && !line.startsWith('|')) break
    if (!inTable || /^\|\s*-+/.test(line)) continue

    const cells = splitRow(line)
    if (cells.length < 2) continue
    out.push({ changed: cells[0].trim(), run: cells[1].trim(), line: lineNo })
  }

  return out
}

// ─── resolving the `run` column ───────────────────────────────────────────────
//
// The column is `` `<where>`: `<target>` `` with prose after an em-dash, and a
// row often names several. Targets are read ONLY where they follow a `where`
// anchor or are joined to one by `+` / `and` / a middot — because the prose
// after the dash is full of backticks too (*the only drive that prerenders a
// DYNAMIC route (`getStaticPaths`)*), and a naive scan turns every one of those
// into a target that resolves to nothing.
//
// `where` is resolved against the tree rather than through a table: `example` is
// a directory, `sierra` is `packages/sierra`, `packages/junction` is itself. A
// hardcoded map would go stale the first time a package moves.

const JOIN = /^\s*(?:\*\*and\*\*|and|\+|,|·|&)\s*/

export function resolveRun(runText, { root, rows = [] } = {}) {
  const out = []
  const re  = /`([^`]+)`\s*:\s*/g
  let m

  while ((m = re.exec(runText))) {
    const dir = resolveWhere(m[1], root)
    let rest  = runText.slice(re.lastIndex)

    // The first target, then any joined to it while no new `where` intervenes.
    for (;;) {
      const t = rest.match(/^\s*`([^`]+)`/)
      if (!t) break
      out.push(target(t[1], dir, m[1], root, rows))
      rest = rest.slice(t[0].length)
      const j = rest.match(JOIN)
      if (!j) break
      // A `where` anchor after the joiner belongs to the outer loop.
      if (/^\s*`[^`]+`\s*:/.test(rest.slice(j[0].length))) break
      rest = rest.slice(j[0].length)
    }
    re.lastIndex = runText.length - rest.length
  }

  return out
}

/**
 * One target, graded by what it turned out to be.
 *
 * `row` — a runnable this project already lists, so it can be pressed.
 * `script` — a real script in that package's `package.json` that is not a
 *   runnable row: `sierra`'s `test:widgets` and `test:safety` are both this, and
 *   naming them honestly beats either inventing a row or dropping them.
 * `file` — a test FILE. No command is offered, because the runner differs per
 *   package and guessing `bun test` for a vitest package is worse than silence.
 * `unknown` — nothing there answers to this. That is the finding the check rule
 *   exists for: a row naming a drive that has been renamed reads exactly like a
 *   row that is right.
 */
function target(name, dir, where, root, rows) {
  const base = { name, where, dir }

  if (/\.(ts|js|mjs|mesa)$/.test(name) || name.includes('/')) {
    const exists = dir !== null && existsSync(join(root, dir, name))
    return { ...base, kind: exists ? 'file' : 'unknown', id: null, command: null }
  }

  // `bun run test` and `bun run test match` — the suite, sometimes with a filter.
  const suite = name.match(/^bun run test\b(.*)$/)
  if (suite) {
    const row = rows.find(r => r.kind === 'suite' && r.dir === dir)
    return { ...base, kind: row ? 'row' : 'script', id: row?.id ?? null, command: `bun run test${suite[1]}` }
  }

  // `test:browser geofield` — a script and its argument. The script is looked up
  // alone, or a real script carrying a filter grades as a drive renamed away.
  const [script, ...args] = name.split(/\s+/)
  const arg = args.length ? ` ${args.join(' ')}` : ''

  const row = rows.find(r => r.dir === dir && r.name === script && (r.kind === 'drive' || r.kind === 'task'))
  if (row) return { ...base, kind: 'row', id: row.id, command: row.start && `${row.start}${arg}` }

  // Not a row, but the package may still declare it.
  const pkg = dir === null ? null : readJson(join(root, dir, 'package.json'))
  if (pkg?.scripts?.[script]) return { ...base, kind: 'script', id: null, command: `bun run ${name}` }

  return { ...base, kind: 'unknown', id: null, command: null }
}

/**
 * `example` -> `example`; `sierra` -> `packages/sierra`; `packages/x` -> itself.
 *
 * Exported because `preflight.js` reads the table beside this one and has to
 * mean the same thing by `sierra`; two answers to *which directory is that* is
 * how the two tables end up disagreeing about one row.
 */
export function resolveWhere(where, root) {
  for (const candidate of [where, join('packages', where)]) {
    if (existsSync(join(root, candidate, 'package.json'))) return candidate
  }
  return null
}

// ─── matching the `changed` column ────────────────────────────────────────────
//
// Three tiers, and the tier travels with the answer so a weak match reads as a
// weak match rather than as the same claim a path match makes.
//
//   path     a backticked token that looks like one, matched against the file
//   area     the package, NARROWED by the row's own words — `sierra
//            prerender/islands/static-safety` against `src/build/prerender.js`
//   symbol   a backticked identifier appearing in the diff's own text
//   package  the package alone, which is the weakest thing a row can say
//
// The `area` tier exists because the package tier is coarse to the point of
// noise: four rows name sierra, so any file under it matched all four and the
// answer was *run everything*. The rows already carry the narrowing — the tail
// of `sierra prerender/islands/static-safety` is three words, and two of them
// are directory names — so it is read rather than declared.
//
// The symbol tier needs the diff CONTENT and is skipped without it, rather than
// being approximated from the file list — a row that matches for a reason
// nobody can see is worse than a row that does not match.
//
// Every tier but `path` reads only what the project RUNS (`changesBehavior`),
// and the symbol tier only CODE (`holdsSymbols`), only the lines that changed
// rather than moved (`changedLines`), and a symbol only as a whole identifier:
// `find` inside `findMany` is not `find()`. A path the row names still matches
// any file — that is the row saying so.

export function matchChanged(changedText, { files, diff = null, packages = [] }) {
  const ticks = [...changedText.matchAll(/`([^`]+)`/g)].map(m => m[1])
  const hits  = []

  for (const t of ticks) {
    if (!/[/.]/.test(t) || /\s/.test(t)) continue
    const token = t.replace(/^\.\//, '')
    for (const f of files) if (f === token || f.endsWith(`/${token}`)) hits.push({ tier: 'path', file: f, on: t })
  }
  if (hits.length) return best(hits)

  const code = files.filter(changesBehavior)

  // The leading words, up to the first punctuation the prose uses to qualify.
  const lead  = changedText.toLowerCase().split(/[—·(/]|\s+-\s+/)[0]
  const owned = packages.filter(p => new RegExp(`(^|\\s)${escapeRe(p.name)}(\\b|'s)`).test(lead))

  if (owned.length) {
    const words = areaWords(changedText, owned)
    for (const pkg of owned) {
      for (const f of code) {
        if (!f.startsWith(`${pkg.dir}/`)) continue
        const hit = words.find(w => f.toLowerCase().includes(w))
        if (hit) hits.push({ tier: 'area', file: f, on: hit })
      }
    }
    if (hits.length) return best(hits)
  }

  if (diff) {
    const text = diffText(diff)
    for (const t of ticks) {
      if (!/^[A-Za-z_$][\w$.]*(\(\))?$/.test(t)) continue
      const sym = t.replace(/\(\)$/, '')
      // `id` and `db` appear in every diff ever written.
      if (sym.length < 4) continue
      if (new RegExp(`(?<![\\w$])${escapeRe(sym)}(?![\\w$])`).test(text)) hits.push({ tier: 'symbol', file: null, on: sym })
    }
  }
  if (hits.length) return best(hits)

  // The package alone. Last, and named as the weakest thing a row can say: it
  // means *something in here changed and this row is about here*, which is true
  // of four rows at once for sierra.
  for (const pkg of owned) {
    for (const f of code) if (f.startsWith(`${pkg.dir}/`)) hits.push({ tier: 'package', file: f, on: pkg.name })
  }
  return hits.length ? best(hits) : null
}

// ─── what a change is evidence of ─────────────────────────────────────────────

// A `.md` under `commands/` is a fli command — prose and fenced code, compiled
// and run — whatever its namespace directory is called; `commands/test/` is one.
const COMMAND = /(^|\/)commands\/.+\.md$/

/**
 * Whether a change to this file is a change to what the project runs. A
 * document names every symbol it explains and a regenerated snapshot names
 * every symbol in the repo, so either matched most of the table; a test is its
 * own proof, and running it is what proves a change to it.
 */
export function changesBehavior(file) {
  return COMMAND.test(file) || !['test', 'doc', 'generated'].includes(kindOf(file))
}

/**
 * Whether a changed line in this file is read for symbols. A line is read
 * whole, so only code: a command's prose is English, and the one line of a
 * package's test script names every test file it runs.
 */
export function holdsSymbols(file) {
  return ['source', 'example'].includes(kindOf(file))
}

/**
 * The lines a `-U0` diff adds and removes in files `keep` accepts, minus every
 * line that only MOVED — removed in one place and added in another, whitespace
 * and a leading `export` aside. Splitting a file into nine is thousands of lines
 * naming every symbol it held, and none of them changed.
 *
 * Four kinds of line are not read at all, because each names a symbol without
 * changing what it does: a hunk header (git writes the enclosing function into
 * it), a comment, an import, and a bare list of names — the middle of a
 * multi-line import, which `-U0` hands over one line at a time.
 */
export function changedLines(diff, keep = () => true) {
  const added   = []
  const removed = []
  let take = true
  let hunk = true

  for (const line of String(diff ?? '').split('\n')) {
    const head = line.match(/^diff --git a\/\S+ b\/(\S+)/)
    if (head) { take = keep(head[1]); hunk = false; continue }
    if (line.startsWith('@@')) { hunk = true; continue }
    if (!hunk || !take) continue
    const body = line.slice(1).trim().replace(/\s+/g, ' ').replace(/^export (default )?/, '')
    if (!body || NOT_CODE.some(re => re.test(body))) continue
    if (line[0] === '+') added.push(body)
    else if (line[0] === '-') removed.push(body)
  }

  const moved = new Map()
  for (const l of removed) moved.set(l, (moved.get(l) ?? 0) + 1)
  const out = []
  for (const l of added) {
    const n = moved.get(l)
    if (n) moved.set(l, n - 1)
    else out.push(l)
  }
  for (const [l, n] of moved) for (let i = 0; i < n; i++) out.push(l)
  return out.join('\n')
}

const NOT_CODE = [
  /^(\/\/|\/\*|\*)/,
  /^import\b/,
  /^(export\s*)?(\*|\{[^}]*\})\s*from\s*['"]/,
  /^\}\s*from\s*['"]/,
  /^[\w$]+(\s+as\s+[\w$]+)?(\s*,\s*[\w$]+(\s+as\s+[\w$]+)?)*\s*,?$/,
]

// Every row asks about the same diff, and a split's diff is megabytes.
let lastDiff = { diff: null, text: '' }
function diffText(diff) {
  if (lastDiff.diff !== diff) lastDiff = { diff, text: changedLines(diff, holdsSymbols) }
  return lastDiff.text
}

// Words from the row that could name a directory or a file under the package.
// Its own package names are dropped — every file under `packages/sierra` has
// "sierra" in its path, so keeping them would make every match an `area` one.
const AREA_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'over',
  'a', 'an', 'its', 'own', 'only', 'reads', 'model', 'screen', 'store', 'rule',
])

function areaWords(changedText, owned) {
  const names = new Set(owned.map(p => p.name))
  return [...new Set(
    changedText.toLowerCase()
      .replace(/`[^`]*`/g, ' ')          // backticks are the path and symbol tiers'
      .split(/[^a-z0-9]+/)
      .filter(w => w.length >= 5 && !AREA_STOP.has(w) && !names.has(w)),
  )]
}

function best(hits) {
  return {
    tier:  hits[0].tier,
    on:    [...new Set(hits.map(h => h.on))],
    files: [...new Set(hits.map(h => h.file).filter(Boolean))],
  }
}

// ─── the answer ───────────────────────────────────────────────────────────────

// Strongest first. `symbol` beats `package` because a backticked identifier
// appearing in the diff is a statement about the change, and a package name is
// a statement about the directory it happens to live in.
const TIER_ORDER = { path: 0, area: 1, symbol: 2, package: 3 }

/**
 * Which rows this change touches, strongest match first.
 *
 * `rows` is `runnables()`'s output where the caller has it, so a target can be
 * a thing to press rather than a string; without it every target grades as a
 * script or a file, which is still the useful half.
 */
export function provesFor(root, { files, diff = null, rows = [] } = {}) {
  const packages = packageDirs(root)

  return readProofs(root)
    .map(p => ({ ...p, match: matchChanged(p.changed, { files, diff, packages }) }))
    .filter(p => p.match)
    .map(p => ({ ...p, targets: resolveRun(p.run, { root, rows }) }))
    .sort((a, b) => TIER_ORDER[a.match.tier] - TIER_ORDER[b.match.tier] || a.line - b.line)
}

/**
 * The change `provesFor` grades — `{ files, diff }` for the working tree
 * against HEAD, or a branch against `from`. One reader for `test:proves`,
 * `test:prove` and `test:done`, so the three cannot name different drives for
 * one tree.
 *
 * The working tree includes UNTRACKED files, content and all. A module that is
 * new is in no `git diff`, so without it every line moved into one read as
 * deleted from where it came from — a split named thirty drives.
 *
 * `paths` narrows it to what one change touched. A tree shared with another
 * session holds that session's edits too, and proving them costs every drive
 * they name — eleven for a one-file fix, measured.
 *
 * The diff CONTENT is the symbol tier: without it a row naming
 * `announceDataWrites` matches only by the package it lives in. `--no-color`,
 * because a user's `color.diff = always` colors a piped diff too. `--relative`,
 * because git answers from the repository root, and a project one level below
 * it would be matched on paths carrying a prefix its own table never writes.
 */
export function changedTree(root, { from = null, paths = [] } = {}) {
  const against = from ? `${from}...` : 'HEAD'
  const only    = paths.length ? ['--', ...paths] : []
  const git = (argv) => {
    try { return execFileSync('git', argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch { return '' }
  }
  const lines = text => text.trim().split('\n').filter(Boolean)
  const fresh = from ? [] : lines(git(['ls-files', '--others', '--exclude-standard', ...only]))
  const files = [...new Set([...lines(git(['diff', '--relative', '--name-only', against, ...only])), ...fresh])].sort()
  if (!files.length) return { files, diff: '' }
  return { files, diff: git(['diff', '--relative', '--no-color', '-U0', against, ...only]) + fresh.map(f => newFileDiff(root, f)).join('') }
}

// `git diff --no-index` exits 1 when the two sides differ, which for a new file
// is always, so the answer arrives on the thrown error.
function newFileDiff(root, file) {
  try { if (statSync(join(root, file)).size > NEW_FILE_LIMIT) return '' } catch { return '' }
  try {
    execFileSync('git', ['diff', '--no-color', '-U0', '--no-index', '--', '/dev/null', file], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return ''
  } catch (err) { return err.status === 1 ? String(err.stdout ?? '') : '' }
}

const NEW_FILE_LIMIT = 2_000_000

/** Every directory a proof row could name — `packages/*` plus the root's apps. */
export function packageDirs(root) {
  const out  = []
  const seen = new Set()

  const add = (name, dir) => {
    const key = `${name}\x00${dir}`
    if (!name || seen.has(key)) return
    seen.add(key)
    out.push({ name, dir })
  }

  for (const dir of [...listDirs(join(root, 'packages')).map(d => `packages/${d}`), ...listDirs(root)]) {
    const pkg = readJson(join(root, dir, 'package.json'))
    if (!pkg) continue
    // Both spellings a row might use: the published name without its scope, and
    // the folder it sits in. `@frontierjs/cli` is written `fli` nowhere in that
    // table, but `basecamp` is written as its folder and `ui` as its name.
    add(String(pkg.name ?? '').replace(/^@[^/]+\//, '').toLowerCase(), dir)
    add(dir.split('/').pop().toLowerCase(), dir)
  }
  return out
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name)
      .sort()
  } catch { return [] }
}

function read(path)     { try { return readFileSync(path, 'utf8') } catch { return null } }
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
function escapeRe(s)    { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

/** A markdown row's cells, respecting an escaped pipe inside one. */
export function splitRow(line) {
  const ESC = '\x00'
  return line.replace(/\\\|/g, ESC).split('|').slice(1, -1)
    .map(c => c.split(ESC).join('|'))
}
