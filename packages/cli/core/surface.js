// ─── surface.js — what each package exports, and what anyone outside reaches ──
//
// `exports.snapshot.md` answers what a package SHIPS. Nothing answered whether
// anything NEEDS it: a battery written for the day an app wants it, a helper
// exported so a test could reach it, a type nobody imports. Each is cheap to
// add and free to keep, so the count only ever grows, and a surface that grows
// without a caller is the over-engineering the batteries-vs-smallness
// adjudication is about — measurable, and measured nowhere before this.
//
// ── Two questions, both decidable from the tree ─────────────────────────────
//
// 1. An ENTRY POINT nobody imports: an `exports` subpath no file outside the
//    package resolves to, through `importGraph` — a statement, never a string
//    that looks like a path.
// 2. A NAME nobody reaches: an exported binding whose identifier appears in no
//    source file outside its package. Read as a token, so a mention in a type
//    position, a destructure or a property counts — the question is *does the
//    name exist anywhere else*, and a token is the loosest honest answer.
//
// ── Biased toward "live" ────────────────────────────────────────────────────
//
// A common word (`run`, `log`) is reached by any file that uses the word; this
// never calls a reached name dead, and may call a dead name reached. A name is
// EMITTED when no file outside names it but a string the package writes out
// does — the mesa compiler emits `$$runtime.bindClass(` into compiled output
// that lives in no source file, so its runtime exports would read as dead.
// Emitted is reported apart, never as unreached.
//
// A `.d.ts` is not a caller — `db/schema.d.ts` is generated and names what the
// generator knows, not what the app reached for. Comments are blanked first:
// a doc block quoting an export is prose.
//
// ── What the snapshot records ───────────────────────────────────────────────
//
// Only the crossings: entries with no importer and names with no reach. An
// importer COUNT would move on every unrelated import and keep the `snapshots`
// phase red for nobody's change; whether a thing has one is the fact that
// matters, and it moves only when a surface gains an unreached export or loses
// its last caller — which is the diff a reviewer should see.
//
// Zero dependencies, plain ESM, node or bun — the rule `seams.js` and
// `snapshots.js` follow.

import { readdirSync, existsSync }              from 'node:fs'
import { join, posix }                           from 'node:path'
import { read }                                     from './fs.js'

import { stripComments, importGraph, packageIndex } from './codegraph.js'
import { treePaths }                                from './tree.js'


/** A file that can hold an import or a reference. `.lite`, `.css`, `.md` cannot. */
export const SOURCE = /\.(?:[cm]?[jt]sx?|mesa)$/
const DECL      = /\.d\.[cm]?ts$/
const SNAPSHOT  = /\.snapshot\.[^./]+$/
const SKIPDIR   = new Set(['node_modules', '.bun', '.git'])
const IDENT     = /[A-Za-z_$][\w$]*/g
const EXT_TRY   = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js', '/index.mjs']

// ─── the files ───────────────────────────────────────────────────────────────

function walk(dir, rel = '', out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (SKIPDIR.has(e.name)) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) walk(join(dir, e.name), r, out)
    else out.push(r)
  }
  return out
}

/** What a clone holds, else the disk; posix-relative, sorted. */
export function sourceFiles(root) {
  const tree = treePaths(root)
  const all  = tree ? [...tree.files] : walk(root)
  return all
    .filter(p => SOURCE.test(p) && !DECL.test(p) && !SNAPSHOT.test(p))
    .filter(p => !p.split('/').some(seg => SKIPDIR.has(seg)))
    .sort()
}

const tokensOf = text => new Set(text.match(IDENT) ?? [])

const ISTEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/**
 * Every string literal's contents, joined — where an emitter names what it
 * writes. Scanned with `stripComments`'s quote rules rather than a regex: a
 * backtick inside a regex literal pairs with the next one by regex and swallows
 * the code between, which read half of junction as emitted.
 */
export function stringLiterals(text) {
  const out = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    // A regex literal's quote or backtick is not a string's. A slash after an
    // operator or an opener starts one; after a value it divides.
    if (c === '/') {
      let k = i - 1
      while (k >= 0 && /\s/.test(text[k])) k--
      const before = text.slice(Math.max(0, k - 6), k + 1)
      if (k < 0 || /[(,=:[!&|?{};+\-*%<>~^]$/.test(text[k]) || /\b(?:return|typeof|case|in|of)$/.test(before)) {
        let j = i + 1, inClass = false
        while (j < text.length && text[j] !== '\n') {
          if (text[j] === '\\') { j += 2; continue }
          if (text[j] === '[') inClass = true
          else if (text[j] === ']') inClass = false
          else if (text[j] === '/' && !inClass) break
          j++
        }
        i = j + 1
        continue
      }
      i++
      continue
    }
    if (c !== '"' && c !== "'" && c !== '`') { i++; continue }
    let j = i + 1
    while (j < text.length && text[j] !== c) {
      if (text[j] === '\\') j++
      else if (c !== '`' && text[j] === '\n') break
      j++
    }
    out.push(text.slice(i + 1, j))
    i = j + 1
  }
  return out.join('\n')
}

// ─── the exported names ──────────────────────────────────────────────────────

const NAME = '[A-Za-z_$][\\w$]*'
const DECLARED = new RegExp(
  `^\\s*export\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(function\\*?|const|let|var|class|type|interface|enum)\\s+(${NAME})`, 'gm')
const DEFAULT  = /^\s*export\s+default\b/m
const BRACES   = /^\s*export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm
const STAR_AS  = new RegExp(`^\\s*export\\s+\\*\\s+as\\s+(${NAME})\\s+from`, 'gm')
const STAR     = /^\s*export\s+\*\s+from\s*['"]([^'"]+)['"]/gm

/**
 * The names a module exports, re-exports followed. `text` is comment-stripped
 * source; `resolve(spec)` answers a relative specifier with the path of the
 * module it names and its text, or null. `kind` is `type` for a type-only
 * export and `value` otherwise.
 */
export function exportedNames(path, text, resolve, seen = new Set()) {
  if (seen.has(path)) return []
  seen.add(path)
  const out = new Map()
  const add = (name, kind) => { if (!out.has(name) || kind === 'value') out.set(name, kind) }

  for (const m of text.matchAll(DECLARED)) add(m[2], m[1] === 'type' || m[1] === 'interface' ? 'type' : 'value')
  if (DEFAULT.test(text)) add('default', 'value')
  for (const m of text.matchAll(STAR_AS)) add(m[1], 'value')
  for (const m of text.matchAll(BRACES)) {
    const allTypes = Boolean(m[1])
    for (const raw of m[2].split(',')) {
      let item = raw.trim()
      if (!item) continue
      const typed = allTypes || item.startsWith('type ')
      item = item.replace(/^type\s+/, '')
      const as = item.split(/\s+as\s+/)
      add((as[1] ?? as[0]).trim(), typed ? 'type' : 'value')
    }
  }
  for (const m of text.matchAll(STAR)) {
    const hit = resolve(path, m[1])
    if (hit) for (const n of exportedNames(hit.path, hit.text, resolve, seen)) add(n.name, n.kind)
  }
  return [...out].map(([name, kind]) => ({ name, kind }))
}

// ─── the entry points ────────────────────────────────────────────────────────

const norm = p => String(p).replace(/^\.\//, '')

/** Every `exports` subpath with its targets, all conditions; `main` when there is no map. */
export function entryPoints(pkg) {
  const out = []
  const push = (key, target) => {
    if (typeof target === 'string') { out.push({ key, file: norm(target) }); return }
    if (Array.isArray(target))        { for (const t of target) push(key, t); return }
    if (target && typeof target === 'object') for (const v of Object.values(target)) push(key, v)
  }
  if (pkg.exports) {
    if (typeof pkg.exports === 'string' || Array.isArray(pkg.exports)) push('.', pkg.exports)
    else {
      const keys = Object.keys(pkg.exports)
      if (keys.length && !keys[0].startsWith('.')) push('.', pkg.exports)
      else for (const [k, v] of Object.entries(pkg.exports)) push(k, v)
    }
  } else if (pkg.main) push('.', pkg.main)
  // one row per (key, file) — a condition map naming one file twice is one entry
  const seen = new Set()
  return out.filter(e => { const k = `${e.key}\0${e.file}`; if (seen.has(k)) return false; seen.add(k); return true })
}

const patternRx = file =>
  new RegExp('^' + file.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')

// ─── collect ─────────────────────────────────────────────────────────────────

/**
 *   collectSurface({ root, packages })
 *     → { files, packages: [{ name, folder, entries, names, totals }] }
 *
 * `packages` is `wsPackages()`'s list — `{ folder, pkg }` each, `packages/<folder>`
 * at the root. `files` may be handed in (a test's fixture); else the tree's.
 */
export function collectSurface({ root, packages, files = sourceFiles(root) }) {
  const texts = new Map()
  for (const p of files) {
    const t = read(join(root, p))
    if (t !== null) texts.set(p, stripComments(t))
  }
  const tokens  = new Map([...texts].map(([p, t]) => [p, tokensOf(t)]))
  const regionOf = p => { const m = p.match(/^packages\/([^/]+)\//); return m ? m[1] : null }

  const manifests = packages.map(({ folder, pkg }) => ({ path: `packages/${folder}/package.json`, json: pkg }))
  const graph     = importGraph(texts, { isFile: p => texts.has(p), packages: packageIndex(manifests) })

  const resolveRel = (from, spec) => {
    const base = posix.normalize(posix.join(posix.dirname(from), spec))
    const hit  = EXT_TRY.map(e => base + e).find(p => texts.has(p))
    return hit ? { path: hit, text: texts.get(hit) } : null
  }

  const out = []
  for (const { folder, pkg } of [...packages].sort((a, b) => a.folder.localeCompare(b.folder))) {
    const inside  = p => regionOf(p) === folder
    const outside = [...texts.keys()].filter(p => !inside(p))
    // A suite's strings describe; only what the package itself runs can emit.
    const ownStrings = [...texts].filter(([p]) => inside(p) && !ISTEST.test(p)).map(([, t]) => stringLiterals(t)).join('\n')
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const inOwnStrings = s => new RegExp(`(?<![\\w$])${esc(s)}(?![\\w$])`).test(ownStrings)
    // A name is emitted when the string is CODE naming it — a call, a member, an
    // import clause. An error message that mentions the function is prose.
    const emitsName = n => new RegExp(`\\.${esc(n)}(?![\\w$])|(?<![\\w$])${esc(n)}\\s*\\(|\\{[^}\\n]*(?<![\\w$])${esc(n)}(?![\\w$])[^}\\n]*\\}`).test(ownStrings)

    const entries = []
    const names   = new Map()
    for (const e of entryPoints(pkg)) {
      const file = posix.normalize(posix.join('packages', folder, e.file))
      const pattern = file.includes('*')
      const targets = pattern ? [...texts.keys()].filter(p => inside(p) && patternRx(file).test(p)) : [file]
      const source  = targets.some(t => texts.has(t))
      const importers = source
        ? outside.filter(f => { const edges = graph.get(f); return edges && targets.some(t => edges.has(t)) }).length
        : null
      // sierra's auto-import plugin writes `import { page } from '@frontierjs/sierra'`
      // into every page, so its root entry has no importer in any source file
      const specifier = e.key === '.' ? pkg.name : `${pkg.name}/${e.key.slice(2)}`
      const emitted   = importers === 0 && inOwnStrings(specifier)
      entries.push({ key: e.key, file: e.file, pattern, source, importers, emitted })

      if (pattern || !texts.has(file)) continue
      for (const n of exportedNames(file, texts.get(file), resolveRel)) {
        if (n.name === 'default') continue
        if (!names.has(n.name) || n.kind === 'value') names.set(n.name, { ...n, entry: e.key })
      }
    }

    const graded = [...names.values()].sort((a, b) => a.name.localeCompare(b.name)).map(n => {
      const reached = outside.some(f => tokens.get(f).has(n.name))
      const emitted = !reached && emitsName(n.name)
      return { ...n, reached, emitted }
    })

    const values = graded.filter(n => n.kind === 'value')
    const types  = graded.filter(n => n.kind === 'type')
    out.push({
      name: pkg.name, folder, entries, names: graded,
      totals: {
        entries: entries.length,
        entriesUnimported: entries.filter(e => e.importers === 0 && !e.emitted).length,
        entriesEmitted: entries.filter(e => e.emitted).length,
        value: values.length,
        valueUnreached: values.filter(n => !n.reached && !n.emitted).length,
        emitted: values.filter(n => n.emitted).length,
        type: types.length,
        typeUnreached: types.filter(n => !n.reached && !n.emitted).length,
      },
    })
  }
  return { files: texts.size, packages: out }
}

// ─── outside this repo ───────────────────────────────────────────────────────

/**
 * Which unreached names and unimported entries another tree reaches. `roots`
 * are directories: one holding a `package.json` or `.git` is one tree; any
 * other is a folder of trees, one per child. Terminal only — a runner has none
 * of these, so a snapshot that read them could never be checked.
 */
export function reachOutside({ roots, surface }) {
  const trees = []
  for (const r of roots) {
    if (existsSync(join(r, 'package.json')) || existsSync(join(r, '.git'))) { trees.push(r); continue }
    let kids = []
    try { kids = readdirSync(r, { withFileTypes: true }).filter(d => d.isDirectory() && !SKIPDIR.has(d.name)).map(d => join(r, d.name)) } catch {}
    trees.push(...kids)
  }
  const hits = []
  for (const tree of trees) {
    const files = sourceFiles(tree)
    let tokens = new Set(), raw = ''
    for (const p of files) {
      const t = read(join(tree, p))
      if (t === null) continue
      const s = stripComments(t)
      raw += s + '\n'
      for (const id of s.match(IDENT) ?? []) tokens.add(id)
    }
    for (const pkg of surface.packages) {
      for (const n of pkg.names) if (!n.reached && !n.emitted && tokens.has(n.name)) hits.push({ tree, pkg: pkg.name, kind: 'name', what: n.name })
      for (const e of pkg.entries) {
        if (e.importers !== 0 || e.emitted) continue
        const spec = e.key === '.' ? pkg.name : `${pkg.name}/${e.key.slice(2)}`
        if (raw.includes(`'${spec}'`) || raw.includes(`"${spec}"`)) hits.push({ tree, pkg: pkg.name, kind: 'entry', what: spec })
      }
    }
  }
  return hits
}

// ─── render ──────────────────────────────────────────────────────────────────

const code = names => names.map(n => `\`${n}\``).join(' ')

export function renderSurface({ files, packages }) {
  const sum = key => packages.reduce((a, p) => a + p.totals[key], 0)
  const out = []
  out.push('<!-- generated by: fli ws:surface -->')
  out.push('')
  out.push('# Surface — what each package exports, and what anyone outside it reaches')
  out.push('')
  out.push('Generated by `fli ws:surface`. **Do not edit.**')
  out.push('')
  out.push('`exports.snapshot.md` is what a package SHIPS; this is what is REACHED. Two')
  out.push('questions, both read off the tree: an `exports` entry no file outside the package')
  out.push('imports, and an exported name no file outside the package mentions. A surface')
  out.push('that grows with no caller is cost with no buyer, and this is where it is counted.')
  out.push('')
  out.push('**Unreached is a question, not a verdict.** A name is reached when its identifier')
  out.push('appears in any source file outside its package — the loosest honest reading, so a')
  out.push('common word is never called dead and a dead name may pass as reached. Linked')
  out.push('prototypes outside this repo are not scanned here (`fli ws:surface --also <dir>`')
  out.push('asks them, in the terminal), so a name below may be live there. An error class')
  out.push('exported for `instanceof`, a type a consumer would import, a helper a test reaches')
  out.push('by relative path — each is a reason, and the row is where the reason gets asked for.')
  out.push('')
  out.push('**Emitted** is a name or an entry no outside file mentions but a string the package')
  out.push('itself writes out does — the mesa compiler emits its runtime\'s names into compiled')
  out.push('output no source file holds, and sierra\'s auto-import writes the import of its own')
  out.push('root into every page. Counted apart, never as unreached.')
  out.push('')
  out.push('Only crossings are recorded — no importer, no reach — so the file moves when a')
  out.push('surface gains an unreached export or loses its last caller, and not on every import.')
  out.push('')
  out.push('```')
  out.push(`${packages.length} package(s) · ${files} source file(s) read`)
  out.push(`${sum('entries')} entry point(s), ${sum('entriesUnimported')} imported by nothing outside their package, ${sum('entriesEmitted')} emitted`)
  out.push(`${sum('value')} value export(s), ${sum('valueUnreached')} reached by nothing outside, ${sum('emitted')} emitted`)
  out.push(`${sum('type')} type export(s), ${sum('typeUnreached')} reached by nothing outside`)
  out.push('```')
  out.push('')
  out.push('| Package | Entries | Unimported | Values | Unreached | Emitted | Types | Unreached |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const p of [...packages].sort((a, b) => (b.totals.valueUnreached + b.totals.entriesUnimported) - (a.totals.valueUnreached + a.totals.entriesUnimported) || a.folder.localeCompare(b.folder))) {
    const t = p.totals
    out.push(`| \`${p.folder}\` | ${t.entries} | ${t.entriesUnimported} | ${t.value} | ${t.valueUnreached} | ${t.emitted} | ${t.type} | ${t.typeUnreached} |`)
  }
  out.push('')

  for (const p of packages) {
    const t = p.totals
    out.push(`## \`${p.name}\``)
    out.push('')
    out.push(`\`packages/${p.folder}\` · ${t.entries} entry point(s) · ${t.value} value, ${t.type} type export(s)`)
    out.push('')
    const unimported = p.entries.filter(e => e.importers === 0 && !e.emitted)
    const emittedE   = p.entries.filter(e => e.emitted)
    const unknown    = p.entries.filter(e => e.importers === null)
    if (unimported.length) {
      out.push(`**Entries imported by nothing outside (${unimported.length}):** ${code(unimported.map(e => e.key))}`)
      out.push('')
    }
    if (emittedE.length) {
      out.push(`**Entries emitted (${emittedE.length}):** ${code(emittedE.map(e => e.key))}`)
      out.push('')
    }
    if (unknown.length) {
      out.push(`**Entries not source (${unknown.length}, not graded):** ${code(unknown.map(e => e.key))}`)
      out.push('')
    }
    const dead    = p.names.filter(n => n.kind === 'value' && !n.reached && !n.emitted).map(n => n.name)
    const emitted = p.names.filter(n => n.emitted).map(n => n.name)
    const deadT   = p.names.filter(n => n.kind === 'type' && !n.reached && !n.emitted).map(n => n.name)
    if (dead.length)    { out.push(`**Unreached values (${dead.length}):** ${code(dead)}`);  out.push('') }
    if (emitted.length) { out.push(`**Emitted (${emitted.length}):** ${code(emitted)}`);      out.push('') }
    if (deadT.length)   { out.push(`**Unreached types (${deadT.length}):** ${code(deadT)}`); out.push('') }
    if (!unimported.length && !dead.length && !deadT.length) { out.push('Every entry is imported and every name reached.'); out.push('') }
  }
  return out.join('\n').replace(/\n+$/, '\n')
}
