// migrations.js — migration file management + apply/status/verify
//
// Commands:
//   create(db, parseResult, label, dir)  → generate + write migrations/TIMESTAMP_label.sql
//   apply(db, dir)                       → apply all pending migration files in order
//   status(db, dir)                      → show applied + pending migrations
//   verify(db, parseResult, dir)         → check live db against pristine schema

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'fs'
import { resolve, join } from 'path'
import { Database } from 'bun:sqlite'
import {
  introspect, buildPristine, buildPristineForDatabase, diffSchemas,
  generateMigrationSQL, summariseDiff, checksum, splitStatements,
} from './migrate.js'
import { generateDDLForDatabase, detectM2MPairs, generateJoinTableDDL, planEdgeStorage, generateEdgeSideTableDDL } from './ddl.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIGRATIONS_TABLE = `_litestone_migrations`
const MIGRATION_FILE   = /^(\d{14})_([a-z0-9_]+)\.(sql|js)$/
// Anything that was plausibly meant to be a migration. Only used to report what
// MIGRATION_FILE rejected — never to widen what runs.
const MIGRATION_CANDIDATE = /\.(sql|js)$/

// ─── Tracking table ───────────────────────────────────────────────────────────

function ensureTrackingTable(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL UNIQUE,
      applied_at  TEXT    NOT NULL,
      checksum    TEXT    NOT NULL
    )
  `)
}

export function appliedMigrations(db) {
  ensureTrackingTable(db)
  return db
    .query(`SELECT name, applied_at, checksum FROM "${MIGRATIONS_TABLE}" ORDER BY name`)
    .all()
}

function recordMigration(db, name, sql) {
  ensureTrackingTable(db)
  db.query(`
    INSERT INTO "${MIGRATIONS_TABLE}" (name, applied_at, checksum)
    VALUES (?, ?, ?)
  `).run(name, new Date().toISOString(), sql ? checksum(sql) : 'js-migration')
}

// ─── File helpers ─────────────────────────────────────────────────────────────

export function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

// ─── Naming a new migration ───────────────────────────────────────────────────
//
// Filename order IS apply order — `listMigrationFiles` sorts, and nothing else
// records when a file was written. The clock is second-granular, so two
// migrations created inside one second break that in two ways, both silent:
//
//   same label  — the second `writeFileSync` overwrites the first, and the
//                 change that was in it is simply gone
//   different   — they sort by LABEL, so `evolve` applies before `initial` and
//                 a migration runs against a table its predecessor creates
//
// Neither is hypothetical: `migrate create` twice in a script, a test that
// seeds and then evolves, a multi-database create loop. The fix is to name a
// migration after every one already in the directory rather than after the
// clock alone — the timestamp still says roughly when, and now also says after
// what.

const STAMP = /^(\d{14})_/

function formatStamp(d) {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// A stamp a person wrote by hand may not be a real clock reading (`99999999999999`
// is a legal filename and sorts last on purpose). Add the second numerically
// when it cannot be read as a date, so an unparseable stamp still yields a name
// that sorts after it.
function bumpStamp(ts) {
  const y = +ts.slice(0, 4), mo = +ts.slice(4, 6), d = +ts.slice(6, 8)
  const h = +ts.slice(8, 10), mi = +ts.slice(10, 12), s = +ts.slice(12, 14)
  const date = new Date(y, mo - 1, d, h, mi, s + 1)
  if (!Number.isNaN(date.getTime()) && formatStamp(date) > ts) return formatStamp(date)
  return String(BigInt(ts) + 1n).padStart(14, '0')
}

function timestamp() {
  return formatStamp(new Date())
}

export function nextMigrationName(dir, label, ext = 'sql') {
  const abs   = resolve(dir)
  const slug  = slugify(label)
  const files = listMigrationFiles(abs)
  const last  = files.length ? files[files.length - 1].match(STAMP)?.[1] : null

  let ts = timestamp()
  if (last && ts <= last) ts = bumpStamp(last)
  // A directory can hold a file per label at one stamp; keep stepping until the
  // name is free rather than overwriting somebody's migration.
  while (existsSync(join(abs, `${ts}_${slug}.${ext}`))) ts = bumpStamp(ts)

  return `${ts}_${slug}.${ext}`
}

export function listMigrationFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => MIGRATION_FILE.test(f))
    .sort()
}

// A `.sql`/`.js` file in the directory that MIGRATION_FILE does not match. The
// ordering guarantee comes from the 14-digit timestamp, so the pattern cannot be
// loosened — but a file it rejects has to be named, because the alternative is
// `apply()` reading "none matched" as "there are none" and a fresh deploy
// starting against an empty database while reporting success.
export function unmatchedMigrationFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => MIGRATION_CANDIDATE.test(f) && !MIGRATION_FILE.test(f))
    .sort()
}

// One sentence, so apply/status/verify and the CLI all say the same thing about
// the same directory.
export function describeSkipped(skipped) {
  if (skipped.length === 0) return ''
  return `${skipped.length} file(s) skipped — a migration is named ` +
         `<14-digit timestamp>_<lower_snake_label>.sql|.js: ${skipped.join(', ')}`
}

// ─── SHADOW ───────────────────────────────────────────────────────────────────
//
// A fresh in-memory database with the migration HISTORY replayed into it, then
// introspected. It is what the files say the schema is, which is a different
// fact from what the live database holds and from what `schema.lite` declares —
// and until `FJS-D123` litestone could only compare the last two.
//
// One comparison was doing two jobs and doing neither: `create()` diffed the
// schema against the LIVE database, so a database developed with `db push`
// already matched and `migrate create` answered *already in sync — no migration
// needed*. The deploy then refused, correctly, and told the developer to run the
// command that had just declined to write anything. A closed loop with no way
// out from inside the tool (`FJS-388`).
//
// With the shadow there are two questions and two answers:
//
//   schema  <-> shadow  — what migration is missing        (create, the guard)
//   shadow  <-> live    — has somebody changed the db      (drift)
//
// Cheap: `create()` already opened a `:memory:` database to build a pristine
// one out of the schema, so this is the same move seeded from the files.
//
// **A `.js` migration is not replayed and makes the answer unknown.** It needs a
// Litestone client and may perform schema surgery through `sys.sql`, so
// skipping it would answer a confident diff over a shadow missing part of its
// history — the class of silent wrongness this ruling exists to remove. Callers
// are handed `unknown` with the files named, and say so.

export function buildShadow(dir = './migrations') {
  const files = listMigrationFiles(dir)
  const js    = files.filter(f => f.endsWith('.js'))
  if (js.length) return { ok: false, reason: 'js-migrations', files: js, schema: null }

  const db = new Database(':memory:')
  try {
    for (const file of files) {
      for (const stmt of migrationStatements(join(resolve(dir), file))) {
        try { db.run(stmt + ';') }
        catch (e) {
          return { ok: false, reason: 'replay-failed', file, error: e.message, schema: null }
        }
      }
    }
    return { ok: true, schema: introspect(db), files }
  } finally {
    db.close()
  }
}

// What the history does NOT build that the schema declares — the deploy's
// question, asked of the repo alone. No database, no container, no network, so
// `fli deploy:doctor`, `fli check` and CI can ask it before an image is built
// and `migrate apply` can ask it again at container start (`FJS-D123` section 6).
//
// `{ ok }` when the history builds the declared schema, `{ pending }` with a
// summary when it does not, `{ unknown }` when the shadow could not be built —
// reported rather than folded into either, since *I cannot tell* is not *it is
// fine*.

export function historyGap(parseResult, dir = './migrations', { pluralize = false, dbName = 'main' } = {}) {
  const shadow = buildShadow(dir)
  // `ok` is deliberately absent here: *I cannot tell* is a third answer, and a
  // caller reading `.ok` on it would fold it into one of the other two.
  if (!shadow.ok) return { unknown: true, reason: shadow.reason, file: shadow.file, error: shadow.error, files: shadow.files, message: shadowRefusal(shadow) }

  const pristineDb = new Database(':memory:')
  let pristine
  try {
    pristine = buildPristineForDatabase(pristineDb, parseResult, dbName)
  } finally {
    pristineDb.close()
  }

  const diff = diffSchemas(pristine, shadow.schema, parseResult, dbName, { pluralize })
  if (!diff.hasChanges) return { ok: true, files: shadow.files }
  return { ok: false, pending: true, diff, summary: summariseDiff(diff), files: shadow.files }
}

// ─── DRIFT + BASELINE ─────────────────────────────────────────────────────────
//
// The second of the shadow's two comparisons: shadow <-> live. *Has this
// database got what the files build?* Not the same question as *does the
// history build the schema* — one is about the database in front of you, the
// other about the repo — and conflating them is the defect `FJS-D123` closes.

export function driftAgainstLive(rawDb, parseResult, dir = './migrations', { pluralize = false, dbName = 'main' } = {}) {
  const shadow = buildShadow(dir)
  if (!shadow.ok) return { unknown: true, reason: shadow.reason, file: shadow.file, error: shadow.error, files: shadow.files, message: shadowRefusal(shadow) }

  const diff = diffSchemas(shadow.schema, introspect(rawDb), parseResult, dbName, { pluralize })
  return diff.hasChanges
    ? { ok: false, drifted: true, diff, summary: summariseDiff(diff), files: shadow.files }
    : { ok: true, files: shadow.files }
}

// Record migration files as applied WITHOUT running them.
//
// The way out for a database that is already correct and has no history to say
// so — every app developed through `db push`, and the developer's own database
// the moment `migrate create` writes the delta they had already pushed (an
// `ALTER TABLE ADD COLUMN` is not idempotent, so replaying it there fails with
// `duplicate column name`). Prisma calls this baselining and reaches it through
// `migrate resolve --applied`; the need is the same and so is the shape.
//
// **It refuses to record a lie.** Baselining says *this database already holds
// what these files build*, so that claim is CHECKED against the database first:
// anything the shadow builds and the live database lacks is named and nothing
// is written. Without that, one wrong baseline is a database that reports a
// complete history and is missing a column, which is the exact failure this
// ruling exists to make impossible.

export function baseline(rawDb, parseResult, dir = './migrations', { pluralize = false, dbName = 'main' } = {}) {
  const shadow = buildShadow(dir)
  if (!shadow.ok) return { ok: false, blocked: true, message: shadowRefusal(shadow) }
  if (!shadow.files.length) return { ok: false, message: 'there are no migration files to baseline' }

  const applied = new Set(appliedMigrations(rawDb).map(m => m.name))
  const pending = shadow.files.filter(f => !applied.has(f))
  if (!pending.length) return { ok: true, recorded: [], message: 'every migration is already recorded as applied' }

  // The claim being recorded, checked before it is recorded.
  const drift = driftAgainstLive(rawDb, parseResult, dir, { pluralize, dbName })
  if (drift.unknown) return { ok: false, blocked: true, message: drift.message }
  if (!drift.ok) return {
    ok: false, blocked: true, diff: drift.diff, summary: drift.summary,
    message: 'this database does not hold what those migrations build, so recording them as applied would record a lie',
  }

  const recorded = []
  for (const file of pending) {
    const sql = file.endsWith('.js') ? null : loadMigrationSql(join(resolve(dir), file)).sql
    recordMigration(rawDb, file, sql)
    recorded.push(file)
  }
  return { ok: true, recorded }
}

// ─── CREATE ───────────────────────────────────────────────────────────────────
// Diffs schema.lite (via pristine in-memory db) against live db.
// Writes a new timestamped migration file if there are changes.

export function create(db, parseResult, label = 'migration', dir = './migrations', { pluralize = false } = {}) {
  return createAgainstHistory(parseResult, 'main', label, dir, { pluralize })
}

// The body both create() and createForDatabase() run.
//
// It diffs the declared schema against the SHADOW — what the migration files
// build — and not against the live database (`FJS-D123`). The live database is
// where the developer has been working, so with `db push` it already matches
// the schema and the old comparison answered *nothing to write* precisely when
// a migration was most needed. The files are what a deploy replays, so the
// files are what the question has to be asked of.
//
// The live database is therefore not consulted here at all, which is what makes
// `migrate create` answerable with no database — and is why the same walk can
// run in `fli check` and before an image is built.
function createAgainstHistory(parseResult, dbName, label, dir, { pluralize = false } = {}) {
  const shadow = buildShadow(dir)
  if (!shadow.ok) return { created: false, blocked: true, message: shadowRefusal(shadow) }

  const pristineDb = new Database(':memory:')
  let pristineSchema
  try {
    pristineSchema = buildPristineForDatabase(pristineDb, parseResult, dbName)
  } finally {
    pristineDb.close()
  }

  const diffResult = diffSchemas(pristineSchema, shadow.schema, parseResult, dbName, { pluralize })

  if (!diffResult.hasChanges) return {
    created: false,
    message: shadow.files.length
      ? 'the migration history already builds the schema — no migration needed'
      : 'the schema declares nothing to build — no migration needed',
  }

  const sql     = generateMigrationSQL(diffResult, parseResult, { pluralize })
  const name    = nextMigrationName(dir, label)
  const summary = summariseDiff(diffResult)

  const header = [
    `-- Litestone migration${dbName === 'main' ? '' : ` (database: ${dbName})`}`,
    `-- Created:   ${new Date().toISOString()}`,
    `-- Changes:`,
    summary.split('\n').map(l => `--   ${l}`).join('\n'),
    ``, ``,
  ].join('\n')

  mkdirSync(resolve(dir), { recursive: true })
  const filePath = join(resolve(dir), name)
  writeFileSync(filePath, header + sql, 'utf8')

  return { created: true, name, filePath, summary, sql }
}

// One sentence for every caller that could not build a shadow, so create, the
// guard and the doctor say the same thing about the same directory.
export function shadowRefusal(shadow) {
  if (shadow.reason === 'js-migrations')
    return `the migration history contains JavaScript migrations (${shadow.files.join(', ')}), ` +
           `which run against a Litestone client and can change the schema through sys.sql. ` +
           `They cannot be replayed into a shadow database, so what the history builds is unknown ` +
           `and no migration can be derived from it. Write this one by hand`
  if (shadow.reason === 'replay-failed')
    return `the migration history does not replay — "${shadow.file}" failed: ${shadow.error}. ` +
           `A deploy applies these files in this order, so it would fail the same way`
  return 'the migration history could not be read'
}

// ─── CREATE FOR DATABASE ─────────────────────────────────────────────────────
// Like create() but scoped to a specific named database.
// Used by CLI multi-DB migrate create to write per-database migration files.

export function createForDatabase(rawDb, parseResult, dbName, label = 'migration', dir = './migrations', { pluralize = false } = {}) {
  return createAgainstHistory(parseResult, dbName, label, dir, { pluralize })
}

// ─── APPLY ────────────────────────────────────────────────────────────────────
// Applies all pending migration files in chronological order.

// Parsed-SQL cache keyed by file path + mtime. tenants.migrate() calls apply()
// once per tenant — without this, 500 tenants × 20 migration files means
// 10,000 redundant readFileSync + splitStatements passes over identical bytes.
const _sqlFileCache = new Map()
function loadMigrationSql(filePath) {
  const mtimeMs = statSync(filePath).mtimeMs
  const hit = _sqlFileCache.get(filePath)
  if (hit && hit.mtimeMs === mtimeMs) return hit
  const sql = readFileSync(filePath, 'utf8')
  const execSQL = sql
    .split('\n')
    .filter(l => !l.trimStart().startsWith('--'))
    .join('\n')
  const stmts = splitStatements(execSQL).filter(s => s.length > 0)
  const entry = { mtimeMs, sql, stmts }
  _sqlFileCache.set(filePath, entry)
  return entry
}

// ─── Statement execution ─────────────────────────────────────────────────────
// apply() and autoMigrate() own the transaction. Generated migration files
// still carry `BEGIN;`/`COMMIT;` and the foreign_keys pragma pair so they can
// be read and run by hand in a sqlite shell — the runner strips those and
// provides the real thing: one transaction per migration, ROLLBACK on
// failure, FK pragma managed around the transaction. Trusting the in-file
// pair meant a mid-file failure left the connection inside an open
// transaction with foreign_keys still OFF, and no ROLLBACK ever ran.

const TXN_CONTROL = /^(BEGIN|COMMIT|ROLLBACK|END)\b/i
const FK_PRAGMA   = /^PRAGMA\s+foreign_keys\b/i

function executableStatements(stmts) {
  return stmts.filter(s => {
    const t = s.trim()
    return t.length > 0 && !TXN_CONTROL.test(t) && !FK_PRAGMA.test(t)
  })
}

// Runs statements inside one owned transaction. `record` (optional) runs as
// the final step INSIDE the transaction, so the migration bookkeeping commits
// atomically with the schema change itself.
// The executable statements of one migration file, comments and the in-file
// transaction control already removed. Exported so anything that replays a
// migration outside apply() — the test template builder — strips it the same
// way rather than carrying a second copy of a rule whose whole point is that
// getting it wrong leaves a connection inside an open transaction.
export function migrationStatements(filePath) {
  return executableStatements(loadMigrationSql(filePath).stmts)
}

function runInTransaction(rawDb, stmts, record = null) {
  rawDb.run('PRAGMA foreign_keys = OFF')
  rawDb.run('BEGIN')
  try {
    for (const stmt of stmts) rawDb.run(stmt + ';')
    if (record) record()
    rawDb.run('COMMIT')
  } catch (e) {
    try { rawDb.run('ROLLBACK') } catch { /* no open txn — nothing to roll back */ }
    throw e
  } finally {
    try { rawDb.run('PRAGMA foreign_keys = ON') } catch { /* advisory */ }
  }
}

export async function apply(db, dir = './migrations', client = null) {
  const absDir  = resolve(dir)
  const files   = listMigrationFiles(absDir)
  const skipped = unmatchedMigrationFiles(absDir)

  if (files.length === 0) {
    // Files present but none matched is a REFUSAL, not an empty directory. The
    // two used to return the same "no migration files found" and the same exit
    // code, which is how a deploy applied nothing and reported ✓.
    if (skipped.length > 0) {
      return {
        applied: [], pending: 0, skipped, unmatched: true,
        message: `no migration files matched — ${describeSkipped(skipped)}`,
      }
    }
    return { applied: [], pending: 0, skipped, message: 'no migration files found' }
  }

  const appliedSet = new Set(appliedMigrations(db).map(m => m.name))
  const pending    = files.filter(f => !appliedSet.has(f))

  if (pending.length === 0) {
    return { applied: [], pending: 0, skipped, message: '✓ all migrations already applied' }
  }

  const results = []

  for (const file of pending) {
    const filePath = join(absDir, file)
    const t0       = performance.now()
    const isJs     = file.endsWith('.js')

    try {
      if (isJs) {
        // ── JS migration ─────────────────────────────────────────────────────
        // Dynamically import the migration module and call up(client)
        if (!client) throw new Error(
          `JS migration "${file}" requires a Litestone client. ` +
          `Pass the client as the third argument to apply(db, dir, client).`
        )
        const mod = await import(filePath)
        const up  = mod.up ?? mod.default
        if (typeof up !== 'function')
          throw new Error(`JS migration "${file}" must export an "up" function or a default function`)

        // A migration runs as the SYSTEM, always.
        //
        // It is schema surgery performed by an operator, outside any request
        // and usually before the rows it touches have an owner — so every
        // access declaration in the schema is beside the point here, and a
        // migration that could be filtered by a policy would be a migration
        // that silently half-applied.
        //
        // Stated explicitly because raw SQL now refuses on a schema that
        // declares access rules (FJS-005): `up(tx)` handed migrations the
        // unscoped client, whose `sql` is guarded, so the very first JS
        // migration on a gated schema failed with "use asSystem()" — advice
        // aimed at application code that a migration cannot act on. Caught by
        // running one, not by reading.
        //
        // The system proxy is passed rather than the transaction's `tx`
        // because $transaction hands the callback the unscoped clientProxy —
        // the same thing `authQuery` works around to keep auth alive through a
        // batch. The transaction is connection state, so it still wraps this.
        const sys = typeof client.asSystem === 'function' ? client.asSystem() : client

        // Run inside a transaction — rollback on failure
        await client.$transaction(async () => {
          await up(sys)
        })

        recordMigration(db, file, null)   // no SQL content for JS migrations
      } else {
        // ── SQL migration ────────────────────────────────────────────────────
        const { sql, stmts } = loadMigrationSql(filePath)
        runInTransaction(db, executableStatements(stmts), () => recordMigration(db, file, sql))
      }

      const elapsed = (performance.now() - t0).toFixed(0)
      results.push({ file, ok: true, elapsed })
    } catch (e) {
      results.push({ file, ok: false, error: e.message })
      return { applied: results, pending: pending.length, skipped, failed: file, error: e.message }
    }
  }

  // Auto-ANALYZE after successful migrations.
  // SQLite query planner uses sqlite_stat1/stat4 tables to choose indexes.
  // Without ANALYZE, the planner falls back to coarse heuristics that often
  // miss the optimal index for selective predicates. Running ANALYZE after a
  // batch of schema changes is cheap (milliseconds on a fresh table) and
  // gives subsequent queries the best plan immediately.
  // This is a SQLite-specific edge — Postgres does this automatically via
  // autovacuum, but SQLite has no equivalent.
  if (results.some(r => r.ok)) {
    // analysis_limit bounds the rows sampled per index — an unbounded ANALYZE
    // full-scans every index of every table, which on a multi-GB DB can add
    // minutes to the deploy path (and via tenants.migrate(), per tenant).
    // 400 is SQLite's own recommended value for this use.
    try { db.run('PRAGMA analysis_limit=400'); db.run('ANALYZE') } catch { /* analyze is advisory; never fail migrations on it */ }
  }

  return { applied: results, pending: pending.length, skipped }
}

// ─── STATUS ───────────────────────────────────────────────────────────────────
// Returns a row per migration file showing applied/pending/orphaned state.

export function status(db, dir = './migrations') {
  const absDir     = resolve(dir)
  const files      = listMigrationFiles(absDir)
  const applied    = appliedMigrations(db)
  const appliedMap = new Map(applied.map(m => [m.name, m]))

  const rows = []

  for (const file of files) {
    const isJs   = file.endsWith('.js')
    const sql    = isJs ? null : readFileSync(join(absDir, file), 'utf8')
    const record = appliedMap.get(file)
    if (record) {
      const tampered = !isJs && checksum(sql) !== record.checksum
      rows.push({ file, state: tampered ? 'modified' : 'applied', applied_at: record.applied_at, tampered, sql })
    } else {
      rows.push({ file, state: 'pending', applied_at: null, tampered: false, sql })
    }
  }

  // Applied but file no longer exists → orphaned (sql unavailable)
  for (const record of applied) {
    if (!files.includes(record.name)) {
      rows.push({ file: record.name, state: 'orphaned', applied_at: record.applied_at, tampered: false, sql: null })
    }
  }

  // A .sql/.js the name pattern rejected. status(), apply() and verify() read
  // one list, so a file invisible to one is invisible to none of the others.
  for (const file of unmatchedMigrationFiles(absDir)) {
    rows.push({ file, state: 'skipped', applied_at: null, tampered: false, sql: null })
  }

  return rows
}

// ─── VERIFY ───────────────────────────────────────────────────────────────────
// Diffs live db against pristine schema.
// Returns: { state: 'in-sync' | 'pending' | 'drift', ... }

export function verify(db, parseResult, dir = './migrations', { pluralize = false } = {}) {
  const pristineDb     = new Database(':memory:')
  const pristineSchema = buildPristine(pristineDb, parseResult)
  pristineDb.close()

  const liveSchema = introspect(db)
  const diffResult = diffSchemas(pristineSchema, liveSchema, parseResult, 'main', { pluralize })

  if (!diffResult.hasChanges) return { state: 'in-sync', message: '✓ schema is in sync' }

  // Check if there are pending migrations that would explain the diff
  const rows    = status(db, dir)
  const pending = rows.filter(r => r.state === 'pending')

  if (pending.length > 0) {
    return {
      state:   'pending',
      message: `${pending.length} migration${pending.length > 1 ? 's' : ''} not yet applied`,
      pending: pending.map(r => r.file),
      diff:    summariseDiff(diffResult),
    }
  }

  // A migration the name pattern rejected is the likeliest explanation for a
  // drift nothing else accounts for, so it is named here rather than left for
  // whoever thinks to run `migrate status`.
  const skipped = rows.filter(r => r.state === 'skipped').map(r => r.file)

  return {
    state:   'drift',
    message: '⚠  live db has drifted from schema.lite',
    diff:    summariseDiff(diffResult),
    ...(skipped.length ? { skipped, note: describeSkipped(skipped) } : {}),
  }
}

// ─── AUTO-MIGRATE ─────────────────────────────────────────────────────────────
// Applies schema changes directly to the live DB without writing migration files.
// Intended for development, tests, and single-file servers where you just want
// the tables to exist and match the schema.
//
// Safe to call on every startup — no-ops if the DB is already in sync.
//
//   import { createClient, autoMigrate } from '@frontierjs/litestone'
//   const db = await createClient('./app.db', './schema.lite')
//   await autoMigrate(db)
//
// For production use the file-based migration system (create / apply / status).

const AUTO_META_TABLE = '_litestone_meta'
const AUTO_HASH_KEY   = 'autoMigrate.ddlHash'

function readAutoHash(rawDb) {
  try {
    return rawDb.query(`SELECT value FROM "${AUTO_META_TABLE}" WHERE key = ?`).get(AUTO_HASH_KEY)?.value ?? null
  } catch { return null }   // meta table doesn't exist yet
}

function writeAutoHash(rawDb, hash) {
  try {
    rawDb.run(`CREATE TABLE IF NOT EXISTS "${AUTO_META_TABLE}" (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    rawDb.run(
      `INSERT INTO "${AUTO_META_TABLE}" (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      AUTO_HASH_KEY, hash
    )
  } catch { /* advisory — a read-only DB just skips the fast path next time */ }
}

export function autoMigrate(db, parseResultOrSchema, { pluralize = false, force = false } = {}) {
  // Accept either a parseResult or pull it from db.$schema
  const parseResult = parseResultOrSchema ?? { schema: db.$schema, valid: true, errors: [] }

  // Multi-db: iterate every database in the registry.
  // Single-db (no database blocks in schema): only 'main' is present — backward compat.
  const rawDbs = db.$rawDbs ?? { main: db.$db }

  const results = {}

  for (const [dbName, rawDb] of Object.entries(rawDbs)) {
    // Skip non-sqlite databases (jsonl) and disabled databases (access: false)
    if (!rawDb) {
      results[dbName] = { state: 'skipped', reason: rawDb === null ? 'jsonl or disabled' : 'no raw handle' }
      continue
    }

    // Fast path: hash the generated DDL and compare to the hash recorded after
    // the last successful sync. On match, skip the pristine :memory: build and
    // the double introspection entirely — this is what makes "call on every
    // startup" actually free. Pass { force: true } to run the full diff anyway
    // (e.g. after out-of-band DDL changes to the live DB).
    const ddlHash = checksum(generateDDLForDatabase(parseResult.schema, dbName, { foreignKeys: true, pluralize }) + `|pluralize=${pluralize}`)
    if (!force && readAutoHash(rawDb) === ddlHash) {
      results[dbName] = { state: 'in-sync', applied: 0 }
      continue
    }

    const pristineDb = new Database(':memory:')
    pristineDb.run('PRAGMA foreign_keys = ON')

    try {
      const liveSchema     = introspect(rawDb)
      const pristineSchema = buildPristineForDatabase(pristineDb, parseResult, dbName)
      const diffResult     = diffSchemas(pristineSchema, liveSchema, parseResult, dbName, { pluralize })

      // Join tables (and @edge/@scoped side tables) are invisible to
      // introspection — ensure they exist even when the model diff is in sync
      // (e.g. an m2m or an @edge added to an existing DB).
      try {
        const dbModels = parseResult.schema.models.filter(m =>
          (m.attributes?.find(a => a.kind === 'db')?.name ?? 'main') === dbName)
        const scoped = { ...parseResult.schema, models: dbModels }
        const m2mPairs = detectM2MPairs(scoped, pluralize)
        // planEdgeStorage attaches @edge columns to their pairs and collects
        // create-own side-table groups.
        const { ownGroups } = planEdgeStorage(scoped, m2mPairs, pluralize)
        for (const pair of m2mPairs) {
          for (const stmt of splitStatements(generateJoinTableDDL(pair, true)))
            if (stmt.trim()) rawDb.run(stmt)
          // Add any @edge columns missing from an already-existing join table —
          // CREATE IF NOT EXISTS is a no-op once the join exists.
          if (pair.edgeColumns?.length) {
            const have = new Set(rawDb.query(`PRAGMA table_info("${pair.joinTable}")`).all().map(c => c.name))
            for (const colDef of pair.edgeColumns) {
              const name = colDef.match(/"([^"]+)"/)?.[1]
              if (name && !have.has(name)) rawDb.run(`ALTER TABLE "${pair.joinTable}" ADD COLUMN ${colDef.trim()}`)
            }
          }
        }
        for (const g of ownGroups) {
          for (const stmt of splitStatements(generateEdgeSideTableDDL(g, true)))
            if (stmt.trim()) rawDb.run(stmt)
        }
      } catch { /* advisory — migration files remain the source of truth */ }

      if (!diffResult.hasChanges) {
        writeAutoHash(rawDb, ddlHash)
        results[dbName] = { state: 'in-sync', applied: 0 }
        continue
      }

      // Same rule as file migrations: a rebuild that adds a NOT NULL column
      // with no DEFAULT has no value for existing rows. Refuse loudly instead
      // of applying commented-out SQL and marking the db in-sync — the hash is
      // NOT written, so this surfaces on every startup until the schema is fixed.
      const blockedCols = diffResult.tableDiffs.flatMap(d =>
        d.needsRebuild
          ? (d.cols?.added ?? []).filter(c => c.notnull && c.default == null).map(c => `${d.name}.${c.name}`)
          : [])
      if (blockedCols.length) {
        results[dbName] = {
          state:  'blocked',
          reason: `rebuild adds NOT NULL column(s) with no DEFAULT: ${blockedCols.join(', ')} — ` +
                  `add a @default() or make the field optional (?)`,
        }
        continue
      }

      // The other half of the same rule (FJS-183). A rebuild drops the table,
      // taking any trigger or index the APP created — litestone did not write
      // them and cannot restate them, so applying the rebuild here would delete
      // behaviour with nothing recording that it had. The generated file blocks
      // for this too; the hash is not written, so it surfaces on every startup
      // until the schema or the database says what should happen.
      const blockedObjects = diffResult.tableDiffs.flatMap(d => d.needsRebuild
        ? [...(d.foreignTriggers ?? []).map(n => `trigger ${n}`),
           ...(d.indexes?.foreign ?? []).map(i => `index ${i.name}`)]
        : [])
      if (blockedObjects.length) {
        results[dbName] = {
          state:  'blocked',
          reason: `a rebuild would destroy ${blockedObjects.join(', ')} — litestone did not create ` +
                  `these and cannot restate them. Move each into the schema, drop it by hand, or ` +
                  `write the migration as a file and recreate it there`,
        }
        continue
      }

      const sql   = generateMigrationSQL(diffResult, parseResult, { pluralize })
      const stmts = executableStatements(splitStatements(sql))

      runInTransaction(rawDb, stmts)

      writeAutoHash(rawDb, ddlHash)
      results[dbName] = { state: 'migrated', applied: stmts.length, sql }
      // Auto-ANALYZE (bounded) — see migrations.apply() for rationale.
      try { rawDb.run('PRAGMA analysis_limit=400'); rawDb.run('ANALYZE') } catch { /* advisory */ }
    } finally {
      pristineDb.close()
    }
  }

  return results
}
