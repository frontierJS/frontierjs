// src/seeder.js — Factory + Seeder system for Litestone

import { modelToAccessor } from './core/ddl.js'

// ─── SeededRng — deterministic PRNG (mulberry32) ──────────────────────────────

class SeededRng {
  constructor(seed) { this._s = seed >>> 0 }

  next() {
    let t = (this._s += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(min, max) { return Math.floor(this.next() * (max - min + 1)) + min }
  pick(arr)     { return arr[Math.floor(this.next() * arr.length)] }
  bool(p = 0.5) { return this.next() < p }
  str(len = 8)  {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    return Array.from({ length: len }, () => chars[Math.floor(this.next() * chars.length)]).join('')
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export class Factory {
  // Subclasses declare:
  //   model = 'tableName'
  //   traits = { admin: { role: 'admin' }, ... }
  //   afterCreate = async (row, db) => { ... }

  constructor(db) {
    this._db        = db
    this._states    = []
    this._rng       = null
    this._seq       = 0
    this._relations = {}

    // Return a Proxy so that trait methods (defined via class instance fields
    // which run AFTER super() returns) are available immediately on the instance.
    // The Proxy intercepts unknown property lookups and calls _ensureTraits() first.
    return new Proxy(this, {
      get(target, prop, receiver) {
        // For known internal props, return directly
        if (prop in target) return Reflect.get(target, prop, receiver)
        // Unknown prop — might be a trait method not yet generated
        target._ensureTraits()
        return Reflect.get(target, prop, receiver)
      }
    })
  }

  _ensureTraits() {
    if (this._traitsSetup || !this.traits) { this._traitsSetup = true; return }
    this._traitsSetup = true
    for (const [name, override] of Object.entries(this.traits)) {
      if (!this[name]) {
        this[name] = function(extra = {}) {
          const merged = typeof override === 'function'
            ? (seq, rng) => ({ ...override(seq, rng), ...extra })
            : { ...override, ...extra }
          return this.state(merged)
        }
      }
    }
  }

  _clone() {
    this._ensureTraits()
    const clone        = new this.constructor(this._db)
    clone._states      = [...this._states]
    clone._rng         = this._rng
    clone._seq         = this._seq
    clone._relations   = { ...this._relations }
    if (this.definition && !clone.definition) clone.definition = this.definition
    if (this.model      && !clone.model)      clone.model      = this.model
    return clone
  }

  // ── Chain methods ────────────────────────────────────────────────────────────

  state(overrideOrFn) {
    const clone = this._clone()
    clone._states = [...this._states, overrideOrFn]
    return clone
  }

  seed(n) {
    const clone = this._clone()
    clone._rng  = new SeededRng(n)
    clone._seq  = 0
    return clone
  }

  /**
   * Auto-create a parent row before each create and inject its PK as a FK.
   * factory.withRelation('author', userFactory)
   * factory.withRelation('author', userFactory.admin(), 'authorId')
   */
  withRelation(name, factory, fk, pk = 'id') {
    const clone = this._clone()
    clone._relations = {
      ...this._relations,
      [name]: { row: null, factory, fk: fk ?? `${name}Id`, pk },
    }
    return clone
  }

  /**
   * Use an existing parent row — no auto-create.
   * factory.for('author', existingUser)
   */
  for(name, row, fk, pk = 'id') {
    const clone = this._clone()
    clone._relations = {
      ...this._relations,
      [name]: { row, factory: null, fk: fk ?? `${name}Id`, pk },
    }
    return clone
  }

  // ── Build (no DB) ────────────────────────────────────────────────────────────

  buildOne(overrides = {}) {
    this._seq++
    const rng     = this._rng ?? null
    // When a seed is set, derive a per-call offset from the rng so that
    // different seeds produce different seq-based values (e.g. emails).
    const seqKey  = rng ? this._seq + Math.floor(rng.next() * 1000) * 1000 : this._seq
    let data  = { ...this.definition(seqKey, rng) }
    for (const s of this._states)
      Object.assign(data, typeof s === 'function' ? s(seqKey, rng) : s)
    Object.assign(data, typeof overrides === 'function' ? overrides(seqKey, rng) : overrides)
    return data
  }

  buildMany(count, overrides = {}) {
    return Array.from({ length: count }, (_, i) =>
      this.buildOne(typeof overrides === 'function' ? overrides(i) : overrides)
    )
  }

  // ── Create (with DB) ─────────────────────────────────────────────────────────

  async createOne(overrides = {}) {
    // Resolve relations — auto-create parents, collect FK values
    const fkOverrides = {}
    for (const [, rel] of Object.entries(this._relations)) {
      let parentRow = rel.row
      if (!parentRow && rel.factory) {
        parentRow = await rel.factory.createOne()
        rel.row   = parentRow   // cache — createMany shares one parent per relation
      }
      if (parentRow) fkOverrides[rel.fk] = parentRow[rel.pk]
    }

    const resolvedOverrides = typeof overrides === 'function'
      ? overrides(this._seq + 1, this._rng)
      : overrides
    const data = this.buildOne({ ...fkOverrides, ...resolvedOverrides })
    const row  = await this._db[modelToAccessor(this.model)].create({ data })

    // afterCreate hook
    const hook = this.afterCreate ?? this.constructor.prototype.afterCreate
    if (hook) await hook.call(this, row, this._db)

    // Attach resolved relation rows for convenience (no extra query)
    for (const [name, rel] of Object.entries(this._relations)) {
      if (rel.row) row[name] = rel.row
    }

    return row
  }

  async createMany(count, overrides = {}) {
    const rows = []
    for (let i = 0; i < count; i++) {
      const o = typeof overrides === 'function' ? overrides(i) : overrides
      rows.push(await this.createOne(o))
    }
    return rows
  }

  build(n, o)  { return n != null ? this.buildMany(n, o)  : this.buildOne(o) }
  create(n, o) { return n != null ? this.createMany(n, o) : this.createOne(o) }

  /** Hard-delete all rows in this factory's model table. */
  async truncate() {
    await this._db.asSystem()[modelToAccessor(this.model)].deleteMany({})
  }
}

// ─── Seeder ───────────────────────────────────────────────────────────────────

export class Seeder {
  async call(db, seederClasses) {
    for (const SeederClass of seederClasses) {
      await new SeederClass().run(db)
    }
  }

  /**
   * Idempotent seed block — only runs fn if key hasn't run before.
   * Records run history in _litestone_seeds table.
   */
  async once(db, key, fn) {
    const raw = db.$db ?? db.$rawDbs?.main ?? null
    if (!raw) throw new Error('once() requires a raw db connection via db.$db')

    raw.run(`CREATE TABLE IF NOT EXISTS "_litestone_seeds" (
      "key"    TEXT PRIMARY KEY,
      "ran_at" TEXT NOT NULL
    ) STRICT`)

    const existing = raw.prepare('SELECT key FROM "_litestone_seeds" WHERE key = ?').get(key)
    if (existing) return

    await fn()

    raw.run(
      'INSERT INTO "_litestone_seeds" (key, ran_at) VALUES (?, ?)',
      key, new Date().toISOString()
    )
  }
}

export async function runSeeder(db, SeederClass) {
  await new SeederClass().run(db)
}
