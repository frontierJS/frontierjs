// ─── repo-map.js — the workspace, read rather than described ─────────────────
//
// One page answering "what is in here and how do I run it", built from the tree
// every time. The prose version of this lived in a hand-written markdown file
// and was wrong within a fortnight, which is the failure this exists to stop: a
// map that costs a person to maintain is a map that lies. Nothing here is
// typed twice — every row comes from a file that would break something else if
// it were wrong.
//
//   snapshots  ← core/snapshots.js, the same walker the CI phase runs
//   ci phases  ← scripts/ci.mjs's own `main()`, in call order
//   packages   ← every package.json, incl. which siblings it depends on
//   drives     ← the `verify*` scripts those package.json files declare
//   ports      ← core/ports.js's PROJECTS registry
//   issues     ← ISSUES.md's tables, open rows only
//   decisions  ← DECISIONS.md's rulings, by section
//   ideas      ← IDEAS/overview.md's ranked rows, and every paper's own title
//   commands   ← the .md files under a fli command tree
//   registers  ← the markdown files at the workspace root
//
// A section whose source is absent is omitted rather than faked — a client app
// has no `scripts/ci.mjs` and no `ISSUES.md`, and a map that invents them is
// worse than one that is short.
//
// ── Determinism ──────────────────────────────────────────────────────────────
//
// The output is committed and rechecked with `--check`, so nothing in it may
// vary between two runs over one tree: no dates, no timings, no directory
// order. Every list is sorted before it is rendered.
//
// Zero dependencies, plain ESM, node or bun — same rule as `snapshots.js` and
// `checks.js`, because the callers include a script that runs before install.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative }                                  from 'node:path'
import { findSnapshots }        from './snapshots.js'
// The tree readers both this and `core/runnables.js` use. One answer to *where
// could an app be*, *what is a drive* and *what is a command*: two would drift,
// and the one that drifted would be the one nobody reads the output of.
import { SKIP, safeRead, isDir, readJson, appDirs, driveRows, readCommands } from './runnables.js'
import { readProofs } from './proofs.js'
import { RULES }                from './checks.js'
import { styleBundle }          from './assets.js'    
import { PROJECTS, GLOBAL, ENV, CAT } from './ports.js'

// A generator names its realm — litestone is Data, junction is API, sierra is
// UI. Nothing else in this file needs to know what a realm is.
const REALM_BY_BIN = { litestone: 'data', junction: 'api', sierra: 'ui', fli: 'repo' }


// ─── collect ──────────────────────────────────────────────────────────────────
//
//   collect({ root })  → the whole model, ready to render or serialise
//
// Every field is either read or null. A caller may render a partial model.

export function collect({ root }) {
  const members = packages(root)
  const notes   = packageNotes(root)

  for (const m of members) {
    const note = notes[m.name] ?? notes[m.folder]
    if (note) Object.assign(m, note)
  }

  return {
    root:      rootName(root),
    scripts:   rootScripts(root),
    snapshots: snapshots(root),
    ci:        ciPhases(root),
    packages:  members,
    apps:      apps(root),
    proofs:    proofs(root),
    css: styleBundle(root),
    invariants: invariants(root),
    checks:    checkRules(root),
    drives:    drives(root),
    ports:     ports(),
    issues:    issues(root),
    decisions: decisions(root),
    ideas:     ideas(root),
    commands:  commands(root),
    registers: registers(root),
  }
}

// ─── the workspace root ───────────────────────────────────────────────────────

function rootName(root) {
  const pkg = readJson(join(root, 'package.json'))
  return pkg?.name ?? root.split('/').filter(Boolean).pop() ?? 'workspace'
}

function rootScripts(root) {
  const pkg = readJson(join(root, 'package.json'))
  return Object.entries(pkg?.scripts ?? {}).map(([name, run]) => ({ name, run })).sort(byName)
}

// ─── snapshots ────────────────────────────────────────────────────────────────
//
// The generator is the remedy, so it is carried whole: `cd <dir> && bunx <argv>`
// regenerates, and the same line with `--check` is what CI runs.

function snapshots(root) {
  return findSnapshots({ root }).map(s => ({
    file:      s.file,
    dir:       s.dir,
    generator: s.argv ? s.argv.join(' ') : null,
    realm:     s.argv ? (REALM_BY_BIN[s.argv[0]] ?? 'repo') : 'repo',
    error:     s.error,
  }))
}

// ─── ci phases ────────────────────────────────────────────────────────────────
//
// Read out of `main()` in call order, with the guard each call sits under, so a
// phase that is added, reordered or moved between tiers moves here too. The
// prose is the phase's own section comment — restating it in this file would be
// a second copy that drifts, which is the thing the whole map is against.
//
// A parse that finds nothing returns null: the section then does not render,
// which is correct for any workspace that is not this one.

function ciPhases(root) {
  const file = join(root, 'scripts', 'ci.mjs')
  if (!existsSync(file)) return null

  const src  = read(file)
  const body = src?.match(/function main\s*\(\)\s*\{\n([\s\S]*?)\n\}/)?.[1]
  if (!body) return null

  const phases = []
  const guards = []

  for (const line of body.split('\n')) {
    const opened = line.match(/if\s*\(\s*!\s*(\w+)\s*\)\s*\{/)
    if (opened) { guards.push(opened[1]); continue }
    if (/^\s*\}/.test(line)) { guards.pop(); continue }

    const call = line.match(/^\s*(\w+)\(\)\s*$/)
    if (!call || call[1] === 'report') continue

    phases.push({
      fn:    call[1],
      label: phaseLabel(src, call[1]) ?? call[1],
      // `!fast` means "not on the fast tier" — the guard names the flag that
      // switches the phase off, which is what someone running it wants to know.
      tier:  guards.includes('fast') ? 'full run' : 'fast',
      skips: guards.map(g => `--${kebab(g)}`),
      note:  phaseNote(src, call[1]),
    })
  }

  return phases.length ? { file: relative(root, file), phases } : null
}

/** The string the phase announces itself with — `phase('structure')`. */
function phaseLabel(src, fn) {
  const at = src.indexOf(`function ${fn}(`)
  if (at < 0) return null
  return src.slice(at, at + 600).match(/phase\(['"]([^'"]+)['"]\)/)?.[1] ?? null
}

/** The contiguous comment block directly above the function, first sentence of. */
function phaseNote(src, fn) {
  const at = src.indexOf(`function ${fn}(`)
  if (at < 0) return null

  const before = src.slice(0, at).split('\n')
  const lines  = []
  for (let i = before.length - 1; i >= 0; i--) {
    const line = before[i].trim()
    if (line === '') continue
    if (!line.startsWith('//')) break
    lines.unshift(line.replace(/^\/\/\s?/, ''))
  }

  const prose = lines
    .filter(l => !/^─|─$/.test(l.trim()))   // the box-drawing dividers are not prose
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

  return prose ? firstSentence(prose, 260) : null
}

// ─── packages ─────────────────────────────────────────────────────────────────
//
// A member is a directory under `packages/` with a package.json. One WITHOUT is
// reported too and marked claimed: it does not install, test or count, and the
// only thing that makes that visible is a list of what is there beside a list of
// what is a member.

function packages(root) {
  const dir = join(root, 'packages')
  if (!existsSync(dir)) return []

  const names = safeRead(dir).filter(n => !SKIP.has(n) && !n.startsWith('.') && isDir(join(dir, n)))
  const members = []

  for (const folder of names) {
    const pkg = readJson(join(dir, folder, 'package.json'))
    if (!pkg) { members.push({ folder, claimed: true }); continue }
    members.push({
      folder,
      name:    pkg.name ?? folder,
      version: pkg.version ?? null,
      private: pkg.private === true,
      desc:    pkg.description ?? null,
      test:    pkg.scripts?.test ?? null,
      manager: existsSync(join(dir, folder, 'package-lock.json')) ? 'npm' : 'bun',
      deps:    [],   // filled below, once every member name is known
      raw:     pkg,
    })
  }

  const ceilings = baselines(root)

  for (const m of members) {
    if (m.claimed) continue
    m.topics     = topics(join(dir, m.folder), root)
    m.sections   = readmeSections(join(dir, m.folder))
    m.subsystems = subsystems(join(dir, m.folder))
    // Absent is 0 — the file's own rule, and the reason it is keyed by folder.
    m.baseline = ceilings[m.folder] ?? 0
  }

  const known = new Set(members.filter(m => m.name).map(m => m.name))

  for (const m of members) {
    if (!m.raw) continue
    const all = { ...m.raw.dependencies, ...m.raw.peerDependencies }
    m.deps = Object.keys(all).filter(d => known.has(d)).sort()
    delete m.raw
  }

  // The other direction, which no file states: who breaks if this one moves.
  for (const m of members) {
    if (m.claimed) continue
    m.dependents = members.filter(o => o.deps?.includes(m.name)).map(o => o.name).sort()
  }

  return members.sort((a, b) => (a.name ?? a.folder).localeCompare(b.name ?? b.folder))
}

// ─── what a package actually does ─────────────────────────────────────────────
//
// Nobody remembers a package's whole surface, and the place it is already
// written down is `docs/` — one file per capability — with the README's own
// `##` headings as the second index. Both are read: a topic is a document
// somebody wrote and can open, not a feature list this file invents. A package
// with neither has nothing to show here, which is itself worth seeing.

function topics(pkgDir, root) {
  const dir = join(pkgDir, 'docs')
  if (!existsSync(dir)) return []

  const out = []
  for (const name of safeRead(dir)) {
    if (!name.endsWith('.md') || name === 'README.md') continue

    const head = read(join(dir, name))?.slice(0, 1500) ?? ''
    const body = head.replace(/^#\s+.+$/m, '')

    out.push({
      file:  relative(root, join(dir, name)).split('\\').join('/'),
      title: head.match(/^#\s+(.+)$/m)?.[1].trim() ?? name.replace(/\.md$/, ''),
      claim: firstSentence(plain(body.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('```')) ?? ''), 130),
    })
  }

  return out.sort(byFile)
}

/** The README's own section headings — the surface as its author grouped it. */
/**
 * A README's `##` headings, each with the first thing it says.
 *
 * For a package with no `docs/` this IS the feature list — junction documents
 * thirty-two capabilities in one README and one file under `docs/` — so a
 * heading alone is not enough. Half of them open on a fenced example rather
 * than on prose, which is what an API package's README looks like, so the
 * opening LINE of that fence is kept instead: `Response helpers` says nothing
 * and `ctx.json(data)` says the whole thing.
 */
function readmeSections(pkgDir) {
  const src = read(join(pkgDir, 'README.md'))
  if (!src) return []

  const out = []
  let at = null
  let fenced = false

  for (const line of src.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      at = { title: plain(heading[1]), claim: '', code: '' }
      fenced = false
      // A `##` inside a fence is a comment, not a heading — but a fence that
      // opened under the PREVIOUS heading is closed by this one either way.
      if (!/^(install|licen[cs]e|contributing|changelog)$/i.test(at.title)) out.push(at)
      continue
    }
    // First thing wins. Scanning on for a signature after prose was already
    // found picks up whatever example happens to be furthest down the section.
    if (!at || at.claim || at.code) continue

    const text = line.trim()
    if (text.startsWith('```')) { fenced = !fenced; continue }
    if (!text) continue

    if (fenced) at.code = firstSentence(text, 90)
    else if (!NOT_PROSE.test(text)) at.claim = firstSentence(plain(text), 150)
  }

  return out
}

// ─── what the source is made of ───────────────────────────────────────────────
//
// The directories under `src/`, each with how many files are in it. Not a
// feature list and not a substitute for one: it is the structural answer to
// *where does this live*, which for a package documenting itself in one README
// is the only map of the code there is.

function subsystems(pkgDir) {
  const dir = join(pkgDir, 'src')
  if (!existsSync(dir)) return []

  return safeRead(dir)
    .filter(name => !SKIP.has(name) && !name.startsWith('.') && isDir(join(dir, name)))
    .map(name => ({ name, files: countFiles(join(dir, name)) }))
    .filter(s => s.files)
}

function countFiles(dir) {
  let n = 0
  for (const name of safeRead(dir)) {
    if (SKIP.has(name) || name.startsWith('.')) continue
    const path = join(dir, name)
    n += isDir(path) ? countFiles(path) : 1
  }
  return n
}

// ─── package notes ────────────────────────────────────────────────────────────
//
// The realm a package belongs to is a statement about the mental model and lives
// in the root `CLAUDE.md` table — the one place it is written down. Parsed, not
// restated: a package that moves realm moves here, and one the table forgets is
// visibly missing rather than quietly labelled.

function packageNotes(root) {
  const src = read(join(root, 'CLAUDE.md'))
  if (!src) return {}

  const notes = {}
  let inTable = false

  for (const line of src.split('\n')) {
    if (/^\|\s*Package\s*\|\s*Realm/i.test(line)) { inTable = true; continue }
    if (inTable && !line.startsWith('|')) { inTable = false; continue }
    if (!inTable || /^\|\s*-+/.test(line)) continue

    const cells = splitRow(line)
    if (cells.length < 4) continue

    // `cli (\`fli\`)` names the folder and its binary; the folder is the key.
    const name = plain(cells[0]).replace(/\s*\(.*\)$/, '').trim()
    if (!name) continue

    notes[name] = {
      realm: plain(cells[1]),
      what:  firstSentence(plain(cells[2]), 200),
      state: firstSentence(plain(cells[3]), 200),
    }
  }

  return notes
}

// ─── typecheck ceilings ───────────────────────────────────────────────────────
//
// One number per package, ratcheting down only. Absent means 0, which is the
// file's own rule and why a package with none is not a package with no data.
// Keyed by DIRECTORY name, not by package name.

function baselines(root) {
  const raw = readJson(join(root, 'scripts', 'typecheck-baselines.json')) ?? {}
  const out = {}

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('//') || typeof value !== 'number') continue
    out[key] = value
  }

  return out
}

// ─── invariants and the rules that check them ─────────────────────────────────
//
// Two halves of one question that nothing crosses today. The root `CLAUDE.md`
// numbers the invariants; `core/checks.js` exports the rules, and each rule
// names the invariant it comes from — so the crossing says which invariants a
// machine actually enforces, and which are held up by nothing but attention.
//
// The rules are IMPORTED rather than parsed, because they are already data in
// this package.

function invariants(root) {
  const src = read(join(root, 'CLAUDE.md'))
  if (!src) return []

  const section = src.split(/^##\s+Invariants\s*$/m)[1]
  if (!section) return []

  const body = section.split(/^---$/m)[0]
  const out  = []

  for (const line of body.split('\n')) {
    const row = line.match(/^(\d+)\.\s+\*\*(.+?)\*\*\s*(.*)$/)
    if (!row) continue
    out.push({
      n:     Number(row[1]),
      title: plain(row[2]),
      blurb: firstSentence(plain(row[3].replace(/^[—–-]\s*/, '')), 190),
    })
  }

  return out
}

function checkRules() {
  return RULES.map(r => ({ id: r.id, title: r.title, scope: r.scope, severity: r.severity, invariant: r.invariant }))
}

// ─── the styling language, vendored ───────────────────────────────────────────
//
// The generated pages are written in `@frontierjs/css` (Invariant 13), and the
// stylesheet is INLINED rather than linked. Three things a link could not do:
// the page opens from a `file://` path and has to render with no network, a
// published Artifact is refused an external request outright by CSP, and a link
// is styled by whatever the registry answers rather than by the tree the page
// describes (`FJS-256`).
//
// The build itself is `core/assets.js`, because the Web GUI is written in
// the same language and must be styled by the same bytes.

// ─── what proves a change ─────────────────────────────────────────────────────
//
// The highest-value paragraph in a root `CLAUDE.md` is the table that says
// which drive proves a change to which package — *changed the compiler, run the
// SSR drive AND the hydration one, they fail apart*. It exists in exactly one
// place, in prose, and a person who needs it is by definition not reading the
// file top to bottom.
//
// Read as pairs. Which package a row is about is a matching question and
// belongs to the reader that draws the page, not here.

// The proof table's rows, read through `core/proofs.js` — which also resolves
// them, for `fli proves` and the two rules that grade the table. A second parse
// here is what that module exists to prevent.
//
// The markup is stripped on the way through: this page renders for a person,
// while the resolver needs the backticks, because a backticked token IS the
// path or the target it is matching. Two readings of one parse rather than two
// parses.
function proofs(root) {
  return readProofs(root).map(p => ({ changed: plain(p.changed), run: plain(p.run) }))
}


// ─── apps ─────────────────────────────────────────────────────────────────────
//
// An app is not a package: it is never published, it sits wherever it sits, and
// it is where a framework's seams are actually crossed. One is recognised by
// carrying a schema or a drive — the two things a library in this workspace
// does not have.

function apps(root) {
  const out = []

  for (const name of safeRead(root)) {
    if (SKIP.has(name) || name.startsWith('.') || name === 'packages') continue
    const dir = join(root, name)
    if (!isDir(dir)) continue

    const pkg = readJson(join(dir, 'package.json'))
    if (!pkg) continue

    const hasSchema = existsSync(join(dir, 'db', 'schema.lite'))
    const hasDrive  = Object.keys(pkg.scripts ?? {}).some(s => /^verify/.test(s))
    if (!hasSchema && !hasDrive) continue

    out.push({
      folder: name,
      name:   pkg.name ?? name,
      desc:   pkg.description ?? null,
      schema: hasSchema,
      scripts: Object.entries(pkg.scripts ?? {}).map(([n, run]) => ({ name: n, run })).sort(byName),
    })
  }

  return out.sort(byFile2)
}

function byFile2(a, b) { return a.folder.localeCompare(b.folder) }

// ─── drives ───────────────────────────────────────────────────────────────────
//
// A drive is a `verify*` script: the thing that proves a change end to end,
// where a suite only proves one package. They are found wherever they are
// declared — an app at the root of the workspace has them too — and the script
// body is carried, because it names the harness file to read when one fails.

const drives = driveRows

// ─── ports ────────────────────────────────────────────────────────────────────
//
// Derived from the registry rather than listed: a project id IS its ports, and
// the pair printed beside the formula is what stops the next app choosing a
// number somebody already has.

function ports() {
  const rows = Object.entries(PROJECTS)
    .map(([name, id]) => ({
      name,
      id,
      fe: ENV.dev * 1000 + CAT.fe * 100 + id * 10,
      be: ENV.dev * 1000 + CAT.be * 100 + id * 10,
    }))
    .sort((a, b) => a.id - b.id)

  return { rows, global: Object.entries(GLOBAL).map(([name, port]) => ({ name, port })).sort(byName) }
}

// ─── issues ───────────────────────────────────────────────────────────────────
//
// The open register, by severity. Only the sections above § Closed are read —
// a closed row is history, and the register's own rule is that an id resolves in
// exactly one place.
//
// The title is the first bold run, which is how every row is written: a claim in
// bold, then the measurement. The rest is deliberately dropped; this is an index
// pointing at ISSUES.md, not a copy of it.
//
// A settled row keeps its place and is rewritten AROUND its answer — the claim
// struck through, the ruling bold after it — so the first bold run of a ruled
// decision is the answer that lost, and reading it whole publishes a retired
// name as a live question.

function issues(root) {
  const file = join(root, 'ISSUES.md')
  if (!existsSync(file)) return null

  const src = read(file)
  if (!src) return null

  const rows   = []
  let section  = null
  let closed   = 0

  for (const line of src.split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) { section = heading[1]; continue }
    // A row may lead with its own link anchor — `| <a id="fjs-282"></a>FJS-282 |`
    // — which half the register does so a ruling can cite a row by id. Matching
    // on a bare `| FJS-` skipped every one of them, and the miss is invisible:
    // the page renders a smaller register rather than an error.
    if (!/^\|\s*(<a\s[^>]*>\s*<\/a>\s*)?`?FJS-/.test(line)) continue

    const cells = splitRow(line)
    if (cells.length < 4) continue

    const id = cells[0].replace(/<a\s[^>]*>\s*<\/a>/g, '').replace(/`/g, '').trim()
    if (/^Closed/i.test(section ?? '')) { closed++; continue }

    // Struck text is what the row no longer claims. A decision table carries no
    // Status column, so the strikethrough — or the ruling that follows it — is
    // the only mark that separates a settled question from an open one.
    const live  = cells[2].replace(/~~[\s\S]*?~~/g, ' ')
    const ruled = live !== cells[2] || /\*\*Ruled\b/i.test(cells[2])

    rows.push({
      id,
      pkg:      plain(cells[1]),
      title:    firstClaim(live.trim() ? live : cells[2]),
      status:   cells.length >= 6 ? plain(cells[3]) : ruled ? 'ruled' : 'needs a ruling',
      verified: cells.length >= 6 ? plain(cells[4]) : '',
      severity: severityOf(section),
      // The Detail column links the evidence, and those links are paths into
      // this tree — the one place the register says WHERE a defect lives.
      files:    linkedFiles(cells[cells.length - 1]),
    })
  }

  const bySeverity = {}
  for (const r of rows) (bySeverity[r.severity] ??= []).push(r)

  const byPackage = {}
  for (const r of rows) byPackage[r.pkg] = (byPackage[r.pkg] ?? 0) + 1

  return {
    file: relative(root, file),
    open: rows.length,
    closed,
    bySeverity,
    byPackage: Object.entries(byPackage).map(([pkg, count]) => ({ pkg, count }))
      .sort((a, b) => b.count - a.count || a.pkg.localeCompare(b.pkg)),
  }
}

/**
 * Repo-relative paths out of a markdown cell's links. A `#fjs-d04` anchor is a
 * cross-reference to another row, an `http` link is somebody else's tree, and a
 * `#L134` fragment is a line inside a file that is still the same file.
 */
function linkedFiles(cell = '') {
  const out = new Set()

  for (const [, target] of cell.matchAll(/\]\(([^)]+)\)/g)) {
    const path = target.split('#')[0].trim()
    if (!path || /^[a-z]+:/i.test(path)) continue
    out.add(path)
  }

  return [...out].sort()
}

function severityOf(section = '') {
  const m = section.match(/^(S[1-4])/)
  if (m) return m[1]
  if (/decision/i.test(section)) return 'decision'
  return 'other'
}

/**
 * A row's cells. A prose cell carrying a `|` inside code over-splits and shifts every
 * column right of it — `docker save | docker load` put half a paragraph in the effort
 * column — so the surplus is folded back into the prose cell. The tail columns are
 * short and fixed, which is what makes counting from the end safe.
 */
function splitRow(line, want = 6, foldAt = 2) {
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
  if (cells.length <= want) return cells
  const tail = want - foldAt - 1
  return [
    ...cells.slice(0, foldAt),
    cells.slice(foldAt, cells.length - tail).join(' | '),
    ...cells.slice(-tail),
  ]
}

// ─── commands ─────────────────────────────────────────────────────────────────
//
// A namespace is a directory and a command is a file, so the count IS the tree.

function commands(root) {
  const dir = join(root, 'packages', 'cli', 'commands')
  if (!existsSync(dir)) return null

  const list = readCommands(dir, root, [])
  if (!list.length) return null

  const counts = {}
  for (const c of list) counts[c.ns] = (counts[c.ns] ?? 0) + 1

  return {
    total: list.length,
    list:  list.sort((a, b) => a.name.localeCompare(b.name)),
    namespaces: Object.entries(counts).map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  }
}

// ─── rulings ──────────────────────────────────────────────────────────────────
//
// `DECISIONS.md` is the settled register: a question is asked in `ISSUES.md`
// with a `FJS-D##`, and the answer comes back here and closes that row. So the
// two are one register read at two moments, and neither is legible without the
// other — which is why both are read.
//
// A ruling is written the way the file's own header says: a date, an optional
// id, and the claim, bolded, leading a paragraph. The claim is quoted whole and
// nothing else about the ruling is read; this is an index into the file.

function decisions(root) {
  const file = join(root, 'DECISIONS.md')
  const src  = read(file)
  if (src === null) return null

  const sections = []
  let section = null

  for (const block of src.split(/\n\s*\n/)) {
    const heading = block.match(/^##\s+(.+?)\s*$/m)
    if (heading && block.trim().startsWith('##')) {
      section = { title: plain(heading[1]), rulings: [] }
      sections.push(section)
      continue
    }
    if (!section) continue

    const led = block.trim().match(/^\*\*(\d{4}-\d{2}-\d{2})\s*·\s*([\s\S]+?)\*\*/)
    if (!led) continue

    section.rulings.push({
      date:  led[1],
      id:    led[2].match(/FJS-D\d+/)?.[0] ?? null,
      claim: firstSentence(plain(led[2].replace(/^`?FJS-D\d+`?\s*[—·-]\s*/, '')), 200),
      section: section.title,
    })
  }

  const kept = sections.filter(s => s.rulings.length)
  return {
    file:  relative(root, file),
    count: kept.reduce((n, s) => n + s.rulings.length, 0),
    sections: kept,
  }
}

// ─── ideas ────────────────────────────────────────────────────────────────────
//
// `IDEAS/` is the third register and the only one about work NOT started. Its
// `overview.md` says of itself that it is derived and that the source file wins
// where they disagree — so both are read: the ranked rows for the shape of the
// backlog, and every paper's own opening claim, because the paper is the thing
// that is authoritative.
//
// A row's Status is the column that matters and it is written for people:
// `**defect**`, `~~shipped~~`, `` `contested` — see ISSUES.md ``. It is
// normalised to one word so it can be a facet, and the cell is kept whole
// beside it so nothing is lost to the normalisation.

function ideas(root) {
  const dir = join(root, 'IDEAS')
  if (!existsSync(dir)) return null

  // A paper's own claim is its H1, not its opening paragraph — every one of them
  // opens on the same `**Status: …** Dated …` boilerplate, so the generic reader
  // has all 39 introducing themselves identically. The status header is read
  // separately, because it is the thing that goes stale (`state-machines.md`
  // said IDEA for two days after it shipped).
  const papers = []
  for (const name of safeRead(dir)) {
    if (!name.endsWith('.md') || name === 'overview.md') continue
    const src = read(join(dir, name))
    if (src === null) continue

    const h1 = src.match(/^#\s+(.+?)\s*$/m)?.[1] ?? name.replace(/\.md$/, '')
    papers.push({
      file:   `IDEAS/${name}`,
      title:  plain(h1).replace(/^Idea\s*[—:-]\s*/i, ''),
      // Up to the first full stop: the rest of the header is `Nothing here is
      // built` on all 39 of them, but `SHIPPED, with a remainder` is the claim.
      status: plain(src.match(/\*\*Status:\s*([^*]+?)\*\*/)?.[1] ?? '').split('. ')[0].replace(/\.$/, ''),
    })
  }

  const waves = []
  const src = read(join(dir, 'overview.md'))

  if (src !== null) {
    let wave = null
    for (const line of src.split('\n')) {
      const heading = line.match(/^##\s+(Wave\s+\S+)\s*[—-]\s*(.+?)\s*$/)
      if (heading) { wave = { title: heading[1], blurb: heading[2], rows: [] }; waves.push(wave); continue }
      if (line.startsWith('## ')) { wave = null; continue }
      if (!wave || !/^\|\s*\d/.test(line)) continue

      const cells = splitRow(line, 8, 1)
      if (cells.length < 8) continue

      wave.rows.push({
        n:      cells[0],
        title:  firstClaim(cells[1]),
        effort: plain(cells[2]),
        payoff: (cells[3].match(/●/g) ?? []).length,
        edge:   plain(cells[4]),
        realms: plain(cells[5]),
        status: statusOf(cells[6]),
        note:   plain(cells[6]),
        // The cell is a filename and sometimes a section number after it —
        // `` `framework-shape.md` 4 `` — and only the file is a link.
        source: cells[7].match(/[\w.-]+\.md/)?.[0] ?? null,
      })
    }
  }

  const byStatus = {}
  for (const w of waves) for (const r of w.rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1

  return {
    file:  'IDEAS/overview.md',
    count: waves.reduce((n, w) => n + w.rows.length, 0),
    waves,
    papers: papers.sort(byFile),
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
  }
}

// A strikethrough means landed, and so do three words the column uses without
// one. `other` is left as a real answer rather than folded into `idea`: a row
// whose status this cannot read is a row somebody should look at.
const STATUS = {
  idea: 'idea', partial: 'partial', defect: 'defect', contested: 'contested',
  shipped: 'shipped', built: 'shipped', 'part-shipped': 'partial',
}

function statusOf(cell = '') {
  if (/~~/.test(cell)) return 'shipped'
  return STATUS[plain(cell).match(/[a-z-]+/i)?.[0]?.toLowerCase()] ?? 'other'
}

// ─── registers ────────────────────────────────────────────────────────────────
//
// The markdown files at the root, each with the first thing it says about
// itself — the bold claim these files open with. What makes the set navigable is
// that each holds one kind of statement, and the only way to show that without
// asserting it is to quote them.

function registers(root) {
  const out = []
  for (const name of safeRead(root)) {
    if (!name.endsWith('.md') || name.includes('.snapshot.')) continue
    const src = read(join(root, name))
    if (src === null) continue
    out.push({ file: name, claim: openingClaim(src) })
  }
  return out.sort(byFile)
}

/**
 * What a register says about itself, in its own words.
 *
 * The house convention is to bold the claim, but not every register does — and
 * a bold run further down the file is some SECTION's claim, not the file's:
 * asking for the first one anywhere had `DECISIONS.md` introducing itself as
 * *Outpost*, which is the first ruling's subject rather than the file's
 * business. So the opening paragraph is found first, and the bold only counts
 * where it leads that paragraph.
 */
const NOT_PROSE = /^(#|\||>|<!--|```|-{3,}$|\*{3,}$|_{3,}$)/

function openingClaim(src) {
  const para = []

  for (const line of src.split('\n')) {
    const text = line.trim()
    if (!text) { if (para.length) break; continue }
    // A quote is somebody else's sentence — `HANDOFF.md` opens on the last
    // session's summary — and a rule is not a sentence at all.
    if (!para.length && NOT_PROSE.test(text)) continue
    if (para.length && NOT_PROSE.test(text)) break
    para.push(text)
  }

  if (!para.length) return ''

  const opening = para.join(' ')
  const bold    = opening.match(/^\*\*(.+?)\*\*/)
  return firstSentence(plain(bold ? bold[1] : opening), 150)
}

// ─── text ─────────────────────────────────────────────────────────────────────

/** Markdown to plain text — links to their label, emphasis and code marks away. */
function plain(md = '') {
  return md
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The bold run a register row opens with, which is the claim; the rest is evidence. */
function firstClaim(cell = '') {
  const bold = cell.match(/\*\*([\s\S]+?)\*\*/)
  return firstSentence(plain(bold ? bold[1] : cell), 190)
}

function firstSentence(text, max) {
  const stop = text.search(/\.\s|\.$/)
  const one  = stop > 30 ? text.slice(0, stop + 1) : text
  if (one.length <= max) return one
  return one.slice(0, one.lastIndexOf(' ', max) > 0 ? one.lastIndexOf(' ', max) : max).trim() + '…'
}

function kebab(s) { return s.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase() }

// ─── the tree ─────────────────────────────────────────────────────────────────

function read(path)    { try { return readFileSync(path, 'utf8') } catch { return null } }

function byName(a, b) { return a.name.localeCompare(b.name) }
function byFile(a, b) { return a.file.localeCompare(b.file) }

// ═══ rendering ════════════════════════════════════════════════════════════════
//
// One self-contained HTML file — no stylesheet, no script, no font to fetch,
// because the thing it is most often opened from is a `file://` path with no
// server in front of it.

export function renderHtml(model) {
  const parts = [
    '<!doctype html>',
    // The machine half: a snapshot names the command that regenerates it, and
    // the walker reads this out of the first 4KB. It sits BELOW the doctype —
    // anything above one puts the browser in quirks mode.
    '<!-- generated by: fli ws:map -->',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(model.root)} — repo map</title>`,
    `<style>${STYLE}</style>`,
    '</head><body>',
    bar(model),
    '<div class="wrap">',
    masthead(model),
    runSection(model),
    snapshotSection(model),
    ciSection(model),
    issueSection(model),
    packageSection(model),
    driveSection(model),
    portSection(model),
    commandSection(model),
    registerSection(model),
    footer(),
    '</div>',
    `<script>${SCRIPT}</script>`,
    '</body></html>',
    '',
  ]
  return parts.filter(Boolean).join('\n')
}

export function renderJson(model) {
  return JSON.stringify(model, null, 2) + '\n'
}

// ─── page parts ───────────────────────────────────────────────────────────────

function bar(model) {
  const links = [
    ['run', model.scripts.length],
    ['snapshots', model.snapshots.length],
    ['ci', model.ci?.phases.length],
    ['issues', model.issues?.open],
    ['packages', model.packages.length],
    ['drives', model.drives.length],
    ['ports', model.ports.rows.length],
    ['commands', model.commands?.total],
    ['registers', model.registers.length],
  ].filter(([, n]) => n)

  return `<div class="bar"><div class="bar-inner"><nav class="nav">${
    links.map(([id]) => `<a href="#${id}">${id}</a>`).join('')
  }</nav><input id="filter" type="search" placeholder="filter rows…" aria-label="Filter every row on this page"><span id="hits" aria-live="polite"></span></div></div>`
}

function masthead(model) {
  const counters = [
    [model.packages.filter(p => !p.claimed).length, 'packages'],
    [model.snapshots.length, 'snapshots'],
    [model.ci?.phases.length, 'ci phases'],
    [model.drives.length, 'drives'],
    [model.issues?.open, 'open issues'],
    [model.commands?.total, 'commands'],
  ].filter(([n]) => n)

  return `<header class="masthead">
  <div class="kicker">${esc(model.root)} · generated by fli ws:map</div>
  <h1>Repo map</h1>
  <p class="lede">Every row on this page was read out of the tree it describes — the snapshot walker, <code>main()</code> in the CI script, each package.json, the port registry, and the open register. Regenerate it rather than editing it.</p>
  <div class="counters">${counters.map(([n, label]) =>
    `<div class="counter"><b>${n}</b><span>${esc(label)}</span></div>`).join('')}</div>
</header>`
}

function runSection(model) {
  if (!model.scripts.length) return ''
  return section('run', 'Run it', 'scripts declared at the workspace root',
    `<p class="note">Everything else runs from inside its own package — a wrong runner produces failures that belong to nothing. A snapshot generator runs from the snapshot's own directory.</p>` +
    `<div class="cards">${model.scripts.map(s => `<div class="card" data-row>
      <div class="cmd">bun run ${esc(s.name)}</div>
      <p>${esc(s.run)}</p>
    </div>`).join('')}</div>`)
}

function snapshotSection(model) {
  if (!model.snapshots.length) return ''
  const rows = model.snapshots.map(s => `<tr data-row>
    <td><span class="chip c-${s.realm}">${s.realm}</span></td>
    <td class="path">${esc(s.file)}</td>
    <td class="m">${s.generator ? `cd ${esc(s.dir)} &amp;&amp; bunx ${esc(s.generator)}` : '<span class="chip c-stop">no generator</span>'}</td>
  </tr>`).join('')

  return section('snapshots', 'Snapshots', `${model.snapshots.length} committed · discovered, never listed`,
    `<p class="note">A generated artefact committed beside its source, so a change nothing else can see arrives as a diff. Each names the command that wrote it; that command is rerun with <code>--check</code> from the file's own directory. To regenerate one, run the command below <strong>without</strong> <code>--check</code> and read the diff.</p>` +
    table(['Realm', 'Snapshot', 'Regenerate'], rows))
}

function ciSection(model) {
  if (!model.ci) return ''
  const rows = model.ci.phases.map((p, i) => `<div class="phase" data-row>
    <div class="ord">${String(i + 1).padStart(2, '0')}</div>
    <div>
      <div class="phase-name"><b>${esc(p.label)}</b><span class="chip ${p.tier === 'fast' ? 'c-ok' : 'c-warn'}">${esc(p.tier)}</span></div>
      ${p.note ? `<p>${esc(p.note)}</p>` : ''}
    </div>
  </div>`).join('')

  return section('ci', 'CI phases', esc(model.ci.file),
    `<p class="note">In call order, read out of <code>main()</code>. A <span class="chip c-ok">fast</span> phase also runs on <code>--fast</code> and in the pre-push hook; the rest only on a full run.</p>` +
    `<div class="panel phases">${rows}</div>`)
}

function issueSection(model) {
  if (!model.issues) return ''
  const order = ['S1', 'S2', 'S3', 'S4', 'decision', 'other']
  const blocks = order.filter(s => model.issues.bySeverity[s]?.length).map(sev => {
    const rows = model.issues.bySeverity[sev].map(r => `<tr data-row>
      <td class="m">${esc(r.id)}</td>
      <td class="m sub">${esc(r.pkg)}</td>
      <td>${esc(r.title)}</td>
      <td class="m sub">${esc(r.status)}</td>
      <td class="m sub">${esc(r.verified)}</td>
    </tr>`).join('')
    return `<h3 class="sev">${esc(label(sev))} <span class="count">${model.issues.bySeverity[sev].length}</span></h3>` +
      table(['Id', 'Pkg', 'Claim', 'Status', 'Verified'], rows)
  }).join('')

  const spread = model.issues.byPackage.map(p =>
    `<span class="tally" data-row><b>${esc(p.pkg)}</b>${p.count}</span>`).join('')

  return section('issues', 'Open register', `${model.issues.open} open · ${model.issues.closed} closed in ${esc(model.issues.file)}`,
    `<p class="note">The claim only — each row's evidence, dates and links stay in <code>${esc(model.issues.file)}</code>. A <code>stale?</code> status is a lead, not a fact.</p>` +
    `<div class="tallies">${spread}</div>` + blocks)
}

function label(sev) {
  return { S1: 'S1 — blockers', S2: 'S2 — high', S3: 'S3 — medium', S4: 'S4 — low', decision: 'Needs a decision', other: 'Other' }[sev] ?? sev
}

function packageSection(model) {
  if (!model.packages.length) return ''
  const rows = model.packages.map(p => p.claimed
    ? `<tr data-row>
        <td class="m">${esc(p.folder)}</td>
        <td><span class="chip c-warn">claimed</span></td>
        <td class="sub" colspan="2">No package.json — does not install, test, or count as a workspace member</td>
      </tr>`
    : `<tr data-row>
        <td class="m">${esc(p.name)}</td>
        <td class="m sub">${p.private ? '<span class="chip c-tool">private</span>' : esc(p.version ?? '')}</td>
        <td class="m sub">${p.deps.length ? p.deps.map(d => esc(d.replace(/^@[^/]+\//, ''))).join(' · ') : '<i>leaf</i>'}</td>
        <td class="m sub">${p.test ? `${p.manager} run test` : '<span class="chip c-stop">no test script</span>'}</td>
      </tr>`).join('')

  return section('packages', 'Packages', 'a member is a directory with a package.json',
    `<p class="note">Depends-on lists workspace siblings only, which is the dependency direction drawn from the files rather than asserted.</p>` +
    table(['Package', 'Version', 'Depends on', 'Test'], rows))
}

function driveSection(model) {
  if (!model.drives.length) return ''
  const rows = model.drives.map(d => `<tr data-row>
    <td class="m">${esc(d.where)}</td>
    <td class="m">${esc(d.script)}</td>
    <td class="m sub">${esc(d.run)}</td>
  </tr>`).join('')

  return section('drives', 'Drives', 'a suite proves a package; a drive proves the seams',
    `<p class="note">Run from the directory in the first column. Several need servers started by hand and exit 1 naming the missing process — and a dev server serves the code it started with, so restart it after a compiler change.</p>` +
    table(['Where', 'Script', 'What it runs'], rows))
}

function portSection(model) {
  const rows = model.ports.rows.map(p => `<tr data-row>
    <td class="m">${p.id}</td>
    <td class="m">${esc(p.name)}</td>
    <td class="m">${p.fe}</td>
    <td class="m">${p.be}</td>
  </tr>`).join('')

  return section('ports', 'Ports', 'env×1000 + category×100 + project×10 + service',
    `<p class="note">Derived, not chosen — a new app takes the next id. Frontend and backend shown for <code>dev</code>; test is <code>7</code> and prod <code>9</code> in the leading digit. Reserved for global tooling: ${
      model.ports.global.map(g => `<code>${g.port}</code> ${esc(g.name)}`).join(' · ')}.</p>` +
    table(['Id', 'Project', 'dev frontend', 'dev backend'], rows))
}

function commandSection(model) {
  if (!model.commands) return ''
  const rows = model.commands.namespaces.map(n => `<span class="tally" data-row><b>${esc(n.name)}</b>${n.count}</span>`).join('')
  return section('commands', 'Command namespaces', `${model.commands.total} invokable commands`,
    `<p class="note">A command is a markdown file compiled to JavaScript, so this count is the tree itself. Namespace modules (<code>_module.md</code>) and step files are not invokable and are not counted.</p><div class="tallies">${rows}</div>`)
}

function registerSection(model) {
  if (!model.registers.length) return ''
  const rows = model.registers.map(r => `<div class="item" data-row><b>${esc(r.file)}</b><p>${esc(r.claim)}</p></div>`).join('')
  return section('registers', 'Which file answers which question', 'each one holds a single kind of statement',
    `<p class="note">Quoted from each file's own opening claim. When you cannot find something, the question to ask is what kind of statement it is.</p>` +
    `<div class="panel list">${rows}</div>`)
}

function footer() {
  return `<footer>Regenerate with <code>fli ws:map</code> · check with <code>fli ws:map --check</code> · data with <code>fli ws:map --json</code>. Nothing here is hand-maintained, so a wrong row is a bug in <code>packages/cli/core/repo-map.js</code>.</footer>`
}

// ─── html helpers ─────────────────────────────────────────────────────────────

function section(id, title, kicker, body) {
  return `<section id="${id}">
  <div class="head"><h2>${esc(title)}</h2><div class="rule"></div><span class="kicker">${kicker}</span></div>
  ${body}
</section>`
}

function table(headers, rows) {
  return `<div class="panel scroll"><table><thead><tr>${
    headers.map(h => `<th>${esc(h)}</th>`).join('')
  }</tr></thead><tbody>${rows}</tbody></table></div>`
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── style ────────────────────────────────────────────────────────────────────
//
// Three theme states, not two: an explicit choice stamps the root element, and
// the default setting stamps nothing — so a colour defined only inside a media
// query renders one theme's text on the other theme's ground.

const STYLE = `
:root{--ground:#EEF1F2;--surface:#fff;--sunk:#E4E8EA;--ink:#12171B;--muted:#5B676F;--faint:#8A959C;--line:#D5DBDE;--line-soft:#E6EAEC;
--data:#245F9E;--data-bg:#E3ECF6;--api:#0B6E5A;--api-bg:#DDEEE9;--ui:#9C3D62;--ui-bg:#F5E3EA;--tool:#5A4E97;--tool-bg:#E8E5F3;
--ok:#226B4C;--ok-bg:#DDEDE4;--warn:#8E6210;--warn-bg:#F4EAD5;--stop:#A63535;--stop-bg:#F6E1E1;
--shadow:0 1px 2px rgba(18,23,27,.06),0 8px 24px -18px rgba(18,23,27,.35);
--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0E1216;--surface:#161B21;--sunk:#1B2229;--ink:#E2E8EC;--muted:#939FA7;--faint:#6E7A82;--line:#2A333B;--line-soft:#212930;
--data:#7FB2E8;--data-bg:#17293C;--api:#57C3A8;--api-bg:#12302A;--ui:#E48CAC;--ui-bg:#38202A;--tool:#A79AE4;--tool-bg:#262244;
--ok:#5CC08D;--ok-bg:#14301F;--warn:#DCAE55;--warn-bg:#34290F;--stop:#E8807F;--stop-bg:#391B1B;
--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -20px rgba(0,0,0,.8)}}
:root[data-theme="dark"]{--ground:#0E1216;--surface:#161B21;--sunk:#1B2229;--ink:#E2E8EC;--muted:#939FA7;--faint:#6E7A82;--line:#2A333B;--line-soft:#212930;
--data:#7FB2E8;--data-bg:#17293C;--api:#57C3A8;--api-bg:#12302A;--ui:#E48CAC;--ui-bg:#38202A;--tool:#A79AE4;--tool-bg:#262244;
--ok:#5CC08D;--ok-bg:#14301F;--warn:#DCAE55;--warn-bg:#34290F;--stop:#E8807F;--stop-bg:#391B1B;
--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px -20px rgba(0,0,0,.8)}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px 96px}
h1,h2,h3{margin:0;font-weight:640;letter-spacing:-.015em;text-wrap:balance}
h1{font-size:clamp(28px,4.4vw,42px);letter-spacing:-.03em}
h2{font-size:21px}
p{margin:0}
code{font-family:var(--mono);font-size:.86em}
:focus-visible{outline:2px solid var(--data);outline-offset:2px;border-radius:3px}
.masthead{padding:44px 0 26px;display:flex;flex-direction:column;gap:14px}
.kicker{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--faint)}
.lede{color:var(--muted);max-width:64ch;font-size:16px}
.counters{display:flex;flex-wrap:wrap;gap:10px;margin-top:6px}
.counter{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 13px;display:flex;align-items:baseline;gap:8px}
.counter b{font-size:19px;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.counter span{font-family:var(--mono);font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.09em}
.bar{position:sticky;top:0;z-index:20;background:var(--ground);border-bottom:1px solid var(--line)}
.bar-inner{max-width:1120px;margin:0 auto;padding:9px 24px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.nav{display:flex;gap:3px;flex-wrap:wrap;flex:1 1 auto}
.nav a{font-family:var(--mono);font-size:11.5px;color:var(--muted);text-decoration:none;padding:4px 8px;border-radius:5px;white-space:nowrap}
.nav a:hover{background:var(--sunk);color:var(--ink)}
#filter{font-family:var(--mono);font-size:12.5px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:6px 10px;width:210px}
#filter::placeholder{color:var(--faint)}
#hits{font-family:var(--mono);font-size:11px;color:var(--faint);min-width:72px}
section{margin-top:52px;scroll-margin-top:60px}
.head{display:flex;align-items:baseline;gap:12px;margin-bottom:6px;flex-wrap:wrap}
.rule{flex:1 1 40px;height:1px;background:var(--line)}
.note{color:var(--muted);font-size:14px;max-width:70ch;margin-bottom:18px}
.note strong{font-weight:620;color:var(--ink)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow);overflow:hidden;margin-bottom:14px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 15px;display:flex;flex-direction:column;gap:8px;box-shadow:var(--shadow)}
.cmd{font-family:var(--mono);font-size:13px;background:var(--sunk);border-radius:6px;padding:8px 10px;overflow-x:auto;white-space:pre;border:1px solid var(--line-soft)}
.card p{font-family:var(--mono);font-size:11.5px;color:var(--muted);overflow-wrap:anywhere}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:13.5px}
th{text-align:left;font-family:var(--mono);font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--faint);padding:10px 14px;border-bottom:1px solid var(--line);white-space:nowrap;background:var(--surface)}
td{padding:10px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tr:last-child td{border-bottom:0}
tbody tr:hover td{background:var(--sunk)}
td.m,th.m{font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums}
td.sub{color:var(--muted)}
.path{font-family:var(--mono);font-size:12px}
.chip{font-family:var(--mono);font-size:10px;text-transform:uppercase;letter-spacing:.08em;padding:2px 6px;border-radius:4px;white-space:nowrap;display:inline-block}
.c-data{background:var(--data-bg);color:var(--data)}
.c-api{background:var(--api-bg);color:var(--api)}
.c-ui{background:var(--ui-bg);color:var(--ui)}
.c-repo,.c-tool{background:var(--tool-bg);color:var(--tool)}
.c-ok{background:var(--ok-bg);color:var(--ok)}
.c-warn{background:var(--warn-bg);color:var(--warn)}
.c-stop{background:var(--stop-bg);color:var(--stop)}
.phases{display:flex;flex-direction:column}
.phase{display:grid;grid-template-columns:46px 1fr;gap:14px;padding:13px 16px;border-bottom:1px solid var(--line-soft);align-items:start}
.phase:last-child{border-bottom:0}
.ord{font-family:var(--mono);font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;padding-top:2px}
.phase-name{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap}
.phase-name b{font-family:var(--mono);font-size:13.5px;font-weight:640}
.phase p{font-size:13.5px;color:var(--muted);margin-top:3px;max-width:76ch}
.sev{font-size:13px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:22px 0 8px;display:flex;gap:8px;align-items:baseline}
.sev .count{font-variant-numeric:tabular-nums;color:var(--faint)}
.tallies{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:16px}
.tally{font-family:var(--mono);font-size:11.5px;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:4px 9px;display:flex;gap:7px;align-items:baseline;color:var(--muted)}
.tally b{color:var(--ink);font-weight:600}
.list{display:flex;flex-direction:column}
.item{padding:11px 15px;border-bottom:1px solid var(--line-soft)}
.item:last-child{border-bottom:0}
.item b{font-family:var(--mono);font-size:12.5px;font-weight:620}
.item p{font-size:13px;color:var(--muted);margin-top:2px}
.hidden{display:none!important}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
@media (max-width:620px){.wrap{padding:0 16px 72px}.bar-inner{padding:8px 16px}#filter{width:100%}}
`

// One interaction, because a page nobody can search is a page nobody reads
// twice. A section whose rows all hide keeps its heading, so a dead-end search
// still says where it looked.
const SCRIPT = `
const box=document.getElementById('filter'),hits=document.getElementById('hits')
const rows=[...document.querySelectorAll('[data-row]')]
function apply(){
  const q=box.value.trim().toLowerCase()
  let n=0
  for(const r of rows){const hit=q===''||r.textContent.toLowerCase().includes(q);r.classList.toggle('hidden',!hit);if(hit)n++}
  hits.textContent=q===''?rows.length+' rows':n+' / '+rows.length
}
box.addEventListener('input',apply)
box.addEventListener('keydown',e=>{if(e.key==='Escape'){box.value='';apply()}})
apply()
`
