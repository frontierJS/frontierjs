// transport/bridge.ts
// The formal handoff point between transport and service layer.
// Nothing above the bridge touches req/res.
// Nothing below the bridge touches the service layer.

import type { TransportContext } from './types.ts'
import { toFrameworkError, FrameworkError, BadRequest, sanitizeError, type ErrorMapperHost } from '../core/errors.ts'
import { accessorCandidates } from '../core/litestone.ts'
import { omitBy } from '@frontierjs/toolbelt/redact'
import { hookContext } from '@frontierjs/toolbelt/hooks'
import {
  CRUD_METHODS, RESERVED_PARAMS, requestMeta, freezeUser, withCallEffects,
  type ServiceContext, type ServiceMethod, type AnyMethod,
  type CallOptions, type QueryDirectives,
} from '../core/context.ts'
import { isServiceResult, unwrapResult } from '../core/envelope.ts'
import { invalidDirectives, listedDirectives, splitParams, transportFlags, unknownDirectives } from '@frontierjs/toolbelt/directives'

// ─── HTTP method → service method map ────────────────────────────────────
// PUT -> update, PATCH -> patch. Both MERGE (`FJS-D179`): Feathers' word for
// update is a full replace and this is not one, so a PUT stating only `title`
// leaves every column it did not name where it was. What the id buys is that a
// REST client's PUT can never reach patch's query path, which is a bulk write.
// A service taking PUT traffic needs an update method; db-backed ones get one.
const METHOD_MAP: Record<string, ServiceMethod> = {
  'GET':    'find',
  'POST':   'create',
  'PUT':    'update',
  'PATCH':  'patch',
  'DELETE': 'remove',
}

// Built-ins no HTTP verb names, so the header is their only address. `upsert`
// is not a CRUD method; it is resolved against the body in toContext.
const HEADER_BUILTINS = new Set<string>(['aggregate', 'restore', 'upsert'])

// CRUD methods that cannot be overridden via X-Service-Method header: the ones
// an HTTP verb already names. Custom method names pass through — callService
// validates existence.
const CRUD_METHOD_BLOCK = new Set<string>(CRUD_METHODS.filter(m => !HEADER_BUILTINS.has(m)))

// ─── Wire `$directive` → structured QueryDirectives ──────────────────────
// This is where the API realm applies the `$` convention, and everything past
// it reads ctx.directives — no prefixes, no strings that mean numbers.
//
// The grammar itself is `@frontierjs/toolbelt/directives`, one level below both
// realms, because Sierra's router applies the same one to a URL's search string
// on the way to `page.query` + `page.directives`. One table, two boundaries.


// ─── Bridge ───────────────────────────────────────────────────────────────


// What a context made outside any app holds as `ctx.app`. One object, not a
// fresh one per call: state a hook keeps per app (a rate limiter's buckets) is
// keyed on it, and a new object each call is a new app each call.
const NO_APP = {} as import('../core/app.ts').App

export const bridge = {

  // ── Transport → ServiceContext ────────────────────────────────────────
  // X-Service-Method header dispatches restore, upsert, and every custom method.
  // CRUD method names are blocked from header override.
  // Strips reserved params ($first, $wrap, etc.) from ctx.query.
  // Merges multipart files into ctx.data as File objects.

  toContext(
    raw:       TransportContext,
    service:   string,
    // The service's own name unless the caller knows better, which is what
    // `service.model ?? service.name` answers everywhere else. Declared
    // required, it said a caller must supply what nothing downstream reads.
    model:     string = service,
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
      serviceMethod = HEADER_BUILTINS.has(headerLower) ? headerLower : rawHeaderMethod
    }

    // ── Routing ────────────────────────────────────────────────────────
    let resolvedMethod: AnyMethod = serviceMethod
    if (serviceMethod === 'find') {
      if (raw.route.id) {
        resolvedMethod = 'get'
      } else if (readTransportFlags(rawQuery).first) {
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
    refuseBadDirectives(rawQuery)

    const { query, directives } = splitParams(rawQuery) as {
      query: Record<string, unknown>
      directives: QueryDirectives
    }

    refuseUnservableWindow(directives)

    // ── The write envelope — `{ data, base }` under a flag ─────────────
    // A base is a ROW, so it cannot ride a header the way an idempotency key
    // does, and a write's body already IS its data — so a caller carrying one
    // flags the body and puts both inside (`FJS-D338`). FLAGGED rather than
    // sniffed: a row may legitimately hold a `data` key of its own, so the
    // shape cannot answer whether it is an envelope.
    //
    // Absent flag means the body is the data, exactly as before, so nothing
    // already on the wire changes meaning.
    const enveloped = (raw.headers?.['x-fjs-write'] ?? '').trim().toLowerCase() === 'enveloped'
    let envelopeBase: Record<string, unknown> | null = null
    let envelopeBody = raw.body
    if (enveloped) {
      const b = raw.body as Record<string, unknown> | null
      // Refused by name rather than read as data. An envelope that is not one
      // would otherwise arrive as a record with a `data` column, be refused by
      // validation for the wrong reason, and name a field nobody wrote.
      if (!b || typeof b !== 'object' || Array.isArray(b) || !('data' in b))
        throw new BadRequest(
          'This request is flagged as an enveloped write (X-Fjs-Write: enveloped) and its body is not ' +
          'one: an enveloped body is { data, base }, where base is the row as the writer read it.')
      envelopeBody = b.data as TransportContext['body']
      const rawBase = b.base
      envelopeBase  = rawBase && typeof rawBase === 'object' && !Array.isArray(rawBase)
        ? rawBase as Record<string, unknown>
        : null
    }

    // ── Build ctx.data — merge body + multipart files ──────────────────
    const data = (() => {
      // An ARRAY body is a bulk write and must survive as an array.
      // `{ ...[a, b] }` produces `{ 0: a, 1: b }`, so a bulk POST arrived at
      // the service as one malformed record with numeric keys — Array.isArray
      // was false, the bulk branch never ran, and the service created a single
      // row out of the indices. Bulk create over HTTP could not work.
      // (Files are multipart, which is never an array body.)
      if (Array.isArray(envelopeBody)) return envelopeBody as Record<string, unknown>[]

      const body: Record<string, unknown> =
        envelopeBody && typeof envelopeBody === 'object'
          ? { ...envelopeBody as Record<string, unknown> }
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

    return withCallEffects(hookContext({
      service:   service,
      method:    finalMethod,
      type:      'before',
      transport,
      model,
      id:        raw.route.id ?? null,
      query,
      directives,
      data,
      base: envelopeBase,
      auth: {
        user: raw.user,
      },
      caller: {
        ip:        raw.ip,
        userAgent: raw.headers?.['user-agent'],
        headers:   raw.headers,
      },
      route:  { ...raw.route },   // path-pattern captures — same word both sides
      locals: {},
      transients: {},             // filled by autoValidate, from what the model declares
      reserved:   {},             // filled by callService, from what the service reserved
      app:       appRef ?? NO_APP,
      result:    null,
      error:     null,
      statusCode: undefined,
      dispatch:   undefined,
      $raw:      raw
    }))
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
    if (ctx.error) return errorResponse(ctx.error, ctx)

    const result = ctx.result

    if (result === null || result === undefined) {
      return new Response(null, { status: ctx.statusCode ?? 204 })
    }

    const status = ctx.statusCode ?? (ctx.method === 'create' ? 201 : 200)

    // The framework's one rule, stated once: a list keeps its envelope (it
    // carries total/limit/offset, which have nowhere else to live), a single
    // unwraps to the record. $wrap=true opts a single into the envelope too.
    //
    // Branching on `kind` rather than `object === 'list'` — `object` is now
    // always the service name, so a service literally named 'list' no longer
    // changes how its singles serialize.
    return jsonResponse(
      withholdProtected(unwrapResult(result, {
        single: rawWrap === true  ? 'envelope' : 'data',
        list:   rawWrap === false ? 'data'     : 'envelope',
      }), ctx),
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
    const { query = {}, auth, transport = 'internal', locals, directives, base = null } = opts
    // An internal caller may still hand us a `$`-spelled query (older code,
    // and tests that predate ctx.directives). Translate rather than ignore:
    // explicit opts.directives wins, `$` keys are the fallback.
    refuseBadDirectives(query)

    const { query: filters, directives: fromQuery } = splitParams(query) as {
      query: Record<string, unknown>
      directives: QueryDirectives
    }
    // The same refusal toContext makes, so a negative count is not floored to
    // no rows with a 200 on the in-process and socket paths.
    const merged = { ...fromQuery, ...directives }
    refuseUnservableWindow(merged)
    return withCallEffects(hookContext({
      service,
      method,
      type:      'before',
      transport,
      model:     service,
      id:        (data as Record<string, unknown>)?.id as string ?? null,
      query:      filters,
      directives: merged,
      data,
      base,
      auth: {
        // Shared frozen reference — same immutability guarantee the old
        // per-call structuredClone gave, without deep-clone cost on every
        // internal call (see freezeUser).
        user: auth?.user ? freezeUser(auth.user) : null,
      },
      caller: {
        headers: {},
      },
      route:  {},
      locals: locals ? { ...locals } : {},   // fresh; explicit seed only
      transients: {},
      reserved:   {},
      app:       appRef ?? NO_APP,
      result:    null,
      error:     null,
      statusCode: undefined,
      dispatch:   undefined,
      $raw:      null
    }))
  }

}

// ─── What may be said about a failure ─────────────────────────────────────
//
// The rule is `sanitizeError`'s; this is the half that only the transport can
// answer — WHICH model this call was about, so the Data boundary can be asked
// which of its columns must never be written down. `accessorCandidates` is the
// one owner of `orders` ⇄ `Order` (Invariant 2), and `$protectedFields`
// answers `{}` for an accessor it does not know, so a service over no model
// costs one empty lookup.
function boundaryOptions(ctx?: ServiceContext) {
  const app = ctx?.app as {
    config?: { debug?: boolean }
    logger?: { error?: (m: string, meta?: unknown) => void }
  } | undefined

  return {
    protectedFields: protectedFieldsFor(ctx),
    correlationId:   requestMeta()?.correlationId,
    debug:           app?.config?.debug,
    logger:          app?.logger ?? null,
  }
}

/*
 * A success body with every protected column of the call's model DROPPED.
 *
 * A method that writes through `asSystem()` and returns what it wrote answered
 * a stranger with the DECRYPTED `@secret`, while `GET` of the same row omitted
 * it (`FJS-1221`). Each layer was right on its own: a system client returns the
 * column by design, and the method returned what it was handed. So the wire is
 * where it is answered, with the error path's own list, and dropped rather than
 * `[redacted]` so the body has the shape a caller-scoped read of the row has
 * (`FJS-D473`).
 *
 * Every wire calls this -- HTTP here, the socket's `service_result`, an MCP tool
 * result -- and an in-process `app.service()` does not, because that caller is
 * the app. By key name, so a method meaning to hand back a protected value once
 * (a freshly minted token) returns it under a key that is not a column's name.
 */
export function withholdProtected(value: unknown, ctx?: Pick<ServiceContext, 'locals' | 'model' | 'service'>): unknown {
  const fields = protectedFieldsFor(ctx as ServiceContext)
  if (!Object.keys(fields).length) return value
  const omit = (v: unknown) => omitBy(v, (k) => Object.hasOwn(fields, k))
  // An envelope's `data` is the answer, not a column. Walked by key name, a
  // model with a protected column called `data` answered every list with the
  // rows removed and `total` still counting them.
  if (isServiceResult(value)) {
    const { data, ...envelope } = value
    return { ...(omit(envelope) as object), data: omit(data) }
  }
  return omit(value)
}

/** The body `errorResponse` writes -- for a wire that is not a `Response`. */
export function errorBody(err: unknown, ctx?: ServiceContext): ReturnType<FrameworkError['toJSON']> {
  return sanitizeError(toFrameworkError(err, ctx?.app), boundaryOptions(ctx)).toJSON()
}

function protectedFieldsFor(ctx?: ServiceContext): Record<string, string> {
  const db = ctx?.locals?.db as { $protectedFields?: (a: string) => Record<string, string> } | undefined
  // A client that throws on a name it does not know answers the probe itself,
  // and this runs on every success body, so a throw here is a 500 on every read.
  let lookup: unknown
  try { lookup = db?.$protectedFields } catch { return {} }
  if (typeof lookup !== 'function') return {}
  const fieldsOf = (lookup as (a: string) => Record<string, string>).bind(db)

  const out: Record<string, string> = {}
  for (const name of [ctx?.model, ctx?.service]) {
    if (!name) continue
    for (const accessor of accessorCandidates(name)) {
      try { Object.assign(out, fieldsOf(accessor)) } catch { /* an unknown accessor is not a failure */ }
    }
  }
  return out
}

// ─── A window that cannot be served ───────────────────────────────────────
//
// A negative `$limit` reaches SQLite as `LIMIT -1`, which SQLite reads as NO
// limit — so the one directive a paginated endpoint exists to bound became the
// way past the bound, unauthenticated (`FJS-683`). `clampPage` floors it now,
// but a clamp answers a caller who stated something impossible with silence.
// Refused by NAME here, where the `$` convention is already owned, in the same
// shape `$checkWhere` refuses a filter key it cannot honor.
//
// Only a stated negative NUMBER is refused here; a value that is not decimal
// digits at all never reaches this check, `invalidDirectives` refused it.
/*
 * A `$` name the wire does not know is refused, and the refusal names it.
 *
 * `$limitt=10` used to be a WHERE on a column nobody declared, which the Data
 * boundary reported three layers from the cause (`FJS-988`); it is dropped now,
 * and dropping is what this replaces — the caller asked for ten rows, got the
 * default page and a 200, and nothing said why.
 *
 * The BRIDGE refuses and sierra's router does not, which is § IV *ergonomics vs.
 * strictness* resolved per surface by what a mistake destroys: here a typo costs
 * the correctness of the answer and a refusal costs a retry, while in a router a
 * refusal destroys the navigation and a half-loaded page is worse than a missing
 * `$limit` (`FJS-D237`).
 *
 * The list of names comes from the toolbelt table rather than from here. A copy
 * would go stale on the next directive added, which is the exact failure that
 * table was built to end.
 */
export function refuseBadDirectives(params: unknown): void {
  // Every check below grades a `$` key, and most calls carry none; the three
  // table walks ran on every request regardless (`FJS-2992`).
  if (!params || typeof params !== 'object') return
  let dollar = false
  for (const key in params) if (key[0] === '$') { dollar = true; break }
  if (!dollar) return
  refuseListedDirectives(params)
  refuseInvalidFlags(params)
  const unknown = unknownDirectives(params as Record<string, unknown>)
  if (!unknown.length) return

  const available = [...RESERVED_PARAMS].sort()
  const plural = unknown.length > 1
  throw new BadRequest(
    `${unknown.join(', ')} ${plural ? 'are not directives' : 'is not a directive'} this API knows. ` +
    `A '$' name is transport syntax, so it cannot fall through and be read as a filter either — ` +
    `the call is refused rather than answered as if it had been applied. ` +
    `Case matters: ${available.join(', ')}.`,
    { directives: unknown, available }
  )
}

/**
 * A single-valued directive given a list. The filter half makes a repeated key a
 * list by design; read as one value it fell to the default page with a 200.
 */
function refuseListedDirectives(params: unknown): void {
  const listed = listedDirectives(params as Record<string, unknown>)
  if (!listed.length) return
  throw new BadRequest(
    `${listed.join(', ')} ${listed.length > 1 ? 'take' : 'takes'} one value, and was given a list. ` +
    `Send the key once.`,
    { directives: listed }
  )
}

/**
 * A flag or a count, directive or transport, given a value its grammar does not
 * hold. Read as false it would answer 200 without the rows `?$withDeleted=yes`
 * asked for (`FJS-2476`); `?$limit=true` read as 1 answers a one-row page
 * (`FJS-2459`).
 */
function refuseInvalidFlags(params: unknown): void {
  const bag = params as Record<string, unknown>
  refuseFlagValues(bag, [...invalidDirectives(bag), ...transportFlags(bag).invalid])
}

function refuseFlagValues(bag: Record<string, unknown>, invalid: string[]): void {
  if (!invalid.length) return
  throw new BadRequest(
    `${invalid.map(k => `${k}=${String(bag[k])}`).join(', ')} is not a value ${invalid.length > 1 ? 'they take' : 'it takes'}. ` +
    `A flag is true, 1, false or 0 (or written bare, which is true); a count is decimal digits.`,
    { directives: invalid }
  )
}

/**
 * `$first` / `$wrap` off the raw query, refusing a value the flag grammar does
 * not hold. The only reader of either on this side of the wire.
 */
export function readTransportFlags(params: unknown): { first?: boolean, wrap?: boolean } {
  const { first, wrap, invalid } = transportFlags(params as Record<string, unknown>)
  refuseFlagValues(params as Record<string, unknown>, invalid)
  return { first, wrap }
}

function refuseUnservableWindow(directives: QueryDirectives): void {
  for (const name of ['limit', 'offset'] as const) {
    const value = directives[name]
    if (value === undefined || value === null) continue
    const n = Number(value)
    if (Number.isFinite(n) && n < 0) {
      throw new BadRequest(
        `$${name} must be zero or greater (got ${n}).`,
        { directive: `$${name}`, value: n }
      )
    }
    // A count is whole. SQLite refuses `LIMIT 1.5` at prepare, so a fraction
    // otherwise surfaces as a 500 datatype mismatch.
    if (Number.isFinite(n) && !Number.isInteger(n)) {
      throw new BadRequest(
        `$${name} must be a whole number (got ${n}).`,
        { directive: `$${name}`, value: n }
      )
    }
  }
}

// ─── Response helpers ─────────────────────────────────────────────────────

/** What a JSON answer carries until the transport decides better. The
 *  transport replaces exactly this and keeps any other a handler set
 *  (`FJS-1662`), so it is named rather than repeated. */
export const BAKED_CACHE_CONTROL = 'private, no-cache, no-store, max-age=0'

const JSON_HEADERS = {
  'content-type':  'application/json',
  'cache-control': BAKED_CACHE_CONTROL,
  'vary':          'Accept-Encoding'
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS
  })
}

// `host` is for a failure before any service context exists (a bad query, a raw
// route's throw), where the transport holds the app's mappers and no app.
export function errorResponse(err: unknown, ctx?: ServiceContext, host?: ErrorMapperHost): Response {
  const fe     = sanitizeError(toFrameworkError(err, host ?? ctx?.app), boundaryOptions(ctx))
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
