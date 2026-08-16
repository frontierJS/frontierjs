// tests/changes.test.ts
// Tests for changes made in the latest Junction update:
//   1. Custom methods defined directly on service (no wrapper key)
//   2. get(query) → findFirst
//   3. restore as a first-class CRUD method
//   4. ctx.app.service() for internal calls from hooks
//   5. Client: find() returns T[], get(query) routing, restore()

import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { createService, callService }        from '../src/core/service.ts'
import { createTestApp, request }            from '../src/testing/index.ts'
import { bridge }                            from '../src/transport/bridge.ts'
import { createJunctionClient }              from '../src/client/index.ts'

// This file stubs `global.fetch` in a dozen client tests and never used to put
// it back. Bun runs every test file in ONE process, so the last stub installed
// here stayed installed for every file that ran afterwards — any later test
// doing a real fetch() silently got a canned Response instead of talking to its
// own server. That is invisible in this file (its tests pass either way) and
// shows up as a nonsense failure somewhere else, which is the worst shape a
// test bug can have. Snapshot the real fetch and restore it when the file ends.
const REAL_FETCH = globalThis.fetch
afterAll(() => { globalThis.fetch = REAL_FETCH })

// ─── 1. Custom methods — no wrapper key ─────────────────────────────────────

describe('Custom methods (top-level, no wrapper key)', () => {

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

  it('custom method is routed via POST /{service}/{id} + X-Service-Method header', async () => {
    const app = await createTestApp()
    let rebooted = false

    app.services.register(createService({
      name: 'servers',
      find: async () => [],
      async reboot(ctx) { rebooted = true; return { id: ctx.id, rebooted: true } },
    }))

    // Custom methods dispatch via the X-Service-Method header, POSTed to the
    // resource URL — NOT via a path segment (/servers/srv-1/reboot).
    const res = await request(app)
      .post('/servers/srv-1')
      .set('x-service-method', 'reboot')
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

  it('GET /users?$first=true routes to get method', async () => {
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

    const res = await request(app).get('/users?$first=true')
    expect(res.status).toBe(200)
    expect(calls).toContain('findFirst')
  })

  it('GET /users/123 routes to get with id', async () => {
    const app = await createTestApp()
    let gotId: string | null = null

    app.services.register(createService({
      name: 'users',
      find: async () => [],
      async get(ctx) { gotId = String(ctx.id); return { id: ctx.id } },
    }))

    const res = await request(app).get('/users/123')
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

  it('PUT /posts/:id + X-Service-Method: restore routes to restore()', async () => {
    const app = await createTestApp()
    let restoredId: string | null = null

    app.services.register(createService({
      name: 'posts',
      find: async () => [],
      async get(ctx)     { return { id: ctx.id } },
      async restore(ctx) { restoredId = String(ctx.id); return { id: ctx.id, deletedAt: null } },
    }))

    const res = await request(app)
      .put('/posts/99')
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
      .put('/posts/1')
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
      .put('/posts/1')
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
    expect(new URL(requests[0].url).pathname).toBe('/posts/1')
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

    await request(app).post('/leads').send({ name: 'test' })
    expect(auditCalled).toBe(true)
  })

  it('app.service() with ctx.params threads user identity', async () => {
    const app = await createTestApp({ users: [{ id: 'u1', role: 'user' }] })
    let seenUserId: string | null = null

    app.services.register(createService({
      name: 'logs',
      find: async () => [],
      async create(ctx) {
        seenUserId = ctx.auth.user?.userId ?? null
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
            await ctx.app.service('logs').create({ action: 'lead.created' }, { auth: ctx.auth })
          }],
        },
      },
    }))

    await request(app)
      .post('/leads')
      .auth(app.tokenFor('u1'))
      .send({ name: 'test' })

    expect(seenUserId).toBe('u1')
  })

  it('app.service() naming no principal INHERITS the caller (FJS-D03)', async () => {
    const app = await createTestApp({ users: [{ id: 'u1', role: 'user' }] })
    let seenUser: unknown = 'not-set'

    app.services.register(createService({
      name: 'logs',
      find: async () => [],
      async create(ctx) { seenUser = ctx.auth.user; return { logged: true } },
    }))

    app.services.register(createService({
      name: 'leads',
      find: async () => [],
      async create() { return { id: '1' } },
      hooks: {
        after: {
          create: [async (ctx) => {
            // Names no principal — inherits the request's, at any depth.
            // This used to be anonymous, and the comment here called it a
            // "system call", which is the opposite thing: STRANGER(0) rather
            // than level 8. A sub-call was refused by the model's own gate
            // while reading as though it had been privileged.
            await ctx.app.service('logs').create({ action: 'lead.created' })
          }],
        },
      },
    }))

    await request(app)
      .post('/leads')
      .auth(app.tokenFor('u1'))
      .send({ name: 'test' })

    expect((seenUser as { userId?: string })?.userId).toBe('u1')
  })

  it('an explicit { user: null } is still anonymous — absent is not null', async () => {
    // The escape hatch the test above used to be. A service that deliberately
    // reads as a stranger would — checking what a public listing returns —
    // says so, and saying so still works.
    const app = await createTestApp({ users: [{ id: 'u1', role: 'user' }] })
    let seenUser: unknown = 'not-set'

    app.services.register(createService({
      name: 'logs',
      find: async () => [],
      async create(ctx) { seenUser = ctx.auth.user; return { logged: true } },
    }))

    app.services.register(createService({
      name: 'leads',
      find: async () => [],
      async create() { return { id: '1' } },
      hooks: {
        after: {
          create: [async (ctx) => {
            await ctx.app.service('logs').create({ action: 'lead.created' }, { auth: { user: null } })
          }],
        },
      },
    }))

    await request(app)
      .post('/leads')
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

  it('find() returns the list envelope, metadata intact', async () => {
    // Was: find() unwrapped to T[] and threw total/limit/offset away, so no
    // browser caller could paginate. It now returns the same shape HTTP and
    // app.service() return — a list keeps its envelope.
    global.fetch = async () => new Response(
      JSON.stringify({ kind: 'list', object: 'users', errors: [], data: [{ id: 1 }, { id: 2 }], total: 57, limit: 20, offset: 0 }),
      { headers: { 'Content-Type': 'application/json' } }
    )

    const client = createJunctionClient({ url: 'http://localhost:3000' })
    const result = await client.service('users').find()

    expect(result.kind).toBe('list')
    expect(result.data).toHaveLength(2)
    expect(result.total).toBe(57)
  })

  it('findData() is the rows-only shortcut', async () => {
    global.fetch = async () => new Response(
      JSON.stringify({ kind: 'list', object: 'users', errors: [], data: [{ id: 1 }, { id: 2 }], total: 2 }),
      { headers: { 'Content-Type': 'application/json' } }
    )
    const client = createJunctionClient({ url: 'http://localhost:3000' })
    const rows = await client.service('users').findData()

    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toHaveLength(2)
  })

  it('a legacy paginated response is not silently emptied', async () => {
    // { total, limit, skip, data } with no `kind` — an older server, or a
    // service returning a paginated shape directly. Normalised, not dropped.
    global.fetch = async () => new Response(
      JSON.stringify({ total: 9, limit: 5, skip: 5, data: [{ id: 1 }] }),
      { headers: { 'Content-Type': 'application/json' } }
    )
    const client = createJunctionClient({ url: 'http://localhost:3000' })
    const result = await client.service('users').find()

    expect(result.data).toHaveLength(1)
    expect(result.total).toBe(9)
    expect(result.offset).toBe(5)   // skip → offset
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
    expect(new URL(requests[0].url).pathname).toBe('/users')
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
    expect(new URL(requests[0].url).pathname).toBe('/users')
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
    expect(new URL(requests[0].url).pathname).toBe('/users/1')
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
    expect(new URL(requests[0].url).pathname).toBe('/users')
  })
})

// ─── 6. Custom methods on createService ──────────────────────────────────────
// (These covered createLitestoneService, which was folded into createService.
// The invariant is unchanged: custom methods live directly on the service
// object — there is no wrapper key — and config keys must never leak as
// callable methods. See SERVICE_OPTION_KEYS in core/service.ts.)

describe('createService — custom methods (no wrapper key)', () => {

  it('custom method defined inline on the definition is callable', async () => {
    let called = false

    const svc = createService({
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

  it('custom method hooks by method name', async () => {
    const order: string[] = []

    const svc = createService({
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

  it('config keys are not treated as custom methods', async () => {
    // None of the config keys should end up as service methods
    const svc = createService({
      name:      'widgets',
      model:     'widget',
      idField:   'id',
      allowBulk: false,
      hooks:     {},
    }) as unknown as Record<string, unknown>

    // Config keys must not leak as callable RPC/custom methods.
    expect(typeof svc['model']).not.toBe('function')
    expect(typeof svc['idField']).not.toBe('function')
    expect(typeof svc['allowBulk']).not.toBe('function')
    // NOTE: `hooks` is intentionally a function — every service exposes a
    // `.hooks(map)` method for runtime hook registration. That's the real
    // method, not the leaked config key, so we assert it's present and callable.
    expect(typeof svc['hooks']).toBe('function')
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

    await request(app).post('/items').send({ name: 'test' })

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
