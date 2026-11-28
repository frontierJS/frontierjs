// retention-methods.js — the client's retention surface: the sweep over its own
// connection registry (`_runRetention`, run once at boot) and `$retain`, the
// same pass on demand. The per-database sweep is retention.js and jsonl
// compaction is databases.js; this file is what a client does with its registry,
// its plugins and its cascade sinks, and holds the stop flag and the boot drain
// the client's close and its boot pass reach through `stop` and `setDrain`.

import { jsonlFilePath } from './databases.js'
import { runSqliteRetention, compactJsonl } from './retention.js'

export function makeRetentionMethods(/** @type {any} */ ctx, /** @type {any} */ deps) {
  const { schema, dbRegistry, pluralizeTableNames, now, pluginRunner, sharedCtx } = deps

  // ── Retention ──────────────────────────────────────────────────────────────
  // One pass at startup, for each database declaring a policy. **Startup is not
  // a schedule**: a process that stays up never prunes again, which for a
  // long-lived server is every day after the first. `$retain()` below is the
  // same pass on demand, and scheduling it is the app's — the clock belongs to
  // the queue (`FJS-D36`) and this package cannot import it (`FJS-521`).
  const _retentionModels = (dbName) => schema.models.filter(m => {
    const dbAttr = m.attributes.find(a => a.kind === 'db')
    return (dbAttr?.name ?? 'main') === dbName
  })

  // A swept row is a deleted row, and the plugins hear it the way they hear an
  // ORM delete: FileStorage releases the objects a File column held, which a
  // raw DELETE leaves in the store for ever (FJS-1921).
  // Rows are read only for a model whose deletes something hears — a plugin
  // that answers onAfterDelete, or a cascade child with a listener of its own.
  let _retentionStopped = false
  let _retentionDrain   = null
  const _retentionHears = model => pluginRunner.hearsDeletes || !!sharedCtx.cascadeSinkFor(model)?.cascadeHeard()
  async function _retentionRemoved(model, rows, doomed) {
    if (pluginRunner.hearsDeletes) await pluginRunner.afterDelete(model, rows, ctx)
    await sharedCtx.cascadeSinkFor(model)?.cascadeRemoved(doomed)
  }

  async function _runRetention({ jsonl = true, batches = Infinity } = {}) {
    const swept = []
    for (const [dbName, conn] of Object.entries(dbRegistry)) {
      // A model's own @@retention sweeps in a database that declares no window.
      const owned = _retentionModels(dbName).some(m => m.attributes.some(a => a.kind === 'retention'))
      if (!conn.retention && !conn.maxSize && !owned) continue

      if (conn.driver === 'sqlite' && (conn.retention || owned) && conn.rawWriteDb) {
        const opts = {
          pluralize: pluralizeTableNames, now, batches,
          hears:       _retentionHears,
          onRemoved:   _retentionRemoved,
          doomedUnder: (model, rows) => sharedCtx.cascadeSinkFor(model)?.doomedUnder(rows),
          stopped:     () => _retentionStopped,
        }
        for (const r of await runSqliteRetention(conn.rawWriteDb, _retentionModels(dbName), conn.retention, opts))
          swept.push({ database: dbName, driver: 'sqlite', ...r })
        continue
      }

      // The jsonl half compacts inside `makeJsonlTable`, so the boot pass skips
      // it rather than doing it twice; a later `$retain()` has to do it here,
      // because nothing reopens those tables.
      if (jsonl && (conn.driver === 'jsonl' || conn.driver === 'trail')) {
        for (const model of _retentionModels(dbName)) {
          const filePath = jsonlFilePath(conn.absPath, model.name)
          try {
            const res = compactJsonl(filePath, model, conn.retention, conn.maxSize, now)
            if (res)
              swept.push({ database: dbName, driver: conn.driver, model: model.name, table: filePath, removed: res.removed ?? 0 })
          } catch (err) {
            // Reported, not swallowed. A compaction that throws every pass looks
            // exactly like one that had nothing to do (`FJS-521`).
            console.warn(`[litestone] retention: could not compact "${filePath}" — ${err?.message ?? err}`)
            swept.push({ database: dbName, driver: conn.driver, model: model.name, table: filePath, removed: 0, error: String(err?.message ?? err) })
          }
        }
      }
    }
    return swept
  }

  // ── $retain ────────────────────────────────────────────────────────────────
  //
  // The startup pass, on demand — and the reason it exists is that startup is
  // not a schedule. A process that stays up prunes once, on the day it booted,
  // which for a long-lived server means a declared `retention 90d` stops being
  // true the day after the deploy (`FJS-521`).
  //
  // Scheduling it is the APP's, and that is a consequence of two rulings rather
  // than a gap: unattended recurring work belongs to the queue (`FJS-D36`), and
  // this package may not import it (Invariant 1). One line in a `*.job.ts`:
  //
  //     export default defineJob({
  //       cron: '0 4 * * *',
  //       handler: () => db.asSystem().$retain(),
  //     })
  //
  // `asSystem()` for raw SQL's reason (`FJS-D52`): it deletes rows through no
  // gate, no row policy and no `@@softDelete`, so the bypass is said at the call
  // site rather than assumed. Resolves to one row per table it touched, once
  // the plugins have released what the swept rows held.
  async function $retain() {
    // Stamped so *is the sweep running at all* is answerable. A retention job
    // that stopped firing removes nothing and reports nothing, which is the
    // same silence `FJS-327` and `FJS-328` were about one realm over.
    if (_retentionDrain) await _retentionDrain
    const out = await _runRetention()
    ctx._logStats.lastRetainAt = new Date().toISOString()
    return out
  }

  return { _runRetention, $retain, stop: () => { _retentionStopped = true }, setDrain: (/** @type {any} */ p) => { _retentionDrain = p } }
}
