import type { IDatabase } from "./db"

export interface KVEntry {
  value:     unknown
  expiresAt: number | null
}

interface CacheEntry {
  value:     unknown
  expiresAt: number | null
  loadedAt:  number
}

export class KVStore {
  private readonly cache  = new Map<string, Map<string, CacheEntry>>()
  private readonly loaded = new Set<string>()

  constructor(private readonly db: IDatabase) {}

  get(workspaceId: string, scope: string, key: string): unknown | undefined {
    if (scope === "workspace") {
      this.ensureLoaded(workspaceId)
      const entry = this.cache.get(workspaceId)?.get(key)
      if (!entry) return undefined
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        this.cache.get(workspaceId)?.delete(key)
        this.db.run("DELETE FROM kvStore WHERE workspaceId = ? AND scope = ? AND key = ?",
          [workspaceId, scope, key])
        return undefined
      }
      return entry.value
    }

    const rows = this.db.all<{ value: string; expiresAt: number | null }>(
      "SELECT value, expiresAt FROM kvStore WHERE workspaceId = ? AND scope = ? AND key = ?",
      [workspaceId, scope, key],
    )
    const row = rows[0]
    if (!row) return undefined
    if (row.expiresAt !== null && Date.now() > row.expiresAt) {
      this.db.run("DELETE FROM kvStore WHERE workspaceId = ? AND scope = ? AND key = ?",
        [workspaceId, scope, key])
      return undefined
    }
    return JSON.parse(row.value)
  }

  set(workspaceId: string, scope: string, key: string, value: unknown, ttlMs?: number): void {
    const expiresAt  = ttlMs != null ? Date.now() + ttlMs : null
    const serialized = JSON.stringify(value)
    const now        = Date.now()

    this.db.run(
      `INSERT INTO kvStore (workspaceId, scope, key, value, expiresAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspaceId, scope, key) DO UPDATE SET
         value     = excluded.value,
         expiresAt = excluded.expiresAt,
         updatedAt = excluded.updatedAt`,
      [workspaceId, scope, key, serialized, expiresAt, now],
    )

    if (scope === "workspace") {
      this.ensureLoaded(workspaceId)
      let ws = this.cache.get(workspaceId)
      if (!ws) { ws = new Map(); this.cache.set(workspaceId, ws) }
      ws.set(key, { value, expiresAt, loadedAt: now })
    }
  }

  delete(workspaceId: string, scope: string, key: string): boolean {
    const rows = this.db.all<{ key: string }>(
      "SELECT key FROM kvStore WHERE workspaceId = ? AND scope = ? AND key = ?",
      [workspaceId, scope, key],
    )
    if (rows.length === 0) return false
    this.db.run("DELETE FROM kvStore WHERE workspaceId = ? AND scope = ? AND key = ?",
      [workspaceId, scope, key])
    if (scope === "workspace") this.cache.get(workspaceId)?.delete(key)
    return true
  }

  deleteExecutionScope(workspaceId: string, executionId: string): void {
    this.db.run("DELETE FROM kvStore WHERE workspaceId = ? AND scope = ?", [workspaceId, executionId])
  }

  purgeExpired(): number {
    const now  = Date.now()
    const rows = this.db.all<{ key: string }>(
      "SELECT key FROM kvStore WHERE expiresAt IS NOT NULL AND expiresAt < ?", [now],
    )
    if (rows.length === 0) return 0
    this.db.run("DELETE FROM kvStore WHERE expiresAt IS NOT NULL AND expiresAt < ?", [now])
    for (const [, wsCache] of this.cache) {
      for (const [k, entry] of wsCache) {
        if (entry.expiresAt !== null && entry.expiresAt < now) wsCache.delete(k)
      }
    }
    return rows.length
  }

  private ensureLoaded(workspaceId: string): void {
    if (this.loaded.has(workspaceId)) return
    const rows = this.db.all<{ key: string; value: string; expiresAt: number | null }>(
      `SELECT key, value, expiresAt FROM kvStore
       WHERE workspaceId = ? AND scope = 'workspace'
         AND (expiresAt IS NULL OR expiresAt > ?)`,
      [workspaceId, Date.now()],
    )
    let ws = this.cache.get(workspaceId)
    if (!ws) { ws = new Map(); this.cache.set(workspaceId, ws) }
    for (const row of rows) {
      ws.set(row.key, { value: JSON.parse(row.value), expiresAt: row.expiresAt, loadedAt: Date.now() })
    }
    this.loaded.add(workspaceId)
  }
}
