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

  // Normalize the incoming pathname
  const normalized = normalizePath(pathname, trailingSlash)

  // Walk the tree depth-first
  return matchNode(normalized, tree, {})
}

/**
 * Recursively match a full pathname against a node and its children.
 * All pattern matching is against the FULL pathname — patterns are absolute.
 *
 * @param {string} pathname   — full normalized pathname, e.g. '/leads/create/'
 * @param {object} node
 * @param {Record<string, string>} inheritedParams
 */
function matchNode(pathname, node, inheritedParams) {
  // Root node — check for root index or try children
  if (node.id === 'root') {
    if (pathname === '/' && node.file) {
      return { node, params: inheritedParams }
    }
    return matchChildren(pathname, node, inheritedParams)
  }

  // Catch-all — matches everything
  if (node.path === '/*') {
    return {
      node,
      params: { ...inheritedParams, '404': pathname.slice(1).replace(/\/$/, '') },
    }
  }

  // Check if this node's pattern is a prefix of (or exact match for) the pathname
  const result = matchPattern(node.path, pathname, inheritedParams)
  if (!result) return null

  if (result.exact) {
    // Exact match
    return { node, params: result.params }
  }

  if (result.prefix && node.children.length > 0) {
    // Prefix match — try children with the FULL pathname
    // Children have absolute patterns so we pass the full path
    return matchChildren(pathname, node, result.params)
  }

  return null
}

/**
 * Try children of a node in priority order (already sorted by scanner).
 * Passes the FULL pathname — child patterns are absolute.
 */
function matchChildren(pathname, parent, inheritedParams) {
  for (const child of parent.children) {
    const result = matchNode(pathname, child, inheritedParams)
    if (result) return result
  }
  return null
}

/**
 * Match a route pattern against a full pathname.
 *
 * Pattern: '/leads/:leadId/'
 * Pathname: '/leads/abc123/'
 *
 * Returns:
 *   null                          — no match at all
 *   { exact: true, params }       — exact match
 *   { prefix: true, params }      — pattern is a prefix of pathname (parent match)
 *
 * @param {string} pattern
 * @param {string} pathname
 * @param {Record<string, string>} inheritedParams
 */
function matchPattern(pattern, pathname, inheritedParams) {
  const patternParts = splitPath(pattern)
  const pathParts = splitPath(pathname)

  const params = { ...inheritedParams }

  for (let i = 0; i < patternParts.length; i++) {
    const pPart = patternParts[i]
    const uPart = pathParts[i]

    if (uPart === undefined) {
      // Pathname is shorter than pattern — no match
      return null
    }

    if (pPart.startsWith(':')) {
      // Dynamic segment — capture value
      params[pPart.slice(1)] = decodeURIComponent(uPart)
    } else {
      // Static segment — must match exactly (case-insensitive)
      if (pPart.toLowerCase() !== uPart.toLowerCase()) return null
    }
  }

  if (patternParts.length === pathParts.length) {
    return { exact: true, params }
  }

  if (pathParts.length > patternParts.length) {
    // Pathname is longer — this is a parent/prefix match
    return { prefix: true, params }
  }

  return null
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
  // Always strip query string and hash
  const clean = pathname.split('?')[0].split('#')[0]

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
