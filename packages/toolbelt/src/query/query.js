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
 * **A quoted value is a literal string.** `?code="5"` is `'5'`. The one escape
 * in the design, for the case a caller means text and no model is there to say
 * so; it is what the encoder emits when a string would otherwise read back as
 * something else, which is what makes the two halves exact inverses.
 *
 * **Structure is brackets, never a sigil.** `?qty[gte]=10&id[in][]=1` is
 * `{ qty: { gte: 10 }, id: { in: [1] } }` — the operator vocabulary reaches the
 * wire at all, and it reads as itself in a URL. A repeated key is an array,
 * because that is what a multi-select form emits.
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

/**
 * Write `value` at `path` into `root`, growing containers as it goes.
 *
 * A segment that is `''` means *append to the array here*. A conflict between
 * two shapes for one key (`?a=1&a[b]=2`) is resolved by the LAST write, which
 * is the same rule a repeated scalar key follows.
 */
function assignPath(root, path, value) {
  if (path.some(seg => FORBIDDEN_KEYS.has(seg))) return

  let node = root

  for (let i = 0; i < path.length - 1; i++) {
    const seg  = path[i]
    const next = path[i + 1]
    const wantArray = next === ''

    if (seg === '') {
      // `a[][b]=1` — an array of objects. Append a container and descend.
      if (!Array.isArray(node)) return
      if (node.length >= LIMITS.items) return
      const child = wantArray ? [] : bag()
      node.push(child)
      node = child
      continue
    }

    const existing = node[seg]
    const ok = wantArray ? Array.isArray(existing) : (existing !== null && typeof existing === 'object')
    if (!ok) node[seg] = wantArray ? [] : bag()
    node = node[seg]
  }

  const last = path[path.length - 1]
  if (last === '') {
    if (!Array.isArray(node)) return
    if (node.length >= LIMITS.items) return
    node.push(value)
    return
  }

  // A repeated scalar key is an array — what a multi-select form emits. The
  // first repeat promotes; every one after appends.
  if (last in node) {
    const prev = node[last]
    if (Array.isArray(prev)) {
      if (prev.length < LIMITS.items) prev.push(value)
    } else {
      node[last] = [prev, value]
    }
    return
  }

  node[last] = value
}

/** Null-prototype bags are an implementation detail; callers get plain objects. */
function plain(node) {
  if (Array.isArray(node)) return node.map(plain)
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
    if (++seen > LIMITS.keys) break
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
  return out
}

function walk(out, prefix, value, depth) {
  if (value === undefined) return
  if (depth > LIMITS.depth) return

  if (Array.isArray(value)) {
    // `k[]=a&k[]=b`, which parses back as an array of one element too — where a
    // repeated bare key would read as a scalar the first time.
    for (const item of value.slice(0, LIMITS.items)) walk(out, `${prefix}[]`, item, depth + 1)
    return
  }

  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) { out.push([prefix, value.toISOString()]); return }
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k)) continue
      walk(out, `${prefix}[${k}]`, v, depth + 1)
    }
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
