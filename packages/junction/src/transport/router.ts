// transport/router.ts
// Two-tier route cache — the core performance pattern from Total.js.
//
// Tier 1: Fixed URL map  { 'users' → route }          → O(1) lookup
// Tier 2: Dynamic list   [routes with params]         → linear scan of candidates only
//
// Routes are compiled once at startup. Nothing is created at request time.

import type {
  RouteDefinition,
  RouteSegment,
  HttpMethod,
  RouteHandler,
  MiddlewareFn
} from './types.ts'

// ─── Module-level constants ────────────────────────────────────────────────
// Compiled once, never recreated

const PARAM_PATTERN   = /^\{([^}]+)\}$/
const WILDCARD        = '*'
const METHODS_WITH_BODY: Record<string, 1> = {
  POST: 1, PUT: 1, PATCH: 1, DELETE: 1
}

// ─── Route cache structure ─────────────────────────────────────────────────

// Fixed routes and dynamic routes are kept in SEPARATE fields.
//
// They used to share one object, with dynamic routes under the key 'D' and
// fixed routes keyed by their normalised path. A route registered at '/D'
// normalises to exactly 'D', so it collided with the bucket: build() threw
// `methodCache.D.push is not a function`, and lookup() would have returned the
// bucket array as if it were a route. Two fields cannot collide.
type RouteCache = {
  fixed:   Record<string, RouteDefinition>
  dynamic: RouteDefinition[]
}

type MethodCache = Record<string, RouteCache>

export class Router {

  private _routes: RouteDefinition[]     = []
  private _cache: MethodCache            = {}
  private _built = false
  // Registration shapes seen so far → the path that claimed each. Keyed by
  // shape rather than by literal path, because `/a/{id}` and `/a/{name}` match
  // exactly the same requests and differ only in a name nothing outside the
  // handler reads.
  private _claimed = new Map<string, string>()

  // ─── Registration ───────────────────────────────────────────────────────

  add(
    method:     HttpMethod,
    path:       string,
    handler:    RouteHandler,
    middleware: MiddlewareFn[] = []
  ): this {

    if (this._built)
      throw new Error(`Cannot add route ${method} ${path} after router is built`)

    const segments  = parsePath(path)
    const dynamic   = segments.some(s => s.type !== 'static')
    const paramKeys = segments
      .filter((s): s is Extract<RouteSegment, { type: 'param' }> => s.type === 'param')
      .map(s => s.name)

    // A second registration of the same shape used to be accepted in silence,
    // and which copy survived depended on something the caller cannot see: a
    // FIXED path is overwritten in build(), so the LAST registration wins, while
    // a dynamic one is pushed onto a list lookup() scans in order, so the FIRST
    // wins and the later one is dead weight forever. Same mistake, opposite
    // outcome, decided by whether the path happens to contain a param.
    //
    // Configuring CORS twice is the case that surfaced it — `cors()` registers
    // `OPTIONS /*`, and `fli new`'s own scaffold called it by hand beside the
    // config entry that installs it at startup (FJS-225). Nothing said so; the
    // headers came out right and the route list quietly listed the path twice.
    const shape = routeShape(method, segments)
    const owner = this._claimed.get(shape)
    if (owner !== undefined) {
      throw new Error(
        `Route ${method} ${path} is already registered${owner === path ? '' : ` (as ${owner})`}. ` +
        `Two registrations of one path cannot both answer: one of them will never run, and which one ` +
        `depends on whether the path has a parameter. Register it once, or mount the second under its own path.`
      )
    }
    this._claimed.set(shape, path)

    this._routes.push({
      method,
      path,
      handler,
      segments,
      dynamic,
      paramKeys,
      middleware
    })

    return this
  }

  get(path: string, handler: RouteHandler, mw?: MiddlewareFn[])    { return this.add('GET',     path, handler, mw) }
  post(path: string, handler: RouteHandler, mw?: MiddlewareFn[])   { return this.add('POST',    path, handler, mw) }
  put(path: string, handler: RouteHandler, mw?: MiddlewareFn[])    { return this.add('PUT',     path, handler, mw) }
  patch(path: string, handler: RouteHandler, mw?: MiddlewareFn[])  { return this.add('PATCH',   path, handler, mw) }
  delete(path: string, handler: RouteHandler, mw?: MiddlewareFn[]) { return this.add('DELETE',  path, handler, mw) }
  options(path: string, handler: RouteHandler, mw?: MiddlewareFn[]){ return this.add('OPTIONS', path, handler, mw) }
  head(path: string, handler: RouteHandler, mw?: MiddlewareFn[])   { return this.add('HEAD',    path, handler, mw) }

  // ─── Build cache ──────────────────────────────────────────────────────
  // Called once at app startup. After this, no routes can be added.

  build(): void {

    if (this._built) return

    const cache: MethodCache = {}

    for (const route of this._routes) {

      if (!cache[route.method])
        cache[route.method] = { fixed: {}, dynamic: [] }

      const methodCache = cache[route.method]

      if (!route.dynamic) {
        // Fixed route — key is the path without leading slash
        methodCache.fixed[normalizeKey(route.path)] = route
      } else {
        methodCache.dynamic.push(route)
      }
    }

    this._cache = cache
    this._built = true

    // Free the registration array — no longer needed
    this._routes = []
  }

  // ─── Lookup ───────────────────────────────────────────────────────────
  // Called on every request. Must be fast.

  lookup(method: string, path: string): { route: RouteDefinition; params: Record<string, string> } | null {

    const methodCache = this._cache[method]
    if (!methodCache) return null

    const key = normalizeKey(path)

    // ── Tier 1: Fixed URL — O(1) ──────────────────────────────────────
    const fixed = methodCache.fixed[key]
    if (fixed) return { route: fixed, params: {} }

    // ── Tier 2: Dynamic routes — scan the dynamic list only ───────────
    const dynamic = methodCache.dynamic
    if (!dynamic.length) return null

    for (const route of dynamic) {
      const params = matchPathDirect(route.segments, path)
      if (params !== null)
        return { route, params }
    }

    return null
  }

  get hasBodyMethods() { return METHODS_WITH_BODY }

  get routeCount(): number {
    let count = 0
    for (const method in this._cache) {
      const mc = this._cache[method]
      count += Object.keys(mc.fixed).length + mc.dynamic.length
    }
    return count
  }

  get isBuilt(): boolean {
    return this._built
  }

  /**
   * Would a request for this path match SOMETHING?
   *
   * Note this is a matching question, not an existence one: a dynamic route
   * absorbs paths that were never registered. On a default app,
   * `hasRoute('GET', '/health')` is **true** because it matches `GET /{service}`.
   * If you mean "is this exact endpoint mounted", use hasExactRoute().
   */
  hasRoute(method: string, path: string): boolean {
    return this.lookup(method, path) !== null
  }

  /**
   * Is a route registered at EXACTLY this path?
   *
   * Compares the registered path literally, so a dynamic route cannot answer
   * for one that was never mounted. This exists because the startup banner
   * used hasRoute() to decide whether to advertise /health and /docs — and
   * `GET /{service}` matched both, so every app printed URLs that then 404'd.
   *
   * Works before and after build(); build() frees the registration array, so
   * afterwards this reads the fixed-route map. An exact literal path is never
   * dynamic, so the dynamic list is deliberately not consulted.
   */
  hasExactRoute(method: string, path: string): boolean {
    if (!this._built) {
      return this._routes.some(r => r.method === method && r.path === path)
    }
    const methodCache = this._cache[method]
    if (!methodCache) return false
    return methodCache.fixed[normalizeKey(path)] !== undefined
  }

  /**
   * Every path registered for a method, as written at registration time.
   *
   * Lets a caller ask "where did this actually get mounted" instead of
   * guessing a location and testing it — which is how the startup banner
   * stayed silent about a health endpoint mounted at a custom path.
   * Works before and after build().
   */
  routePaths(method: string): string[] {
    if (!this._built) {
      return this._routes.filter(r => r.method === method).map(r => r.path)
    }
    const methodCache = this._cache[method]
    if (!methodCache) return []

    return [
      ...Object.values(methodCache.fixed).map(r => r.path),
      ...methodCache.dynamic.map(r => r.path),
    ]
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// Exported so other transport modules (e.g. http.ts WS routing) can reuse
// the same segment parsing and matching without duplicating logic.
// These use the array-based matchRoute — acceptable for the WS upgrade path
// which is infrequent. HTTP request matching uses matchPathDirect instead.
export { parsePath as parsePathSegments, splitPath as splitPathSegments, matchRoute as matchRouteSegments }

// '/users/{id}/posts' → [static('users'), param('id'), static('posts')]
// Used only at startup — allocations here are irrelevant.
function parsePath(path: string): RouteSegment[] {
  const parts = splitPath(path)
  return parts.map(part => {
    const paramMatch = PARAM_PATTERN.exec(part)
    if (paramMatch) return { type: 'param', name: paramMatch[1] }
    if (part === WILDCARD) return { type: 'wildcard' }
    return { type: 'static', value: part }
  })
}

// '/users/123' → ['users', '123']
// Used at startup (parsePath) and for the WS upgrade export.
// The HTTP hot path uses matchPathDirect to avoid this allocation.
function splitPath(path: string): string[] {
  const p = path.startsWith('/') ? path.slice(1) : path
  const clean = p.endsWith('/') ? p.slice(0, -1) : p
  return clean ? clean.split('/') : []
}

// The identity of a registration, for the duplicate check. Param NAMES are
// erased because they do not participate in matching: `/a/{id}` and `/a/{name}`
// accept exactly the same requests.
//
// Each segment carries its TYPE rather than a placeholder string. `{}` is not a
// param (PARAM_PATTERN needs at least one character between the braces), so it
// is a legal static segment — and a placeholder spelt `{}` made `/a/{}` collide
// with `/a/{id}`. A type tag cannot be spelt by the value it tags.
function routeShape(method: string, segments: RouteSegment[]): string {
  const parts = segments.map(s =>
    s.type === 'static' ? 's:' + s.value : s.type === 'param' ? 'p:' : 'w:')
  return method + ' ' + parts.join('/')
}

// normalize for cache key — strip leading slash
function normalizeKey(path: string): string {
  const p = path.startsWith('/') ? path.slice(1) : path
  return p.endsWith('/') ? p.slice(0, -1) : p
}

// ─── Zero-allocation path matcher ─────────────────────────────────────────
// Replaces the splitPath(path) + matchRoute(segments, array) pair on the
// HTTP request hot path. Walks the raw path string with index arithmetic
// so no temporary array is allocated per request.
//
// Handles: static segments, {param} segments, wildcard (*),
// trailing slashes, percent-encoded characters, empty paths.
//
// Returns extracted params on match, null on no match.

export function matchPathDirect(
  segments: RouteSegment[],
  path:     string
): Record<string, string> | null {

  if (segments.length === 0) {
    // Route registered as '/' or '' — matches only the root
    return (path === '/' || path === '') ? {} : null
  }

  const params: Record<string, string> = {}

  // Start past the leading slash (or at 0 if there is none)
  let pos = path.charCodeAt(0) === 47 /* '/' */ ? 1 : 0

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]

    // Wildcard — consumes everything remaining, always a match
    if (seg.type === 'wildcard') return params

    // Find the end of the current path segment (next '/' or string end)
    let segEnd = pos
    while (segEnd < path.length && path.charCodeAt(segEnd) !== 47) segEnd++

    // Ran out of path but still have non-wildcard segments to satisfy
    if (pos > path.length) return null

    if (seg.type === 'static') {
      // Character-by-character comparison — no substring allocation
      const val = seg.value
      const len = val.length
      if (segEnd - pos !== len) return null
      for (let c = 0; c < len; c++) {
        if (path.charCodeAt(pos + c) !== val.charCodeAt(c)) return null
      }
    } else {
      // param — empty segment never satisfies a param
      if (pos === segEnd) return null
      // Only decode when a percent is present; malformed sequences ('%zz')
      // degrade to the raw text instead of throwing an uncaught 500.
      const raw = path.slice(pos, segEnd)
      if (raw.indexOf('%') !== -1) {
        try { params[seg.name] = decodeURIComponent(raw) } catch { params[seg.name] = raw }
      } else {
        params[seg.name] = raw
      }
    }

    // Advance past the segment and its separating slash
    pos = segEnd + 1
  }

  // All route segments consumed. Accept if the path is also fully consumed.
  // pos is now (last segEnd + 1).
  // - No trailing slash: pos === path.length + 1  (past the end)
  // - Trailing slash:    pos === path.length       (sitting on the trailing slash position)
  if (pos < path.length) return null
  if (pos === path.length && path.charCodeAt(path.length - 1) !== 47 /* '/' */) return null

  return params
}

// Array-based match — used for WS upgrade (exported) and tests.
// Delegates to matchPathDirect — previously this was a second, independent
// matcher with DIVERGENT wildcard semantics (it only honoured a wildcard in
// the last segment, while matchPathDirect matches at the first wildcard),
// so the same pattern could match differently depending on entry point.
// One matcher, one behaviour.
function matchRoute(
  segments: RouteSegment[],
  actual:   string[]
): Record<string, string> | null {
  return matchPathDirect(segments, '/' + actual.join('/'))
}
