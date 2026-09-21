// health-probes.test.ts
//
// `batteries-8`. Three things were measured wrong before any of this changed
// (`FJS-899`): one readiness check that never settled meant `/health` never
// answered at all, checks ran sequentially so a probe's latency was the SUM of
// them, and there was ONE endpoint — so a third-party dependency going down
// answered 503 to a livenessProbe and restarted every replica of an app that
// was working.
//
// Every refusal below is paired with the case one step away that must still
// pass (`FJS-351`): a bounded check beside a hung one, `live` beside `ready`,
// a scraper beside a browser. A bound that failed everything and a split that
// answered 503 on both paths would each satisfy a test that only asked about
// the failing side.

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, healthPlugin, defaultConfig } from '../index.ts'
import { renderPrometheus, wantsPrometheus, collectHealth, type MetricsResponse } from '../src/transport/health.ts'

const PORT = 3931
const url  = (p: string) => `http://localhost:${PORT}${p}`

let app: ReturnType<typeof createApp>
let dependencyUp = true

beforeAll(async () => {
  app = createApp({
    config: {
      port: PORT,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 200 },
    },
  })
  app.configure(healthPlugin({
    checkTimeout: 300,
    checks: {
      // The pair: one that answers inside the bound, one that never answers.
      quick:     async () => { await new Promise(r => setTimeout(r, 20)); return true },
      hangs:     () => new Promise<boolean>(() => {}),
      throwsSync: () => { throw new Error('sync boom') },
      dependency: () => dependencyUp,
    },
  }))
  await app.start()
})

afterAll(async () => { await app?.stop() })

describe('a readiness check is bounded', () => {

  it('a check that never settles is a failed row naming itself, not a probe that never answers', async () => {
    const t   = Date.now()
    const res = await fetch(url('/health'))
    const ms  = Date.now() - t
    const body = await res.json() as { checks: Record<string, { status: string; error?: string }> }

    expect(res.status).toBe(503)
    expect(body.checks.hangs.status).toBe('fail')
    expect(body.checks.hangs.error).toContain('timed out after 300ms')
    // The bound is what makes the endpoint answer at all.
    expect(ms).toBeLessThan(2000)
  })

  it('a check that answers inside the bound still passes', async () => {
    const body = await (await fetch(url('/health'))).json() as { checks: Record<string, { status: string }> }
    expect(body.checks.quick.status).toBe('ok')
  })

  it('a check that throws SYNCHRONOUSLY is one failed row, not a 500 for the endpoint', async () => {
    // Calling fn() directly rather than through Promise.resolve().then(fn)
    // lets a sync throw escape the per-check promise and reject the whole
    // collection, which is a 500 saying nothing about which check it was.
    const body = await (await fetch(url('/health'))).json() as { checks: Record<string, { status: string; error?: string }> }
    expect(body.checks.throwsSync.status).toBe('fail')
    expect(body.checks.throwsSync.error).toBe('sync boom')
    // Named beside the others rather than replacing the whole answer.
    expect(body.checks.quick.status).toBe('ok')
  })

  it('checks run concurrently, so a probe is not the SUM of them', async () => {
    // A stub rather than the app above: that one declares `hangs`, whose
    // timeout would dominate the measurement and hide what is being asked.
    const slow = new Map(Array.from({ length: 5 }, (_, i) =>
      [`slow${i}`, async () => { await new Promise(r => setTimeout(r, 150)); return true }] as const))
    const stub = { _healthChecks: new Map(), _healthChecksApp: slow, config: { name: 's', version: '1' } }

    const t    = Date.now()
    const body = await collectHealth(stub as unknown as Parameters<typeof collectHealth>[0], t, { checkTimeout: 2000 })
    const ms   = Date.now() - t

    for (const n of slow.keys()) expect(body.checks[n].status).toBe('ok')
    // Sequentially this is 5 x 150 = 750ms.
    expect(ms).toBeLessThan(500)
  })
})

describe('liveness and readiness are different questions', () => {

  it('a failing dependency stops TRAFFIC and does not restart the process', async () => {
    dependencyUp = false
    const ready = await fetch(url('/health/ready'))
    const live  = await fetch(url('/health/live'))
    dependencyUp = true

    expect(ready.status).toBe(503)
    expect(live.status).toBe(200)
  })

  it('liveness consults nothing, so a hung dependency cannot hang it', async () => {
    const t   = Date.now()
    const res = await fetch(url('/health/live'))
    const body = await res.json() as { status: string; checks: Record<string, unknown> }

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.checks).toEqual({})
    // `hangs` would otherwise put the check timeout on this path too.
    expect(Date.now() - t).toBeLessThan(200)
  })

  it('/health is still readiness — the split adds paths and moves none', async () => {
    const a = await fetch(url('/health'))
    const b = await fetch(url('/health/ready'))
    expect(a.status).toBe(b.status)
    expect(a.status).toBe(503)     // `hangs` is still declared
  })

  it('a DRAINING process is not ready and is still alive', async () => {
    // Killing a draining process destroys the in-flight requests the drain
    // exists to finish, so `live` must not follow `ready` down here.
    ;(app as unknown as { draining: boolean }).draining = true
    const ready = await fetch(url('/health'))
    const live  = await fetch(url('/health/live'))
    const body  = await ready.json() as { status: string }
    ;(app as unknown as { draining: boolean }).draining = false

    expect(ready.status).toBe(503)
    expect(body.status).toBe('draining')
    expect(ready.headers.get('connection')).toBe('close')
    expect(live.status).toBe(200)
  })
})

describe('an app-declared check still wins its name', () => {

  it('replaces a plugin check of the same name without moving in the answer', async () => {
    app.registerHealthCheck('shared', () => true)
    app._healthChecksApp.set('shared', () => false)
    app.registerHealthCheck('after', () => true)

    const body = await collectHealth(app, Date.now(), { checkTimeout: 500 })
    const names = Object.keys(body.checks)

    expect(body.checks.shared.status).toBe('fail')          // the app's answer
    expect(names.indexOf('shared')).toBeLessThan(names.indexOf('after'))

    app._healthChecks.delete('shared'); app._healthChecks.delete('after')
    app._healthChecksApp.delete('shared')
  })
})

describe('/metrics answers a scraper in the format the path implies', () => {

  const SCRAPER = 'application/openmetrics-text;version=1.0.0,text/plain;version=0.0.4;q=0.5,*/*;q=0.1'
  const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

  it('a Prometheus Accept gets exposition text', async () => {
    const res  = await fetch(url('/metrics'), { headers: { accept: SCRAPER } })
    const body = await res.text()
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(body).toMatch(/^junction_uptime \d+$/m)
    expect(body).toMatch(/^junction_process_memory_mb [\d.]+$/m)
  })

  it('every other caller still gets the JSON the console is written against', async () => {
    for (const accept of [BROWSER, '*/*', undefined]) {
      const res = await fetch(url('/metrics'), { headers: accept ? { accept } : {} })
      expect(res.headers.get('content-type')).toContain('application/json')
      expect((await res.json() as { app: string }).app).toBeDefined()
    }
  })

  it('wantsPrometheus tells a scraper from a browser', () => {
    expect(wantsPrometheus(SCRAPER)).toBe(true)
    expect(wantsPrometheus('text/plain')).toBe(true)
    expect(wantsPrometheus(BROWSER)).toBe(false)
    expect(wantsPrometheus('*/*')).toBe(false)
    expect(wantsPrometheus(undefined)).toBe(false)
  })
})

describe('renderPrometheus emits numbers and invents nothing', () => {

  const render = (m: unknown) => renderPrometheus(m as MetricsResponse)

  it('a number is a metric', () => {
    expect(render({ uptime: 12 })).toBe('junction_uptime 12\n')
  })

  it('a string, an array and a boolean are skipped rather than counted', () => {
    // Counting the array or stringifying the version would be a value the
    // collector never stated.
    const out = render({ ts: '2026-09-05', nodeVersion: 'v1.2.3', registered: ['a', 'b'], bulk: true, n: 1 })
    expect(out).toBe('junction_n 1\n')
  })

  it('a non-finite number has no exposition form and is skipped', () => {
    expect(render({ a: NaN, b: Infinity, c: 3 })).toBe('junction_c 3\n')
  })

  it('nesting becomes one name, camelCase becomes snake_case', () => {
    expect(render({ process: { heapUsedMb: 4.5 } })).toBe('junction_process_heap_used_mb 4.5\n')
  })

  it('a plugin section of names and flags produces no series at all', () => {
    // What bounds the cardinality: `services.details` is one object per service
    // holding a name list and a boolean, and the numbers-only rule reaches none
    // of it, so a section cannot become a series per service by accident.
    const out = render({ services: { count: 2, details: { orders: { customMethods: ['pay'], bulk: true } } } })
    expect(out).toBe('junction_services_count 2\n')
  })

  it('emits no TYPE line, because a counter cannot be told from a gauge by name', () => {
    expect(render({ http: { requests: { total: 9 } } })).not.toContain('# TYPE')
  })
})
