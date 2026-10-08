// cli-helpers.js — what the CLI's commands share: colors, flags, loading a
// schema, resolving a database path, a baseline from git. Its own module so
// Studio's server (studio.js) reads them by import rather than living inside
// cli.js, which runs main() the moment it is loaded (FJS-D635).

import { existsSync, readFileSync, statSync }   from 'fs'
import { resolve, relative, dirname }          from 'path'
import { spawnSync }                           from 'child_process'
import { parse, parseFile, inlineImports, resolveImportSpecifier } from '../core/parser.js'

// ─── Colors ──────────────────────────────────────────────────────────────────

export const c = {
  reset:  '\x1b[0m',  bold:   '\x1b[1m',  dim:    '\x1b[2m',
  red:    '\x1b[31m', green:  '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
}
export const bold   = s => `${c.bold}${s}${c.reset}`
export const dim    = s => `${c.dim}${s}${c.reset}`
export const green  = s => `${c.green}${s}${c.reset}`
export const yellow = s => `${c.yellow}${s}${c.reset}`
export const red    = s => `${c.red}${s}${c.reset}`
export const cyan   = s => `${c.cyan}${s}${c.reset}`

// ─── Args ─────────────────────────────────────────────────────────────────────

export const args = process.argv.slice(2)

// Build a flag map that handles both --flag=value and --flag value forms.
// Values consumed by a flag are excluded from positional args.
const _flagMap  = new Map()
const _consumed = new Set()
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (!a.startsWith('--')) continue
  if (a.includes('=')) {
    const eq  = a.indexOf('=')
    _flagMap.set(a.slice(2, eq), a.slice(eq + 1))
  } else {
    // Peek at next arg — if it exists and isn't a flag, it's the value
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      _flagMap.set(a.slice(2), next)
      _consumed.add(i + 1)
    } else {
      _flagMap.set(a.slice(2), true)   // boolean flag
    }
  }
}

export const positional = args.filter((a, i) => !a.startsWith('--') && !_consumed.has(i))
export const flag       = name => _flagMap.has(name) && _flagMap.get(name) !== false
export const getFlag    = name => {
  const v = _flagMap.get(name)
  return (v === undefined || v === true || v === false) ? null : v
}
// A flag that may be given more than once. `_flagMap` keeps the last, so this
// reads the arguments again.
export const getFlags   = name => {
  const out = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === `--${name}` && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) out.push(args[++i])
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3))
  }
  return out
}

export function fatal(msg) {
  console.error(`\n  ${red('✗')}  ${msg}\n`)
  process.exit(1)
}

export function rel(p) { return relative(process.cwd(), p) || p }

export function header(title) { console.log(`\n  ${bold(title)}\n`) }

export function loadSchema(schemaPath) {
  // schemaPath is null when no schema was found anywhere (no --schema flag,
  // no "schema" key in litestone.config.js, no ./schema.lite). Without this
  // guard, resolve(null) throws the cryptic Node error:
  //   The "paths[0]" property must be of type string, got object
  if (typeof schemaPath !== 'string' || !schemaPath.trim()) {
    fatal(
      `No schema found.\n` +
      `     Looked for: ${cyan('--schema')} flag → ${cyan('schema:')} in litestone.config.js → ` +
      `${cyan('./schema.lite')} → ${cyan('./db/schema.lite')}\n` +
      `     Fix: run this from your project directory, pass ${cyan('--schema=path/to/schema.lite')},\n` +
      `     or run ${cyan('litestone init')} to create a new schema.`
    )
  }
  const abs = resolve(schemaPath)
  if (!existsSync(abs))
    fatal(`Schema file not found: ${abs}\n     Run ${cyan('litestone init')} to create one.`)

  // parseFile, not parse — a schema may `import "./other.lite"`, and createClient
  // has always resolved those. This read the root file alone, so every CLI
  // command saw a schema with the imported models missing and said nothing:
  // `db push` compared against the partial view and reported "already in sync"
  // while three tables were never created.
  const result = parseFile(abs)
  if (!result.valid) {
    console.error(`\n  ${red('✗')}  schema.lite has errors:\n`)
    for (const e of result.errors) console.error(`     ${red('·')} ${e}`)
    console.error()
    process.exit(1)
  }
  for (const w of result.warnings ?? [])
    console.warn(`  ${yellow('⚠')}  ${w}`)
  return result
}

// Resolve encryption key from env for CLI commands that open createClient.
// Schemas with @encrypted/@secret fields require a key; CLI ops (db push,
// migrate apply, studio, seed, optimize, backup) all load via env.
export function getEncKey() {
  return process.env.ENCRYPTION_KEY ?? process.env.LITESTONE_KEY ?? undefined
}

// The CLI's own copy of the client's resolver, anchored the same way and for
// the same reason (`FJS-449`). `schemaAnchor` is imported rather than restated —
// two answers to *where does this database live* is how `litestone studio` run
// from `db/` came to serve an empty database it had just created while every
// other command in the same tree opened the real one.
//
// `cfg.schema` is the file the command was pointed at, so the anchor is
// available here in every invocation; the client only learns it when a caller
// passes `path:`, which is why the call sites above now do.
export function resolveDbPath(pathDef, fallback, anchor = null) {
  const against = v => anchor ? resolve(anchor, v) : resolve(v)
  if (!pathDef) return fallback ? against(fallback) : null
  if (pathDef.var) {
    const envVal = process.env[pathDef.var]
    return against(envVal ?? pathDef.default ?? fallback ?? '.')
  }
  return against(pathDef.value ?? fallback ?? '.')
}

// ─── declaresDatabases / clientDb ─────────────────────────────────────────────
// Does the schema own its own paths?
//
// `createClient({ db })` names MAIN's path and overrides a declared `database
// main`, and loadConfig() ALWAYS answers a db — `./development.db` when nothing
// said otherwise. So a command that forwards cfg.db unconditionally redirects
// `main` at a file the schema never named, and createClient creates it on the
// way, so nothing is missing and nothing complains. `litestone backup` was
// snapshotting that empty file and reporting `✓ main`.
//
// openSqliteDbs has always asked this question; the commands that build a
// client directly did not. One definition, both callers.

export const declaresDatabases = (parseResult) =>
  parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')

// The `db` argument for createClient — the declaration wins when there is one.
// This is also what makes `--db` unambiguous: a name filter on a multi-database
// schema, a path on a single-database one.
export const clientDb = (parseResult, cfg) => declaresDatabases(parseResult) ? undefined : cfg.db

// `--gate ./api/gate.ts#shopGateLevel`. A named export wins; otherwise the
// conventional names, and then the sole exported function — which is the common
// case and the one worth not making people spell. Anything else is refused with
// the exports listed, because the alternative is a console that silently grades
// with the default resolver while the flag suggests otherwise.
export async function loadGateResolver(spec) {
  if (!spec) return null

  const hash = spec.lastIndexOf('#')
  const path = hash === -1 ? spec : spec.slice(0, hash)
  const name = hash === -1 ? null : spec.slice(hash + 1)

  let mod
  try { mod = await import(resolve(path)) }
  catch (e) { fatal(`--gate ${cyan(path)} could not be imported.\n     ${e.message}`) }

  if (name) {
    if (typeof mod[name] !== 'function')
      fatal(`--gate: ${cyan(path)} exports no function named ${cyan(name)}.\n` +
            `     Exports: ${Object.keys(mod).join(', ') || '(none)'}`)
    return mod[name]
  }

  if (typeof mod.getLevel === 'function') return mod.getLevel
  if (typeof mod.default  === 'function') return mod.default

  const fns = Object.keys(mod).filter(k => typeof mod[k] === 'function')
  if (fns.length === 1) return mod[fns[0]]

  fatal(`--gate: ${cyan(path)} exports ${fns.length} functions — name the one to use.\n` +
        `     ${cyan(`--gate ${path}#${fns[0] ?? 'getLevel'}`)}   ${dim(`(${fns.join(', ') || 'none'})`)}`)
}

// Where the previous release's schema comes from. A path on disk wins, because
// a ref and a filename are not distinguishable and only one of them can be
// tested for cheaply; anything else is asked of git.
export function loadBaselineSchema(from, schemaPath) {
  const missing      = []
  const borrowedPkgs = []
  const noteFor = (base) => base ?? (missing.length
    ? `${missing.length === 1 ? 'an import' : `${missing.length} imports`} could not be read there ` +
      `(${missing.join(', ')}) — those models are absent from the baseline`
    : null)

  if (existsSync(from) && statSync(from).isFile()) {
    // rel() walks up out of the project for a file in /tmp, which reads as a
    // path nobody typed. Shortest of the two is the one a person recognizes.
    const abs = resolve(from), r = rel(abs)

    // A baseline is a COPY of this schema at another moment, and its `import`
    // lines mean the files the schema imports — but a relative specifier
    // resolves against whatever directory the copy was put in, so a baseline
    // kept anywhere but beside the schema silently loses every imported model
    // and the comparison then reports the whole of an imported package as newly
    // added. Its own directory is still asked FIRST: a baseline that brought
    // its neighbours with it means those, and a schema whose imports have since
    // been rewritten must not have today's files read into yesterday's release.
    // The schema's directory is the fallback, and borrowing is stated.
    const borrowed = []
    const text = inlineImports(readFileSync(abs, 'utf8'), abs, {
      resolveChild: (parent, spec) => {
        const here = resolveImportSpecifier(spec, parent).path
        if (existsSync(here)) return here
        const there = resolveImportSpecifier(spec, schemaPath).path
        if (!existsSync(there)) return here     // report it against the baseline's own path
        borrowed.push(spec)
        return there
      },
      read: (p) => { try { return readFileSync(p, 'utf8') } catch { return null } },
      seen: new Set([abs]),
      missing,
    })

    const label = `\`${r.length < abs.length ? r : abs}\``
    const notes = []
    if (borrowed.length)
      notes.push(`${borrowed.length === 1 ? 'an import was' : `${borrowed.length} imports were`} read from ` +
                 `${rel(dirname(resolve(schemaPath)))} rather than beside the baseline (${borrowed.join(', ')})`)
    const gone = noteFor(null)
    if (gone) notes.push(gone)

    return { text, label, note: notes.length ? notes.join('; ') : null }
  }

  const root = git(['rev-parse', '--show-toplevel'])
  if (!root) return { text: null, label: from, note: `\`${from}\` is not a file and this is not a git repository` }

  const tracked  = relative(root, schemaPath).split('\\').join('/')
  const rootText = git(['show', `${from}:${tracked}`])

  if (rootText === null)
    return { text: null, label: from, note: `\`${tracked}\` is not committed at \`${from}\`` }

  // A PACKAGE specifier is read from the working tree, and that is not a
  // shortcut. `import "@frontierjs/auth/schema.lite"` resolves through node —
  // a ref has no node_modules, so joining it as a path asks git for
  // `db/@frontierjs/auth/schema.lite`, which is nothing. Every model a package
  // ships was therefore absent from every baseline, and the comparison reported
  // the whole of `@frontierjs/auth` as newly added on every run, for ever: six
  // phantom `new` models on `example`, which is the shape of an answer nobody
  // can act on.
  //
  // The alternative it is measured against is not perfection. If the package
  // version moved between that ref and now, this compares today's fragment
  // against itself and UNDERSTATES what changed in it — one package, when its
  // version moved. Not doing it OVERSTATES every package model on every
  // comparison. The note says which happened, which is the half that makes the
  // narrower error the honest one to take.
  //
  // A relative import still comes from the ref: those files are in the tree and
  // git has them at that commit, which is the whole point of asking for a ref.
  const fromDisk = new Set()
  const text = inlineImports(rootText, tracked, {
    resolveChild: (parent, spec) => {
      if (RELATIVE_IMPORT.test(spec)) return posixJoin(posixDir(parent), spec)
      const here = resolveImportSpecifier(spec, schemaPath).path
      if (!here || !existsSync(here)) return posixJoin(posixDir(parent), spec)
      fromDisk.add(here)
      borrowedPkgs.push(spec)
      return here
    },
    read: (p) => (fromDisk.has(p)
      ? (() => { try { return readFileSync(p, 'utf8') } catch { return null } })()
      : git(['show', `${from}:${p}`])),
    seen:  new Set([tracked]),
    missing,
  })

  const notes = []
  if (borrowedPkgs.length)
    notes.push(`${borrowedPkgs.length === 1 ? 'a package fragment was' : `${borrowedPkgs.length} package fragments were`} ` +
               `read from the working tree rather than at that ref — a package specifier resolves through ` +
               `node_modules, which a ref does not have (${borrowedPkgs.join(', ')})`)
  const gone = noteFor(null)
  if (gone) notes.push(gone)

  return { text, label: `\`${from}\``, note: notes.length ? notes.join('; ') : null }
}

// The same test `resolveImportSpecifier` makes, stated where the ref reader can
// ask it without resolving anything: a relative or absolute specifier is a file
// in this tree and git has it at the ref; anything else is a package.
const RELATIVE_IMPORT = /^\.\.?[\\/]|^[\\/]|^[A-Za-z]:[\\/]/

// A git ref is addressed with posix paths regardless of the host, so the two
// path helpers `inlineImports` needs for the ref reader live here rather than
// coming from `node:path` — `resolve()` would produce a Windows path `git show`
// cannot take.
const posixDir = (p) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.'

const posixJoin = (dir, spec) => {
  const parts = []
  for (const seg of `${dir}/${spec}`.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

// The baseline arrives with its imports already inlined, at the ref it came
// from, so it is the same surface the current schema's parseFile produces and
// the two are comparable.
//
// **A baseline is graded by today's validator, and it should not be.** Every
// rule this parser learns is retroactive: the moment `@@unique` over a nullable
// column became a parse error, every ref written before that commit stopped
// being a baseline, both commands answered *no baseline*, and `--strict` — which
// fails on no baseline by design — failed every branch. The schema at that ref
// shipped; refusing to compare against it because it breaks a rule invented
// afterwards grades the past by today's law.
//
// So a VALIDATION failure demotes to a note and the comparison runs on the
// schema the parser built anyway. A SYNTAX failure still refuses, and that is
// the honest line: validation rejects a schema the parser understood, and there
// is nothing to compare when it did not.
export function parseBaseline(text, pluralize, derive) {
  let parsed
  try { parsed = parse(text) } catch (err) { return { surface: null, error: `the schema there does not parse (${err.message})` } }
  if (!parsed.schema) return { surface: null, error: `the schema there has errors (${parsed.errors?.[0] ?? 'unknown'})` }
  return {
    surface: derive(parsed.schema, { pluralize }),
    error:   null,
    note:    parsed.valid ? null
      : `the schema at that ref breaks ${parsed.errors.length} rule${parsed.errors.length !== 1 ? 's' : ''} this version enforces ` +
        `and shipped before they existed — compared anyway (${parsed.errors[0]})`,
  }
}

export function git(argv) {
  const run = spawnSync('git', argv, { encoding: 'utf8', shell: false, cwd: process.cwd() })
  if (run.error || run.status !== 0) return null
  return run.stdout.replace(/\n$/, '')
}
