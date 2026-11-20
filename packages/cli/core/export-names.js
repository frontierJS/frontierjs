// ─── export-names.js — one name, one thing, across packages ──────────────────
//
// Two packages exporting one name for two jobs is how a reader imports the
// wrong one and gets a function with a different signature that still runs
// (`FJS-2966`, `FJS-D1314`). A name counts against the package that DECLARES
// it: junction re-exporting litestone's `parseWhere` is one thing, so a
// re-export is followed to its declaring package before anything is compared.
//
// Read statically, never imported: an entry module may open a database, start
// a timer or need a Mesa compile to load, and a census that runs them sees what
// loaded rather than what is exported. Value exports only — a type and a value
// can never collide in one import list without the compiler saying so.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SOURCE   = /\.(?:m?js|ts)$/
const IDENT    = /^[A-Za-z_$][\w$]*$/
const RELATIVE = /^\.\.?\//

// The import side of a conditional target: `types` names a declaration file,
// which states what the source exports without being it.
const sourceOf = (target) => {
  if (typeof target === 'string') return target
  if (!target || typeof target !== 'object') return null
  for (const key of ['import', 'bun', 'node', 'default']) {
    const hit = sourceOf(target[key])
    if (hit) return hit
  }
  return null
}

// Every source file an `exports` map reaches. A `*` pattern is skipped: it
// stands for a folder of components or stores whose names are their files.
export const entryFiles = (dir, exportsMap) => {
  const out = []
  if (typeof exportsMap === 'string') exportsMap = { '.': exportsMap }
  for (const [key, target] of Object.entries(exportsMap ?? {})) {
    if (!key.startsWith('.') || key.includes('*')) continue
    const file = sourceOf(target)
    if (!file || !SOURCE.test(file) || file.endsWith('.d.ts')) continue
    const abs = resolve(dir, file)
    if (existsSync(abs)) out.push({ subpath: key, file: abs })
  }
  return out
}

const resolveRelative = (from, spec) => {
  const base = resolve(dirname(from), spec)
  const tries = [base, base.replace(/\.js$/, '.ts'), `${base}.js`, `${base}.ts`, `${base}/index.js`, `${base}/index.ts`]
  return tries.find(f => SOURCE.test(f) && existsSync(f)) ?? null
}

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

// `a`, `a as b`, `type T` — the exported spelling and the local one.
const specifiers = (list) => list.split(',')
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('type '))
  .map(s => {
    const [local, exported = local] = s.split(/\s+as\s+/).map(x => x.trim())
    return { local, exported }
  })
  .filter(s => IDENT.test(s.exported) && s.exported !== 'default')

// Every named or default binding the module imports, by local name. A bare
// `export { x }` of one of these is a re-export, however it was spelled: reading
// it as a declaration charged `@frontierjs/toolbelt`'s `humanize` to every
// package that imported it and passed it on. A namespace import is not followed.
const importedBindings = (text) => {
  const bindings = new Map()
  for (const m of text.matchAll(/^import\s+(?!type[\s{])([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    const [, clause, spec] = m
    const named = clause.match(/\{([^}]*)\}/)
    if (named) {
      for (const { local, exported } of specifiers(named[1])) bindings.set(exported, { spec, name: local })
    }
    const head = clause.replace(/\{[^}]*\}/, '').replace(/,/g, ' ').trim()
    if (IDENT.test(head)) bindings.set(head, { spec, name: 'default' })
  }
  return bindings
}

// One module's value exports, each as `{ name, from }`: `from` is null for a
// declaration in this file, otherwise the specifier and the name it had there.
const moduleExports = (src) => {
  const out = []
  const text = stripComments(src)
  const imported = importedBindings(text)

  for (const m of text.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    out.push({ name: m[1], from: null })
  }
  for (const m of text.matchAll(/^export\s+\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm)) {
    for (const { local, exported } of specifiers(m[1])) {
      const via = m[2] ? { spec: m[2], name: local } : imported.get(local) ?? null
      out.push({ name: exported, from: via })
    }
  }
  for (const m of text.matchAll(/^export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/gm)) {
    out.push({ name: m[1], from: null })
  }
  for (const m of text.matchAll(/^export\s+\*\s+from\s*['"]([^'"]+)['"]/gm)) {
    out.push({ name: '*', from: { spec: m[1], name: '*' } })
  }
  return out
}

// The package that declares each value name `file` exports. A bare specifier
// names its declaring package directly; a relative one is followed.
export const declaredNames = (file, owner, seen = new Set()) => {
  const names = new Map()
  if (seen.has(file)) return names
  seen.add(file)

  for (const { name, from } of moduleExports(readFileSync(file, 'utf8'))) {
    if (!from) { names.set(name, owner); continue }

    if (!RELATIVE.test(from.spec)) {
      if (name !== '*') names.set(name, from.spec.split('/').slice(0, from.spec.startsWith('@') ? 2 : 1).join('/'))
      continue
    }

    const next = resolveRelative(file, from.spec)
    if (!next) { if (name !== '*') names.set(name, owner); continue }
    const inner = declaredNames(next, owner, new Set(seen))
    if (name === '*') {
      for (const [n, o] of inner) if (!names.has(n)) names.set(n, o)
    } else {
      names.set(name, inner.get(from.name) ?? owner)
    }
  }
  return names
}

// Every value name two packages each declare: `[{ name, packages: [{ pkg, subpath }] }]`.
export const sharedNames = (packages) => {
  const byName = new Map()
  for (const { pkg, dir } of packages) {
    for (const { subpath, file } of entryFiles(dir, pkg.exports ?? pkg.main)) {
      for (const [name, owner] of declaredNames(file, pkg.name)) {
        if (owner !== pkg.name) continue
        const where = byName.get(name) ?? new Map()
        if (!where.has(pkg.name)) where.set(pkg.name, subpath)
        byName.set(name, where)
      }
    }
  }
  return [...byName]
    .filter(([, where]) => where.size > 1)
    .map(([name, where]) => ({ name, packages: [...where].map(([pkg, subpath]) => ({ pkg, subpath })) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// The ruling that lets two packages keep one name: a `DECISIONS.md` heading
// naming the name in backticks and every package that exports it.
export const rulingFor = (decisions, { name, packages }) => {
  const named = new RegExp('`' + name.replace(/\$/g, '\\$') + '`')
  for (const line of decisions.split('\n')) {
    if (!line.startsWith('### ') || !named.test(line)) continue
    if (!packages.every(({ pkg }) => new RegExp(pkg.replace(/[/@]/g, '\\$&') + '(?![\\w-])').test(line))) continue
    return line.match(/FJS-D\d+/)?.[0] ?? null
  }
  return null
}

// ─── the ratchet (FJS-D2278) ──────────────────────────────────────────────────
//
// The census finds dozens of shared names, mostly deliberate (every connector
// exports the contract's names) and too many to rename in one pass. So the
// committed snapshot section IS the baseline: a name or a package joining a name
// that the section does not list fails unless a ruling lists it, and a name
// that stops being shared just drops out the next time the snapshot is written.

const SECTION_LINE = /^- `([^`]+)` — (.+?)(?: \((FJS-D\d+)\))?$/

export const SECTION_TITLE = '## Duplicate export names'

// One line per shared name, sorted: `- \`name\` — \`pkg:subpath\` · \`pkg:subpath\` (ruling)`.
export const sectionLines = (shared, decisions) => shared.map(s => {
  const where  = s.packages.map(({ pkg, subpath }) => `\`${pkg}:${subpath}\``).join(' · ')
  const ruling = rulingFor(decisions, s)
  return `- \`${s.name}\` — ${where}${ruling ? ` (${ruling})` : ''}`
})

// The committed baseline as `Map<name, Set<pkg>>`, or null when the snapshot has
// no such section yet -- the one time a write may take the current set whole.
export const parseBaseline = (snapshot) => {
  const at = snapshot.indexOf(`\n${SECTION_TITLE}\n`)
  if (at < 0) return null
  const baseline = new Map()
  for (const line of snapshot.slice(at + 1).split('\n').slice(1)) {
    if (line.startsWith('## ')) break
    const m = line.match(SECTION_LINE)
    if (!m) continue
    const pkgs = [...m[2].matchAll(/`([^`:]+):[^`]*`/g)].map(x => x[1])
    baseline.set(m[1], new Set(pkgs))
  }
  return baseline
}

// Every name whose package set grew past the baseline and that no ruling lists:
// `[{ name, packages }]`, `packages` being each package in a new pair. A pair is
// new unless both of its packages were already sharing the name.
export const newDuplicates = (shared, baseline, decisions) => {
  if (!baseline) return []
  const out = []
  for (const s of shared) {
    const before = baseline.get(s.name) ?? new Set()
    const joined = s.packages.filter(({ pkg }) => !before.has(pkg))
    if (!joined.length) continue
    // A newcomer pairs with every package already there; with none there, the
    // whole set is the new pair.
    const involved = before.size && s.packages.some(({ pkg }) => before.has(pkg))
      ? [...joined, ...s.packages.filter(({ pkg }) => before.has(pkg)).slice(0, 1)]
      : s.packages
    const entry = { name: s.name, packages: involved }
    if (!rulingFor(decisions, s) && !rulingFor(decisions, entry)) out.push(entry)
  }
  return out
}
