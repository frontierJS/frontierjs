// core/envelope.ts
// The result envelope — one module, one owner.
//
// `{ kind, object, data, errors, total?, limit?, offset? }` is the framework's
// most-travelled shape. It used to be built in one place and taken apart in
// TWELVE others, each with its own idea of the rules:
//
//   bridge.toResponse   list → keep whole, single → unwrap unless $wrap
//   app.service()       flat .data — silently dropped total/limit/offset
//   callService         flat .data, for auto-events
//   channels.publish    list → keep, else .data ?? raw   ("mirror HTTP bridge")
//   channels ws handler the same rule, hand-copied
//   client find()       flat .data — browser could not paginate either
//   client resource()   flat .data
//   hooks-builtin       'object' in result
//   devtools            result.object === 'list'
//   service.ts          'object' in raw, to detect an already-wrapped value
//
// They had already drifted: the same find() returned a full envelope over HTTP
// and a bare array to internal and browser callers, so `total` was reachable
// from curl and from nowhere else. The July password leak came from the same
// root — protect() stripped fields off the WRAPPER instead of the record,
// because "the result" meant two different things in two files.
//
// Detection used to be `'object' in value`, which is true of any object with an
// `object` key — a record with a column called `object` was indistinguishable
// from an envelope. isServiceResult() checks the discriminant instead.

// ─── Shape ────────────────────────────────────────────────────────────────

/** Discriminant. `single` carries one record, `list` carries an array. */
export type ResultKind = 'single' | 'list'

export interface ServiceResult<T = unknown> {
  /**
   * What this envelope holds. THE field to branch on — every consumer used to
   * infer it, each slightly differently (`object === 'list'`, `Array.isArray`,
   * `'data' in x`). Now it is stated.
   */
  kind:    ResultKind
  /**
   * The service that produced it — 'posts', not 'Post' and not 'list'.
   * Stable across both kinds, so a client can key a cache or a type off it
   * without first working out which kind it is holding.
   */
  object:  string
  data:    T
  /** Partial failures, for bulk writes. Always [] otherwise. */
  errors:  unknown[]

  // Pagination — `list` only, and only when the source paginated.
  total?:  number
  limit?:  number
  offset?: number
}

export type ListResult<T = unknown>   = ServiceResult<T[]>   & { kind: 'list' }
export type SingleResult<T = unknown> = ServiceResult<T>     & { kind: 'single' }

// ─── Guard ────────────────────────────────────────────────────────────────

/**
 * True only for a real envelope.
 *
 * Deliberately strict: it tests the discriminant AND that `data` is present,
 * so a plain record that happens to carry an `object` or `data` column is not
 * mistaken for one. The loose `'object' in value` check it replaces would
 * classify `{ object: 'satellite' }` — a perfectly ordinary row — as an
 * envelope and hand the caller its `data` (undefined) instead of the row.
 */
export function isServiceResult<T = unknown>(value: unknown): value is ServiceResult<T> {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (v.kind === 'single' || v.kind === 'list')
    && 'data'   in v
    && 'object' in v
}

/** True for a list envelope specifically. */
export function isListResult<T = unknown>(value: unknown): value is ListResult<T> {
  return isServiceResult(value) && value.kind === 'list'
}

// ─── Constructors ─────────────────────────────────────────────────────────
// Use these rather than object literals. A hook that short-circuits by setting
// ctx.result (caching, custom actions, stubs) has to produce a well-formed
// envelope, and hand-rolling one is how fields go missing.

export function single<T>(object: string, data: T, errors: unknown[] = []): SingleResult<T> {
  return { kind: 'single', object, data, errors }
}

export function list<T>(
  object: string,
  data:   T[],
  meta:   { total?: number; limit?: number; offset?: number } = {},
  errors: unknown[] = []
): ListResult<T> {
  const out: ListResult<T> = { kind: 'list', object, data, errors }
  if (meta.total  !== undefined) out.total  = meta.total
  if (meta.limit  !== undefined) out.limit  = meta.limit
  if (meta.offset !== undefined) out.offset = meta.offset
  return out
}

// ─── Wrap ─────────────────────────────────────────────────────────────────

/**
 * Raw service-method output → envelope.
 *
 * Paginated find  → list + total/limit/offset
 * Array           → list (bulk patch/remove, unpaginated find)
 * Anything else   → single
 */
export function wrapResult(raw: unknown, object: string): ServiceResult {
  // Paginated find — { total, limit, offset|skip, data: [...] }
  // Partial bulk write — { data: [...], errors: [{ data, error }, …] }
  if (
    raw !== null &&
    typeof raw === 'object' &&
    'data' in (raw as object) &&
    ('total' in (raw as object) || 'errors' in (raw as object))
  ) {
    const p = raw as {
      total?: number; limit?: number; offset?: number; skip?: number
      data: unknown[]; errors?: unknown[]
    }
    // Canonical pagination field is `offset`; `skip` accepted from services
    // written Feathers-style so it isn't silently dropped.
    return list(object, p.data, {
      total:  p.total,
      limit:  p.limit,
      offset: p.offset ?? p.skip,
    }, p.errors ?? [])
  }

  if (Array.isArray(raw)) return list(object, raw)

  return single(object, raw)
}

// ─── Partial failure ──────────────────────────────────────────────────────

/**
 * One failed record in a bulk write.
 *
 * The pairing is the point: `data` is the input that failed and `error` is why,
 * so a caller can tell WHICH of fifty rows was rejected rather than being told
 * "some subset broke". This is the shape Feathers' 2017 envelope proposal
 * (issue #562) specified and never shipped — the migration cost across its
 * ecosystem killed it. Junction had no such lock-in.
 */
export interface BulkFailure {
  data:  unknown
  error: { name: string; message: string; code?: number }
}

/**
 * Where a validation hook parks rows it rejected, for the service to report.
 *
 * Validation runs as a `before` hook and a bulk write is decided in the method,
 * so the two need a channel. Without one, validating element-wise meant the
 * FIRST bad row threw a 400 and partial success was unreachable — the most
 * obvious bulk case (one malformed row out of fifty) could never succeed
 * partially, which is the entire point of the feature.
 */
export const BULK_FAILURES = '__bulkFailures'

/**
 * Validate each row, keeping the good ones and parking the rest.
 *
 * Returns the rows that passed. Failures are appended to
 * `ctx.locals[BULK_FAILURES]` — appended, not replaced, so gate/validate/custom
 * hooks can each contribute without clobbering one another.
 */
export function partitionBulk<T>(
  ctx:   { locals: Record<string, unknown> },
  rows:  T[],
  parse: (row: T) => T
): T[] {
  const valid: T[] = []
  const failures = (ctx.locals[BULK_FAILURES] as BulkFailure[] | undefined) ?? []

  for (const row of rows) {
    try   { valid.push(parse(row)) }
    catch (err) { failures.push(toBulkFailure(row, err)) }
  }

  ctx.locals[BULK_FAILURES] = failures
  return valid
}

export function toBulkFailure(data: unknown, err: unknown): BulkFailure {
  const e = err as { name?: string; message?: string; code?: number }
  return {
    data,
    error: {
      name:    e?.name    ?? 'Error',
      message: e?.message ?? String(err),
      ...(typeof e?.code === 'number' ? { code: e.code } : {}),
    },
  }
}

// ─── Unwrap ───────────────────────────────────────────────────────────────

export interface UnwrapOptions {
  /**
   * What a `list` envelope becomes.
   *
   *   'envelope' — keep it whole, so total/limit/offset survive (default)
   *   'data'     — just the rows
   */
  list?: 'envelope' | 'data'
  /**
   * What a `single` envelope becomes.
   *
   *   'data'     — the record (default)
   *   'envelope' — keep it whole
   */
  single?: 'data' | 'envelope'
}

/**
 * Envelope → what a consumer wants, per the one rule the framework has:
 * **a list keeps its envelope, a single unwraps to the record.**
 *
 * A list carries metadata that has nowhere else to live, and a single does
 * not — that asymmetry is the whole design, and every consumer that reduced
 * it to "take .data" is how `total` became unreachable from everywhere except
 * curl.
 *
 * Non-envelopes pass through untouched, so this is safe on a value that may
 * or may not be wrapped (cache hits, hook-set results, bypass methods).
 */
export function unwrapResult(value: unknown, opts: UnwrapOptions = {}): unknown {
  if (!isServiceResult(value)) return value

  if (value.kind === 'list') {
    return (opts.list ?? 'envelope') === 'envelope' ? value : value.data
  }
  return (opts.single ?? 'data') === 'data' ? value.data : value
}

/** The record(s) inside, whatever the kind. For consumers that only want rows. */
export function resultData(value: unknown): unknown {
  return isServiceResult(value) ? value.data : value
}
