// core/idempotency.ts
// Replay protection for a mutating call that carries an Idempotency-Key.
//
// The header was read into ctx.idempotencyKey and consumed by nothing, so a
// double-submitted create ran twice while the request carried the value that
// says not to — and Conduit spends the OTHER side of the same contract, sending
// `Idempotency-Key` outbound and treating its presence as licence to retry a
// POST (FJS-088). This makes the inbound half true.
//
// What a key promises: the same key, from the same principal, to the same
// service and method, executes ONCE. A repeat replays the first answer without
// running the pipeline again — no second email, no second announcement, no
// second row. It is not a cache: a key is never reused for a different call,
// and a key whose call FAILED is released, because a failed request is one the
// caller is entitled to retry.
//
// Scoped to the principal on purpose. Replay skips the hook pipeline, so it
// skips the auth checks in it; a key shared across principals would hand one
// caller another's answer. Two callers using the same key string get two
// entries and two executions, which is the safe reading of an ambiguous
// request.

import { Conflict } from './errors.ts'
import type { ICache } from '../cache/index.ts'
import type { ServiceContext } from './context.ts'

// A read cannot be replayed usefully and does not need protecting.
const READ_METHODS = new Set(['find', 'get'])

export interface IdempotencyConfig {
  enabled?: boolean
  /** How long a completed key is remembered. Parsed by the cache's TTL grammar. */
  ttl?:     string
  /**
   * How long the in-flight marker lives.
   *
   * It is a separate, short TTL because it is the one entry nothing is
   * guaranteed to clear: a throw between the claim and the settle — from a
   * broadcast, a cleanup, anything outside the pipeline's own catch — would
   * otherwise leave a key answering 409 for the whole `ttl`, which turns a
   * one-off failure into a caller that can never retry. Longer than any request
   * this app expects to serve, shorter than a person will wait.
   */
  pendingTtl?: string
}

interface Entry {
  state:  'pending' | 'done'
  result: unknown
}

/**
 * The cache key. The principal is part of it — see the header note — and so is
 * the method, so one key cannot answer for `create` and then for `remove`.
 */
function cacheKey(ctx: ServiceContext, key: string): string {
  const principal = ctx.auth.user?.userId ?? 'anonymous'
  return `idem:${ctx.service}:${ctx.method}:${principal}:${key}`
}

function cacheOf(ctx: ServiceContext): ICache | null {
  const cache = (ctx.app as { cache?: ICache } | undefined)?.cache
  return cache && typeof cache.get === 'function' ? cache : null
}

export interface IdempotencyClaim {
  /** The stored result, when this call is a replay of one that already ran. */
  replay:  boolean
  result:  unknown
  /** Called by callService when the call finishes. */
  settle:  (ok: boolean, result: unknown) => void
}

/**
 * Claim a key for this call, or discover that it is already spoken for.
 *
 * Returns null when idempotency does not apply — no key, a read, no cache, or
 * turned off — and the caller proceeds exactly as before.
 *
 * The claim is synchronous from get() to set(), so two calls arriving in the
 * same tick cannot both see an empty slot: the second finds `pending` and is
 * refused with a retryable 409 rather than executing in parallel with the
 * first, which is the failure the key exists to prevent.
 */
export function claimIdempotency(
  ctx:    ServiceContext,
  key:    string | undefined,
  config: IdempotencyConfig | undefined
): IdempotencyClaim | null {
  if (!key) return null
  if (config?.enabled === false) return null
  if (READ_METHODS.has(ctx.method as string)) return null

  const cache = cacheOf(ctx)
  if (!cache) return null

  const k        = cacheKey(ctx, key)
  const existing = cache.get<Entry>(k)

  if (existing?.state === 'done') {
    return { replay: true, result: existing.result, settle: () => {} }
  }

  if (existing?.state === 'pending') {
    // Retryable: the first call is still running, so the same request may well
    // succeed once it has. A domain refusal would not be.
    const err = new Conflict(
      `A request with this Idempotency-Key is still in flight ` +
      `(${ctx.service}.${ctx.method as string}). Retry when it has finished.`
    )
    err.retryable = true
    throw err
  }

  const ttl = config?.ttl ?? '24 hours'
  cache.set<Entry>(k, { state: 'pending', result: null }, config?.pendingTtl ?? '2 minutes')

  return {
    replay: false,
    result: null,
    settle: (ok, result) => {
      // A failed call releases the key. The caller is entitled to retry, and
      // remembering a failure would answer the retry with the failure.
      if (!ok) { cache.remove(k); return }
      cache.set<Entry>(k, { state: 'done', result }, ttl)
    },
  }
}
