// core/rate-limit.ts
// The one rate-limiting definition. Counting, the window, the sweep, the
// teardown and the refusal live here; everything else is an adapter that
// decides how to read a key and what to do with the result.
//
// There were three of these (FJS-017): a transport middleware keyed on
// `limit`/`keyFn`/`window: 60_000`, a pipeline hook keyed on
// `max`/`key`/`window: '15 minutes'`, and a third inside @frontierjs/auth. Same
// algorithm, three vocabularies, so learning one taught you nothing about the
// next — and the copies had already drifted: auth's returned before checking the
// limit on a fresh bucket, so `max: 0` let one request through.
//
// Auth's fork had a stated reason and it was stale. Its comment said the hook
// "operates on ServiceContext, which has ctx.params.ip" — a ServiceContext has
// no `params` at all. The real difference was one accessor, which is what
// `clientIp()` in context.ts now answers for both shapes.

import { TooManyRequests } from './errors.ts'
import { parseTtl }        from '../config/index.ts'

export interface RateLimitOptions<Ctx = unknown> {
  /** Requests allowed per window. `0` refuses everything. */
  max:       number
  /** `'15 minutes'`, `'1h'`, `'30s'` — or a number of milliseconds. */
  window:    string | number
  /** What to count by. Adapters supply the default. */
  key?:      (ctx: Ctx) => string
  /** Message on the 429. */
  message?:  string
  /** Return true to let a request past without counting it. */
  skip?:     (ctx: Ctx) => boolean
}

/** What a permitted request knows about its own budget. */
export interface RateLimitVerdict {
  limit:      number
  remaining:  number
  /** Unix seconds at which the window rolls over. */
  reset:      number
}

export interface RateLimiter<Ctx> {
  /** Counts the request. Throws `TooManyRequests` when over budget. */
  check(ctx: Ctx): RateLimitVerdict
  /** Clears the sweep timer. Adapters wire this to their own teardown. */
  dispose(): void
}

export function createRateLimiter<Ctx>(
  opts:       RateLimitOptions<Ctx>,
  defaultKey: (ctx: Ctx) => string
): RateLimiter<Ctx> {

  const windowMs = typeof opts.window === 'number' ? opts.window : parseTtl(opts.window)
  const keyOf    = opts.key ?? defaultKey
  const counters = new Map<string, { count: number; resetAt: number }>()

  // Sweep expired buckets so the map cannot grow without bound. unref'd, so a
  // limiter never keeps the process alive on its own — but `dispose()` is still
  // needed, because an unref'd interval left running against a live map is a
  // leak inside a test process that builds many apps.
  const gc = setInterval(() => {
    const now = Date.now()
    for (const [k, b] of counters) if (b.resetAt < now) counters.delete(k)
  }, windowMs)
  if (typeof gc.unref === 'function') gc.unref()

  return {
    check(ctx: Ctx): RateLimitVerdict {
      const now = Date.now()

      if (opts.skip?.(ctx))
        return { limit: opts.max, remaining: opts.max, reset: Math.ceil((now + windowMs) / 1000) }

      const key    = keyOf(ctx)
      let   bucket = counters.get(key)

      if (!bucket || bucket.resetAt < now) {
        bucket = { count: 0, resetAt: now + windowMs }
        counters.set(key, bucket)
      }

      bucket.count++

      // Counted BEFORE the comparison, and the comparison covers the first
      // request too — `max: 0` means none, not one. Auth's copy returned early
      // on a fresh bucket and let that first one through.
      if (bucket.count > opts.max) {
        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
        throw new TooManyRequests(
          opts.message ?? `Rate limit exceeded — max ${opts.max} per ${
            typeof opts.window === 'number' ? `${opts.window}ms` : opts.window}`,
          { retryAfter },
        )
      }

      return {
        limit:     opts.max,
        remaining: Math.max(0, opts.max - bucket.count),
        reset:     Math.ceil(bucket.resetAt / 1000),
      }
    },

    dispose() { clearInterval(gc) },
  }
}

// The old spellings, refused by name. A silently ignored option is a limit
// nobody is enforcing: `rateLimit({ limit: 10, … })` under the new names would
// read `max` as undefined and compare every count against it, which is never
// greater, so the limiter would accept everything and say nothing.
export function refuseLegacyRateLimitOptions(opts: Record<string, unknown>): void {
  const renamed: Record<string, string> = { limit: 'max', keyFn: 'key', skipFn: 'skip' }
  for (const [was, now] of Object.entries(renamed)) {
    if (was in opts)
      throw new Error(
        `rateLimit: '${was}' is now '${now}'. One limiter serves the transport middleware, ` +
        `the pipeline hook and @frontierjs/auth, so it has one set of option names.`
      )
  }
}
