/**
 * router/match.js — URL pattern matching
 *
 * Matches a URL pathname against the route tree and returns
 * the matched node + extracted params.
 *
 * Matching priority (mirrors SvelteKit):
 *   1. Static segments beat dynamic
 *   2. Dynamic [param] beats catch-all [...rest]
 *   3. Ties broken alphabetically
 *
 * The tree is already sorted in this priority order by the scanner.
 */

/**
 * Match a pathname against the route tree.
 *
 * @param {string} pathname  — e.g. '/leads/abc123/'
 * @param {object} tree      — root node from config/routes.js
 * @param {object} options
 * @param {string} [options.trailingSlash='always']
 * @returns {{ node: object, params: Record<string, string> } | null}
 */
export function matchRoute(pathname, tree, options = {}) {
  const { trailingSlash = 'always' } = options

  // Normalize once, split once. Previously every node visited re-split the same
  // pathname inside matchPattern, so a 24-node tree meant 24 identical splits
  // and 24 throwaway arrays per match — and matchRoute is on the hot path for
  // both navigation and every prefetch.
  const normalized = normalizePath(pathname, trailingSlash)
  const pathParts = splitPath(normalized)

  return matchNode(normalized, pathParts, tree, {})
}

// ─── Pattern segment cache ───────────────────────────────────────────────────
// Route patterns are static for the life of the tree, so their split form and
// the lowercase of each static segment can be computed once. Keyed by node so
// nothing is written onto the tree itself (the route table is serialised, and
// tests build trees by hand).
const _segCache = new WeakMap()

function segmentsFor(node) {
  let segs = _segCache.get(node)
  if (segs) return segs
  segs = splitPath(node.path).map((part) => {
    if (part.startsWith(':')) return { dynamic: true, name: part.slice(1) }
    return { dynamic: false, lower: part.toLowerCase() }
  })
  _segCache.set(node, segs)
  return segs
}

/**
 * Recursively match a full pathname against a node and its children.
 * All pattern matching is against the FULL pathname — patterns are absolute.
 *
 * @param {string} pathname   — full normalized pathname, e.g. '/leads/create/'
 * @param {object} node
 * @param {Record<string, string>} inheritedParams
 */
function matchNode(pathname, pathParts, node, inheritedParams) {
  // Root node — check for root index or try children
  if (node.id === 'root') {
    if (pathname === '/' && node.file) {
      return { node, params: inheritedParams }
    }
    return matchChildren(pathname, pathParts, node, inheritedParams)
  }

  // Catch-all — matches everything
  if (node.path === '/*') {
    return {
      node,
      params: { ...inheritedParams, '404': pathname.slice(1).replace(/\/$/, '') },
    }
  }

  // Check if this node's pattern is a prefix of (or exact match for) the pathname
  const result = matchPattern(node, pathParts, inheritedParams)
  if (!result) return null

  if (result.exact) {
    // Exact match
    return { node, params: result.params }
  }

  if (result.prefix && node.children.length > 0) {
    // Prefix match — try children with the FULL pathname
    // Children have absolute patterns so we pass the full path
    return matchChildren(pathname, pathParts, node, result.params)
  }

  return null
}

/**
 * Try children of a node in priority order (already sorted by scanner).
 * Passes the FULL pathname — child patterns are absolute.
 */
function matchChildren(pathname, pathParts, parent, inheritedParams) {
  for (const child of parent.children) {
    const result = matchNode(pathname, pathParts, child, inheritedParams)
    if (result) return result
  }
  return null
}

/**
 * Match a node's pattern against an already-split pathname.
 *
 * Pattern:  '/leads/:leadId/'   (segments cached per node)
 * Pathname: ['leads', 'abc123'] (split once per matchRoute call)
 *
 * Returns:
 *   null                      — no match
 *   { exact: true, params }   — pattern consumed the whole pathname
 *   { prefix: true, params }  — pattern is a proper prefix (parent match)
 *
 * Params are only allocated once the pattern is known to match, so a failed
 * comparison against a deep static route costs no object churn — the previous
 * version spread inheritedParams into a fresh object before the first
 * comparison, on every node visited.
 *
 * @param {object} node
 * @param {string[]} pathParts
 * @param {Record<string, string>} inheritedParams
 */
function matchPattern(node, pathParts, inheritedParams) {
  const patternParts = segmentsFor(node)
  const plen = patternParts.length
  const ulen = pathParts.length

  if (ulen < plen) return null   // pathname shorter than pattern — no match

  let params = null

  for (let i = 0; i < plen; i++) {
    const seg = patternParts[i]
    const uPart = pathParts[i]

    if (seg.dynamic) {
      if (params === null) params = { ...inheritedParams }
      params[seg.name] = decodeURIComponent(uPart)
    } else if (seg.lower !== uPart.toLowerCase()) {
      return null   // static segment mismatch
    }
  }

  if (params === null) params = inheritedParams

  if (plen === ulen) return { exact: true, params }
  return { prefix: true, params }
}

/**
 * Split a path into non-empty segments, handling leading/trailing slashes.
 * '/' → []
 * '/leads/abc/' → ['leads', 'abc']
 */
function splitPath(path) {
  return path.split('/').filter(Boolean)
}

/**
 * Normalize a pathname according to the trailingSlash setting.
 */
export function normalizePath(pathname, trailingSlash = 'always') {
  // Fast path: already-normalized paths are the common case (both callers in
  // the router pre-normalize, and matchRoute normalizes again for safety), and
  // the two splits below allocate three strings and two arrays each time.
  if (
    trailingSlash === 'always' &&
    pathname.length > 1 &&
    pathname.charCodeAt(pathname.length - 1) === 47 /* '/' */ &&
    pathname.indexOf('?') === -1 &&
    pathname.indexOf('#') === -1
  ) return pathname

  // Always strip query string and hash
  const qi = pathname.indexOf('?')
  const hi = pathname.indexOf('#')
  const cut = qi === -1 ? hi : (hi === -1 ? qi : Math.min(qi, hi))
  const clean = cut === -1 ? pathname : pathname.slice(0, cut)

  if (clean === '/') return '/'

  switch (trailingSlash) {
    case 'always':
      return clean.endsWith('/') ? clean : clean + '/'
    case 'never':
      return clean.endsWith('/') ? clean.slice(0, -1) : clean
    case 'preserve':
    default:
      return clean
  }
}

/**
 * Build a URL from a path and query params.
 *
 * @param {string} path
 * @param {Record<string, unknown>} params
 * @param {string} trailingSlash
 */
export function buildUrl(path, params = {}, trailingSlash = 'always') {
  const normalized = normalizePath(path, trailingSlash)
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')

  if (entries.length === 0) return normalized

  const query = new URLSearchParams()
  for (const [key, value] of entries) {
    if (Array.isArray(value)) {
      for (const v of value) query.append(`${key}[]`, String(v))
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        query.set(`${key}[${k}]`, String(v))
      }
    } else {
      query.set(key, String(value))
    }
  }

  return normalized + '?' + query.toString()
}

/**
 * Parse and type-coerce query params from a URL search string.
 * '?page=1&active=true&ids[]=1&ids[]=2' → { page: 1, active: true, ids: [1, 2] }
 *
 * @param {string} search — e.g. '?page=1&active=true'
 * @returns {Record<string, unknown>}
 */
export function parseQueryParams(search) {
  if (!search || search === '?') return {}

  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const result = {}

  for (const [key, value] of params.entries()) {
    // Array notation: ids[]
    if (key.endsWith('[]')) {
      const k = key.slice(0, -2)
      if (!result[k]) result[k] = []
      result[k].push(coerce(value))
      continue
    }

    // Nested object notation: filter[min]
    const nested = key.match(/^(\w+)\[(\w+)\]$/)
    if (nested) {
      const [, obj, prop] = nested
      if (!result[obj] || typeof result[obj] !== 'object') result[obj] = {}
      result[obj][prop] = coerce(value)
      continue
    }

    result[key] = coerce(value)
  }

  return result
}

/**
 * Coerce a string value to its most natural type.
 */
function coerce(value) {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (value === '') return ''
  const num = Number(value)
  if (!isNaN(num) && value.trim() !== '') return num
  return value
}
