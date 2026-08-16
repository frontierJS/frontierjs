// transport/bridge.ts
// The formal handoff point between transport and service layer.
// Nothing above the bridge touches req/res.
// Nothing below the bridge touches the service layer.

import type { TransportContext } from './types.ts'
import { toFrameworkError, FrameworkError } from '../core/errors.ts'

// ─── Context types — moved to core (core/context.ts) ─────────────────────
// The service layer's vocabulary (ServiceContext, ServiceResult, hook and
// method types, request meta, freezeUser) is owned by core; this module
// re-exports it so existing `from '.../transport/bridge.ts'` imports keep
// working unchanged.
import {
  RESERVED_PARAMS, runWithMeta, requestMeta, freezeUser,
  type ServiceContext, type ServiceContextLocals, type ServiceResult,
  type ServiceMethod, type AnyMethod, type HookType,
  type CallOptions, type RequestMeta, type QueryDirectives,
} from '../core/context.ts'
import { isListResult, unwrapResult } from '../core/envelope.ts'
import { splitParams } from '@frontierjs/toolbelt/directives'

export {
  RESERVED_PARAMS, runWithMeta, requestMeta, freezeUser,
}
export type {
  ServiceContext, ServiceContextLocals, ServiceResult,
  ServiceMethod, AnyMethod, HookType,
  CallOptions, RequestMeta,
}

// ─── HTTP method → service method map ────────────────────────────────────
// REST/Feathers semantics: PUT = full replace (update), PATCH = merge
// (patch). PUT mapped to patch before update() existed; services that take
// PUT traffic need an update method (db-backed services get one for free).
const METHOD_MAP: Record<string, ServiceMethod> = {
  'GET':    'find',
  'POST':   'create',
  'PUT':    'update',
  'PATCH':  'patch',
  'DELETE': 'remove',
}

// CRUD methods that cannot be overridden via X-Service-Method header.
// Custom method names pass through — callService validates existence.
const CRUD_METHOD_BLOCK = new Set(['find', 'get', 'create', 'update', 'patch', 'remove'])

// ─── Wire `$directive` → structured QueryDirectives ──────────────────────
// This is where the API realm applies the `$` convention, and everything past
// it reads ctx.directives — no prefixes, no strings that mean numbers.
//
// The grammar itself is `@frontierjs/toolbelt/directives`, one level below both
// realms, because Sierra's router applies the same one to a URL's search string
// on the way to `page.query` + `page.directives`. One table, two boundaries.


// ─── Bridge ───────────────────────────────────────────────────────────────

export const bridge = {

  // ── Transport → ServiceContext ────────────────────────────────────────
  // X-Service-Method header dispatches restore, upsert, and every custom method.
  // CRUD method names are blocked from header override.
  // Strips reserved params ($first, $wrap, etc.) from ctx.query.
  // Merges multipart files into ctx.data as File objects.

  toContext(
    raw:       TransportContext,
    service:   string,
    model:     string,
    transport: 'http' | 'websocket' | 'internal' = 'http',
    appRef?:   import('../core/app.ts').App
  ): ServiceContext {

    const httpMethod = raw.method.toUpperCase()
    const rawQuery   = raw.query as Record<string, unknown> ?? {}

    // ── X-Service-Method header — whitelist only ──────────────────────
    // Case is preserved for custom methods (getStats stays getStats — the
    // old blanket toLowerCase() made every camelCase method a guaranteed
    // 404). Built-ins (restore/upsert) and the CRUD block-list still match
    // case-insensitively.
    const rawHeaderMethod = (raw.headers?.['x-service-method'] ?? '').trim()
    const headerLower     = rawHeaderMethod.toLowerCase()
    let serviceMethod: AnyMethod = METHOD_MAP[httpMethod] ?? 'find'

    if (rawHeaderMethod && !CRUD_METHOD_BLOCK.has(headerLower)) {
      serviceMethod = (headerLower === 'upsert' || headerLower === 'restore')
        ? headerLower
        : rawHeaderMethod
    }

    // ── Routing ────────────────────────────────────────────────────────
    let resolvedMethod: AnyMethod = serviceMethod
    if (serviceMethod === 'find') {
      if (raw.route.id) {
        resolvedMethod = 'get'
      } else if (rawQuery.$first) {
        resolvedMethod = 'get'
      }
    }

    // ── Split the query string in two — single pass ────────────────────
    // `$`-prefixed keys are DIRECTIVES (how to shape the result); everything
    // else is a FILTER (which records). The bridge is the only place that
    // knows about the `$` convention — it is wire syntax, not a data model.
    //
    // This used to only strip the reserved keys and throw them away, while
    // parseQuery downstream looked for those exact keys on ctx.query. The
    // transport deleted precisely what the query builder was written to read,
    // so $limit / $offset / $orderBy / $select were all silently inert.
    const { query, directives } = splitParams(rawQuery) as {
      query: Record<string, unknown>
      directives: QueryDirectives
    }

    // ── Build ctx.data — merge body + multipart files ──────────────────
    const data = (() => {
      // An ARRAY body is a bulk write and must survive as an array.
      // `{ ...[a, b] }` produces `{ 0: a, 1: b }`, so a bulk POST arrived at
      // the service as one malformed record with numeric keys — Array.isArray
      // was false, the bulk branch never ran, and the service created a single
      // row out of the indices. Bulk create over HTTP could not work.
      // (Files are multipart, which is never an array body.)
      if (Array.isArray(raw.body)) return raw.body as Record<string, unknown>[]

      const body: Record<string, unknown> =
        raw.body && typeof raw.body === 'object'
          ? { ...raw.body as Record<string, unknown> }
          : {}

      if (raw.files?.length) {
        for (const f of raw.files) {
          body[f.name] = new File([f.data], f.filename, { type: f.type })
        }
      }

      return Object.keys(body).length > 0 ? body : null
    })()

    // ── Upsert routing ─────────────────────────────────────────────────
    // POST + X-Service-Method: upsert → inspect data.id
    // data.id != null → patch (200), data.id == null → create (201)
    // ctx.method is rewritten immediately — no upsert hook slot.
    let finalMethod = resolvedMethod
    if (serviceMethod === 'upsert') {
      finalMethod = (data as Record<string, unknown>)?.id != null ? 'patch' : 'create'
    }

    return {
      service:   service,
      method:    finalMethod,
      type:      'before',
      transport,
      model,
      id:        raw.route.id ?? null,
      query,
      directives,
      data,
      auth: {
        user: raw.user,
      },
      client: {
        ip:        raw.ip,
        userAgent: raw.headers?.['user-agent'],
        headers:   raw.headers,
      },
      route:  { ...raw.route },   // path-pattern captures — same word both sides
      locals: {},
      app:       appRef ?? ({} as import('../core/app.ts').App),
      result:    null,
      error:     null,
      statusCode: undefined,
      dispatch:   undefined,
      $raw:      raw
    }
  },

  // ── ServiceContext → HTTP Response ────────────────────────────────────
  // Singles unwrapped by default. Lists always envelope.
  // $wrap=true opts singles into the envelope.

  /**
   * ServiceContext → HTTP Response.
   *
   * `wrap` is tri-state, mirroring `$wrap` on the wire:
   *   undefined → the default rule
   *   true      → envelope everything, singles included
   *   false     → unwrap everything, lists included (bare array)
   */
  toResponse(ctx: ServiceContext, rawWrap?: boolean): Response {
    if (ctx.error) return errorResponse(ctx.error)

    const result = ctx.result

    if (result === null || result === undefined) {
      return new Response(null, { status: ctx.statusCode ?? 204 })
    }

    if (result instanceof Response) return result

    const status = ctx.statusCode ?? (ctx.method === 'create' ? 201 : 200)

    // The framework's one rule, stated once: a list keeps its envelope (it
    // carries total/limit/offset, which have nowhere else to live), a single
    // unwraps to the record. $wrap=true opts a single into the envelope too.
    //
    // Branching on `kind` rather than `object === 'list'` — `object` is now
    // always the service name, so a service literally named 'list' no longer
    // changes how its singles serialize.
    return jsonResponse(
      unwrapResult(result, {
        single: rawWrap === true  ? 'envelope' : 'data',
        list:   rawWrap === false ? 'data'     : 'envelope',
      }),
      status
    )
  },

  // ── Internal service call context ────────────────────────────────────
  // opts carries only what you VARY per call. auth is deep-cloned
  // (frozen-propagates), locals starts fresh {} (never inherits the
  // caller's — this is what kills the shared-mutation footgun).
  // Request-wide metadata (correlation/idempotency/locale) is NOT here
  // — it rides the AsyncLocalStorage store and is read via requestMeta().

  internal(
    service: string,
    method:  ServiceMethod,
    data:    Record<string, unknown> | null = null,
    opts:    CallOptions & { query?: Record<string, unknown> } = {},
    appRef?: import('../core/app.ts').App
  ): ServiceContext {
    const { query = {}, auth, transport = 'internal', locals, directives } = opts
    // An internal caller may still hand us a `$`-spelled query (older code,
    // and tests that predate ctx.directives). Translate rather than ignore:
    // explicit opts.directives wins, `$` keys are the fallback.
    const { query: filters, directives: fromQuery } = splitParams(query) as {
      query: Record<string, unknown>
      directives: QueryDirectives
    }
    return {
      service,
      method,
      type:      'before',
      transport,
      model:     service,
      id:        (data as Record<string, unknown>)?.id as string ?? null,
      query:      filters,
      directives: { ...fromQuery, ...directives },
      data,
      auth: {
        // Shared frozen reference — same immutability guarantee the old
        // per-call structuredClone gave, without deep-clone cost on every
        // internal call (see freezeUser).
        user: auth?.user ? freezeUser(auth.user) : null,
      },
      client: {
        headers: {},
      },
      route:  {},
      locals: locals ? { ...locals } : {},   // fresh; explicit seed only
      app:       appRef ?? ({} as import('../core/app.ts').App),
      result:    null,
      error:     null,
      statusCode: undefined,
      dispatch:   undefined,
      $raw:      null
    }
  }

}

// ─── Response helpers ─────────────────────────────────────────────────────

const JSON_HEADERS = {
  'content-type':  'application/json',
  'cache-control': 'private, no-cache, no-store, max-age=0',
  'vary':          'Accept-Encoding'
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  })
}

export function errorResponse(err: unknown): Response {
  const fe     = toFrameworkError(err)
  const status = fe.code ?? 500

  return new Response(JSON.stringify(fe.toJSON()), {
    status,
    headers: JSON_HEADERS
  })
}

export function redirectResponse(url: string, status = 302): Response {
  return new Response(null, {
    status,
    headers: { location: url }
  })
}
