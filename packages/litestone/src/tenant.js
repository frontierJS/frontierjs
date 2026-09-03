// tenant.js — Database-per-tenant registry for Litestone
//
// Multi-DB note: In schemas with multiple database blocks, each tenant only
// gets a SQLite file for the 'main' database. The jsonl/logger databases are
// schema-global (not per-tenant) and are not managed here. If you need
// per-tenant analytics or audit databases, create them separately.
//
// Each tenant gets its own SQLite file: <dir>/<tenantId>.db
// A registry.db in the same directory tracks tenant metadata.
//
// Usage:
//   import { createTenantRegistry } from '@frontierjs/litestone'
//
//   const tenants = await createTenantRegistry({
//     dir:      './tenants/',
//     schema:   './schema.lite',
//     registry: './registry.db',  // default: <dir>/registry.db
//     maxOpen:  100,
//     encryptionKey: async (id) => getKey(id)
//   })
//
//   const db = await tenants.get('acme')
//   await db.post.findMany()
//
//   await tenants.query(db => db.user.count())
//   await tenants.migrate()

import { Database }        from 'bun:sqlite'
import { applyBusyTimeout, busyTimeoutFor } from './core/pragmas.js'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { createClient }    from './core/client.js'
import { generateDDL, generateDDLForDatabase } from './core/ddl.js'
import { apply }           from './core/migrations.js'
import { splitStatements } from './core/migrate.js'
import { parse, parseFile } from './core/parser.js'
import { resolveTenancy, tenantFrom } from './core/tenancy.js'
import { noteMintedDirectory }  from './core/db-path.js'

// ─── Tenant ID sanitization ───────────────────────────────────────────────────
// Tenant IDs are free-form strings that become filenames.
// We allow: a-z A-Z 0-9 - _ .
// Everything else is rejected — we don't silently mangle IDs.

const SAFE_ID = /^[a-zA-Z0-9_\-\.]+$/

function assertSafeId(id) {
  if (!id || typeof id !== 'string')
    throw new Error(`Tenant ID must be a non-empty string`)
  if (!SAFE_ID.test(id))
    throw new Error(`Tenant ID "${id}" contains invalid characters. Use: a-z A-Z 0-9 - _ .`)
  if (id === 'registry')
    throw new Error(`"registry" is reserved — it is used for the tenant registry database`)
}

// ─── LRU connection pool ──────────────────────────────────────────────────────
// Map preserves insertion order — move to end on access, evict from front.
//
// Two rules here are not obvious and both were bugs (`FJS-640`).
//
// **Eviction does not close.** A pool that closes what it lent out is not a
// pool: `get()` hands a client to a request that holds it across every await it
// makes, and `maxOpen` is reached by traffic rather than by that request
// finishing. Closing under it used to leave a MIXED client — a cached statement
// still answering, a fresh one throwing — so requests failed at random above
// the default of 100 hot tenants. `maxOpen` is therefore a target for how many
// to keep warm, not a ceiling on open handles.
//
// A LEASE is what makes the common case deterministic. junction pins for the
// length of a request and releases in a `finally`, so eviction can close a
// client whose every lease has ended, now, rather than waiting for a collection
// that file-descriptor pressure does not trigger. A client from a bare `get()`
// was never leased and is dropped instead — bun finalises a Database on GC, so
// the last holder to let go still closes it.
//
// **A fan-out inserts COLD.** `tenants.query` walks every tenant, so through a
// plain LRU an admin dashboard evicts the tenants being served. A cold entry is
// the eviction victim before any hot one, which is Postgres's ring buffer for
// sequential scans and MySQL's midpoint insertion; the ring is sized to the
// fan-out's concurrency so its in-flight clients stay pooled and everything
// past them recycles within the ring.

class LRUPool {
  constructor(maxSize, coldKeep = 8) {
    this.maxSize  = maxSize
    // The ring is sized to the fan-out's concurrency so its in-flight clients
    // stay pooled — but never past half the pool, or a scan owns the cache it
    // was supposed to leave alone. A ring wider than the pool can never fill,
    // so it never starts recycling and every cold insert evicts a hot entry:
    // the scan resistance is off, silently, for exactly the small pools that
    // need it most.
    this.coldKeep = Math.max(1, Math.min(coldKeep, Math.floor(maxSize / 2)))
    this.pool     = new Map()  // tenantId → { db, lastAccess, cold, pins, leased }
    // Retired clients are counted, never held. A FinalizationRegistry holds its
    // target weakly, so registering one cannot be the reason it stays alive,
    // and the callback is what lets `stats()` say how many evicted clients are
    // still outstanding. A count only — nothing branches on it, because a
    // finaliser is not guaranteed to run.
    this.retired   = 0
    this.overflows = 0
    this.warned    = false
    this.finaliser = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry(() => { this.retired-- })
      : null
  }

  get(id, { cold = false } = {}) {
    const entry = this.pool.get(id)
    if (!entry) return null
    // A fan-out must neither promote nor reorder: it is walking this pool, and
    // touching every tenant once would make the scan its own working set.
    if (!cold) {
      entry.cold = false
      this.pool.delete(id)
      this.pool.set(id, entry)
      entry.lastAccess = Date.now()
    }
    return entry.db
  }

  set(id, db, { cold = false } = {}) {
    if (this.pool.size >= this.maxSize && !this.pool.has(id)) this.#evict()
    this.pool.set(id, { db, lastAccess: Date.now(), cold, pins: 0, leased: false })
  }

  /**
   * Pin a pooled client for the duration of a unit of work. Returns the
   * release; calling it twice is a no-op, so a `finally` is safe on a path
   * that already released.
   */
  retain(id) {
    const entry = this.pool.get(id)
    if (!entry) return () => {}
    entry.pins++
    entry.leased = true
    let done = false
    return () => {
      if (done) return
      done = true
      entry.pins--
      if (entry.pins === 0 && entry.evicted) this.#close(entry)
    }
  }

  #victim() {
    let firstCold = null, colds = 0, firstFree = null, first = null
    for (const [id, e] of this.pool) {
      if (first === null) first = id
      if (e.cold) { colds++; if (firstCold === null) firstCold = id }
      else if (e.pins === 0 && firstFree === null) firstFree = id
    }
    // Recycle within the cold ring once it is full; below that a scan is still
    // filling its working set and evicting it would make the scan pay twice.
    // `>=` because the victim is chosen BEFORE the new cold entry goes in, so
    // `>` would let the ring grow one slot past its size on every insert.
    if (firstCold !== null && colds >= this.coldKeep) return firstCold
    return firstFree ?? firstCold ?? first
  }

  #evict() {
    const id    = this.#victim()
    const entry = this.pool.get(id)
    this.pool.delete(id)
    if (!entry) return
    entry.evicted = true
    // Leased and idle: every holder has let go and the close is safe and now.
    if (entry.leased && entry.pins === 0) { this.#close(entry); return }
    // Leased and busy: every slot was in use, so the pool is over its target
    // for as long as those requests run. This is the one condition an operator
    // can act on, and the only one that cannot be GC lag — a client waiting to
    // be collected is not a client anybody is using.
    if (entry.pins > 0) { this.#overflow(entry.pins); return }
    // Never leased: nobody told us who holds it, so dropping the reference is
    // the only safe answer.
    this.#retire(entry.db)
  }

  #overflow(pins) {
    this.overflows++
    if (this.warned) return
    this.warned = true
    console.warn(
      `[litestone] tenant pool: every one of maxOpen=${this.maxSize} connections was in use, ` +
      `so a client ${pins} request(s) are still holding was evicted. It stays open until they ` +
      `finish, so this process is over its target. Raise maxOpen to the concurrent tenant ` +
      `working set.`,
    )
  }

  #close(entry) {
    try { entry.db.$close() } catch {}
  }

  // An evicted client nobody leased. Counted for `stats()` and NOT warned
  // about: the count includes clients that are already garbage and merely
  // uncollected, so a threshold on it fires on GC lag rather than on pressure,
  // which is how a warning teaches everyone to ignore it. `#overflow` is the
  // condition that is really about the pool being too small.
  #retire(db) {
    if (!this.finaliser) return
    this.retired++
    this.finaliser.register(db, null)
  }

  delete(id) {
    const entry = this.pool.get(id)
    if (!entry) return
    this.pool.delete(id)
    entry.evicted = true
    // A dropped tenant is not a closed one. An in-flight request finishes
    // against a file that has been unlinked, which POSIX is fine with, and the
    // handle goes when the last holder does.
    if (entry.pins === 0 && entry.leased) this.#close(entry)
    else if (!entry.leased) this.#retire(entry.db)
  }

  closeAll() {
    // Shutdown: nothing is in flight, so this is the one place an unconditional
    // close is right.
    for (const [, entry] of this.pool) {
      try { entry.db.$close() } catch {}
    }
    this.pool.clear()
  }

  get size() { return this.pool.size }

  stats() {
    return {
      pooled:    this.pool.size,
      leased:    [...this.pool.values()].reduce((n, e) => n + (e.pins > 0 ? 1 : 0), 0),
      retired:   this.retired,
      overflows: this.overflows,
      maxOpen:   this.maxSize,
    }
  }

  ids() { return [...this.pool.keys()] }
}

// ─── Registry DB ──────────────────────────────────────────────────────────────
// Simple SQLite file Litestone manages — tracks tenant IDs + metadata.
// Schema is fixed: id TEXT PK, createdAt TEXT, meta TEXT (JSON blob).

const REGISTRY_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS tenants (
  id        TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  meta      TEXT NOT NULL DEFAULT '{}'
) STRICT;
`

function openRegistry(path, busyTimeout) {
  const db = new Database(path)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  applyBusyTimeout(db, busyTimeout)
  db.run(`CREATE TABLE IF NOT EXISTS tenants (
    id        TEXT PRIMARY KEY,
    createdAt TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    meta      TEXT NOT NULL DEFAULT '{}'
  ) STRICT`)
  return db
}

// ─── TenantRegistry ───────────────────────────────────────────────────────────


class TenantRegistry {
  #dir
  #parseResult
  #registryDb
  #pool
  #maxOpen
  #encryptionKey
  #migrationsDir
  #clientOptions
  #defaultConcurrency = 8
  #inMemory
  #tenancy
  #busyTimeout

  constructor({ dir, registryDb, maxOpen, encryptionKey, migrationsDir, inMemory, clientOptions, tenancy }) {
    this.#tenancy       = tenancy ?? null
    this.#dir           = dir
    this.#registryDb    = registryDb
    this.#pool          = new LRUPool(maxOpen, this.#defaultConcurrency)
    this.#maxOpen       = maxOpen
    this.#encryptionKey = encryptionKey ?? null
    this.#migrationsDir = migrationsDir ?? null
    this.#inMemory      = inMemory ?? false
    this.#clientOptions = clientOptions ?? {}
    // A tenant's file IS main under `strategy database`, so a per-database
    // `busyTimeout` narrows to main's entry for every raw handle below.
    this.#busyTimeout   = busyTimeoutFor(this.#clientOptions.busyTimeout, 'main')

    // `databases: ':memory:'` is the single-client shorthand for *move them
    // all*, and a registry decides where a tenant's sqlite files go — so here
    // it can only mean the shared jsonl/logger ones, which is not what it says.
    // Refused by name: spreading a string yields one key per character, and the
    // per-tenant merge below would have taken it silently.
    if (typeof this.#clientOptions.databases === 'string')
      throw new Error(
        `createTenantRegistry: clientOptions.databases must be an object here — ` +
        `pass { inMemory: true } for an in-memory fleet, or name a database: ` +
        `{ databases: { audit: { path } } }`
      )
  }
  // Called by createTenantRegistry after construction
  async _init(parseResult) {
    this.#parseResult = parseResult

    // Warn if schema has jsonl/logger databases — these are global, not per-tenant.
    // All tenants will write to the same log/audit files unless you handle this
    // separately in your application layer.
    const sharedDbs = parseResult.schema.databases
      .filter(d => d.driver === 'jsonl' || d.driver === 'logger')
    if (sharedDbs.length) {
      console.warn(
        `[litestone:tenants] Schema has ${sharedDbs.length} shared database(s): ` +
        sharedDbs.map(d => `${d.name} (${d.driver})`).join(', ') +
        '. These are global — all tenants share the same files. ' +
        'Handle per-tenant logging separately if needed.'
      )
    }
  }

  // ── Tenant DB path ──────────────────────────────────────────────────────────

  #dbPath(id) {
    return join(this.#dir, `${id}.db`)
  }

  // ── Get encryption options for a tenant ────────────────────────────────────

  async #encryptionFor(id) {
    if (!this.#encryptionKey) return undefined
    // Function form: encryptionKey: (tenantId) => key
    if (typeof this.#encryptionKey === 'function') {
      const key = await this.#encryptionKey(id)
      return key ?? undefined
    }
    // String form: encryptionKey: 'abc...' — same key for all tenants
    return this.#encryptionKey
  }

  // ── Open a connection to a tenant DB ───────────────────────────────────────

  // In-flight opens, memoized per tenant id. Without this, K concurrent get()
  // calls for the same cold tenant each run a full createClient during the
  // async gap between the pool check and pool.set — K sets of SQLite handles,
  // K-1 of them leaked (never $close()d), and at capacity each duplicate
  // evicts an innocent pool entry (thundering herd on deploy restarts).
  #opening = new Map()

  async #open(id, opts) {
    const cached = this.#pool.get(id, opts)
    if (cached) return cached

    const inflight = this.#opening.get(id)
    if (inflight) return inflight

    const promise = this.#doOpen(id, opts).finally(() => this.#opening.delete(id))
    this.#opening.set(id, promise)
    return promise
  }

  async #doOpen(id, opts) {
    const path = this.#inMemory ? ':memory:' : this.#dbPath(id)
    if (!this.#inMemory && !existsSync(path))
      throw new Error(`Tenant "${id}" does not exist`)

    const encKey = await this.#encryptionFor(id)

    // Multi-DB schemas resolve paths from their database blocks, which would
    // send EVERY tenant to the same shared files — a cross-tenant isolation
    // hole. Override every sqlite database to this tenant's own file (all of a
    // tenant's sqlite databases live in one file, per the documented layout).
    // jsonl/logger databases stay schema-global by design.
    const sqliteOverrides = {}
    if (!this.#inMemory) {
      for (const d of (this.#parseResult.schema.databases ?? [])) {
        if (!d.driver || d.driver === 'sqlite') sqliteOverrides[d.name] = { path }
      }
    }

    // A caller's own `databases` still applies, and it reaches exactly the ones
    // this registry does not decide: the shared jsonl/logger files. Merging
    // rather than replacing, because a declared `path` on one of those is
    // relative to the process CWD and an app that assembles its schema in
    // memory has no other way to pin it. The tenant file wins for every sqlite
    // database — that is the isolation, and it is not negotiable from options.
    const databases = { ...this.#clientOptions.databases, ...sqliteOverrides }

    const db  = await createClient({
      ...this.#clientOptions,
      parsed:        this.#parseResult,
      db:            path,
      ...(Object.keys(databases).length ? { databases } : {}),
      encryptionKey: encKey ?? this.#clientOptions.encryptionKey,
    })

    this.#pool.set(id, db, opts)
    return db
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * The tenancy declaration this registry was built from, resolved — or null
   * when the schema declares none and the caller passed options by hand.
   */
  get tenancy() { return this.#tenancy }

  /**
   * Which tenant is this request for?
   *
   * Asked rather than copied: an API layer holds the request and this holds the
   * declaration, and a second reading of `resolve subdomain` living above the
   * Data realm is how the two drift. Junction calls exactly this.
   */
  tenantFor({ host = null, headers = null, principal = null } = {}) {
    return tenantFrom(this.#tenancy?.resolve ?? null, { host, headers, principal })
  }

  /**
   * Get a client for an existing tenant. Throws if tenant doesn't exist.
   */
  async get(id) {
    assertSafeId(id)
    return this.#open(id)
  }

  /**
   * Get a client, creating the tenant if it doesn't exist.
   */
  async getOrCreate(id, meta = {}) {
    assertSafeId(id)
    if (!this.exists(id)) await this.create(id, meta)
    return this.#open(id)
  }

  /**
   * Create a new tenant. Throws if already exists.
   * Initialises schema via migrations (if dir configured) or DDL.
   */
  async create(id, meta = {}) {
    assertSafeId(id)
    if (this.exists(id))
      throw new Error(`Tenant "${id}" already exists`)

    const path = this.#dbPath(id)

    // Initialise schema (skip file creation in inMemory mode — createClient handles it)
    if (this.#inMemory) {
      this.#registryDb.prepare(`INSERT INTO tenants (id, meta) VALUES (?, ?)`).run(id, JSON.stringify(meta))
      return this.#open(id)
    }

    const raw = new Database(path)
    raw.run('PRAGMA journal_mode = WAL')
    raw.run('PRAGMA foreign_keys = ON')
    applyBusyTimeout(raw, this.#busyTimeout)

    if (this.#migrationsDir && existsSync(this.#migrationsDir)) {
      // Apply migration files — same as running `litestone migrate apply`.
      // MUST be awaited: apply() is async, and the raw handle closes below.
      await apply(raw, this.#migrationsDir)
    } else {
      // Fall back to fresh DDL from schema. A tenant's single file holds ALL
      // of the schema's sqlite databases (main + analytics + …), so generate
      // DDL for every sqlite database — jsonl/logger stay schema-global.
      const sqliteDbs = (this.#parseResult.schema.databases ?? []).filter(
        d => !d.driver || d.driver === 'sqlite'
      )
      if (sqliteDbs.length) {
        for (const d of sqliteDbs) {
          for (const s of splitStatements(generateDDLForDatabase(this.#parseResult.schema, d.name)))
            if (s.trim()) raw.run(s)
        }
      } else {
        for (const s of splitStatements(generateDDL(this.#parseResult.schema)))
          if (s.trim()) raw.run(s)
      }
    }
    raw.close()

    // Register in registry
    this.#registryDb.prepare(
      `INSERT INTO tenants (id, meta) VALUES (?, ?)`
    ).run(id, JSON.stringify(meta))

    return this.#open(id)
  }

  /**
   * Check if a tenant exists (in registry AND as a file).
   */
  exists(id) {
    assertSafeId(id)
    const row = this.#registryDb.prepare(`SELECT 1 FROM tenants WHERE id = ?`).get(id)
    return !!row && existsSync(this.#dbPath(id))
  }

  /**
   * List all tenant IDs.
   */
  list() {
    return this.#registryDb
      .prepare(`SELECT id FROM tenants ORDER BY createdAt`)
      .all()
      .map(r => r.id)
  }

  /**
   * Delete a tenant — closes connection, deletes file, removes from registry.
   */
  async delete(id) {
    assertSafeId(id)
    this.#pool.delete(id)  // closes connection
    const path = this.#dbPath(id)
    if (existsSync(path)) unlinkSync(path)
    // Also remove WAL/SHM files if present
    for (const ext of ['-wal', '-shm']) {
      if (existsSync(path + ext)) unlinkSync(path + ext)
    }
    this.#registryDb.prepare(`DELETE FROM tenants WHERE id = ?`).run(id)
  }

  /**
   * Get or update metadata for a tenant.
   *
   * tenants.meta.get('acme')                        // → { plan: 'pro', ... }
   * tenants.meta.set('acme', { plan: 'enterprise' })  // merge
   * tenants.meta.replace('acme', { plan: 'pro' })     // full replace
   * tenants.meta.findMany({ where: { plan: 'pro' } }) // query all
   */
  get meta() {
    const db = this.#registryDb
    return {
      get: (id) => {
        const row = db.prepare(`SELECT meta FROM tenants WHERE id = ?`).get(id)
        if (!row) throw new Error(`Tenant "${id}" not found`)
        return JSON.parse(row.meta)
      },
      set: (id, patch) => {
        const current = JSON.parse(
          db.prepare(`SELECT meta FROM tenants WHERE id = ?`).get(id)?.meta ?? '{}'
        )
        db.prepare(`UPDATE tenants SET meta = ? WHERE id = ?`)
          .run(JSON.stringify({ ...current, ...patch }), id)
      },
      replace: (id, meta) => {
        db.prepare(`UPDATE tenants SET meta = ? WHERE id = ?`)
          .run(JSON.stringify(meta), id)
      },
      findMany: ({ where } = {}) => {
        const rows = db.prepare(`SELECT id, createdAt, meta FROM tenants ORDER BY createdAt`).all()
        const parsed = rows.map(r => ({ id: r.id, createdAt: r.createdAt, ...JSON.parse(r.meta) }))
        if (!where) return parsed
        return parsed.filter(row => {
          for (const [k, v] of Object.entries(where))
            if (row[k] !== v) return false
          return true
        })
      },
      all: () => {
        return db.prepare(`SELECT id, createdAt, meta FROM tenants ORDER BY createdAt`).all()
          .map(r => ({ id: r.id, createdAt: r.createdAt, ...JSON.parse(r.meta) }))
      },
    }
  }

  // ── Fan-out queries ─────────────────────────────────────────────────────────

  /**
   * Run an async function against every tenant in parallel.
   * Returns [{ tenantId, result }] — or flattened if flatten:true.
   *
   * @param {(db, tenantId) => Promise<any>} fn
   * @param {object} opts
   * @param {number}   [opts.concurrency=8]   parallel connection limit
   * @param {string[]} [opts.only]            restrict to these tenant IDs
   * @param {Function} [opts.where]           filter tenants by metadata
   * @param {boolean}  [opts.flatten=false]   flatten row arrays, inject tenantId field
   * @param {string}   [opts.tenantField='tenantId']  field name when flattening
   */
  async query(fn, {
    concurrency = this.#defaultConcurrency,
    only        = null,
    where       = null,
    flatten     = false,
    tenantField = 'tenantId',
  } = {}) {
    let ids = this.list()
    if (only)  ids = ids.filter(id => only.includes(id))
    if (where) ids = ids.filter(id => {
      const m = this.meta.get(id)
      for (const [k, v] of Object.entries(where))
        if (m[k] !== v) return false
      return true
    })

    const results = await this.#fanOut(ids, async (id) => {
      // Cold: a scan over every tenant must not evict the ones being served.
      const db = await this.#open(id, { cold: true })
      return fn(db, id)
    }, concurrency)

    if (flatten) {
      return results.flatMap(({ tenantId, result }) => {
        if (Array.isArray(result))
          return result.map(row => ({ [tenantField]: tenantId, ...row }))
        return [{ [tenantField]: tenantId, result }]
      })
    }

    return results
  }

  /**
   * Aggregate a value across all tenants.
   *
   * // Count total users
   * await tenants.aggregate(db => db.user.count())
   * // → { total: 1247, byTenant: { acme: 42, globex: 17, ... } }
   *
   * // Custom reduce
   * await tenants.aggregate({
   *   value:   db => db.invoice.findMany({ where: { paid: true } }),
   *   reduce:  (acc, rows, id) => acc + rows.reduce((s, r) => s + r.amount, 0),
   *   initial: 0
   * })
   */
  async aggregate(fnOrOpts, queryOpts = {}) {
    // Simple form: aggregate(db => db.user.count())
    if (typeof fnOrOpts === 'function') {
      const results = await this.query(fnOrOpts, queryOpts)
      const byTenant = Object.fromEntries(results.map(r => [r.tenantId, r.result]))
      const values   = Object.values(byTenant)
      const total    = values.every(v => typeof v === 'number')
        ? values.reduce((a, b) => a + b, 0)
        : values
      return { total, byTenant }
    }

    // Extended form: aggregate({ value, reduce, initial })
    const { value: fn, reduce, initial } = fnOrOpts
    const results = await this.query(fn, queryOpts)
    return results.reduce(
      (acc, { tenantId, result }) => reduce(acc, result, tenantId),
      initial
    )
  }

  /**
   * Run pending migrations against all (or selected) tenant databases.
   * Requires migrationsDir to be configured.
   */
  async migrate({
    only        = null,
    where       = null,
    concurrency = this.#defaultConcurrency,
  } = {}) {
    if (!this.#migrationsDir)
      throw new Error('migrationsDir must be configured to use tenants.migrate()')

    let ids = this.list()
    if (only)  ids = ids.filter(id => only.includes(id))
    if (where) ids = ids.filter(id => {
      const m = this.meta.get(id)
      for (const [k, v] of Object.entries(where))
        if (m[k] !== v) return false
      return true
    })

    const results = await this.#fanOut(ids, async (id) => {
      const path   = this.#dbPath(id)
      const raw    = new Database(path)
      applyBusyTimeout(raw, this.#busyTimeout)
      try {
        // await BEFORE closing — previously this fired-and-forgot the promise,
        // closed the DB immediately, and reported 0 applied migrations.
        const result = await apply(raw, this.#migrationsDir)
        if (result.error) throw new Error(`migration "${result.failed}" failed: ${result.error}`)
        return { applied: result.applied?.filter(a => a.ok).length ?? 0 }
      } finally {
        raw.close()
        // Evict cached connection so next access gets a fresh one post-migration
        this.#pool.delete(id)
      }
    }, concurrency)

    const total  = results.reduce((n, r) => n + (r.result?.applied ?? 0), 0)
    const failed = results.filter(r => r.error)

    return {
      tenants: ids.length,
      migrations: total,
      failed: failed.map(r => ({ tenantId: r.tenantId, error: r.error.message })),
    }
  }

  /**
   * Close all open connections and the registry.
   */
  close() {
    this.#pool.closeAll()
    try { this.#registryDb.close() } catch {}
  }

  /**
   * How many connections are currently open.
   */
  get openCount() { return this.#pool.size }

  /**
   * Pin a client for the length of a unit of work; returns the release.
   *
   * The pool never closes a client it lent out, so without this an evicted one
   * waits on a collection that file-descriptor pressure does not trigger. A
   * lease says when the work is over, which is what lets eviction close the
   * client immediately instead. Junction's per-request tenant hook is the
   * caller; an app holding a client for the length of a call does not need it.
   *
   *   const release = tenants.retain(id)
   *   try { ... } finally { release() }
   */
  retain(id) { return this.#pool.retain(id) }

  /**
   * `{ pooled, retired, maxOpen }` — `retired` is evicted clients something is
   * still holding, which is the number `openCount` cannot report and the one
   * that says whether this process is over its target.
   */
  poolStats() { return this.#pool.stats() }

  // ── Internal fan-out ────────────────────────────────────────────────────────
  // Processes ids in parallel batches of `concurrency`.
  // Never throws — captures errors per tenant.

  async #fanOut(ids, fn, concurrency) {
    const results = []
    const queue   = [...ids]

    async function runSlot() {
      while (queue.length) {
        const id = queue.shift()
        try {
          const result = await fn(id)
          results.push({ tenantId: id, result })
        } catch (error) {
          results.push({ tenantId: id, result: null, error })
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, ids.length || 1) }, runSlot)
    )

    // Preserve original order
    const order = Object.fromEntries(ids.map((id, i) => [id, i]))
    return results.sort((a, b) => order[a.tenantId] - order[b.tenantId])
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create and initialise a TenantRegistry.
 *
 * @param {object} opts
 * @param {string} opts.dir            — directory for tenant .db files
 * @param {string} opts.schema         — path to schema.lite or a parseResult
 * @param {string} [opts.registry]     — path to registry db (default: <schemaDir>/tenants-registry.db)
 * @param {number} [opts.maxOpen=100]  — max open connections (LRU)
 * @param {object} [opts.encryption]   — { key: string } or { keyFor: async (id) => string }
 * @param {boolean} [opts.inMemory=false] — all tenant DBs use :memory: (testing only)
 * @param {string} [opts.migrationsDir] — migrations folder for tenants.migrate()
 */
export async function createTenantRegistry({
  // Schema — same forms as createClient
  path:          schemaPath,
  schema:        schemaInline,
  parsed:        schemaParsed,
  // Tenant directory — defaults to the schema's `tenancy { dir }`, then <schemaDir>/tenants
  dir,
  // Registry db — defaults to `tenancy { registry }`, then <schemaDir>/tenants-registry.db
  registry,
  maxOpen,
  // encryptionKey: string | (tenantId) => string | Promise<string>
  encryptionKey  = null,
  migrationsDir  = null,
  // databases: ':memory:' — all tenant DBs use :memory: (testing)
  databases,
  // Extra createClient options forwarded to every tenant connection
  clientOptions  = {},
} = {}) {
  // Resolve schema — same order as createClient
  const parseResult = (() => {
    if (schemaParsed)  return schemaParsed
    if (schemaInline)  return schemaInline.includes('\n') || !schemaInline.endsWith('.lite')
                         ? parse(schemaInline)
                         : parseFile(resolve(schemaInline))
    if (schemaPath)    return parseFile(resolve(schemaPath))
    throw new Error('createTenantRegistry requires one of: path, schema, or parsed')
  })()

  if (!parseResult.valid)
    throw new Error(`schema.lite has errors:\n${parseResult.errors.join('\n')}`)

  // What the SEED says, with these options on top of it. An app that declares
  // `tenancy { }` needs no arguments here at all, which is the point: the CLI's
  // `tenant` commands, Studio and Junction read the same block, so a registry
  // built by hand and one built by a tool open the same files.
  const declared = resolveTenancy(parseResult.schema, { schemaPath })

  // A `strategy row` schema has no per-tenant file to open, and building a
  // registry over one would silently create a second, empty database per
  // tenant beside the real single one.
  if (declared?.strategy === 'row')
    throw new Error(
      `createTenantRegistry: this schema declares tenancy { strategy row }, which is one database ` +
      `with a '${declared.column}' column — there are no per-tenant files to register. ` +
      `Scope a client with db.$setAuth(principal) instead.`
    )

  const inMemory  = databases === ':memory:'
  const schemaDir = schemaPath ? dirname(resolve(schemaPath)) : process.cwd()
  const absDir    = resolve(dir ?? declared?.dir ?? join(schemaDir, 'tenants'))
  const registryPath = registry
    ? resolve(registry)
    : inMemory
      ? ':memory:'
      : (declared?.registry ?? join(schemaDir, 'tenants-registry.db'))

  // Ensure tenant directory exists (skip in inMemory mode). A directory that
  // was not there is the same signal it is for a database file: every measured
  // instance of `FJS-449` is a relative declared path resolved from one
  // directory away, and nothing fails — the fleet simply becomes empty.
  if (!inMemory && !existsSync(absDir)) {
    mkdirSync(absDir, { recursive: true })
    noteMintedDirectory(absDir, registryPath)
  }

  // Open registry DB
  const registryDb = openRegistry(registryPath, busyTimeoutFor(clientOptions?.busyTimeout, 'default'))

  const reg = new TenantRegistry({
    dir:           absDir,
    registryDb,
    maxOpen:       maxOpen ?? declared?.maxOpen ?? 100,
    encryptionKey: encryptionKey ?? declared?.key ?? null,
    migrationsDir: migrationsDir ? resolve(migrationsDir) : null,
    inMemory,
    clientOptions,
    tenancy:       declared,
  })

  await reg._init(parseResult)
  return reg
}
