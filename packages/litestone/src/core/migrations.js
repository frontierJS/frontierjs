// migrations.js — migration file management + apply/status/verify
//
// Commands:
//   create(db, parseResult, label, dir)  → generate + write migrations/TIMESTAMP_label.sql
//   apply(db, dir)                       → apply all pending migration files in order
//   status(db, dir)                      → show applied + pending migrations
//   verify(db, parseResult, dir)         → check live db against pristine schema

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs'
import { resolve, join } from 'path'
import { Database } from 'bun:sqlite'
import {
  introspect, buildPristine, buildPristineForDatabase, diffSchemas,
  generateMigrationSQL, summariseDiff, checksum, splitStatements,
} from './migrate.js'

// ─── Constants ────────────────────────────────────────────────────────────────

const MIGRATIONS_TABLE = `_litestone_migrations`
const MIGRATION_FILE   = /^(\d{14})_([a-z0-9_]+)\.(sql|js)$/

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

function timestamp() {
  const d   = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export function slugify(label) {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

export function listMigrationFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => MIGRATION_FILE.test(f))
    .sort()
}

// ─── CREATE ───────────────────────────────────────────────────────────────────
// Diffs schema.lite (via pristine in-memory db) against live db.
// Writes a new timestamped migration file if there are changes.

export function create(db, parseResult, label = 'migration', dir = './migrations', { pluralize = false } = {}) {
  const pristineDb     = new Database(':memory:')
  const pristineSchema = buildPristine(pristineDb, parseResult)
  pristineDb.close()

  const liveSchema = introspect(db)
  const diffResult = diffSchemas(pristineSchema, liveSchema, parseResult, 'main', { pluralize })

  if (!diffResult.hasChanges) return { created: false, message: 'schema is already in sync — no migration needed' }

  const sql      = generateMigrationSQL(diffResult, parseResult, { pluralize })
  const name     = `${timestamp()}_${slugify(label)}.sql`
  const summary  = summariseDiff(diffResult)

  const header = [
    `-- Litestone migration`,
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

// ─── CREATE FOR DATABASE ─────────────────────────────────────────────────────
// Like create() but scoped to a specific named database.
// Used by CLI multi-DB migrate create to write per-database migration files.

export function createForDatabase(rawDb, parseResult, dbName, label = 'migration', dir = './migrations', { pluralize = false } = {}) {
  const pristineDb     = new Database(':memory:')
  const pristineSchema = buildPristineForDatabase(pristineDb, parseResult, dbName)
  pristineDb.close()

  const liveSchema = introspect(rawDb)
  const diffResult = diffSchemas(pristineSchema, liveSchema, parseResult, dbName, { pluralize })

  if (!diffResult.hasChanges) return { created: false, message: `${dbName}: schema is already in sync` }

  const sql      = generateMigrationSQL(diffResult, parseResult, { pluralize })
  const name     = `${timestamp()}_${slugify(label)}.sql`
  const summary  = summariseDiff(diffResult)

  const header = [
    `-- Litestone migration (database: ${dbName})`,
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

// ─── APPLY ────────────────────────────────────────────────────────────────────
// Applies all pending migration files in chronological order.

export async function apply(db, dir = './migrations', client = null) {
  const absDir  = resolve(dir)
  const files   = listMigrationFiles(absDir)

  if (files.length === 0) {
    return { applied: [], pending: 0, message: 'no migration files found' }
  }

  const appliedSet = new Set(appliedMigrations(db).map(m => m.name))
  const pending    = files.filter(f => !appliedSet.has(f))

  if (pending.length === 0) {
    return { applied: [], pending: 0, message: '✓ all migrations already applied' }
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

        // Run inside a transaction — rollback on failure
        await client.$transaction(async (tx) => {
          await up(tx)
        })

        recordMigration(db, file, null)   // no SQL content for JS migrations
      } else {
        // ── SQL migration ────────────────────────────────────────────────────
        const sql    = readFileSync(filePath, 'utf8')
        const execSQL = sql
          .split('\n')
          .filter(l => !l.trimStart().startsWith('--'))
          .join('\n')
        const stmts = splitStatements(execSQL).filter(s => s.length > 0)
        for (const stmt of stmts) {
          db.run(stmt + ';')
        }
        recordMigration(db, file, sql)
      }

      const elapsed = (performance.now() - t0).toFixed(0)
      results.push({ file, ok: true, elapsed })
    } catch (e) {
      results.push({ file, ok: false, error: e.message })
      return { applied: results, pending: pending.length, failed: file, error: e.message }
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
    try { db.run('ANALYZE') } catch { /* analyze is advisory; never fail migrations on it */ }
  }

  return { applied: results, pending: pending.length }
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

  return {
    state:   'drift',
    message: '⚠  live db has drifted from schema.lite',
    diff:    summariseDiff(diffResult),
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

export function autoMigrate(db, parseResultOrSchema, { pluralize = false } = {}) {
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

    const pristineDb = new Database(':memory:')
    pristineDb.run('PRAGMA foreign_keys = ON')

    try {
      const liveSchema     = introspect(rawDb)
      const pristineSchema = buildPristineForDatabase(pristineDb, parseResult, dbName)
      const diffResult     = diffSchemas(pristineSchema, liveSchema, parseResult, dbName, { pluralize })

      if (!diffResult.hasChanges) {
        results[dbName] = { state: 'in-sync', applied: 0 }
        continue
      }

      const sql   = generateMigrationSQL(diffResult, parseResult, { pluralize })
      const stmts = splitStatements(sql).filter(s => s.trim().length > 0)

      for (const stmt of stmts) {
        rawDb.run(stmt + ';')
      }

      results[dbName] = { state: 'migrated', applied: stmts.length, sql }
      // Auto-ANALYZE — see migrations.apply() for rationale.
      try { rawDb.run('ANALYZE') } catch { /* advisory */ }
    } finally {
      pristineDb.close()
    }
  }

  return results
}
