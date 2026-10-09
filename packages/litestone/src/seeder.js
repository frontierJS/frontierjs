// src/seeder.js — Factory + Seeder system for Litestone

import { modelToAccessor } from './core/ddl.js'
import { ValidationError } from './core/validate.js'
import { UniqueConflictError, ForeignKeyError } from './core/errors.js'
import { parseCell } from '@frontierjs/toolbelt/cells'
import { minorUnits } from '@frontierjs/toolbelt/units'

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

/** `fk`/`pk` as given to withRelation()/for(), paired by position. */
function _keyPairs(fk, pk) {
  const fks = [].concat(fk), pks = [].concat(pk)
  return fks.map((f, i) => [f, pks[i] ?? 'id'])
}

function _isUniqueViolation(e) {
  const msg = String(e?.message ?? '')
  // The client translates a live conflict before it gets here and the new
  // message does not carry SQLite's wording, which is the point of it.
  return e?.name === 'UniqueConflictError'
    || /UNIQUE constraint failed/i.test(msg) || e?.code === 'SQLITE_CONSTRAINT_UNIQUE'
}


// ─── A row asked for further along its state machine ─────────────────────────
//
// A row under @@transitions starts at its @default whoever creates it
// (`FJS-D470`), so a definition naming another state would refuse every
// create. The factory creates the row at the entry and makes the declared moves
// that reach the state: the fewest moves, the first declared on a tie, never a
// @gate(9) move. They are ordinary moves, graded on the factory's client,
// announced and audited like any other.

function _statePath(transitions, from, to) {
  const prev  = new Map([[from, null]])
  const queue = [from]
  while (queue.length && !prev.has(to)) {
    const at = queue.shift()
    for (const [name, t] of Object.entries(transitions)) {
      if (t.gate === 9 || !t.from.includes(at) || prev.has(t.to)) continue
      prev.set(t.to, { from: at, move: name })
      queue.push(t.to)
    }
  }
  if (!prev.has(to)) return null
  const moves = []
  for (let s = to; prev.get(s); s = prev.get(s).from) moves.unshift(prev.get(s).move)
  return moves
}

// Takes the states out of `data` and answers the moves to make once the row
// exists. Throws, naming the state, when no declared move leads there.
function _machineWalk(schema, modelName, data) {
  const model = schema?.models?.find(m => m.name === modelName)
  const moves = []
  for (const attr of model?.attributes ?? []) {
    if (attr.kind !== 'transitions' || data[attr.field] == null) continue
    const entry = model.fields.find(f => f.name === attr.field)
      ?.attributes.find(a => a.kind === 'default')?.value?.value
    const want  = data[attr.field]
    if (want === entry) continue
    const path = _statePath(attr.transitions, entry, want)
    if (!path) throw new Error(
      `Factory(${modelName}): no declared move leads from '${entry}' to '${want}' on ${attr.field}. ` +
      `A row starts at its @default; create it there and put it where no move leads with db.asSystem().sql.`)
    delete data[attr.field]
    moves.push(...path)
  }
  return moves
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
    // A box, shared by every clone of this factory, so one model has ONE counter:
    // a Customer built inside withParents() and one built at the top otherwise
    // both drew seq 1 and collided on every @unique column (`FJS-1779`).
    this._seq         = { n: 0 }
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
    clone._seq  = { n: 0 }
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
   * new parent per row. `fk` and `pk` are arrays for a composite relation —
   * `@relation(fields: [projectId, teamId], references: [id, teamId])` — paired
   * by position.
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

    // A composite relation sets every column of its key, so a single-column
    // relation over one of those columns — Deployment.team beside
    // Deployment.project over [projectId, teamId] — would point the column at a
    // second, unrelated parent. Composites are wired first and claim their columns.
    const rels = []
    for (const field of def.fields) {
      if (field.type.kind !== 'relation' || field.type.array) continue
      const rel = field.attributes.find(a => a.kind === 'relation' && a.fields)
      if (!rel) continue
      rels.push({ field, fks: rel.fields, pks: rel.fields.map((_, i) => rel.references?.[i] ?? 'id') })
    }
    rels.sort((a, b) => b.fks.length - a.fks.length)

    // `@@arc([a, b])` wants exactly one of two nullable columns set, and the
    // nullable skip below would leave both null. The first named is the one wired.
    const arcFirst = new Set((def.attributes ?? [])
      .filter(a => a.kind === 'arc' && !a.optional)
      .map(a => a.fields[0]))

    const claimed  = new Set()
    const pinnedTo = new Set()
    for (const { field, fks, pks } of rels) {
      const fkDefs   = fks.map(fk => def.fields.find(f => f.name === fk))
      const nullable = fkDefs.some(f => f?.type.optional)
      // A nullable FK the schema still insists on — the arc's first column, or
      // one under `@required(where:)` — gets a parent whatever `optional` says.
      const insisted = arcFirst.has(fks[0]) ||
        fkDefs.some(f => f?.attributes.some(a => a.kind === 'required'))
      if (nullable && !optional && !insisted) continue
      if (fks.some(fk => claimed.has(fk))) continue
      if (clone._relations[field.name]) {           // already wired explicitly
        for (const fk of fks) claimed.add(fk)
        continue
      }

      // Both of these must be checked BEFORE the cycle guard, because both are
      // the cure the guard's own message recommends.
      //
      // A pin satisfies ONE relation to its model. Two relations to the same
      // parent given one pinned row are the same row twice, which
      // `@@check("issueId <> relatedIssueId")` refuses, so the second gets a
      // parent of its own — unless only the pin can break a cycle.
      const pinned = pins[field.type.name]
      const cyclic = seen.has(field.type.name)
      if (pinned && (!pinnedTo.has(field.type.name) || cyclic)) {
        pinnedTo.add(field.type.name)
        clone = clone.for(field.name, pinned, fks, pks)
        for (const fk of fks) claimed.add(fk)
        continue
      }

      // A cycle (self-reference, or A→B→A) cannot be satisfied by creating more
      // rows — each new parent needs a parent. Say so, rather than skipping
      // silently and letting it surface as an opaque FOREIGN KEY failure.
      if (cyclic) {
        throw new Error(
          `Factory(${this.model}): "${field.name}" is a required relation to ` +
          `"${field.type.name}", which is already in this parent chain ` +
          `(${[...seen].join(' → ')}). A cycle cannot be satisfied by creating more rows — ` +
          `create the root first and pass it: .for('${field.name}', rootRow, '${fks[0]}'), ` +
          `pin it for the whole chain: withParents({ pins: { ${field.type.name}: rootRow } }), ` +
          `or make ${fks[0]} optional.`
        )
      }

      const parent = this._factoryFor(field.type.name)
        .withParents({ ...opts, depth: depth - 1, _seen: seen })
      clone = clone.withRelation(field.name, parent, fks, pks, { fresh })
      for (const fk of fks) claimed.add(fk)
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
    const seq     = ++this._seq.n
    const rng     = this._rng ?? null
    // When a seed is set, derive a per-call offset from the rng so that
    // different seeds produce different seq-based values (e.g. emails).
    const seqKey  = rng ? seq + Math.floor(rng.next() * 1000) * 1000 : seq
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
      if (parentRow) for (const [fk, pk] of _keyPairs(rel.fk, rel.pk)) fkOverrides[fk] = parentRow[pk]
    }

    const resolvedOverrides = typeof overrides === 'function'
      ? overrides(this._seq.n + 1, this._rng)
      : overrides

    // Generated values carry a short seq token, so a @unique column is unique by
    // construction — but the token pool is finite and the value catalog is small,
    // so at scale two rows can still collide. Rebuilding advances the seq, which
    // changes every generated value; retry rather than fail a 5000-row seed.
    let row, moves
    const table = this._db[modelToAccessor(this.model)]
    for (let attempt = 0; ; attempt++) {
      const data = this.buildOne({ ...fkOverrides, ...resolvedOverrides })
      moves = _machineWalk(this._db.$schema ?? this._schema, this.model, data)
      try {
        row = await table.create({ data })
        break
      } catch (e) {
        if (attempt >= UNIQUE_RETRIES || !_isUniqueViolation(e)) throw e
      }
    }
    if (moves.length) {
      const pkField = (this._db.$schema ?? this._schema)?.models?.find(m => m.name === this.model)
        ?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
      const pk = row[pkField]
      for (const move of moves) Object.assign(row, await table.transition(pk, move))
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
// A subclass declares `traits` as an instance field, which initializes only AFTER
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

// ─── Loading rows from outside ────────────────────────────────────────────────
//
// Data somebody else wrote — a CSV dropped by another system, a page of an
// API's records — read against the schema, row by row:
//
//   const { loaded, rejects } = await loadRows(db.asSystem(), 'Order', csvText, { key: 'id' })
//
// A cell that is not its column's type is a REJECT, with the row's position,
// the column and a reason, and the load goes on: one bad row in 5,000 must not
// cost the other 4,999. Every input row is either loaded or rejected, and a
// reason never quotes the cell — the text may be what the column encrypts, and
// a reject is stored and shown where that protection does not reach.
//
// What is NOT a reject is a mapping mistake — a header naming no column, a
// required column the file does not carry. Every row would be rejected for the
// same reason, so it throws before any row is read.
//
// Rows go through the ORM in batches, so defaults, validators, `@encrypted`
// and plugins all apply; a batch the database refuses is retried a row at a
// time, each under its own savepoint, so the refusal lands on its row.
//
//   mode 'insert'   the default; a key repeated in the source is a reject
//   mode 'upsert'   on `key`, which is required; a repeat updates the row
//   mode 'replace'  every stored row deleted and the source inserted, in one
//                   transaction, so a reader sees the old rows or the new
//   dryRun          the whole load, rolled back: what WOULD land, exactly
//   stamp           columns every loaded row carries — which load wrote it,
//                   and when — that the source has no column for; a source
//                   that names one is a mapping mistake, not a value to keep

const LOAD_MODES = ['insert', 'upsert', 'replace']
// Not a column a source can fill: the engine or the schema computes it.
const DERIVED = new Set(['computed', 'from', 'generated', 'derived', 'sequence', 'updatedAt'])
const DRY_RUN = Symbol('loadRows.dryRun')

export async function loadRows(db, modelName, source, opts = {}) {
  const { key = null, mode = 'insert', dryRun = false, stamp = {}, batch = 1000, overflow = null } = opts
  if (!LOAD_MODES.includes(mode))
    throw new Error(`loadRows(${modelName}): mode is one of ${LOAD_MODES.join(', ')}, got '${mode}'`)
  if (mode === 'upsert' && !key)
    throw new Error(`loadRows(${modelName}): mode 'upsert' needs a key to upsert on`)

  const schema = db.$schema
  const model  = schema?.models?.find(m => m.name === modelName)
  if (!model) throw new Error(`loadRows: '${modelName}' is not a model in this schema`)
  if (key && !model.fields.some(f => f.name === key))
    throw new Error(`loadRows(${modelName}): key '${key}' is not a column of ${modelName}`)

  const fromText = typeof source === 'string'
  const { header, records, lines } = fromText ? readCsv(source) : { header: null, records: source, lines: null }
  if (!Array.isArray(records))
    throw new Error(`loadRows(${modelName}): expected CSV text or an array of records, got ${typeof source}`)

  const columns = columnReader(model, schema, modelName, overflow)
  for (const name of Object.keys(stamp)) columns.of(name)
  if (overflow && overflow in stamp)
    throw new Error(`loadRows(${modelName}): '${overflow}' is the overflow column, so this load cannot also stamp it`)
  if (header) {
    for (const h of header) {
      if (h === overflow) throw new Error(`loadRows(${modelName}): the file has a column '${h}', which this load fills with what no column takes`)
      if (columns.overflows(h)) continue
      columns.of(h)
      if (h in stamp) throw new Error(`loadRows(${modelName}): the file has a column '${h}', which this load stamps`)
    }
    const missing = model.fields.filter(f => columns.required(f) && !header.includes(f.name) && !(f.name in stamp)).map(f => f.name)
    if (missing.length)
      throw new Error(`loadRows(${modelName}): the file has no column for ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} required and ${missing.length > 1 ? 'have' : 'has'} no default`)
  }

  const rejects = []
  const where   = (i) => (lines ? { row: i, line: lines[i] } : { row: i })
  const reject  = (i, field, reason, keyValue) =>
    rejects.push({ ...where(i), key: keyValue == null ? null : String(keyValue), field, reason })

  // Read every row before writing any, so a repeated key is decided by
  // position in the source and not by which batch a row happened to fall in.
  const ready = []
  const firstAt = new Map()
  for (let i = 0; i < records.length; i++) {
    const named = Object.keys(stamp).find(k => records[i] && k in records[i])
    if (named) throw new Error(`loadRows(${modelName}): row ${i} names '${named}', which this load stamps`)
    if (overflow && !header && records[i] && overflow in records[i])
      throw new Error(`loadRows(${modelName}): row ${i} names '${overflow}', which this load fills with what no column takes`)
    const out = columns.read(records[i], stamp)
    const keyValue = key ? (out.data?.[key] ?? records[i]?.[key]) : null
    if (out.reason) { reject(i, out.field, out.reason, keyValue); continue }
    if (key) {
      if (out.data[key] == null) { reject(i, key, 'required: it is the key', null); continue }
      const k = String(out.data[key])
      if (mode !== 'upsert' && firstAt.has(k)) {
        const first = firstAt.get(k)
        reject(i, key, `repeats the key of ${lines ? `line ${lines[first]}` : `row ${first}`}`, k)
        continue
      }
      if (!firstAt.has(k)) firstAt.set(k, i)
    }
    ready.push({ i, data: out.data, keyValue })
  }

  const accessor = modelToAccessor(modelName)
  let loaded = 0
  const write = async (tx, rows) => {
    const data = rows.map(r => r.data)
    if (mode === 'upsert') await tx[accessor].upsertMany({ data, conflictTarget: [key] })
    else                   await tx[accessor].createMany({ data })
  }

  const run = async (tx) => {
    if (mode === 'replace') await tx[accessor].deleteMany({ where: {} })
    for (const group of batches(ready, batch, mode === 'upsert' ? key : null)) {
      try {
        await tx.$transaction(t => write(t, group))
        loaded += group.length
      } catch (e) {
        if (!refusesARow(e)) throw e
        for (const r of group) {
          try { await tx.$transaction(t => write(t, [r])); loaded++ }
          catch (err) {
            if (!refusesARow(err)) throw err
            const why = reasonFor(err)
            reject(r.i, why.field, why.reason, r.keyValue)
          }
        }
      }
    }
    if (dryRun) throw DRY_RUN
  }

  try { await db.$transaction(run) }
  catch (e) { if (e !== DRY_RUN) throw e }

  rejects.sort((a, b) => a.row - b.row)
  return { loaded, rejects }
}

// Consecutive slices of `size`; under upsert a slice also closes before a key
// it already holds, because one statement may not touch a row twice.
function* batches(rows, size, key) {
  let group = [], keys = new Set()
  for (const r of rows) {
    const k = key ? String(r.data[key]) : null
    if (group.length >= size || (k !== null && keys.has(k))) { yield group; group = []; keys = new Set() }
    group.push(r)
    if (k !== null) keys.add(k)
  }
  if (group.length) yield group
}

// The refusals that are about one row's values. Anything else — a gate, a
// closed client, a disk — is about the load, and is thrown.
function refusesARow(e) {
  return e instanceof ValidationError || e instanceof UniqueConflictError || e instanceof ForeignKeyError
    || /constraint failed/i.test(e?.message ?? '')
}

// In the reject's own words, because the errors' words quote the value: a
// conflict names what is taken, a foreign key the id it could not find.
function reasonFor(e) {
  if (e instanceof UniqueConflictError)
    return { field: e.fields?.join(' + ') || null, reason: 'already taken by a stored row' }
  if (e instanceof ForeignKeyError)
    return { field: Array.isArray(e.field) ? e.field.join(' + ') : e.field ?? null, reason: `names no ${e.target ?? 'row'}` }
  if (e instanceof ValidationError) {
    const first = e.errors?.[0]
    return { field: first?.path?.at(-1) ?? null, reason: e.errors.map(x => x.message).join('; ') }
  }
  const check = /CHECK constraint failed: (.*)$/i.exec(e?.message ?? '')
  return { field: null, reason: check ? `breaks the check ${check[1]}` : 'refused by the database' }
}

// What each column is, read once per column name, and how to read a row by it.
function columnReader(model, schema, modelName, overflow) {
  const byName = new Map(model.fields.map(f => [f.name, f]))
  const cache  = new Map()

  // L2: the schema is frozen, and a name it does not have is either a mapping
  // mistake (no overflow: thrown, as before) or kept, whole, in one Json column.
  if (overflow) {
    const f = byName.get(overflow)
    if (!f) throw new Error(`loadRows(${modelName}): overflow '${overflow}' is not a column of ${modelName}`)
    if (f.type.name !== 'Json' || f.type.array || !f.type.optional)
      throw new Error(`loadRows(${modelName}): overflow '${overflow}' must be an optional Json column (Json?), since a row with nothing extra leaves it empty`)
  }
  const overflows = (name) => !!overflow && !byName.has(name)

  function of(name) {
    if (cache.has(name)) return cache.get(name)
    const f = byName.get(name)
    if (!f)
      throw new Error(`loadRows(${modelName}): '${name}' is not a column of ${modelName}`)
    if (f.type.kind === 'relation' || f.attributes.some(a => DERIVED.has(a.kind)))
      throw new Error(`loadRows(${modelName}): '${name}' is not a column a source fills — it is computed or a relation`)
    const t = f.type.name
    if (t === 'Bytes' || t === 'File')
      throw new Error(`loadRows(${modelName}): '${name}' is ${t}, which a row of text cannot carry`)
    const money = f.attributes.find(a => a.kind === 'money')
    const scale = f.attributes.find(a => a.kind === 'scale')
    let col
    if (f.type.array)                    col = { kind: 'json' }
    else if (f.type.kind === 'enum')     col = { kind: 'enum', values: schema.enums.find(e => e.name === t).values.map(v => v.name) }
    else if (money?.field)               col = { kind: 'scaled', currencyField: money.field }
    else if (money)                      col = { kind: 'scaled', scale: minorUnits(money.currency) }
    else if (scale)                      col = { kind: 'scaled', scale: scale.places }
    else col = { kind: { String: 'string', Int: 'int', Float: 'float', Boolean: 'boolean', DateTime: 'datetime', Json: 'json' }[t] }
    col = { ...col, name, optional: f.type.optional, defaulted: f.attributes.some(a => a.kind === 'default' || a.kind === 'id') }
    cache.set(name, col)
    return col
  }

  function required(f) {
    if (f.type.optional || f.type.kind === 'relation') return false
    if (f.attributes.some(a => DERIVED.has(a.kind) || a.kind === 'default')) return false
    // An Int @id with no default is the rowid, which SQLite assigns.
    if (f.attributes.some(a => a.kind === 'id') && f.type.name === 'Int') return false
    return true
  }

  function read(record, stamp) {
    if (!record || typeof record !== 'object') return { field: null, reason: 'not a record' }
    const data = { ...stamp }
    const later = []
    let extra = null
    for (const [name, raw] of Object.entries(record)) {
      // Kept as it arrived: text from a file stays text, a value from an API
      // stays its JSON type. Nothing reads it against a column it has not got.
      if (overflows(name)) { if (raw !== undefined) (extra ??= {})[name] = raw; continue }
      const col = of(name)
      if (col.currencyField) { later.push([col, raw]); continue }
      const out = cell(col, raw, col.scale)
      if (out.reason) return { field: name, reason: out.reason }
      if (out.value !== undefined) data[name] = out.value
    }
    for (const [col, raw] of later) {
      let scale
      try { scale = minorUnits(data[col.currencyField]) }
      catch { return { field: col.currencyField, reason: 'not an ISO 4217 currency' } }
      const out = cell(col, raw, scale)
      if (out.reason) return { field: col.name, reason: out.reason }
      if (out.value !== undefined) data[col.name] = out.value
    }
    if (extra) { of(overflow); data[overflow] = extra }
    for (const [name, value] of Object.entries(data)) {
      const col = cache.get(name)
      if (value === null && !col.optional) {
        // A blank in a defaulted column means "take the default", which only
        // leaving the key out says.
        if (col.defaulted) { delete data[name]; continue }
        return { field: name, reason: 'required, and empty' }
      }
    }
    return { data }
  }

  return { of, required, read, overflows }
}

// A string is text from a file and is read against the column; anything else
// arrived typed — a JSON number from an API — and goes to the ORM as it is,
// which refuses it by name if it is not the column's type.
function cell(col, raw, scale) {
  if (raw === undefined) return { value: undefined }
  if (raw === null) return { value: null }
  if (typeof raw !== 'string') return { value: raw }
  return parseCell(raw, col.kind, { scale, values: col.values })
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────
//
// Reference data — countries, plans, currencies — is authored, not generated. It
// belongs in a file next to the schema, not in a factory.
//
//   await loadFixture(db, 'Country', './db/fixtures/countries.json')
//   await loadFixture(db, 'Plan',    './db/fixtures/plans.csv', { mode: 'upsert', key: 'code' })
//   await loadFixture(db, 'Plan',    [{ code: 'pro', price: 20 }])
//
// The same path as loadRows, with one difference: a fixture is AUTHORED, so a
// row in it that does not load is the developer's bug, and it throws naming
// every one rather than handing back a list of rejects to act on.

export async function loadFixture(db, modelName, source, opts = {}) {
  const { asSystem = false, ...load } = opts
  const rows = typeof source === 'string' && /\.(json|csv)$/.test(source) ? await _readFixture(source)
    : typeof source === 'string' ? (() => { throw new Error(`loadFixture: unsupported fixture "${source}" — use .json or .csv`) })()
    : source
  const out = await loadRows(asSystem ? db.asSystem() : db, modelName, rows, load)
  if (out.rejects.length)
    throw new Error(`loadFixture(${modelName}): ${out.rejects.length} row${out.rejects.length > 1 ? 's' : ''} did not load — ` +
      out.rejects.slice(0, 5).map(r => `${r.line ? `line ${r.line}` : `row ${r.row}`}${r.field ? ` ${r.field}` : ''}: ${r.reason}`).join('; '))
  return out
}

async function _readFixture(path) {
  const { readFile } = await import('fs/promises')
  const text = await readFile(path, 'utf8')
  if (path.endsWith('.csv')) return text
  const parsed = JSON.parse(text)
  // A top-level object keyed by model is a common shape; take the array either way.
  return Array.isArray(parsed) ? parsed : Object.values(parsed).find(Array.isArray) ?? []
}

/**
 * RFC-4180 CSV: quoted fields, embedded commas/newlines, "" escapes.
 * Every cell is TEXT, or `null` for an empty unquoted one: what a cell means is
 * its column's to say, and a reader that coerced without the schema turned an
 * unquoted postcode 0123 into the number 123 (FJS-1634).
 */
export function parseCsv(text) {
  return readCsv(text).records
}

// The records, plus the 1-based line each starts on — header included, so a
// reject names the line an editor shows. Not the record's index: a quoted cell
// may hold a newline, and from then on the two disagree.
function readCsv(text) {
  const rows  = []
  const lines = []
  let row       = []
  let field     = ''
  let quoted    = false
  let wasQuoted = false
  let line      = 1
  let rowLine   = 1
  let i         = 0

  const endField = () => { row.push(wasQuoted || field !== '' ? field : null); field = ''; wasQuoted = false }
  const endRow   = () => { endField(); rows.push(row); lines.push(rowLine); row = []; rowLine = line }

  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  while (i < src.length) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i += 2; continue }
      if (c === '"') { quoted = false; i++; continue }
      if (c === '\n') line++
      field += c; i++; continue
    }
    if (c === '"' && field === '') { quoted = true; wasQuoted = true; i++; continue }
    if (c === ',')  { endField(); i++; continue }
    if (c === '\n') { line++; endRow(); i++; continue }
    field += c; i++
  }
  if (field !== '' || wasQuoted || row.length) endRow()

  const keep = rows.map((r, n) => [r, lines[n]]).filter(([r]) => r.length && !(r.length === 1 && r[0] === null))
  if (!keep.length) return { header: [], records: [], lines: [] }
  const [[header], ...body] = keep
  return {
    header:  header.map(h => String(h ?? '')),
    records: body.map(([cells]) => Object.fromEntries(header.map((h, idx) => [String(h), cells[idx] ?? null]))),
    lines:   body.map(([, l]) => l),
  }
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
