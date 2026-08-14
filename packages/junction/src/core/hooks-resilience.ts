// core/hooks-resilience.ts
// Stateful resilience hooks — circuit breaker and pipeline-level rate
// limiter. Split out of hooks.ts (which owns only the pipeline engine);
// their imports previously sat mid-file at line ~513. hooks.ts re-exports
// everything here, so existing imports are unaffected.

import type { ServiceContext } from './context.ts'
import type { Hook, AroundHook } from './hooks.ts'
import { Unavailable } from './errors.ts'
import type { RateLimitHookOptions } from '../auth/types.ts'
import { createRateLimiter, refuseLegacyRateLimitOptions, type RateLimitOptions } from './rate-limit.ts'
import { clientIp } from './context.ts'

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
  refuseLegacyRateLimitOptions(opts as unknown as Record<string, unknown>)

  // Authenticated callers get their own bucket regardless of IP; anonymous ones
  // share a bucket per address.
  //
  // `auth` is reached optionally because this hook is also the limiter
  // @frontierjs/auth uses on its own /auth/* routes, and those are plain HTTP
  // handlers holding a TransportContext — no principal, by definition, since
  // signing in is what produces one. Reaching through `ctx.auth.user` directly
  // would throw there, which is the difference auth forked over (FJS-017).
  const limiter = createRateLimiter<ServiceContext>(
    opts as RateLimitOptions<ServiceContext>,
    (ctx) => (ctx.auth?.user?.userId as string) ?? clientIp(ctx),
  )

  const hook = (ctx: ServiceContext): void => { limiter.check(ctx) }
  // Exposed so a caller holding the hook can stop its sweep timer. The transport
  // adapter wires this into a plugin shutdown(); a service-level hook lives as
  // long as the service, so there is nothing to hang it off automatically.
  ;(hook as unknown as { dispose(): void }).dispose = () => limiter.dispose()
  return hook
}

