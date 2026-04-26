// src/plugin.js — Litestone Plugin System
//
// Plugins tap into the client lifecycle without touching core.
// Install via createClient({ plugins: [...] })
//
// Lifecycle hooks (all optional — override only what you need):
//
//   onInit(schema, ctx)
//     Called once when the client is created. Use to build maps from schema,
//     store config, or validate options. ctx is the shared client context.
//
//   async onBeforeRead(model, args, ctx)
//     Before findMany/findFirst/findUnique/count/search.
//     Throw AccessDeniedError to block. Return nothing to allow.
//
//   async onBeforeCreate(model, args, ctx)
//     Before create/createMany. args.data is the full data payload including
//     any nested write ops. Throw to block.
//
//   async onBeforeUpdate(model, args, ctx)
//     Before update/updateMany. args includes where + data. Throw to block.
//
//   async onBeforeDelete(model, args, ctx)
//     Before delete/deleteMany/remove. Throw to block.
//
//   async onAfterRead(model, rows, ctx, opts)
//     After rows are fetched, before returning to caller. Can mutate rows.
//     rows is always an array (even for findFirst/findUnique).
//
//   async onAfterWrite(model, operation, result, ctx)
//     After a write completes. operation is 'create'|'update'|'delete'.
//     result is the written row (or null for many-ops).
//
//   buildReadFilter(model, ctx)
//     Called during buildSQL to inject extra WHERE conditions.
//     Return a where-object (same shape as findMany({ where: ... })) or null.
//     Multiple plugins' filters are AND-merged together and with the query's
//     own where clause.

export class Plugin {
  onInit(schema, ctx) {}

  async onBeforeRead(model, args, ctx) {}
  async onBeforeCreate(model, args, ctx) {}
  async onBeforeUpdate(model, args, ctx) {}
  async onBeforeDelete(model, args, ctx) {}

  async onAfterRead(model, rows, ctx, opts = {}) {}
  async onAfterWrite(model, operation, result, ctx) {}

  // Called after any delete completes — single or bulk.
  // rows = array of the rows that were deleted (fetched before the SQL ran).
  // For soft deletes, rows have deletedAt set to the new timestamp.
  // This is the right place for S3 object cleanup — the SQL has already
  // committed so there's no risk of deleting storage for a row that survived.
  async onAfterDelete(model, rows, ctx) {}

  buildReadFilter(model, ctx) { return null }
}

// ─── AccessDeniedError ────────────────────────────────────────────────────────

export class AccessDeniedError extends Error {
  constructor(message, { model, operation, required, got } = {}) {
    super(message ?? `Access denied on "${model}" for "${operation}"`)
    this.name    = 'AccessDeniedError'
    this.code    = 'ACCESS_DENIED'
    this.model   = model
    this.operation = operation
    this.required  = required
    this.got       = got
  }
}

// ─── PluginRunner ─────────────────────────────────────────────────────────────
// Orchestrates all installed plugins. Called from makeTable and createClient.

export class PluginRunner {
  constructor(plugins) {
    this._plugins = plugins ?? []
  }

  get hasPlugins() { return this._plugins.length > 0 }

  // Called once at client init
  init(schema, ctx) {
    for (const p of this._plugins) p.onInit?.(schema, ctx)
  }

  // Read lifecycle
  async beforeRead(model, args, ctx) {
    for (const p of this._plugins) await p.onBeforeRead?.(model, args, ctx)
  }

  async afterRead(model, rows, ctx, opts = {}) {
    for (const p of this._plugins) await p.onAfterRead?.(model, rows, ctx, opts)
  }

  // Write lifecycle
  async beforeCreate(model, args, ctx) {
    for (const p of this._plugins) await p.onBeforeCreate?.(model, args, ctx)
  }

  async beforeUpdate(model, args, ctx) {
    for (const p of this._plugins) await p.onBeforeUpdate?.(model, args, ctx)
  }

  async beforeDelete(model, args, ctx) {
    for (const p of this._plugins) await p.onBeforeDelete?.(model, args, ctx)
  }

  async afterWrite(model, operation, result, ctx) {
    for (const p of this._plugins) await p.onAfterWrite?.(model, operation, result, ctx)
  }

  async afterDelete(model, rows, ctx) {
    for (const p of this._plugins) await p.onAfterDelete?.(model, rows, ctx)
  }

  // Collect all plugin read filters for a model → array of where-objects
  // Returns [] if no plugins contribute a filter for this model
  getReadFilters(model, ctx) {
    const filters = []
    for (const p of this._plugins) {
      const f = p.buildReadFilter?.(model, ctx)
      if (f != null) filters.push(f)
    }
    return filters
  }
}
