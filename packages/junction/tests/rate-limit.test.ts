// tests/rate-limit.test.ts
//
// FJS-017. There were three rate limiters — a transport middleware
// (limit/keyFn/window: 60_000), a pipeline hook (max/key/window: '15 minutes')
// and a third inside @frontierjs/auth. Same algorithm, three vocabularies, so
// learning one taught you nothing about the next.
//
// They had already drifted: auth's returned early on a fresh bucket, so
// `max: 0` let one request through. That is the shape these assert against —
// not "does it limit", which each copy passed on its own, but "do the tiers
// agree", which is the question no per-copy test could ask.

import { describe, it, expect } from 'bun:test'
import { createRateLimiter } from '../src/core/rate-limit.ts'
import { clientIp }          from '../src/core/context.ts'
import { rateLimit as rateLimitHook } from '../src/core/hooks-resilience.ts'
import { rateLimit as rateLimitMw }   from '../src/transport/middleware.ts'

const svcCtx = (ip: string, userId?: string) =>
  ({ client: { ip }, auth: { user: userId ? { userId } : null } }) as never
const wireCtx = (ip: string) => ({ ip }) as never

describe('one limiter under both tiers', () => {

  it('max: 0 refuses the FIRST request — the drift auth had', () => {
    // Auth's copy set the bucket and returned before comparing, so a limiter
    // configured to allow nothing allowed one.
    const l = createRateLimiter<{ ip: string }>({ max: 0, window: 1000 }, c => c.ip)
    expect(() => l.check({ ip: 'a' })).toThrow(/Rate limit exceeded/)
    l.dispose()
  })

  it('counts to the limit, then refuses with a retryAfter', () => {
    const l = createRateLimiter<{ ip: string }>({ max: 2, window: 60_000 }, c => c.ip)
    expect(l.check({ ip: 'a' }).remaining).toBe(1)
    expect(l.check({ ip: 'a' }).remaining).toBe(0)
    try {
      l.check({ ip: 'a' })
      throw new Error('should have refused')
    } catch (err) {
      const e = err as { code?: number; data?: { retryAfter?: number } }
      expect(e.code).toBe(429)
      expect(e.data?.retryAfter).toBeGreaterThan(0)
    }
    l.dispose()
  })

  it('buckets are per key, and a different key is unaffected', () => {
    const l = createRateLimiter<{ ip: string }>({ max: 1, window: 60_000 }, c => c.ip)
    l.check({ ip: 'a' })
    expect(() => l.check({ ip: 'a' })).toThrow()
    expect(() => l.check({ ip: 'b' })).not.toThrow()
    l.dispose()
  })

  it('window takes a TTL string as well as milliseconds — it used to be number-only at the transport', () => {
    const a = createRateLimiter<{ ip: string }>({ max: 1, window: '1 hour' }, c => c.ip)
    const b = createRateLimiter<{ ip: string }>({ max: 1, window: 3_600_000 }, c => c.ip)
    const ra = a.check({ ip: 'x' }).reset
    const rb = b.check({ ip: 'x' }).reset
    expect(Math.abs(ra - rb)).toBeLessThanOrEqual(1)
    a.dispose(); b.dispose()
  })

  it('skip lets a request past WITHOUT counting it', () => {
    const l = createRateLimiter<{ ip: string; bot?: boolean }>(
      { max: 1, window: 60_000, skip: c => !!c.bot }, c => c.ip)
    l.check({ ip: 'a', bot: true })
    l.check({ ip: 'a', bot: true })
    expect(() => l.check({ ip: 'a' })).not.toThrow()   // budget untouched
    expect(() => l.check({ ip: 'a' })).toThrow()
    l.dispose()
  })
})

describe('clientIp reads either context shape', () => {
  // The one-line gap that grew a third limiter: a TransportContext carries `ip`
  // at the top level, a ServiceContext splits client facts into ctx.client.
  it('finds the address on a service context and a transport context alike', () => {
    expect(clientIp(svcCtx('1.1.1.1'))).toBe('1.1.1.1')
    expect(clientIp(wireCtx('2.2.2.2'))).toBe('2.2.2.2')
  })
  it('answers "unknown" rather than throwing on an internal call with no client', () => {
    expect(clientIp({})).toBe('unknown')
    expect(clientIp(null)).toBe('unknown')
  })
})

describe('the hook keys on the principal, the middleware on the address', () => {

  it('two users behind one IP get their own buckets in the pipeline', () => {
    const hook = rateLimitHook({ max: 1, window: '1 hour' })
    hook(svcCtx('1.1.1.1', 'u1'))
    expect(() => hook(svcCtx('1.1.1.1', 'u2'))).not.toThrow()
    expect(() => hook(svcCtx('1.1.1.1', 'u1'))).toThrow(/Rate limit/)
  })

  it('the hook survives a context with NO auth — which is how auth uses it', () => {
    // /auth/login holds a TransportContext: no principal, because signing in is
    // what produces one. Reaching ctx.auth.user directly threw here, and that is
    // what @frontierjs/auth forked a whole limiter over.
    const hook = rateLimitHook({ max: 1, window: '1 hour' })
    expect(() => hook(wireCtx('9.9.9.9'))).not.toThrow()
    expect(() => hook(wireCtx('9.9.9.9'))).toThrow(/Rate limit/)
  })
})

describe('the legacy option names are refused, not ignored', () => {
  // A silently ignored `limit:` would read `max` as undefined, and `count >
  // undefined` is never true — so the limiter would accept everything and say
  // nothing. That is worse than the rename.
  it('names each old option and its replacement', () => {
    expect(() => rateLimitMw({ limit: 10, window: 1000 } as never)).toThrow(/'limit' is now 'max'/)
    expect(() => rateLimitMw({ max: 10, window: 1000, keyFn: () => 'k' } as never)).toThrow(/'keyFn' is now 'key'/)
    expect(() => rateLimitMw({ max: 10, window: 1000, skipFn: () => true } as never)).toThrow(/'skipFn' is now 'skip'/)
    expect(() => rateLimitHook({ max: 10, window: '1 hour', key: () => 'k' })).not.toThrow()
  })
})
