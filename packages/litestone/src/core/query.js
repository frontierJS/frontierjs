// query.js — SQL clause builders + row serialization + select parsing

// ─── sql tagged template ──────────────────────────────────────────────────────
//
// Safe parameterized raw SQL for use inside where: { $raw: sql`...` }.
// Interpolated values are extracted as params — never concatenated into the SQL string.
//
// Usage:
//   import { sql } from '@frontierjs/litestone'
//
//   db.products.findMany({
//     where: { $raw: sql`price > IF(state = ${state}, ${minPrice}, 100)` }
//   })
//
// Returns a RawClause: { _litestoneRaw: true, sql: string, params: any[] }

export function sql(strings, ...values) {
  let sqlStr = ''
  for (let i = 0; i < strings.length; i++) {
    sqlStr += strings[i]
    if (i < values.length) sqlStr += '?'
  }
  return { _litestoneRaw: true, sql: sqlStr.trim(), params: values }
}

// Check if a value is a RawClause produced by the sql tag
export function isRawClause(val) {
  return val !== null && typeof val === 'object' && val._litestoneRaw === true
}

// ─── Typed JSON helpers ──────────────────────────────────────────────────────
// When a Where clause traverses a Json @type(T) column, we compile sub-key
// references to json_extract() paths. This lets users filter inside JSON
// columns using the same Where shape they use on real columns:
//
//   where: { addr: { city: 'NYC', coords: { lat: { gte: 40 } } } }
//   →
//   WHERE json_extract("addr", '$.city') = ?
//     AND json_extract("addr", '$.coords.lat') >= ?
//
// Type info from the type declaration drives:
//   - Which keys are valid (unknown keys throw at query-build time)
//   - Sub-key types for the WHERE-op coercion (Boolean → 0/1, etc.)
//   - Whether to recurse into a nested type (Json @type(Other))

const JSON_LEAF_OPS = new Set([
  'gt', 'gte', 'lt', 'lte', 'not', 'in', 'notIn',
  'contains', 'startsWith', 'endsWith',
])

// Decides whether the object value on a typed-JSON field is a path traversal
// (recurse into sub-keys) or a leaf operator block (apply directly to the
// whole JSON value — currently a no-op since we always traverse). The signal
// is "any key that isn't a known operator" → it's a path. If all keys are
// operators, fall through to the regular WhereOp handling at the column level.
function isTypedJsonPath(val) {
  for (const k of Object.keys(val)) {
    if (!JSON_LEAF_OPS.has(k)) return true
  }
  return false
}

// Walk a Where sub-tree against a type declaration, emitting json_extract()
// clauses. Returns an array of SQL clause strings; the caller joins with AND.
//
// `colExpr`     — the SQL expression for the typed-JSON column (e.g. '"addr"')
// `where`       — the user's Where sub-tree at this level
// `typeDecl`    — the type declaration for the value at this level
// `path`        — the JSON path so far, e.g. ['coords', 'lat']
// `params`      — parameter array (mutated)
// `typedJsonMap` — passed through for nested-type recursion (rarely needed
//                  but kept for symmetry with the top-level signature)
function buildTypedJsonClauses(colExpr, where, typeDecl, path, params, typedJsonMap) {
  const clauses = []
  if (!typeDecl) return clauses

  // Build a quick lookup: key name → field decl
  const fieldByName = new Map((typeDecl.fields ?? []).map(f => [f.name, f]))

  for (const [key, val] of Object.entries(where)) {
    if (!fieldByName.has(key)) {
      throw new Error(`Unknown field '${key}' on type ${typeDecl.name} in WHERE clause`)
    }
    const field = fieldByName.get(key)
    const subPath = [...path, key]

    // Nested type? Recurse if the value is a path traversal again.
    if (field.type.name === 'Json' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
      const nestedTypeAttr = field.attributes.find(a => a.kind === 'type')
      if (nestedTypeAttr && isTypedJsonPath(val)) {
        // Nested type — recurse using the nested type's declaration.
        // We need to look it up from typedJsonMap (which carries '$nestedTypes'
        // for recursive resolution) — see makeTable wiring.
        const nestedType = typedJsonMap?.$nestedTypes?.get(nestedTypeAttr.name)
        if (nestedType) {
          clauses.push(...buildTypedJsonClauses(colExpr, val, nestedType, subPath, params, typedJsonMap))
          continue
        }
        // Fallthrough: treat as leaf if we can't resolve (shouldn't happen
        // — parse-time validation catches unknown nested types).
      }
    }

    // Leaf comparison: emit a json_extract() expression at this path.
    const jsonPath = `'$.${subPath.map(p => p.replace(/'/g, "''")).join('.')}'`
    const fieldType = field.type.name

    // Coerce primitive values for SQLite: booleans → 0/1, Date → ISO 8601 string.
    const coerce = (v) => {
      if (typeof v === 'boolean') return v ? 1 : 0
      if (v instanceof Date) return v.toISOString()
      return v
    }

    // Text predicates (LIKE) need explicit CAST AS TEXT — json_extract returns
    // SQLite-native types, and LIKE on a number or NULL silently misbehaves.
    const textCol = `CAST(json_extract(${colExpr}, ${jsonPath}) AS TEXT)`
    const rawCol  = `json_extract(${colExpr}, ${jsonPath})`

    if (val === null) {
      clauses.push(`${rawCol} IS NULL`)
      continue
    }

    if (typeof val !== 'object' || Array.isArray(val)) {
      // Direct equality. Boolean fields stored as 0/1 by Litestone — coerce.
      if (Array.isArray(val)) {
        // Implicit IN
        if (!val.length) { clauses.push('0 = 1'); continue }
        val.forEach(v => params.push(coerce(v)))
        clauses.push(`${rawCol} IN (${val.map(() => '?').join(', ')})`)
      } else {
        params.push(coerce(val))
        clauses.push(`${rawCol} = ?`)
      }
      continue
    }

    // Operator block — supports the same ops as regular WHERE
    for (const [op, operand] of Object.entries(val)) {
      switch (op) {
        case 'gt':         params.push(coerce(operand));        clauses.push(`${rawCol} > ?`);   break
        case 'gte':        params.push(coerce(operand));        clauses.push(`${rawCol} >= ?`);  break
        case 'lt':         params.push(coerce(operand));        clauses.push(`${rawCol} < ?`);   break
        case 'lte':        params.push(coerce(operand));        clauses.push(`${rawCol} <= ?`);  break
        case 'contains':   params.push(`%${operand}%`);         clauses.push(`${textCol} LIKE ?`); break
        case 'startsWith': params.push(`${operand}%`);          clauses.push(`${textCol} LIKE ?`); break
        case 'endsWith':   params.push(`%${operand}`);          clauses.push(`${textCol} LIKE ?`); break
        case 'in':
          if (!operand?.length) { clauses.push('0 = 1'); break }
          operand.forEach(v => params.push(coerce(v)))
          clauses.push(`${rawCol} IN (${operand.map(() => '?').join(', ')})`)
          break
        case 'notIn':
          if (!operand?.length) break
          operand.forEach(v => params.push(coerce(v)))
          clauses.push(`(${rawCol} NOT IN (${operand.map(() => '?').join(', ')}) OR ${rawCol} IS NULL)`)
          break
        case 'not':
          if (operand === null) { clauses.push(`${rawCol} IS NOT NULL`); break }
          params.push(coerce(operand))
          clauses.push(`${rawCol} != ?`)
          break
        default:
          throw new Error(`Unknown WHERE operator '${op}' inside typed JSON path on field ${typeDecl.name}.${subPath.join('.')}`)
      }
    }
    // Suppress unused-var warning when fieldType isn't read in some branches
    void fieldType
  }

  return clauses
}

// ─── Where clause ─────────────────────────────────────────────────────────────
//
// Supports:
//   { field: value }                  equality (null → IS NULL)
//   { field: { gt, gte, lt, lte } }   comparisons
//   { field: { in: [...] } }          IN
//   { field: { notIn: [...] } }       NOT IN
//   { field: { not: value } }         !=  (null → IS NOT NULL)
//   { field: { contains: str } }      LIKE %str%
//   { field: { startsWith: str } }    LIKE str%
//   { field: { endsWith: str } }      LIKE %str
//   { AND: [...] }                    AND group
//   { OR: [...] }                     OR group
//   { NOT: {...} }                    NOT (...)
//   "raw SQL string"                  passed through as-is
//
// Typed JSON path pushdown (when typedJsonMap is provided):
//   { addr: { city: 'NYC' } }              → json_extract(addr, '$.city') = ?
//   { addr: { coords: { lat: { gte: 40 } } } } → json_extract(addr, '$.coords.lat') >= ?
//   { addr: { city: { contains: 'Bos' } } }    → CAST(json_extract(addr, '$.city') AS TEXT) LIKE ?
//
// typedJsonMap: { fieldName: typeDecl } — only typed-Json fields appear here.

export function buildWhere(where, params, fromExprMap = null, tableAlias = null, typedJsonMap = null) {
  if (!where) return ''
  if (typeof where === 'string') return where

  const clauses = []
  const aliasPrefix = tableAlias ? `${tableAlias}.` : ''

  // Coerce JS values that aren't valid SQLite bind types. The Bun driver will
  // happily call `.toString()` on a Date, producing the human-readable form
  // ("Mon Apr 27 2026 ...") which compares lexically wrong against ISO
  // datetime columns. We normalize Dates to ISO 8601 here so comparisons
  // line up with how DateTime values are stored.
  //
  // Functions, symbols, and undefined values can't be bound at all and Bun
  // throws "Binding expected ..." — a useless error that doesn't say which
  // field caused it. We catch that case here and re-throw with the field name
  // so the user can find their bug in five seconds instead of five minutes.
  const coerce = (v) => v instanceof Date ? v.toISOString() : v
  const checkBindable = (v, fieldName) => {
    if (v === undefined) {
      throw new Error(`where clause: field "${fieldName}" was given undefined — did you mean null?`)
    }
    if (typeof v === 'function') {
      throw new Error(`where clause: field "${fieldName}" was given a function — you probably forgot to call it (e.g. \`${fieldName}: req.headers.get('x')\` not \`${fieldName}: req.headers.get\`)`)
    }
    if (typeof v === 'symbol') {
      throw new Error(`where clause: field "${fieldName}" was given a symbol — symbols can't be used in queries`)
    }
    return v
  }
  // Bound to the current key being processed in the loop below. `pushFor(k)(v)`
  // both coerces and bind-checks `v` against field name `k`. The factory keeps
  // hot-path overhead minimal — the closure is created once per top-level key
  // and reused for all operands at that key.
  const pushFor = (fieldName) => (v) => params.push(checkBindable(coerce(v), fieldName))

  for (const [key, val] of Object.entries(where)) {
    if (key === 'AND') {
      const parts = val.map(w => buildWhere(w, params, fromExprMap, tableAlias, typedJsonMap)).filter(Boolean)
      if (parts.length) clauses.push(`(${parts.join(' AND ')})`)
      continue
    }
    if (key === 'OR') {
      const parts = val.map(w => buildWhere(w, params, fromExprMap, tableAlias, typedJsonMap)).filter(Boolean)
      if (parts.length) clauses.push(`(${parts.join(' OR ')})`)
      continue
    }
    if (key === 'NOT') {
      const inner = buildWhere(val, params, fromExprMap, tableAlias, typedJsonMap)
      if (inner) clauses.push(`NOT (${inner})`)
      continue
    }
    if (key === '$raw') {
      // val is a RawClause from the sql tag: { _litestoneRaw: true, sql, params }
      // or a plain string for simple parameterless expressions
      if (isRawClause(val)) {
        if (val.sql) {
          clauses.push(`(${val.sql})`)
          params.push(...val.params)
        }
      } else if (typeof val === 'string' && val) {
        clauses.push(`(${val})`)
      } else {
        throw new Error('where.$raw must be a value returned by the sql`` tag or a plain SQL string')
      }
      continue
    }

    // ── Typed JSON path pushdown ────────────────────────────────────────────
    // If this top-level key references a Json @type(T) column AND the value is
    // an object that is NOT a known operator block (gt/gte/in/etc.), the user
    // is filtering on JSON sub-keys. Compile to json_extract() paths.
    //
    // We only enter this branch when typedJsonMap[key] exists. That means:
    //   1. The field is a Json column with @type(T) — the type was registered
    //      when the client was built.
    //   2. We have the type's structure available, so we know which sub-keys
    //      are valid and what types they have.
    const typedJsonInfo = typedJsonMap?.[key]
    if (typedJsonInfo && val !== null && typeof val === 'object' && !Array.isArray(val) && isTypedJsonPath(val)) {
      const colExpr = `${aliasPrefix}"${key}"`
      const subClauses = buildTypedJsonClauses(colExpr, val, typedJsonInfo, [], params, typedJsonMap)
      if (subClauses.length) clauses.push(subClauses.join(' AND '))
      continue
    }

    // @from field — use subquery expression instead of column name.
    // Subqueries are self-qualifying (they reference `t.` internally), so we
    // never prepend an extra alias prefix to them.
    const isFromExpr = fromExprMap?.[key] != null
    const col = isFromExpr ? fromExprMap[key] : `${aliasPrefix}"${key}"`

    if (val === null) { clauses.push(`${col} IS NULL`); continue }

    // Field-bound binder — captures the field name so any "Binding expected"
    // error tells the caller which field caused it.
    const push = pushFor(key)

    if (typeof val !== 'object' || Array.isArray(val) || val instanceof Date) {
      if (Array.isArray(val)) {
        val.forEach(v => push(typeof v === 'boolean' ? (v ? 1 : 0) : v))
        clauses.push(`${col} IN (${val.map(() => '?').join(', ')})`)
      } else if (typeof val === 'boolean' && isFromExpr && col.includes('EXISTS')) {
        // EXISTS subquery — already returns 0/1; emit directly or negate
        clauses.push(val ? col : `NOT ${col}`)
      } else {
        push(typeof val === 'boolean' ? (val ? 1 : 0) : val)
        clauses.push(`${col} = ?`)
      }
      continue
    }

    for (const [op, operand] of Object.entries(val)) {
      switch (op) {
        case 'gt':         push(operand);              clauses.push(`${col} > ?`);           break
        case 'gte':        push(operand);              clauses.push(`${col} >= ?`);          break
        case 'lt':         push(operand);              clauses.push(`${col} < ?`);           break
        case 'lte':        push(operand);              clauses.push(`${col} <= ?`);          break
        case 'contains':   push(`%${operand}%`);       clauses.push(`${col} LIKE ?`);        break
        case 'startsWith': push(`${operand}%`);        clauses.push(`${col} LIKE ?`);        break
        case 'endsWith':   push(`%${operand}`);        clauses.push(`${col} LIKE ?`);        break
        case 'in':
          if (!operand?.length) { clauses.push('0 = 1'); break }
          operand.forEach(v => push(v))
          clauses.push(`${col} IN (${operand.map(() => '?').join(', ')})`)
          break
        case 'notIn':
          if (!operand?.length) break
          operand.forEach(v => push(v))
          // Include NULL rows — NOT IN silently excludes them in SQLite
          clauses.push(`(${col} NOT IN (${operand.map(() => '?').join(', ')}) OR ${col} IS NULL)`)
          break
        case 'has':
          // element exists in JSON array: json_each(col) WHERE value = ?
          push(operand)
          clauses.push(`EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`)
          break
        case 'hasEvery':
          // all elements present
          if (!operand?.length) break
          for (const v of operand) {
            push(v)
            clauses.push(`EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)`)
          }
          break
        case 'hasSome':
          // at least one element present
          if (!operand?.length) { clauses.push('0 = 1'); break }
          {
            const parts = operand.map(v => { push(v); return `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value = ?)` })
            clauses.push(`(${parts.join(' OR ')})`)
          }
          break
        case 'isEmpty':
          clauses.push(operand ? `json_array_length(${col}) = 0` : `json_array_length(${col}) > 0`)
          break
        case 'not':
          if (operand === null) { clauses.push(`${col} IS NOT NULL`); break }
          push(operand)
          clauses.push(`${col} != ?`)
          break
        default:
          throw new Error(`Unknown where operator: "${op}"`)
      }
    }
  }

  return clauses.join(' AND ')
}

// ─── Order by ─────────────────────────────────────────────────────────────────

export function buildOrderBy(orderBy) {
  if (!orderBy) return ''
  const items = Array.isArray(orderBy) ? orderBy : [orderBy]
  const parts  = []
  for (const item of items) {
    for (const [col, dir] of Object.entries(item)) {
      // Relation orderBy — { relation: { field: 'asc' } } — handled separately
      if (dir !== null && typeof dir === 'object') {
        // Object form: { field: { dir: 'asc', nulls: 'last' } }
        // Relation objects (no 'dir' key) are skipped here — handled by buildRelationOrderBy
        if (dir.dir == null) continue
        const d = dir.dir.toUpperCase()
        if (d !== 'ASC' && d !== 'DESC')
          throw new Error(`orderBy direction must be 'asc' or 'desc', got: ${dir.dir}`)
        let expr = `"${col}" ${d}`
        if (dir.nulls) {
          const n = dir.nulls.toUpperCase()
          if (n !== 'FIRST' && n !== 'LAST')
            throw new Error(`orderBy nulls must be 'first' or 'last', got: ${dir.nulls}`)
          expr += ` NULLS ${n}`
        }
        parts.push(expr)
        continue
      }
      const d = dir.toUpperCase()
      if (d !== 'ASC' && d !== 'DESC')
        throw new Error(`orderBy direction must be 'asc' or 'desc', got: ${dir}`)
      parts.push(`"${col}" ${d}`)
    }
  }
  return parts.join(', ')
}

// ─── Named aggregates with FILTER ────────────────────────────────────────────
//
// Any _-prefixed key in aggregate()/groupBy() args whose value is an object
// with a count/sum/avg/min/max key is treated as a named filtered aggregate:
//
//   _countPaid: { count: true,   filter: sql`status = 'paid'` }
//   _sumPaid:   { sum: 'amount', filter: sql`status = 'paid'` }
//   _avgActive: { avg: 'score',  filter: sql`active = 1` }
//
// The FILTER clause uses the same sql`` tag as where.$raw for safe param binding.
//
// Result shape:
//   { _countPaid: 72, _sumPaid: 3200, _avgActive: 8.4 }

const _NAMED_AGG_FNS = ['count', 'sum', 'avg', 'min', 'max']

/** Returns true if this args key+value is a named aggregate spec */
export function isNamedAgg(key, val) {
  return key.startsWith('_')
    && val !== null
    && typeof val === 'object'
    && !Array.isArray(val)
    && _NAMED_AGG_FNS.some(fn => fn in val)
}

/**
 * Build a SELECT expression for a named aggregate.
 * Returns { expr: string, params: any[] }
 *
 * spec: { count?, sum?, avg?, min?, max?, filter?: RawClause | string, distinct?: boolean }
 */
export function buildNamedAggExpr(alias, spec, extraParams) {
  const fn = _NAMED_AGG_FNS.find(f => f in spec)
  if (!fn) throw new Error(`Named aggregate "${alias}" must specify count, sum, avg, min, or max`)

  let aggExpr
  if (fn === 'count') {
    if (spec.count === true || spec.count === '*') {
      aggExpr = spec.distinct ? `COUNT(DISTINCT *)` : `COUNT(*)`
    } else {
      aggExpr = spec.distinct ? `COUNT(DISTINCT "${spec.count}")` : `COUNT("${spec.count}")`
    }
  } else {
    const sqlFn = fn.toUpperCase()
    aggExpr = spec.distinct
      ? `${sqlFn}(DISTINCT "${spec[fn]}")`
      : `${sqlFn}("${spec[fn]}")`
  }

  // FILTER (WHERE ...) clause
  let filterClause = ''
  if (spec.filter) {
    if (isRawClause(spec.filter)) {
      filterClause = ` FILTER (WHERE ${spec.filter.sql})`
      extraParams.push(...spec.filter.params)
    } else if (typeof spec.filter === 'string') {
      filterClause = ` FILTER (WHERE ${spec.filter})`
    } else {
      throw new Error(`Named aggregate "${alias}" filter must be a sql\`\` tag result or plain string`)
    }
  }

  return `${aggExpr}${filterClause} AS "__nagg__${alias}"`
}

/** Extract all named aggregate entries from an args object */
export function extractNamedAggs(args) {
  return Object.entries(args).filter(([k, v]) => isNamedAgg(k, v))
}
//
// Handles { relation: { field: 'asc' } } and nested { rel1: { rel2: { field: 'asc' } } }.
// Only works for belongsTo relations (single-row joins). hasMany is silently skipped
// with an error — sorting by a hasMany field is ambiguous.
//
// Returns:
//   joinClauses  — array of LEFT JOIN strings to splice into the FROM clause
//   orderParts   — array of ORDER BY expressions (aliased table column refs)
//
// Each JOIN alias is deterministic: _ob_{rel1} for depth 1, _ob_{rel1}_{rel2} for depth 2.
// Aliases are unique even when the same relation is used in multiple orderBy items.
//
// Example:
//   orderBy: { author: { name: 'asc' } }
//   → LEFT JOIN "users" _ob_author ON _ob_author."id" = t."authorId"
//   → ORDER BY _ob_author."name" ASC
//
//   orderBy: [{ author: { team: { name: 'asc' } } }]
//   → LEFT JOIN "users" _ob_author ON _ob_author."id" = t."authorId"
//     LEFT JOIN "teams" _ob_author_team ON _ob_author_team."id" = _ob_author."teamId"
//   → ORDER BY _ob_author_team."name" ASC

export function buildRelationOrderBy(orderBy, modelName, relationMap, modelToTable = (m) => m) {
  if (!orderBy) return { joinClauses: [], orderParts: [] }

  const items       = Array.isArray(orderBy) ? orderBy : [orderBy]
  const joinClauses = []   // deduplicated by alias
  const seenAliases = new Set()
  // entries preserves positional order for mixed flat + relation orderBy.
  // Each entry is either:
  //   { flat: true,  sql: '"name" ASC' }
  //   { flat: false, sql: '_ob_company."name" ASC' }  (relation/aggregate)
  const entries     = []

  for (const item of items) {
    for (const [key, val] of Object.entries(item)) {
      // Flat scalar form:  { col: 'asc'|'desc' }
      if (val === null || typeof val !== 'object') {
        const d = String(val).toUpperCase()
        if (d !== 'ASC' && d !== 'DESC')
          throw new Error(`orderBy direction must be 'asc' or 'desc', got: ${val}`)
        entries.push({ flat: true, sql: `"${key}" ${d}` })
        continue
      }
      // Flat object config form:  { col: { dir: 'asc', nulls: 'last' } }
      // (A relation spec never has a 'dir' key — it has relation/field keys.)
      if ('dir' in val) {
        const d = val.dir.toUpperCase()
        if (d !== 'ASC' && d !== 'DESC')
          throw new Error(`orderBy direction must be 'asc' or 'desc', got: ${val.dir}`)
        let s = `"${key}" ${d}`
        if (val.nulls) {
          const n = val.nulls.toUpperCase()
          if (n !== 'FIRST' && n !== 'LAST')
            throw new Error(`orderBy nulls must be 'first' or 'last', got: ${val.nulls}`)
          s += ` NULLS ${n}`
        }
        entries.push({ flat: true, sql: s })
        continue
      }

      // Detect aggregate orderBy: { posts: { _count: 'asc' } } or { posts: { _sum: { amount: 'asc' } } }
      const aggKeys = Object.keys(val).filter(k => k === '_count' || k === '_sum' || k === '_avg' || k === '_min' || k === '_max')
      if (aggKeys.length > 0) {
        const sub = []
        _buildAggregateOrder(key, val, aggKeys, modelName, relationMap, sub, modelToTable)
        for (const s of sub) entries.push({ flat: false, sql: s })
      } else {
        const sub = []
        _walkRelationOrder(key, val, modelName, 't', relationMap, joinClauses, sub, seenAliases, `_ob_${key}`, modelToTable)
        for (const s of sub) entries.push({ flat: false, sql: s })
      }
    }
  }

  // When JOINs exist, flat entries must be prefixed with `t.` to avoid ambiguous
  // column references (e.g. `id` exists on both joined tables). We emit the full
  // ordered list — caller must SKIP calling buildOrderBy() when joinClauses.length > 0.
  // When there are no JOINs, we return only relation/aggregate parts; the caller
  // uses buildOrderBy() for the flat parts (which is already positionally fine).
  if (joinClauses.length > 0) {
    const orderParts = entries.map(e =>
      e.flat ? e.sql.replace(/^"([^"]+)"/, 't."$1"') : e.sql
    )
    return { joinClauses, orderParts }
  }
  const orderParts = entries.filter(e => !e.flat).map(e => e.sql)
  return { joinClauses, orderParts }
}

// Aggregate orderBy — emits a correlated subquery into ORDER BY.
// No JOINs needed; no row duplication risk.
//
// hasMany:    SELECT COUNT(*) FROM "posts" WHERE "posts"."userId" = t."id"
// manyToMany: SELECT COUNT(*) FROM "_tags_posts" WHERE "postId" = t."id"
// _sum etc:   SELECT SUM("amount") FROM "orders" WHERE "orders"."userId" = t."id"

function _buildAggregateOrder(relName, spec, aggKeys, modelName, relationMap, orderParts, modelToTable) {
  const tableRels = relationMap[modelName] ?? {}
  const rel       = tableRels[relName]

  if (!rel) {
    throw new Error(`orderBy: relation '${relName}' not found on '${modelName}'`)
  }
  if (rel.kind === 'belongsTo') {
    throw new Error(`orderBy: aggregate on '${relName}' is a belongsTo relation — use a regular field orderBy instead`)
  }

  // Convert rel.targetModel (PascalCase model name) to its SQL table name.
  const targetTable = modelToTable(rel.targetModel)

  for (const aggKey of aggKeys) {
    const dirOrSpec = spec[aggKey]

    if (aggKey === '_count') {
      const dir = (typeof dirOrSpec === 'string' ? dirOrSpec : 'asc').toUpperCase()
      if (dir !== 'ASC' && dir !== 'DESC') throw new Error(`orderBy _count direction must be 'asc' or 'desc', got: ${dirOrSpec}`)

      let subquery
      if (rel.kind === 'manyToMany') {
        subquery = `(SELECT COUNT(*) FROM "${rel.joinTable}" WHERE "${rel.selfKey}" = t."id")`
      } else {
        // hasMany
        subquery = `(SELECT COUNT(*) FROM "${targetTable}" WHERE "${rel.foreignKey}" = t."${rel.referencedKey}")`
      }
      orderParts.push(`${subquery} ${dir}`)

    } else {
      // _sum, _avg, _min, _max — value is { fieldName: 'asc'|'desc' }
      if (typeof dirOrSpec !== 'object' || dirOrSpec === null) {
        throw new Error(`orderBy ${aggKey} requires { fieldName: 'asc'|'desc' }, got: ${JSON.stringify(dirOrSpec)}`)
      }
      if (rel.kind === 'manyToMany') {
        throw new Error(`orderBy ${aggKey} is not supported on manyToMany relations — use a hasMany relation`)
      }
      const fn = { _sum: 'SUM', _avg: 'AVG', _min: 'MIN', _max: 'MAX' }[aggKey]
      for (const [field, dir] of Object.entries(dirOrSpec)) {
        const d = dir.toUpperCase()
        if (d !== 'ASC' && d !== 'DESC') throw new Error(`orderBy ${aggKey} direction must be 'asc' or 'desc', got: ${dir}`)
        const subquery = `(SELECT ${fn}("${field}") FROM "${targetTable}" WHERE "${rel.foreignKey}" = t."${rel.referencedKey}")`
        orderParts.push(`${subquery} ${d}`)
      }
    }
  }
}

function _walkRelationOrder(relName, spec, currentModel, currentAlias, relationMap, joinClauses, orderParts, seenAliases, joinAlias, modelToTable = (m) => m) {
  const tableRels = relationMap[currentModel] ?? {}
  const rel       = tableRels[relName]

  if (!rel) {
    throw new Error(`orderBy: relation '${relName}' not found on '${currentModel}'`)
  }
  if (rel.kind !== 'belongsTo') {
    throw new Error(`orderBy: '${relName}' is a ${rel.kind} relation — only belongsTo (single-row) relations can be used in orderBy`)
  }

  // Emit the JOIN (deduplicated by alias) — SQL uses the table name, not the model name
  if (!seenAliases.has(joinAlias)) {
    seenAliases.add(joinAlias)
    const targetTable = modelToTable(rel.targetModel)
    const joinSql = `LEFT JOIN "${targetTable}" ${joinAlias} ON ${joinAlias}."${rel.referencedKey}" = ${currentAlias}."${rel.foreignKey}"`
    joinClauses.push(joinSql)
  }

  // Walk the spec — either { field: 'asc' } or { nestedRel: { field: 'asc' } }
  for (const [key, val] of Object.entries(spec)) {
    if (val !== null && typeof val === 'object') {
      // Another level of nesting — recurse. currentModel becomes rel.targetModel
      // (the PascalCase model name); modelToTable converts it for the next JOIN.
      _walkRelationOrder(key, val, rel.targetModel, joinAlias, relationMap, joinClauses, orderParts, seenAliases, `${joinAlias}_${key}`, modelToTable)
    } else {
      // Leaf — { field: 'asc'|'desc' }
      const d = val.toUpperCase()
      if (d !== 'ASC' && d !== 'DESC')
        throw new Error(`orderBy direction must be 'asc' or 'desc', got: ${val}`)
      orderParts.push(`${joinAlias}."${key}" ${d}`)
    }
  }
}

// ─── Select parsing ───────────────────────────────────────────────────────────
//
// Takes the user-supplied select object and resolves it into everything the
// query pipeline needs.
//
// Returns null if select is not provided (meaning "return everything").
//
// Returns:
//   {
//     sqlCols:          string       — SQL column list ('*' or '"id", "email"')
//     relationSelects:  object       — { relName: true | { select: {...} } }
//     requestedFields:  Set<string>  — all fields the user wants back
//     injectedFKs:      Set<string>  — FK cols added for joins but not requested
//     needsAllDbCols:   boolean      — true when computed fields are selected
//                                      (we fetch * so fns have their dependencies)
//   }
//
// Rules:
//   - Relation fields in select are treated as includes (with optional nested select)
//   - @computed fields have no DB column — we SELECT * when any are requested so
//     their extension functions can access any DB column they depend on
//   - FK columns needed for include resolution are injected into the SQL SELECT
//     and then stripped from results unless the user also selected them

export function parseSelectArg(select, modelName, relationMap, computedSets, include, fromSets) {
  if (!select) return null

  const tableRels      = relationMap?.[modelName] ?? {}
  const tableComputed  = computedSets?.[modelName] ?? new Set()
  const tableFrom      = fromSets?.[modelName] ?? new Set()

  const dbFields        = {}    // user-requested DB column names
  const relationSelects = {}    // relation name → true | { select }
  const requestedFields = new Set()
  const requestedFrom   = new Set()  // @from fields explicitly selected
  let   needsAllDbCols  = false

  for (const [key, val] of Object.entries(select)) {
    if (!val) continue  // skip false/null/undefined

    requestedFields.add(key)

    if (key in tableRels) {
      // Relation field — treat as include (possibly with nested select)
      relationSelects[key] = typeof val === 'object' && val !== true ? val : true

    } else if (tableComputed.has(key)) {
      // @computed field — no DB column, needs all DB cols so fn has its deps
      needsAllDbCols = true

    } else if (tableFrom.has(key)) {
      // @from field — subquery is injected at buildSQL time, track for trimming
      requestedFrom.add(key)

    } else {
      // Normal DB column — value can be true or an options object e.g. { resolve: false }
      dbFields[key] = val
    }
  }

  // Merge include into relationSelects (include wins if both specify same rel)
  if (include) {
    for (const [relName, relVal] of Object.entries(include)) {
      if (!relVal) continue
      if (!(relName in relationSelects)) {
        requestedFields.add(relName)
        relationSelects[relName] = relVal
      }
    }
  }

  // Inject FK columns required for relation resolution
  // They need to be in the SQL SELECT even if the user didn't ask for them
  const injectedFKs = new Set()

  if (!needsAllDbCols) {
    for (const relName of Object.keys(relationSelects)) {
      const rel = tableRels[relName]
      if (!rel) continue

      if (rel.kind === 'belongsTo') {
        // Need the FK column on this table to join to the target
        if (!dbFields[rel.foreignKey]) {
          dbFields[rel.foreignKey] = true
          if (!requestedFields.has(rel.foreignKey)) {
            injectedFKs.add(rel.foreignKey)
          }
        }
      } else {
        // hasMany — need the referenced key on this table (usually 'id')
        if (!dbFields[rel.referencedKey]) {
          dbFields[rel.referencedKey] = true
          if (!requestedFields.has(rel.referencedKey)) {
            injectedFKs.add(rel.referencedKey)
          }
        }
      }
    }
  }

  const sqlCols = needsAllDbCols
    ? '*'
    : Object.keys(dbFields).length > 0
      ? Object.keys(dbFields).map(c => `"${c}"`).join(', ')
      : '"_no_cols_"'  // edge case: only computed/relation fields selected

  return { sqlCols, relationSelects, requestedFields, injectedFKs, needsAllDbCols, requestedFrom }
}

// ─── Post-select trimming ─────────────────────────────────────────────────────
// After reads + computed + includes, strip anything the user didn't ask for.
// Called only when select was provided.

export function trimToSelect(row, requestedFields, injectedFKs) {
  if (!row) return null
  const out = {}
  for (const [key, val] of Object.entries(row)) {
    // Keep if user requested it, skip if it was injected just for FK joins
    if (requestedFields.has(key) && !injectedFKs.has(key)) {
      out[key] = val
    }
  }
  return out
}

export function trimAllToSelect(rows, requestedFields, injectedFKs) {
  if (!requestedFields) return rows
  return rows.map(r => trimToSelect(r, requestedFields, injectedFKs))
}

// ─── JSON serialization ───────────────────────────────────────────────────────

export function deserializeRow(row, jsonFields) {
  if (!row || !jsonFields.size) return row
  const out = { ...row }
  for (const field of jsonFields) {
    if (field in out && typeof out[field] === 'string') {
      try { out[field] = JSON.parse(out[field]) } catch {}
    }
  }
  return out
}

export function serializeRow(data, jsonFields) {
  if (!data || !jsonFields.size) return data
  const out = { ...data }
  for (const field of jsonFields) {
    if (field in out && out[field] !== null && typeof out[field] !== 'string') {
      out[field] = JSON.stringify(out[field])
    }
  }
  return out
}

// ─── Cursor pagination ────────────────────────────────────────────────────────
//
// Encodes/decodes opaque cursor tokens (base64 JSON).
// Builds the WHERE clause for cursor-based pagination using tuple comparison
// so every page uses the index directly — O(log n) regardless of page number.
//
// For single-field orderBy { id: 'asc' }:
//   WHERE "id" > ?
//
// For multi-field orderBy [{ createdAt: 'desc' }, { id: 'asc' }]:
//   WHERE ("createdAt" < ?) OR ("createdAt" = ? AND "id" > ?)
//
// The direction of the comparison flips based on ASC/DESC.

export function encodeCursor(values) {
  return Buffer.from(JSON.stringify(values)).toString('base64url')
}

export function decodeCursor(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new Error(`Invalid cursor token`)
  }
}

// Parse orderBy into a consistent array of { col, dir } objects.
// Relation orderBy items ({ rel: { field: 'asc' } }) are skipped — they are
// not DB columns and cannot be used as cursor fields.
export function normaliseOrderBy(orderBy) {
  if (!orderBy) return [{ col: 'id', dir: 'ASC' }]
  const items = Array.isArray(orderBy) ? orderBy : [orderBy]
  return items.flatMap(item =>
    Object.entries(item)
      .filter(([, dir]) => {
        if (dir === null) return false
        if (typeof dir === 'object') return dir.dir != null  // object form with dir key
        return true
      })
      .map(([col, dir]) => ({
        col,
        dir: (typeof dir === 'object' ? dir.dir : dir).toUpperCase(),
      }))
  )
}

// Build the cursor WHERE clause for multi-field tuple comparison.
// Returns { sql, params } to be ANDed with any existing where clause.
//
// For fields [{ col: 'createdAt', dir: 'DESC' }, { col: 'id', dir: 'ASC' }]
// and cursor values { createdAt: '2024-01-10', id: 50 } this generates:
//
//   ("createdAt" < ?) OR ("createdAt" = ? AND "id" > ?)
//
// which correctly continues from that position in either direction.

export function buildCursorWhere(fields, cursorValues, params) {
  if (!cursorValues || !fields.length) return ''

  // For a single field, simple comparison
  if (fields.length === 1) {
    const { col, dir } = fields[0]
    const op = dir === 'ASC' ? '>' : '<'
    params.push(cursorValues[col])
    return `"${col}" ${op} ?`
  }

  // Multi-field: build OR chain of progressively more specific conditions
  // ( A < a ) OR ( A = a AND B > b ) OR ( A = a AND B = b AND C > c ) ...
  const clauses = []

  for (let i = 0; i < fields.length; i++) {
    const parts = []

    // Equality conditions for all fields before position i
    for (let j = 0; j < i; j++) {
      params.push(cursorValues[fields[j].col])
      parts.push(`"${fields[j].col}" = ?`)
    }

    // Comparison for field at position i
    const { col, dir } = fields[i]
    const op = dir === 'ASC' ? '>' : '<'
    params.push(cursorValues[col])
    parts.push(`"${col}" ${op} ?`)

    clauses.push(`(${parts.join(' AND ')})`)
  }

  return clauses.join(' OR ')
}

// Extract cursor values from a row given the orderBy fields
export function extractCursorValues(row, fields) {
  const values = {}
  for (const { col } of fields) {
    values[col] = row[col]
  }
  return values
}


// ─── Boolean coercion ─────────────────────────────────────────────────────────
// SQLite stores Boolean as INTEGER (0/1). Litestone auto-coerces on read/write
// so JS developers get real true/false, not 0/1.

// Deserialize: 0/1 → false/true on Boolean fields
export function coerceBooleans(row, boolFields) {
  if (!row || !boolFields.size) return row
  const out = { ...row }
  for (const field of boolFields) {
    if (field in out && out[field] !== null) {
      out[field] = out[field] === 1 || out[field] === true
    }
  }
  return out
}

// Serialize: true/false → 1/0 on Boolean fields
export function serializeBooleans(data, boolFields) {
  if (!data || !boolFields.size) return data
  const out = { ...data }
  for (const field of boolFields) {
    if (field in out && out[field] !== null && out[field] !== undefined) {
      out[field] = out[field] ? 1 : 0
    }
  }
  return out
}

// ─── Window functions ─────────────────────────────────────────────────────────
//
// Builds window function SQL expressions from a user-supplied window spec:
//
//   window: {
//     rank:       { rank: true, partitionBy: 'accountId', orderBy: { score: 'desc' } },
//     runningSum: { sum: 'amount', orderBy: { createdAt: 'asc' } },
//     prevValue:  { lag: 'amount', offset: 1, orderBy: { createdAt: 'asc' } },
//     movingAvg:  { avg: 'price', orderBy: { date: 'asc' }, rows: [-2, 0] },
//   }
//
// Returns: array of SQL strings to add to SELECT, e.g.:
//   [ 'RANK() OVER (PARTITION BY "accountId" ORDER BY "score" DESC) AS "rank"', ... ]
//
// Supported functions:
//   rowNumber, rank, denseRank                    — positional
//   lag(field, offset?), lead(field, offset?)      — adjacent row value
//   firstValue(field), lastValue(field)            — partition boundary value
//   sum, avg, count, min, max                      — running/rolling aggregates
//
// All support: partitionBy (field | field[]), orderBy ({ field: dir }), rows ([start, end])
// rows: [-2, 0] → ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
//        [null, null] → ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING

export function buildWindowCols(windowSpec, filterParams = null) {
  if (!windowSpec || !Object.keys(windowSpec).length) return []

  const cols = []

  for (const [alias, spec] of Object.entries(windowSpec)) {
    const expr = _buildWindowExpr(alias, spec)
    const over = _buildOverClause(spec)

    // FILTER (WHERE ...) — optional, only valid on aggregate window functions
    let filterClause = ''
    if (spec.filter) {
      if (isRawClause(spec.filter)) {
        filterClause = ` FILTER (WHERE ${spec.filter.sql})`
        if (filterParams) filterParams.push(...spec.filter.params)
      } else if (typeof spec.filter === 'string') {
        filterClause = ` FILTER (WHERE ${spec.filter})`
      }
    }

    cols.push(`${expr}${filterClause} OVER ${over} AS "${alias}"`)
  }

  return cols
}

function _buildWindowExpr(alias, spec) {
  // Positional functions
  if (spec.rowNumber)   return 'ROW_NUMBER()'
  if (spec.rank)        return 'RANK()'
  if (spec.denseRank)   return 'DENSE_RANK()'
  if (spec.cumeDist)    return 'CUME_DIST()'
  if (spec.percentRank) return 'PERCENT_RANK()'

  // Offset functions
  if (spec.lag != null) {
    const offset = spec.offset ?? 1
    const def    = spec.default != null ? `, ${_sqlLit(spec.default)}` : ''
    return `LAG("${spec.lag}", ${offset}${def})`
  }
  if (spec.lead != null) {
    const offset = spec.offset ?? 1
    const def    = spec.default != null ? `, ${_sqlLit(spec.default)}` : ''
    return `LEAD("${spec.lead}", ${offset}${def})`
  }
  if (spec.firstValue != null) return `FIRST_VALUE("${spec.firstValue}")`
  if (spec.lastValue  != null) return `LAST_VALUE("${spec.lastValue}")`
  if (spec.nthValue   != null) return `NTH_VALUE("${spec.nthValue}", ${spec.n ?? 1})`
  if (spec.ntile      != null) return `NTILE(${spec.ntile})`

  // Aggregate window functions
  if (spec.sum   != null) return `SUM("${spec.sum}")`
  if (spec.avg   != null) return `AVG("${spec.avg}")`
  if (spec.min   != null) return `MIN("${spec.min}")`
  if (spec.max   != null) return `MAX("${spec.max}")`
  if (spec.count != null) {
    return spec.count === '*' || spec.count === true ? 'COUNT(*)' : `COUNT("${spec.count}")`
  }

  throw new Error(`window "${alias}": unrecognised window function spec. Use rowNumber, rank, denseRank, lag, lead, sum, avg, min, max, count, firstValue, lastValue.`)
}

function _buildOverClause(spec) {
  const parts = []

  // PARTITION BY
  if (spec.partitionBy) {
    const cols = Array.isArray(spec.partitionBy) ? spec.partitionBy : [spec.partitionBy]
    parts.push(`PARTITION BY ${cols.map(c => `"${c}"`).join(', ')}`)
  }

  // ORDER BY
  if (spec.orderBy) {
    const items = Array.isArray(spec.orderBy) ? spec.orderBy : [spec.orderBy]
    const exprs = items.flatMap(item =>
      Object.entries(item).map(([col, dir]) => {
        if (dir !== null && typeof dir === 'object') {
          const d = dir.dir?.toUpperCase() ?? 'ASC'
          const n = dir.nulls ? ` NULLS ${dir.nulls.toUpperCase()}` : ''
          return `"${col}" ${d}${n}`
        }
        return `"${col}" ${dir.toUpperCase()}`
      })
    )
    parts.push(`ORDER BY ${exprs.join(', ')}`)
  }

  // ROWS / RANGE frame
  if (spec.rows) {
    const [start, end] = spec.rows
    parts.push(`ROWS BETWEEN ${_frameBound(start, 'PRECEDING')} AND ${_frameBound(end, 'FOLLOWING')}`)
  } else if (spec.range) {
    const [start, end] = spec.range
    parts.push(`RANGE BETWEEN ${_frameBound(start, 'PRECEDING')} AND ${_frameBound(end, 'FOLLOWING')}`)
  }

  return `(${parts.join(' ')})`
}

function _frameBound(val, defaultDir) {
  if (val === null || val === undefined) return `UNBOUNDED ${defaultDir}`
  if (val === 0)  return 'CURRENT ROW'
  if (val < 0)    return `${Math.abs(val)} PRECEDING`
  return `${val} FOLLOWING`
}

function _sqlLit(val) {
  if (val === null) return 'NULL'
  if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`
  return String(val)
}
