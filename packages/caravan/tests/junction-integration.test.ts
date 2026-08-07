// ============================================================
// Caravan ↔ Junction — Integration
//
// tests/caravan.test.ts drives the queue and cron logic directly and
// never boots a Junction app. Those tests pass unchanged even if the
// plugin lifecycle, the App surface, or raw route registration changes
// underneath — which is how the admin-route auth bug below shipped.
//
// These boot a real Junction app and exercise the seams Caravan
// actually depends on:
//
//   • Plugin lifecycle      — register/boot/ready/shutdown are called
//   • app.jobs              — the module augmentation resolves
//   • app._metricsProviders — private-field reach-in still lands
//   • raw app.get/app.post  — admin routes route, and ctx is a
//                             TransportContext (headers, not params.headers)
// ============================================================

import { describe, it, expect } from 'bun:test'
import { resolve } from 'node:path'
import { createTestApp, request } from '@frontierjs/junction'
import type { App } from '@frontierjs/junction'
import { createCaravan } from '../src/index.ts'
import type { CaravanOptions, CaravanInstance, JobRecord } from '../src/types.ts'

const FIXTURES = resolve(import.meta.dir, 'fixtures/jobs')

// `app.jobs` is fully typed here: Caravan augments Junction's AppJobs
// interface, so CaravanInstance's members resolve without a cast. If that
// augmentation ever breaks, these lines stop compiling.
const jobsOf = (app: { jobs?: CaravanInstance }) => app.jobs!

// Every instance gets its own in-memory DB, so tests are isolated and
// nothing touches ./db/jobs.db on disk.
const opts = (o: Partial<CaravanOptions> = {}): CaravanOptions => ({
  db:           ':memory:',
  pollInterval: 10,
  ...o,
})

// Boots a test app with the plugin configured, through the real lifecycle.
// _startForTest() is what runs boot() — anything asserting on start() must
// go through it.
async function bootApp(o: Partial<CaravanOptions> = {}) {
  const app = await createTestApp()
  app.configure(createCaravan(opts(o)))
  await app._startForTest()
  return app
}

// Poll until a predicate holds — the worker is asynchronous, so assertions
// about processed jobs can't be made synchronously after dispatch.
async function until(pred: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return pred()
}

// ─── Plugin lifecycle ────────────────────────────────────────

describe('plugin lifecycle against a real app', () => {
  it('register() attaches app.jobs at configure() time', async () => {
    const app = await createTestApp()
    expect(app.jobs).toBeUndefined()

    app.configure(createCaravan(opts()))

    // configure() runs register() synchronously — no start() needed
    expect(app.jobs).toBeDefined()
    expect(typeof jobsOf(app).dispatch).toBe('function')
  })

  it('the plugin exposes every lifecycle phase Junction calls', () => {
    const plugin = createCaravan(opts())
    // Junction invokes these as optional — a rename on either side would
    // silently skip the phase rather than error.
    for (const phase of ['register', 'boot', 'ready', 'shutdown'] as const) {
      expect(typeof plugin[phase]).toBe('function')
    }
    expect(plugin.name).toBe('caravan')
  })

  it('boot() starts the worker, so a dispatched job actually runs', async () => {
    const app = await bootApp()
    let ran: unknown = null
    jobsOf(app).handle('greet', (job: { data: unknown }) => { ran = job.data })

    await jobsOf(app).dispatch('greet', { to: 'alice' })

    expect(await until(() => ran !== null)).toBe(true)
    expect(ran).toEqual({ to: 'alice' })
  })

  it('a handler registered before start still processes after boot()', async () => {
    const app = await createTestApp()
    const caravan = createCaravan(opts())
    app.configure(caravan)

    let ran = false
    jobsOf(app).handle('early', () => { ran = true })
    await jobsOf(app).dispatch('early', {})

    await app._startForTest()

    expect(await until(() => ran)).toBe(true)
  })

  it('shutdown() stops the worker — no further jobs are processed', async () => {
    const app = await createTestApp()
    const plugin = createCaravan(opts())
    plugin.register(app as App)
    await plugin.boot!(app as App)

    let processed = 0
    jobsOf(app).handle('count', () => { processed++ })
    await jobsOf(app).dispatch('count', {})
    expect(await until(() => processed === 1)).toBe(true)

    await plugin.shutdown!(app as App)

    // The worker loop and cron timer are both stopped; the DB is closed, so
    // a further dispatch cannot even be persisted.
    await new Promise(r => setTimeout(r, 50))
    expect(processed).toBe(1)
  })
})

// ─── Metrics wiring ──────────────────────────────────────────

describe('metrics provider', () => {
  // register() reaches into app._metricsProviders behind an `instanceof Map`
  // guard. If Junction renames or retypes that field the guard fails silently
  // and job metrics vanish with no error anywhere.
  it('lands in the real app._metricsProviders map', async () => {
    const app = await bootApp()

    expect(app._metricsProviders).toBeInstanceOf(Map)
    expect(app._metricsProviders.has('jobs')).toBe(true)
  })

  it('the registered provider returns the current stats shape', async () => {
    const app = await bootApp()

    const stats = app._metricsProviders.get('jobs')!() as {
      queues: Record<string, { pending: number }>
      total:  { pending: number; running: number; failed: number; cancelled: number }
    }

    expect(stats.total).toBeDefined()
    expect(stats.queues.default).toBeDefined()
    expect(stats.total.pending).toBe(0)
  })

  it('stats stay in sync with dispatched work', async () => {
    // No handler registered, so the job stays pending and the count is stable.
    const app = await bootApp()
    const read = () => (app._metricsProviders.get('jobs')!() as {
      total: { pending: number }
    }).total.pending

    expect(read()).toBe(0)
    await jobsOf(app).dispatch('never-handled', {})
    expect(read()).toBe(1)
  })
})

// ─── junction.config.js → caravan section ────────────────────
//
// register() reads `app.config._junction.caravan`. Junction really does
// publish that section (JunctionCaravanConfig in src/config/index.ts), but
// Caravan can only honour the keys that are still changeable at register()
// time — jobsDir and cleanupAfter. db/pollInterval/queues/admin are consumed
// by createCaravan() before any app exists, so a config file cannot set them.

describe('junction config caravan section', () => {
  const withConfig = async (caravanCfg: Record<string, unknown>, o: Partial<CaravanOptions> = {}) => {
    const app = await createTestApp()
    ;(app.config as Record<string, unknown>)._junction = { caravan: caravanCfg }
    app.configure(createCaravan(opts(o)))
    await app._startForTest()
    return app
  }

  it('picks up jobsDir from config when opts does not set it', async () => {
    const app = await withConfig({ jobsDir: FIXTURES })

    // The autoloaded 'send-email' handler declares queue 'email', so dispatch
    // routing off the registration proves the handler was loaded.
    const id = await jobsOf(app).dispatch('send-email', { to: 'a@b.c' })
    expect(jobsOf(app).find(id)!.queue).toBe('email')
  })

  it('opts.jobsDir wins over the config file', async () => {
    const app = await withConfig({ jobsDir: resolve(FIXTURES, 'nope') }, { jobsDir: FIXTURES })

    const id = await jobsOf(app).dispatch('send-email', { to: 'a@b.c' })
    expect(jobsOf(app).find(id)!.queue).toBe('email')
  })

  it('boots normally when no _junction config is present', async () => {
    const app = await bootApp()
    expect(jobsOf(app).stats().total.pending).toBe(0)
  })
})

// ─── Admin routes over real routing ──────────────────────────

describe('admin routes over real routes', () => {
  it('GET /jobs lists jobs through the HTTP layer', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))
    await jobsOf(app).dispatch('report', { id: 1 })

    const res = await request(app).get('/jobs')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect((res.body as JobRecord[])[0].name).toBe('report')
  })

  it('GET /jobs/:id resolves a single job', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))
    const id = await jobsOf(app).dispatch('report', { id: 1 })

    const res = await request(app).get(`/jobs/${id}`)

    expect(res.status).toBe(200)
    expect((res.body as JobRecord).id).toBe(id)
  })

  it('GET /jobs/:id on an unknown id returns 404', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))

    const res = await request(app).get('/jobs/nope')
    expect(res.status).toBe(404)
  })

  // /jobs/schedules is registered before /jobs/:id — if that order ever
  // flips, this request is captured by the :id route and 404s instead.
  it('GET /jobs/schedules is not shadowed by /jobs/:id', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))
    jobsOf(app).schedule('nightly', '0 2 * * *', () => {})

    const res = await request(app).get('/jobs/schedules')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect((res.body as Array<{ name: string }>)[0].name).toBe('nightly')
  })

  it('POST /jobs/:id/cancel cancels the job', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))
    const id = await jobsOf(app).dispatch('report', {})

    const res = await request(app).post(`/jobs/${id}/cancel`)

    expect(res.status).toBe(200)
    expect((res.body as { ok: boolean }).ok).toBe(true)
    expect(jobsOf(app).find(id)!.status).toBe('cancelled')
  })

  it('POST /jobs/:id/retry re-queues a cancelled job', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))
    const id = await jobsOf(app).dispatch('report', {})
    await jobsOf(app).cancel(id)

    const res = await request(app).post(`/jobs/${id}/retry`)

    expect(res.status).toBe(200)
    expect(jobsOf(app).find(id)!.status).toBe('pending')
  })

  // ── POST /jobs/run/{name} ──────────────────────────────────
  //
  // The admin surface could retry a job and cancel a job but not START one, so
  // a nightly sweep could only be exercised by waiting until 03:00 — its
  // handler was untestable and, during an incident, unrunnable. Added
  // 2026-08-06 while giving `example/` a cron it could actually drive.

  it('POST /jobs/run/{name} dispatches a registered job', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))
    jobsOf(app).handle('report', async () => {})

    const res = await request(app).post('/jobs/run/report')

    expect(res.status).toBe(200)
    const { ok, id } = res.body as { ok: boolean; id: string }
    expect(ok).toBe(true)
    expect(jobsOf(app).find(id)!.name).toBe('report')
  })

  it('the body becomes the job data, so a scheduled handler can be re-parameterised', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))
    jobsOf(app).schedule('sweep', '0 3 * * *', async () => {})

    const res = await request(app).post('/jobs/run/sweep').send({ days: 0 })

    const { id } = res.body as { id: string }
    expect(JSON.parse(jobsOf(app).find(id)!.data as string)).toEqual({ days: 0 })
  })

  it('an empty body is an empty data object, not a hang', async () => {
    // ctx.body is already parsed by the transport. Reading the raw request
    // instead would await a stream nobody is going to write to.
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))
    jobsOf(app).handle('report', async () => {})

    const res = await request(app).post('/jobs/run/report')
    const { id } = res.body as { id: string }

    expect(JSON.parse(jobsOf(app).find(id)!.data as string)).toEqual({})
  })

  it('refuses an unregistered name with 404 rather than queueing it', async () => {
    // A job nothing handles sits pending forever and reports as a backlog.
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))

    const res = await request(app).post('/jobs/run/nope')

    expect(res.status).toBe(404)
    expect(jobsOf(app).list()).toHaveLength(0)
  })

  it('run/{name} is guarded by the same secret as everything else', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: { secret: 's3cret' } })))
    jobsOf(app).handle('report', async () => {})

    expect((await request(app).post('/jobs/run/report')).status).toBe(401)
    expect((await request(app).post('/jobs/run/report')
      .set('x-caravan-secret', 's3cret')).status).toBe(200)
  })

  it('honours a custom admin path', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: { path: '/admin/jobs' } })))

    const res = await request(app).get('/admin/jobs')
    expect(res.status).toBe(200)
  })

  it('is not mounted when admin is omitted', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts()))

    const res = await request(app).get('/jobs')
    expect(res.status).toBe(404)
  })
})

// ─── The secret guard ────────────────────────────────────────
//
// The guard used to read `ctx.params.headers['x-caravan-secret']`. These are
// raw app.get/app.post routes, so ctx is Junction's TransportContext, where
// `params` holds path params only and headers live on `ctx.headers`. The
// lookup was always undefined, so every request 401'd whenever a secret was
// configured — the secured mode was unusable and nothing here caught it.

describe('admin secret guard', () => {
  const secured = async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: { secret: 's3cret' } })))
    return app
  }

  it('admits a request carrying the correct secret header', async () => {
    const app = await secured()
    await jobsOf(app).dispatch('report', {})

    const res = await request(app).get('/jobs').set('x-caravan-secret', 's3cret')

    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
  })

  it('rejects a request with a wrong secret', async () => {
    const app = await secured()

    const res = await request(app).get('/jobs').set('x-caravan-secret', 'wrong')

    expect(res.status).toBe(401)
  })

  it('rejects a request with no secret header at all', async () => {
    const app = await secured()

    const res = await request(app).get('/jobs')

    expect(res.status).toBe(401)
  })

  it('guards every admin route, not just the list', async () => {
    const app = await secured()
    const id = await jobsOf(app).dispatch('report', {})

    expect((await request(app).get(`/jobs/${id}`)).status).toBe(401)
    expect((await request(app).get('/jobs/schedules')).status).toBe(401)
    expect((await request(app).post(`/jobs/${id}/retry`)).status).toBe(401)
    expect((await request(app).post(`/jobs/${id}/cancel`)).status).toBe(401)

    // ...and the guarded mutation genuinely did not run
    expect(jobsOf(app).find(id)!.status).toBe('pending')
  })

  it('leaves routes open when no secret is configured', async () => {
    const app = await createTestApp()
    app.configure(createCaravan(opts({ admin: true })))

    const res = await request(app).get('/jobs')
    expect(res.status).toBe(200)
  })
})
