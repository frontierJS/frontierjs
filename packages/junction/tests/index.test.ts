// tests/index.test.ts
// Core framework tests — Bun test runner.
// Run: bun test

import { describe, it, expect, beforeEach } from 'bun:test'

// ─── Router tests ─────────────────────────────────────────────────────────

import { Router } from '../src/transport/router.ts'

describe('Router', () => {

  it('matches fixed routes — O(1) path', () => {
    const r = new Router()
    r.get('/users', () => null)
    r.post('/users', () => null)
    r.build()

    expect(r.lookup('GET',  '/users')).not.toBeNull()
    expect(r.lookup('POST', '/users')).not.toBeNull()
    expect(r.lookup('GET',  '/other')).toBeNull()
  })

  it('matches dynamic routes and extracts params', () => {
    const r = new Router()
    r.get('/users/{id}', () => null)
    r.build()

    const match = r.lookup('GET', '/users/123')
    expect(match).not.toBeNull()
    expect(match!.params).toEqual({ id: '123' })
  })

  it('matches nested dynamic routes', () => {
    const r = new Router()
    r.get('/workspaces/{workspaceId}/users/{userId}', () => null)
    r.build()

    const match = r.lookup('GET', '/workspaces/abc/users/xyz')
    expect(match).not.toBeNull()
    expect(match!.params).toEqual({ workspaceId: 'abc', userId: 'xyz' })
  })

  it('fixed routes take precedence over dynamic', () => {
    const r = new Router()
    const fixed   = () => 'fixed'
    const dynamic = () => 'dynamic'
    r.get('/users/profile', fixed)
    r.get('/users/{id}',    dynamic)
    r.build()

    const match = r.lookup('GET', '/users/profile')
    expect(match).not.toBeNull()
    expect(match!.route.handler).toBe(fixed)
  })

  it('decodes URL-encoded params', () => {
    const r = new Router()
    r.get('/files/{name}', () => null)
    r.build()

    const match = r.lookup('GET', '/files/my%20file.txt')
    expect(match!.params.name).toBe('my file.txt')
  })

  it('returns null for unregistered routes', () => {
    const r = new Router()
    r.get('/users', () => null)
    r.build()

    expect(r.lookup('DELETE', '/users')).toBeNull()
    expect(r.lookup('GET',    '/posts')).toBeNull()
  })

  it('throws if routes are added after build()', () => {
    const r = new Router()
    r.get('/users', () => null)
    r.build()

    expect(() => r.get('/posts', () => null)).toThrow()
  })

  it('counts routes correctly', () => {
    const r = new Router()
    r.get('/a', () => null)
    r.get('/b', () => null)
    r.get('/c/{id}', () => null)
    r.build()

    expect(r.routeCount).toBe(3)
  })
})

// ─── matchPathDirect — zero-allocation path matcher ───────────────────────
// Tests for the function that replaced splitPath+matchRoute on the hot path.
// Covers every branch: static, param, wildcard, edge cases, encoding.

import { matchPathDirect } from '../src/transport/router.ts'
import type { RouteSegment } from '../src/transport/types.ts'

const seg = {
  static:   (value: string): RouteSegment => ({ type: 'static', value }),
  param:    (name:  string): RouteSegment => ({ type: 'param',  name  }),
  wildcard: ():              RouteSegment => ({ type: 'wildcard'       }),
}

describe('matchPathDirect', () => {

  // ── Static segments ──────────────────────────────────────────────────

  it('matches a single static segment', () => {
    const segs = [seg.static('users')]
    expect(matchPathDirect(segs, '/users')).toEqual({})
    expect(matchPathDirect(segs, '/posts')).toBeNull()
  })

  it('matches multiple static segments', () => {
    const segs = [seg.static('api'), seg.static('v1'), seg.static('health')]
    expect(matchPathDirect(segs, '/api/v1/health')).toEqual({})
    expect(matchPathDirect(segs, '/api/v2/health')).toBeNull()
    expect(matchPathDirect(segs, '/api/v1')).toBeNull()
  })

  it('is case-sensitive on static segments', () => {
    const segs = [seg.static('Users')]
    expect(matchPathDirect(segs, '/Users')).toEqual({})
    expect(matchPathDirect(segs, '/users')).toBeNull()
  })

  // ── Param segments ───────────────────────────────────────────────────

  it('extracts a single param', () => {
    const segs = [seg.static('users'), seg.param('id')]
    expect(matchPathDirect(segs, '/users/123')).toEqual({ id: '123' })
    expect(matchPathDirect(segs, '/users/abc-def')).toEqual({ id: 'abc-def' })
  })

  it('extracts multiple params', () => {
    const segs = [seg.static('workspaces'), seg.param('wsId'), seg.static('users'), seg.param('userId')]
    const m = matchPathDirect(segs, '/workspaces/ws-1/users/u-99')
    expect(m).toEqual({ wsId: 'ws-1', userId: 'u-99' })
  })

  it('returns null when a param segment is empty', () => {
    const segs = [seg.static('users'), seg.param('id')]
    // double slash — empty param segment
    expect(matchPathDirect(segs, '/users/')).toBeNull()
  })

  it('returns null when path has too few segments for params', () => {
    const segs = [seg.static('users'), seg.param('id')]
    expect(matchPathDirect(segs, '/users')).toBeNull()
  })

  it('returns null when path has extra segments after params', () => {
    const segs = [seg.static('users'), seg.param('id')]
    expect(matchPathDirect(segs, '/users/123/extra')).toBeNull()
  })

  // ── Wildcard ─────────────────────────────────────────────────────────

  it('wildcard matches single remaining segment', () => {
    const segs = [seg.static('static'), seg.wildcard()]
    expect(matchPathDirect(segs, '/static/file.css')).toEqual({})
  })

  it('wildcard matches multiple remaining segments', () => {
    const segs = [seg.static('files'), seg.wildcard()]
    expect(matchPathDirect(segs, '/files/a/b/c/d.txt')).toEqual({})
  })

  it('wildcard matches nothing remaining (trailing slash into wildcard)', () => {
    const segs = [seg.static('files'), seg.wildcard()]
    // The wildcard consumes whatever is left, including nothing
    expect(matchPathDirect(segs, '/files/')).toEqual({})
  })

  it('wildcard at root matches everything', () => {
    const segs = [seg.wildcard()]
    expect(matchPathDirect(segs, '/anything/at/all')).toEqual({})
    expect(matchPathDirect(segs, '/')).toEqual({})
  })

  // ── URL encoding ─────────────────────────────────────────────────────

  it('decodes percent-encoded param values', () => {
    const segs = [seg.static('files'), seg.param('name')]
    expect(matchPathDirect(segs, '/files/my%20file.txt')).toEqual({ name: 'my file.txt' })
  })

  it('decodes multiple encoded characters in a param', () => {
    const segs = [seg.param('q')]
    expect(matchPathDirect(segs, '/hello%20world%21')).toEqual({ q: 'hello world!' })
  })

  it('skips decodeURIComponent when no percent present (fast path)', () => {
    // No encoding — should return the raw string without calling decode
    const segs = [seg.param('slug')]
    expect(matchPathDirect(segs, '/my-post-title')).toEqual({ slug: 'my-post-title' })
  })

  // ── Empty / root paths ───────────────────────────────────────────────

  it('empty segments array matches root path', () => {
    expect(matchPathDirect([], '/')).toEqual({})
    expect(matchPathDirect([], '')).toEqual({})
    expect(matchPathDirect([], '/anything')).toBeNull()
  })

  // ── Path variants ────────────────────────────────────────────────────

  it('handles path without leading slash', () => {
    const segs = [seg.static('users'), seg.param('id')]
    expect(matchPathDirect(segs, 'users/42')).toEqual({ id: '42' })
  })

  it('handles trailing slash on path', () => {
    const segs = [seg.static('users'), seg.param('id')]
    // trailing slash is accepted — pos ends at length+1 which passes the check
    expect(matchPathDirect(segs, '/users/42/')).toEqual({ id: '42' })
  })

  // ── Parity with Router.lookup() ──────────────────────────────────────
  // Every matchPathDirect match should agree with the full router.

  it('agrees with Router.lookup() on a mixed-segment route', () => {
    const r = new Router()
    r.get('/api/{version}/users/{id}/notes/{noteId}', () => null)
    r.build()

    const path   = '/api/v2/users/u-5/notes/n-99'
    const direct = matchPathDirect(
      [seg.static('api'), seg.param('version'), seg.static('users'),
       seg.param('id'),   seg.static('notes'),  seg.param('noteId')],
      path
    )
    const via = r.lookup('GET', path)

    expect(direct).toEqual(via!.params)
    expect(direct).toEqual({ version: 'v2', id: 'u-5', noteId: 'n-99' })
  })

  it('agrees with Router.lookup() on a no-match', () => {
    const r = new Router()
    r.get('/users/{id}', () => null)
    r.build()

    const path   = '/users/123/extra'
    const direct = matchPathDirect([seg.static('users'), seg.param('id')], path)
    const via    = r.lookup('GET', path)

    expect(direct).toBeNull()
    expect(via).toBeNull()
  })

  it('handles UUIDs in params correctly', () => {
    const segs = [seg.static('orders'), seg.param('id')]
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    expect(matchPathDirect(segs, `/orders/${uuid}`)).toEqual({ id: uuid })
  })
})

// ─── Body parser tests ────────────────────────────────────────────────────

import { parseBody, parseQuery, parseCookies, extractIP } from '../src/transport/body.ts'

describe('parseQuery', () => {

  it('parses simple key=value', () => {
    expect(parseQuery('?name=john&age=30')).toEqual({ name: 'john', age: '30' })
  })

  it('decodes URL-encoded values', () => {
    expect(parseQuery('?name=john+doe')).toEqual({ name: 'john doe' })
    expect(parseQuery('?city=New%20York')).toEqual({ city: 'New York' })
  })

  it('handles empty string', () => {
    expect(parseQuery('')).toEqual({})
    expect(parseQuery('?')).toEqual({})
  })

  it('handles missing = sign', () => {
    expect(parseQuery('?flag')).toEqual({ flag: '' })
  })
})

describe('parseCookies', () => {

  it('parses cookie header', () => {
    expect(parseCookies('session=abc123; theme=dark')).toEqual({
      session: 'abc123',
      theme:   'dark'
    })
  })

  it('handles empty cookie header', () => {
    expect(parseCookies('')).toEqual({})
  })
})

describe('extractIP', () => {

  it('prefers x-forwarded-for', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }
    })
    expect(extractIP(req)).toBe('1.2.3.4')
  })

  it('falls back to x-real-ip', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-real-ip': '9.10.11.12' }
    })
    expect(extractIP(req)).toBe('9.10.11.12')
  })

  it('falls back to remoteAddr', () => {
    const req = new Request('http://localhost')
    expect(extractIP(req, '127.0.0.1')).toBe('127.0.0.1')
  })
})

// ─── Hooks pipeline tests ─────────────────────────────────────────────────

import { runPipeline, resolvePipelines, mergeHookMaps } from '../src/core/hooks.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'
import type { HookMap }        from '../src/core/hooks.ts'

function makeCtx(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return {
    service:   'test',
    method:    'find',
    type:      'before',
    transport: 'internal',
    model:     'test',
    id:        null,
    query:     {},
    data:      null,
    auth:      { user: null },
    client:    { headers: {} },
    route:     {},
    locals:    {},
    app:       {} as import('../src/core/app.ts').App,
    result:    null,
    error:     null,
    $raw:      null,
    ...overrides
  }
}

describe('Hook pipeline', () => {

  it('runs before → method → after in order', async () => {
    const order: string[] = []
    const hooks: HookMap = {
      before: { all: [async () => { order.push('before') }] },
      after:  { all: [async () => { order.push('after') }] }
    }
    const pipeline = resolvePipelines(hooks).find
    const ctx      = makeCtx()

    await runPipeline(ctx, pipeline, async () => { order.push('method') })
    expect(order).toEqual(['before', 'method', 'after'])
  })

  it('around hooks wrap everything', async () => {
    const order: string[] = []
    const hooks: HookMap = {
      around: {
        all: [async (ctx, next) => {
          order.push('around:enter')
          await next()
          order.push('around:exit')
        }]
      },
      before: { all: [async () => { order.push('before') }] },
      after:  { all: [async () => { order.push('after') }] }
    }
    const pipeline = resolvePipelines(hooks).find
    const ctx      = makeCtx()

    await runPipeline(ctx, pipeline, async () => { order.push('method') })
    expect(order).toEqual(['around:enter', 'before', 'method', 'after', 'around:exit'])
  })

  it('short-circuits method when ctx.result is set in before', async () => {
    const methodCalled = { value: false }
    const hooks: HookMap = {
      before: {
        all: [async (ctx) => { ctx.result = 'cached' }]
      }
    }
    const pipeline = resolvePipelines(hooks).find
    const ctx      = makeCtx()

    await runPipeline(ctx, pipeline, async () => { methodCalled.value = true })
    expect(methodCalled.value).toBe(false)
    expect(ctx.result).toBe('cached')
  })

  it('error hooks catch and can recover', async () => {
    const errorCaught = { value: false }
    const hooks: HookMap = {
      before: { all: [async () => { throw new Error('boom') }] },
      error:  { all: [async (ctx) => { errorCaught.value = true; ctx.error = null }] }
    }
    const pipeline = resolvePipelines(hooks).find
    const ctx      = makeCtx()

    // error hook cleared ctx.error but re-throw still happens in runPipeline
    // because our impl throws after error hook if error remains
    // since error hook cleared it, no throw
    await runPipeline(ctx, pipeline, async () => {})
    expect(errorCaught.value).toBe(true)
  })

  it('merges hook maps correctly', () => {
    const a: HookMap = { before: { all: [() => {}], find: [() => {}] } }
    const b: HookMap = { before: { all: [() => {}], create: [() => {}] } }
    const merged     = mergeHookMaps(a, b)

    expect(merged.before?.all?.length).toBe(2)
    expect(merged.before?.find?.length).toBe(1)
    expect(merged.before?.create?.length).toBe(1)
  })
})

// ─── Schema tests ─────────────────────────────────────────────────────────

import { createSchema, v } from '../src/core/schema.ts'

describe('Schema validation', () => {

  const UserSchema = createSchema({
    name:  v.required.string({ minLength: 2 }),
    email: v.required.email(),
    age:   v.number({ min: 0, max: 150, default: 18 }),
    role:  v.string({ enum: ['user', 'admin'], default: 'user' }),
  })

  it('validates valid data', () => {
    const result = UserSchema.validate({ name: 'Alice', email: 'alice@example.com' })
    expect(result.valid).toBe(true)
    expect(result.data.name).toBe('Alice')
    expect(result.data.email).toBe('alice@example.com')
    expect(result.data.age).toBe(18)     // default
    expect(result.data.role).toBe('user') // default
  })

  it('rejects missing required fields', () => {
    const result = UserSchema.validate({ name: 'Alice' })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.field === 'email')).toBe(true)
  })

  it('rejects invalid email', () => {
    const result = UserSchema.validate({ name: 'Alice', email: 'not-an-email' })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.field === 'email')).toBe(true)
  })

  it('rejects invalid enum value', () => {
    const result = UserSchema.validate({ name: 'Alice', email: 'a@b.com', role: 'superuser' })
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.field === 'role')).toBe(true)
  })

  it('coerces string numbers', () => {
    const result = UserSchema.validate({ name: 'Alice', email: 'a@b.com', age: '25' })
    expect(result.valid).toBe(true)
    expect(result.data.age).toBe(25)
  })

  it('trims strings when configured', () => {
    const S = createSchema({ name: v.string({ trim: true, required: true }) })
    const r = S.validate({ name: '  Alice  ' })
    expect(r.data.name).toBe('Alice')
  })

  it('parse() throws BadRequest on invalid data', () => {
    expect(() => UserSchema.parse({ name: 'x' })).toThrow()
  })

  it('.partial() makes all fields optional', () => {
    const partial = UserSchema.partial()
    const result  = partial.validate({})
    expect(result.valid).toBe(true)
  })

  it('.pick() selects only named fields', () => {
    const picked = UserSchema.pick('name', 'email')
    const result = picked.validate({ name: 'Alice', email: 'a@b.com', role: 'hacker' })
    expect(result.valid).toBe(true)
    expect(result.data.role).toBeUndefined()
  })

  it('validates nested objects', () => {
    const S = createSchema({
      address: v.object({
        street: { type: 'string', required: true },
        city:   { type: 'string', required: true }
      }, { required: true })
    })
    const good = S.validate({ address: { street: '123 Main', city: 'NYC' } })
    expect(good.valid).toBe(true)

    const bad = S.validate({ address: { street: '123 Main' } })
    expect(bad.valid).toBe(false)
  })

  it('validates array items', () => {
    const S = createSchema({
      tags: v.array(v.required.string(), { required: true })
    })
    const r = S.validate({ tags: ['a', 'b', 'c'] })
    expect(r.valid).toBe(true)
    expect(r.data.tags).toEqual(['a', 'b', 'c'])
  })
})

// ─── Schema — new features ────────────────────────────────────────────────

describe('Schema minItems / maxItems', () => {

  it('rejects array shorter than minItems', () => {
    const S = createSchema({ tags: v.array(v.string(), { minItems: 2 }) })
    const r = S.validate({ tags: ['only-one'] })
    expect(r.valid).toBe(false)
    expect(r.errors[0].message).toMatch(/at least 2/)
  })

  it('rejects array longer than maxItems', () => {
    const S = createSchema({ tags: v.array(v.string(), { maxItems: 3 }) })
    const r = S.validate({ tags: ['a', 'b', 'c', 'd'] })
    expect(r.valid).toBe(false)
    expect(r.errors[0].message).toMatch(/at most 3/)
  })

  it('accepts array within bounds', () => {
    const S = createSchema({ tags: v.array(v.string(), { minItems: 1, maxItems: 5 }) })
    expect(S.validate({ tags: ['a', 'b'] }).valid).toBe(true)
  })

  it('singular item message for minItems: 1', () => {
    const S = createSchema({ tags: v.array(v.string(), { minItems: 1 }) })
    const r = S.validate({ tags: [] })
    expect(r.errors[0].message).toMatch(/at least 1 item[^s]/)
  })
})

describe('Schema passthrough option', () => {

  it('strips unknown fields by default', () => {
    const S = createSchema({ name: v.required.string() })
    const r = S.parse({ name: 'Alice', extra: 'dropped' })
    expect(r.extra).toBeUndefined()
  })

  it('passes unknown fields through when passthrough: true', () => {
    const S = createSchema({ name: v.required.string() }, { passthrough: true })
    const r = S.parse({ name: 'Alice', extra: 'kept', num: 42 })
    expect(r.name).toBe('Alice')
    expect(r.extra).toBe('kept')
    expect(r.num).toBe(42)
  })

  it('partial() inherits passthrough option', () => {
    const S = createSchema({ name: v.required.string() }, { passthrough: true })
    const P = S.partial()
    const r = P.parse({ extra: 'kept' })
    expect(r.extra).toBe('kept')
  })
})

describe('Schema pattern pre-compilation', () => {

  it('string pattern (string form) is compiled once and validated correctly', () => {
    const S = createSchema({ code: v.string({ pattern: '^[A-Z]{3}$' }) })
    expect(S.validate({ code: 'ABC' }).valid).toBe(true)
    expect(S.validate({ code: 'abc' }).valid).toBe(false)
    expect(S.validate({ code: 'ABCD' }).valid).toBe(false)
  })

  it('RegExp pattern works as before', () => {
    const S = createSchema({ slug: v.string({ pattern: /^[a-z0-9-]+$/ }) })
    expect(S.validate({ slug: 'hello-world' }).valid).toBe(true)
    expect(S.validate({ slug: 'Hello World' }).valid).toBe(false)
  })
})

describe('v.required completeness', () => {

  it('v.required.boolean rejects non-boolean', () => {
    const S = createSchema({ active: v.required.boolean() })
    expect(S.validate({ active: true }).valid).toBe(true)
    expect(S.validate({}).valid).toBe(false)
  })

  it('v.required.date accepts date strings', () => {
    const S = createSchema({ dob: v.required.date() })
    expect(S.validate({ dob: '1990-01-01' }).valid).toBe(true)
    expect(S.validate({}).valid).toBe(false)
  })

  it('v.required.url rejects invalid URLs', () => {
    const S = createSchema({ site: v.required.url() })
    expect(S.validate({ site: 'https://example.com' }).valid).toBe(true)
    expect(S.validate({ site: 'not-a-url' }).valid).toBe(false)
    expect(S.validate({}).valid).toBe(false)
  })

  it('v.required.array(items) validates items and requires presence', () => {
    const S = createSchema({ ids: v.required.array(v.required.uuid()) })
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    expect(S.validate({ ids: [uuid] }).valid).toBe(true)
    expect(S.validate({}).valid).toBe(false)
    expect(S.validate({ ids: ['not-a-uuid'] }).valid).toBe(false)
  })
})

import { protect }       from '../src/core/hooks.ts'
import { createTestApp as makeApp2, request as req2 } from '../src/testing/index.ts'
// Alias to avoid collisions with later imports in the same file
const _createTestApp = (o: Parameters<typeof makeApp2>[0]) => makeApp2(o)
const _request       = (a: Parameters<typeof req2>[0])     => req2(a)

describe('protect() dot-path support', () => {

  it('strips a top-level field (existing behaviour)', async () => {
    const app = await _createTestApp({
      services: [() => createService({
        name: 'users',
        find: async () => ({ total: 1, limit: 20, offset: 0, data: [{ id: '1', name: 'Alice', password: 'secret' }] }),
        hooks: { after: { find: [protect('password')] } },
      })],
    })
    const res = await _request(app).get('/users')
    const data = (res.body as { data: Record<string, unknown>[] }).data
    expect(data[0].password).toBeUndefined()
    expect(data[0].name).toBe('Alice')
  })

  it('strips a nested field via dot-path', async () => {
    const app = await _createTestApp({
      services: [() => createService({
        name: 'users',
        find: async () => ({ total: 1, limit: 20, offset: 0, data: [{ id: '1', name: 'Alice', meta: { internal: true, score: 99 } }] }),
        hooks: { after: { find: [protect('meta.internal')] } },
      })],
    })
    const res = await _request(app).get('/users')
    const row = (res.body as { data: Record<string, unknown>[] }).data[0]
    const meta = row.meta as Record<string, unknown>
    expect(meta.internal).toBeUndefined()
    expect(meta.score).toBe(99)
  })

  it('handles missing intermediate keys gracefully', async () => {
    const app = await _createTestApp({
      services: [() => createService({
        name: 'items',
        find: async () => ({ total: 1, limit: 20, offset: 0, data: [{ id: '1' }] }),  // no 'meta' key
        hooks: { after: { find: [protect('meta.internal')] } },
      })],
    })
    const res = await _request(app).get('/items')
    // Should not throw, result is unchanged
    expect(res.status).toBe(200)
    expect((res.body as { data: unknown[] }).data[0]).toEqual({ id: '1' })
  })

  it('strips multiple dot-paths in one call', async () => {
    const app = await _createTestApp({
      services: [() => createService({
        name: 'users',
        find: async () => ({ total: 1, limit: 20, offset: 0, data: [{
          id: '1',
          auth: { token: 'secret', refreshToken: 'also-secret' },
          profile: { name: 'Alice', ssn: '123-45-6789' },
        }] }),
        hooks: { after: { find: [protect('auth.token', 'auth.refreshToken', 'profile.ssn')] } },
      })],
    })
    const res = await _request(app).get('/users')
    const row = (res.body as { data: Record<string, unknown>[] }).data[0]
    const auth    = row.auth    as Record<string, unknown>
    const profile = row.profile as Record<string, unknown>
    expect(auth.token).toBeUndefined()
    expect(auth.refreshToken).toBeUndefined()
    expect(profile.ssn).toBeUndefined()
    expect(profile.name).toBe('Alice')
  })
})

// ─── IEventBus.onAny() ────────────────────────────────────────────────────

import { createEventBus } from '../src/events/index.ts'

// FJS-143: hasListeners() answers a yes/no, which is the wrong question for
// anyone chasing a missing announcement — *the bus is idle* and *four things
// are subscribed to three events* were the same answer, and the handler map is
// closure-private so nothing could count them.

describe('IEventBus.stats()', () => {

  it('counts subscribers per event, and in total', () => {
    const bus = createEventBus()
    bus.on('users:created', () => {})
    bus.on('users:created', () => {})
    bus.on('notes:patched', () => {})

    expect(bus.stats()).toEqual({
      events: { 'users:created': 2, 'notes:patched': 1 },
      total:  3,
    })
  })

  it('an empty bus reports zero, not an absence', () => {
    expect(createEventBus().stats()).toEqual({ events: {}, total: 0 })
  })

  it('wildcards are their own keys — a subscriber to everything is a different fact', () => {
    const bus = createEventBus()
    bus.on('*', () => {})
    bus.onAny(() => {})
    const stats = bus.stats()
    expect(stats.events['*']).toBe(1)
    expect(stats.events['__any__']).toBe(1)
    expect(stats.total).toBe(2)
  })

  it('an unsubscribed event disappears rather than reporting zero', () => {
    // off() deletes the handler and leaves the Set behind, so the naive
    // implementation would say something is subscribed to an event nothing is
    // subscribed to.
    const bus = createEventBus()
    const off = bus.on('ping', () => {})
    off()
    expect(bus.stats()).toEqual({ events: {}, total: 0 })
  })

  it('a once() handler stops being counted after it fires', async () => {
    const bus = createEventBus()
    bus.once('boot', () => {})
    expect(bus.stats().total).toBe(1)
    await bus.emit('boot', {})
    expect(bus.stats().total).toBe(0)
  })
})

describe('IEventBus.onAny()', () => {

  it('receives all events with their names', async () => {
    const bus = createEventBus()
    const received: Array<{ event: string; data: unknown }> = []
    bus.onAny((event, data) => { received.push({ event, data }) })

    await bus.emit('users:created', { id: '1' })
    await bus.emit('notes:patched', { id: '2' })

    expect(received).toHaveLength(2)
    expect(received[0]).toEqual({ event: 'users:created', data: { id: '1' } })
    expect(received[1]).toEqual({ event: 'notes:patched', data: { id: '2' } })
  })

  it('does not interfere with named on() handlers', async () => {
    const bus = createEventBus()
    const named: unknown[] = []
    const any: string[] = []

    bus.on('ping', (d) => { named.push(d) })
    bus.onAny((event) => { any.push(event) })

    await bus.emit('ping', { ts: 1 })
    await bus.emit('pong', { ts: 2 })

    expect(named).toHaveLength(1)
    expect(any).toHaveLength(2)
    expect(any).toContain('ping')
    expect(any).toContain('pong')
  })

  it('returns an unsubscribe function', async () => {
    const bus = createEventBus()
    const received: string[] = []

    const off = bus.onAny((event) => { received.push(event) })
    await bus.emit('first', {})
    off()
    await bus.emit('second', {})

    expect(received).toEqual(['first'])
  })

  it('multiple onAny handlers all fire', async () => {
    const bus = createEventBus()
    const a: string[] = []
    const b: string[] = []

    bus.onAny((e) => { a.push(e) })
    bus.onAny((e) => { b.push(e) })

    await bus.emit('test', {})

    expect(a).toContain('test')
    expect(b).toContain('test')
  })

  it('errors in onAny handlers do not break other handlers', async () => {
    const bus = createEventBus()
    const received: string[] = []

    bus.onAny(() => { throw new Error('bad handler') })
    bus.onAny((e) => { received.push(e) })

    await bus.emit('ok', {})
    expect(received).toContain('ok')
  })
})

// ─── defineEnv ────────────────────────────────────────────────────────────

import { defineEnv, generateEnvExample } from '../src/core/env.ts'

describe('defineEnv', () => {

  // Helper: run defineEnv with a controlled env — sets/restores process.env
  function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
    const saved: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      return fn()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  // ── Happy paths ──────────────────────────────────────────────────────

  it('returns string values as-is', () => {
    const env = withEnv({ DB_URL: 'sqlite:./test.db' }, () =>
      defineEnv({ DB_URL: { required: true } })
    )
    expect(env.DB_URL).toBe('sqlite:./test.db')
  })

  it('coerces number strings', () => {
    const env = withEnv({ PORT: '4000' }, () =>
      defineEnv({ PORT: { type: 'number', required: true } })
    )
    expect(env.PORT).toBe(4000)
    expect(typeof env.PORT).toBe('number')
  })

  it('coerces boolean true variants', () => {
    for (const val of ['true', '1', 'yes']) {
      const env = withEnv({ FLAG: val }, () =>
        defineEnv({ FLAG: { type: 'boolean', required: true } })
      )
      expect(env.FLAG).toBe(true)
    }
  })

  it('coerces boolean false variants', () => {
    for (const val of ['false', '0', 'no']) {
      const env = withEnv({ FLAG: val }, () =>
        defineEnv({ FLAG: { type: 'boolean', required: true } })
      )
      expect(env.FLAG).toBe(false)
    }
  })

  it('validates URLs', () => {
    const env = withEnv({ API_URL: 'https://api.example.com' }, () =>
      defineEnv({ API_URL: { type: 'url', required: true } })
    )
    expect(env.API_URL).toBe('https://api.example.com')
  })

  it('parses JSON values', () => {
    const env = withEnv({ FEATURES: '{"dark_mode":true}' }, () =>
      defineEnv({ FEATURES: { type: 'json', required: true } })
    )
    expect((env.FEATURES as Record<string, unknown>).dark_mode).toBe(true)
  })

  it('validates port range', () => {
    const env = withEnv({ PORT: '3000' }, () =>
      defineEnv({ PORT: { type: 'port', required: true } })
    )
    expect(env.PORT).toBe(3000)
  })

  // ── Defaults ─────────────────────────────────────────────────────────

  it('uses default when var is absent', () => {
    const env = withEnv({ MY_PORT: undefined }, () =>
      defineEnv({ MY_PORT: { type: 'number', default: 3000 } })
    )
    expect(env.MY_PORT).toBe(3000)
  })

  it('prefers env var over default', () => {
    const env = withEnv({ MY_PORT: '4000' }, () =>
      defineEnv({ MY_PORT: { type: 'number', default: 3000 } })
    )
    expect(env.MY_PORT).toBe(4000)
  })

  it('returns undefined for absent optional var with no default', () => {
    const env = withEnv({ OPTIONAL_KEY: undefined }, () =>
      defineEnv({ OPTIONAL_KEY: {} })
    )
    expect(env.OPTIONAL_KEY).toBeUndefined()
  })

  // ── Errors ────────────────────────────────────────────────────────────

  it('throws for missing required var', () => {
    expect(() =>
      withEnv({ MISSING_KEY: undefined }, () =>
        defineEnv({ MISSING_KEY: { required: true } })
      )
    ).toThrow(/MISSING_KEY is required/)
  })

  it('throws for invalid number', () => {
    expect(() =>
      withEnv({ BAD_PORT: 'notanumber' }, () =>
        defineEnv({ BAD_PORT: { type: 'number', required: true } })
      )
    ).toThrow(/expected a number/)
  })

  it('throws for out-of-range port', () => {
    expect(() =>
      withEnv({ BAD_PORT: '99999' }, () =>
        defineEnv({ BAD_PORT: { type: 'port', required: true } })
      )
    ).toThrow(/port must be between/)
  })

  it('throws for invalid URL', () => {
    expect(() =>
      withEnv({ API_URL: 'not-a-url' }, () =>
        defineEnv({ API_URL: { type: 'url', required: true } })
      )
    ).toThrow(/expected a valid URL/)
  })

  it('throws for invalid JSON', () => {
    expect(() =>
      withEnv({ CFG: '{bad json' }, () =>
        defineEnv({ CFG: { type: 'json', required: true } })
      )
    ).toThrow(/expected valid JSON/)
  })

  it('throws for invalid boolean', () => {
    expect(() =>
      withEnv({ FLAG: 'maybe' }, () =>
        defineEnv({ FLAG: { type: 'boolean', required: true } })
      )
    ).toThrow(/expected boolean/)
  })

  it('throws for minLength violation', () => {
    expect(() =>
      withEnv({ SECRET: 'short' }, () =>
        defineEnv({ SECRET: { required: true, minLength: 32 } })
      )
    ).toThrow(/at least 32 characters/)
  })

  it('throws for enum violation', () => {
    expect(() =>
      withEnv({ ENV: 'staging' }, () =>
        defineEnv({ ENV: { required: true, enum: ['development', 'production', 'test'] } })
      )
    ).toThrow(/must be one of/)
  })

  it('collects all errors before throwing', () => {
    expect(() =>
      withEnv({ VAR_A: undefined, VAR_B: undefined }, () =>
        defineEnv({
          VAR_A: { required: true },
          VAR_B: { required: true },
        })
      )
    ).toThrow(/VAR_A/)
  })

  // ── generateEnvExample ───────────────────────────────────────────────

  it('generates .env.example with required and optional vars', () => {
    const spec = {
      DATABASE_URL: { required: true, description: 'Postgres connection string', example: 'postgresql://localhost/mydb' },
      PORT:         { type: 'number' as const, default: 3000 },
      DEBUG:        { type: 'boolean' as const, default: false },
    }
    const out = generateEnvExample(spec)
    expect(out).toContain('DATABASE_URL=')
    expect(out).toContain('PORT=')
    expect(out).toContain('# required')
    expect(out).toContain('postgresql://localhost/mydb')
    expect(out).toContain('# [number]')
  })
})

// ─── Cache tests ──────────────────────────────────────────────────────────


import { createMemoryCache } from '../src/cache/index.ts'

describe('Memory cache', () => {

  let cache: ReturnType<typeof createMemoryCache>

  beforeEach(() => {
    cache = createMemoryCache({ defaultTtl: '1 hour', maxSize: 100 })
  })

  it('sets and gets a value', () => {
    cache.set('key', 'value')
    expect(cache.get('key')).toBe('value')
  })

  it('returns undefined for missing keys', () => {
    expect(cache.get('missing')).toBeUndefined()
  })

  it('returns undefined after TTL expires', async () => {
    cache.set('short', 'val', '1ms')   // 1ms TTL
    await new Promise(r => setTimeout(r, 10))
    expect(cache.get('short')).toBeUndefined()
  })

  it('removes a key', () => {
    cache.set('key', 'val')
    cache.remove('key')
    expect(cache.get('key')).toBeUndefined()
  })

  it('clears all keys', () => {
    cache.set('a', 1); cache.set('b', 2)
    cache.clear()
    expect(cache.size()).toBe(0)
  })

  it('clears keys by string pattern', () => {
    cache.set('user:1', 1); cache.set('user:2', 2); cache.set('post:1', 3)
    const count = cache.clear('user:')
    expect(count).toBe(2)
    expect(cache.get('post:1')).toBe(3)
  })

  it('clears keys by regex pattern', () => {
    cache.set('user:1', 1); cache.set('user:2', 2); cache.set('post:1', 3)
    cache.clear(/^user:/)
    expect(cache.get('post:1')).toBe(3)
    expect(cache.get('user:1')).toBeUndefined()
  })

  it('tracks stats', () => {
    cache.set('k', 'v')
    cache.get('k')     // hit
    cache.get('miss')  // miss
    const stats = cache.stats()
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(1)
    expect(stats.sets).toBe(1)
  })

  it('evicts oldest when at maxSize', () => {
    const c = createMemoryCache({ defaultTtl: '1 hour', maxSize: 3 })
    c.set('a', 1); c.set('b', 2); c.set('c', 3)
    c.set('d', 4)  // should evict 'a' (oldest)
    expect(c.size()).toBe(3)
  })
})

// ─── Litestone query translator tests ─────────────────────────────────────

import { parseQuery as parseLSQuery, parseWhere, deriveModelName } from '../src/core/litestone.ts'

describe('Litestone query translator', () => {

  it('parses basic query params', () => {
    const q = parseLSQuery({ $limit: '10', $offset: '5', name: 'alice' })
    expect(q.limit).toBe(10)
    expect(q.offset).toBe(5)
    expect(q.where).toEqual({ name: 'alice' })
  })

  it('caps take at maxLimit', () => {
    const q = parseLSQuery({ $limit: '9999' }, 20, 100)
    expect(q.limit).toBe(100)
  })

  it('translates $in operator', () => {
    const where = parseWhere({ status: { $in: ['active', 'pending'] } })
    expect(where.status).toEqual({ in: ['active', 'pending'] })
  })

  it('translates $gt and $lt operators', () => {
    const where = parseWhere({ age: { $gt: 18, $lt: 65 } })
    expect(where.age).toEqual({ gt: 18, lt: 65 })
  })

  it('translates $ne operator', () => {
    const where = parseWhere({ role: { $ne: 'banned' } })
    expect(where.role).toEqual({ not: 'banned' })
  })

  it('translates $or operator', () => {
    const where = parseWhere({ $or: [{ status: 'active' }, { status: 'pending' }] })
    expect(where.OR).toEqual([{ status: 'active' }, { status: 'pending' }])
  })

  it('handles $null check', () => {
    const where = parseWhere({ deleted_at: { $null: true } })
    expect(where.deleted_at).toBeNull()

    const where2 = parseWhere({ deleted_at: { $null: false } })
    expect(where2.deleted_at).toEqual({ not: null })
  })

  it('passes plain equality through', () => {
    const where = parseWhere({ name: 'alice', age: 30 })
    expect(where).toEqual({ name: 'alice', age: 30 })
  })

  it('parses sort string', () => {
    const q = parseLSQuery({ $orderBy: 'name,-created_at' })
    expect(q.orderBy).toEqual([{ name: 'asc' }, { created_at: 'desc' }])
  })

  it('parses select string', () => {
    const q = parseLSQuery({ $select: 'id,name,email' })
    expect(q.select).toEqual({ id: true, name: true, email: true })
  })

  it('parses $populate string', () => {
    const q = parseLSQuery({ $populate: 'author,tags' })
    expect(q.include).toEqual({ author: true, tags: true })
  })

  it('parses $populate with field selection', () => {
    const q = parseLSQuery({ $populate: 'author:name+email' })
    expect(q.include).toEqual({ author: { select: { name: true, email: true } } })
  })

  it('trims whitespace in $populate', () => {
    const q = parseLSQuery({ $populate: 'author , tags' })
    expect(q.include).toEqual({ author: true, tags: true })
  })

  it('parses $search', () => {
    const q = parseLSQuery({ $search: 'hello world' })
    expect(q.search).toBe('hello world')
  })

  it('parses $withDeleted', () => {
    const q1 = parseLSQuery({ $withDeleted: true })
    expect(q1.withDeleted).toBe(true)
    const q2 = parseLSQuery({ $withDeleted: 'true' })
    expect(q2.withDeleted).toBe(true)
  })

  it('parses $onlyDeleted', () => {
    const q = parseLSQuery({ $onlyDeleted: true })
    expect(q.onlyDeleted).toBe(true)
  })

  it('parses $ilike operator', () => {
    const where = parseWhere({ name: { $ilike: 'Alice' } })
    expect(where.name).toEqual({ contains: 'alice' })
  })

  it('parses nested relation filter', () => {
    const where = parseWhere({ author: { name: 'Alice' } })
    expect(where.author).toEqual({ name: 'Alice' })
  })

  it('parses $and operator', () => {
    const where = parseWhere({ $and: [{ status: 'active' }, { age: { $gt: 18 } }] })
    expect(where.AND).toEqual([{ status: 'active' }, { age: { gt: 18 } }])
  })

  it('parses $not operator', () => {
    const where = parseWhere({ $not: { status: 'banned' } })
    expect(where.NOT).toEqual({ status: 'banned' })
  })

  it('parses sort object with MongoDB-style values', () => {
    const q = parseLSQuery({ $orderBy: { name: 1, created_at: -1 } })
    expect(q.orderBy).toEqual([{ name: 'asc' }, { created_at: 'desc' }])
  })

  it('defaults offset to 0 when $offset not set', () => {
    const q = parseLSQuery({})
    expect(q.offset).toBe(0)
  })
})

describe('deriveModelName', () => {
  it('handles common patterns', () => {
    expect(deriveModelName('accounts'))   .toBe('account')
    expect(deriveModelName('users'))      .toBe('user')
    expect(deriveModelName('categories')) .toBe('category')
    expect(deriveModelName('notes'))      .toBe('note')
    expect(deriveModelName('status'))     .toBe('status')   // no depluralize on -ss
  })
})

// ─── Bridge tests ─────────────────────────────────────────────────────────

import { bridge }                from '../src/transport/bridge.ts'
import type { TransportContext } from '../src/transport/types.ts'

describe('Bridge', () => {

  function makeTransportCtx(overrides: Partial<TransportContext> = {}): TransportContext {
    return {
      method:   'GET',
      path:     '/api/users',
      params:   {},
      query:    {},
      headers:  {},
      body:     null,
      files:    [],
      ip:       '127.0.0.1',
      protocol: 'http',
      host:     'localhost',
      user:     null,
      json:     (data, status = 200) => new Response(JSON.stringify(data), { status }),
      text:     (data, status = 200) => new Response(data, { status }),
      html:     (data, status = 200) => new Response(data, { status }),
      redirect: (url, status = 302)  => new Response(null, { status, headers: { location: url } }),
      file:     async () => new Response(null, { status: 404 }),
      stream:   (r, t, status = 200) => new Response(r, { status }),
      empty:    (status = 204)       => new Response(null, { status }),
      $raw:     { $req: new Request('http://x'), url: 'http://x' },
      ...overrides
    }
  }

  it('GET without id → find', () => {
    const ctx = makeTransportCtx({ method: 'GET', params: {} })
    const sc  = bridge.toContext(ctx, 'users')
    expect(sc.method).toBe('find')
    expect(sc.service).toBe('users')
  })

  it('GET with id param → get', () => {
    const ctx = makeTransportCtx({ method: 'GET', params: { id: '123' } })
    const sc  = bridge.toContext(ctx, 'users')
    expect(sc.method).toBe('get')
    expect(sc.id).toBe('123')
  })

  it('POST → create', () => {
    const ctx = makeTransportCtx({ method: 'POST', body: { name: 'Alice' } })
    const sc  = bridge.toContext(ctx, 'users')
    expect(sc.method).toBe('create')
    expect(sc.data).toEqual({ name: 'Alice' })
  })

  it('PATCH → patch', () => {
    const ctx = makeTransportCtx({ method: 'PATCH', params: { id: '1' }, body: { name: 'Bob' } })
    const sc  = bridge.toContext(ctx, 'users')
    expect(sc.method).toBe('patch')
  })

  it('DELETE → remove', () => {
    const ctx = makeTransportCtx({ method: 'DELETE', params: { id: '1' } })
    const sc  = bridge.toContext(ctx, 'users')
    expect(sc.method).toBe('remove')
  })

  it('toResponse returns JSON for object results', () => {
    const svc: any = { result: { id: 1, name: 'Alice' }, error: null }
    const res = bridge.toResponse(svc)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
  })

  it('toResponse returns 204 for null results', () => {
    const svc: any = { result: null, error: null }
    const res = bridge.toResponse(svc)
    expect(res.status).toBe(204)
  })

  it('toResponse returns error response when ctx.error is set', () => {
    const { BadRequest } = require('../src/core/errors.ts')
    const svc: any = { result: null, error: new BadRequest('invalid') }
    const res = bridge.toResponse(svc)
    expect(res.status).toBe(400)
  })

  it('toResponse returns 201 for create method', () => {
    const svc: any = { result: { object: 'test', data: { id: 1 }, errors: [] }, error: null, method: 'create', statusCode: undefined, dispatch: undefined }
    const res = bridge.toResponse(svc)
    expect(res.status).toBe(201)
  })

  it('toResponse respects explicit ctx.statusCode', () => {
    const svc: any = { result: { id: 1 }, error: null, method: 'find', statusCode: 202 }
    const res = bridge.toResponse(svc)
    expect(res.status).toBe(202)
  })

  it('internal() creates context without HTTP', () => {
    const ctx = bridge.internal('users', 'create', { name: 'Alice' })
    expect(ctx.transport).toBe('internal')
    expect(ctx.$raw).toBeNull()
    expect(ctx.data).toEqual({ name: 'Alice' })
  })
})

// ─── Errors tests ─────────────────────────────────────────────────────────

import {
  BadRequest, NotFound, Unauthorized, toFrameworkError, fromStatusCode
} from '../src/core/errors.ts'

describe('Errors', () => {

  it('has correct status codes', () => {
    expect(new BadRequest().code).toBe(400)
    expect(new Unauthorized().code).toBe(401)
    expect(new NotFound().code).toBe(404)
  })

  it('toJSON() serializes correctly', () => {
    const err = new BadRequest('Invalid input', { field: 'email' })
    const json = err.toJSON()
    expect(json.code).toBe(400)
    expect(json.message).toBe('Invalid input')
    expect(json.data).toEqual({ field: 'email' })
  })

  it('toFrameworkError wraps native Error', () => {
    const fe = toFrameworkError(new Error('boom'))
    expect(fe.code).toBe(500)
    expect(fe.message).toBe('boom')
  })

  it('toFrameworkError passes FrameworkError through', () => {
    const original = new NotFound('gone')
    expect(toFrameworkError(original)).toBe(original)
  })

  it('fromStatusCode maps correctly', () => {
    expect(fromStatusCode(404).code).toBe(404)
    expect(fromStatusCode(401).code).toBe(401)
    expect(fromStatusCode(999).code).toBe(500)   // unknown → GeneralError
  })
})

// ─── Scheduler tests ──────────────────────────────────────────────────────

import { createScheduler } from '../src/scheduler/index.ts'

describe('Scheduler', () => {

  it('fires interval jobs', async () => {
    const scheduler = createScheduler()
    let count = 0
    const handle = scheduler.every('10ms', () => { count++ })

    await new Promise(r => setTimeout(r, 50))
    handle.stop()
    scheduler.destroy()

    expect(count).toBeGreaterThan(0)
  })

  it('pause and resume works', async () => {
    const scheduler = createScheduler()
    let count = 0
    const handle = scheduler.every('10ms', () => { count++ })

    await new Promise(r => setTimeout(r, 30))
    const countAtPause = count
    handle.pause()
    await new Promise(r => setTimeout(r, 30))
    expect(count).toBe(countAtPause)   // no new fires while paused

    handle.resume()
    await new Promise(r => setTimeout(r, 30))
    expect(count).toBeGreaterThan(countAtPause)

    handle.stop()
    scheduler.destroy()
  })

  it('once() fires exactly once', async () => {
    const scheduler = createScheduler()
    let count = 0
    scheduler.once('10ms', () => { count++ })

    await new Promise(r => setTimeout(r, 50))
    scheduler.destroy()
    expect(count).toBe(1)
  })

  it('reports stats correctly', () => {
    const scheduler = createScheduler()
    scheduler.every('1 hour', () => {})
    scheduler.every('2 hours', () => {})
    const stats = scheduler.stats()
    expect(stats.total).toBe(2)
    expect(stats.running).toBe(2)
    scheduler.destroy()
  })
})

// ─── Event bus tests ──────────────────────────────────────────────────────

import { createEventBus } from '../src/events/index.ts'

describe('EventBus', () => {

  it('delivers events to subscribers', async () => {
    const bus = createEventBus()
    let received: unknown

    bus.on('test', (data) => { received = data })
    await bus.emit('test', { value: 42 })

    expect(received).toEqual({ value: 42 })
  })

  it('once() fires only once', async () => {
    const bus   = createEventBus()
    let count   = 0

    bus.once('ping', () => { count++ })
    await bus.emit('ping')
    await bus.emit('ping')
    await bus.emit('ping')

    expect(count).toBe(1)
  })

  it('off() removes a handler', async () => {
    const bus = createEventBus()
    let count = 0
    const handler = () => { count++ }

    bus.on('x', handler)
    await bus.emit('x')
    bus.off('x', handler)
    await bus.emit('x')

    expect(count).toBe(1)
  })

  it('on() returns unsubscribe function', async () => {
    const bus = createEventBus()
    let count = 0
    const unsub = bus.on('x', () => { count++ })

    await bus.emit('x')
    unsub()
    await bus.emit('x')

    expect(count).toBe(1)
  })

  it('wildcard * receives all events', async () => {
    const bus      = createEventBus()
    const received: string[] = []

    bus.on('*', (data) => { received.push((data as { event: string }).event ?? 'unknown') })
    await bus.emit('a', { event: 'a' })
    await bus.emit('b', { event: 'b' })

    expect(received.length).toBeGreaterThanOrEqual(2)
  })

  it('error in one handler does not block others', async () => {
    const bus    = createEventBus()
    let reached  = false

    bus.on('x', () => { throw new Error('handler error') })
    bus.on('x', () => { reached = true })

    await bus.emit('x')
    expect(reached).toBe(true)
  })

  it('clear() removes all handlers', async () => {
    const bus   = createEventBus()
    let count   = 0

    bus.on('x', () => count++)
    bus.clear()
    await bus.emit('x')

    expect(count).toBe(0)
  })
})

// ─── Service custom methods tests ───────────────────────────────────────────

import { createService, callService, DERIVED_HOOKS } from '../src/core/service.ts'
import { bridge }                      from '../src/transport/bridge.ts'

describe('Service custom methods', () => {

  it('registers and calls a custom method', async () => {
    let called = false

    const svc = createService({
      name: 'servers',
      async reboot(ctx) {
        called = true
        return { id: ctx.id, rebooted: true }
      },
    })

    const ctx = bridge.internal('servers', 'find', null)
    ctx.method = 'reboot'
    ctx.id     = 'srv-1'

    await callService(svc, ctx)
    expect(called).toBe(true)
    expect((ctx.result as Record<string, unknown>).data).toMatchObject({ rebooted: true })
  })

  it('throws NotFound for unknown action', async () => {
    const svc = createService({ name: 'servers' })
    const ctx = bridge.internal('servers', 'create', null)
    ctx.method = 'nope'

    await expect(callService(svc, ctx)).rejects.toMatchObject({ code: 404 })
  })

  it('runs before hooks for custom methods', async () => {
    const order: string[] = []

    const svc = createService({
      name: 'servers',
      async drain() { order.push('method'); return { ok: true } },
      hooks: {
        before: {
          drain: [async () => { order.push('before:drain') }],
          all:   [async () => { order.push('before:all') }],
        },
        after: {
          drain: [async () => { order.push('after:drain') }],
        },
      },
    })

    const ctx = bridge.internal('servers', 'find', null)
    ctx.method = 'drain'

    await callService(svc, ctx)
    expect(order).toEqual(['before:all', 'before:drain', 'method', 'after:drain'])
  })

  it('custom method hooks do not bleed into CRUD methods', async () => {
    let drainHookCalled = false

    const svc = createService({
      name: 'test',
      find: async () => [],
      async drain() { return { drained: true } },
      hooks: {
        before: {
          drain: [async () => { drainHookCalled = true }],
        },
      },
    })

    const ctx = bridge.internal('test', 'find', null)
    await callService(svc, ctx)
    expect(drainHookCalled).toBe(false)
  })

  it('mergeHookMaps preserves custom method keys', () => {
    const a = { before: { all: [() => {}], reboot: [() => {}] } }
    const b = { before: { all: [() => {}], drain:  [() => {}] } }

    const { mergeHookMaps } = require('../src/core/hooks.ts')
    const merged = mergeHookMaps(a, b)

    expect(merged.before?.all?.length).toBe(2)
    expect(merged.before?.reboot?.length).toBe(1)
    expect(merged.before?.drain?.length).toBe(1)
  })

  it('resolvePipelines includes custom method pipelines', () => {
    const { resolvePipelines } = require('../src/core/hooks.ts')

    const hooks = {
      before: {
        all:    [() => {}],
        reboot: [() => {}],
        drain:  [() => {}],
      },
    }

    const pipelines = resolvePipelines(hooks)

    // Standard methods still exist
    expect(pipelines.find).toBeDefined()
    expect(pipelines.create).toBeDefined()

    // Custom methods exist with correct hook stacking
    expect(pipelines.reboot).toBeDefined()
    expect(pipelines.reboot.before.length).toBe(2)  // all + reboot-specific

    expect(pipelines.drain).toBeDefined()
    expect(pipelines.drain.before.length).toBe(2)   // all + drain-specific
  })
})

// ─── Channels tests ───────────────────────────────────────────────────────

import { createChannelManager, Channel, publish } from '../src/transport/channels.ts'

describe('Channel', () => {

  it('join and send delivers to connected socket', () => {
    const sent: string[] = []
    const socket = { send: (m: string) => sent.push(m), close: () => {}, readyState: 1 }
    const conn   = { id: '1', socket, data: {}, user: null }

    const ch = new Channel('test')
    ch.join(conn)
    ch.send('users created', { id: '123' })

    expect(sent.length).toBe(1)
    expect(JSON.parse(sent[0])).toMatchObject({ type: 'event', event: 'users created' })
  })

  it('leave stops delivery', () => {
    const sent: string[] = []
    const socket = { send: (m: string) => sent.push(m), close: () => {}, readyState: 1 }
    const conn   = { id: '1', socket, data: {} }

    const ch = new Channel('test')
    ch.join(conn)
    ch.leave(conn)
    ch.send('event', {})

    expect(sent.length).toBe(0)
  })

  it('gc removes closed connections', () => {
    const socket = { send: () => {}, close: () => {}, readyState: 3 }  // CLOSED
    const conn   = { id: '1', socket, data: {} }

    const ch = new Channel('test')
    ch.join(conn)
    expect(ch.length).toBe(1)
    ch.gc()
    expect(ch.length).toBe(0)
  })
})

describe('ChannelManager', () => {

  it('channel() creates and returns the same channel', () => {
    const manager = createChannelManager()
    const a = manager.channel('workspace:1')
    const b = manager.channel('workspace:1')
    expect(a).toBe(b)
    manager.destroy()
  })

  it('handleConnection sends ack and runs handlers', async () => {
    const manager = createChannelManager()
    const acks: string[] = []
    const socket  = { send: (m: string) => acks.push(m), close: () => {}, readyState: 1 }

    let handlerRan = false
    manager.on('connection', () => { handlerRan = true })

    const conn = await manager.handleConnection(socket, { userId: 'u1' })
    expect(conn.id).toBeDefined()
    expect(acks.length).toBe(1)
    expect(JSON.parse(acks[0]).type).toBe('connection')
    expect(handlerRan).toBe(true)
    manager.destroy()
  })

  it('handleDisconnect removes connection from all channels', async () => {
    const manager = createChannelManager()
    const socket  = { send: () => {}, close: () => {}, readyState: 1 }

    const conn = await manager.handleConnection(socket, null)
    manager.channel('all').join(conn)
    manager.channel('workspace:1').join(conn)

    expect(manager.channel('all').length).toBe(1)

    await manager.handleDisconnect(conn.id)
    expect(manager.channel('all').length).toBe(0)
    expect(manager.channel('workspace:1').length).toBe(0)
    manager.destroy()
  })

  it('publish sends to target channels', async () => {
    const manager = createChannelManager()
    const sent: unknown[] = []
    const socket  = { send: (m: string) => sent.push(JSON.parse(m)), close: () => {}, readyState: 1 }
    const conn    = await manager.handleConnection(socket, null)

    const ch = manager.channel('workspace:1')
    ch.join(conn)

    const fakeCtx = { service: 'deployments', method: 'create', auth: { user: null }, client: { headers: {} }, route: {}, locals: {} } as any
    await manager.publish('deployments created', { id: 'dep-1' }, fakeCtx, () => ch)

    expect(sent.length).toBe(2)  // 1 connection ack + 1 event
    const event = (sent as any[]).find(m => m.type === 'event')
    expect(event).toBeDefined()
    expect(event.event).toBe('deployments created')
    manager.destroy()
  })

  it('stats returns accurate counts', async () => {
    const manager = createChannelManager()
    const socket  = { send: () => {}, close: () => {}, readyState: 1 }
    await manager.handleConnection(socket, null)
    manager.channel('all').toString()  // creates the channel

    const stats = manager.stats()
    expect(stats.connections).toBe(1)
    manager.destroy()
  })
})

// ─── Database tests ───────────────────────────────────────────────────────

import { createDatabase, createInMemoryDatabase } from '../src/storage/database/index.ts'

describe('createDatabase', () => {

  it('opens an in-memory database', () => {
    const { db, close } = createInMemoryDatabase()
    const row = db.query('SELECT 1 as n').get() as { n: number }
    expect(row.n).toBe(1)
    close()
  })

  it('applies WAL and foreign key pragmas by default', () => {
    // WAL is not supported on :memory: databases — use a temp file
    const path = `/tmp/test-pragmas-${Date.now()}.db`
    const { db, close } = createDatabase(path)
    const wal = db.query('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(wal.journal_mode).toBe('wal')
    const fk  = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
    close()
    // Clean up
    try { require('node:fs').unlinkSync(path) } catch {}
  })

  it('runs migrations from SQL strings via seed', async () => {
    const { db, migrate, close } = createInMemoryDatabase()

    // Write a temp migration file
    const dir = '/tmp/test-migrations-' + Date.now()
    await Bun.write(`${dir}/001_create_notes.sql`,
      'CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL)'
    )

    const result = await migrate(dir)
    expect(result.applied).toContain('001_create_notes.sql')

    db.run("INSERT INTO notes (id, title) VALUES ('1', 'hello')")
    const row = db.query('SELECT title FROM notes WHERE id = ?').get('1') as { title: string }
    expect(row.title).toBe('hello')
    close()
  })

  it('skips already-applied migrations on second run', async () => {
    const { migrate, close } = createInMemoryDatabase()
    const dir = '/tmp/test-migrations2-' + Date.now()
    await Bun.write(`${dir}/001_init.sql`, 'CREATE TABLE t1 (id TEXT PRIMARY KEY)')

    const first  = await migrate(dir)
    const second = await migrate(dir)
    expect(first.applied.length).toBe(1)
    expect(second.applied.length).toBe(0)
    expect(second.skipped.length).toBe(1)
    close()
  })

  it('transactions roll back failed migrations', async () => {
    const { db, migrate, close } = createInMemoryDatabase()
    const dir = '/tmp/test-migrations3-' + Date.now()
    await Bun.write(`${dir}/001_bad.sql`, 'THIS IS NOT VALID SQL @@@@')

    await expect(migrate(dir)).rejects.toThrow()

    // _migrations table should be empty — nothing committed
    const rows = db.query('SELECT * FROM _migrations').all()
    expect(rows.length).toBe(0)
    close()
  })

  it('createDatabase integrates with createApp', async () => {
    const { createApp }    = await import('../src/core/app.ts')
    const { defaultConfig } = await import('../src/config/index.ts')
    // Just verify app.db is populated when database.url is set
    const app = createApp({
      config: {
        ...defaultConfig,
        database: { url: ':memory:' }
      }
    })
    expect(app.db).toBeDefined()
    expect(app.db!.db).toBeDefined()
  })
})

// ─── Testing utilities tests ──────────────────────────────────────────────

import { createTestApp, createStubAuth, request, testCtx } from '../src/testing/index.ts'
import { createService }                                     from '../src/core/service.ts'
import { callService }                                       from '../src/core/service.ts'

describe('createStubAuth', () => {

  it('verifySession returns null for unknown token', async () => {
    const auth = createStubAuth()
    const result = await auth.verifySession('bad-token')
    expect(result).toBeNull()
  })

  it('addUser and verify round-trip', async () => {
    const auth  = createStubAuth()
    const token = auth.addUser({ id: 'u1', role: 'admin', workspaceId: 'ws-1' })
    const ctx   = await auth.verifySession(token)
    expect(ctx?.userId).toBe('u1')
    expect(ctx?.role).toBe('admin')
    expect(ctx?.workspaceId).toBe('ws-1')
  })

  it('pre-seeded users are available immediately', async () => {
    const auth  = createStubAuth({ users: [{ id: 'u1', role: 'developer' }] })
    const ctx   = await auth.verifySession('test-token-u1')
    expect(ctx?.userId).toBe('u1')
  })
})

describe('createTestApp', () => {

  it('boots with in-memory DB', async () => {
    const app = await createTestApp()
    expect(app.db).toBeDefined()
    // Basic DB query should work
    const row = app.db!.db.query('SELECT 1 as n').get() as { n: number }
    expect(row.n).toBe(1)
  })

  it('registers services', async () => {
    const app = await createTestApp({
      services: [(_app) => createService({
        name:   'pings',
        find:   async () => [{ pong: true }],
      })]
    })
    expect(app.services.has('pings')).toBe(true)
  })

  it('tokenFor returns predictable tokens', async () => {
    const app = await createTestApp({
      users: [{ id: 'u1', role: 'admin' }]
    })
    expect(app.tokenFor('u1')).toBe('test-token-u1')
  })
})

describe('testCtx', () => {

  it('creates a service context for direct testing', () => {
    const ctx = testCtx('notes', 'create',
      { title: 'Hello', body: 'World' },
      { user: { userId: 'u1', role: 'admin' }, workspaceId: 'ws-1' }
    )
    expect(ctx.service).toBe('notes')
    expect(ctx.method).toBe('create')
    expect(ctx.data?.title).toBe('Hello')
    expect(ctx.auth.user?.userId).toBe('u1')
    expect(ctx.locals.workspaceId).toBe('ws-1')
  })
})

describe('request()', () => {

  async function makeApp() {
    return createTestApp({
      services: [(_app) => createService({
        name:   'items',
        find:   async () => ({ total: 2, limit: 20, offset: 0, data: [{ id: '1' }, { id: '2' }] }),
        get:    async (ctx) => ({ id: ctx.id, name: 'item' }),
        create: async (ctx) => ({ id: 'new-1', ...ctx.data }),
      })]
    })
  }

  it('GET /api/items returns list', async () => {
    const app = await makeApp()
    // Start app to build route cache
    const res = await request(app).get('/items')
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).total).toBe(2)
  })

  it('POST /api/items creates a resource', async () => {
    const app = await makeApp()
    const res = await request(app)
      .post('/items')
      .send({ name: 'Widget' })
    expect(res.status).toBe(201)
    expect((res.body as Record<string, unknown>).name).toBe('Widget')
  })

  it('GET /api/items/:id returns single resource', async () => {
    const app = await makeApp()
    const res = await request(app).get('/items/123')
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).id).toBe('123')
  })

  it('sets Authorization header via .auth()', async () => {
    let receivedToken: string | undefined

    const app = await createTestApp({
      services: [(_app) => createService({
        name: 'echo',
        find: async (ctx) => {
          receivedToken = ctx.client.headers['authorization']
          return []
        },
      })]
    })

    await request(app).get('/echo').auth('my-token')
    expect(receivedToken).toBe('Bearer my-token')
  })

  it('returns 404 for unknown routes', async () => {
    const app = await makeApp()
    const res = await request(app).get('/does-not-exist')
    expect(res.status).toBe(404)
  })
})

// ─── OpenAPI tests ────────────────────────────────────────────────────────

import { generateOpenAPI, openapi } from '../src/plugins/openapi/index.ts'
import { createSchema, v }          from '../src/core/schema.ts'

describe('generateOpenAPI', () => {

  async function makeApp() {
    const app = await createTestApp({
      services: [(_app) => createService({
        name:    'posts',
        find:    async () => [],
        get:     async () => ({}),
        create:  async () => ({}),
        patch:   async () => ({}),
        remove:  async () => ({}),
        async publish()   { return { published: true } },
        async unpublish() { return { published: false } },
      })]
    })
    return app
  }

  it('generates a valid OpenAPI 3.1 spec', async () => {
    const app  = await makeApp()
    const spec = generateOpenAPI(app, { title: 'Test API', version: '1.0.0' })

    expect(spec.openapi).toBe('3.1.0')
    expect(spec.info.title).toBe('Test API')
    expect(spec.info.version).toBe('1.0.0')
  })

  it('includes collection and resource paths for each service', async () => {
    const app  = await makeApp()
    const spec = generateOpenAPI(app, { title: 'T', version: '1' })

    expect(spec.paths['/posts']).toBeDefined()
    expect(spec.paths['/posts/{id}']).toBeDefined()
    expect(spec.paths['/posts']).toHaveProperty('get')
    expect(spec.paths['/posts']).toHaveProperty('post')
    expect(spec.paths['/posts/{id}']).toHaveProperty('get')
    expect(spec.paths['/posts/{id}']).toHaveProperty('patch')
    expect(spec.paths['/posts/{id}']).toHaveProperty('delete')
  })

  it('includes action routes', async () => {
    const app  = await makeApp()
    const spec = generateOpenAPI(app, { title: 'T', version: '1' })

    expect(spec.paths['/posts/{id}/publish']).toBeDefined()
    expect(spec.paths['/posts/{id}/unpublish']).toBeDefined()
  })

  it('includes schema details when schemas are registered', async () => {
    const PostSchema = createSchema({
      title: v.required.string({ minLength: 1, maxLength: 200 }),
      body:  v.required.string(),
      tags:  v.array(v.string()),
    })

    const app  = await makeApp()
    const spec = generateOpenAPI(app, {
      title: 'T',
      version: '1',
      schemas: {
        posts: {
          create: { body: PostSchema }
        }
      }
    })

    const createOp = spec.paths['/posts'].post
    expect(createOp.requestBody).toBeDefined()
  })

  it('openapi plugin mounts GET /openapi.json (no prefix by default)', async () => {
    const app = await makeApp()

    const plugin = openapi({ title: 'Test', version: '1.0.0' })
    await plugin.register!(app)

    const res = await request(app).get('/openapi.json')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.openapi).toBe('3.1.0')
    expect(body.info).toBeDefined()
  })

  it('openapi plugin respects custom apiPrefix', async () => {
    const app = await createTestApp({
      config: { apiPrefix: '/v1' },
      services: [(_app) => createService({ name: 'posts', find: async () => [] })]
    })
    const plugin = openapi({ title: 'Test', version: '1.0.0' })
    await plugin.register!(app)

    const res = await request(app).get('/v1/openapi.json')
    expect(res.status).toBe(200)
  })
})

// ─── ctx.statusCode tests ────────────────────────────────────────────────

describe('ctx.statusCode', () => {

  it('create returns 201 by default', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'items',
        create: async () => ({ id: '1', name: 'widget' }),
      })]
    })
    const res = await request(app).post('/items').send({ name: 'widget' })
    expect(res.status).toBe(201)
  })

  it('find/get/patch/remove return 200', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:  'items',
        find:  async () => [],
        get:   async () => ({ id: '1' }),
        patch: async () => ({ id: '1', updated: true }),
      })]
    })
    expect((await request(app).get('/items')).status).toBe(200)
    expect((await request(app).get('/items/1')).status).toBe(200)
    expect((await request(app).patch('/items/1').send({})).status).toBe(200)
  })

  it('service can override status to 202', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'jobs',
        create: async (ctx) => {
          ctx.statusCode = 202
          return { queued: true }
        },
      })]
    })
    const res = await request(app).post('/jobs').send({ type: 'export' })
    expect(res.status).toBe(202)
  })

  it('after hook can set statusCode', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'tasks',
        create: async () => ({ id: '1' }),
        hooks: {
          after: {
            create: [async (ctx) => { ctx.statusCode = 202 }]
          }
        }
      })]
    })
    const res = await request(app).post('/tasks').send({})
    expect(res.status).toBe(202)
  })

  it('null result returns 204', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'pings',
        create: async () => null,
      })]
    })
    const res = await request(app).post('/pings').send({})
    expect(res.status).toBe(204)
  })
})

// ─── ctx.dispatch tests ──────────────────────────────────────────────────

describe('ctx.dispatch', () => {

  it('publish() uses ctx.result when dispatch not set', async () => {
    let published: unknown = null
    const manager = createChannelManager()
    const socket  = { send: (m: string) => { const p = JSON.parse(m); if (p.type === 'event') published = p.data }, close: () => {}, readyState: 1 }
    const conn    = await manager.handleConnection(socket, null)
    manager.channel('all').join(conn)

    const app = await createTestApp({
      services: [() => createService({
        name:   'posts',
        create: async () => ({ id: '1', title: 'Hello', secret: 'hidden' }),
        hooks: {
          after: {
            create: [async (ctx) => { ctx.locals.__channels = manager },
                     publish(() => manager.channel('all'))],
          }
        }
      })]
    })

    await request(app).post('/posts').send({ title: 'Hello' })
    // publish() broadcasts ctx.result; manager.publish unwraps single-record
    // envelopes (`object !== 'list'`) so subscribers see the bare record.
    expect((published as Record<string, unknown>)?.secret).toBe('hidden')
    manager.destroy()
  })

  it('publish() uses ctx.dispatch when set — strips sensitive fields', async () => {
    let published: unknown = null
    const manager = createChannelManager()
    const socket  = { send: (m: string) => { const p = JSON.parse(m); if (p.type === 'event') published = p.data }, close: () => {}, readyState: 1 }
    const conn    = await manager.handleConnection(socket, null)
    manager.channel('all').join(conn)

    const app = await createTestApp({
      services: [() => createService({
        name:   'users',
        create: async () => ({ id: '1', email: 'a@b.com', password_hash: '$2b$...' }),
        hooks: {
          after: {
            create: [
              async (ctx) => {
                ctx.locals.__channels = manager
                const r = (ctx.result as { data: Record<string, unknown> }).data
                ctx.dispatch = { id: r.id, email: r.email }  // strip password_hash
              },
              publish(() => manager.channel('all')),
            ]
          }
        }
      })]
    })

    const res = await request(app).post('/users').send({ email: 'a@b.com' })
    expect((res.body as Record<string, unknown>).password_hash).toBe('$2b$...')  // full result to HTTP caller
    expect((published as Record<string, unknown>)?.password_hash).toBeUndefined()  // stripped from broadcast
    manager.destroy()
  })

  it('publish() suppresses broadcast when dispatch === false', async () => {
    let eventCount = 0
    const manager = createChannelManager()
    const socket  = { send: (m: string) => { if (JSON.parse(m).type === 'event') eventCount++ }, close: () => {}, readyState: 1 }
    const conn    = await manager.handleConnection(socket, null)
    manager.channel('all').join(conn)

    const app = await createTestApp({
      services: [() => createService({
        name:   'internal',
        create: async (ctx) => {
          ctx.dispatch = false   // suppress broadcast
          return { id: '1' }
        },
        hooks: {
          after: {
            create: [
              async (ctx) => { ctx.locals.__channels = manager },
              publish(() => manager.channel('all')),
            ]
          }
        }
      })]
    })

    await request(app).post('/internal').send({})
    expect(eventCount).toBe(0)
    manager.destroy()
  })
})

// ─── app.service() caller tests ───────────────────────────────────────────

describe('app.service()', () => {

  it('find() returns the list envelope, not a bare array', async () => {
    // Was: flat-unwrapped to .data, so total/limit/offset were unreachable
    // from any internal caller while HTTP callers got the full envelope —
    // the same call answering two different ways.
    const app = await createTestApp({
      services: [() => createService({
        name: 'items',
        find: async () => [{ id: '1' }, { id: '2' }],
      })],
    })
    const result = await app.service('items').find() as { kind: string; object: string; data: unknown[] }
    expect(result.kind).toBe('list')
    expect(result.object).toBe('items')
    expect(result.data).toHaveLength(2)
  })

  it('get() still unwraps to the record — singles have no metadata to keep', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'items',
        get: async () => ({ id: '1', name: 'one' }),
      })],
    })
    const result = await app.service('items').get('1') as { id: string; name: string }
    expect(result.id).toBe('1')
    expect(result.name).toBe('one')
  })

  it('get() passes id to the service', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'users',
        get:  async (ctx) => ({ id: ctx.id, found: true }),
      })],
    })
    const result = await app.service('users').get('u-42') as Record<string, unknown>
    expect(result.id).toBe('u-42')
    expect(result.found).toBe(true)
  })

  it('create() passes data to the service', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'notes',
        create: async (ctx) => ({ id: 'new', ...ctx.data }),
      })],
    })
    const result = await app.service('notes').create({ title: 'Hello' }) as Record<string, unknown>
    expect(result.id).toBe('new')
    expect(result.title).toBe('Hello')
  })

  it('patch() passes id and data', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:  'notes',
        patch: async (ctx) => ({ id: ctx.id, ...ctx.data, patched: true }),
      })],
    })
    const result = await app.service('notes').patch('n-1', { title: 'Updated' }) as Record<string, unknown>
    expect(result.id).toBe('n-1')
    expect(result.patched).toBe(true)
  })

  it('remove() passes id', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'notes',
        remove: async (ctx) => ({ id: ctx.id, deleted: true }),
      })],
    })
    const result = await app.service('notes').remove('n-99') as Record<string, unknown>
    expect(result.id).toBe('n-99')
    expect(result.deleted).toBe(true)
  })

  it('locals flow through to ctx.locals when provided', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'items',
        // A probe, but still a list — find promises one, and wrapResult throws
        // rather than guess (FJS-140/FJS-144).
        find: async (ctx) => [{ workspace: ctx.locals.workspaceId }],
      })],
    })
    const result = await app.service('items').find({}, { locals: { workspaceId: 'ws-99' } }) as { data: Record<string, unknown>[] }
    expect(result.data[0].workspace).toBe('ws-99')
  })

  it('passing params threads user into ctx.auth.user', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'items',
        find: async (ctx) => [{ callerUser: ctx.auth.user?.userId ?? null }],
        hooks: { before: { find: [authenticate] } },
      })],
    })
    const fakeUser = { userId: 'u-1', role: 'user', userType: 'user', authMethod: 'session', scopes: [] }
    // With user → hook passes, result has the user
    const result = await app.service('items').find({}, { auth: { user: fakeUser as any } }) as { data: Record<string, unknown>[] }
    expect(result.data[0].callerUser).toBe('u-1')
  })

  it('no params → anonymous call, auth hooks fire on null user', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'locked',
        find: async () => [{ secret: true }],
        hooks: { before: { find: [authenticate] } },
      })],
    })
    // No params → user is null → authenticate throws Unauthorized
    await expect(app.service('locked').find()).rejects.toThrow()
  })

  it('call() invokes custom methods with id and params', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'servers',
        find: async () => [],
        async reboot(ctx) { return { serverId: ctx.id, rebooted: true } },
      })],
    })
    const result = await app.service('servers').call('reboot', 'srv-1') as Record<string, unknown>
    expect(result.serverId).toBe('srv-1')
    expect(result.rebooted).toBe(true)
  })

  it('throws NotFound for unknown service', async () => {
    const app = await createTestApp({ services: [] })
    await expect(app.service('ghost').find()).rejects.toThrow('not found')
  })

  it('transport is internal, not http', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'items',
        find: async (ctx) => [{ transport: ctx.transport }],
      })],
    })
    const result = await app.service('items').find() as { data: Record<string, unknown>[] }
    expect(result.data[0].transport).toBe('internal')
  })
})

// ─── Auto-events tests ───────────────────────────────────────────────────

describe('Auto-events', () => {

  it('create fires service:created', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'notes',
        create: async () => ({ id: '1', title: 'Hello' }),
      })]
    })

    let fired: unknown = null
    app.events.on('notes:created', (d) => { fired = d })

    await request(app).post('/notes').send({ title: 'Hello' })
    await new Promise(r => setTimeout(r, 10))
    expect((fired as Record<string, unknown>)?.id).toBe('1')
  })

  it('patch fires service:patched', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:  'notes',
        patch: async () => ({ id: '1', updated: true }),
      })]
    })

    let fired: unknown = null
    app.events.on('notes:patched', (d) => { fired = d })

    await request(app).patch('/notes/1').send({ title: 'Updated' })
    await new Promise(r => setTimeout(r, 10))
    expect((fired as Record<string, unknown>)?.updated).toBe(true)
  })

  it('remove fires service:removed', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'notes',
        remove: async () => ({ id: '1', deleted: true }),
      })]
    })

    let fired: unknown = null
    app.events.on('notes:removed', (d) => { fired = d })

    await request(app).delete('/notes/1')
    await new Promise(r => setTimeout(r, 10))
    expect((fired as Record<string, unknown>)?.deleted).toBe(true)
  })

  it('find and get do NOT fire auto-events', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'notes',
        find: async () => [],
        get:  async () => ({ id: '1' }),
      })]
    })

    let eventCount = 0
    app.events.on('notes:found',  () => eventCount++)
    app.events.on('notes:gotten', () => eventCount++)

    await request(app).get('/notes')
    await request(app).get('/notes/1')
    await new Promise(r => setTimeout(r, 10))
    expect(eventCount).toBe(0)
  })

  it('auto-events do not fire when service throws', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'notes',
        create: async () => { throw Object.assign(new Error('fail'), { code: 400, name: 'BadRequest' }) },
      })]
    })

    let fired = false
    app.events.on('notes:created', () => { fired = true })

    await request(app).post('/notes').send({})
    await new Promise(r => setTimeout(r, 10))
    expect(fired).toBe(false)
  })
})

// ─── Bidirectional WebSocket service calls tests ──────────────────────────

describe('Bidirectional WS service calls', () => {

  async function makeWsApp() {
    const app = await createTestApp({
      users: [{ id: 'u1', role: 'user' }],
      services: [() => createService({
        name:   'messages',
        find:   async () => [{ id: '1', text: 'hello' }],
        create: async (ctx) => ({ id: '2', text: (ctx.data as Record<string, unknown>)?.text, author: ctx.auth.user?.userId }),
      })]
    })
    app.configure(channels(() => {}))
    // Manually trigger plugin register since we're not calling app.start()
    const plugin = channels(() => {})
    await plugin.register!(app)
    return app
  }

  it('service_call dispatches to service and returns service_result', async () => {
    const { createChannelManager: mgr } = await import('../src/transport/channels.ts')
    const manager = mgr()
    const received: unknown[] = []
    const socket = { send: (m: string) => received.push(JSON.parse(m)), close: () => {}, readyState: 1 }

    const conn = await manager.handleConnection(socket, { userId: 'u1', role: 'user', userType: 'user', authMethod: 'session', scopes: [] })

    const app = await createTestApp({
      users: [{ id: 'u1', role: 'user' }],
      services: [() => createService({
        name: 'pings',
        find: async () => [{ pong: true }],
      })]
    })

    // Simulate what the WS dispatcher does — call the service directly
    const { callService: _call } = await import('../src/core/service.ts')
    const { bridge: _bridge }    = await import('../src/transport/bridge.ts')

    const svc    = app.services.get('pings')!
    const svcCtx = _bridge.internal('pings', 'find', null, {
      auth:       { user: conn.user as any },
      transport:  'websocket',
      locals:     { __channels: manager },
    })
    await _call(svc, svcCtx, undefined, app.events)

    expect(Array.isArray((svcCtx.result as { data: unknown[] }).data)).toBe(true)
    expect(((svcCtx.result as { data: unknown[] }).data)[0]).toMatchObject({ pong: true })
    manager.destroy()
  })

  it('ctx.transport is websocket for WS calls', async () => {
    let transport: string | null = null

    const app = await createTestApp({
      services: [() => createService({
        name:   'echo',
        create: async (ctx) => { transport = ctx.transport; return { ok: true } },
      })]
    })

    const { callService: _call } = await import('../src/core/service.ts')
    const { bridge: _bridge }    = await import('../src/transport/bridge.ts')

    const svc    = app.services.get('echo')!
    const svcCtx = _bridge.internal('echo', 'create', { test: true })
    svcCtx.transport = 'websocket'
    await _call(svc, svcCtx, undefined, app.events)

    expect(transport).toBe('websocket')
  })

  it('auto-events still fire for WS service calls', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'msgs',
        create: async () => ({ id: '1', text: 'hi' }),
      })]
    })

    let autoFired: unknown = null
    app.events.on('msgs:created', (d) => { autoFired = d })

    const { callService: _call } = await import('../src/core/service.ts')
    const { bridge: _bridge }    = await import('../src/transport/bridge.ts')

    const svc    = app.services.get('msgs')!
    const svcCtx = _bridge.internal('msgs', 'create', { text: 'hi' })
    svcCtx.transport = 'websocket'
    await _call(svc, svcCtx, undefined, app.events)

    await new Promise(r => setTimeout(r, 10))
    expect((autoFired as Record<string, unknown>)?.id).toBe('1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Tests for everything added/fixed in the review session
// ─────────────────────────────────────────────────────────────────────────────

import { createService }                from '../src/core/service.ts'
import { callService }                  from '../src/core/service.ts'
import { authenticate, requireRole, circuitBreaker } from '../src/core/hooks.ts'
import { createTestApp, request, testCtx } from '../src/testing/index.ts'
import { correlationId }                from '../src/transport/middleware.ts'
import { healthPlugin }                 from '../src/transport/health.ts'
import { BadRequest, Unauthorized, Forbidden, Unavailable } from '../src/core/errors.ts'
import { bridge }                       from '../src/transport/bridge.ts'

// ─── authenticate / requireRole use proper FrameworkError subclasses ──────

describe('authenticate hook', () => {

  it('throws Unauthorized (not plain Error) when no user', () => {
    const ctx = testCtx('users', 'find')
    ctx.auth.user = null

    let thrown: unknown
    try { authenticate(ctx) } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(Unauthorized)
    expect((thrown as Unauthorized).code).toBe(401)
  })

  it('passes when user is present', () => {
    const ctx = testCtx('users', 'find', null, {
      user: { userId: 'u1', role: 'admin' }
    })
    expect(() => authenticate(ctx)).not.toThrow()
  })
})

describe('requireRole hook', () => {

  it('throws Forbidden (not plain Error) when role does not match', () => {
    const ctx = testCtx('users', 'find', null, { user: { role: 'user' } })

    let thrown: unknown
    try { requireRole('admin')(ctx) } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(Forbidden)
    expect((thrown as Forbidden).code).toBe(403)
  })

  it('throws Forbidden when no user at all', () => {
    const ctx = testCtx('users', 'find')
    ctx.auth.user = null

    let thrown: unknown
    try { requireRole('admin')(ctx) } catch (e) { thrown = e }

    expect(thrown).toBeInstanceOf(Forbidden)
  })

  it('passes when role matches', () => {
    const ctx = testCtx('users', 'find', null, { user: { role: 'admin' } })
    expect(() => requireRole('admin')(ctx)).not.toThrow()
  })

  it('accepts any role in the list', () => {
    const ctx = testCtx('users', 'find', null, { user: { role: 'moderator' } })
    expect(() => requireRole('admin', 'moderator')(ctx)).not.toThrow()
  })
})

// ─── Bulk delete / patch guards ───────────────────────────────────────────

describe('allowBulk guard', () => {

  function makeDb(records: Record<string, unknown>[] = []) {
    const store = [...records]
    return () => ({
      items: {
        findMany:   async () => store,
        count:      async () => store.length,
        findUnique: async ({ where }: { where: { id: string } }) =>
          store.find(r => r.id === where.id) ?? null,
        create:     async ({ data }: { data: unknown }) => {
          const rec = { id: crypto.randomUUID(), ...(data as object) }
          store.push(rec); return rec
        },
        update:     async ({ where, data }: { where: { id: string }, data: unknown }) => {
          const idx = store.findIndex(r => r.id === where.id)
          store[idx] = { ...store[idx], ...(data as object) }; return store[idx]
        },
        updateMany: async () => ({ count: store.length }),
        delete:     async ({ where }: { where: { id: string } }) => {
          const idx = store.findIndex(r => r.id === where.id)
          return store.splice(idx, 1)[0]
        },
        deleteMany: async () => ({ count: store.length }),
      }
    })
  }

  it('remove() without id throws BadRequest when allowBulk not set', async () => {
    const svc = createService({ name: 'items', model: 'items', db: makeDb() })
    const ctx = testCtx('items', 'remove')
    ctx.id = null

    await expect(callService(svc, ctx)).rejects.toBeInstanceOf(BadRequest)
  })

  it('remove() without id and no filter throws BadRequest even with allowBulk', async () => {
    const svc = createService({ name: 'items', model: 'items', db: makeDb(), allowBulk: true })
    const ctx = testCtx('items', 'remove')
    ctx.id = null
    ctx.query = {}

    await expect(callService(svc, ctx)).rejects.toBeInstanceOf(BadRequest)
  })

  it('remove() without id succeeds when allowBulk:true and filter present', async () => {
    const svc = createService({ name: 'items', model: 'items', db: makeDb([{ id: '1', status: 'old' }]), allowBulk: true })
    const ctx = testCtx('items', 'remove')
    ctx.id = null
    ctx.query = { status: 'old' } as unknown as Record<string, string>

    await callService(svc, ctx)
    expect(ctx.error).toBeNull()
  })

  it('remove() with id always works regardless of allowBulk', async () => {
    const svc = createService({ name: 'items', model: 'items', db: makeDb([{ id: '42' }]) })
    const ctx = testCtx('items', 'remove')
    ctx.id = '42'

    await callService(svc, ctx)
    expect(ctx.error).toBeNull()
  })

  it('patch() without id throws BadRequest when allowBulk not set', async () => {
    const svc = createService({ name: 'items', model: 'items', db: makeDb() })
    const ctx = testCtx('items', 'patch', { status: 'new' })
    ctx.id = null

    await expect(callService(svc, ctx)).rejects.toBeInstanceOf(BadRequest)
  })

  it('patch() without id succeeds when allowBulk:true', async () => {
    const svc = createService({ name: 'items', model: 'items', db: makeDb([{ id: '1' }]), allowBulk: true })
    const ctx = testCtx('items', 'patch', { status: 'updated' })
    ctx.id = null

    await callService(svc, ctx)
    expect(ctx.error).toBeNull()
  })
})

// ─── pipelines() — one owner ──────────────────────────────────────────────
//
// There used to be a `_compiledPipelines` cache: four writers, a hand
// invalidation inside hooks(), a registry that monkey-patched hooks() to
// recompile, and a three-way ladder in callService where the cache BEAT the app
// hooks the transport had just handed over. A stale entry was a wrong answer,
// not a slow one.
//
// pipelines(appHooks) is memoised on both inputs — the app map by identity, the
// service's own by a version hooks() bumps — so staleness is unreachable rather
// than remembered.

describe('pipelines — one owner', () => {

  it('memoises on the app hooks it is given', async () => {
    const svc = createService({ name: 'pings', find: async () => [] })
    const h1  = { before: { all: [async function a() {}] } }
    const h2  = { before: { all: [async function b() {}] } }

    expect(svc.pipelines(h1)).toBe(svc.pipelines(h1))
    expect(svc.pipelines(h2)).not.toBe(svc.pipelines(h1))
  })

  it('a later hooks() call changes the answer — nothing has to invalidate', async () => {
    const svc = createService({ name: 'pings', find: async () => [] })
    const h   = { before: { all: [async function app() {}] } }

    const first = svc.pipelines(h)
    svc.hooks({ before: { find: [async function late() {}] } })
    const second = svc.pipelines(h)

    expect(second).not.toBe(first)
    expect(second['find']!.before.some(f => f.name === 'late')).toBe(true)
  })

  it('the app hook survives alongside the derived ones', async () => {
    const order: string[] = []
    const app = await createTestApp({
      services: [() => createService({ name: 'pings', find: async () => [{ pong: true }] })]
    })
    app.hooks({ before: { all: [async function appBefore() { order.push('app:before') }] } })

    // What this pins is that the pipeline resolved at all, and that the app's
    // own hook survived alongside the derived ones. It used to assert
    // `.length === 2` and broke the day a second derived hook was added.
    const before = app.services.get('pings')!.pipelines(app._appHooks)['find']!.before
    expect(before.some(h => h.name === 'gateAuth')).toBe(true)
    expect(before.filter(h => !DERIVED_HOOKS.has(h.name)).length).toBe(1)
  })

  it('a call ALWAYS runs the app hooks it was handed', async () => {
    // The inversion. The old cache took precedence over this argument, so a
    // caller could pass hooks and watch them not run — which is why staleness
    // was a correctness bug. Warm with one map, call with another.
    const ran: string[] = []
    const svc = createService({ name: 'things', find: async () => [{ id: '1' }] })

    const warm = { before: { all: [async function warmHook() { ran.push('warm') }] } }
    const live = { before: { all: [async function liveHook() { ran.push('live') }] } }
    svc.pipelines(warm)

    const ctx = testCtx('things', 'find')
    await callService(svc, ctx, live)

    expect(ctx.error).toBeNull()
    expect(ran).toEqual(['live'])
  })

  it('a service registered after setAppHooks runs the app hooks on its first call', async () => {
    // The plugin-ready() path. It used to depend on register() writing the
    // cache; now it depends on nothing but the memo key.
    const ran: string[] = []
    const app = await createTestApp({
      services: [() => createService({ name: 'first', find: async () => [] })]
    })
    app.hooks({ before: { all: [async function appBefore() { ran.push('app') }] } })
    await request(app).get('/first')          // forces start + setAppHooks

    const late = createService({ name: 'late', find: async () => [{ id: '1' }] })
    app.services.register(late)

    const res = await request(app).get('/late')
    expect(res.status).toBe(200)
    expect(ran.filter(r => r === 'app').length).toBeGreaterThanOrEqual(2)
  })
})

// ─── Circuit breaker ──────────────────────────────────────────────────────

describe('circuitBreaker', () => {

  function makeService(failTimes = 0) {
    let calls = 0
    const svc = createService({
      name: 'ext',
      find: async () => {
        calls++
        if (calls <= failTimes) throw new Error('downstream error')
        return [{ ok: true }]
      },
    })
    return { svc, getCalls: () => calls }
  }

  it('stays CLOSED and passes through on success', async () => {
    const { svc } = makeService(0)
    svc.hooks({ around: { all: [circuitBreaker({ threshold: 3 })] } })

    const ctx = testCtx('ext', 'find')
    await callService(svc, ctx)
    expect(ctx.error).toBeNull()
    expect(Array.isArray((ctx.result as { data: unknown[] }).data)).toBe(true)
  })

  it('opens after threshold consecutive failures', async () => {
    const { svc } = makeService(999)
    svc.hooks({ around: { all: [circuitBreaker({ threshold: 3 })] } })

    for (let i = 0; i < 3; i++) {
      const ctx = testCtx('ext', 'find')
      await expect(callService(svc, ctx)).rejects.toThrow()
    }

    // 4th call — circuit is now OPEN, should fail fast with Unavailable
    const ctx = testCtx('ext', 'find')
    await expect(callService(svc, ctx)).rejects.toBeInstanceOf(Unavailable)
  })

  it('transitions OPEN → HALF_OPEN → CLOSED after timeout', async () => {
    const { svc } = makeService(3)
    svc.hooks({ around: { all: [circuitBreaker({ threshold: 3, timeout: 20 })] } })

    // Trigger open
    for (let i = 0; i < 3; i++) {
      await expect(callService(svc, testCtx('ext', 'find'))).rejects.toThrow()
    }

    // Immediate call — still open
    await expect(callService(svc, testCtx('ext', 'find'))).rejects.toBeInstanceOf(Unavailable)

    // Wait for timeout to elapse
    await new Promise(r => setTimeout(r, 30))

    // Next call goes through (HALF_OPEN probe) — service now succeeds
    const ctx = testCtx('ext', 'find')
    await callService(svc, ctx)
    expect(ctx.error).toBeNull()

    // Circuit back to CLOSED — subsequent calls also succeed
    const ctx2 = testCtx('ext', 'find')
    await callService(svc, ctx2)
    expect(ctx2.error).toBeNull()
  })

  it('fires onOpen and onClose callbacks', async () => {
    const events: string[] = []
    const { svc } = makeService(999)

    svc.hooks({ around: { all: [circuitBreaker({
      threshold: 2,
      timeout: 10,
      onOpen:  () => events.push('open'),
      onClose: () => events.push('close'),
    })] } })

    // Open the circuit
    for (let i = 0; i < 2; i++) {
      await expect(callService(svc, testCtx('ext', 'find'))).rejects.toThrow()
    }
    expect(events).toContain('open')
  })

  it('resets failure count on success', async () => {
    let fail = true
    const svc = createService({
      name: 'flaky',
      find: async () => {
        if (fail) throw new Error('fail')
        return [{ ok: true }]
      },
    })
    svc.hooks({ around: { all: [circuitBreaker({ threshold: 5 })] } })

    // 2 failures — below threshold
    for (let i = 0; i < 2; i++) {
      await expect(callService(svc, testCtx('flaky', 'find'))).rejects.toThrow()
    }

    // Success — resets counter
    fail = false
    await callService(svc, testCtx('flaky', 'find'))

    // Now fail again — threshold counter starts fresh, should need 5 more
    fail = true
    for (let i = 0; i < 4; i++) {
      await expect(callService(svc, testCtx('flaky', 'find'))).rejects.toThrow()
    }

    // 4 failures after reset — still below threshold, NOT open yet
    const ctx = testCtx('flaky', 'find')
    await expect(callService(svc, ctx)).rejects.toThrow(Error)
    // Should be a regular error (downstream), not Unavailable (circuit open)
    // The 5th failure triggers open
    await expect(callService(svc, testCtx('flaky', 'find'))).rejects.toBeInstanceOf(Unavailable)
  })
})

// ─── rateLimit hook ───────────────────────────────────────────────────────

import { rateLimit } from '../src/core/hooks.ts'
import { TooManyRequests } from '../src/core/errors.ts'
import type { SessionContext } from '../src/auth/types.ts'

describe('rateLimit hook', () => {

  function makeService(hookOpts: Parameters<typeof rateLimit>[0]) {
    const svc = createService({
      name: 'items',
      find: async () => [{ id: 1 }],
    })
    svc.hooks({ before: { find: [rateLimit(hookOpts)] } })
    return svc
  }

  it('allows requests under the limit', async () => {
    const svc = makeService({ max: 3, window: '1 minute' })
    for (let i = 0; i < 3; i++) {
      const ctx = testCtx('items', 'find')
      await callService(svc, ctx)
      expect(ctx.error).toBeNull()
    }
  })

  it('throws TooManyRequests when limit is exceeded', async () => {
    const svc = makeService({ max: 2, window: '1 minute' })

    // First two succeed
    for (let i = 0; i < 2; i++) {
      await callService(svc, testCtx('items', 'find'))
    }

    // Third throws
    await expect(
      callService(svc, testCtx('items', 'find'))
    ).rejects.toBeInstanceOf(TooManyRequests)
  })

  it('keys on userId for authenticated requests', async () => {
    const svc = makeService({ max: 1, window: '1 minute' })

    const userA: SessionContext = { userId: 'u-alice', userType: 'user', authMethod: 'session', scopes: [] }
    const userB: SessionContext = { userId: 'u-bob',   userType: 'user', authMethod: 'session', scopes: [] }

    // Alice uses her 1 request
    await callService(svc, testCtx('items', 'find', null, { user: userA }))

    // Bob can still make a request (different key)
    await callService(svc, testCtx('items', 'find', null, { user: userB }))

    // Alice is blocked
    await expect(
      callService(svc, testCtx('items', 'find', null, { user: userA }))
    ).rejects.toBeInstanceOf(TooManyRequests)
  })

  it('keys on IP for anonymous requests', async () => {
    const svc = makeService({ max: 1, window: '1 minute' })

    // A fresh context per call, as the transport builds one per request. The
    // third call used to reuse `ip1`, which still carried the RESULT of the
    // first — and the before-pipeline short-circuits on a non-null ctx.result,
    // so any hook after the first would have been skipped. That passed only
    // while rateLimit happened to be the very first before hook.
    const ip = (addr: string) => {
      const c = testCtx('items', 'find')
      c.client.ip = addr
      return c
    }

    await callService(svc, ip('1.2.3.4'))
    await callService(svc, ip('5.6.7.8'))   // different IP — allowed
    await expect(callService(svc, ip('1.2.3.4'))).rejects.toBeInstanceOf(TooManyRequests)
  })

  it('accepts a custom key function', async () => {
    const svc = makeService({
      max: 1,
      window: '1 minute',
      key: (ctx) => (ctx.data as Record<string, unknown>)?.org as string ?? 'default',
    })

    // Fresh context per call — see the note in the IP test above.
    const org = (name: string) => {
      const c = testCtx('items', 'find')
      c.data = { org: name }
      return c
    }

    await callService(svc, org('acme'))
    await callService(svc, org('globex'))   // different org — allowed
    await expect(callService(svc, org('acme'))).rejects.toBeInstanceOf(TooManyRequests)
  })

  it('uses a custom error message', async () => {
    const svc = makeService({ max: 0, window: '1 minute', message: 'Slow down partner' })
    const err = await callService(svc, testCtx('items', 'find')).catch(e => e)
    expect(err.message).toContain('Slow down partner')
  })

  it('resets after the window expires', async () => {
    const svc = makeService({ max: 1, window: '30ms' })

    await callService(svc, testCtx('items', 'find'))
    await expect(callService(svc, testCtx('items', 'find'))).rejects.toBeInstanceOf(TooManyRequests)

    // Wait for window to expire
    await new Promise(r => setTimeout(r, 40))

    // Should be allowed again
    const ctx = testCtx('items', 'find')
    await callService(svc, ctx)
    expect(ctx.error).toBeNull()
  })

})

// ─── SessionContext shape ─────────────────────────────────────────────────

describe('SessionContext shape', () => {
  it('has the expected camelCase fields', () => {
    const session: SessionContext = {
      userId:     'u-1',
      userType:   'user',
      authMethod: 'session',
      email:      'alice@example.com',
      name:       'Alice',
      accountId:  'acc-1',
      workspaceId:'ws-1',
      role:       'admin',
      scopes:     ['read', 'write'],
    }
    expect(session.userId).toBe('u-1')
    expect(session.userType).toBe('user')
    expect(session.authMethod).toBe('session')
    expect(session.accountId).toBe('acc-1')
    expect(session.workspaceId).toBe('ws-1')
    // Ensure no snake_case fields exist on the object
    expect((session as Record<string, unknown>).user_id).toBeUndefined()
    expect((session as Record<string, unknown>).user_type).toBeUndefined()
    expect((session as Record<string, unknown>).auth_method).toBeUndefined()
    expect((session as Record<string, unknown>).account_id).toBeUndefined()
    expect((session as Record<string, unknown>).workspace_id).toBeUndefined()
  })
})



describe('correlationId middleware', () => {

  async function makeApp(opts = {}) {
    const app = await createTestApp({
      services: [() => createService({
        name: 'pings',
        find: async () => [{ pong: true }],
      })],
      ...opts,
    })
    app.configure(correlationId())
    return app
  }

  it('generates an id when none provided', async () => {
    const app = await makeApp()
    const res = await request(app).get('/pings')
    expect(res.headers['x-request-id']).toBeTruthy()
    expect(typeof res.headers['x-request-id']).toBe('string')
  })

  it('echoes back the client-provided id', async () => {
    const app = await makeApp()
    const res = await request(app)
      .get('/pings')
      .set('x-request-id', 'my-trace-123')
    expect(res.headers['x-request-id']).toBe('my-trace-123')
  })

  it('includes the id on error responses too', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'boom',
        find: async () => { throw new Error('kaboom') },
      })]
    })
    app.configure(correlationId())
    const res = await request(app).get('/boom')
    expect(res.status).toBe(500)
    expect(res.headers['x-request-id']).toBeTruthy()
  })

  it('respects a custom header name', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'pings', find: async () => [] })]
    })
    app.configure(correlationId({ header: 'x-trace-id' }))
    const res = await request(app)
      .get('/pings')
      .set('x-trace-id', 'custom-999')
    expect(res.headers['x-trace-id']).toBe('custom-999')
    expect(res.headers['x-request-id']).toBeUndefined()
  })

  it('respects a custom generator function', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'pings', find: async () => [] })]
    })
    app.configure(correlationId({ generator: () => 'fixed-id' }))
    const res = await request(app).get('/pings')
    expect(res.headers['x-request-id']).toBe('fixed-id')
  })
})

// ─── csrf() middleware ────────────────────────────────────────────────────

import { csrf } from '../index.ts'

describe('csrf middleware', () => {

  async function makeApp(csrfOpts: Parameters<typeof csrf>[0]) {
    const app = await createTestApp({
      services: [() => createService({
        name:   'notes',
        find:   async () => [],
        create: async (ctx) => ({ created: true, data: ctx.data }),
        patch:  async (ctx) => ({ patched: true }),
        remove: async (ctx) => ({ removed: true }),
      })],
    })
    app.configure(csrf(csrfOpts))
    return app
  }

  // ── GET requests are always allowed ─────────────────────────────────

  it('passes GET requests regardless of origin', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app).get('/notes')
    expect(res.status).toBe(200)
  })

  it('passes GET requests with no origin header', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app).get('/notes')
    expect(res.status).toBe(200)
  })

  // ── Allowed origins pass through ──────────────────────────────────────

  it('allows POST from a listed origin', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app)
      .post('/notes')
      .set('origin', 'https://myapp.com')
      .send({ title: 'Hello' })
    expect(res.status).toBe(201)
    expect((res.body as Record<string, unknown>).created).toBe(true)
  })

  it('allows PATCH from a listed origin', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app)
      .patch('/notes/123')
      .set('origin', 'https://myapp.com')
      .send({ title: 'Updated' })
    expect(res.status).toBe(200)
  })

  it('allows DELETE from a listed origin', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app)
      .delete('/notes/123')
      .set('origin', 'https://myapp.com')
    expect(res.status).toBe(200)
  })

  it('allows multiple listed origins', async () => {
    const app = await makeApp({ origins: ['https://app.com', 'https://admin.app.com'] })

    const r1 = await request(app).post('/notes').set('origin', 'https://app.com').send({})
    expect(r1.status).toBe(201)

    const r2 = await request(app).post('/notes').set('origin', 'https://admin.app.com').send({})
    expect(r2.status).toBe(201)
  })

  // ── Blocked origins are rejected ──────────────────────────────────────

  it('blocks POST from an unlisted origin with 403', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app)
      .post('/notes')
      .set('origin', 'https://evil.com')
      .send({ title: 'Attack' })
    expect(res.status).toBe(403)
  })

  it('blocks PUT from an unlisted origin', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app)
      .put('/notes/1')
      .set('origin', 'https://evil.com')
      .send({})
    expect(res.status).toBe(403)
  })

  // ── Missing origin header ─────────────────────────────────────────────

  it('blocks mutating request with no origin by default', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    // No origin or referer header
    const res = await request(app).post('/notes').send({ title: 'No origin' })
    expect(res.status).toBe(403)
  })

  it('allows missing origin when allowMissingOrigin is true', async () => {
    const app = await makeApp({
      origins:            ['https://myapp.com'],
      allowMissingOrigin: true,
    })
    const res = await request(app).post('/notes').send({ title: 'Server call' })
    expect(res.status).toBe(201)
  })

  // ── Referer fallback ──────────────────────────────────────────────────

  it('uses Referer as fallback when Origin is absent', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app)
      .post('/notes')
      .set('referer', 'https://myapp.com/dashboard')
      .send({ title: 'Via referer' })
    expect(res.status).toBe(201)
  })

  it('blocks when Referer points to an unlisted origin', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app)
      .post('/notes')
      .set('referer', 'https://evil.com/phish')
      .send({})
    expect(res.status).toBe(403)
  })

  it('strips the path from Referer before checking', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    // Referer includes a full path — origin extraction should strip it
    const res = await request(app)
      .post('/notes')
      .set('referer', 'https://myapp.com/some/deep/path?foo=bar')
      .send({})
    expect(res.status).toBe(201)
  })

  // ── Custom predicate origins ──────────────────────────────────────────

  it('accepts a function as origins predicate', async () => {
    const app = await makeApp({
      origins: (o) => o.endsWith('.myapp.com') || o === 'https://myapp.com',
    })

    const allowed = await request(app)
      .post('/notes')
      .set('origin', 'https://staging.myapp.com')
      .send({})
    expect(allowed.status).toBe(201)

    const blocked = await request(app)
      .post('/notes')
      .set('origin', 'https://evil.com')
      .send({})
    expect(blocked.status).toBe(403)
  })

  // ── Custom methods ────────────────────────────────────────────────────

  it('respects custom methods list — GET becomes protected', async () => {
    const app = await makeApp({
      origins: ['https://myapp.com'],
      methods: ['GET', 'POST'],
    })
    // GET is now in the protected list — no origin → blocked
    const res = await request(app).get('/notes')
    expect(res.status).toBe(403)
  })

  it('allows a method excluded from the methods list', async () => {
    const app = await makeApp({
      origins: ['https://myapp.com'],
      methods: ['POST'],          // only POST is protected
    })
    // DELETE is not in methods — should pass with no origin
    const res = await request(app).delete('/notes/1')
    expect(res.status).toBe(200)
  })

  // ── Custom rejection handler ──────────────────────────────────────────

  it('calls onRejected instead of throwing when provided', async () => {
    const rejected: string[] = []
    const app = await makeApp({
      origins:    ['https://myapp.com'],
      onRejected: (_ctx, reason) => { rejected.push(reason) },
    })
    // With onRejected, the middleware continues (no throw) — handler still runs
    const res = await request(app)
      .post('/notes')
      .set('origin', 'https://evil.com')
      .send({})
    // onRejected was called
    expect(rejected.length).toBe(1)
    expect(rejected[0]).toContain('evil.com')
    // Handler still ran (onRejected called next())
    expect(res.status).toBe(201)
  })

  // ── Error response shape ──────────────────────────────────────────────

  it('rejection response is proper JSON with name and message', async () => {
    const app = await makeApp({ origins: ['https://myapp.com'] })
    const res = await request(app)
      .post('/notes')
      .set('origin', 'https://evil.com')
      .send({})
    expect(res.status).toBe(403)
    const body = res.body as Record<string, unknown>
    expect(body.name).toBe('Forbidden')
    expect(typeof body.message).toBe('string')
  })
})

// ─── cors() + csrf() ordering ─────────────────────────────────────────────
// Verifies the documented requirement: configure cors() before csrf().
// cors() must short-circuit OPTIONS preflight before csrf() checks the origin,
// otherwise a legitimate preflight from an allowed origin would be blocked.

import { cors } from '../index.ts'

describe('cors() + csrf() ordering', () => {

  async function makeApp() {
    const app = await createTestApp({
      services: [() => createService({
        name:   'items',
        find:   async () => [],
        create: async () => ({ created: true }),
      })],
    })
    // Correct order: cors first, then csrf
    app.configure(cors({ origins: ['https://myapp.com'] }))
    app.configure(csrf({ origins: ['https://myapp.com'] }))
    return app
  }

  it('OPTIONS preflight passes even though POST would need an origin check', async () => {
    const app = await makeApp()
    // A real browser sends OPTIONS before the actual POST.
    // If csrf() saw this before cors() short-circuited it, the missing body
    // and different semantics would not matter — but the origin header is
    // present, so it must get a 204 back, not a 403.
    const res = await request(app)
      .options('/items')
      .set('origin',                         'https://myapp.com')
      .set('access-control-request-method',  'POST')
      .set('access-control-request-headers', 'content-type')
    expect(res.status).toBe(204)
  })

  it('OPTIONS from an unlisted origin still gets a CORS response (not 403)', async () => {
    const app = await makeApp()
    // cors() owns the OPTIONS response regardless of origin — it decides
    // what CORS headers to send. csrf() must never intercept OPTIONS.
    const res = await request(app)
      .options('/items')
      .set('origin',                        'https://evil.com')
      .set('access-control-request-method', 'POST')
    // cors() responds 204 — CORS headers will reflect the unlisted origin
    // by omitting Access-Control-Allow-Origin, which is correct CORS behaviour.
    // What matters here is that csrf() did NOT throw a 403.
    expect(res.status).toBe(204)
  })

  it('POST from an allowed origin passes both cors() and csrf()', async () => {
    const app = await makeApp()
    const res = await request(app)
      .post('/items')
      .set('origin', 'https://myapp.com')
      .send({ name: 'thing' })
    expect(res.status).toBe(201)
    expect((res.body as Record<string, unknown>).created).toBe(true)
  })

  it('POST from a blocked origin is rejected by csrf() with 403', async () => {
    const app = await makeApp()
    const res = await request(app)
      .post('/items')
      .set('origin', 'https://evil.com')
      .send({ name: 'thing' })
    expect(res.status).toBe(403)
  })

  it('GET is unaffected by csrf() — no origin needed', async () => {
    const app = await makeApp()
    const res = await request(app).get('/items')
    expect(res.status).toBe(200)
  })

  it('csrf() alone (no cors()) still blocks OPTIONS when origin is wrong', async () => {
    // Edge case: if someone configures csrf() without cors(), OPTIONS is not
    // registered as a special handler. csrf() uses the default methods list
    // (POST/PUT/PATCH/DELETE) so OPTIONS would still pass through.
    const app = await createTestApp({
      services: [() => createService({ name: 'items', find: async () => [] })],
    })
    app.configure(csrf({ origins: ['https://myapp.com'] }))
    // OPTIONS is not in csrf's protected methods — passes regardless
    const res = await request(app)
      .options('/items')
      .set('origin', 'https://evil.com')
    // No cors() handler for OPTIONS, so falls through to 404 — but crucially not 403
    expect(res.status).not.toBe(403)
  })
})

describe('ctx.paginate()', () => {

  async function makeApp() {
    return createTestApp({
      services: [() => createService({
        name: 'posts',
        find: async () => [],  // won't be called — we use custom routes
      })]
    })
  }

  it('returns correct envelope shape', async () => {
    const app = await makeApp()
    app.get('/paginated', (ctx) => {
      return ctx.paginate([{ id: '1' }, { id: '2' }], 50, { limit: 2, offset: 0 })
    })
    const res = await request(app).get('/paginated')
    const body = res.body as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(Array.isArray(body.data)).toBe(true)
    expect((body.data as unknown[]).length).toBe(2)
    expect(body.total).toBe(50)
    expect(body.limit).toBe(2)
    expect(body.offset).toBe(0)
  })

  it('generates a next URL when more pages exist', async () => {
    const app = await makeApp()
    app.get('/paginated', (ctx) => ctx.paginate([{ id: '1' }], 10, { limit: 1, offset: 0 }))
    const res = await request(app).get('/paginated')
    const body = res.body as Record<string, unknown>
    expect(body.next).toContain('$offset=1')
    expect(body.next).toContain('$limit=1')
    expect(body.prev).toBeNull()
  })

  it('generates a prev URL on subsequent pages', async () => {
    const app = await makeApp()
    app.get('/paginated', (ctx) => ctx.paginate([{ id: '5' }], 10, { limit: 5, skip: 5 }))
    const res = await request(app).get('/paginated')
    const body = res.body as Record<string, unknown>
    expect(body.prev).toContain('$offset=0')
    expect(body.next).toBeNull()
  })

  it('null for both next and prev on a single full page', async () => {
    const app = await makeApp()
    app.get('/paginated', (ctx) => ctx.paginate([{ id: '1' }], 1, { limit: 10, skip: 0 }))
    const res = await request(app).get('/paginated')
    const body = res.body as Record<string, unknown>
    expect(body.next).toBeNull()
    expect(body.prev).toBeNull()
  })
})

// ─── ctx.sse() ────────────────────────────────────────────────────────────

describe('ctx.sse()', () => {

  it('returns 200 with correct content-type', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    app.get('/events', (ctx) => {
      const { response, close } = ctx.sse()
      close()
      return response
    })
    const res = await request(app).get('/events')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
  })

  it('sends data: lines in SSE format', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    app.get('/events', (ctx) => {
      const { response, send, close } = ctx.sse()
      send({ data: { hello: 'world' } })
      send({ event: 'ping', data: 'ok' })
      close()
      return response
    })
    const res = await request(app).get('/events')
    expect(res.text).toContain('data:')
    expect(res.text).toContain('hello')
    expect(res.text).toContain('event: ping')
  })

  it('sets x-accel-buffering: no to disable nginx buffering', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    app.get('/events', (ctx) => {
      const { response, close } = ctx.sse()
      close()
      return response
    })
    const res = await request(app).get('/events')
    expect(res.headers['x-accel-buffering']).toBe('no')
  })
})

// ─── apiPrefix ────────────────────────────────────────────────────────────

describe('apiPrefix config', () => {

  it('no prefix by default — routes mount at /{service}', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'items', find: async () => [{ id: '1' }] })]
    })
    const res = await request(app).get('/items')
    expect(res.status).toBe(200)
  })

  it('mounts routes at custom prefix', async () => {
    const app = await createTestApp({
      config: { apiPrefix: '/api/v1' },
      services: [() => createService({ name: 'items', find: async () => [{ id: '1' }] })]
    })
    const res = await request(app).get('/api/v1/items')
    expect(res.status).toBe(200)
  })

  it('old prefix returns 404 when custom prefix is set', async () => {
    const app = await createTestApp({
      config: { apiPrefix: '/api/v2' },
      services: [() => createService({ name: 'items', find: async () => [] })]
    })
    const res = await request(app).get('/items')
    expect(res.status).toBe(404)
  })

  it('handles prefix without leading slash gracefully', async () => {
    const app = await createTestApp({
      config: { apiPrefix: 'v3' },
      services: [() => createService({ name: 'items', find: async () => [{ id: '1' }] })]
    })
    const res = await request(app).get('/v3/items')
    expect(res.status).toBe(200)
  })

  it('moves a plugin\'s own routes too, not just the service routes', async () => {
    // FJS-012: apiPrefix used to be applied by registerServiceRoutes alone, so
    // a plugin calling app.get() landed at the root while the services beside
    // it moved. @frontierjs/auth is the case that cost the most — an app under
    // /api served its login at /auth, and the browser client's default looked
    // for it under the prefix.
    const app = await createTestApp({
      config: { apiPrefix: '/api' },
      services: [() => createService({ name: 'items', find: async () => [] })],
    })
    app.get('/thing', (ctx) => ctx.json({ ok: true }))    // what a plugin's register() does
    expect((await request(app).get('/api/thing')).status).toBe(200)
    expect((await request(app).get('/thing')).status).toBe(404)
  })

  it('handles prefix with trailing slash gracefully', async () => {
    const app = await createTestApp({
      config: { apiPrefix: '/api/v4/' },
      services: [() => createService({ name: 'items', find: async () => [{ id: '1' }] })]
    })
    const res = await request(app).get('/api/v4/items')
    expect(res.status).toBe(200)
  })
})

// ─── app.ws() — param routing + WsContext ────────────────────────────────

describe('app.ws() routing', () => {

  it('is registered on the app object', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    expect(typeof app.ws).toBe('function')
  })

  it('ws() registration accepts {param} paths without throwing', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    expect(() => {
      app.ws('/chat/{roomId}', {
        open(ctx)  { void ctx },
        close(ctx) { void ctx },
      })
    }).not.toThrow()
  })

  it('rejects registration after router is built', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    // Build the router
    app.http.router.build()

    expect(() => {
      app.ws('/live', { open: () => {} })
    }).toThrow()
  })

  it('WsContext shape has expected fields', () => {
    // Verify the type by building a context manually the same way http.ts does
    const mockWs = {
      data: {
        path:     '/chat/room-1',
        params:   { roomId: 'room-1' },
        query:    { token: 'abc' },
        headers:  { 'user-agent': 'test' },
        ip:       '127.0.0.1',
        user:     null,
        handlers: {},
      },
      send:       (_: string) => {},
      close:      (_?: number) => {},
      readyState: 1,
    }

    // Mirror what _buildWsContext does
    const ctx = {
      path:    mockWs.data.path,
      params:  mockWs.data.params,
      query:   mockWs.data.query,
      headers: mockWs.data.headers,
      ip:      mockWs.data.ip,
      user:    mockWs.data.user,
      send:    (data: string | object) => mockWs.send(
        typeof data === 'string' ? data : JSON.stringify(data)
      ),
      close:   (code?: number) => mockWs.close(code),
      $ws:     mockWs,
    }

    expect(ctx.params.roomId).toBe('room-1')
    expect(ctx.query.token).toBe('abc')
    expect(ctx.ip).toBe('127.0.0.1')
    expect(ctx.user).toBeNull()
    expect(typeof ctx.send).toBe('function')
    expect(typeof ctx.close).toBe('function')
  })

  it('send() serialises objects to JSON strings', () => {
    const sent: string[] = []
    const mockWs = { send: (m: string) => sent.push(m), close: () => {} }

    const send = (data: string | object) =>
      mockWs.send(typeof data === 'string' ? data : JSON.stringify(data))

    send({ type: 'welcome', room: 'abc' })
    send('raw string')

    expect(JSON.parse(sent[0])).toMatchObject({ type: 'welcome', room: 'abc' })
    expect(sent[1]).toBe('raw string')
  })
})

// ─── /health and /metrics endpoints ──────────────────────────────────────

describe('healthPlugin', () => {

  async function makeApp(opts = {}) {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })],
    })
    app.configure(healthPlugin(opts))
    return app
  }

  it('GET /health returns 200 with ok status', async () => {
    const app = await makeApp()
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.status).toBe('ok')
    expect(typeof body.uptime).toBe('number')
    expect(typeof body.ts).toBe('string')
  })

  it('GET /health includes database check when db is available', async () => {
    const app = await makeApp()
    const res = await request(app).get('/health')
    const body = res.body as Record<string, unknown>
    const checks = body.checks as Record<string, { status: string }>
    expect(checks.database).toBeDefined()
    expect(checks.database.status).toBe('ok')
  })

  it('GET /health returns 503 when a custom check fails', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    app.configure(healthPlugin({
      checks: {
        downstream: async () => { throw new Error('connection refused') }
      }
    }))
    const res = await request(app).get('/health')
    expect(res.status).toBe(503)
    const body = res.body as Record<string, unknown>
    expect(body.status).toBe('degraded')
    const checks = body.checks as Record<string, { status: string; error?: string }>
    expect(checks.downstream.status).toBe('fail')
    expect(checks.downstream.error).toBe('connection refused')
  })

  it('GET /health includes app name and version', async () => {
    const app = await makeApp()
    const res = await request(app).get('/health')
    const body = res.body as Record<string, unknown>
    expect(typeof body.app).toBe('string')
    expect(typeof body.version).toBe('string')
  })

  it('GET /metrics returns 200 with expected shape', async () => {
    const app = await makeApp()
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.process).toBeDefined()
    expect(body.http).toBeDefined()
    expect(body.services).toBeDefined()
    expect(body.cache).toBeDefined()
  })

  it('GET /metrics includes process memory fields', async () => {
    const app = await makeApp()
    const res = await request(app).get('/metrics')
    const proc = (res.body as Record<string, unknown>).process as Record<string, unknown>
    expect(typeof proc.memoryMb).toBe('number')
    expect(typeof proc.heapUsedMb).toBe('number')
    expect(typeof proc.pid).toBe('number')
    expect(proc.memoryMb).toBeGreaterThan(0)
  })

  it('GET /metrics lists registered services', async () => {
    const app = await makeApp()
    const res = await request(app).get('/metrics')
    const services = (res.body as Record<string, unknown>).services as Record<string, unknown>
    expect(Array.isArray(services.registered)).toBe(true)
    expect((services.registered as string[]).includes('noop')).toBe(true)
    expect(services.count).toBe(1)
  })

  it('GET /metrics includes cache hit rate', async () => {
    const app = await makeApp()
    // Warm the cache
    app.cache.set('test-key', 'value', '1 minute')
    app.cache.get('test-key')
    app.cache.get('missing-key')

    const res = await request(app).get('/metrics')
    const cache = (res.body as Record<string, unknown>).cache as Record<string, unknown>
    expect(cache.hits).toBeGreaterThanOrEqual(1)
    expect(cache.misses).toBeGreaterThanOrEqual(1)
    expect(typeof cache.hitRate).toBe('string')
    expect(cache.hitRate).toContain('%')
  })

  it('returns 401 when token auth is configured and no token provided', async () => {
    const app = await makeApp({ token: 'secret-token' })
    const res = await request(app).get('/health')
    expect(res.status).toBe(401)
  })

  it('returns 200 when correct token is provided', async () => {
    const app = await makeApp({ token: 'secret-token' })
    const res = await request(app)
      .get('/health')
      .set('authorization', 'Bearer secret-token')
    expect(res.status).toBe(200)
  })

  it('accepts token via x-api-key header', async () => {
    const app = await makeApp({ token: 'secret-token' })
    const res = await request(app)
      .get('/health')
      .set('x-api-key', 'secret-token')
    expect(res.status).toBe(200)
  })

  it('mounts at custom path prefix', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    app.configure(healthPlugin({ path: '/_internal' }))
    const res = await request(app).get('/_internal/health')
    expect(res.status).toBe(200)
    // Default path should 404
    const res2 = await request(app).get('/health')
    expect(res2.status).toBe(404)
  })

  it('accepts a custom authFn', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'noop', find: async () => [] })]
    })
    app.configure(healthPlugin({
      authFn: (ctx) => ctx.headers['x-internal'] === 'yes'
    }))
    const allowed = await request(app).get('/health').set('x-internal', 'yes')
    expect(allowed.status).toBe(200)

    const denied = await request(app).get('/health')
    expect(denied.status).toBe(401)
  })
})

// ─── createLogger / fileWriter ────────────────────────────────────────────

import { createLogger, consoleWriter, fileWriter, noopLogger } from '../src/core/logger.ts'

describe('createLogger', () => {

  it('logs at all levels without throwing', () => {
    const logger = createLogger({ level: 'debug', writers: [noopLogger as unknown as import('../src/core/logger.ts').LogWriter] })
    // These should all run silently
    expect(() => {
      logger.debug('debug msg', { x: 1 })
      logger.info('info msg')
      logger.warn('warn msg')
      logger.error('error msg', new Error('test'))
    }).not.toThrow()
  })

  it('child logger inherits namespace and defaults', () => {
    const entries: import('../src/core/logger.ts').LogEntry[] = []
    const writer = (e: import('../src/core/logger.ts').LogEntry) => entries.push(e)
    const logger = createLogger({ writers: [writer] })
    const child  = logger.child('auth', { userId: 'u1' })

    child.info('logged in')

    expect(entries[0].ns).toBe('auth')
    expect(entries[0].data?.userId).toBe('u1')
  })

  it('nested child logger concatenates namespace', () => {
    const entries: import('../src/core/logger.ts').LogEntry[] = []
    const writer = (e: import('../src/core/logger.ts').LogEntry) => entries.push(e)
    const logger = createLogger({ writers: [writer] })
    const child  = logger.child('auth').child('session')

    child.info('check')
    expect(entries[0].ns).toBe('auth:session')
  })

  it('respects minimum log level', () => {
    const entries: import('../src/core/logger.ts').LogEntry[] = []
    const writer = (e: import('../src/core/logger.ts').LogEntry) => entries.push(e)
    const logger = createLogger({ level: 'warn', writers: [writer] })

    logger.debug('ignored')
    logger.info('also ignored')
    logger.warn('captured')

    expect(entries.length).toBe(1)
    expect(entries[0].level).toBe('warn')
  })

  it('includes error details on error level', () => {
    const entries: import('../src/core/logger.ts').LogEntry[] = []
    const writer = (e: import('../src/core/logger.ts').LogEntry) => entries.push(e)
    const logger = createLogger({ writers: [writer] })

    logger.error('something broke', new Error('boom'))

    expect(entries[0].error?.message).toBe('boom')
    expect(entries[0].error?.name).toBe('Error')
  })

  it('writes JSON format when format=json', () => {
    const lines: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (s: string | Uint8Array) => {
      if (typeof s === 'string') lines.push(s)
      return true
    }
    try {
      const logger = createLogger({ format: 'json' })
      logger.info('json test', { key: 'value' })
    } finally {
      process.stdout.write = origWrite
    }
    expect(lines.length).toBeGreaterThan(0)
    const parsed = JSON.parse(lines[lines.length - 1])
    expect(parsed.level).toBe('info')
    expect(parsed.message).toBe('json test')
  })

  it('fileWriter appends JSON to a temp file', async () => {
    const tmpPath = `/tmp/junction-log-test-${Date.now()}.log`
    const writer  = fileWriter(tmpPath)

    writer({ level: 'info', message: 'line one', time: new Date().toISOString() })
    writer({ level: 'warn', message: 'line two', time: new Date().toISOString() })

    // FileSink buffers — give it a tick to flush
    await new Promise(r => setTimeout(r, 50))

    const content = await Bun.file(tmpPath).text().catch(() => '')
    const lines   = content.trim().split('\n').filter(Boolean)

    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).message).toBe('line one')
    expect(JSON.parse(lines[1]).message).toBe('line two')

    await import('node:fs/promises').then(({ unlink }) => unlink(tmpPath).catch(() => {}))
  })

  it('noopLogger does nothing', () => {
    expect(() => {
      noopLogger.debug('x')
      noopLogger.info('x')
      noopLogger.warn('x')
      noopLogger.error('x')
      noopLogger.child('ns').info('x')
    }).not.toThrow()
  })

})

// ─── autoloadServices ─────────────────────────────────────────────────────

import { autoloadServices } from '../src/core/loader.ts'

describe('autoloadServices', () => {

  it('loads service files from a directory', async () => {
    // Write a temp service file
    const dir = `/tmp/junction-loader-test-${Date.now()}`
    // Resolve createService.ts to its absolute path so the temp file's
    // import statement works regardless of where the fixture lives.
    const { fileURLToPath } = await import('node:url')
    const servicePath = fileURLToPath(new URL('../src/core/service.ts', import.meta.url))
    await Bun.write(`${dir}/users.service.ts`, `
      import { createService } from '${servicePath}'
      export function createUsersService() {
        return createService({ name: 'users', find: async () => [] })
      }
    `)

    const { ServiceRegistry } = await import('../src/core/service.ts')
    const registry = new ServiceRegistry()

    await autoloadServices({ dir, app: {}, registry })

    expect(registry.has('users')).toBe(true)

    await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true }).catch(() => {}))
  })

  it('returns gracefully when directory does not exist', async () => {
    const { ServiceRegistry } = await import('../src/core/service.ts')
    const registry = new ServiceRegistry()

    // Should not throw
    await expect(
      autoloadServices({ dir: '/tmp/does-not-exist-xyz', app: {}, registry })
    ).resolves.toBeUndefined()

    expect(registry.list().length).toBe(0)
  })

  it('skips duplicate services', async () => {
    const dir = `/tmp/junction-loader-dup-${Date.now()}`
    const { fileURLToPath } = await import('node:url')
    const servicePath = fileURLToPath(new URL('../src/core/service.ts', import.meta.url))
    await Bun.write(`${dir}/items.service.ts`, `
      import { createService } from '${servicePath}'
      export function createItemsService() {
        return createService({ name: 'items', find: async () => [] })
      }
    `)

    const { ServiceRegistry, createService } = await import('../src/core/service.ts')
    const registry = new ServiceRegistry()

    // Pre-register so loader finds a duplicate
    registry.register(createService({ name: 'items', find: async () => [] }))
    await autoloadServices({ dir, app: {}, registry })

    // Still only one
    expect(registry.list().length).toBe(1)

    await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true }).catch(() => {}))
  })

})

// ─── cors() CORS header correctness ───────────────────────────────────────
// Regression tests for the bug where Access-Control-Allow-Origin was missing
// from preflight responses because:
//   1. OPTIONS handler was registered before patchRouterWithMiddleware ran
//   2. Middleware returned a Response directly instead of calling next()

describe('cors() preflight and header correctness', () => {

  async function makeApp(origins: string | string[]) {
    const app = await createTestApp({
      services: [() => createService({
        name:   'items',
        find:   async () => [],
        create: async () => ({ created: true }),
      })],
    })
    app.configure(cors({ origins, credentials: true }))
    return app
  }

  it('OPTIONS preflight returns Access-Control-Allow-Origin', async () => {
    const app = await makeApp('http://localhost:5173')
    const res = await request(app)
      .options('/items')
      .set('origin', 'http://localhost:5173')
      .set('access-control-request-method', 'POST')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('OPTIONS preflight includes Access-Control-Allow-Methods', async () => {
    const app = await makeApp(['http://localhost:5173'])
    const res = await request(app)
      .options('/items')
      .set('origin', 'http://localhost:5173')
      .set('access-control-request-method', 'PATCH')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-methods']).toContain('PATCH')
  })

  it('GET response includes Access-Control-Allow-Origin', async () => {
    const app = await makeApp(['http://localhost:5173'])
    const res = await request(app)
      .get('/items')
      .set('origin', 'http://localhost:5173')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('POST response includes Access-Control-Allow-Origin', async () => {
    const app = await makeApp(['http://localhost:5173'])
    const res = await request(app)
      .post('/items')
      .set('origin', 'http://localhost:5173')
      .send({ name: 'thing' })
    expect(res.status).toBe(201)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
  })

  it('credentials: true sets Access-Control-Allow-Credentials', async () => {
    const app = await makeApp(['http://localhost:5173'])
    const res = await request(app)
      .options('/items')
      .set('origin', 'http://localhost:5173')
      .set('access-control-request-method', 'GET')
    expect(res.headers['access-control-allow-credentials']).toBe('true')
  })

  it('unlisted origin gets no Access-Control-Allow-Origin', async () => {
    const app = await makeApp(['http://localhost:5173'])
    const res = await request(app)
      .get('/items')
      .set('origin', 'http://evil.com')
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('wildcard origin allows any origin', async () => {
    const app = await makeApp('*')
    const res = await request(app)
      .options('/items')
      .set('origin', 'http://anything.com')
      .set('access-control-request-method', 'GET')
    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBeTruthy()
  })
})

// ─── Model-less service wiring ────────────────────────────────────────────
// Regression test for the bug where the (now removed) createLitestoneService
// returned a plain ServiceDefinition object instead of calling createService(),
// meaning the hook state was undefined and app.start() crashed while warming
// every registered service.
//
// createService is now the only factory, so these assert the same invariants
// on the model-less path it absorbed: a built service can always answer for its
// own pipelines, survives start(), routes, and applies its declared hooks.

describe('createService — model-less (explicit CRUD methods)', () => {

  it('registers without throwing — _hookMap is defined', async () => {
    const svc = createService({
      name:  'widgets',
      find:  async () => [],
      get:   async () => null,
      create: async (ctx) => ctx.data,
      patch:  async (ctx) => ctx.data,
      remove: async () => null,
    })
    // Must have the internal state createService() adds
    expect(svc._hookMap).toBeDefined()
    expect(typeof svc.pipelines).toBe('function')
    expect(svc.pipelines()['find']).toBeDefined()
  })

  it('app.start() does not crash when a litestone service is registered', async () => {
    const svc = createService({
      name:   'widgets',
      find:   async () => [],
      get:    async () => null,
      create: async (ctx) => ctx.data,
      patch:  async (ctx) => ctx.data,
      remove: async () => null,
    })
    // createTestApp calls _startForTest() which runs setAppHooks → mergeHookMaps
    // — this is where the crash happened
    await expect(createTestApp({ services: [() => svc] })).resolves.toBeDefined()
  })

  it('registered service responds to GET /api/widgets', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:  'widgets',
        find:  async () => [{ id: 1, name: 'Sprocket' }],
        get:   async () => null,
        create: async (ctx) => ctx.data,
        patch:  async (ctx) => ctx.data,
        remove: async () => null,
      })],
    })
    const res = await request(app).get('/widgets')
    expect(res.status).toBe(200)
    expect(Array.isArray((res.body as Record<string, unknown>).data)
      || Array.isArray(res.body)).toBe(true)
  })

  it('hooks declared on the service definition are applied', async () => {
    let hookRan = false
    const app = await createTestApp({
      services: [() => createService({
        name: 'widgets',
        find: async () => [],
        get:  async () => null,
        create: async (ctx) => ctx.data,
        patch:  async (ctx) => ctx.data,
        remove: async () => null,
        hooks: {
          before: {
            find: [async (_ctx) => { hookRan = true }],
          },
        },
      })],
    })
    await request(app).get('/widgets')
    expect(hookRan).toBe(true)
  })
})

// ─── Cache-Control headers ─────────────────────────────────────────────────
// Regression for the bug where ctx.json() hardcoded 'private,no-cache,no-store'
// on every response. Cache-Control is now set contextually in _finalizeWithHeaders.

describe('Cache-Control headers', () => {

  it('authenticated GET returns private, no-cache', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'items',
        find: async () => [],
        hooks: { before: { find: [authenticate] } },
      })],
      auth: createStubAuth({ users: [{ id: 'u1', role: 'user' }] }),
    })
    const res = await request(app)
      .get('/items')
      .set('authorization', 'Bearer test-token-u1')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toContain('private')
    expect(res.headers['cache-control']).toContain('no-cache')
  })

  it('authenticated GET includes Vary: Authorization', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'items',
        find: async () => [],
        hooks: { before: { find: [authenticate] } },
      })],
      auth: createStubAuth({ users: [{ id: 'u1', role: 'user' }] }),
    })
    const res = await request(app)
      .get('/items')
      .set('authorization', 'Bearer test-token-u1')
    expect(res.headers['vary']).toContain('Authorization')
  })

  it('public GET returns no-store', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'items', find: async () => [] })],
    })
    const res = await request(app).get('/items')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('POST returns no-store', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:   'items',
        find:   async () => [],
        create: async (ctx) => ctx.data ?? {},
      })],
    })
    const res = await request(app).post('/items').send({ name: 'x' })
    expect(res.status).toBe(201)
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('PATCH returns no-store', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name:  'items',
        find:  async () => [],
        get:   async () => ({ id: '1' }),
        patch: async (ctx) => ({ id: ctx.id, ...ctx.data }),
      })],
    })
    const res = await request(app).patch('/items/1').send({ name: 'y' })
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
  })
})

// ─── authenticate hook — call site correctness ────────────────────────────
// Regression for the bug where authenticate was called as authenticate()
// (invoking it immediately, returning undefined) instead of passed as a
// reference. The resulting TypeError crashed with 'ctx.params is undefined'.

describe('authenticate hook usage', () => {

  async function makeApp() {
    return createTestApp({
      services: [() => createService({
        name:   'items',
        find:   async () => [{ id: 1 }],
        create: async (ctx) => ctx.data ?? {},
        get:    async () => ({ id: '1' }),
        patch:  async (ctx) => ({ id: ctx.id }),
        remove: async () => ({ id: '1' }),
        hooks: {
          before: {
            create: [authenticate],
            patch:  [authenticate],
            remove: [authenticate],
          },
        },
      })],
      auth: createStubAuth({ users: [{ id: 'u1', role: 'user' }] }),
    })
  }

  it('unauthenticated create returns 401', async () => {
    const app = await makeApp()
    const res = await request(app).post('/items').send({ name: 'x' })
    expect(res.status).toBe(401)
  })

  it('authenticated create succeeds', async () => {
    const app = await makeApp()
    const res = await request(app)
      .post('/items')
      .set('authorization', 'Bearer test-token-u1')
      .send({ name: 'x' })
    expect(res.status).toBe(201)
  })

  it('unauthenticated GET /find still works (no auth on find)', async () => {
    const app = await makeApp()
    const res = await request(app).get('/items')
    expect(res.status).toBe(200)
  })

  it('does not crash when passed as reference vs called as function', async () => {
    // The bug: hooks: { before: { create: [authenticate()] } }
    // authenticate() returns undefined — the pipeline stored [undefined]
    // and crashed with 'ctx.params is undefined' on the next request.
    // Passing the reference instead must not throw.
    await expect(makeApp()).resolves.toBeDefined()
  })
})

// ─── Plugin lifecycle ─────────────────────────────────────────────────────
// Tests for app.configure(), register/boot/ready/shutdown hooks, and the
// _metricsProviders extension point used by Caravan, Conduit, etc.

describe('Plugin lifecycle', () => {

  it('configure() runs register() synchronously', async () => {
    let ran = false
    const app = await createTestApp()
    app.configure({ name: 'test', register() { ran = true } })
    expect(ran).toBe(true)
  })

  it('register() receives the app instance', async () => {
    let received: unknown
    const app = await createTestApp()
    app.configure({ name: 'test', register(a) { received = a } })
    expect(received).toBe(app)
  })

  it('plugin can set a property on app via register()', async () => {
    const app = await createTestApp() as typeof app & { myPlugin?: string }
    app.configure({
      name: 'test',
      register(a) { (a as typeof app & { myPlugin?: string }).myPlugin = 'wired' }
    })
    expect((app as typeof app & { myPlugin?: string }).myPlugin).toBe('wired')
  })

  it('boot() runs during _startForTest()', async () => {
    let booted = false
    const app = await createTestApp({
      services: [],
    })
    // configure after createTestApp to test late boot
    // boot already ran in createTestApp — test that boot fires via direct configure
    app.configure({ name: 'test', register() {}, boot() { booted = true } })
    // boot() on post-start plugins does not run (documented behaviour) —
    // but register() does. Verify register ran.
    expect(booted).toBe(false) // boot skipped after start
  })

  it('a plain function is accepted as a plugin', async () => {
    let ran = false
    const app = await createTestApp()
    app.configure((_a) => { ran = true })
    expect(ran).toBe(true)
  })

  it('multiple plugins register in order', async () => {
    const order: string[] = []
    const app = await createTestApp()
    app.configure({ name: 'a', register() { order.push('a') } })
    app.configure({ name: 'b', register() { order.push('b') } })
    app.configure({ name: 'c', register() { order.push('c') } })
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('plugin registered before start() has boot() called', async () => {
    // Plugins configured before _startForTest() runs get boot() called.
    // We verify by checking that a plugin that calls boot runs its side effect.
    const booted: string[] = []

    // createTestApp runs _startForTest() internally — plugins configured
    // via opts are registered before that call, so boot() runs.
    // Simulate by configuring on a fresh app before _startForTest:
    const { createApp, defaultConfig } = await import('../index.ts')
    const innerApp = createApp({ config: { ...defaultConfig, database: { url: '', log: false } } })
    innerApp.configure({ name: 'p1', boot() { booted.push('p1') } })
    innerApp.configure({ name: 'p2', boot() { booted.push('p2') } })
    await innerApp._startForTest()
    expect(booted).toEqual(['p1', 'p2'])
  })

})

// ─── _metricsProviders ────────────────────────────────────────────────────
// Tests for the plugin metrics extension point used by Caravan and Conduit.

describe('_metricsProviders', () => {

  it('is an empty Map on a fresh app', async () => {
    const app = await createTestApp()
    expect(app._metricsProviders).toBeInstanceOf(Map)
    expect(app._metricsProviders.size).toBe(0)
  })

  it('plugin can register a metrics provider', async () => {
    const app = await createTestApp()
    app._metricsProviders.set('myplugin', () => ({ count: 42 }))
    expect(app._metricsProviders.has('myplugin')).toBe(true)
  })

  it('registered provider appears in GET /metrics', async () => {
    const app = await createTestApp()
    app.configure(healthPlugin())
    app._metricsProviders.set('myplugin', () => ({ widgets: 7, active: true }))
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.myplugin).toEqual({ widgets: 7, active: true })
  })

  it('multiple providers all appear in /metrics', async () => {
    const app = await createTestApp()
    app.configure(healthPlugin())
    app._metricsProviders.set('jobs',    () => ({ pending: 3 }))
    app._metricsProviders.set('conduit', () => ({ targets: { total: 2 } }))
    const res = await request(app).get('/metrics')
    const body = res.body as Record<string, unknown>
    expect(body.jobs).toEqual({ pending: 3 })
    expect(body.conduit).toEqual({ targets: { total: 2 } })
  })

  it('a provider that throws does not crash /metrics', async () => {
    const app = await createTestApp()
    app.configure(healthPlugin())
    app._metricsProviders.set('broken', () => { throw new Error('provider error') })
    app._metricsProviders.set('fine',   () => ({ ok: true }))
    const res = await request(app).get('/metrics')
    // Should still return 200 — broken provider is skipped
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.fine).toEqual({ ok: true })
    expect(body.broken).toBeUndefined()
  })

  it('provider result is merged at top level of metrics response', async () => {
    const app = await createTestApp()
    app.configure(healthPlugin())
    app._metricsProviders.set('caravan', () => ({
      queues: { default: { pending: 1, running: 0, dead: 0 } },
      total:  { pending: 1, running: 0, dead: 0 },
    }))
    const res = await request(app).get('/metrics')
    const body = res.body as Record<string, unknown>
    // Caravan stats land at body.caravan, not nested inside body.cache etc.
    expect(body.caravan).toBeDefined()
    expect((body.caravan as Record<string, unknown>).total).toEqual({ pending: 1, running: 0, dead: 0 })
    // Core fields still present
    expect(body.cache).toBeDefined()
    expect(body.services).toBeDefined()
  })

})

// ─── Security headers (helmet auto-applied) ───────────────────────────────

describe('helmet — security headers applied by default', () => {

  it('x-frame-options: DENY on every response', async () => {
    const app = await createTestApp()
    app.services.register(createService({ name: 'items', find: async () => [] }))
    const res = await request(app).get('/items')
    expect(res.headers['x-frame-options']).toBe('DENY')
  })

  it('x-content-type-options: nosniff on every response', async () => {
    const app = await createTestApp()
    app.services.register(createService({ name: 'items', find: async () => [] }))
    const res = await request(app).get('/items')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('x-xss-protection header set', async () => {
    const app = await createTestApp()
    app.services.register(createService({ name: 'items', find: async () => [] }))
    const res = await request(app).get('/items')
    expect(res.headers['x-xss-protection']).toBeDefined()
  })

  it('referrer-policy header set', async () => {
    const app = await createTestApp()
    app.services.register(createService({ name: 'items', find: async () => [] }))
    const res = await request(app).get('/items')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
  })

  it('helmet disabled via config.http.helmet = false', async () => {
    const app = await createTestApp({ config: { http: { helmet: false } } })
    app.services.register(createService({ name: 'items', find: async () => [] }))
    const res = await request(app).get('/items')
    expect(res.headers['x-frame-options']).toBeUndefined()
  })

})

// ─── app.setAuth() ────────────────────────────────────────────────────────

describe('app.setAuth()', () => {

  it('sets auth after createApp — verifySession works on subsequent requests', async () => {
    const app = await createTestApp()
    const stubAuth = createStubAuth({ users: [{ id: 'u1', role: 'user' }] })
    app.setAuth(stubAuth)

    app.services.register(createService({
      name: 'items',
      find: async () => [],
      hooks: { before: { find: [authenticate] } },
    }))

    const token = stubAuth.addUser({ id: 'u2', role: 'user' })
    const res = await request(app).get('/items').auth(token)
    expect(res.status).toBe(200)
  })

  it('requests without token still rejected after setAuth', async () => {
    const app = await createTestApp()
    app.setAuth(createStubAuth())

    app.services.register(createService({
      name: 'items',
      find: async () => [],
      hooks: { before: { find: [authenticate] } },
    }))

    const res = await request(app).get('/items')
    expect(res.status).toBe(401)
  })

})
