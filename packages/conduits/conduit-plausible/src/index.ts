// @frontierjs/conduit-plausible — Plausible's Stats API v2 over conduit.
//
// One bearer key, one POST that only READS, paged by offset, 600 requests an
// hour. On its own that fails the test for a maintained connector; it passes
// as the reference *read-only, rate-limited report source*: every call is
// `replayable: true` because a query moves nothing, so conduit replays a lost
// response and honors a 429's `Retry-After` itself — the opposite of every
// send-shaped connector here, and the clause CONTRACT C5 needed a second case for.
//
// Self-hosted Plausible is the same API at another address: an argument to
// the builder, not a second connector.

import type { ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'

export const PLAUSIBLE_TARGET  = 'provider:plausible'
export const PLAUSIBLE_ADDRESS = 'https://plausible.io'
/** Plausible's documented maximum page. */
export const MAX_LIMIT = 10_000

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = PLAUSIBLE_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

export function plausibleTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? PLAUSIBLE_TARGET, kind: 'provider', protocol: 'http',
    address: (opts.address ?? PLAUSIBLE_ADDRESS).replace(/\/$/, ''),
    auth: { type: 'bearer', ref: opts.ref ?? 'PLAUSIBLE_API_KEY' }, registered_at: Date.now(), last_seen_at: null,
  }
}

export type Metric = 'visitors' | 'visits' | 'pageviews' | 'views_per_visit' | 'bounce_rate' | 'visit_duration' | 'events' | (string & {})
export type DateRange = 'day' | '7d' | '30d' | 'month' | '6mo' | '12mo' | 'year' | 'all' | [string, string]

export interface StatsQuery {
  site_id:     string
  metrics:     Metric[]
  date_range:  DateRange
  dimensions?: string[]
  filters?:    unknown[]
  order_by?:   [string, 'asc' | 'desc'][]
  pagination?: { limit?: number; offset?: number }
}
export interface StatsResult {
  results: { metrics: number[]; dimensions: string[] }[]
  meta:    { total_rows?: number; warning?: string; [k: string]: unknown }
  query:   StatsQuery
}

export type PlausibleFailureKind = 'refused' | 'unknown_site' | 'quota' | ConduitError['kind']
export interface PlausibleFailure { kind: PlausibleFailureKind; message: string; retryable: boolean; retryAfterMs?: number }

export function translate(error: ConduitError, status?: number): PlausibleFailure {
  let body: { error?: string } | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as typeof body) } catch { /* not JSON */ }
  const base: PlausibleFailure = { kind: error.kind, message: body?.error ?? error.message, retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (error.kind === 'client_error') {
    if (status === 404 || /site/i.test(body?.error ?? '') && /not found|exist/i.test(body?.error ?? '')) return { ...base, kind: 'unknown_site', retryable: false }
    return { ...base, kind: 'refused', retryable: false }
  }
  // 600 an hour: a 429 with no Retry-After is the hourly budget gone, not a burst.
  if (error.kind === 'rate_limited' && error.retry_after_ms === undefined) return { ...base, kind: 'quota', retryable: false }
  return base
}

export async function query(send: Send, q: StatsQuery): Promise<{ result?: StatsResult; error?: PlausibleFailure }> {
  if (!q.metrics.length) return { error: { kind: 'refused', message: 'a query names at least one metric', retryable: false } }
  if ((q.pagination?.limit ?? 0) > MAX_LIMIT) return { error: { kind: 'refused', message: `limit above ${MAX_LIMIT} is clamped by the vendor in silence; refused here`, retryable: false } }
  // A read moves nothing: the one POST in this workspace that is replayable.
  const r = await send<StatsResult>({ method: 'POST', path: '/api/v2/query', body: q, replayable: true })
  if (r.error) return { error: translate(r.error, r.meta.status) }
  return { result: r.data }
}

/** Every page, by offset, until a short page. `cap` bounds the walk. */
export async function queryAll(send: Send, q: StatsQuery, opts: { pageSize?: number; cap?: number } = {}): Promise<{ rows?: StatsResult['results']; pages?: number; error?: PlausibleFailure }> {
  const limit = opts.pageSize ?? 1000, cap = opts.cap ?? 100
  const rows: StatsResult['results'] = []
  for (let page = 0; page < cap; page++) {
    const r = await query(send, { ...q, pagination: { limit, offset: page * limit } })
    if (r.error) return { error: r.error }
    rows.push(...r.result!.results)
    if (r.result!.results.length < limit) return { rows, pages: page + 1 }
  }
  return { error: { kind: 'refused', message: `still returning full pages after ${cap}`, retryable: false } }
}
