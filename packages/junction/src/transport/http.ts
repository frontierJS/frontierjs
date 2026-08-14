// transport/http.ts
// The main HTTP transport — Bun.serve handler.
// Owns: routing, body parsing, auth resolution, static files,
//       gzip, response helpers, DDoS protection, stats tracking.
// App code never sees Request or Response directly.

import { Router }                         from './router.ts'
import { parsePathSegments, matchPathDirect } from './router.ts'
import { parseBody, parseQuery, parseCookies, extractIP } from './body.ts'
import { serveStatic }                    from './static.ts'
// `type` matters: StaticOptions is an interface, and importing it as a value
// breaks any runtime that strips types rather than transpiling — Node's
// --experimental-strip-types fails with "does not provide an export named
// 'StaticOptions'". Bun transpiles fully so it never noticed.
import type { StaticOptions }             from './static.ts'
import { bridge, jsonResponse, errorResponse } from './bridge.ts'
import { toFrameworkError }               from '../core/errors.ts'
import { createStats }                    from './types.ts'
import { wsSend, flushOutbox, dropOutbox, setMaxQueuedBytes } from './outbox.ts'
import type { TransportStats }            from './types.ts'
import type { TransportContext, RawRequest, RouteHandler, MiddlewareFn,
              WsData, WsContext, WsHandlerSet }  from './types.ts'
import type { RouteSegment }              from './router.ts'
import type { IAuth }                     from '../auth/types.ts'

// ─── Module-level constants ────────────────────────────────────────────────

// ─── Cookie helpers ──────────────────────────────────────────────────────────

// Cookie parsing unified on body.ts's parseCookies — this file previously
// carried its own divergent implementation (extra intermediate arrays per
// request, and an unguarded decodeURIComponent that threw on malformed
// values).

function serializeSetCookie(
  name:  string,
  value: string,
  opts:  { httpOnly?: boolean; sameSite?: string; secure?: boolean; maxAge?: number; path?: string } = {}
): string {
  const parts = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`]
  parts.push(`Path=${opts.path ?? '/'}`)
  if (opts.maxAge   !== undefined) parts.push(`Max-Age=${opts.maxAge}`)
  if (opts.httpOnly)               parts.push('HttpOnly')
  if (opts.secure)                 parts.push('Secure')
  if (opts.sameSite)               parts.push(`SameSite=${opts.sameSite.charAt(0).toUpperCase() + opts.sameSite.slice(1)}`)
  return parts.join('; ')
}

const COMPRESSIBLE_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/manifest+json',
  'text/plain',
  'text/html',
  'text/css',
  'text/csv',
  'text/javascript',
  'application/javascript',
  'application/xml',
  'text/xml',
  'image/svg+xml',
])

// Below this threshold compression overhead exceeds the saving
const MIN_COMPRESS_BYTES = 1024

const ENCODER  = new TextEncoder()  // singleton — not per-request

// Frozen response-header constants — Response copies the init object into
// its own Headers, so these are safe to share across every request instead
// of allocating a fresh literal per helper call.
const H_JSON = Object.freeze({ 'content-type': 'application/json' })
const H_TEXT = Object.freeze({ 'content-type': 'text/plain; charset=utf-8' })
const H_HTML = Object.freeze({ 'content-type': 'text/html; charset=utf-8' })

// ─── HTTP Transport options ───────────────────────────────────────────────

export interface HttpTransportOptions {
  port?:        number
  hostname?:    string
  maxBodySize?: number     // bytes, default 256KB
  compress?:    boolean    // gzip responses, default true
  ddos?: {
    enabled:    boolean
    limit:      number     // requests per window
    window:     number     // ms
  }
  static?:      StaticOptions
  auth?:        IAuth
  /**
   * Cookie name to read the session token from, in addition to
   * `Authorization: Bearer` and `x-api-key`. Null/omitted = cookies are not
   * read at all, which is the default and a deliberate one — see extractToken.
   *
   * Usually set for you: @frontierjs/auth calls `setAuthCookie('session')` from
   * its own register() when configured `{ cookieAuth: true }`. Set it here (via
   * `config.auth.cookie`) for a hand-rolled IAuth that issues its own cookie.
   */
  authCookie?:  string | null
  powered?:     string     // X-Powered-By header value
  onError?:     (err: unknown, ctx?: TransportContext) => void
  /**
   * Trust x-forwarded-for / x-real-ip headers for client IP resolution.
   * Enable ONLY when a trusted reverse proxy (nginx, Caddy, a load
   * balancer) sits in front of the app and sets these headers itself.
   * Default false: the socket address is used, because the forwarding
   * headers are client-settable and would let attackers spoof their way
   * past IP-keyed rate limiting and DDoS protection.
   */
  trustProxy?:  boolean
  /**
   * How many bytes junction will hold for one socket that is not draining,
   * before closing it with 1013 rather than growing without bound. Default 8MB
   * — see outbox.ts, which is also where the reason a frame needs holding at
   * all is written down.
   *
   * There is deliberately no knob for Bun's own buffer: `maxBackpressureLimit`
   * is accepted and ignored (measured on 1.3.11 — 64KB, 1MB and 16MB all drop
   * at the same ~16.9MB), so exposing it would be a control that changes
   * nothing.
   */
  wsMaxQueued?: number
}

// ─── HTTP Transport ───────────────────────────────────────────────────────

export class HttpTransport {

  readonly router: Router
  readonly stats:  TransportStats

  private _opts:        HttpTransportOptions
  private _server:      ReturnType<typeof Bun.serve> | null = null
  private _ddos:        Map<string, { count: number; reset: number }> = new Map()
  private _ddosGc:      ReturnType<typeof setInterval> | null = null
  private _wsRoutes: Array<{ segments: RouteSegment[]; handlers: WsHandlerSet }> = []

  // Request-independent response helpers, built ONCE per transport.
  // _buildContext used to allocate all of these as fresh closures on every
  // request; they only touch `this.stats`, so one shared set suffices.
  private _sharedHelpers: Pick<TransportContext,
    'json' | 'text' | 'html' | 'redirect' | 'stream' | 'empty'>

  constructor(opts: HttpTransportOptions = {}) {
    this.router = new Router()
    this.stats  = createStats()

    const stats = this.stats
    this._sharedHelpers = {
      json: (data, status = 200) => {
        stats.response.json++
        return new Response(JSON.stringify(data), { status, headers: H_JSON })
      },
      text: (data, status = 200) => {
        stats.response.text++
        return new Response(data, { status, headers: H_TEXT })
      },
      html: (data, status = 200) => {
        stats.response.html++
        return new Response(data, { status, headers: H_HTML })
      },
      redirect: (location, status = 302) => {
        stats.response.redirect++
        return new Response(null, { status, headers: { location } })
      },
      stream: (readable, type, status = 200) => {
        stats.response.stream++
        return new Response(readable, { status, headers: { 'content-type': type } })
      },
      empty: (status = 204) => {
        stats.response.empty++
        return new Response(null, { status })
      },
    }
    this._opts  = {
      port:        3000,
      hostname:    '0.0.0.0',
      maxBodySize: 256 * 1024,
      compress:    true,
      powered:     'Junction',
      ...opts
    }

    // GC: prune expired DDoS counters every window interval so the map
    // doesn't accumulate every IP the server has ever seen. Handle is kept
    // so stop() can clear it — previously it ran forever after shutdown.
    if (opts.ddos?.enabled) {
      this._ddosGc = setInterval(() => {
        const now = Date.now()
        for (const [ip, rec] of this._ddos) {
          if (rec.reset < now) this._ddos.delete(ip)
        }
      }, opts.ddos.window ?? 60_000)
      if (this._ddosGc.unref) this._ddosGc.unref()
    }
  }

  // ─── Start server ──────────────────────────────────────────────────

  /**
   * `port` overrides the configured one for this bind only. It exists for a
   * caller that wants 0 — an OS-chosen free port, read back from `.port` — which
   * is what makes a test server parallel-safe. Configuration stays untouched, so
   * a restart binds what the app declared.
   */
  start(port?: number): ReturnType<typeof Bun.serve> {

    // Build route cache — must happen before first request
    this.router.build()

    setMaxQueuedBytes(this._opts.wsMaxQueued)

    this._server = Bun.serve({
      port:     port ?? this._opts.port,
      hostname: this._opts.hostname,

      fetch: (req, server) => this._handle(req, server),

      // WebSocket handlers
      websocket: {
        open:    (ws)            => this._wsOpen(ws),
        message: (ws, msg)       => this._wsMessage(ws, msg),
        close:   (ws, code, reason) => this._wsClose(ws, code, reason),
        drain:   (ws)            => this._wsDrain(ws),
      },

      error: (err) => {
        this._opts.onError?.(err)
        return new Response('Internal Server Error', { status: 500 })
      }
    })

    return this._server
  }

  /**
   * The port actually bound, or null before start(). Configured `port: 0` asks
   * the OS for a free one, and without this there is no way to learn which —
   * which is the difference between a parallel-safe test server and a suite
   * that collides on a fixed number and reports it as the app being broken.
   */
  get port(): number | null {
    return this._server?.port ?? null
  }

  // Swap the auth implementation used for session resolution. Public API —
  // core's app.setAuth() previously reached into the private _opts field
  // via type-erasing casts, which no type-checker could protect.
  setAuth(auth: IAuth): void {
    this._opts.auth = auth
  }

  /**
   * Accept the session token from a cookie of this name, as well as from
   * `Authorization: Bearer` and `x-api-key`. Pass null to stop.
   *
   * Exists so an auth plugin can turn cookie mode on from its own `register()`
   * rather than making the app state it twice. `cookieAuth: true` on
   * @frontierjs/auth used to set a cookie nothing read back — declaring the
   * mode in one place and having the transport honour it is what closes that.
   *
   * See extractToken for why this is opt-in rather than always on.
   */
  setAuthCookie(name: string | null): void {
    this._opts.authCookie = name
  }

  stop(): Promise<void> {
    // Clear the DDoS GC timer and counters regardless of server state.
    if (this._ddosGc) {
      clearInterval(this._ddosGc)
      this._ddosGc = null
    }
    this._ddos.clear()

    if (!this._server) return Promise.resolve()
    // Bun's stop() without force:true drains open connections gracefully.
    const p = this._server.stop()
    this._server = null
    return Promise.resolve(p)
  }

  // ─── WebSocket route registration ──────────────────────────────────
  // Called before start() — registers a route that accepts WS upgrades.
  // Same {param} segment syntax as HTTP routes.

  ws(path: string, handlers: WsHandlerSet): void {
    if (this.router.isBuilt) {
      throw new Error(`Cannot register WS route ${path} after router is built`)
    }
    const segments = parsePathSegments(path)
    this._wsRoutes.push({ segments, handlers })
  }

  // ─── fetch() — public request handler for testing ─────────────────
  // The same function Bun.serve calls, exposed so tests can call it
  // directly without spinning up a real port.
  // router.build() must have been called first (or call app.start()).
  //
  // Usage in tests:
  //   const res = await app.http.fetch(new Request('http://localhost/users'))
  async fetch(req: Request): Promise<Response> {
    const mockServer = { upgrade: () => false }
    return this._handle(req, mockServer as ReturnType<typeof Bun.serve>)
  }

  private async _handle(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {

    this.stats.request.total++

    const method = req.method.toUpperCase()
    const url    = new URL(req.url)
    const path   = url.pathname

    // Resolve the client IP ONCE per request, from the socket address —
    // the only client-unforgeable source. Forwarding headers are consulted
    // only when trustProxy is explicitly enabled (see HttpTransportOptions).
    const remoteAddr = (server as { requestIP?: (r: Request) => { address: string } | null })
      .requestIP?.(req)?.address
    const clientIP = extractIP(req, remoteAddr, this._opts.trustProxy)

    // ── DDoS protection ────────────────────────────────────────────
    if (this._opts.ddos?.enabled) {
      const ip  = clientIP
      const now = Date.now()
      const rec = this._ddos.get(ip)

      if (rec) {
        if (now < rec.reset) {
          rec.count++
          if (rec.count > this._opts.ddos.limit) {
            this.stats.request.blocked++
            return new Response('Too Many Requests', { status: 429 })
          }
        } else {
          rec.count = 1
          rec.reset = now + this._opts.ddos.window
        }
      } else {
        this._ddos.set(ip, { count: 1, reset: now + (this._opts.ddos.window ?? 60000) })
      }
    }

    // ── WebSocket upgrade ──────────────────────────────────────────
    if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      return this._handleUpgrade(req, server, url, path) ?? new Response('Not Found', { status: 404 })
    }

    // ── Route lookup — Tier 1 O(1) then Tier 2 ────────────────────
    // Routes are checked BEFORE static files: the router lookup is an
    // in-memory match while static serving stats the filesystem, so with
    // the old static-first order every API GET paid a disk probe. Dynamic
    // routes therefore now take precedence over same-path static files.
    const match = this.router.lookup(method, path)

    // ── Static file serving (only for unrouted GETs) ───────────────
    if (!match && this._opts.static && method === 'GET') {
      const staticResp = await serveStatic(req, path, this._opts.static)
      if (staticResp) {
        this.stats.response.file++
        return staticResp
      }
    }

    if (!match) {
      return this._notFound(path)
    }

    // ── Parse body ─────────────────────────────────────────────────
    let parsed
    try {
      parsed = await parseBody(req, this._opts.maxBodySize)
    } catch (err) {
      return new Response('Payload Too Large', { status: 413 })
    }

    // ── Lazy headers proxy ─────────────────────────────────────────
    // Most handlers read 1–3 headers (authorization, content-type, origin).
    // Copying all headers into a plain object on every request is O(n_headers)
    // work that's wasted when most of those keys are never accessed.
    //
    // Instead, expose a Proxy that reads from req.headers on first access
    // per key and caches the result. Iteration (for middleware that needs all
    // headers) still works via the ownKeys / getOwnPropertyDescriptor traps,
    // but defers the cost until the iteration actually happens.
    const headersCache: Record<string, string> = {}
    const headers = new Proxy(headersCache, {
      get(target, key: string) {
        if (key in target) return target[key]
        const val = req.headers.get(key) ?? undefined
        if (val !== undefined) target[key] = val
        return val
      },
      has(_target, key: string) {
        return req.headers.has(key)
      },
      // Support Object.entries / for...in used by middleware that iterates headers
      ownKeys(_target) {
        // Populate cache on first full iteration
        req.headers.forEach((val, key) => { headersCache[key] = val })
        return Object.keys(headersCache)
      },
      getOwnPropertyDescriptor(_target, key: string) {
        const val = req.headers.get(key as string)
        if (val === null) return undefined
        headersCache[key as string] = val
        return { value: val, writable: true, enumerable: true, configurable: true }
      },
    }) as Record<string, string>

    // ── Resolve auth ───────────────────────────────────────────────
    let user = null
    if (this._opts.auth) {
      const token = extractToken(headers, this._opts.authCookie ?? null)
      if (token) {
        try { user = await this._opts.auth.verifySession(token) } catch {}
      }
    }

    // Parse query once and pass to _buildContext to avoid double parsing
    const query = parseQuery(url.search)

    // ── Build transport context ────────────────────────────────────
    const ctx = this._buildContext(req, url, query, headers, parsed, match.params, user, clientIP)

    // ── Track method stats ─────────────────────────────────────────
    this._trackMethod(method)

    // ── Run middleware chain + handler ─────────────────────────────
    try {
      const response = await this._execute(ctx, match.route.handler, match.route.middleware)
      return await this._finalizeWithHeaders(response, ctx, req.headers.get('accept-encoding') ?? '')
    } catch (err) {
      this._opts.onError?.(err, ctx)
      // Run error response through finalize so correlation ID still appears
      return await this._finalizeWithHeaders(errorResponse(err), ctx, '')
    }
  }

  // ─── Execute middleware + handler ─────────────────────────────────
  // After the handler completes, inject any headers that middleware
  // deposited on ctx side-channel properties (__cors, __securityHeaders,
  // __rateLimit). Previously these were computed but never applied.

  private async _execute(
    ctx:        TransportContext,
    handler:    RouteHandler,
    middleware: MiddlewareFn[]
  ): Promise<Response> {

    let response: Response

    if (!middleware.length) {
      response = toResponse(await handler(ctx), ctx)
    } else {
      // Middleware chain — each calls next()
      let idx = 0
      let finalResponse!: Response

      const next = async (): Promise<void> => {
        if (idx < middleware.length) {
          await middleware[idx++](ctx, next)
        } else {
          finalResponse = toResponse(await handler(ctx), ctx)
          // Stamp status so middleware (e.g. requestLogger) can read it
          ;(ctx as Record<string, unknown>).__status = finalResponse.status
        }
      }

      await next()
      response = finalResponse
    }

    // Inject headers that middleware stashed on ctx during the chain.
    // Middleware can't modify the Response directly (it's built inside next()),
    // so they write to known ctx properties and we apply them in _finalizeWithHeaders.
    return response
  }

  // ─── Finalize response — single clone for middleware headers + powered-by + gzip ──
  // Previously _injectCtxHeaders and _finalize could each clone the Response
  // independently (two allocations per request). Now they share one pass:
  // collect all extra headers from ctx side-channels AND powered-by in one
  // Headers object, then clone once.

  private async _finalizeWithHeaders(response: Response, ctx: TransportContext, acceptEncoding: string): Promise<Response> {
    const canDecorate = response.status !== 204 && response.status !== 304

    const extra         = ctx as Record<string, unknown>
    const cookieHeaders = extra.__pendingCookies    as Array<[string, string, Record<string, unknown>]> | undefined
    const cors          = extra.__cors               as Record<string, string> | undefined
    const security      = extra.__securityHeaders    as Record<string, string> | undefined
    const rateLimit     = extra.__rateLimit          as Record<string, string> | undefined
    const correlation   = extra.__correlationHeaders as Record<string, string> | undefined

    const needsCacheControl = canDecorate && response.status >= 200 && response.status < 300
    const hasExtras =
      !!(cookieHeaders?.length || cors || security || rateLimit || correlation) ||
      !!(this._opts.powered && canDecorate)

    // Compression decision is readable without cloning anything.
    const rawContentType = response.headers.get('content-type') ?? ''
    const willCompress =
      this._opts.compress !== false &&
      canDecorate &&
      acceptEncoding.includes('gzip') &&
      COMPRESSIBLE_TYPES.has(rawContentType.split(';')[0].trim()) &&
      !response.headers.has('content-encoding')

    // TRUE no-op fast path: nothing to add, nothing to rewrite, nothing to
    // compress → hand the handler's Response straight back (no Headers copy,
    // no Response clone). Covers 204/304, redirects, errors, pre-encoded
    // bodies, and non-compressible small responses with no middleware headers.
    if (!hasExtras && !needsCacheControl && !willCompress) {
      return response
    }

    // ONE Headers copy for everything below — cookies included (previously
    // the cookie path built its own intermediate Headers + Response clone).
    const headers = new Headers(response.headers)

    if (cookieHeaders?.length) {
      for (const [name, value, opts] of cookieHeaders) {
        headers.append('set-cookie', serializeSetCookie(name, value, opts as Parameters<typeof serializeSetCookie>[2]))
      }
    }

    if (cors)        for (const [k, v] of Object.entries(cors))        headers.set(k, v)
    if (security)    for (const [k, v] of Object.entries(security))    headers.set(k, v)
    if (rateLimit)   for (const [k, v] of Object.entries(rateLimit))   headers.set(k, v)
    if (correlation) for (const [k, v] of Object.entries(correlation)) headers.set(k, v)
    if (this._opts.powered && canDecorate)
      headers.set('x-powered-by', this._opts.powered)

    // ── Cache-Control ───────────────────────────────────────────────────────
    // Replace the blunt NOCACHE constant that was hardcoded in ctx.json() /
    // ctx.paginate() with context-aware directives. Only on 2xx; never
    // override a Cache-Control the handler already set explicitly.
    if (canDecorate && response.status >= 200 && response.status < 300) {
      const isRead = ctx.method === 'GET' || ctx.method === 'HEAD'

      // Re-set unconditionally — replaces the blunt NOCACHE baked into ctx.json()
      if (!isRead) {
        // Writes must never be cached anywhere
        headers.set('cache-control', 'no-store')
      } else if (ctx.user?.userId != null) {
        // Authenticated read — private cache, must revalidate before reuse.
        // Vary on Authorization so any shared cache always keys per-token.
        headers.set('cache-control', 'private, no-cache')
        const existing = headers.get('vary')
        headers.set('vary', existing ? `${existing}, Authorization` : 'Authorization')
      } else {
        // Public read — no-store keeps CDN out; Junction's server-side
        // cache (cache: true on the service) is the intended layer.
        headers.set('cache-control', 'no-store')
      }
    }

    // ── Compression ─────────────────────────────────────────────────────────
    // Decision was made up top (willCompress) from the original headers.
    if (!willCompress) {
      return new Response(response.body, { status: response.status, headers })
    }

    const bytes = new Uint8Array(await response.arrayBuffer())

    if (bytes.byteLength < MIN_COMPRESS_BYTES) {
      // Too small — compression overhead not worth it
      return new Response(bytes, { status: response.status, headers })
    }

    const compressed = Bun.gzipSync(bytes)
    headers.set('content-encoding', 'gzip')
    headers.set('content-length',   String(compressed.byteLength))
    const existingVary = headers.get('vary')
    headers.set('vary', existingVary ? `${existingVary}, Accept-Encoding` : 'Accept-Encoding')

    return new Response(compressed, { status: response.status, headers })
  }

  // ─── Build TransportContext ────────────────────────────────────────

  private _buildContext(
    req:     Request,
    url:     URL,
    query:   Record<string, string>,
    headers: Record<string, string>,
    parsed:  Awaited<ReturnType<typeof parseBody>>,
    params:  Record<string, string>,
    user:    ReturnType<typeof Object.create>,
    clientIP?: string
  ): TransportContext {

    // IP was already resolved (socket-address-first) in _handle — reuse it
    // rather than re-parsing headers.
    const ip = clientIP ?? extractIP(req)
    const pendingCookies: Array<[string, string, Record<string, unknown>]> = []

    // Lazy cookie parse — most API traffic is bearer-token and never reads
    // ctx.cookies, so don't pay header parsing until first access.
    let _cookies: Record<string, string> | undefined

    // Build response helpers bound to this request. The request-independent
    // helpers (json/text/html/redirect/stream/empty) are shared, prebuilt
    // closures — see _sharedHelpers in the constructor.
    const ctx: TransportContext = {
      ...this._sharedHelpers,

      method:   req.method.toUpperCase(),
      path:     url.pathname,
      params,
      query,
      headers,
      body:     parsed.data,
      files:    parsed.files,
      ip,
      protocol: url.protocol.startsWith('https') ? 'https' : 'http',
      host:     url.host,
      user,

      file: async (filePath, download) => {
        this.stats.response.file++
        const file = Bun.file(filePath)
        const exists = await file.exists()
        if (!exists) return new Response('Not Found', { status: 404 })

        const headers: Record<string, string> = {}
        if (download) {
          headers['content-disposition'] =
            `attachment; filename*=utf-8''${encodeURIComponent(
              typeof download === 'string' ? download : file.name ?? 'download'
            )}`
        }

        // Delegate to static handler for range/etag/gzip
        const staticResp = await serveStatic(req, '/' + filePath, {
          root: '',
          ...this._opts.static
        })
        return staticResp ?? new Response(file, { headers })
      },

      // ── Pagination envelope ────────────────────────────────────
      // Builds a consistent { data, total, limit, offset, next, prev }
      // response with absolute next/prev URLs derived from the current request.

      paginate: (data, total, opts) => {
        this.stats.response.json++

        // Accept both `skip` (legacy) and `offset` (canonical) as the same thing.
        const { limit } = opts as { limit: number }
        const skip = (opts as { skip?: number; offset?: number }).skip
          ?? (opts as { offset?: number }).offset
          ?? 0

        const base   = `${url.protocol}//${url.host}${url.pathname}`

        // Build next/prev URLs manually — URLSearchParams encodes '$' as '%24'
        // but callers expect '$offset' and '$limit' to appear literally.
        // We preserve any existing query params and add/replace $offset/$limit.
        function buildUrl(newOffset: number, newLimit: number): string {
          const existing = new URLSearchParams(url.search)
          existing.delete('$offset')
          existing.delete('$limit')
          const rest = existing.toString()
          const pagination = `$offset=${newOffset}&$limit=${newLimit}`
          return `${base}?${rest ? rest + '&' + pagination : pagination}`
        }

        const next = skip + limit < total ? buildUrl(skip + limit, limit)         : null
        const prev = skip > 0             ? buildUrl(Math.max(0, skip - limit), limit) : null

        return new Response(
          JSON.stringify({ data, total, limit, offset: skip, next, prev }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      },

      // ── Server-Sent Events ─────────────────────────────────────
      // Returns the Response immediately (must be returned from the handler)
      // and a send() function to push events, close() to end the stream,
      // and onDisconnect() to register cleanup when the client disconnects.
      //
      // Usage:
      //   app.get('/events', (ctx) => {
      //     const { response, send, close, onDisconnect } = ctx.sse()
      //     const timer = setInterval(() => send({ data: { ts: Date.now() } }), 1000)
      //     onDisconnect(() => clearInterval(timer))   // ← clean up on disconnect
      //     return response
      //   })

      sse: () => {
        this.stats.response.sse++

        let controller: ReadableStreamDefaultController<Uint8Array>
        const disconnectCallbacks: (() => void)[] = []

        const readable = new ReadableStream<Uint8Array>({
          start(c) { controller = c },
          cancel()  {
            // Client disconnected — run all registered cleanup callbacks
            for (const cb of disconnectCallbacks) {
              try { cb() } catch {}
            }
          }
        })

        const send = (event: import('./types.ts').SseEvent | unknown): void => {
          try {
            const e = (event && typeof event === 'object' && 'data' in (event as object))
              ? event as import('./types.ts').SseEvent
              : { data: event }

            let msg = ''
            if ((e as import('./types.ts').SseEvent).id)    msg += `id: ${(e as import('./types.ts').SseEvent).id}\n`
            if ((e as import('./types.ts').SseEvent).event) msg += `event: ${(e as import('./types.ts').SseEvent).event}\n`
            if ((e as import('./types.ts').SseEvent).retry) msg += `retry: ${(e as import('./types.ts').SseEvent).retry}\n`
            msg += `data: ${JSON.stringify((e as import('./types.ts').SseEvent).data ?? e)}\n\n`

            controller.enqueue(ENCODER.encode(msg))
          } catch { /* stream already closed */ }
        }

        const close = (): void => {
          try { controller.close() } catch {}
        }

        const onDisconnect = (cb: () => void): void => {
          disconnectCallbacks.push(cb)
        }

        return {
          response: new Response(readable, {
            status: 200,
            headers: {
              'content-type':      'text/event-stream; charset=utf-8',
              'cache-control':     'no-cache',
              'connection':        'keep-alive',
              'x-accel-buffering': 'no',   // disable Nginx buffering
            }
          }),
          send,
          close,
          onDisconnect,
        }
      },

      get cookies() {
        return _cookies ??= parseCookies(req.headers.get('cookie') ?? '')
      },
      setCookie: (name, value, opts = {}) => {
        pendingCookies.push([name, value, opts])
        ;(ctx as unknown as { __pendingCookies: typeof pendingCookies }).__pendingCookies = pendingCookies
      },

      $raw: {
        $req: req,
        url:  req.url,
      }
    }

    return ctx
  }

  // ─── WebSocket handling ────────────────────────────────────────────

  private _handleUpgrade(
    req:    Request,
    server: ReturnType<typeof Bun.serve>,
    url:    URL,
    path:   string
  ): Response | null {

    // Route the upgrade through the same zero-allocation matcher as HTTP requests.
    let matchedHandlers: WsHandlerSet | null = null
    let matchedParams:   Record<string, string> = {}

    for (const route of this._wsRoutes) {
      const params = matchPathDirect(route.segments, path)
      if (params !== null) {
        matchedHandlers = route.handlers
        matchedParams   = params
        break
      }
    }

    if (!matchedHandlers) return null

    this.stats.request.websocket++

    const query   = parseQuery(url.search)   // reuse the URL already parsed in _handle
    const headers = Object.fromEntries(req.headers.entries())
    const ip      = extractIP(
      req,
      (server as { requestIP?: (r: Request) => { address: string } | null }).requestIP?.(req)?.address,
      this._opts.trustProxy
    )

    // Store everything needed to build WsContext in ws.data.
    // user is null here — resolved asynchronously in _wsOpen.
    const wsData: WsData = {
      path,
      params:   matchedParams,
      query,
      headers,
      ip,
      user:     null,
      handlers: matchedHandlers,
    }

    const upgraded = server.upgrade(req, { data: wsData })

    return upgraded
      ? undefined as unknown as null   // Bun owns the response
      : new Response('WebSocket Upgrade Failed', { status: 400 })
  }

  // ── Build WsContext from ws.data ──────────────────────────────────
  // Called once per lifecycle event. Wraps the raw Bun WS with the
  // same ergonomic surface as TransportContext.

  private _buildWsContext(ws: Bun.ServerWebSocket<WsData>): WsContext {
    return {
      path:    ws.data.path,
      params:  ws.data.params,
      query:   ws.data.query,
      headers: ws.data.headers,
      ip:      ws.data.ip,
      user:    ws.data.user,
      send(data: string | object): void {
        // Never ws.send() directly. A dropped frame is silent — outbox.ts is
        // the one place that knows what Bun's return value means.
        wsSend(ws, typeof data === 'string' ? data : JSON.stringify(data))
      },
      close(code?: number, reason?: string): void {
        ws.close(code, reason)
      },
      $ws: ws,
    }
  }

  private async _wsOpen(ws: Bun.ServerWebSocket<WsData>): Promise<void> {
    this.stats.performance.online++

    // Resolve auth from token in headers or query — same logic as HTTP.
    // We do this here rather than at upgrade time because verifySession is async
    // and Bun's upgrade() call is synchronous.
    if (this._opts.auth) {
      const token =
        ws.data.query?.token ??
        // The upgrade request is an ordinary browser request and carries the
        // cookie, so cookie mode has to work for the socket too — otherwise a
        // cookie-authenticated app connects as anonymous and every channel
        // scoped to the user stays silent.
        extractToken(ws.data.headers, this._opts.authCookie ?? null)
      if (token) {
        try { ws.data.user = await this._opts.auth.verifySession(token) } catch {}
      }
    }

    const ctx = this._buildWsContext(ws)
    try { await ws.data.handlers.open?.(ctx) } catch {}

    // Signal the client that auth is resolved and the connection is registered.
    // The client defers _wsReady until it receives this — prevents service calls
    // from firing before verifySession and connMap registration are complete.
    wsSend(ws, JSON.stringify({ type: 'connected' }))
  }

  private async _wsMessage(ws: Bun.ServerWebSocket<WsData>, message: string | Buffer): Promise<void> {
    const ctx = this._buildWsContext(ws)
    try { await ws.data.handlers.message?.(ctx, message) } catch {}
  }

  private async _wsClose(ws: Bun.ServerWebSocket<WsData>, code: number, reason: string): Promise<void> {
    this.stats.performance.online--
    dropOutbox(ws)
    const ctx = this._buildWsContext(ws)
    try { await ws.data.handlers.close?.(ctx, code, reason) } catch {}
  }

  private async _wsDrain(ws: Bun.ServerWebSocket<WsData>): Promise<void> {
    // The socket has room again — anything held back goes out first, in order,
    // before any handler gets a chance to write more.
    flushOutbox(ws)
    const ctx = this._buildWsContext(ws)
    try { await ws.data.handlers.drain?.(ctx) } catch {}
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private _notFound(path: string): Response {
    this.stats.response.error++
    return new Response(JSON.stringify({ name: 'NotFound', message: `${path} not found`, code: 404 }), {
      status:  404,
      headers: { 'content-type': 'application/json' }
    })
  }

  private _trackMethod(method: string): void {
    const m = method.toLowerCase() as keyof typeof this.stats.request
    if (m in this.stats.request)
      (this.stats.request as Record<string, number>)[m]++
  }
}

// ─── Response coercion ────────────────────────────────────────────────────
// Converts whatever a handler returned into a proper Response

function toResponse(result: unknown, ctx: TransportContext): Response {
  if (result instanceof Response) return result
  if (result instanceof Promise) throw new Error('Handler returned a Promise — use async/await')
  if (result === null || result === undefined) return ctx.empty()
  if (typeof result === 'string') return ctx.text(result)
  return ctx.json(result)
}

// ─── Token extraction from headers ───────────────────────────────────────

/**
 * Resolve the session token for a request.
 *
 * Order is deliberate: an explicitly-attached credential always beats an
 * ambiently-attached one, so a Bearer token or an API key wins over the cookie
 * even when both are present. That makes "act as someone else for this one
 * call" possible from a browser that is also holding a session cookie.
 *
 * ── Why the cookie is opt-in (FJS-002) ────────────────────────────────────
 *
 * This used to read only `authorization` and `x-api-key`, so
 * `createAuthPlugin(auth, { cookieAuth: true })` set an httpOnly cookie that
 * nothing ever read back: `ctx.user` stayed null and a cookie-only request to
 * any protected route was 401. The documented mode handed you a session you
 * could not use.
 *
 * It stays OFF unless a cookie name is supplied, and that is a security
 * decision rather than caution about breaking things. A Bearer token has to be
 * attached by script, so a cross-site request cannot forge one. A cookie is
 * attached by the browser automatically, which is what makes CSRF possible at
 * all — so an app only gets that exposure when it asks for it. What makes it
 * safe when asked for is `SameSite=Lax`, which @frontierjs/auth sets: the
 * browser withholds the cookie from cross-site POST/PUT/PATCH/DELETE, and those
 * are the requests that change something. An app that sets its own session
 * cookie with `SameSite=None` re-opens the hole and Junction cannot tell.
 */
function extractToken(
  headers:    Record<string, string>,
  cookieName: string | null = null,
): string | null {
  const auth = headers['authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  const apiKey = headers['x-api-key']
  if (apiKey) return apiKey

  if (cookieName) {
    const raw = headers['cookie']
    if (raw) {
      const value = parseCookies(raw)[cookieName]
      // An empty cookie is how a logout clears one. Treating '' as a token
      // would send a guaranteed-failing verifySession on every request after
      // sign-out.
      if (value) return value
    }
  }

  return null
}
