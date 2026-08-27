#!/usr/bin/env bun
// litestone CLI

import { existsSync, writeFileSync, readFileSync, statSync, mkdirSync, readdirSync } from 'fs'
import { resolve, relative, join, dirname, basename } from 'path'
import { spawnSync }                                from 'child_process'
import { Database }                                from 'bun:sqlite'

// Imports of sibling source files MUST use literal relative specifiers — never
// `import.meta.dir + path`. Two reasons:
//   1. Computed specifiers are invisible to the bundler, so `bun build --compile`
//      emits a binary that resolves them against /$bunfs/root at runtime and dies
//      with "Cannot find module". Literal specifiers get embedded.
//   2. A wrong computed path fails only when that command runs; a wrong literal
//      one fails at build time.
// Bun resolves symlinks before resolving relative imports, so these still work
// when the CLI is reached through node_modules/.bin/ under `bun link`.
//
// import.meta.dir remains correct for locating files NEXT TO the source at
// runtime — but see IS_COMPILED: inside a standalone binary there is no such
// directory, so on-disk assets must be embedded instead (see studio.html).
import { parse, parseFile, inlineImports, inlineImportsFromDisk } from '../core/parser.js'
import { buildPristine, introspect, diffSchemas,
         generateMigrationSQL, summariseDiff }         from '../core/migrate.js'
import { create, apply, status, verify,
         createForDatabase, listMigrationFiles, migrationStatements,
         describeSkipped, appliedMigrations,
         baseline, historyGap, driftAgainstLive }      from '../core/migrations.js'
import { backupSqliteTo }                              from '../core/backup.js'
import { schemaAnchor, noteMintedDirectory }          from '../core/db-path.js'
import { resolveTenancy }                              from '../core/tenancy.js'
import { CATALOG, GROUPS, POSITIONS, positionsOf, docFor } from '../core/catalog.js'
import { modelToAccessor, modelToTableName }           from '../core/ddl.js'

// Assets that must survive `bun build --compile`. A text import is embedded in
// the binary; readFileSync(import.meta.dir + ...) is not.
import STUDIO_HTML       from './studio.html'      with { type: 'text' }
import SEED_CALENDAR_SQL from './seeds/calendar.sql' with { type: 'text' }

// Version for `--version`. An import, not a readFileSync: the path has to work
// from source, from an installed package (reached via a node_modules/.bin
// symlink), and from inside a compiled binary where there is no package.json
// on disk at all.
import { version as PKG_VERSION } from '../../package.json' with { type: 'json' }

// True when running from a standalone binary. Stamped in by scripts/build-binary.js
// via `--define process.env.LITESTONE_COMPILED="1"`; undefined when run from source.
//
// Do NOT sniff import.meta.dir for this. It reads /$bunfs/root in a plain
// --compile binary, but `--bytecode` bakes in the BUILD MACHINE's absolute source
// path instead — so a path-based check silently returns false in exactly the build
// we ship, and any import.meta.dir path resolution points at a directory that does
// not exist on the user's machine. Verified on Bun 1.3.11.
const IS_COMPILED = process.env.LITESTONE_COMPILED === '1'

// Seeds that ship inside the package, as name → SQL text. Embedded rather than
// read from src/tools/seeds/ so they exist in a compiled binary too.
const BUILTIN_SEEDS = { calendar: SEED_CALENDAR_SQL }

// ─── Colours ──────────────────────────────────────────────────────────────────

const c = {
  reset:  '\x1b[0m',  bold:   '\x1b[1m',  dim:    '\x1b[2m',
  red:    '\x1b[31m', green:  '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
}
const bold   = s => `${c.bold}${s}${c.reset}`
const dim    = s => `${c.dim}${s}${c.reset}`
const green  = s => `${c.green}${s}${c.reset}`
const yellow = s => `${c.yellow}${s}${c.reset}`
const red    = s => `${c.red}${s}${c.reset}`
const cyan   = s => `${c.cyan}${s}${c.reset}`

// ─── .env loading ─────────────────────────────────────────────────────────────
// Auto-load environment variables from .env files in cwd before any command
// runs. This matches behaviour developers expect from tools like Prisma and
// Drizzle: drop secrets in .env, run `litestone db push`, it just works.
//
// Precedence (highest wins, never overrides what the shell already set):
//   1. process.env from the shell (already set when this file loads)
//   2. .env.local                  (gitignored, machine-local overrides)
//   3. .env                        (committed defaults)
//   4. file passed via --env-file=path / --env-file path
//
// Disable with --no-env. Passing --env-file replaces the default search and
// errors if the file is missing.

function parseDotenv(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let val = line.slice(eq + 1).trim()
    // Strip wrapping quotes — single or double
    if ((val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
        (val.startsWith("'") && val.endsWith("'") && val.length >= 2)) {
      val = val.slice(1, -1)
    } else {
      // Strip inline `# comment` only when value is unquoted
      const hash = val.indexOf(' #')
      if (hash >= 0) val = val.slice(0, hash).trim()
    }
    out[key] = val
  }
  return out
}

function loadEnvFile(path, { required = false } = {}) {
  if (!existsSync(path)) {
    if (required) {
      console.error(`\n  ${c.red}✗${c.reset}  --env-file not found: ${path}\n`)
      process.exit(1)
    }
    return 0
  }
  const parsed = parseDotenv(readFileSync(path, 'utf8'))
  let loaded   = 0
  for (const [k, v] of Object.entries(parsed)) {
    // Shell env always wins — never clobber a value the user set explicitly.
    if (process.env[k] === undefined) {
      process.env[k] = v
      loaded++
    }
  }
  return loaded
}

;(function autoLoadEnv() {
  const argv = process.argv.slice(2)
  if (argv.includes('--no-env')) return

  // Pull --env-file value if present (supports --env-file=x and --env-file x)
  let explicit = null
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--env-file' && argv[i + 1]) { explicit = argv[i + 1]; break }
    if (a.startsWith('--env-file=')) { explicit = a.slice('--env-file='.length); break }
  }

  if (explicit) {
    loadEnvFile(resolve(process.cwd(), explicit), { required: true })
    return
  }

  // Default: .env then .env.local in cwd. Load .env.local LAST so that when we
  // skip already-set keys, .env.local effectively wins for any keys present in
  // both files. (Shell still beats both.)
  loadEnvFile(resolve(process.cwd(), '.env.local'))
  loadEnvFile(resolve(process.cwd(), '.env'))
})()

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

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

const positional = args.filter((a, i) => !a.startsWith('--') && !_consumed.has(i))
const flag       = name => _flagMap.has(name) && _flagMap.get(name) !== false
const getFlag    = name => {
  const v = _flagMap.get(name)
  return (v === undefined || v === true || v === false) ? null : v
}

// ─── Help ─────────────────────────────────────────────────────────────────────

const HELP = `
  ${bold('litestone')}  SQLite schema & migration tool

  ${bold('Commands')}
    ${cyan('litestone init')}                      create schema.lite + litestone.config.js
    ${cyan('litestone codemod')} [path]            migrate .lite files to renamed types
    ${dim('  --dry-run')}                            preview without writing
    ${dim('  --no-backup')}                          skip .bak files
    ${cyan('litestone migrate create')} [label]    diff schema → write migration file
    ${cyan('litestone migrate dry-run')} [label]   preview migration SQL, no file written
    ${cyan('litestone migrate apply')}             apply all pending migrations
    ${dim('  --backup[=dir]')}                       copy every database first — there is no down
    ${cyan('litestone migrate status')}            show applied / pending / modified
    ${cyan('litestone migrate verify')}            check if live db matches schema
    ${cyan('litestone db push')}                    apply schema directly — no migration files (dev)
    ${cyan('litestone types')} [out.d.ts]            generate TypeScript declarations from schema
    ${dim('  --only=users,posts')}                  only emit types for specified models
    ${dim('  --audience=client|system')}             field visibility (default: client)
    ${cyan('litestone studio')}                     open local web UI
    ${cyan('litestone repl')} [--as|--level|--gate]  a console that boots at a gate level
    ${cyan('litestone doctor')}                     check setup, audit health
    ${cyan('litestone seed')} [SeederClass]             seed the database
    ${cyan('litestone seed run')} [name]               run an infrastructure seed (--force to re-run)
    ${cyan('litestone introspect')} <db>              reverse-engineer db → schema.lite
    ${cyan('litestone diagram')}                    ER diagram (opens in studio)
    ${cyan('litestone optimize')} [table]            optimize FTS5 indexes (all or one table)
    ${cyan('litestone edge eject')} <Model>.<field>  promote an @edge/@scoped field to a real model [--apply]
    ${cyan('litestone backup')} [dest]               backup all databases (SQLite + JSONL/logger)
    ${cyan('litestone replicate')} [config.js]       stream every SQLite db's WAL to S3/R2 via litestream
    ${cyan('litestone rsync')} <dest>              sync all SQLite DBs to a destination via sqlite3_rsync
    ${cyan('litestone transform')} [config.js]      run a transform pipeline (DSL)
    ${cyan('litestone tenant list')}                list all tenants
    ${cyan('litestone tenant create <id>')}         create a new tenant
    ${cyan('litestone tenant delete <id>')}         delete a tenant
    ${cyan('litestone tenant migrate')}             migrate all tenants
    ${cyan('litestone explain')} [@word]              what a .lite word is, what it accepts, where it is legal
    ${dim('  --visibility')}                           which of @computed/@transient/@system/@guarded/@encrypted
    ${dim('  --json')}                                 the catalog as data
    ${cyan('litestone catalog --snapshot')}            write the language surface ${dim('(--check in CI)')}
    ${cyan('litestone catalog --reference')}           write docs/reference.snapshot.md ${dim('(--check in CI)')}
    ${cyan('litestone advise')}                       what this schema says wrong, and what it never said
    ${dim('  --json')}                                 both lists as data
    ${cyan('litestone jsonschema')}                   generate JSON Schema from schema.lite
    ${cyan('litestone access')}                       write the access snapshot ${dim('(--check in CI)')}
    ${cyan('litestone ddl')}                          write the DDL snapshot ${dim('(--check in CI)')}
    ${cyan('litestone release')}                      classify the deploy: expand, contract or unknown
    ${dim('  --from=<ref|path>')}                      the release to compare against ${dim('(default: HEAD)')}
    ${dim('  --strict')}                               exit 1 unless the verdict is expand
    ${cyan('litestone mutate')}                       mutate the schema, report what the checks miss

  ${bold('Options')}
    ${dim('--schema=<path>')}     path to schema.lite         ${dim('(auto-detected if omitted)')}
    ${dim('--config=<path>')}     optional .js/.ts config file ${dim('(db, migrations overrides)')}
    ${dim('--db=<path>')}         database file     ${dim('(default: from config)')}
    ${dim('--migrations=<dir>')}  migrations dir    ${dim('(default: from config or ./migrations)')}
    ${dim('--force')}             overwrite on init
    ${dim('--debug')}             print stack traces on error
    ${dim('--env-file=<path>')}   load env vars from file ${dim('(default: ./.env.local then ./.env)')}
    ${dim('--no-env')}            skip auto-loading .env files
    ${dim('--version')}           print version and exit

  ${bold('Config')}  litestone.config.js
    export default {
      db:         './production.db',
      schema:     './schema.lite',
      migrations: './migrations',
    }
`

// ─── Config ───────────────────────────────────────────────────────────────────

// configOverride lets a command accept the config path positionally
// (`litestone replicate ./litestone.config.js`) without a second resolver.
async function loadConfig(configOverride) {
  // ── Resolution order ─────────────────────────────────────────────────────────
  //
  // schema:     --schema flag  →  config schema:  →  sibling to config  →  ./schema.lite
  //             in cwd  →  ./db/schema.lite (an FJS app keeps the Data realm there)
  // db:         --db flag      →  config db:      →  null (comes from database block in schema)
  // migrations: --migrations   →  config migrations:  →  sibling ./migrations to schema
  //
  // --config must be a .js or .ts file — use --schema to point directly at a .lite file.

  const configPath = configOverride ?? getFlag('config')
  let   cfg        = {}
  let   cfgDir     = process.cwd()

  if (configPath) {
    const cfgAbs = resolve(configPath)
    if (!cfgAbs.endsWith('.js') && !cfgAbs.endsWith('.ts'))
      fatal(`--config must be a .js or .ts file, got: ${configPath}\n     To point at a schema directly, use --schema instead.`)
    if (!existsSync(cfgAbs))
      fatal(`Config file not found: ${cfgAbs}`)
    const mod = await import(`file://${cfgAbs}`)
    cfg    = mod.default ?? mod
    cfgDir = dirname(cfgAbs)
  } else {
    // No --config — look for litestone.config.js in cwd, then in ./db/.
    //
    // `db/` is where an FJS app keeps the Data realm (root README § Project
    // Structure), so an app root is the obvious place to run this from and the
    // config is one level down. cwd is probed first: an app that puts one at
    // its root means it.
    const defaultCfg = [resolve('./litestone.config.js'), resolve('./db/litestone.config.js')]
      .find(existsSync)
    if (defaultCfg) {
      const mod = await import(`file://${defaultCfg}`)
      cfg    = mod.default ?? mod
      cfgDir = dirname(defaultCfg)
    }
  }

  // Config values must be string paths — catch objects/arrays/functions here
  // with a pointed message instead of letting resolve() throw "paths[0]".
  const fromCfg = (p, key) => {
    if (p == null) return null
    if (typeof p !== 'string')
      fatal(
        `litestone.config.js: ${cyan(key)} must be a string path, got ${Array.isArray(p) ? 'an array' : typeof p === 'object' ? 'an object' : `a ${typeof p}`}.\n` +
        `     Example:  ${cyan(`${key}: './${key === 'schema' ? 'schema.lite' : key}'`)}`
      )
    return resolve(cfgDir, p)
  }

  // Resolve schema — flag wins, then config key, then sibling to config, then cwd
  const schemaPath = getFlag('schema')
    ? resolve(getFlag('schema'))
    : fromCfg(cfg.schema, 'schema')
      ?? (existsSync(resolve(cfgDir, 'schema.lite'))    ? resolve(cfgDir, 'schema.lite')    : null)
      ?? (existsSync(resolve('./schema.lite'))           ? resolve('./schema.lite')           : null)
      // Same reason as the config probe above — an FJS app's schema is db/schema.lite,
      // so running from the app root looked for it one directory too high and
      // reported "No schema found" about a file that was plainly there.
      ?? (existsSync(resolve('./db/schema.lite'))        ? resolve('./db/schema.lite')        : null)

  // migrations dir resolves relative to schema file location when known
  const schemaDir = schemaPath ? dirname(schemaPath) : cfgDir

  return {
    db:         getFlag('db')         ? resolve(getFlag('db'))         : fromCfg(cfg.db, 'db') ?? resolve('./development.db'),
    schema:     schemaPath,
    migrations: getFlag('migrations') ? resolve(getFlag('migrations')) : fromCfg(cfg.migrations, 'migrations') ?? resolve(schemaDir, 'migrations'),
    seedsDir:   fromCfg(cfg.seedsDir, 'seedsDir') ?? null,
    pluralize:  cfg.pluralize ?? false,
    tenants:    cfg.tenants ?? null,   // { dir, registry, migrationsDir } — used by tenant cmds + Studio
    replicate:  cfg.replicate ?? null, // { url, syncInterval, ... } — used by cmdReplicate
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fatal(msg) {
  console.error(`\n  ${red('✗')}  ${msg}\n`)
  process.exit(1)
}

function rel(p) { return relative(process.cwd(), p) || p }

function header(title) { console.log(`\n  ${bold(title)}\n`) }

function loadSchema(schemaPath) {
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
function getEncKey() {
  return process.env.ENCRYPTION_KEY ?? process.env.LITESTONE_KEY ?? undefined
}

function openDb(dbPath) {
  if (!dbPath)
    fatal(`No database specified. Pass ${cyan('--db=<path>')} or set ${cyan('db')} in litestone.config.js`)
  const abs = resolve(dbPath)
  if (!existsSync(abs))
    console.log(`  ${dim(`db not found — will be created: ${rel(abs)}`)}`)
  ensureParentDir(abs)
  try {
    return new Database(abs)
  } catch (e) {
    if (e?.code === 'SQLITE_CANTOPEN')
      fatal(`unable to open database file\n     path: ${abs}\n     Check that the parent directory is writable.`)
    throw e
  }
}

/** Ensure the parent directory of `absPath` exists (for SQLite db paths). */
function ensureParentDir(absPath) {
  if (!absPath || absPath === ':memory:') return
  try {
    const dir = dirname(absPath)
    if (dir && dir !== '.' && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
      noteMintedDirectory(dir, absPath)
    }
  } catch { /* let the subsequent open() surface the real error */ }
}

// ─── Multi-DB helpers ────────────────────────────────────────────────────────
//
// When a schema has `database` blocks, migrations run per-database.
// Directory layout:
//   Single-DB (no database blocks): cfg.migrations/
//   Multi-DB:                       cfg.migrations/<dbName>/
//
// jsonl and logger databases are always skipped — they have no SQL schema.

// The CLI's own copy of the client's resolver, anchored the same way and for
// the same reason (`FJS-449`). `schemaAnchor` is imported rather than restated —
// two answers to *where does this database live* is how `litestone studio` run
// from `db/` came to serve an empty database it had just created while every
// other command in the same tree opened the real one.
//
// `cfg.schema` is the file the command was pointed at, so the anchor is
// available here in every invocation; the client only learns it when a caller
// passes `path:`, which is why the call sites above now do.
function resolveDbPath(pathDef, fallback, anchor = null) {
  const against = v => anchor ? resolve(anchor, v) : resolve(v)
  if (!pathDef) return fallback ? against(fallback) : null
  if (pathDef.var) {
    const envVal = process.env[pathDef.var]
    return against(envVal ?? pathDef.default ?? fallback ?? '.')
  }
  return against(pathDef.value ?? fallback ?? '.')
}

// Returns array of { name, rawDb, migrationsDir } for every sqlite database.
// Opens raw Database connections — caller must close them.
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

const declaresDatabases = (parseResult) =>
  parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')

// The `db` argument for createClient — the declaration wins when there is one.
// This is also what makes `--db` unambiguous: a name filter on a multi-database
// schema, a path on a single-database one.
const clientDb = (parseResult, cfg) => declaresDatabases(parseResult) ? undefined : cfg.db

function openSqliteDbs(parseResult, cfg) {
  const schema = parseResult.schema
  const hasDatabaseBlocks = declaresDatabases(parseResult)

  if (!hasDatabaseBlocks) {
    // Single-DB schema — just main, using cfg.db
    if (!cfg.db) fatal('No database path specified. Set db in litestone.config.js or pass --db=<path>')
    return [{ name: 'main', rawDb: openDb(cfg.db), path: resolve(cfg.db), migrationsDir: cfg.migrations }]
  }

  const result = []
  for (const db of schema.databases) {
    if (db.driver === 'jsonl' || db.driver === 'logger') continue  // no SQL schema
    const absPath = resolveDbPath(db.path, null, schemaAnchor(cfg.schema))
    if (!absPath) {
      console.log(`  ${yellow('⚠')}  database '${db.name}' has no resolvable path — skipping`)
      continue
    }
    if (!existsSync(absPath))
      console.log(`  ${dim(`db not found — will be created: ${rel(absPath)}`)}`)
    ensureParentDir(absPath)
    let rawDb
    try { rawDb = new Database(absPath) }
    catch (e) {
      if (e?.code === 'SQLITE_CANTOPEN') {
        fatal(`unable to open database '${db.name}'\n     path: ${absPath}\n     Check that the parent directory is writable.`)
      }
      throw e
    }
    result.push({
      name:          db.name,
      rawDb,
      path:          absPath,
      migrationsDir: join(cfg.migrations, db.name),
    })
  }

  return result
}


// Which migration directories this schema has, WITHOUT opening a database.
//
// `openSqliteDbs` creates the file if it is missing, which is right for every
// command that is about to read or write one — and wrong for `migrate check`,
// whose whole claim is that it needs no database at all. Asking it there would
// create an empty database as a side effect of a read-only question, and would
// fatal on an app that has not configured `db` yet.
function migrationDirsFor(parseResult, cfg) {
  if (!declaresDatabases(parseResult)) return [{ name: 'main', migrationsDir: cfg.migrations }]
  return parseResult.schema.databases
    .filter(db => db.driver !== 'jsonl' && db.driver !== 'logger')
    .map(db => ({ name: db.name, migrationsDir: join(cfg.migrations, db.name) }))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

// Migrate .lite files from the old type names (Text/Integer/Real/Blob) to the
// new ones (String/Int/Float/Bytes). Word-boundary replacement so we don't
// trample identifiers that happen to contain the old name as a substring.
//
// Defaults: rewrite in place, skip node_modules / .git / migrations directory.
// Pass --dry-run to print the changes without writing. Pass --no-backup to
// skip the .bak files (default writes filename.lite.bak alongside).
async function cmdCodemod(target) {
  header('litestone codemod')

  const dryRun  = flag('dry-run')
  const backup  = !flag('no-backup')
  const root    = target ? resolve(target) : process.cwd()
  const renames = [
    [/\bText\b/g,    'String'],
    [/\bInteger\b/g, 'Int'],
    [/\bReal\b/g,    'Float'],
    [/\bBlob\b/g,    'Bytes'],
  ]

  // Walk root looking for .lite files. Skip the obvious throw-away dirs.
  const SKIP_DIRS = new Set(['node_modules', '.git', 'migrations', 'dist', 'build'])
  const files = []
  function walk(dir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue
      if (SKIP_DIRS.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && e.name.endsWith('.lite')) files.push(full)
    }
  }
  walk(root)

  if (!files.length) {
    console.log(`  ${dim('no .lite files found under')} ${rel(root)}`)
    return
  }

  let totalEdits = 0
  for (const f of files) {
    const before = readFileSync(f, 'utf8')
    let after = before
    let edits = 0
    for (const [re, name] of renames) {
      after = after.replace(re, () => { edits++; return name })
    }
    if (!edits) {
      console.log(`  ${dim('·')} ${rel(f)} ${dim('(no changes)')}`)
      continue
    }
    totalEdits += edits
    if (dryRun) {
      console.log(`  ${yellow('~')} ${rel(f)} ${dim(`(${edits} change${edits === 1 ? '' : 's'})`)}`)
      continue
    }
    if (backup) writeFileSync(f + '.bak', before, 'utf8')
    writeFileSync(f, after, 'utf8')
    console.log(`  ${green('✓')} ${rel(f)} ${dim(`(${edits} change${edits === 1 ? '' : 's'}${backup ? ', backup written' : ''})`)}`)
  }

  console.log()
  console.log(dryRun
    ? `  ${dim('dry-run — no files written. Total changes that would be made:')} ${totalEdits}`
    : `  ${green('✓')}  rewrote ${totalEdits} occurrence${totalEdits === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'}`
  )
}

async function cmdInit() {
  header('litestone init')

  const schemaPath = getFlag('schema') ?? './schema.lite'
  const configPath = './litestone.config.js'

  if (existsSync(schemaPath) && !flag('force'))
    fatal(`${schemaPath} already exists. Use --force to overwrite.`)

  writeFileSync(schemaPath, `/// schema.lite — Litestone schema definition

model User {
  id        Int      @id
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
  deletedAt DateTime?

  @@softDelete
  @@index([email])
}
`, 'utf8')
  console.log(`  ${green('✓')}  created ${cyan(schemaPath)}`)

  if (!existsSync(configPath)) {
    writeFileSync(configPath, `// litestone.config.js
export default {
  schema:     './schema.lite',
  migrations: './migrations',
  // db defaults to ./development.db
}
`, 'utf8')
    console.log(`  ${green('✓')}  created ${cyan(configPath)}`)
  }

  // Create the migrations directory upfront. First migrate-create would do
  // this anyway; doing it now avoids a spurious "directory not found" warning
  // from doctor immediately after init.
  const migrationsDir = './migrations'
  if (!existsSync(migrationsDir)) {
    mkdirSync(migrationsDir, { recursive: true })
    console.log(`  ${green('✓')}  created ${cyan(migrationsDir + '/')}`)
  }

  console.log(`
  ${dim('Next:')}
    1. Edit ${cyan(schemaPath)}
    2. ${cyan('litestone migrate create init')}
    3. ${cyan('litestone migrate apply')}
`)
}

// ─────────────────────────────────────────────────────────────────────────────

async function cmdCreate(label, cfg) {
  header('litestone migrate create')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')
  let   anyCreated  = false

  try {
    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)
      const result = multi
        ? createForDatabase(rawDb, parseResult, name, label || 'migration', migrationsDir, { pluralize: cfg.pluralize })
        : create(rawDb, parseResult, label || 'migration', migrationsDir, { pluralize: cfg.pluralize })

      if (!result.created) {
        console.log(`  ${green('✓')}  ${result.message}\n`)
        continue
      }

      anyCreated = true
      console.log(`  ${green('✓')}  ${cyan(rel(result.filePath))}\n`)
      console.log(result.summary.split('\n').map(l => `  ${l}`).join('\n'))
      console.log()
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }

  if (anyCreated)
    console.log(`  ${dim(`Run ${cyan('litestone migrate apply')} to apply.`)}\n`)
}

// ─────────────────────────────────────────────────────────────────────────────

async function cmdDryRun(label, cfg) {
  header('litestone migrate dry-run')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')

  try {
    for (const { name, rawDb } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)

      const pristineDb = new Database(':memory:')
      const pristine   = multi
        ? (await import('../core/migrate.js')).buildPristineForDatabase(pristineDb, parseResult, name)
        : buildPristine(pristineDb, parseResult)
      pristineDb.close()

      const live       = introspect(rawDb)
      const diffResult = diffSchemas(pristine, live, parseResult, name, { pluralize: cfg.pluralize })

      if (!diffResult.hasChanges) {
        console.log(`  ${green('✓')}  ${multi ? name + ': ' : ''}schema is in sync — no migration needed\n`)
        continue
      }

      console.log(summariseDiff(diffResult).split('\n').map(l => `  ${l}`).join('\n'))
      console.log()
      console.log(`  ${dim('─── SQL preview (not written) ' + '─'.repeat(33))}`)
      console.log()
      console.log(generateMigrationSQL(diffResult, parseResult)
        .split('\n').map(l => `  ${l}`).join('\n'))
      console.log()
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────────

// A migration file has no `down`, by ruling — the way back is a copy of the
// database taken before the migration ran (DECISIONS.md § Migrations). These
// two say so at the moment it is still true: `preApplyBackup` takes the copy,
// `irreversibleMigrations` names what is about to happen when nobody asked for
// one.

// Every database is copied before the FIRST one is migrated. A run that fails
// on the second database has already changed the first, so a per-database
// backup taken inside the loop is a backup of a half-migrated fleet.
async function preApplyBackup(dbs) {
  const stamp   = new Date().toISOString().replace('T', '_').replace(/:/g, '').slice(0, 15)
  const destDir = resolve(getFlag('backup') ?? join('./backups', stamp))

  mkdirSync(destDir, { recursive: true })

  for (const { name, rawDb } of dbs) {
    const dest = resolve(destDir, `${name}.db`)
    try {
      const size = await backupSqliteTo(rawDb, dest)
      console.log(`  ${green('✓')}  backup ${cyan(name)} ${dim(`${(size / 1024 / 1024).toFixed(2)} MB → ${rel(dest)}`)}`)
    } catch (e) {
      // The point of the flag is that nothing runs without the copy.
      fatal(`backup of '${name}' failed — nothing was migrated.\n     ${e.message}`)
    }
  }
  console.log()
  return destDir
}

// A DROP is the statement there is no way back from, and a rebuild is a DROP —
// so a dropped column is in this class too. The guard table a rebuild creates
// is not: it holds one row and belongs to the migration.
// The quote goes INSIDE the lookahead: `"?(?!_litestone_)` backtracks the
// optional quote away and then passes on the `"` itself.
const DROPS_A_TABLE = /^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?(?!"?_litestone_)/i

function irreversibleMigrations(migrationsDir, pending) {
  const out = []
  for (const file of pending) {
    // A JS migration is arbitrary — it may rewrite every row in the database,
    // and nothing here can read what it will do.
    if (file.endsWith('.js')) { out.push(`${file} ${dim('(JS — contents unknown)')}`); continue }
    const drops = migrationStatements(join(resolve(migrationsDir), file))
      .filter(s => DROPS_A_TABLE.test(s.trim())).length
    if (drops) out.push(`${file} ${dim(`(drops ${drops} table${drops > 1 ? 's' : ''})`)}`)
  }
  return out
}

/**
 * Does the migration HISTORY build the schema the app declares?
 *
 * `migrate apply` applies migration FILES. With none — the state every app is
 * in that develops through `db push`, which writes tables and no file — it
 * applied nothing, printed `no migration files found` with a TICK, and exited
 * ZERO. A container whose entrypoint is `bun run db:migrate && bun run start`
 * therefore started a server over a database holding litestone's own
 * bookkeeping table and nothing else: health answered, the deploy was declared
 * good, and the first write said `no such table: user` (`FJS-388`).
 *
 * The first answer to that compared declared TABLE NAMES against
 * `sqlite_master`, and it was not enough. A new model was caught; a new COLUMN
 * was not — history at `User{id,email}`, a pushed `name` column, and apply
 * answered `1 migration applied`, exit 0, over a table with no `name`. A column
 * add is the common change after week one, so the guard was passing exactly the
 * traffic it was written for (`FJS-D123`).
 *
 * So the comparison is schema-granular and it is asked of the REPO, through
 * `historyGap` — replay the files into a shadow database, diff the declared
 * schema against it. Two consequences worth having: it catches columns,
 * indexes and constraints rather than tables alone, and it needs no database at
 * all, which is what lets `fli deploy:doctor` and CI ask the identical question
 * before an image is built. Same function, several callers.
 */

// ─── migrate check ────────────────────────────────────────────────────────────
//
// Does the migration history build the schema this app declares? The deploy's
// question, asked of the REPO alone — no database is opened, nothing is
// written — which is what lets `fli deploy:doctor`, `fli check` and CI ask it
// before an image exists, and `migrate apply` ask the same function again at
// container start (`FJS-D123` section 6).
//
// Exit 1 when the history falls short, 0 when it builds the schema. A history
// that cannot be shadowed answers 0 with a note: *I cannot tell* is not a
// failure, and a check that fires on a `.js` migration would be one nobody
// keeps in their pipeline.

async function cmdCheck(cfg) {
  header('litestone migrate check')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = migrationDirsFor(parseResult, cfg)
  const multi       = dbs.length > 1
  const gaps        = []

  for (const { name, migrationsDir } of dbs) {
    const gap = historyGap(parseResult, migrationsDir, { pluralize: cfg.pluralize, dbName: name })
    if (gap.unknown) { console.log(`  ${dim('·')}  ${multi ? name + ': ' : ''}${gap.message}\n`); continue }
    if (gap.ok) { console.log(`  ${green('✓')}  ${multi ? name + ': ' : ''}the migration history builds the schema\n`); continue }
    gaps.push({ name, summary: gap.summary })
  }

  if (!gaps.length) return

  console.error(`\n  ${red('✗')}  the migration history does not build the schema this app declares:\n`)
  for (const { name, summary } of gaps) {
    if (multi) console.error(`     ${cyan(name)}`)
    console.error(summary.split('\n').map(l => `     ${l}`).join('\n'))
  }
  console.error(
    `\n     ${dim('A deploy replays these files. What is missing here is missing there,')}` +
    `\n     ${dim('and the container refuses to start rather than serving 500s.')}` +
    `\n\n     Write it:  ${cyan('litestone migrate dev')}\n`
  )
  process.exit(1)
}

// ─── migrate baseline ─────────────────────────────────────────────────────────
//
// Record the migration files as applied without running them, for a database
// that already holds what they build. Two populations need it and both are
// ordinary: an app developed entirely through `db push`, which has a correct
// database and no history at all, and the developer's OWN database the moment
// `migrate create` writes a delta they had already pushed — `ALTER TABLE ADD
// COLUMN` is not idempotent, so replaying it there fails with `duplicate column
// name`. Reset is the other way out and is what Prisma does; this is the one
// that keeps the data (`FJS-D123`).

async function cmdBaseline(cfg) {
  header('litestone migrate baseline')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')
  let   anyBlocked  = false
  let   anyRecorded = false

  try {
    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)
      const result = baseline(rawDb, parseResult, migrationsDir, { pluralize: cfg.pluralize, dbName: name })

      if (result.ok && result.recorded?.length) {
        anyRecorded = true
        for (const f of result.recorded) console.log(`  ${green('✓')}  ${dim('recorded as applied')}  ${f}`)
        console.log()
        continue
      }
      if (result.ok) { console.log(`  ${green('✓')}  ${result.message}\n`); continue }

      anyBlocked = true
      console.error(`\n  ${red('✗')}  ${result.message}\n`)
      if (result.summary) console.error(result.summary.split('\n').map(l => `     ${l}`).join('\n') + '\n')
      console.error(
        `     ${dim('Baselining states that this database already holds what those files build.')}` +
        `\n     ${dim('It is checked before it is recorded, because one wrong baseline is a database')}` +
        `\n     ${dim('that reports a complete history and is missing a column.')}` +
        `\n\n     Bring it up to date:  ${cyan('litestone migrate apply')}\n`
      )
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }

  if (anyBlocked) process.exit(1)
  if (anyRecorded) console.log(`  ${dim(`Nothing was run — ${cyan('litestone migrate status')} to see the history.`)}\n`)
}

// ─── migrate dev ──────────────────────────────────────────────────────────────
//
// Create, then apply, in the one verb a developer runs constantly. It is what
// makes `db push` prototyping-only rather than a workflow a deployed app lives
// in (`FJS-D123`): before this the only convenient command wrote no history, so
// the history fell behind by default and the deploy was the first thing to
// notice. Prisma's `migrate deploy` needs no schema guard because `migrate dev`
// has already kept the two in step; the guard in `cmdApply` is what litestone
// was using instead of having this.
//
// The drift check is what separates it from `create && apply`: a database ahead
// of its history cannot take the delta, and saying so with the way out beats
// `duplicate column name` from the middle of a file the developer did not write.

async function cmdDev(label, cfg) {
  header('litestone migrate dev')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')
  let   created     = 0
  let   drifted     = false

  try {
    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)

      // Asked BEFORE anything is written: a drifted database cannot apply what
      // create is about to produce, and a file written and not applied leaves
      // the developer in a state neither command explains.
      const drift = driftAgainstLive(rawDb, parseResult, migrationsDir, { pluralize: cfg.pluralize, dbName: name })
      if (drift.unknown) { console.error(`\n  ${red('✗')}  ${drift.message}\n`); process.exit(1) }
      if (!drift.ok) {
        drifted = true
        console.error(`\n  ${red('✗')}  this database is not what its migration history builds:\n`)
        console.error(drift.summary.split('\n').map(l => `     ${l}`).join('\n'))
        console.error(
          `\n     ${dim('`db push` writes tables and no file, so a pushed change lives here and')}` +
          `\n     ${dim('nowhere else. A migration created now cannot re-apply over it.')}` +
          `\n\n     Keep the data:   ${cyan('litestone migrate create')}${dim(' then ')}${cyan('litestone migrate baseline')}` +
          `\n     Start clean:     ${cyan('litestone db reset')}${dim('  then ')}${cyan('litestone migrate dev')}\n`
        )
        continue
      }

      const result = createAgainstHistoryCli(parseResult, name, label, migrationsDir, cfg)
      if (result.blocked) { console.error(`\n  ${red('✗')}  ${result.message}\n`); process.exit(1) }
      if (!result.created) { console.log(`  ${green('✓')}  ${result.message}\n`); continue }

      created++
      console.log(`  ${green('✓')}  ${cyan(rel(result.filePath))}\n`)
      console.log(result.summary.split('\n').map(l => `  ${l}`).join('\n'))
      console.log()
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }

  if (drifted) process.exit(1)
  if (created) await cmdApply(cfg)
  else console.log(`  ${dim('nothing to apply')}\n`)
}

// create() and createForDatabase() differ only in which database's models they
// build, and cmdDev needs whichever this one is.
function createAgainstHistoryCli(parseResult, name, label, migrationsDir, cfg) {
  return createForDatabase(null, parseResult, name, label || 'migration', migrationsDir, { pluralize: cfg.pluralize })
}

async function cmdApply(cfg) {
  header('litestone migrate apply')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')
  const wantsBackup = flag('backup') || getFlag('backup') !== null
  let   backupDir   = null
  let   totalOk     = 0
  let   anyFailed   = false
  const missingByDb = []

  try {
    if (wantsBackup) backupDir = await preApplyBackup(dbs)

    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)

      // Set optimal page size on brand new databases
      const pageCount = rawDb.query('PRAGMA page_count').get()
      if (pageCount && pageCount.page_count <= 1) rawDb.run('PRAGMA page_size = 8192')

      const appliedSet = new Set(appliedMigrations(rawDb).map(m => m.name))
      const pending    = listMigrationFiles(migrationsDir).filter(f => !appliedSet.has(f))

      if (!wantsBackup) {
        const risky = irreversibleMigrations(migrationsDir, pending)
        if (risky.length) {
          console.warn(`  ${yellow('!')}  no way back from this run without a copy of the database:`)
          for (const r of risky) console.warn(`       ${r}`)
          console.warn(`     ${dim(`Re-run with ${cyan('--backup')} to take one first.`)}\n`)
        }
      }

      // Create Litestone client if any JS migrations are pending
      // (needed so JS migrations receive full ORM access)
      const hasPendingJs = pending.some(f => f.endsWith('.js'))
      let lsClient = null
      if (hasPendingJs) {
        const { createClient } = await import('../core/client.js')
        lsClient = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: rawDb, encryptionKey: getEncKey() })
      }

      const result = await apply(rawDb, migrationsDir, lsClient)
      if (lsClient) lsClient.$close()

      // Named whether or not anything ran: a directory holding three valid
      // migrations and one misnamed file applies three and is silent about the
      // fourth, which is the same omission one file at a time.
      if (result.skipped?.length && !result.unmatched) {
        console.warn(`  ${yellow('!')}  ${describeSkipped(result.skipped)}\n`)
      }

      // A directory holding .sql files that none of them matched is not a
      // success. It used to print ✓ and exit 0, so a deploy migrated nothing
      // and said so in the affirmative.
      if (result.unmatched) {
        console.error(`  ${red('✗')}  ${result.message}\n`)
        anyFailed = true
        continue
      }

      if (result.message) {
        console.log(`  ${green('✓')}  ${result.message}\n`)
        continue
      }

      for (const r of result.applied) {
        const tag = r.ok ? green('✓') : red('✗')
        const ms  = r.ok ? dim(`  (${r.elapsed}ms)`) : ''
        const prefix = multi ? dim(`  [${name}] `) : '  '
        console.log(`${prefix}${tag}  ${r.file}${ms}`)
        if (!r.ok) console.error(`\n     ${red(r.error)}\n`)
      }

      if (result.failed) anyFailed = true
      totalOk += result.applied.filter(r => r.ok).length
    }

    // Asked after the run rather than during it, so the answer covers every
    // path above — including the one that applies nothing and `continue`s.
    for (const { name, migrationsDir } of dbs) {
      const gap = historyGap(parseResult, migrationsDir, { pluralize: cfg.pluralize, dbName: name })
      if (gap.unknown) continue   // a JS history cannot be shadowed — say nothing rather than guess
      if (!gap.ok) missingByDb.push({ name, summary: gap.summary })
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }

  if (anyFailed) {
    if (backupDir) console.error(`\n  ${dim(`backup taken before the run: ${cyan(rel(backupDir))}`)}`)
    console.error(`\n  ${red('✗')}  One or more migrations failed or were unreadable — affected databases unchanged.\n`)
    process.exit(1)
  }

  if (missingByDb.length) {
    const multiDb = missingByDb.length > 1 || multi
    console.error(`\n  ${red('✗')}  the migration history does not build the schema this app declares:\n`)
    for (const { name, summary } of missingByDb) {
      if (multiDb) console.error(`     ${cyan(name)}`)
      console.error(summary.split('\n').map(l => `     ${l}`).join('\n'))
    }
    console.error(
      `\n     ${totalOk > 0
        ? 'The migrations that ran do not build the schema as declared.'
        : 'Nothing applied, because there was nothing to apply.'}` +
      `\n     ${dim('`migrate apply` runs migration FILES; `db push` writes tables and no file,')}` +
      `\n     ${dim('so a change developed with push has no history for a deploy to replay.')}` +
      `\n\n     Write it:  ${cyan('litestone migrate dev')}${dim('  (create + apply, in development)')}` +
      `\n     ${dim('or')}         ${cyan('litestone migrate create <label>')}${dim(', commit the file, and deploy again')}\n`
    )
    process.exit(1)
  }

  if (totalOk > 0) {
    console.log(`\n  ${green(bold(`${totalOk} migration${totalOk !== 1 ? 's' : ''} applied`))}`)
    if (backupDir) {
      // Said here because it is the last moment somebody reads this output, and
      // the -wal/-shm half is what makes a hand-rolled restore come back wrong.
      console.log(`\n  ${dim('to go back: stop the app, then put each copy back over its database')}`)
      for (const { name, path } of dbs)
        console.log(`    ${dim(`cp ${rel(join(backupDir, name + '.db'))} ${rel(path)}`)}`)
      console.log(`    ${dim('and delete the -wal and -shm files beside it')}`)
    }
    console.log()
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function cmdStatus(cfg) {
  header('litestone migrate status')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')

  const stateTag = {
    applied:  green('✓'),
    pending:  yellow('·'),
    modified: red('⚠'),
    orphaned: red('?'),
    skipped:  red('✗'),
  }
  const stateLabel = {
    applied:  dim('applied '),
    pending:  yellow('pending '),
    modified: red('modified'),
    orphaned: red('orphaned'),
    skipped:  red('skipped '),
  }

  try {
    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${cyan(name)}`)

      const rows = status(rawDb, migrationsDir)

      if (rows.length === 0) {
        console.log(`  ${dim('no migration files found')}
`)
        continue
      }

      for (const row of rows) {
        const date = row.applied_at
          ? dim(`  ${row.applied_at.slice(0, 19).replace('T', ' ')}`)
          : ''
        const warn = row.tampered
          ? `  ${red('(checksum mismatch — edited after apply)')}`
          : ''
        const indent = multi ? '    ' : '  '
        console.log(`${indent}${stateTag[row.state]}  ${stateLabel[row.state]}  ${row.file}${date}${warn}`)
      }

      const counts = {
        pending:  rows.filter(r => r.state === 'pending').length,
        applied:  rows.filter(r => r.state === 'applied').length,
        problems: rows.filter(r => r.state === 'modified' || r.state === 'orphaned' || r.state === 'skipped').length,
      }
      const skipped = rows.filter(r => r.state === 'skipped').map(r => r.file)

      console.log()
      if (counts.applied)  console.log(`  ${dim(`${counts.applied} applied`)}`)
      if (counts.pending)  console.log(`  ${yellow(`${counts.pending} pending`)}`)
      if (counts.problems) console.log(`  ${red(`${counts.problems} problem${counts.problems > 1 ? 's' : ''}`)}`)
      if (skipped.length)  console.log(`  ${red(describeSkipped(skipped))}`)
      console.log()
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function cmdVerify(cfg) {
  header('litestone migrate verify')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')
  let   anyDrift    = false

  try {
    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${cyan(name)}`)

      const result = verify(rawDb, parseResult, migrationsDir)

      if (result.state === 'in-sync') {
        console.log(`  ${green('✓')}  ${multi ? name + ': ' : ''}${result.message}\n`)
        continue
      }

      if (result.state === 'pending') {
        console.log(`  ${yellow('·')}  ${multi ? name + ': ' : ''}${result.message}\n`)
        for (const f of result.pending)
          console.log(`     ${dim('·')} ${f}`)
        console.log()
        console.log(`  ${dim(`Run ${cyan('litestone migrate apply')} to apply them.`)}\n`)
        continue
      }

      // drift
      anyDrift = true
      console.log(`  ${red('⚠')}  ${multi ? name + ': ' : ''}${result.message}\n`)
      console.log(result.diff.split('\n').map(l => `  ${l}`).join('\n'))
      console.log()
      console.log(`  ${dim(`Run ${cyan('litestone migrate create')} to generate a corrective migration.`)}\n`)
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }

  if (anyDrift) process.exit(1)
}


// ─── the console ──────────────────────────────────────────────────────────────
//
// `litestone repl`, and `fli tinker` over it. What it resolves is the STANDING —
// which principal, graded by which resolver, at which level — and the prompt
// loop itself is `tools/repl.js`.
//
// Three standings, and the middle two are deliberately not the same thing:
// `--as` runs a resolver over a real row, `--level` fixes the answer. The split
// is `createTestEnv`'s between `actingAs` and `atLevel`, for the same reason —
// a ladder walked with the second says nothing about whether the first works.

async function cmdRepl(cfg) {
  header('litestone tinker')

  // It drove `bun repl` as a subprocess once, fed through `.load` and two fixed
  // sleeps. That worked and could never satisfy the rule this command lives by:
  // a subprocess REPL owns its prompt, so it cannot say what it is running as.
  // Hosted here instead — `node:readline` under bun.
  const parseResult = loadSchema(cfg.schema)
  const { isSoftDelete } = await import('../core/ddl.js')
  const { createClient } = await import('../core/client.js')
  const { startRepl, describeStanding } = await import('./repl.js')

  const asWho = getFlag('as')
  const level = getFlag('level') != null ? Number(getFlag('level')) : null

  if (level != null && (!Number.isInteger(level) || level < 0 || level > 9))
    fatal(`--level takes 0-9. Got ${cyan(String(getFlag('level')))}.\n` +
          `     0 STRANGER · 2 READER · 4 USER · 5 ADMINISTRATOR · 6 OWNER · 7 SYSADMIN · 8 SYSTEM`)

  // The app's own resolver, if it will say where it is. Without this the console
  // grades with `FrontierGateGetLevel`, which is the DEFAULT and not necessarily
  // what the app installed — and "refuses exactly what that person is refused"
  // is a false claim the moment the two disagree. `example` exports
  // `shopGateLevel`; the flag is `--gate ./api/gate.ts#shopGateLevel`.
  const appGetLevel = await loadGateResolver(getFlag('gate'))

  // A synthetic standing REPLACES the GatePlugin the schema would auto-install,
  // which is exactly what `atLevel(n)` does in the testing env and for the same
  // reason: a level is fixed when a client is constructed, so it cannot be a
  // property of a call.
  const plugins = []
  if (level != null || appGetLevel) {
    const { GatePlugin } = await import('../plugins/gate.js')
    plugins.push(new GatePlugin({ getLevel: level != null ? () => level : appGetLevel }))
  }

  // The house form, encryption key included: a console that cannot decrypt an
  // `@encrypted` column shows ciphertext where the app shows a value, which is
  // a console that lies about the row you came to look at.
  const base = await createClient({
    parsed:        parseResult,
    db:            clientDb(parseResult, cfg),
    encryptionKey: getEncKey(),
    ...(plugins.length ? { plugins } : {}),
  })

  const sys = base.asSystem()

  // Read through the system client. You are an operator looking somebody up —
  // finding the row must not depend on the standing you are about to adopt.
  const found = asWho ? await findPrincipal(sys, base.$schema, asWho) : { row: null, model: null }

  if (asWho && !found.model)
    fatal(`This schema does not say which model holds people.\n` +
          `     Mark it ${cyan('@@auth')} — or name it here: ${cyan('--as Customer:' + asWho)}.\n` +
          `     ${dim('Guessing which table holds principals is how a console boots as the wrong thing.')}`)

  if (asWho && !found.row)
    fatal(`No ${cyan(found.model)} row matches ${cyan(found.needle)}.\n` +
          `     Tried ${found.tried.join(', ')}. ${dim('`--level <n>` takes a standing with no user.')}`)

  const user = found.row

  const db = user ? base.$setAuth(user) : base

  // The level a principal is GRADED at, shown rather than assumed — the point of
  // --as is that a resolver answers, and a person reading a refusal needs the
  // number it was refused against and WHICH resolver said it.
  const { FrontierGateGetLevel } = await import('../plugins/gate.js')
  const { levelLabel }           = await import('../access.js')

  const resolver = appGetLevel ?? FrontierGateGetLevel
  const graded   = level != null ? level : (user ? await resolver(user) : 0)

  const label    = user ? (user.email ?? user.username ?? user.name ?? `#${user.id}`) : null
  const standing = describeStanding({ label, graded, synthetic: level != null })

  const models    = parseResult.schema.models
  const accessors = models.map(m => modelToAccessor(m.name))
  const softTbls  = models.filter(m => isSoftDelete(m)).map(m => modelToAccessor(m.name))

  const dbDisplay = parseResult.schema.databases.length
    ? parseResult.schema.databases.filter(d => !d.driver || d.driver === 'sqlite').map(d => d.name).join(', ')
    : (cfg.db ? rel(resolve(cfg.db)) : '(from schema)')

  console.log(`  ${dim('Database:')}   ${dbDisplay}`)
  console.log(`  ${dim('Tables:')}     ${accessors.join(', ')}`)
  if (softTbls.length) console.log(`  ${dim('Soft delete:')} ${softTbls.join(', ')}`)
  console.log(`  ${dim('Standing:')}   ${cyan(standing)} ${dim(levelLabel(graded))}`)
  console.log(`  ${dim('Graded by:')}  ${level != null
    ? dim('--level — synthetic, no resolver was asked')
    : (appGetLevel ? cyan(getFlag('gate')) : dim('FrontierGateGetLevel (the default — pass --gate if your app installs its own)'))}`)
  console.log()

  const hints = []

  // Said out loud, because the symptom is indistinguishable from a gate refusal
  // and reads as one: a policy compiles into the WHERE, so with no principal
  // every `auth().id ==` row policy matches nothing and answers an empty list.
  if (level != null && !user && hasAuthPolicies(parseResult.schema))
    hints.push(`  ${yellow('!')}  a standing with no user: every ${cyan('auth()')} row policy matches nothing,\n` +
               `     so a model with one answers an empty list rather than refusing.\n`)

  if (gatedModels(parseResult.schema).length && !user && level == null)
    hints.push(`  ${yellow('!')}  anonymous is STRANGER(0) — ${gatedModels(parseResult.schema).length} gated model(s) will refuse.\n` +
               `     ${dim('--as <email> to boot as somebody, --level <n> for a standing with no user.')}\n`)

  hints.push(`  ${green('✓')}  ${cyan('db')} at this standing · ${cyan('sys')} bypasses everything · ${dim('.help')}`)
  hints.push('')

  await startRepl({ db, sys, standing, accessors, hints })

  try { base.$close() } catch {}
}

// `--gate ./api/gate.ts#shopGateLevel`. A named export wins; otherwise the
// conventional names, and then the sole exported function — which is the common
// case and the one worth not making people spell. Anything else is refused with
// the exports listed, because the alternative is a console that silently grades
// with the default resolver while the flag suggests otherwise.
async function loadGateResolver(spec) {
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

/** The @@auth model, or the one every app calls User. Studio picks it the same way. */
function authModelOf(schema) {
  return schema.models.find(m => m.attributes?.some(a => a.kind === 'auth'))
      ?? schema.models.find(m => m.name === 'User' || m.name === 'users')
      ?? null
}

// `--as alice@example.com` over the @@auth model, or `--as Customer:alice@…`
// where the schema never said. Four columns tried in order, because an app names
// its people whatever it names them and asking a person to know which column is
// asking them to read the schema first. An all-digit argument is an id LAST, not
// first: an email is never all digits and a username can be.
//
// It returns what it tried as well as what it found — "no row matches" and
// "there is no such model" send a person to two different places, and a console
// that conflates them sends them to the wrong one.
async function findPrincipal(sys, schema, spec) {
  const colon  = spec.indexOf(':')
  const named  = colon > 0 ? spec.slice(0, colon) : null
  const needle = colon > 0 ? spec.slice(colon + 1) : spec

  const model = named
    ? schema.models.find(m => m.name === named || modelToAccessor(m.name) === named)
    : authModelOf(schema)

  if (!model) return { row: null, model: null, needle, tried: [] }

  const accessor = modelToAccessor(model.name)
  const declared = new Set((model.fields ?? []).map(f => f.name))
  const tried    = ['email', 'username', 'name'].filter(c => declared.has(c))

  for (const column of tried) {
    const row = await sys[accessor].findFirst({ where: { [column]: needle } }).catch(() => null)
    if (row) return { row, model: model.name, needle, tried }
  }

  if (/^\d+$/.test(needle)) {
    tried.push('id')
    const row = await sys[accessor].findFirst({ where: { id: Number(needle) } }).catch(() => null)
    if (row) return { row, model: model.name, needle, tried }
  }

  return { row: null, model: model.name, needle, tried }
}

const gatedModels = (schema) =>
  schema.models.filter(m => m.attributes?.some(a => a.kind === 'gate'))

const hasAuthPolicies = (schema) =>
  schema.models.some(m => m.attributes?.some(a =>
    (a.kind === 'allow' || a.kind === 'deny') && JSON.stringify(a.expr ?? '').includes('auth')))


// ─── Tenant management ────────────────────────────────────────────────────────

// Where a tenant lives, and who says so. Flag beats litestone.config.js beats
// the schema's own `tenancy { }` block beats the default — one order, and this
// is the only place it is written. The block is last-but-one deliberately: it
// is what the APP declares, and an operator typing a flag is answering for one
// run.
//
// This used to read the config slice alone, so a schema declaring its tenant
// directory and a CLI creating tenants somewhere else both looked correct.
async function tenantOptions(cfg) {
  const parsed   = cfg.schema ? loadSchema(cfg.schema) : null
  const declared = parsed ? resolveTenancy(parsed.schema, { schemaPath: cfg.schema }) : null

  if (declared?.strategy === 'row')
    fatal(
      `This schema declares ${cyan('tenancy { strategy row }')} — one database with a ` +
      `'${declared.column}' column, so there are no per-tenant files to manage.\n` +
      `     ${dim('litestone tenant')} is for ${cyan('strategy database')}.`
    )

  const dir = getFlag('dir') ?? cfg.tenants?.dir ?? declared?.dir ?? './tenants'
  const registry = getFlag('registry') ?? cfg.tenants?.registry ?? declared?.registry ?? null
  const migrationsDir = getFlag('migrations') ?? cfg.tenants?.migrationsDir ?? cfg.migrations

  return { dir, registry, migrationsDir, declared }
}

async function cmdTenant(subCmd, args, cfg) {
  const { createTenantRegistry } = await import('../tenant.js')

  if (!cfg.schema) fatal('No schema found. Use --schema ./db/schema.lite')

  const { dir, registry, migrationsDir } = await tenantOptions(cfg)
  const concurrency   = parseInt(getFlag('concurrency') ?? '8')

  const tenants = await createTenantRegistry({
    dir,
    registry,
    // The PATH, not the text: createTenantRegistry resolves the block's
    // relative paths against the schema's own directory, and it can only do
    // that if it is told which file the schema came from.
    path:          cfg.schema,
    migrationsDir: migrationsDir && existsSync(resolve(migrationsDir)) ? resolve(migrationsDir) : null,
  })

  try {
    switch (subCmd) {

      case 'list': {
        header('litestone tenant list')
        const ids = tenants.list()
        if (!ids.length) { console.log(`  ${dim('No tenants found in')} ${cyan(dir)}`); break }
        console.log(`  ${dim(`${ids.length} tenant${ids.length !== 1 ? 's' : ''} in`)} ${cyan(dir)}\n`)
        for (const id of ids) {
          const meta = tenants.meta.get(id)
          const metaStr = Object.keys(meta).length
            ? '  ' + dim(JSON.stringify(meta))
            : ''
          console.log(`    ${cyan(id)}${metaStr}`)
        }
        console.log()
        break
      }

      case 'create': {
        const id = args[0]
        if (!id) fatal('Usage: litestone tenant create <id>')
        header(`litestone tenant create ${id}`)
        const metaArg  = getFlag('meta')
        const meta     = metaArg ? JSON.parse(metaArg) : {}
        await tenants.create(id, meta)
        console.log(`  ${green('✓')}  Created tenant ${cyan(id)} → ${dim(resolve(dir, id + '.db'))}`)
        if (Object.keys(meta).length)
          console.log(`  ${dim('meta:')} ${JSON.stringify(meta)}`)
        console.log()
        break
      }

      case 'delete': {
        const id = args[0]
        if (!id) fatal('Usage: litestone tenant delete <id>')
        header(`litestone tenant delete ${id}`)
        await tenants.delete(id)
        console.log(`  ${green('✓')}  Deleted tenant ${cyan(id)}`)
        console.log()
        break
      }

      case 'migrate': {
        header('litestone tenant migrate')
        if (!existsSync(resolve(migrationsDir)))
          fatal(`Migrations directory not found: ${migrationsDir}`)
        const only = getFlag('only')?.split(',').map(s => s.trim()) ?? null
        console.log(`  ${dim('Migrating')} ${only ? cyan(only.join(', ')) : 'all tenants'} ${dim('in')} ${cyan(dir)}...\n`)
        const result = await tenants.migrate({ only, concurrency })
        console.log(`  ${green('✓')}  ${result.tenants} tenant${result.tenants !== 1 ? 's' : ''}, ${result.migrations} migration${result.migrations !== 1 ? 's' : ''} applied`)
        if (result.failed.length) {
          console.log(`\n  ${red('✗')}  ${result.failed.length} failed:`)
          result.failed.forEach(f => console.log(`    ${dim('·')} ${cyan(f.tenantId)}: ${f.error}`))
        }
        console.log()
        break
      }

      case 'info': {
        const id = args[0]
        if (!id) fatal('Usage: litestone tenant info <id>')
        header(`litestone tenant info ${id}`)
        if (!tenants.exists(id)) fatal(`Tenant "${id}" not found`)
        const meta = tenants.meta.get(id)
        const db   = await tenants.get(id)
        console.log(`  ${dim('path:')}    ${cyan(resolve(dir, id + '.db'))}`)
        console.log(`  ${dim('meta:')}    ${JSON.stringify(meta)}`)
        console.log()
        break
      }

      default:
        fatal(`Unknown tenant subcommand "${subCmd}". Use: list, create, delete, migrate, info`)
    }
  } finally {
    tenants.close()
  }
}

// ─── EXPLAIN QUERY PLAN parser ────────────────────────────────────────────────
// Converts a SQLite EXPLAIN QUERY PLAN detail string into a rating + advice.
//
// A plan line on its own is not enough to advise on. "USE TEMP B-TREE FOR ORDER
// BY" used to answer "add an index on your ORDER BY column", which is wrong
// whenever that column is the primary key — and it usually is, because the
// default list query orders by it. Measured on `ORDER BY "id"` against a
// `String @id`: adding the advised index changes the plan not at all, because
// the column already carries sqlite_autoindex_<table>_1.
//
// The sort is not a missing index, it is TWO jobs and one index. SQLite uses a
// single index per table here; it spent it on the WHERE, and that index's
// entries are ordered by (its columns, rowid) rather than by the ORDER BY
// column. What removes the sort is one index that does both jobs — the filter
// columns first, the sort columns after. So the advice needs the query, the
// rest of the plan, and the indexes the table actually has.

// The indexes a table really carries, the implicit PRIMARY KEY one included.
//
// PRAGMA takes no bound parameters, so the name has to be interpolated. It is
// resolved through sqlite_master first and the stored name is what gets used —
// never the caller's text (Invariant 8).
function tableIndexes(db, table) {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
    if (!row) return []
    const safe = row.name.replace(/"/g, '""')
    return db.prepare(`PRAGMA index_list("${safe}")`).all().map(ix => ({
      name:    ix.name,
      cols:    db.prepare(`PRAGMA index_info("${ix.name.replace(/"/g, '""')}")`).all().map(c => c.name),
      unique:  !!ix.unique,
      partial: !!ix.partial,
      // 'pk' is the index PRIMARY KEY created for you; 'c' is one you declared.
      implicit: ix.origin === 'pk' || ix.origin === 'u',
      sql:     db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(ix.name)?.sql ?? null,
    }))
  } catch { return [] }
}

// The columns named in the statement's own ORDER BY. Deliberately shallow: a
// subquery's ORDER BY would be a different table's problem, so anything that
// does not parse cleanly returns nothing and the advice stays general.
function orderByColumns(sql) {
  const m = /\border\s+by\s+([^)]+?)(?:\s+limit\b|\s+offset\b|;|$)/is.exec(sql ?? '')
  if (!m) return []
  return m[1].split(',')
    .map(part => part.trim()
      .replace(/\s+(asc|desc)$/i, '')
      .replace(/\s+(nulls\s+(first|last))$/i, '')
      .replace(/^.*\./, '')            // drop a table qualifier
      .replace(/^["'`\[]|["'`\]]$/g, ''))
    .filter(c => /^\w+$/.test(c))      // an expression is not a column
}

// The table this plan line is about, and the index it settled on.
function planTarget(detail) {
  const m = /^(?:SEARCH|SCAN)\s+"?(\w+)"?/i.exec(detail)
  return {
    table: m?.[1] ?? null,
    index: /USING\s+(?:COVERING\s+)?INDEX\s+"?([\w-]+)"?/i.exec(detail)?.[1] ?? null,
  }
}

// The concrete advice for a temp sort: name what is already indexed, then give
// the one index that would do both jobs.
function adviseOrderBySort(ctx) {
  const GENERAL = {
    advice: '<b>Temp sort</b> — SQLite sorted the results itself because no single index both '
          + 'satisfied the WHERE and returned rows in the ORDER BY order.',
    sql: null,
  }
  if (!ctx?.db || !ctx.sql) return GENERAL

  const cols = orderByColumns(ctx.sql)
  if (!cols.length) return GENERAL

  // The sort belongs to whichever table this plan actually reads. With more
  // than one, which ORDER BY column belongs to which table is a guess.
  const targets = (ctx.planRows ?? []).map(r => planTarget(r.detail ?? '')).filter(t => t.table)
  const tables  = [...new Set(targets.map(t => t.table))]
  if (tables.length !== 1) return GENERAL

  const table   = tables[0]
  const indexes = tableIndexes(ctx.db, table)
  if (!indexes.length) return GENERAL

  const chosenName = targets.find(t => t.index)?.index ?? null
  const chosen     = indexes.find(ix => ix.name === chosenName) ?? null

  // Is the ORDER BY already indexed? This is the whole reason the old advice
  // was wrong, so it is said out loud rather than implied.
  const alreadyIndexed = indexes.find(ix => cols.every((c, i) => ix.cols[i] === c))
  const already = alreadyIndexed
    ? `<b>${cols.join(', ')}</b> is already indexed (${alreadyIndexed.implicit
        ? 'the implicit index on its PRIMARY KEY / UNIQUE'
        : alreadyIndexed.name}), so a second index on it alone changes nothing. `
    : ''

  // One index doing both jobs: the filter columns lead, the sort columns follow.
  // The chosen index's own columns ARE the filter it was picked for, which is
  // steadier than re-parsing the constraint out of the plan string.
  const lead     = chosen ? chosen.cols : []
  const combined = [...lead, ...cols.filter(c => !lead.includes(c))]
  if (!lead.length || combined.length === lead.length) {
    return {
      advice: `${already}<b>Temp sort</b> — nothing here returns rows in ${cols.join(', ')} order. `
            + `Add an index leading with your WHERE columns and ending with ${cols.join(', ')}.`,
      sql: null,
    }
  }

  // Carry the chosen index's partial clause across. Litestone's own soft-delete
  // index is partial, and a partial replacement stays the same size.
  const where = chosen.partial
    ? / (WHERE .+)$/i.exec(chosen.sql ?? '')?.[1] ?? ''
    : ''
  const name  = `idx_${table}_${combined.join('_')}`
  const quoted = combined.map(c => `"${c}"`).join(', ')

  return {
    advice: `${already}<b>Temp sort</b> — SQLite spent its one index on the WHERE `
          + `(<b>${chosen.name}</b>), and that index returns rows in ${lead.join(', ')} order, not `
          + `${cols.join(', ')} order. One index that does both jobs removes the sort: `
          + `filter columns first, sort columns last.`,
    sql: `CREATE INDEX "${name}" ON "${table}" (${quoted})${where ? ' ' + where : ''};`
       + `\n-- in the schema: @@index([${combined.join(', ')}])`,
  }
}

function parsePlanDetail(detail, ctx) {
  const d = detail.toUpperCase()

  // Full table scan — worst case
  if (/^SCAN\b/.test(d) && !d.includes('COVERING INDEX') && !d.includes('USING INDEX')) {
    const tbl = detail.match(/^SCAN\s+"?(\w+)"?/i)?.[1] ?? 'table'
    return {
      rating: 'red',
      advice: `<b>Full table scan</b> on "${tbl}" — every row is read. Add an index on the column(s) in your WHERE clause.`,
    }
  }

  // Temp B-tree for ORDER BY or GROUP BY — sort without index
  if (d.includes('TEMP B-TREE FOR ORDER BY')) {
    return { rating: 'yellow', ...adviseOrderBySort(ctx) }
  }
  if (d.includes('TEMP B-TREE FOR GROUP BY')) {
    return {
      rating: 'yellow',
      advice: `<b>Temp sort</b> — GROUP BY required a temporary B-tree. An index on the GROUP BY column would eliminate this.`,
    }
  }
  if (d.includes('TEMP B-TREE FOR DISTINCT')) {
    return {
      rating: 'yellow',
      advice: `<b>Temp sort</b> — DISTINCT required a temporary B-tree. An index may help if used with a WHERE clause.`,
    }
  }

  // Index scan — good
  if (d.includes('USING COVERING INDEX')) {
    return {
      rating: 'green',
      advice: 'Covering index — all needed columns are in the index, no row lookups required. Optimal.',
    }
  }
  if (d.includes('USING INDEX')) {
    return { rating: 'green', advice: 'Index scan — query is using an index.' }
  }

  // PK lookup — best
  if (d.includes('INTEGER PRIMARY KEY') || d.includes('USING PRIMARY KEY') || d.includes('ROWID')) {
    return { rating: 'green', advice: 'Primary key lookup — O(log n) via the rowid B-tree. Optimal.' }
  }

  // SEARCH without index qualifier — could still be ok (auto-index)
  if (/^SEARCH\b/.test(d)) {
    if (d.includes('AUTOMATIC') || d.includes('AUTO-INDEX')) {
      return {
        rating: 'yellow',
        advice: `<b>Auto-index</b> — SQLite built a temporary index at query time. Create a permanent index to avoid this overhead.`,
      }
    }
    return { rating: 'green', advice: 'Index-based search.' }
  }

  // Correlated subquery — warn
  if (d.includes('CORRELATED') || d.includes('SUBQUERY')) {
    return {
      rating: 'yellow',
      advice: 'Correlated subquery — runs once per outer row. Consider rewriting as a JOIN.',
    }
  }

  // Multi-index OR
  if (d.includes('MULTI-INDEX OR')) {
    return { rating: 'yellow', advice: 'Multi-index OR — each branch uses an index but results are merged. Generally fine.' }
  }

  // Default — informational
  return { rating: 'green', advice: null }
}

// ─── Studio ───────────────────────────────────────────────────────────────────

async function cmdStudio(cfg) {
  header('litestone studio')

  const { isSoftDelete }  = await import('../core/ddl.js')
  const { statSync, readdirSync } = await import('fs')
  const { createClient }  = await import('../core/client.js')
  const { status: migStatus, apply: migApply, autoMigrate: migAuto,
          create: migCreate, createForDatabase: migCreateForDb } = await import('../core/migrations.js')
  const { diffSchemas, buildPristine, generateMigrationSQL, summariseDiff } = await import('../core/migrate.js')

  const port        = parseInt(getFlag('port') ?? '5001')
  const parseResult = loadSchema(cfg.schema)
  const db     = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: clientDb(parseResult, cfg), encryptionKey: getEncKey() })
  const rawDb  = db.$db
  const rawDbs = db.$rawDbs

  // ── Studio flags ───────────────────────────────────────────────────────────
  // --readonly: block every mutating endpoint (row writes, imports, schema
  //   saves, migrations, maintenance, REPL, non-SELECT SQL, transform runs).
  // --token:    require a bearer token on every /api call — pair with --host
  //   when exposing Studio beyond loopback.
  const READONLY = flag('readonly')   // bare boolean flag — getFlag() returns null for these
  const TOKEN    = getFlag('token') ?? null

  // ── Active database context ────────────────────────────────────────────────
  // Studio normally serves the base client; opening a tenant re-points the
  // data endpoints at that tenant's client. Base migrations/schema editing
  // always target the base project.
  let activeTenant = null
  let activeDb     = db
  let activeRawDb  = rawDb
  let activeRawDbs = rawDbs

  // ── Tenant registry (lazy) ─────────────────────────────────────────────────
  const _schemaDir      = dirname(resolve(cfg.schema))
  // The schema's own block is consulted before the defaults, so Studio's tenant
  // switcher lists the files `litestone tenant list` does. `strategy row` has
  // no files at all, hence the strategy test rather than mere presence.
  const _declaredTenancy = parseResult.schema?.tenancy
    ? resolveTenancy(parseResult.schema, { schemaPath: resolve(cfg.schema) })
    : null
  const _fileTenancy    = _declaredTenancy?.strategy === 'database' ? _declaredTenancy : null
  const _tenantDirOpt   = cfg.tenants?.dir      ? resolve(cfg.tenants.dir)      : (_fileTenancy?.dir      ?? join(_schemaDir, 'tenants'))
  const _tenantRegOpt   = cfg.tenants?.registry ? resolve(cfg.tenants.registry) : (_fileTenancy?.registry ?? join(_schemaDir, 'tenants-registry.db'))
  const tenantsEnabled  = !!cfg.tenants || !!_fileTenancy || existsSync(_tenantRegOpt)
  let   _tenantRegistry = null
  async function getRegistry() {
    if (!_tenantRegistry) {
      const { createTenantRegistry } = await import('../tenant.js')
      _tenantRegistry = await createTenantRegistry({
        parsed:        parseResult,
        path:          resolve(cfg.schema),
        dir:           _tenantDirOpt,
        registry:      _tenantRegOpt,
        migrationsDir: cfg.tenants?.migrationsDir ? resolve(cfg.tenants.migrationsDir) : (existsSync(cfg.migrations) ? cfg.migrations : null),
        encryptionKey: getEncKey() ?? null,
      })
    }
    return _tenantRegistry
  }

  // Build softDeleteMap from the augmented schema so auto-generated models are included
  const softDeleteMap = {}
  for (const model of activeDb.$schema.models)
    softDeleteMap[model.name] = isSoftDelete(model)
  const html        = STUDIO_HTML

  // ── Persistent query log ───────────────────────────────────────────────────
  // Ring buffer fed by $tapQuery — captures every ORM operation Studio's
  // client executes (Browse, edits, REPL, import/export), plus raw SQL-panel
  // queries pushed manually. Newest entries last; capped at QUERY_LOG_MAX.
  const QUERY_LOG_MAX = 2000
  const queryLog = []
  let queryLogSeq = 0
  function pushQueryLog(e) {
    queryLog.push({
      id:        ++queryLogSeq,
      ts:        Date.now(),
      operation: e.operation ?? 'sql',
      model:     e.model ?? null,
      database:  e.database ?? null,
      sql:       typeof e.sql === 'string' ? e.sql : null,
      params:    Array.isArray(e.params) ? e.params.slice(0, 32) : null,
      duration:  typeof e.duration === 'number' ? +e.duration.toFixed(2) : 0,
      rowCount:  e.rowCount ?? null,
      actorId:   e.actorId ?? null,
    })
    if (queryLog.length > QUERY_LOG_MAX) queryLog.splice(0, queryLog.length - QUERY_LOG_MAX)
  }
  const _qlTapped = new WeakSet()
  function tapClient(c) { if (!_qlTapped.has(c)) { c.$tapQuery(pushQueryLog); _qlTapped.add(c) } }
  tapClient(db)

  // Build per-database migration status
  // ── The schema as it is on disk, not as it was at boot ────────────────────
  //
  // Studio parses once at startup and holds the result for the life of the
  // process. Every panel built on that parse describes the file as it was when
  // the server started — and says so with the same confidence it would if the
  // file had not moved. That is the drift the badge exists to report, and the
  // access panel has to read THROUGH it or it would report on a stale surface
  // while telling you the surface has changed.
  //
  // Re-parsed only when the bytes differ, so the common case is a string
  // compare. An edit that does not parse keeps the last good result: a
  // half-typed model should leave the panel showing the last thing that was
  // true, not an empty schema.
  const BOOT_SCHEMA_TEXT = (() => {
    try { return readFileSync(resolve(cfg.schema), 'utf8') } catch { return null }
  })()

  let _liveParse = { text: BOOT_SCHEMA_TEXT, parsed: parseResult }

  function currentSchemaParse() {
    try {
      const text = readFileSync(resolve(cfg.schema), 'utf8')
      if (text === _liveParse.text) return _liveParse.parsed
      // The cache key is the ROOT file's text, so an edit to an imported file
      // alone does not invalidate it. Studio reloads on a touch of the schema
      // it was pointed at; that is the granularity, not a claim about imports.
      const next = parseFile(resolve(cfg.schema))
      if (!next.valid) return _liveParse.parsed
      _liveParse = { text, parsed: next }
      return next
    } catch { return _liveParse.parsed }
  }

  function getAllMigrationStatus() {
    const result = {}
    for (const db of parseResult.schema.databases) {
      if (db.driver === 'jsonl' || db.driver === 'logger') continue
      const handle = rawDbs[db.name]
      if (!handle) continue
      try { result[db.name] = migStatus(handle, join(cfg.migrations, db.name)) } catch { result[db.name] = [] }
    }
    // Single-DB schemas have no database blocks — use main connection
    if (!Object.keys(result).length)
      try { result.main = migStatus(rawDb, cfg.migrations) } catch { result.main = [] }
    return result
  }

  async function getRowCounts() {
    const counts = {}
    const sysDb  = activeDb.asSystem()  // bypass policies — counts should reflect actual data
    for (const model of activeDb.$schema.models) {
      const accessor = modelToAccessor(model.name)
      try { counts[model.name] = await sysDb[accessor].count() } catch { counts[model.name] = 0 }
    }
    return counts
  }

  function getDbStats() {
    try {
      // Use db.$databases — canonical source of { driver, access, path } per named DB.
      // Falls back to a synthetic 'main' entry for single-DB schemas.
      const dbMeta  = activeDb.$databases  // { name: { driver, access, path } }
      const entries = Object.keys(dbMeta).length
        ? Object.entries(dbMeta)
        : [['main', { driver: 'sqlite', path: cfg.db ? resolve(cfg.db) : null }]]

      const databases = []
      let rollupSize = 0, rollupRows = 0, rollupTables = 0, rollupIndexes = 0

      for (const [name, meta] of entries) {
        const { driver = 'sqlite', path: absPath } = meta

        if (driver === 'jsonl' || driver === 'logger') {
          // No SQLite connection — report file/dir size only
          let size = 0
          if (absPath) {
            try {
              const st = statSync(absPath)
              if (st.isDirectory()) {
                size = readdirSync(absPath)
                  .filter(f => f.endsWith('.jsonl'))
                  .reduce((acc, f) => { try { return acc + statSync(`${absPath}/${f}`).size } catch { return acc } }, 0)
              } else {
                size = st.size
              }
            } catch { /* path may not exist yet */ }
          }
          rollupSize += size
          databases.push({ name, driver, size })
          continue
        }

        // SQLite database
        const conn  = activeRawDbs?.[name] ?? activeRawDb
        const entry = { name, driver: 'sqlite', size: 0 }

        if (absPath) {
          try { entry.size = existsSync(absPath) ? statSync(absPath).size : 0 } catch {}
        }

        try {
          entry.pageSize      = conn.query('PRAGMA page_size').get().page_size
          entry.pageCount     = conn.query('PRAGMA page_count').get().page_count
          entry.freelistCount = conn.query('PRAGMA freelist_count').get().freelist_count
          entry.walMode       = conn.query('PRAGMA journal_mode').get().journal_mode === 'wal'
          entry.foreignKeys   = conn.query('PRAGMA foreign_keys').get().foreign_keys === 1

          const tables = conn.query(
            `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`
          ).all().map(r => r.name)

          entry.indexCount  = conn.query(`SELECT COUNT(*) as n FROM sqlite_master WHERE type='index'`).get().n
          entry.tableCount  = tables.length
          entry.tables      = {}
          entry.totalRows   = 0

          for (const t of tables) {
            const n = conn.query(`SELECT COUNT(*) as n FROM "${t}"`).get().n
            entry.tables[t] = n
            entry.totalRows += n
          }

          rollupRows    += entry.totalRows
          rollupTables  += entry.tableCount
          rollupIndexes += entry.indexCount
        } catch (innerErr) {
          entry.error = innerErr.message
        }

        rollupSize += entry.size
        databases.push(entry)
      }

      // cacheSize from main connection
      const cs        = db.$cacheSize
      const cacheSize = cs?.read != null ? cs : (cs?.main ?? { read: 0, write: 0 })

      // Flat fields for the header bar (main DB values)
      const mainEntry = databases.find(d => d.name === 'main') ?? databases[0] ?? {}

      return {
        databases,
        // header rollups
        size:         rollupSize,
        pageCount:    mainEntry.pageCount  ?? 0,
        tableCount:   rollupTables,
        indexCount:   rollupIndexes,
        totalRows:    rollupRows,
        cacheSize,
        // flat shape kept for backwards-compat (perf panel, etc.)
        pageSize:      mainEntry.pageSize,
        freelistCount: mainEntry.freelistCount,
        walMode:       mainEntry.walMode,
        foreignKeys:   mainEntry.foreignKeys,
        tables:        Object.assign({}, ...databases.map(d => d.tables ?? {})),
      }
    } catch (e) {
      console.error('[litestone:studio] getDbStats error:', e)
      return {}
    }
  }
  function json(data, status = 200) {
    return Response.json(data, { status })
  }

  // ── Server-side search / sort helpers for /api/table and /api/export ──────
  // Turns the Browse filter box text into a real WHERE clause: substring match
  // on String fields, exact match on numeric fields when the query is numeric,
  // prefix match on DateTime fields when the query looks date-ish.
  function buildSearchWhere(model, search) {
    const q = typeof search === 'string' ? search.trim() : ''
    if (!q) return undefined
    const or  = []
    const num = Number(q)
    const numeric = q !== '' && !Number.isNaN(num)
    for (const f of model.fields) {
      if (f.type.kind === 'relation' || f.type.array) continue
      if (f.attributes?.some(a => ['computed', 'transient', 'guarded', 'secret', 'encrypted', 'omit'].includes(a.kind))) continue
      const t = f.type.name
      if (t === 'String')                      or.push({ [f.name]: { contains: q } })
      else if ((t === 'Int' || t === 'Float') && numeric) or.push({ [f.name]: num })
      else if (t === 'DateTime' && /^\d{4}(-\d{2})?(-\d{2})?/.test(q)) or.push({ [f.name]: { gte: q, lt: q + '~' } })
    }
    // No matchable protected field fits this query shape → return an impossible
    // filter (empty `in` compiles to 0 = 1) so the result is "no rows"
    // rather than silently unfiltered.
    return or.length ? { OR: or } : { [model.fields[0]?.name ?? 'id']: { in: [] } }
  }

  function buildOrderBySpec(model, orderBy) {
    const hasId = model.fields.some(f => f.name === 'id')
    const fallback = hasId ? { id: 'asc' } : undefined
    if (!orderBy?.col) return fallback
    const f = model.fields.find(f => f.name === orderBy.col && f.type.kind !== 'relation')
    if (!f) return fallback
    const dir  = orderBy.dir === 'desc' ? 'desc' : 'asc'
    // Tie-break on id (when present and not already the sort column) so
    // cursor pagination stays stable on non-unique sort columns.
    return (hasId && orderBy.col !== 'id') ? [{ [orderBy.col]: dir }, { id: 'asc' }] : { [orderBy.col]: dir }
  }

  // ── "Give me this view as a query" ────────────────────────────────────────
  // Browse already builds a real Litestone query object on every load and then
  // throws it away. These render it back so the view can be copied into a
  // service or the REPL.

  // JS source, not JSON: unquoted keys where legal, single quotes, so what is
  // copied can be pasted. JSON.stringify would quote every key and force the
  // reader to edit it before it matches anything else in the codebase.
  // Bumped per generated row so two clicks are not the same row.
  let factorySeq = 0

  const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
  function jsLiteral(v, indent = '') {
    if (v === null || v === undefined) return String(v)
    if (typeof v === 'string')  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
    if (typeof v !== 'object')  return String(v)
    const inner = indent + '  '
    if (Array.isArray(v)) {
      if (!v.length) return '[]'
      const parts = v.map(x => jsLiteral(x, inner))
      const flat  = `[${parts.join(', ')}]`
      return flat.length <= 72 ? flat : `[\n${parts.map(p => inner + p).join(',\n')}\n${indent}]`
    }
    const entries = Object.entries(v).filter(([, val]) => val !== undefined)
    if (!entries.length) return '{}'
    const parts = entries.map(([k, val]) => `${IDENT.test(k) ? k : `'${k}'`}: ${jsLiteral(val, inner)}`)
    const flat  = `{ ${parts.join(', ')} }`
    return flat.length <= 72 ? flat : `{\n${parts.map(p => inner + p).join(',\n')}\n${indent}}`
  }

  // The client flavour is part of the query. A view browsed as a user and the
  // same args run through asSystem() return different rows, so emitting the
  // args alone hands back something that silently does not reproduce the view.
  function buildViewQuery(accessor, authCtx, args) {
    const argsCode = jsLiteral(args)
    const client   = authCtx ? 'db.$setAuth(user)' : 'db.asSystem()'
    // The REPL binds `db` already scoped from the auth selector, so its form
    // states no client — restating one there would scope the call twice.
    return {
      accessor,
      client,
      clientNote: authCtx
        ? `Browsed as ${authCtx.email ?? authCtx.name ?? `#${authCtx.id}`} — \`user\` stands in for that principal.`
        : 'Browsed with no principal selected, which Studio runs as asSystem().',
      args,
      argsCode,
      code:     `await ${client}.${accessor}.findMany(${argsCode})`,
      replCode: `db.${accessor}.findMany(${argsCode})`,
    }
  }

  // Bind to loopback by default — Studio exposes raw SQL, a JS REPL, and
  // schema writes, so it must not listen on all interfaces unless explicitly
  // asked (--host=0.0.0.0 for containers/LAN use).
  const hostname = getFlag('host') ?? '127.0.0.1'
  const server = Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url  = new URL(req.url)
      const path = url.pathname
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}

      if (path === '/' || path === '/index.html')
        return new Response(html, { headers: { 'Content-Type': 'text/html' } })

      if (!path.startsWith('/api/')) return new Response('Not Found', { status: 404 })

      // ── Token auth (--token) ────────────────────────────────────────────────
      if (TOKEN) {
        const given = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || url.searchParams.get('token')
        if (given !== TOKEN) return json({ error: 'Unauthorized — pass ?token= or Authorization: Bearer' }, 401)
      }

      // ── Read-only mode (--readonly) ─────────────────────────────────────────
      if (READONLY) {
        const MUTATING = ['/api/row/', '/api/rows/', '/api/import', '/api/repl', '/api/factory',
          '/api/migrations/apply', '/api/migrations/auto', '/api/migrations/create',
          '/api/maint/', '/api/transform/run', '/api/tenants/migrate', '/api/perf/advisor/fix']
        if (MUTATING.some(p => path.startsWith(p)) && path !== '/api/maint/integrity')
          return json({ error: 'Studio is running in --readonly mode' }, 403)
        if (path === '/api/schema-source' && req.method !== 'GET')
          // allow validation, block the save
          if (!path.endsWith('validate')) return json({ error: 'Studio is running in --readonly mode' }, 403)
        if (path === '/api/query') {
          const q = (body.sql ?? '').trim().toUpperCase()
          if (!/^(SELECT|EXPLAIN|WITH|PRAGMA TABLE_INFO|PRAGMA INDEX_LIST|PRAGMA FOREIGN_KEY_LIST)/.test(q))
            return json({ error: 'Only SELECT/EXPLAIN queries are allowed in --readonly mode' }, 403)
        }
      }

      try {
        if (path === '/api/info') {
          const stats     = getDbStats()
          const counts    = await getRowCounts()
          // Use db.$schema — the augmented schema that includes auto-generated
          // logger models (e.g. auditLogs) and view stubs. parseResult.schema
          // is the raw parsed result and is missing these synthetic models.
          const liveSchema = activeDb.$schema
          const multiDb   = liveSchema.databases.some(db => !db.driver || db.driver === 'sqlite')
          const databases = liveSchema.databases.map(db => ({
            name:   db.name,
            driver: db.driver ?? 'sqlite',
          }))
          return json({
            dbPath:     cfg.db ? resolve(cfg.db) : null,
            schema:     liveSchema,
            softDelete: softDeleteMap,
            stats,
            counts,
            multiDb,
            databases,
            tenantsEnabled,
            activeTenant,
            readonly: READONLY,
          })
        }

        if (path === '/api/table') {
          const { table, cursor, withDeleted = false, auth: authCtx, search, orderBy, pageSize } = body
          const model = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
          if (!model) return json({ error: `Unknown table: ${table}` }, 400)
          const accessor = modelToAccessor(model.name)
          const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
          const limit    = Math.max(10, Math.min(500, parseInt(pageSize) || 50))
          const where    = buildSearchWhere(model, search)
          const ob       = buildOrderBySpec(model, orderBy)
          const result   = await tableDb[accessor].findManyCursor({ cursor, limit, where, withDeleted, orderBy: ob })
          // Filtered total so the UI can show "N matching rows" (best effort)
          let total = null
          try { total = await tableDb[accessor].count({ where, withDeleted }) } catch {}
          const columns  = model.fields
            .filter(f => f.type.kind !== 'relation' && !f.attributes.find(a => a.kind === 'computed' || a.kind === 'transient'))
            .map(f => f.name) ?? []
          // findMany, not findManyCursor: `cursor` is opaque paging state that
          // means nothing pasted elsewhere. The filter and the sort are the
          // parts worth copying, so the query describes page one of this view.
          const query = buildViewQuery(accessor, authCtx, {
            where,
            orderBy: ob,
            limit,
            ...(withDeleted ? { withDeleted: true } : {}),
          })
          return json({ ...result, columns, total, query, paged: Boolean(cursor) })
        }

        // POST /api/row/restore — un-soft-delete a single row
        if (path === '/api/row/restore') {
          const { table, where, auth: authCtx } = body
          if (!table || !where) return json({ error: 'table, where required' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            const result   = await tableDb[accessor].restore({ where })
            return json({ ok: true, count: result?.count ?? 0 })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/rows/bulk — bulk delete / hard-delete / restore by PK list
        if (path === '/api/rows/bulk') {
          const { table, action, ids, auth: authCtx } = body
          if (!table || !action || !Array.isArray(ids) || !ids.length)
            return json({ error: 'table, action, ids[] required' }, 400)
          if (ids.length > 10_000) return json({ error: 'Too many ids (max 10,000 per request)' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const idField  = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
            const where    = { [idField]: { in: ids } }
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            let count = 0
            if (action === 'delete') {
              const r = await tableDb[accessor].removeMany({ where })
              count = r?.count ?? 0
            } else if (action === 'hardDelete') {
              const r = await tableDb[accessor].deleteMany({ where })
              count = r?.count ?? 0
            } else if (action === 'restore') {
              const r = await tableDb[accessor].restore({ where })
              count = r?.count ?? 0
            } else {
              return json({ error: `Unknown action: ${action}` }, 400)
            }
            return json({ ok: true, count })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/export — stream the FULL (filtered) table as CSV or JSON
        if (path === '/api/export') {
          const { table, format = 'json', search, withDeleted = false, auth: authCtx } = body
          const model = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
          if (!model) return json({ error: `Unknown table: ${table}` }, 400)
          const accessor = modelToAccessor(model.name)
          const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
          const where    = buildSearchWhere(model, search)
          const ob       = buildOrderBySpec(model, null)
          const cols     = model.fields
            .filter(f => f.type.kind !== 'relation' && !f.attributes.find(a => a.kind === 'computed' || a.kind === 'transient'))
            .map(f => f.name)
          const enc = new TextEncoder()
          const csvCell = (v) => {
            if (v == null) return ''
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
          }
          const stream = new ReadableStream({
            async start(controller) {
              try {
                let cursor = null
                let first  = true
                controller.enqueue(enc.encode(format === 'csv' ? cols.join(',') + '\n' : '[\n'))
                while (true) {
                  const page = await tableDb[accessor].findManyCursor({ cursor, limit: 1000, where, withDeleted, orderBy: ob })
                  for (const row of page.items) {
                    if (format === 'csv') {
                      controller.enqueue(enc.encode(cols.map(c => csvCell(row[c])).join(',') + '\n'))
                    } else {
                      controller.enqueue(enc.encode((first ? '' : ',\n') + '  ' + JSON.stringify(row)))
                      first = false
                    }
                  }
                  if (!page.hasMore || !page.nextCursor) break
                  cursor = page.nextCursor
                }
                if (format !== 'csv') controller.enqueue(enc.encode('\n]\n'))
                controller.close()
              } catch (e) { controller.error(e) }
            }
          })
          return new Response(stream, { headers: {
            'Content-Type':        format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${accessor}.${format === 'csv' ? 'csv' : 'json'}"`,
          }})
        }

        // POST /api/import — batched row import (client parses CSV/JSON to rows)
        if (path === '/api/import') {
          const { table, rows, auth: authCtx } = body
          if (!table || !Array.isArray(rows) || !rows.length)
            return json({ error: 'table, rows[] required' }, 400)
          if (rows.length > 50_000) return json({ error: 'Too many rows in one request (max 50,000)' }, 400)
          const model = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
          if (!model) return json({ error: `Unknown table: ${table}` }, 400)
          const accessor = modelToAccessor(model.name)
          const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
          const BATCH    = 500
          let inserted   = 0
          const errors   = []
          for (let i = 0; i < rows.length; i += BATCH) {
            const batch = rows.slice(i, i + BATCH)
            try {
              const r = await tableDb[accessor].createMany({ data: batch })
              inserted += r?.count ?? batch.length
            } catch (e) {
              // Batch failed — retry row-by-row so one bad row doesn't sink 500
              for (let j = 0; j < batch.length; j++) {
                try { await tableDb[accessor].create({ data: batch[j] }); inserted++ }
                catch (rowErr) {
                  if (errors.length < 50) errors.push({ row: i + j + 1, error: rowErr.message })
                }
              }
            }
          }
          return json({ ok: errors.length === 0, inserted, failed: rows.length - inserted, errors })
        }

        if (path === '/api/query') {
          const { sql } = body
          if (!sql?.trim()) return json({ rows: [] })
          const t0   = performance.now()
          try {
            const rows = activeRawDb.prepare(sql.trim()).all()
            const ms   = (performance.now() - t0).toFixed(1)
            pushQueryLog({ operation: 'sql', sql: sql.trim(), duration: performance.now() - t0, rowCount: rows.length, database: 'main' })
            return json({ rows, ms })
          } catch (e) {
            pushQueryLog({ operation: 'sql', sql: sql.trim(), duration: performance.now() - t0, rowCount: 0, database: 'main' })
            throw e
          }
        }

        // POST /api/querylog — incremental fetch of the query log ring buffer
        if (path === '/api/querylog') {
          if (body.clear) { queryLog.length = 0; return json({ entries: [], cleared: true }) }
          const after = Number(body.after) || 0
          // Entries are id-ordered; find the first entry newer than `after`
          let start = 0
          if (after > 0) {
            start = queryLog.findIndex(e => e.id > after)
            if (start === -1) return json({ entries: [], latest: queryLogSeq, total: queryLog.length })
          }
          const entries = queryLog.slice(start, start + 500)
          return json({ entries, latest: queryLogSeq, total: queryLog.length })
        }

        if (path === '/api/migrations') {
          const allStatus = getAllMigrationStatus()

          // Build per-database diff summaries for multi-DB schemas
          const diffs = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const { buildPristineForDatabase } = await import('../core/migrate.js')
              const pristineDb  = new Database(':memory:')
              const pristine    = buildPristineForDatabase(pristineDb, parseResult, dbName)
              pristineDb.close()
              const live        = introspect(handle)
              const diffResult  = diffSchemas(pristine, live, parseResult, dbName, { pluralize: cfg.pluralize })
              diffs[dbName] = {
                diff: summariseDiff(diffResult),
                sql:  diffResult.hasChanges ? generateMigrationSQL(diffResult, parseResult, { pluralize: cfg.pluralize }) : null,
              }
            } catch (e) { diffs[dbName] = { diff: e.message, sql: null } }
          }

          return json({ status: allStatus, diffs, multiDb: parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite') })
        }

        // ── GET /api/access ─────────────────────────────────────────────
        // The declared access surface, straight from deriveAccess(). One
        // formatter existed for this — the committed access.snapshot.md — and
        // it is good at being reviewed and bad at being read: 37 rows of
        // "4.4.4.5" answers *what does this model require* and never *what can
        // a level-4 caller do*. Same object, second reader.
        //
        // Read-only by construction, so --readonly needs no case here. The
        // payload is the same information the repo already commits in plain
        // text beside the schema, so it exposes nothing the schema did not.
        if (path === '/api/access') {
          const { deriveAccess } = await import('../access.js')
          return json(deriveAccess(currentSchemaParse().schema))
        }

        // ── GET /api/drift ──────────────────────────────────────────────
        // Three questions that are not the same question, kept apart on
        // purpose: one badge saying "out of date" would blur them.
        //
        //   file      — has schema.lite changed since Studio parsed it?
        //   snapshot  — does the committed access.snapshot.md still match it?
        //   migrations— is anything pending/modified/orphaned?
        //
        // `file` is first because the other two are worthless without it:
        // Studio parses once at boot and holds the result for the life of the
        // process, so an edit made in an editor leaves every panel describing
        // the previous version, confidently.
        if (path === '/api/drift') {
          const out = { file: null, snapshot: null, migrations: null }

          // ── file ──
          try {
            const onDisk = readFileSync(resolve(cfg.schema), 'utf8')
            out.file = {
              path:    rel(resolve(cfg.schema)),
              changed: onDisk !== BOOT_SCHEMA_TEXT,
            }
          } catch (e) { out.file = { error: e.message } }

          // ── snapshot ──
          // Rendered from what is on disk NOW, not from the boot parse, or a
          // schema edited since startup would be compared against itself.
          try {
            const { deriveAccess, renderAccessSnapshot } = await import('../access.js')
            const snapPath = join(dirname(resolve(cfg.schema)), 'access.snapshot.md')
            if (!existsSync(snapPath)) {
              // Absent is not "no drift" — it is "I cannot judge this", the
              // same distinction db.$checkWhere makes for an unknown accessor.
              out.snapshot = { exists: false, path: rel(snapPath) }
            } else {
              const live = currentSchemaParse()
              const body = renderAccessSnapshot(deriveAccess(live.schema),
                                                { source: basename(resolve(cfg.schema)) })
              out.snapshot = {
                exists:  true,
                path:    rel(snapPath),
                current: readFileSync(snapPath, 'utf8') === body,
                command: `litestone access --schema ${rel(resolve(cfg.schema))}`,
              }
            }
          } catch (e) { out.snapshot = { error: e.message } }

          // ── migrations ──
          try {
            const counts = { pending: 0, modified: 0, orphaned: 0 }
            for (const rows of Object.values(getAllMigrationStatus()))
              for (const r of rows) if (counts[r.state] !== undefined) counts[r.state]++
            out.migrations = counts
          } catch (e) { out.migrations = { error: e.message } }

          return json(out)
        }

        // The catalog is the .lite language itself rather than this app's use of
        // it, so it is served whole and never filtered by what the schema
        // happens to declare — a word with no rows is exactly what the explorer
        // exists to show.
        // Positions are computed here rather than sent as a rule the panel
        // re-applies: one implementation of "where is this legal", and the
        // browser gets an answer instead of a second copy of POSITION_RULES.
        if (path === '/api/catalog')
          return json({
            catalog:   CATALOG.map(r => ({ ...r, positions: positionsOf(r), doc: docFor(r) })),
            groups:    GROUPS,
            positions: POSITIONS,
          })

        // The visibility table and the rules, over the schema as it stands. The
        // interview needs the table with no edit in hand, and the rules are
        // worth reading without proposing one.
        if (path === '/api/advise') {
          const { VISIBILITY, PER_CALLER, checkRules, RULES } = await import('../core/advise.js')
          // Two questions about one schema and they are not the same one: a
          // rule is legal-and-wrong, an opportunity is legal-and-missing. One
          // endpoint because a panel asks both at once; two lists because a
          // defect and a suggestion cannot share a severity word.
          const { OPPORTUNITIES, checkOpportunities } = await import('../core/opportunities.js')
          const parsed = currentSchemaParse().schema
          return json({
            visibility:    VISIBILITY,
            perCaller:     PER_CALLER,
            rules:         RULES.map(({ id, severity, title }) => ({ id, severity, title })),
            findings:      checkRules(parsed),
            opportunities: OPPORTUNITIES.map(({ id, confidence, word, title }) => ({ id, confidence, word, title })),
            missing:       checkOpportunities(parsed),
          })
        }

        // What a proposed edit DOES, before it is written. The seed fans out
        // into DDL, an access surface, a JSON Schema and a deploy verdict, and
        // no panel here could see the fan-out — the four are computed in four
        // places and read in four others.
        //
        // Everything is derived from the SUBMITTED text, never from the file, so
        // the answer is about the change rather than about what is on disk. The
        // UI realm is deliberately absent: which control a form renders is
        // sierra's `field-rules.js`, and litestone cannot import sierra without
        // inverting the dependency. A second table here would be the drift the
        // one-owner rule exists to stop.
        if (path === '/api/preview') {
          const { source, model: modelName } = body
          if (typeof source !== 'string') return json({ error: 'preview needs a source' }, 400)

          const { deriveAccess }                        = await import('../access.js')
          const { deriveReleaseSurface, classifyPivot,
                  classifyAccess }                      = await import('../release.js')
          const { generateJsonSchema }                  = await import('../jsonschema.js')
          const { generateModelDDL }                    = await import('../core/ddl.js')
          const { checkRules }                          = await import('../core/advise.js')
          const { checkOpportunities }                  = await import('../core/opportunities.js')

          // Imports are inlined from the file's own directory so a fragment the
          // app imports is in the parse, exactly as it is when Studio boots.
          let after
          try   { after = parse(inlineImports(source, resolve(cfg.schema), {})) }
          catch (e) { return json({ valid: false, errors: [e.message] }) }
          if (!after.valid) return json({ valid: false, errors: after.errors })

          const before = currentSchemaParse()

          // Each pane is asked separately, because parse() is more permissive
          // than the layers above it: a gate string parses and then throws the
          // moment deriveAccess reads it. A preview whose whole job is to say
          // what a word does must answer with the message, not a 500 that says
          // nothing about the other three realms.
          const rejected = []
          const pane = (label, fn) => {
            try { return fn() }
            catch (e) { rejected.push({ pane: label, message: e.message }); return null }
          }

          const forModel = (parsed, side) => {
            const m = parsed.schema.models.find(x => x.name === modelName)
            if (!m) return { ddl: null, access: null, json: null }
            return {
              ddl:    pane(`ddl (${side})`,    () => generateModelDDL(m, parsed.schema)),
              access: pane(`access (${side})`, () => deriveAccess(parsed.schema).models.find(x => x.name === modelName) ?? null),
              json:   pane(`schema (${side})`, () => generateJsonSchema(parsed.schema).$defs?.[modelName] ?? null),
            }
          }

          const a = modelName ? forModel(before, 'before') : {}
          const b = modelName ? forModel(after,  'after')  : {}

          const surfaceBefore = pane('release (before)', () => deriveReleaseSurface(before.schema))
          const surfaceAfter  = pane('release (after)',  () => deriveReleaseSurface(after.schema))
          const both = surfaceBefore && surfaceAfter

          return json({
            valid:   true,
            model:   modelName ?? null,
            ddl:     { before: a.ddl    ?? null, after: b.ddl    ?? null },
            access:  { before: a.access ?? null, after: b.access ?? null },
            json:    { before: a.json   ?? null, after: b.json   ?? null },
            release: both ? pane('release', () => classifyPivot(surfaceBefore, surfaceAfter))  : null,
            reach:   both ? pane('reach',   () => classifyAccess(surfaceBefore, surfaceAfter)) : null,
            rejected,
            // Legal and wrong is a class the parser cannot report, so the
            // findings are about the PROPOSED schema and the ones already true
            // of the file are marked rather than dropped — a warning that was
            // there before this edit is not this edit's fault.
            rules:   diffFindings('rules', checkRules, before, after, pane),
            // Same treatment for the other question: an edit that ADDS a Json
            // column adds a suggestion about it, and one that was already there
            // is not this edit's doing.
            missing: diffFindings('missing', checkOpportunities, before, after, pane),
            warnings: after.warnings ?? [],
          })
        }

        if (path === '/api/stats') return json(getDbStats())

        // POST /api/row/detail — full row + belongsTo parents + hasMany child counts
        if (path === '/api/row/detail') {
          const { table, id, auth: authCtx } = body
          if (!table || id === undefined) return json({ error: 'table, id required' }, 400)
          const model = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
          if (!model) return json({ error: `Unknown table: ${table}` }, 400)
          const accessor = modelToAccessor(model.name)
          const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
          const idField  = model.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
          const row = await tableDb[accessor].findUnique({ where: { [idField]: id }, withDeleted: true }).catch(() => null)
            ?? await tableDb[accessor].findFirst({ where: { [idField]: id } }).catch(() => null)
          if (!row) return json({ error: 'Row not found' }, 404)

          // belongsTo parents — relation fields on THIS model carrying an FK
          const parents = []
          for (const f of model.fields) {
            const rel = f.attributes.find(a => a.kind === 'relation')
            if (!rel?.fields?.length) continue
            const fk     = Array.isArray(rel.fields) ? rel.fields[0] : rel.fields
            const refCol = (Array.isArray(rel.references) ? rel.references[0] : rel.references) ?? 'id'
            if (row[fk] == null) continue
            const targetAccessor = modelToAccessor(f.type.name)
            try {
              const parent = await tableDb[targetAccessor].findFirst({ where: { [refCol]: row[fk] }, withDeleted: true })
              parents.push({ relation: f.name, table: f.type.name, fk, value: row[fk], row: parent })
            } catch { parents.push({ relation: f.name, table: f.type.name, fk, value: row[fk], row: null }) }
          }

          // hasMany children — other models with a belongsTo FK pointing here
          const children = []
          for (const other of activeDb.$schema.models) {
            if (other.name === model.name) continue
            for (const f of other.fields) {
              const rel = f.attributes.find(a => a.kind === 'relation')
              if (!rel?.fields?.length || f.type.name !== model.name) continue
              const fk = Array.isArray(rel.fields) ? rel.fields[0] : rel.fields
              try {
                const count = await tableDb[modelToAccessor(other.name)].count({ where: { [fk]: row[idField] } })
                children.push({ table: other.name, fk, count })
              } catch {}
            }
          }
          return json({ row, idField, parents, children })
        }

        // ── Saved SQL queries (base project, _litestone_ table is ignored by introspection)
        if (path === '/api/queries' && req.method === 'GET') {
          try {
            rawDb.run(`CREATE TABLE IF NOT EXISTS "_litestone_studio_queries" (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, sql TEXT NOT NULL, createdAt TEXT NOT NULL)`)
            return json({ queries: rawDb.query(`SELECT id, name, sql, createdAt FROM "_litestone_studio_queries" ORDER BY name`).all() })
          } catch (e) { return json({ queries: [], error: e.message }) }
        }
        if (path === '/api/queries') {
          if (READONLY) return json({ error: 'Studio is running in --readonly mode' }, 403)
          const { name, sql } = body
          if (!name?.trim() || !sql?.trim()) return json({ error: 'name and sql required' }, 400)
          rawDb.run(`CREATE TABLE IF NOT EXISTS "_litestone_studio_queries" (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, sql TEXT NOT NULL, createdAt TEXT NOT NULL)`)
          rawDb.run(`INSERT INTO "_litestone_studio_queries" (name, sql, createdAt) VALUES (?, ?, ?)
                     ON CONFLICT(name) DO UPDATE SET sql = excluded.sql`, name.trim().slice(0, 80), sql, new Date().toISOString())
          return json({ ok: true })
        }
        if (path === '/api/queries/delete') {
          if (READONLY) return json({ error: 'Studio is running in --readonly mode' }, 403)
          rawDb.run(`DELETE FROM "_litestone_studio_queries" WHERE id = ?`, body.id)
          return json({ ok: true })
        }

        // POST /api/schema-diff — live "what would this edit change" for the editor.
        // Always diffs against the BASE project databases (schema editing is base-scoped).
        if (path === '/api/schema-diff') {
          const { source } = body
          if (typeof source !== 'string') return json({ error: 'source required' }, 400)
          const parsed = parse(source)
          if (!parsed.valid) return json({ valid: false, errors: parsed.errors, diffs: {} })
          const { buildPristineForDatabase } = await import('../core/migrate.js')
          const diffs = {}
          for (const [dbName, handle] of Object.entries(rawDbs)) {
            if (!handle) continue
            try {
              const pristineDb = new Database(':memory:')
              const pristine   = buildPristineForDatabase(pristineDb, parsed, dbName)
              pristineDb.close()
              const live       = introspect(handle)
              const diffResult = diffSchemas(pristine, live, parsed, dbName, { pluralize: cfg.pluralize })
              diffs[dbName] = {
                hasChanges: diffResult.hasChanges,
                summary:    diffResult.hasChanges ? summariseDiff(diffResult) : null,
                sql:        diffResult.hasChanges ? generateMigrationSQL(diffResult, parsed, { pluralize: cfg.pluralize }) : null,
              }
            } catch (e) { diffs[dbName] = { error: e.message } }
          }
          return json({ valid: true, warnings: parsed.warnings ?? [], diffs })
        }

        // POST /api/schema-codemod — migrate renamed scalar types in editor source
        if (path === '/api/schema-codemod') {
          const { source } = body
          if (typeof source !== 'string') return json({ error: 'source required' }, 400)
          let out = source
          let changes = 0
          for (const [from, to] of [['Integer', 'Int'], ['Text', 'String'], ['Real', 'Float'], ['Blob', 'Bytes']]) {
            out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), () => { changes++; return to })
          }
          return json({ source: out, changes })
        }

        // ── Tenant registry ─────────────────────────────────────────────────

        if (path === '/api/tenants') {
          if (!tenantsEnabled) return json({ enabled: false, tenants: [] })
          try {
            const reg = await getRegistry()
            const ids = reg.list()
            const tenants = ids.map(id => {
              const meta = (() => { try { return reg.meta.get(id) } catch { return {} } })()
              let size = 0
              try { const p = join(_tenantDirOpt, `${id}.db`); if (existsSync(p)) size = statSync(p).size } catch {}
              return { id, meta, size, active: id === activeTenant }
            })
            return json({ enabled: true, tenants, openCount: reg.openCount, dir: _tenantDirOpt, activeTenant })
          } catch (e) { return json({ enabled: true, tenants: [], error: e.message }) }
        }

        // POST /api/tenants/open { id } — re-point data endpoints at a tenant.
        // POST /api/tenants/open {} — back to the base project database.
        if (path === '/api/tenants/open') {
          const { id } = body
          if (!id) {
            activeTenant = null; activeDb = db; activeRawDb = rawDb; activeRawDbs = rawDbs
            return json({ ok: true, activeTenant: null })
          }
          try {
            const reg = await getRegistry()
            const tdb = await reg.get(id)
            tapClient(tdb)   // tenant queries appear in the query log too
            activeTenant = id
            activeDb     = tdb
            activeRawDb  = tdb.$db
            activeRawDbs = tdb.$rawDbs
            return json({ ok: true, activeTenant: id })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/tenants/migrate — fleet-wide migration via the registry
        if (path === '/api/tenants/migrate') {
          try {
            const reg = await getRegistry()
            const r = await reg.migrate()
            return json({ ok: !r.failed?.length, ...r })
          } catch (e) { return json({ ok: false, error: e.message }, 400) }
        }

        // ── Maintenance actions ─────────────────────────────────────────────
        // Each iterates the open sqlite connections (skips jsonl/logger).

        if (path === '/api/maint/backup') {
          const { vacuum = false } = body
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          const multi = Object.entries(activeRawDbs).filter(([, h]) => h).length > 1
          const dest  = cfg.db
            ? resolve(dirname(resolve(cfg.db)), `backup-${stamp}${multi ? '' : '.db'}`)
            : resolve(process.cwd(), `backup-${stamp}`)
          const result = await activeDb.$backup(dest, { vacuum })
          return json({ ok: true, dest, result })
        }

        if (path === '/api/maint/vacuum') {
          const results = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const pageSize = handle.query('PRAGMA page_size').get().page_size
              const before   = handle.query('PRAGMA page_count').get().page_count
              handle.run('VACUUM')
              const after    = handle.query('PRAGMA page_count').get().page_count
              results[dbName] = { ok: true, freedBytes: Math.max(0, (before - after) * pageSize), pagesBefore: before, pagesAfter: after }
            } catch (e) { results[dbName] = { ok: false, error: e.message } }
          }
          return json({ ok: true, results })
        }

        if (path === '/api/maint/analyze') {
          const results = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const t0 = performance.now()
              handle.run('PRAGMA analysis_limit=400')
              handle.run('ANALYZE')
              results[dbName] = { ok: true, ms: +(performance.now() - t0).toFixed(0) }
            } catch (e) { results[dbName] = { ok: false, error: e.message } }
          }
          return json({ ok: true, results })
        }

        if (path === '/api/maint/checkpoint') {
          const results = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const r = handle.query('PRAGMA wal_checkpoint(TRUNCATE)').get()
              results[dbName] = { ok: true, busy: r?.busy ?? null, walPages: r?.log ?? null, checkpointed: r?.checkpointed ?? null }
            } catch (e) { results[dbName] = { ok: false, error: e.message } }
          }
          return json({ ok: true, results })
        }

        if (path === '/api/maint/integrity') {
          const results = {}
          let allOk = true
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              const t0   = performance.now()
              const rows = handle.query('PRAGMA quick_check').all()
              const msgs = rows.map(r => Object.values(r)[0])
              const ok   = msgs.length === 1 && msgs[0] === 'ok'
              if (!ok) allOk = false
              results[dbName] = { ok, messages: msgs.slice(0, 20), ms: +(performance.now() - t0).toFixed(0) }
            } catch (e) { allOk = false; results[dbName] = { ok: false, error: e.message } }
          }
          return json({ ok: allOk, results })
        }

        if (path === '/api/maint/optimize-fts') {
          const results = {}
          const sys = activeDb.asSystem()
          for (const model of activeDb.$schema.models) {
            if (!model.attributes?.some(a => a.kind === 'fts')) continue
            const accessor = modelToAccessor(model.name)
            try {
              const t0 = performance.now()
              await sys[accessor].optimizeFts()
              results[model.name] = { ok: true, ms: +(performance.now() - t0).toFixed(0) }
            } catch (e) { results[model.name] = { ok: false, error: e.message } }
          }
          if (!Object.keys(results).length) return json({ ok: true, results, message: 'No @@fts models in schema' })
          return json({ ok: true, results })
        }

        if (path === '/api/maint/rotate-key') {
          const { newKey } = body
          if (!/^[0-9a-fA-F]{64}$/.test(newKey ?? ''))
            return json({ error: 'newKey must be 64 hex characters (32 bytes)' }, 400)
          try {
            const t0    = performance.now()
            const stats = await activeDb.$rotateKey(newKey)
            return json({ ok: true, stats, ms: +(performance.now() - t0).toFixed(0),
                          note: 'Client now uses the new key. Update your ENCRYPTION_KEY env before restarting the app.' })
          } catch (e) { return json({ ok: false, error: e.message }, 400) }
        }

        // GET /api/perf/sizes — per-table + per-index disk usage via dbstat
        if (path === '/api/perf/sizes') {
          const perDb = {}
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            try {
              // dbstat vtab: one row per page — aggregate bytes per object
              const rows = handle.query(
                `SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages FROM dbstat GROUP BY name ORDER BY bytes DESC`
              ).all()
              // Map indexes to their tables + pull stat1 (present after ANALYZE)
              const idxInfo = handle.query(
                `SELECT name, tbl_name FROM sqlite_master WHERE type='index'`
              ).all()
              const idxToTable = Object.fromEntries(idxInfo.map(r => [r.name, r.tbl_name]))
              let stat1 = {}
              try {
                stat1 = Object.fromEntries(handle.query(`SELECT idx, stat FROM sqlite_stat1 WHERE idx IS NOT NULL`).all().map(r => [r.idx, r.stat]))
              } catch {}
              const tables = {}
              for (const r of rows) {
                const owner = idxToTable[r.name] ?? r.name
                if (!tables[owner]) tables[owner] = { table: owner, tableBytes: 0, indexBytes: 0, indexes: [] }
                if (idxToTable[r.name]) {
                  tables[owner].indexBytes += r.bytes
                  tables[owner].indexes.push({ name: r.name, bytes: r.bytes, stat: stat1[r.name] ?? null })
                } else {
                  tables[owner].tableBytes += r.bytes
                }
              }
              perDb[dbName] = { ok: true, tables: Object.values(tables).sort((a, b) => (b.tableBytes + b.indexBytes) - (a.tableBytes + a.indexBytes)) }
            } catch {
              // dbstat requires SQLITE_ENABLE_DBSTAT_VTAB (not compiled into
              // Bun's SQLite) — fall back to sampled payload estimation:
              // sum column byte-lengths over up to 1,000 rows, scale by count.
              try {
                const tableNames = handle.query(
                  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'`
                ).all().map(r => r.name)
                const idxInfo = handle.query(`SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL`).all()
                let stat1 = {}
                try {
                  stat1 = Object.fromEntries(handle.query(`SELECT idx, stat FROM sqlite_stat1 WHERE idx IS NOT NULL`).all().map(r => [r.idx, r.stat]))
                } catch {}
                const tables = []
                for (const t of tableNames) {
                  try {
                    const n = handle.query(`SELECT COUNT(*) AS n FROM "${t}"`).get().n
                    let bytes = 0
                    if (n > 0) {
                      const cols = handle.query(`PRAGMA table_info("${t}")`).all().map(c => c.name)
                      const expr = cols.map(c => `COALESCE(LENGTH(CAST("${c}" AS BLOB)),0)`).join(' + ')
                      const avg  = handle.query(`SELECT AVG(len) AS a FROM (SELECT (${expr}) AS len FROM "${t}" LIMIT 1000)`).get().a ?? 0
                      bytes = Math.round(avg * n * 1.15)   // ~15% page/btree overhead
                    }
                    tables.push({
                      table: t, tableBytes: bytes, indexBytes: null, estimated: true,
                      indexes: idxInfo.filter(i => i.tbl_name === t).map(i => ({ name: i.name, bytes: null, stat: stat1[i.name] ?? null })),
                    })
                  } catch {}
                }
                tables.sort((a, b) => b.tableBytes - a.tableBytes)
                perDb[dbName] = { ok: true, estimated: true, tables }
              } catch (e2) {
                perDb[dbName] = { ok: false, error: e2.message }
              }
            }
          }
          return json({ perDb })
        }

        // POST /api/migrations/apply — apply pending migration files
        if (path === '/api/migrations/apply') {
          const multi   = parseResult.schema.databases.some(d => !d.driver || d.driver === 'sqlite')
          const results = {}
          let   applied = 0
          let   failed  = false
          for (const [dbName, handle] of Object.entries(activeRawDbs)) {
            if (!handle) continue
            const dir = multi ? join(cfg.migrations, dbName) : cfg.migrations
            try {
              // Pass the live client so JS migrations get full ORM access
              const r = await migApply(handle, dir, db)
              const ok = (r.applied ?? []).filter(a => a.ok)
              applied += ok.length
              if (r.failed) failed = true
              results[dbName] = { applied: ok.map(a => ({ file: a.file, elapsed: a.elapsed })),
                                  failed: r.failed ?? null, error: r.error ?? null, message: r.message ?? null }
            } catch (e) { failed = true; results[dbName] = { error: e.message } }
          }
          return json({ ok: !failed, applied, results })
        }

        // POST /api/migrations/auto — dev autoMigrate (applies diff directly)
        if (path === '/api/migrations/auto') {
          try {
            const results = migAuto(db, parseResult, { pluralize: cfg.pluralize, force: true })
            const summary = {}
            for (const [dbName, r] of Object.entries(results))
              summary[dbName] = { state: r.state, applied: r.applied ?? 0, sql: r.sql ?? null, reason: r.reason ?? null }
            return json({ ok: true, results: summary })
          } catch (e) { return json({ ok: false, error: e.message }, 400) }
        }

        // POST /api/migrations/create — write a migration file from the pending diff
        if (path === '/api/migrations/create') {
          const { label } = body
          const cleanLabel = String(label || 'studio').slice(0, 60)
          const multi   = parseResult.schema.databases.some(d => !d.driver || d.driver === 'sqlite')
          const results = {}
          let   created = 0
          try {
            for (const [dbName, handle] of Object.entries(activeRawDbs)) {
              if (!handle) continue
              const dir = multi ? join(cfg.migrations, dbName) : cfg.migrations
              const r = multi
                ? migCreateForDb(handle, parseResult, dbName, cleanLabel, dir, { pluralize: cfg.pluralize })
                : migCreate(handle, parseResult, cleanLabel, dir, { pluralize: cfg.pluralize })
              if (r.created) created++
              results[dbName] = { created: r.created, file: r.name ?? null, path: r.filePath ?? null, message: r.message ?? null, summary: r.summary ?? null }
            }
            return json({ ok: true, created, results })
          } catch (e) { return json({ ok: false, error: e.message }, 400) }
        }

        // GET /api/schema-source — return raw schema.lite text + path
        if (path === '/api/schema-source' && req.method === 'GET') {
          const absPath = resolve(cfg.schema)
          try {
            const source = readFileSync(absPath, 'utf8')
            return json({ source, path: absPath })
          } catch (e) {
            return json({ error: `Cannot read schema: ${e.message}` }, 500)
          }
        }

        // POST /api/schema-validate — validate schema.lite without saving
        if (path === '/api/schema-validate') {
          const { source } = body
          if (typeof source !== 'string') return json({ error: 'source required' }, 400)
          const result = parse(source)
          return json({ valid: result.valid, errors: result.errors, warnings: result.warnings ?? [] })
        }

        // POST /api/schema-source — validate + save schema.lite
        if (path === '/api/schema-source') {
          const { source } = body
          if (typeof source !== 'string') return json({ error: 'source required' }, 400)
          const result = parse(source)
          if (!result.valid) return json({ valid: false, errors: result.errors, warnings: result.warnings ?? [] })
          // Valid — write to disk
          const absPath = resolve(cfg.schema)
          writeFileSync(absPath, source, 'utf8')
          return json({ valid: true, errors: [], warnings: result.warnings ?? [] })
        }

        // POST /api/perf/advisor/fix — write an advisor's fix into schema.lite
        //
        // The schema is the source, so the fix belongs there rather than in a
        // hand-run CREATE INDEX: an index litestone did not name is one no later
        // migration will ever drop. Writing the attribute does NOT create the
        // index — a migration still has to run, and the response says so rather
        // than letting a green toast imply the table changed.
        if (path === '/api/perf/advisor/fix') {
          const { model: modelName, columns } = body
          if (!modelName || !Array.isArray(columns) || !columns.length)
            return json({ error: 'model and columns[] required' }, 400)
          const absPath = resolve(cfg.schema)
          try {
            const source = readFileSync(absPath, 'utf8')
            const lines  = source.split('\n')

            // Locate the model block by brace depth rather than by regex over
            // the whole file — a doc comment inside a model may contain braces,
            // and `model X {` may sit anywhere in a multi-model file.
            const openIdx = lines.findIndex(l => new RegExp(`^\\s*model\\s+${modelName}\\s*\\{`).test(l))
            if (openIdx < 0) return json({ error: `model ${modelName} not found in ${absPath}` }, 400)
            let depth = 0, closeIdx = -1
            for (let i = openIdx; i < lines.length; i++) {
              const bare = lines[i].replace(/\/\/.*$/, '').replace(/\/\/\/.*$/, '')
              for (const ch of bare) { if (ch === '{') depth++; else if (ch === '}') depth-- }
              if (depth === 0) { closeIdx = i; break }
            }
            if (closeIdx < 0) return json({ error: `model ${modelName} block is not closed` }, 400)

            const attr = `@@index([${columns.join(', ')}])`
            const body_ = lines.slice(openIdx + 1, closeIdx)
            if (body_.some(l => l.replace(/\s/g, '').includes(attr.replace(/\s/g, ''))))
              return json({ error: `${modelName} already declares ${attr}` }, 400)

            // Sit with the other model attributes when there are any, so the
            // block keeps the shape the rest of the file uses.
            const lastAttr = body_.reduce((acc, l, i) => /^\s*@@/.test(l) ? i : acc, -1)
            const at       = lastAttr >= 0 ? openIdx + 1 + lastAttr + 1 : closeIdx
            const indent   = (body_.find(l => l.trim())?.match(/^\s*/)?.[0]) ?? '  '
            const next     = [...lines]
            next.splice(at, 0, `${indent}${attr}`)
            const updated  = next.join('\n')

            const parsed = parse(updated)
            if (!parsed.valid) return json({ error: `Would not parse: ${parsed.errors?.[0]?.message ?? 'unknown'}` }, 400)
            writeFileSync(absPath, updated, 'utf8')
            return json({
              ok: true, added: attr, model: modelName, line: at + 1, path: absPath,
              note: 'Written to the schema. The index does not exist until a migration runs.',
            })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // GET /api/perf/advisor — schema-level index analysis
        if (path === '/api/perf/advisor') {
          const issues = []
          const models = activeDb.$schema.models
          const { modelToTableName } = await import('../core/ddl.js')
          const pluralize = cfg.pluralize ?? false

          for (const model of models) {
            // `sqlite_master.tbl_name` holds the name as written at CREATE TABLE
            // time, and SQL string equality is case-sensitive even though SQLite
            // resolves identifiers case-insensitively. Querying for the MODEL
            // name ("User") against a table created as "user" matched nothing,
            // so every index looked absent and every FK was reported unindexed.
            const modelName = model.name
            const tableName = modelToTableName(model, pluralize)

            // A model assigned to a jsonl/logger database has no SQLite indexes
            // to be missing, and lives in a different handle if it has any.
            const dbName = model.attributes?.find(a => a.kind === 'db')?.name ?? 'main'
            if ((activeDb.$databases?.[dbName]?.driver ?? 'sqlite') !== 'sqlite') continue
            const handle = activeRawDbs?.[dbName] ?? activeRawDb
            if (!handle) continue

            // PRAGMA rather than parsing sqlite_master.sql, for two reasons:
            // an implicit UNIQUE index has sql = NULL (so a `sql IS NOT NULL`
            // filter hides every @@unique behind a false positive), and the
            // pragma hands back columns already in order instead of a regex
            // over DDL text that also has to survive partial-index predicates.
            let existingIndexes = []
            try {
              existingIndexes = handle.query(`PRAGMA index_list("${tableName}")`).all().map(r => ({
                name:    r.name,
                unique:  Boolean(r.unique),
                columns: handle.query(`PRAGMA index_info("${r.name}")`).all()
                  .sort((a, b) => a.seqno - b.seqno).map(c => c.name).filter(Boolean),
              }))
            } catch { continue }   // table not created yet — migrations pending
            const idxColumnsOf = idx => idx.columns
            // Only the LEADING column of an index makes a lookup on that column
            // fast — SQLite uses a leftmost prefix. Counting every column meant
            // an index on (username, accountId) was read as covering accountId,
            // which is the false negative that hides a real scan.
            const indexedCols = new Set(existingIndexes.map(idx => idxColumnsOf(idx)[0]).filter(Boolean))

            // 1. FK columns without indexes
            const fkFields = model.fields.filter(f =>
              f.attributes.some(a => a.kind === 'relation' && a.fields?.length)
            )
            for (const field of fkFields) {
              const relAttr = field.attributes.find(a => a.kind === 'relation')
              const fkCols  = relAttr?.fields ?? []
              for (const col of fkCols) {
                if (!indexedCols.has(col)) {
                  issues.push({
                    severity:    'red',
                    title:       `Missing FK index on ${modelName}.${col}`,
                    table:       modelName,
                    description: `Foreign key column "${col}" on "${modelName}" has no leading index, so any read that starts from the OTHER side scans this table — the parent's hasMany (include({ ${modelName.toLowerCase()}s: true })), a where on "${col}", and ON DELETE CASCADE. Reading the parent from here (include({ ${field.name}: true })) is not affected: that resolves by primary key.`,
                    impact:      'Measured on 50k rows: 2,000 lookups by this column take 4.0s unindexed vs 56ms indexed (72×), and a cascade delete of 200 parents 656ms vs 8ms (83×). The index costs ~1.7× on insert and ~60% more disk.',
                    fix:         { kind: 'index', model: modelName, columns: [col] },
                    sql:         `CREATE INDEX "idx_${tableName}_${col}" ON "${tableName}" ("${col}");`,
                    notes:       `SQLite does not index foreign key columns for you. Declare it — @@index([${col}]) on ${modelName} — and migrate, so the index carries the name litestone manages; one created by hand survives every later migration.`,
                  })
                }
              }
            }

            // 2. Soft-delete tables: deletedAt should be indexed
            const hasSoftDelete = model.attributes.some(a => a.kind === 'softDelete')
            if (hasSoftDelete && !indexedCols.has('deletedAt')) {
              issues.push({
                severity:    'yellow',
                title:       `No index on ${modelName}.deletedAt`,
                table:       modelName,
                description: `"${modelName}" uses @@softDelete but "deletedAt" is not indexed. Every query filters "WHERE deletedAt IS NULL" — without an index this scans the full table.`,
                impact:      'All findMany/findFirst/count calls filter on deletedAt. This becomes slower as rows accumulate.',
                sql:         `CREATE INDEX "idx_${tableName}_deletedAt" ON "${tableName}" ("deletedAt");`,
                notes:       'A partial index (WHERE deletedAt IS NULL) is even better but requires SQLite 3.8+.',
                fix:         { kind: 'index', model: modelName, columns: ['deletedAt'] },
              })
            }

            // 3. @@index declared in schema but not in live db
            const declaredIndexes = model.attributes.filter(a => a.kind === 'index' || a.kind === 'unique')
            for (const attr of declaredIndexes) {
              const cols     = attr.fields ?? []
              const isUnique = attr.kind === 'unique'
              // Check if any existing index covers exactly these cols
              const covered = existingIndexes.some(idx => {
                const idxCols = idxColumnsOf(idx)
                return cols.length === idxCols.length && cols.every((c, i) => c === idxCols[i])
              })
              if (!covered && cols.length) {
                const idxName = `idx_${tableName}_${cols.join('_')}`
                issues.push({
                  severity:    'red',
                  title:       `Pending ${isUnique ? 'unique ' : ''}index on ${modelName}`,
                  table:       modelName,
                  description: `Schema declares @@${isUnique ? 'unique' : 'index'}([${cols.join(', ')}]) on "${modelName}" but this index doesn't exist in the live database. Run a migration to create it.`,
                  impact:      'Queries filtering or sorting on these columns are doing full table scans.',
                  sql:         `CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX "${idxName}" ON "${tableName}" (${cols.map(c => `"${c}"`).join(', ')});`,
                  notes:       'Run "litestone migrate apply" to apply pending schema changes.',
                })
              }
            }

            // 4. High row-count tables with no indexes at all (except PK)
            try {
              const rowCount = handle.query(`SELECT COUNT(*) as n FROM "${tableName}"`).get().n
              const nonPkIndexes = existingIndexes.filter(idx => !idx.name.startsWith('sqlite_'))
              if (rowCount > 5000 && nonPkIndexes.length === 0) {
                issues.push({
                  severity:    'yellow',
                  title:       `Large table with no indexes: ${modelName}`,
                  table:       modelName,
                  description: `"${modelName}" has ${rowCount.toLocaleString()} rows but only a primary key index. Any WHERE clause on non-PK columns will scan all rows.`,
                  impact:      'Queries filtering by non-PK columns are doing full table scans across all rows.',
                  sql:         null,
                  notes:       'Add @@index([column]) to your schema for columns you filter or sort by frequently.',
                })
              }
            } catch {}
          }

          return json({ issues })
        }

        // POST /api/perf/analyze — EXPLAIN QUERY PLAN for a SQL statement
        if (path === '/api/perf/analyze') {
          const { sql } = body
          if (!sql?.trim()) return json({ error: 'sql is required' }, 400)
          try {
            const planRows = activeRawDb.prepare(`EXPLAIN QUERY PLAN ${sql.trim()}`).all()

            // Parse each plan row into a rated node. A temp sort can only be
            // explained against the whole plan and the table's real indexes,
            // so the context travels with every line.
            const ctx = { sql: sql.trim(), planRows, db: activeRawDb }
            const nodes = planRows.map(row => {
              const detail = row.detail ?? ''
              return { detail, ...parsePlanDetail(detail, ctx) }
            })

            // Overall score 0–5
            const hasRed    = nodes.some(n => n.rating === 'red')
            const hasYellow = nodes.some(n => n.rating === 'yellow')
            const score = hasRed ? 1 : hasYellow ? 3 : 5

            const summary = hasRed
              ? 'This query has full table scans. Add indexes on the columns in your WHERE clause.'
              : hasYellow
              ? 'This query could be faster. A temp sort or subquery was detected.'
              : 'This query is using indexes efficiently.'

            return json({ nodes, score, summary })
          } catch(e) {
            return json({ error: e.message }, 400)
          }
        }

        // POST /api/transform/preview — preview row counts without writing
        if (path === '/api/transform/preview') {
          const { srcDb, steps } = body
          if (!srcDb) return json({ error: 'srcDb is required' }, 400)
          const absDb = resolve(srcDb)
          if (!existsSync(absDb)) return json({ error: `DB not found: ${absDb}` }, 404)
          try {
            const { Database } = await import('bun:sqlite')
            const { introspectSQL } = await import('../transform/framework.js')
            const tmpDb = new Database(absDb, { readonly: true })
            const rawSchema = introspectSQL(tmpDb)
            const source = {}
            for (const [t] of Object.entries(rawSchema)) {
              source[t] = tmpDb.query(`SELECT COUNT(*) as n FROM "${t}"`).get().n
            }
            // Apply simple row-reducing steps for estimate
            const tables = { ...source }
            for (const s of (steps ?? [])) {
              if ((s.type === 'drop-table' || s.type === 'truncate') && tables[s.target] !== undefined) {
                if (s.type === 'truncate') tables[s.target] = 0
                else delete tables[s.target]
              }
              if (s.type === 'limit' || s.type === 'sample') {
                const tgts = s.target === 'all' ? Object.keys(tables) : [s.target]
                for (const t of tgts) {
                  if (tables[t] !== undefined) {
                    const n = parseFloat(s.n)
                    if (!isNaN(n) && n < tables[t]) tables[t] = Math.floor(n)
                  }
                }
              }
            }
            const { statSync } = await import('fs')
            const { size: dbSize } = statSync(absDb)
            const totalRows = Object.values(source).reduce((a, b) => a + b, 0)
            const bpr = totalRows > 0 ? dbSize / totalRows : 0
            const estBytes = Object.values(tables).reduce((a, b) => a + b * bpr, 0)
            tmpDb.close()
            return json({ source, tables, estimatedBytes: Math.round(estBytes) })
          } catch (e) {
            return json({ error: e.message }, 500)
          }
        }

        // POST /api/transform/run — execute a pipeline
        if (path === '/api/transform/run') {
          const { srcDb, outPath, steps, filenameFn } = body
          if (!srcDb) return json({ error: 'srcDb is required' }, 400)
          const absDb = resolve(srcDb)
          if (!existsSync(absDb)) return json({ error: `DB not found: ${absDb}` }, 404)
          if (!steps?.length) return json({ error: 'No steps provided' }, 400)
          try {
            const { $, execute } = await import('../transform/framework.js')
            const { run }        = await import('../transform/runner.js')

            // Build pipeline from serialized steps
            const pipeline = steps.map(s => {
              const t = s.target === 'all' ? $.all : $[s.target]
              switch (s.type) {
                case 'scope':       return t.scope(s.sql)
                case 'filter':      return t.filter(s.sql)
                case 'limit':       return t.limit(s.n)
                case 'sample':      return t.sample(s.n)
                case 'drop-col':    return t.drop(...(s.cols||'').split(',').map(c => c.trim()).filter(Boolean))
                case 'keep':        return t.keep(...(s.cols||'').split(',').map(c => c.trim()).filter(Boolean))
                case 'mask':        return t.mask(s.col, s.strategy)
                case 'rename':      return t.rename(s.from, s.to)
                case 'set':         return t.set(s.col, eval(s.expr)) // eslint-disable-line no-eval
                case 'redact':      return t.redact(s.mode === 'both' ? undefined : s.mode)
                case 'drop-table':  return $[s.target].drop()
                case 'truncate':    return $[s.target].truncate()
                case 'drop-except': return $.any.dropExcept(...(s.keep||'').split(',').map(c => c.trim()).filter(Boolean))
                case 'shard':       return $.shard(s.target)
                default: return null
              }
            }).filter(Boolean)

            const resolvedOut = outPath ? resolve(outPath) : null
            const t0 = performance.now()
            const lines = []
            const origLog = console.log.bind(console)
            console.log = (...a) => { lines.push(a.join(' ')); origLog(...a) }

            const outputs = []
            const result = await execute(
              absDb,
              { verbose: true, outputPath: resolvedOut },
              run,
              pipeline,
            ).catch(e => { throw e })
            .finally(() => { console.log = origLog })

            const ms = Math.round(performance.now() - t0)
            const outFiles = (Array.isArray(result) ? result : [result]).filter(Boolean)
            const { statSync } = await import('fs')
            for (const f of outFiles) {
              try { outputs.push({ path: f, size: statSync(f).size }) } catch {}
            }
            return json({ ok: true, ms, lines, outputs })
          } catch (e) {
            return json({ error: e.message }, 500)
          }
        }

        // POST /api/repl — evaluate a Litestone client expression
        if (path === '/api/repl') {
          const { code } = body
          if (!code?.trim()) return json({ result: null })
          try {
            // Wrap in AsyncFunction so top-level await and bare expressions both work
            const wrappedCode = code.trim().includes('\n') || !code.trim().startsWith('db.')
              ? `return (async () => { ${code} })()`
              : `return (async () => (${code}))()`

            // Compile outside the timed region — new Function() JIT cost is not DB cost
            // sys = activeDb.asSystem() — bypasses all @@allow/@@deny policies, useful for debugging
            // db = scoped to current auth context (or no-auth if none selected)
            const { auth: replAuth } = body
            const replDb = replAuth ? activeDb.$setAuth(replAuth) : activeDb.asSystem()
            const fn = new Function('db', 'sys', wrappedCode)

            // Capture all ORM queries fired during this execution via $tapQuery
            const sqlLog = []
            const stopTap = activeDb.$tapQuery(e => sqlLog.push(e))

            const t0     = performance.now()
            let result, execError
            try {
              result = await fn(replDb, activeDb.asSystem())
            } catch (e) {
              execError = e
            } finally {
              stopTap()
            }

            const execMs = (performance.now() - t0).toFixed(1)
            if (execError) return json({ error: execError.message, sqlLog })

            // Response.json handles serialization natively in Bun (JSC-optimized)
            return Response.json({ result: result ?? null, execMs, sqlLog })
          } catch (e) {
            return json({ error: e.message })
          }
        }

        // GET /api/auth-users — returns rows from the @@auth model for the auth picker
        if (path === '/api/auth-users') {
          const authModel = activeDb.$schema.models.find(m =>
            m.attributes.some(a => a.kind === 'auth')
          ) ?? activeDb.$schema.models.find(m => m.name === 'User' || m.name === 'users')
          if (!authModel) return json({ users: [], modelName: null })
          try {
            const rows = await activeDb.asSystem()[modelToAccessor(authModel.name)].findMany({ limit: 50 })
            return json({ users: rows, modelName: authModel.name })
          } catch { return json({ users: [], modelName: authModel.name }) }
        }

        // POST /api/row/update — update a single row
        if (path === '/api/row/update') {
          const { table, where, data: rowData, auth: authCtx } = body
          if (!table || !where || !rowData) return json({ error: 'table, where, data required' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            const result   = await tableDb[accessor].update({ where, data: rowData })
            return json({ ok: true, row: result })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/row/create — insert a new row
        if (path === '/api/row/create') {
          const { table, data: rowData, auth: authCtx } = body
          if (!table || !rowData) return json({ error: 'table, data required' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            const result   = await tableDb[accessor].create({ data: rowData })
            return json({ ok: true, row: result })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        // POST /api/factory — create one plausible row from the schema alone
        //
        // The same generator the test realm uses, pointed at the live database.
        // Two properties are the point rather than conveniences:
        //   · withParents() fills every required belongsTo recursively, so the
        //     row satisfies its own FKs — which is why a click can write to
        //     several tables and why the response says which ones.
        //   · it runs as the principal the sidebar selects, so a @@gate refusal
        //     here is the gate working, not the button failing.
        if (path === '/api/factory') {
          const { table, auth: authCtx, asSystem: forceSystem, pins } = body
          if (!table) return json({ error: 'table required' }, 400)
          try {
            const { factoryFrom } = await import('../testing.js')
            const schema = activeDb.$schema
            const model  = schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            // A model names its database with @@db(name); no attribute is main.
            // There is no modelDbMap on $schema — the attribute is the mapping.
            const dbName = model.attributes?.find(a => a.kind === 'db')?.name ?? 'main'
            const driver = activeDb.$databases?.[dbName]?.driver ?? 'sqlite'
            if (driver !== 'sqlite')
              return json({ error: `${model.name} lives in a ${driver} database — append-only, nothing to generate into` }, 400)

            // Asked for explicitly, never a silent fallback: the refusal is the
            // useful answer, and a button that quietly escalates past a gate
            // teaches you the gate is not there.
            const factoryDb = (forceSystem || !authCtx) ? activeDb.asSystem() : activeDb.$setAuth(authCtx)
            // withParents() resolves a parent through the registry, so every
            // model needs an entry and they must share one object — the graph
            // is cyclic and a factory built per lookup would recurse forever.
            const registry = {}
            for (const m of schema.models) registry[modelToAccessor(m.name)] = factoryFrom(schema, m.name, factoryDb, registry)

            // Unseeded output is deliberately plain and deterministic; a seed is
            // what makes fake.js hand back real words for known field names.
            // Counter rather than a constant, so two clicks differ.
            // A pin is sent as an id and re-read HERE, through the same client
            // the factory will write with — otherwise pinning would be a side
            // channel that hands a principal a row its own policy hides.
            const pinRows = {}
            for (const [pinModel, pinId] of Object.entries(pins ?? {})) {
              const pm = schema.models.find(m => m.name === pinModel)
              if (!pm) continue                       // stale pin for a model that went away
              const idField = pm.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
              const seen = await factoryDb[modelToAccessor(pm.name)].findFirst({ where: { [idField]: pinId } })
              if (!seen) return json({
                error: `Pinned ${pinModel} is not visible to this principal — unpin it, or switch who you are acting as`,
              }, 400)
              pinRows[pinModel] = seen
            }

            const created = []
            const stopTap = activeDb.$tapQuery(e => { if (e.operation === 'create') created.push(e.model) })
            let row
            try {
              row = await registry[modelToAccessor(model.name)]
                .seed(++factorySeq)
                .withParents({ pins: pinRows })
                .createOne()
            } finally { stopTap() }

            const tally = []
            for (const t of created) {
              const hit = tally.find(x => x.table === t)
              if (hit) hit.count++
              else tally.push({ table: t, count: 1 })
            }
            return json({ ok: true, row, created: tally, asSystem: Boolean(forceSystem || !authCtx) })
          } catch (e) {
            // A gate refusal is a different kind of answer from a bad row, and
            // only it has a sensible retry. Discriminate on the error, never on
            // the wording of its message.
            const denied = e.name === 'AccessDeniedError' || e.code === 'ACCESS_DENIED'
            return json({ error: e.message, retryAsSystem: denied && !forceSystem && Boolean(authCtx) }, 400)
          }
        }

        // POST /api/row/delete — delete a single row
        if (path === '/api/row/delete') {
          const { table, where, soft, auth: authCtx } = body
          if (!table || !where) return json({ error: 'table, where required' }, 400)
          try {
            const model    = activeDb.$schema.models.find(m => m.name === table || modelToAccessor(m.name) === table)
            if (!model) return json({ error: `Unknown table: ${table}` }, 400)
            const accessor = modelToAccessor(model.name)
            const tableDb  = authCtx ? activeDb.$setAuth(authCtx) : activeDb.asSystem()
            if (soft) await tableDb[accessor].remove({ where })
            else      await tableDb[accessor].delete({ where })
            return json({ ok: true })
          } catch (e) { return json({ error: e.message }, 400) }
        }

        return json({ error: 'Not found' }, 404)
      } catch (e) {
        return json({ error: e.message }, 500)
      }
    },
  })

  const displayHost = (hostname === '127.0.0.1' || hostname === '0.0.0.0') ? 'localhost' : hostname
  // server.port, never the requested one: `--port=0` asks the OS for any free
  // port, and printing the request back prints `:0`. That is what makes 0 the
  // right thing for a test to ask for — a fixed number, however unlikely, can
  // be taken by whatever else the run is doing.
  const url = `http://${displayHost}:${server.port}`
  console.log(`  ${green('✓')}  Studio at ${cyan(url)}${hostname !== '127.0.0.1' ? dim(`  (listening on ${hostname})`) : ''}`)
  // Which file is this? Asked of the SCHEMA first, because a declaration wins
  // over `cfg.db` — the same rule `clientDb()` applies when building the client.
  // Testing `cfg.db` instead made this branch unreachable: `cfg.db` defaults to
  // './development.db', so every app that declares its databases was told it was
  // on a file it had never opened, and the branch that names the real ones had
  // never run (`FJS-449`).
  //
  // Printed relative to the CWD, so a path that is not below it leads with `..`
  // — which is the signal that this command was typed somewhere unexpected.
  const _declared = parseResult.schema?.databases?.filter(d => !d.driver || d.driver === 'sqlite') ?? []
  if (_declared.length) {
    for (const d of _declared) {
      const absPath = resolveDbPath(d.path, null, schemaAnchor(cfg.schema))
      if (absPath) console.log(`  ${dim(`db (${d.name}):`)}  ${rel(absPath)}`)
    }
  } else if (cfg.db) console.log(`  ${dim('db:')}     ${rel(resolve(cfg.db))}`)
  console.log(`  ${dim('Press Ctrl+C to stop')}\n`)

  // Open browser
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open'
  try { Bun.spawn([opener, url]) } catch {}
}


// ─── JSON Schema ──────────────────────────────────────────────────────────────

async function cmdTypes(outArg, cfg) {
  // --stdout means the output is being piped into a file. The banner goes to
  // stdout, so printing it first put "litestone types" at the top of the .d.ts.
  if (!flag('stdout')) header('litestone types')

  const { generateTypeScript } = await import('./typegen.js')
  // statSync already imported at top level
  const parseResult = loadSchema(cfg.schema)

  const audience    = getFlag('audience') ?? 'client'
  const toStdout    = flag('stdout')
  const outputPath  = getFlag('out') ?? outArg
  const onlyFlag    = getFlag('only')
  const onlyModels  = onlyFlag ? new Set(onlyFlag.split(',').map(s => s.trim())) : null

  const augment     = getFlag('augment') ?? null

  if (!['client','system'].includes(audience))
    fatal(`--audience must be "client" or "system"`)
  if (augment && augment !== 'junction')
    fatal(`--augment takes only "junction"`)

  // Filter schema to only requested models if --only is specified
  const schema = onlyModels
    ? { ...parseResult.schema, models: parseResult.schema.models.filter(m => onlyModels.has(m.name)) }
    : parseResult.schema

  const dts    = generateTypeScript(schema, { audience, augment })
  const models = schema.models.length
  const enums  = parseResult.schema.enums.length

  if (toStdout) {
    process.stdout.write(dts)
    return
  }

  const schemaName = resolve(cfg.schema).replace(/\.lite(stone)?$/, '')
  const outPath    = outputPath ? resolve(outputPath) : `${schemaName}.d.ts`

  writeFileSync(outPath, dts, 'utf8')
  const { size } = statSync(outPath)

  console.log(`  ${green('✓')}  ${rel(outPath)}  ${dim(`(${(size/1024).toFixed(1)}kb)`)}`)
  console.log(`  ${dim(`${models} model${models!==1?'s':''}, ${enums} enum${enums!==1?'s':''}, audience=${audience}`)}`)
  console.log()
  console.log(`  ${dim('--out=<path>')}              ${dim('default: schema path + .d.ts')}`)
  console.log(`  ${dim('--stdout')}                  ${dim('print to stdout instead of writing a file')}`)
  console.log(`  ${dim('--audience=client|system')}  ${dim('client strips @guarded/@secret  (default: client)')}`)
  console.log(`  ${dim('--augment=junction')}        ${dim('also type client.service(name) in the browser')}`)
  console.log()
}

async function cmdJsonSchema(cfg) {
  // Same trap as cmdTypes: `litestone jsonschema --stdout > schema.json` wrote
  // the banner into the file, so the JSON did not parse.
  if (!flag('stdout')) header('litestone jsonschema')

  const { generateJsonSchema } = await import('../jsonschema.js')
  const parseResult = loadSchema(cfg.schema)

  // ── --snapshot ───────────────────────────────────────────────────────────
  //
  // The committed, reviewable form of the same document. Generation is the
  // command's own job either way; this is a second RENDERING, not a second
  // generator — the raw JSON is what ships, and thousands of lines of it is
  // where a removed keyword hides.
  if (flag('snapshot')) { await jsonSchemaSnapshot(cfg, parseResult); return }

  const format            = getFlag('format') ?? 'definitions'
  const mode              = getFlag('mode')   ?? 'create'
  const outputPath        = getFlag('out')
  const toStdout          = flag('stdout')
  const includeTimestamps = flag('include-timestamps')
  const includeDeletedAt  = flag('include-deleted-at')
  const allModes          = flag('all-modes')

  if (!['definitions','flat'].includes(format))
    fatal(`--format must be "definitions" or "flat"`)
  if (!['create','update','full'].includes(mode) && !allModes)
    fatal(`--mode must be "create", "update", or "full"`)

  const schemaName = resolve(cfg.schema).replace(/\.lite(stone)?$/, '')
  // No includeComputed here on purpose: generateJsonSchema never read such an
  // option, so the flag that used to be advertised did nothing. Computed,
  // generated and @from fields are a property of mode:'full'.
  const opts       = { format, includeTimestamps, includeDeletedAt }

  if (toStdout) {
    const schema = generateJsonSchema(parseResult.schema, { ...opts, mode })
    process.stdout.write(JSON.stringify(schema, null, 2) + '\n')
    return
  }

  if (allModes) {
    for (const m of ['create', 'update', 'full']) {
      const outPath = outputPath
        ? resolve(outputPath, `schema.${m}.json`)
        : `${schemaName}.${m}.json`
      const schema  = generateJsonSchema(parseResult.schema, { ...opts, mode: m })
      writeFileSync(outPath, JSON.stringify(schema, null, 2))
      const { size } = statSync(outPath)
      console.log(`  ${green('✓')}  ${rel(outPath)}  ${dim(`(${size}b)`)}`)
    }
  } else {
    const outPath = outputPath
      ? existsSync(outputPath) && statSync(outputPath).isDirectory()
        ? resolve(outputPath, 'schema.json')
        : resolve(outputPath)
      : `${schemaName}.json`

    const schema = generateJsonSchema(parseResult.schema, { ...opts, mode })
    writeFileSync(outPath, JSON.stringify(schema, null, 2))
    const { size } = statSync(outPath)
    console.log(`  ${green('✓')}  ${rel(outPath)}  ${dim(`(${(size/1024).toFixed(1)}kb)`)}`)

    const models = parseResult.schema.models.length
    const enums  = parseResult.schema.enums.length
    console.log(`  ${dim(`${models} model${models!==1?'s':''}, ${enums} enum${enums!==1?'s':''}, mode=${mode}, format=${format}`)}`)
  }

  console.log()
  console.log(`  ${dim('--out=<path>')}               ${dim('default: schema path + .json')}`)
  console.log(`  ${dim('--stdout')}                   ${dim('print to stdout instead of writing a file')}`)
  console.log(`  ${dim('--mode=create|update|full')}  ${dim('(default: create)')}`)
  console.log(`  ${dim('--all-modes')}                ${dim('generate create + update + full')}`)
  console.log(`  ${dim('--format=definitions|flat')}  ${dim('(default: definitions)')}`)
  console.log(`  ${dim('--include-timestamps')}       ${dim('include createdAt/updatedAt')}`)
  console.log(`  ${dim('--include-deleted-at')}       ${dim('include deletedAt')}`)
  console.log()
}

// ─── JSON Schema snapshot ────────────────────────────────────────────────────
//
// litestone jsonschema --snapshot           — write jsonschema.snapshot.md
// litestone jsonschema --snapshot --check   — exit 1 if the committed file is stale
//
// The bridge with three readers (junction validation, sierra's field rules, ui's
// <Form>) and no build that breaks when it changes shape.

async function jsonSchemaSnapshot(cfg, parseResult) {
  const { renderJsonSchemaSnapshot } = await import('./jsonschema-snapshot.js')

  const schemaPath = resolve(cfg.schema)
  const outPath    = getFlag('out')
    ? resolve(getFlag('out'))
    : resolve(dirname(schemaPath), 'jsonschema.snapshot.md')

  // BASENAME, for the reason cmdAccess and cmdDdl use one: the file is
  // byte-compared, and a cwd-relative path renders differently from the app
  // directory and from the repo root.
  const body = renderJsonSchemaSnapshot(parseResult.schema, { source: basename(schemaPath) })

  if (flag('stdout')) { process.stdout.write(body); return }

  if (flag('check')) {
    checkSnapshot(outPath, body, {
      regen: 'litestone jsonschema --snapshot',
      moved: 'The client contract changed. Run `litestone jsonschema --snapshot` and review the diff before committing.',
    })
    console.log()
    return
  }

  writeFileSync(outPath, body, 'utf8')
  const { size } = statSync(outPath)
  console.log(`  ${green('✓')}  ${rel(outPath)}  ${dim(`(${(size/1024).toFixed(1)}kb)`)}`)
  console.log()
}


// ─── explain ─────────────────────────────────────────────────────────────────

/**
 * The findings a proposed edit leaves, with the ones that were already there
 * marked rather than dropped.
 *
 * A warning that predates the edit is not the edit's fault, and hiding it would
 * make a card look clean while the file is not. Both questions want this and
 * both wanted it identically, which is the whole argument for one function:
 * the key is (id, model, field), because that triple is what "the same finding"
 * means for a rule and for an opportunity alike.
 */
function diffFindings(label, check, before, after, pane) {
  const now  = pane(`${label} (after)`,  () => check(after.schema))  ?? []
  const was  = pane(`${label} (before)`, () => check(before.schema)) ?? []
  const key  = f => `${f.id}:${f.model}:${f.field}`
  const seen = new Set(was.map(key))
  return now.map(f => ({ ...f, preexisting: seen.has(key(f)) }))
}

async function cmdAdvise(cfg) {
  const { checkRules }         = await import('../core/advise.js')
  const { checkOpportunities } = await import('../core/opportunities.js')
  const { docFor, lookup }     = await import('../core/catalog.js')

  // loadSchema, never parse(): a schema may `import`, and only parseFile
  // resolves that. Three readers had this wrong and each failed silently.
  const parsed = loadSchema(cfg.schema).schema
  const rules  = checkRules(parsed)
  const missed = checkOpportunities(parsed)

  if (flag('json')) {
    process.stdout.write(JSON.stringify({ rules, opportunities: missed }, null, 2) + '\n')
    return
  }

  header('litestone advise')

  const tone = { error: red, warn: yellow, info: dim, likely: yellow, possible: dim }
  const show = (rows, key, lead) => {
    if (!rows.length) return
    console.log(`  ${bold(lead)}`)
    for (const r of rows) {
      const mark = (tone[r[key]] ?? dim)(r[key].padEnd(9))
      const at   = r.model ? `${r.model}${r.field ? '.' + r.field : ''}` : ''
      console.log(`  ${mark} ${cyan(at)}`)
      for (const line of wrapText(r.message, 72)) console.log(`             ${line}`)
      // The line that makes this a route rather than a verdict: an opportunity
      // names the word it is about, so the next thing to type is printed.
      if (r.word) {
        const row = lookup(r.word)
        console.log(`             ${dim('litestone explain')} ${cyan(r.word)}` +
                    (row && docFor(row) ? `   ${dim(docFor(row))}` : ''))
      }
      console.log()
    }
  }

  const order = { error: 0, warn: 1, info: 2 }
  show([...rules].sort((a, b) => order[a.severity] - order[b.severity]), 'severity',
       `Legal and worth a look — ${rules.length}`)
  show([...missed].sort((a, b) => (a.confidence === 'likely' ? 0 : 1) - (b.confidence === 'likely' ? 0 : 1)),
       'confidence', `Declared by nobody — ${missed.length}`)

  if (!rules.length && !missed.length)
    console.log(`  ${green('✓')}  nothing to say about this schema.\n`)
  else
    console.log(`  ${dim('neither list is a build failure. `fli test:access --strict` and `release:check` are the gates.')}\n`)
}


async function cmdExplain(word) {
  const { CATALOG, GROUPS, POSITIONS, POSITION_RULES, positionsOf, typed, lookup, grouped, docFor } =
    await import('../core/catalog.js')
  const { VISIBILITY, PER_CALLER } = await import('../core/advise.js')

  const asJson = flag('json')

  // The question that runs the other way: not "what is this word" but "I need a
  // column nobody may read — which word is that?" Three answers, one row.
  if (flag('visibility')) {
    if (asJson) { process.stdout.write(JSON.stringify({ visibility: VISIBILITY, perCaller: PER_CALLER }, null, 2) + '\n'); return }
    header('litestone explain --visibility')
    console.log(`  ${dim('column'.padEnd(8))}${dim('caller writes'.padEnd(15))}${dim('caller reads'.padEnd(14))}${dim('word')}`)
    for (const r of VISIBILITY) {
      const yn = b => (b ? 'yes' : 'no')
      const answer = r.word ? cyan('@' + r.word) : dim(r.answer)
      console.log(`  ${yn(r.stored).padEnd(8)}${yn(r.callerWrites).padEnd(15)}${yn(r.callerReads).padEnd(14)}${answer}`)
    }
    console.log(`  ${dim('—'.padEnd(8))}${dim('—'.padEnd(15))}${dim('depends'.padEnd(14))}${cyan(PER_CALLER.answer)}`)
    console.log()
    for (const line of wrapText(PER_CALLER.note, 76)) console.log(`  ${dim(line)}`)
    console.log()
    return
  }

  if (!word) {
    if (asJson) { process.stdout.write(JSON.stringify(CATALOG, null, 2) + '\n'); return }
    header('litestone explain')
    for (const level of ['schema', 'field', 'model']) {
      const label = level === 'schema' ? 'Declarations' : level === 'field' ? 'Field attributes' : 'Model attributes'
      console.log(`  ${bold(label)}`)
      for (const g of grouped(level)) {
        console.log(`    ${dim(g.title)}`)
        console.log('      ' + g.rows.map(r => cyan(typed(r))).join('  '))
      }
      console.log()
    }
    console.log(`  ${dim('litestone explain @guarded')}   one word`)
    console.log(`  ${dim('litestone explain --json')}     the whole table`)
    console.log()
    return
  }

  // A bare word may exist at two levels with different meanings. Showing both
  // beats picking one: @unique constrains a column and @@unique constrains a
  // tuple, and a reader who typed neither prefix wanted to be told that.
  const bare  = String(word).replace(/^@@?/, '')
  const typedPrefix = String(word).startsWith('@')
  const rows  = typedPrefix
    ? [lookup(word)].filter(Boolean)
    : CATALOG.filter(r => r.word === bare)

  if (!rows.length) {
    const near = suggestWords(CATALOG, bare, typed)
    if (asJson) { process.stdout.write(JSON.stringify({ error: `unknown word: ${word}`, near }) + '\n'); process.exitCode = 1; return }
    console.log()
    console.log(`  ${red('✗')}  ${bold(word)} is not a word this language has.`)
    if (near.length) console.log(`     ${dim('did you mean')} ${near.map(cyan).join('  ')}`)
    console.log(`     ${dim('litestone explain')} ${dim('lists every one')}`)
    console.log()
    process.exitCode = 1
    return
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(rows.map(r => ({ ...r, positions: positionsOf(r), doc: docFor(r) })), null, 2) + '\n')
    return
  }

  console.log()
  for (const row of rows) {
    console.log(`  ${bold(cyan(typed(row)))} ${dim(row.arity || '')}`)
    if (row.removed) console.log(`  ${red('removed')} — use ${cyan(row.replacedBy)}`)
    console.log()
    for (const line of wrapText(row.blurb, 76)) console.log(`  ${line}`)
    console.log()

    const where = positionsOf(row)
    const ordinary = row.level === 'field' ? 3 : row.level === 'model' ? 2 : 1
    if (where.length !== ordinary)
      console.log(`  ${dim('legal')}      ${where.map(p => POSITIONS[p] ?? p).join(', ')}`)

    for (const v of row.values ?? [])
      console.log(`  ${dim(v.arg.padEnd(10))} ${v.of.map(e => typeof e === 'string' ? e : e.value).join(' · ')}`)

    if (row.excludes?.length) console.log(`  ${dim('not with')}   ${row.excludes.map(w => cyan('@' + w)).join(' ')}`)
    if (row.seeAlso?.length)  console.log(`  ${dim('see also')}   ${row.seeAlso.map(cyan).join(' ')}`)
    // `see also` leads to another word; this is the only line that leads out of
    // the catalog, which is the difference between finding a word and using it.
    if (docFor(row))          console.log(`  ${dim('read more')}  ${cyan(docFor(row))}`)
    if (row.note) { console.log(); for (const line of wrapText(row.note, 76)) console.log(`  ${dim(line)}`) }

    console.log()
    const example = (row.context ? row.context + '\n\n' : '') + row.example
    for (const line of example.split('\n')) console.log(`    ${green(line)}`)
    console.log()

    // The visibility table is the answer to a question this word is one of five
    // answers to, so it is worth naming here rather than only in Studio.
    // Five field attributes are answers to one question, and knowing which four
    // you did NOT pick is most of understanding the one you did.
    const vis = VISIBILITY.find(v => v.word === row.word) ?? (row.word === PER_CALLER.word ? PER_CALLER : null)
    if (vis && row.level === 'field')
      console.log(`  ${dim('one of five answers to the same question —')} ${cyan('litestone explain --visibility')}\n`)
  }

  if (rows.length > 1)
    console.log(`  ${dim('two words, one spelling — the prefix picks which:')} ${rows.map(r => cyan(typed(r))).join('  ')}`)
  console.log()
}

/** Closest words to a miss: a substring hit first, then one edit away. */
function suggestWords(catalog, bare, typedFn) {
  const all  = catalog.map(r => ({ r, w: r.word }))
  const sub  = all.filter(x => x.w.includes(bare) || bare.includes(x.w))
  const near = all.filter(x => editDistance(x.w, bare) <= 2)
  const seen = new Set()
  return [...sub, ...near]
    .filter(x => !seen.has(typedFn(x.r)) && seen.add(typedFn(x.r)))
    .slice(0, 6)
    .map(x => typedFn(x.r))
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1))
  return d[a.length][b.length]
}

function wrapText(text, width) {
  const out = []
  let line = ''
  for (const w of String(text).split(/\s+/)) {
    if (line && (line + ' ' + w).length > width) { out.push(line); line = w }
    else line = line ? line + ' ' + w : w
  }
  if (line) out.push(line)
  return out
}

// ─── Snapshot --check ────────────────────────────────────────────────────────
//
// The half every snapshot command shares. A snapshot is a byte compare — the
// file is what the schema produces now or it is stale — and the useful output is
// the lines that moved, not the fact that something did.
//
// Exits the process rather than returning a verdict: a stale snapshot IS the
// failure, and a caller that forgot to read a return value would pass CI in
// silence. `scripts/ci.mjs`'s snapshots phase reruns the command in the header
// of each committed snapshot with --check appended, so every generator that
// writes one has to answer this way.

function checkSnapshot(outPath, body, { regen, moved }) {
  if (!existsSync(outPath))
    fatal(`No snapshot at ${rel(outPath)} — run \`${regen}\` and commit it.`)

  const committed = readFileSync(outPath, 'utf8')
  if (committed === body) {
    console.log(`  ${green('✓')}  ${rel(outPath)} is current`)
    return
  }

  const was = committed.split('\n')
  const now = body.split('\n')
  const changed = []
  for (let i = 0; i < Math.max(was.length, now.length); i++) {
    if (was[i] === now[i]) continue
    changed.push(`    ${red('-')} ${was[i] ?? dim('(absent)')}`)
    changed.push(`    ${green('+')} ${now[i] ?? dim('(absent)')}`)
    if (changed.length >= 20) break
  }

  console.log(`  ${red('✗')}  ${rel(outPath)} does not match the schema\n`)
  console.log(changed.join('\n'))
  if (changed.length >= 20) console.log(`    ${dim('…')}`)
  console.log()
  console.log(`  ${dim(moved)}`)
  console.log()
  process.exit(1)
}


// ─── Access snapshot ─────────────────────────────────────────────────────────
//
// litestone access             — write access.snapshot.md beside the schema
// litestone access --check     — exit 1 if the committed file is stale
// litestone access --stdout    — print it
// litestone access --json      — the structured table instead of the markdown
// litestone access --from=<ref>— what this branch did to who may do what
//
// --check is the CI half. Committing the snapshot is what makes a gate change
// reviewable; nothing enforces that it was regenerated except this.
//
// --from is the other question and it writes nothing. The snapshot says what IS
// and a reviewer needs what MOVED — "this branch drops User.role's @allow" is a
// sentence no diff of the schema file says out loud, because a removed line is
// the absence of a rule and reads like tidying.

async function cmdAccess(cfg) {
  const toStdout = flag('stdout')
  const asJson   = flag('json')
  const check    = flag('check')
  const from     = getFlag('from')

  if (from) return cmdAccessDiff(cfg, from, { asJson, strict: flag('strict') })
  if (getFlag('for')) return cmdAccessFor(cfg, getFlag('for'), { asJson })

  // Same trap as cmdTypes and cmdJsonSchema: a banner printed to stdout ends up
  // inside the file when the caller redirects.
  if (!toStdout) header('litestone access')

  const { deriveAccess, renderAccessSnapshot } = await import('../access.js')
  const parseResult = loadSchema(cfg.schema)
  const access      = deriveAccess(parseResult.schema)

  const schemaPath = resolve(cfg.schema)
  const outPath    = getFlag('out')
    ? resolve(getFlag('out'))
    : resolve(dirname(schemaPath), asJson ? 'access.snapshot.json' : 'access.snapshot.md')

  // The schema is named by BASENAME, not by a path relative to cwd: the file is
  // byte-compared by --check, and a cwd-relative path made the same schema
  // render differently from the app directory and from the repo root.
  const body = asJson
    ? JSON.stringify(access, null, 2) + '\n'
    : renderAccessSnapshot(access, { source: basename(schemaPath) })

  if (toStdout) { process.stdout.write(body); return }

  const { counts } = access
  const summary = `${counts.models} models · ${counts.gated} gated · ${counts.unrestricted} unrestricted · ` +
                  `${counts.policied} policied · ${counts.protected} with protected fields`

  if (check) {
    checkSnapshot(outPath, body, {
      regen: 'litestone access',
      moved: 'Access changed. Run `litestone access` and review the diff before committing.',
    })
    console.log(`  ${dim(summary)}`)
    console.log()
    return
  }

  writeFileSync(outPath, body, 'utf8')
  const { size } = statSync(outPath)

  console.log(`  ${green('✓')}  ${rel(outPath)}  ${dim(`(${(size/1024).toFixed(1)}kb)`)}`)
  console.log(`  ${dim(summary)}`)

  if (counts.unrestricted)
    console.log(`  ${yellow('!')}  ${counts.unrestricted} model${counts.unrestricted!==1?'s':''} declare neither @@gate nor @@allow — every caller reaches every row`)

  console.log()
  console.log(`  ${dim('--check')}          ${dim('exit 1 if the committed snapshot is stale (CI)')}`)
  console.log(`  ${dim('--from=<ref>')}     ${dim('what moved since that release — widens, narrows or undecidable')}`)
  console.log(`  ${dim('--json')}           ${dim('the structured table instead of the markdown')}`)
  console.log(`  ${dim('--stdout')}         ${dim('print instead of writing a file')}`)
  console.log(`  ${dim('--out=<path>')}     ${dim('default: access.snapshot.md beside the schema')}`)
  console.log()
}

// ─── the permission diff ─────────────────────────────────────────────────────
//
// The comparison is `classifyAccess`, which is `classifyPivot`'s own walk read
// on the other axis — one derivation, two verdicts. They disagree constantly and
// that is the point: removing a `@@gate` is an EXPAND for the deploy (nothing
// N-1 does starts failing) and the widest thing a schema change can do, so a
// reviewer handed the deploy severity reads green on the change that should stop
// them.
//
// --strict fails on a widening OR on no baseline, for the reason `release
// --strict` does: it asks a question about safety and "I could not tell" is not
// an answer to it.

// What `--strict` lets through. `new` is in it because a model the baseline
// never had is reported rather than graded — nobody could do anything with a
// table that did not exist, so it cannot be a widening, and a gate that failed
// on it would fail every branch that adds a table (`FJS-444`).
const ACCESS_STRICT_OK = new Set(['unchanged', 'new', 'narrows'])

// `litestone access --for <who>` — what can this person do.
//
// `FJS-D148` names this command and names it a CALLER: the answer comes from
// `db.$capabilitiesFor`, so a support screen asking live and an operator asking
// here cannot drift. Everything else in `access` describes the DECLARED surface
// and needs no database; this one is a join over rows and opens one.
//
// The person is found through the same resolver `tinker --as` uses, read through
// asSystem() — you are an operator looking somebody up, so finding the row must
// not depend on what that row is allowed to see.
//
// **It answers what is true NOW and says so.** *What could Ada do in March* is a
// different question that no argument to this command can answer, because the
// roles have changed since; it is only answerable from what the audit trail
// recorded at the time. Printing a date here would make this look like it
// answered that.
async function cmdAccessFor(cfg, who, { asJson }) {
  if (!asJson) header('litestone access --for')

  const { createClient } = await import('../core/client.js')
  const parseResult = loadSchema(cfg.schema)

  const base = await createClient({
    parsed:        parseResult,
    db:            clientDb(parseResult, cfg),
    encryptionKey: getEncKey(),
  })
  const sys = base.asSystem()

  const found = await findPrincipal(sys, base.$schema, who)
  if (!found.model)
    fatal(`This schema does not say which model holds people.\n` +
          `     Mark it ${cyan('@@auth')} — or name it here: ${cyan('--for Customer:' + who)}.`)
  if (!found.row)
    fatal(`No ${cyan(found.model)} row matches ${cyan(found.needle)}.\n` +
          `     Tried ${found.tried.join(', ')}.`)

  const answer = base.$capabilitiesFor(found.row)
  const label  = found.row.email ?? found.row.username ?? found.row.name ?? `#${found.row.id}`

  if (asJson) {
    process.stdout.write(JSON.stringify({ subject: label, model: found.model, ...answer }, null, 2) + '\n')
    await base.$close()
    return
  }

  console.log(`  ${dim(found.model)}  ${cyan(label)}`)
  console.log()

  if (!answer.held.length && !answer.unknown.length) {
    console.log(`  ${dim('holds no capabilities')}`)
    // Not the same as "is refused everything": a model declaring no
    // @@capabilities is graded by its gate and its policies alone, and this
    // command says nothing about those.
    console.log(`  ${dim('Only models declaring @@capabilities are graded this way.')}`)
  }

  for (const [model, targets] of Object.entries(answer.byModel))
    console.log(`  ${model.padEnd(24)} ${targets.join(' · ')}`)

  if (answer.unknown.length) {
    console.log()
    console.log(`  ${yellow('!')}  ${answer.unknown.length} name${answer.unknown.length !== 1 ? 's' : ''} this schema no longer declares:`)
    for (const n of answer.unknown) console.log(`     ${n}`)
    console.log(`     ${dim('A capability is a reference, so renaming one leaves the old string in the row.')}`)
    console.log(`     ${dim('These grant nothing. `litestone access --from <ref>` computes the rewrite.')}`)
  }

  console.log()
  console.log(`  ${dim('This is what is true now. What somebody could do in the past is only')}`)
  console.log(`  ${dim('answerable from the audit trail, which records it at the time.')}`)
  console.log()

  await base.$close()
}

async function cmdAccessDiff(cfg, from, { asJson, strict }) {
  if (!asJson) header('litestone access')

  const { deriveReleaseSurface, classifyAccess, formatAccessDiff, capabilityDrift } = await import('../release.js')

  const schemaPath = resolve(cfg.schema)
  const after      = deriveReleaseSurface(loadSchema(cfg.schema).schema)

  const baseline = loadBaselineSchema(from, schemaPath)
  const before   = baseline.text ? parseBaseline(baseline.text, false, deriveReleaseSurface) : null
  const result   = before?.surface ? classifyAccess(before.surface, after) : null

  // What a rename COST, beside what it means. A capability is a reference, so a
  // renamed referent leaves the old string in every grant column — and the
  // migration engine cannot see it, because a move rename emits identical DDL.
  // This comparison reads two schemas, which is the only place it is computable.
  const drift = before?.surface ? capabilityDrift(before.surface, after) : null

  if (asJson) {
    process.stdout.write(JSON.stringify({
      baseline: { from, label: baseline.label, resolved: !!before?.surface, note: before?.error ?? before?.note ?? baseline.note ?? null },
      verdict:  result?.verdict ?? 'unknown',
      counts:   result?.counts  ?? { widens: 0, unknown: 0, narrows: 0 },
      findings: result?.findings ?? [],
      ...(drift?.lost.length ? { capabilityDrift: drift } : {}),
    }, null, 2) + '\n')
    if (strict && !ACCESS_STRICT_OK.has(result?.verdict)) process.exit(1)
    return
  }

  if (!result) {
    console.log(`  ${yellow('!')}  no baseline — ${before?.error ?? baseline.note}`)
    console.log()
    if (strict) process.exit(1)
    return
  }

  if (before?.note) console.log(`  ${yellow('!')}  ${before.note}`)

  const mark  = result.verdict === 'widens' ? red('✗') : result.verdict === 'unknown' ? yellow('!') : green('✓')
  const lines = formatAccessDiff(result, { baseline: baseline.label })
  console.log(`  ${mark}  ${lines[0]}`)
  for (const line of lines.slice(1)) console.log(line ? `  ${line}` : '')
  console.log()
  if (drift?.lost.length) {
    console.log(`  ${yellow('!')}  ${drift.lost.length} capability name${drift.lost.length !== 1 ? 's' : ''} disappeared, and ` +
                `${drift.columns.length ? `${drift.columns.length} column${drift.columns.length !== 1 ? 's' : ''} hold${drift.columns.length !== 1 ? '' : 's'} grants` : 'nothing in this schema holds grants'}`)
    console.log(`     ${dim('A capability is a reference. The old string stays in every row and grants nothing —')}`)
    console.log(`     ${dim('and `migrate create` cannot see this: a renamed move emits identical DDL.')}`)
    console.log()

    for (const r of drift.renames) console.log(`     ${green('→')}  ${r.from}  becomes  ${r.to}   ${dim(`(${r.why})`)}`)
    for (const n of drift.ambiguous) console.log(`     ${yellow('?')}  ${n}  ${dim('— gone, and nothing pairs with it unambiguously')}`)

    if (drift.sql.length) {
      console.log()
      console.log(`     ${dim('The rewrite, for a migration file:')}`)
      for (const q of drift.sql) console.log(`     ${q}`)
    }
    if (drift.ambiguous.length) {
      console.log()
      console.log(`     ${dim('The unpaired ones are not guessed: a wrong rewrite hands one role')}`)
      console.log(`     ${dim("another's authority and looks like it worked. Decide those by hand.")}`)
    }
    console.log()
  }
  console.log(`  ${dim('--strict')}  ${dim('exit 1 unless the verdict is narrows, new or unchanged (CI)')}`)
  console.log(`  ${dim('--json')}    ${dim('the diff as data')}`)
  console.log()

  if (strict && !ACCESS_STRICT_OK.has(result.verdict)) process.exit(1)
}


// ─── DDL snapshot ────────────────────────────────────────────────────────────
//
// litestone ddl             — write ddl.snapshot.sql beside the schema
// litestone ddl --check     — exit 1 if the committed file is stale
// litestone ddl --stdout    — print it
//
// The tables, indexes, triggers and views a fresh database is built from. A
// migration shows what CHANGED; this shows what IS, which is what an app's
// hand-written SQL binds to and what a rewritten emitter silently renames.

async function cmdDdl(cfg) {
  const toStdout = flag('stdout')
  const check    = flag('check')

  // Same trap as cmdAccess: a banner printed to stdout ends up inside the file
  // when the caller redirects.
  if (!toStdout) header('litestone ddl')

  const { renderDdlSnapshot } = await import('./ddl-snapshot.js')
  const parseResult = loadSchema(cfg.schema)
  const pluralize   = flag('pluralize') || (cfg.pluralize ?? false)

  const schemaPath = resolve(cfg.schema)
  const outPath    = getFlag('out')
    ? resolve(getFlag('out'))
    : resolve(dirname(schemaPath), 'ddl.snapshot.sql')

  // BASENAME, not a cwd-relative path — the file is byte-compared by --check,
  // and a path would render differently from the app directory and from the
  // repo root.
  const body = renderDdlSnapshot(parseResult.schema, { source: basename(schemaPath), pluralize })

  if (toStdout) { process.stdout.write(body); return }

  const dbCount = parseResult.schema.databases?.length || 1
  const summary = `${parseResult.schema.models.length} models · ${dbCount} database${dbCount === 1 ? '' : 's'}` +
                  (pluralize ? ' · pluralized table names' : '')

  if (check) {
    checkSnapshot(outPath, body, {
      regen: 'litestone ddl',
      moved: 'The emitted schema changed. Run `litestone ddl` and review the diff before committing.',
    })
    console.log(`  ${dim(summary)}`)
    console.log()
    return
  }

  writeFileSync(outPath, body, 'utf8')
  const { size } = statSync(outPath)

  console.log(`  ${green('✓')}  ${rel(outPath)}  ${dim(`(${(size/1024).toFixed(1)}kb)`)}`)
  console.log(`  ${dim(summary)}`)
  console.log()
  console.log(`  ${dim('--check')}       ${dim('exit 1 if the committed snapshot is stale (CI)')}`)
  console.log(`  ${dim('--stdout')}      ${dim('print instead of writing a file')}`)
  console.log(`  ${dim('--pluralize')}   ${dim('pluralized table names (default: from config)')}`)
  console.log(`  ${dim('--out=<path>')}  ${dim('default: ddl.snapshot.sql beside the schema')}`)
  console.log()
}


// ─── Release — the pivot classifier ──────────────────────────────────────────
//
// litestone release                  — write release.snapshot.md, classify against HEAD
// litestone release --check          — exit 1 if the committed snapshot is stale
// litestone release --from=v1.2.0    — classify against the schema at any ref, or a file
// litestone release --strict         — exit 1 unless the verdict is expand or unchanged
// litestone release --json           — the verdict as data, nothing written
//
// A deploy replaces code and does not replace the rows already written, so the
// question is whether the release still serving and the release starting can
// share one database. Expand: yes, and the deploy can be taken back. Contract:
// no, and that deploy is the pivot.
//
// --check is deliberately a staleness check and nothing else. It is what the
// snapshots CI phase reruns out of the file's own header, and a check that also
// needed git would fail in a tarball rather than in a repository.

async function cmdRelease(cfg) {
  const toStdout = flag('stdout')
  const asJson   = flag('json')
  const check    = flag('check')
  const strict   = flag('strict')

  // Same trap as cmdAccess: a banner printed to stdout ends up inside the file
  // when the caller redirects.
  if (!toStdout && !asJson) header('litestone release')

  const { deriveReleaseSurface, renderReleaseSnapshot, classifyPivot, formatVerdict } =
    await import('../release.js')

  const parseResult = loadSchema(cfg.schema)
  const pluralize   = flag('pluralize') || (cfg.pluralize ?? false)
  const surface     = deriveReleaseSurface(parseResult.schema, { pluralize })

  const schemaPath = resolve(cfg.schema)
  const outPath    = getFlag('out')
    ? resolve(getFlag('out'))
    : resolve(dirname(schemaPath), 'release.snapshot.md')

  // BASENAME, for the reason cmdAccess and cmdDdl use one: the file is
  // byte-compared, and a cwd-relative path renders differently from the app
  // directory and from the repo root.
  const body = renderReleaseSnapshot(surface, { source: basename(schemaPath) })

  if (check) {
    checkSnapshot(outPath, body, {
      regen: 'litestone release',
      moved: 'The release surface changed. Run `litestone release` and read the verdict before committing.',
    })
    console.log()
    return
  }

  if (toStdout && !asJson) { process.stdout.write(body); return }

  const from     = getFlag('from') ?? 'HEAD'
  const baseline = loadBaselineSchema(from, schemaPath)
  const before   = baseline.text ? parseBaseline(baseline.text, pluralize, deriveReleaseSurface) : null
  const result   = before?.surface ? classifyPivot(before.surface, surface) : null

  if (asJson) {
    process.stdout.write(JSON.stringify({
      baseline: { from, label: baseline.label, resolved: !!before?.surface, note: before?.error ?? before?.note ?? baseline.note ?? null },
      verdict:  result?.verdict ?? 'unknown',
      counts:   result?.counts  ?? { expand: 0, unknown: 0, contract: 0 },
      findings: result?.findings ?? [],
      surface,
    }, null, 2) + '\n')
    if (strict && (result?.verdict ?? 'unknown') !== 'expand' && (result?.verdict ?? 'unknown') !== 'unchanged')
      process.exit(1)
    return
  }

  writeFileSync(outPath, body, 'utf8')
  const { size } = statSync(outPath)
  console.log(`  ${green('✓')}  ${rel(outPath)}  ${dim(`(${(size/1024).toFixed(1)}kb)`)}`)
  console.log()

  if (!result) {
    // Nothing to compare against. On its own that is the honest first run; under
    // --strict it is a failure, because --strict asks for a REVERSIBLE deploy
    // and "I could not tell" is not one.
    console.log(`  ${yellow('!')}  no baseline — ${before?.error ?? baseline.note}`)
    console.log(`     ${dim('Commit this snapshot; the next run classifies the change against it.')}`)
    console.log()
    if (strict) process.exit(1)
    return
  }

  const mark = result.verdict === 'contract' ? red('✗') : result.verdict === 'unknown' ? yellow('!') : green('✓')
  if (before?.note) console.log(`  ${yellow('!')}  ${before.note}`)

  const lines = formatVerdict(result, { baseline: baseline.label })
  console.log(`  ${mark}  ${lines[0]}`)
  for (const line of lines.slice(1)) console.log(line ? `  ${line}` : '')
  console.log()

  if (result.verdict !== 'unchanged' && result.verdict !== 'expand')
    console.log(`  ${dim('A contract deploy is one that cannot be taken back. Split it, or cross the pivot knowingly.')}\n`)

  console.log(`  ${dim('--from=<ref|path>')}  ${dim('classify against another release (default: HEAD)')}`)
  console.log(`  ${dim('--strict')}           ${dim('exit 1 unless the verdict is expand or unchanged (CI)')}`)
  console.log(`  ${dim('--check')}            ${dim('exit 1 if the committed snapshot is stale (CI)')}`)
  console.log(`  ${dim('--json')}             ${dim('the verdict as data, nothing written')}`)
  console.log()

  if (strict && result.verdict !== 'expand' && result.verdict !== 'unchanged') process.exit(1)
}

// Where the previous release's schema comes from. A path on disk wins, because
// a ref and a filename are not distinguishable and only one of them can be
// tested for cheaply; anything else is asked of git.
function loadBaselineSchema(from, schemaPath) {
  const missing = []
  const noteFor = (base) => base ?? (missing.length
    ? `${missing.length === 1 ? 'an import' : `${missing.length} imports`} could not be read there ` +
      `(${missing.join(', ')}) — those models are absent from the baseline`
    : null)

  if (existsSync(from) && statSync(from).isFile()) {
    // rel() walks up out of the project for a file in /tmp, which reads as a
    // path nobody typed. Shortest of the two is the one a person recognises.
    const abs = resolve(from), r = rel(abs)
    const { text, missing: gone } = inlineImportsFromDisk(abs)
    missing.push(...gone)
    return { text, label: `\`${r.length < abs.length ? r : abs}\``, note: noteFor(null) }
  }

  const root = git(['rev-parse', '--show-toplevel'])
  if (!root) return { text: null, label: from, note: `\`${from}\` is not a file and this is not a git repository` }

  const tracked  = relative(root, schemaPath).split('\\').join('/')
  const rootText = git(['show', `${from}:${tracked}`])

  if (rootText === null)
    return { text: null, label: from, note: `\`${tracked}\` is not committed at \`${from}\`` }

  const text = inlineImports(rootText, tracked, {
    resolveChild: (parent, spec) => posixJoin(posixDir(parent), spec),
    read:         (p) => git(['show', `${from}:${p}`]),
    seen:         new Set([tracked]),
    missing,
  })

  return { text, label: `\`${from}\``, note: noteFor(null) }
}

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
function parseBaseline(text, pluralize, derive) {
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

function git(argv) {
  const run = spawnSync('git', argv, { encoding: 'utf8', shell: false, cwd: process.cwd() })
  if (run.error || run.status !== 0) return null
  return run.stdout.replace(/\n$/, '')
}


// ─── Mutate — the completeness proof ─────────────────────────────────────────
//
// Mutate the schema, build a database from each mutant, and run the checks
// derived from the ORIGINAL schema against it. A mutant nothing notices is a
// hole in the checks, and it names itself.
//
// Run by hand, not in CI: basecamp is 232 mutants at several seconds each. It
// answers "did my last change to a check make it weaker", which is a question
// asked when something changes rather than on every push.

async function cmdMutate(cfg) {
  header('litestone mutate')

  const { schemaMutants, mutationScore, createTestEnv } = await import('../testing.js')
  const schemaPath = resolve(cfg.schema)
  const schemaText = readFileSync(schemaPath, 'utf8')
  const kinds      = getFlag('kinds')?.split(',').map(s => s.trim()).filter(Boolean) ?? null

  const all = schemaMutants(schemaText, { kinds })
  if (!all.length) fatal(
    `No mutants for ${rel(schemaPath)}${kinds ? ` with --kinds=${kinds.join(',')}` : ''}. ` +
    `A schema declaring no @@gate, @@allow, @guarded or field validator has nothing to mutate.`
  )

  console.log(`  ${dim(`${all.length} mutants · ${basename(schemaPath)}`)}`)
  console.log()

  // Progress as it goes: a 232-mutant run is minutes, and a silent one is
  // indistinguishable from a hung one.
  let done = 0
  const started = Date.now()
  const result  = await mutationScore({
    schema: schemaText,
    kinds,
    build:  (text) => createTestEnv({ schema: text, encryptionKey: cfg.encryptionKey }),
    // Only on a terminal: `\r` does not erase in a pipe or a log, so a
    // redirected run collected one progress line per tick on a single row.
    onMutant: () => {
      done++
      if (!process.stdout.isTTY) return
      if (done % 5 === 0 || done === all.length) process.stdout.write(`\r  ${dim(`${done}/${all.length}`)}   `)
    },
  })
  if (process.stdout.isTTY) process.stdout.write('\r                    \r')

  const pct   = result.graded ? Math.round(result.score * 100) : 100
  const mark  = result.survived.length ? yellow('!') : green('✓')
  const secs  = ((Date.now() - started) / 1000).toFixed(0)

  console.log(`  ${mark}  ${pct}% killed  ${dim(`${result.killed}/${result.graded} graded · ${secs}s`)}`)
  if (result.refused.length) console.log(`  ${dim(`${result.refused.length} refused by the parser or the loader — a schema that cannot ship`)}`)
  console.log()

  if (result.errored.length) {
    console.log(`  ${red('✗')}  ${result.errored.length} mutant(s) could not be graded — the checks fell over:`)
    for (const e of result.errored.slice(0, 5)) console.log(`     ${dim('·')} ${e.describe} ${dim(`— ${e.thrown}`)}`)
    console.log()
  }

  if (!result.survived.length) {
    console.log(`  ${dim('Every mutant was noticed. Nothing to do.')}`)
  } else {
    console.log(`  ${yellow(`${result.survived.length} SURVIVED`)} ${dim('— nothing in the checks can see these changes')}`)
    console.log()
    const byKind = {}
    for (const s of result.survived) (byKind[s.kind] ??= []).push(s)
    for (const [kind, rows] of Object.entries(byKind)) {
      console.log(`    ${kind}  ${dim(`(${rows.length})`)}`)
      for (const r of rows) console.log(`      ${dim(`${basename(schemaPath)}:${r.lineNo}`)}  ${r.describe}`)
    }
    console.log()
    console.log(`  ${dim('A survivor is a fact about the CHECKS, not the schema. Two are expected:')}`)
    console.log(`  ${dim('a nullable @unique (SQLite takes any number of NULLs) and a create-only')}`)
    console.log(`  ${dim('policy (checked by evalJs alone, so nothing independent can grade it).')}`)
  }

  console.log()
  console.log(`  ${dim('--kinds=<a,b>')}  ${dim(`narrow: ${[...new Set(all.map(m => m.kind))].join(', ')}`)}`)
  console.log()
}


// ─── Doctor / audit ──────────────────────────────────────────────────────────
//
// litestone doctor           — interactive, suggests fixes
// litestone doctor --ci      — machine-readable, exits 1 if any errors
// litestone doctor --fix     — auto-fix safe issues (create dirs, etc.)
//
// Checks:
//   ENV      bun version, node version
//   CONFIG   litestone.config.js exists and is valid
//   SCHEMA   schema.lite exists, parses, no errors/warnings
//   DB       database file accessible, WAL health
//   MIGRATE  migrations dir exists, no pending migrations, schema in sync
//   ENCRYPT  encryption key present if @encrypted fields exist
//   TENANT   tenant directory health (if configured)

async function cmdDoctor() {
  const ci      = flag('ci')
  const fix     = flag('fix') && !ci
  const verbose = !ci

  if (verbose) {
    console.log()
    console.log(`  ${bold('litestone doctor')}`)
    console.log()
  }

  const checks  = []   // { group, label, status, detail, fix }
  let   errors  = 0
  let   warnings = 0

  function pass(group, label, detail = '')  { checks.push({ group, label, status: 'pass', detail }) }
  function warn(group, label, detail = '', fixFn = null) { checks.push({ group, label, status: 'warn', detail, fixFn }); warnings++ }
  function fail(group, label, detail = '', fixFn = null) { checks.push({ group, label, status: 'fail', detail, fixFn }); errors++ }
  function info(group, label, detail = '')  { checks.push({ group, label, status: 'info', detail }) }

  // ── ENV ─────────────────────────────────────────────────────────────────────

  // Bun version
  const bunVersion = typeof Bun !== 'undefined' ? Bun.version : null
  if (bunVersion) {
    const [maj, min] = bunVersion.split('.').map(Number)
    if (maj > 1 || (maj === 1 && min >= 1)) {
      pass('ENV', 'Bun version', `v${bunVersion}`)
    } else {
      warn('ENV', 'Bun version outdated', `v${bunVersion} — recommend v1.1+`)
    }
  } else {
    warn('ENV', 'Bun not detected', 'Running under Node — some features require Bun')
  }

  // ── CONFIG ──────────────────────────────────────────────────────────────────

  const configPath = resolve(getFlag('config') ?? './litestone.config.js')
  const hasConfig  = existsSync(configPath)

  if (hasConfig) {
    try {
      const mod = await import(`file://${configPath}`)
      const cfg = mod.default ?? mod
      pass('CONFIG', 'litestone.config.js', rel(configPath))
      if (!cfg.schema) info('CONFIG', 'No schema path in config', 'Defaults to ./schema.lite')

      // ── SCHEMA ──────────────────────────────────────────────────────────────
      const schemaPath = resolve(getFlag('schema') ?? cfg.schema ?? './schema.lite')
      if (!existsSync(schemaPath)) {
        fail('SCHEMA', 'schema.lite not found', rel(schemaPath),
          fix ? async () => {
            const { writeFileSync } = await import('fs')
            writeFileSync(schemaPath, `/// schema.lite\n\nmodel Example {\n  id   Int @id\n  name String\n}\n`)
            return `created ${rel(schemaPath)}`
          } : null
        )
      } else {
        const { parse: parseSchema } = await import('../core/parser.js')
        const { readFileSync: rfs } = await import('fs')
        const result = parseSchema(rfs(schemaPath, 'utf8'))
        if (!result.valid) {
          fail('SCHEMA', 'schema.lite has errors', result.errors[0])
          for (const e of result.errors.slice(1)) fail('SCHEMA', '', e)
        } else {
          const models = result.schema.models.length
          const enums  = result.schema.enums.length
          const funcs  = result.schema.functions.length
          const traits = (result.schema.traits ?? []).length
          const types  = (result.schema.types ?? []).length
          const parts = [
            `${models} model${models!==1?'s':''}`,
            `${enums} enum${enums!==1?'s':''}`,
            `${funcs} function${funcs!==1?'s':''}`,
          ]
          if (traits) parts.push(`${traits} trait${traits!==1?'s':''}`)
          if (types)  parts.push(`${types} type${types!==1?'s':''}`)
          pass('SCHEMA', 'schema.lite valid', parts.join(', '))

          for (const w of result.warnings ?? [])
            warn('SCHEMA', 'Schema warning', w)

          // Check for @encrypted without key hint
          const hasEncrypted = result.schema.models.some(m =>
            m.fields.some(f => f.attributes.find(a => a.kind === 'encrypted'))
          )
          if (hasEncrypted && !process.env.LITESTONE_KEY && !process.env.ENCRYPTION_KEY) {
            warn('ENCRYPT', '@encrypted fields detected', 'Set encryptionKey: process.env.ENCRYPTION_KEY in createClient()')
          } else if (hasEncrypted) {
            pass('ENCRYPT', 'Encryption key env var present')
          }

          // ── DB ─────────────────────────────────────────────────────────────
          // Build list of SQLite databases to check:
          // multi-DB schemas declare them in database blocks; single-DB uses cfg.db
          const { Database: DB } = await import('bun:sqlite')
          const { status: migStatus } = await import('../core/migrations.js')
          const { buildPristineForDatabase, diffSchemas, introspect } = await import('../core/migrate.js')
          const migrationsBase = resolve(getFlag('migrations') ?? cfg.migrations ?? './migrations')

          const sqliteDbs = result.schema.databases.filter(d => !d.driver || d.driver === 'sqlite')
          // If no explicit db is configured (via schema database block or cfg.db),
          // fall back to ./development.db — same default the main CLI flow uses.
          const effectiveDb = cfg.db ?? (sqliteDbs.length ? null : './development.db')
          const dbsToCheck = sqliteDbs.length
            ? sqliteDbs.map(d => ({
                label:        d.name,
                dbPath:       (() => { try { return resolveDbPath(d.path, null, schemaAnchor(cfg.schema)) } catch { return null } })(),
                migrationsDir: join(migrationsBase, d.name),
              }))
            : effectiveDb
              ? [{ label: 'main', dbPath: resolve(effectiveDb), migrationsDir: migrationsBase }]
              : []

          if (!sqliteDbs.length && !cfg.db && !dbsToCheck.length) {
            warn('DB', 'No database path configured',
              'Add a database block to schema.lite or set db in litestone.config.js')
          }

          for (const { label, dbPath, migrationsDir } of dbsToCheck) {
            const dbLabel = dbsToCheck.length > 1 ? `DB(${label})` : 'DB'

            if (!dbPath) {
              warn(dbLabel, 'Database path unresolvable', `Check the path definition for database '${label}'`)
              continue
            }

            if (!existsSync(dbPath)) {
              info(dbLabel, 'Database not yet created', `Will be created at ${rel(dbPath)}`)
            } else {
              try {
                const db = new DB(dbPath, { readonly: true })
                const { page_count } = db.query('PRAGMA page_count').get()
                const { page_size  } = db.query('PRAGMA page_size').get()
                db.close()
                pass(dbLabel, 'Database accessible', `${rel(dbPath)}  ${fmtBytes(page_count * page_size)}`)
              } catch (e) {
                fail(dbLabel, 'Database unreadable', e.message)
              }
              for (const ext of ['-wal', '-shm']) {
                if (existsSync(dbPath + ext))
                  warn(dbLabel, `Stale ${ext} file`, `${rel(dbPath + ext)} — run: sqlite3 ${rel(dbPath)} "PRAGMA wal_checkpoint(TRUNCATE)"`)
              }
            }

            // ── MIGRATIONS ────────────────────────────────────────────────
            if (!existsSync(migrationsDir)) {
              warn('MIGRATE' + (dbsToCheck.length > 1 ? `(${label})` : ''), 'Migrations directory not found', rel(migrationsDir),
                fix ? async () => {
                  const { mkdirSync } = await import('fs')
                  mkdirSync(migrationsDir, { recursive: true })
                  return `created ${rel(migrationsDir)}`
                } : null
              )
            } else if (dbPath && existsSync(dbPath)) {
              try {
                const db2 = new DB(dbPath)
                const rows = migStatus(db2, migrationsDir)
                const pending = rows.filter(r => r.state === 'pending').length
                const applied = rows.filter(r => r.state === 'applied').length
                const migrateLabel = 'MIGRATE' + (dbsToCheck.length > 1 ? `(${label})` : '')

                if (pending > 0) {
                  warn(migrateLabel, `${pending} pending migration${pending!==1?'s':''}`,
                    `Run ${cyan('litestone migrate apply')} to apply`)
                } else if (rows.length > 0) {
                  pass(migrateLabel, 'Migrations up to date', `${applied} applied`)
                } else {
                  info(migrateLabel, 'No migrations yet', `Run ${cyan('litestone migrate create')} to create the first one`)
                }

                // Schema drift check
                const pristineDb = new DB(':memory:')
                const pristine   = buildPristineForDatabase(pristineDb, result, label)
                pristineDb.close()
                const live = introspect(db2)
                const diff = diffSchemas(pristine, live, result, label, { pluralize: cfg.pluralize })
                if (diff.hasChanges)
                  warn(migrateLabel, 'Schema drift detected', `Run ${cyan('litestone migrate create')} to generate a corrective migration`)
                else if (rows.length > 0)
                  pass(migrateLabel, 'Schema matches database')

                // ── PERF ──────────────────────────────────────────────────
                // Performance checks against the live DB. All advisory.
                const perfLabel = 'PERF' + (dbsToCheck.length > 1 ? `(${label})` : '')
                try {
                  const { modelToTableName } = await import('../core/ddl.js')
                  const resolveTableName = (m) => {
                    const mapAttr = m.attributes?.find(a => a.kind === 'map')
                    if (mapAttr?.name) return mapAttr.name
                    return modelToTableName(m, cfg.pluralize ?? false)
                  }

                  // Models that belong to this DB
                  const dbModels = result.schema.models.filter(m => {
                    const dbAttr = m.attributes?.find(a => a.kind === 'db')
                    const modelDbName = dbAttr?.name ?? 'main'
                    return modelDbName === label
                  })

                  // ── 1. FK columns missing indexes ──────────────────────────────
                  // belongsTo FKs without an index force every nested write or include
                  // query to scan the child table. Standard ORM perf gotcha — Postgres
                  // adds these implicitly on FK definition; SQLite does not.
                  for (const model of dbModels) {
                    const tableName = resolveTableName(model)

                    // Find FK fields — fields with @relation(fields:[..])
                    const fkFields = []
                    for (const f of model.fields) {
                      const rel = f.attributes?.find(a => a.kind === 'relation' && a.fields)
                      if (rel) {
                        const fkCol = Array.isArray(rel.fields) ? rel.fields[0] : rel.fields
                        if (fkCol) fkFields.push(fkCol)
                      }
                    }

                    if (!fkFields.length) continue

                    // Get indexed columns for this table from sqlite_master
                    let indexedCols = new Set()
                    try {
                      const indexes = db2.query(
                        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`
                      ).all(tableName)
                      for (const idx of indexes) {
                        try {
                          const cols = db2.query(`PRAGMA index_info("${idx.name}")`).all()
                          // First column of a multi-column index is what matters for
                          // selectivity on a single-column FK lookup.
                          if (cols[0]) indexedCols.add(cols[0].name)
                        } catch {}
                      }
                    } catch { continue }

                    const unindexedFks = fkFields.filter(c => !indexedCols.has(c))
                    if (unindexedFks.length) {
                      const cols = unindexedFks.join(', ')
                      warn(perfLabel, `${model.name}: FK column${unindexedFks.length>1?'s':''} not indexed`,
                        `${cols} — add @@index([${unindexedFks[0]}]) to ${model.name}`)
                    }
                  }

                  // ── 2. Tables that are large but have no indexes at all ────────
                  // Scanning a 100k-row table on every WHERE clause is the silent
                  // dev-becomes-prod perf cliff. Flag tables over 10k rows with
                  // no user-defined indexes (PK doesn't count).
                  for (const model of dbModels) {
                    const tableName = resolveTableName(model)
                    let rowCount = 0
                    try {
                      const r = db2.query(`SELECT COUNT(*) as n FROM "${tableName}"`).get()
                      rowCount = r?.n ?? 0
                    } catch { continue }

                    if (rowCount < 10_000) continue

                    // User indexes only — exclude auto sqlite_ ones
                    let userIndexCount = 0
                    try {
                      const r = db2.query(
                        `SELECT COUNT(*) as n FROM sqlite_master
                         WHERE type='index' AND tbl_name=? AND name NOT LIKE 'sqlite_%'`
                      ).get(tableName)
                      userIndexCount = r?.n ?? 0
                    } catch {}

                    if (userIndexCount === 0) {
                      warn(perfLabel, `${model.name}: ${rowCount.toLocaleString()} rows, no indexes`,
                        `Add @@index for any column you filter on — full table scan otherwise`)
                    }
                  }

                  // ── 3. Stale ANALYZE stats ─────────────────────────────────────
                  // ANALYZE populates sqlite_stat1 used by the query planner. After
                  // bulk imports or large data shifts the stats can become stale.
                  // Litestone runs ANALYZE automatically after migrations, so the
                  // common cause of staleness is bulk data load outside migrations.
                  try {
                    const hasStat = db2.query(
                      `SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'`
                    ).get()
                    if (!hasStat) {
                      // Only warn if there's actually data — fresh databases don't need stats yet.
                      const totalRows = dbModels.reduce((sum, m) => {
                        try {
                          const tn = resolveTableName(m)
                          const r = db2.query(`SELECT COUNT(*) as n FROM "${tn}"`).get()
                          return sum + (r?.n ?? 0)
                        } catch { return sum }
                      }, 0)
                      if (totalRows > 1000) {
                        warn(perfLabel, 'ANALYZE never run',
                          `Run ${cyan('sqlite3 ' + rel(dbPath) + ' "ANALYZE"')} or trigger via migrate apply`)
                      }
                    }
                  } catch {}

                  // ── 4. WAL checkpoint pressure ─────────────────────────────────
                  // WAL file > 5000 frames means autocheckpoint is falling behind —
                  // either reads are holding open snapshots or write volume exceeds
                  // checkpoint cadence. Either way, indicates a config tune.
                  try {
                    const wal = db2.query('PRAGMA wal_checkpoint(PASSIVE)').get()
                    // returns { busy, log, checkpointed } — log is total WAL frames
                    if (wal?.log != null && wal.log > 5000) {
                      warn(perfLabel, 'WAL file is large',
                        `${wal.log.toLocaleString()} frames — long-running readers may be holding snapshots open`)
                    }
                  } catch {}

                  if (checks.filter(c => c.group === perfLabel).length === 0) {
                    pass(perfLabel, 'No performance issues detected')
                  }
                } catch (e) {
                  info(perfLabel, 'Could not run perf checks', e.message)
                }

                db2.close()
              } catch (e) {
                info('MIGRATE', 'Could not check migration status', e.message)
              }
            }
          }
        }
      }
    } catch (e) {
      fail('CONFIG', 'litestone.config.js has errors', e.message)
    }
  } else {
    warn('CONFIG', 'litestone.config.js not found', rel(configPath),
      fix ? async () => {
        const { writeFileSync } = await import('fs')
        writeFileSync(configPath,
`export default {
  schema:     './schema.lite',
  migrations: './migrations',
  // db defaults to ./development.db
}
`)
        return `created ${rel(configPath)}`
      } : null
    )
  }

  // ── Auto-fix ─────────────────────────────────────────────────────────────────
  const fixable = checks.filter(c => c.fixFn)
  if (fix && fixable.length) {
    console.log(`  ${dim('─── auto-fix ───────────────────────────────────────────')}\n`)
    for (const c of fixable) {
      try {
        const msg = await c.fixFn()
        console.log(`  ${green('✓')}  fixed: ${msg}`)
        c.status = 'pass'
        c.detail = msg
        c.fixFn  = null
        errors   = Math.max(0, errors - 1)
        warnings = Math.max(0, warnings - 1)
      } catch (e) {
        console.log(`  ${red('✗')}  fix failed: ${e.message}`)
      }
    }
    console.log()
  }

  // ── Output ────────────────────────────────────────────────────────────────────

  if (ci) {
    // Machine-readable: one line per check
    for (const c of checks) {
      if (c.label) console.log(`${c.status.toUpperCase()}\t${c.group}\t${c.label}${c.detail ? '\t' + c.detail : ''}`)
    }
    process.exit(errors > 0 ? 1 : 0)
    return
  }

  // Human-readable
  const ICONS = { pass: green('✓'), warn: yellow('⚠'), fail: red('✗'), info: dim('·') }

  let lastGroup = null
  for (const c of checks) {
    if (!c.label) continue
    if (c.group !== lastGroup) {
      console.log(`  ${dim(c.group)}`)
      lastGroup = c.group
    }
    const icon   = ICONS[c.status]
    const detail = c.detail ? `  ${dim(c.detail)}` : ''
    const fixHint = c.fixFn ? `  ${dim(`(run with --fix to auto-fix)`)}` : ''
    console.log(`    ${icon}  ${c.label}${detail}${fixHint}`)
  }

  console.log()

  if (errors === 0 && warnings === 0) {
    console.log(`  ${green(bold('✓ All checks passed'))} — Litestone is ready\n`)
  } else {
    if (errors > 0)   console.log(`  ${red(`${errors} error${errors!==1?'s':''}`)}`+
      (fixable.length ? `  ${dim(`(${fixable.length} fixable — run with --fix)`)}` : ''))
    if (warnings > 0) console.log(`  ${yellow(`${warnings} warning${warnings!==1?'s':''}`)}`)
    const hasFixable = checks.some(c => c.fixFn)
    if (hasFixable && !fix)
      console.log(`\n  ${dim(`Run ${cyan('litestone doctor --fix')} to auto-fix safe issues`)}`)
    console.log()
  }
}

function fmtBytes(b) {
  if (b >= 1024**3) return `${(b/1024**3).toFixed(1)}gb`
  if (b >= 1024**2) return `${(b/1024**2).toFixed(1)}mb`
  if (b >= 1024)    return `${(b/1024).toFixed(1)}kb`
  return `${b}b`
}



// ─── Introspect (entity generator) ───────────────────────────────────────────

async function cmdIntrospect(dbArg, cfg) {
  header('litestone introspect')

  const dbPath = dbArg ?? cfg.db
  if (!dbPath) fatal('No database path provided.\n     Usage: litestone introspect ./mydb.db')

  const abs = resolve(dbPath)
  if (!existsSync(abs)) fatal(`Database not found: ${abs}`)

  const out      = getFlag('out')
  const noCamel  = flag('no-camel')

  const { Database: DB } = await import('bun:sqlite')
  const { generateLiteSchema } = await import('./introspect.js')

  const db = new DB(abs, { readonly: true })
  const liteSchema = generateLiteSchema(db, { camelCase: !noCamel })
  db.close()

  if (out) {
    const outPath = resolve(out)
    const { writeFileSync } = await import('fs')
    writeFileSync(outPath, liteSchema)
    console.log(`  ${green('✓')}  Schema written to ${rel(outPath)}`)
    console.log(`  ${dim('Models:')} ${(liteSchema.match(/^model /gm) || []).length}`)
    console.log(`  ${dim('Enums:')}  ${(liteSchema.match(/^enum /gm) || []).length}`)
  } else {
    console.log(liteSchema)
  }

  console.log()
  console.log(`  ${dim('Options:')}`)
  console.log(`    ${cyan('--out=schema.lite')}  write to file instead of stdout`)
  console.log(`    ${cyan('--no-camel')}         keep original snake_case names`)
  console.log()
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function cmdSeed(seederArg, cfg) {
  header('litestone seed')

  if (!cfg.db) fatal('No database specified. Set db in litestone.config.js')

  // Resolve seeder file — config.seeder or default ./seeders/DatabaseSeeder.js
  const seederPath = cfg.seeder ?? './seeders/DatabaseSeeder.js'
  const absSeeder  = resolve(seederPath)

  if (!existsSync(absSeeder))
    fatal(`Seeder not found: ${absSeeder}\n     Create a seeder file or set ${cyan('seeder')} in litestone.config.js`)

  const parseResult = loadSchema(cfg.schema)
  const { createClient } = await import('../core/client.js')
  const { runSeeder }    = await import('../seeder.js')

  const db = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: clientDb(parseResult, cfg), encryptionKey: getEncKey() })

  const mod         = await import(`file://${absSeeder}`)
  // Allow: default export, named export matching the file, or named DatabaseSeeder
  const SeederClass = mod.default
    ?? mod[seederArg]
    ?? mod.DatabaseSeeder
    ?? Object.values(mod).find(v => typeof v === 'function' && v.prototype?.run)

  if (!SeederClass)
    fatal(`No seeder class found in ${rel(absSeeder)}.\n     Export a default class or name it DatabaseSeeder.`)

  if (cfg.db) console.log(`  ${dim('Database:')}  ${rel(resolve(cfg.db))}`)
  console.log(`  ${dim('Seeder:')}    ${rel(absSeeder)}\n`)

  const t0 = performance.now()
  try {
    await runSeeder(db, SeederClass)
    const ms = (performance.now() - t0).toFixed(0)
    console.log(`\n  ${green('✓')}  Seeding complete  ${dim(`(${ms}ms)`)}`)
  } catch (e) {
    console.error(`\n  ${red('✗')}  Seeding failed: ${e.message}`)
    if (flag('debug')) console.error(e.stack)
    process.exit(1)
  } finally {
    db.$close()
  }
}

// ─── seed:run — run reusable infrastructure seeds ─────────────────────────────
//
// Two seed sources:
//
//   1. Built-in seeds — ship with @frontierjs/litestone, live in
//      <package>/src/tools/seeds/. Currently: calendar.
//
//   2. User seeds — in the consumer's project. Resolved from cfg.seedsDir,
//      defaulting to ./seeds/.
//
// User seeds with the same name as a built-in seed override the built-in.
// Each seed is tracked in _litestone_seeds — won't run twice unless --force.
//
// Usage:
//   litestone seed:run                    — list available seeds (built-in + user)
//   litestone seed:run calendar           — run calendar seed against main db
//   litestone seed:run calendar --db=analytics
//   litestone seed:run calendar --force   — re-run even if already applied
//
async function cmdSeedRun(seedName, cfg) {
  header('litestone seed:run')

  const { Database } = await import('bun:sqlite')
  const { readdirSync, readFileSync } = await import('fs')

  // User seeds dir — explicit config wins, otherwise ./seeds/.
  const userSeedsDir = cfg.seedsDir
    ?? (existsSync(resolve('./seeds')) ? resolve('./seeds') : null)

  const dbPath = getFlag('db') ? resolve(getFlag('db')) : cfg.db
  const force  = flag('force')

  // ── Catalogue helper — returns Map<name, { source, file, sql, display }> ───
  // Built-ins come from BUILTIN_SEEDS (embedded at build time, so they exist in
  // a compiled binary); user seeds are read from disk. User seeds with the same
  // name as a built-in override it (last-write-wins on the Map).
  const catalogue = () => {
    const out = new Map()
    for (const [name, sql] of Object.entries(BUILTIN_SEEDS))
      out.set(name, { source: 'builtin', file: null, sql, display: '(bundled)' })
    if (userSeedsDir && existsSync(userSeedsDir)) {
      for (const f of readdirSync(userSeedsDir)) {
        if (!f.endsWith('.sql') && !f.endsWith('.js')) continue
        const file = resolve(userSeedsDir, f)
        out.set(f.replace(/\.(sql|js)$/, ''), {
          source: 'user', file, sql: null, display: rel(file),
        })
      }
    }
    return out
  }

  // ── List mode ──────────────────────────────────────────────────────────────
  if (!seedName) {
    const seeds = catalogue()
    if (!seeds.size) {
      console.log(`  ${dim('No seeds available.')}`)
      console.log(`  Add .sql or .js files to ${cyan('./seeds/')} or set ${cyan('seedsDir')} in litestone.config.js\n`)
      return
    }

    // Check which are applied (if db exists)
    const applied = new Set()
    if (dbPath && existsSync(dbPath)) {
      const raw = new Database(dbPath, { readonly: true })
      try {
        const rows = raw.query(`SELECT name FROM _litestone_seeds WHERE status = 'applied'`).all()
        for (const r of rows) applied.add(r.name)
      } catch {} finally { raw.close() }
    }

    console.log(`  ${dim('Available seeds:')}\n`)
    for (const [name, { source, display }] of [...seeds.entries()].sort()) {
      const status = applied.has(name) ? green('✓ applied') : dim('· pending')
      const tag    = source === 'builtin' ? dim('(built-in)') : dim('(user)')
      console.log(`    ${status}  ${name.padEnd(20)} ${tag}  ${dim(display)}`)
    }
    console.log()
    return
  }

  // ── Run mode ───────────────────────────────────────────────────────────────
  if (!dbPath)
    fatal(`No database specified. Pass ${cyan('--db=<path>')} or set ${cyan('db')} in litestone.config.js`)

  const seeds    = catalogue()
  const seedRef  = seeds.get(seedName)

  if (!seedRef) {
    const list = [...seeds.keys()].sort().join(', ') || '(none)'
    fatal(`Seed not found: ${seedName}\n     Available: ${list}`)
  }

  const seedFile = seedRef.file
  const isJs     = seedFile?.endsWith('.js') ?? false

  console.log(`  ${dim('Seed:')}     ${cyan(seedName)} ${dim(`(${seedRef.source})`)}`)
  console.log(`  ${dim('File:')}     ${seedRef.display}`)
  console.log(`  ${dim('Database:')} ${rel(dbPath)}\n`)

  const raw = new Database(dbPath)

  // Ensure tracking table exists
  // appliedAt is ISO-8601, the format every other timestamp litestone writes
  // uses — _litestone_migrations stamps `new Date().toISOString()`. SQLite's own
  // `datetime('now')` answers a different format, and two ledgers answering
  // "when did this run" in two formats sort against each other wrongly the
  // moment anything reads both (FJS-226).
  raw.run(`CREATE TABLE IF NOT EXISTS _litestone_seeds (
    name       TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'applied',
    appliedAt  TEXT NOT NULL,
    notes      TEXT
  )`)

  // Check if already applied
  const existing = raw.query(`SELECT name FROM _litestone_seeds WHERE name = ?`).get(seedName)
  if (existing && !force) {
    console.log(`  ${dim('ℹ')}  Seed ${cyan(seedName)} already applied. Use ${cyan('--force')} to re-run.\n`)
    raw.close()
    return
  }

  const t0 = performance.now()
  try {
    if (isJs) {
      // JS seed — gets full ORM client
      const parseResult = cfg.schema ? loadSchema(cfg.schema) : null
      if (!parseResult)
        fatal(`No schema found. Set ${cyan('schema')} in litestone.config.js to use JS seeds.`)
      const { createClient } = await import('../core/client.js')
      const db = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: dbPath, encryptionKey: getEncKey() })
      const mod = await import(`file://${seedFile}`)
      const fn  = mod.default ?? Object.values(mod).find(v => typeof v === 'function')
      if (!fn) fatal(`JS seed ${seedName} must export a default function`)
      try {
        await fn(db)
      } finally {
        db.$close()
      }
    } else {
      // SQL seed — embedded text for built-ins, on-disk for user seeds
      const sql = seedRef.sql ?? readFileSync(seedFile, 'utf8')
      // Split on semicolons but keep multi-statement CTEs intact
      // Use SQLite's exec() which handles multi-statement SQL natively
      raw.exec(sql)
    }

    // Record as applied (upsert)
    raw.run(
      `INSERT INTO _litestone_seeds (name, status, appliedAt) VALUES (?, 'applied', ?)
       ON CONFLICT(name) DO UPDATE SET status = 'applied', appliedAt = excluded.appliedAt`,
      seedName, new Date().toISOString()
    )

    const ms = (performance.now() - t0).toFixed(0)
    console.log(`  ${green('✓')}  ${seedName} applied  ${dim(`(${ms}ms)`)}`)
  } catch (e) {
    console.error(`  ${red('✗')}  Seed failed: ${e.message}`)
    if (flag('debug')) console.error(e.stack)
    process.exit(1)
  } finally {
    raw.close()
  }
  console.log()
}



async function cmdEdgeEject(target, cfg, apply) {
  header('litestone edge eject')
  const parseResult = loadSchema(cfg.schema)
  const { ejectEdge, applyEject, formatEjectPlan } = await import('./eject.js')
  let plan
  try {
    plan = ejectEdge(parseResult.schema, target, { pluralize: cfg.pluralize })
  } catch (e) {
    fatal(e.message)
  }
  console.log(formatEjectPlan(plan))
  if (apply) {
    const rawDb = openDb(cfg.db)
    try {
      applyEject(rawDb, plan)
      console.log(`\n  ${green('✓')}  renamed ${plan.oldTable} → ${plan.newTable} (data preserved)`)
    } finally {
      rawDb.close()
    }
  } else {
    console.log(`\n  ${dim('dry run — pass --apply to run the rename in step 4')}`)
  }
}

async function cmdOptimize(targetTable, cfg) {
  header('litestone optimize')

  const { createClient } = await import('../core/client.js')
  const parseResult = loadSchema(cfg.schema)
  const db = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: clientDb(parseResult, cfg), encryptionKey: getEncKey() })

  // Find all models with @@fts
  const ftsModels = parseResult.schema.models.filter(m =>
    m.attributes.some(a => a.kind === 'fts')
  )

  if (!ftsModels.length) {
    console.log(`  ${yellow('!')}  No models have @@fts — nothing to optimize\n`)
    db.$close()
    return
  }

  // Filter to a single table if specified (accept model name or accessor)
  const targets = targetTable
    ? ftsModels.filter(m => m.name === targetTable || modelToAccessor(m.name) === targetTable)
    : ftsModels

  if (targetTable && !targets.length) {
    console.log(`  ${red('✗')}  "${targetTable}" has no @@fts or doesn't exist\n`)
    console.log(`  FTS tables: ${ftsModels.map(m => m.name).join(', ')}\n`)
    db.$close()
    process.exit(1)
  }

  for (const model of targets) {
    const t0 = performance.now()
    const result = db[modelToAccessor(model.name)].optimizeFts()
    const ms = (performance.now() - t0).toFixed(1)
    console.log(`  ${green('✓')}  ${cyan(model.name + '_fts')}  ${dim(`optimized (${ms}ms)`)}`)
  }

  console.log()
  db.$close()
}

// ─── cmdBackup ────────────────────────────────────────────────────────────────
// Full backup — backs up ALL databases in the schema to a timestamped directory:
//   SQLite databases      → hot backup via $backup (safe during active writes)
//   JSONL/logger dirs     → directory copy via cpSync
//
//   litestone backup                   → ./backups/2026-04-21_120000/
//   litestone backup ./my-backup/      → explicit destination directory
//   litestone backup --vacuum          → compact SQLite files during backup
//   litestone backup --zip             → zip the backup directory with timestamp
//   litestone backup --db main         → only backup one database

async function cmdBackup(dest, cfg) {
  header('litestone backup')

  const { createClient }                    = await import('../core/client.js')
  const { mkdirSync, cpSync, readdirSync }  = await import('fs')

  const parseResult = loadSchema(cfg.schema)
  const vacuum      = flag('vacuum')
  const zip         = flag('zip')
  // --db is overloaded: a NAME filter when the schema declares databases, a
  // PATH when it declares none (loadConfig already consumed it as one). Read as
  // a name in the single-database case it matches nothing and reports
  // "No databases found matching --db=./app.db".
  const onlyDb      = declaresDatabases(parseResult) ? getFlag('db') : null

  // ── Destination: timestamped directory ─────────────────────────────────────
  const stamp        = new Date().toISOString().replace('T', '_').replace(/:/g, '').slice(0, 15)
  // When zipping, we still write to a temp dir first, then zip it
  const resolvedDest = dest
    ? (zip ? resolve(dest.replace(/\.zip$/, '')) : resolve(dest))
    : resolve('./backups', stamp)
  const zipPath      = zip
    ? (dest ? resolve(dest.endsWith('.zip') ? dest : dest + '.zip') : resolve('./backups', `${stamp}.zip`))
    : null

  mkdirSync(resolvedDest, { recursive: true })

  // ── Open ONE client ────────────────────────────────────────────────────────
  // Held open for the whole run. It used to be opened to read $databases,
  // closed, and then reopened once PER DATABASE as
  // `createClient({ parsed, db: info.path })` — but that argument names MAIN, so
  // every one of those clients backed up main, filed under a different
  // database's name. `$backup(dest, { only: [name] })` asks the one client for
  // the one database instead.
  const db        = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: clientDb(parseResult, cfg), encryptionKey: getEncKey() })
  const databases = db.$databases

  const targets = Object.entries(databases)
    .filter(([name]) => !onlyDb || name === onlyDb)

  if (!targets.length) fatal(`No databases found${onlyDb ? ` matching --db=${onlyDb}` : ''}.`)

  console.log()
  console.log(`  ${dim('destination:')} ${cyan(zip ? rel(zipPath) : rel(resolvedDest))}`)
  console.log(`  ${dim('databases:')}   ${targets.map(([n]) => n).join(', ')}`)
  if (zip) console.log(`  ${dim('format:')}      zip`)
  console.log()

  let totalSize = 0
  const t0 = performance.now()

  // A backup that copied SOME of the declared databases is not a backup. Every
  // arm below used to console.log its failure and carry on to `✓ backup
  // complete` with exit 0 — so a caller running this before something
  // irreversible (a deploy's pre-migration snapshot) read success and had no
  // audit trail. Collect what did not make it and refuse at the end.
  const incomplete = []

  for (const [name, info] of targets) {
    const t1 = performance.now()

    if (info.driver === 'sqlite') {
      // ── SQLite: hot backup ──────────────────────────────────────────────
      const destFile = resolve(resolvedDest, `${name}.db`)
      try {
        const result = await db.$backup(destFile, { vacuum, only: [name] })
        totalSize += result.size ?? 0
        const mb = ((result.size ?? 0) / 1024 / 1024).toFixed(2)
        const ms = (performance.now() - t1).toFixed(0)
        console.log(`  ${green('✓')}  ${cyan(name)}  ${dim(`${mb} MB · ${ms}ms${vacuum ? ' · vacuumed' : ''}`)}`)
        console.log(`     ${dim(rel(destFile))}`)
      } catch (e) {
        console.log(`  ${red('✗')}  ${cyan(name)} failed: ${e.message}`)
        incomplete.push(`${name} (${e.message})`)
      }

    } else if (info.driver === 'jsonl' || info.driver === 'logger') {
      // ── JSONL / logger: directory copy ──────────────────────────────────
      if (!info.path) {
        console.log(`  ${yellow('⚠')}  ${cyan(name)}: no path configured, skipping`)
        incomplete.push(`${name} (no path configured)`)
        continue
      }
      const srcDir  = resolve(info.path)
      const destDir = resolve(resolvedDest, name)
      if (!existsSync(srcDir)) {
        // Database paths resolve against the process CWD, not the schema file —
        // so running this from the wrong directory silently produced a partial
        // backup that reported success.
        console.log(`  ${yellow('⚠')}  ${cyan(name)}: ${dim(srcDir)} not found, skipping`)
        incomplete.push(`${name} (${srcDir} not found — paths resolve against CWD)`)
        continue
      }
      try {
        mkdirSync(destDir, { recursive: true })
        cpSync(srcDir, destDir, { recursive: true })
        const files = readdirSync(srcDir)
        let dirSize = 0
        for (const f of files) {
          try { dirSize += statSync(resolve(srcDir, f)).size } catch {}
        }
        totalSize += dirSize
        const kb    = (dirSize / 1024).toFixed(1)
        const ms    = (performance.now() - t1).toFixed(0)
        const count = files.length
        console.log(`  ${green('✓')}  ${cyan(name)}  ${dim(`${count} file${count !== 1 ? 's' : ''} · ${kb} KB · ${ms}ms`)}`)
        console.log(`     ${dim(rel(destDir))}`)
      } catch (e) {
        console.log(`  ${red('✗')}  ${cyan(name)} failed: ${e.message}`)
        incomplete.push(`${name} (${e.message})`)
      }
    }

    console.log()
  }

  // ── Zip the backup directory ────────────────────────────────────────────────
  if (zip) {
    const tZip = performance.now()
    console.log(`  ${dim('zipping...')}`)
    try {
      const { spawnSync } = await import('child_process')
      mkdirSync(resolve(zipPath, '..'), { recursive: true })
      const result = spawnSync('zip', ['-r', zipPath, '.'], {
        cwd:      resolvedDest,
        encoding: 'utf8',
        stdio:    'pipe',
      })
      if (result.status !== 0) throw new Error(result.stderr || 'zip failed')

      // Clean up the temp directory
      const { rmSync } = await import('fs')
      rmSync(resolvedDest, { recursive: true, force: true })

      const zipStat = await Bun.file(zipPath).stat()
      const zipMb   = (zipStat.size / 1024 / 1024).toFixed(2)
      const zipMs   = (performance.now() - tZip).toFixed(0)
      console.log(`  ${green('✓')}  ${cyan(rel(zipPath))}  ${dim(`${zipMb} MB · ${zipMs}ms`)}`)
      console.log()
    } catch (e) {
      console.log(`  ${red('✗')}  zip failed: ${e.message}`)
      console.log(`  ${dim(`unzipped backup preserved at: ${rel(resolvedDest)}`)}`)
      console.log()
    }
  }

  db.$close()

  const totalMs = (performance.now() - t0).toFixed(0)
  const totalMb = (totalSize / 1024 / 1024).toFixed(2)

  if (incomplete.length) {
    console.log(`  ${red(bold('✗  backup INCOMPLETE'))}  ${dim(`${incomplete.length} of ${targets.length} database(s) not backed up`)}`)
    for (const line of incomplete) console.log(`     ${dim(line)}`)
    console.log()
    console.log(`  ${dim('Whatever was written is a PARTIAL copy. Do not treat it as a restore point.')}`)
    console.log()
    process.exit(1)
  }

  console.log(`  ${green(bold('✓  backup complete'))}  ${dim(`${totalMb} MB · ${totalMs}ms`)}`)
  console.log()
}

// ─── cmdReplicate ─────────────────────────────────────────────────────────────
// Continuous WAL replication via litestream, over the databases the SCHEMA
// declares — the same resolution cmdBackup does, for the same reason: this used
// to read one `db:` path out of a transform-pipeline config, so an app with a
// `main` plus an `audit` logger replicated its rows and silently not its trail.
//
//   litestone replicate                              → every declared SQLite db
//   litestone replicate --url s3://bucket/myapp      → no config file needed
//   litestone replicate --db main                    → one database
//   litestone replicate ./litestone.config.js        → config path positionally
//
// Litestream replicates SQLite. A jsonl or logger database is a directory of
// append-only files with no WAL, so it CANNOT be covered here — reported by
// name rather than omitted, because a replication report that lists only what
// it did reads as though it did everything.

async function cmdReplicate(cfg) {
  const { createClient } = await import('../core/client.js')
  const { replicate }    = await import('./replicate.js')

  const parseResult = loadSchema(cfg.schema)
  // --db is overloaded: a NAME filter when the schema declares databases, a
  // PATH when it declares none (loadConfig already consumed it as one). Read as
  // a name in the single-database case it matches nothing and reports
  // "No databases found matching --db=./app.db".
  const onlyDb      = declaresDatabases(parseResult) ? getFlag('db') : null

  const options = {
    url:             getFlag('url')       ?? cfg.replicate?.url,
    syncInterval:    getFlag('interval')   ?? cfg.replicate?.syncInterval,
    retentionPeriod: getFlag('retention')  ?? cfg.replicate?.retentionPeriod,
    l0Retention:     getFlag('l0')         ?? cfg.replicate?.l0Retention,
  }

  if (!options.url) {
    fatal(
      `No replica url.\n` +
      `     Pass ${cyan('--url=s3://bucket/myapp')}, or add a ${cyan('replicate')} block to litestone.config.js:\n\n` +
      `       replicate: {\n` +
      `         url:             's3://bucket/myapp',\n` +
      `         syncInterval:    '10s',    // optional\n` +
      `         retentionPeriod: '720h',   // optional\n` +
      `         l0Retention:     '24h',    // optional — time-travel window\n` +
      `       }`
    )
  }

  header('litestone replicate')

  const db        = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: clientDb(parseResult, cfg), encryptionKey: getEncKey() })
  const databases = db.$databases
  db.$close()

  const declared = Object.entries(databases).filter(([name]) => !onlyDb || name === onlyDb)
  if (!declared.length) fatal(`No databases found${onlyDb ? ` matching --db=${onlyDb}` : ''}.`)

  const targets    = declared.filter(([, i]) => i.driver === 'sqlite').map(([name, i]) => ({ name, path: i.path }))
  const unreplicable = declared.filter(([, i]) => i.driver !== 'sqlite')

  if (unreplicable.length) {
    console.log(`  ${yellow(bold('⚠  not replicated'))}  ${dim('litestream streams SQLite WAL only')}`)
    for (const [name, info] of unreplicable)
      console.log(`     ${cyan(name)} ${dim(`(${info.driver})`)}  ${dim(info.path ?? 'no path')}`)
    console.log()
    console.log(`  ${dim(`Cover these with ${cyan('litestone backup')} on a schedule, or sync the directory to object storage.`)}`)
    console.log()
  }

  if (!targets.length) {
    fatal(
      `Nothing to replicate — no SQLite databases declared${onlyDb ? ` matching --db=${onlyDb}` : ''}.\n` +
      `     litestream streams SQLite WAL; jsonl and logger databases need ${cyan('litestone backup')}.`
    )
  }

  await replicate({ targets, options, dir: dirname(resolve(cfg.schema)) })
}

// ─── db push ─────────────────────────────────────────────────────────────────
// Dev equivalent of prisma db push — diffs schema against live DB and applies
// changes directly without writing migration files. Safe to run on every boot.
// Not intended for production — use migrate create / apply there.

async function cmdDbPush(cfg) {
  header('litestone db push')

  const { autoMigrate }  = await import('../core/migrations.js')
  const { createClient } = await import('../core/client.js')

  const parseResult = loadSchema(cfg.schema)
  const schema      = parseResult.schema
  const hasDbs      = schema.databases.some(db => !db.driver || db.driver === 'sqlite')

  // Open a temporary createClient just to get $rawDbs wired up correctly
  const db = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: clientDb(parseResult, cfg), encryptionKey: getEncKey() })

  const t0      = performance.now()
  const results = autoMigrate(db)
  const ms      = (performance.now() - t0).toFixed(0)

  let anyChanges = false

  for (const [dbName, result] of Object.entries(results)) {
    const label = hasDbs ? `  ${cyan(dbName)}  ` : '  '

    if (result.state === 'skipped') {
      console.log(`${label}${dim('skipped')}  ${dim(`(${result.reason})`)}`)
    } else if (result.state === 'in-sync') {
      console.log(`${label}${green('✓')}  already in sync`)
    } else if (result.state === 'migrated') {
      anyChanges = true
      console.log(`${label}${green('✓')}  ${result.applied} statement${result.applied !== 1 ? 's' : ''} applied`)
      if (flag('verbose') || flag('v')) {
        console.log()
        console.log(result.sql.split('\n').map(l => `    ${dim(l)}`).join('\n'))
        console.log()
      }
    }
  }

  db.$close()

  console.log()
  if (anyChanges) {
    console.log(`  ${green(bold('✓  DB pushed'))}  ${dim(`(${ms}ms)`)}`)
    console.log(`  ${dim('Schema applied directly — no migration files written, so a deploy')}`)
    console.log(`  ${dim('replaying migrations will not have this change.')}`)
    console.log(`  ${dim('Prototyping only. For a project that deploys:')} ${cyan('litestone migrate dev')}`)
    console.log(`  ${dim('To catch up from here:')} ${cyan('litestone migrate create')}${dim(' then ')}${cyan('litestone migrate baseline')}`)
  } else {
    console.log(`  ${green('✓')}  DB is already in sync with schema  ${dim(`(${ms}ms)`)}`)
  }
  console.log()
}


// ─── rsync ────────────────────────────────────────────────────────────────────
// Point-in-time sync of all SQLite databases in the schema to a remote
// destination using sqlite3_rsync (bundled with SQLite 3.47+).
//
// Unlike litestream (continuous WAL streaming), sqlite3_rsync is a one-shot
// sync — run it from a cron job or deploy hook. It only transfers changed
// pages so it's bandwidth-efficient even on large databases.
//
// Usage:
//   litestone --schema ./db/schema.lite rsync user@host:/backups
//   litestone --schema ./db/schema.lite rsync ./backups/
//   litestone --schema ./db/schema.lite rsync rsync://host/backups --db main
//
// Flags:
//   --db=<name>      sync only this database (default: all SQLite databases)
//   --verbose        show sqlite3_rsync output
//   --dry-run        print commands without executing

async function cmdRsync(dest, cfg) {
  header('litestone rsync')

  if (!dest) fatal('Usage: litestone rsync <destination>\n     Examples:\n       litestone rsync user@host:/backups\n       litestone rsync ./local-backup/')

  const { spawnSync } = await import('child_process')

  // ── Locate sqlite3_rsync binary ──────────────────────────────────────────
  const whichCmd = process.platform === 'win32' ? 'where' : 'which'
  const which    = spawnSync(whichCmd, ['sqlite3_rsync'], { encoding: 'utf8' })
  const binary   = which.status === 0 ? which.stdout.trim().split('\n')[0].trim() : null

  if (!binary) {
    console.log()
    console.log(`  ${red('✗')}  sqlite3_rsync not found on PATH`)
    console.log()
    console.log(`  ${dim('sqlite3_rsync ships with SQLite 3.47+. Install options:')}`)
    console.log(`  ${dim('  macOS:   brew install sqlite')}`)
    console.log(`  ${dim('  Ubuntu:  apt install sqlite3')}`)
    console.log(`  ${dim('  Manual:  https://www.sqlite.org/rsync.html')}`)
    console.log()
    process.exit(1)
  }

  const dryRun  = flag('dry-run')
  const verbose = flag('verbose') || flag('v')
  const onlyDb  = getFlag('db')

  // ── Load schema to find SQLite databases ─────────────────────────────────
  const parseResult = loadSchema(cfg.schema)
  const schema      = parseResult.schema

  // Resolve database paths the same way createClient does
  const sqliteDbs = (schema.databases ?? []).filter(d => !d.driver || d.driver === 'sqlite')

  if (!sqliteDbs.length) {
    // No database blocks — treat cfg.db as the single database
    if (!cfg.db) fatal('No database path found. Use --schema or --db to specify the database.')
    sqliteDbs.push({ name: 'main', path: { kind: 'literal', value: cfg.db } })
  }

  const targets = sqliteDbs
    .filter(d => !onlyDb || d.name === onlyDb)
    .map(d => {
      const raw = d.path.kind === 'env'
        ? (process.env[d.path.var] ?? d.path.default)
        : d.path.value
      return { name: d.name, src: resolve(raw) }
    })
    .filter(d => {
      if (!existsSync(d.src)) {
        console.log(`  ${yellow('⚠')}  ${d.name}: ${dim(d.src)} ${dim('(not found, skipping)')}`)
        return false
      }
      return true
    })

  if (!targets.length) fatal(`No SQLite databases found to sync.`)

  console.log()
  console.log(`  ${dim('destination:')} ${dest}`)
  console.log(`  ${dim('binary:')}      ${binary}`)
  console.log(`  ${dim('databases:')}   ${targets.map(t => t.name).join(', ')}`)
  if (dryRun) console.log(`  ${yellow('dry-run')}`)
  console.log()

  let allOk = true

  for (const { name, src } of targets) {
    // sqlite3_rsync <src> <dest>
    // For multiple DBs, append /<name>.db to a directory dest
    const isDir   = targets.length > 1 || dest.endsWith('/') || dest.endsWith('\\')
    const destPath = isDir
      ? dest.replace(/[\/]$/, '') + '/' + name + '.db'
      : dest

    const args = [src, destPath]
    if (verbose) args.unshift('--verbose')

    console.log(`  ${cyan('→')}  ${name}  ${dim(src)}  ${dim('→')}  ${dim(destPath)}`)

    if (dryRun) {
      console.log(`     ${dim(binary + ' ' + args.join(' '))}`)
      console.log()
      continue
    }

    const t0     = performance.now()
    const result = spawnSync(binary, args, { stdio: verbose ? 'inherit' : 'pipe', encoding: 'utf8' })
    const ms     = (performance.now() - t0).toFixed(0)

    if (result.status === 0) {
      console.log(`  ${green('✓')}  ${name}  ${dim(`(${ms}ms)`)}`)
    } else {
      allOk = false
      console.log(`  ${red('✗')}  ${name} failed  ${dim(`(exit ${result.status})`)}`)
      if (result.stderr) console.log(`     ${dim(result.stderr.trim())}`)
    }
    console.log()
  }

  if (!dryRun) {
    console.log()
    if (allOk) {
      console.log(`  ${green(bold('✓  rsync complete'))}`)
    } else {
      console.log(`  ${red('✗  one or more databases failed to sync')}`)
      process.exit(1)
    }
  }
  console.log()
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, sub, ...rest] = positional

  if (flag('version') || cmd === 'version' || flag('v')) {
    console.log(`litestone v${PKG_VERSION}`)
    return
  }

  if (!cmd || flag('help') || cmd === 'help') {
    console.log(HELP)
    return
  }

  if (cmd === 'init')   { await cmdInit();   return }
  if (cmd === 'codemod') { await cmdCodemod(sub ?? null); return }
  if (cmd === 'seed') {
    const cfg = await loadConfig()
    if (sub === 'run') { await cmdSeedRun(rest[0] ?? null, cfg); return }
    await cmdSeed(sub, cfg)
    return
  }
  if (cmd === 'introspect') { const cfg = await loadConfig(); await cmdIntrospect(sub, cfg); return }
  if (cmd === 'doctor') { await cmdDoctor(); return }
  if (cmd === 'audit')  { await cmdDoctor(); return }  // alias

  if (cmd === 'optimize') {
    const cfg = await loadConfig()
    await cmdOptimize(sub ?? null, cfg)
    return
  }

  if (cmd === 'edge') {
    if (sub !== 'eject') fatal(`Unknown edge subcommand "${sub ?? ''}". Use: eject`)
    const target = rest.find(a => !a.startsWith('--'))
    if (!target) fatal('Usage: litestone edge eject <Model>.<field> [--apply]')
    const cfg = await loadConfig()
    await cmdEdgeEject(target, cfg, flag('apply'))
    return
  }

  if (cmd === 'backup') {
    const cfg = await loadConfig()
    await cmdBackup(sub ?? null, cfg)
    return
  }

  if (cmd === 'rsync') {
    const cfg  = await loadConfig()
    await cmdRsync(sub, cfg)
    return
  }

  if (cmd === 'replicate') {
    // A positional argument is the config path, kept from the original form.
    // Anything else would be silently ignored, so it is refused by name.
    if (sub && !/\.(js|ts)$/.test(sub))
      fatal(`litestone replicate takes a config file positionally, got: ${sub}\n     To point at a schema, use ${cyan('--schema=path/to/schema.lite')}.`)
    const cfg = await loadConfig(sub ?? undefined)
    cmdReplicate(cfg).catch(err => {
      console.error(`\n  ${red('✗')}  ${err.message}\n`)
      if (flag('debug')) console.error(err.stack)
      process.exit(1)
    })
    return   // intentionally no await — replicate() runs until Ctrl+C
  }

  if (cmd === 'types') {
    const cfg = await loadConfig()
    await cmdTypes(sub, cfg)
    return
  }

  // litestone explain [@word]
  //
  // The catalog's second reader, and the reason it is a module rather than a
  // panel: Studio answers this in a browser, and the same rows answer it here
  // with no server, no schema and no database. A word is looked up by what you
  // TYPE — the prefix picks the level, because @unique is a column constraint
  // and @@unique is a composite one and answering the wrong one is worse than
  // answering neither.
  if (cmd === 'explain') { await cmdExplain(positional[1]); return }

  // litestone advise
  //
  // The one command that reads YOUR schema and says something about it that no
  // generated artefact can. Everything this repo commits answers *what did you
  // declare* — the DDL, the access surface, the JSON Schema — so a word absent
  // from the seed is absent from all of them, and nobody has ever been told
  // about a feature they never heard of.
  //
  // Two lists and they are two questions. `rules` is legal-and-wrong: the schema
  // says something and a layer above the parser refuses it. `opportunities` is
  // legal-and-missing: it says nothing, everything works, and a word would have
  // said it better. Neither is a build failure and neither takes a --check;
  // `fli test:access` and `release:check` are the ones that gate.
  if (cmd === 'advise') { const cfg = await loadConfig(); await cmdAdvise(cfg); return }

  // The one snapshot with no --schema: the language surface is a property of
  // this package, not of an app's seed, so it is rendered from the catalog and
  // written beside it.
  if (cmd === 'catalog') {
    // Two renderings of one table, and the difference is who reads them.
    // --snapshot is for a REVIEWER: facts in columns, no prose, so a diff is
    // what changed rather than a reshuffle on an edited sentence. --reference is
    // for a PERSON looking a word up: blurbs, worked examples, cross-links. Both
    // are gated, because a generated page nothing rechecks goes stale exactly
    // the way the hand-written lists it replaces did.
    const reference = flag('reference')
    const { renderCatalogSnapshot }  = reference ? {} : await import('./catalog-snapshot.js')
    const { renderCatalogReference } = reference ? await import('./catalog-reference.js') : {}

    const body    = reference ? renderCatalogReference() : renderCatalogSnapshot()
    const cmdline = reference ? 'litestone catalog --reference' : 'litestone catalog --snapshot'
    const outPath = getFlag('out')
      ? resolve(getFlag('out'))
      : resolve(import.meta.dirname, reference ? '../../docs/reference.snapshot.md'
                                               : '../../catalog.snapshot.md')

    if (flag('stdout')) { process.stdout.write(body); return }
    if (flag('check')) {
      checkSnapshot(outPath, body, {
        regen: cmdline,
        moved: `The .lite language surface changed. Run \`${cmdline}\` and review the diff before committing.`,
      })
      console.log()
      return
    }
    writeFileSync(outPath, body, 'utf8')
    console.log(`  ${green('✓')}  ${rel(outPath)}`)
    console.log()
    return
  }

  if (cmd === 'jsonschema') {
    const cfg = await loadConfig()
    await cmdJsonSchema(cfg)
    return
  }

  if (cmd === 'access') {
    const cfg = await loadConfig()
    await cmdAccess(cfg)
    return
  }

  if (cmd === 'ddl') {
    const cfg = await loadConfig()
    await cmdDdl(cfg)
    return
  }

  if (cmd === 'release') {
    const cfg = await loadConfig()
    await cmdRelease(cfg)
    return
  }

  if (cmd === 'mutate') {
    const cfg = await loadConfig()
    await cmdMutate(cfg)
    return
  }

  if (cmd === 'tenant') {
    const subCmd = args.find(a => !a.startsWith('--'))
    const rest   = args.filter(a => a !== subCmd && !a.startsWith('--'))
    const cfg    = await loadConfig()
    await cmdTenant(subCmd, rest, cfg)
    return
  }

  if (cmd === 'repl') {
    const cfg = await loadConfig()
    await cmdRepl(cfg)
    return
  }

  if (cmd === 'studio') {
    const cfg = await loadConfig()
    await cmdStudio(cfg)
    return
  }

  if (cmd === 'db') {
    if (sub === 'push') {
      const cfg = await loadConfig()
      await cmdDbPush(cfg)
      return
    }
    fatal(`Unknown db subcommand "${sub}". Available: push`)
  }

  if (cmd === 'migrate') {
    const cfg = await loadConfig()

    if (!sub) {
      console.error(`\n  ${red('✗')}  migrate requires a subcommand\n`)
      console.log(`  ${cyan('dev')} [label]  ·  ${cyan('create')} [label]  ·  ${cyan('apply')}  ·  ${cyan('check')}  ·  ${cyan('baseline')}  ·  ${cyan('status')}  ·  ${cyan('verify')}  ·  ${cyan('dry-run')} [label]\n`)
      process.exit(1)
    }

    switch (sub) {
      case 'dev':      await cmdDev(rest[0], cfg);     break
      case 'create':   await cmdCreate(rest[0], cfg);  break
      case 'dry-run':  await cmdDryRun(rest[0], cfg);  break
      case 'apply':    await cmdApply(cfg);            break
      case 'baseline': await cmdBaseline(cfg);         break
      case 'check':    await cmdCheck(cfg);            break
      case 'status':   await cmdStatus(cfg);           break
      case 'verify':   await cmdVerify(cfg);           break
      default:
        console.error(`\n  ${red('✗')}  unknown migrate subcommand: ${red(sub)}\n`)
        process.exit(1)
    }
    return
  }

  // ── Transform command ────────────────────────────────────────────────────────
  // Routes to the pipeline DSL transformer — separate from the ORM.
  // litestone transform config.js [--dry-run] [--preview] [--out=...] etc.
  // Also triggered when first arg looks like a .js config file and no cmd matches.

  if (cmd === 'transform' || (cmd && cmd.endsWith('.js') && !['init','seed','introspect','doctor','audit','jsonschema','tenant','repl','studio','migrate','replicate'].includes(cmd))) {
    const configPath   = cmd === 'transform' ? (sub ?? './litestone.transform.js') : cmd
    const dryRun       = flag('dry-run')
    const previewMode  = flag('preview')
    const skipExisting = flag('skip-existing')
    const force        = flag('force')
    const outputPath   = getFlag('out')
    const onlyArg      = getFlag('only')
    const only         = onlyArg ? onlyArg.split(',').map(v => v.trim()) : null
    const concurrency  = parseInt(getFlag('concurrency') ?? '8')
    const paramsArg    = getFlag('params')

    if (paramsArg) {
      try {
        JSON.parse(paramsArg)
        process.env.TRANSFORM_PARAMS = paramsArg
      } catch {
        console.error(`\n  ${red('✗')}  --params must be valid JSON\n`)
        process.exit(1)
      }
    }

    const { preview, execute } = await import('../transform/framework.js')
    const { run }              = await import('../transform/runner.js')

    if (previewMode) {
      await preview(configPath)
    } else {
      await execute(configPath, { dryRun, verbose: true, outputPath, only, concurrency, skipExisting, force }, run)
    }
    return
  }

  console.error(`\n  ${red('✗')}  unknown command: ${red(cmd)}\n`)
  console.log(HELP)
  process.exit(1)
}

main().catch(e => {
  console.error(`\n  ${red('Fatal')}  ${e.message}\n`)
  if (flag('debug')) console.error(e.stack)
  else console.error(`  ${dim('(run with --debug for stack trace)')}`)
  process.exit(1)
})
