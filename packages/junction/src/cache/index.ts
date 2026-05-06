// cache/index.ts
// TTL-based in-memory cache with optional SQLite persistence.
// Same interface regardless of backend — swap without changing app code.
// Garbage collection runs on a fixed interval, not per get() call.

import { Database } from 'bun:sqlite'
import { parseTtl } from '../config/index.ts'

// ─── ICache interface ─────────────────────────────────────────────────────

export interface ICache {
  get<T = unknown>(key: string):                              T | undefined
  set<T = unknown>(key: string, value: T, ttl?: string):     void
  has(key: string):                                           boolean
  remove(key: string):                                        void
  clear(pattern?: string | RegExp):                          number   // returns count removed
  size():                                                     number
  stats():                                                    CacheStats
  destroy():                                                  void
}

export interface CacheStats {
  hits:    number
  misses:  number
  sets:    number
  evicts:  number
  size:    number
}

// ─── Memory cache entry ───────────────────────────────────────────────────

interface CacheEntry<T = unknown> {
  value:   T
  expires: number    // Date.now() + ttl ms — using int for fast comparison
}

// ─── In-memory implementation ─────────────────────────────────────────────

export interface MemoryCacheOptions {
  defaultTtl?:    string    // e.g. '5 minutes'
  maxSize?:       number    // evict oldest on overflow
  gcInterval?:   number    // ms between GC sweeps, default 60s
}

export function createMemoryCache(opts: MemoryCacheOptions = {}): ICache {

  const defaultTtlMs = parseTtl(opts.defaultTtl ?? '5 minutes')
  const maxSize      = opts.maxSize    ?? 10_000
  const gcInterval   = opts.gcInterval ?? 60_000

  // Plain object map — faster than Map for string keys in hot loops
  const store  = new Map<string, CacheEntry>()
  const stats: CacheStats = { hits: 0, misses: 0, sets: 0, evicts: 0, size: 0 }

  // GC timer — sweeps expired entries
  const gcTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (entry.expires <= now) {
        store.delete(key)
        stats.evicts++
        stats.size--
      }
    }
  }, gcInterval)

  // Don't block process exit
  if (gcTimer.unref) gcTimer.unref()

  return {

    get<T>(key: string): T | undefined {
      const entry = store.get(key)
      if (!entry) {
        stats.misses++
        return undefined
      }
      // Lazy expiry check
      if (entry.expires <= Date.now()) {
        store.delete(key)
        stats.misses++
        stats.evicts++
        stats.size--
        return undefined
      }
      stats.hits++
      return entry.value as T
    },

    set<T>(key: string, value: T, ttl?: string): void {
      const ttlMs   = ttl ? parseTtl(ttl) : defaultTtlMs
      const expires = Date.now() + ttlMs

      const existed = store.has(key)
      store.set(key, { value, expires })
      stats.sets++

      if (!existed) {
        stats.size++
        // Evict oldest entry if over max size
        if (store.size > maxSize) {
          const oldest = store.keys().next().value
          if (oldest !== undefined) {
            store.delete(oldest)
            stats.evicts++
            stats.size--
          }
        }
      }
    },

    has(key: string): boolean {
      const entry = store.get(key)
      if (!entry) return false
      if (entry.expires <= Date.now()) {
        store.delete(key)
        stats.evicts++
        stats.size--
        return false
      }
      return true
    },

    remove(key: string): void {
      if (store.delete(key)) stats.size--
    },

    clear(pattern?: string | RegExp): number {
      if (!pattern) {
        const count = store.size
        store.clear()
        stats.size = 0
        return count
      }

      let count = 0
      const isRegex = pattern instanceof RegExp
      for (const key of store.keys()) {
        const match = isRegex
          ? pattern.test(key)
          : key.includes(pattern as string)
        if (match) {
          store.delete(key)
          count++
          stats.size--
        }
      }
      return count
    },

    size(): number {
      return store.size
    },

    stats(): CacheStats {
      return { ...stats }
    },

    destroy(): void {
      clearInterval(gcTimer)
      store.clear()
    }
  }
}

// ─── SQLite-backed persistent cache ──────────────────────────────────────
// Same interface, survives restarts.
// Uses Bun's native SQLite — zero deps.

export interface SqliteCacheOptions {
  path?:        string    // default ':memory:'
  defaultTtl?:  string
  gcInterval?:  number
}

export function createSqliteCache(opts: SqliteCacheOptions = {}): ICache {

  const db = new Database(opts.path ?? ':memory:')
  const defaultTtlMs = parseTtl(opts.defaultTtl ?? '5 minutes')
  const stats: CacheStats = { hits: 0, misses: 0, sets: 0, evicts: 0, size: 0 }

  // Schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      key     TEXT    PRIMARY KEY,
      value   TEXT    NOT NULL,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cache_expires ON cache(expires);
  `)

  // Prepared statements — compiled once
  const stmtGet    = db.prepare<{ value: string; expires: number }, [string, number]>(
    'SELECT value, expires FROM cache WHERE key = ? AND expires > ?'
  )
  const stmtSet    = db.prepare<void, [string, string, number]>(
    'INSERT OR REPLACE INTO cache (key, value, expires) VALUES (?, ?, ?)'
  )
  const stmtDel    = db.prepare<void, [string]>('DELETE FROM cache WHERE key = ?')
  const stmtExists = db.prepare<{ 1: number }, [string, number]>(
    'SELECT 1 FROM cache WHERE key = ? AND expires > ? LIMIT 1'
  )
  const stmtSize   = db.prepare<{ count: number }, []>('SELECT COUNT(*) as count FROM cache')
  const stmtGC     = db.prepare<void, [number]>('DELETE FROM cache WHERE expires <= ?')
  const stmtClear  = db.prepare<void, []>('DELETE FROM cache')

  const gcTimer = setInterval(() => {
    const result = stmtGC.run(Date.now())
    stats.evicts += (result as unknown as { changes: number }).changes ?? 0
  }, opts.gcInterval ?? 60_000)

  if (gcTimer.unref) gcTimer.unref()

  return {

    get<T>(key: string): T | undefined {
      const row = stmtGet.get(key, Date.now())
      if (!row) { stats.misses++; return undefined }
      stats.hits++
      try { return JSON.parse(row.value) as T } catch { return row.value as unknown as T }
    },

    set<T>(key: string, value: T, ttl?: string): void {
      const ttlMs   = ttl ? parseTtl(ttl) : defaultTtlMs
      const expires = Date.now() + ttlMs
      stmtSet.run(key, JSON.stringify(value), expires)
      stats.sets++
    },

    has(key: string): boolean {
      return !!stmtExists.get(key, Date.now())
    },

    remove(key: string): void {
      stmtDel.run(key)
    },

    clear(pattern?: string | RegExp): number {
      if (!pattern) {
        stmtClear.run()
        return 0
      }
      // String prefix pattern — use SQL LIKE to avoid loading all keys
      if (typeof pattern === 'string') {
        const result = db.run(
          'DELETE FROM cache WHERE key LIKE ?',
          [pattern.replace(/%/g, '\\%').replace(/_/g, '\\_') + '%']
        )
        return (result as unknown as { changes: number }).changes ?? 0
      }
      // RegExp — no SQL equivalent, must filter client-side.
      // Kept as a separate slow path so the fast string path stays fast.
      const rows = db.query<{ key: string }, []>('SELECT key FROM cache').all()
      let count = 0
      for (const row of rows) {
        if (pattern.test(row.key)) { stmtDel.run(row.key); count++ }
      }
      return count
    },

    size(): number {
      return stmtSize.get()?.count ?? 0
    },

    stats(): CacheStats {
      return { ...stats, size: this.size() }
    },

    destroy(): void {
      clearInterval(gcTimer)
      db.close()
    }
  }
}
