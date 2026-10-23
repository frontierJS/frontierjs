// restore.js — the restore verb: un-delete on a @@softDelete table, which
// clears the stamp and walks the cascade back down to the children that
// carried the root's stamp. Graded as an UPDATE of deletedAt, so the update
// gate and policy decide which rows come back. A verb and not a helper, so it
// goes into the table literal under its own name.
//
// Built once per table by `makeTable`, which hands it both connections and
// the table's cascade walk, stamps and announcers, and takes back the one verb.

import { CapabilityNotDeclaredError } from './errors.js'
import { ident, keyIn } from './query.js'

export function makeRestore(shape, ctx, deps) {
  const { tableName, modelName, softDelete, softDeleteCascade } = shape
  const {
    plugins, tx, readDb, writeDb, col, visibleWhere, buildWhereWithEncryption, stampSets, _stampCols,
    _cascadeTargets, walkCascade, cascadeChildRows, noteCardinality, noteExclusion, needsTiming,
    fireQuery, tableHasLogWork, emitLogs, trailImage, read, fireRowEvent,
  } = deps

  // ── restore ─────────────────────────────────────────────────────────────
  // Soft-delete tables only — sets deletedAt = NULL.
  //
  // Un-deleting is an UPDATE of `deletedAt` and is graded as one: the update
  // gate through `beforeUpdate`, and the update policy ANDed into the WHERE,
  // which is also where a row tenancy's `@@deny` arrives. A row outside it is
  // not restored and not reported — § Rule one. The cascade walks from the
  // rows that scope admits, never from the caller's where alone, or a refused
  // parent's children come back without it (`FJS-1096`).
  async function restore({ where } = {}) {
    if (!softDelete) throw new CapabilityNotDeclaredError(modelName, 'restore()', '@@softDelete',
      'A row here is either present or gone — delete() is the only removal, and it has no way back.')
    if (plugins?.hasPlugins) await plugins.beforeUpdate(modelName, { where, data: { deletedAt: null } }, ctx)
    const params   = []
    // Restore targets deleted rows: `onlyDeleted` is the verb's own mode,
    // not a caller flag.
    const { where: exclWhere, policy: restorePolicy } = visibleWhere('restore', where, { onlyDeleted: true })
    const baseWhereSql = buildWhereWithEncryption(exclWhere, params)
    if (!baseWhereSql) throw new Error(`restore on "${tableName}" requires a where clause`)
    const whereSql = restorePolicy ? `(${baseWhereSql}) AND (${restorePolicy.sql})` : baseWhereSql
    if (restorePolicy) params.push(...restorePolicy.params)
    // The children and the parent come back together, or neither does — the
    // walk below is many statements and used to be that many auto-commits
    // (`FJS-638`).
    let restored, trashed = null
    await tx.wrapExclusive(() => {
    // The stamp the restore clears is the one fact the trail's `before` needs
    // and RETURNING cannot carry.
    if (tableHasLogWork) trashed = readDb.query(`SELECT * FROM ${ident(tableName).sql} WHERE ${whereSql}`).all(...params)
    // If cascading, restore child tables too (reverse of delete cascade).
    // Only the children holding the ROOT'S stamp: remove() stamps every live
    // child with its own timestamp and leaves an already-deleted child with
    // an older one, so matching the stamp is what separates what this
    // cascade removed from what somebody deleted on its own (`FJS-1583`).
    // One walk per stamp, because `where` can match roots removed apart.
    // The roots come back before the walk: under a self-relation a root can
    // be another root's child, and restored by the walk first it would be
    // missing from the rows returned, logged and announced.
    const byStamp = new Map()
    if (softDeleteCascade && _cascadeTargets().length > 0) {
      for (const r of readDb.query(`SELECT * FROM "${tableName}" WHERE ${whereSql}`).all(...params)) {
        const stamp = r[col('deletedAt')]
        byStamp.set(stamp, [...(byStamp.get(stamp) ?? []), r])
      }
    }

    const _rsSets = [`"${col('deletedAt')}" = NULL`, ...stampSets(['deletedAt'])].join(', ')
    const _rsSql = `UPDATE "${tableName}" SET ${_rsSets} WHERE ${whereSql} RETURNING *`
    const _nt = needsTiming()
    const _rsT0 = _nt ? performance.now() : 0
    restored = writeDb.query(_rsSql).all(...params)
    for (const r of restored) { noteCardinality(read(r)); noteExclusion(read(r)) }
    fireQuery({ operation: 'restore', args: { where }, sql: _rsSql, params, duration: _nt ? performance.now() - _rsT0 : 0, rowCount: restored.length })

    for (const [stamp, rootRows] of byStamp) {
      walkCascade(rootRows, ({ childModel, childTable, foreignKeys, hardDelete }, keys) => {
        if (hardDelete) return null  // hard-deleted children are gone — cannot restore
        const binds = []
        const under = `${keyIn(foreignKeys.map(f => `"${f}"`), keys, binds)} AND "deletedAt" = ?`
        binds.push(stamp)
        // Read before the write: after it, the stamp that names them is gone.
        const childRows = cascadeChildRows(childModel, childTable, under, binds)
        writeDb.run(`UPDATE "${childTable}" SET "deletedAt" = NULL WHERE ${under}`, ...binds)
        return childRows
      })
    }
    })
    // Un-deleting is a write and belongs in the trail. It logs as 'update' —
    // the entry vocabulary is create|update|delete|read, and a restored row is
    // a row that changed state, not one that was created. One row carries its
    // images like any single-row write; many name their ids.
    if (tableHasLogWork && restored.length) {
      const written = [Object.fromEntries(['deletedAt', ..._stampCols].map(c => [c, null]))]
      const one = restored.length === 1 && trashed?.length === 1
      emitLogs('update', restored, one
        ? {
            before: trailImage(trashed[0], read(trashed[0], { mode: 'single' })),
            after:  trailImage(restored[0], read(restored[0], { mode: 'single' })),
            written,
          }
        : { written })
    }
    // The rows, shaped — not `{ count }`. Three sources claimed three
    // different answers here (index.d.ts said one row, CLAUDE.md said an
    // array, the code returned a count), so the TypeScript declaration
    // accepted `(await restore(…)).id` for something that never had one.
    // An array is the honest shape: `where` can match many, and RETURNING
    // already had the rows before they were thrown away. They were also raw
    // — no JSON parse, no boolean coercion, no computed fields — so anything
    // that had reached for them would have got a shape no other read
    // produces. restore mirrors remove, which returns its row.
    const restoredRows = restored.map(r => read(r, { mode: 'single', hydrateFrom: true }))
    // One event per row rather than a collection one: `where` can match many,
    // but RETURNING already built every row and the caller is handed them, so
    // the memory a per-row announcement would cost is spent either way.
    // `update` for the same reason the log entry says update — a restored row
    // is one that changed state, not one that was created — and to a list
    // holding the default (live) filter it arrives exactly as a patch does.
    for (const r of restoredRows) fireRowEvent('update', 'restore', r)
    if (plugins?.hearsWrites) for (const r of restoredRows) await plugins.afterWrite(modelName, 'update', r, ctx)
    return restoredRows
  }

  return { restore }
}
