// cache/index.ts
// TTL cache with two drivers behind one interface: in-memory and SQLite.
// Swapping the driver must not change an answer, which is what `codec` and
// tests/cache-conformance.test.ts exist to hold — eleven behaviors used to
// differ between them and nothing said so (`FJS-898`).
// Garbage collection runs on a fixed interval, not per get() call.

import { Database } from 'bun:sqlite'
import { parseTtl } from '../config/index.ts'

// ─── What a cache value may be ────────────────────────────────────────────
// One codec, used by BOTH drivers, so what is storable is one answer rather
// than one per backend. The answer is derived rather than chosen: JSON is
// what a Litestone row already is (a DateTime reads back as an ISO string),
// what a response body carries and what a WS frame carries, so a cache that
// holds what the wire holds needs no rule of its own.
//
// The refusals ride the walk JSON.stringify is already doing, so grading a
// value costs no second pass. They fire at set(), where the mistake was made
// — a value that degrades on the way in is otherwise found by whoever reads
// it back, in another file, as a wrong answer rather than an error.

export class CacheValueError extends Error {
  readonly key:  string
  readonly kind: string
  constructor(key: string, kind: string, advice: string) {
    super(`cache: cannot store ${kind} under "${key}" — ${advice}`)
    this.name = 'CacheValueError'
    this.key  = key
    this.kind = kind
  }
}

// Returns the name of what cannot survive a round trip, or null.
// Every node of the value passes through here, so the two shapes that make up
// almost all of one — a plain object and an array — are answered by a single
// prototype comparison, and only something else pays for a tag. Asking by tag
// rather than `instanceof` grades a value from another realm the same as a
// local one.
function unrepresentable(v: unknown): string | null {
  switch (typeof v) {
    case 'object':   break
    case 'string':
    case 'boolean':  return null
    case 'number':   return Number.isFinite(v) ? null : String(v)
    case 'bigint':   return 'a BigInt'
    case 'function': return 'a function'
    case 'symbol':   return 'a symbol'
    default:         return null
  }
  if (v === null) return null
  const proto = Object.getPrototypeOf(v)
  if (proto === Object.prototype || proto === Array.prototype || proto === null) return null

  const tag = Object.prototype.toString.call(v)
  switch (tag) {
    case '[object Date]':   return 'a Date'
    case '[object Map]':    return 'a Map'
    case '[object Set]':    return 'a Set'
    case '[object RegExp]': return 'a RegExp'
  }
  // A typed array serialises to {"0":…} and reads back as a plain object.
  if (ArrayBuffer.isView(v) || tag === '[object ArrayBuffer]') return tag.slice(8, -1)
  return null
}

const ADVICE: Record<string, string> = {
  'a Date':   'store the ISO string (a Litestone row already carries one)',
  'a Map':    'store a plain object or an array of entries',
  'a Set':    'store an array',
  'a RegExp': 'store its source string',
  'a BigInt': 'store a string of digits, the way an `Int @big` column crosses',
}

function advise(kind: string): string {
  return ADVICE[kind] ?? 'JSON is what a cache value may be, and this is lost by it'
}

export function encodeValue(key: string, value: unknown): string {
  // A stored `undefined` cannot be told from a miss by get(), which is also
  // what makes getOrSet's miss check sound.
  if (value === undefined)
    throw new CacheValueError(key, 'undefined', 'get() answers undefined for a miss, so a stored one could not be read back')

  return JSON.stringify(value, function (this: Record<string, unknown>, k: string, encoded: unknown) {
    // toJSON has already run by the time a replacer sees a value, so the
    // Date is read off the holder rather than off what arrived.
    const kind = unrepresentable(this[k])
    if (kind) throw new CacheValueError(key, kind, advise(kind))
    return encoded
  })!
}

export function decodeValue<T>(raw: string): T {
  return JSON.parse(raw) as T
}

// ─── Single flight ────────────────────────────────────────────────────────
// One factory run per key per cache, however many callers arrive while it is
// running. A rejection is NOT cached: the in-flight entry is dropped either
// way, so the next caller tries again.

function makeGetOrSet(
  get: (key: string) => unknown,
  set: (key: string, value: unknown, ttl?: string) => void,
) {
  const inFlight = new Map<string, Promise<unknown>>()

  return function getOrSet<T>(key: string, factory: () => T | Promise<T>, ttl?: string): Promise<T> {
    const hit = get(key)
    if (hit !== undefined) return Promise.resolve(hit as T)

    const pending = inFlight.get(key)
    if (pending) return pending as Promise<T>

    const p = (async () => factory())()
      .then(value => { set(key, value, ttl); return value })
      .finally(() => { inFlight.delete(key) })

    inFlight.set(key, p)
    return p
  }
}

// ─── ICache interface ─────────────────────────────────────────────────────
// The contract every driver owes, held by tests/cache-conformance.test.ts:
//   · a value round-trips through JSON, or set() throws naming the key
//   · get() answers a fresh value — mutating it cannot reach the cache
//   · clear() answers how many entries it removed
//   · clear(string) is a PREFIX match; clear(RegExp) tests the whole key
//   · a bounded driver evicts least-recently-USED, where get() counts as use
//     and has() does not

export interface ICache {
  get<T = unknown>(key: string):                              T | undefined
  set<T = unknown>(key: string, value: T, ttl?: string):     void
  getOrSet<T = unknown>(key: string, factory: () => T | Promise<T>, ttl?: string): Promise<T>
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
// The value is held ENCODED. Storing the object would be faster and is the
// one thing that cannot be made to agree with a persistent driver: a shared
// reference is a semantics no backend but this one can offer, so code written
// against it breaks on the day the driver is swapped.

interface CacheEntry {
  value:   string
  expires: number    // Date.now() + ttl ms — using int for fast comparison
}

// ─── In-memory implementation ─────────────────────────────────────────────

export interface MemoryCacheOptions {
  defaultTtl?:    string    // e.g. '5 minutes'
  maxSize?:       number    // evict least-recently-used on overflow
  gcInterval?:   number     // ms between GC sweeps, default 60s
}

export function createMemoryCache(opts: MemoryCacheOptions = {}): ICache {

  const defaultTtlMs = parseTtl(opts.defaultTtl ?? '5 minutes')
  const maxSize      = opts.maxSize    ?? 10_000
  const gcInterval   = opts.gcInterval ?? 60_000

  // A Map is insertion-ordered, which is what carries the LRU chain: a use
  // re-inserts at the end, so the eviction candidate is the first key.
  const store  = new Map<string, CacheEntry>()
  const counts = { hits: 0, misses: 0, sets: 0, evicts: 0 }

  // GC timer — sweeps expired entries
  const gcTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (entry.expires <= now) {
        store.delete(key)
        counts.evicts++
      }
    }
  }, gcInterval)

  // Don't block process exit
  if (gcTimer.unref) gcTimer.unref()

  function read<T>(key: string): T | undefined {
    const entry = store.get(key)
    if (!entry) {
      counts.misses++
      return undefined
    }
    // Lazy expiry check
    if (entry.expires <= Date.now()) {
      store.delete(key)
      counts.misses++
      counts.evicts++
      return undefined
    }
    counts.hits++
    // Re-insert at the end: this key is now the most recently used.
    store.delete(key)
    store.set(key, entry)
    return decodeValue<T>(entry.value)
  }

  function write(key: string, value: unknown, ttl?: string): void {
    // Encode BEFORE touching the store, so a refused value leaves whatever
    // was already under that key intact.
    const encoded = encodeValue(key, value)
    const ttlMs   = ttl ? parseTtl(ttl) : defaultTtlMs

    // Map.set on an existing key keeps its original position, so an overwrite
    // has to re-insert or a hot key stays the eviction candidate forever.
    store.delete(key)
    store.set(key, { value: encoded, expires: Date.now() + ttlMs })
    counts.sets++

    if (store.size > maxSize) {
      const lru = store.keys().next().value
      if (lru !== undefined) {
        store.delete(lru)
        counts.evicts++
      }
    }
  }

  return {

    get: read,
    set: write,
    getOrSet: makeGetOrSet(read, write),

    has(key: string): boolean {
      const entry = store.get(key)
      if (!entry) return false
      if (entry.expires <= Date.now()) {
        store.delete(key)
        counts.evicts++
        return false
      }
      // Deliberately not a use: has() is a probe, and letting it reorder the
      // chain would let a scan for a key evict the entries somebody wants.
      return true
    },

    remove(key: string): void {
      store.delete(key)
    },

    clear(pattern?: string | RegExp): number {
      if (!pattern) {
        const count = store.size
        store.clear()
        return count
      }

      let count = 0
      const isRegex = pattern instanceof RegExp
      for (const key of store.keys()) {
        const match = isRegex
          ? pattern.test(key)
          : key.startsWith(pattern as string)
        if (match) {
          store.delete(key)
          count++
        }
      }
      return count
    },

    size(): number {
      return store.size
    },

    stats(): CacheStats {
      return { ...counts, size: store.size }
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
  /** ms to wait for another PROCESS's write lock before SQLITE_BUSY. Default
   *  5_000; `0` fails immediately. Only meaningful for a file-backed cache. */
  busyTimeout?: number
}

export function createSqliteCache(opts: SqliteCacheOptions = {}): ICache {

  const db = new Database(opts.path ?? ':memory:')

  // A file-backed cache is shared, so a second process finding the write lock
  // held has to wait rather than throw — `storage/database` already sets the
  // same floor and this was the one connection in the package without it
  // (`FJS-569`). Harmless in memory, where there is nothing to contend for.
  const busyTimeout = opts.busyTimeout ?? 5000
  // Refused rather than coerced — `Number('5s') || 0` is SQLite's *fail
  // immediately*, so a typo would buy the opposite of what it asked for.
  if (!Number.isInteger(busyTimeout) || busyTimeout < 0)
    throw new Error(`createSqliteCache: busyTimeout must be a whole number of milliseconds (0 or more), got ${JSON.stringify(opts.busyTimeout)}`)
  db.run(`PRAGMA busy_timeout = ${busyTimeout}`)
  const defaultTtlMs = parseTtl(opts.defaultTtl ?? '5 minutes')
  const counts = { hits: 0, misses: 0, sets: 0, evicts: 0 }

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
    counts.evicts += (result as unknown as { changes: number }).changes ?? 0
  }, opts.gcInterval ?? 60_000)

  if (gcTimer.unref) gcTimer.unref()

  function read<T>(key: string): T | undefined {
    const row = stmtGet.get(key, Date.now())
    if (!row) { counts.misses++; return undefined }
    counts.hits++
    // A row is whatever encodeValue wrote, so a parse failure is a corrupt
    // file rather than a plain string somebody stored — treating it as the
    // value is how a truncated row becomes a wrong answer instead of a miss.
    try { return decodeValue<T>(row.value) }
    catch { stmtDel.run(key); counts.evicts++; return undefined }
  }

  function write(key: string, value: unknown, ttl?: string): void {
    const encoded = encodeValue(key, value)
    const ttlMs   = ttl ? parseTtl(ttl) : defaultTtlMs
    stmtSet.run(key, encoded, Date.now() + ttlMs)
    counts.sets++
  }

  return {

    get: read,
    set: write,
    getOrSet: makeGetOrSet(read, write),

    has(key: string): boolean {
      return !!stmtExists.get(key, Date.now())
    },

    remove(key: string): void {
      stmtDel.run(key)
    },

    clear(pattern?: string | RegExp): number {
      if (!pattern) {
        const result = stmtClear.run()
        return (result as unknown as { changes: number }).changes ?? 0
      }
      // String prefix pattern — use SQL LIKE to avoid loading all keys
      if (typeof pattern === 'string') {
        // ESCAPE is not optional: without it SQLite reads the backslash as an
        // ordinary character, so a prefix containing % or _ matches nothing.
        const result = db.run(
          "DELETE FROM cache WHERE key LIKE ? ESCAPE '\\'",
          [pattern.replace(/[\\%_]/g, m => '\\' + m) + '%']
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
      return { ...counts, size: this.size() }
    },

    destroy(): void {
      clearInterval(gcTimer)
      db.close()
    }
  }
}
