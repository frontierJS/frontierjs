// core/db-preflight.js
// "Is there anything in the database?" — asked before a dev server starts.
//
// The failure this exists for: an app boots clean, serves every route, answers
// every request correctly, and shows a person an empty screen — because the
// database has no rows in it. Nothing is broken, so nothing says anything, and
// the first ten minutes go into looking for a bug in the app.
//
// It is a WARNING and never a refusal. An empty database is the correct state
// for a first run, and for anyone about to seed one; the point is that it is
// stated rather than discovered.
//
// ─── how the path is found ───────────────────────────────────────────────────
//
// The schema is the seed, so the schema is asked first: a `database <name> { … }`
// declaration is the one place an app says where its data lives, and it WINS
// over `createClient({ db })` at runtime. `litestone.config.js` is the fallback
// for a schema that declares none.
//
// Parsed with a regex rather than by importing litestone's parser, because this
// runs inside `fli`, which is a plain-node CLI with no @frontierjs dependency of
// its own — a broken parse degrades to "cannot tell", which is the right answer
// for a check that must never block a dev server.
//
// ─── how emptiness is measured ───────────────────────────────────────────────
//
// `node:sqlite` lands in Node 22.5 and fli's floor is 20.6, so it is imported
// optionally and its absence costs the row count, not the check. The file-level
// signals — absent, or zero bytes — need no binding at all and are the ones that
// actually fire: they are what a `db:reset` leaves behind.

import { existsSync, statSync, readFileSync } from 'node:fs'
import { resolve, dirname, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// SQLite writes its own tables in here; they are not the app's data.
const INTERNAL_TABLE = /^sqlite_/

// Litestone's own bookkeeping. A database holding ONLY these has had its
// migrations applied and nothing else — which is precisely the state worth
// naming, so it must not count as "has rows".
const BOOKKEEPING = new Set(['_migrations', '_litestone_migrations', 'migrations'])

/**
 * Every database the schema declares, resolved to a filesystem path.
 *
 * Non-sqlite drivers are skipped: a `driver logger` database is a directory of
 * jsonl and "no rows" says nothing about it.
 *
 * @returns {Array<{ name: string, path: string }>}
 */
export function declaredDatabases(appRoot, dbDir) {
  const schemaPath = resolve(dbDir, 'schema.lite')
  const out = []

  if (existsSync(schemaPath)) {
    let text = ''
    try { text = readFileSync(schemaPath, 'utf8') } catch { return [] }

    // `database main { path env("DATABASE_URL", "./db/basecamp.db") }`
    // `database audit { path "./db/audit/" driver logger retention 90d }`
    const blocks = text.matchAll(/^\s*database\s+(\w+)\s*\{([^}]*)\}/gm)
    for (const [, name, body] of blocks) {
      if (/\bdriver\s+(?!sqlite)\w+/.test(body)) continue   // logger, and anything else
      const path = readPath(body)
      if (path) out.push({ name, path: absolute(path, appRoot) })
    }
    if (out.length) return out
  }

  // No declaration — litestone.config.js is where a simpler app says it.
  const configPath = resolve(dbDir, 'litestone.config.js')
  if (existsSync(configPath)) {
    try {
      const text  = readFileSync(configPath, 'utf8')
      const match = text.match(/\bdb\s*:\s*['"`]([^'"`]+)['"`]/)
      // Relative to the CONFIG, not to the app root — that is how litestone
      // resolves it, and db/ is where the file sits.
      if (match) out.push({ name: 'main', path: absolute(match[1], dirname(configPath)) })
    } catch { /* unparseable — cannot tell, which is a fine answer */ }
  }

  return out
}

/** `path env("DATABASE_URL", "./db/x.db")` or `path "./db/x.db"` → the default. */
function readPath(body) {
  const env = body.match(/\bpath\s+env\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]+)['"`]\s*\)/)
  if (env) {
    // The variable wins at runtime, so it wins here — otherwise the check
    // reports on a file the app will not open.
    const name = body.match(/\bpath\s+env\(\s*['"`]([^'"`]+)['"`]/)?.[1]
    return (name && process.env[name]) || env[1]
  }
  return body.match(/\bpath\s+['"`]([^'"`]+)['"`]/)?.[1] ?? null
}

const absolute = (p, base) => (isAbsolute(p) ? p : resolve(base, p))

/**
 * A read-only SQLite handle, from whichever runtime is hosting `fli`.
 *
 * `fli`'s shebang is node, but nothing stops a person running it under bun —
 * and bun does not implement `node:sqlite` at all, so a node-only import makes
 * this check silently blind rather than wrong. Both bindings expose
 * `prepare().get()/.all()` and `close()`, which is the whole surface used here;
 * only the constructor's readonly option differs in spelling.
 *
 * @returns {((path: string) => any) | null} null when neither is available,
 *   which is Node below 22.5 — the file-level signals still answer.
 */
function sqliteOpener() {
  // node:sqlite is experimental, so importing it prints a warning to stderr —
  // which would put a Node implementation note on top of every `fli dev`, about
  // a check nobody asked to see the machinery of. Muted across the import only.
  const emit = process.emitWarning
  try {
    process.emitWarning = () => {}
    const { DatabaseSync } = require('node:sqlite')
    return (path) => new DatabaseSync(path, { readOnly: true })
  } catch { /* not this runtime, or not this Node */ } finally {
    process.emitWarning = emit
  }

  try {
    const { Database } = require('bun:sqlite')
    return (path) => new Database(path, { readonly: true })
  } catch { /* not bun either */ }

  return null
}

/**
 * What state is this database in?
 *
 * @returns {'missing'|'empty-file'|'no-tables'|'no-rows'|'has-rows'|'unknown'}
 */
export function databaseState(path) {
  if (!existsSync(path)) return 'missing'

  try { if (statSync(path).size === 0) return 'empty-file' } catch { return 'unknown' }

  const open = sqliteOpener()
  if (!open) return 'unknown'

  let db
  try {
    db = open(path)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map(r => String(r.name))
      .filter(n => !INTERNAL_TABLE.test(n))

    if (!tables.length) return 'no-tables'

    const data = tables.filter(n => !BOOKKEEPING.has(n))
    if (!data.length) return 'no-tables'

    for (const table of data) {
      // The identifier comes from sqlite_master, never from a caller
      // (Invariant 8), and is quoted regardless.
      const row = db.prepare(`SELECT 1 FROM "${table.replace(/"/g, '""')}" LIMIT 1`).get()
      if (row) return 'has-rows'
    }
    return 'no-rows'
  } catch {
    return 'unknown'
  } finally {
    try { db?.close() } catch { /* already gone */ }
  }
}

/**
 * Warn about every declared database that has nothing in it.
 *
 * Takes the command `context` so the message can name the app's OWN seed script
 * rather than a guess — an app whose package.json has `db:seed` is told to run
 * it, and one without is told what the state is and left alone.
 *
 * @returns {number} how many databases were reported on
 */
export function warnIfDatabaseEmpty(context, { dbDir } = {}) {
  const appRoot = context.paths.root
  const dir     = dbDir ?? context.paths.db ?? resolve(appRoot, 'db')

  let databases
  try { databases = declaredDatabases(appRoot, dir) } catch { return 0 }
  if (!databases.length) return 0

  const scripts = readScripts(appRoot)
  const seed    = ['db:seed', 'seed'].find(s => scripts[s])
  const runner  = detectRunner(appRoot)
  const hint    = seed ? `${runner} run ${seed}` : null

  let reported = 0
  for (const { name, path } of databases) {
    const state = databaseState(path)
    const where = path.startsWith(appRoot) ? path.slice(appRoot.length + 1) : path

    if (state === 'missing' || state === 'empty-file') {
      context.log.warn(`database "${name}" does not exist yet — ${where}`)
      context.log.info('  it will be created and migrated when the API starts')
      if (hint) context.log.info(`  then seed it: ${hint}`)
      reported++
    } else if (state === 'no-tables') {
      context.log.warn(`database "${name}" has no tables — ${where}`)
      context.log.info('  migrations have not run against it')
      reported++
    } else if (state === 'no-rows') {
      context.log.warn(`database "${name}" is EMPTY — every table has zero rows`)
      context.log.info('  the app will start and every screen will be blank; that is data, not a bug')
      if (hint) context.log.info(`  seed it: ${hint}`)
      reported++
    }
    // 'has-rows' and 'unknown' say nothing. Silence on `unknown` is deliberate:
    // node:sqlite is absent below Node 22.5, and a check that cannot see is not
    // entitled to an opinion.
  }
  return reported
}

function readScripts(appRoot) {
  try {
    return JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8')).scripts ?? {}
  } catch { return {} }
}

/**
 * bun or npm — decided by a lockfile, searched UP from the app.
 *
 * Upward, because a package inside a workspace has no lockfile of its own: the
 * one lockfile sits at the workspace root, and looking only beside package.json
 * reports "npm" for every package in a bun monorepo.
 */
export function detectRunner(appRoot) {
  let dir = appRoot
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'bun.lock')) || existsSync(resolve(dir, 'bun.lockb'))) return 'bun'
    if (existsSync(resolve(dir, 'package-lock.json'))) return 'npm'
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'npm'
}
