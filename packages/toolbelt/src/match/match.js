/*
 * match.js — does this record belong in that query's results?
 *
 * A pushed record is an announcement about a ROW; a live list is the answer to
 * a QUERY. Nothing on the wire says a row has left a filter — there is no such
 * event — so a store that applies every announcement it receives keeps rows the
 * query no longer admits, updated in place and quietly wrong.
 *
 * One definition, because there are two live stores and they had one between
 * them: sierra's, which asked this, and jetty's, which upserted whatever
 * arrived (`FJS-493`). jetty may not import sierra — the dependency direction
 * forbids it — and a hand copy is what `FJS-059` already paid for once, so the
 * pure half lives here, below the graph.
 *
 * The answer decides what the store does:
 *
 *   true   → upsert
 *   false  → REMOVE, because leaving the filter has no other event
 *   null   → cannot decide from this record; ask the server again
 *
 * Three answers rather than two. A matcher forced to return a boolean has to
 * guess about a filter it cannot see through — a `select` that dropped the
 * filtered column, a filter naming a relation, `$search`, a raw clause — and a
 * wrong guess is silent either way it falls.
 *
 * ── The operators ─────────────────────────────────────────────────────────
 *
 * Exactly what junction's `parseWhere`/`translateOps` accept and litestone's
 * `buildWhere` compiles: the `$`-prefixed wire spelling, and the bare litestone
 * spelling that reaches the same place through parseWhere's nested branch.
 * Nothing more — a keyword the server cannot be sent does not belong here.
 *
 * ── The fields table ──────────────────────────────────────────────────────
 *
 * `fields` is `{ name: { type } }` — anything richer satisfies it, which is why
 * sierra passes `buildFieldRules()`'s output whole. It is read for ONE reason:
 * the wire is text, so a query built from a URL or a form control sends `'5'`
 * for an Int, and SQLite's affinity makes `WHERE id = '5'` match row 5 where
 * `5 === '5'` does not. `@frontierjs/toolbelt/jsonschema`'s `fieldShapes` builds
 * the minimum from a model definition.
 *
 * `{}` is legal and degrades exactly one way: a string operand against a
 * numeric column answers `false` where the server would answer true. That is
 * the same degradation sierra has always had on a schema-registry miss, and it
 * is why a caller with a schema should pass one.
 */

import { DIRECTIVE_PARAMS } from '../directives/directives.js'

const _WIRE_OPS = {
  $in: 'in', $nin: 'notIn', $lt: 'lt', $lte: 'lte', $gt: 'gt', $gte: 'gte',
  $ne: 'not', $like: 'contains', $ilike: 'contains', $start: 'startsWith', $end: 'endsWith',
}

// The same operators under the names Litestone knows them by. An unprefixed
// operator block travels through `parseWhere` untouched (it only looks for a
// leading `$`), so both spellings reach `buildWhere` and both are legal here.
const _BARE_OPS = new Set([
  'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'not', 'equals',
  'contains', 'startsWith', 'endsWith',
  'has', 'hasEvery', 'hasSome', 'hasNone', 'isEmpty',
])

// Filters whose answer is not in the record, so a pushed row cannot be graded
// against them: `$search` is an FTS5 index, `$onlyDeleted`/`$onlyTemplates` are
// visibility flags the record does not carry a decidable answer for (the marker
// column can be renamed, and this side holds no schema), `$raw` is SQL.
const _OPAQUE = new Set(['$search', '$onlyDeleted', '$onlyTemplates', '$raw'])

// Not filters at all — `parseQuery` destructures these out before `parseWhere`
// sees the rest. They ride in `query` only on the pre-directives fallback path.
//
// Read off the wire's own table rather than restated, because a Data-realm
// feature that grows a per-call option is otherwise a filter on a column nobody
// declared here, three layers from the cause (FJS-306). Only the decidability
// question above is this module's to answer.
const _DIRECTIVES = new Set(DIRECTIVE_PARAMS.filter(p => !_OPAQUE.has(p)))

/** Three-valued AND — false wins over unknown, unknown wins over true. */
function _and(a, b) {
  if (a === false || b === false) return false
  if (a === null  || b === null)  return null
  return true
}

function _not(v) {
  return v === null ? null : !v
}

/**
 * A query operand as the column would hold it. The wire is strings — a query
 * built from a URL or a form control sends `'5'` for an Int — and SQLite's type
 * affinity converts on comparison, so `WHERE id = '5'` matches row 5 and a
 * client matcher comparing `5 === '5'` would not.
 */
function _operand(rule, v) {
  if (v instanceof Date) return v.toISOString()
  if (typeof v !== 'string' || v === '') return v
  if (rule?.type === 'integer') return /^[+-]?\d+$/.test(v.trim()) ? Number(v) : v
  if (rule?.type === 'number')  { const n = Number(v); return Number.isFinite(n) ? n : v }
  if (rule?.type === 'boolean') {
    if (v === 'true')  return true
    if (v === 'false') return false
  }
  return v
}

/** `IN (…)` for a scalar column, `hasSome` for an array one — as the bare-array shorthand compiles. */
function _inList(rule, actual, list) {
  if (!Array.isArray(list)) return null
  const wanted = list.map(v => _operand(rule, v))
  if (Array.isArray(actual)) return actual.some(v => wanted.includes(v))
  return wanted.includes(actual)
}

// LIKE is case-insensitive for ASCII in SQLite, which is what makes `$like` and
// `$ilike` compile to the same `contains` on the server.
const _like = (actual, operand, test) =>
  actual == null ? false : test(String(actual).toLowerCase(), String(operand).toLowerCase())

function _matchOp(rule, actual, op, operand) {
  switch (op) {
    case 'in':     return _inList(rule, actual, operand)
    // NOT IN excludes NULL rows in SQLite, so Litestone ORs `IS NULL` back in.
    case 'notIn':  return operand?.length ? _not(_inList(rule, actual, operand)) : true
    case 'gt':     return actual == null ? false : actual >  _operand(rule, operand)
    case 'gte':    return actual == null ? false : actual >= _operand(rule, operand)
    case 'lt':     return actual == null ? false : actual <  _operand(rule, operand)
    case 'lte':    return actual == null ? false : actual <= _operand(rule, operand)
    case 'contains':   return _like(actual, operand, (a, b) => a.includes(b))
    case 'startsWith': return _like(actual, operand, (a, b) => a.startsWith(b))
    case 'endsWith':   return _like(actual, operand, (a, b) => a.endsWith(b))
    case 'equals':
      if (operand === null) return actual == null
      if (Array.isArray(operand)) {
        // The exact set, in order — the one place an array is not a membership test.
        if (!Array.isArray(actual)) return null
        return actual.length === operand.length && actual.every((v, i) => v === operand[i])
      }
      return actual === _operand(rule, operand)
    case 'not':
      if (operand === null) return actual != null
      if (Array.isArray(operand)) return operand.length ? _not(_inList(rule, actual, operand)) : true
      // `col != ?` is NULL, not true, on a NULL column.
      return actual == null ? false : actual !== _operand(rule, operand)
    case 'has':      return Array.isArray(actual) ? actual.includes(operand) : null
    case 'hasEvery': return Array.isArray(actual) ? operand.every(v => actual.includes(v)) : null
    case 'hasSome':  return Array.isArray(actual) ? operand.some(v => actual.includes(v))  : null
    case 'hasNone':  return Array.isArray(actual) ? !operand.some(v => actual.includes(v)) : null
    case 'isEmpty':  return Array.isArray(actual) ? (operand ? actual.length === 0 : actual.length > 0) : null
    default:         return null
  }
}

function _matchField(rule, actual, expected) {
  if (expected === null) return actual == null
  if (expected instanceof Date) return actual === expected.toISOString()
  if (Array.isArray(expected)) {
    // A bare array is membership, never equality — Prisma reads it the other way
    // and a schema ported from there filters wider than it did.
    return expected.length ? _inList(rule, actual, expected) : false
  }
  if (typeof expected !== 'object') return actual === _operand(rule, expected)

  if ('$null' in expected) return expected.$null ? actual == null : actual != null

  const keys = Object.keys(expected)
  if (!keys.length) return true

  // Every key an operator, or none of them: the same disambiguation the server
  // makes (`isTypedJsonPath`). Anything else is a path into a JSON document or a
  // filter over a relation, neither of which this record can answer.
  if (!keys.every(k => k in _WIRE_OPS || _BARE_OPS.has(k))) return null

  let verdict = true
  for (const k of keys) {
    verdict = _and(verdict, _matchOp(rule, actual, _WIRE_OPS[k] ?? k, expected[k]))
    if (verdict === false) return false
  }
  return verdict
}

/**
 * Does this record satisfy that query?
 *
 * @param {Record<string, object>} fields  from buildFieldRules(); `{}` still
 *        matches structurally, it just cannot convert a string operand
 * @param {object} record
 * @param {object} query  filters as they travel over the wire
 * @returns {true|false|null}  in the results, not in them, or undecidable
 */
export function matchesQuery(fields, record, query) {
  if (!query || typeof query !== 'object') return true
  if (!record || typeof record !== 'object') return null

  let verdict = true

  for (const [key, val] of Object.entries(query)) {
    if (val === undefined || _DIRECTIVES.has(key)) continue

    let one
    if (_OPAQUE.has(key)) {
      one = null
    } else if (key === '$or') {
      one = Array.isArray(val) ? _some(fields, record, val) : null
    } else if (key === '$and') {
      one = Array.isArray(val) ? _every(fields, record, val) : null
    } else if (key === '$not') {
      one = _not(matchesQuery(fields, record, val))
    } else if (key.startsWith('$')) {
      one = null   // an operator the server may know and this does not
    } else if (!(key in record)) {
      // A `select` that dropped the filtered column, or a filter naming a
      // relation — the row is here, the answer is not.
      one = null
    } else {
      one = _matchField(fields?.[key], record[key], val)
    }

    verdict = _and(verdict, one)
    if (verdict === false) return false
  }

  return verdict
}

function _some(fields, record, list) {
  let verdict = false
  for (const q of list) {
    const one = matchesQuery(fields, record, q)
    if (one === true) return true
    if (one === null) verdict = null
  }
  return verdict
}

function _every(fields, record, list) {
  let verdict = true
  for (const q of list) {
    verdict = _and(verdict, matchesQuery(fields, record, q))
    if (verdict === false) return false
  }
  return verdict
}
