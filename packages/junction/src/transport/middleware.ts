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

import type { MiddlewareFn, RouteOptions, TransportContext } from './types.ts'
import type { App }                            from '../core/app.ts'
import { Forbidden, isDevelopmentEnv, toFrameworkError } from '../core/errors.ts'
import { clientIp, inboundCorrelationId, mintCorrelationId, PROTOCOL_CALL_HEADERS, PROTOCOL_HTTP_ONLY_HEADERS } from '../core/context.ts'
import {
  createRateLimiter,
  refuseLegacyRateLimitOptions,
  type RateLimitOptions as CoreRateLimitOptions,
} from '../core/rate-limit.ts'

// ─── Shared origin type ───────────────────────────────────────────────────
// cors() and csrf() both accept the same origin specification.
// Define it once here.

/**
 * Allowed origins — one origin, a list of them, or a custom predicate.
 *
 * `'*'` is the wildcard and is just a string here. A single origin was
 * `string[] | '*'` and therefore did not compile, while `cors()`'s own
 * `isAllowed` has always had the `typeof origins === 'string'` branch that
 * handles it.
 */
export type OriginList = string | string[] | ((origin: string) => boolean)

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
  // csrf() takes no wildcard and no bare string: '*' would defeat it, and a
  // single origin becomes the one-element list it means.
  const csrfOrigins: string[] | ((o: string) => boolean) =
    origins === '*'               ? () => true
    : typeof origins === 'string' ? [origins]
    : origins

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
  // The app's own per-call headers (`config.http.callHeaders`). Separate from
  // `headers` so an app declaring one place gets both readers — the WS frame
  // merge is the other — rather than having to remember the CORS half too.
  callHeaders?: string[]
  credentials?: boolean
  maxAge?:      number      // seconds
}

/** Case-insensitive dedupe, first spelling wins — a list is header NAMES, and
 *  `content-type` and `Content-Type` are one header announced twice. */
function _uniqueHeaders(names: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    const k = n.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(n)
  }
  return out.join(', ')
}

export function cors(opts: CorsOptions) {

  const {
    origins,
    methods    = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    headers    = ['Content-Type', 'Authorization', 'X-API-Key'],
    credentials = false,
    maxAge      = 86400
  } = opts

  // `*` and credentials together is not a wider CORS policy, it is no policy:
  // the browser refuses the literal `*` alongside `Access-Control-Allow-
  // Credentials`, so the middleware reflected whatever `Origin` arrived and
  // answered `true` beside it — every origin on the internet reading a
  // cookie-authenticated response (`FJS-689`). Refused at CONSTRUCTION rather
  // than per request: a guard that fires on the attacker's request and not on
  // the developer's is one nobody sees until it is being used.
  if (credentials && (origins === '*' || (Array.isArray(origins) && origins.includes('*')))) {
    throw new TypeError(
      `[Junction] cors(): origins '*' cannot be combined with credentials: true — ` +
      `a credentialed response reflects the caller's own Origin back, so the ` +
      `wildcard grants every site read access to an authenticated response. ` +
      `List the origins that may hold a session, or drop credentials.`
    )
  }

  const methodStr  = methods.join(', ')
  // Junction's OWN protocol headers are added to whatever the app declared,
  // never replaced by it, because the browser client sends them unasked:
  // X-Service-Method is how a custom method is addressed over HTTP,
  // X-Workspace-Id rides on every call once setWorkspace() is used, and
  // Idempotency-Key is read by callService. Cross-origin, a header missing
  // here fails the preflight and the request never arrives — and an app whose
  // socket is up never sees it, because the HTTP path is only the fallback.
  //
  // They used to be part of the DEFAULT, which is the same thing until an app
  // states a list of its own: `config.http.cors.headers` is populated in
  // defaultConfig, so every app that configured CORS through config replaced
  // the default with three names and lost all three protocol headers.
  const headerStr  = _uniqueHeaders([...headers, ...PROTOCOL_HTTP_ONLY_HEADERS, ...PROTOCOL_CALL_HEADERS, ...(opts.callHeaders ?? [])])

  function isAllowed(origin: string): boolean {
    if (origins === '*') return true
    if (Array.isArray(origins)) return origins.includes('*') || origins.includes(origin)
    if (typeof origins === 'string') return origins === origin
    return origins(origin)
  }

  const middleware: MiddlewareFn = async (ctx, next) => {
    const origin = ctx.headers['origin'] ?? ''

    // With credentials on there is no wildcard to fall back to: a request with
    // no Origin is not cross-origin, and answering `*` beside
    // `allow-credentials: true` is a header pair every browser rejects anyway.
    if (credentials && !origin) { await next(); return }

    if (isAllowed(origin)) {
      ;(ctx).__cors = {
        'access-control-allow-origin':      origin || '*',
        'access-control-allow-methods':     methodStr,
        'access-control-allow-headers':     headerStr,
        'access-control-max-age':           String(maxAge),
        // A reflected origin makes the response origin-dependent; without this
        // a shared cache hands one site's ACAO to the next caller.
        ...(origin ? { 'vary': 'Origin' } : {}),
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
      const corsHeaders = ctx.__cors ?? {}
      return new Response(null, { status: 204, headers: corsHeaders })
    })
  }
}

function patchRouterWithMiddleware(app: App, mw: MiddlewareFn): void {
  const router   = app.http.router
  const methods  = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const

  // Routes registered BEFORE this point get it too, which patching alone
  // cannot do. Every raw route a plugin mounts is registered inside
  // `configure()` → `register()`, and that is synchronous and long finished by
  // the time the `cors` start phase runs — so `/auth/login`, caravan's `/jobs`
  // and every `app.post` an app writes at module scope were the routes this
  // never reached, while SERVICE routes (registered in a later start phase)
  // were fine. Sign-in was therefore the one call in a Junction app that no
  // browser on another origin could make: preflight 204, POST 200, session
  // created, response discarded by the browser, `Failed to fetch` on the page
  // (`FJS-496`).
  router.prependMiddleware?.(mw)

  for (const method of methods) {
    const original = router[method].bind(router) as Function
    ;(router as unknown as Record<string, Function>)[method] = (
      path:    string,
      handler: Function,
      opts:    RouteOptions = {}
    ) => {
      return original(path, handler, { ...opts, middleware: [mw, ...(opts.middleware ?? [])] })
    }
  }
}

// ─── Helmet (security headers) ────────────────────────────────────────────

export interface HelmetOptions {
  noSniff?:      boolean   // X-Content-Type-Options
  frame?:        'deny' | 'sameorigin' | false   // X-Frame-Options
  hsts?:         boolean | { maxAge: number; includeSubDomains?: boolean }
  referrer?:     string    // Referrer-Policy
  csp?:          string | false   // Content-Security-Policy
  poweredBy?:    false     // remove X-Powered-By
}

// FJS-D1192. On in development too, so a page that breaks under it breaks
// where it is written. `base-uri`, `form-action` and `frame-ancestors` never
// fall back to `default-src`, so leaving them out leaves them open.
function defaultCsp(frame: HelmetOptions['frame'] = 'deny'): string {
  return [
    "default-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    ...(frame ? [`frame-ancestors ${frame === 'deny' ? "'none'" : "'self'"}`] : []),
  ].join('; ')
}

export function helmet(opts: HelmetOptions = {}) {

  const {
    noSniff = true,
    frame   = 'deny',
    // On in production with no scheme check: a browser ignores it over plain
    // http (RFC 6797 §8.1). Off in development, where https://localhost would
    // be pinned for a year
    hsts    = !isDevelopmentEnv(),
    referrer = 'no-referrer',
    csp     = defaultCsp(frame),
    poweredBy,
  } = opts

  const securityHeaders: Record<string, string> = {}

  // '0' and not absent: an older browser runs its XSS auditor by default, and the auditor itself leaks page content
  securityHeaders['x-xss-protection'] = '0'
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

  // No middleware: the transport stamps these on every answer it finalizes,
  // routed or not, and a middleware that only stashed them on the context cost
  // every request a promise hop and a Headers copy.
  return function helmetPlugin(app: App): void {
    app.http.setSecurityHeaders(securityHeaders)
  }
}

// ─── Rate limiter ─────────────────────────────────────────────────────────

// The transport tier's own view of the shared options. Same names throughout —
// `max`/`window`/`key`/`message`/`skip` — so what you learn here is what the
// pipeline hook and @frontierjs/auth take (FJS-017). `window` accepts a TTL
// string as well as milliseconds; this tier used to take only a number.
export type RateLimitOptions = CoreRateLimitOptions<TransportContext>

export function rateLimit(opts: RateLimitOptions) {

  refuseLegacyRateLimitOptions(opts as unknown as Record<string, unknown>)

  // At the transport there is no principal yet — that is the whole reason this
  // tier exists, so a flood that never reaches a service is still counted. IP is
  // the only thing to key on.
  const limiter = createRateLimiter<TransportContext>(opts, clientIp)

  const middleware: MiddlewareFn = async (ctx, next) => {
    const verdict = limiter.check(ctx)

    // The header side is what this tier has and the hook does not: it runs where
    // a response is still being assembled.
    ;(ctx as unknown as Record<string, unknown>).__rateLimit = {
      'x-ratelimit-limit':     String(verdict.limit),
      'x-ratelimit-remaining': String(verdict.remaining),
      'x-ratelimit-reset':     String(verdict.reset),
    }

    await next()
  }

  // A full Plugin rather than a bare PluginFn so shutdown() can stop the sweep.
  return {
    name: 'rateLimit',
    register(app: App): void {
      patchRouterWithMiddleware(app, middleware)
    },
    shutdown(): void {
      limiter.dispose()
    },
  }
}

// ─── Request logger ───────────────────────────────────────────────────────

export interface RequestLoggerOptions {
  level?:  'info' | 'debug'
  format?: 'common' | 'json'
  skip?:   (ctx: TransportContext) => boolean
}

export function requestLogger(opts: RequestLoggerOptions = {}) {

  const { level = 'info', format = 'common', skip } = opts

  // The middleware is built INSIDE the plugin, because it needs the app's
  // logger and the factory does not have one yet. It used to write straight to
  // `console[level]`, so the one line per request an operator actually greps
  // had no namespace, no correlation id and no level filter — and under
  // `format: 'json'` it was a second JSON shape beside the logger's own.
  //
  // `format` is kept and now means what it says: `json` puts the fields on the
  // entry, `common` puts the familiar one-line string in the message and the
  // fields beside it. Either way it goes through the app's writers.
  return function requestLoggerPlugin(app: App): void {
    const log = app.logger.child('http')

    const middleware: MiddlewareFn = async (ctx, next) => {
      if (skip?.(ctx)) { await next(); return }

      const start = Date.now()
      // A raw route's throw leaves `ctx.__status` unset, so without the
      // catch a refused sign-in logged as 200 (`FJS-1417`). The status is the
      // one the error boundary will answer with, from its own owner.
      let thrown: number | undefined
      try {
        await next()
      } catch (err) {
        thrown = toFrameworkError(err, app).code
        throw err
      } finally {
        const ms     = Date.now() - start
        const status = thrown ?? ctx.__status ?? 200
        // The id the `correlationId()` middleware stamped. The request scope
        // `enterRequest` opens is closed by now, so `requestMeta()` answers
        // `undefined` here (`FJS-1414`).
        const correlationId = ctx.requestId

        const data = { method: ctx.method, path: ctx.path, status, ms, ip: ctx.ip, correlationId }

        if (format === 'json') log[level]('request', data)
        else log[level](`${ctx.method} ${ctx.path} ${status} ${ms}ms - ${ctx.ip}`, { correlationId })
      }
    }

    patchRouterWithMiddleware(app, middleware)

    // A socket call never passes the router, so without this a connected
    // client — every screen after the first second — left no line for any
    // read or write, a refused one included (`FJS-1301`).
    socketCallLoggers.set(app, ({ service, method, id, status, ms, ip, correlationId }) => {
      const path = id != null ? `${service}/${id}` : service
      const data = { transport: 'websocket', method, path, status, ms, ip, correlationId }
      if (format === 'json') log[level]('request', data)
      else log[level](`WS ${method} ${path} ${status} ${ms}ms - ${ip}`, { correlationId })
    })
  }
}

export interface SocketCallEntry {
  service: string
  method:  string
  id:      string | null
  status:  number
  ms:      number
  ip:      string | undefined
  correlationId?: string
}

const socketCallLoggers = new WeakMap<App, (entry: SocketCallEntry) => void>()

/** The socket transport's half of `requestLogger` — a no-op unless it is on. */
export function logSocketCall(app: App, entry: SocketCallEntry): void {
  socketCallLoggers.get(app)?.(entry)
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
// Reads the id by enterRequest's rule (`inboundCorrelationId`: the traceparent
// trace id, then a well-formed X-Request-ID), or generates one. A second rule
// here would give the response header and the log line two ids.
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
  // Custom id generator. Default: 32 hex, shaped as a W3C trace id
  generator?: () => string
}

export function correlationId(opts: CorrelationIdOptions = {}) {

  const header    = (opts.header ?? 'x-request-id').toLowerCase()
  const generate  = opts.generator ?? mintCorrelationId

  const middleware: MiddlewareFn = async (ctx, next) => {
    const id = inboundCorrelationId(ctx.headers, header) ?? generate()

    // Stamp on ctx so handlers can reach it without parsing headers again
    ;(ctx).requestId = id

    await next()

    // Echo back in the response — _injectCtxHeaders picks this up
    const existing = ctx.__correlationHeaders
    ;(ctx).__correlationHeaders = { ...existing, [header]: id }
  }

  return function correlationIdPlugin(app: App): void {
    patchRouterWithMiddleware(app, middleware)
  }
}

// ─── CSRF ─────────────────────────────────────────────────────────────────
// Origin-checking CSRF protection for cookie-session APIs.
//
// A Bearer token is CSRF-safe — a cross-origin page cannot set the header. A
// cookie is attached by the browser, so cookie mode installs this guard
// itself (`FJS-D610`). SameSite=Lax is not enough: a cross-site form POST to
// /auth/login carries no cookie and SETS one, signing the victim's browser
// into the attacker's account (`FJS-1818`).
//
// For every mutating request, in order:
//   1. `Sec-Fetch-Site: same-origin` or `none` passes. A browser sets it and a
//      page cannot.
//   2. The request's origin is `Origin`, else the origin of `Referer`. A
//      listed origin passes.
//   3. `Sec-Fetch-Site: cross-site` or `same-site` is refused. `same-site` is
//      a sibling subdomain, which SameSite counts as the same site.
//   4. A browser too old to send Sec-Fetch-Site: an origin whose host is the
//      request's `Host` passes, any other is refused.
//   5. No origin information at all passes unless allowMissingOrigin is false.
//      The attack needs a browser, and a browser names the origin of a
//      cross-origin POST.
//
// Behind a proxy, step 4 needs the Host header to survive the hop.
//
// Usage:
//   app.configure(csrf())                                   // same origin only
//   app.configure(csrf({ origins: ['https://admin.myapp.com'] }))
//   app.configure(csrf({ origins: (o) => o.endsWith('.myapp.com') }))
//
// Relationship to cors():
//   cors() controls which origins the browser exposes the response to.
//   csrf() controls which origins are allowed to trigger server-side mutations.
//   Run both together — cors() first, so a preflight is answered before the
//   origin check refuses it.


export interface CsrfOptions {
  // Origins besides the app's own that may make mutating requests. Same
  // format as cors() origins, but '*' is not accepted (it would defeat the
  // purpose). Use combineOrigins() to share a list with cors().
  origins?: string[] | ((origin: string) => boolean)

  // Methods considered state-mutating. Default: POST, PUT, PATCH, DELETE.
  methods?: string[]

  // If false, a request with no Sec-Fetch-Site, Origin or Referer is refused.
  // Default: true — it is a server-to-server call or curl, not a browser.
  allowMissingOrigin?: boolean

  // Custom rejection handler. Default: throws Forbidden.
  onRejected?: (ctx: TransportContext, reason: string) => void | Promise<void>
}

// 'https://myapp.com/some/path' → URL, or null for 'null' and garbage
function parseUrl(url: string): URL | null {
  try { return new URL(url) } catch { return null }
}

/**
 * Steps 1–5 above: why a request's origin may not act with the credentials a
 * browser attaches by itself, or null when it may. csrf() asks it of a
 * mutating request and the WebSocket upgrade of every handshake, because a
 * browser applies no CORS to an upgrade and sends its cookies with it
 * (`FJS-D1207`).
 */
export function originRefusal(
  headers:            Record<string, string | undefined>,
  origins:            CsrfOptions['origins'],
  allowMissingOrigin: boolean,
): string | null {
  const site = headers['sec-fetch-site']?.trim().toLowerCase()
  if (site === 'same-origin' || site === 'none') return null

  const originHeader  = headers['origin']?.trim()
  const refererHeader = headers['referer'] ?? headers['referrer']
  const referer       = refererHeader ? parseUrl(refererHeader) : null
  const requestOrigin = originHeader || (referer ? `${referer.protocol}//${referer.host}` : null)

  const listed = requestOrigin !== null && !!origins && (Array.isArray(origins)
    ? origins.includes(requestOrigin) || origins.includes('*')
    : origins(requestOrigin))

  if (listed) return null
  if (site === 'cross-site' || site === 'same-site')
    return `a ${site} request from '${requestOrigin ?? 'no origin'}' is not allowed`
  if (requestOrigin) {
    const host = headers['host']?.trim().toLowerCase()
    return host && parseUrl(requestOrigin)?.host.toLowerCase() === host
      ? null
      : `origin '${requestOrigin}' is not allowed`
  }
  return allowMissingOrigin ? null : 'request has no Origin or Referer header'
}

export function csrf(opts: CsrfOptions = {}) {

  const mutateMethods = new Set(
    (opts.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE']).map(m => m.toUpperCase())
  )
  const allowMissingOrigin = opts.allowMissingOrigin ?? true

  const middleware: MiddlewareFn = async (ctx, next) => {
    if (!mutateMethods.has(ctx.method.toUpperCase())) return next()

    const refused = originRefusal(ctx.headers, opts.origins, allowMissingOrigin)
    const reason  = refused && `CSRF: ${refused}`

    if (reason) {
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
    if (opts.origins) app.http.setUpgradeOrigins(opts.origins)
  }
}
