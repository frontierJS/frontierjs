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

/** Rebuild-and-retry budget for a UNIQUE collision on a generated value. */
const UNIQUE_RETRIES = 5

function _isUniqueViolation(e) {
  const msg = String(e?.message ?? '')
  return /UNIQUE constraint failed/i.test(msg) || e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
}


export class Factory {
  // Subclasses declare:
  //   model = 'tableName'
  //   traits = { admin: { role: 'admin' }, ... }
  //   afterCreate = async (row, db) => { ... }

  constructor(db) {
    this._db          = db
    this._states      = []
    this._rng         = null
    this._seq         = 0
    this._relations   = {}
    this._children    = []    // hasMany — created AFTER the row, FK pointed back
    this._attachments = []    // implicit m2m — connected AFTER the row
    // Set by factoryFrom()/makeTestClient(). Without them, has()/attach()/
    // withParents() need their target factory passed explicitly.
    this._schema      = null
    this._registry    = null

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
    clone._children    = [...this._children]
    clone._attachments = [...this._attachments]
    clone._schema      = this._schema
    clone._registry    = this._registry
    if (this.definition && !clone.definition) clone.definition = this.definition
    if (this.model      && !clone.model)      clone.model      = this.model
    return clone
  }

  // ── Schema lookups — only available when _schema was supplied ────────────────

  _modelDef(name = this.model) {
    return this._schema?.models?.find(m => m.name === name) ?? null
  }

  /**
   * The factory for a model name: explicit wins, else the registry.
   * Registry factories are rebound to THIS factory's client, so `asSystem()` (or
   * any `usingDb`) propagates through the whole graph — otherwise seeding a gated
   * schema failed on the first parent, which is bound to the gated client.
   */
  _factoryFor(modelName, explicit) {
    const f = explicit ?? this._registry?.[modelToAccessor(modelName)]
    if (!f) {
      throw new Error(
        `Factory(${this.model}): no factory for "${modelName}". Pass one explicitly ` +
        `— e.g. .has('field', 2, { factory: ${modelToAccessor(modelName)}Factory }) — ` +
        `or build the factories with makeTestClient({ autoFactories: true }).`
      )
    }
    return f._db === this._db ? f : f.usingDb(this._db)
  }

  /** Name of a model's @id field. */
  _pkOf(modelName) {
    const def = this._modelDef(modelName)
    return def?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
  }

  /**
   * The FK column on `childModel` that points back at `parentModel`.
   * Ambiguous when the child declares two relations to the same parent — that
   * needs an explicit `fk`, so say which ones rather than picking one.
   */
  _backReference(childModel, parentModel) {
    const def = this._modelDef(childModel)
    if (!def) return null
    const candidates = def.fields
      .filter(f => f.type.kind === 'relation' && !f.type.array && f.type.name === parentModel)
      .map(f => f.attributes.find(a => a.kind === 'relation' && a.fields))
      .filter(Boolean)
    if (!candidates.length) return null
    if (candidates.length > 1) {
      const names = candidates.map(c => c.fields[0]).join(', ')
      throw new Error(
        `Factory(${this.model}): "${childModel}" has more than one relation to ` +
        `"${parentModel}" (${names}) — pass { fk: '…' } to say which.`
      )
    }
    return { fk: candidates[0].fields[0], pk: candidates[0].references?.[0] ?? 'id' }
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

  /** Run against a different client — the whole wired graph follows. */
  usingDb(db) {
    const clone = this._clone()
    clone._db   = db
    return clone
  }

  /**
   * Seed past the Data boundary. A schema declaring any `@@gate` auto-installs
   * GatePlugin, so an unauthenticated factory grades STRANGER and cannot create
   * anything — seeding is a system concern, not a user one.
   */
  asSystem() {
    return this.usingDb(this._db.asSystem())
  }

  /** Seed as a specific principal — gates and policies see it. */
  actingAs(user) {
    return this.usingDb(this._db.$setAuth(user))
  }

  /**
   * Auto-create a parent row before each create and inject its PK as a FK.
   * factory.withRelation('author', userFactory)
   * factory.withRelation('author', userFactory.admin(), 'authorId')
   *
   * One parent is shared by every row of a createMany. Pass { fresh: true } for a
   * new parent per row.
   */
  withRelation(name, factory, fk, pk = 'id', opts = {}) {
    const clone = this._clone()
    clone._relations = {
      ...this._relations,
      [name]: { row: null, factory, fk: fk ?? `${name}Id`, pk, fresh: opts.fresh === true },
    }
    return clone
  }

  /**
   * Auto-create a parent for EVERY required belongsTo relation the schema declares,
   * recursively, so a model deep in a graph is creatable in one call. Requires the
   * schema + registry that makeTestClient({ autoFactories: true }) supplies.
   *
   * An Int FK falls back to 1 without this; a String/uuid FK cannot fall back at
   * all, which is why a uuid-keyed schema could not be auto-seeded before.
   *
   *   factories.deployment.withParents().createOne()
   *
   * `pins` reuses rows you already have instead of creating them, keyed by MODEL
   * name, and it applies at every depth — which is the point. `.for()` wires one
   * relation on THIS model, so it cannot reach an Account five hops up a chain;
   * a pin rides the recursion down and is consulted wherever that model is the
   * required parent.
   *
   *   factories.deployment.withParents({ pins: { Account: acct, Workspace: ws } })
   *
   * A pin is also the only cure for a required cyclic relation, so pins are
   * consulted before the cycle check rather than after it.
   *
   * opts: { depth = 10, optional = false, fresh = false, pins = {} }
   *   optional: also create parents for nullable relations (default: skip them).
   */
  withParents(opts = {}) {
    // `_seen` is what terminates recursion (cycles cannot be satisfied by more
    // rows); depth is only a backstop, so it is generous — basecamp's deepest
    // chain is DeploymentStep → Deployment → App → Environment → Project →
    // Workspace → Account, and a shallow default silently left the last FK unwired.
    const { depth = 10, optional = false, fresh = false, pins = {}, _seen = new Set() } = opts
    const def = this._modelDef()
    if (!def) {
      throw new Error(
        `Factory(${this.model}): withParents() needs the parsed schema — build ` +
        `factories with makeTestClient({ autoFactories: true }) or factoryFrom().`
      )
    }
    if (depth <= 0) return this

    let clone = this
    const seen = new Set([..._seen, this.model])

    for (const field of def.fields) {
      if (field.type.kind !== 'relation' || field.type.array) continue
      const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
      if (!rel) continue
      const fk     = rel.fields[0]
      const fkDef  = def.fields.find(f => f.name === fk)
      if (!optional && fkDef?.type.optional) continue
      const pk = rel.references?.[0] ?? 'id'

      // Both of these must be checked BEFORE the cycle guard, because both are
      // the cure the guard's own message recommends. Ordered above it, .for()
      // now works as advertised — it did not, and following the advice threw
      // the identical error.
      if (clone._relations[field.name]) continue   // already wired explicitly
      const pinned = pins[field.type.name]
      if (pinned) {
        clone = clone.for(field.name, pinned, fk, pk)
        continue
      }

      // A cycle (self-reference, or A→B→A) cannot be satisfied by creating more
      // rows — each new parent needs a parent. Say so, rather than skipping
      // silently and letting it surface as an opaque FOREIGN KEY failure.
      if (seen.has(field.type.name)) {
        throw new Error(
          `Factory(${this.model}): "${field.name}" is a required relation to ` +
          `"${field.type.name}", which is already in this parent chain ` +
          `(${[...seen].join(' → ')}). A cycle cannot be satisfied by creating more rows — ` +
          `create the root first and pass it: .for('${field.name}', rootRow, '${fk}'), ` +
          `pin it for the whole chain: withParents({ pins: { ${field.type.name}: rootRow } }), ` +
          `or make ${fk} optional.`
        )
      }

      const parent = this._factoryFor(field.type.name)
        .withParents({ ...opts, depth: depth - 1, _seen: seen })
      clone = clone.withRelation(field.name, parent, fk, pk, { fresh })
    }
    return clone
  }

  /**
   * Create hasMany children after the row, with their FK pointed back at it.
   *
   *   factories.author.has('posts', 3).createOne()
   *   factories.author.has('posts', 3, { overrides: { published: true } })
   *   factories.author.has('posts', 3, { factory: draftPosts, fk: 'writerId' })
   */
  has(name, count = 1, opts = {}) {
    const clone = this._clone()
    clone._children = [...this._children, { name, count, ...opts }]
    return clone
  }

  /**
   * Connect implicit many-to-many rows after the row is created. Takes a count
   * (rows are generated) or existing rows.
   *
   *   factories.post.attach('tags', 3).createOne()
   *   factories.post.attach('tags', [tagA, tagB]).createOne()
   */
  attach(name, countOrRows = 1, opts = {}) {
    const clone = this._clone()
    clone._attachments = [...this._attachments, { name, countOrRows, ...opts }]
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
      let parentRow = rel.fresh ? null : rel.row
      if (!parentRow && rel.factory) {
        parentRow = await rel.factory.createOne()
        // cache — createMany shares one parent per relation unless { fresh: true }
        if (!rel.fresh) rel.row = parentRow
        else            rel.row = parentRow   // still exposed on the returned row
      }
      if (parentRow) fkOverrides[rel.fk] = parentRow[rel.pk]
    }

    const resolvedOverrides = typeof overrides === 'function'
      ? overrides(this._seq + 1, this._rng)
      : overrides

    // Generated values carry a short seq token, so a @unique column is unique by
    // construction — but the token pool is finite and the value catalogue is small,
    // so at scale two rows can still collide. Rebuilding advances the seq, which
    // changes every generated value; retry rather than fail a 5000-row seed.
    let row
    for (let attempt = 0; ; attempt++) {
      const data = this.buildOne({ ...fkOverrides, ...resolvedOverrides })
      try {
        row = await this._db[modelToAccessor(this.model)].create({ data })
        break
      } catch (e) {
        if (attempt >= UNIQUE_RETRIES || !_isUniqueViolation(e)) throw e
      }
    }

    // afterCreate hook
    const hook = this.afterCreate ?? this.constructor.prototype.afterCreate
    if (hook) await hook.call(this, row, this._db)

    // Attach resolved relation rows for convenience (no extra query)
    for (const [name, rel] of Object.entries(this._relations)) {
      if (rel.row) row[name] = rel.row
    }

    await this._createChildren(row)
    await this._connectAttachments(row)

    return row
  }

  /** hasMany — children are created after the parent, with the FK pointed back. */
  async _createChildren(row) {
    for (const child of this._children) {
      const field = this._modelDef()?.fields.find(f => f.name === child.name)
      if (!field || field.type.kind !== 'relation' || !field.type.array) {
        throw new Error(`Factory(${this.model}): has('${child.name}') — no hasMany relation by that name.`)
      }
      const childModel = field.type.name
      const factory    = this._factoryFor(childModel, child.factory)
      // Only resolve the back-reference when the caller has not named the FK —
      // an ambiguous relation is an error to guess at, not to report once answered.
      const back = child.fk ? null : this._backReference(childModel, this.model)
      const fk   = child.fk ?? back?.fk
      const pk   = child.pk ?? back?.pk ?? this._pkOf(this.model)
      if (!fk) {
        throw new Error(
          `Factory(${this.model}): has('${child.name}') — "${childModel}" declares no ` +
          `relation back to "${this.model}". Pass { fk: '…' }.`
        )
      }
      const overrides = { ...(child.overrides ?? {}), [fk]: row[pk] }
      row[child.name] = await factory.createMany(child.count, overrides)
    }
  }

  /** Implicit m2m — the client takes `{ field: { connect: [{ pk }] } }` on update. */
  async _connectAttachments(row) {
    for (const att of this._attachments) {
      const field = this._modelDef()?.fields.find(f => f.name === att.name)
      if (!field || field.type.kind !== 'implicitM2M') {
        throw new Error(`Factory(${this.model}): attach('${att.name}') — no many-to-many relation by that name.`)
      }
      const targetPk = this._pkOf(field.type.name)
      const rows = Array.isArray(att.countOrRows)
        ? att.countOrRows
        : await this._factoryFor(field.type.name, att.factory).createMany(att.countOrRows, att.overrides ?? {})

      const selfPk = this._pkOf(this.model)
      await this._db[modelToAccessor(this.model)].update({
        where: { [selfPk]: row[selfPk] },
        data:  { [att.name]: { connect: rows.map(r => ({ [targetPk]: r[targetPk] })) } },
      })
      row[att.name] = rows
    }
  }

  async createMany(count, overrides = {}) {
    const rows = []
    for (let i = 0; i < count; i++) {
      const o = typeof overrides === 'function' ? overrides(i) : overrides
      rows.push(await this.createOne(o))
    }
    return rows
  }

  // build()/create() overload on the FIRST argument:
  //   create(3)             → 3 rows
  //   create(3, overrides)  → 3 rows with overrides
  //   create(overrides)     → 1 row  (overrides object or function — no count)
  //   create()              → 1 row
  // A non-numeric first argument is overrides, never a count. Treating it as a
  // count silently produced [] — `Array.from({length: {}})` is empty.
  build(n, o) {
    return typeof n === 'number' ? this.buildMany(n, o) : this.buildOne(n ?? o)
  }

  create(n, o) {
    return typeof n === 'number' ? this.createMany(n, o) : this.createOne(n ?? o)
  }

  /** Hard-delete all rows in this factory's model table. */
  async truncate() {
    await this._db.asSystem()[modelToAccessor(this.model)].deleteMany({})
  }
}

// ─── defineFactory ────────────────────────────────────────────────────────────
//
// The same Factory without the class ceremony. Returns a CLASS, so it drops
// straight into `makeTestClient({ factories: { user: UserFactory } })`.
//
//   const UserFactory = defineFactory({
//     model: 'User',
//     definition: (seq, rng) => ({ email: `u${seq}@x.com`, role: 'member' }),
//     traits:     { admin: { role: 'admin' } },
//     afterCreate: async (row, db) => { … },
//   })
//
//   new UserFactory(db).admin().createMany(3)
//
// A subclass declares `traits` as an instance field, which initialises only AFTER
// super() returns — that is the sole reason Factory's constructor returns a Proxy.
// Here everything is known up front, so traits are installed in the constructor and
// the Proxy never has to fire.

export function defineFactory(spec = {}) {
  const { model, definition, traits, afterCreate, ...rest } = spec
  if (!model)      throw new Error('defineFactory: `model` is required (PascalCase singular, as the schema declares it)')
  if (!definition) throw new Error(`defineFactory(${model}): \`definition\` is required — (seq, rng) => ({ … })`)

  return class extends Factory {
    constructor(db) {
      super(db)
      this.model      = model
      this.definition = definition
      if (traits)      this.traits      = traits
      if (afterCreate) this.afterCreate = afterCreate
      Object.assign(this, rest)
      this._ensureTraits()
      return this
    }
  }
}

// ─── Seeder ───────────────────────────────────────────────────────────────────

export class Seeder {
  /**
   * Run other seeders. Each class runs AT MOST ONCE per call(), and its
   * `static dependsOn = [OtherSeeder]` runs first — so a seeder can name what it
   * needs instead of every caller having to know the whole order.
   *
   *   class OrderSeeder extends Seeder {
   *     static dependsOn = [AccountSeeder, ProductSeeder]
   *     async run(db) { … }
   *   }
   *   await new DatabaseSeeder().call(db, [OrderSeeder])   // seeds all three, in order
   */
  async call(db, seederClasses) {
    for (const SeederClass of _orderSeeders(seederClasses, this._ran ??= new Set())) {
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Reference data — countries, plans, currencies — is authored, not generated. It
// belongs in a file next to the schema, not in a factory.
//
//   await loadFixture(db, 'Country', './db/fixtures/countries.json')
//   await loadFixture(db, 'Plan',    './db/fixtures/plans.csv', { upsert: 'code' })
//   await loadFixture(db, 'Plan',    [{ code: 'pro', price: 20 }])
//
// Rows go through the ORM, so defaults, validators, `@encrypted` and hooks all
// apply — a fixture is an ordinary write, unlike restore().

export async function loadFixture(db, modelName, source, opts = {}) {
  const { upsert = null, asSystem = false } = opts
  const rows   = typeof source === 'string' ? await _readFixture(source) : source
  if (!Array.isArray(rows)) throw new Error(`loadFixture(${modelName}): expected an array of rows, got ${typeof rows}`)
  if (!rows.length) return []

  const client   = asSystem ? db.asSystem() : db
  const accessor = modelToAccessor(modelName)
  // An unknown accessor throws from the client proxy itself, and its message
  // already lists the tables that do exist — no guard needed here.
  const table    = client[accessor]

  const out = []
  for (const row of rows) {
    if (upsert) {
      if (!(upsert in row)) throw new Error(`loadFixture(${modelName}): upsert key "${upsert}" missing from a row`)
      out.push(await table.upsert({ where: { [upsert]: row[upsert] }, create: row, update: row }))
    } else {
      out.push(await table.create({ data: row }))
    }
  }
  return out
}

async function _readFixture(path) {
  // Extension first — otherwise an unsupported one surfaces as ENOENT from the
  // read, which points at the wrong problem.
  if (!path.endsWith('.json') && !path.endsWith('.csv'))
    throw new Error(`loadFixture: unsupported fixture "${path}" — use .json or .csv`)

  const { readFile } = await import('fs/promises')
  const text = await readFile(path, 'utf8')
  if (path.endsWith('.json')) {
    const parsed = JSON.parse(text)
    // A top-level object keyed by model is a common shape; take the array either way.
    return Array.isArray(parsed) ? parsed : Object.values(parsed).find(Array.isArray) ?? []
  }
  return parseCsv(text)
}

/**
 * Minimal RFC-4180 CSV: quoted fields, embedded commas/newlines, "" escapes.
 * Unquoted `true`/`false`/numbers/empty are coerced; quoted values stay strings,
 * which is how a fixture says "this really is the text 0123".
 */
export function parseCsv(text) {
  const rows    = []
  let row       = []
  let field     = ''
  let quoted    = false
  let wasQuoted = false
  let i         = 0

  const endField = () => { row.push(wasQuoted ? field : _coerceCsv(field)); field = ''; wasQuoted = false }
  const endRow   = () => { endField(); rows.push(row); row = [] }

  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  while (i < src.length) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue }
      if (c === '"') { quoted = false; i++; continue }
      field += c; i++; continue
    }
    if (c === '"' && field === '') { quoted = true; wasQuoted = true; i++; continue }
    if (c === ',')  { endField(); i++; continue }
    if (c === '\n') { endRow();   i++; continue }
    field += c; i++
  }
  if (field !== '' || row.length) endRow()

  const [header, ...body] = rows.filter(r => r.length && !(r.length === 1 && r[0] === ''))
  if (!header) return []
  return body.map(cells =>
    Object.fromEntries(header.map((h, idx) => [String(h), cells[idx] ?? null])))
}

function _coerceCsv(v) {
  if (v === '')      return null
  if (v === 'true')  return true
  if (v === 'false') return false
  if (v === 'null')  return null
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v)
  return v
}

export async function runSeeder(db, SeederClass) {
  const deps = _orderSeeders([SeederClass], new Set())
  for (const S of deps) await new S().run(db)
}

/**
 * Depth-first order over `static dependsOn`, deduplicated against `ran`.
 * A dependency cycle is an authoring mistake, not something to resolve — name the
 * classes in it rather than silently dropping one.
 */
function _orderSeeders(classes, ran) {
  const out   = []
  const stack = []

  const visit = (S) => {
    if (ran.has(S)) return
    if (stack.includes(S)) {
      const names = [...stack.slice(stack.indexOf(S)), S].map(c => c.name || '<anonymous>')
      throw new Error(`Seeder dependency cycle: ${names.join(' → ')}`)
    }
    stack.push(S)
    for (const dep of S.dependsOn ?? []) visit(dep)
    stack.pop()
    ran.add(S)
    out.push(S)
  }

  for (const S of classes) visit(S)
  return out
}
