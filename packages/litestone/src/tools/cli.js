#!/usr/bin/env bun
// litestone CLI

import { existsSync, writeFileSync, readFileSync, statSync, mkdirSync, readdirSync } from 'fs'
import { applyBusyTimeout } from '../core/pragmas.js'
import { resolve, relative, join, dirname, basename, extname, sep } from 'path'
import { openDatabase }                           from '../core/engine.js'

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
import { inlineImportsFromDisk }                       from '../core/parser.js'
import { buildPristine, introspect, diffSchemas,
         generateMigrationSQL, summarizeDiff }         from '../core/migrate.js'
import { create, apply, status, verify,
         createForDatabase, listMigrationFiles, migrationStatements,
         describeSkipped, appliedMigrations,
         baseline, historyGap, driftAgainstLive,
         unacceptedLoss, unresolvedBlocks, renameCandidates } from '../core/migrations.js'
import { parseRenameFlag, readOperations, askRenames } from '../core/operations.js'
import { backupSqliteTo }                              from '../core/backup.js'
import { schemaAnchor, noteMintedDirectory }          from '../core/db-path.js'
import { resolveTenancy }                              from '../core/tenancy.js'
import { modelToAccessor, modelToTableName }           from '../core/ddl.js'
import { findPrincipal }                               from './principal.js'
import { c, bold, dim, green, yellow, red, cyan, args, positional, flag, getFlag, getFlags,
         fatal, rel, header, loadSchema, getEncKey, resolveDbPath,
         declaresDatabases, clientDb, loadGateResolver,
         loadBaselineSchema, parseBaseline }        from './cli-helpers.js'

// Assets that must survive `bun build --compile`. A text import is embedded in
// the binary; readFileSync(import.meta.dir + ...) is not.
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


// ─── .env loading ─────────────────────────────────────────────────────────────
// Auto-load environment variables from .env files in cwd before any command
// runs. This matches behavior developers expect from tools like Prisma and
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


// ─── Help ─────────────────────────────────────────────────────────────────────

const HELP = `
  ${bold('litestone')}  SQLite schema & migration tool

  ${bold('Commands')}
    ${cyan('litestone init')}                      create schema.lite + litestone.config.js
    ${cyan('litestone migrate create')} [label]    diff schema → write migration file
                                     ${dim('--rename Model.oldColumn=newField   keep a renamed column\'s values (repeatable)')}
                                     ${dim('--operations ops.json               the same, as a document')}
    ${cyan('litestone migrate dry-run')} [label]   preview migration SQL, no file written
    ${cyan('litestone migrate apply')}             apply all pending migrations
    ${dim('  --backup[=dir]')}                       copy every database first — there is no down
    ${dim('  refuses a file whose DESTRUCTIVE box still says "Accept data loss: no"')}
    ${cyan('litestone migrate status')}            show applied / pending / modified
    ${cyan('litestone migrate verify')}            check if live db matches schema
    ${cyan('litestone db push')}                    apply schema directly — no migration files (dev)
    ${dim('  --accept-data-loss')}                  allow a change that drops a column and its values
    ${dim('  at a terminal, a drop asks y/N instead; anywhere else it refuses')}
    ${cyan('litestone types')} [out.d.ts]            generate TypeScript declarations from schema
    ${dim('  --only=users,posts')}                  only emit types for specified models
    ${dim('  --audience=client|system')}             field visibility (default: client)
    ${cyan('litestone studio')} [--no-open]        open Litestone Studio
    ${dim('  --gate <path[#export]>')}              grade previews with this app's own getLevel
    ${dim('  --host <addr> --token <secret>')}      serve beyond loopback; the token is required there
    ${cyan('litestone repl')} [--as|--level|--gate]  a console that boots at a gate level
    ${dim(`  --eval '<expr>'`)}                     evaluate one line, print it as JSON, exit 1 on a throw
    ${dim('  --tenant <id>')}                       whose database, under strategy database (asked when omitted)
    ${cyan('litestone export')} <dataset> --as <who>  take an extract, graded as that account
    ${cyan('litestone doctor')}                     check setup, audit health
    ${cyan('litestone seed')} [SeederClass]             seed the database
    ${cyan('litestone seed run')} [name]               run an infrastructure seed (--force to re-run)
    ${cyan('litestone introspect')} <db>              reverse-engineer db → schema.lite
    ${cyan('litestone import')} <path>                 read a foreign schema → .lite, and say what it cost
    ${dim('  --from=prisma|rails|sql|frappe')}         the source format ${dim('(detected from the path if omitted)')}
    ${dim('  --out=<path>')}                            write the schema ${dim('(default: stdout)')}
    ${dim('  --report=<path>')}                         write every unexpressed construct as JSON
    ${dim('  --strict')}                                exit 1 if anything CHANGED meaning
    ${cyan('litestone diagram')}                    ER diagram (opens in studio)
    ${cyan('litestone optimize')} [table]            optimize FTS5 indexes (all or one table)
    ${cyan('litestone edge eject')} <Model>.<field>  promote an @edge/@scoped field to a real model [--apply]
    ${cyan('litestone backup')} [dest]               backup all databases (SQLite + JSONL/logger)
    ${cyan('litestone replicate')} [config.js]       stream every SQLite db's WAL to S3/R2 via litestream
    ${cyan('litestone restore')} [config.js]         bring every db back from its replica — all or nothing
    ${dim('  --at=<instant>')}                          one point in time for every file
    ${dim('  --from-backup=<dir>')}                     every db from a litestone backup ${dim('(with --url/--at/--verify: jsonl/logger only)')}
    ${dim('  --force')}                                 replace files that exist (stop the app first)
    ${dim('  --verify=<dir>')}                          restore into <dir> instead and prove the copy is good
    ${dim('  --without-key')}                           verify with no ENCRYPTION_KEY, encrypted columns unchecked
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
    ${cyan('litestone validate')}                     which STORED rows this schema would now refuse
    ${dim('  --only=A,B')}                             just these models
    ${dim('  --json')}                                 the report as data
    ${cyan('litestone assistant')}                    a chat-model schema assistant, with this schema, to paste
    ${dim('  --bare')}                                 the instructions alone, no schema
    ${dim('  --purpose=<path>')}                       the app's PURPOSE.md ${dim('(default: found above the schema)')}
    ${dim('  --snapshot')}                             write assistant.snapshot.md ${dim('(--check in CI)')}
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


function openDb(dbPath) {
  if (!dbPath)
    fatal(`No database specified. Pass ${cyan('--db=<path>')} or set ${cyan('db')} in litestone.config.js`)
  const abs = resolve(dbPath)
  if (!existsSync(abs))
    console.log(`  ${dim(`db not found — will be created: ${rel(abs)}`)}`)
  ensureParentDir(abs)
  try {
    const db = openDatabase(abs)
    applyBusyTimeout(db)
    return db
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
// jsonl and trail databases are always skipped — they have no SQL schema.


// Returns array of { name, rawDb, migrationsDir } for every sqlite database.
// Opens raw Database connections — caller must close them.


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
    if (db.driver === 'jsonl' || db.driver === 'trail') continue  // no SQL schema
    const absPath = resolveDbPath(db.path, null, schemaAnchor(cfg.schema))
    if (!absPath) {
      console.log(`  ${yellow('⚠')}  database '${db.name}' has no resolvable path — skipping`)
      continue
    }
    if (!existsSync(absPath))
      console.log(`  ${dim(`db not found — will be created: ${rel(absPath)}`)}`)
    ensureParentDir(absPath)
    let rawDb
    try { rawDb = openDatabase(absPath); applyBusyTimeout(rawDb) }
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
    .filter(db => db.driver !== 'jsonl' && db.driver !== 'trail')
    .map(db => ({ name: db.name, migrationsDir: join(cfg.migrations, db.name) }))
}

// ─── Commands ─────────────────────────────────────────────────────────────────

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

// The operations a run was given by flag or document, before any prompt.
// Parsed once per process; a malformed one stops the run before a file is written.
function givenOperations() {
  const ops = []
  try {
    for (const text of getFlags('rename')) ops.push(parseRenameFlag(text))
    const path = getFlag('operations')
    if (path) {
      if (!existsSync(path)) throw new Error(`--operations ${path}: no such file`)
      let doc
      try { doc = JSON.parse(readFileSync(path, 'utf8')) }
      catch (e) { throw new Error(`--operations ${path}: not JSON (${e.message})`) }
      ops.push(...readOperations(doc))
    }
  } catch (e) {
    fatal(e.message)
  }
  return ops
}

// The given operations, plus whatever a person says yes to. A prompt only where
// a person can answer it: with no terminal the DESTRUCTIVE box is what stops a
// guess from being applied, and a hung CI job is worse than that.
async function operationsFor(parseResult, name, dir, cfg, given) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return given
  const guesses = renameCandidates(parseResult, dir, { dbName: name, pluralize: cfg.pluralize, operations: given })
  if (!guesses.length) return given
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return [...given, ...await askRenames(guesses, q => rl.question(`  ${q}`))]
  } finally {
    rl.close()
  }
}

async function cmdCreate(label, cfg) {
  header('litestone migrate create')
  const given = givenOperations()

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')
  let   anyCreated  = false

  try {
    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)
      const operations = await operationsFor(parseResult, name, migrationsDir, cfg, given)
      const result = multi
        ? createForDatabase(rawDb, parseResult, name, label || 'migration', migrationsDir, { pluralize: cfg.pluralize, operations })
        : create(rawDb, parseResult, label || 'migration', migrationsDir, { pluralize: cfg.pluralize, operations })

      // A refusal printed under ✓ with exit 0 told a script a migration was written.
      if (result.blocked) { console.error(`\n  ${red('✗')}  ${result.message}\n`); process.exit(1) }
      if (!result.created) {
        console.log(`  ${green('✓')}  ${result.message}\n`)
        continue
      }

      anyCreated = true
      console.log(`  ${green('✓')}  ${cyan(rel(result.filePath))}\n`)
      console.log(result.summary.split('\n').map(l => `  ${l}`).join('\n'))
      console.log()
      printLoss(result)
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }

  if (anyCreated)
    console.log(`  ${dim(`Run ${cyan('litestone migrate apply')} to apply.`)}\n`)
}

// Said where the file is named, because `migrate dev` goes on to apply and the
// refusal that follows reads as a failure unless this came first.
function printLoss(result) {
  if (!result.loss?.length) return
  console.warn(`  ${yellow('!')}  deletes the values in ${result.loss.map(l => cyan(`${l.table}.${l.columns.join(', ')}`)).join(', ')}`)
  console.warn(`     ${dim('apply refuses this file until its DESTRUCTIVE box is answered in the file')}\n`)
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

      const pristineDb = openDatabase(':memory:')
      const pristine   = multi
        ? (await import('../core/migrate.js')).buildPristineForDatabase(pristineDb, parseResult, name)
        : buildPristine(pristineDb, parseResult)
      pristineDb.close()

      const live       = introspect(rawDb)
      const diffResult = diffSchemas(pristine, live, parseResult, name, { pluralize: cfg.pluralize })

      if (!diffResult.hasChanges) {
        console.log(`  ${green('✓')}  ${multi ? name + ': ' : ''}schema is in sync — no migration needed`)
        if (diffResult.residue.length)
          console.log(summarizeDiff(diffResult).split('\n').slice(1).map(l => `  ${yellow(l)}`).join('\n'))
        console.log()
        continue
      }

      console.log(summarizeDiff(diffResult).split('\n').map(l => `  ${l}`).join('\n'))
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

// Beside the schema, so an app's `db/schema.lite` backs up into `db/backups/`,
// the path its `.gitignore` covers. At the working directory the copy (users,
// password hashes) was one `git add .` from a commit (FJS-1465).
function defaultBackupRoot(cfg) {
  return cfg?.schema ? join(dirname(resolve(cfg.schema)), 'backups') : './backups'
}

// A new directory every run: to the second, suffixed when that second is taken.
// Cut to the minute, two backups in one minute shared a directory and the
// second replaced the first (FJS-1786). A zip counts, since its directory is
// removed once the archive is written.
function newBackupDir(root) {
  const base = resolve(root, new Date().toISOString().replace('T', '_').replace(/:/g, '').slice(0, 17))
  let dir = base
  for (let n = 2; existsSync(dir) || existsSync(`${dir}.zip`); n++) dir = `${base}-${n}`
  return dir
}

// Every database is copied before the FIRST one is migrated. A run that fails
// on the second database has already changed the first, so a per-database
// backup taken inside the loop is a backup of a half-migrated fleet.
async function preApplyBackup(dbs, cfg) {
  const destDir = resolve(getFlag('backup') ?? newBackupDir(defaultBackupRoot(cfg)))

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
  let   refused     = false

  for (const { name, migrationsDir } of dbs) {
    const gap = historyGap(parseResult, migrationsDir, { pluralize: cfg.pluralize, dbName: name })
    if (gap.unknown) { console.error(`  ${red('✗')}  ${multi ? name + ': ' : ''}${gap.message}\n`); refused = true; continue }
    if (gap.ok) { console.log(`  ${green('✓')}  ${multi ? name + ': ' : ''}the migration history builds the schema\n`); continue }
    gaps.push({ name, summary: gap.summary })
  }

  if (!gaps.length) { if (refused) process.exit(1); return }

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
  const given = givenOperations()

  const parseResult = loadSchema(cfg.schema)
  const dbs         = openSqliteDbs(parseResult, cfg)
  const multi       = parseResult.schema.databases.some(db => !db.driver || db.driver === 'sqlite')
  let   created     = 0
  let   drifted     = false
  let   pending     = 0

  try {
    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)

      // Asked BEFORE anything is written: a drifted database cannot apply what
      // create is about to produce, and a file written and not applied leaves
      // the developer in a state neither command explains. Asked of the APPLIED
      // files, so a teammate's fresh clone is behind, not drifted (`FJS-1455`).
      const drift = driftAgainstLive(rawDb, parseResult, migrationsDir, { pluralize: cfg.pluralize, dbName: name, appliedOnly: true })
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
      if (drift.pending.length) {
        pending += drift.pending.length
        console.log(`  ${dim(`${drift.pending.length} migration${drift.pending.length === 1 ? '' : 's'} pending`)}`)
      }

      const operations = await operationsFor(parseResult, name, migrationsDir, cfg, given)
      const result = createAgainstHistoryCli(parseResult, name, label, migrationsDir, cfg, operations)
      if (result.blocked) { console.error(`\n  ${red('✗')}  ${result.message}\n`); process.exit(1) }
      if (!result.created) { console.log(`  ${green('✓')}  ${result.message}\n`); continue }

      created++
      console.log(`  ${green('✓')}  ${cyan(rel(result.filePath))}\n`)
      console.log(result.summary.split('\n').map(l => `  ${l}`).join('\n'))
      console.log()
      printLoss(result)
    }
  } finally {
    for (const { rawDb } of dbs) rawDb.close()
  }

  if (drifted) process.exit(1)
  if (created || pending) await cmdApply(cfg)
  else console.log(`  ${dim('nothing to apply')}\n`)
}

// create() and createForDatabase() differ only in which database's models they
// build, and cmdDev needs whichever this one is.
function createAgainstHistoryCli(parseResult, name, label, migrationsDir, cfg, operations = []) {
  return createForDatabase(null, parseResult, name, label || 'migration', migrationsDir, { pluralize: cfg.pluralize, operations })
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
    if (wantsBackup) backupDir = await preApplyBackup(dbs, cfg)

    for (const { name, rawDb, migrationsDir } of dbs) {
      if (multi) console.log(`  ${dim(`database: ${cyan(name)}`)}`)

      // Set optimal page size on brand new databases
      const pageCount = rawDb.query('PRAGMA page_count').get()
      if (pageCount && pageCount.page_count <= 1) rawDb.run('PRAGMA page_size = 8192')

      const appliedSet = new Set(appliedMigrations(rawDb).map(m => m.name))
      const pending    = listMigrationFiles(migrationsDir).filter(f => !appliedSet.has(f))

      if (!wantsBackup) {
        // A file apply is about to refuse runs nothing, so it is no risk of this run.
        const held  = new Set([...unacceptedLoss(migrationsDir, pending), ...unresolvedBlocks(migrationsDir, pending)])
        const risky = held.size ? [] : irreversibleMigrations(migrationsDir, pending)
        if (risky.length) {
          console.warn(`  ${yellow('!')}  no way back from this run without a copy of the database:`)
          for (const r of risky) console.warn(`       ${r}`)
          console.warn(`     ${dim(`Re-run with ${cyan('--backup')} to take one first.`)}\n`)
        }
      }

      const result = await apply(rawDb, migrationsDir)
      if (result.refused) {
        console.error(`  ${red('✗')}  ${result.message}\n`)
        anyFailed = true
        continue
      }

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
      if (gap.unknown) continue   // apply refused it above and names the files
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

// ─── export ───────────────────────────────────────────────────────────────────
//
// The governed extract (`FJS-D228`). Everything about who may take what is the
// scoped client's, so this command's whole job is to answer three questions the
// core cannot: which dataset, as whom, and where do the bytes go.
//
// `--as` names an ACCOUNT and not a level, deliberately. A synthesized principal
// evaluates every claim-based policy against nothing, which is where
// three-valued logic is least safe — so the standing comes off a real row, found
// the same way `litestone repl` finds one, and `--gate` names the app's own
// resolver for the same reason it does there.
async function cmdExport(cfg) {
  header('litestone export')

  const parseResult = loadSchema(cfg.schema)
  const { createClient } = await import('../core/client.js')
  const { runExport, exportableDatasets } = await import('../export.js')

  const datasets = exportableDatasets(parseResult.schema)

  const name = positional[1]
  if (!name) {
    if (!datasets.length)
      fatal(`No dataset in this schema declares ${cyan('@@export')}.\n` +
            `     Add it to a model or a view, beside a ${cyan('@@gate')}.`)
    console.log(`  ${dim('datasets this schema says may leave:')}\n`)
    for (const d of datasets)
      console.log(`    ${cyan(d.name)}${dim(` · ${d.kind} · ${d.export.format}${d.export.since ? ` · since ${d.export.since}` : ''}`)}`)
    console.log(`\n  ${dim(`litestone export ${datasets[0].name} --as <account>`)}`)
    return
  }

  const asWho  = getFlag('as')
  const system = args.includes('--system')
  if (!asWho && !system)
    fatal(`Name a standing: ${cyan('--as <account>')}, or ${cyan('--system')}.\n` +
          `     An export is a bulk read of every row a caller may see, so there is no\n` +
          `     default caller to be. ${dim('--as takes an email, username, name or id in the @@auth model.')}`)

  const appGetLevel = await loadGateResolver(getFlag('gate'))
  const plugins = []
  if (appGetLevel) {
    const { GatePlugin } = await import('../plugins/gate.js')
    plugins.push(new GatePlugin({ getLevel: appGetLevel }))
  }

  // Under `strategy database` the rows are in a TENANT's file and `main` holds
  // the machinery, so an export with no tenant named is an export of nothing —
  // which looks exactly like an export of an empty table. Say so rather than
  // writing the empty file.
  const tenancy  = parseResult.schema.tenancy
  const tenantId = getFlag('tenant')
  let base, tenants = null

  if (tenancy?.strategy === 'database') {
    const { createTenantRegistry } = await import('../tenant.js')
    const { dir, registry, migrationsDir } = await tenantOptions(cfg)
    tenants = await createTenantRegistry({
      dir, registry, path: cfg.schema,
      migrationsDir: migrationsDir && existsSync(resolve(migrationsDir)) ? resolve(migrationsDir) : null,
      encryptionKey: getEncKey(),
      ...(plugins.length ? { clientOptions: { plugins } } : {}),
    })
    const ids = tenants.list()
    if (!tenantId)
      fatal(`This schema is ${cyan('strategy database')}, so name whose data leaves: ${cyan('--tenant <id>')}.\n` +
            `     ${ids.length ? `Known: ${ids.map(i => cyan(i)).join(', ')}` : dim('No tenants exist yet.')}\n` +
            `     ${dim('Without one the extract would come from main, which holds the machinery and none of the rows.')}`)
    if (!tenants.exists(tenantId))
      fatal(`No tenant ${cyan(tenantId)}. ${ids.length ? `Known: ${ids.map(i => cyan(i)).join(', ')}` : dim('none exist yet')}`)
    base = await tenants.get(tenantId)
  } else {
    if (tenantId) fatal(`${cyan('--tenant')} needs ${cyan('tenancy { strategy database }')} — this schema declares none.`)
    // `path` + `resolveFrom: 'schema'` is the house form and it is load-bearing
    // here: a relative `database { path }` otherwise resolves against the working
    // directory, so running this from `db/` exports zero rows out of a `db/db/`
    // database it created on the way (`FJS-449`).
    base = await createClient({
      parsed:        parseResult,
      path:          cfg.schema,
      resolveFrom:   'schema',
      db:            clientDb(parseResult, cfg),
      encryptionKey: getEncKey(),
      ...(plugins.length ? { plugins } : {}),
    })
  }

  // Found through the system client: an operator looking somebody up must not
  // depend on the standing they are about to adopt.
  const sys   = base.asSystem()
  const found = asWho ? await findPrincipal(sys, base.$schema, asWho) : { row: null, model: null }
  if (asWho && !found.model)
    fatal(`This schema does not say which model holds people.\n` +
          `     Mark it ${cyan('@@auth')} — or name it here: ${cyan('--as Customer:' + asWho)}.`)
  if (asWho && !found.row)
    fatal(`No ${cyan(found.model)} row matches ${cyan(found.needle)}. Tried ${found.tried.join(', ')}.`)

  const fs   = await import('node:fs')
  const path = await import('node:path')

  const format = getFlag('format') ?? datasets.find(d => d.name === name || d.accessor === name)?.export.format ?? 'ndjson'
  const toStdout = args.includes('--stdout')
  const outDir   = getFlag('out') ?? process.cwd()
  const stem     = path.join(outDir, name)
  const dataFile = `${stem}.${format}`
  const manFile  = `${stem}.manifest.json`

  let stream = null
  if (!toStdout) {
    fs.mkdirSync(outDir, { recursive: true })
    stream = fs.createWriteStream(dataFile)
  }
  const write = (line) => {
    if (toStdout) { process.stdout.write(line + '\n'); return }
    // Backpressure matters: an extract is the one thing here big enough to
    // outrun a disk, and dropping it on the floor would be silent.
    return new Promise((res, rej) => stream.write(line + '\n', err => err ? rej(err) : res()))
  }

  let manifest
  try {
    manifest = await runExport(base, name, {
      as: found.row, system,
      since:            getFlag('since') ?? null,
      format:           getFlag('format') ?? null,
      includeProtected: args.includes('--include-protected'),
      withDeleted:      args.includes('--with-deleted'),
      write,
      tenant: tenantId ?? null,
    })
  } catch (e) {
    if (stream) stream.destroy()
    fatal(e.message)
  }
  if (stream) await new Promise(res => stream.end(res))

  if (toStdout) { process.stderr.write(JSON.stringify(manifest, null, 2) + '\n'); return }
  fs.writeFileSync(manFile, JSON.stringify(manifest, null, 2) + '\n')

  const omittedProtected = manifest.omitted.filter(o => o.reason === 'protected')
  console.log(`  ${green('✓')}  ${rel(dataFile)} ${dim(`(${manifest.rows} row${manifest.rows === 1 ? '' : 's'})`)}`)
  console.log(`  ${green('✓')}  ${rel(manFile)}`)
  console.log(`\n  taken as   ${system ? cyan('--system') : cyan(String(manifest.takenAs.principal))}` +
              `${manifest.takenAs.declaredReadGate != null ? dim(`   read gate ${manifest.takenAs.declaredReadGate}`) : ''}`)
  if (manifest.policiesApplied.length)
    console.log(`  bounded by ${dim(manifest.policiesApplied.map(r => `${r.kind} ${r.expr}`).join('  ·  '))}`)
  if (omittedProtected.length)
    console.log(`  omitted    ${dim(omittedProtected.map(o => `${o.name} ${o.by}`).join(', '))}` +
                `${args.includes('--include-protected') ? '' : dim('   (--include-protected to keep them)')}`)
  if (manifest.cursor?.after)
    console.log(`  resume     ${dim(`--since ${manifest.cursor.after}`)}`)
}

async function cmdRepl(cfg) {
  // `--eval` is the console run once: an answer on stdout for a caller to parse,
  // everything about the session on stderr. The standing still prints — a
  // one-shot run that does not say what it ran as is the god-mode console again.
  const code = getFlag('eval')
  if (flag('eval') && code == null)
    fatal(`${cyan('--eval')} takes an expression: ${cyan(`--eval 'db.order.count()'`)}.`)
  const once = code != null

  if (!once) header('litestone tinker')

  // It drove `bun repl` as a subprocess once, fed through `.load` and two fixed
  // sleeps. That worked and could never satisfy the rule this command lives by:
  // a subprocess REPL owns its prompt, so it cannot say what it is running as.
  // Hosted here instead — `node:readline` under bun.
  const parseResult = loadSchema(cfg.schema)
  const { isSoftDelete } = await import('../core/ddl.js')
  const { createClient } = await import('../core/client.js')
  const { startRepl, evalOnce, describeStanding, tinkerCommands } = await import('./repl.js')

  // Loaded before any database opens: a broken commands file is a refusal
  // naming the file, not a session that starts and lacks the command.
  const commandsFile = join(dirname(resolve(cfg.schema)), 'tinker.js')
  let commands = {}
  if (existsSync(commandsFile)) {
    try { commands = tinkerCommands(await import(commandsFile), rel(commandsFile)) }
    catch (e) { fatal(`${rel(commandsFile)} could not be loaded.\n     ${e.message}`) }
  }

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
  const openMain = () => createClient({
    parsed:        parseResult,
    db:            clientDb(parseResult, cfg),
    encryptionKey: getEncKey(),
    ...(plugins.length ? { plugins } : {}),
  })

  // Under `strategy database` main holds the machinery and none of the rows, so
  // a console on main answers `count()` with 0 for a shop full of orders — an
  // empty table and the wrong file look identical from the prompt.
  let tenantId = getFlag('tenant') ?? null
  let tenants  = null
  let base

  if (parseResult.schema.tenancy?.strategy === 'database') {
    const { createTenantRegistry } = await import('../tenant.js')
    const { dir, registry, migrationsDir } = await tenantOptions(cfg)
    tenants = await createTenantRegistry({
      dir, registry, path: cfg.schema,
      migrationsDir: migrationsDir && existsSync(resolve(migrationsDir)) ? resolve(migrationsDir) : null,
      encryptionKey: getEncKey(),
      ...(plugins.length ? { clientOptions: { plugins } } : {}),
    })
    const ids   = tenants.list()
    const known = ids.length ? `Known: ${ids.map(i => cyan(i)).join(', ')}` : dim('No tenants exist yet.')

    if (tenantId && !tenants.exists(tenantId))
      fatal(`No tenant ${cyan(tenantId)}. ${known}`)

    if (!tenantId && ids.length) {
      if (!process.stdin.isTTY || once)
        fatal(`This schema is ${cyan('strategy database')}, so name whose data: ${cyan('--tenant <id>')}.\n` +
              `     ${known}\n` +
              `     ${dim('Without one the console would open main, which holds the machinery and none of the rows.')}`)
      tenantId = await chooseTenant(ids)
    }

    base = tenantId ? await tenants.get(tenantId) : await openMain()
  } else {
    if (tenantId) fatal(`${cyan('--tenant')} needs ${cyan('tenancy { strategy database }')} — this schema declares none.`)
    base = await openMain()
  }

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

  // A `--level` with no user still needs SOMEBODY to grade: the gate never asks
  // `getLevel` about a caller with no id (`FJS-D515`), so the synthetic level
  // answered STRANGER to every call. The same stand-in `atLevel` uses — an id
  // no row carries, so an `auth().id ==` policy still matches nothing, and every
  // declared capability, so a refusal names the gate and not a missing grant.
  const { capabilityNames } = await import('../core/capabilities.js')
  const db = user ? base.$setAuth(user)
    : level != null ? base.$setAuth({ id: `level-${level}`, capabilities: [...capabilityNames(parseResult.schema)] })
    : base

  // The level a principal is GRADED at, shown rather than assumed — the point of
  // --as is that a resolver answers, and a person reading a refusal needs the
  // number it was refused against and WHICH resolver said it.
  const { FrontierGateGetLevel } = await import('../plugins/gate.js')
  const { levelLabel }           = await import('../access.js')

  const resolver = appGetLevel ?? FrontierGateGetLevel
  const graded   = level != null ? level : (user ? await resolver(user) : 0)

  const label    = user ? (user.email ?? user.username ?? user.name ?? `#${user.id}`) : null
  const standing = (tenantId ? `${tenantId} · ` : '') + describeStanding({ label, graded, synthetic: level != null })

  const models    = parseResult.schema.models
  const accessors = models.map(m => modelToAccessor(m.name))
  const softTbls  = models.filter(m => isSoftDelete(m)).map(m => modelToAccessor(m.name))

  const dbDisplay = parseResult.schema.databases.length
    ? parseResult.schema.databases.filter(d => !d.driver || d.driver === 'sqlite').map(d => d.name).join(', ')
    : (cfg.db ? rel(resolve(cfg.db)) : '(from schema)')

  const gradedBy = level != null
    ? dim('--level — synthetic, no resolver was asked')
    : (appGetLevel ? cyan(getFlag('gate')) : dim('FrontierGateGetLevel (the default — pass --gate if your app installs its own)'))

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

  if (once) {
    console.error(`  ${dim('Standing:')} ${cyan(standing)} ${dim(levelLabel(graded))} ${dim('· graded by')} ${gradedBy}`)
    for (const h of hints) console.error(h.trimEnd())
    const exit = await evalOnce({ code, db, sys, commands, tenant: tenantId })
    try { tenants ? tenants.close() : base.$close() } catch {}
    process.exit(exit)
  }

  console.log(`  ${dim('Database:')}   ${!tenants ? dbDisplay
    : tenantId ? `${cyan(tenantId)} ${dim('(tenant)')}`
    : `main ${yellow('— the machinery; no tenant rows are here')}`}`)
  console.log(`  ${dim('Tables:')}     ${accessors.join(', ')}`)
  if (softTbls.length) console.log(`  ${dim('Soft delete:')} ${softTbls.join(', ')}`)
  console.log(`  ${dim('Standing:')}   ${cyan(standing)} ${dim(levelLabel(graded))}`)
  console.log(`  ${dim('Graded by:')}  ${gradedBy}`)
  console.log()

  hints.push(`  ${green('✓')}  ${cyan('db')} at this standing · ${cyan('sys')} bypasses everything · ${dim('.help')}`)
  const names = Object.keys(commands)
  if (names.length)
    hints.push(`  ${green('✓')}  ${rel(commandsFile)}: ${names.map(n => cyan('.' + n)).join(' ')}`)
  hints.push('')

  await startRepl({ db, sys, standing, accessors, commands, tenant: tenantId, hints })

  try { tenants ? tenants.close() : base.$close() } catch {}
}

// The picker behind a bare `litestone repl` on a `strategy database` schema.
// Main is offered last and says what it is, because it is a legitimate place to
// look (sessions, the outbox) and the wrong place to look for a tenant's rows.
async function chooseTenant(ids) {
  const { createInterface } = await import('node:readline/promises')
  console.log(`  ${dim('This schema is')} ${cyan('strategy database')}${dim(' — whose data?')}\n`)
  ids.forEach((id, i) => console.log(`    ${dim(String(i + 1).padStart(2))}  ${cyan(id)}`))
  console.log(`    ${dim(' 0')}  main ${dim('— the machinery, no tenant rows')}\n`)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    for (;;) {
      const fallback = ids.length === 1 ? ' [1]' : ''
      const answer   = (await rl.question(`  tenant${fallback}: `)).trim() || (ids.length === 1 ? '1' : '')
      if (answer === '0' || answer === 'main') { console.log(); return null }
      const n = Number(answer)
      if (Number.isInteger(n) && n >= 1 && n <= ids.length) { console.log(); return ids[n - 1] }
      if (ids.includes(answer)) { console.log(); return answer }
      console.log(`  ${dim('a number from the list, or a tenant id')}`)
    }
  } finally {
    rl.close()
  }
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

// The files `strategy database` writes that no `database { }` block names: one
// `<id>.db` per tenant, and the registry that lists them. `backup` and
// `replicate` read `$databases`, which is the declared set — so under this
// strategy they copied the machinery in `main` and not one tenant's rows, and
// both reported success. The names are hyphenated so a declared database can
// never collide with them.
//
// A DIRECTORY and a PATTERN rather than a list of ids: a replica started before
// a tenant exists has to cover it, so the unit is "every tenant file there".
async function tenantStorage(parseResult, cfg) {
  if (parseResult.schema.tenancy?.strategy !== 'database') return null
  const { dir, registry } = await tenantOptions(cfg)
  const files = { name: 'tenant-files', dir: resolve(dir), pattern: '*.db' }
  const reg   = resolve(registry ?? join(dir, 'registry.db'))
  // A registry inside the tenant directory is already one of its `*.db` files.
  if (dirname(reg) === files.dir && reg.endsWith('.db')) return [files]
  return [files, { name: 'tenant-registry', dir: dirname(reg), pattern: basename(reg) }]
}

// What `backup`, `replicate` and `restore` copy, resolved from the schema
// WITHOUT a client. Opening one creates every missing declared file and its
// directory, so a restore would find its destinations already there and a
// replica of a mistyped path would stream the empty database it had just made.
// It also needs the encryption key, which none of the three decrypts with.
//
//   sqlite  [{ name, path }]          streamed by litestream, copied hot
//   other   [{ name, driver, path }]  jsonl/logger directories — copied, never streamed
//   dirs    [{ name, dir, pattern }]  tenantStorage()
async function copyTargets(parseResult, cfg, onlyDb = null) {
  const anchor   = schemaAnchor(cfg.schema)
  const declared = parseResult.schema.databases.map(d => ({
    name: d.name, driver: d.driver ?? 'sqlite', path: resolveDbPath(d.path, null, anchor),
  }))
  if (!declaresDatabases(parseResult)) declared.unshift({ name: 'main', driver: 'sqlite', path: resolve(cfg.db) })
  const wanted = t => !onlyDb || t.name === onlyDb
  const dirs   = (await tenantStorage(parseResult, cfg)) ?? []
  return {
    sqlite: declared.filter(d => d.driver === 'sqlite' && wanted(d)).map(({ name, path }) => ({ name, path })),
    other:  declared.filter(d => d.driver !== 'sqlite' && wanted(d)),
    dirs:   dirs.filter(wanted),
    layout: onlyDb ? null : layoutFiles(cfg, declared, dirs),
  }
}

// What persists and no schema names: Caravan's `jobs.db`, a `local` storage
// provider's bytes. A restore of the declared set alone brought back every row
// and none of the pending jobs or images those rows point at (FJS-1391). The
// schema is the wrong owner for them and a list here would be a second copy of
// every path, so the LAYOUT is the list (`FJS-D493`): everything an app keeps
// lives under `db/`, the one volume deploy mounts.
//
// Only a schema IN a `db/` directory has one. A bare litestone project keeps its
// schema beside its source, and copying that directory would copy the project.
//
//   sqlite [{ name, path }]   every other `*.db`, named `db-<path>` — a hyphen no
//                             declared database name can hold
//   files  [{ rel, path }]    everything else, copied byte for byte
//
// Skipped: what the declared set already covers, a SQLite file's companions,
// dot-entries (litestream's own state, generated output) and the backups root,
// which would otherwise put every earlier backup inside the next.
function layoutFiles(cfg, declared, dirs) {
  const root = cfg.schema ? dirname(resolve(cfg.schema)) : null
  if (!root || basename(root) !== 'db' || !existsSync(root)) return null

  const coveredFile = new Set(declared.filter(d => d.driver === 'sqlite').map(d => resolve(d.path)))
  const skipDir     = new Set([
    ...declared.filter(d => d.driver !== 'sqlite' && d.path).map(d => resolve(d.path)),
    resolve(defaultBackupRoot(cfg)),
  ])
  const byTenancy = (dir, f) => dirs.some(t => t.dir === dir && (t.pattern === '*.db' ? f.endsWith('.db') : f === t.pattern))

  const sqlite = [], files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { if (!skipDir.has(path)) walk(path); continue }
      if (!entry.isFile() || coveredFile.has(path) || byTenancy(dir, entry.name)) continue
      if (/\.db-(wal|shm|journal)$/.test(entry.name)) continue
      const rel = relative(root, path).split(sep).join('/')
      if (entry.name.endsWith('.db')) sqlite.push({ name: `db-${rel.slice(0, -3).replaceAll('/', '-')}`, path })
      else files.push({ rel, path })
    }
  }
  walk(root)
  return { root, sqlite, files }
}

// The files a directory target covers right now. The dot-prefixed entries are
// litestream's own `.<db>-litestream` state, which it writes beside every file.
const matchingFiles = ({ dir, pattern }) =>
  !existsSync(dir) ? [] : readdirSync(dir).filter(f =>
    !f.startsWith('.') && (pattern === '*.db' ? f.endsWith('.db') : f === pattern))

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
    encryptionKey: getEncKey(),
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
  hints([
    `  ${dim('--out=<path>')}              ${dim('default: schema path + .d.ts')}`,
    `  ${dim('--stdout')}                  ${dim('print to stdout instead of writing a file')}`,
    `  ${dim('--audience=client|system')}  ${dim('client strips @guarded/@secret  (default: client)')}`,
    `  ${dim('--augment=junction')}        ${dim('also type client.service(name) in the browser')}`,
  ])
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
      mkdirSync(dirname(outPath), { recursive: true })
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
    // Create the directory the caller named. `--out db/.json/schema.json` is a
    // path into a directory that does not exist yet on a fresh clone, and
    // writeFileSync answers ENOENT naming the FILE, which reads as a permission
    // problem rather than a missing parent. Note that a `--out` naming a
    // directory that does not exist yet is treated as a FILE path by the branch
    // above — that is why the recommended spelling states `schema.json`.
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, JSON.stringify(schema, null, 2))
    const { size } = statSync(outPath)
    console.log(`  ${green('✓')}  ${rel(outPath)}  ${dim(`(${(size/1024).toFixed(1)}kb)`)}`)

    const models = parseResult.schema.models.length
    const enums  = parseResult.schema.enums.length
    console.log(`  ${dim(`${models} model${models!==1?'s':''}, ${enums} enum${enums!==1?'s':''}, mode=${mode}, format=${format}`)}`)
  }

  hints([
    `  ${dim('--out=<path>')}               ${dim('default: schema path + .json')}`,
    `  ${dim('--stdout')}                   ${dim('print to stdout instead of writing a file')}`,
    `  ${dim('--mode=create|update|full')}  ${dim('(default: create)')}`,
    `  ${dim('--all-modes')}                ${dim('generate create + update + full')}`,
    `  ${dim('--format=definitions|flat')}  ${dim('(default: definitions)')}`,
    `  ${dim('--include-timestamps')}       ${dim('include createdAt/updatedAt')}`,
    `  ${dim('--include-deleted-at')}       ${dim('include deletedAt')}`,
  ])
}

// ─── hints — the "what else you can pass" block under a command's result ────
//
// TTY only. These are written for somebody who just typed the command and is
// reading the answer; a composing caller (`fli new` runs six commands that each
// end in one of these) gets a wall of flags for commands it ran on the user's
// behalf, and the lines that mattered scroll off the top.
//
// `process.stdout.isTTY` rather than a flag: the question is whether a person
// is reading this, which is the same question the color subset already asks.
function hints(lines) {
  if (!process.stdout.isTTY) return
  console.log()
  for (const l of lines) console.log(l)
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
  const { CATALOG, GROUPS, POSITIONS, POSITION_RULES, positionsOf, typed, lookup, grouped, docFor, bySynonym } =
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

  // A synonym is an exact hit, not a guess: `aggregate` IS @from, and answering
  // "not a word this language has" is true and useless. The line says which
  // word answered, because the point is to leave knowing it.
  const viaSynonym = rows.length ? null : bySynonym(bare)
  if (viaSynonym) {
    if (asJson) {
      process.stdout.write(JSON.stringify(
        [{ ...viaSynonym, positions: positionsOf(viaSynonym), doc: docFor(viaSynonym), matchedSynonym: bare }], null, 2) + '\n')
      return
    }
    console.log()
    console.log(`  ${dim(bare)} ${dim('is not a word — the word is')} ${cyan(typed(viaSynonym))}`)
    rows.push(viaSynonym)
  }

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

// `litestone validate` — which stored rows would this schema refuse?
//
// The question the migration differ cannot ask. A `@email`, a `@length`, a
// `@minItems` and the shape of a `Json @type(T)` emit no CHECK, so tightening
// one leaves the column exactly where it was and the migrator correctly reports
// in sync — while every row already down that breaks the new rule has become
// unwritable, and reads back looking fine.
//
// Exits 1 on a finding. The name is `validate`, and a validate that passes over
// invalid data would be answering a different question than the one it is named
// for; a report with no verdict is `advise`, beside it.
async function cmdValidate(cfg) {
  const asJson = flag('json')
  const only   = getFlag('only')?.split(',').map(m => m.trim()).filter(Boolean) ?? null

  const { createClient }  = await import('../core/client.js')
  const { validateRows }  = await import('../validate-rows.js')

  const parseResult = loadSchema(cfg.schema)
  const db = await createClient({ parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', db: clientDb(parseResult, cfg), encryptionKey: getEncKey() })

  // The file, always, and before the verdict. Run from the wrong directory this
  // command opens a database that is not there, litestone creates it, and every
  // model answers zero rows — which prints as a pass. *Nothing is wrong* and
  // *nothing was read* are one answer until something separates them, and here
  // that is the path and the count.
  const files = Object.entries(db.$databases)
    .filter(([, d]) => d.path)
    .map(([name, d]) => `${name}: ${d.path}`)

  let report
  try { report = await validateRows(db, { models: only }) }
  finally { db.$close() }

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exitCode = report.ok ? 0 : 1
    return
  }

  header('litestone validate')

  const rows = report.checked.reduce((n, c) => n + c.rows, 0)
  const at   = f => `${f.model}${f.id == null ? '' : ' ' + (typeof f.id === 'object' ? JSON.stringify(f.id) : f.id)}`

  for (const f of files) console.log(`  ${dim(f)}`)
  console.log()

  if (report.ok && rows === 0) {
    // Not a pass and not a failure. Every model empty is the shape a wrong
    // path produces, and it is also what a fresh database legitimately looks
    // like — so it is reported as the one thing that is certainly true.
    console.log(`  ${yellow('!')}  ${report.checked.length} model(s) and not one row between them — nothing was checked.`)
    console.log(`       ${dim('If this database should hold rows, the path above is not the one you meant.')}\n`)
  } else if (report.ok) {
    console.log(`  ${green('✓')}  ${rows} row(s) across ${report.checked.length} model(s) satisfy the schema.\n`)
  } else if (report.findings.length || report.models.length) {
    // The model rollup first: a rule NO row satisfies is a deploy that
    // half-landed, and reading the rows one by one would not say so.
    for (const m of report.models) {
      console.log(`  ${red('✗')}  ${cyan(m.model)} — ${bold(`all ${m.rows} row(s)`)} would be refused`)
      for (const e of m.errors) console.log(`       ${dim(e.path.join('.'))} ${e.message}`)
      console.log(`       ${dim('every row breaks it, so this is the rule to look at rather than the data')}`)
      console.log()
    }

    const scattered = report.findings.filter(f => !report.models.some(m => m.model === f.model))
    for (const f of scattered) {
      console.log(`  ${yellow('!')}  ${cyan(at(f))}`)
      for (const e of f.errors) console.log(`       ${dim(e.path.join('.'))} ${e.message}`)
      console.log()
    }

    const failing = report.checked.reduce((n, c) => n + c.failing, 0)
    console.log(`  ${failing} of ${rows} row(s) would be refused by the schema as it stands.`)
    console.log(`  ${dim('Nothing was written. Backfill the rows, or loosen the rule back.')}\n`)
  }

  for (const u of report.unreadable)
    console.log(`  ${red('✗')}  ${cyan(u.model)} could not be read — ${u.error}\n`)

  for (const s of report.skipped)
    console.log(`  ${dim('skipped')} ${s.model} — ${dim(s.reason)}`)
  if (report.skipped.length) console.log()

  process.exitCode = report.ok ? 0 : 1
}

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
  const summary = `${counts.models - counts.views} models · ` +
                  (counts.views ? `${counts.views} view${counts.views === 1 ? '' : 's'} · ` : '') +
                  `${counts.gated} gated · ${counts.unrestricted} unrestricted · ` +
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

  hints([
    `  ${dim('--check')}          ${dim('exit 1 if the committed snapshot is stale (CI)')}`,
    `  ${dim('--from=<ref>')}     ${dim('what moved since that release — widens, narrows or undecidable')}`,
    `  ${dim('--json')}           ${dim('the structured table instead of the markdown')}`,
    `  ${dim('--stdout')}         ${dim('print instead of writing a file')}`,
    `  ${dim('--out=<path>')}     ${dim('default: access.snapshot.md beside the schema')}`,
  ])
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

  if (baseline.note) console.log(`  ${yellow('!')}  ${baseline.note}`)
  if (before?.note)  console.log(`  ${yellow('!')}  ${before.note}`)

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
  hints([
    `  ${dim('--strict')}  ${dim('exit 1 unless the verdict is narrows, new or unchanged (CI)')}`,
    `  ${dim('--json')}    ${dim('the diff as data')}`,
  ])

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
  hints([
    `  ${dim('--check')}       ${dim('exit 1 if the committed snapshot is stale (CI)')}`,
    `  ${dim('--stdout')}      ${dim('print instead of writing a file')}`,
    `  ${dim('--pluralize')}   ${dim('pluralized table names (default: from config)')}`,
    `  ${dim('--out=<path>')}  ${dim('default: ddl.snapshot.sql beside the schema')}`,
  ])
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
  // Said on a baseline that RESOLVED, which is the only case where it is not
  // obvious: a baseline that lost an import compares cleanly against a smaller
  // schema and reports every model it dropped as newly added.
  if (baseline.note) console.log(`  ${yellow('!')}  ${baseline.note}`)
  if (before?.note) console.log(`  ${yellow('!')}  ${before.note}`)

  const lines = formatVerdict(result, { baseline: baseline.label })
  console.log(`  ${mark}  ${lines[0]}`)
  for (const line of lines.slice(1)) console.log(line ? `  ${line}` : '')
  console.log()

  if (result.verdict !== 'unchanged' && result.verdict !== 'expand')
    console.log(`  ${dim('A contract deploy is one that cannot be taken back. Split it, or cross the pivot knowingly.')}\n`)

  hints([
    `  ${dim('--from=<ref|path>')}  ${dim('classify against another release (default: HEAD)')}`,
    `  ${dim('--strict')}           ${dim('exit 1 unless the verdict is expand or unchanged (CI)')}`,
    `  ${dim('--check')}            ${dim('exit 1 if the committed snapshot is stale (CI)')}`,
    `  ${dim('--json')}             ${dim('the verdict as data, nothing written')}`,
  ])

  if (strict && result.verdict !== 'expand' && result.verdict !== 'unchanged') process.exit(1)
}


// ─── Mutate — the completeness proof ─────────────────────────────────────────
//
// Mutate the schema, build a database from each mutant, and run the checks
// derived from the ORIGINAL schema against it. A mutant nothing notices is a
// hole in the checks, and it names itself.
//
// CI's full-tier `mutate` phase runs it over each app in
// scripts/mutate-baselines.json and fails a score below that app's floor
// (FJS-D476); basecamp only under a `--kinds` subset, since its whole run is
// past 25 minutes.

async function cmdMutate(cfg) {
  // `--json` is what the CI `mutate` phase reads (FJS-598): the score as data,
  // so a floor is compared against a number rather than a scraped line.
  const asJson = flag('json')
  const log    = asJson ? () => {} : console.log
  if (!asJson) header('litestone mutate')

  const { schemaMutants, mutationScore, createTestEnv } = await import('../testing.js')
  const schemaPath = resolve(cfg.schema)
  const kinds      = getFlag('kinds')?.split(',').map(s => s.trim()).filter(Boolean) ?? null

  // The schema INLINED, not the file's own bytes. `schemaMutants` mutates text
  // and `mutationScore` parses it, and `parse` does not follow an import — so a
  // schema that imports a fragment reads as a file full of `extend model`
  // statements naming models nothing declared, and every mutant of it dies for a
  // reason that has nothing to do with the mutation. On `packages/basecamp` that
  // was all 300 of them and the run refused outright (FJS-597), which is the
  // FJS-264 class: anything loading a schema from a PATH owes the imports.
  //
  // `inlineImportsFromDisk` rather than `parseFile`, because what is wanted here
  // is TEXT — the mutation catalog is line-oriented, and `createTestEnv` keys
  // its template cache on the same string.
  //
  // A fragment that could not be read is named rather than skipped: its models
  // are absent, so every rule they declare is silently outside the run.
  const { text: schemaText, missing } = inlineImportsFromDisk(schemaPath)
  if (missing.length) log(
    `  ${yellow('⚠')}  ${missing.length === 1 ? 'an import' : `${missing.length} imports`} could not be read ` +
    `(${missing.join(', ')}) — the models they declare are outside this run`)

  const all = schemaMutants(schemaText, { kinds })
  if (!all.length) fatal(
    `No mutants for ${rel(schemaPath)}${kinds ? ` with --kinds=${kinds.join(',')}` : ''}. ` +
    `A schema declaring no @@gate, @@allow, @guarded or field validator has nothing to mutate.`
  )

  log(`  ${dim(`${all.length} mutants · ${basename(schemaPath)}`)}`)
  log()

  // Progress as it goes: a 232-mutant run is minutes, and a silent one is
  // indistinguishable from a hung one.
  let done = 0
  const started = Date.now()
  const result  = await mutationScore({
    schema: schemaText,
    kinds,
    // `getEncKey()` is where every other command in this file reads the key —
    // env, because a key is not config. This alone read `cfg.encryptionKey`,
    // which loadConfig does not populate, so a schema declaring `@secret` could
    // not be BUILT and every mutant came back refused by the loader.
    build:  (text) => createTestEnv({ schema: text, encryptionKey: getEncKey() }),
    // Only on a terminal: `\r` does not erase in a pipe or a log, so a
    // redirected run collected one progress line per tick on a single row.
    onMutant: () => {
      done++
      if (asJson || !process.stdout.isTTY) return
      if (done % 5 === 0 || done === all.length) process.stdout.write(`\r  ${dim(`${done}/${all.length}`)}   `)
    },
  })
  if (!asJson && process.stdout.isTTY) process.stdout.write('\r                    \r')

  const pct   = result.graded ? Math.round(result.score * 100) : 100

  if (asJson) {
    console.log(JSON.stringify({
      mutants: all.length, graded: result.graded, killed: result.killed, score: pct,
      refused: result.refused.length, missing,
      errored:  result.errored.map(e => ({ kind: e.kind, lineNo: e.lineNo, describe: e.describe, thrown: String(e.thrown) })),
      survived: result.survived.map(s => ({ kind: s.kind, lineNo: s.lineNo, describe: s.describe })),
    }, null, 2))
    return
  }
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
    console.log(`  ${dim('@@allow (a create has no WHERE, so only its @@deny rules are graded).')}`)
  }

  hints([
    `  ${dim('--kinds=<a,b>')}  ${dim(`narrow: ${[...new Set(all.map(m => m.kind))].join(', ')}`)}`,
    `  ${dim('--json')}         ${dim('the score and every survivor as data')}`,
  ])
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
                const db = openDatabase(dbPath, { readonly: true })
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
                const db2 = openDatabase(dbPath)
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
                const pristineDb = openDatabase(':memory:')
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

  // Where the database IS.
  //
  // `loadConfig` always answers a `db`, and it answers `./development.db` when
  // nothing said otherwise — so this read a file the schema never named, for
  // every app that declares a `database` block. `fli db:pull` passes `--schema`
  // and no path at all, which is exactly that case, so the one documented way to
  // run this command could not run it. Same class as FJS-449: the declaration is
  // the answer, and `openSqliteDbs` has always known it.
  //
  // One database in, one schema out — this emits no `@@db` — so a schema
  // declaring several is asked which, by name, rather than served the first.
  let dbPath = dbArg
  if (!dbPath && cfg.schema && existsSync(resolve(cfg.schema))) {
    const parsed = loadSchema(cfg.schema)
    if (parsed?.schema && declaresDatabases(parsed)) {
      const sqlite = parsed.schema.databases.filter(d => !d.driver || d.driver === 'sqlite')
      const named  = getFlag('db')
      const pick   = named ? sqlite.filter(d => d.name === named) : sqlite
      if (named && !pick.length)
        fatal(`No database named '${named}' in ${rel(resolve(cfg.schema))}.\n` +
              `     Declared: ${sqlite.map(d => d.name).join(', ')}`)
      if (pick.length > 1)
        fatal(`${rel(resolve(cfg.schema))} declares ${pick.length} databases — name one.\n` +
              `     litestone introspect --db=${pick[0].name}   (of ${pick.map(d => d.name).join(', ')})`)
      if (pick.length === 1) dbPath = resolveDbPath(pick[0].path, null, schemaAnchor(cfg.schema))
    }
  }
  dbPath ??= cfg.db
  if (!dbPath) fatal('No database path provided.\n     Usage: litestone introspect ./mydb.db')

  const abs = resolve(dbPath)
  if (!existsSync(abs)) fatal(`Database not found: ${abs}`)

  const out      = getFlag('out')
  const report   = getFlag('report')
  const noCamel  = flag('no-camel')
  // Same rule `import` keeps: the report goes to stderr when the schema goes to
  // stdout, so `litestone introspect app.db > schema.lite` is a schema and not a
  // schema with a report glued to the top of it.
  const say      = out ? console.log : console.error

  const { introspectToLite }  = await import('./introspect.js')
  const { tierOf }            = await import('../import/tiers.js')

  const db = openDatabase(abs, { readonly: true })
  const { lite: liteSchema, gaps, summary } = introspectToLite(db, { camelCase: !noCamel })
  db.close()

  if (out) {
    const outPath = resolve(out)
    const { writeFileSync } = await import('fs')
    writeFileSync(outPath, liteSchema)
    console.log(`  ${green('✓')}  Schema written to ${rel(outPath)}`)
  } else {
    console.log(liteSchema)
  }

  if (report) {
    const target = resolve(report)
    const { writeFileSync } = await import('fs')
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(gaps.map(g => ({ ...g, tier: tierOf(g.kind) })), null, 1))
  }

  say()
  say(`  ${dim('Models')}   ${(liteSchema.match(/^model /gm) || []).length}`)
  say(`  ${dim('Enums')}    ${(liteSchema.match(/^enum /gm) || []).length}`)
  if (report) say(`  ${green('✓')}        ${summary.total} records written to ${rel(resolve(report))}`)

  reportGaps(summary, gaps.map(g => ({ ...g, tier: tierOf(g.kind) })), say, Boolean(out))

  if (flag('strict') && summary.changed) {
    say(`  ${red('✗')}  --strict: ${summary.changed} construct${summary.changed === 1 ? '' : 's'} ` +
        `changed meaning.\n`)
    process.exit(1)
  }

  say()
  say(`  ${dim('Options:')}`)
  say(`    ${cyan('--out=schema.lite')}  write to file instead of stdout`)
  say(`    ${cyan('--report=gaps.json')} what the reading could not carry`)
  say(`    ${cyan('--strict')}           exit 1 if anything changed meaning`)
  say(`    ${cyan('--no-camel')}         keep original snake_case names`)
  say()
}

// ─── Import ───────────────────────────────────────────────────────────────────
//
// Bring the schema you already have. Four front-ends — Prisma, a Rails
// schema.rb, a Postgres dump, a Frappe app — and one contract they all keep:
// **the .lite is not the whole answer, the refusal list is.** A reading that
// prints only the output is one that has quietly decided what to lose.
//
// The report is on stderr when the schema goes to stdout, so
// `litestone import x.prisma > schema.lite` is a schema and not a schema with a
// report glued to the top of it.

async function cmdImport(pathArg) {
  const { detectFormat, loadSource, convert, annotate, fileHeader, tierOf, FORMATS } =
    await import('../import/index.js')

  if (!pathArg) fatal(
    `No source given.\n     Usage: litestone import <path> [--from=${FORMATS.join('|')}] [--out=db/schema.lite]`)

  const abs = resolve(pathArg)
  if (!existsSync(abs)) fatal(`Not found: ${abs}`)

  const asked = getFlag('from')
  if (asked && !FORMATS.includes(asked))
    fatal(`Unknown --from=${asked}. One of: ${FORMATS.join(', ')}`)

  // A dump named `.txt` is still a dump, so a stated format always wins over the
  // guess from the filename.
  const format = asked ?? detectFormat(abs)
  if (!format) fatal(
    `Cannot tell what kind of schema ${basename(abs)} is.\n` +
    `     Name it: --from=${FORMATS.join('|')}`)

  const out    = getFlag('out')
  const report = getFlag('report')
  const say    = out ? console.log : console.error   // keep stdout clean when piping

  if (out) header('litestone import')

  let source
  try { ({ source } = loadSource(abs, format)) } catch (e) { fatal(e.message) }

  const label = basename(abs, extname(abs)) || basename(abs)
  const { lite, gaps, models, summary } = convert({ source, format, label })

  // A reader pointed at the wrong file finds nothing and reports nothing missing,
  // which is a green tick over an empty schema — the exact silence this command
  // is built to break. Refuse before anything is written.
  if (!models.length) fatal(
    `Read ${rel(abs)} as ${format} and found no models.\n` +
    `     ${asked ? 'Is --from=' + asked + ' right for this file?' : 'Name the format with --from=' + FORMATS.join('|') + '.'}`)

  const body = fileHeader({ format, path: rel(abs), models: models.length, summary }) +
               annotate(lite, gaps)

  if (out) {
    const target = resolve(out)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
  } else {
    process.stdout.write(body)
  }

  if (report) {
    const target = resolve(report)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(gaps.map(g => ({ ...g, tier: tierOf(g.kind) })), null, 1))
  }

  say()
  say(`  ${dim('Source')}   ${rel(abs)} ${dim(`(${format})`)}`)
  say(`  ${dim('Models')}   ${models.length}`)
  if (out)    say(`  ${green('✓')}        written to ${rel(resolve(out))}`)
  if (report) say(`  ${green('✓')}        ${summary.total} records written to ${rel(resolve(report))}`)

  reportGaps(summary, gaps.map(g => ({ ...g, tier: tierOf(g.kind) })), say, Boolean(out))

  if (flag('strict') && summary.changed) {
    say(`  ${red('✗')}  --strict: ${summary.changed} construct${summary.changed === 1 ? '' : 's'} ` +
        `changed meaning.\n`)
    process.exit(1)
  }
  say()
}

// What each tier means is stated here rather than in a legend nobody reads, and
// `changed` is printed ROW BY ROW while the other two are counted: a changed
// construct is a column somebody has to look at, and there are rarely many.
function reportGaps(summary, graded, say, wroteFile) {
  if (!summary.total) {
    say(`\n  ${green('✓')}  Nothing in the source went unexpressed.`)
    return
  }

  say(`\n  ${bold(`What the reading could not express`)} ` +
       `${dim(`— ${summary.total} construct${summary.total === 1 ? '' : 's'}`)}`)

  const MEANING = {
    changed: 'the schema says something the source does not',
    lost:    'the source says something the schema does not',
    noted:   'a decision for you, not a defect',
  }
  const paint = { changed: red, lost: yellow, noted: dim }

  for (const tier of ['changed', 'lost', 'noted']) {
    if (!summary[tier]) continue
    say(`\n    ${paint[tier](tier.padEnd(8))} ${String(summary[tier]).padStart(4)}  ${dim(MEANING[tier])}`)

    if (tier === 'changed') {
      for (const g of graded.filter(x => x.tier === 'changed'))
        say(`      ${dim('·')} ${cyan(where(g))}  ${g.detail} ${dim('→')} ${clip(g.emitted, 60)}`)
      continue
    }
    for (const row of summary.byKind.filter(r => r.tier === tier))
      say(`      ${String(row.count).padStart(4)}x ${row.kind}` +
           `  ${dim(clip(`${where(row.first)} — ${row.first.emitted}`, 74))}`)
  }

  if (summary.changed && wroteFile)
    say(`\n  ${dim('Every')} changed ${dim('one is marked in the file with')} // ⚠ imported:`)
  say(`  ${dim('--report=<path>')}  the whole list as JSON, tier included`)
}

const where = (g) => g.field ? `${g.model}.${g.field}` : (g.model ?? '—')
const clip  = (s, n) => { const t = String(s ?? '') ; return t.length > n ? t.slice(0, n - 1) + '…' : t }

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

  const { readdirSync, readFileSync } = await import('fs')

  // User seeds dir — explicit config wins, otherwise ./seeds/.
  const userSeedsDir = cfg.seedsDir
    ?? (existsSync(resolve('./seeds')) ? resolve('./seeds') : null)

  const dbPath = getFlag('db') ? resolve(getFlag('db')) : cfg.db
  const force  = flag('force')

  // ── Catalog helper — returns Map<name, { source, file, sql, display }> ───
  // Built-ins come from BUILTIN_SEEDS (embedded at build time, so they exist in
  // a compiled binary); user seeds are read from disk. User seeds with the same
  // name as a built-in override it (last-write-wins on the Map).
  const catalog = () => {
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
    const seeds = catalog()
    if (!seeds.size) {
      console.log(`  ${dim('No seeds available.')}`)
      console.log(`  Add .sql or .js files to ${cyan('./seeds/')} or set ${cyan('seedsDir')} in litestone.config.js\n`)
      return
    }

    // Check which are applied (if db exists)
    const applied = new Set()
    if (dbPath && existsSync(dbPath)) {
      const raw = openDatabase(dbPath, { readonly: true })
      applyBusyTimeout(raw)
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

  const seeds    = catalog()
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

  const raw = openDatabase(dbPath)
  applyBusyTimeout(raw)

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
//   litestone backup                   → <schema dir>/backups/2026-04-21_120000/
//   litestone backup ./my-backup/      → explicit destination directory
//   litestone backup --vacuum          → compact SQLite files during backup
//   litestone backup --zip             → zip the backup directory with timestamp
//   litestone backup --db main         → only backup one database

async function cmdBackup(dest, cfg) {
  header('litestone backup')

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
  // When zipping, we still write to a temp dir first, then zip it
  const resolvedDest = dest
    ? (zip ? resolve(dest.replace(/\.zip$/, '')) : resolve(dest))
    : newBackupDir(defaultBackupRoot(cfg))
  const zipPath      = zip
    ? (dest ? resolve(dest.endsWith('.zip') ? dest : dest + '.zip') : `${resolvedDest}.zip`)
    : null

  // Written into, an earlier backup keeps every file this run does not replace —
  // a database since emptied comes back from it on restore.
  if (dest && existsSync(resolvedDest) && readdirSync(resolvedDest).length)
    fatal(`${cyan(rel(resolvedDest))} already holds files, and a backup written over another is neither.\n` +
          `     Name a new directory, or leave the destination off for a new ${cyan(rel(defaultBackupRoot(cfg)) + '/<stamp>/')}.`)
  if (zip && existsSync(zipPath))
    fatal(`${cyan(rel(zipPath))} already exists, and zip adds to an archive rather than replacing it.`)

  mkdirSync(resolvedDest, { recursive: true })

  // Each file is opened on its own path, never through a client — see copyTargets.
  const { sqlite, other, dirs: tenantDirs, layout } = await copyTargets(parseResult, cfg, onlyDb)
  const targets = [...sqlite, ...(layout?.sqlite ?? [])].map(t => ({ ...t, driver: 'sqlite' })).concat(other)

  if (!targets.length && !tenantDirs.length) fatal(`No databases found${onlyDb ? ` matching --db=${onlyDb}` : ''}.`)

  console.log()
  console.log(`  ${dim('destination:')} ${cyan(zip ? rel(zipPath) : rel(resolvedDest))}`)
  console.log(`  ${dim('databases:')}   ${[...targets.map(t => t.name), ...tenantDirs.map(t => t.name)].join(', ')}`)
  if (layout?.files.length) console.log(`  ${dim('files:')}       ${layout.files.length} under ${rel(layout.root)}`)
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

  for (const info of targets) {
    const { name } = info
    const t1 = performance.now()

    if (info.driver === 'sqlite') {
      // ── SQLite: hot backup ──────────────────────────────────────────────
      // Absent is the logger arm's two cases: a parent that exists is an app
      // that has not written yet — a first deploy's pre-migration backup — and
      // a missing one is a path that leads nowhere on this machine.
      if (!existsSync(info.path)) {
        if (existsSync(dirname(info.path))) {
          console.log(`  ${dim('·')}  ${cyan(name)}: ${dim('nothing written yet')}`)
          console.log(`     ${dim(info.path)}`)
        } else {
          console.log(`  ${yellow('⚠')}  ${cyan(name)}: ${dim(info.path)} not found, skipping`)
          incomplete.push(`${name} (${info.path} does not exist — nor does ${dirname(info.path)}, so nothing is mounted there)`)
        }
        console.log()
        continue
      }
      const destFile = resolve(resolvedDest, `${name}.db`)
      let raw
      try {
        raw = openDatabase(info.path)
        const size = await backupSqliteTo(raw, destFile, { vacuum })
        totalSize += size
        const mb = (size / 1024 / 1024).toFixed(2)
        const ms = (performance.now() - t1).toFixed(0)
        console.log(`  ${green('✓')}  ${cyan(name)}  ${dim(`${mb} MB · ${ms}ms${vacuum ? ' · vacuumed' : ''}`)}`)
        console.log(`     ${dim(rel(destFile))}`)
      } catch (e) {
        console.log(`  ${red('✗')}  ${cyan(name)} failed: ${e.message}`)
        incomplete.push(`${name} (${e.message})`)
      } finally {
        raw?.close()
      }

    } else if (info.driver === 'jsonl' || info.driver === 'trail') {
      // ── JSONL / logger: directory copy ──────────────────────────────────
      if (!info.path) {
        console.log(`  ${yellow('⚠')}  ${cyan(name)}: no path configured, skipping`)
        incomplete.push(`${name} (no path configured)`)
        continue
      }
      const srcDir  = resolve(info.path)
      const destDir = resolve(resolvedDest, name)
      if (!existsSync(srcDir)) {
        // A jsonl/trail database is a DIRECTORY the driver creates on its first
        // write, so absent has two causes and they are not the same fact. Both
        // used to be `backup INCOMPLETE` and exit 1, which made the first deploy
        // of every app report that its restore point did not exist — and a
        // refusal that fires on every ordinary run teaches an operator to ignore
        // the one that matters (`FJS-574`).
        //
        // The parent separates them, off the filesystem rather than off a flag
        // the operator has to remember to set. The parent is there and the
        // directory is not: nothing has ever been written to this trail, so
        // there is nothing to copy and the backup is whole. The parent is gone
        // too: the path does not lead anywhere on this machine — an unmounted
        // volume is the usual reason — and what would have been in it is not in
        // this copy.
        //
        // Ambiguity falls toward the refusal, since an absent parent is the
        // unreachable answer.
        if (existsSync(dirname(srcDir))) {
          console.log(`  ${dim('·')}  ${cyan(name)}: ${dim('nothing written yet')}`)
          console.log(`     ${dim(`${srcDir} — a logger creates its directory on the first write`)}`)
          continue
        }
        console.log(`  ${yellow('⚠')}  ${cyan(name)}: ${dim(srcDir)} not found, skipping`)
        incomplete.push(`${name} (${srcDir} does not exist — nor does ${dirname(srcDir)}, so nothing is mounted there)`)
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

  // ── Tenant files: a hot copy of each, the way `main` is copied ──────────────
  // Absent has the two causes the logger arm separates, and the same answer:
  // a parent that exists is a fleet with no tenant yet, a missing one is a path
  // that leads nowhere on this machine.
  for (const t of tenantDirs) {
    const t1    = performance.now()
    const files = matchingFiles(t)
    if (!files.length) {
      if (existsSync(dirname(t.dir))) {
        console.log(`  ${dim('·')}  ${cyan(t.name)}: ${dim('nothing written yet')}`)
        console.log(`     ${dim(join(t.dir, t.pattern))}`)
      } else {
        console.log(`  ${yellow('⚠')}  ${cyan(t.name)}: ${dim(t.dir)} not found, skipping`)
        incomplete.push(`${t.name} (${t.dir} does not exist — nor does ${dirname(t.dir)}, so nothing is mounted there)`)
      }
      console.log()
      continue
    }
    const destDir = resolve(resolvedDest, t.name)
    mkdirSync(destDir, { recursive: true })
    let dirSize = 0
    for (const f of files) {
      let raw
      try {
        raw = openDatabase(join(t.dir, f))
        dirSize += await backupSqliteTo(raw, resolve(destDir, f))
      } catch (e) {
        console.log(`  ${red('✗')}  ${cyan(t.name)}/${f} failed: ${e.message}`)
        incomplete.push(`${t.name}/${f} (${e.message})`)
      } finally {
        raw?.close()
      }
    }
    totalSize += dirSize
    const count = files.length
    console.log(`  ${green('✓')}  ${cyan(t.name)}  ${dim(`${count} file${count !== 1 ? 's' : ''} · ${(dirSize / 1024 / 1024).toFixed(2)} MB · ${(performance.now() - t1).toFixed(0)}ms`)}`)
    console.log(`     ${dim(rel(destDir))}`)
    console.log()
  }

  // ── The rest of db/: a stored file is a row's other half ────────────────────
  // Copied as bytes under `db-files/`, keeping each path under `db/`, so a
  // restore is one copy back onto the volume.
  if (layout?.files.length) {
    const t1      = performance.now()
    const destDir = resolve(resolvedDest, 'db-files')
    let dirSize = 0, copied = 0
    for (const f of layout.files) {
      try {
        const to = resolve(destDir, f.rel)
        mkdirSync(dirname(to), { recursive: true })
        cpSync(f.path, to)
        dirSize += statSync(to).size
        copied++
      } catch (e) {
        console.log(`  ${red('✗')}  ${cyan('db-files')}/${f.rel} failed: ${e.message}`)
        incomplete.push(`db-files/${f.rel} (${e.message})`)
      }
    }
    totalSize += dirSize
    console.log(`  ${green('✓')}  ${cyan('db-files')}  ${dim(`${copied} file${copied !== 1 ? 's' : ''} · ${(dirSize / 1024 / 1024).toFixed(2)} MB · ${(performance.now() - t1).toFixed(0)}ms`)}`)
    console.log(`     ${dim(rel(destDir))}`)
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
// Litestream replicates SQLite. A jsonl or trail database is a directory of
// append-only files with no WAL, so it CANNOT be covered here — reported by
// name rather than omitted, because a replication report that lists only what
// it did reads as though it did everything.

async function cmdReplicate(cfg) {
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

  const { sqlite, other: unreplicable, dirs, layout } = await copyTargets(parseResult, cfg, onlyDb)
  if (!sqlite.length && !unreplicable.length && !dirs.length) fatal(`No databases found${onlyDb ? ` matching --db=${onlyDb}` : ''}.`)

  const targets = [...sqlite, ...dirs, ...(layout?.sqlite ?? [])]

  if (unreplicable.length || layout?.files.length) {
    console.log(`  ${yellow(bold('⚠  not replicated'))}  ${dim('litestream streams SQLite WAL only')}`)
    for (const info of unreplicable)
      console.log(`     ${cyan(info.name)} ${dim(`(${info.driver})`)}  ${dim(info.path ?? 'no path')}`)
    if (layout?.files.length) {
      const shown = layout.files.slice(0, 5)
      for (const f of shown) console.log(`     ${cyan(`db/${f.rel}`)}`)
      if (layout.files.length > shown.length) console.log(`     ${dim(`…and ${layout.files.length - shown.length} more file(s) under ${layout.root}`)}`)
    }
    console.log()
    console.log(`  ${dim(`Cover these with ${cyan('litestone backup')} on a schedule, or sync the directory to object storage.`)}`)
    console.log()
  }

  if (!targets.length) {
    fatal(
      `Nothing to replicate — no SQLite databases declared${onlyDb ? ` matching --db=${onlyDb}` : ''}.\n` +
      `     litestream streams SQLite WAL; jsonl and trail databases need ${cyan('litestone backup')}.`
    )
  }

  await replicate({ targets, options, dir: dirname(resolve(cfg.schema)) })
}

// ─── cmdRestore ───────────────────────────────────────────────────────────────
// The mirror of `replicate`: the same targets, from the same `<url>/<name>`
// paths, back onto the paths the schema and the tenancy block resolve to.
//
//   litestone restore --url s3://bucket/myapp          → every database, latest
//   litestone restore --at 2026-09-27T10:00:00Z        → one instant, for every file
//   litestone restore --from-backup ./backups/<stamp>  → every database from a `backup`
//   litestone restore --url … --from-backup <dir>      → SQLite from the replica, jsonl/logger from the backup
//                                                        (--at and --verify name the replica too)
//   litestone restore --force                          → over files that exist
//
// All or nothing. Every file is restored beside its destination first, and
// only when every one of them has come back is any of them moved into place:
// an app that starts on `main` and yesterday's tenants, or on its rows and no
// audit trail, is the failure a restore has to make impossible rather than
// report. The registry comes back first, because it is what names the tenants.

async function cmdRestore(cfg) {
  const { requireLitestream, restoreFile, replicaUrl } = await import('./replicate.js')
  const { rmSync, renameSync, cpSync }                 = await import('fs')

  const parseResult = loadSchema(cfg.schema)
  const onlyDb      = declaresDatabases(parseResult) ? getFlag('db') : null
  const url         = getFlag('url') ?? cfg.replicate?.url
  const at          = getFlag('at')
  const fromBackup  = getFlag('from-backup')
  const force       = flag('force')
  const verifyDir   = getFlag('verify') ? resolve(getFlag('verify')) : null

  // A backup and no replica word on the line: everything comes from the backup.
  // `replicate.url` in the config does not count — a developer putting back a
  // local checkpoint must not be handed the production replica. With --url,
  // --at or --verify, the replica brings the SQLite files and the backup brings
  // what litestream never streamed.
  if (fromBackup && !getFlag('url') && !at && !verifyDir) return restoreFromBackup(parseResult, cfg, { onlyDb, fromBackup, force })

  if (verifyDir && force) fatal(`${cyan('--verify')} restores beside the app and never over it, so ${cyan('--force')} has nothing to replace.`)
  if (verifyDir) await confirmKeyless(loadSchema(cfg.schema))
  if (verifyDir && existsSync(verifyDir) && readdirSync(verifyDir).length)
    fatal(`${cyan('--verify')} restores into an empty directory, and ${rel(verifyDir)} is not one.`)
  if (!url) fatal(`No replica url. Pass ${cyan('--url=s3://bucket/myapp')} — the one ${cyan('replicate')} streamed to — or set ${cyan('replicate.url')} in litestone.config.js.`)
  if (at && Number.isNaN(Date.parse(at))) fatal(`${cyan('--at')} is an instant — ${cyan('2026-09-27T10:00:00Z')} — and ${cyan(at)} is not one.`)

  header('litestone restore')

  const targets = await copyTargets(parseResult, cfg, onlyDb)
  // Under --verify every target lands beneath the one directory, in the layout
  // `litestone backup` writes, and no live path is ever named.
  const { sqlite, other, dirs } = verifyDir ? {
    sqlite: targets.sqlite.map(t => ({ ...t, path: join(verifyDir, `${t.name}.db`) })),
    other:  targets.other.map(t => ({ ...t, path: join(verifyDir, t.name) })),
    dirs:   targets.dirs.map(t => ({ ...t, dir: join(verifyDir, t.name) })),
  } : targets
  if (!sqlite.length && !other.length && !dirs.length) fatal(`No databases found${onlyDb ? ` matching --db=${onlyDb}` : ''}.`)

  // jsonl and trail databases were never streamed, so their only way back is
  // a `litestone backup` directory — and without one this is the partial the
  // command exists to refuse.
  if (other.length && !fromBackup)
    fatal(`${other.map(o => cyan(o.name)).join(', ')} ${other.length > 1 ? 'are' : 'is a'} ${other.map(o => o.driver).join('/')} database${other.length > 1 ? 's' : ''}, which litestream never streamed.\n` +
          `     Pass ${cyan('--from-backup <dir>')} — a ${cyan('litestone backup')} destination — to bring ${other.length > 1 ? 'them' : 'it'} back from there,\n` +
          `     or ${cyan('--db <name>')} to restore one database and leave the rest deliberately.`)
  const missingCopies = other.filter(o => !existsSync(join(resolve(fromBackup ?? '.'), o.name)))
  if (other.length && missingCopies.length)
    fatal(`The backup at ${cyan(fromBackup)} has no ${missingCopies.map(o => cyan(o.name + '/')).join(', ')}.`)

  const binary  = requireLitestream()
  const staging = []
  const stage   = dest => join(dirname(dest), `.${basename(dest)}.restoring`)
  const discard = () => { for (const s of staging) rmSync(s, { force: true }) }

  // Every file this run will write, collected before anything is fetched.
  const jobs = sqlite.map(t => ({ kind: 'declared', name: t.name, url: replicaUrl(url, t.name), dest: t.path }))

  // ── The registry, then the tenants it names ────────────────────────────────
  const files = dirs.find(d => d.name === 'tenant-files')
  const reg   = dirs.find(d => d.name === 'tenant-registry')
  if (files) {
    const inDir   = basename(resolve((await tenantOptions(cfg)).registry ?? 'registry.db'))
    const regDest = reg ? join(reg.dir, reg.pattern) : verifyDir ? join(files.dir, inDir) : resolve((await tenantOptions(cfg)).registry ?? join(files.dir, 'registry.db'))
    const regUrl  = reg ? `${replicaUrl(url, 'tenant-registry')}/${reg.pattern}` : `${replicaUrl(url, 'tenant-files')}/${basename(regDest)}`
    mkdirSync(dirname(regDest), { recursive: true })
    const got = restoreFile(binary, { url: regUrl, out: stage(regDest), at })
    staging.push(stage(regDest))
    if (!got.ok) { discard(); fatal(`The tenant registry did not come back — nothing was restored.\n     ${regUrl}\n     ${got.error}`) }

    const { registryIds } = await import('../tenant.js')
    for (const id of registryIds(stage(regDest)))
      jobs.push({ kind: 'tenant', id, name: `tenant ${id}`, url: `${replicaUrl(url, 'tenant-files')}/${id}.db`, dest: join(files.dir, `${id}.db`) })
    jobs.push({ kind: 'registry', name: 'tenant-registry', url: regUrl, dest: regDest, staged: true })
  } else if (reg) {
    jobs.push({ kind: 'registry', name: 'tenant-registry', url: `${replicaUrl(url, 'tenant-registry')}/${reg.pattern}`, dest: join(reg.dir, reg.pattern) })
  }

  // ── Refuse before fetching anything else ──────────────────────────────────
  const occupied = [...jobs.map(j => j.dest), ...other.map(o => o.path)].filter(p => existsSync(p))
  if (occupied.length && !force) {
    discard()
    fatal(`Restoring would replace what is already there:\n` +
          occupied.map(p => `       ${rel(p)}`).join('\n') + '\n' +
          `     Stop the app first, then pass ${cyan('--force')} — or point the paths somewhere empty to restore beside it.`)
  }

  const unreachable = []
  for (const j of jobs.filter(j => !j.staged)) {
    const probe = restoreFile(binary, { url: j.url, out: stage(j.dest), at, dryRun: true })
    if (!probe.ok) unreachable.push(`${j.name}  ${dim(j.url)}\n       ${probe.error}`)
  }
  if (unreachable.length) {
    discard()
    fatal(`${unreachable.length} of ${jobs.length} could not be reached — nothing was restored:\n` +
          unreachable.map(u => `     ${u}`).join('\n'))
  }

  console.log()
  console.log(`  ${dim('replica:')}     ${cyan(url)}`)
  console.log(`  ${dim('as of:')}       ${at ? cyan(at) : dim('the latest')}`)
  console.log()

  // ── Fetch everything beside its destination ───────────────────────────────
  for (const j of jobs.filter(j => !j.staged)) {
    mkdirSync(dirname(j.dest), { recursive: true })
    const got = restoreFile(binary, { url: j.url, out: stage(j.dest), at })
    staging.push(stage(j.dest))
    if (!got.ok) { discard(); fatal(`${cyan(j.name)} failed after the others were reached — nothing was restored.\n     ${got.error}`) }
  }

  // ── Then move it all into place ───────────────────────────────────────────
  // An old -wal beside a restored file would be replayed onto it, and
  // litestream's own `.<db>-litestream` state describes the database that is
  // being replaced — the next `replicate` starts that file's history over.
  for (const j of jobs) {
    for (const stale of [`${j.dest}-wal`, `${j.dest}-shm`, join(dirname(j.dest), `.${basename(j.dest)}-litestream`)])
      rmSync(stale, { recursive: true, force: true })
    renameSync(stage(j.dest), j.dest)
    console.log(`  ${green('✓')}  ${cyan(j.name)}  ${dim(rel(j.dest))}`)
  }
  for (const o of other) {
    rmSync(o.path, { recursive: true, force: true })
    cpSync(join(resolve(fromBackup), o.name), o.path, { recursive: true })
    console.log(`  ${green('✓')}  ${cyan(o.name)}  ${dim(`${rel(o.path)} ← ${rel(join(resolve(fromBackup), o.name))}`)}`)
  }

  console.log()
  console.log(`  ${green(bold('✓  restore complete'))}  ${dim(`${jobs.length + other.length} database${jobs.length + other.length !== 1 ? 's' : ''}`)}`)
  console.log()

  if (verifyDir) await verifyRestored({ parseResult, cfg, jobs, other, files, dir: verifyDir, binary })
}

// ─── restore --from-backup: a `litestone backup` directory, put back ─────────
// The layout `backup` writes is the map: `<name>.db` for a SQLite database,
// `<name>/` for a jsonl or logger one, `tenant-files/` and `tenant-registry/`
// for the per-tenant files, `db-<path>.db` for a SQLite file under db/ that no
// schema names. All or nothing, as a replica restore is: every copy is staged
// beside its destination before any is moved into place.
//
// A database the backup does not hold is left as it is, and named. `backup`
// writes nothing for a database nothing had written to yet, and nothing for one
// a `--db` left out, and the directory cannot say which — deleting a live audit
// trail on the strength of an absence is the wrong way round.
//
// `db-files/` is not put back: it holds the schema and the migrations beside
// any stored bytes, and those are the repo's to restore. A database whose
// history is behind the files applies the rest on the next migrate.
async function restoreFromBackup(parseResult, cfg, { onlyDb, fromBackup, force }) {
  const { rmSync, renameSync, cpSync } = await import('fs')

  const src = resolve(fromBackup)
  if (src.endsWith('.zip')) fatal(`${cyan(rel(src))} is a zip. Unzip it into a directory and pass that.`)
  if (!existsSync(src) || !statSync(src).isDirectory()) fatal(`No backup directory at ${cyan(rel(src))}.`)

  header('litestone restore')

  const { sqlite, other, dirs, layout } = await copyTargets(parseResult, cfg, onlyDb)
  const jobs = [], absent = []

  for (const t of sqlite) {
    const from = join(src, `${t.name}.db`)
    if (existsSync(from)) jobs.push({ name: t.name, from, dest: t.path })
    else absent.push(t.name)
  }
  for (const o of other) {
    const from = join(src, o.name)
    if (existsSync(from)) jobs.push({ name: o.name, from, dest: resolve(o.path), dir: true })
    else absent.push(o.name)
  }
  for (const d of dirs) {
    const from = join(src, d.name)
    if (!existsSync(from)) { absent.push(d.name); continue }
    for (const f of matchingFiles({ dir: from, pattern: d.pattern }))
      jobs.push({ name: `${d.name}/${f}`, from: join(from, f), dest: join(d.dir, f) })
  }

  // Found by the name the live walk gives a file: `db-<path>` turns the path's
  // slashes into hyphens, so `db-a-b.db` alone is `a/b.db` or `a-b.db`.
  if (!onlyDb) {
    const live     = new Map((layout?.sqlite ?? []).map(t => [`${t.name}.db`, t.path]))
    const unplaced = []
    for (const f of readdirSync(src).filter(f => /^db-.+\.db$/.test(f))) {
      if (live.has(f)) jobs.push({ name: f.slice(0, -3), from: join(src, f), dest: live.get(f) })
      else unplaced.push(f)
    }
    if (unplaced.length)
      fatal(`The backup holds ${unplaced.map(f => cyan(f)).join(', ')} — a SQLite file under db/ that no schema names — ` +
            `and nothing on this machine is at the path it came from, so its name cannot say where it goes.\n` +
            `     Pass ${cyan('--db <name>')} to restore one declared database and leave it out.`)
  }

  if (!jobs.length)
    fatal(`The backup at ${cyan(rel(src))} holds none of the databases this schema declares${onlyDb ? ` matching --db=${onlyDb}` : ''}.`)

  const occupied = jobs.map(j => j.dest).filter(p => existsSync(p))
  if (occupied.length && !force)
    fatal(`Restoring would replace what is already there:\n` +
          occupied.map(p => `       ${rel(p)}`).join('\n') + '\n' +
          `     Stop the app first, then pass ${cyan('--force')}.`)

  console.log()
  console.log(`  ${dim('backup:')}      ${cyan(rel(src))}`)
  console.log()

  const stage  = dest => join(dirname(dest), `.${basename(dest)}.restoring`)
  const staged = []
  try {
    for (const j of jobs) {
      mkdirSync(dirname(j.dest), { recursive: true })
      rmSync(stage(j.dest), { recursive: true, force: true })
      cpSync(j.from, stage(j.dest), { recursive: !!j.dir })
      staged.push(stage(j.dest))
    }
  } catch (e) {
    for (const s of staged) rmSync(s, { recursive: true, force: true })
    fatal(`Copying out of the backup failed — nothing was restored.\n     ${e.message}`)
  }

  // An old -wal beside a restored file is replayed onto it, which is the half
  // of a hand-rolled `cp` that comes back wrong; litestream's own state
  // describes the database being replaced.
  for (const j of jobs) {
    const companions = j.dir ? [] : [`${j.dest}-wal`, `${j.dest}-shm`, join(dirname(j.dest), `.${basename(j.dest)}-litestream`)]
    for (const p of [j.dest, ...companions]) rmSync(p, { recursive: true, force: true })
    renameSync(stage(j.dest), j.dest)
    console.log(`  ${green('✓')}  ${cyan(j.name)}  ${dim(`${rel(j.dest)} ← ${rel(j.from)}`)}`)
  }
  for (const name of absent)
    console.log(`  ${dim('·')}  ${cyan(name)}: ${dim('not in the backup — left as it is')}`)
  if (existsSync(join(src, 'db-files')))
    console.log(`  ${dim('·')}  ${cyan('db-files')}: ${dim('not restored — the schema and migrations are the repo\'s; copy stored files back by hand')}`)

  console.log()
  console.log(`  ${green(bold('✓  restore complete'))}  ${dim(`${jobs.length} file${jobs.length !== 1 ? 's' : ''} from the backup`)}`)
  console.log()
}

// ─── restore --verify: who says it runs without the key ───────────────────────
// A keyless verify passes with a warning, and a cron line reads only the exit
// code — so a drill whose environment lost the key would stop checking every
// encrypted column and go on passing. The operator states it every time: a
// terminal is asked, anything else needs `--without-key` (`FJS-D501`). Asked
// before the first download, so a refusal costs nothing.

async function confirmKeyless(parseResult) {
  if (getEncKey()) return
  const sealed = parseResult.schema.models.flatMap(m => m.fields
    .filter(f => f.attributes.some(a => a.kind === 'encrypted' || a.kind === 'secret'))
    .map(f => `${m.name}.${f.name}`))
  if (!sealed.length || flag('without-key')) return

  const what = `No ${cyan('ENCRYPTION_KEY')}, so ${sealed.length} encrypted column(s) could not be proven readable:\n` +
               `     ${dim(sealed.join(', '))}`
  if (!process.stdin.isTTY)
    fatal(`${what}\n     Set the key, or pass ${cyan('--without-key')} to verify everything else and say so.`)

  const { createInterface } = await import('node:readline/promises')
  console.log(`  ${yellow('!')}  ${what}\n`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let answer
  try { answer = (await rl.question('  verify without it? [y/N] ')).trim().toLowerCase() }
  finally { rl.close() }
  console.log()
  if (answer !== 'y' && answer !== 'yes') fatal(`Not verified. Set ${cyan('ENCRYPTION_KEY')} and run it again.`)
}

// ─── restore --verify ─────────────────────────────────────────────────────────
// A restored copy is proven by what the schema can say about it, not by the
// app's suite, which arranges its own rows and cannot run on real ones
// (`FJS-D497`). Every check is graded except replica lag: a tenant nobody wrote
// to since Tuesday has a Tuesday replica, and that is correct.
//
// Without the key, the `@encrypted` and `@secret` columns are read around and
// named as not checked — a warning, never a pass (`FJS-D498`). With it, a value
// written under a different key is a failure, which is the lost-key case.

async function verifyRestored({ parseResult, cfg, jobs, other, files, dir, binary }) {
  const { lastWrite }        = await import('./replicate.js')
  const { validateRows }     = await import('../validate-rows.js')
  const { createClient }     = await import('../core/client.js')
  const { buildPristine, buildPristineForDatabase } = await import('../core/migrate.js')
  const { rmSync }           = await import('fs')

  // An empty variable is the operator unsetting the key, not a key.
  const key     = getEncKey() || null
  const keyless = !key
  const sqliteNames = parseResult.schema.databases.filter(d => !d.driver || d.driver === 'sqlite').map(d => d.name)
  const multi   = sqliteNames.length > 1

  // One tenant file holds every sqlite database's tables, so it is graded
  // against all of them; a declared file against its own.
  const drift = (path, names) => {
    const pristineDb = openDatabase(':memory:')
    const live       = openDatabase(path, { readonly: true })
    try {
      const pristine = (multi && names.length === 1) ? buildPristineForDatabase(pristineDb, parseResult, names[0]) : buildPristine(pristineDb, parseResult)
      const found    = introspect(live)
      const changed  = (names.length ? names : ['main'])
        .map(n => diffSchemas(pristine, found, parseResult, n, { pluralize: cfg.pluralize }))
        .filter(d => d.hasChanges)
      return changed.length ? changed.map(d => summarizeDiff(d).split('\n')[0]).join('; ') : null
    } finally { pristineDb.close(); live.close() }
  }

  const pragmas = (path) => {
    const raw = openDatabase(path, { readonly: true })
    try {
      const integrity = raw.query('PRAGMA integrity_check').all().map(r => Object.values(r)[0])
      const orphans   = raw.query('PRAGMA foreign_key_check').all()
      return {
        integrity:   integrity.length === 1 && integrity[0] === 'ok' ? null : integrity.slice(0, 3).join('; '),
        foreignKeys: orphans.length ? `${orphans.length} row(s) reference nothing — first in ${orphans[0].table}` : null,
      }
    } finally { raw.close() }
  }

  const rowsOf = (report) => {
    if (report.unreadable.length) return report.unreadable.map(u => `${u.model} unreadable: ${u.error}`).join('; ')
    const failing = report.checked.reduce((n, c) => n + c.failing, 0)
    return failing ? `${failing} row(s) the schema would refuse — run litestone validate on the copy` : null
  }
  const counted = (report) => report.checked.reduce((n, c) => n + c.rows, 0)

  // Every declared database the client can reach points into the copy: the
  // ones restored at their restored file, the rest at nothing, so no check
  // ever opens — and so creates — a live path.
  const restoredAt = Object.fromEntries([
    ...jobs.filter(j => j.kind === 'declared').map(j => [j.name, j.dest]),
    ...other.map(o => [o.name, o.path]),
  ])
  const databases = Object.fromEntries(parseResult.schema.databases.map(d => [d.name, {
    path: restoredAt[d.name] ?? (!d.driver || d.driver === 'sqlite' ? ':memory:' : join(dir, '.unrestored', d.name) + '/'),
  }]))
  const clientKey = key ?? [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')

  const results    = []
  const notChecked = new Set()

  for (const j of jobs) {
    const r = { name: j.name, path: j.dest, checks: pragmas(j.dest), lag: null, rows: null }
    const last = lastWrite(binary, j.url)
    r.lag = last == null ? null : Math.max(0, Math.round((Date.now() - last) / 1000))
    if (j.kind !== 'registry') r.checks.schema = drift(j.dest, j.kind === 'tenant' ? sqliteNames : [j.name])
    results.push(r)
  }

  // ── Through a client: every row against the schema, every model read ──────
  const declared = jobs.filter(j => j.kind === 'declared')
  if (declared.length) {
    const db = await createClient({
      parsed: parseResult, path: cfg.schema, resolveFrom: 'schema', encryptionKey: clientKey,
      ...(declaresDatabases(parseResult) ? { databases } : { db: declared[0].dest }),
    })
    try {
      const report = await validateRows(db, { keyless })
      report.notChecked.forEach(c => notChecked.add(c))
      for (const r of results.filter(r => declared.some(j => j.name === r.name))) {
        r.checks.rows = rowsOf(report)
        r.rows = counted(report)
      }
    } finally { db.$close() }
  }

  const tenantJobs = jobs.filter(j => j.kind === 'tenant')
  if (tenantJobs.length) {
    const { createTenantRegistry } = await import('../tenant.js')
    const reg = jobs.find(j => j.kind === 'registry')
    const tenants = await createTenantRegistry({
      path: cfg.schema, dir: files.dir, registry: reg.dest, encryptionKey: clientKey,
      clientOptions: { databases: Object.fromEntries(Object.entries(databases).filter(([n]) => !sqliteNames.includes(n))) },
    })
    try {
      for (const j of tenantJobs) {
        const r = results.find(r => r.name === j.name)
        const report = await validateRows(await tenants.get(j.id), { keyless })
        report.notChecked.forEach(c => notChecked.add(c))
        r.checks.rows = rowsOf(report)
        r.rows = counted(report)
      }
    } finally { tenants.close() }
  }

  for (const o of other) {
    const n = existsSync(o.path) ? readdirSync(o.path).length : 0
    results.push({ name: o.name, path: o.path, checks: { copied: n ? null : 'the directory came back empty' }, lag: null, rows: null, files: n })
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const failed = results.filter(r => Object.values(r.checks).some(v => v))
  const lags   = results.map(r => r.lag).filter(l => l != null)
  const report = {
    ok:         failed.length === 0,
    dir,
    newestLag:  lags.length ? Math.min(...lags) : null,
    files:      results,
    notChecked: [...notChecked],
  }

  if (flag('json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  else {
    const ago = s => s == null ? '' : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`
    // The kept copy is something to open, so a path that climbs out of here is printed whole.
    const where = p => rel(p).startsWith('../..') ? p : rel(p)
    console.log(`  ${bold('verify')}  ${dim(where(dir))}`)
    console.log()
    for (const r of results) {
      const bad = Object.entries(r.checks).filter(([, v]) => v)
      const facts = [r.rows != null ? `${r.rows} row(s)` : null, r.files != null ? `${r.files} file(s)` : null, r.lag != null ? `last write ${ago(r.lag)} ago` : null].filter(Boolean).join(' · ')
      console.log(`  ${bad.length ? red('✗') : green('✓')}  ${cyan(r.name)}  ${dim(facts)}`)
      for (const [check, why] of bad) console.log(`       ${red(check)}  ${why}`)
    }
    console.log()
    if (report.notChecked.length) {
      console.log(`  ${yellow('!')}  ${bold('NOT checked')} — no encryption key, so ${report.notChecked.length} column(s) could not be read:`)
      console.log(`       ${dim(report.notChecked.join(', '))}`)
      console.log(`       ${dim('Set ENCRYPTION_KEY to prove they decrypt.')}`)
      console.log()
    }
    if (report.newestLag != null) console.log(`  ${dim('newest write in the replica:')} ${ago(report.newestLag)} ago\n`)
    console.log(report.ok
      ? `  ${green(bold('✓  the copy is good'))}  ${dim('— removed')}\n`
      : `  ${red(bold(`✗  ${failed.length} of ${results.length} failed`))}  ${dim(`— the copy is kept at ${where(dir)}`)}\n`)
  }

  if (report.ok) rmSync(dir, { recursive: true, force: true })
  process.exitCode = report.ok ? 0 : 1
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

  let t0        = performance.now()
  const results = autoMigrate(db, null, { acceptDataLoss: flag('accept-data-loss') })
  let elapsed   = performance.now() - t0

  // Only a terminal is asked: a script, CI or an agent gets the refusal, which
  // is what Prisma does too. The second pass takes only the databases the
  // person answered for — the rest were already applied or refused for a
  // reason a yes does not cover.
  const lost = Object.entries(results).filter(([, r]) => r.state === 'blocked' && r.dataLoss?.length)
  if (lost.length && process.stdin.isTTY && await confirmDataLoss(lost, hasDbs)) {
    t0 = performance.now()
    const again = autoMigrate(db, null, { acceptDataLoss: true })
    elapsed += performance.now() - t0
    for (const [dbName] of lost) results[dbName] = again[dbName]
  }
  const ms = elapsed.toFixed(0)

  let anyChanges = false
  let refused    = false

  for (const [dbName, result] of Object.entries(results)) {
    const label = hasDbs ? `  ${cyan(dbName)}  ` : '  '

    if (result.state === 'skipped') {
      console.log(`${label}${dim('skipped')}  ${dim(`(${result.reason})`)}`)
    // `blocked` and `failed` had no branch at all, so a refused migration
    // printed nothing and the summary below said "already in sync" — a green
    // tick over a change that did not happen, which is the class this command's
    // own refusals exist to prevent (`FJS-646`).
    } else if (result.state === 'blocked' || result.state === 'failed') {
      refused = true
      console.log(`${label}${red('✗')}  ${result.state === 'blocked' ? 'blocked' : 'failed'}  ${result.reason}`)
      if (result.dataLoss?.length)
        console.log(`  ${dim('Pass')} ${cyan('--accept-data-loss')} ${dim('to apply it anyway.')}`)
    } else if (result.state === 'in-sync') {
      // "already in sync" is exactly the sentence a residue makes false, and
      // this command's own refusals exist to stop a green tick over a database
      // that is not the declared one (`FJS-646`, one dimension out).
      console.log(`${label}${green('✓')}  already in sync${result.residue ? dim(` — on every dimension the differ reads`) : ''}`)
      for (const r of result.residue ?? []) {
        console.log(`${label}${yellow('!')}  ${r.type} ${cyan(r.name)} differs in a way the differ cannot name`)
        console.log(`  ${dim('declared:')} ${dim(r.pristine ?? '(absent)')}`)
        console.log(`  ${dim('live    :')} ${dim(r.live ?? '(absent)')}`)
      }
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
  if (refused) {
    // Non-zero, because `db push` is run from scripts and a boot sequence, and
    // a refusal that exits 0 is the same silence one layer up.
    process.exitCode = 1
    console.log(`  ${red(bold('✗  DB not pushed'))}  ${dim(`(${ms}ms)`)}`)
    console.log(`  ${dim('The database is unchanged. Fix the schema, or write it as a file migration:')} ${cyan('litestone migrate create')}`)
  } else if (anyChanges) {
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

// A drops-only diff is also what a database migrated by a NEWER build looks
// like, and a yes there deletes the column that build is writing — so the
// question says so rather than leaving it to the warning above it.
async function confirmDataLoss(lost, hasDbs) {
  console.log(`  ${yellow('!')}  This push drops these columns and every value in them:\n`)
  for (const [dbName, r] of lost) {
    for (const l of r.dataLoss) {
      const at   = hasDbs ? `${cyan(dbName)}  ` : ''
      const hint = l.renameTo ? dim(`  — a rename to ${l.renameTo}? a yes drops the values instead`) : ''
      console.log(`       ${at}${l.columns.map(c => `${l.table}.${c}`).join(', ')}${hint}`)
    }
  }
  if (lost.some(([, r]) => r.onlyDrops))
    console.log(`\n     ${dim('The change only removes. If a newer build migrated this database, answer no.')}`)
  console.log()

  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  let answer
  try { answer = (await rl.question('  apply anyway? [y/N] ')).trim().toLowerCase() }
  finally { rl.close() }
  console.log()
  return answer === 'y' || answer === 'yes'
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
  if (cmd === 'seed') {
    const cfg = await loadConfig()
    if (sub === 'run') { await cmdSeedRun(rest[0] ?? null, cfg); return }
    await cmdSeed(sub, cfg)
    return
  }
  if (cmd === 'introspect') { const cfg = await loadConfig(); await cmdIntrospect(sub, cfg); return }
  if (cmd === 'import') { await cmdImport(sub); return }
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

  if (cmd === 'restore') {
    if (sub && !/\.(js|ts)$/.test(sub))
      fatal(`litestone restore takes a config file positionally, got: ${sub}\n     To point at a schema, use ${cyan('--schema=path/to/schema.lite')}.`)
    const cfg = await loadConfig(sub ?? undefined)
    await cmdRestore(cfg)
    return
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

  // litestone assistant
  //
  // Studio's guidance for somebody with a chat window instead of Studio. The
  // default is the PASTE: the document and this schema, every imported file
  // included, on stdout. --snapshot writes the same document with no schema
  // beside the catalog, which is what the published URL serves, and --check
  // is its CI half.
  if (cmd === 'assistant') {
    const { renderAssistant, collectSchemaFiles, findPurpose } = await import('./assistant.js')
    const cmdline = 'litestone assistant --snapshot'
    const outPath = resolve(import.meta.dirname, '../../assistant.snapshot.md')

    if (flag('snapshot') || flag('check')) {
      const body = renderAssistant({ snapshot: true })
      if (flag('check')) {
        checkSnapshot(outPath, body, {
          regen: cmdline,
          moved: `The schema assistant changed. Run \`${cmdline}\` and review the diff before committing.`,
        })
        console.log()
        return
      }
      writeFileSync(outPath, body, 'utf8')
      console.log(`  ${green('✓')}  ${rel(outPath)}`)
      console.log()
      return
    }

    let schema = null, purpose = null
    if (!flag('bare')) {
      const cfg = await loadConfig()
      loadSchema(cfg.schema)
      schema = collectSchemaFiles(cfg.schema)
      if (getFlag('purpose')) {
        const path = resolve(getFlag('purpose'))
        if (!existsSync(path)) { console.error(`  ${red('✗')}  --purpose: ${getFlag('purpose')} not found`); process.exit(1) }
        purpose = { label: rel(path), text: readFileSync(path, 'utf8') }
      } else {
        purpose = findPurpose(cfg.schema)
      }
    }
    const body = renderAssistant({ schema, purpose })
    if (getFlag('out')) {
      writeFileSync(resolve(getFlag('out')), body, 'utf8')
      console.error(`  ${green('✓')}  ${getFlag('out')} — paste it into a chat, then say what you want to change`)
      return
    }
    process.stdout.write(body)
    return
  }

  if (cmd === 'jsonschema') {
    const cfg = await loadConfig()
    await cmdJsonSchema(cfg)
    return
  }

  if (cmd === 'validate') {
    const cfg = await loadConfig()
    await cmdValidate(cfg)
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
    // `args` is raw argv and still holds the command word, so finding the first
    // non-flag in it returned "tenant" and every subcommand answered "Unknown
    // tenant subcommand". `positional` is what main() already destructured.
    const cfg = await loadConfig()
    await cmdTenant(sub, rest, cfg)
    return
  }

  if (cmd === 'repl') {
    const cfg = await loadConfig()
    await cmdRepl(cfg)
    return
  }

  if (cmd === 'export') {
    const cfg = await loadConfig()
    await cmdExport(cfg)
    return
  }

  if (cmd === 'studio') {
    const cfg = await loadConfig()
    const { cmdStudio } = await import('./studio.js')
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

  if (cmd === 'transform' || (cmd && cmd.endsWith('.js') && !['init','seed','introspect','import','doctor','audit','jsonschema','tenant','repl','studio','migrate','replicate'].includes(cmd))) {
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
      // The schema is resolved the way every other command resolves it; redact()
      // reads its declarations, and a pipeline with no redact never opens it.
      const { schema: schemaPath } = await loadConfig()
      await execute(configPath, { dryRun, verbose: true, outputPath, only, concurrency, skipExisting, force, schemaPath }, run)
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
