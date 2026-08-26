// tests/devtools-observability.test.ts
//
// Two answers, one owner each.
//
// /metrics and the devtools console both describe a running app, and devtools
// hand-built its own version of the answer — so a plugin that contributed a
// section through `registerMetricsSource` appeared at /metrics and was absent
// from the console, whose renderer has looped over plugin sections since it was
// written and had never had one to draw (`FJS-414`). Both now call
// `collectMetrics`, and the assertion that keeps them together is field
// equality between the two surfaces rather than a restatement of either.
//
// The readiness half is new rather than repaired: `checks` was an option on
// healthPlugin(), so only the app author could declare one and a plugin owning
// the resource that fails had no way to say so.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp, createService, healthPlugin, devtools, defaultConfig } from '../index.ts'

const PORT   = 3387
const DVPORT = 3388
let app: any

const state   = async () => (await fetch(`http://localhost:${DVPORT}/api/state`)).json()
const health  = async () => fetch(`http://localhost:${DVPORT}/api/health`)
const metrics = async () => (await fetch(`http://localhost:${PORT}/metrics`)).json()

let dbUp = true

beforeAll(async () => {
  app = createApp({
    config: {
      port: PORT,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 200 },
    },
  })
  app.configure(healthPlugin({ checks: { declared: () => true } }))
  app.configure(devtools({ port: DVPORT }))
  app.services.register(createService({ name: 'things', async find() { return [] } }))

  // A plugin contributing to both seams, which is the shape this file is about.
  app.registerMetricsSource('widgets', () => ({ pending: 3, spun: 41 }))
  app.registerHealthCheck('widgets', () => dbUp)

  await app.start()
})

afterAll(async () => { await app?.stop() })

describe('metrics have one owner', () => {
  it('carries a plugin section at /metrics', async () => {
    expect((await metrics()).widgets).toEqual({ pending: 3, spun: 41 })
  })

  it('carries the same plugin section in the devtools console', async () => {
    // The regression: this key was unreachable from devtools for its whole life.
    expect((await state()).metrics.widgets).toEqual({ pending: 3, spun: 41 })
  })

  it('answers the same shape on both surfaces', async () => {
    const [m, s] = [await metrics(), (await state()).metrics]
    // uptime/ts move between two reads; everything else is one function's output.
    expect(Object.keys(s).sort()).toEqual(Object.keys(m).sort())
    expect(s.services).toEqual(m.services)
    expect(s.app).toBe(m.app)
  })

  it('survives a source that throws — one bad plugin is not an outage', async () => {
    app.registerMetricsSource('broken', () => { throw new Error('nope') })
    const m = await metrics()
    expect(m.broken).toBeUndefined()
    expect(m.widgets).toEqual({ pending: 3, spun: 41 })
    app._metricsSources.delete('broken')
  })
})

describe('readiness takes checks from plugins', () => {
  it('reports a registered check by name', async () => {
    const body = await (await fetch(`http://localhost:${PORT}/health`)).json()
    expect(body.checks.widgets.status).toBe('ok')
    expect(body.status).toBe('ok')
  })

  it('fails the whole probe when a registered check says no', async () => {
    dbUp = false
    const res  = await fetch(`http://localhost:${PORT}/health`)
    const body = await res.json()
    expect(body.checks.widgets.status).toBe('fail')
    expect(body.status).toBe('degraded')
    expect(res.status).toBe(503)   // a load balancer must be able to act on it
    dbUp = true
  })

  it('reports a throwing check as failed, carrying its message', async () => {
    app.registerHealthCheck('angry', () => { throw new Error('disk full') })
    const body = await (await fetch(`http://localhost:${PORT}/health`)).json()
    expect(body.checks.angry.status).toBe('fail')
    expect(body.checks.angry.error).toBe('disk full')
    app._healthChecks.delete('angry')
  })

  it('lets an app-declared check win the name', async () => {
    // App-declared checks are applied last on purpose: the plugin registered
    // its probe without knowing what the app knows about the same resource.
    const solo = createApp({
      config: {
        port: PORT + 40,
        database: { url: '', log: false },
        services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 200 },
      },
    })
    solo.configure(healthPlugin({ checks: { widgets: () => false } }))
    solo.registerHealthCheck('widgets', () => true)
    await solo.start()
    try {
      const body = await (await fetch(`http://localhost:${PORT + 40}/health`)).json()
      expect(body.checks.widgets.status).toBe('fail')
    } finally { await solo.stop() }
  })

  it('answers the same set on both surfaces', async () => {
    // The console reads readiness on its own port, and `checks` used to live in
    // healthPlugin's closure where nothing else could see it — so an app that
    // declared its own database probe had it graded at /health and silently
    // missing from the console. Two surfaces, one question.
    const [route, console_] = [
      await (await fetch(`http://localhost:${PORT}/health`)).json(),
      await (await health()).json(),
    ]
    expect(Object.keys(console_.checks).sort()).toEqual(Object.keys(route.checks).sort())
    expect(console_.checks.declared.status).toBe('ok')
    expect(console_.checks.widgets.status).toBe('ok')
  })
})

describe('the banner says where the console is', () => {
  it('names the URL when it is up', () => {
    expect(app._devtools).toEqual({ status: 'on', url: `http://localhost:${DVPORT}` })
  })

  it('says off for an app that never configured it', async () => {
    // The case this exists for: an app with the console switched off used to be
    // indistinguishable at boot from one whose console had refused to bind.
    const bare = createApp({
      config: {
        port: PORT + 41,
        database: { url: '', log: false },
        services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 200 },
      },
    })
    await bare.start()
    try { expect(bare._devtools.status).toBe('off') } finally { await bare.stop() }
  })

  it('says refused, with the reason, when production has no auth gate', async () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const locked = createApp({
      config: {
        port: PORT + 42,
        database: { url: '', log: false },
        services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 200 },
      },
    })
    locked.configure(devtools({ port: PORT + 43 }))
    await locked.start()
    try {
      expect(locked._devtools.status).toBe('refused')
      expect(locked._devtools.reason).toMatch(/auth/)
    } finally {
      await locked.stop()
      process.env.NODE_ENV = prev
    }
  })

  it('reports the port it actually bound, not the one it was asked for', async () => {
    // port: 0 is how a parallel suite avoids a collision — Bun assigns a real
    // one, and a banner echoing the request would advertise ":0".
    const dyn = createApp({
      config: {
        port: PORT + 44,
        database: { url: '', log: false },
        services: { dir: '/nonexistent' },
        http: { ...defaultConfig.http, drainTimeout: 200 },
      },
    })
    dyn.configure(devtools({ port: 0 }))
    await dyn.start()
    try {
      expect(dyn._devtools.url).not.toContain(':0')
      expect(dyn._devtools.url).toMatch(/^http:\/\/localhost:\d+$/)
    } finally { await dyn.stop() }
  })
})

describe('the jobs surface', () => {
  it('says so plainly when no queue is installed', async () => {
    const res = await fetch(`http://localhost:${DVPORT}/api/jobs`)
    expect(res.status).toBe(501)
    expect((await res.json()).error).toMatch(/no job queue/i)
  })
})
