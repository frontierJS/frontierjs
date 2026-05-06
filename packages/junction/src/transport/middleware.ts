// transport/middleware.ts
// Common HTTP middleware plugins.
// Each follows the Plugin interface — register() adds routes/middleware.
// All are thin wrappers that return PluginFn | Plugin.
//
// Header injection pattern:
//   Middleware cannot modify the Response directly because it's built
//   inside next(). Instead, middleware deposits headers on well-known
//   ctx side-channel properties (__cors, __securityHeaders, __rateLimit).
//   HttpTransport._injectCtxHeaders() reads these after the handler returns
//   and merges them into the final response before it leaves the server.

import type { MiddlewareFn, TransportContext } from './types.ts'
import type { App }                            from '../core/app.ts'

// ─── Shared origin type ───────────────────────────────────────────────────
// cors() and csrf() both accept the same origin specification.
// Define it once here.

/** Allowed origins — string array, wildcard '*', or a custom predicate. */
export type OriginList = string[] | '*' | ((origin: string) => boolean)

// ─── combineOrigins ────────────────────────────────────────────────────────
// Returns a `{ origins }` object that can be spread into both cors() and
// csrf() options. Avoids repeating the origins list and keeps the two
// middleware in sync when it changes.
//
// Usage:
//   const shared = combineOrigins(['https://myapp.com', 'https://admin.myapp.com'])
//   app.configure(cors({ ...shared, credentials: true }))
//   app.configure(csrf({ ...shared }))
//
//   // Function predicate works too:
//   const shared = combineOrigins(o => o.endsWith('.myapp.com'))
//   app.configure(cors(shared))
//   app.configure(csrf(shared))
//
// Note: cors() accepts '*' but csrf() does not (it would defeat the purpose).
// If you pass '*', it is forwarded as-is to cors() and converted to `() => true`
// for csrf() so the spread still type-checks.

export interface CombinedOrigins {
  origins: OriginList                                  // for cors()
  csrfOrigins: string[] | ((o: string) => boolean)    // for csrf() — no '*'
}

export function combineOrigins(origins: OriginList): {
  /** Spread into cors() options. */
  origins: OriginList
  /** Spread as `origins` into csrf() options — '*' converted to allow-all. */
  csrfOrigins: string[] | ((o: string) => boolean)
  /** Convenience: both keys ready to spread. Usage: app.configure(csrf(combineOrigins(list).forCsrf())) */
  forCors(): Pick<CorsOptions,  'origins'>
  forCsrf(): Pick<CsrfOptions,  'origins'>
} {
  const csrfOrigins: string[] | ((o: string) => boolean) =
    origins === '*' ? () => true : origins as string[] | ((o: string) => boolean)

  return {
    origins,
    csrfOrigins,
    forCors: () => ({ origins }),
    forCsrf: () => ({ origins: csrfOrigins }),
  }
}

// ─── CORS ─────────────────────────────────────────────────────────────────

export interface CorsOptions {
  origins:      OriginList
  methods?:     string[]
  headers?:     string[]
  credentials?: boolean
  maxAge?:      number      // seconds
}

export function cors(opts: CorsOptions) {

  const {
    origins,
    methods    = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    headers    = ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials = false,
    maxAge      = 86400
  } = opts

  const methodStr  = methods.join(', ')
  const headerStr  = headers.join(', ')

  function isAllowed(origin: string): boolean {
    if (origins === '*') return true
    if (Array.isArray(origins)) return origins.includes('*') || origins.includes(origin)
    return origins(origin)
  }

  const middleware: MiddlewareFn = async (ctx, next) => {
    const origin = ctx.headers['origin'] ?? ''

    if (isAllowed(origin)) {
      ;(ctx as Record<string, unknown>).__cors = {
        'access-control-allow-origin':      origin || '*',
        'access-control-allow-methods':     methodStr,
        'access-control-allow-headers':     headerStr,
        'access-control-max-age':           String(maxAge),
        ...(credentials ? { 'access-control-allow-credentials': 'true' } : {})
      }
    }

    // Always call next — OPTIONS handler responds with the __cors headers
    // that we just set above. Non-OPTIONS routes pick them up in _finalizeWithHeaders.
    await next()
  }

  return function corsPlugin(app: App): void {
    // Patch FIRST so the OPTIONS handler below gets the cors middleware attached.
    patchRouterWithMiddleware(app, middleware)

    // Wildcard OPTIONS handler — handles all preflight requests.
    // By this point the cors middleware is already patched in, so __cors
    // will be populated when this handler runs.
    app.http.router.options('/*', async (ctx) => {
      const corsHeaders = (ctx as Record<string, unknown>).__cors as Record<string, string> ?? {}
      return new Response(null, { status: 204, headers: corsHeaders })
    })
  }
}

function patchRouterWithMiddleware(app: App, mw: MiddlewareFn): void {
  const router   = app.http.router
  const methods  = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const

  for (const method of methods) {
    const original = router[method].bind(router) as Function
    ;(router as Record<string, Function>)[method] = (
      path:    string,
      handler: Function,
      existing?: MiddlewareFn[]
    ) => {
      return original(path, handler, [mw, ...(existing ?? [])])
    }
  }
}

// ─── Helmet (security headers) ────────────────────────────────────────────

export interface HelmetOptions {
  xss?:          boolean   // X-XSS-Protection
  noSniff?:      boolean   // X-Content-Type-Options
  frame?:        'deny' | 'sameorigin' | false   // X-Frame-Options
  hsts?:         boolean | { maxAge: number; includeSubDomains?: boolean }
  referrer?:     string    // Referrer-Policy
  csp?:          string    // Content-Security-Policy
  poweredBy?:    false     // remove X-Powered-By
}

export function helmet(opts: HelmetOptions = {}) {

  const {
    xss     = true,
    noSniff = true,
    frame   = 'deny',
    hsts    = false,
    referrer = 'no-referrer',
    csp,
    poweredBy,
  } = opts

  const securityHeaders: Record<string, string> = {}

  if (xss)     securityHeaders['x-xss-protection']        = '1; mode=block'
  if (noSniff) securityHeaders['x-content-type-options']  = 'nosniff'
  if (frame)   securityHeaders['x-frame-options']         = frame.toUpperCase()
  if (referrer) securityHeaders['referrer-policy']        = referrer
  if (csp)     securityHeaders['content-security-policy'] = csp
  if (poweredBy === false) securityHeaders['x-powered-by'] = ''

  if (hsts) {
    const maxAge = typeof hsts === 'object' ? hsts.maxAge : 31536000
    const incl   = typeof hsts === 'object' && hsts.includeSubDomains ? '; includeSubDomains' : ''
    securityHeaders['strict-transport-security'] = `max-age=${maxAge}${incl}`
  }

  const middleware: MiddlewareFn = async (ctx, next) => {
    await next()
    // Headers injected via __securityHeaders on ctx
    ;(ctx as Record<string, unknown>).__securityHeaders = securityHeaders
  }

  return function helmetPlugin(app: App): void {
    patchRouterWithMiddleware(app, middleware)
  }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────

export interface RateLimitOptions {
  limit:         number      // requests per window
  window:        number      // ms
  keyFn?:        (ctx: TransportContext) => string   // default: IP
  message?:      string
  skipFn?:       (ctx: TransportContext) => boolean  // skip for certain requests
}

export function rateLimit(opts: RateLimitOptions) {

  const {
    limit,
    window:  windowMs,
    keyFn    = (ctx) => ctx.ip,
    message  = 'Too Many Requests',
    skipFn,
  } = opts

  // Per-key counters: key → { count, reset }
  const counters = new Map<string, { count: number; reset: number }>()

  // GC timer
  const gc = setInterval(() => {
    const now = Date.now()
    for (const [key, rec] of counters) {
      if (rec.reset < now) counters.delete(key)
    }
  }, windowMs)
  if (gc.unref) gc.unref()

  const middleware: MiddlewareFn = async (ctx, next) => {
    if (skipFn?.(ctx)) { await next(); return }

    const key = keyFn(ctx)
    const now = Date.now()
    let rec   = counters.get(key)

    if (!rec || rec.reset < now) {
      rec = { count: 0, reset: now + windowMs }
      counters.set(key, rec)
    }

    rec.count++

    if (rec.count > limit) {
      const retryAfter = Math.ceil((rec.reset - now) / 1000)
      throw Object.assign(new Error(message), {
        code:          429,
        name:          'TooManyRequests',
        retryAfter,
      })
    }

    // Expose headers for client
    ;(ctx as Record<string, unknown>).__rateLimit = {
      'x-ratelimit-limit':     String(limit),
      'x-ratelimit-remaining': String(Math.max(0, limit - rec.count)),
      'x-ratelimit-reset':     String(Math.ceil(rec.reset / 1000)),
    }

    await next()
  }

  return function rateLimitPlugin(app: App): void {
    patchRouterWithMiddleware(app, middleware)
  }
}

// ─── Request logger ───────────────────────────────────────────────────────

export interface RequestLoggerOptions {
  level?:  'info' | 'debug'
  format?: 'common' | 'json'
  skip?:   (ctx: TransportContext) => boolean
}

export function requestLogger(opts: RequestLoggerOptions = {}) {

  const {
    level  = 'info',
    format = 'common',
    skip,
  } = opts

  const middleware: MiddlewareFn = async (ctx, next) => {
    if (skip?.(ctx)) { await next(); return }

    const start = Date.now()

    try {
      await next()
    } finally {
      const ms     = Date.now() - start
      const status = ((ctx as Record<string, unknown>).__status as number) ?? 200

      if (format === 'json') {
        console[level](JSON.stringify({
          method: ctx.method,
          path:   ctx.path,
          status,
          ms,
          ip:     ctx.ip,
          time:   new Date().toISOString()
        }))
      } else {
        console[level](
          `${ctx.method} ${ctx.path} ${status} ${ms}ms - ${ctx.ip}`
        )
      }
    }
  }

  return function requestLoggerPlugin(app: App): void {
    patchRouterWithMiddleware(app, middleware)
  }
}

// ─── Body size limiter ────────────────────────────────────────────────────

export function bodyLimit(maxBytes: number) {
  const middleware: MiddlewareFn = async (ctx, next) => {
    const contentLength = parseInt(ctx.headers['content-length'] ?? '0', 10)
    if (contentLength > maxBytes)
      throw Object.assign(new Error('Payload Too Large'), { code: 413, name: 'PayloadTooLarge' })
    await next()
  }

  return function bodyLimitPlugin(app: App): void {
    patchRouterWithMiddleware(app, middleware)
  }
}

// ─── Correlation ID ───────────────────────────────────────────────────────
// Reads X-Request-ID from incoming request headers, or generates a new UUID.
// Stamps the id on ctx as ctx.requestId so handlers and services can log it.
// Always echoes the id back in the response as X-Request-ID.
//
// Usage:
//   app.configure(correlationId())
//   app.configure(correlationId({ header: 'X-Trace-ID', generator: () => myId() }))
//
// In a handler:
//   app.get('/orders', (ctx) => {
//     logger.info('request', { id: ctx.requestId })
//     return ctx.json(...)
//   })

export interface CorrelationIdOptions {
  // Header name to read from / write to. Default: 'x-request-id'
  header?:    string
  // Custom id generator. Default: crypto.randomUUID()
  generator?: () => string
}

export function correlationId(opts: CorrelationIdOptions = {}) {

  const header    = (opts.header ?? 'x-request-id').toLowerCase()
  const generate  = opts.generator ?? (() => crypto.randomUUID())

  const middleware: MiddlewareFn = async (ctx, next) => {
    // Use existing id from client, or mint a new one
    const id = ctx.headers[header] ?? generate()

    // Stamp on ctx so handlers can reach it without parsing headers again
    ;(ctx as Record<string, unknown>).requestId = id

    await next()

    // Echo back in the response — _injectCtxHeaders picks this up
    const existing = (ctx as Record<string, unknown>).__correlationHeaders as Record<string, string> | undefined
    ;(ctx as Record<string, unknown>).__correlationHeaders = { ...existing, [header]: id }
  }

  return function correlationIdPlugin(app: App): void {
    patchRouterWithMiddleware(app, middleware)
  }
}

// ─── CSRF ─────────────────────────────────────────────────────────────────
// Origin-checking CSRF protection for cookie-session APIs.
//
// The bearer-token pattern (Authorization: Bearer ...) used by Junction
// is inherently CSRF-safe — a cross-origin page cannot set arbitrary request
// headers. This middleware is only needed when your auth provider (e.g.
// Better Auth) is configured to use cookie-based sessions, because browsers
// attach cookies automatically to cross-origin requests.
//
// Strategy: for every state-mutating request (POST/PUT/PATCH/DELETE), check
// the Origin header (set by browsers on all cross-origin requests). If absent
// — same-origin requests from some browsers don't send it — fall back to
// the Referer header. If neither is present and allowMissingOrigin is false
// (the default), the request is rejected.
//
// This is sometimes called the "origin header check" or "same-site cookie
// check" pattern. It's simpler than synchronizer tokens and sufficient for
// API endpoints that don't serve HTML.
//
// Usage:
//   app.configure(csrf({ origins: ['https://myapp.com'] }))
//   app.configure(csrf({ origins: ['https://myapp.com', 'https://admin.myapp.com'] }))
//   app.configure(csrf({ origins: (o) => o.endsWith('.myapp.com') }))
//
// Relationship to cors():
//   csrf() and cors() both check origins, but they serve different purposes.
//   cors() controls which origins the browser exposes the response to.
//   csrf() controls which origins are allowed to trigger server-side mutations.
//   Run both together — cors() first:
//     app.configure(cors({ origins: ['https://myapp.com'] }))
//     app.configure(csrf({ origins: ['https://myapp.com'] }))

import { Forbidden } from '../core/errors.ts'

export interface CsrfOptions {
  // Which origins are allowed to make mutating requests.
  // Same format as cors() origins, but '*' is not accepted (it would
  // defeat the purpose). Use combineOrigins() to share a list with cors().
  origins: string[] | ((origin: string) => boolean)

  // Methods considered state-mutating. Default: POST, PUT, PATCH, DELETE.
  methods?: string[]

  // If true, requests with no Origin AND no Referer header are allowed through.
  // Useful for server-to-server calls or curl during development.
  // Default: false — missing origin is rejected.
  allowMissingOrigin?: boolean

  // Custom rejection handler. Default: throws Forbidden.
  onRejected?: (ctx: TransportContext, reason: string) => void | Promise<void>
}

export function csrf(opts: CsrfOptions) {

  const mutateMethods = new Set(
    (opts.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE']).map(m => m.toUpperCase())
  )

  function isAllowed(origin: string): boolean {
    if (Array.isArray(opts.origins)) {
      return opts.origins.includes(origin) || opts.origins.includes('*')
    }
    return opts.origins(origin)
  }

  // Extract the scheme+host from a full URL string.
  // 'https://myapp.com/some/path' → 'https://myapp.com'
  function originFromUrl(url: string): string | null {
    try {
      const u = new URL(url)
      return `${u.protocol}//${u.host}`
    } catch {
      return null
    }
  }

  const middleware: MiddlewareFn = async (ctx, next) => {
    // Only check mutating methods
    if (!mutateMethods.has(ctx.method.toUpperCase())) {
      return next()
    }

    const originHeader  = ctx.headers['origin']
    const refererHeader = ctx.headers['referer'] ?? ctx.headers['referrer']

    // Determine the effective request origin
    let requestOrigin: string | null = null

    if (originHeader) {
      // Origin header is set by the browser for all cross-origin requests
      // and for same-origin requests in modern browsers — most reliable source
      requestOrigin = originHeader.trim()
    } else if (refererHeader) {
      // Referer fallback — older browsers and some same-origin navigations
      // only send Referer. Strip the path to get just the origin.
      requestOrigin = originFromUrl(refererHeader)
    }

    // No origin information at all
    if (!requestOrigin) {
      if (opts.allowMissingOrigin) return next()

      const reason = 'CSRF: request has no Origin or Referer header'
      if (opts.onRejected) {
        await opts.onRejected(ctx, reason)
        return next()
      }
      throw new Forbidden(reason)
    }

    // Check against allowed origins
    if (!isAllowed(requestOrigin)) {
      const reason = `CSRF: origin '${requestOrigin}' is not allowed`
      if (opts.onRejected) {
        await opts.onRejected(ctx, reason)
        return next()
      }
      throw new Forbidden(reason)
    }

    return next()
  }

  return function csrfPlugin(app: App): void {
    patchRouterWithMiddleware(app, middleware)
  }
}
