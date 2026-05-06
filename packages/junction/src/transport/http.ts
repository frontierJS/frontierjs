// transport/http.ts
// The main HTTP transport — Bun.serve handler.
// Owns: routing, body parsing, auth resolution, static files,
//       gzip, response helpers, DDoS protection, stats tracking.
// App code never sees Request or Response directly.

import { Router }                         from './router.ts'
import { parsePathSegments, matchPathDirect } from './router.ts'
import { parseBody, parseQuery, extractIP } from './body.ts'
import { serveStatic, StaticOptions }     from './static.ts'
import { bridge, jsonResponse, errorResponse } from './bridge.ts'
import { toFrameworkError }               from '../core/errors.ts'
import { createStats, TransportStats }    from './types.ts'
import type { TransportContext, RawRequest, RouteHandler, MiddlewareFn,
              WsData, WsContext, WsHandlerSet }  from './types.ts'
import type { RouteSegment }              from './router.ts'
import type { IAuth }                     from '../auth/types.ts'

// ─── Module-level constants ────────────────────────────────────────────────

// ─── Cookie helpers ──────────────────────────────────────────────────────────

function parseCookieHeader(header: string): Record<string, string> {
  if (!header) return {}
  return Object.fromEntries(
    header.split(';').flatMap(part => {
      const [k, ...rest] = part.trim().split('=')
      const key = k?.trim()
      if (!key) return []
      return [[key, decodeURIComponent(rest.join('=').trim())]]
    })
  )
}

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

const EMPTY_HEADERS:  Record<string, string> = Object.freeze({})
const ENCODER  = new TextEncoder()  // singleton — not per-request

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
  powered?:     string     // X-Powered-By header value
  onError?:     (err: unknown, ctx?: TransportContext) => void
}

// ─── HTTP Transport ───────────────────────────────────────────────────────

export class HttpTransport {

  readonly router: Router
  readonly stats:  TransportStats

  private _opts:        HttpTransportOptions
  private _server:      ReturnType<typeof Bun.serve> | null = null
  private _ddos:        Map<string, { count: number; reset: number }> = new Map()
  private _wsRoutes: Array<{ segments: RouteSegment[]; handlers: WsHandlerSet }> = []

  constructor(opts: HttpTransportOptions = {}) {
    this.router = new Router()
    this.stats  = createStats()
    this._opts  = {
      port:        3000,
      hostname:    '0.0.0.0',
      maxBodySize: 256 * 1024,
      compress:    true,
      powered:     'Junction',
      ...opts
    }

    // GC: prune expired DDoS counters every window interval so the map
    // doesn't accumulate every IP the server has ever seen.
    if (opts.ddos?.enabled) {
      const gcInterval = setInterval(() => {
        const now = Date.now()
        for (const [ip, rec] of this._ddos) {
          if (rec.reset < now) this._ddos.delete(ip)
        }
      }, opts.ddos.window ?? 60_000)
      if (gcInterval.unref) gcInterval.unref()
    }
  }

  // ─── Start server ──────────────────────────────────────────────────

  start(): ReturnType<typeof Bun.serve> {

    // Build route cache — must happen before first request
    this.router.build()

    this._server = Bun.serve({
      port:     this._opts.port,
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

  stop(): Promise<void> {
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
  //   const res = await app.http.fetch(new Request('http://localhost/api/users'))
  async fetch(req: Request): Promise<Response> {
    const mockServer = { upgrade: () => false }
    return this._handle(req, mockServer as ReturnType<typeof Bun.serve>)
  }

  private async _handle(req: Request, server: ReturnType<typeof Bun.serve>): Promise<Response> {

    this.stats.request.total++

    const method = req.method.toUpperCase()
    const url    = new URL(req.url)
    const path   = url.pathname

    // ── DDoS protection ────────────────────────────────────────────
    if (this._opts.ddos?.enabled) {
      const ip  = extractIP(req)
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

    // ── Static file serving ────────────────────────────────────────
    if (this._opts.static && method === 'GET') {
      const staticRoot = this._opts.static.root
      if (path.startsWith('/')) {
        const staticResp = await serveStatic(req, path, this._opts.static)
        if (staticResp) {
          this.stats.response.file++
          return staticResp
        }
      }
    }

    // ── Route lookup — Tier 1 O(1) then Tier 2 ────────────────────
    const match = this.router.lookup(method, path)

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
      const token = extractToken(headers)
      if (token) {
        try { user = await this._opts.auth.verifySession(token) } catch {}
      }
    }

    // Parse query once and pass to _buildContext to avoid double parsing
    const query = parseQuery(url.search)

    // ── Build transport context ────────────────────────────────────
    const ctx = this._buildContext(req, url, query, headers, parsed, match.params, user)

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

    // Apply any Set-Cookie headers queued by handler via ctx.setCookie()
    const cookieHeaders = (ctx as unknown as { __pendingCookies?: typeof pendingCookies }).__pendingCookies
    if (cookieHeaders?.length) {
      const headers2 = new Headers(response.headers)
      for (const [name, value, opts] of cookieHeaders) {
        headers2.append('set-cookie', serializeSetCookie(name, value, opts as Parameters<typeof serializeSetCookie>[2]))
      }
      response = new Response(response.body, { status: response.status, headers: headers2 })
    }

    const extra       = ctx as Record<string, unknown>
    const cors        = extra.__cors               as Record<string, string> | undefined
    const security    = extra.__securityHeaders    as Record<string, string> | undefined
    const rateLimit   = extra.__rateLimit          as Record<string, string> | undefined
    const correlation = extra.__correlationHeaders as Record<string, string> | undefined

    const headers = new Headers(response.headers)
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
    const contentType = headers.get('content-type') ?? ''
    const mimeType    = contentType.split(';')[0].trim()

    const shouldCompress =
      this._opts.compress !== false &&
      canDecorate &&
      acceptEncoding.includes('gzip') &&
      COMPRESSIBLE_TYPES.has(mimeType) &&
      !headers.has('content-encoding')

    if (!shouldCompress) {
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
    user:    ReturnType<typeof Object.create>
  ): TransportContext {

    const ip = extractIP(req)
    const pendingCookies: Array<[string, string, Record<string, unknown>]> = []

    // Build response helpers bound to this request
    const ctx: TransportContext = {
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

      // Response helpers — return Response objects, not void
      json: (data, status = 200) => {
        this.stats.response.json++
        return new Response(JSON.stringify(data), {
          status,
          headers: { 'content-type': 'application/json' }
        })
      },

      text: (data, status = 200) => {
        this.stats.response.text++
        return new Response(data, {
          status,
          headers: { 'content-type': 'text/plain; charset=utf-8' }
        })
      },

      html: (data, status = 200) => {
        this.stats.response.html++
        return new Response(data, {
          status,
          headers: { 'content-type': 'text/html; charset=utf-8' }
        })
      },

      redirect: (location, status = 302) => {
        this.stats.response.redirect++
        return new Response(null, {
          status,
          headers: { location }
        })
      },

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

      stream: (readable, type, status = 200) => {
        this.stats.response.stream++
        return new Response(readable, {
          status,
          headers: { 'content-type': type }
        })
      },

      empty: (status = 204) => {
        this.stats.response.empty++
        return new Response(null, { status })
      },

      // ── Pagination envelope ────────────────────────────────────
      // Builds a consistent { data, total, limit, offset, next, prev }
      // response with absolute next/prev URLs derived from the current request.

      paginate: (data, total, { limit, skip }) => {
        this.stats.response.json++

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

      cookies:   parseCookieHeader(req.headers.get('cookie') ?? ''),
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
    const ip      = extractIP(req)

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
        ws.send(typeof data === 'string' ? data : JSON.stringify(data))
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
        extractToken(ws.data.headers)
      if (token) {
        try { ws.data.user = await this._opts.auth.verifySession(token) } catch {}
      }
    }

    const ctx = this._buildWsContext(ws)
    try { await ws.data.handlers.open?.(ctx) } catch {}

    // Signal the client that auth is resolved and the connection is registered.
    // The client defers _wsReady until it receives this — prevents service calls
    // from firing before verifySession and connMap registration are complete.
    ws.send(JSON.stringify({ type: 'connected' }))
  }

  private async _wsMessage(ws: Bun.ServerWebSocket<WsData>, message: string | Buffer): Promise<void> {
    const ctx = this._buildWsContext(ws)
    try { await ws.data.handlers.message?.(ctx, message) } catch {}
  }

  private async _wsClose(ws: Bun.ServerWebSocket<WsData>, code: number, reason: string): Promise<void> {
    this.stats.performance.online--
    const ctx = this._buildWsContext(ws)
    try { await ws.data.handlers.close?.(ctx, code, reason) } catch {}
  }

  private async _wsDrain(ws: Bun.ServerWebSocket<WsData>): Promise<void> {
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

function extractToken(headers: Record<string, string>): string | null {
  const auth = headers['authorization']
  if (auth?.startsWith('Bearer ')) return auth.slice(7)

  const apiKey = headers['x-api-key']
  if (apiKey) return apiKey

  return null
}
