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

import { Plugin } from '../core/plugin.js'
import { buildWhere } from '../core/query.js'

export class ExternalRefPlugin extends Plugin {
  // Subclasses set this to match the DSL scalar type name
  // e.g. 'File', 'GitHub', 'Stripe'
  fieldType = null

  constructor(config = {}) {
    super()
    this.config      = config
    this._fieldMap   = {}   // { model: { field: { isArray, ...opts } } }
    this._relationMap = {}  // { model: { relationField: targetModel } }
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

  // Called when a ref is deleted (row delete or field update).
  // Optional — default is a no-op.
  // eslint-disable-next-line no-unused-vars
  async cleanup(ref, { field, model, ctx }) {}

  // Return a cache key string for this ref, or null to skip caching.
  // eslint-disable-next-line no-unused-vars
  cacheKey(ref) { return null }

  // ── Init ──────────────────────────────────────────────────────────────────

  onInit(schema, ctx) {
    if (!this.fieldType)
      throw new Error(`${this.constructor.name}: fieldType must be set`)

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
          if (!this._relationMap[model.name]) this._relationMap[model.name] = {}
          this._relationMap[model.name][field.name] = field.type.name
          continue
        }
        if (field.type.name !== this.fieldType) continue
        if (!this._fieldMap[model.name]) this._fieldMap[model.name] = {}
        this._fieldMap[model.name][field.name] = {
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

  _parseRef(value) {
    if (!value || typeof value !== 'string') return null
    try { return JSON.parse(value) } catch { return null }
  }

  _parseRefArray(value) {
    if (!value || typeof value !== 'string') return []
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

  // ── Stash for update cleanup ──────────────────────────────────────────────

  _stashMap = new WeakMap()

  _stash(ctx, model, field, ref) {
    if (!this._stashMap.has(ctx)) this._stashMap.set(ctx, new Map())
    this._stashMap.get(ctx).set(`${model}.${field}`, ref)
  }

  _unstash(ctx, model, field) {
    const ref = this._stashMap.get(ctx)?.get(`${model}.${field}`)
    this._stashMap.get(ctx)?.delete(`${model}.${field}`)
    return ref
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async onBeforeCreate(model, args, ctx) {
    const fields = this._fieldMap[model]
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
        const refs = await Promise.all(
          items.map((item, i) =>
            this._isRawValue(item)
              ? this.serialize(item, { field, model, id: `${id}-${i}`, ctx })
              : Promise.resolve(item)
          )
        )
        args.data[field] = JSON.stringify(refs)
        continue
      }

      if (!this._isRawValue(value)) continue
      const ref = await this.serialize(value, { field, model, id, ctx })
      args.data[field] = JSON.stringify(ref)
    }
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async onBeforeUpdate(model, args, ctx) {
    const fields = this._fieldMap[model]
    if (!fields || !args.data) return

    // Which fields carry incoming raw values? (Others are untouched refs.)
    const rawFields = Object.entries(fields).filter(([field]) => this._isRawValue(args.data[field]))
    if (!rawFields.length) return

    // Stash old refs for cleanup after write — ONE combined SELECT for all
    // raw fields (previously: one dynamic import + one SELECT per field).
    if (ctx.readDb && args.where) {
      try {
        const params = []
        const whereSql = buildWhere(args.where, params)
        if (whereSql) {
          const colSql = rawFields.map(([f]) => `"${f}"`).join(', ')
          const oldRow = ctx.readDb.query(`SELECT ${colSql} FROM "${model}" WHERE ${whereSql}`).get(...params)
          for (const [field, opts] of rawFields) {
            if (opts.isArray) {
              for (const oldRef of this._parseRefArray(oldRow?.[field])) {
                if (oldRef) this._stash(ctx, model, `${field}[${JSON.stringify(oldRef)}]`, oldRef)
              }
            } else {
              const oldRef = this._parseRef(oldRow?.[field])
              if (oldRef) this._stash(ctx, model, field, oldRef)
            }
          }
        }
      } catch {}
    }

    for (const [field, opts] of rawFields) {
      const value = args.data[field]
      const id = args.where?.id ?? 'upd'

      if (opts.isArray) {
        const items = Array.isArray(value) ? value : [value]
        if (!items.some(v => this._isRawValue(v))) continue
        const refs = await Promise.all(
          items.map((item, i) =>
            this._isRawValue(item)
              ? this.serialize(item, { field, model, id: `${id}-${i}`, ctx })
              : Promise.resolve(item)
          )
        )
        args.data[field] = JSON.stringify(refs)
        continue
      }

      const ref = await this.serialize(value, { field, model, id, ctx })
      args.data[field] = JSON.stringify(ref)
    }
  }

  // ── After write (cleanup old refs on update) ──────────────────────────────

  async onAfterWrite(model, operation, result, ctx) {
    if (operation !== 'update') return
    const fields = this._fieldMap[model]
    if (!fields) return

    // Collect all stale refs first, then clean them up in PARALLEL —
    // previously each S3 delete was awaited sequentially (N round trips).
    const cleanups = []
    for (const [field, opts] of Object.entries(fields)) {
      if (opts.isArray) {
        const stash = this._stashMap.get(ctx)
        if (!stash) continue
        const prefix = `${model}.${field}[`
        for (const [k, ref] of stash.entries()) {
          if (!k.startsWith(prefix)) continue
          stash.delete(k)
          cleanups.push(this._cleanupRef(ref, { field, model, ctx }))
        }
        continue
      }
      const oldRef = this._unstash(ctx, model, field)
      if (oldRef) cleanups.push(this._cleanupRef(oldRef, { field, model, ctx }))
    }
    if (cleanups.length) await Promise.all(cleanups)
  }

  // ── After delete ──────────────────────────────────────────────────────────

  async onAfterDelete(model, rows, ctx) {
    const fields = this._fieldMap[model]
    if (!fields || !rows.length) return

    await Promise.all(rows.flatMap(row =>
      Object.entries(fields).flatMap(([field, opts]) => {
        if (opts.isArray) {
          return this._parseRefArray(row[field]).map(ref =>
            this._cleanupRef(ref, { field, model, ctx })
          )
        }
        const ref = this._parseRef(row[field])
        return ref ? [this._cleanupRef(ref, { field, model, ctx })] : []
      })
    ))
  }

  // ── After read (auto-resolve if enabled) ──────────────────────────────────

  async onAfterRead(model, rows, ctx, opts = {}) {
    if (!this._autoResolve) return
    await this._resolveRows(model, rows, ctx, opts.select ?? null, new Set())
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
    const fields    = this._fieldMap[model]
    const relations = this._relationMap[model]
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
