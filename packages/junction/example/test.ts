// example/test.ts
// ─────────────────────────────────────────────────────────────────────────
// Example tests for the Junction demo API.
// Shows how to use the testing utilities — no real server, no ports.
//
// Run: bun test example/test.ts
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  createTestApp, request, testCtx,
  createService, createSchema, v,
  authenticate, requireRole, circuitBreaker,
  protect, timestamps,
  callService,
  NotFound, BadRequest, Forbidden, Unavailable,
  healthPlugin, correlationId,
  type TestApp,
} from '../index.ts'

import { createUsersService } from './services/users.service.ts'
import { createNotesService } from './services/notes.service.ts'

// ─── App factory ─────────────────────────────────────────────────────────
// Each test suite gets a fresh isolated app with clean in-memory state.

async function makeApp(): Promise<TestApp> {
  return createTestApp({
    // Mirror the demo app's config — its routes (and these tests) live
    // under /api. createTestApp's defaultConfig has no prefix, so without
    // this every request here would 404 against /{service} routes.
    config: { apiPrefix: '/api' },
    services: [
      (app) => createUsersService(app),
      (app) => createNotesService(app),
    ],
    users: [
      { id: 'admin-1', role: 'admin' },
      { id: 'user-1',  role: 'user'  },
    ],
  })
}

// ─── Users service ────────────────────────────────────────────────────────

describe('Users service', () => {

  it('creates a user and returns a token', async () => {
    const app = await makeApp()
    const res = await request(app)
      .post('/api/users')
      .send({ name: 'Alice', email: 'alice@example.com' })
    expect(res.status).toBe(201)   // create → 201 Created
    expect((res.body as Record<string, unknown>).email).toBe('alice@example.com')
    expect((res.body as Record<string, unknown>).token).toBeTruthy()
  })

  it('rejects duplicate email with 409', async () => {
    const app = await makeApp()
    await request(app).post('/api/users').send({ name: 'Alice', email: 'alice@example.com' })
    const res = await request(app).post('/api/users').send({ name: 'Alice2', email: 'alice@example.com' })
    expect(res.status).toBe(409)
  })

  it('GET /api/users lists all users', async () => {
    const app = await makeApp()
    await request(app).post('/api/users').send({ name: 'Bob', email: 'bob@example.com' })
    const res = await request(app).get('/api/users')
    expect(res.status).toBe(200)
    const body = res.body as { data: unknown[]; total: number }
    expect(body.total).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('GET /api/users/:id returns a single user', async () => {
    const app = await makeApp()
    const created = await request(app)
      .post('/api/users')
      .send({ name: 'Carol', email: 'carol@example.com' })
    const id  = (created.body as Record<string, unknown>).id as string
    const res = await request(app).get(`/api/users/${id}`)
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).email).toBe('carol@example.com')
  })

  it('PATCH /api/users/:id updates name', async () => {
    const app = await makeApp()
    const created = await request(app)
      .post('/api/users')
      .send({ name: 'Dave', email: 'dave@example.com' })
    const id  = (created.body as Record<string, unknown>).id as string
    const res = await request(app).patch(`/api/users/${id}`).send({ name: 'David' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).name).toBe('David')
  })

  it('DELETE /api/users/:id removes user', async () => {
    const app = await makeApp()
    const created = await request(app)
      .post('/api/users')
      .send({ name: 'Eve', email: 'eve@example.com' })
    const id  = (created.body as Record<string, unknown>).id as string
    const del = await request(app).delete(`/api/users/${id}`)
    expect(del.status).toBe(200)
    const get = await request(app).get(`/api/users/${id}`)
    expect(get.status).toBe(404)
  })

  it('token field is stripped from list results (protect hook)', async () => {
    const app = await makeApp()
    await request(app).post('/api/users').send({ name: 'Frank', email: 'frank@example.com' })
    const res  = await request(app).get('/api/users')
    const data = (res.body as { data: Record<string, unknown>[] }).data
    for (const user of data) {
      expect(user.token).toBeUndefined()
    }
  })
})

// ─── Notes service ────────────────────────────────────────────────────────

describe('Notes service', () => {

  it('creates a note when authenticated', async () => {
    const app = await makeApp()
    const res = await request(app)
      .post('/api/notes')
      .auth(app.tokenFor('user-1'))
      .send({ title: 'Hello Junction', body: 'First note', tags: ['demo'] })
    expect(res.status).toBe(201)   // create → 201 Created
    const body = res.body as Record<string, unknown>
    expect(body.title).toBe('Hello Junction')
    expect(body.author_id).toBe('user-1')
    expect(Array.isArray(body.tags)).toBe(true)
  })

  it('rejects unauthenticated create with 401', async () => {
    const app = await makeApp()
    const res = await request(app)
      .post('/api/notes')
      .send({ title: 'Sneaky note', body: 'Should fail' })
    expect(res.status).toBe(401)
  })

  it('rejects create with missing required fields', async () => {
    const app = await makeApp()
    const res = await request(app)
      .post('/api/notes')
      .auth(app.tokenFor('user-1'))
      .send({ title: 'Missing body' })
    expect(res.status).toBe(400)
  })

  it('GET /api/notes returns paginated list', async () => {
    const app = await makeApp()
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/notes')
        .auth(app.tokenFor('user-1'))
        .send({ title: `Note ${i}`, body: 'body' })
    }
    const res  = await request(app).get('/api/notes')
    // List envelope uses `offset` (not `skip`) — the framework normalises
    // pagination fields when wrapping results.
    const body = res.body as { total: number; data: unknown[]; limit: number; offset: number }
    expect(res.status).toBe(200)
    expect(body.total).toBe(3)
    expect(body.limit).toBeDefined()
    expect(body.offset).toBeDefined()
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('filters notes by title', async () => {
    const app = await makeApp()
    await request(app).post('/api/notes').auth(app.tokenFor('user-1')).send({ title: 'Bun rocks', body: 'b' })
    await request(app).post('/api/notes').auth(app.tokenFor('user-1')).send({ title: 'Python rocks', body: 'b' })
    const res  = await request(app).get('/api/notes').query({ title: 'Bun' })
    const body = res.body as { data: unknown[] }
    expect(body.data).toHaveLength(1)
  })

  it('PATCH /api/notes/:id updates a note', async () => {
    const app  = await makeApp()
    const post = await request(app)
      .post('/api/notes')
      .auth(app.tokenFor('user-1'))
      .send({ title: 'Old title', body: 'body' })
    const id  = (post.body as Record<string, unknown>).id as string
    const res = await request(app)
      .patch(`/api/notes/${id}`)
      .auth(app.tokenFor('user-1'))
      .send({ title: 'New title' })
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).title).toBe('New title')
  })

  it('DELETE /api/notes/:id removes a note', async () => {
    const app  = await makeApp()
    const post = await request(app)
      .post('/api/notes')
      .auth(app.tokenFor('user-1'))
      .send({ title: 'Delete me', body: 'body' })
    const id  = (post.body as Record<string, unknown>).id as string
    const del = await request(app).delete(`/api/notes/${id}`).auth(app.tokenFor('user-1'))
    expect(del.status).toBe(200)
    const get = await request(app).get(`/api/notes/${id}`)
    expect(get.status).toBe(404)
  })

  it('GET /api/notes/:id/summary — custom action', async () => {
    const app  = await makeApp()
    const post = await request(app)
      .post('/api/notes')
      .auth(app.tokenFor('user-1'))
      .send({ title: 'Summary test', body: 'One two three four five' })
    const id  = (post.body as Record<string, unknown>).id as string
    // Custom actions dispatch via POST /{service}/{id} + X-Service-Method
    // header — there are no path-style /{id}/{action} routes.
    const res = await request(app)
      .post(`/api/notes/${id}`)
      .set('X-Service-Method', 'summary')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body.word_count).toBe(5)
    expect(body.char_count).toBeGreaterThan(0)
    expect(typeof body.preview).toBe('string')
  })

  it('admin can pin a note; regular user cannot', async () => {
    const app  = await makeApp()
    const post = await request(app)
      .post('/api/notes')
      .auth(app.tokenFor('user-1'))
      .send({ title: 'Pin me', body: 'body' })
    const id = (post.body as Record<string, unknown>).id as string

    // Admin succeeds — custom action via X-Service-Method header
    const adminRes = await request(app)
      .post(`/api/notes/${id}`)
      .set('X-Service-Method', 'pin')
      .auth(app.tokenFor('admin-1'))
    expect(adminRes.status).toBe(200)

    // Regular user is rejected
    const userRes = await request(app)
      .post(`/api/notes/${id}`)
      .set('X-Service-Method', 'pin')
      .auth(app.tokenFor('user-1'))
    expect(userRes.status).toBe(403)
  })
})

// ─── Circuit breaker ──────────────────────────────────────────────────────

describe('Circuit breaker (prices service)', () => {

  function makeFlaky(failAfter: number) {
    let calls = 0
    return createService({
      name: 'flaky',
      find: async () => {
        calls++
        if (calls <= failAfter) throw new Error('upstream down')
        return [{ ok: true, calls }]
      },
      hooks: {
        around: { all: [circuitBreaker({ threshold: 3, timeout: 20 })] },
      },
    })
  }

  it('passes through when upstream is healthy', async () => {
    const app = await createTestApp({ services: [() => makeFlaky(0)] })
    const ctx = testCtx('flaky', 'find')
    await callService(app.services.get('flaky')!, ctx)
    // callService wraps raw results in the ServiceResult envelope —
    // the records live under .data
    expect(Array.isArray((ctx.result as { data: unknown[] }).data)).toBe(true)
  })

  it('opens after threshold failures', async () => {
    const app = await createTestApp({ services: [() => makeFlaky(999)] })
    const svc = app.services.get('flaky')!

    for (let i = 0; i < 3; i++) {
      await expect(callService(svc, testCtx('flaky', 'find'))).rejects.toThrow()
    }

    // Circuit is now open — next call should be Unavailable (503), not upstream error
    await expect(callService(svc, testCtx('flaky', 'find'))).rejects.toBeInstanceOf(Unavailable)
  })

  it('recovers after timeout', async () => {
    let fail = true
    const svc = createService({
      name: 'recover',
      find: async () => { if (fail) throw new Error('down'); return [{ ok: true }] },
      hooks: { around: { all: [circuitBreaker({ threshold: 2, timeout: 20 })] } },
    })
    const app = await createTestApp({ services: [() => svc] })
    const s   = app.services.get('recover')!

    for (let i = 0; i < 2; i++) {
      await expect(callService(s, testCtx('recover', 'find'))).rejects.toThrow()
    }
    await new Promise(r => setTimeout(r, 30))
    fail = false
    const ctx = testCtx('recover', 'find')
    await callService(s, ctx)
    expect(ctx.error).toBeNull()
  })
})

// ─── Health plugin ────────────────────────────────────────────────────────

describe('healthPlugin', () => {

  it('GET /health returns 200 ok', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'ping', find: async () => [] })],
    })
    app.configure(healthPlugin())
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).status).toBe('ok')
  })

  it('GET /health returns 503 when a check fails', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'ping', find: async () => [] })],
    })
    app.configure(healthPlugin({
      checks: { downstream: async () => { throw new Error('connection refused') } },
    }))
    const res = await request(app).get('/health')
    expect(res.status).toBe(503)
    expect((res.body as Record<string, unknown>).status).toBe('degraded')
  })

  it('GET /metrics returns process + service + cache data', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'ping', find: async () => [] })],
    })
    app.configure(healthPlugin())
    const res  = await request(app).get('/metrics')
    const body = res.body as Record<string, unknown>
    expect(res.status).toBe(200)
    expect(body.process).toBeDefined()
    expect(body.cache).toBeDefined()
    expect((body.services as Record<string, unknown>).registered).toContain('ping')
  })
})

// ─── Correlation ID middleware ────────────────────────────────────────────

describe('correlationId middleware', () => {

  it('echoes X-Request-ID back in the response', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'ping', find: async () => [] })],
    })
    app.configure(correlationId())
    const res = await request(app).get('/api/ping').set('x-request-id', 'trace-abc')
    expect(res.headers['x-request-id']).toBe('trace-abc')
  })

  it('generates an id when none is provided', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'ping', find: async () => [] })],
    })
    app.configure(correlationId())
    const res = await request(app).get('/api/ping')
    expect(res.headers['x-request-id']).toBeTruthy()
  })
})

// ─── Direct service testing (no HTTP) ────────────────────────────────────

describe('Direct callService()', () => {

  it('calls a service method without any HTTP infrastructure', async () => {
    const app = await makeApp()
    const ctx = testCtx('notes', 'find')
    await callService(app.services.get('notes')!, ctx)
    expect(ctx.error).toBeNull()
    const result = ctx.result as { total: number; data: unknown[] }
    expect(typeof result.total).toBe('number')
    expect(Array.isArray(result.data)).toBe(true)
  })

  it('hooks run on direct callService() calls', async () => {
    const order: string[] = []
    const svc = createService({
      name: 'ordered',
      find: async () => { order.push('method'); return [] },
      hooks: {
        before: { find: [async () => { order.push('before') }] },
        after:  { find: [async () => { order.push('after')  }] },
      },
    })
    const app = await createTestApp({ services: [() => svc] })
    await callService(app.services.get('ordered')!, testCtx('ordered', 'find'))
    expect(order).toEqual(['before', 'method', 'after'])
  })
})
