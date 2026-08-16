// ============================================================
// The job context — who deferred work runs as.
//
// The oldest hazard in this package: a handler had no principal, and no
// principal is STRANGER(0), so a job writing back through
// `app.service('x').patch(…)` was refused by the model's own `@@gate`. It was
// documented rather than fixed, and every job in every app carried a
// hand-written `{ auth: { user: SYSTEM } }` to work around it — which ALSO
// meant a job asked for by a customer ran with the authority of the shop.
//
// Now a dispatch records WHO asked and the worker opens a scope for them.
// Three rules, and each is a behaviour rather than a shape, so each is run:
//
//   1. a dispatch inside a request records that caller
//   2. the handler runs as them — re-RESOLVED, never replayed
//   3. nobody asked (cron, boot, standalone) → the app's own system principal
//
// The re-resolution is the one worth being careful about: storing the session
// would be one line shorter and would let a caller demoted between asking and
// running keep the authority they had when they asked.
// ============================================================

import { describe, it, expect } from 'bun:test'
import { createTestApp, createService } from '@frontierjs/junction'
import type { App, IAuth, SessionContext } from '@frontierjs/junction'
import { createCaravan } from '../src/index.ts'
import type { CaravanInstance, CaravanOptions, JobContext } from '../src/types.ts'

const jobsOf = (app: { jobs?: CaravanInstance }) => app.jobs!

const opts = (o: Partial<CaravanOptions> = {}): CaravanOptions => ({
  db:           ':memory:',
  pollInterval: 10,
  ...o,
})

async function until(pred: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise(r => setTimeout(r, 10))
  }
  return pred()
}

/**
 * An auth provider that resolves ids out of a mutable table.
 *
 * Mutable on purpose — demoting a user between the dispatch and the run is the
 * only way to tell a re-resolution from a replayed snapshot, and both look
 * identical in every other test.
 */
function authStub(users: Record<string, Partial<SessionContext>>) {
  let calls = 0
  const auth = {
    async sessionFor(userId: string): Promise<SessionContext | null> {
      calls++
      const u = users[userId]
      return u ? { userId, userType: 'user', authMethod: 'created', ...u } as SessionContext : null
    },
  } as unknown as IAuth
  return { auth, users, resolved: () => calls }
}

const SYSTEM = { userId: 'system', userType: 'service', role: 'system', authMethod: 'created' } as SessionContext

async function bootApp(o: {
  system?: SessionContext
  auth?:   IAuth
  caravan?: Partial<CaravanOptions>
} = {}) {
  const app = await createTestApp({ system: o.system, auth: o.auth } as never)
  app.configure(createCaravan(opts(o.caravan)))
  await app._startForTest()
  return app
}

/** Registers a job that records the context it was handed. */
function recorder(app: App, name = 'record') {
  const seen: JobContext[] = []
  jobsOf(app).handle(name, async (ctx) => { seen.push(ctx) })
  return seen
}

describe('the principal a job runs as', () => {

  it('records the caller in scope at dispatch and runs as them', async () => {
    const { auth } = authStub({ alice: { role: 'staff' } })
    const app = await bootApp({ auth })
    const seen = recorder(app)

    // A service is the only honest way to get a principal in scope — it is the
    // shape a real dispatch has, and it is what puts the ALS store there.
    app.services.register(createService({
      name: 'orders', methods: ['create'],
      async create() { await jobsOf(app).dispatch('record', {}); return {} },
    } as never))

    await app.service('orders').create({}, { auth: { user: { userId: 'alice' } } } as never)

    expect(await until(() => seen.length > 0)).toBe(true)
    expect(seen[0].actorId).toBe('alice')
    expect(seen[0].auth.user?.userId).toBe('alice')
    expect(seen[0].auth.user?.role).toBe('staff')

    await app.stop()
  })

  it('RE-RESOLVES rather than replaying — a caller demoted in between is graded now', async () => {
    // The reason an id is stored and a session is not. Snapshot the session at
    // dispatch and this test passes with `role: 'admin'`: a privilege that
    // outlives its own revocation, for as long as the retry schedule runs.
    const stub = authStub({ alice: { role: 'admin' } })
    const app  = await bootApp({ auth: stub.auth })
    const seen = recorder(app)

    app.services.register(createService({
      name: 'orders', methods: ['create'],
      async create() { await jobsOf(app).dispatch('record', {}, { delay: 50 }); return {} },
    } as never))

    await app.service('orders').create({}, { auth: { user: { userId: 'alice' } } } as never)

    // Demoted after the work was asked for and before it runs.
    stub.users.alice = { role: 'viewer' }

    expect(await until(() => seen.length > 0)).toBe(true)
    expect(seen[0].auth.user?.role).toBe('viewer')
    expect(stub.resolved()).toBeGreaterThan(0)

    await app.stop()
  })

  it('nobody asked → the app\'s own system principal', async () => {
    const app  = await bootApp({ system: SYSTEM })
    const seen = recorder(app)

    // Dispatched from outside any request, which is what a cron fire is.
    await jobsOf(app).dispatch('record', {})

    expect(await until(() => seen.length > 0)).toBe(true)
    expect(seen[0].actorId).toBeNull()
    expect(seen[0].auth.user?.userId).toBe('system')

    await app.stop()
  })

  it('an app that declares no system principal gets null, not an invented one', async () => {
    const app  = await bootApp()
    const seen = recorder(app)

    await jobsOf(app).dispatch('record', {})

    expect(await until(() => seen.length > 0)).toBe(true)
    expect(seen[0].auth.user).toBeNull()

    await app.stop()
  })

  it('`actor: null` says this is the app\'s own work even inside a request', async () => {
    const { auth } = authStub({ alice: {} })
    const app  = await bootApp({ auth, system: SYSTEM })
    const seen = recorder(app)

    app.services.register(createService({
      name: 'orders', methods: ['create'],
      async create() { await jobsOf(app).dispatch('record', {}, { actor: null }); return {} },
    } as never))

    await app.service('orders').create({}, { auth: { user: { userId: 'alice' } } } as never)

    expect(await until(() => seen.length > 0)).toBe(true)
    expect(seen[0].actorId).toBeNull()
    expect(seen[0].auth.user?.userId).toBe('system')

    await app.stop()
  })

  it('a stated actor overrides the caller', async () => {
    const { auth } = authStub({ alice: {}, bob: { role: 'staff' } })
    const app  = await bootApp({ auth })
    const seen = recorder(app)

    app.services.register(createService({
      name: 'orders', methods: ['create'],
      async create() { await jobsOf(app).dispatch('record', {}, { actor: 'bob' }); return {} },
    } as never))

    await app.service('orders').create({}, { auth: { user: { userId: 'alice' } } } as never)

    expect(await until(() => seen.length > 0)).toBe(true)
    expect(seen[0].auth.user?.userId).toBe('bob')

    await app.stop()
  })
})

describe('what the handler can reach', () => {

  it('a service call from a handler INHERITS the job\'s principal', async () => {
    // The whole point, and the thing no shape assertion can show. Nothing in
    // the handler names an auth; the principal arrives through the scope
    // `runAs` opened, exactly as it does for any nested call.
    const { auth } = authStub({ alice: { role: 'staff' } })
    const app = await bootApp({ auth })

    let sawInService: string | null = 'unset'
    app.services.register(createService({
      name: 'audit', methods: ['create'],
      async create(ctx: any) { sawInService = ctx.auth.user?.userId ?? null; return {} },
    } as never))

    jobsOf(app).handle('write-audit', async (ctx) => {
      await ctx.app!.service('audit').create({ what: 'shipped' })
    })

    app.services.register(createService({
      name: 'orders', methods: ['create'],
      async create() { await jobsOf(app).dispatch('write-audit', {}); return {} },
    } as never))

    await app.service('orders').create({}, { auth: { user: { userId: 'alice' } } } as never)

    expect(await until(() => sawInService !== 'unset')).toBe(true)
    expect(sawInService).toBe('alice')

    await app.stop()
  })

  it('ctx.app is the running app — an autoloaded job needs no module-level reference', async () => {
    const app  = await bootApp()
    const seen = recorder(app)

    await jobsOf(app).dispatch('record', {})

    expect(await until(() => seen.length > 0)).toBe(true)
    expect(seen[0].app).toBe(app)

    await app.stop()
  })

  it('standalone Caravan hands the handler no app and no principal', async () => {
    // No Junction, so no runAs and no scope. The shape stays the shape — a
    // handler reads ctx.app and finds undefined rather than crashing on a
    // missing argument.
    const queue = createCaravan(opts())
    const seen: JobContext[] = []
    queue.handle('record', async (ctx) => { seen.push(ctx) })
    await queue.start()
    await queue.dispatch('record', { n: 1 })

    expect(await until(() => seen.length > 0)).toBe(true)
    expect(seen[0].app).toBeUndefined()
    expect(seen[0].auth.user).toBeNull()
    expect(seen[0].data).toEqual({ n: 1 })

    await queue.stop()
  })
})

describe('what cannot be resolved', () => {

  it('a deleted actor fails the job by name rather than running as nobody', async () => {
    // Deferred work outlives its caller. Silently downgrading to STRANGER(0)
    // is the failure this whole change removes; silently upgrading to the
    // system principal would be worse. So it throws, which is a retry and then
    // a failed job with the reason in it.
    const stub = authStub({ alice: {} })
    const app  = await bootApp({ auth: stub.auth, caravan: { pollInterval: 10 } })

    jobsOf(app).handle('vanish', async () => {}, { maxAttempts: 1 })

    app.services.register(createService({
      name: 'orders', methods: ['create'],
      async create() { await jobsOf(app).dispatch('vanish', {}, { delay: 50 }); return {} },
    } as never))

    await app.service('orders').create({}, { auth: { user: { userId: 'alice' } } } as never)
    delete stub.users.alice

    const failed = () => jobsOf(app).list({ status: 'failed' })
    expect(await until(() => failed().length > 0)).toBe(true)
    expect(failed()[0].error).toContain('no such principal')

    await app.stop()
  })

  it('an auth provider with no sessionFor says so, naming the way out', async () => {
    const app = await bootApp({ auth: {} as IAuth })

    jobsOf(app).handle('needs-actor', async () => {}, { maxAttempts: 1 })
    await jobsOf(app).dispatch('needs-actor', {}, { actor: 'alice' })

    const failed = () => jobsOf(app).list({ status: 'failed' })
    expect(await until(() => failed().length > 0)).toBe(true)
    expect(failed()[0].error).toContain('sessionFor')

    await app.stop()
  })
})
