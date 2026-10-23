// search.js — the search verb: full-text search over the model's @@fts index
// in two steps, the hits on the index and then the rows from the base table,
// with the global filter, the plugin read filters and the row policy folded
// once and bound to both. A verb and not a helper, so it goes into the table
// literal under its own name.
//
// Built once per table by `makeTable`, which hands it the read connection
// and the table's column helpers and readers, and takes back the one verb.

import { CapabilityNotDeclaredError } from './errors.js'
import { buildOrderBy, ftsWords, inList, pageSql, quoteIdent } from './query.js'
import { fromSelectExpr } from './include.js'

export function makeSearch(shape, ctx, deps) {
  const { tableName, modelName, ftsFields, fromFields, columnMap } = shape
  const {
    readDb, plugins, col, visibleWhere, buildWhereWithEncryption, needsTiming, fireQuery,
    parseArgs, _hasFrom, withRankTiebreak, _pointMap, _vectorMap, _vectorFn,
    readAll, withIncludes, finalize,
  } = deps

  // ── search ──────────────────────────────────────────────────────────────
  // Full-text search via FTS5. Only available on models with @@fts([...]).
  //
  // Options:
  //   query      the words to find — every one required, a "quoted phrase"
  //              kept whole; never FTS5 syntax (`ftsWords`, FJS-1440). Under
  //              trigram a word under three characters is found by a scan,
  //              unranked: a text of only such words has `_rank` null and
  //              comes back in row order (FJS-2332)
  //   prefix    the last word also matches as the start of a word
  //   raw        `query` is an FTS5 query, passed to MATCH as written
  //   limit      max rows to return (default 20)
  //   offset     skip rows (default 0)
  //   where      additional filter on base table (applied after FTS match)
  //   orderBy    sort the MATCHED rows by a column instead of by relevance
  //   select     column allowlist (same as findMany)
  //   include    relations to include (same as findMany)
  //   highlight  { field, open, close } — wrap matched terms in HTML
  //   snippet    { field, open, close, length } — extract matched context window
  //   withRank   include _rank (BM25 score) on each row — default true
  //   withDeleted / onlyDeleted — soft delete mode (same as findMany)
  //
  // Returns rows from the base table ordered by relevance (best match first),
  // or by `orderBy` when the caller states one.
  // Adds _rank (BM25), _highlight, _snippet where requested.
  //
  // ── where the paging happens, and why it MOVES ─────────────────────────
  //
  // By relevance, step 1 pages on the FTS index itself: rank lives there, so
  // LIMIT lets SQLite stop early. A caller's order is over BASE columns the
  // index does not carry, and the fts table carries columns of the SAME NAMES
  // as the indexed ones — so ordering in step 1 would need a join in which
  // an unqualified column is ambiguous and SQLite picks one silently.
  //
  // So the ordered path collects every matching rowid in step 1 and pages in
  // step 2, over the base table alone, through the same `buildOrderBy` and
  // the same `columnMap` every other read uses. Materializing the match set
  // is the cost of the request rather than of the implementation: no engine
  // can page a base-column order without knowing what matched. The relevance
  // path is untouched and stays the default.

  async function search(query, {
    raw         = false,
    prefix      = false,
    limit       = 20,
    offset      = 0,
    where,
    orderBy,
    select,
    include,
    highlight,
    snippet,
    withRank    = true,
    withDeleted = false,
    onlyDeleted = false,
    withTemplates = false,
    onlyTemplates = false,
    withExpired = false,
    onlyExpired = false,
    asOf,
  } = {}) {
    if (!ftsFields) {
      throw new CapabilityNotDeclaredError(modelName, 'search()', '@@fts',
        `Add @@fts([field1, field2]) to ${modelName} to make it searchable.`)
    }
    if (typeof query !== 'string') {
      throw new TypeError(`${modelName}.search(query) takes the words to find as a string, got ${query === null ? 'null' : typeof query}`)
    }
    if (raw && prefix) {
      throw new Error(`${modelName}.search(): prefix widens the last WORD, and a raw query is FTS5's own syntax — write its * instead`)
    }
    // Nothing left to find once the punctuation is gone — a lone `"` — answers
    // no rows; FTS5 would refuse the empty MATCH as a syntax error.
    const trigram = shape.model.attributes.find(a => a.kind === 'fts')?.tokenize === 'trigram'
    const words   = raw ? { match: query, scan: [] } : ftsWords(query, { prefix, trigram })
    if (words == null) return []

    if (plugins?.hasPlugins) await plugins.beforeRead(modelName, { where, limit, offset }, ctx)

    const ftsTable = `${tableName}_fts`

    // ── Step 1: query FTS table for matching rowids + rank ─────────────────
    // FTS5 rank column is BM25 — lower (more negative) = better match.
    // We ORDER BY rank ASC so best matches come first.

    const ftsParams  = []
    let   ftsSql     = `SELECT rowid, rank`

    // Optional highlight — wraps matched terms in open/close tags
    if (highlight) {
      const fieldIdx = ftsFields.indexOf(highlight.field)
      if (fieldIdx === -1) throw new Error(
        `highlight.field "${highlight.field}" is not an FTS field on "${tableName}". FTS fields: ${ftsFields.join(', ')}`
      )
      const open  = highlight.open  ?? '<mark>'
      const close = highlight.close ?? '</mark>'
      ftsSql += `, highlight(${ftsTable}, ${fieldIdx}, ?, ?) as _highlight`
      ftsParams.push(open, close)
    }

    // Optional snippet — extracts a short window of context around the match
    if (snippet) {
      const fieldIdx = ftsFields.indexOf(snippet.field)
      if (fieldIdx === -1) throw new Error(
        `snippet.field "${snippet.field}" is not an FTS field on "${tableName}". FTS fields: ${ftsFields.join(', ')}`
      )
      const open   = snippet.open   ?? '<mark>'
      const close  = snippet.close  ?? '</mark>'
      const ellip  = snippet.ellipsis ?? '…'
      const tokens = snippet.length  ?? 15
      ftsSql += `, snippet(${ftsTable}, ${fieldIdx}, ?, ?, ?, ?) as _snippet`
      ftsParams.push(open, close, ellip, tokens)
    }

    // The index mirrors the table, so soft-deleted, template and where-excluded
    // rows are in it and would otherwise spend slots the LIMIT below then
    // throws away — a search asking for 20 answering 13, with nothing to say
    // why. Narrowing here rather than after also makes `offset` mean pages of
    // matching rows rather than pages of index entries.
    //
    // The global filter, the plugin read filters and the row policy are part
    // of that narrowing, and were part of neither step: `findMany` answered
    // one row where `search` answered every row in the table, another owner's
    // and another tenant's included (FJS-262). Folded ONCE here and used by
    // both steps, so the two cannot drift.
    const { where: searchWhere, policy: searchPolicy } = visibleWhere('search', where,
      { withDeleted, onlyDeleted, withTemplates, onlyTemplates, withExpired, onlyExpired, asOf })

    const filterParams = []
    let   filterSql    = buildWhereWithEncryption(searchWhere, filterParams)
    if (searchPolicy) {
      filterSql = filterSql && filterSql !== '1=1'
        ? `(${filterSql}) AND (${searchPolicy.sql})`
        : searchPolicy.sql
      filterParams.push(...searchPolicy.params)
    }
    const filtered = !!filterSql && filterSql !== '1=1'

    // A word too short for a trigram is a GLOB over every indexed column
    // (`ftsWords`), required like any other word. The content table holds the
    // same columns under the same names, so a GLOB reads either.
    const globsOver  = (/** @type {string} */ table) => words.scan.map(() =>
      '(' + ftsFields.map(f => `${quoteIdent(table)}.${quoteIdent(col(f))} GLOB ?`).join(' OR ') + ')')
    const globParams = words.scan.flatMap(glob => ftsFields.map(() => glob))

    if (words.match != null) {
      ftsSql += ` FROM "${ftsTable}" WHERE ` + [`"${ftsTable}" MATCH ?`, ...globsOver(ftsTable)].join(' AND ')
      ftsParams.push(words.match, ...globParams)
      // Correlated on the hit's rowid, so the filter runs once per MATCH. As
      // `rowid IN (SELECT rowid FROM t WHERE …)` SQLite built the list of every
      // readable row and re-read it under the FTS scan: 300-800 ms for a
      // two-hop policy over 12k rows that matched one or eight (FJS-1692).
      if (filtered) {
        ftsSql += ` AND EXISTS (SELECT 1 FROM "${tableName}" WHERE "${tableName}".rowid = "${ftsTable}".rowid AND (${filterSql}))`
        ftsParams.push(...filterParams)
      }
    } else {
      // With no MATCH the GLOB is a scan, and the opposite holds: driven from
      // the index, every one of 113k entries ran the correlated filter to keep
      // an account's 4k (420 ms); driven from the table, the filter's own index
      // goes first (80 ms).
      const narrow = [...globsOver(tableName), ...(filtered ? [`(${filterSql})`] : [])].join(' AND ')
      ftsSql += ` FROM ${quoteIdent(ftsTable)} WHERE rowid IN (SELECT rowid FROM ${quoteIdent(tableName)} WHERE ${narrow})`
      ftsParams.push(...globParams, ...(filtered ? filterParams : []))
    }

    // A caller's order is applied in step 2, so this pass has to hand it the
    // WHOLE match set — a LIMIT here would page by relevance and then sort
    // the page, which is a different query and looks like a working one.
    const ordered = orderBy != null

    // Without a MATCH there is no BM25 and every rank is NULL, so the rowid is
    // what keeps a page from repeating or skipping a row.
    ftsSql += words.match != null ? ` ORDER BY rank` : ` ORDER BY rowid`

    if (!ordered) {
      const page = pageSql(limit, offset)
      if (page) { ftsSql += page.sql; ftsParams.push(...page.params) }
    }

    const _nt = needsTiming()

    const _srT0 = _nt ? performance.now() : 0
    const ftsRows = readDb.query(ftsSql).all(...ftsParams)
    fireQuery({ operation: 'search', args: { query, where, limit, offset }, sql: ftsSql, params: ftsParams, duration: _nt ? performance.now() - _srT0 : 0, rowCount: ftsRows.length })
    if (!ftsRows.length) return []

    // ── Step 2: fetch full rows from base table for the matching IDs ───────
    // Preserve FTS rank order by using a CASE WHEN expression.

    const rowids      = ftsRows.map(r => r.rowid)
    const rankByRowid = new Map(ftsRows.map(r => [r.rowid, r.rank]))
    const hlByRowid   = highlight ? new Map(ftsRows.map(r => [r.rowid, r._highlight])) : null
    const snipByRowid = snippet   ? new Map(ftsRows.map(r => [r.rowid, r._snippet]))   : null

    // Build base query — the same fold as step 1, bound again
    const baseParams   = []
    let whereSql = buildWhereWithEncryption(searchWhere, baseParams)
    // The index is keyed on the source rowid, not `id` (a String id cannot be
    // an FTS5 rowid), so the hits are rejoined on rowid.
    const rowidBinds = []
    const rowidSql   = inList('rowid', rowids, rowidBinds)
    whereSql = whereSql && whereSql !== '1=1' ? `${rowidSql} AND (${whereSql})` : rowidSql
    baseParams.unshift(...rowidBinds)
    // The pre-filter above already narrowed the rowids, so this is belt and
    // braces — and it is the half that must not be dropped: step 2 is what
    // returns the rows, and a future edit that skips the pre-filter for a
    // cheap query would otherwise hand them all back.
    if (searchPolicy) {
      whereSql = whereSql ? `(${whereSql}) AND (${searchPolicy.sql})` : searchPolicy.sql
      baseParams.push(...searchPolicy.params)
    }

    const ps         = parseArgs(select, include)
    let   sqlCols    = ps?.sqlCols ?? '*'
    // Step 2 builds its own SELECT, so it appends the @from subqueries itself
    // — the same reason findManyCursor and resolveIncludes do.
    if (_hasFrom) {
      if (sqlCols === '*') {
        sqlCols = `*, ${fromSelectExpr(fromFields)}`
      } else if (ps?.requestedFrom?.size) {
        sqlCols += ', ' + [...ps.requestedFrom]
          .map(n => `${fromFields[n].subquerySql} AS "${n}"`).join(', ')
      }
    }
    let   baseSql    = `SELECT rowid AS __fts_rowid, ${sqlCols} FROM "${tableName}" WHERE ${whereSql}`

    // The caller's order, over the base table alone — the same builder and
    // the same columnMap findMany uses, so a `@map`ped column and a `@from`
    // rollup sort here exactly as they do there. The KEYS were graded before
    // the call (`checkOrderBy`), which matters more here than anywhere: a bad
    // sort key answers the right rows in the wrong order, and nothing about
    // that is visible.
    if (ordered) {
      const orderSql = buildOrderBy(withRankTiebreak(orderBy), baseParams, columnMap, _pointMap, _vectorMap, _vectorFn(readDb))
      if (orderSql) baseSql += ` ORDER BY ${orderSql}`
      const page = pageSql(limit, offset)
      if (page) { baseSql += page.sql; baseParams.push(...page.params) }
    }

    const baseRows = readAll(readDb.query(baseSql).all(...baseParams), { computedFields: ps?.requestedFields })
    if (!baseRows.length) return []

    // ── Step 3: attach rank + extras, in the order the query decided ──────
    //
    // Two orders and the walk decides which survives. By relevance the rows
    // come back in whatever order SQLite read them, so the FTS hits are
    // walked and the rows looked up. Under a caller's order step 2 already
    // sorted AND paged, so walking the hits would put rank back — the rows
    // are walked instead and the per-row extras looked up by rowid.
    const result = [], rids = []

    if (ordered) {
      for (const row of baseRows) {
        rids.push(row.__fts_rowid)
        delete row.__fts_rowid
        result.push(row)
      }
    } else {
      const rowById = new Map(baseRows.map(r => { const rid = r.__fts_rowid; delete r.__fts_rowid; return [rid, r] }))
      for (const ftsRow of ftsRows) {
        const row = rowById.get(ftsRow.rowid)
        if (!row) continue  // filtered out by where clause or soft delete
        rids.push(ftsRow.rowid)
        result.push(row)
      }
    }

    // ── Step 4: resolve includes + trim select, then the extras ───────────
    // The extras are not columns, so the trim to a `select` dropped them:
    // `search(q, { select })` answered without `_rank` and said nothing
    // (FJS-1694).
    withIncludes(result, ps, include)
    return finalize(result, ps).map((row, i) => {
      const rid = rids[i]
      if (withRank)    row._rank      = rankByRowid.get(rid)
      if (hlByRowid)   row._highlight = hlByRowid.get(rid)
      if (snipByRowid) row._snippet   = snipByRowid.get(rid)
      return row
    })
  }

  return { search }
}
