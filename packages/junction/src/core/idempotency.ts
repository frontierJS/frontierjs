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
// caller another's answer. Two signed-in callers using the same key string get
// two entries and two executions, which is the safe reading of an ambiguous
// request — and a caller with NO principal gets no entry at all, because
// `anonymous` is not an identity, it is everybody.

import { createHash } from 'node:crypto'
import { occurrenceKey } from '@frontierjs/toolbelt/history'
import { Conflict, Unprocessable } from './errors.ts'
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
  /** What the first request under this key actually asked for. */
  fingerprint: string
}

/**
 * The call this key was claimed for, hashed.
 *
 * A key promises that ONE request runs once — not that any request quoting it
 * gets the first one's answer. Without this, a client that reuses a key on a
 * different body is silently answered the earlier row and never finds out
 * (`FJS-680`); Stripe answers 422 for exactly this and so do we. Hashed rather
 * than stored, because the body is the caller's payload and a cache entry is
 * not the place to keep a second copy of it.
 */
function fingerprintOf(ctx: ServiceContext): string {
  return createHash('sha256').update(JSON.stringify({
    m: ctx.method,
    p: `${ctx.service}/${ctx.id ?? ''}`,
    q: ctx.query ?? null,
    b: ctx.data  ?? null,
  })).digest('hex')
}

// Warned once per process. A key from a caller nobody can tell apart is a
// misconfiguration, not a per-request event.
let _warnedAnonymous = false

/**
 * The cache key. The principal is part of it — see the header note — and so is
 * the method, so one key cannot answer for `create` and then for `remove`.
 *
 * Built through `occurrenceKey` because two of the four parts are outside this
 * package's control — the header a caller writes, and a principal id that is
 * whatever the auth provider issues. Joining them raw on `:` is not injective
 * once either can contain one, so a principal of `user-1:a` with key `b` and a
 * principal of `user-1` with key `a:b` are one cache entry — and a shared entry
 * is one caller being replayed another's answer. The format is unchanged for
 * any principal and key without a `:` in them.
 */
function cacheKey(ctx: ServiceContext, principal: string, key: string): string {
  return occurrenceKey('idem', ctx.service, ctx.method as string, principal, key)
}

/**
 * WHO this key belongs to, or null where nobody can be told apart.
 *
 * Anonymous callers used to share the string `'anonymous'`, which made one
 * namespace out of every stranger on the internet: the second stranger to send
 * a key the first had used was replayed the first one's row — somebody else's
 * created record, with their id in it — or refused with a 409 about a request
 * they never made (`FJS-680`). There is nothing here to key on: a guest's
 * claims deliberately never become `ctx.auth.user` (they scope the Data client
 * and nothing else), so the honest answer is that the header cannot be honoured
 * and the call runs normally. Two anonymous POSTs with one key are two calls,
 * which is the safe reading of an ambiguous request.
 */
function principalOf(ctx: ServiceContext): string | null {
  return ctx.auth.user?.userId ?? null
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

  const principal = principalOf(ctx)
  if (!principal) {
    if (!_warnedAnonymous) {
      _warnedAnonymous = true
      console.warn(
        `[Junction] an Idempotency-Key arrived from a caller with no principal ` +
        `(${ctx.service}.${ctx.method as string}) and was ignored. A key is scoped ` +
        `to who sent it, and anonymous callers cannot be told apart — sharing one ` +
        `namespace would replay one stranger's answer to another. Authenticate the ` +
        `call, or drop the header.`
      )
    }
    return null
  }

  const k           = cacheKey(ctx, principal, key)
  const fingerprint = fingerprintOf(ctx)
  const existing    = cache.get<Entry>(k)

  // A key already spoken for by a DIFFERENT call. Not retryable: repeating it
  // asks the same impossible thing, and the way out is a new key.
  if (existing && existing.fingerprint !== fingerprint) {
    const err = new Unprocessable(
      `Idempotency key reused with a different payload ` +
      `(${ctx.service}.${ctx.method as string}). A key names one request; use a new one.`
    )
    err.retryable = false
    throw err
  }

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
  cache.set<Entry>(k, { state: 'pending', result: null, fingerprint }, config?.pendingTtl ?? '2 minutes')

  return {
    replay: false,
    result: null,
    settle: (ok, result) => {
      // A failed call releases the key. The caller is entitled to retry, and
      // remembering a failure would answer the retry with the failure.
      if (!ok) { cache.remove(k); return }
      cache.set<Entry>(k, { state: 'done', result, fingerprint }, ttl)
    },
  }
}
