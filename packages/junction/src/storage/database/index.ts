// database/index.ts
import { Database } from 'bun:sqlite'
// First-class SQLite support for Junction apps.
//
// createDatabase() opens a bun:sqlite database with production-safe
// settings (WAL, foreign keys, busy timeout) and returns it alongside
// a runMigrations() runner that applies numbered SQL files in order.
//
// Usage in createApp():
//   const app = createApp({ config, auth })
//   // app.db is ready — no manual wiring needed
//
// Usage standalone:
//   const { db, migrate } = createDatabase('./app.db')
//   await migrate('./migrations')

import { join, basename } from 'node:path'

// ─── Types ────────────────────────────────────────────────────────────────

export interface DatabaseClient {
  // The raw bun:sqlite Database — full API available
  db:      import('bun:sqlite').Database

  // Run numbered SQL migration files from a directory
  migrate: (migrationsDir: string) => Promise<MigrationResult>

  // Close the connection
  close:   () => void
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

// ─── Default pragmas ──────────────────────────────────────────────────────
// These are the settings every SQLite app in production needs.
// WAL mode is particularly important — it allows concurrent reads
// without blocking writes, critical when many Outposts heartbeat simultaneously.

const PRODUCTION_PRAGMAS = [
  'PRAGMA journal_mode = WAL',     // concurrent reads + no write blocking
  'PRAGMA synchronous  = NORMAL',  // safe with WAL, much faster than FULL
  'PRAGMA foreign_keys = ON',      // enforce referential integrity
  'PRAGMA busy_timeout = 5000',    // wait 5s for another PROCESS's write lock rather than
                                   // failing; `pragmas: ['PRAGMA busy_timeout = N']` overrides it,
                                   // since these run first (`FJS-569`)
  'PRAGMA cache_size   = -32000',  // 32 MB page cache (negative = KB)
  'PRAGMA temp_store   = MEMORY',  // temp tables in RAM
]

// ─── createDatabase ───────────────────────────────────────────────────────

export interface DatabaseOptions {
  // SQLite path — use ':memory:' for tests
  // Supports bun:sqlite path format: 'file:./app.db' or './app.db'
  path?:    string

  // Additional pragmas to run after the defaults
  pragmas?: string[]

  // Called on every SQL statement when debug=true
  // Useful for query logging
  log?:     boolean

  // Skip applying production pragmas (useful for testing specific behaviours)
  bare?:    boolean
}

export function createDatabase(pathOrOpts?: string | DatabaseOptions): DatabaseClient {

  const opts = typeof pathOrOpts === 'string'
    ? { path: pathOrOpts }
    : (pathOrOpts ?? {})

  const rawPath = opts.path ?? './app.db'
  // Normalise: bun:sqlite accepts both 'file:./app.db' and './app.db'
  const dbPath  = rawPath.replace(/^file:/, '')

  const db = new Database(dbPath, { create: true })

  if (!opts.bare) {
    for (const pragma of PRODUCTION_PRAGMAS) {
      db.run(pragma)
    }
  }

  for (const pragma of (opts.pragmas ?? [])) {
    db.run(pragma)
  }

  // ── Migration runner ──────────────────────────────────────────────

  async function migrate(dir: string): Promise<MigrationResult> {

    // Ensure migrations tracking table exists
    db.run(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT    NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      )
    `)

    // Which migrations have already run?
    const applied = new Set(
      (db.query('SELECT name FROM _migrations').all() as { name: string }[])
        .map(r => r.name)
    )

    // Discover SQL files — Bun.Glob is faster than readdir+filter
    // and handles the missing-directory case cleanly via exists() check.
    let files: string[] = []
    try {
      const glob = new Bun.Glob('*.{sql,ts}')
      for await (const f of glob.scan({ cwd: dir, absolute: false })) {
        files.push(f)
      }
      files.sort()  // 001_..., 002_... order
    } catch {
      return { applied: [], skipped: [] }
    }

    const result: MigrationResult = { applied: [], skipped: [] }

    for (const file of files) {
      const name = basename(file)

      if (applied.has(name)) {
        result.skipped.push(name)
        continue
      }

      const fullPath = join(dir, file)
      let sql: string

      if (file.endsWith('.ts')) {
        // TypeScript migration — import and call its default export
        const mod = await import(fullPath)
        if (typeof mod.default === 'function') {
          const tx = db.transaction(() => {
            mod.default(db)
            db.run('INSERT INTO _migrations (name) VALUES (?)', [name])
          })
          try {
            tx()
            result.applied.push(name)
          } catch (err) {
            throw new Error(`Migration "${name}" failed: ${(err as Error).message}`)
          }
          continue
        }
        sql = typeof mod.default === 'string' ? mod.default : mod.sql ?? ''
      } else {
        sql = await Bun.file(fullPath).text()
      }

      // Wrap in a transaction — all or nothing
      const tx = db.transaction(() => {
        db.run(sql)
        db.run('INSERT INTO _migrations (name) VALUES (?)', [name])
      })

      try {
        tx()
        result.applied.push(name)
        if (opts.log) console.log(`[db] migration applied: ${name}`)
      } catch (err) {
        throw new Error(`Migration "${name}" failed: ${(err as Error).message}`)
      }
    }

    if (opts.log && result.applied.length === 0) {
      console.log('[db] no new migrations')
    }

    return result
  }

  return {
    db,
    migrate,
    close: () => db.close(),
  }
}

// ─── createInMemoryDatabase ───────────────────────────────────────────────
// Convenience for tests — same interface, always :memory:.

export function createInMemoryDatabase(opts?: Omit<DatabaseOptions, 'path'>): DatabaseClient {
  return createDatabase({ ...opts, path: ':memory:' })
}
