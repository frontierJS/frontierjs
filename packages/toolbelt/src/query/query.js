/*
 * query.js — what a query string MEANS, one definition.
 *
 * A URL carries text and nothing else, so `?qty=5` is the string `"5"` and
 * something has to decide whether that is a number. Two boundaries decide it
 * and they disagreed: Sierra's router inferred (badly — `Number('007')` is 7,
 * so a SKU became a number), and Junction's bridge did not infer at all, so a
 * browser sending `{ live: true }` reached the Data boundary as `"true"` and
 * matched no rows, silently. `FJS-D125` is the ruling; this is its one
 * implementation.
 *
 *   Junction's bridge   — an HTTP query string / a WS frame → ctx.query
 *   Sierra's router     — a URL's search string             → page.query
 *   Junction's client   — filters → the query string it sends
 *
 * Sibling of `/directives`, which splits the `$` names off the same bag. The
 * two compose: parse types here, split there. A directive already reads both a
 * string and a typed value, so the order does not matter to it.
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 * **A string is a number only if it round-trips.** `String(Number(v)) === v`,
 * one test, no special cases — and every trap the obvious `parseFloat` version
 * carries falls out of it:
 *
 *   '007'              → stays a string   (String(7) is '7')
 *   '0x10'             → stays a string   (would have been 16)
 *   '+1'               → stays a string   (a phone number, not 1)
 *   '1e5'              → stays a string
 *   ' 12 '             → stays a string
 *   '1.50'             → stays a string   (money keeps its cents)
 *   '9007199254740993' → stays a string   (the round trip loses the last digit,
 *                                          which is how a snowflake id survives)
 *
 * `NaN` and `Infinity` round-trip and are still not what anyone typed into a
 * filter, so they are excluded by name.
 *
 * **`true`, `false` and `null` are themselves.** Unambiguous, and the two that
 * were not handled were each a silent empty list at the Data boundary.
 *
 * **`{}` and `[]` are themselves.** An empty operand has no bracket spelling,
 * and dropping it widened the filter: `tasks: { none: {} }` over HTTP answered
 * every row where the socket answered the unplaced ones (`FJS-2047`).
 *
 * **A quoted value is a literal string.** `?code="5"` is `'5'`. The one escape
 * in the design, for the case a caller means text and no model is there to say
 * so; it is what the encoder emits when a string would otherwise read back as
 * something else, which is what makes the two halves exact inverses.
 *
 * **Structure is brackets, never a sigil.** `?qty[gte]=10&id[in][]=1` is
 * `{ qty: { gte: 10 }, id: { in: [1] } }` — the operator vocabulary reaches the
 * wire at all, and it reads as itself in a URL. A repeated key is an array,
 * because that is what a multi-select form emits. An integer segment names an
 * array element — `OR[1][a]=x&OR[1][b]=y` is ONE branch with two keys, which
 * `OR[]` cannot say — so an object whose keys are all integers reads back as
 * an array.
 *
 * ── What this is NOT ──────────────────────────────────────────────────────
 *
 * It is not validation and it is not schema coercion. It answers *what did the
 * caller type*, with no model in the room — which is why it is here rather than
 * in either boundary. Where a model exists it has the last word and converts
 * both ways: `id String` filtered by `?id=5` reads 5 here and Litestone turns
 * it back into `'5'`. That is the stated gotcha, not a defect: only the schema
 * knows, and the alternative is this module guessing on the schema's behalf.
 */

/* ── Guards ────────────────────────────────────────────────────────────────
 *
 * A query string is caller-supplied and bracket notation is recursive, so the
 * limits are the feature. `__proto__` is the one that is not a size: assigning
 * it on a plain object walks up to Object.prototype and the pollution is
 * process-wide, which is why the accumulator below is null-prototype AND the
 * key is refused. Both, because a null-prototype object is copied into an
 * ordinary one by any caller that spreads it.
 */
export const LIMITS = Object.freeze({
  depth:  5,      // filter[a][b][c][d] — deeper is refused, not truncated
  keys:   1000,   // distinct parameters
  items:  1000,   // elements in one array
})

/**
 * Past a limit in EITHER direction. A filter cut short is a different filter:
 * `notIn` minus its last id answers a row it was written to exclude, and a
 * pair dropped off the end is a condition that never applies. So the limit
 * refuses, and `status` is what lets a transport answer 400 without importing
 * the framework.
 */
export class QueryLimitError extends RangeError {
  constructor(message) {
    super(message)
    this.name   = 'QueryLimitError'
    this.status = 400
  }
}

const tooMany = limit => new QueryLimitError(`query exceeds the ${limit} limit of ${LIMITS[limit]}`)

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/* ── Scalars ───────────────────────────────────────────────────────────── */

/**
 * Is this text a number that survives being one?
 *
 * The whole of the number rule. Exported because it is the line most likely to
 * be argued with, and an argument should be able to run it.
 *
 * @param {string} v
 * @returns {boolean}
 */
export function isNumericLiteral(v) {
  if (typeof v !== 'string' || v === '') return false
  const n = Number(v)
  return Number.isFinite(n) && String(n) === v
}

/**
 * One text value → what the caller meant.
 *
 * @param {unknown} v
 * @returns {unknown}
 */
export function parseValue(v) {
  if (typeof v !== 'string') return v

  // The escape, checked first: a quoted value says *this is text* and nothing
  // below gets to reinterpret it.
  if (v.length >= 2 && v.charCodeAt(0) === 34 && v.charCodeAt(v.length - 1) === 34) {
    return v.slice(1, -1)
  }

  if (v === 'true')  return true
  if (v === 'false') return false
  if (v === 'null')  return null
  // Empty containers have no bracket spelling: `k[]` is an append and `k[x]`
  // names a member. Fresh each read, so a caller mutating one shares nothing.
  if (v === '{}')    return {}
  if (v === '[]')    return []

  return isNumericLiteral(v) ? Number(v) : v
}

/* ── Keys ──────────────────────────────────────────────────────────────── */

/**
 * `filter[status][in][]` → `['filter', 'status', 'in', '']`.
 *
 * An empty last segment is the array marker. A key with no brackets is a
 * one-element path, so every caller below takes the same shape.
 *
 * @param {string} key
 * @returns {string[] | null}  null when the key is malformed or too deep
 */
function keyPath(key) {
  const open = key.indexOf('[')
  if (open === -1) return [key]

  const path = [key.slice(0, open)]
  let i = open

  while (i < key.length) {
    if (key[i] !== '[') return null            // trailing junk: a[b]c
    const close = key.indexOf(']', i)
    if (close === -1) return null              // unbalanced: a[b
    path.push(key.slice(i + 1, close))
    i = close + 1
    if (path.length > LIMITS.depth) return null
  }

  return path
}

/** A fresh accumulator with no prototype to pollute. */
const bag = () => Object.create(null)

/** `0`, `12` — a position. `01` and `-1` are not, so they stay keys. */
const isIndex = seg => /^(0|[1-9]\d*)$/.test(seg)

/**
 * The element at `seg` of `node`, when `node` is an array and `seg` names a
 * position in it; `-1` otherwise. Past the item limit is refused, because a
 * sparse write would otherwise size an array by what the caller typed.
 */
function indexIn(node, seg) {
  if (!Array.isArray(node) || !isIndex(seg)) return -1
  const at = Number(seg)
  if (at >= LIMITS.items) throw tooMany('items')
  return at
}

const isBag = v => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * Write `value` at `path` into `root`, growing containers as it goes.
 *
 * A segment that is `''` means *append to the array here*; one that is an
 * index names an element, which is the only spelling that can put two keys in
 * ONE element — `a[][x]=1&a[][y]=2` is two elements (`FJS-2628`). A conflict
 * between two shapes for one key (`?a=1&a[b]=2`) is resolved by the LAST
 * write, which is the same rule a repeated scalar key follows.
 */
function assignPath(root, path, value) {
  if (path.some(seg => FORBIDDEN_KEYS.has(seg))) return

  let node = root

  for (let i = 0; i < path.length - 1; i++) {
    const seg  = path[i]
    const next = path[i + 1]
    const wantArray = next === '' || isIndex(next)

    const at = indexIn(node, seg)
    if (at !== -1) {
      const ok = wantArray ? Array.isArray(node[at]) : isBag(node[at])
      if (!ok) node[at] = wantArray ? [] : bag()
      node = node[at]
      continue
    }

    if (seg === '') {
      // `a[][b]=1` — an array of objects. Append a container and descend.
      if (!Array.isArray(node)) return
      if (node.length >= LIMITS.items) throw tooMany('items')
      const child = wantArray ? [] : bag()
      node.push(child)
      node = child
      continue
    }

    const existing = node[seg]
    // A named key never descends into an array: `last in node` and `node[seg]`
    // would read `length` or `map` off Array.prototype and throw (FJS-2186).
    const ok = wantArray ? Array.isArray(existing) : isBag(existing)
    if (!ok) node[seg] = wantArray ? [] : bag()
    node = node[seg]
  }

  const last = path[path.length - 1]
  const at = indexIn(node, last)
  if (at !== -1) { node[at] = value; return }

  if (last === '') {
    if (!Array.isArray(node)) return
    if (node.length >= LIMITS.items) throw tooMany('items')
    node.push(value)
    return
  }

  // A repeated scalar key is an array — what a multi-select form emits. The
  // first repeat promotes; every one after appends.
  if (last in node) {
    const prev = node[last]
    if (Array.isArray(prev)) {
      if (prev.length >= LIMITS.items) throw tooMany('items')
      prev.push(value)
    } else {
      node[last] = [prev, value]
    }
    return
  }

  node[last] = value
}

/**
 * Null-prototype bags are an implementation detail; callers get plain objects.
 * A gap an index left (`a[3][b]=1` alone) closes up, since a hole reaches a
 * filter as an `undefined` operand.
 */
function plain(node) {
  if (Array.isArray(node)) return node.filter(() => true).map(plain)
  if (node === null || typeof node !== 'object') return node
  const out = {}
  for (const k in node) out[k] = plain(node[k])
  return out
}

/* ── Parse ─────────────────────────────────────────────────────────────── */

/**
 * A bag of raw `key → text` pairs → the structured, typed query.
 *
 * For a caller that already has the pairs (a WS frame, a test, a transport that
 * parsed the string itself). `parseQueryString` is the same thing off a URL.
 *
 * @param {Record<string, unknown> | Iterable<[string, unknown]>} params
 * @returns {Record<string, unknown>}
 */
export function parseParams(params) {
  const root = bag()
  if (!params) return {}

  const entries = typeof params[Symbol.iterator] === 'function'
    ? params
    : Object.entries(params)

  let seen = 0
  for (const [key, value] of entries) {
    if (++seen > LIMITS.keys) throw tooMany('keys')
    const path = keyPath(String(key))
    // A malformed or too-deep key is kept whole rather than dropped: it is a
    // filter on a column nobody declared, which the Data boundary already
    // reports by name — where a silent drop is a filter that did not apply.
    if (!path) { root[String(key)] = parseValue(value); continue }
    assignPath(root, path, parseValue(value))
  }

  return plain(root)
}

/**
 * A URL's search string → the structured, typed query.
 *
 * Takes it with or without the leading `?`.
 *
 * @param {string} search
 * @returns {Record<string, unknown>}
 */
export function parseQueryString(search) {
  if (!search || search === '?') return {}
  const qs = search.charCodeAt(0) === 63 ? search.slice(1) : search

  const pairs = []
  for (const part of qs.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    // A bare key is the empty string, which is query-string semantics and NOT
    // the same as absent — `?q=` is an empty filter somebody typed.
    pairs.push(eq === -1
      ? [decodePart(part), '']
      : [decodePart(part.slice(0, eq)), decodePart(part.slice(eq + 1))])
  }

  return parseParams(pairs)
}

/** `+` is a space in a query string and nowhere else; a bad %-sequence stays raw. */
function decodePart(s) {
  const plus = s.indexOf('+') === -1 ? s : s.replace(/\+/g, ' ')
  try { return decodeURIComponent(plus) } catch { return plus }
}

/* ── Encode ────────────────────────────────────────────────────────────── */

/**
 * Does this string need quoting to survive the round trip?
 *
 * The encoder's only judgement, and it is derived rather than listed: anything
 * `parseValue` would not hand back unchanged.
 */
function needsQuoting(s) {
  return parseValue(s) !== s
}

/**
 * The structured query → flat `key → text` PAIRS.
 *
 * The exact inverse of `parseParams`: `parseParams(encodePairs(q))` is `q`, for
 * every value this module can carry. A list of pairs rather than an object,
 * because an object cannot hold `k[]=1&k[]=2` — the second write lands on the
 * same key and the array arrives with one element, which is the shape this
 * exists to carry. `parseParams` takes either.
 *
 * `undefined` is dropped, because absent and *asked for nothing* are the same
 * on a wire with no way to write one; `null` is NOT — *where the column is
 * null* is a filter, and dropping it was a call that answered every row
 * instead of the null ones.
 *
 * @param {Record<string, unknown>} query
 * @returns {Array<[string, string]>}
 */
export function encodePairs(query) {
  const out = []
  if (!query || typeof query !== 'object') return out
  for (const [key, value] of Object.entries(query)) walk(out, key, value, 1)
  if (out.length > LIMITS.keys) throw tooMany('keys')
  return out
}

function walk(out, prefix, value, depth) {
  if (value === undefined) return
  if (depth > LIMITS.depth) throw tooMany('depth')

  if (Array.isArray(value)) {
    if (!value.length) { out.push([prefix, '[]']); return }
    if (value.length > LIMITS.items) throw tooMany('items')
    // `k[]=a&k[]=b`, which parses back as an array of one element too — where a
    // repeated bare key would read as a scalar the first time. A container
    // names its index: under `k[]` every pair it writes appends a new element,
    // so one OR branch with two keys read back as two branches (`FJS-2628`).
    value.forEach((item, i) => {
      const container = item !== null && typeof item === 'object' && !(item instanceof Date)
      walk(out, container ? `${prefix}[${i}]` : `${prefix}[]`, item, depth + 1)
    })
    return
  }

  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) { out.push([prefix, value.toISOString()]); return }
    const before = out.length
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) continue
      walk(out, `${prefix}[${k}]`, v, depth + 1)
    }
    if (out.length === before) out.push([prefix, '{}'])
    return
  }

  out.push([prefix, encodeScalar(value)])
}

function encodeScalar(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return needsQuoting(value) ? `"${value}"` : value
  return String(value)
}

/**
 * The structured query → a search string, `?` included, or `''` for an empty one.
 *
 * `$` is left as itself: it is a legal sub-delim, every server decodes `%24` to
 * it anyway, and the `$` names are a documented part of the URL syntax here.
 *
 * @param {Record<string, unknown>} query
 * @returns {string}
 */
export function encodeQueryString(query) {
  const pairs = encodePairs(query)
  if (!pairs.length) return ''
  const qs = pairs
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&')
    .replace(/%24/g, '$')
    .replace(/%5B/g, '[')
    .replace(/%5D/g, ']')
  return `?${qs}`
}

/* ── Ordering ──────────────────────────────────────────────────────────────
 *
 * What a `$orderBy` / `$select` directive's VALUE means. `/directives` says
 * which `$` names exist and reads them off a wire; it leaves the SHAPE of
 * these two open because only a query builder can say which spelling it takes.
 * This is that answer, here because it is asked from opposite ends of the wire:
 *
 *   normalizeOrderBy  the three spellings a caller may write → one list. The
 *                     server compiles the result into SQL.
 *   normalizeSelect   a comma-joined string or a list of names → the map a
 *                     query builder takes.
 *   comparatorFor     that same list → a comparator over records, for a side
 *                     that has to place a row in a list it cannot re-query: the
 *                     browser client's live list and `<Table>`'s own sort.
 *
 * A caller that spells one of these itself is a second answer to a settled
 * question, and it fails where nothing is watching: Sierra's offline read
 * handed SQLite the wire's own `-id` and every read of a sorted list threw
 * (`FJS-1179`).
 *
 * **The comparator is an approximation of SQLite's ORDER BY, and where it
 * cannot be exact it is stated rather than assumed.** It agrees on the things
 * that decide a list's order in practice: NULLs first ascending (SQLite's
 * default, which negating gives NULLs last descending), numbers before text,
 * booleans as the 0/1 they are stored as, and ISO-8601 DateTime text comparing
 * as text. A column's `@collate` is reproduced only when the caller passes it
 * (`collations`, read off `x-collate`); without it the column is BINARY.
 * JavaScript orders strings by UTF-16 code unit where SQLite orders by byte;
 * the two agree on ASCII and can differ past it. A list whose order matters
 * that much re-reads.
 */

/**
 * The three spellings → `[{ field: 'asc' | 'desc' }]`.
 *
 *   'name'                    ascending
 *   '-createdAt'              descending
 *   'status,-createdAt'       several, in order
 *   { createdAt: 'desc' }     object form; 1 / -1 also accepted
 *   [{ a: 'asc' }, { b: … }]  already normalized
 *
 * **A STRUCTURED value is not one of the three and travels untouched.** The
 * Data boundary takes orderings whose value is an object rather than a
 * direction -- a relation hop (`{ author: { name: 'asc' } }`), a nulls
 * placement (`{ deletedAt: { dir: 'asc', nulls: 'last' } }`) and a distance
 * (`{ site: { near: { lat, lng } } }`) -- and reading one as *not ascending*
 * flattened a hop onto the relation, inverted a nulls placement and refused a
 * distance order as a sort of the JSON document.
 *
 * @param {string | Record<string, unknown> | Record<string, unknown>[]} sort
 * @returns {Record<string, unknown>[]}
 */
export function normalizeOrderBy(sort) {
  if (typeof sort === 'string') {
    return sort.split(',').map((field) => {
      const f = field.trim()
      if (f.startsWith('-')) return { [f.slice(1)]: 'desc' }
      return { [f]: 'asc' }
    })
  }
  if (Array.isArray(sort)) return sort
  return Object.entries(sort).map(([field, dir]) => ({
    [field]: isDirection(dir) ? directionOf(field, dir) : dir,
  }))
}

/** A direction is a word or a sign. Anything structured is an ARGUMENT. */
function isDirection(v) {
  return v === null || (typeof v !== 'object' && typeof v !== 'function')
}

/**
 * A scalar direction is asc, desc, 1 or -1 (words in either case) and nothing
 * else. A two-way ternary read `sideways`, `null` and `''` as descending, so a
 * typo sorted the opposite way and answered 200.
 */
function directionOf(field, dir) {
  const word = typeof dir === 'string' ? dir.toLowerCase() : dir
  if (word === 1 || word === 'asc') return 'asc'
  if (word === -1 || word === 'desc') return 'desc'
  throw Object.assign(
    new RangeError(`$orderBy direction for '${field}' must be asc, desc, 1 or -1, got: ${dir}`),
    { status: 400 },
  )
}

/**
 * `'id,name'` or `['id', 'name']` → `{ id: true, name: true }`.
 *
 * The map is what every query builder here takes, and the string is what a URL
 * carries, so the two spellings meet exactly once.
 *
 * @param {string | string[]} select
 * @returns {Record<string, boolean>}
 */
export function normalizeSelect(select) {
  const fields = Array.isArray(select) ? select : String(select).split(',')
  const out = {}
  for (const f of fields) {
    const name = f.trim()
    if (name) out[name] = true
  }
  return out
}

const foldAscii = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))

// SQLite's storage-class order: NULL < INTEGER/REAL < TEXT < BLOB. A Boolean is
// stored as 0/1 and therefore sorts as a number; a DateTime is ISO-8601 TEXT.
function rank(v) {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number' || typeof v === 'boolean') return 1
  if (typeof v === 'string') return 2
  return 3
}

/**
 * One value against another, as the column holding them would be ordered.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {string} [collation]  `nocase` or `rtrim` for a text pair; anything else is BINARY
 * @returns {number}
 */
export function compareValues(a, b, collation) {
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  if (ra === 0) return 0

  if (ra === 1) {
    const na = typeof a === 'boolean' ? (a ? 1 : 0) : a
    const nb = typeof b === 'boolean' ? (b ? 1 : 0) : b
    return na < nb ? -1 : na > nb ? 1 : 0
  }

  if (ra === 2) {
    // SQLite's NOCASE folds ASCII only and RTRIM drops trailing spaces only.
    if (collation === 'nocase') { a = foldAscii(a); b = foldAscii(b) }
    else if (collation === 'rtrim') { a = a.replace(/ +$/, ''); b = b.replace(/ +$/, '') }
    return a < b ? -1 : a > b ? 1 : 0
  }

  // A Json, an array or a File column cannot be ordered by at all -- the server
  // refuses it by name (`opaque`), so a load naming one never returned rows for
  // this to place. Answering "equal" keeps the comparator total without
  // inventing an order for values that have none.
  return 0
}

/**
 * A comparator over records for an `orderBy`, or `null` when there is nothing
 * to order by -- which the caller must treat as *leave the list alone*, not as
 * *sort by nothing*.
 *
 * @param {string | Record<string, unknown> | Record<string, unknown>[] | null | undefined} sort
 * @param {Record<string, string>} [collations]  column → its `@collate` (`x-collate`); an unnamed column is BINARY
 * @returns {((a: Record<string, unknown>, b: Record<string, unknown>) => number) | null}
 */
export function comparatorFor(sort, collations) {
  if (sort == null) return null
  // A structured value is an ordering this side cannot reproduce: a relation
  // hop reads a column that is not on the record, a nulls placement is about
  // rows this comparator never sees, and a distance needs a center and the geo
  // kit. Skipped rather than read as a direction -- placing a row by the TEXT
  // of a JSON document is a wrong position asserted confidently, where dropping
  // the key leaves the rest of the ordering doing its job.
  const keys = normalizeOrderBy(sort)
    .map((entry) => {
      const field = Object.keys(entry)[0]
      if (!field) return null
      const dir = entry[field]
      if (dir !== null && typeof dir === 'object') return null
      return { field, desc: dir === 'desc' }
    })
    .filter((k) => k !== null)

  if (!keys.length) return null

  return (a, b) => {
    for (const { field, desc } of keys) {
      const c = compareValues(a?.[field], b?.[field], collations?.[field])
      if (c !== 0) return desc ? -c : c
    }
    return 0
  }
}
