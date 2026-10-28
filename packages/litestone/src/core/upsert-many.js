// upsert-many.js — the upsertMany verb: one INSERT … ON CONFLICT over every
// row, so a bulk write that is a create for some rows and an update for others
// costs one statement. Graded as both at once (FJS-720): the insert half
// against the create gate and policy, the ON CONFLICT half as an updateMany
// over rows nobody read. A verb and not a helper, so it goes into the table
// literal under its own name.
//
// Built once per table by `makeTable`, which hands it the write connection
// and the table's refusals, stamps and announcers, and takes back the one verb.

import { BulkTransitionError, SoftDeletedUniqueError } from './errors.js'
import { buildPolicyFilter, checkPostUpdatePolicy } from './policy.js'
import { quoteIdent } from './query.js'
import {
  applyAuthDefaults, applyGeneratedDefaults, applySequences, authStamped, noteStamp, stampFromAuth,
} from './stamps.js'
import { enforceValueSets } from './valuesets.js'
import { rowsChanged } from './databases.js'

export function makeUpsertMany(shape, ctx, deps) {
  const { tableName, modelName, softDelete } = shape
  const {
    _bulkTransitionField, refuseSoftDeleteWrite, refuseOffEntry, refuseBulkNested,
    refuseSystemEntries, extractWriteOps, idField, plugins, tx, writeDb, col, stampSets, _ranks,
    applyFieldRefDefaults, applyPathDefaults, applyRanks, writeData, hasTemplatesField, hiddenParents, checkCreate,
    firstRefusal, _sealInsertSql, sealInsertGuard, sealRefusal, asBatchRowError, asConstraintError,
    noteExclusion, needsTiming, fireQuery, tableHasLogWork, emitLogs, read, announceFor,
    announceBulk,
  } = deps

  // ── upsertMany ──────────────────────────────────────────────────────────
  // Bulk upsert — one SQL statement, one round trip.
  //
  // conflictTarget — the column(s) that define uniqueness (default: idField).
  // All supplied fields are updated on conflict; unspecified fields keep
  // their existing values.
  //
  //   await db.post.upsertMany({
  //     data: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }],
  //   })
  //
  //   // Custom conflict target (e.g. unique slug)
  //   await db.post.upsertMany({
  //     data: [{ slug: 'hello', title: 'Hello' }],
  //     conflictTarget: ['slug'],
  //     update: ['title'],   // only update these fields on conflict
  //   })

  async function upsertMany({ data, conflictTarget, update: updateFields, system, announce } = {}) {
    // The `update:` half is an ON CONFLICT SET over rows nobody read, which is
    // `updateMany`'s problem exactly. The insert half is a create, graded
    // against the entry below.
    const _upMove = _bulkTransitionField(updateFields, 'upsertMany')
    if (_upMove) throw new BulkTransitionError(modelName, _upMove, 'upsertMany')
    // No `update:` list sets every key the rows carry on a conflict.
    refuseSoftDeleteWrite(updateFields == null ? data?.find(d => d?.deletedAt !== undefined) : [updateFields].flat(), 'upsertMany')
    if (!data?.length) return { count: 0 }
    // Under row tenancy a `@unique` was built as (tenant, field) (`FJS-D310`),
    // so a target naming the field alone matches no index and SQLite refuses
    // it without naming the model or the column (`FJS-1918`). The target is
    // widened only when that scoped constraint exists, so a target the caller
    // already led with the tenant column, or one of a `@unique(global)`, is
    // taken as written.
    const target = (() => {
      const named = conflictTarget
        ? (Array.isArray(conflictTarget) ? conflictTarget : [conflictTarget])
        : [idField]
      const t = ctx.schema?.tenancy
      if (t?.strategy !== 'row' || named.includes(t.column)) return named
      const scoped = shape.model.attributes?.some(a =>
        (a.kind === 'uniqueIndex' || a.kind === 'partialUnique') && a.generated === 'tenancy' &&
        a.fields.length === named.length + 1 && a.fields[0] === t.column &&
        named.every((c, i) => a.fields[i + 1] === c))
      return scoped ? [t.column, ...named] : named
    })()
    refuseBulkNested(data, 'upsertMany')
    for (const row of data) extractWriteOps(row, { where: 'upsertMany' })
    refuseSystemEntries(system, ['create', 'update'])
    const { mode: _usMode, wantRows: _usWantRows } = announceFor(announce)
    // The create/update split costs one SELECT per row and is what a logged
    // model already pays for its trail. At the `rows` tier it is worth paying
    // again: the caller asked for precision, and knowing which half a row fell
    // in is the difference between announcing `create` and announcing `update`
    // — the compromise the collection form has to make and this one does not.
    // The conflict half's post-update rule reads the row as it is now, which
    // only RETURNING carries — updateMany's reason (FJS-1730).
    const _usPost = ctx.hasPolicies && !!shape.policy['postUpdate']
    const _usNeedRows = tableHasLogWork || _usWantRows || _usPost || !!plugins?.hearsWrites
    if (plugins?.hasPlugins) await plugins.beforeCreate(modelName, { data, system }, ctx)
    // The conflict half is an update and is graded as one — without this a
    // caller below the update gate overwrote any row by naming its key
    // (`FJS-1700`). Graded whether or not a row conflicts, as updateMany is
    // for a where that matches nothing: the standing is the call's, not the
    // row's. Only an explicit `update: []` is insert-only. The shape carries
    // the KEYS the conflict would set, which is what a capability grades.
    if (plugins?.hasPlugins && !(Array.isArray(updateFields) && !updateFields.length)) {
      const _usKeys = updateFields
        ? [updateFields].flat()
        : [...new Set(data.flatMap(d => Object.keys(d)))]
            .filter(k => !target.includes(k))
      await plugins.beforeUpdate(modelName, { data: Object.fromEntries(_usKeys.map(k => [k, undefined])), system }, ctx)
    }
    await enforceValueSets(modelName, data, ctx)
    data = refuseOffEntry(data)
    // A one-hop default reads another row, so it is stamped before the unit
    // rather than inside it with the other stamps — see createMany.
    const _usPathStamped = data.map(() => new Set())
    if (shape.pathDefaults.length) {
      const out = []
      for (const [i, row] of data.entries()) out.push(await applyPathDefaults(row, _usPathStamped[i]))
      data = out
    }
    const _usHidden = await hiddenParents(data, _usPathStamped, system)

    const autoId       = shape.autoId
    const genDefaults  = shape.generatedDefaults
    const authDefaults = shape.authDefaults
    const createdBys   = shape.createdBy
    const updatedBys   = shape.updatedBy
    const usVersion    = shape.version

    // Which author columns WE are about to fill. An upsert is an insert for
    // some rows and an update for others, and a create-time column must not
    // ride the ON CONFLICT SET clause — a conflict is an update, and an update
    // may not rewrite who created the row. Columns the CALLER supplied are not
    // in this set: naming one is an explicit request, and excluding it would
    // change behavior that predates the stamps.
    const supplied = new Set()
    for (const item of data) for (const k of Object.keys(item ?? {})) supplied.add(k)
    const authorCols = new Set(
      [...(createdBys ?? []), ...(authDefaults ?? [])]
        .map(s => s.field).filter(f => !supplied.has(f)))

    let sql
    let count = 0
    // Split for the audit trail — an upsert is a create for some rows and an
    // update for others, and the log entry says which. Only computed on a
    // logged model: it costs one SELECT over the batch's conflict keys.
    let _usCreated = null, _usUpdated = null
    // What each logged row was given, aligned with the two lists above: the
    // bound row for an insert, the columns ON CONFLICT set for an update.
    let _usCreatedW = null, _usUpdatedW = null
    const _nt = needsTiming()
    const _usT0 = _nt ? performance.now() : 0
    // Whole batch (incl. @sequence bumps) inside one transaction — see createMany.
    // A key minted for the insert half is not the caller's, so a row that
    // conflicts keeps its own unless the conflict moves it to another scope.
    const _usRankMemo = _ranks.length ? new Map() : null
    const _usMinted   = []
    await tx.wrapExclusive(() => {
      const rows = data.map((item, i) => {
        let d = item
        const stamped = new Set()   // per row — see createMany
        if (autoId && (d == null || d[autoId.field] == null)) {
          noteStamp(stamped, d, autoId.field)
          d = { ...(d ?? {}), [autoId.field]: autoId.generate() }
        }
        d = applyGeneratedDefaults(d, genDefaults, stamped)
        d = applyAuthDefaults(d, authDefaults, ctx.auth, stamped)
        d = stampFromAuth(d, createdBys, ctx.auth, stamped)
        d = stampFromAuth(d, updatedBys, ctx.auth, stamped)
        d = applyFieldRefDefaults(d, stamped)
        if (usVersion) { noteStamp(stamped, d, usVersion); d = { ...(d ?? {}), [usVersion]: 1 } }
        d = applySequences(d, modelName, shape.sequences, writeDb, stamped)
        d = applyRanks(d, stamped, _usRankMemo)
        _usMinted[i] = _ranks.filter(r => stamped.has(r.field))
        try { return writeData(d, { requireAll: true, system, stamped, creating: true }) }
        catch (e) { throw asBatchRowError(e, i, data.length, null) }
      })

      // ON CONFLICT DO UPDATE is resolved by SQLite, which has never heard of
      // soft delete — so a batch whose conflict key matched a DELETED row
      // wrote the update INTO that row and reported `{count: 1}`. The write
      // landed where no read returns it and `deletedAt` was never cleared, so
      // it was invisible for good and the caller was told it succeeded
      // (FJS-276). Asked BEFORE the statement runs, because afterwards the
      // write has already happened.
      if (softDelete) {
        for (const [i, row] of rows.entries()) {
          if (target.some(c => row[c] === undefined)) continue
          const hit = writeDb.query(
            `SELECT * FROM "${tableName}" WHERE ${target.map(c => `"${col(c)}" = ?`).join(' AND ')} ` +
            `AND "${col('deletedAt')}" IS NOT NULL LIMIT 1`
          ).get(...target.map(c => row[c] ?? null))
          if (hit) throw asBatchRowError(new SoftDeletedUniqueError(
            modelName, target, target.map(c => row[c]), hit[idField], idField), i, rows.length, row)
        }
      }

      // ── Which rows are inserts and which are updates ─────────────────────
      //
      // Both halves are policied and they are policied by DIFFERENT rules, so
      // the split has to be known before either can be applied: a row that
      // will insert is a create and a row that will conflict is an update.
      // It was neither — `create()` refused planting a row owned by somebody
      // else and `upsertMany` planted it, `update()` refused writing to their
      // row and `upsertMany` wrote it (`FJS-720`). `createMany` has always
      // checked the create policy one verb along, which is what makes the
      // cost known rather than guessed: the same lookup the audit trail
      // already pays for on a logged model.
      // The lookup is what the CREATE half needs, so it is paid for policies
      // alone: the template guard rides the statement's own WHERE and knows
      // nothing about which rows already exist.
      let present = null
      const keyOf = row => JSON.stringify(target.map(c => row[c] ?? null))
      if (_usNeedRows || ctx.hasPolicies) {
        const clause = target.map(c => `"${c}" = ?`).join(' AND ')
        const lookup = writeDb.prepare(`SELECT 1 FROM "${tableName}" WHERE ${clause} LIMIT 1`)
        present = new Set()
        for (const row of rows) {
          if (lookup.get(...target.map(c => row[c] ?? null))) present.add(keyOf(row))
        }
        if (_usNeedRows) { _usCreated = []; _usUpdated = []; _usCreatedW = []; _usUpdatedW = [] }
      }

      // The INSERT half, refused whole like `createMany`'s — a batch is one
      // call, and half of it landing is a worse answer than none of it.
      if (ctx.hasPolicies) {
        for (const [i, row] of rows.entries()) {
          if (present.has(keyOf(row))) continue
          try { _usHidden[i] = firstRefusal(checkCreate(authStamped(data[i], modelName, ctx), _usHidden[i]), _usHidden[i]) }
          catch (e) { throw asBatchRowError(e, i, rows.length, data[i]) }
        }
      }

      // The UPDATE half rides SQLite's own `DO UPDATE … WHERE`, where an
      // unqualified column is the EXISTING row — which is exactly the row the
      // update policy is about, and the same predicate `updateMany` puts in
      // its WHERE. A row the policy excludes is skipped rather than refused,
      // for `updateMany`'s reason: a bulk write narrows, it does not throw.
      const _usUpdPolicy = ctx.hasPolicies
        ? buildPolicyFilter(modelName, 'update', ctx)
        : null
      // A template is a live row in a parallel category, so a bulk write must
      // not reach one it did not ask for — the rule `updateMany` applies
      // through `applyHtFilter` and this statement builds no WHERE to carry.
      const _usGuards = [
        ...(_usUpdPolicy ? [_usUpdPolicy.sql] : []),
        ...(hasTemplatesField ? [`"${hasTemplatesField}" = 0`] : []),
      ]
      const _usGuardSql    = _usGuards.length ? _usGuards.join(' AND ') : null
      const _usGuardParams = _usUpdPolicy?.params ?? []

      // One statement per row shape — see createMany. The SET clause is
      // derived from the shape's own columns, so a row carrying a column the
      // batch's first row omitted updates it on conflict rather than losing it.
      const stmts = new Map()
      const stmtFor = (cols, minted = []) => {
        const key = cols.join(' ') + (minted.length ? ' | ' + minted.map(r => r.field).join(' ') : '')
        let entry = stmts.get(key)
        if (entry) return entry

        // Build UPDATE SET clause — only the fields that aren't in the conflict target
        // An explicit `update:` list still wins outright — naming an author
        // column there is a deliberate request to move it on conflict.
        const updateCols = updateFields
          ? (Array.isArray(updateFields) ? updateFields : [updateFields]).filter(c => cols.includes(c))
          : cols.filter(c => !target.includes(c) && !authorCols.has(c))

        let s = _sealInsertSql
          ? `INSERT INTO "${tableName}" (${cols.map(c => `"${col(c)}"`).join(', ')}) SELECT ${cols.map(() => '?').join(', ')} WHERE ${_sealInsertSql}`
          : `INSERT INTO "${tableName}" (${cols.map(c => `"${col(c)}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`

        // The SET speaks columns, as the INSERT above does: a field name on a
        // @map model is `no such column: excluded.<field>`.
        const _qt = quoteIdent(tableName)
        const _qc = (/** @type {string} */ c) => quoteIdent(col(c))
        const _mintedRank = c => minted.find(r => r.field === c)
        const _rankSet = (r) => {
          const same = r.scope.map(f => `${_qt}.${_qc(f)} IS excluded.${_qc(f)}`).join(' AND ')
          return `${_qc(r.field)} = CASE WHEN ${same} THEN ${_qt}.${_qc(r.field)} ELSE excluded.${_qc(r.field)} END`
        }
        // @version rides the INSERT at 1 and is BUMPED on conflict, never taken
        // from `excluded` — that would reset an existing row to 1 and make every
        // stale editor's version look current again.
        const setPairs = updateCols
          .filter(c => c !== usVersion)
          .map(c => _mintedRank(c) ? _rankSet(_mintedRank(c)) : `${_qc(c)} = excluded.${_qc(c)}`)
        if (usVersion) setPairs.push(`${_qc(usVersion)} = ${_qt}.${_qc(usVersion)} + 1`)
        // A conflict is an update, so it stamps. `setPairs.length` is what
        // decides whether this row updates at all, so the stamp is added
        // after that test and never turns a DO NOTHING into a DO UPDATE.
        if (setPairs.length) setPairs.push(...stampSets(updateCols))

        if (setPairs.length) {
          const conflictSql = target.map(_qc).join(', ')
          s += ` ON CONFLICT(${conflictSql}) DO UPDATE SET ${setPairs.join(', ')}`
          if (_usGuardSql) s += ` WHERE ${_usGuardSql}`
        } else {
          s += ` ON CONFLICT DO NOTHING`
        }

        // RETURNING on a logged model, so the entry names rows by their real id —
        // see createMany. ON CONFLICT DO NOTHING returns nothing for a skipped row.
        if (_usNeedRows) s += ` RETURNING *`
        entry = { cols, updateCols, sql: s, stmt: writeDb.prepare(s) }
        stmts.set(key, entry)
        return entry
      }

      for (const [_i, row] of rows.entries()) {
        if (_usHidden[_i]) throw asBatchRowError(_usHidden[_i], _i, rows.length, row)
        const { cols, updateCols, stmt } = stmtFor(Object.keys(row), _usMinted[_i])
        const _usSeal = sealInsertGuard(row)
        // The guard's params bind LAST, because `ON CONFLICT … WHERE` is the
        // tail of the statement — after the VALUES and after the seal's own
        // WHERE on the `INSERT … SELECT` form.
        const args = [...cols.map(c => row[c] ?? null), ...(_usSeal?.params ?? []), ..._usGuardParams]
        // A conflict TARGET is handled by ON CONFLICT; anything else — a second
        // @unique, a NOT NULL, an FK — still reaches here as SQLite's message.
        let _usWrote = true
        try {
          if (_usNeedRows) {
            const written = stmt.get(...args)
            const _usUpd  = written && present.has(keyOf(row))
            if (written) {
              (_usUpd ? _usUpdated : _usCreated).push(written)
              ;(_usUpd ? _usUpdatedW : _usCreatedW).push(_usUpd ? Object.fromEntries(updateCols.map(c => [c, true])) : row)
            }
            else if (_usSeal || _usGuardSql) _usWrote = false
            // A later row repeating this key conflicts with the row just written.
            if (written) present.add(keyOf(row))
            // One refused row refuses the batch: the throw rolls the unit back.
            if (_usUpd && _usPost)
              checkPostUpdatePolicy(modelName, read(written, { mode: 'single', hydrateFrom: true }), ctx)
          } else {
            stmt.run(...args)
            if (_usSeal || _usGuardSql) _usWrote = rowsChanged(writeDb) > 0
          }
        } catch (e) { throw asBatchRowError(asConstraintError(e, row), _i, rows.length, row) }
        // Named like a constraint failure rather than counted: a batch that
        // reports writing a row it did not write is worse than one that stops,
        // and `ON CONFLICT DO NOTHING` is the only other way to get here.
        //
        // A row the update GUARD skipped is the third way and is not a
        // refusal: `updateMany` narrows its WHERE and counts what it moved, so
        // this counts what it moved too. Which is also why the count has to be
        // read from SQLite rather than assumed — the reason this branch exists.
        if (!_usWrote) {
          const refusal = sealRefusal(_usSeal?.parents, 'create')
          if (refusal) throw asBatchRowError(refusal, _i, rows.length, row)
        }
        if (_usWrote) { noteExclusion(row); count++ }
      }
      sql = [...stmts.values()].map(e => e.sql).join('\n')
    })
    fireQuery({ operation: 'upsertMany', args: { data, conflictTarget, update: updateFields }, sql, params: null, duration: _nt ? performance.now() - _usT0 : 0, rowCount: count })
    if (tableHasLogWork) {
      if (_usCreated?.length) emitLogs('create', _usCreated, { system, written: _usCreatedW })
      if (_usUpdated?.length) emitLogs('update', _usUpdated, { system, written: _usUpdatedW })
    }
    if (plugins?.hearsWrites && _usCreated) {
      for (const r of _usCreated) await plugins.afterWrite(modelName, 'create', read(r, { mode: 'single', hydrateFrom: true }), ctx)
      for (const r of _usUpdated) await plugins.afterWrite(modelName, 'update', read(r, { mode: 'single', hydrateFrom: true }), ctx)
    }
    // At the `rows` tier the split is known, so each half announces truthfully.
    // The COLLECTION form has to pick one for the whole batch and picks
    // `update`: to a list every row named here now exists with new values, and
    // `create` would be wrong for the conflicting majority, which is the
    // ordinary case for an upsert.
    if (_usMode === 'rows' && _usCreated) {
      announceBulk({ mode: 'rows', event: 'create', operation: 'upsertMany', count: _usCreated.length, rows: _usCreated })
      announceBulk({ mode: 'rows', event: 'update', operation: 'upsertMany', count: _usUpdated.length, rows: _usUpdated })
    } else {
      announceBulk({ mode: _usMode, event: 'update', operation: 'upsertMany', count, rows: _usCreated ? [..._usCreated, ..._usUpdated] : null })
    }
    return { count }
  }

  return { upsertMany }
}
