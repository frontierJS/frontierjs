// tests/p0-fixes.test.ts
// ─────────────────────────────────────────────────────────────────────────
// Regression tests for the P0 audit fixes (2026-07-18):
//
//   1. Service cache stores/serves CLONES — after-hook mutation (protect)
//      can no longer poison the cached copy or leak protected fields.
//   2. update() is a real CRUD method — full-replace sibling of patch,
//      with auto-event 'updated'.
//   3. Hooks added after app start (service.hooks / app.hooks) take
//      effect — compiled pipelines are recompiled, not silently stale.
//   4. Webhook management routes require auth and never return the HMAC
//      secret on read paths (POST create shows it exactly once).
//   5. parseBody rejects oversized declared Content-Length BEFORE
//      buffering the body.
//   6. extractIP ignores spoofable forwarding headers unless trustProxy
//      is explicitly enabled, preferring the socket address.
// ─────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'bun:test'
import {
  createTestApp, request, testCtx,
  createService, callService,
  protect,
  webhooks,
} from '../index.ts'
import { parseBody, extractIP } from '../src/transport/body.ts'

// ─── 1. Cache clone-on-read/write ─────────────────────────────────────────

describe('P0: service cache reference isolation', () => {

  function makeCachedService() {
    let hits = 0
    const record = { id: '1', name: 'Ada', password: 'hunter2' }
    const svc = createService({
      name: 'accounts',
      cache: true,
      async get() { hits++; return { ...record } },
      hooks: {
        after: { get: [protect('password')] },
      },
    })
    return { svc, calls: () => hits }
  }

  it('protect() strips fields without poisoning later cache hits', async () => {
    const app = await createTestApp({ services: [] })
    const { svc, calls } = makeCachedService()
    app.services.register(svc)

    const ctx1 = testCtx('accounts', 'get')
    ctx1.id = '1'
    await callService(svc, ctx1)
    const r1 = ctx1.result as { data: Record<string, unknown> }
    expect(r1.data.password).toBeUndefined()   // protect ran
    expect(r1.data.name).toBe('Ada')

    // Mutate the returned object — must NOT reach the cached copy
    delete r1.data.name

    const ctx2 = testCtx('accounts', 'get')
    ctx2.id = '1'
    await callService(svc, ctx2)
    const r2 = ctx2.result as { data: Record<string, unknown> }
    expect(calls()).toBe(1)                    // second call was a cache hit
    expect(r2.data.name).toBe('Ada')           // caller mutation did not stick
    expect(r2.data.password).toBeUndefined()   // stored copy was post-protect
  })
})

// ─── 2. update() is a first-class method ──────────────────────────────────

describe('P0: update() method', () => {

  function makeThings() {
    const store = new Map<string, Record<string, unknown>>([
      ['1', { id: '1', name: 'old', extra: 'field' }],
    ])
    return createService({
      name: 'things',
      async get(ctx)    { return store.get(String(ctx.id)) ?? null },
      async update(ctx) {
        const next = { id: String(ctx.id), ...(ctx.data as object) }
        store.set(String(ctx.id), next)
        return next
      },
    })
  }

  it('app.service().update() dispatches instead of throwing NotFound', async () => {
    const app = await createTestApp({ services: [() => makeThings()] })
    const result = await app.service('things').update('1', { name: 'new' }) as Record<string, unknown>
    expect(result.name).toBe('new')
    expect(result.id).toBe('1')
  })

  it('emits the things:updated auto-event', async () => {
    const app = await createTestApp({ services: [() => makeThings()] })
    let payload: unknown = null
    app.events.on('things:updated', (p: unknown) => { payload = p })
    await app.service('things').update('1', { name: 'evented' })
    // Event delivery is async — give the bus a tick
    await new Promise(r => setTimeout(r, 10))
    expect((payload as Record<string, unknown>)?.name).toBe('evented')
  })
})

// ─── 3. Post-start hook registration ──────────────────────────────────────

describe('P0: hooks added after start take effect', () => {

  it('service.hooks() after first request still runs new hooks', async () => {
    const svc = createService({ name: 'ping', async find() { return [1] } })
    const app = await createTestApp({ services: [() => svc] })

    // First request compiles pipelines (setAppHooks via _startForTest)
    const r1 = await request(app).get('/ping')
    expect(r1.status).toBe(200)

    let ran = false
    function lateHook() { ran = true }
    svc.hooks({ before: { find: [lateHook] } })

    const r2 = await request(app).get('/ping')
    expect(r2.status).toBe(200)
    expect(ran).toBe(true)
  })

  it('app.hooks() after first request still runs new hooks', async () => {
    const app = await createTestApp({
      services: [() => createService({ name: 'pong', async find() { return [1] } })],
    })
    await request(app).get('/pong')

    let ran = false
    function lateAppHook() { ran = true }
    app.hooks({ before: { all: [lateAppHook] } })

    await request(app).get('/pong')
    expect(ran).toBe(true)
  })
})

// ─── 4. Webhook management route security ─────────────────────────────────

describe('P0: webhook routes — auth required, secrets redacted', () => {

  async function makeWebhookApp() {
    const app = await createTestApp({
      config: { apiPrefix: '/api' },
      users:  [{ id: 'admin-1', role: 'admin' }],
    })
    app.configure(webhooks({ events: [] }))   // store auto-created from app.db
    return app
  }

  it('rejects unauthenticated management requests', async () => {
    const app = await makeWebhookApp()
    const res = await request(app).get('/api/webhooks')
    expect(res.status).toBe(401)
  })

  it('returns the secret exactly once (on create), never on reads', async () => {
    const app = await makeWebhookApp()
    const auth = app.tokenFor('admin-1')

    const created = await request(app)
      .post('/api/webhooks')
      .auth(auth)
      .send({ url: 'https://example.com/hook', events: ['*'] })
    expect(created.status).toBe(201)
    const hook = created.body as Record<string, unknown>
    expect(hook.secret).toBeTruthy()           // shown once here

    const list = await request(app).get('/api/webhooks').auth(auth)
    expect(list.status).toBe(200)
    for (const h of list.body as Record<string, unknown>[]) {
      expect(h.secret).toBeUndefined()
      expect(h.url).toBeTruthy()               // still a real registration
    }

    const one = await request(app).get(`/api/webhooks/${hook.id}`).auth(auth)
    expect(one.status).toBe(200)
    expect((one.body as Record<string, unknown>).secret).toBeUndefined()
  })
})

// ─── 5. Body limit enforced before buffering ──────────────────────────────

describe('P0: Content-Length pre-check', () => {

  it('rejects an oversized declared Content-Length without reading the body', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '10485760' },
    })
    // 1 MB limit, 10 MB declared — must throw from the header check alone
    expect(parseBody(req, 1024 * 1024)).rejects.toThrow(/exceeds/)
  })

  it('still enforces the limit on actual body size', async () => {
    const body = JSON.stringify({ pad: 'x'.repeat(2048) })
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(parseBody(req, 512)).rejects.toThrow(/exceeds/)
  })
})

// ─── 6. IP extraction is spoof-resistant by default ───────────────────────

describe('P0: extractIP trust model', () => {

  const spoofed = new Request('http://localhost/', {
    headers: { 'x-forwarded-for': '6.6.6.6, 10.0.0.1', 'x-real-ip': '6.6.6.7' },
  })

  it('prefers the socket address and ignores forwarded headers by default', () => {
    expect(extractIP(spoofed, '203.0.113.9')).toBe('203.0.113.9')
  })

  it('honors forwarded headers only when trustProxy is enabled', () => {
    expect(extractIP(spoofed, '203.0.113.9', true)).toBe('6.6.6.6')
  })

  it('falls back to headers, then localhost, when no socket address exists', () => {
    expect(extractIP(spoofed)).toBe('6.6.6.6')
    expect(extractIP(new Request('http://localhost/'))).toBe('127.0.0.1')
  })
})
