import { readFileSync, readdirSync } from "fs"
import { join, dirname }             from "path"
import { fileURLToPath }             from "url"

// ─────────────────────────────────────────────
// IDATABASE
// Thin synchronous interface over SQLite.
//
// Two implementations:
//   SqlJsAdapter     — sql.js (WASM), used in Vitest / Node
//   BunSqliteAdapter — bun:sqlite, used in production
//
// Surface API:
//   db.exec(sql)                → DDL, no return value
//   db.run(sql, params?)        → INSERT / UPDATE / DELETE
//   db.get<T>(sql, params?)     → SELECT one row → T | undefined
//   db.all<T>(sql, params?)     → SELECT all rows → T[]
//   db.close()                  → release resources
// ─────────────────────────────────────────────

export interface IDatabase {
  exec(sql: string): void
  run(sql: string, params?: SQLParam[]): { lastInsertRowid: number | bigint }
  get<T = Record<string, unknown>>(sql: string, params?: SQLParam[]): T | undefined
  all<T = Record<string, unknown>>(sql: string, params?: SQLParam[]): T[]
  close(): void
}

export type SQLParam = string | number | bigint | boolean | null | Uint8Array

// ─────────────────────────────────────────────
// SQL.JS ADAPTER
// Used in Vitest (Node environment).
// sql.js WASM must be initialized asynchronously — use the factory:
//   const db = await createSqlJsDatabase()
// After that, all operations are synchronous.
// ─────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyDb = any

export async function createSqlJsDatabase(file?: Uint8Array): Promise<IDatabase> {
  const mod    = await import("sql.js/dist/sql-asm.js")
  const SQL    = await mod.default()
  const inner: AnyDb = file ? new SQL.Database(file) : new SQL.Database()
  return new SqlJsAdapter(inner)
}

class SqlJsAdapter implements IDatabase {
  constructor(private readonly db: AnyDb) {}

  exec(sql: string): void {
    this.db.run(sql)
  }

  run(sql: string, params: SQLParam[] = []): { lastInsertRowid: number | bigint } {
    this.db.run(sql, params)
    const res = this.db.exec("SELECT last_insert_rowid()")
    const rowid = (res[0]?.values[0]?.[0] ?? 0) as number
    return { lastInsertRowid: rowid }
  }

  get<T = Record<string, unknown>>(sql: string, params: SQLParam[] = []): T | undefined {
    const stmt: AnyDb = this.db.prepare(sql)
    try {
      stmt.bind(params)
      return stmt.step() ? (stmt.getAsObject() as T) : undefined
    } finally {
      stmt.free()
    }
  }

  all<T = Record<string, unknown>>(sql: string, params: SQLParam[] = []): T[] {
    const stmt: AnyDb = this.db.prepare(sql)
    const rows: T[] = []
    try {
      stmt.bind(params)
      while (stmt.step()) rows.push(stmt.getAsObject() as T)
    } finally {
      stmt.free()
    }
    return rows
  }

  close(): void { this.db.close() }
}

// ─────────────────────────────────────────────
// BUN SQLITE ADAPTER
// Production only — import resolves only in Bun runtime.
// Vitest never instantiates this class.
// ─────────────────────────────────────────────

export class BunSqliteAdapter implements IDatabase {
  private readonly db: AnyDb

  constructor(path: string) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite")
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA foreign_keys = ON")
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  run(sql: string, params: SQLParam[] = []): { lastInsertRowid: number | bigint } {
    const info = this.db.prepare(sql).run(...params)
    return { lastInsertRowid: info.lastInsertRowid }
  }

  get<T = Record<string, unknown>>(sql: string, params: SQLParam[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined
  }

  all<T = Record<string, unknown>>(sql: string, params: SQLParam[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[]
  }

  close(): void { this.db.close() }
}

// ─────────────────────────────────────────────
// MIGRATION RUNNER
// Reads numbered .sql files from migrations/ and applies them in order.
// Safe to call on every boot — skips already-applied versions.
// ─────────────────────────────────────────────

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations")

export function runMigrations(db: IDatabase): void {
  // Bootstrap tracker table before reading it
  db.exec(`
    CREATE TABLE IF NOT EXISTS schemaMigrations (
      version    INTEGER NOT NULL PRIMARY KEY,
      appliedAt INTEGER NOT NULL
    )
  `)

  const applied = new Set(
    db.all<{ version: number }>("SELECT version FROM schemaMigrations")
      .map(r => r.version)
  )

  let files: string[]
  try {
    files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith(".sql")).sort()
  } catch {
    return  // no migrations dir (e.g. running from dist without sources)
  }

  for (const file of files) {
    const version = parseInt(file.split("_")[0]!, 10)
    if (applied.has(version)) continue

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    db.exec(sql)

    db.run(
      "INSERT OR IGNORE INTO schemaMigrations (version, appliedAt) VALUES (?, ?)",
      [version, Date.now()],
    )

    console.log(`[db] applied migration ${file}`)
  }
}
