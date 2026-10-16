// ============================================================
// Conduit ↔ Junction — Integration
//
// The plugin tests in conduit.test.ts drive a hand-rolled fake app
// (`{ _metricsSources: new Map() }`). Those verify the plugin's own
// shape and nothing about Junction: they pass unchanged even if the
// Plugin lifecycle, the App surface, or service routing changes.
//
// These boot a real Junction app and exercise the seams Conduit
// actually depends on:
//
//   • Plugin lifecycle      — register/boot/ready/shutdown are called
//   • app.conduit           — the module augmentation resolves
//   • app._metricsSources — private-field reach-in still lands
//   • app.services.register — the management service routes and runs
//   • app.hooks             — app-level auth reaches that service
// ============================================================

import { describe, it, expect } from 'bun:test'
import { createTestApp, createApp, createStubAuth, request, Forbidden, createService, callService } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'
import { conduit as conduitPlugin } from './src/plugin.ts'
import { createStaticResolver } from './src/credentials.ts'
import type { TargetDescriptor } from './src/types.ts'
import type { MirrorClaim } from './src/mirror.ts'
import { createClient } from '../litestone/src/index.js'

// `app.conduit` is fully typed here: Conduit augments Junction's AppConduit
// interface, so IConduit's members resolve without a cast. If that
// augmentation ever breaks again, these lines stop compiling.
const conduitOf = (app: { conduit?: import('./src/types.ts').IConduit }) => app.conduit!

// ─── Fixtures ────────────────────────────────────────────────

function providerTarget(overrides: Partial<TargetDescriptor> = {}): TargetDescriptor {
  return {
    id:            'provider:hetzner',
    kind:          'provider',
    protocol:      'http',
    address:       'https://api.hetzner.cloud/v1',
    auth:          { type: 'bearer', ref: 'HETZNER_TOKEN' },
    registered_at: 1_000,
    last_seen_at:  null,
    ...overrides,
  }
}

const secrets = () => createStaticResolver({ HETZNER_TOKEN: 'htz-token-abc' })

// Boots a test app with the plugin configured, through the real
// lifecycle. request() triggers _startForTest() lazily, which is what
// runs boot() — so anything asserting on init() must go through it.
async function bootApp(opts: Parameters<typeof conduitPlugin>[0] = {}) {
  const app = await createTestApp()
  app.configure(conduitPlugin({ credentials: secrets(), ...opts }))
  await app._startForTest()
  return app
}

// ─── Plugin lifecycle ────────────────────────────────────────

describe('plugin lifecycle against a real app', () => {
  it('register() attaches app.conduit at configure() time', async () => {
    const app = await createTestApp()
    expect(app.conduit).toBeUndefined()

    app.configure(conduitPlugin({ credentials: secrets() }))

    // configure() runs register() synchronously — no start() needed
    expect(app.conduit).toBeDefined()
    expect(typeof conduitOf(app).send).toBe('function')
  })

  it('boot() runs init(), so static targets are resolvable after start', async () => {
    const app = await bootApp({ targets: [providerTarget()] })

    const resolved = await conduitOf(app).resolve('provider:hetzner')
    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe('provider:hetzner')
  })

  it('a target registered before start survives boot()', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({ credentials: secrets() }))
    await conduitOf(app).register(providerTarget({ id: 'outpost:early' }))

    await app._startForTest()

    expect(await conduitOf(app).resolve('outpost:early')).not.toBeNull()
  })

  it('shutdown() destroys the conduit — later sends fail closed', async () => {
    // Drive the full lifecycle on a fresh app, the way app.stop() does, without
    // binding a port. It must be a fresh app: register() claims app.conduit via
    // app.claim(), which now refuses to overwrite an existing claim.
    const app = await createTestApp()
    const plugin = conduitPlugin({ credentials: secrets(), targets: [providerTarget()] })

    plugin.register!(app as App)
    await plugin.boot!(app as App)
    await plugin.shutdown!(app as App)

    const result = await conduitOf(app).send({ target: 'provider:hetzner', method: 'GET' })
    expect(result.error!.message).toContain('destroyed')
  })

  it('shutdown of one app does not destroy another app\'s conduit', async () => {
    // boot()/shutdown() used to close over a single factory-time instance, so
    // stopping one app tore down every app that shared the plugin object.
    const plugin = conduitPlugin({ credentials: secrets(), targets: [providerTarget()] })

    const appA = await createTestApp()
    const appB = await createTestApp()
    plugin.register!(appA as App); await plugin.boot!(appA as App)
    plugin.register!(appB as App); await plugin.boot!(appB as App)

    await plugin.shutdown!(appA as App)

    // B is untouched and still resolves its targets
    expect(await conduitOf(appB).resolve('provider:hetzner')).not.toBeNull()
  })

  it('a second plugin claiming app.conduit fails loudly instead of silently winning', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({ credentials: secrets() }))

    expect(() => app.configure(conduitPlugin({ credentials: secrets() })))
      .toThrow(/already claimed/)
  })

  it('the plugin exposes every lifecycle phase Junction calls', async () => {
    const plugin = conduitPlugin()
    // Junction invokes these as optional — a rename on either side would
    // silently skip the phase rather than error.
    for (const phase of ['register', 'boot', 'ready', 'shutdown'] as const) {
      expect(typeof plugin[phase]).toBe('function')
    }
  })
})

// ─── Metrics wiring ──────────────────────────────────────────

describe('metrics provider', () => {
  // register() reaches into app._metricsSources behind an `instanceof Map`
  // guard. If Junction renames or retypes that field the guard fails silently
  // and conduit metrics vanish with no error anywhere.
  it('lands in the real app._metricsSources map', async () => {
    const app = await bootApp({ targets: [providerTarget()] })

    expect(app._metricsSources).toBeInstanceOf(Map)
    expect(app._metricsSources.has('conduit')).toBe(true)
  })

  it('the registered provider returns the current stats shape', async () => {
    const app = await bootApp({ targets: [providerTarget()] })

    const stats = app._metricsSources.get('conduit')!() as {
      targets:  { total: number; byKind: Record<string, number> }
      requests: { total: number }
    }

    expect(stats.targets.total).toBe(1)
    expect(stats.targets.byKind.provider).toBe(1)
    expect(stats.requests.total).toBe(0)
  })

  it('stats stay in sync with runtime registration', async () => {
    const app = await bootApp()
    const read = () => (app._metricsSources.get('conduit')!() as {
      targets: { total: number }
    }).targets.total

    expect(read()).toBe(0)
    await conduitOf(app).register(providerTarget())
    expect(read()).toBe(1)
    await conduitOf(app).deregister('provider:hetzner')
    expect(read()).toBe(0)
  })
})

// ─── Management service ──────────────────────────────────────

describe('management service over real routes', () => {
  it('find() returns registered targets through the HTTP layer', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget()],
      management:  { path: 'conduit-targets', public: true },
    }))

    const res = await request(app).get('/conduit-targets')

    expect(res.status).toBe(200)
    const body = res.body as { data?: unknown[] } | unknown[]
    const rows = Array.isArray(body) ? body : (body.data ?? [])
    expect(rows).toHaveLength(1)
    expect((rows as TargetDescriptor[])[0].id).toBe('provider:hetzner')
  })

  // The whole point of moving credentials behind a resolver: this endpoint
  // used to enumerate every provider token and outpost secret in the system.
  it('never returns secret material, only refs', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget()],
      management:  { path: 'conduit-targets', public: true },
    }))

    const res = await request(app).get('/conduit-targets')

    expect(res.text).toContain('HETZNER_TOKEN')     // the ref
    expect(res.text).not.toContain('htz-token-abc') // the secret
  })

  it('get() resolves a single target by id', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget({ id: 'hetzner' })],
      management:  { path: 'conduit-targets', public: true },
    }))

    const res = await request(app).get('/conduit-targets/hetzner')

    expect(res.status).toBe(200)
    expect((res.body as TargetDescriptor).id).toBe('hetzner')
  })

  it('get() on an unknown id returns 404 through Junction error handling', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({
      credentials: secrets(),
      management:  { path: 'conduit-targets', public: true },
    }))

    const res = await request(app).get('/conduit-targets/nope')
    expect(res.status).toBe(404)
  })

  it('remove() deregisters and the target is gone from the conduit', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget({ id: 'hetzner' })],
      management:  { path: 'conduit-targets', public: true },
    }))

    const res = await request(app).delete('/conduit-targets/hetzner')

    expect(res.status).toBe(200)
    expect(await conduitOf(app).resolve('hetzner')).toBeNull()
  })

  // Junction registers service routes as `{apiPrefix}/{service}` where
  // `{service}` matches exactly one path segment. The default name used to
  // be 'conduit/targets', which registered without complaint and then 404'd
  // on every request.
  it('the default management path is reachable', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget()],
      management:  { public: true },
    }))

    const res = await request(app).get('/conduit-targets')
    expect(res.status).toBe(200)
    expect((res.body as { data?: unknown[] }).data ?? res.body).toHaveLength(1)
  })

  it('a multi-segment management path fails at configure(), not at request time', async () => {
    const app = await createTestApp()

    expect(() => app.configure(conduitPlugin({
      credentials: secrets(),
      management:  { path: 'admin/conduit' },
    }))).toThrow(/single path segment/)
  })

  // Enabling management without saying who may reach it used to serve an
  // open endpoint that enumerates every target and can deregister them.
  it('enabling management without an access decision throws at configure()', async () => {
    const app = await createTestApp()

    expect(() => app.configure(conduitPlugin({
      credentials: secrets(),
      management:  {},
    }))).toThrow(/access decision/)
  })

  it('service-level hooks passed through management protect the routes', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget()],
      management:  {
        path:  'conduit-targets',
        hooks: { before: { all: [() => { throw new Forbidden('nope') }] } },
      },
    }))

    const res = await request(app).get('/conduit-targets')

    expect(res.status).toBe(403)
    expect(res.text).not.toContain('provider:hetzner')
  })

  it('a gate grades every route on the app\'s own ladder — refused below it, answered at it', async () => {
    // isAdmin is ADMINISTRATOR(5) and isSystemAdmin SYSADMIN(7) to junction's
    // fallback grader; this app has no Data client to ask instead.
    const app = await createTestApp({ users: [
      { id: 'admin', isAdmin: true },
      { id: 'root',  isSystemAdmin: true },
    ] } as never)
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget()],
      management:  { path: 'conduit-targets', gate: 7 },
    }))

    const stranger = await request(app).get('/conduit-targets')
    const admin    = await request(app).get('/conduit-targets').auth('test-token-admin')
    const removed  = await request(app).delete('/conduit-targets/provider:hetzner').auth('test-token-admin')
    const root     = await request(app).get('/conduit-targets').auth('test-token-root')

    expect(stranger.status).toBe(401)
    expect(admin.status).toBe(403)
    expect(removed.status).toBe(403)
    expect((await conduitOf(app).list()).map(t => t.id)).toContain('provider:hetzner')
    expect(root.status).toBe(200)
    expect(root.text).toContain('provider:hetzner')
  })

  it('is not registered when management is omitted', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({ credentials: secrets() }))
    await app._startForTest()

    expect(app.services.get('conduit-targets')).toBeUndefined()
  })
})

// ─── App-level auth reaches the management service ───────────

describe('app-level hooks apply to the management service', () => {
  // The service declares no hooks of its own. The claim that an app with
  // global auth is covered depends entirely on Junction merging app-level
  // hooks into every service pipeline — assert it rather than assume it.
  it('a global before-hook can reject the management routes', async () => {
    const app = await createTestApp({
      hooks: {
        before: { all: [() => { throw new Forbidden('nope') }] }
      }
    })
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget()],
      management:  { path: 'conduit-targets', public: true },
    }))

    const res = await request(app).get('/conduit-targets')

    expect(res.status).toBe(403)
    expect(res.text).not.toContain('provider:hetzner')
  })

  // The flip side, stated plainly: with no auth installed the routes are open.
  it('without any auth hook the routes are public', async () => {
    const app = await createTestApp()
    app.configure(conduitPlugin({
      credentials: secrets(),
      targets:     [providerTarget()],
      management:  { path: 'conduit-targets', public: true },
    }))

    const res = await request(app).get('/conduit-targets')
    expect(res.status).toBe(200)
  })
})

// ─── Trace propagation ───────────────────────────────────────
// `createTraceContext` shipped with nobody wiring it: an inbound request
// stating both a correlation id and a `traceparent` produced an outbound call
// carrying neither, so a target's logs could not be joined to the request that
// caused them (`FJS-742`). Every assertion here is about what really left the
// process, read off a listening server rather than off the request object.

function headerRecorder() {
  const seen: Record<string, string>[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const headers: Record<string, string> = {}
      req.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
      seen.push(headers)
      return Response.json({ ok: true })
    },
  })
  return { seen, url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

async function appCalling(rec: { url: string }, opts: Record<string, unknown> = {}, calls = 1) {
  const app = await createTestApp()
  app.configure(conduitPlugin({
    ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'traced')),
    targets: [providerTarget({ id: 'provider:x', address: rec.url, auth: { type: 'none' }, trace: opts.traced !== false })],
  }))
  app.get('/go', async () => {
    for (let i = 0; i < calls; i++) {
      await conduitOf(app as never).send({ target: 'provider:x', method: 'GET', path: '/ping' })
    }
    return new Response('ok')
  })
  await app._startForTest()
  return app
}

describe('an outbound call carries the request that caused it', () => {
  // The id reaching a third party is the join from its log of the query to the
  // audit row naming who typed it (`FJS-1413`, `FJS-D507`).
  it('a target that did not declare trace: true gets neither header', async () => {
    const rec = headerRecorder()
    try {
      const app = await appCalling(rec, { traced: false })
      await request(app).get('/go')
        .set('x-request-id', 'req-abc-123')
        .set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')

      expect(rec.seen[0]!['x-request-id']).toBeUndefined()
      expect(rec.seen[0]!.traceparent).toBeUndefined()
    } finally {
      rec.stop()
    }
  })

  it('continues an upstream trace rather than starting a new one', async () => {
    const rec = headerRecorder()
    try {
      const app = await appCalling(rec)
      await request(app).get('/go')
        .set('x-request-id', 'req-abc-123')
        .set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')

      const sent = rec.seen[0]!
      // Same trace, new span — the target's work hangs off ours rather than
      // being the root of something unrelated.
      expect(sent.traceparent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/)
      expect(sent.traceparent).not.toContain('00f067aa0ba902b7')
      // One id for the request (`FJS-D660`): the trace id won over the
      // caller's x-request-id, and it is what junction's log line and trail
      // row carry — so a log search and the vendor's trace find each other.
      expect(sent['x-request-id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    } finally {
      rec.stop()
    }
  })

  // The measured failure: a traceparent and no x-request-id. The outbound call
  // continued the trace while junction filed the request under a fresh UUID.
  it('names the inbound trace id outbound when the caller stated only a traceparent', async () => {
    const rec = headerRecorder()
    try {
      const app = await appCalling(rec)
      await request(app).get('/go')
        .set('traceparent', '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')

      const sent = rec.seen[0]!
      expect(sent.traceparent!.split('-')[1]).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
      expect(sent['x-request-id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736')
    } finally {
      rec.stop()
    }
  })

  it('gives every call in one request the same trace when nobody sent one', async () => {
    const rec = headerRecorder()
    try {
      const app = await appCalling(rec, {}, 2)
      await request(app).get('/go')

      const [a, b] = rec.seen as [Record<string, string>, Record<string, string>]
      const trace = (h: Record<string, string>) => h.traceparent!.split('-')[1]
      const span  = (h: Record<string, string>) => h.traceparent!.split('-')[2]

      // The assertion the derivation exists for: two calls, one request, one
      // trace. A random trace id per call would make these two unrelated.
      expect(trace(a)).toBe(trace(b)!)
      expect(span(a)).not.toBe(span(b))
      // Junction minted the correlation id, and it is what the trace is
      // derived from — so the header and the trace id name the same request.
      expect(a['x-request-id']).toBe(b['x-request-id']!)
      expect(trace(a)).toBe(a['x-request-id']!.replace(/-/g, ''))
    } finally {
      rec.stop()
    }
  })

  it('lets the app replace it, and turn it off', async () => {
    const rec = headerRecorder()
    try {
      const own = await appCalling(rec, { trace: () => ({ 'x-my-trace': 'mine' }) })
      await request(own).get('/go')
      expect(rec.seen[0]!['x-my-trace']).toBe('mine')
      // The default is under the caller's, so replacing it really replaces it.
      expect(rec.seen[0]!.traceparent).toBeUndefined()

      const off = await appCalling(rec, { trace: () => null })
      await request(off).get('/go')
      expect(rec.seen[1]!.traceparent).toBeUndefined()
      expect(rec.seen[1]!['x-request-id']).toBeUndefined()
    } finally {
      rec.stop()
    }
  })

  it('traces a call made outside any request', async () => {
    const rec = headerRecorder()
    try {
      const app = await appCalling(rec)
      // A job, a script, boot: there is no inbound request to hang off, so a
      // fresh trace is the right answer rather than a missing one.
      await conduitOf(app as never).send({ target: 'provider:x', method: 'GET', path: '/ping' })
      expect(rec.seen[0]!.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    } finally {
      rec.stop()
    }
  })
})

// ─── Broker health ───────────────────────────────────────────

describe('broker subscription health', () => {
  it('reaches the app health check, which reads down while the broker is unreachable', async () => {
    const app = await bootApp()
    await conduitOf(app).register({
      id: 'broker:orders', kind: 'broker', protocol: 'websocket',
      address: 'ws://127.0.0.1:1/', auth: { type: 'none' },
      registered_at: 1_000, last_seen_at: null,
    })
    await conduitOf(app).subscribe('broker:orders', () => {})

    const check = (app as unknown as { _readiness: Map<string, () => boolean> })._readiness.get('conduit:broker:orders')
    expect(check).toBeDefined()
    expect(check!()).toBe(false)
  })
})

// FJS-D1127: a receiver on a broker target is fed by the socket conduit
// dialed, which was its verification. A route for it would take a frame from
// anyone, verified by nothing.
describe('a receiver that names a broker target', () => {
  it('subscribes and mounts no route', async () => {
    const broker = Bun.serve({ port: 0, fetch(req, s) { return s.upgrade(req) ? undefined : new Response('no', { status: 400 }) }, websocket: { message() {} } })
    const app = await bootApp()
    const c = conduitOf(app)
    await c.register({ id: 'broker:x', kind: 'broker', protocol: 'websocket', address: `ws://127.0.0.1:${broker.port}/`, auth: { type: 'none' }, registered_at: 1_000, last_seen_at: null })
    const landed: unknown[] = []
    await c.receive({
      provider: 'x', target: 'broker:x',
      dialect: { parse: m => ({ id: m.id, type: 't', payload: m.body }), dedupeKey: m => m.id },
      apply(ev) { landed.push(ev); return 'applied' },
    })
    expect(c.stats().subscriptions['broker:x']!.connected).toBe(true)
    expect((await request(app).post('/broker:x').send({ id: 'f', type: 'message', body: 1 })).status).toBe(404)
    expect((await request(app).post('/x').send({})).status).toBe(404)
    expect(landed).toEqual([])
    await c.destroy()
    broker.stop(true)
  })

  // A Provider that redelivers nothing lost what it sent while the socket was
  // down; the backfill starts at opened(), so it must fire on the redial and
  // ahead of the new connection's first frame.
  it('calls opened on every believed connection, ahead of that connection\'s first frame', async () => {
    let dials = 0
    const broker = Bun.serve({
      port: 0,
      fetch(req, s) { return s.upgrade(req) ? undefined : new Response('no', { status: 400 }) },
      websocket: {
        open(ws) {
          const n = ++dials
          ws.send(JSON.stringify({ id: `f${n}`, type: 'message', body: n }))
          if (n === 1) setTimeout(() => ws.close(), 20)
        },
        message() {},
      },
    })
    const app = await bootApp()
    const c = conduitOf(app)
    await c.register({ id: 'broker:x', kind: 'broker', protocol: 'websocket', address: `ws://127.0.0.1:${broker.port}/`, auth: { type: 'none' }, registered_at: 1_000, last_seen_at: null })
    const order: string[] = []
    await c.receive({
      provider: 'x', target: 'broker:x',
      dialect: { parse: m => ({ id: m.id, type: 't', payload: m.body }), dedupeKey: m => m.id },
      opened() { order.push('opened') },
      apply(ev) { order.push(String(ev.id)); return 'applied' },
    })
    const until = Date.now() + 3_000
    while (order.length < 4 && Date.now() < until) await new Promise(r => setTimeout(r, 25))
    expect(order).toEqual(['opened', 'f1', 'opened', 'f2'])
    await c.destroy()
    broker.stop(true)
  })

  it('frees the target on deregister, so the same id can be registered and received again', async () => {
    const broker = Bun.serve({ port: 0, fetch(req, s) { return s.upgrade(req) ? undefined : new Response('no', { status: 400 }) }, websocket: { message() {} } })
    const app = await bootApp()
    const c = conduitOf(app)
    const target = { id: 'broker:x', kind: 'broker', protocol: 'websocket', address: `ws://127.0.0.1:${broker.port}/`, auth: { type: 'none' }, registered_at: 1_000, last_seen_at: null } as TargetDescriptor
    const receiver = {
      provider: 'x', target: 'broker:x',
      dialect: { parse: (m: { id: string; body: unknown }) => ({ id: m.id, type: 't', payload: m.body }), dedupeKey: (m: { id: string }) => m.id },
      apply: () => 'applied' as const,
    }
    await c.register(target)
    await c.receive(receiver)
    await c.deregister('broker:x')
    await c.register(target)
    await c.receive(receiver)
    expect(c.stats().subscriptions['broker:x']!.connected).toBe(true)
    await c.destroy()
    broker.stop(true)
  })
})

// FJS-2070: an afterCommit effect is at-most-once, so a send from one warns in
// development and names ctx.enqueue, the durable spelling.
describe('app.conduit.send() inside an afterCommit drain', () => {
  it('warns once per call site, and not outside the drain', async () => {
    const app = await bootApp({ targets: [] })
    const svc = app.services.register(createService({
      name: 'pings',
      async create() { return { ok: true } },
      hooks: { after: { create: [(c: any) => {
        c.afterCommit(() => conduitOf(app).send({ target: 'nowhere', method: 'GET', path: '/' } as never))
      }] } },
    } as never))
    const logged: string[] = []
    const real = console.warn
    console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(' ')) }
    try {
      await conduitOf(app).send({ target: 'nowhere', method: 'GET', path: '/' } as never)
      expect(logged).toEqual([])
      const ctx = () => ({ service: 'pings', method: 'create', data: {}, query: {}, auth: { user: null },
        caller: {}, route: {}, locals: {}, app, result: null, type: 'before' }) as never
      await (callService as any)(svc, ctx())
      await (callService as any)(svc, ctx())
    } finally { console.warn = real }
    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain('app.conduit.send()')
    expect(logged[0]).toContain('ctx.enqueue')
  })
})

// ─── A mirror claim (`FJS-D1125`) ────────────────────────────

// A Provider holding posts, which answers only a caller's own token: the
// forward must spend the per-caller target as the user making the request.
function acmeProvider() {
  const posts = new Map<string, { id: string; channel: string; text: string }>()
  const seen: Array<{ method: string; path: string; auth: string | null }> = []
  const bodies: unknown[] = []
  let n = 0
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const auth = req.headers.get('authorization')
      seen.push({ method: req.method, path: url.pathname, auth })
      if (!auth?.startsWith('Bearer tok-')) return Response.json({ message: 'no token' }, { status: 401 })
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await req.json() as { channel?: string; text?: string }
      if (body) bodies.push(body)
      if (req.method === 'POST' && url.pathname === '/posts') {
        if (body!.text === 'refuse me') return Response.json({ message: 'text is not allowed' }, { status: 400 })
        const post = { id: `p${++n}`, channel: body!.channel!, text: body!.text! }
        posts.set(post.id, post)
        return Response.json(post, { status: 201 })
      }
      const id = url.pathname.match(/^\/posts\/(\w+)$/)?.[1]
      const post = id ? posts.get(id) : undefined
      if (!post) return Response.json({ message: 'not found' }, { status: 404 })
      if (req.method === 'PATCH') { post.text = body!.text!; return Response.json(post) }
      if (req.method === 'DELETE') { posts.delete(post.id); return Response.json({ status: 'OK' }) }
      return Response.json(post)
    },
  })
  return { server, posts, seen, bodies }
}

const acmeClaim = (): MirrorClaim => ({
  provider: 'acme',
  models: {
    Post: {
      key: 'externalId', target: 'provider:acme:user',
      parse: (p: { id?: string; channel: string; text: string }) =>
        p?.id ? { externalId: p.id, channelExternalId: p.channel, message: p.text } : null,
      // `pendingId` is the claim's input and no column of Post's: the payload
      // is the claim's, so a row validator in front of it would strip it.
      create: (i: { channelExternalId: string; message: string; pendingId?: string }) => {
        if (!i.message) throw new TypeError('message is required')
        return { method: 'POST', path: '/posts', body: { channel: i.channelExternalId, text: i.message, ...(i.pendingId ? { pending: i.pendingId } : {}) } }
      },
      update: (id: string, p: { message: string }) => ({ method: 'PATCH', path: `/posts/${id}`, body: { text: p.message } }),
      delete: (id: string) => ({ method: 'DELETE', path: `/posts/${id}` }),
    },
  },
})

const MIRROR_SCHEMA = `
model Post {
  id                Int     @id
  externalId        String
  channelExternalId String
  message           String
  starred           Boolean @default(false) @local
  @@mirror(key: externalId)
}
model Note {
  id         Int    @id
  externalId String @unique
  body       String
}`

async function mirrorApp(opts: { claim?: MirrorClaim | null; schema?: string } = {}) {
  const acme = acmeProvider()
  const db = await createClient({ db: ':memory:', schema: opts.schema ?? MIRROR_SCHEMA })
  const app = createApp({ db, auth: createStubAuth({ users: [{ id: 'u1', role: 'member' }, { id: 'u2', role: 'member' }] }) } as never)
  app.configure(conduitPlugin({
    credentials: { get: async () => null, getFor: async (_ref: string, who: { principal: string | null }) => who.principal ? `tok-${who.principal}` : null } as never,
    targets: [{
      id: 'provider:acme:user', kind: 'provider', protocol: 'http', address: `http://127.0.0.1:${acme.server.port}`,
      auth: { type: 'bearer', ref: 'ACME', per_caller: true },
      registered_at: 1_000, last_seen_at: null,
    } as TargetDescriptor],
  }))
  app.services.register(createService({ name: 'posts', model: 'Post' }))
  app.services.register(createService({ name: 'notes', model: 'Note' }))
  if (opts.claim !== null) conduitOf(app).mirror(opts.claim ?? acmeClaim())
  return { app, db, acme }
}

describe('a claimed mirror model forwards its generated writes', () => {
  it('creates at the Provider as the caller, then lands the answered row by its key', async () => {
    const { app, db, acme } = await mirrorApp()
    try {
      await app._startForTest()
      const res = await request(app).post('/posts').auth('test-token-u1').send({ channelExternalId: 'c1', message: 'hello', pendingId: 'k1' })
      expect(res.status).toBe(201)
      expect(res.body).toMatchObject({ externalId: 'p1', channelExternalId: 'c1', message: 'hello' })
      expect(acme.seen).toEqual([{ method: 'POST', path: '/posts', auth: 'Bearer tok-u1' }])
      expect(acme.bodies).toEqual([{ channel: 'c1', text: 'hello', pending: 'k1' }])
      expect(await (db as any).asSystem().post.findMany()).toEqual([{ id: 1, externalId: 'p1', channelExternalId: 'c1', message: 'hello', starred: false, missingSince: null }])
    } finally { acme.server.stop(true) }
  })

  it('patches and removes through the row the caller names, keyed by the Provider id', async () => {
    const { app, db, acme } = await mirrorApp()
    try {
      await app._startForTest()
      const made = await request(app).post('/posts').auth('test-token-u2').send({ channelExternalId: 'c1', message: 'first' })
      const id = (made.body as { id: number }).id
      // `starred` is the app's own column: the Provider never sees it, and it
      // is written here beside the row the Provider answered.
      const edited = await request(app).patch(`/posts/${id}`).auth('test-token-u2').send({ message: 'edited', starred: true })
      expect(edited.status).toBe(200)
      expect(edited.body).toMatchObject({ id, externalId: 'p1', message: 'edited', starred: true })
      expect(acme.posts.get('p1')!.text).toBe('edited')
      expect(acme.bodies.at(-1)).toEqual({ text: 'edited' })
      const gone = await request(app).delete(`/posts/${id}`).auth('test-token-u2')
      expect(gone.status).toBe(200)
      expect(acme.posts.has('p1')).toBe(false)
      expect(await (db as any).asSystem().post.findMany()).toEqual([])
      expect(acme.seen.map(s => `${s.method} ${s.path} ${s.auth}`)).toEqual([
        'POST /posts Bearer tok-u2', 'PATCH /posts/p1 Bearer tok-u2', 'DELETE /posts/p1 Bearer tok-u2'])
    } finally { acme.server.stop(true) }
  })

  it('answers the Provider\'s refusal and lands nothing', async () => {
    const { app, db, acme } = await mirrorApp()
    try {
      await app._startForTest()
      const refused = await request(app).post('/posts').auth('test-token-u1').send({ channelExternalId: 'c1', message: 'refuse me' })
      expect(refused.status).toBe(422)
      const unbuilt = await request(app).post('/posts').auth('test-token-u1').send({ channelExternalId: 'c1', message: '' })
      expect(unbuilt.status).toBe(400)
      expect((unbuilt.body as { message: string }).message).toContain('message is required')
      expect(acme.seen).toHaveLength(1)
      expect(await (db as any).asSystem().post.findMany()).toEqual([])
    } finally { acme.server.stop(true) }
  })

  it('refuses a bulk write by name, before anything is sent', async () => {
    const { app, acme } = await mirrorApp()
    try {
      await app._startForTest()
      const bulk = await request(app).post('/posts').auth('test-token-u1').send([{ channelExternalId: 'c1', message: 'a' }])
      expect(bulk.status).toBe(400)
      expect((bulk.body as { message: string }).message).toContain('mirrored from acme')
      expect(acme.seen).toEqual([])
    } finally { acme.server.stop(true) }
  })

  it('leaves an unclaimed mirror to the generated verb, which refuses the Provider\'s columns', async () => {
    const { app, db, acme } = await mirrorApp({ claim: null })
    try {
      await app._startForTest()
      const res = await request(app).post('/posts').auth('test-token-u1').send({ channelExternalId: 'c1', message: 'hello' })
      expect(res.status).toBe(403)
      expect((res.body as { message: string }).message).toContain('"channelExternalId", "message" are @system')
      expect(acme.seen).toEqual([])
      expect(await (db as any).asSystem().post.findMany()).toEqual([])
    } finally { acme.server.stop(true) }
  })
})

describe('boot refuses a claim the schema does not back', () => {
  const claimOn = (model: string, key = 'externalId'): MirrorClaim => {
    const c = acmeClaim()
    return { provider: 'acme', models: { [model]: { ...c.models.Post!, key } } }
  }

  for (const [why, claim, says] of [
    ['a model the schema lacks', claimOn('Thread'), 'the schema has no model Thread'],
    ['a model that is not @@mirror', claimOn('Note'), 'Note is not @@mirror'],
    ['a key the schema does not name', claimOn('Post', 'providerId'), "keyed by 'providerId', and Post declares @@mirror(key: externalId)"],
  ] as const) {
    it(why, async () => {
      const { app, acme } = await mirrorApp({ claim })
      try {
        await expect(app._startForTest()).rejects.toThrow(says)
      } finally { acme.server.stop(true) }
    })
  }

  it('a second claim on one model, as it is made', async () => {
    const { app, acme } = await mirrorApp()
    try {
      expect(() => conduitOf(app).mirror({ ...acmeClaim(), provider: 'other' })).toThrow("Post is already claimed by 'acme'")
    } finally { acme.server.stop(true) }
  })

  it('a claim made after start, before it is held', async () => {
    const { app, acme } = await mirrorApp({ claim: null })
    try {
      await app._startForTest()
      expect(() => conduitOf(app).mirror(claimOn('Note'))).toThrow('Note is not @@mirror')
      expect(conduitOf(app).claimed()).toEqual([])
    } finally { acme.server.stop(true) }
  })
})
