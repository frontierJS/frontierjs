// query.js — SQL clause builders + row serialization + select parsing

import { ValidationError } from './validate.js'

// ─── sql tagged template ──────────────────────────────────────────────────────
//
// Safe parameterized raw SQL for use inside where: { $raw: sql`...` }.
// Interpolated values are extracted as params — never concatenated into the SQL string.
//
// Usage:
//   import { sql } from '@frontierjs/litestone'
//
//   db.product.findMany({
//     where: { $raw: sql`price > IF(state = ${state}, ${minPrice}, 100)` }
//   })
//
// Returns a RawClause: { _litestoneRaw: true, sql: string, params: any[] }

export function sql(strings, ...values) {
  let sqlStr   = ''
  const params = []
  for (let i = 0; i < strings.length; i++) {
    sqlStr += strings[i]
    if (i >= values.length) continue
    const value = values[i]
    // A fragment is litestone's own SQL, not a caller's — the only thing that
    // may reach the pattern rather than the parameter list (Invariant 8). Its
    // own operands are still bound, and pushed HERE so they keep their place in
    // the positional order.
    if (isSqlFragment(value)) { sqlStr += value.sql; params.push(...value.params) }
    else                      { sqlStr += '?';       params.push(value) }
  }
  assertNoBareClock(sqlStr)
  return { _litestoneRaw: true, sql: expandNowTokens(sqlStr).trim(), params }
}

/**
 * A raw clause built from SCHEMA text — a declaration, never a caller's input.
 *
 * The same trust `@from(where:)` and an `@@allow` expression already have:
 * the string was written by whoever wrote the schema, so it may reach the
 * pattern (Invariant 8 is about CALLER-supplied names). It still gets the clock
 * check a hand-written fragment gets, because `datetime('now')` is wrong here
 * for exactly the reason it is wrong there (`FJS-226`).
 */
export function schemaRaw(text) {
  assertNoBareClock(text)
  return { _litestoneRaw: true, sql: expandNowTokens(text).trim(), params: [] }
}

// Check if a value is a RawClause produced by the sql tag
export function isRawClause(val) {
  return val !== null && typeof val === 'object' && val._litestoneRaw === true
}

// ─── now() — the clock, spelled so it can match a stored DateTime ────────────
//
// `DateTime` is stored as ISO-8601 TEXT with a `T` and a `Z`
// (2026-08-13T07:38:31.984Z) and every comparison against it is string-wise.
// SQLite's own `datetime('now')` answers `2026-08-13 07:38:31` — space
// separator, no milliseconds, no zone — and `'T'` (0x54) sorts ABOVE a space
// (0x20), so every value stored TODAY compares greater than a same-day
// `datetime('now')`. A predicate written with it is right for yesterday's rows
// and wrong for this morning's, which is why nobody notices: a demo seeded with
// last week's data passes (FJS-226).
//
//   where: { $raw: sql`dueAt < ${now()} AND completedAt IS NULL` }
//   where: { $raw: sql`startedAt > ${now('-7 days')}` }
//
// It emits SQLite's clock rather than a JS timestamp, so every occurrence in
// one statement is the SAME instant — SQLite fixes `'now'` for the duration of
// a statement, which two `new Date()` calls cannot promise. The consequence is
// that `createClient({ now })` does NOT reach it: that clock is the policy
// evaluator's, and a test that needs a frozen instant here binds its own ISO
// string instead.
//
// Modifiers are BOUND, not spliced. `strftime` takes them as parameters, so a
// caller-supplied '-7 days' never enters the SQL pattern.
const SQL_FRAGMENT = Symbol.for('litestone.sqlFragment')

/** litestone's own SQL, safe to splice into a pattern. Never built from caller text. */
function sqlFragment(sqlText, params = []) {
  return { [SQL_FRAGMENT]: true, sql: sqlText, params }
}

export function isSqlFragment(val) {
  return val !== null && typeof val === 'object' && val[SQL_FRAGMENT] === true
}

export function now(...modifiers) {
  for (const m of modifiers) {
    if (typeof m !== 'string')
      throw new Error(`now(): a modifier is a SQLite date modifier string like '-7 days' or 'start of month' — got ${typeof m}`)
  }
  return sqlFragment(
    `strftime('%Y-%m-%dT%H:%M:%fZ','now'${modifiers.map(() => ',?').join('')})`,
    modifiers,
  )
}

// ─── The spellings that can never match ──────────────────────────────────────
//
// Each of these produces a format no stored DateTime can equal, so a comparison
// against one is not a filter that returns too few rows — it is a filter that
// answers a different question. Refused rather than warned: the wrong answer is
// plausible, which is the case where a warning is read after the bug ships.
//
// `julianday('now')` and `unixepoch()` are NOT here: they produce numbers, and
// `julianday(dueAt) - julianday('now') < 7` compares like with like. Nor is
// `strftime`, whose format string is the caller's to get right — and getting it
// right is what `now()` is.
const BARE_CLOCK = [
  // `\bdate(` also matches the tail of `datetime(`, so datetime is tested first
  // and each name is anchored on a word boundary.
  [/\bdatetime\s*\(\s*'now'/i, "datetime('now')"],
  [/\bdate\s*\(\s*'now'/i,     "date('now')"],
  [/\btime\s*\(\s*'now'/i,     "time('now')"],
  [/\bCURRENT_TIMESTAMP\b/i,    'CURRENT_TIMESTAMP'],
  [/\bCURRENT_DATE\b/i,         'CURRENT_DATE'],
  [/\bCURRENT_TIME\b/i,         'CURRENT_TIME'],
]

// `now()` written as a TOKEN rather than interpolated. A `@from(where: …)` is a
// string in the schema and a plain-string `$raw` has no interpolation either, so
// without this the refusal below would name a spelling those two callers cannot
// write. Litestone's own text replaces litestone's own token — nothing reaches
// the pattern that was not already in it.
const NOW_TOKEN     = /\bnow\s*\(\s*\)/gi
const NOW_TOKEN_ARG = /\bnow\s*\(/gi
export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

export function expandNowTokens(sqlText) {
  if (!sqlText || !/\bnow\s*\(/i.test(sqlText)) return sqlText
  // Empty first: the second pattern would otherwise leave a trailing comma.
  return sqlText
    .replace(NOW_TOKEN, NOW_SQL)
    .replace(NOW_TOKEN_ARG, `strftime('%Y-%m-%dT%H:%M:%fZ','now',`)
}

export function assertNoBareClock(sqlText, where = 'raw SQL') {
  if (!sqlText) return
  for (const [re, name] of BARE_CLOCK) {
    if (!re.test(sqlText)) continue
    throw new Error(
      `${where}: \`${name}\` cannot match a stored DateTime.\n\n` +
      `litestone writes DateTime as ISO-8601 TEXT — 2026-08-13T07:38:31.984Z — and SQLite answers\n` +
      `\`${name}\` in its own format. The comparison is string-wise and 'T' sorts above a space, so\n` +
      `every row stored today compares GREATER than a same-day ${name}: the predicate is right for\n` +
      `older rows and wrong for recent ones, with nothing raised.\n\n` +
      `Use now(), which emits the spelling that matches:\n\n` +
      `    import { sql, now } from '@frontierjs/litestone'\n` +
      `    where: { $raw: sql\`dueAt < \${now()} AND completedAt IS NULL\` }\n` +
      `    where: { $raw: sql\`startedAt > \${now('-7 days')}\` }\n\n` +
      `Comparing whole days rather than instants is \`now('start of day')\`. For arithmetic on a\n` +
      `duration, julianday() is untouched — it answers a number, so it compares like with like.`
    )
  }
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

// Operators that read the column as a JSON array. Asking one of a scalar column
// is a caller error, not a SQLite error — see the guard in buildWhere.
const ARRAY_OPS = new Set(['has', 'hasEvery', 'hasSome', 'hasNone', 'isEmpty'])

// Operators that compile to LIKE, which asks a question about TEXT.
const TEXT_OPS = new Set(['contains', 'startsWith', 'endsWith'])

// A column whose stored text is not the value cannot answer one, and the way it
// fails is a plausible answer rather than an error: on an array column `contains`
// substring-matches the stored JSON, so `contains: '['` matches every row and
// `contains: '","'` matches every array of two or more elements — it looks like
// `has` and is not `has`. On a Boolean the value is 0/1, so `contains: 'tru'`
// answers nothing at all.
//
// Int and DateTime are deliberately NOT here: SQLite's coercion answers the
// question that was asked, and `{ when: { contains: '2024-01' } }` against an ISO
// column is a genuinely useful way to ask for a month.
const TEXT_OP_REFUSALS = {
  array:   (k, op) => `"${k}" holds a JSON array, so "${op}" would substring-match the stored document rather than its elements — ` +
                      `use "has" for an element, or "hasSome"/"hasEvery" for several`,
  json:    (k, op) => `"${k}" holds a JSON document, so "${op}" would match its serialised text, punctuation included — ` +
                      `declare @type(...) on the column to filter by a path`,
  file:    (k, op) => `"${k}" holds a file reference document, so "${op}" would match its serialised text rather than anything about the file`,
  boolean: (k, op) => `"${k}" is a Boolean, stored as 0/1, so "${op}" can never match — compare it to true or false`,
}

// Every operator `buildWhere` answers, in one set. Read by the typed-JSON walk,
// which cannot tell a sub-key from an operator without it and reported an
// operator as a missing field (FJS-206).
const WHERE_OPS = new Set([...JSON_LEAF_OPS, ...ARRAY_OPS, ...TEXT_OPS, 'equals'])

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
function buildTypedJsonClauses(colExpr, where, typeDecl, path, params, typedJsonMap, colName) {
  const clauses = []
  if (!typeDecl) return clauses

  // Build a quick lookup: key name → field decl
  const fieldByName = new Map((typeDecl.fields ?? []).map(f => [f.name, f]))

  // A where on a typed column is a PATH, so every key is read as a sub-key —
  // including one that is an operator everywhere else. `{ addr: { has: 'NYC' } }`
  // reported `Unknown field 'has'`, which names the type, calls an operator a
  // field, and never names the column the caller wrote (FJS-206).
  // Where the caller is, named the way they wrote it: the column, plus the path
  // walked into it so far.
  const at = colName ? `"${[colName, ...path].join('.')}"` : null

  for (const [key, val] of Object.entries(where)) {
    if (!fieldByName.has(key)) {
      const known = (typeDecl.fields ?? []).map(f => f.name)
      const has   = known.length ? `. ${typeDecl.name} has: ${known.join(', ')}` : ''
      throw new Error(
        WHERE_OPS.has(key)
          ? `"${key}" is an operator and ${typeDecl.name} has no field by that name` +
            `${at ? `, so it was read as a sub-key of ${at}` : ''} — ` +
            `the column is Json @type(${typeDecl.name}), and a where on a typed column is a PATH. ` +
            `Name a field of ${typeDecl.name} first, then the operator under it${has}`
          : `Unknown field '${key}' on type ${typeDecl.name} in WHERE clause` +
            `${at ? ` (at ${at})` : ''}${has}`)
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
          clauses.push(...buildTypedJsonClauses(colExpr, val, nestedType, subPath, params, typedJsonMap, colName))
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
//
// Array columns (when fieldKinds is provided):
//   { tags: ['x', 'y'] }              the row holds x OR y   — IN over the elements
//   { tags: { equals: [...] } }       the row IS exactly that — ordered
//   { tags: { has, hasEvery, hasSome, hasNone, isEmpty } }
//
// fieldKinds: Map<fieldName, 'array'|'json'|'file'|'boolean'> for THIS model —
// what the column HOLDS, which the operand cannot say. `{ id: [1,2] }` and
// `{ tags: ['x','y'] }` are the same shape and mean different SQL, so without it
// the array column silently compiles to `"tags" IN ('x','y')`, which asks a JSON
// document whether it equals 'x'. It is the same fact a text operator needs, so
// it is one map rather than one per question.

export function buildWhere(where, params, fromExprMap = null, tableAlias = null, typedJsonMap = null, relFilter = null, fieldKinds = null) {
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
  //
  // A Boolean column filtered by TEXT is the third case, and it is the one that
  // fails silently. SQLite stores a Boolean as 0/1, a JS `true` binds as 1, and
  // the string `'true'` binds as the text `'true'` — which matches no row and
  // answers an empty list with a 200. `fieldKinds` already knows which columns
  // are Boolean, so the conversion is available exactly where the guess would
  // otherwise be one. Only the two spellings SQLite could never have stored;
  // anything else is left alone and compares as itself.
  const coerce = (v, fieldName) => {
    if (v instanceof Date) return v.toISOString()
    if (typeof v === 'string' && fieldKinds?.get(fieldName) === 'boolean') {
      if (v === 'true')  return 1
      if (v === 'false') return 0
    }
    return v
  }
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
    // A plain object is the one unbindable value the driver does NOT throw on:
    // bun:sqlite reads it as a bag of NAMED parameters, and a statement built
    // with positional `?` matches none of its keys — so it runs with EVERY
    // binding dropped, including the WHERE, and reports no error. The read
    // answers nothing and the write changes nothing. Arrays and Dates are
    // legitimate operands and never reach here as a single value.
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      throw new Error(`where clause: field "${fieldName}" was given an object where a value was expected — ` +
                      `an operator object belongs one level up (\`${fieldName}: { gt: 1 }\`), and a nested object needs @type(...) on the column`)
    }
    return v
  }
  // Bound to the current key being processed in the loop below. `pushFor(k)(v)`
  // both coerces and bind-checks `v` against field name `k`. The factory keeps
  // hot-path overhead minimal — the closure is created once per top-level key
  // and reused for all operands at that key.
  const pushFor = (fieldName) => (v) => params.push(checkBindable(coerce(v, fieldName), fieldName))

  for (const [key, val] of Object.entries(where)) {
    if (key === 'AND') {
      const parts = val.map(w => buildWhere(w, params, fromExprMap, tableAlias, typedJsonMap, relFilter, fieldKinds)).filter(Boolean)
      if (parts.length) clauses.push(`(${parts.join(' AND ')})`)
      continue
    }
    if (key === 'OR') {
      const parts = val.map(w => buildWhere(w, params, fromExprMap, tableAlias, typedJsonMap, relFilter, fieldKinds)).filter(Boolean)
      if (parts.length) clauses.push(`(${parts.join(' OR ')})`)
      continue
    }
    if (key === 'NOT') {
      const inner = buildWhere(val, params, fromExprMap, tableAlias, typedJsonMap, relFilter, fieldKinds)
      if (inner) clauses.push(`NOT (${inner})`)
      continue
    }

    // ── Relation filters: some / every / none / is / isNot ──────────────────
    // When `key` names a relation (resolved by the client-supplied relFilter),
    // compile a correlated EXISTS/NOT EXISTS subquery instead of a column test.
    // relFilter returns: SQL string (a clause), '' (relation but no-op), or
    // undefined (not a relation → fall through to normal column handling).
    if (relFilter && val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
      const relSql = relFilter(key, val, params, tableAlias)
      if (relSql !== undefined) {
        if (relSql) clauses.push(relSql)
        continue
      }
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
        // A plain string skips the sql tag, so it skips the tag's clock check
        // with it. Same rule, asked again — the string form is the one written
        // when there is nothing to interpolate, which is exactly the shape
        // `dueAt < datetime('now')` takes.
        assertNoBareClock(val, 'where.$raw')
        clauses.push(`(${expandNowTokens(val)})`)
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
      const subClauses = buildTypedJsonClauses(colExpr, val, typedJsonInfo, [], params, typedJsonMap, key)
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

    const isArrayCol = fieldKinds?.get(key) === 'array'

    if (typeof val !== 'object' || Array.isArray(val) || val instanceof Date) {
      if (Array.isArray(val)) {
        if (!val.length) { clauses.push('0 = 1'); continue }
        val.forEach(v => push(typeof v === 'boolean' ? (v ? 1 : 0) : v))
        // The shorthand says the same thing either way — the column's value is
        // in this list. A scalar has one value; an array column supplies its
        // elements, so the IN moves inside json_each. For an exact, ordered
        // match, say `equals`.
        clauses.push(isArrayCol
          ? `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${val.map(() => '?').join(', ')}))`
          : `${col} IN (${val.map(() => '?').join(', ')})`)
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
      // json_each and json() raise "malformed JSON" on a column that is not a
      // JSON document — a message naming neither the field nor the operator.
      // Say it here instead, while both are still in hand.
      // Both refusals below are ValidationErrors rather than bare Errors: an
      // operator the column cannot answer is a caller error, and junction maps
      // the name to a 400. A 500 would say the server broke.
      if (ARRAY_OPS.has(op) && fieldKinds && !isArrayCol)
        throw new ValidationError([{ path: ['where', key], message:
          `"${op}" is an array operator and "${key}" is not an array field` }])

      // A string operator on a column that does not hold text answers the wrong
      // question instead of failing — see TEXT_OP_REFUSALS.
      if (TEXT_OPS.has(op)) {
        const refusal = TEXT_OP_REFUSALS[fieldKinds?.get(key)]
        if (refusal) throw new ValidationError([{ path: ['where', key], message: refusal(key, op) }])
      }

      switch (op) {
        case 'gt':         push(operand);              clauses.push(`${col} > ?`);           break
        case 'gte':        push(operand);              clauses.push(`${col} >= ?`);          break
        case 'lt':         push(operand);              clauses.push(`${col} < ?`);           break
        case 'lte':        push(operand);              clauses.push(`${col} <= ?`);          break
        case 'contains':   push(`%${operand}%`);       clauses.push(`${col} LIKE ?`);        break
        case 'startsWith': push(`${operand}%`);        clauses.push(`${col} LIKE ?`);        break
        case 'endsWith':   push(`%${operand}`);        clauses.push(`${col} LIKE ?`);        break
        // `in` and the bare-array shorthand are documented as the same question,
        // so they have to compile the same way: on an array column the row
        // supplies several values and the IN moves inside json_each. Without
        // this the shorthand answered and its own explicit spelling did not.
        case 'in':
          if (!operand?.length) { clauses.push('0 = 1'); break }
          operand.forEach(v => push(v))
          clauses.push(isArrayCol
            ? `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${operand.map(() => '?').join(', ')}))`
            : `${col} IN (${operand.map(() => '?').join(', ')})`)
          break
        case 'notIn':
          if (!operand?.length) break
          operand.forEach(v => push(v))
          // Include NULL rows — NOT IN silently excludes them in SQLite
          clauses.push(isArrayCol
            ? `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${operand.map(() => '?').join(', ')}))`
            : `(${col} NOT IN (${operand.map(() => '?').join(', ')}) OR ${col} IS NULL)`)
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
        case 'hasNone':
          // none of these elements present
          if (!operand?.length) break
          operand.forEach(v => push(v))
          clauses.push(`NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${operand.map(() => '?').join(', ')}))`)
          break
        case 'isEmpty':
          clauses.push(operand ? `json_array_length(${col}) = 0` : `json_array_length(${col}) > 0`)
          break
        case 'equals':
          // The exact set, in order. json() on both sides normalises whitespace,
          // so a row a JS migration wrote as `[ "x", "y" ]` still matches.
          if (isArrayCol && Array.isArray(operand)) {
            push(JSON.stringify(operand))
            clauses.push(`json(${col}) = json(?)`)
            break
          }
          if (operand === null) { clauses.push(`${col} IS NULL`); break }
          push(typeof operand === 'boolean' ? (operand ? 1 : 0) : operand)
          clauses.push(`${col} = ?`)
          break
        case 'not':
          if (operand === null) { clauses.push(`${col} IS NOT NULL`); break }
          if (Array.isArray(operand)) {
            // Without this the array falls into `col != ?` with one placeholder
            // and N bindings, and SQLite answers about placeholder counts.
            if (isArrayCol) {
              push(JSON.stringify(operand))
              clauses.push(`json(${col}) != json(?)`)
            } else {
              if (!operand.length) break
              operand.forEach(v => push(v))
              clauses.push(`(${col} NOT IN (${operand.map(() => '?').join(', ')}) OR ${col} IS NULL)`)
            }
            break
          }
          push(operand)
          clauses.push(`${col} != ?`)
          break
        default: {
          // An untyped `Json` column has no declared shape to traverse, so a
          // structural filter lands here and reads as a misspelt operator —
          // which sends the reader looking for the wrong thing (FJS-206). The
          // column is the diagnosis, and both ways forward are stated.
          const untypedJson = fieldKinds?.get(key) === 'json' && !typedJsonMap?.[key]
          throw new Error(
            `Unknown where operator "${op}" on field "${key}"` +
            (untypedJson
              ? ` — "${key}" is an untyped Json column, so there is no declared shape to traverse and "${op}" ` +
                `was read as an operator. Declare @type(...) on the column to filter by path, or filter it as ` +
                `it stands with $raw: where: { $raw: sql\`json_extract("${key}", '$.${op}') = ...\` }`
              : ''))
        }
      }
    }
  }

  return clauses.join(' AND ')
}

// ─── Order by ─────────────────────────────────────────────────────────────────
//
// `$raw` is the escape hatch `where` has had all along and the sort side did
// not, which is the actual gap behind FJS-D28: everything monotonic in a stored
// column already sorts, and what does not — *snoozed last regardless of due
// date*, a weighted score — could not be said at all (FJS-230).
//
//   orderBy: { $raw: sql`CASE WHEN "snoozedUntil" > ${now()} THEN 1 ELSE 0 END ASC, "dueAt" ASC` }
//
// The fragment is the whole ORDER BY tail, direction included, because that is
// what a sort no builder can express needs: several keys, in an order only the
// caller knows. It composes with ordinary keys in the position it is written.
//
// **It must be a `sql` tag, and a plain string is refused by name.** The tag's
// static text is written by the app author and its interpolations are bound, so
// Invariant 8 holds unchanged — caller-supplied values never enter the pattern.
// A bare string is exactly how a caller-supplied one would arrive, so accepting
// it would turn the hatch into an injection.
//
// Params travel in a SEPARATE array the caller splices in at the ORDER BY, not
// into the statement's params as they are built: positional binds make the
// order the correctness, and ORDER BY comes after both the WHERE and the row
// policy that is appended to it (FJS-215 is the same lesson).

function rawOrderPart(val, outParams) {
  if (typeof val === 'string')
    throw new Error(
      `orderBy $raw must be a sql\`\` tag, not a string — the tag binds its values, ` +
      `a string would put them in the pattern. Write: orderBy: { $raw: sql\`…\` }`)
  if (!isRawClause(val) && !isSqlFragment(val))
    throw new Error(`orderBy $raw must be a sql\`\` tag result, got ${val === null ? 'null' : typeof val}`)
  if (!val.sql.trim()) throw new Error('orderBy $raw is empty')
  outParams.push(...val.params)
  return val.sql.trim()
}

export function buildOrderBy(orderBy, outParams = []) {
  if (!orderBy) return ''
  const items = Array.isArray(orderBy) ? orderBy : [orderBy]
  const parts  = []
  for (const item of items) {
    for (const [col, dir] of Object.entries(item)) {
      if (col === '$raw') { parts.push(rawOrderPart(dir, outParams)); continue }
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

export function buildRelationOrderBy(orderBy, modelName, relationMap, modelToTable = (m) => m, outParams = []) {
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
      // A raw fragment is flat — it names its own columns, and under a JOIN the
      // caller qualifies them, because only the caller knows what the fragment
      // is about. Marked `raw` so the `t.` rewrite below leaves it alone: that
      // regex would turn `"snoozedUntil" > ?` into `t."snoozedUntil" > ?` and
      // stop after the first column, qualifying one name in a fragment that has
      // several.
      if (key === '$raw') {
        entries.push({ flat: true, raw: true, sql: rawOrderPart(val, outParams) })
        continue
      }
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
      e.flat && !e.raw ? e.sql.replace(/^"([^"]+)"/, 't."$1"') : e.sql
    )
    return { joinClauses, orderParts }
  }
  // A raw part is flat and still has to come back here: the caller only falls
  // through to buildOrderBy for the flat ones when there are no joins, and that
  // is the same list built twice. Returning it in both places would emit it
  // twice, so it rides the non-flat channel only when buildOrderBy is skipped.
  const orderParts = entries.filter(e => !e.flat).map(e => e.sql)
  return { joinClauses, orderParts }
}

// Aggregate orderBy — emits a correlated subquery into ORDER BY.
// No JOINs needed; no row duplication risk.
//
// hasMany:    SELECT COUNT(*) FROM "posts" WHERE "posts"."userId" = t."id"
// manyToMany: SELECT COUNT(*) FROM "_tags_posts" WHERE "postId" = t."<pk>"
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
        subquery = `(SELECT COUNT(*) FROM "${rel.joinTable}" WHERE "${rel.selfKey}" = t."${rel.selfPk ?? 'id'}")`
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
//     needsAllDbCols:   boolean      — true when a computed field that declares
//                                      no `needs` is selected (we fetch * so its
//                                      fn has whatever it reads)
//
// `fromSets` is the model's @from map keyed by field name — a Map, because the
// defs are read for more than membership: a @from(first/last) field needs the
// column its target points back at in the SELECT (see below).
//   }
//
// Rules:
//   - Relation fields in select are treated as includes (with optional nested select)
//   - A @computed field has no DB column. One that declares `needs` contributes
//     exactly those columns; one that does not widens the whole SELECT to *
//   - FK columns needed for include resolution are injected into the SQL SELECT
//     and then stripped from results unless the user also selected them

export function parseSelectArg(select, modelName, relationMap, computedSets, include, fromSets, computedFns) {
  if (!select) return null

  const tableRels      = relationMap?.[modelName] ?? {}
  const tableComputed  = computedSets?.[modelName] ?? new Set()
  const tableFrom      = fromSets?.[modelName] ?? new Map()
  const tableFns       = computedFns?.[modelName] ?? null

  const dbFields        = {}    // user-requested DB column names
  const relationSelects = {}    // relation name → true | { select }
  const requestedFields = new Set()
  const requestedFrom   = new Set()  // @from fields explicitly selected
  const computedDeps    = []         // names a selected @computed field declared
  let   needsAllDbCols  = false

  for (const [key, val] of Object.entries(select)) {
    if (!val) continue  // skip false/null/undefined

    requestedFields.add(key)

    if (key in tableRels) {
      // Relation field — treat as include (possibly with nested select)
      relationSelects[key] = typeof val === 'object' && val !== true ? val : true

    } else if (tableComputed.has(key)) {
      // @computed field — no DB column of its own. Collected rather than
      // resolved here: a LATER key may be a computed field with no `needs`,
      // and that widens to * and makes every dep gathered so far moot.
      const needs = tableFns?.[key]?.needs
      if (needs) computedDeps.push(...needs)
      else       needsAllDbCols = true

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

  // Inject the dependencies a selected @computed field declared. They are NOT
  // added to requestedFields, so trimToSelect strips them again afterwards —
  // asking for a computed field must not smuggle its inputs into the result.
  if (!needsAllDbCols) {
    for (const name of computedDeps) {
      if (tableFrom.has(name)) requestedFrom.add(name)
      else if (!(name in dbFields)) dbFields[name] = true
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

  // A @from(first/last) field is resolved by REPICKING the row under the
  // caller's row policy, and the repick correlates on the column the target
  // points back at (resolveFromRowRefs). Injected the same way an FK is — into
  // the SQL, out of the answer — because without it the resolver has nothing to
  // correlate on and falls back to the id the startup subquery chose, which is
  // the pick made before the policy was known.
  if (!needsAllDbCols) {
    for (const name of requestedFrom) {
      // Every column of the correlation — a composite key is only a correlation
      // when all of it is in the row.
      for (const refCol of tableFrom.get?.(name)?.rowRef?.refCols ?? []) {
        if (dbFields[refCol]) continue
        dbFields[refCol] = true
        if (!requestedFields.has(refCol)) injectedFKs.add(refCol)
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
  // A cursor is the ORDER BY read back off the last row and compared against —
  // it needs a COLUMN it can extract a value from, and an expression has none.
  // Emitted as `"$raw" ASC` it would sort by a string constant and page by a
  // value that is not there, which is a wrong answer rather than a missing one.
  for (const item of items)
    if (item && '$raw' in item)
      throw new Error(
        `orderBy $raw cannot be used with a cursor — a cursor encodes the value of every sort key ` +
        `off the last row, and an expression is not a column it can read back. Use limit/offset for a ` +
        `computed sort, or sort by a stored column`)
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
