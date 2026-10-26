// find-many-cursor.js — the findManyCursor verb: keyset pagination, one
// SELECT ordered by the cursor fields and bounded by the previous page's last
// values, answered as { items, nextCursor, hasMore }. A verb and not a helper,
// so it goes into the table literal under its own name.
//
// Built once per table by `makeTable`, which hands it the read connection
// and the table's refusals and column helpers, and takes back the one verb.

import {
  buildCursorWhere, cursorOrderSql, decodeCursor, encodeCursor, extractCursorValues, trimAllToSelect,
} from './query.js'

export function makeFindManyCursor(shape, ctx, deps) {
  const { tableName, modelName, fromFields, columnMap } = shape
  const {
    readDb, plugins, refuseRecursive, cursorFields, visibleWhere, buildWhereWithEncryption,
    parseArgs, _hasFrom, _fromEntries, needsTiming, fireQuery, readAll, withIncludes,
  } = deps

  // ── findManyCursor ──────────────────────────────────────────────────────
  // Cursor-based pagination — O(log n) via index, unlike offset pagination.
  //
  // Returns { items, nextCursor, hasMore }
  //   items:       the page of rows
  //   nextCursor:  opaque token to pass as `cursor` on the next call
  //   hasMore:     true if there are more rows after this page
  //
  // Usage:
  //   const p1 = await db.user.findManyCursor({ limit: 50, orderBy: { id: 'asc' } })
  //   const p2 = await db.user.findManyCursor({ limit: 50, orderBy: { id: 'asc' }, cursor: p1.nextCursor })
  //
  // Multi-field ordering is supported:
  //   orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
  //   The cursor encodes all orderBy field values from the last row.
  //
  // All findMany options work: where, include, select, withDeleted, onlyDeleted.
  // The orderBy fields must be present in the SELECT — they're injected automatically.

  async function findManyCursor(args = {}) {
    refuseRecursive('findManyCursor', args)
    // The gate lives in a plugin's beforeRead, and this path did not call it —
    // so a model gated at SYSADMIN answered a level-4 caller in full, and the
    // one read method built for paging through a large table was the one that
    // asked nothing (FJS-262).
    if (plugins?.hasPlugins) await plugins.beforeRead(modelName, args, ctx)
    const {
      cursor,
      limit    = 20,
      where,
      select,
      include,
      orderBy,
    } = args

    const fields = cursorFields(orderBy)

    // Graded against THIS query's ordering, which is the same `fields` the
    // token was minted from — so a cursor from another sort is refused by
    // name rather than answering an empty page (`FJS-779`).
    const cursorValues = cursor ? decodeCursor(cursor, fields) : null

    // Build the combined WHERE clause:
    //   global filter AND plugin filters AND soft delete AND @@hasTemplates
    //   AND user where AND cursor where AND the row policy
    //
    // This path builds its own SQL, which is how it came to apply none of the
    // first four and neither the policy: `findMany` answered one row where
    // `findManyCursor` answered every row in the table, another owner's and
    // another tenant's included. Composed in the same ORDER as buildSQL, and
    // the policy is appended last as raw SQL with its params after the
    // cursor's — positional binds, so the order is the correctness (FJS-262).
    const params = []

    const { where: htWhere, policy: policyResult } = visibleWhere('findManyCursor', where, args)
    const baseWhere = buildWhereWithEncryption(htWhere, params)

    const cursorClause = cursorValues
      ? buildCursorWhere(fields, cursorValues, params, columnMap)
      : ''

    let whereSql = ''
    if (baseWhere && cursorClause) {
      whereSql = `(${baseWhere}) AND (${cursorClause})`
    } else if (baseWhere) {
      whereSql = baseWhere
    } else if (cursorClause) {
      whereSql = cursorClause
    }
    if (policyResult) {
      whereSql = whereSql ? `(${whereSql}) AND (${policyResult.sql})` : policyResult.sql
      params.push(...policyResult.params)
    }

    // Build SELECT — ensure all orderBy fields are present for cursor extraction
    const ps = parseArgs(select, include)

    // If select is restrictive, inject orderBy fields so we can extract cursor
    let sqlCols = ps?.sqlCols ?? '*'
    const injectedOrderCols = new Set()
    if (ps && sqlCols !== '*') {
      for (const { col } of fields) {
        if (!sqlCols.includes(`"${col}"`)) {
          sqlCols = `"${col}", ${sqlCols}`
          injectedOrderCols.add(col)
        }
      }
    }

    // @from subqueries — this path builds its own SQL, so it has to append
    // them itself. Without this a cursor page carried NO @from field at all
    // and any @computed field reading one computed from undefined: a
    // plausible 0 rather than an error, on the paginated path only, so the
    // same query answered differently through findMany.
    if (_hasFrom) {
      if (sqlCols === '*') {
        sqlCols = `"${tableName}".*, ` +
          _fromEntries.map(([n, { subquerySql }]) => `${subquerySql} AS "${n}"`).join(', ')
      } else if (ps?.requestedFrom?.size) {
        sqlCols += ', ' + [...ps.requestedFrom]
          .map(n => `${fromFields[n].subquerySql} AS "${n}"`).join(', ')
      }
    }

    // Build ORDER BY — including where the NULLs sit, which this dropped.
    // `findMany` honours a stated `nulls` and this did not, so the two
    // disagreed about the order for the same `orderBy`: the scan walked one
    // arrangement and the cursor was compared against another, which is the
    // same lost-rows failure as `FJS-780` one layer up. `fields` carries the
    // position now, defaulted to SQLite's own where nothing stated it.
    const orderSql = cursorOrderSql(fields, params)

    // Fetch limit + 1 to detect hasMore
    const fetchLimit = limit + 1

    let sql = `SELECT ${sqlCols} FROM "${tableName}"`
    if (whereSql)   sql += ` WHERE ${whereSql}`
    sql += ` ORDER BY ${orderSql}`
    sql += ` LIMIT ${fetchLimit}`

    const _nt = needsTiming()

    const _fmcT0 = _nt ? performance.now() : 0
    const rawRows = readDb.query(sql).all(...params)
    if (_nt) fireQuery({ operation: 'findManyCursor', args, sql, params, duration: _nt ? performance.now() - _fmcT0 : 0, rowCount: rawRows.length })

    // Detect hasMore by checking if we got an extra row
    const hasMore = rawRows.length > limit
    const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows

    // Deserialize + compute
    const rows = readAll(pageRows, { computedFields: ps?.requestedFields })

    // Resolve includes
    withIncludes(rows, ps, include)

    // Extract cursor from last row (before trimming — need orderBy field values)
    let nextCursor = null
    if (hasMore && rows.length > 0) {
      const lastRow = rows[rows.length - 1]
      const cursorData = extractCursorValues(lastRow, fields)
      nextCursor = encodeCursor(cursorData)
    }

    // Trim to select (strip injected orderBy cols if not requested)
    let finalRows = rows
    if (ps) {
      // Add injected order cols to injectedFKs so they get stripped
      const augmentedInjected = new Set([...ps.injectedFKs, ...injectedOrderCols])
      finalRows = trimAllToSelect(rows, ps.requestedFields, augmentedInjected)
    }

    return { items: finalRows, nextCursor, hasMore }
  }

  return { findManyCursor }
}
