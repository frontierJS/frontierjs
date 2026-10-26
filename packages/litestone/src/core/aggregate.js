// aggregate.js — the aggregate verb: one SELECT of COUNT/SUM/AVG/MIN/MAX,
// GROUP_CONCAT and the named aggregates over the visible rows, answered as
// one object. A verb and not a helper, so it goes into the table literal
// under its own name.
//
// Built once per table by `makeTable`, which hands it the read connection
// and the table's refusals and column helpers, and takes back the one verb.

import { buildNamedAggExpr, extractNamedAggs } from './query.js'

export function makeAggregate(shape, ctx, deps) {
  const { tableName, modelName } = shape
  const {
    readDb, plugins, refuseRecursive, refuseAggregateKeys, namedAggFields, refuseCountShape,
    refuseMixedCurrency, visibleWhere, _aggCol, needsTiming, fireQuery, hydrateCols, exactSum,
    buildWhereWithEncryption,
  } = deps

  // ── aggregate ────────────────────────────────────────────────────────────
  // db.order.aggregate({ _sum: { amount: true }, _avg: { amount: true }, _count: true, _min: { amount: true }, _max: { amount: true }, where: {...} })
  // Returns: { _sum: { amount: 1200 }, _avg: { amount: 40 }, _count: 30, _min: { amount: 5 }, _max: { amount: 200 } }
  async function aggregate(args = {}) {
    refuseRecursive('aggregate', args)
    // A @@gate is a plugin's beforeRead, and three read methods never called
    // it: a model gated at SYSADMIN answered a level-4 caller's COUNT, its
    // GROUP BY and its full-text search. A row policy compiles into the WHERE
    // and did apply, which is what hid this — the gate is the layer that
    // refuses OUTRIGHT, and it is the one an aggregate over a gated model
    // needs (FJS-262).
    if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
    const { where, _count, _sum, _avg, _min, _max, _stringAgg } = args
    // Every name this method can put inside a quoted identifier. Missing one
    // is silent: SQLite reads the unresolvable identifier as a string constant
    // and the aggregate answers it (FJS-202).
    refuseAggregateKeys('aggregate', [
      ...[_sum, _avg, _min, _max].filter(v => v && typeof v === 'object').flatMap(v => Object.keys(v)),
      ...(_stringAgg && typeof _stringAgg === 'object' ? [_stringAgg.field, _stringAgg.orderBy] : []),
      ...namedAggFields(extractNamedAggs(args).map(([, spec]) => spec)),
    ])
    refuseCountShape('aggregate', _count)
    refuseMixedCurrency('aggregate', args)
    const params = []
    // A SELECT-list value (a _stringAgg separator, a named aggregate's
    // filter) is bound before the WHERE's, because it comes first in the
    // statement. Pushed onto one array they bound in the wrong order: a
    // separator compared against the where's column and the where's value
    // joined the strings, so _stringAgg beside any where answered [].
    const selectParams = []

    // The flags ride in `args`, not a hardcoded 'live'/'instances'. Both were
    // pinned here, so `aggregate({ _count: true, onlyDeleted: true })` counted
    // the LIVE rows and `onlyTemplates` counted the instances — the opposite
    // answer to the question asked, from the method whose whole output is one
    // number nothing can cross-check (FJS-263).
    const { where: exclWhere, policy: policyResult } = visibleWhere('aggregate', where, args)
    const whereSql = buildWhereWithEncryption(exclWhere, params)

    // Build SELECT columns
    const selects = []
    if (_count) {
      // _count: true → COUNT(*)
      // _count: { distinct: 'field' } → COUNT(DISTINCT "field")
      if (typeof _count === 'object' && _count.distinct) {
        selects.push(`COUNT(DISTINCT ${_aggCol(_count.distinct)}) AS "__count"`)
      } else {
        selects.push(`COUNT(*) AS "__count"`)
      }
    }
    for (const agg of ['_sum', '_avg', '_min', '_max']) {
      const spec = args[agg]
      if (!spec || spec === true) continue
      const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[agg]
      for (const [field, wanted] of Object.entries(spec)) {
        if (!wanted) continue
        selects.push(`${fn}(${_aggCol(field)}) AS "${agg}__${field}"`)
      }
    }
    // _stringAgg: { field: 'name', separator: ', ', orderBy: 'name' }
    if (_stringAgg) {
      const { field, separator = ',', orderBy: saOrderBy } = _stringAgg
      if (!field) throw new Error('aggregate() _stringAgg requires a field')
      // SQLite syntax: GROUP_CONCAT(col, separator ORDER BY ...) — separator
      // MUST precede ORDER BY. Putting ORDER BY before the separator silently
      // causes the separator to be ignored and the default "," is used.
      const orderClause = saOrderBy ? ` ORDER BY ${_aggCol(saOrderBy)}` : ''
      selects.push(`GROUP_CONCAT(${_aggCol(field)}, ?${orderClause}) AS "__stringAgg__${field}"`)
      selectParams.push(separator)
    }

    // Named aggregates: any _-prefixed key with { count/sum/avg/min/max, filter? }
    const namedAggs = extractNamedAggs(args).filter(([k]) =>
      !['_count','_sum','_avg','_min','_max','_stringAgg'].includes(k)
    )
    for (const [key, spec] of namedAggs) {
      selects.push(buildNamedAggExpr(key, spec, selectParams))
    }

    if (!selects.length) throw new Error('aggregate() requires at least one aggregation (_count, _sum, _avg, _min, _max, _stringAgg, or a named aggregate)')

    let sql = `SELECT ${selects.join(', ')} FROM "${tableName}"`
    if (whereSql && policyResult) sql += ` WHERE (${whereSql}) AND (${policyResult.sql})`
    else if (whereSql)            sql += ` WHERE ${whereSql}`
    else if (policyResult)        sql += ` WHERE ${policyResult.sql}`
    if (policyResult) params.push(...policyResult.params)

    const _nt = needsTiming()
    const _t0 = _nt ? performance.now() : 0
    params.unshift(...selectParams)
    const raw = readDb.query(sql).get(...params) ?? {}
    fireQuery({ operation: 'aggregate', args, sql, params, duration: _nt ? performance.now() - _t0 : 0, rowCount: 1 })

    // Shape result
    const result = {}
    if (_count)      result._count = raw.__count ?? 0
    for (const agg of ['_sum', '_avg', '_min', '_max']) {
      const spec = args[agg]
      if (!spec || spec === true) continue
      result[agg] = {}
      for (const [field, wanted] of Object.entries(spec)) {
        if (!wanted) continue
        result[agg][field] = raw[`${agg}__${field}`] ?? null
        if (agg === '_sum') exactSum('aggregate', field, result[agg][field])
      }
      if (agg === '_min' || agg === '_max') result[agg] = hydrateCols(result[agg])
    }
    if (_stringAgg) {
      result._stringAgg = { [_stringAgg.field]: raw[`__stringAgg__${_stringAgg.field}`] ?? null }
    }
    // Named aggregates
    for (const [key] of namedAggs) {
      result[key] = raw[`__nagg__${key}`] ?? null
    }
    return result
  }

  return { aggregate }
}
