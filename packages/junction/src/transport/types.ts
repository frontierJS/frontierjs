// transport/types.ts
// Shared interfaces for the transport layer.
// Nothing above the bridge imports from here directly —
// they only see the ctx shape defined in bridge.ts

import type { SessionContext } from '../auth/types.ts'

// ─── Raw request — lives entirely inside transport ───────────────────────────

// Only fields not already on TransportContext directly.
// ctx.method, ctx.path, ctx.query, ctx.headers, ctx.body, ctx.route etc.
// are all accessible on the context itself — no need to duplicate them here.
export interface RawRequest {
  // The original Bun Request object — use when you need the raw fetch API
  // (streaming body, native Headers, FormData, etc.)
  $req: Request
  // Full URL string including origin, path, and query
  url:  string
}

// ─── Uploaded file ────────────────────────────────────────────────────────────

export interface UploadedFile {
  name:     string
  filename: string
  type:     string
  size:     number
  data:     ArrayBuffer
}

// ─── Route definition ─────────────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

export interface RouteDefinition {
  method:    HttpMethod
  path:      string
  handler:   RouteHandler
  // pre-parsed path segments for matching
  segments:  RouteSegment[]
  // true if any segment is a param
  dynamic:   boolean
  // pre-built param names list
  paramKeys: string[]
  // compiled middleware chain
  middleware: MiddlewareFn[]
}

export type RouteSegment =
  | { type: 'static'; value: string }
  | { type: 'param';  name: string  }
  | { type: 'wildcard'             }

export type RouteHandler   = (ctx: TransportContext) => unknown | Promise<unknown>
export type MiddlewareFn   = (ctx: TransportContext, next: () => Promise<void>) => Promise<void>

// ─── Pagination envelope ──────────────────────────────────────────────────

export interface PaginateResponse {
  data:   unknown[]
  total:  number
  limit:  number
  skip:   number
  next:   string | null    // full URL for the next page, null if at the end
  prev:   string | null    // full URL for the previous page, null if at the start
}

// ─── SSE sender ───────────────────────────────────────────────────────────

export interface SseEvent {
  data:    unknown           // will be JSON-serialised
  event?:  string            // named event type, e.g. 'update'
  id?:     string            // event id for Last-Event-ID tracking
  retry?:  number            // reconnect delay hint in ms
}

export type SseSendFn = (event: SseEvent | unknown) => void

// ─── Transport-level context ─────────────────────────────────────────────────
// This is the ctx shape BELOW the bridge.
// Service layer sees a different, cleaner ctx via bridge.toContext()

export interface TransportContext {
  method:   string
  path:     string
  /**
   * Path-pattern captures — `{id}`, `{room}`. Path only; the search string is
   * `query`.
   *
   * Named `route` rather than `params` because in Feathers `params` is the
   * whole context bag, and that idiom keeps arriving here: `ctx.params.user`,
   * `ctx.params.headers`, `app.service(x).get(id, ctx.params)`. A field of that
   * name holding something else is how a role check reads `undefined` and
   * passes for everyone. One word per realm — `ctx.route` on both of
   * Junction's contexts, `page.params` in Sierra (`FJS-D03`).
   */
  route:    Record<string, string>
  query:    Record<string, string>
  headers:  Record<string, string>
  body:     unknown
  /**
   * The body as it arrived on the wire, when it was a single string — JSON,
   * urlencoded, XML or text. Absent for multipart and for no body at all.
   *
   * For verifying a signature over the body, and nothing else: read `body`.
   * A hook reaches it as `ctx.$raw.rawBody`.
   */
  rawBody?: string
  files:    UploadedFile[]
  ip:       string
  protocol: 'http' | 'https'
  host:     string
  user:     SessionContext | null

  // response helpers — bound to current request
  json:     (data: unknown, status?: number)  => Response
  text:     (data: string,  status?: number)  => Response
  html:     (data: string,  status?: number)  => Response
  redirect: (url: string,   status?: number)  => Response
  file:     (path: string,  download?: string) => Promise<Response>
  stream:   (readable: ReadableStream, type: string, status?: number) => Response
  empty:    (status?: number) => Response

  // Pagination envelope — wraps an array with total/limit/skip and
  // pre-built next/prev URLs based on the current request URL.
  //   ctx.paginate(rows, total, { limit: 20, offset: 0 })
  //   // `skip` accepted as a legacy alias for `offset`
  //   → { data, total, limit, offset, next, prev }
  paginate: (data: unknown[], total: number, opts: { limit: number; offset?: number; skip?: number }) => Response

  // Server-Sent Events — returns an open stream response.
  // The returned sender lets you push events and close the stream.
  //   const { send, close } = ctx.sse()
  //   send({ event: 'update', data: { id: 1 } })
  sse: () => { response: Response; send: SseSendFn; close: () => void; onDisconnect: (cb: () => void) => void }

  // Set by correlationId() middleware — the request's trace ID.
  // Available to handlers and services without parsing headers.
  requestId?: string

  // Cookie helpers — set by the HTTP layer from the Cookie request header.
  // cookies: parsed key→value map from the incoming Cookie header.
  // setCookie: queues a Set-Cookie header on the response.
  cookies:   Record<string, string>
  setCookie: (name: string, value: string, opts?: {
    httpOnly?: boolean
    sameSite?: 'strict' | 'lax' | 'none'
    secure?:   boolean
    maxAge?:   number
    path?:     string
  }) => void

  // escape hatch to raw request
  $raw: RawRequest

  // ── the middleware → transport side channel ──────────────────────────────
  //
  // A middleware runs before the response object exists, so it cannot set a
  // header on one; it leaves the header here and `_finalizeWithHeaders` applies
  // every bucket at the end. That is one contract with six fields and it was
  // written down nowhere — each side reached it through
  // `(ctx as Record<string, unknown>).__cors`, so a middleware writing a
  // misspelled bucket compiled, ran, and dropped its headers in silence.
  //
  // Declared here so both ends are checked against the same names. They are
  // internal to the transport: an application does not write them, which is
  // what the `__` says, and a handler is free to read them.
  __cors?:                Record<string, string>
  __securityHeaders?:     Record<string, string>
  __rateLimit?:           Record<string, string>
  __correlationHeaders?:  Record<string, string>
  __pendingCookies?:      Array<[string, string, Record<string, unknown>]>

  // The status the response actually carried, stashed on the way out so a
  // middleware that already ran `await next()` can log it.
  __status?:              number
}

// ─── Stats ─────────────────────────────────────────────────────────────────
// Pre-allocated integer counters — never create objects on hot path

export interface TransportStats {
  request: {
    total:    number
    get:      number
    post:     number
    put:      number
    patch:    number
    delete:   number
    options:  number
    head:     number
    websocket: number
    file:     number
    blocked:  number
    pending:  number
  }
  response: {
    json:     number
    html:     number
    text:     number
    file:     number
    stream:   number
    redirect: number
    empty:    number
    error:    number
    cached:   number
    sse:      number
  }
  performance: {
    upload:   number   // MB uploaded
    download: number   // MB downloaded
    online:   number   // active WS connections
  }
}

export function createStats(): TransportStats {
  return {
    request: {
      total: 0, get: 0, post: 0, put: 0,
      patch: 0, delete: 0, options: 0, head: 0,
      websocket: 0, file: 0, blocked: 0, pending: 0
    },
    response: {
      json: 0, html: 0, text: 0, file: 0,
      stream: 0, redirect: 0, empty: 0, error: 0, cached: 0, sse: 0
    },
    performance: {
      upload: 0, download: 0, online: 0
    }
  }
}

// ─── WebSocket context ────────────────────────────────────────────────────
// The shape every ws() handler receives — mirrors TransportContext so
// app code never needs to think about which transport it's on.

export interface WsData {
  path:     string
  params:   Record<string, string>
  query:    Record<string, string>
  headers:  Record<string, string>
  ip:       string
  // Resolved during _wsOpen after async auth — null until then.
  // Always set before any user-facing handler is called.
  user:     SessionContext | null
  // Reference to the matched handler set — set at upgrade time so
  // _wsOpen/_wsMessage/_wsClose don't need to re-run route lookup.
  handlers: WsHandlerSet
}

export interface WsContext {
  // Routing
  path:     string
  /** Path-pattern captures. Same word as TransportContext.route — one realm, one name. */
  route:    Record<string, string>

  // Request info — same fields as TransportContext
  query:    Record<string, string>
  headers:  Record<string, string>
  ip:       string
  user:     SessionContext | null

  // Send helpers
  send:  (data: string | object) => void
  close: (code?: number, reason?: string) => void

  // Escape hatch — the raw Bun WebSocket. Use only in transport-layer
  // code (e.g. channels.ts). Never reference in services or hooks.
  $ws: unknown
}

// Handler set registered via app.ws() / http.ws()
export interface WsHandlerSet {
  open?:    (ctx: WsContext) => void | Promise<void>
  message?: (ctx: WsContext, msg: string | Buffer) => void | Promise<void>
  close?:   (ctx: WsContext, code: number, reason: string) => void | Promise<void>
  drain?:   (ctx: WsContext) => void | Promise<void>
}

