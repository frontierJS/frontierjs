// core/hooks-resilience.ts
// Stateful resilience hooks — circuit breaker and pipeline-level rate
// limiter. Split out of hooks.ts (which owns only the pipeline engine);
// their imports previously sat mid-file at line ~513. hooks.ts re-exports
// everything here, so existing imports are unaffected.

import type { ServiceContext } from './context.ts'
import type { Hook, AroundHook } from './hooks.ts'
import { Unavailable, TooManyRequests } from './errors.ts'
import { parseTtl } from '../config/index.ts'
import type { RateLimitHookOptions } from '../auth/types.ts'

export type { RateLimitHookOptions }

// ─── Circuit breaker ──────────────────────────────────────────────────────
// Wraps a service method (or action) as an around hook.
// Transitions: CLOSED → OPEN after `threshold` consecutive failures.
//              OPEN   → HALF_OPEN after `timeout` ms.
//              HALF_OPEN → CLOSED on success, back to OPEN on failure.
//
// Usage — protect a service that calls an external API:
//
//   service.hooks({
//     around: {
//       all: [circuitBreaker({ threshold: 5, timeout: 30_000 })]
//     }
//   })
//
// Options:
//   threshold  — consecutive failures before opening. Default 5.
//   timeout    — ms to wait in OPEN state before trying again. Default 30 000.
//   onOpen     — called when circuit opens. Useful for alerting.
//   onClose    — called when circuit resets to closed.
//   onHalfOpen — called when circuit enters half-open probe state.

export interface CircuitBreakerOptions {
  threshold?:  number
  timeout?:    number
  onOpen?:     (ctx: ServiceContext) => void
  onClose?:    (ctx: ServiceContext) => void
  onHalfOpen?: (ctx: ServiceContext) => void
}

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export function circuitBreaker(opts: CircuitBreakerOptions = {}): AroundHook {

  const threshold = opts.threshold ?? 5
  const timeout   = opts.timeout   ?? 30_000

  let state:      CircuitState = 'CLOSED'
  let failures    = 0
  let openedAt    = 0

  return async (ctx: ServiceContext, next: () => Promise<void>): Promise<void> => {

    // ── OPEN — fail fast unless timeout has elapsed ──────────────
    if (state === 'OPEN') {
      if (Date.now() - openedAt < timeout) {
        throw new Unavailable(
          `Circuit open for ${ctx.service}.${ctx.method} — too many recent failures`
        )
      }
      // Timeout elapsed — allow one probe through
      state = 'HALF_OPEN'
      opts.onHalfOpen?.(ctx)
    }

    // ── CLOSED / HALF_OPEN — attempt the call ────────────────────
    try {
      await next()

      // Success — reset regardless of which state we were in
      if (state !== 'CLOSED') {
        state    = 'CLOSED'
        failures = 0
        opts.onClose?.(ctx)
      } else {
        failures = 0
      }

    } catch (err) {
      failures++

      if (state === 'HALF_OPEN' || failures >= threshold) {
        state    = 'OPEN'
        openedAt = Date.now()
        opts.onOpen?.(ctx)
      }

      throw err
    }
  }
}


// ─── Rate limiter ─────────────────────────────────────────────────────────
// Before hook — operates inside the pipeline where the full ServiceContext
// is available (ctx.auth.user, ctx.client.ip, ctx.service, ctx.method).
//
// In-process memory store — correct for single-instance deployments.
// For multi-instance, replace with a Redis-backed counter via the key option.
//
// Distinct from the transport-level rateLimit middleware plugin which applies
// globally at the HTTP layer before any service context exists.
//
// Usage:
//   service.hooks({
//     before: {
//       create: [rateLimitHook({ max: 10, window: '15 minutes' })]
//     }
//   })
//
// Keyed by IP by default. Key by user for authenticated routes:
//   rateLimitHook({ max: 100, window: '1 hour', key: (ctx) => ctx.auth.user?.userId ?? ctx.client.ip })



export function rateLimit(opts: RateLimitHookOptions): Hook {
  const windowMs = parseTtl(opts.window)
  const counters  = new Map<string, { count: number; resetAt: number }>()

  // GC: sweep expired buckets on the window interval to prevent unbounded growth
  const gc = setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of counters) {
      if (bucket.resetAt < now) counters.delete(key)
    }
  }, windowMs)
  if (gc.unref) gc.unref()

  return (ctx: ServiceContext): void => {
    const key = opts.key
      ? opts.key(ctx)
      // Default: key on the authenticated user when present, falling back to
      // client IP for anonymous callers. (Authenticated users get their own
      // bucket regardless of IP; anonymous callers share per-IP buckets.)
      : (ctx.auth.user?.userId as string) ?? (ctx.client.ip as string) ?? 'unknown'

    const now    = Date.now()
    const bucket = counters.get(key)

    // Fresh / expired bucket — start a new window at count 1.
    if (!bucket || now > bucket.resetAt) {
      counters.set(key, { count: 1, resetAt: now + windowMs })
      // Even the first request must respect the limit (e.g. max: 0 blocks all).
      if (1 > opts.max) {
        throw new TooManyRequests(
          opts.message ?? `Rate limit exceeded — max ${opts.max} requests per ${opts.window}`
        )
      }
      return
    }

    bucket.count++

    if (bucket.count > opts.max) {
      throw new TooManyRequests(
        opts.message ?? `Rate limit exceeded — max ${opts.max} requests per ${opts.window}`
      )
    }
  }
}

