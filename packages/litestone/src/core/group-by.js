// group-by.js — the groupBy verb: one SELECT with GROUP BY over the group
// keys, the aggregates and the optional interval bucket, filtered by HAVING,
// then gap-filled on the caller's calendar. A verb and not a helper, so it
// goes into the table literal under its own name.
//
// Built once per table by `makeTable`, which hands it the read connection
// and the table's refusals and column helpers, and takes back the one verb.

import { ValidationError } from './validate.js'
import { buildNamedAggExpr, extractNamedAggs, pageSql, quoteIdent } from './query.js'
import { offsetSpans, partsIn, plainDateIn } from '@frontierjs/toolbelt/datetime'

// ─── HAVING clause builder for groupBy() ─────────────────────────────────────
// Converts { gt: 5 } or scalar 5 into a SQL fragment like "COUNT(*) > ?"
function buildAggHaving(expr, cond, params) {
  if (cond == null) return null
  if (typeof cond !== 'object') {
    params.push(cond)
    return `${expr} = ?`
  }
  const parts = []
  for (const [op, val] of Object.entries(cond)) {
    switch (op) {
      case 'gt':  params.push(val); parts.push(`${expr} > ?`);  break
      case 'gte': params.push(val); parts.push(`${expr} >= ?`); break
      case 'lt':  params.push(val); parts.push(`${expr} < ?`);  break
      case 'lte': params.push(val); parts.push(`${expr} <= ?`); break
      case 'not': params.push(val); parts.push(`${expr} != ?`); break
    }
  }
  return parts.length ? parts.join(' AND ') : null
}

export function makeGroupBy(shape, ctx, deps) {
  const { tableName, modelName } = shape
  const {
    readDb, plugins, refuseRecursive, refuseAggregateKeys, namedAggFields, refuseCountShape,
    refuseMixedCurrency, col, visibleWhere, _derivedSql, _aggCol, T, needsTiming, fireQuery,
    hydrateCols, exactSum, buildWhereWithEncryption,
  } = deps

  // ── groupBy ──────────────────────────────────────────────────────────────
  // db.order.groupBy({ by: ['status'], _count: true, _sum: { amount: true }, where: {...}, having: {...}, orderBy: {...}, limit, offset })
  // Returns: [{ status: 'paid', _count: 10, _sum: { amount: 500 } }, ...]
  async function groupBy(args = {}) {
    refuseRecursive('groupBy', args)
    if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
    const { by, where, having, limit, offset, _count, _sum, _avg, _min, _max, _stringAgg, fillGaps, timeZone, weekStart = 'monday' } = args
    // findMany takes an array of terms, and a total order over two group keys
    // needs one. Flattened to [key, dir] pairs because two `_sum` terms would
    // collapse into one key in an object.
    const orderTerms = []
    if (Array.isArray(args.orderBy)) {
      args.orderBy.forEach((item, i) => {
        if (!item || typeof item !== 'object' || Array.isArray(item))
          throw new ValidationError([{ path: ['orderBy', i], message:
            `orderBy[${i}] on ${modelName}.groupBy must be an object such as { ${by?.[0] ?? 'field'}: 'asc' }` }])
        orderTerms.push(...Object.entries(item))
      })
    } else if (args.orderBy && typeof args.orderBy === 'object') {
      orderTerms.push(...Object.entries(args.orderBy))
    }
    const orderBy = orderTerms.length ? orderTerms : null
    const interval = args.interval   // { fieldName: 'unit' }
    // A week is named by its first day, and which day that is belongs to the
    // business: a Sunday-start tenant read Monday-cut buckets as wrong weeks.
    // Refused beside any other unit, where it would be quietly ignored.
    if (!['monday', 'sunday'].includes(weekStart))
      throw new ValidationError([{ path: ['weekStart'], message: `groupBy() weekStart '${weekStart}' is not a week start — use 'monday' or 'sunday'` }])
    if ('weekStart' in args && Object.values(interval ?? {})[0] !== 'week')
      throw new ValidationError([{ path: ['weekStart'], message: `groupBy() weekStart cuts a week — pass interval: { <DateTime field>: 'week' } beside it` }])
    // S3: an interval is cut on the wall clock of `timeZone` (IANA), not UTC's.
    // Refused without an interval, where it would mean nothing and quietly
    // be ignored — the shape of every silent wrong answer a report can give.
    if (timeZone != null) {
      if (!interval)
        throw new ValidationError([{ path: ['timeZone'], message: `groupBy() timeZone cuts an interval — pass interval: { <DateTime field>: 'month' } beside it` }])
      try { offsetSpans(0, 0, timeZone) }
      catch { throw new ValidationError([{ path: ['timeZone'], message: `groupBy() timeZone '${timeZone}' is not an IANA time zone (e.g. 'Asia/Tokyo')` }]) }
    }
    let zoneShift = null   // set below, once the WHERE is built
    if (!by?.length) throw new Error('groupBy() requires a "by" array of field names')
    // `by` is the naming tier — a GROUP BY over stored text is at least
    // self-consistent, so an opaque column passes here and not below. It
    // reached SQLite unchecked, which answered `no such column: order.label`:
    // a refusal, but one naming a table rather than the model and never the
    // reason.
    refuseAggregateKeys('groupBy', by, false)
    refuseAggregateKeys('groupBy', [
      ...[_sum, _avg, _min, _max].filter(v => v && typeof v === 'object').flatMap(v => Object.keys(v)),
      ...(_stringAgg && typeof _stringAgg === 'object' ? [_stringAgg.field, _stringAgg.orderBy] : []),
      ...namedAggFields(extractNamedAggs(args).map(([, spec]) => spec)),
    ])
    refuseCountShape('groupBy', _count)
    refuseMixedCurrency('groupBy', args, by, [having, ...orderTerms.map(([k, v]) => ({ [k]: v }))])

    // ── Interval / date truncation ───────────────────────────────────────
    // interval: { createdAt: 'month' }
    // Only one interval field supported per query.
    let intervalField = null, intervalUnit = null
    if (interval) {
      const entries = Object.entries(interval)
      if (entries.length !== 1)
        throw new Error('groupBy() interval only supports one field at a time')
      ;[intervalField, intervalUnit] = entries[0]

      // Validate unit
      const VALID_UNITS = ['year', 'quarter', 'month', 'week', 'day', 'hour']
      if (!VALID_UNITS.includes(intervalUnit))
        throw new Error(`groupBy() interval unit '${intervalUnit}' is invalid. Use: ${VALID_UNITS.join(', ')}`)

      // It becomes STRFTIME('%Y', "table"."field") — a quoted identifier like
      // any other, so an unknown name is a string constant and every row
      // groups together. The type check below only ever ran when the field
      // WAS found.
      refuseAggregateKeys('groupBy interval', [intervalField], false)

      // Validate field is DateTime on the model
      const modelDef = shape.model
      const intervalFieldDef = modelDef?.fields.find(f => f.name === intervalField)
      if (intervalFieldDef && intervalFieldDef.type.name !== 'DateTime' && intervalFieldDef.type.name !== 'String')
        throw new Error(`groupBy() interval field '${intervalField}' must be a DateTime field, got '${intervalFieldDef.type.name}'`)
    }

    // ── `having` and an aggregate `orderBy` name columns too ──────────────
    //
    // Both put a caller's name inside an aggregate expression and neither
    // reached refuseAggregateKeys, so the ladder that refuses `_max` over a
    // @guarded column refused nothing here: a binary search on a HAVING
    // threshold recovered an exact value in 18 requests and one aggregate
    // sort ordered every group by it — `FJS-393`'s attack on the two
    // grammars that had no walk (`FJS-954`). The same gap swallowed a typo,
    // because SQLite reads an unresolvable quoted identifier as a string
    // constant and `SUM('nope') > 1` is simply false (`FJS-202`).
    //
    // Checked here rather than beside the other refusals because `orderBy`
    // may name the interval field, which is resolved just above.
    const AGG_FNS = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }
    if (having && typeof having === 'object') {
      const names = []
      for (const [aggKey, spec] of Object.entries(having)) {
        if (aggKey === '_count') continue
        if (!(aggKey in AGG_FNS))
          throw new ValidationError([{ path: ['having', aggKey], message:
            `Unknown having key '${aggKey}' on ${modelName}.groupBy. A HAVING filters an aggregate: ` +
            `_count, ${Object.keys(AGG_FNS).join(', ')}. A named aggregate cannot be filtered here — it is ` +
            `computed in the SELECT, so filter the returned rows.` }])
        if (spec && typeof spec === 'object') names.push(...Object.keys(spec))
      }
      refuseAggregateKeys('having', names)
    }
    if (orderBy) {
      const groupKeys = new Set(by)
      if (intervalField) groupKeys.add(intervalField)
      const names = []
      for (const [key, val] of orderBy) {
        if (key === '$raw')
          // A fragment written for findMany names columns this statement does
          // not have. Refused rather than emitted as `"$raw" ASC`, which
          // SQLite reads as a string constant and sorts by nothing.
          throw new ValidationError([{ path: ['orderBy', '$raw'], message:
            `orderBy $raw is not supported on groupBy — its ORDER BY is over the group keys and aggregates, ` +
            `not over ${modelName}'s columns. Put the expression in the aggregate, or sort the result in JS` }])
        if (key === '_count' || key === '_stringAgg') continue
        if (key in AGG_FNS) {
          if (val && typeof val === 'object') names.push(...Object.keys(val))
          continue
        }
        if (key.startsWith('_'))
          throw new ValidationError([{ path: ['orderBy', key], message:
            `Cannot orderBy '${key}' on ${modelName}.groupBy — a named aggregate is computed in the SELECT and ` +
            `cannot be sorted on. Sort the returned rows, or ask for it as ${Object.keys(AGG_FNS).join(' / ')}.` }])
        if (!groupKeys.has(key))
          throw new ValidationError([{ path: ['orderBy', key], message:
            `Cannot orderBy '${key}' on ${modelName}.groupBy — a groupBy sorts by a group key or an aggregate, and ` +
            `'${key}' is neither. Group keys: ${[...groupKeys].join(', ')}. Aggregates: _count, ` +
            `${Object.keys(AGG_FNS).join(', ')}.` }])
      }
      refuseAggregateKeys('orderBy', names)
    }

    // Days since the week began, from %w (Sunday is 0).
    const weekday = expr => weekStart === 'sunday'
      ? `CAST(STRFTIME('%w', ${expr}) AS INTEGER)`
      : `((CAST(STRFTIME('%w', ${expr}) AS INTEGER) + 6) % 7)`

    // Build STRFTIME expression for a given field + unit. With a time zone the
    // instant is first moved onto that zone's wall clock (`zoneShift`).
    function strftimeExpr(field, unit) {
      // `expr` and not `col`, which is this table's field → column resolver.
      const raw  = `"${tableName}"."${col(field)}"`
      const expr = zoneShift ? `DATETIME(${raw}, ${zoneShift})` : raw
      switch (unit) {
        case 'year':    return `STRFTIME('%Y', ${expr})`
        case 'quarter': return `STRFTIME('%Y', ${expr}) || '-Q' || (((CAST(STRFTIME('%m', ${expr}) AS INTEGER) - 1) / 3) + 1)`
        case 'month':   return `STRFTIME('%Y-%m', ${expr})`
        // The week's first date, so a week crossing New Year is one bucket.
        case 'week':    return `DATE(${expr}, '-' || ${weekday(expr)} || ' days')`
        case 'day':    return `STRFTIME('%Y-%m-%d', ${expr})`
        case 'hour':    return `STRFTIME('%Y-%m-%dT%H', ${expr})`
      }
    }

    // CTE step for gap-filling: advance by one interval unit
    function cteStep(unit) {
      switch (unit) {
        case 'year':    return '+1 year'
        case 'quarter': return '+3 months'
        case 'month':   return '+1 month'
        case 'week':    return '+7 days'
        case 'day':     return '+1 day'
        case 'hour':    return '+1 hour'
      }
    }

    // CTE date format for comparison with STRFTIME output
    function cteDateFormat(unit) {
      switch (unit) {
        case 'year':    return '%Y'
        case 'quarter': return null   // special case handled below
        case 'month':   return '%Y-%m'
        case 'week':    return '%Y-%m-%d'
        case 'day':     return '%Y-%m-%d'
        case 'hour':    return '%Y-%m-%dT%H'
      }
    }

    const params = []
    // A SELECT-list value (a _stringAgg separator, a named aggregate's
    // filter) is bound before the WHERE's, because it comes first in the
    // statement. Pushed onto one array they bound in the wrong order: a
    // separator compared against the where's column and the where's value
    // joined the strings, so _stringAgg beside any where answered [].
    const selectParams = []

    // WHERE clause — the flags ride in `args`, as aggregate (FJS-263).
    const { where: exclWhere, policy: policyResult } = visibleWhere('groupBy', where, args)
    const whereSql = buildWhereWithEncryption(exclWhere, params)

    // ── The zone, as SQL ─────────────────────────────────────────────────
    // SQLite has no zone database and bun:sqlite can register no function,
    // so the zone is stated as the fixed offsets it keeps over the rows this
    // call reads (toolbelt's offsetSpans) and a CASE picks each row's:
    // DATETIME(t, '+32400 seconds') is Tokyo's wall clock for t. Everything
    // inlined is a number this code computed; nothing the caller sent.
    // One extra read over the same WHERE names the UTC years holding rows,
    // and the spans cover those years only: a MIN/MAX range read the zone
    // across every empty year between, so one 9999-12-31 "never" date cost
    // eight thousand years of reads per call (FJS-2184). A gap between two
    // years holds no row, so whichever arm covers it picks nothing.
    if (timeZone != null) {
      const rawCol = `"${tableName}"."${col(intervalField)}"`
      const parts = [whereSql, policyResult?.sql].filter(Boolean)
      const years = readDb.query(
        `SELECT DISTINCT CAST(strftime('%Y', ${rawCol}) AS INTEGER) AS y FROM "${tableName}"` +
        ` WHERE ${[`${rawCol} IS NOT NULL`, ...parts].map(p => `(${p})`).join(' AND ')} ORDER BY y`,
      ).all(...params, ...(policyResult?.params ?? [])).map(r => r.y).filter(y => y != null)
      // Date.UTC reads a year below 100 as 19xx; setUTCFullYear does not.
      const yearStart = y => new Date(0).setUTCFullYear(y, 0, 1)
      const spans = []
      for (const y of years) {
        for (const sp of offsetSpans(yearStart(y), yearStart(y + 1), timeZone)) {
          if (spans.at(-1)?.offset !== sp.offset) spans.push(sp)
        }
      }
      if (!spans.length) spans.push({ offset: 0 })
      const mod = offset => `'${offset >= 0 ? '+' : ''}${offset / 1000} seconds'`
      zoneShift = spans.length === 1
        ? mod(spans[0].offset)
        : `CASE ${spans.slice(1).map((sp, i) =>
            `WHEN julianday(${rawCol}) < ${sp.from / 86400000 + 2440587.5} THEN ${mod(spans[i].offset)}`).join(' ')} ` +
          `ELSE ${mod(spans[spans.length - 1].offset)} END`
    }

    // ── SELECT columns ───────────────────────────────────────────────────
    const groupByCols = []   // SQL expressions for GROUP BY
    const selectCols  = []   // SQL expressions for SELECT

    for (const f of by) {
      if (f === intervalField) {
        const expr = strftimeExpr(intervalField, intervalUnit)
        selectCols.push(`${expr} AS "${intervalField}"`)
        groupByCols.push(expr)
      } else {
        // A derived key groups by its expression and is aliased to its name,
        // so the returned row carries the field the caller asked for.
        const d = _derivedSql(f)
        // Aliased back to the FIELD, so a grouped row carries the key the
        // caller grouped by rather than the column it is stored under.
        selectCols.push(d ? `${d} AS "${f}"` : `"${tableName}"."${col(f)}" AS "${f}"`)
        groupByCols.push(d ?? `"${tableName}"."${col(f)}"`)
      }
    }

    if (_count) {
      if (typeof _count === 'object' && _count.distinct) {
        selectCols.push(`COUNT(DISTINCT ${_aggCol(_count.distinct)}) AS "__count"`)
      } else {
        selectCols.push(`COUNT(*) AS "__count"`)
      }
    }
    for (const agg of ['_sum', '_avg', '_min', '_max']) {
      const spec = args[agg]
      if (!spec || spec === true) continue
      const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[agg]
      for (const [field, wanted] of Object.entries(spec)) {
        if (!wanted) continue
        selectCols.push(`${fn}(${_aggCol(field)}) AS "${agg}__${field}"`)
      }
    }
    if (_stringAgg) {
      const { field, separator = ',', orderBy: saOrderBy } = _stringAgg
      if (!field) throw new Error('groupBy() _stringAgg requires a field')
      // SQLite: separator must come before ORDER BY in GROUP_CONCAT.
      const orderClause = saOrderBy ? ` ORDER BY ${_aggCol(saOrderBy)}` : ''
      selectCols.push(`GROUP_CONCAT(${_aggCol(field)}, ?${orderClause}) AS "__stringAgg__${field}"`)
      selectParams.push(separator)
    }

    // Named aggregates
    const namedAggs = extractNamedAggs(args).filter(([k]) =>
      !['_count','_sum','_avg','_min','_max','_stringAgg'].includes(k)
    )
    for (const [key, spec] of namedAggs) {
      selectCols.push(buildNamedAggExpr(key, spec, selectParams))
    }

    // ── Gap filling — infer range from where clause if fillGaps: true ───
    // fillGaps: true        → infer from where[intervalField].gte/lte
    // fillGaps: false       → disable (even if interval is set)
    // fillGaps: { start, end } → explicit range
    // default when interval present → true (infer)
    let gapStart = null, gapEnd = null
    const shouldFill = interval && fillGaps !== false

    if (shouldFill) {
      if (fillGaps && typeof fillGaps === 'object' && fillGaps.start && fillGaps.end) {
        // Explicit range
        gapStart = fillGaps.start
        gapEnd   = fillGaps.end
      } else {
        // Infer from where clause — look for where[intervalField].gte/.gt and .lte/.lt
        const fieldWhere = where?.[intervalField]
        if (fieldWhere && typeof fieldWhere === 'object') {
          gapStart = fieldWhere.gte ?? fieldWhere.gt ?? null
          gapEnd   = fieldWhere.lte ?? fieldWhere.lt ?? null
        }
        // No range found — fall back to sparse (no gap fill)
        if (!gapStart || !gapEnd) {
          gapStart = null; gapEnd = null
        }
      }
    }
    // Each bound becomes a calendar date — the zone's, when there is one —
    // and is BOUND, never written into the statement. It was interpolated as
    // date('${gapStart}'), and since it arrives from fillGaps or the where
    // over the aggregate verb, a caller could close the quote and read any
    // table one bit per call (FJS-1650). A value that is not a date is
    // refused by name rather than coerced.
    const gapDate = (v, which) => {
      const ms = v instanceof Date ? v.getTime()
        : typeof v === 'number' ? v
        : typeof v === 'string' ? Date.parse(v)
        : NaN
      if (!Number.isFinite(ms))
        throw new ValidationError([{ path: ['fillGaps', which], message: `groupBy() gap fill ${which} ${JSON.stringify(v)} is not a date or an instant` }])
      // A bound written as a date IS a calendar date, and is that date in any
      // zone. Read as an instant it was UTC midnight, which is the evening
      // before west of Greenwich, so `start: '2026-01-01'` in Chicago filled
      // from December.
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
        return intervalUnit === 'hour' ? `${v} 00:00:00` : v
      // An hour bucket walks a wall clock to the hour, everything else a date.
      if (intervalUnit === 'hour') {
        if (!timeZone) return new Date(ms).toISOString().slice(0, 13).replace('T', ' ') + ':00:00'
        const p = partsIn(ms, timeZone)
        const two = n => String(n).padStart(2, '0')
        return `${String(p.year).padStart(4, '0')}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:00:00`
      }
      return timeZone ? plainDateIn(ms, timeZone) : new Date(ms).toISOString().slice(0, 10)
    }
    // The CTE steps from a bucket's FIRST day. Stepped from the bound's own
    // day, '+1 month' from 31 January is 3 March and February never filled,
    // and a start later in its month than the end (the 15th, then the 10th)
    // stopped one bucket short. A week starts on its Monday or Sunday, which
    // is the label the data rows carry.
    const bucketStart = (d) => {
      if (intervalUnit === 'week') {
        const t = new Date(`${d}T00:00:00Z`)
        const back = (t.getUTCDay() + (weekStart === 'sunday' ? 0 : 6)) % 7
        return new Date(t.getTime() - back * 864e5).toISOString().slice(0, 10)
      }
      if (intervalUnit === 'month')   return `${d.slice(0, 7)}-01`
      if (intervalUnit === 'year')    return `${d.slice(0, 4)}-01-01`
      if (intervalUnit === 'quarter') return `${d.slice(0, 4)}-${String(Math.floor((Number(d.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`
      return d
    }
    if (gapStart && gapEnd) {
      gapStart = bucketStart(gapDate(gapStart, 'start'))
      gapEnd   = bucketStart(gapDate(gapEnd, 'end'))
      // A recursive CTE makes one row per interval, and both bounds are the
      // caller's: a century of hours is 876,000 rows built per request.
      const MAX_GAP_INTERVALS = 10_000
      const UNIT_MS = { year: 365 * 864e5, quarter: 90 * 864e5, month: 28 * 864e5, week: 7 * 864e5, day: 864e5, hour: 36e5 }
      const span = Date.parse(gapEnd.replace(' ', 'T') + (gapEnd.length > 10 ? 'Z' : 'T00:00:00Z')) - Date.parse(gapStart.replace(' ', 'T') + (gapStart.length > 10 ? 'Z' : 'T00:00:00Z'))
      if (span / UNIT_MS[intervalUnit] > MAX_GAP_INTERVALS)
        throw new ValidationError([{ path: ['fillGaps'], message: `groupBy() gap fill from ${gapStart} to ${gapEnd} is more than ${MAX_GAP_INTERVALS} ${intervalUnit}s — narrow the range or pass fillGaps: false` }])
    }

    // ── Build SQL ────────────────────────────────────────────────────────
    let sql

    if (gapStart && gapEnd && intervalField) {
      // Gap-fill path: recursive CTE generates all intervals, LEFT JOIN data
      const step   = cteStep(intervalUnit)
      const fmt    = cteDateFormat(intervalUnit)
      // date() drops the time, so date(d, '+1 hour') is d again and the CTE
      // never ended: one request with interval hour and a gap fill held a
      // core for good. An hour walks datetime().
      const at     = intervalUnit === 'hour' ? 'datetime' : 'date'

      // CTE generates one row per interval between gapStart and gapEnd
      // For quarter, we generate dates and format them the same way as STRFTIME expr
      const cteLabel = intervalUnit === 'quarter'
        ? `STRFTIME('%Y', d) || '-Q' || (((CAST(STRFTIME('%m', d) AS INTEGER) - 1) / 3) + 1)`
        : `STRFTIME('${fmt}', d)`

      // Gap rows: SELECT from intervals LEFT JOIN, emit cteLabel for the interval field
      // Data rows: SELECT from main table with strftimeExpr — same as non-gap path
      // We need two separate SELECT column lists:
      //   gapCols: uses cteLabel (references intervals.d)
      //   dataCols: uses strftimeExpr (references tableName.intervalField)

      const otherByFields = by.filter(f => f !== intervalField)

      // Gap row columns
      const gapCols = [
        `${cteLabel} AS "${intervalField}"`,
        ...otherByFields.map(f => `NULL AS "${f}"`),
        ...(_count ? [`0 AS "__count"`] : []),
        ...['_sum', '_avg', '_min', '_max'].flatMap(agg => {
          const spec = args[agg]
          if (!spec || spec === true) return []
          return Object.entries(spec)
            .filter(([, v]) => v)
            .map(([field]) => `${agg === '_sum' ? '0' : 'NULL'} AS "${agg}__${field}"`)
        }),
      ]

      // Data row columns (same as selectCols — already built above with strftimeExpr)
      // dataWhere is used TWICE in the SQL: once in existsSubquery (NOT IN), once in UNION ALL.
      // SQLite processes ? params left-to-right so we push the where params twice.
      const dataWhereParts = []
      if (whereSql) dataWhereParts.push(whereSql)
      if (policyResult) dataWhereParts.push(policyResult.sql)
      const dataWhere = dataWhereParts.length ? ` WHERE ${dataWhereParts.join(' AND ')}` : ''

      // Collect the where params that go into the data WHERE clause
      const whereOnlyParams = params.slice()  // snapshot of params so far (already has whereSql values)
      params.length = 0  // reset — we'll re-push in the right order

      // Order: the CTE's two bounds, then existsSubquery, then UNION ALL
      params.push(gapStart, gapEnd)     // intervals CTE
      params.push(...whereOnlyParams)  // existsSubquery
      if (policyResult) params.push(...policyResult.params)  // existsSubquery policy
      params.push(...selectParams)     // UNION ALL's SELECT list
      params.push(...whereOnlyParams)  // UNION ALL
      if (policyResult) params.push(...policyResult.params)  // UNION ALL policy

      // The data subquery for the NOT IN check: the bucket LABEL of every
      // interval that has rows. It selected the raw column, which never
      // equals a label, so every interval with data came back twice — once
      // as a 0 gap row and once with its counts.
      const existsSubquery = `SELECT ${strftimeExpr(intervalField, intervalUnit)} FROM "${tableName}"${dataWhere} GROUP BY ${groupByCols.join(', ')}`

      sql = `
WITH RECURSIVE intervals(d) AS (
SELECT ${at}(?)
UNION ALL
SELECT ${at}(d, '${step}') FROM intervals WHERE ${at}(d, '${step}') <= ${at}(?)
)
SELECT DISTINCT ${gapCols.join(', ')}
FROM intervals
WHERE ${cteLabel} NOT IN (${existsSubquery})
UNION ALL
SELECT ${selectCols.join(', ')} FROM "${tableName}"${dataWhere} GROUP BY ${groupByCols.join(', ')}
`.trim()

      // NOTE: Potential optimization — if a 'calendar' table exists in this DB
      // (populated via 'litestone seed run calendar'), replace the recursive CTE
      // with a direct SELECT from calendar WHERE date BETWEEN gapStart AND gapEnd.
      // Calendar table has a B-tree index on 'date', making day-level queries
      // over multi-year ranges significantly faster. Not implemented — CTE is
      // sufficient for most use cases. Run `litestone seed run calendar`
      // to populate the table from the bundled seed.

    } else {
      // No gap fill — standard groupBy
      params.unshift(...selectParams)
      let baseSql = `SELECT ${selectCols.join(', ')} FROM "${tableName}"`
      if (whereSql && policyResult) baseSql += ` WHERE (${whereSql}) AND (${policyResult.sql})`
      else if (whereSql)            baseSql += ` WHERE ${whereSql}`
      else if (policyResult)        baseSql += ` WHERE ${policyResult.sql}`
      if (policyResult) params.push(...policyResult.params)
      baseSql += ` GROUP BY ${groupByCols.join(', ')}`
      sql = baseSql
    }

    // HAVING
    if (having) {
      const havingParts = []
      for (const [aggKey, spec] of Object.entries(having)) {
        if (aggKey === '_count') {
          const expr = buildAggHaving('COUNT(*)', spec, params)
          if (expr) havingParts.push(expr)
        } else {
          const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[aggKey]
          if (!fn) continue
          for (const [field, cond] of Object.entries(spec)) {
            const expr = buildAggHaving(`${fn}(${_aggCol(field)})`, cond, params)
            if (expr) havingParts.push(expr)
          }
        }
      }
      if (havingParts.length) sql += ` HAVING ${havingParts.join(' AND ')}`
    }

    // ORDER BY
    if (orderBy) {
      const orderParts = []
      for (const [key, val] of orderBy) {
        if (key === '_count') {
          orderParts.push(`COUNT(*) ${val === 'desc' ? 'DESC' : 'ASC'}`)
        } else if (key === '_stringAgg') {
          // orderBy: { _stringAgg: 'asc' } — order by the concatenated result
          if (_stringAgg?.field) {
            orderParts.push(`GROUP_CONCAT(${_aggCol(_stringAgg.field)}) ${val === 'desc' ? 'DESC' : 'ASC'}`)
          }
        } else if (key.startsWith('_')) {
          const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[key]
          if (fn && typeof val === 'object') {
            for (const [field, dir] of Object.entries(val)) {
              orderParts.push(`${fn}(${_aggCol(field)}) ${dir === 'desc' ? 'DESC' : 'ASC'}`)
            }
          }
        } else if (key === intervalField) {
          // Order by the truncated interval expression
          orderParts.push(`"${key}" ${val === 'desc' ? 'DESC' : 'ASC'}`)
        } else {
          orderParts.push(`"${key}" ${val === 'desc' ? 'DESC' : 'ASC'}`)
        }
      }
      if (orderParts.length) sql += ` ORDER BY ${orderParts.join(', ')}`
    } else if (gapStart && gapEnd && intervalField) {
      // The gap rows and the data rows are two halves of a UNION ALL, so
      // unordered the series answers every filled bucket before any real one.
      sql += ` ORDER BY ${quoteIdent(intervalField)} ASC`
    }

    const page = pageSql(limit, offset)
    if (page) { sql += page.sql; params.push(...page.params) }

    const _nt = needsTiming()
    const _t0 = _nt ? performance.now() : 0
    const raw = readDb.query(sql).all(...params)
    fireQuery({ operation: 'groupBy', args, sql, params, duration: _nt ? performance.now() - _t0 : 0, rowCount: raw.length })

    // Shape results
    return raw.map(r => {
      let out = {}
      for (const f of by) out[f] = r[f]
      out = hydrateCols(out)
      if (_count) out._count = r.__count ?? 0
      for (const agg of ['_sum', '_avg', '_min', '_max']) {
        const spec = args[agg]
        if (!spec || spec === true) continue
        out[agg] = {}
        for (const [field, wanted] of Object.entries(spec)) {
          if (!wanted) continue
          out[agg][field] = r[`${agg}__${field}`] ?? null
          if (agg === '_sum') exactSum('groupBy', field, out[agg][field])
        }
        if (agg === '_min' || agg === '_max') out[agg] = hydrateCols(out[agg])
      }
      if (_stringAgg) {
        out._stringAgg = { [_stringAgg.field]: r[`__stringAgg__${_stringAgg.field}`] ?? null }
      }
      // Named aggregates
      for (const [key] of namedAggs) {
        out[key] = r[`__nagg__${key}`] ?? null
      }
      return out
    })
  }

  return { groupBy }
}
