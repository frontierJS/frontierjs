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
//   await db.posts.findMany()
//
//   await tenants.query(db => db.users.count())
//   await tenants.migrate()

import { Database }        from 'bun:sqlite'
import { existsSync, unlinkSync, mkdirSync } from 'fs'
import { resolve, join, dirname } from 'path'
import { createClient }    from './core/client.js'
import { generateDDL, generateDDLForDatabase } from './core/ddl.js'
import { apply }           from './core/migrations.js'
import { splitStatements } from './core/migrate.js'
import { parse, parseFile } from './core/parser.js'

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

class LRUPool {
  constructor(maxSize) {
    this.maxSize = maxSize
    this.pool    = new Map()  // tenantId → { db, lastAccess }
  }

  get(id) {
    const entry = this.pool.get(id)
    if (!entry) return null
    // Move to end (most recently used)
    this.pool.delete(id)
    this.pool.set(id, entry)
    entry.lastAccess = Date.now()
    return entry.db
  }

  set(id, db) {
    // Evict LRU if at capacity
    if (this.pool.size >= this.maxSize && !this.pool.has(id)) {
      const lruId = this.pool.keys().next().value
      const lru   = this.pool.get(lruId)
      try { lru.db.$close() } catch {}
      this.pool.delete(lruId)
    }
    this.pool.set(id, { db, lastAccess: Date.now() })
  }

  delete(id) {
    const entry = this.pool.get(id)
    if (entry) {
      try { entry.db.$close() } catch {}
      this.pool.delete(id)
    }
  }

  closeAll() {
    for (const [, entry] of this.pool) {
      try { entry.db.$close() } catch {}
    }
    this.pool.clear()
  }

  get size() { return this.pool.size }

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

function openRegistry(path) {
  const db = new Database(path)
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
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

  constructor({ dir, registryDb, maxOpen, encryptionKey, migrationsDir, inMemory, clientOptions }) {
    this.#dir           = dir
    this.#registryDb    = registryDb
    this.#pool          = new LRUPool(maxOpen)
    this.#maxOpen       = maxOpen
    this.#encryptionKey = encryptionKey ?? null
    this.#migrationsDir = migrationsDir ?? null
    this.#inMemory      = inMemory ?? false
    this.#clientOptions = clientOptions ?? {}
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

  async #open(id) {
    const cached = this.#pool.get(id)
    if (cached) return cached

    const path = this.#inMemory ? ':memory:' : this.#dbPath(id)
    if (!this.#inMemory && !existsSync(path))
      throw new Error(`Tenant "${id}" does not exist`)

    const encKey = await this.#encryptionFor(id)
    const db  = await createClient({
      ...this.#clientOptions,
      parsed:        this.#parseResult,
      db:            path,
      encryptionKey: encKey ?? this.#clientOptions.encryptionKey,
    })

    this.#pool.set(id, db)
    return db
  }

  // ── Public API ──────────────────────────────────────────────────────────────

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

    if (this.#migrationsDir && existsSync(this.#migrationsDir)) {
      // Apply migration files — same as running `litestone migrate apply`
      apply(raw, this.#migrationsDir)
    } else {
      // Fall back to fresh DDL from schema.
      // In multi-DB schemas only generate DDL for the 'main' SQLite database —
      // jsonl/logger databases are not managed as SQLite files per tenant.
      const hasDatabaseBlocks = this.#parseResult.schema.databases?.some(
        d => !d.driver || d.driver === 'sqlite'
      )
      const ddl = hasDatabaseBlocks
        ? generateDDLForDatabase(this.#parseResult.schema, 'main')
        : generateDDL(this.#parseResult.schema)
      for (const s of splitStatements(ddl))
        if (s.trim()) raw.run(s)
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
      const db = await this.#open(id)
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
   * await tenants.aggregate(db => db.users.count())
   * // → { total: 1247, byTenant: { acme: 42, globex: 17, ... } }
   *
   * // Custom reduce
   * await tenants.aggregate({
   *   value:   db => db.invoices.findMany({ where: { paid: true } }),
   *   reduce:  (acc, rows, id) => acc + rows.reduce((s, r) => s + r.amount, 0),
   *   initial: 0
   * })
   */
  async aggregate(fnOrOpts, queryOpts = {}) {
    // Simple form: aggregate(db => db.users.count())
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
      const applied = apply(raw, this.#migrationsDir)
      raw.close()
      // Evict cached connection so next access gets a fresh one post-migration
      this.#pool.delete(id)
      return { applied }
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
  // Tenant directory — defaults to <schemaDir>/tenants
  dir,
  // Registry db — defaults to <schemaDir>/registry.db (next to schema.lite)
  registry,
  maxOpen        = 100,
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

  const inMemory  = databases === ':memory:'
  const schemaDir = schemaPath ? dirname(resolve(schemaPath)) : process.cwd()
  const absDir    = resolve(dir ?? join(schemaDir, 'tenants'))
  const registryPath = registry
    ? resolve(registry)
    : inMemory
      ? ':memory:'
      : join(schemaDir, 'tenants-registry.db')

  // Ensure tenant directory exists (skip in inMemory mode)
  if (!inMemory) mkdirSync(absDir, { recursive: true })

  // Open registry DB
  const registryDb = openRegistry(registryPath)

  const reg = new TenantRegistry({
    dir:           absDir,
    registryDb,
    maxOpen,
    encryptionKey,
    migrationsDir: migrationsDir ? resolve(migrationsDir) : null,
    inMemory,
    clientOptions,
  })

  await reg._init(parseResult)
  return reg
}
