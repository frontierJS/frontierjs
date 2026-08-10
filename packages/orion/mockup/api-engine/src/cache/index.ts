// ─────────────────────────────────────────────
// EXECUTION CACHE
// Key-value cache used by NodeExecutor to skip redundant node runs.
// Default: in-memory with TTL. Scale-out: swap for Redis.
//
// Surface API:
//   new InMemoryCache()
//   cache.get(key)          → unknown | undefined
//   cache.set(key, val, ms) → void
// ─────────────────────────────────────────────

export interface IExecutionCache {
  get(key: string): Promise<unknown | undefined>
  set(key: string, value: unknown, ttlMs: number): Promise<void>
}

// ─────────────────────────────────────────────
// IN-MEMORY CACHE
// TTL-based, entries expire lazily on next read.
// Swap for a Redis implementation at scale.
// ─────────────────────────────────────────────

interface CacheEntry {
  value:     unknown
  expiresAt: number
}

export class InMemoryCache implements IExecutionCache {
  private readonly store = new Map<string, CacheEntry>()

  async get(key: string): Promise<unknown | undefined> {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key)
      return undefined
    }
    return entry.value
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  // ── Test / admin helpers ──────────────────────

  size(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }
}
