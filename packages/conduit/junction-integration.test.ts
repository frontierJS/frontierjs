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
import { createTestApp, request, Forbidden } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'
import { conduit as conduitPlugin } from './src/plugin.ts'
import { createStaticResolver } from './src/credentials.ts'
import type { TargetDescriptor } from './src/types.ts'

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
