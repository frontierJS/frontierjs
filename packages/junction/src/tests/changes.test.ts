// tests/changes.test.ts
// Tests for changes made in the latest Junction update:
//   1. Custom methods defined directly on service (no actions key)
//   2. get(query) → findFirst
//   3. restore as a first-class CRUD method
//   4. ctx.app.service() for internal calls from hooks
//   5. Client: find() returns T[], get(query) routing, restore()

import { describe, it, expect, beforeEach } from 'bun:test'
import { createService, callService }        from '../core/service.ts'
import { createTestApp, request }            from '../testing/index.ts'
import { bridge }                            from '../transport/bridge.ts'
import { createJunctionClient }              from '../client/index.ts'

// ─── 1. Custom methods — no actions key ──────────────────────────────────────

describe('Custom methods (top-level, no actions key)', () => {

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

  it('throws NotFound for unknown method', async () => {
    const svc = createService({ name: 'servers' })
    const ctx = bridge.internal('servers', 'find', null)
    ctx.method = 'nope'

    await expect(callService(svc, ctx)).rejects.toMatchObject({ code: 404 })
  })

  it('custom method runs through the full hook pipeline', async () => {
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

  it('custom method hooks do not bleed into CRUD', async () => {
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

  it('CRUD hooks do not bleed into custom methods', async () => {
    let createHookCalled = false

    const svc = createService({
      name: 'test',
      async drain() { return { ok: true } },
      hooks: {
        before: {
          create: [async () => { createHookCalled = true }],
        },
      },
    })

    const ctx = bridge.internal('test', 'find', null)
    ctx.method = 'drain'
    await callService(svc, ctx)
    expect(createHookCalled).toBe(false)
  })

  it('multiple custom methods coexist on one service', async () => {
    const results: string[] = []

    const svc = createService({
      name: 'servers',
      async reboot()    { results.push('reboot');    return { method: 'reboot' } },
      async drain()     { results.push('drain');     return { method: 'drain' } },
      async heartbeat() { results.push('heartbeat'); return { method: 'heartbeat' } },
    })

    for (const method of ['reboot', 'drain', 'heartbeat']) {
      const ctx = bridge.internal('servers', 'find', null)
      ctx.method = method
      await callService(svc, ctx)
    }

    expect(results).toEqual(['reboot', 'drain', 'heartbeat'])
  })

  it('custom method is routed via POST /api/{service}/{id}/{method}', async () => {
    const app = await createTestApp()
    let rebooted = false

    app.services.register(createService({
      name: 'servers',
      find: async () => [],
      async reboot(ctx) { rebooted = true; return { id: ctx.id, rebooted: true } },
    }))

    const res = await request(app)
      .post('/api/servers/srv-1/reboot')
      .send({})

    expect(res.status).toBe(200)
    expect(rebooted).toBe(true)
  })

  it('app.service().call() invokes a custom method', async () => {
    const app = await createTestApp()
    let rebooted = false

    app.services.register(createService({
      name: 'servers',
      find: async () => [],
      async reboot(ctx) { rebooted = true; return { id: ctx.id, rebooted: true } },
    }))

    await app._startForTest()
    await app.service('servers').call('reboot', 'srv-1')
    expect(rebooted).toBe(true)
  })
})

// ─── 2. get(query) → findFirst ────────────────────────────────────────────────

describe('get(query) → findFirst', () => {

  it('get with id returns single record', async () => {
    const store = new Map([
      ['1', { id: '1', name: 'Alice' }],
      ['2', { id: '2', name: 'Bob' }],
    ])

    const svc = createService({
      name: 'users',
      async get(ctx) {
        if (ctx.id) {
          const r = store.get(String(ctx.id))
          if (!r) throw Object.assign(new Error('Not found'), { code: 404 })
          return r
        }
        const where = ctx.query as Record<string, unknown>
        for (const [, rec] of store) {
          if (Object.entries(where).every(([k, v]) => (rec as Record<string, unknown>)[k] === v))
            return rec
        }
        throw Object.assign(new Error('Not found'), { code: 404 })
      },
    })

    const ctx = bridge.internal('users', 'get', null)
    ctx.id = '1'
    await callService(svc, ctx)
    expect((ctx.result as Record<string, unknown>).data).toMatchObject({ name: 'Alice' })
  })

  it('get without id uses query as where (findFirst)', async () => {
    const store = new Map([
      ['1', { id: '1', name: 'Alice' }],
      ['2', { id: '2', name: 'Bob' }],
    ])

    const svc = createService({
      name: 'users',
      async get(ctx) {
        if (ctx.id) {
          const r = store.get(String(ctx.id))
          if (!r) throw Object.assign(new Error('Not found'), { code: 404 })
          return r
        }
        const where = ctx.query as Record<string, unknown>
        for (const [, rec] of store) {
          if (Object.entries(where).every(([k, v]) => (rec as Record<string, unknown>)[k] === v))
            return rec
        }
        throw Object.assign(new Error('Not found'), { code: 404 })
      },
    })

    // No id — query goes in params.query
    const ctx = bridge.internal('users', 'get', null, { query: { name: 'Bob' } })
    await callService(svc, ctx)
    expect((ctx.result as Record<string, unknown>).data).toMatchObject({ name: 'Bob' })
  })

  it('GET /api/users?$first=true routes to get method', async () => {
    const app = await createTestApp()
    const calls: string[] = []

    app.services.register(createService({
      name: 'users',
      find: async () => [],
      async get(ctx) {
        calls.push(ctx.id ? `id:${ctx.id}` : 'findFirst')
        return ctx.id ? { id: ctx.id } : { id: 'first' }
      },
    }))

    const res = await request(app).get('/api/users?$first=true')
    expect(res.status).toBe(200)
    expect(calls).toContain('findFirst')
  })

  it('GET /api/users/123 routes to get with id', async () => {
    const app = await createTestApp()
    let gotId: string | null = null

    app.services.register(createService({
      name: 'users',
      find: async () => [],
      async get(ctx) { gotId = String(ctx.id); return { id: ctx.id } },
    }))

    const res = await request(app).get('/api/users/123')
    expect(res.status).toBe(200)
    expect(gotId).toBe('123')
  })

  it('client get(query) sends $first=true in URL', async () => {
    const requests: string[] = []

    global.fetch = async (input: RequestInfo) => {
      requests.push(String(input))
      return new Response(JSON.stringify({ id: 'u1', name: 'Alice' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    await client.service('users').get({ name: 'Alice' })

    expect(requests.some(r => r.includes('$first=true'))).toBe(true)
  })
})

// ─── 3. restore as first-class CRUD method ───────────────────────────────────

describe('restore as a CRUD method', () => {

  it('restore is callable via callService', async () => {
    let restored = false

    const svc = createService({
      name: 'posts',
      find: async () => [],
      async restore(ctx) { restored = true; return { id: ctx.id, deletedAt: null } },
    })

    const ctx = bridge.internal('posts', 'restore', null)
    ctx.id = '42'
    await callService(svc, ctx)
    expect(restored).toBe(true)
    expect((ctx.result as Record<string, unknown>).data).toMatchObject({ deletedAt: null })
  })

  it('before/after hooks run for restore', async () => {
    const order: string[] = []

    const svc = createService({
      name: 'posts',
      async restore() { order.push('restore'); return { restored: true } },
      hooks: {
        before: { restore: [async () => { order.push('before:restore') }] },
        after:  { restore: [async () => { order.push('after:restore') }] },
      },
    })

    const ctx = bridge.internal('posts', 'restore', null)
    ctx.method = 'restore'
    await callService(svc, ctx)
    expect(order).toEqual(['before:restore', 'restore', 'after:restore'])
  })

  it('PUT /api/posts/:id + X-Service-Method: restore routes to restore()', async () => {
    const app = await createTestApp()
    let restoredId: string | null = null

    app.services.register(createService({
      name: 'posts',
      find: async () => [],
      async get(ctx)     { return { id: ctx.id } },
      async restore(ctx) { restoredId = String(ctx.id); return { id: ctx.id, deletedAt: null } },
    }))

    const res = await request(app)
      .put('/api/posts/99')
      .set('x-service-method', 'restore')
      .send({})

    expect(res.status).toBe(200)
    expect(restoredId).toBe('99')
  })

  it('restore emits posts:restored event', async () => {
    const app = await createTestApp()
    const events: string[] = []

    app.events.on('posts:restored', () => events.push('restored'))

    app.services.register(createService({
      name: 'posts',
      find:   async () => [],
      async restore(ctx) { return { id: ctx.id, deletedAt: null } },
    }))

    await request(app)
      .put('/api/posts/1')
      .set('x-service-method', 'restore')
      .send({})

    await new Promise(r => setTimeout(r, 10))
    expect(events).toContain('restored')
  })

  it('restore is separate from patch — does not fire patched event', async () => {
    const app = await createTestApp()
    const events: string[] = []

    app.events.on('posts:patched',   () => events.push('patched'))
    app.events.on('posts:restored',  () => events.push('restored'))

    app.services.register(createService({
      name: 'posts',
      find:   async () => [],
      async restore(ctx) { return { id: ctx.id, deletedAt: null } },
    }))

    await request(app)
      .put('/api/posts/1')
      .set('x-service-method', 'restore')
      .send({})

    await new Promise(r => setTimeout(r, 10))
    expect(events).not.toContain('patched')
    expect(events).toContain('restored')
  })

  it('client restore(id) sends PUT with x-service-method header', async () => {
    const requests: { method: string; url: string; headers: Record<string, string> }[] = []

    global.fetch = async (input: RequestInfo, init?: RequestInit) => {
      requests.push({
        method:  (init?.method ?? 'GET').toUpperCase(),
        url:     String(input),
        headers: Object.fromEntries(new Headers(init?.headers ?? {}).entries()),
      })
      return new Response(JSON.stringify({ id: 1, deletedAt: null }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    await client.service('posts').restore(1)

    expect(requests[0].method).toBe('PUT')
    expect(requests[0].url).toContain('/api/posts/1')
    expect(requests[0].headers['x-service-method']).toBe('restore')
  })
})

// ─── 4. ctx.app.service() for internal calls from hooks ──────────────────────

describe('ctx.app.service() — internal calls from hooks', () => {

  it('after hook can call another service via ctx.app.service()', async () => {
    const app = await createTestApp()
    let auditCalled = false

    app.services.register(createService({
      name: 'audit',
      find: async () => [],
      async create() { auditCalled = true; return { logged: true } },
    }))

    app.services.register(createService({
      name: 'leads',
      find: async () => [],
      async create() { return { id: '1', name: 'test' } },
      hooks: {
        after: {
          create: [async (ctx) => {
            await ctx.app.service('audit').create({ action: 'lead.created' })
          }],
        },
      },
    }))

    await request(app).post('/api/leads').send({ name: 'test' })
    expect(auditCalled).toBe(true)
  })

  it('app.service() with ctx.params threads user identity', async () => {
    const app = await createTestApp({ users: [{ id: 'u1', role: 'user' }] })
    let seenUserId: string | null = null

    app.services.register(createService({
      name: 'logs',
      find: async () => [],
      async create(ctx) {
        seenUserId = ctx.params.user?.userId ?? null
        return { logged: true }
      },
    }))

    app.services.register(createService({
      name: 'leads',
      find: async () => [],
      async create() { return { id: '1' } },
      hooks: {
        after: {
          create: [async (ctx) => {
            await ctx.app.service('logs').create({ action: 'lead.created' }, ctx.params)
          }],
        },
      },
    }))

    await request(app)
      .post('/api/leads')
      .auth(app.tokenFor('u1'))
      .send({ name: 'test' })

    expect(seenUserId).toBe('u1')
  })

  it('app.service() without params makes an anonymous call', async () => {
    const app = await createTestApp({ users: [{ id: 'u1', role: 'user' }] })
    let seenUser: unknown = 'not-set'

    app.services.register(createService({
      name: 'logs',
      find: async () => [],
      async create(ctx) { seenUser = ctx.params.user; return { logged: true } },
    }))

    app.services.register(createService({
      name: 'leads',
      find: async () => [],
      async create() { return { id: '1' } },
      hooks: {
        after: {
          create: [async (ctx) => {
            // No params passed — anonymous system call
            await ctx.app.service('logs').create({ action: 'lead.created' })
          }],
        },
      },
    }))

    await request(app)
      .post('/api/leads')
      .auth(app.tokenFor('u1'))
      .send({ name: 'test' })

    expect(seenUser).toBeNull()
  })

  it('app.service() throws NotFound when service does not exist', async () => {
    const app = await createTestApp()
    await app._startForTest()

    await expect(
      app.service('nonexistent').find()
    ).rejects.toMatchObject({ code: 404 })
  })
})

// ─── 5. Client — updated method behaviour ────────────────────────────────────

describe('Client — updated method behaviour', () => {

  it('find() returns T[] (unwrapped from list envelope)', async () => {
    global.fetch = async () => new Response(
      JSON.stringify({ object: 'list', data: [{ id: 1 }, { id: 2 }], total: 2, limit: 20, offset: 0 }),
      { headers: { 'Content-Type': 'application/json' } }
    )

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    const result = await client.service('users').find()

    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(2)
  })

  it('find() with query passes $-prefixed params in URL', async () => {
    const urls: string[] = []
    global.fetch = async (input: RequestInfo) => {
      urls.push(String(input))
      return new Response(
        JSON.stringify({ object: 'list', data: [], total: 0, limit: 10, offset: 5 }),
        { headers: { 'Content-Type': 'application/json' } }
      )
    }

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    await client.service('users').find({ status: 'active' }, { limit: 10, offset: 5 })

    expect(urls[0]).toContain('status=active')
    expect(urls[0]).toContain('$limit=10')
    expect(urls[0]).toContain('$offset=5')
  })

  it('patch(query, data) sends PATCH to collection — not /id', async () => {
    const requests: { method: string; url: string }[] = []
    global.fetch = async (input: RequestInfo, init?: RequestInit) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) })
      return new Response(JSON.stringify([{ id: 1 }]), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    await client.service('users').patch({ status: 'draft' }, { status: 'active' })

    expect(requests[0].method).toBe('PATCH')
    // Collection URL — no trailing /id
    expect(requests[0].url).toMatch(/\/api\/users\?/)
    expect(requests[0].url).toContain('status=draft')
  })

  it('remove(query) sends DELETE to collection URL', async () => {
    const requests: { method: string; url: string }[] = []
    global.fetch = async (input: RequestInfo, init?: RequestInit) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) })
      return new Response(JSON.stringify(['1', '2']), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    await client.service('users').remove({ status: 'archived' })

    expect(requests[0].method).toBe('DELETE')
    expect(requests[0].url).toMatch(/\/api\/users\?/)
    expect(requests[0].url).toContain('status=archived')
  })

  it('upsert(data with id) calls patch on /id', async () => {
    const requests: { method: string; url: string }[] = []
    global.fetch = async (input: RequestInfo, init?: RequestInit) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) })
      return new Response(JSON.stringify({ id: 1, name: 'Updated' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    await client.service('users').upsert({ id: 1, name: 'Updated' })

    expect(requests[0].method).toBe('PATCH')
    expect(requests[0].url).toContain('/api/users/1')
  })

  it('upsert(data without id) calls create', async () => {
    const requests: { method: string; url: string }[] = []
    global.fetch = async (input: RequestInfo, init?: RequestInit) => {
      requests.push({ method: init?.method ?? 'GET', url: String(input) })
      return new Response(JSON.stringify({ id: 2, name: 'New' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    await client.service('users').upsert({ name: 'New' })

    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toMatch(/\/api\/users$/)
  })
})

// ─── 6. createLitestoneService custom methods ─────────────────────────────────

describe('createLitestoneService — custom methods (no actions key)', () => {

  it('custom method defined inline on createLitestoneService is callable', async () => {
    let called = false

    // Import inline to avoid circular issues in test context
    const { createLitestoneService } = await import('../core/litestone.ts')

    const svc = createLitestoneService({
      name: 'widgets',
      async activate(ctx) {
        called = true
        return { id: ctx.id, active: true }
      },
    })

    const ctx = bridge.internal('widgets', 'find', null)
    ctx.method = 'activate'
    ctx.id     = 'w-1'

    await callService(svc, ctx)
    expect(called).toBe(true)
    expect((ctx.result as Record<string, unknown>).data).toMatchObject({ active: true })
  })

  it('custom method on createLitestoneService hooks by method name', async () => {
    const order: string[] = []
    const { createLitestoneService } = await import('../core/litestone.ts')

    const svc = createLitestoneService({
      name: 'widgets',
      async activate() { order.push('method'); return { ok: true } },
      hooks: {
        before: {
          activate: [async () => { order.push('before:activate') }],
          all:      [async () => { order.push('before:all') }],
        },
        after: {
          activate: [async () => { order.push('after:activate') }],
        },
      },
    })

    const ctx = bridge.internal('widgets', 'find', null)
    ctx.method = 'activate'
    await callService(svc, ctx)
    expect(order).toEqual(['before:all', 'before:activate', 'method', 'after:activate'])
  })

  it('createLitestoneService config keys are not treated as custom methods', async () => {
    const { createLitestoneService } = await import('../core/litestone.ts')

    // None of the config keys should end up as service methods
    const svc = createLitestoneService({
      name:      'widgets',
      model:     'widget',
      idField:   'id',
      allowBulk: false,
      hooks:     {},
    }) as unknown as Record<string, unknown>

    // Config keys must not appear as callable methods
    expect(typeof svc['model']).not.toBe('function')
    expect(typeof svc['idField']).not.toBe('function')
    expect(typeof svc['allowBulk']).not.toBe('function')
    expect(typeof svc['hooks']).not.toBe('function')
  })
})

// ─── 7. Hook-bypass _ prefix methods ─────────────────────────────────────────

describe('Hook-bypass _ methods', () => {

  it('_find calls the raw method without hooks', async () => {
    const hookCalled = { value: false }

    const svc = createService({
      name: 'items',
      find: async () => [{ id: 1 }, { id: 2 }],
      hooks: {
        before: { find: [async () => { hookCalled.value = true }] },
      },
    })

    const ctx = bridge.internal('items', 'find', null)
    await svc._find(ctx)

    expect(hookCalled.value).toBe(false)
    // Raw method result — no ServiceResult envelope from pipeline
    expect(ctx.result).toBeNull()   // pipeline didn't run, result not wrapped
  })

  it('_create skips after hooks (publish, audit, cache-bust)', async () => {
    const afterCalled = { value: false }

    const svc = createService({
      name: 'items',
      create: async (ctx) => ({ id: 1, ...ctx.data }),
      hooks: {
        after: { create: [async () => { afterCalled.value = true }] },
      },
    })

    const ctx = bridge.internal('items', 'create', { name: 'test' })
    await svc._create(ctx)

    expect(afterCalled.value).toBe(false)
  })

  it('app.service()._find bypasses hooks', async () => {
    const app = await createTestApp()
    const hookCalled = { value: false }

    app.services.register(createService({
      name: 'items',
      find: async () => [{ id: 1 }],
      hooks: {
        before: { find: [async () => { hookCalled.value = true }] },
        after:  { find: [async () => { hookCalled.value = true }] },
      },
    }))

    await app._startForTest()
    await app.service('items')._find()

    expect(hookCalled.value).toBe(false)
  })

  it('app.service()._create bypasses hooks', async () => {
    const app = await createTestApp()
    let hookCalled = false

    app.services.register(createService({
      name: 'items',
      find:   async () => [],
      create: async (ctx) => ({ id: 1, ...ctx.data }),
      hooks: {
        before: { create: [async () => { hookCalled = true }] },
        after:  { create: [async () => { hookCalled = true }] },
      },
    }))

    await app._startForTest()
    await app.service('items')._create({ name: 'test' })

    expect(hookCalled).toBe(false)
  })

  it('app.service()._get bypasses hooks', async () => {
    const app = await createTestApp()
    let hookCalled = false

    app.services.register(createService({
      name: 'items',
      find: async () => [],
      get:  async (ctx) => ({ id: ctx.id }),
      hooks: {
        before: { get: [async () => { hookCalled = true }] },
      },
    }))

    await app._startForTest()
    await app.service('items')._get(1)

    expect(hookCalled).toBe(false)
  })

  it('unprefixed method still runs hooks', async () => {
    const app = await createTestApp()
    let hookCalled = false

    app.services.register(createService({
      name: 'items',
      find: async () => [],
      create: async (ctx) => ({ id: 1, ...ctx.data }),
      hooks: {
        before: { create: [async () => { hookCalled = true }] },
      },
    }))

    await request(app).post('/api/items').send({ name: 'test' })

    expect(hookCalled).toBe(true)
  })

  it('_patch bypasses hooks at service layer', async () => {
    const app = await createTestApp()
    let hookCalled = false

    app.services.register(createService({
      name: 'items',
      find:  async () => [],
      patch: async (ctx) => ({ id: ctx.id, patched: true }),
      hooks: {
        after: { patch: [async () => { hookCalled = true }] },
      },
    }))

    await app._startForTest()
    await app.service('items')._patch(1, { name: 'updated' })

    expect(hookCalled).toBe(false)
  })

  it('_remove bypasses hooks at service layer', async () => {
    const app = await createTestApp()
    let hookCalled = false

    app.services.register(createService({
      name: 'items',
      find:   async () => [],
      remove: async (ctx) => ({ id: ctx.id }),
      hooks: {
        before: { remove: [async () => { hookCalled = true }] },
      },
    }))

    await app._startForTest()
    await app.service('items')._remove(1)

    expect(hookCalled).toBe(false)
  })
})
