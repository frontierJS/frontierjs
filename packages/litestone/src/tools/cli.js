#!/usr/bin/env bun
// litestone CLI

import { existsSync, writeFileSync, readFileSync, statSync, mkdirSync, readdirSync } from 'fs'
import { resolve, relative, join, dirname }       from 'path'
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
import { parse }                                       from '../core/parser.js'
import { buildPristine, introspect, diffSchemas,
         generateMigrationSQL, summariseDiff }         from '../core/migrate.js'
import { create, apply, status, verify,
         createForDatabase, listMigrationFiles,
         appliedMigrations }                           from '../core/migrations.js'
import { modelToAccessor }                             from '../core/ddl.js'

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
    ${cyan('litestone migrate status')}            show applied / pending / modified
    ${cyan('litestone migrate verify')}            check if live db matches schema
    ${cyan('litestone db push')}                    apply schema directly — no migration files (dev)
    ${cyan('litestone types')} [out.d.ts]            generate TypeScript declarations from schema
    ${dim('  --only=users,posts')}                  only emit types for specified models
    ${dim('  --audience=client|system')}             field visibility (default: client)
    ${cyan('litestone studio')}                     open local web UI
    ${cyan('litestone repl')}                       interactive Litestone REPL
    ${cyan('litestone doctor')}                     check setup, audit health
    ${cyan('litestone seed')} [SeederClass]             seed the database
    ${cyan('litestone seed run')} [name]               run an infrastructure seed (--force to re-run)
    ${cyan('litestone introspect')} <db>              reverse-engineer db → schema.lite
    ${cyan('litestone diagram')}                    ER diagram (opens in studio)
    ${cyan('litestone optimize')} [table]            optimize FTS5 indexes (all or one table)
    ${cyan('litestone edge eject')} <Model>.<field>  promote an @edge/@scoped field to a real model [--apply]
    ${cyan('litestone backup')} [dest]               backup all databases (SQLite + JSONL/logger)
    ${cyan('litestone replicate')} [config.js]       stream WAL to S3/R2 via litestream
    ${cyan('litestone rsync')} <dest>              sync all SQLite DBs to a destination via sqlite3_rsync
    ${cyan('litestone transform')} [config.js]      run a transform pipeline (DSL)
    ${cyan('litestone tenant list')}                list all tenants
    ${cyan('litestone tenant create <id>')}         create a new tenant
    ${cyan('litestone tenant delete <id>')}         delete a tenant
    ${cyan('litestone tenant migrate')}             migrate all tenants
    ${cyan('litestone jsonschema')}                   generate JSON Schema from schema.lite

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

async function loadConfig() {
  // ── Resolution order ─────────────────────────────────────────────────────────
  //
  // schema:     --schema flag  →  config schema:  →  sibling to config  →  ./schema.lite in cwd
  // db:         --db flag      →  config db:      →  null (comes from database block in schema)
  // migrations: --migrations   →  config migrations:  →  sibling ./migrations to schema
  //
  // --config must be a .js or .ts file — use --schema to point directly at a .lite file.

  const configPath = getFlag('config')
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
    // No --config — look for litestone.config.js in cwd
    const defaultCfg = resolve('./litestone.config.js')
    if (existsSync(defaultCfg)) {
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
      ?? (existsSync(resolve(cfgDir, 'schema.lite')) ? resolve(cfgDir, 'schema.lite') : null)
      ?? (existsSync(resolve('./schema.lite'))        ? resolve('./schema.lite')        : null)

  // migrations dir resolves relative to schema file location when known
  const schemaDir = schemaPath ? dirname(schemaPath) : cfgDir

  return {
    db:         getFlag('db')         ? resolve(getFlag('db'))         : fromCfg(cfg.db, 'db') ?? resolve('./development.db'),
    schema:     schemaPath,
    migrations: getFlag('migrations') ? resolve(getFlag('migrations')) : fromCfg(cfg.migrations, 'migrations') ?? resolve(schemaDir, 'migrations'),
    seedsDir:   fromCfg(cfg.seedsDir, 'seedsDir') ?? null,
    pluralize:  cfg.pluralize ?? false,
    tenants:    cfg.tenants ?? null,   // { dir, registry, migrationsDir } — used by tenant cmds + Studio
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
      `     Looked for: ${cyan('--schema')} flag → ${cyan('schema:')} in litestone.config.js → ${cyan('./schema.lite')}\n` +
      `     Fix: run this from your project directory, pass ${cyan('--schema=path/to/schema.lite')},\n` +
      `     or run ${cyan('litestone init')} to create a new schema.`
    )
  }
  const abs = resolve(schemaPath)
  if (!existsSync(abs))
    fatal(`Schema file not found: ${abs}\n     Run ${cyan('litestone init')} to create one.`)

  const result = parse(readFileSync(abs, 'utf8'))
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
    if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true })
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

function resolveDbPath(pathDef, fallback) {
  if (!pathDef) return fallback ? resolve(fallback) : null
  if (pathDef.var) {
    const envVal = process.env[pathDef.var]
    return resolve(envVal ?? pathDef.default ?? fallback ?? '.')
  }
  return resolve(pathDef.value ?? fallback ?? '.')
}

// Returns array of { name, rawDb, migrationsDir } for every sqlite database.
// Opens raw Database connections — caller must close them.
function openSqliteDbs(parseResult, cfg) {
  const schema = parseResult.schema
  const hasDatabaseBlocks = schema.databases.some(db => !db.driver || db.driver === 'sqlite')

  if (!hasDatabaseBlocks) {
    // Single-DB schema — just main, using cfg.db
    if (!cfg.db) fatal('No database path specified. Set db in litestone.config.js or pass --db=<path>')
    return [{ name: 'main', rawDb: openDb(cfg.db), migrationsDir: cfg.migrations }]
  }

  const result = []
  for (const db of schema.databases) {
    if (db.driver === 'jsonl' || db.driver === 'logger') continue  // no SQL schema
    const absPath = resolveDbPath(db.path, null)
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
      migrationsDir: join(cfg.migrations, db.name),
    })
  }

  return result
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

async function cmdApply(cfg) {
  header('litestone migrate apply')

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')
  let   totalOk     = 0
  let   anyFailed   = false

  try {
    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)

      // Set optimal page size on brand new databases
      const pageCount = rawDb.query('PRAGMA page_count').get()
      if (pageCount && pageCount.page_count <= 1) rawDb.run('PRAGMA page_size = 8192')

      // Create Litestone client if any JS migrations are pending
      // (needed so JS migrations receive full ORM access)
      const hasPendingJs = listMigrationFiles(migrationsDir)
        .some(f => f.endsWith('.js') && !new Set(appliedMigrations(rawDb).map(m => m.name)).has(f))
      let lsClient = null
      if (hasPendingJs) {
        const { createClient } = await import('../core/client.js')
        lsClient = await createClient({ parsed: parseResult, db: rawDb, encryptionKey: getEncKey() })
      }

      const result = await apply(rawDb, migrationsDir, lsClient)
      if (lsClient) lsClient.$close()

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
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }

  if (anyFailed) {
    console.error(`\n  ${red('✗')}  One or more migrations failed — affected databases unchanged.\n`)
    process.exit(1)
  }

  if (totalOk > 0) {
    console.log(`\n  ${green(bold(`${totalOk} migration${totalOk !== 1 ? 's' : ''} applied`))}`)
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
  }
  const stateLabel = {
    applied:  dim('applied '),
    pending:  yellow('pending '),
    modified: red('modified'),
    orphaned: red('orphaned'),
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
        problems: rows.filter(r => r.state === 'modified' || r.state === 'orphaned').length,
      }

      console.log()
      if (counts.applied)  console.log(`  ${dim(`${counts.applied} applied`)}`)
      if (counts.pending)  console.log(`  ${yellow(`${counts.pending} pending`)}`)
      if (counts.problems) console.log(`  ${red(`${counts.problems} problem${counts.problems > 1 ? 's' : ''}`)}`)
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


// ─── REPL ─────────────────────────────────────────────────────────────────────
// Starts an interactive Litestone REPL with:
//   - Schema-aware tab completion (db.<table>.<method>, where fields)
//   - Persistent per-project history (↑/↓ cycles through past queries)
//   - Top-level await support
//
// Launches src/repl-server.js as a subprocess, passing schema info via env.
// History is stored in .litestone_history in the project root.

async function cmdRepl(cfg) {
  header('litestone repl')

  // The REPL is the one command that cannot run from a compiled binary: it
  // drives `bun repl` as a subprocess and feeds it a temp file that imports
  // core/client.js by absolute path. Inside a binary those paths are /$bunfs
  // entries that a separate bun process cannot see. Fail loudly rather than
  // emitting a confusing "Cannot find module /$bunfs/root/..." from the child.
  if (IS_COMPILED)
    fatal(`${cyan('litestone repl')} is not available in the standalone binary.\n` +
          `     It drives a separate ${cyan('bun repl')} process that needs the package on disk.\n` +
          `     Run it from an installed package instead: ${cyan('bunx @frontierjs/litestone repl')}`)

  const parseResult = loadSchema(cfg.schema)
  const { isSoftDelete } = await import('../core/ddl.js')

  // Model names are PascalCase singular; accessors on the client are camelCase.
  const models    = parseResult.schema.models.map(m => m.name)
  const accessors = parseResult.schema.models.map(m => modelToAccessor(m.name))
  const softTbls  = parseResult.schema.models.filter(m => isSoftDelete(m)).map(m => modelToAccessor(m.name))
  const enums     = parseResult.schema.enums.map(e => e.name)

  // import.meta.dir is only trustworthy here because IS_COMPILED gated us out
  // above — under `--bytecode` it resolves to the build machine's source path.
  const replServer = resolve(import.meta.dir, 'repl-server.js')  // same tools/ dir

  const dbDisplay = parseResult.schema.databases.length
    ? parseResult.schema.databases.filter(d => !d.driver || d.driver === 'sqlite').map(d => d.name).join(', ')
    : (cfg.db ? rel(resolve(cfg.db)) : '(from schema)')
  console.log(`  ${dim('Database:')}  ${dbDisplay}`)
  console.log(`  ${dim('Tables:')}    ${accessors.join(', ')}`)
  if (softTbls.length)
    console.log(`  ${dim('Soft delete:')} ${softTbls.join(', ')}`)
  if (enums.length)
    console.log(`  ${dim('Enums:')}     ${enums.join(', ')}`)
  console.log()
  console.log(`  ${green('✓')}  ${cyan('db')} is ready — Tab to complete, ↑↓ for history`)
  console.log(`  ${dim('History:')}    ~/.bun_repl_history  ${dim('(managed by Bun)')}`)
  console.log()
  console.log(`  ${dim('Examples:')}`)
  console.log(`    ${cyan('db.' + accessors[0] + '.findMany()')}`)
  console.log(`    ${cyan('db.' + accessors[0] + '.count()')}`)
  if (accessors.length > 1)
    console.log(`    ${cyan('db.' + accessors[1] + '.findFirst({ where: { id: 1 } })')}`)
  console.log()
  console.log(`  ${dim('Tab to complete · ↑↓ history · .help for commands · Ctrl+C to exit')}\n`)

  // Bun's REPL runs in a sandboxed context — preload globals aren't visible.
  // Solution: write a temp setup file, then use the REPL's built-in `.load`
  // command to eval it directly in the REPL scope. Then forward stdin normally.

  const { writeFileSync, unlinkSync } = await import('fs')
  const tmpSetup = resolve(process.env.TMPDIR || '/tmp', `litestone-db-${Date.now()}.ts`)

  // This file runs inside the REPL context via .load — `db` becomes a REPL variable
  writeFileSync(tmpSetup, [
    `import { createClient } from ${JSON.stringify(resolve(import.meta.dir, '../core/client.js'))}`,
    `import { parseFile }    from ${JSON.stringify(resolve(import.meta.dir, '../core/parser.js'))}`,
    `var db = await createClient({ path: ${JSON.stringify(resolve(cfg.schema))}${cfg.db ? `, db: ${JSON.stringify(resolve(cfg.db))}` : ''} })`,
    `globalThis.db = db`,  // also set on globalThis for Tab completion lookup
    `console.log('  ✓ db ready — ' + ${JSON.stringify(accessors)}.join(', '))`,
  ].join('\n'))

  const proc = Bun.spawn(['bun', 'repl'], {
    stdin:  'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  // Wait for REPL to start and print welcome banner
  await Bun.sleep(400)

  // .load evals the file in the REPL's own scope — db becomes a real REPL variable
  proc.stdin.write(`.load ${tmpSetup}\n`)

  // Give .load time to finish (createClient is async — awaited inside the file)
  await Bun.sleep(600)

  // Forward the user's real stdin to the REPL process
  for await (const chunk of Bun.stdin.stream()) {
    proc.stdin.write(chunk)
    if (proc.exitCode !== null) break
  }

  await proc.exited
  try { unlinkSync(tmpSetup) } catch {}
}


// ─── Tenant management ────────────────────────────────────────────────────────

async function cmdTenant(subCmd, args, cfg) {
  const { createTenantRegistry } = await import('../tenant.js')

  if (!cfg.schema) fatal('No schema found. Use --schema ./db/schema.lite')

  const dir           = getFlag('dir')           ?? cfg.tenants?.dir           ?? './tenants'
  const migrationsDir = getFlag('migrations')    ?? cfg.tenants?.migrationsDir ?? cfg.migrations
  const concurrency   = parseInt(getFlag('concurrency') ?? '8')

  const tenants = await createTenantRegistry({
    dir,
    schema:        cfg.schema,
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

function parsePlanDetail(detail) {
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
    const col = detail.match(/ORDER BY (.+)$/i)?.[1] ?? 'ORDER BY column'
    return {
      rating: 'yellow',
      advice: `<b>Temp sort</b> — SQLite built a temporary B-tree to sort results. Add an index on your ORDER BY column to avoid this.`,
    }
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
  const db     = await createClient({ parsed: parseResult, db: cfg.db, encryptionKey: getEncKey() })
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
  const _tenantDirOpt   = cfg.tenants?.dir      ? resolve(cfg.tenants.dir)      : join(_schemaDir, 'tenants')
  const _tenantRegOpt   = cfg.tenants?.registry ? resolve(cfg.tenants.registry) : join(_schemaDir, 'tenants-registry.db')
  const tenantsEnabled  = !!cfg.tenants || existsSync(_tenantRegOpt)
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
      if (f.attributes?.some(a => ['computed', 'guarded', 'secret', 'encrypted', 'omit'].includes(a.kind))) continue
      const t = f.type.name
      if (t === 'String')                      or.push({ [f.name]: { contains: q } })
      else if ((t === 'Int' || t === 'Float') && numeric) or.push({ [f.name]: num })
      else if (t === 'DateTime' && /^\d{4}(-\d{2})?(-\d{2})?/.test(q)) or.push({ [f.name]: { gte: q, lt: q + '~' } })
    }
    // No searchable field matches this query shape → return an impossible
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
        const MUTATING = ['/api/row/', '/api/rows/', '/api/import', '/api/repl',
          '/api/migrations/apply', '/api/migrations/auto', '/api/migrations/create',
          '/api/maint/', '/api/transform/run', '/api/tenants/migrate']
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
            .filter(f => f.type.kind !== 'relation' && !f.attributes.find(a => a.kind === 'computed'))
            .map(f => f.name) ?? []
          return json({ ...result, columns, total })
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
            .filter(f => f.type.kind !== 'relation' && !f.attributes.find(a => a.kind === 'computed'))
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

        // GET /api/perf/advisor — schema-level index analysis
        if (path === '/api/perf/advisor') {
          const issues = []
          const models = activeDb.$schema.models

          for (const model of models) {
            const tableName = model.name
            // Get existing indexes from live db
            const existingIndexes = rawDb
              .query(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`)
              .all(tableName)
            const indexedCols = new Set()
            for (const idx of existingIndexes) {
              const m = idx.sql?.match(/\(([^)]+)\)/)
              if (m) m[1].split(',').map(c => c.trim().replace(/^["'`]|["'`]$/g, '')).forEach(c => indexedCols.add(c))
            }

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
                    title:       `Missing FK index on ${tableName}.${col}`,
                    table:       tableName,
                    description: `Foreign key column "${col}" on "${tableName}" has no index. Every include({ ${field.name}: true }) will do a full table scan to resolve this relation.`,
                    impact:      'Full table scan on every related record lookup. With 10k rows this is ~10ms per query. With 100k rows it becomes noticeable.',
                    sql:         `CREATE INDEX "${tableName}_${col}_idx" ON "${tableName}"("${col}");`,
                    notes:       'SQLite does not automatically index foreign key columns — you must create them explicitly.',
                  })
                }
              }
            }

            // 2. Soft-delete tables: deletedAt should be indexed
            const hasSoftDelete = model.attributes.some(a => a.kind === 'softDelete')
            if (hasSoftDelete && !indexedCols.has('deletedAt')) {
              issues.push({
                severity:    'yellow',
                title:       `No index on ${tableName}.deletedAt`,
                table:       tableName,
                description: `"${tableName}" uses @@softDelete but "deletedAt" is not indexed. Every query filters "WHERE deletedAt IS NULL" — without an index this scans the full table.`,
                impact:      'All findMany/findFirst/count calls filter on deletedAt. This becomes slower as rows accumulate.',
                sql:         `CREATE INDEX "${tableName}_deleted_at_idx" ON "${tableName}"("deletedAt");`,
                notes:       'A partial index (WHERE deletedAt IS NULL) is even better but requires SQLite 3.8+.',
              })
            }

            // 3. @@index declared in schema but not in live db
            const declaredIndexes = model.attributes.filter(a => a.kind === 'index' || a.kind === 'unique')
            for (const attr of declaredIndexes) {
              const cols     = attr.fields ?? []
              const isUnique = attr.kind === 'unique'
              // Check if any existing index covers exactly these cols
              const covered = existingIndexes.some(idx => {
                const m = idx.sql?.match(/\(([^)]+)\)/)
                if (!m) return false
                const idxCols = m[1].split(',').map(c => c.trim().replace(/^["'`]|["'`]$/g, ''))
                return cols.length === idxCols.length && cols.every((c, i) => c === idxCols[i])
              })
              if (!covered && cols.length) {
                const idxName = `${tableName}_${cols.join('_')}_idx`
                issues.push({
                  severity:    'red',
                  title:       `Pending ${isUnique ? 'unique ' : ''}index on ${tableName}`,
                  table:       tableName,
                  description: `Schema declares @@${isUnique ? 'unique' : 'index'}([${cols.join(', ')}]) on "${tableName}" but this index doesn't exist in the live database. Run a migration to create it.`,
                  impact:      'Queries filtering or sorting on these columns are doing full table scans.',
                  sql:         `CREATE ${isUnique ? 'UNIQUE ' : ''}INDEX "${idxName}" ON "${tableName}"(${cols.map(c => `"${c}"`).join(', ')});`,
                  notes:       'Run "litestone migrate apply" to apply pending schema changes.',
                })
              }
            }

            // 4. High row-count tables with no indexes at all (except PK)
            try {
              const rowCount = activeRawDb.query(`SELECT COUNT(*) as n FROM "${tableName}"`).get().n
              const nonPkIndexes = existingIndexes.filter(idx => !idx.name.startsWith('sqlite_'))
              if (rowCount > 5000 && nonPkIndexes.length === 0) {
                issues.push({
                  severity:    'yellow',
                  title:       `Large table with no indexes: ${tableName}`,
                  table:       tableName,
                  description: `"${tableName}" has ${rowCount.toLocaleString()} rows but only a primary key index. Any WHERE clause on non-PK columns will scan all rows.`,
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

            // Parse each plan row into a rated node
            const nodes = planRows.map(row => {
              const detail = row.detail ?? ''
              return { detail, ...parsePlanDetail(detail) }
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
  const url = `http://${displayHost}:${port}`
  console.log(`  ${green('✓')}  Studio at ${cyan(url)}${hostname !== '127.0.0.1' ? dim(`  (listening on ${hostname})`) : ''}`)
  if (cfg.db) console.log(`  ${dim('db:')}     ${rel(resolve(cfg.db))}`)
  else {
    const sqliteDbs = parseResult.schema.databases.filter(d => !d.driver || d.driver === 'sqlite')
    for (const d of sqliteDbs) {
      const absPath = resolveDbPath(d.path, null)
      if (absPath) console.log(`  ${dim(`db (${d.name}):`)}  ${rel(absPath)}`)
    }
  }
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

  if (!['client','system'].includes(audience))
    fatal(`--audience must be "client" or "system"`)

  // Filter schema to only requested models if --only is specified
  const schema = onlyModels
    ? { ...parseResult.schema, models: parseResult.schema.models.filter(m => onlyModels.has(m.name)) }
    : parseResult.schema

  const dts    = generateTypeScript(schema, { audience })
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
  console.log()
}

async function cmdJsonSchema(cfg) {
  // Same trap as cmdTypes: `litestone jsonschema --stdout > schema.json` wrote
  // the banner into the file, so the JSON did not parse.
  if (!flag('stdout')) header('litestone jsonschema')

  const { generateJsonSchema } = await import('../jsonschema.js')
  const parseResult = loadSchema(cfg.schema)

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
                dbPath:       (() => { try { return resolveDbPath(d.path, null) } catch { return null } })(),
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

  const db = await createClient({ parsed: parseResult, db: cfg.db, encryptionKey: getEncKey() })

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
  raw.run(`CREATE TABLE IF NOT EXISTS _litestone_seeds (
    name       TEXT PRIMARY KEY,
    status     TEXT NOT NULL DEFAULT 'applied',
    appliedAt  TEXT NOT NULL DEFAULT (datetime('now')),
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
      const db = await createClient({ parsed: parseResult, db: dbPath, encryptionKey: getEncKey() })
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
      `INSERT INTO _litestone_seeds (name, status, appliedAt) VALUES (?, 'applied', datetime('now'))
       ON CONFLICT(name) DO UPDATE SET status = 'applied', appliedAt = datetime('now')`,
      seedName
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
  const db = await createClient({ parsed: parseResult, db: cfg.db, encryptionKey: getEncKey() })

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
  const onlyDb      = getFlag('db')

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

  // ── Open client to resolve database paths ──────────────────────────────────
  const db        = await createClient({ parsed: parseResult, db: cfg.db, encryptionKey: getEncKey() })
  const databases = db.$databases
  db.$close()

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

  for (const [name, info] of targets) {
    const t1 = performance.now()

    if (info.driver === 'sqlite') {
      // ── SQLite: hot backup ──────────────────────────────────────────────
      const destFile = resolve(resolvedDest, `${name}.db`)
      try {
        const singleDb = await createClient({ parsed: parseResult, db: info.path, encryptionKey: getEncKey() })
        const result   = await singleDb.$backup(destFile, { vacuum })
        singleDb.$close()
        totalSize += result.size ?? 0
        const mb = ((result.size ?? 0) / 1024 / 1024).toFixed(2)
        const ms = (performance.now() - t1).toFixed(0)
        console.log(`  ${green('✓')}  ${cyan(name)}  ${dim(`${mb} MB · ${ms}ms${vacuum ? ' · vacuumed' : ''}`)}`)
        console.log(`     ${dim(rel(destFile))}`)
      } catch (e) {
        console.log(`  ${red('✗')}  ${cyan(name)} failed: ${e.message}`)
      }

    } else if (info.driver === 'jsonl' || info.driver === 'logger') {
      // ── JSONL / logger: directory copy ──────────────────────────────────
      if (!info.path) {
        console.log(`  ${yellow('⚠')}  ${cyan(name)}: no path configured, skipping`)
        continue
      }
      const srcDir  = resolve(info.path)
      const destDir = resolve(resolvedDest, name)
      if (!existsSync(srcDir)) {
        console.log(`  ${yellow('⚠')}  ${cyan(name)}: ${dim(srcDir)} not found, skipping`)
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

  const totalMs = (performance.now() - t0).toFixed(0)
  const totalMb = (totalSize / 1024 / 1024).toFixed(2)
  console.log(`  ${green(bold('✓  backup complete'))}  ${dim(`${totalMb} MB · ${totalMs}ms`)}`)
  console.log()
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
  const db = await createClient({ parsed: parseResult, db: cfg.db, encryptionKey: getEncKey() })

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
    console.log(`  ${dim('Schema applied directly — no migration files written.')}`)
    console.log(`  ${dim('When ready for production, run:')} ${cyan('litestone migrate create')}`)
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
    const configPath = sub ?? './litestone.config.js'
    const { replicate } = await import('./replicate.js')
    replicate(configPath, { verbose: true }).catch(err => {
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

  if (cmd === 'jsonschema') {
    const cfg = await loadConfig()
    await cmdJsonSchema(cfg)
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
      console.log(`  ${cyan('create')} [label]  ·  ${cyan('apply')}  ·  ${cyan('status')}  ·  ${cyan('verify')}  ·  ${cyan('dry-run')} [label]\n`)
      process.exit(1)
    }

    switch (sub) {
      case 'create':  await cmdCreate(rest[0], cfg);  break
      case 'dry-run': await cmdDryRun(rest[0], cfg);  break
      case 'apply':   await cmdApply(cfg);             break
      case 'status':  await cmdStatus(cfg);            break
      case 'verify':  await cmdVerify(cfg);            break
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
