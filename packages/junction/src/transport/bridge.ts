// transport/bridge.ts
// The formal handoff point between transport and service layer.
// Nothing above the bridge touches req/res.
// Nothing below the bridge touches the service layer.

import type { TransportContext } from './types.ts'
import { toFrameworkError, FrameworkError } from '../core/errors.ts'

// ─── Context shape ────────────────────────────────────────────────────────
// What every hook and service method sees. Single object throughout the pipeline.

export interface ServiceContext {
  // ── routing ──────────────────────────────────────────────────────────
  service:   string
  method:    AnyMethod     // 'find'|'get'|'create'|'patch'|'remove'|'restore'|custom
  type:      HookType      // set by hook pipeline
  transport: 'http' | 'websocket' | 'internal'
  model:     string        // set by createService from ServiceDefinition.name

  // ── call inputs ───────────────────────────────────────────────────────
  id:    string | number | null
  // query is top-level — NOT params.query.
  // Reserved params ($limit $offset $orderBy $select $first $wrap) are
  // stripped by the bridge before reaching service methods.
  query: Record<string, unknown>
  data:  Record<string, unknown> | Record<string, unknown>[] | null

  // ── ambient context ────────────────────────────────────────────────────
  params: {
    user:    import('../auth/types.ts').SessionContext | null
    headers: Record<string, string>
    ip:      string
    [key: string]: unknown   // hooks and plugins attach here (db, workspace, etc.)
  }

  // ── app reference ─────────────────────────────────────────────────────
  app: import('../core/app.ts').App

  // ── lifecycle ─────────────────────────────────────────────────────────
  // result is null in before hooks. Populated envelope in after hooks.
  result:  ServiceResult | null
  error:   FrameworkError | null

  // ── HTTP-specific ─────────────────────────────────────────────────────
  statusCode?: number          // override HTTP status
  dispatch?:   unknown | false // separate payload for real-time broadcast; false = suppress

  // escape hatch — never use in services or hooks
  $raw: TransportContext | null

  // instrumentation — set by callService, undefined for bypass (_find etc.)
  telemetryId?: string

  // cleanup callbacks — called in callService finally block after pipeline completes
  // used by litestone tap and any other per-request teardown
  _cleanups?: Array<() => void>
}

// ─── Hook type ────────────────────────────────────────────────────────────
export type HookType = 'before' | 'after' | 'around' | 'error'

// ─── Result envelope ──────────────────────────────────────────────────────
// Consistent shape in all after hooks regardless of method.
// object = model name for singles (e.g. 'lead'), 'list' for collections.
// errors carries partial failures for bulk ops only — always [] for non-bulk.
export interface ServiceResult {
  object:  string
  data:    unknown | unknown[]
  errors:  unknown[]
  total?:  number   // paginated find only
  limit?:  number
  offset?: number
}

export type ServiceMethod = 'find' | 'get' | 'create' | 'patch' | 'remove' | 'restore'
export type AnyMethod     = ServiceMethod | string

// ─── Reserved query params ────────────────────────────────────────────────
// Stripped from ctx.query before reaching Litestone / service methods.
// $first and $wrap are transport-only — never reach service layer.
export const RESERVED_PARAMS = new Set([
  '$limit', '$offset', '$orderBy', '$select', '$first', '$wrap'
])

// ─── HTTP method → service method map ────────────────────────────────────
const METHOD_MAP: Record<string, ServiceMethod> = {
  'GET':    'find',
  'POST':   'create',
  'PUT':    'patch',
  'PATCH':  'patch',
  'DELETE': 'remove',
}

// CRUD methods that cannot be overridden via X-Service-Method header.
// Custom action names pass through — callService validates existence.
const CRUD_METHOD_BLOCK = new Set(['find', 'get', 'create', 'patch', 'remove'])


// ─── Bridge ───────────────────────────────────────────────────────────────

export const bridge = {

  // ── Transport → ServiceContext ────────────────────────────────────────
  // X-Service-Method header dispatches restore, upsert, and all custom actions.
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
    const headerMethod = (raw.headers?.['x-service-method'] ?? '').toLowerCase()
    let serviceMethod: AnyMethod = METHOD_MAP[httpMethod] ?? 'find'

    if (headerMethod && !CRUD_METHOD_BLOCK.has(headerMethod)) {
      serviceMethod = headerMethod
    }

    // ── Routing ────────────────────────────────────────────────────────
    let resolvedMethod: AnyMethod = serviceMethod
    if (serviceMethod === 'find') {
      if (raw.params.id) {
        resolvedMethod = 'get'
      } else if (rawQuery.$first) {
        resolvedMethod = 'get'
      }
    }

    // ── Strip reserved params from ctx.query — single pass ─────────────
    const query: Record<string, unknown> = {}
    for (const k in rawQuery) {
      if (!RESERVED_PARAMS.has(k)) query[k] = rawQuery[k]
    }

    // ── Build ctx.data — merge body + multipart files ──────────────────
    const data = (() => {
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
      id:        raw.params.id ?? null,
      query,
      data,
      params: {
        headers: raw.headers,
        ip:      raw.ip,
        user:    raw.user,
      },
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

  toResponse(ctx: ServiceContext, rawWrap?: boolean): Response {
    if (ctx.error) return errorResponse(ctx.error)

    const result = ctx.result

    if (result === null || result === undefined) {
      return new Response(null, { status: ctx.statusCode ?? 204 })
    }

    if (result instanceof Response) return result

    const status = ctx.statusCode ?? (ctx.method === 'create' ? 201 : 200)

    // List — always envelope
    if (result.object === 'list') {
      return jsonResponse(result, status)
    }

    // Single — unwrap by default, envelope if $wrap requested
    if (rawWrap) {
      return jsonResponse(result, status)
    }

    return jsonResponse(result.data, status)
  },

  // ── Internal service call context ────────────────────────────────────

  internal(
    service: string,
    method:  ServiceMethod,
    data:    Record<string, unknown> | null = null,
    params:  Partial<ServiceContext['params']> & { query?: Record<string, unknown> } = {},
    appRef?: import('../core/app.ts').App
  ): ServiceContext {
    const { query = {}, ...restParams } = params
    return {
      service,
      method,
      type:      'before',
      transport: 'internal',
      model:     service,
      id:        (data as Record<string, unknown>)?.id as string ?? null,
      query,
      data,
      params: {
        headers: {},
        ip:      '127.0.0.1',
        user:    null,
        ...restParams,
      },
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
