// include.js — the rows read through a relation: `include`, and `@from` on
// the paths that assemble their own SQL.

import { modelToTableName } from './ddl.js'
import { coerceBooleans, deserializeRow, buildWhere, parseSelectArg } from './query.js'
import { ValidationError } from './validate.js'
import { buildPolicyFilter } from './policy.js'
import { CapabilityNotDeclaredError } from './errors.js'
import { nowISO } from './schema-maps.js'
import { suggestKey } from './args.js'
import { applyComputed } from './computed.js'
import { wideDb, mappedDb, plainDb } from './databases.js'
import { applyFieldPolicyTo } from './field-policy.js'
import { emitQuery, queryTapped } from './hooks.js'

// ─── @from on a path that builds its own SQL ─────────────────────────────────
//
// makeTable holds a table's own @from entries in a closure, which is right for
// the query pipeline and reaches none of the paths that assemble SQL
// themselves. Those paths — resolveIncludes, and findManyCursor for its own
// table — ask here instead of growing a third copy of the rule.
//
// Both halves matter and only one of them is visible: without the SELECT
// expression the field is absent, and without the deserializer a
// `@from(X, last: true)` arrives as the JSON string SQLite returned. Absent is
// the dangerous one, because applyComputed still runs — a @computed field
// reading a missing @from field answers a plausible 0 rather than throwing.

export function fromSelectExpr(fromFields, aliased = false) {
  const entries = Object.entries(fromFields ?? {})
  if (!entries.length) return null
  return entries
    .map(([n, f]) => `${aliased ? f.subquerySqlAliased : f.subquerySql} AS "${n}"`)
    .join(', ')
}

// ─── @from(first/last) — the row behind the reference ────────────────────────
// The subquery answers an id; the row comes back through a real read of the
// target, so it carries the target's @computed and @from fields and is stripped
// of its @guarded / @omit / @encrypted ones. One query per field across all the
// rows in hand, not one per row.
//
// **The pick is redone here whenever the target declares a read policy.** The
// subquery in the SELECT is built once at startup and a `@@allow` binds
// ctx.auth per request, so the id it chose is the newest row that EXISTS, not
// the newest one this caller may read. Fetching that id and finding it filtered
// answers `null` — *no last order* — where the truth is *your last order is the
// one below it*. So the policy goes into the WHERE and ROW_NUMBER() picks per
// parent, which is the same answer a direct `findFirst` would give. FJS-224.
//
// It costs one window function over the children of the parents in hand, and
// only on a policied target: with no policy the id from SQL is already right
// and the cheaper fetch-by-id runs. The repick needs the parent's correlation
// column in the row, so `parseSelectArg` injects it the way it injects an FK —
// a `select` naming the @from field and not the key still repicks, and does not
// get the key back in the answer.
//
// `depth` bounds a chain of references — A.last → B, B.last → A is a cycle, and
// a cycle here is an infinite fetch rather than a wrong answer.
export function resolveFromRowRefs(readDb, rows, fromFields, ctx, depth = 0) {
  if (!rows?.length || !fromFields || depth > 3) return rows
  for (const [name, def] of Object.entries(fromFields)) {
    if (!def.rowRef) continue
    const { model: target, pk, fkCols, refCols, orderField, dir, extra } = def.rowRef
    const tModel = ctx.schema?.models.find(m => m.name === target)
    const tTable = tModel ? modelToTableName(tModel, ctx.pluralize ?? false) : target
    const tFrom  = ctx.fromMap?.[target] ?? null
    const policy = ctx.hasPolicies
      ? buildPolicyFilter(target, 'read', ctx, ctx.policyMap, ctx.schema, ctx.relationMap)
      : null
    const fromCols = tFrom ? fromSelectExpr(tFrom) : null
    const T        = `"${tTable}"`

    // Repick under the policy, or fetch the id SQL already chose. `refCols` is
    // usually the parent's primary key, so the second condition only fails for
    // a `select` that named the @from field and not the key it correlates on.
    //
    // A composite key is a TUPLE at every step here — the IN list, the
    // partition and the lookup map — because the correlation is over all of it.
    // `keyOf` is that tuple as one string, JSON so two columns cannot join into
    // one value the way a separator would.
    const keyOf   = (r, cols) => JSON.stringify(cols.map(c => r[c] ?? null))
    const refVals = refCols?.length ? rows.map(r => refCols.map(c => r[c])) : []
    const refs    = [...new Map(refVals
      .filter(vals => vals.every(v => v != null))
      .map(vals => [JSON.stringify(vals), vals])).values()]
    const repick  = Boolean(policy && fkCols?.length && refs.length &&
                            refVals.every(vals => vals.every(v => v !== undefined)))

    let sql, binds
    if (repick) {
      const lhs = fkCols.length === 1 ? `${T}."${fkCols[0]}"` : `(${fkCols.map(c => `${T}."${c}"`).join(', ')})`
      const one = fkCols.length === 1 ? '?' : `(${fkCols.map(() => '?').join(', ')})`
      const parts = [
        `${lhs} IN (${refs.map(() => one).join(', ')})`,
        ...(extra ?? []).map(part => part.replaceAll('%T%', T)),
        ...(policy ? [`(${policy.sql})`] : []),
      ]
      // The window runs INSIDE the policy, not over it: partitioning first and
      // filtering after would rank the rows this caller cannot see and then
      // delete the winner, which is the null this fixes wearing a second hat.
      sql = `SELECT * FROM (SELECT ${T}.*${fromCols ? `, ${fromCols}` : ''}, ` +
            `ROW_NUMBER() OVER (PARTITION BY ${fkCols.map(c => `${T}."${c}"`).join(', ')} ORDER BY ${T}."${orderField}" ${dir}) AS "__fromrn" ` +
            `FROM ${T} WHERE ${parts.join(' AND ')}) WHERE "__fromrn" = 1`
      binds = [...refs.flat(), ...(policy?.params ?? [])]
    } else {
      const ids = [...new Set(rows.map(r => r[name]).filter(v => v != null))]
      if (!ids.length) {
        for (const r of rows) if (name in r) r[name] = null
        continue
      }
      sql = `SELECT *${fromCols ? `, ${fromCols}` : ''} FROM ${T} ` +
            `WHERE "${pk}" IN (${ids.map(() => '?').join(', ')})${policy ? ` AND (${policy.sql})` : ''}`
      binds = [...ids, ...(policy?.params ?? [])]
    }

    // This read is of the TARGET's rows, so its wideness is the target's and
    // not the caller's — the same reason the two maps below are keyed by
    // `target`. Asked here rather than inherited from a wrapper, which would be
    // the wrong model's answer in both directions.
    // The @from repick reads the TARGET's rows, so wideness is the target's —
    // and the handle may already be wrapped for the PARENT, which would narrow
    // against the wrong field set.
    const tBig  = ctx.bigMap?.[target]
    const fromDb = tBig ? wideDb(readDb, tBig) : plainDb(readDb)
    const stmt  = fromDb.query(sql)
    let got = stmt.all(...binds)
      .map((r) => {
        if (repick) delete r.__fromrn
        return deserializeFromRow(
          coerceBooleans(deserializeRow(r, ctx.jsonMap?.[target] ?? new Set()), ctx.boolMap?.[target] ?? new Set()),
          tFrom)
      })
    // A referenced row may reference one of its own.
    resolveFromRowRefs(readDb, got, tFrom, ctx, depth + 1)
    got = got.map(r => applyComputed(r, target, ctx.computedFns, ctx))
    const fp = ctx.fieldPolicyMap?.[target]
    if (fp && Object.keys(fp).length)
      got = got.map(r => applyFieldPolicyTo(r, target, fp, ctx, { mode: 'single' }))

    if (repick) {
      const byRef = new Map(got.map(r => [keyOf(r, fkCols), r]))
      for (const r of rows)
        if (name in r)
          r[name] = refCols.some(c => r[c] == null) ? null : (byRef.get(keyOf(r, refCols)) ?? null)
    } else {
      const byId = new Map(got.map(r => [r[pk], r]))
      for (const r of rows) if (name in r) r[name] = r[name] == null ? null : (byId.get(r[name]) ?? null)
    }
  }
  return rows
}

function deserializeFromRow(row, fromFields) {
  if (!row || !fromFields) return row
  let out = row
  for (const [name, f] of Object.entries(fromFields)) {
    if (!(name in row)) continue
    if (out === row) out = { ...row }
    if (f.isObject) {
      out[name] = out[name] != null
        ? (typeof out[name] === 'string' ? JSON.parse(out[name]) : out[name])
        : null
    } else if (f.isBool) {
      out[name] = out[name] === 1 || out[name] === true
    }
  }
  return out
}

// ─── Include resolution ───────────────────────────────────────────────────────
// One query per relation level, batched with IN — never N queries per row.
// Uses readDb for all include fetches.
//
// ── Access rules apply here too, and they are applied by hand ────────────────
//
// These paths build their own SQL and bypass buildWhere entirely, which is why
// the soft-delete and @@hasTemplates filters below are hand-appended. @@allow
// was not, until 2026-08-10: a policy declared on a model filtered every direct
// read of it and none reached through a parent's `include`, so a tenant scoped
// out of a row by `@@allow('read', workspaceId == auth().workspaceId)` still
// received it as `appServer.server`. Same for the field rules — see
// applyFieldPolicyTo above. The gate is the third of the three and is checked
// before the query runs, in GatePlugin.onBeforeRead, because getLevel is async
// and everything here is not.

// Coerce a raw edge column value (from a join/side table) to its JS type.
export function coerceEdgeValue(raw, desc) {
  if (raw == null) return raw
  const tn = desc.type?.name
  if (tn === 'Boolean') return !!raw
  if (tn === 'Json')    { try { return JSON.parse(raw) } catch { return raw } }
  return raw
}

export function resolveIncludes(readDb, rows, include, modelName, ctx) {
  if (!include || !rows.length) return rows

  const { relationMap, jsonMap, edgeMap, computedSets, fromMap, softDeleteMap, computedFns } = ctx
  const tableRelations = relationMap[modelName] ?? {}

  // Resolve a PascalCase model name to its SQL table name. Relations in relationMap
  // carry the target as a model name; SQL emits the table name.
  const modelToTable = (mName) => {
    const m = ctx.schema?.models.find(x => x.name === mName)
    return m ? modelToTableName(m, ctx.pluralize ?? false) : mName
  }

  // Run one include statement and TELL THE TAP about it.
  //
  // An include is a second SELECT and it was reported nowhere: `fireQuery` runs
  // before `withIncludes`, so neither the count nor the parent's `duration`
  // covered it, and a hundred-row populate read as one statement. The statement
  // is against the TARGET model, so that is the `model` and the `database` this
  // event names — a relation may live in another database block.
  const runInclude = (dbh, targetModel, operation, sql, params) => {
    const tapped = queryTapped(ctx)
    const t0     = tapped ? performance.now() : 0
    const out    = dbh.query(sql).all(...params)
    if (tapped)
      emitQuery(ctx, modelToTable(targetModel), ctx.modelDbMap?.[targetModel] ?? 'main',
        { operation, sql, params, duration: performance.now() - t0, rowCount: out.length })
    return out
  }

  // Append the target's @from subqueries to a nested SELECT list. A bare
  // include takes them all; an explicit nested select takes only what it named.
  const withFromCols = (sqlCols, targetFrom, parsedNested) => {
    if (!targetFrom) return sqlCols
    if (sqlCols === '*') {
      const all = fromSelectExpr(targetFrom)
      return all ? `*, ${all}` : sqlCols
    }
    if (!parsedNested?.requestedFrom?.size) return sqlCols
    const picked = [...parsedNested.requestedFrom]
      .map(n => `${targetFrom[n].subquerySql} AS "${n}"`).join(', ')
    return `${sqlCols}, ${picked}`
  }

  // ── _count in include ──────────────────────────────────────────────────────
  // Supports three forms per key:
  //   posts: true                                        — unfiltered count
  //   posts: { where: { published: true } }             — filtered, key = relation name
  //   published_posts: { relation: 'posts', where: { published: true } }  — filtered alias
  //
  // Multiple filtered counts of the same relation are supported via aliases.
  // All counts are batched — one GROUP BY query per distinct (relation, where) pair.
  if (include._count) {
    const countSpec = include._count === true
      ? Object.fromEntries(Object.keys(tableRelations).filter(k => {
          const r = tableRelations[k]
          return r.kind === 'hasMany' || r.kind === 'manyToMany'
        }).map(k => [k, true]))
      : (include._count.select ?? include._count)

    const idField = ctx.models[modelName]?.fields.find(f => f.attributes.some(a => a.kind === 'id'))?.name ?? 'id'
    const pkValues = [...new Set(rows.map(r => r[idField]).filter(v => v != null))]
    const ph = pkValues.map(() => '?').join(', ')

    for (const [alias, spec] of Object.entries(countSpec)) {
      if (!spec) continue

      // Resolve relation name and optional where filter
      const relName  = (typeof spec === 'object' && spec.relation) ? spec.relation : alias
      const where    = (typeof spec === 'object' && spec !== true)  ? (spec.where ?? null) : null

      const rel      = tableRelations[relName]
      if (!rel) continue
      if (rel.kind !== 'hasMany' && rel.kind !== 'manyToMany') continue

      let sql, results

      // A count of rows the caller may not read is a read of them — one number
      // at a time. The join table alone cannot answer it once the TARGET is
      // policied, so the count joins through to the target in that case.
      const countPolicy = ctx.hasPolicies
        ? buildPolicyFilter(rel.targetModel, 'read', ctx, ctx.policyMap, ctx.schema, relationMap)
        : null

      if (rel.kind === 'manyToMany') {
        // M2M: count via join table — where filters not supported on join table, skip
        sql = countPolicy
          ? `SELECT j."${rel.selfKey}" as __pk, COUNT(*) as __n FROM "${rel.joinTable}" j ` +
            `WHERE j."${rel.selfKey}" IN (${ph}) ` +
            `AND j."${rel.targetKey}" IN (SELECT "${rel.targetPk ?? 'id'}" FROM "${modelToTable(rel.targetModel)}" WHERE ${countPolicy.sql}) ` +
            `GROUP BY j."${rel.selfKey}"`
          : `SELECT "${rel.selfKey}" as __pk, COUNT(*) as __n FROM "${rel.joinTable}" WHERE "${rel.selfKey}" IN (${ph}) GROUP BY "${rel.selfKey}"`
        results = runInclude(readDb, rel.targetModel, 'include:count', sql,
          [...pkValues, ...(countPolicy?.params ?? [])])
      } else {
        const sdExtra = softDeleteMap[rel.targetModel] ? ` AND "deletedAt" IS NULL` : ''
        // Default _count behavior mirrors normal reads — exclude templates.
        // The relInclude here is `spec`, parsed above; we don't currently
        // surface withTemplates/onlyTemplates on _count selectors (matches
        // soft-delete: no withDeleted on _count either).
        const targetHt = ctx.hasTemplatesMap?.[rel.targetModel] ?? null
        const htExtra  = targetHt ? ` AND "${targetHt}" = 0` : ''
        // The window, same terms: no flag is surfaced here, so it is always
        // read at `now`. Bound rather than inlined — the two above are literals
        // because a column name and a constant are all they need.
        const cntWin   = ctx.effectiveMap?.[rel.targetModel] ?? null
        const cntBinds = []
        let   effExtra = ''
        if (cntWin?.imposed) {
          const at = cntWin.kind === 'day' ? nowISO(ctx.now).slice(0, 10) : nowISO(ctx.now)
          if (cntWin.from) { effExtra += ` AND ("${cntWin.from}" IS NULL OR "${cntWin.from}" <= ?)`; cntBinds.push(at) }
          if (cntWin.to)   { effExtra += ` AND ("${cntWin.to}" IS NULL OR "${cntWin.to}" > ?)`;      cntBinds.push(at) }
        }
        // Build optional where filter using buildWhere
        let whereExtra = ''
        const whereParams = []
        if (where) {
          const ws = buildWhere(where, whereParams, null, null, null, null, ctx.filterKindMap?.[rel.targetModel])
          if (ws) whereExtra = ` AND (${ws})`
        }
        const polExtra = countPolicy ? ` AND (${countPolicy.sql})` : ''
        sql = `SELECT "${rel.foreignKey}" as __pk, COUNT(*) as __n FROM "${modelToTable(rel.targetModel)}" WHERE "${rel.foreignKey}" IN (${ph})${sdExtra}${htExtra}${effExtra}${whereExtra}${polExtra} GROUP BY "${rel.foreignKey}"`
        results = runInclude(readDb, rel.targetModel, 'include:count', sql,
          [...pkValues, ...cntBinds, ...whereParams, ...(countPolicy?.params ?? [])])
      }

      const counts = new Map(results.map(r => [r.__pk, r.__n]))
      for (const row of rows) {
        if (!row._count) row._count = {}
        row._count[alias] = counts.get(row[idField]) ?? 0
      }
    }
  }

  for (const [relName, relInclude] of Object.entries(include)) {
    if (relName === '_count') continue
    if (!relInclude) continue

    const rel = tableRelations[relName]
    if (!rel) {
      // A bare `Error` reaches a boundary as a 500 quoting a relation name the
      // CALLER supplied — `?$populate=nope` was one (`FJS-776`). It is the same
      // class as an unknown filter key: a caller naming something that is not
      // there, which the boundary can answer 400 to. `ValidationError` is what
      // `checkWhereKeys` already throws for that, so the two agree without this
      // layer knowing anything about HTTP.
      const names = Object.keys(tableRelations).sort()
      throw new ValidationError([{
        path:    ['include', relName],
        message: `Unknown relation '${relName}' on ${modelName}.` +
                 (suggestKey(relName, new Set(names)) ? ` Did you mean: ${suggestKey(relName, new Set(names))}?` : '') +
                 (names.length ? ` Relations: ${names.join(', ')}` : ` ${modelName} declares none`),
      }])
    }

    // An include reads the TARGET's rows, so `@big` is the target's fact. One
    // decision per relation, covering the three SELECT shapes the branches below
    // build; `readDb` itself stays plain, because the nested include and the
    // @from resolver each answer for a model of their own. The `_count` query
    // above is deliberately not on it — a count is a count, not the column.
    const relBig = ctx.bigMap?.[rel.targetModel]
    // The same reasoning for `@map`, and the two compose: the target's rows come
    // back keyed by ITS columns, and every key read out of them below — the join
    // key most of all — is a field name. `tcol` is the same fact in the other
    // direction, for the identifiers these branches write into SQL.
    const relMap = ctx.columnMaps?.[rel.targetModel]
    const tcol   = relMap && Object.keys(relMap).length
      ? (name) => relMap[name] ?? name
      : (name) => name
    let relDb    = relBig ? wideDb(readDb, relBig) : plainDb(readDb)
    if (relMap && Object.keys(relMap).length) relDb = mappedDb(relDb, relMap)

    // ── The target model's own read policy ──────────────────────────────────
    // Built once here and appended by each branch below, because the three
    // branches emit three different SQL shapes. `policyFor` is the plain form
    // for a single-table FROM; `policyIn` re-scopes it through a subquery for
    // the m2m branch, where the target is aliased `t` beside the join table `j`
    // and the compiler's unqualified column names would be ambiguous.
    const targetPolicy = ctx.hasPolicies
      ? buildPolicyFilter(rel.targetModel, 'read', ctx, ctx.policyMap, ctx.schema, relationMap)
      : null
    const policyClause = targetPolicy ? ` AND (${targetPolicy.sql})` : ''
    const policyParams = targetPolicy ? targetPolicy.params : []
    const policyInClause = targetPolicy
      ? ` AND t."${rel.targetPk ?? 'id'}" IN (SELECT "${rel.targetPk ?? 'id'}" FROM "${modelToTable(rel.targetModel)}" WHERE ${targetPolicy.sql})`
      : ''

    // Field rules on the target — @guarded, @encrypted, @omit, field @allow.
    const targetFieldPolicy = ctx.fieldPolicyMap?.[rel.targetModel] ?? null
    const shapeRelated = (rows_, opts) =>
      targetFieldPolicy && Object.keys(targetFieldPolicy).length
        ? rows_.map(r => applyFieldPolicyTo(r, rel.targetModel, targetFieldPolicy, ctx, opts))
        : rows_

    // Deserialize → resolve any @from row references → compute → apply the
    // target's field rules. One definition: the three branches below build three
    // different SELECTs and each used to finish its rows with its own copy of
    // this expression, so a step added to one was absent from the other two.
    const finishRelated = (rawRows, opts, requested = null) => {
      const staged = rawRows.map(r => deserializeFromRow(
        coerceBooleans(deserializeRow(r, targetJsonFields), ctx.boolMap?.[rel.targetModel] ?? new Set()),
        targetFrom))
      resolveFromRowRefs(readDb, staged, targetFrom, ctx)
      return shapeRelated(
        staged.map(r => applyComputed(r, rel.targetModel, computedFns, ctx, requested)),
        opts)
    }

    const nestedInclude = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.include ?? null : null
    const nestedSelect  = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.select  ?? null : null
    // Optional per-include filter: include: { posts: { where: { published: true } } }
    const relWhere = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.where ?? null : null
    const relWhereSql = (extraAlias) => {
      if (!relWhere) return { clause: '', params: [] }
      const p = []
      const ws = buildWhere(relWhere, p, null, extraAlias ?? null, null, null, ctx.filterKindMap?.[rel.targetModel])
      return { clause: ws ? ` AND (${ws})` : '', params: p }
    }
    // Soft delete mode for related table
    const nestedMode    = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.withDeleted ? 'withDeleted' : relInclude.onlyDeleted ? 'onlyDeleted' : 'live'
      : 'live'
    // @@hasTemplates mode for related table — same shape as soft-delete mode.
    const nestedHtMode  = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.withTemplates ? 'withTemplates' : relInclude.onlyTemplates ? 'onlyTemplates' : 'instances'
      : 'instances'
    // The window's mode for the related table — the third of the same shape. `asOf`
    // is deliberately NOT surfaced per include: one read is read at one moment,
    // and a parent read at now holding children read at a different instant is
    // a row nobody could explain.
    const nestedEffMode = typeof relInclude === 'object' && relInclude !== true
      ? relInclude.withExpired ? 'withExpired' : relInclude.onlyExpired ? 'onlyExpired' : 'inForce'
      : 'inForce'

    // An include takes the same flags as a read, so it owes the same refusal:
    // `onlyDeleted` against a target that declares no @@softDelete answers that
    // target's live rows, which is the opposite of the question (FJS-293). The
    // top-level read refuses in sdMode/htMode; this path builds its own SQL and
    // reaches neither.
    if (nestedMode === 'onlyDeleted' && !(softDeleteMap[rel.targetModel] ?? false))
      throw new CapabilityNotDeclaredError(rel.targetModel, 'onlyDeleted', '@@softDelete',
        'Every row here is live, so there is no deleted-only view to include.')
    if (nestedHtMode === 'onlyTemplates' && (ctx.hasTemplatesMap?.[rel.targetModel] ?? null) === null)
      throw new CapabilityNotDeclaredError(rel.targetModel, 'onlyTemplates', '@@hasTemplates',
        'This model has no template rows, so there is no template-only view to include.')
    if (nestedEffMode === 'onlyExpired' && (ctx.effectiveMap?.[rel.targetModel] ?? null) === null)
      throw new CapabilityNotDeclaredError(rel.targetModel, 'onlyExpired', '@@expires or @@effective',
        'Every row here counts at every instant, so there is no out-of-window view to include.')
    if (nestedEffMode === 'onlyExpired' && !ctx.effectiveMap[rel.targetModel].imposed)
      throw new ValidationError([{ path: ['include', relName, 'onlyExpired'], message:
        `onlyExpired on an include of ${rel.targetModel} has no moment to be out of force at — its ` +
        `@@effective window is asked rather than imposed, and an include takes no asOf. Read ` +
        `${rel.targetModel} with asOf instead` }])

    const targetJsonFields  = jsonMap[rel.targetModel]      ?? new Set()
    // The target's @from fields. These paths build their own SQL, so nothing
    // appends the subqueries unless this does — before which an included row
    // carried no @from field at all and a @computed field reading one computed
    // from undefined, silently, on the include path only.
    const targetFrom        = fromMap?.[rel.targetModel] ?? null
    const targetSoftDelete  = softDeleteMap[rel.targetModel] ?? false
    const targetHtField     = ctx.hasTemplatesMap?.[rel.targetModel] ?? null
    const targetHasTemplates = targetHtField !== null

    // Build the @@hasTemplates SQL fragment for nested includes. Same logic as
    // injectHasTemplatesFilter but emitted as raw SQL alongside the existing
    // hand-built sdWhere — these include paths bypass buildWhere entirely for
    // performance, so the filter has to be appended manually here.
    const htClause = (targetHasTemplates && nestedHtMode !== 'withTemplates')
      ? (nestedHtMode === 'onlyTemplates'
          ? `"${targetHtField}" = 1`
          : `"${targetHtField}" = 0`)
      : null

    // The @@effective window for the target table, as SQL plus its binds.
    //
    // It is BOUND rather than inlined, where `htClause` is a literal: the edge
    // is a value and a value in a SQL string is how a window starts answering a
    // caller's text. A relation read under an expired parent is the shape this
    // closes — `cart.findMany({ include: { reservations: true } })` returned
    // dead holds while `stockReservation.findMany()` did not, which is one
    // model answering two ways.
    //
    // Only an IMPOSED window reaches here. An `@@effective` target is history
    // that this row points at — `subscription.planVersion` is the price still
    // being charged — and filtering it would answer the pointer with null.
    const targetWin = ctx.effectiveMap?.[rel.targetModel] ?? null
    const effWhere  = (() => {
      if (!targetWin?.imposed || nestedEffMode === 'withExpired') return null
      const at = targetWin.kind === 'day' ? nowISO(ctx.now).slice(0, 10) : nowISO(ctx.now)
      const parts = []
      const binds = []
      if (nestedEffMode === 'onlyExpired') {
        if (targetWin.from) { parts.push(`"${tcol(targetWin.from)}" > ?`);  binds.push(at) }
        if (targetWin.to)   { parts.push(`"${tcol(targetWin.to)}" <= ?`);   binds.push(at) }
        return { sql: `(${parts.join(' OR ')})`, params: binds }
      }
      if (targetWin.from) { parts.push(`("${tcol(targetWin.from)}" IS NULL OR "${tcol(targetWin.from)}" <= ?)`); binds.push(at) }
      if (targetWin.to)   { parts.push(`("${tcol(targetWin.to)}" IS NULL OR "${tcol(targetWin.to)}" > ?)`);      binds.push(at) }
      return { sql: parts.join(' AND '), params: binds }
    })()

    if (rel.kind === 'belongsTo') {
      const fkValues = [...new Set(rows.map(r => r[rel.foreignKey]).filter(v => v != null))]
      if (!fkValues.length) { rows.forEach(r => r[relName] = null); continue }

      const parsedNested = nestedSelect
        ? parseSelectArg(nestedSelect, rel.targetModel, relationMap, computedSets, nestedInclude,
                         targetFrom ? { [rel.targetModel]: new Map(Object.entries(targetFrom)) } : null,
                         computedFns)
        : null

      let sqlCols = parsedNested?.sqlCols ?? '*'
      if (parsedNested && sqlCols !== '*' && !sqlCols.includes(`"${tcol(rel.referencedKey)}"`)) {
        sqlCols = `"${tcol(rel.referencedKey)}", ${sqlCols}`
        parsedNested.injectedFKs.add(rel.referencedKey)
      }
      sqlCols = withFromCols(sqlCols, targetFrom, parsedNested)

      // Build WHERE with soft delete filter for target table
      const sdParams = []
      let sdWhere = ''
      if (targetSoftDelete && nestedMode !== 'withDeleted') {
        const ph   = fkValues.map(() => '?').join(', ')
        const sdFilter = nestedMode === 'onlyDeleted'
          ? `"${tcol('deletedAt')}" IS NOT NULL AND "${tcol(rel.referencedKey)}" IN (${ph})`
          : `"${tcol('deletedAt')}" IS NULL AND "${tcol(rel.referencedKey)}" IN (${ph})`
        sdWhere = sdFilter
        sdParams.push(...fkValues)
      } else {
        const ph = fkValues.map(() => '?').join(', ')
        sdWhere = `"${tcol(rel.referencedKey)}" IN (${ph})`
        sdParams.push(...fkValues)
      }
      // Append @@hasTemplates filter — composes onto whatever sdWhere produced.
      if (htClause) sdWhere = `${sdWhere} AND ${htClause}`
      if (effWhere) { sdWhere = `${sdWhere} AND ${effWhere.sql}`; sdParams.push(...effWhere.params) }
      // Per-include where filter (belongsTo: filters the parent → nulls if excluded)
      const rw = relWhereSql(null)

      const related = finishRelated(
        runInclude(relDb, rel.targetModel, 'include',
          `SELECT ${sqlCols} FROM "${modelToTable(rel.targetModel)}" WHERE ${sdWhere}${rw.clause}${policyClause}`,
          [...sdParams, ...rw.params, ...policyParams]),
        parsedNested
          ? { mode: 'select', selectedFields: parsedNested.requestedFields }
          : { mode: 'single' },
        parsedNested?.requestedFields)

      const mergedInclude = { ...(nestedInclude ?? {}), ...(parsedNested?.relationSelects ?? {}) }
      if (Object.keys(mergedInclude).length)
        resolveIncludes(readDb, related, mergedInclude, rel.targetModel, ctx)

      const byKey = new Map(related.map(r => [r[rel.referencedKey], r]))
      for (const row of rows) {
        const raw = byKey.get(row[rel.foreignKey]) ?? null
        row[relName] = raw && parsedNested
          ? Object.fromEntries(Object.entries(raw).filter(([k]) => parsedNested.requestedFields.has(k) && !parsedNested.injectedFKs.has(k)))
          : raw
      }

    } else if (rel.kind === 'manyToMany') {
      // Implicit m2m — JOIN through the join table.
      // Select j.selfKey alongside t.* so we can group in one pass — no second query.
      const pkField  = rel.referencedKey ?? rel.selfPk ?? 'id'
      const pkValues = [...new Set(rows.map(r => r[pkField]).filter(v => v != null))]
      if (!pkValues.length) { rows.forEach(r => r[relName] = rel.toOne ? null : []); continue }

      const ph      = pkValues.map(() => '?').join(', ')
      const rwM = relWhereSql('t')   // target aliased `t` in the m2m join query

      // @edge fields on the target that decorate THIS join → surface under their
      // namespace, pulled from the join row (the traversal binds the dimension).
      const edgeDescs = Object.values(edgeMap?.[rel.targetModel] ?? {})
        .filter(d => d.storage === 'decorate' && d.table === rel.joinTable)
      const edgeSelect = edgeDescs.map(d => `, j."${d.col}" AS "__edge_${d.col}"`).join('')

      // The target is aliased `t` here, so the @from correlation has to be too.
      const m2mFrom = targetFrom ? `, ${fromSelectExpr(targetFrom, true)}` : ''

      const rawRows = runInclude(relDb, rel.targetModel, 'include',
        `SELECT t.*, j."${rel.selfKey}" AS __jSelfKey${edgeSelect}${m2mFrom} FROM "${modelToTable(rel.targetModel)}" t ` +
        `INNER JOIN "${rel.joinTable}" j ON j."${rel.targetKey}" = t."${tcol(rel.targetPk ?? 'id')}" ` +
        `WHERE j."${rel.selfKey}" IN (${ph})${rwM.clause}${policyInClause}`,
        [...pkValues, ...rwM.params, ...policyParams])

      // Strip __jSelfKey before processing so it doesn't leak into the output row
      const selfKeys = rawRows.map(r => { const k = r.__jSelfKey; delete r.__jSelfKey; return k })

      // Pull edge values off each raw row (and strip the temp cols) before shaping.
      const edgeBags = rawRows.map(r => {
        if (!edgeDescs.length) return null
        const bag = {}
        for (const d of edgeDescs) {
          const alias = `__edge_${d.col}`
          const raw = r[alias]
          delete r[alias]
          ;(bag[d.as] ??= {})[d.field] = coerceEdgeValue(raw, d)
        }
        return bag
      })

      const related = finishRelated(rawRows, { mode: 'list' })

      // Attach namespaced edge values onto each shaped target row.
      if (edgeDescs.length) {
        for (let i = 0; i < related.length; i++) {
          const bag = edgeBags[i]
          if (bag) for (const ns in bag) related[i][ns] = { ...(related[i][ns] ?? {}), ...bag[ns] }
        }
      }

      const mergedInclude = nestedInclude ?? {}
      if (Object.keys(mergedInclude).length)
        resolveIncludes(readDb, related, mergedInclude, rel.targetModel, ctx)

      const grouped = new Map()
      for (const row of rows) grouped.set(row[pkField], [])
      for (let i = 0; i < related.length; i++) {
        const arr = grouped.get(selfKeys[i])
        if (arr) arr.push(related[i])
      }

      for (const row of rows) {
        row[relName] = grouped.get(row[pkField]) ?? []
      }

    } else {
      const pkValues = [...new Set(rows.map(r => r[rel.referencedKey]).filter(v => v != null))]
      if (!pkValues.length) { rows.forEach(r => r[relName] = rel.toOne ? null : []); continue }

      const parsedNested = nestedSelect
        ? parseSelectArg(nestedSelect, rel.targetModel, relationMap, computedSets, nestedInclude,
                         targetFrom ? { [rel.targetModel]: new Map(Object.entries(targetFrom)) } : null,
                         computedFns)
        : null

      let sqlCols = parsedNested?.sqlCols ?? '*'
      if (parsedNested && sqlCols !== '*' && !sqlCols.includes(`"${tcol(rel.foreignKey)}"`)) {
        sqlCols = `"${tcol(rel.foreignKey)}", ${sqlCols}`
        parsedNested.injectedFKs.add(rel.foreignKey)
      }
      sqlCols = withFromCols(sqlCols, targetFrom, parsedNested)

      const ph = pkValues.map(() => '?').join(', ')
      let sdWhere
      if (targetSoftDelete && nestedMode !== 'withDeleted') {
        const sdClause = nestedMode === 'onlyDeleted'
          ? `"${tcol('deletedAt')}" IS NOT NULL` : `"${tcol('deletedAt')}" IS NULL`
        sdWhere = `${sdClause} AND "${tcol(rel.foreignKey)}" IN (${ph})`
      } else {
        sdWhere = `"${tcol(rel.foreignKey)}" IN (${ph})`
      }
      if (htClause) sdWhere = `${sdWhere} AND ${htClause}`
      const effBinds = []
      if (effWhere) { sdWhere = `${sdWhere} AND ${effWhere.sql}`; effBinds.push(...effWhere.params) }
      const rwH = relWhereSql(null)

      const related = finishRelated(
        runInclude(relDb, rel.targetModel, 'include',
          `SELECT ${sqlCols} FROM "${modelToTable(rel.targetModel)}" WHERE ${sdWhere}${rwH.clause}${policyClause}`,
          [...pkValues, ...effBinds, ...rwH.params, ...policyParams]),
        parsedNested
          ? { mode: 'select', selectedFields: parsedNested.requestedFields }
          : { mode: 'list' },
        parsedNested?.requestedFields)

      const mergedInclude = { ...(nestedInclude ?? {}), ...(parsedNested?.relationSelects ?? {}) }
      if (Object.keys(mergedInclude).length)
        resolveIncludes(readDb, related, mergedInclude, rel.targetModel, ctx)

      const grouped = new Map()
      for (const r of related) {
        const k = r[rel.foreignKey]
        if (!grouped.has(k)) grouped.set(k, [])
        grouped.get(k).push(r)
      }

      for (const row of rows) {
        const group = grouped.get(row[rel.referencedKey]) ?? []
        const shaped = parsedNested
          ? group.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => parsedNested.requestedFields.has(k) && !parsedNested.injectedFKs.has(k))))
          : group
        row[relName] = rel.toOne ? (shaped[0] ?? null) : shaped
      }
    }
  }

  return rows
}
