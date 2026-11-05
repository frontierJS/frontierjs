// plugins/external-ref.js — ExternalRefPlugin base class
//
// Formalizes the pattern pioneered by FileStorage:
//   SQLite stores a lightweight JSON ref → plugin resolves it to real data
//
// ─── Implementing a plugin ────────────────────────────────────────────────────
//
//   import { ExternalRefPlugin } from '@frontierjs/litestone'
//
//   class GitHubContent extends ExternalRefPlugin {
//     fieldType = 'GitHub'   // matches the DSL type name
//
//     async serialize(value, { field, model, ctx }) {
//       // value = whatever the caller passed (Buffer, URL, object, etc.)
//       // return a plain object — stored as JSON ref in SQLite
//       return { path: value.path, sha: value.sha, repo: this.config.repo }
//     }
//
//     async resolve(ref, { field, model, ctx }) {
//       // ref = the parsed JSON object stored in SQLite
//       // return the resolved value returned to the caller
//       return await fetchGitHubFile(ref.path, ref.sha, this.config.token)
//     }
//
//     async cleanup(ref, { field, model, ctx }) {
//       // called on delete or update — optional
//       // GitHub owns the data, nothing to clean up
//     }
//
//     cacheKey(ref) {
//       // return a string cache key, or null for no caching
//       return ref.sha   // cache by sha — invalidated when sha changes
//     }
//   }
//
//   export function GitHub(config) {
//     return new GitHubContent(config)
//   }
//
// ─── Schema ───────────────────────────────────────────────────────────────────
//
//   model Page {
//     id      Int @id
//     content GitHub?
//   }
//
// ─── Resolution ───────────────────────────────────────────────────────────────
//
//   By default, refs are returned as-is from findMany/findFirst (raw JSON string).
//   Call resolveRef/resolveRefs to resolve explicitly, or set autoResolve: true
//   in config to resolve automatically in onAfterRead.
//
//   // Manual resolution
//   const page = await db.page.findFirst({ where: { id: 1 } })
//   const content = await db.page.resolveRef(page.content)
//
//   // Auto resolution (config: autoResolve: true)
//   const page = await db.page.findFirst({ where: { id: 1 } })
//   page.content // → resolved value directly

import { LitestonePlugin } from '../core/plugin.js'
import { buildWhere } from '../core/query.js'

const NO_MAPS = Object.freeze({ fieldMap: Object.freeze({}), relationMap: Object.freeze({}) })

export class ExternalRefPlugin extends LitestonePlugin {
  // Subclasses set this to match the DSL scalar type name
  // e.g. 'File', 'GitHub', 'Stripe'
  fieldType = null

  constructor(config = {}) {
    super()
    this.config      = config
    // Per client, never on the instance: a tenant registry forwards one plugin
    // to every client it opens, and a map kept here merged the second schema's
    // File columns into the first client's (`FJS-1380`).
    this._perClient  = new WeakMap()
    this._cache      = new Map()  // cacheKey → resolved value (bounded LRU)
    this._cacheMax   = config.cacheSize ?? 1000   // hard cap on cached entries
    this._autoResolve = config.autoResolve ?? false  // subclasses can override default
  }

  // ── Abstract methods — subclasses implement these ─────────────────────────

  // Transform incoming value to a ref object stored as JSON in SQLite.
  // Return a plain object. Throw to reject the value.
  // eslint-disable-next-line no-unused-vars
  async serialize(value, { field, model, id, ctx }) {
    throw new Error(`${this.constructor.name}: serialize() not implemented`)
  }

  // Transform a stored ref object to the value returned to the caller.
  // Return any value. Throw to signal resolution failure.
  // eslint-disable-next-line no-unused-vars
  async resolve(ref, { field, model, ctx }) {
    return ref  // default: return the ref as-is
  }

  // Called when a ref is deleted (row delete or field update), once the write
  // is real, and for an object stored by a write that was then refused.
  // Optional — default is a no-op.
  // eslint-disable-next-line no-unused-vars
  async cleanup(ref, { field, model, ctx }) {}

  // Return a cache key string for this ref, or null to skip caching.
  // eslint-disable-next-line no-unused-vars
  cacheKey(ref) { return null }

  // ── Init ──────────────────────────────────────────────────────────────────

  // The maps this client's schema declares. `ctx.shapes` is the one object every
  // flavor of a client shares; a ctx without it (a unit test's) is its own key.
  _maps(ctx) {
    return this._perClient.get(ctx.shapes ?? ctx) ?? NO_MAPS
  }

  onInit(schema, ctx) {
    if (!this.fieldType)
      throw new Error(`${this.constructor.name}: fieldType must be set`)

    const fieldMap    = {}   // { model: { field: { isArray, ...opts } } }
    const relationMap = {}   // { model: { relationField: targetModel } }
    this._perClient.set(ctx.shapes ?? ctx, { fieldMap, relationMap })

    for (const model of schema.models) {
      for (const field of model.fields) {
        if (field.type.kind === 'relation' || field.type.kind === 'implicitM2M') {
          // Where an INCLUDED row came from. A read resolves the fields of the
          // model it names and nothing else, so a `File` one join away was
          // handed back as its raw stored JSON while the identical column read
          // at the top level answered a URL — the same column, two answers,
          // depending on how it was reached. Nothing reports it: both are
          // strings, and the wrong one only fails where it is finally used, as
          // a broken <img>.
          if (!relationMap[model.name]) relationMap[model.name] = {}
          relationMap[model.name][field.name] = field.type.name
          continue
        }
        if (field.type.name !== this.fieldType) continue
        if (!fieldMap[model.name]) fieldMap[model.name] = {}
        fieldMap[model.name][field.name] = {
          isArray:  !!field.type.array,
          optional: !!field.type.optional,
          ...this._fieldOptions(field),
        }
      }
    }
  }

  // Subclasses can override to extract extra per-field options from the AST
  // eslint-disable-next-line no-unused-vars
  _fieldOptions(field) { return {} }

  // ── Ref helpers ───────────────────────────────────────────────────────────

  // A column the client JSON-parses arrives as the ref itself; one it did not
  // arrives as text. Both are the same stored value.
  _parseRef(value) {
    if (!value) return null
    if (typeof value === 'object') return value
    if (typeof value !== 'string') return null
    try { return JSON.parse(value) } catch { return null }
  }

  _parseRefArray(value) {
    if (!value) return []
    if (typeof value === 'object') return Array.isArray(value) ? value : [value]
    if (typeof value !== 'string') return []
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch { return [] }
  }

  _isRawValue(v) {
    // Subclasses can override to detect whether a value needs serialization
    // Default: if it's not a JSON ref string, treat it as a raw value
    if (v == null) return false
    if (typeof v === 'string' && v.trimStart().startsWith('{')) return false
    return true
  }

  async _resolveRef(ref, opts) {
    if (!ref) return null
    const key = this.cacheKey(ref)
    if (key && this._cache.has(key)) {
      // LRU touch — delete + re-set moves the entry to the back of the Map
      const hit = this._cache.get(key)
      this._cache.delete(key)
      this._cache.set(key, hit)
      return hit
    }
    const resolved = await this.resolve(ref, opts)
    if (key) {
      // Bounded LRU — previously this Map grew without limit, an effective
      // memory leak for subclasses that cache resolved payloads.
      if (this._cache.size >= this._cacheMax) {
        this._cache.delete(this._cache.keys().next().value)
      }
      this._cache.set(key, resolved)
    }
    return resolved
  }

  async _cleanupRef(ref, opts) {
    if (!ref) return
    try {
      await this.cleanup(ref, opts)
      // Invalidate cache
      const key = this.cacheKey(ref)
      if (key) this._cache.delete(key)
    } catch (e) {
      console.warn(`${this.constructor.name}: cleanup failed: ${e.message}`)
    }
  }

  // ── What one write stored and replaced ────────────────────────────────────
  //
  // Keyed by the payload the before hook was handed, which onWriteSettled is
  // handed back. A slot per flavor was one slot for every write in flight on
  // it, and a refused update left its old ref there for the next update's
  // cleanup, which deleted the file the row still held (FJS-3991).

  _writes = new WeakMap()

  _writeOf(data) {
    let w = this._writes.get(data)
    if (!w) this._writes.set(data, w = { stored: [], replaced: [], given: new Map() })
    return w
  }

  _replaces(data, field, ref) {
    this._writeOf(data).replaced.push({ field, ref })
  }

  // Serializes `data[field]` in place. Every object stored is noted before
  // anything can throw, a sibling's rejection included, so a refusal removes
  // all of them; the caller's value is kept to hand back if the write fails.
  async _serializeField(model, data, field, opts, id, ctx) {
    const w     = this._writeOf(data)
    const value = data[field]
    if (!w.given.has(field)) w.given.set(field, value)
    if (!opts.isArray) {
      const ref = await this.serialize(value, { field, model, id, ctx })
      w.stored.push({ field, ref })
      data[field] = JSON.stringify(ref)
      return
    }
    const items   = Array.isArray(value) ? value : [value]
    const settled = await Promise.allSettled(items.map((item, i) =>
      this._isRawValue(item) ? this.serialize(item, { field, model, id: `${id}-${i}`, ctx }) : Promise.resolve(item)))
    settled.forEach((s, i) => { if (this._isRawValue(items[i]) && s.status === 'fulfilled') w.stored.push({ field, ref: s.value }) })
    const failed = settled.find(s => s.status === 'rejected')
    if (failed) throw failed.reason
    data[field] = settled.map(s => s.value)
  }

  // A refused write removes what it stored and leaves the caller's payload as
  // it was handed: an upsert retrying as an update with the same object would
  // otherwise write a ref to the object just removed. One that landed is held
  // to the outermost transaction: its rollback restores the row naming the old
  // object and drops the one naming the new.
  async onWriteSettled(model, operation, args, error, ctx) {
    const data = args?.data
    const w    = data && typeof data === 'object' ? this._writes.get(data) : null
    if (!w) return
    this._writes.delete(data)
    const clean = list => Promise.all(list.map(({ field, ref }) => this._cleanupRef(ref, { field, model, ctx })))
    if (!error) return this._settle(ctx, { commit: () => clean(w.replaced), rollback: () => clean(w.stored) })
    for (const [field, value] of w.given) data[field] = value
    await clean(w.stored)
  }

  _settle(ctx, effects) {
    return ctx.tx?.hold ? ctx.tx.hold(effects) : effects.commit?.()
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async onBeforeCreate(model, args, ctx) {
    const fields = this._maps(ctx).fieldMap[model]
    if (!fields || !args.data) return

    const idField = ctx.models?.[model]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
    const id      = Array.isArray(args.data) ? 'new' : (args.data[idField] ?? 'new')

    for (const [field, opts] of Object.entries(fields)) {
      if (Array.isArray(args.data)) {
        // createMany — check if any row has a raw value, throw if so
        const hasRaw = args.data.some(row => this._isRawValue(row?.[field]))
        if (hasRaw)
          throw new Error(
            `${this.constructor.name}: createMany does not support raw values on field "${field}". ` +
            `Use create() individually.`
          )
        continue
      }

      const value = args.data[field]
      if (opts.isArray) {
        if (!value) continue
        const items = Array.isArray(value) ? value : [value]
        if (!items.some(v => this._isRawValue(v))) continue
      } else if (!this._isRawValue(value)) continue
      await this._serializeField(model, args.data, field, opts, id, ctx)
    }
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async onBeforeUpdate(model, args, ctx) {
    const fields = this._maps(ctx).fieldMap[model]
    if (!fields || !args.data) return

    // Which fields carry incoming raw values? (Others are untouched refs.) A
    // null clears the column and replaces its object like a raw value does
    // (FJS-3995).
    const rawFields = Object.entries(fields).filter(([field]) =>
      args.data[field] === null || this._isRawValue(args.data[field]))
    if (!rawFields.length) return

    // The refs this write replaces, in ONE SELECT for every raw field, cleaned
    // up once it lands.
    if (ctx.readDb && args.where) {
      try {
        const params = []
        const whereSql = buildWhere(args.where, params)
        if (whereSql) {
          const colSql = rawFields.map(([f]) => `"${f}"`).join(', ')
          const oldRow = ctx.readDb.query(`SELECT ${colSql} FROM "${model}" WHERE ${whereSql}`).get(...params)
          for (const [field, opts] of rawFields) {
            const old = opts.isArray ? this._parseRefArray(oldRow?.[field]) : [this._parseRef(oldRow?.[field])]
            for (const oldRef of old) if (oldRef) this._replaces(args.data, field, oldRef)
          }
        }
      } catch {}
    }

    const id = args.where?.id ?? 'upd'
    for (const [field, opts] of rawFields) {
      if (args.data[field] === null) continue
      if (opts.isArray && ![].concat(args.data[field]).some(v => this._isRawValue(v))) continue
      await this._serializeField(model, args.data, field, opts, id, ctx)
    }
  }

  // ── After delete ──────────────────────────────────────────────────────────

  // Held like an update's old refs: a delete inside a transaction that rolls
  // back restores a row naming the object.
  async onAfterDelete(model, rows, ctx) {
    const fields = this._maps(ctx).fieldMap[model]
    if (!fields || !rows.length) return

    const refs = rows.flatMap(row => Object.entries(fields).flatMap(([field, opts]) =>
      (opts.isArray ? this._parseRefArray(row[field]) : [this._parseRef(row[field])])
        .filter(Boolean).map(ref => ({ field, ref }))))
    if (!refs.length) return
    await this._settle(ctx, { commit: () => Promise.all(refs.map(({ field, ref }) => this._cleanupRef(ref, { field, model, ctx }))) })
  }

  // ── After read (auto-resolve if enabled) ──────────────────────────────────

  async onAfterRead(model, rows, ctx, opts = {}) {
    if (!this._autoResolve) return
    await this._resolveRows(model, rows, ctx, opts.select ?? null, new Set())
  }

  // A write answers its row like a read does (FJS-D1324); the ref is the
  // server's, and `select: { f: { resolve: false } }` asks for it.
  async onWriteResult(model, rows, ctx, opts = {}) {
    return this.onAfterRead(model, rows, ctx, opts)
  }

  /**
   * Resolve this model's ref fields on every row, then do the same for every
   * INCLUDED row hanging off them.
   *
   * `select: { avatar: { resolve: false } }` is honored at the level it was
   * written and does not descend, because there is no spelling for a nested
   * one — `include: { photos: true }` takes no per-field options.
   *
   * @param {Set<object>} seen  rows already visited. An include tree is finite,
   *        but one row object can be reached twice through two relations, and
   *        resolving it twice would hand `resolve()` a URL where it expects a
   *        ref — which is not an error, just the wrong string.
   */
  async _resolveRows(model, rows, ctx, select, seen) {
    const { fieldMap, relationMap } = this._maps(ctx)
    const fields    = fieldMap[model]
    const relations = relationMap[model]
    if (!fields && !relations) return

    await Promise.all(rows.map(async row => {
      if (!row || typeof row !== 'object' || seen.has(row)) return
      seen.add(row)

      for (const [field, fieldOpts] of Object.entries(fields ?? {})) {
        const selectVal = select?.[field]
        if (selectVal && typeof selectVal === 'object' && selectVal.resolve === false) continue

        if (fieldOpts.isArray) {
          const refs = this._parseRefArray(row[field])
          row[field] = await Promise.all(
            refs.map(ref => this._resolveRef(ref, { field, model, ctx }))
          )
        } else {
          const ref = this._parseRef(row[field])
          row[field] = await this._resolveRef(ref, { field, model, ctx })
        }
      }

      // A relation the caller did not include is simply absent from the row,
      // so this loop costs one property read per declared relation and nothing
      // else on the common path.
      for (const [relation, target] of Object.entries(relations ?? {})) {
        const value = row[relation]
        if (value == null) continue
        const nested = Array.isArray(value) ? value : [value]
        await this._resolveRows(target, nested, ctx, null, seen)
      }
    }))
  }
}
