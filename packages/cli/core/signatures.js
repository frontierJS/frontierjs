// ─── the published surface, as signatures ────────────────────────────────────
//
// `exports.snapshot.md` says which FILES a package ships; this says what an app
// can CALL from them. An agent that wants `bearerClaim`'s arguments otherwise
// greps `src/` and reads a hundred lines around every hit (`FJS-1547`: 1384
// greps, 2.0M characters in 77 sessions).
//
// A symbol is an export of a package's declared entry point, found by the
// checker following `export *` and `export { x } from` to the declaration — the
// reading `import { x } from '@frontierjs/pkg/sub'` does, so a name is listed
// where an app imports it from and never under a path only the repo can see.
// The printed form is the declaration with its body cut off and its comment
// kept, the half of it a caller needs.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const CODE = /\.([cm]?[jt]sx?)$/

/** Every code file a package.json names under `exports`/`main`, with the subpath it is imported by. */
export function entryPoints(pkg) {
  const out = []
  const take = (subpath, target) => {
    if (typeof target === 'string') { if (CODE.test(target) && !target.endsWith('.d.ts')) out.push({ subpath, file: target }); return }
    if (!target || typeof target !== 'object') return
    // a condition map: a `.d.ts` is the surface its author wrote down, so it outranks the source it describes
    for (const key of ['types', 'import', 'default', 'bun']) {
      if (typeof target[key] === 'string' && CODE.test(target[key])) { out.push({ subpath, file: target[key] }); return }
    }
  }
  const ex = pkg.exports
  if (typeof ex === 'string') take('.', ex)
  else if (ex && typeof ex === 'object' && Object.keys(ex).some(k => k.startsWith('.'))) {
    for (const [subpath, target] of Object.entries(ex)) take(subpath, target)
  } else if (ex) take('.', ex)
  else if (pkg.main) take('.', pkg.main)
  return out
}

/** `[{ name, dir, entries: [{ subpath, file }] }]` for every package that declares a code entry point. */
export function publishedPackages(root) {
  const base = join(root, 'packages')
  const found = []
  for (const dir of readdirSync(base).sort()) {
    const pj = join(base, dir, 'package.json')
    if (!existsSync(pj)) continue
    let pkg
    try { pkg = JSON.parse(readFileSync(pj, 'utf8')) } catch { continue }
    if (pkg.private || !pkg.name) continue
    const entries = entryPoints(pkg)
    if (entries.length) found.push({ name: pkg.name, dir: join(base, dir), entries })
  }
  return found
}

const MAX_BODY = 40

/** The comment above a declaration, stripped of its stars, or ''. */
function docOf(ts, node) {
  const docs = node.jsDoc ?? node.parent?.parent?.jsDoc
  if (!docs?.length) return ''
  const text = docs[docs.length - 1].getText()
  return text.split('\n').map(l => l.replace(/^\s*\/?\*+\/?\s?/, '').replace(/\*\/\s*$/, '').trimEnd()).join('\n').trim()
}

/** A declaration's text up to where its body begins — `function f(a): R` without the braces. */
function headOf(sf, node, body) {
  const start = node.getStart(sf)
  const end = body ? body.getStart(sf) : node.end
  return sf.text.slice(start, end).trimEnd()
}

/** A class or interface as its member signatures, one per row, bodies dropped. */
function membersOf(ts, sf, node) {
  const rows = []
  for (const m of node.members ?? []) {
    const doc = docOf(ts, m)
    if (m.kind === ts.SyntaxKind.PropertyDeclaration || m.kind === ts.SyntaxKind.PropertySignature
      || m.kind === ts.SyntaxKind.IndexSignature || m.kind === ts.SyntaxKind.CallSignature) {
      rows.push({ doc, text: sf.text.slice(m.getStart(sf), m.end).trim() })
    } else {
      rows.push({ doc, text: headOf(sf, m, m.body) })
    }
  }
  return rows
}

const MEMBER_DOC = 160
const DOC_LINES  = 12

/** A member's comment as one line, cut where a reader has the gist — the file has the rest. */
const oneLine = text => {
  const flat = text.replace(/\s*\n\s*/g, ' ')
  return flat.length > MEMBER_DOC ? flat.slice(0, MEMBER_DOC).trimEnd() + ' …' : flat
}

/**
 * `{ kind, text, doc }` for one declaration. An interface or class small enough
 * to read is printed whole; a large one is its members, each cut to its
 * signature, so `App` is one screen rather than six hundred lines.
 */
export function describeDeclaration(ts, decl) {
  const sf = decl.getSourceFile()
  const K = ts.SyntaxKind
  const doc = docOf(ts, decl)
  if (decl.kind === K.FunctionDeclaration) return { kind: 'function', doc, text: headOf(sf, decl, decl.body) }
  if (decl.kind === K.VariableDeclaration) {
    const stmt = decl.parent.parent
    const init = decl.initializer
    const lead = stmt.getStart(sf)
    const text = init && (init.kind === K.ArrowFunction || init.kind === K.FunctionExpression)
      ? sf.text.slice(lead, init.body.getStart(sf)).trimEnd().replace(/\s*(=>)?\s*$/, init.kind === K.ArrowFunction ? ' =>' : '')
      : sf.text.slice(lead, decl.end).split('\n').slice(0, 6).join('\n')
    const kind = init && (init.kind === K.ArrowFunction || init.kind === K.FunctionExpression) ? 'function' : 'const'
    return { kind, doc: docOf(ts, stmt) || doc, text }
  }
  if (decl.kind === K.InterfaceDeclaration || decl.kind === K.ClassDeclaration) {
    const kind = decl.kind === K.InterfaceDeclaration ? 'interface' : 'class'
    const whole = sf.text.slice(decl.getStart(sf), decl.end)
    if (whole.split('\n').length <= MAX_BODY) return { kind, doc, text: whole }
    const open = sf.text.indexOf('{', decl.name ? decl.name.end : decl.getStart(sf))
    const head = sf.text.slice(decl.getStart(sf), open).trimEnd()
    const rows = membersOf(ts, sf, decl)
    const body = rows.map(r => (r.doc ? `  // ${oneLine(r.doc.split('\n\n')[0])}\n` : '') + '  ' + r.text.replace(/\n/g, '\n  ')).join('\n')
    return { kind, doc, text: `${head} {\n${body}\n}`, trimmed: true }
  }
  if (decl.kind === K.TypeAliasDeclaration || decl.kind === K.EnumDeclaration) {
    const whole = sf.text.slice(decl.getStart(sf), decl.end)
    const lines = whole.split('\n')
    return { kind: decl.kind === K.EnumDeclaration ? 'enum' : 'type', doc, text: lines.length <= MAX_BODY ? whole : lines.slice(0, MAX_BODY).join('\n') + '\n  …' }
  }
  return { kind: 'other', doc, text: sf.text.slice(decl.getStart(sf), decl.end).split('\n').slice(0, 6).join('\n') }
}

/**
 * Every export of every published package: `[{ name, pkg, subpaths, file, line,
 * kind, text, doc }]`. One program holds all the entry files, so a file two
 * packages reach is parsed once. A name exported by several subpaths of one
 * package is one row listing them.
 */
export function collectExports(ts, root, { only } = {}) {
  const pkgs = publishedPackages(root).filter(p => !only || p.name === only || p.name === `@frontierjs/${only}` || p.name.endsWith(`/${only}`))
  const files = pkgs.flatMap(p => p.entries.map(e => resolve(p.dir, e.file))).filter(f => existsSync(f))
  if (!files.length) return []
  const program = ts.createProgram(files, {
    allowJs: true, checkJs: false, noEmit: true, skipLibCheck: true, noLib: true, types: [],
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  })
  const checker = program.getTypeChecker()
  const rows = new Map()
  for (const p of pkgs) {
    for (const e of p.entries) {
      const sf = program.getSourceFile(resolve(p.dir, e.file))
      const mod = sf && checker.getSymbolAtLocation(sf)
      if (!mod) continue
      for (const exp of checker.getExportsOfModule(mod)) {
        let sym = exp
        if (sym.flags & ts.SymbolFlags.Alias) { try { sym = checker.getAliasedSymbol(sym) } catch { continue } }
        const decls = sym.declarations ?? []
        if (!decls.length) continue
        const decl = decls[0]
        const dsf = decl.getSourceFile()
        const key = `${p.name}:${exp.name}:${dsf.fileName}:${decl.pos}`
        const prior = rows.get(key)
        if (prior) { prior.subpaths.push(e.subpath); continue }
        const { line } = dsf.getLineAndCharacterOfPosition(decl.getStart(dsf))
        const d = describeDeclaration(ts, decl)
        // overloads: every signature, so a caller sees each shape the function takes
        const overloads = decls.length > 1 && decls.every(x => x.kind === ts.SyntaxKind.FunctionDeclaration)
          ? decls.filter(x => !x.body || x === decls[decls.length - 1]).map(x => headOf(x.getSourceFile(), x, x.body))
          : null
        rows.set(key, {
          name: exp.name, pkg: p.name, subpaths: [e.subpath], file: relative(root, dsf.fileName), line: line + 1,
          ...d, ...(overloads ? { text: overloads.join('\n') } : {}),
        })
      }
    }
  }
  return [...rows.values()]
}

/**
 * `{ rows, how }` — rows whose name is exactly `name`, else those holding it
 * case-insensitively, else those whose printed declaration names it as a word.
 * The last is how an option (`sessionFields`) or a method on a returned object
 * (`verifyGateLadder`) is found: it is a member of something exported, and
 * is never an export of its own.
 */
export function matchSymbol(rows, name) {
  const exact = rows.filter(r => r.name === name)
  if (exact.length) return { rows: exact, how: 'exact' }
  const low = name.toLowerCase()
  const part = rows.filter(r => r.name.toLowerCase().includes(low))
  if (part.length) return { rows: part, how: 'name' }
  const word = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`)
  return { rows: rows.filter(r => word.test(r.text)), how: 'member' }
}

/** The import line an app would write, so the answer carries the specifier too. */
export function importFrom(row) {
  const sub = row.subpaths[0]
  return `import { ${row.name} } from '${sub === '.' ? row.pkg : row.pkg + sub.slice(1)}'`
}

/** One row as the text a reader gets. */
export function renderSymbol(row) {
  const out = [`# ${row.name} · ${row.kind} · ${row.file}:${row.line}`, `# ${importFrom(row)}${row.subpaths.length > 1 ? `   (also ${row.subpaths.slice(1).join(' ')})` : ''}`]
  if (row.doc) {
    const lines = row.doc.split('\n')
    out.push(...lines.slice(0, DOC_LINES).map(l => ('// ' + l).trimEnd()))
    if (lines.length > DOC_LINES) out.push(`// … ${lines.length - DOC_LINES} more lines at ${row.file}:${row.line}`)
  }
  out.push(row.text)
  return out.join('\n')
}

/** `name  kind  file:line` per export, grouped by package — the index when no name is given. */
export function renderIndex(rows) {
  const byPkg = new Map()
  for (const r of rows) (byPkg.get(r.pkg) ?? byPkg.set(r.pkg, []).get(r.pkg)).push(r)
  const out = []
  for (const [pkg, list] of byPkg) {
    out.push(`## ${pkg}`)
    for (const r of list.sort((a, b) => a.name.localeCompare(b.name))) out.push(`  ${r.name}  ${r.kind}  ${r.file}:${r.line}`)
  }
  return out
}
