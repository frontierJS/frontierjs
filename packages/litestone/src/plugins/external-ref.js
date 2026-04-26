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
//   model pages {
//     id      Integer @id
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
//   const page = await db.pages.findFirst({ where: { id: 1 } })
//   const content = await db.pages.resolveRef(page.content)
//
//   // Auto resolution (config: autoResolve: true)
//   const page = await db.pages.findFirst({ where: { id: 1 } })
//   page.content // → resolved value directly

import { Plugin } from '../core/plugin.js'

export class ExternalRefPlugin extends Plugin {
  // Subclasses set this to match the DSL scalar type name
  // e.g. 'File', 'GitHub', 'Stripe'
  fieldType = null

  constructor(config = {}) {
    super()
    this.config      = config
    this._fieldMap   = {}   // { model: { field: { isArray, ...opts } } }
    this._cache      = new Map()  // cacheKey → resolved value
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
    if (key && this._cache.has(key)) return this._cache.get(key)
    const resolved = await this.resolve(ref, opts)
    if (key) this._cache.set(key, resolved)
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

    for (const [field, opts] of Object.entries(fields)) {
      const value = args.data[field]
      if (!this._isRawValue(value)) continue

      // Stash old ref for cleanup after write
      if (ctx.readDb && args.where) {
        try {
          const { buildWhere } = await import('../core/query.js')
          const params = []
          const whereSql = buildWhere(args.where, params)
          if (whereSql) {
            if (opts.isArray) {
              const oldRow = ctx.readDb.query(`SELECT "${field}" FROM "${model}" WHERE ${whereSql}`).get(...params)
              const oldRefs = this._parseRefArray(oldRow?.[field])
              for (const oldRef of oldRefs) {
                if (oldRef) this._stash(ctx, model, `${field}[${JSON.stringify(oldRef)}]`, oldRef)
              }
            } else {
              const oldRow = ctx.readDb.query(`SELECT "${field}" FROM "${model}" WHERE ${whereSql}`).get(...params)
              const oldRef = this._parseRef(oldRow?.[field])
              if (oldRef) this._stash(ctx, model, field, oldRef)
            }
          }
        } catch {}
      }

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

    for (const [field, opts] of Object.entries(fields)) {
      if (opts.isArray) {
        const stash = this._stashMap.get(ctx) ?? new Map()
        const prefix = `${model}.${field}[`
        const toClean = [...stash.entries()].filter(([k]) => k.startsWith(prefix))
        for (const [k, ref] of toClean) {
          stash.delete(k)
          await this._cleanupRef(ref, { field, model, ctx })
        }
        continue
      }
      const oldRef = this._unstash(ctx, model, field)
      if (oldRef) await this._cleanupRef(oldRef, { field, model, ctx })
    }
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
    const fields = this._fieldMap[model]
    if (!fields) return

    const select = opts.select ?? null

    await Promise.all(rows.map(async row => {
      for (const [field, fieldOpts] of Object.entries(fields)) {
        // select: { avatar: { resolve: false } } — skip resolution for this field
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
    }))
  }
}
