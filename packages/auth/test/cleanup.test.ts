// test/cleanup.test.ts
//
// The expired-row sweep: `auth.cleanup` on every createLitestoneAuth instance,
// held by createAuthPlugin from work() to shutdown.
//
// The interval is an hour, so the timer is not what is under test here:
// `sweepNow()` runs the SHIPPED predicate against a real Litestone database.
// It exists for that reason as much as for an operator's — a scheduled body
// lives in a closure nothing can reach, so the only other way to grade it is a
// test holding its own copy of the rule, which agrees with itself. What a sweep
// must do is delete the expired rows AND leave the live ones; a test asserting
// only the first passes against `deleteMany({})`.
//
// The lifecycle half needs a real timer, so those rows drive the handle with
// its interval left alone and assert on what `stop()` leaves behind.

import { describe, test, expect, afterAll } from 'bun:test'
import { createAuthCleanupJobs } from '../cleanup.ts'
import { createAuthPlugin }      from '../plugin.ts'
import { makeAuth, type Harness } from './harness.ts'

const harnesses: Harness[] = []
afterAll(() => harnesses.forEach(h => h.cleanup()))

async function env() {
  const h = await makeAuth()
  harnesses.push(h)
  return h
}

const hour = 60 * 60 * 1000
const past = () => new Date(Date.now() - hour)
const soon = () => new Date(Date.now() + hour)

/** The SHIPPED sweep, run once. Not a copy of the predicate — a copy agrees
 *  with itself and would pass against a module whose own rule had changed. */
const sweep = (db: any) => createAuthCleanupJobs(db).sweepNow()

describe('auth cleanup — the sweep', () => {

  test('deletes what has expired and leaves what has not, on all three tables', async () => {
    const { db, sys } = await env()

    const user = await sys.user.create({ data: { email: 'sweep@example.com', name: 'Sweep' } })

    // Each table gets one dead row and one live one. The live row is the whole
    // test: `deleteMany({})` satisfies every assertion about the dead ones.
    await sys.session.create({ data: { userId: user.id, token: 'dead-session', expiresAt: past() } })
    await sys.session.create({ data: { userId: user.id, token: 'live-session', expiresAt: soon() } })
    await sys.verification.create({ data: { purpose: 'emailVerify', identifier: user.email, value: 'dead-verify', expiresAt: past() } })
    await sys.verification.create({ data: { purpose: 'emailVerify', identifier: user.email, value: 'live-verify', expiresAt: soon() } })
    await sys.oauthFlow.create({ data: { state: 'dead-flow', provider: 'github', verifier: 'v1', expiresAt: past() } })
    await sys.oauthFlow.create({ data: { state: 'live-flow', provider: 'github', verifier: 'v2', expiresAt: soon() } })

    await sweep(db)

    const tokens = (rows: any[], key: string) => rows.map(r => r[key]).sort()
    expect(tokens(await sys.session.findMany({}), 'token')).toEqual(['live-session'])
    expect(tokens(await sys.verification.findMany({}), 'value')).toEqual(['live-verify'])
    expect(tokens(await sys.oauthFlow.findMany({}), 'state')).toEqual(['live-flow'])
  })

  test('a row expiring in the future is not swept, however old it is', async () => {
    // The predicate is `expiresAt`, never `createdAt`. A sweep written against
    // the wrong column empties a table of long-lived sessions and looks correct
    // on a fixture whose rows were all made a moment ago.
    const { db, sys } = await env()
    const user = await sys.user.create({ data: { email: 'old@example.com', name: 'Old' } })

    await sys.session.create({
      data: {
        userId:    user.id,
        token:     'ancient-but-valid',
        expiresAt: new Date(Date.now() + 365 * 24 * hour),
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      },
    })

    await sweep(db)
    expect((await sys.session.findMany({})).length).toBe(1)
  })
})

describe('auth cleanup — the handle', () => {

  /** A db whose every accessor answers a counting `deleteMany`. */
  function counter() {
    const seen = { sweeps: 0 }
    const table = { deleteMany: async () => { seen.sweeps++ } }
    const db = { asSystem: () => new Proxy({}, { get: () => table }) }
    return { db, seen }
  }

  /** The intervals alive while fn runs: an hourly timer never fires in a
   *  test, so what the handle leaves behind is read off setInterval itself. */
  function liveIntervals(fn: (live: () => number) => void) {
    const live = new Set<unknown>()
    const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
    globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => { const t = realSet(...a); live.add(t); return t }) as typeof setInterval
    globalThis.clearInterval = ((t: any) => { live.delete(t); realClear(t) }) as typeof clearInterval
    try { fn(() => live.size) } finally {
      globalThis.setInterval = realSet
      globalThis.clearInterval = realClear
      live.forEach(t => realClear(t as any))
    }
  }

  test('two holders share one pair of timers, and the last stop() ends them', () => {
    // Two apps over one auth instance each start it. A second pair would be
    // orphaned — measured before FJS-1000 at six further sweeps after stop().
    const { db } = counter()
    liveIntervals(live => {
      const jobs = createAuthCleanupJobs(db as any)
      jobs.start()
      jobs.start()
      expect(live()).toBe(2)
      jobs.stop()
      expect(live()).toBe(2)
      jobs.stop()
      expect(live()).toBe(0)
    })
  })

  test('createAuthPlugin runs the sweep from work() to shutdown', async () => {
    // What an app no longer writes (FJS-1893): mounting the plugin is the wiring.
    const h = await env()
    const plugin = createAuthPlugin(h.auth) as any
    liveIntervals(live => {
      expect(live()).toBe(0)
      plugin.work()
      expect(live()).toBe(2)
      plugin.shutdown()
      expect(live()).toBe(0)
    })
  })

  test('an extra stop() does not leave a later start() owing one', () => {
    const { db } = counter()
    liveIntervals(live => {
      const jobs = createAuthCleanupJobs(db as any)
      jobs.stop()
      jobs.start()
      expect(live()).toBe(2)
      jobs.stop()
      expect(live()).toBe(0)
    })
  })

  test('start() after stop() runs again — restart is not the same as refuse', async () => {
    // The control for the row above: a handle that refused every second start
    // would satisfy it and make the lifecycle one-shot.
    const { db } = counter()
    const jobs = createAuthCleanupJobs(db as any)
    jobs.start()
    jobs.stop()
    expect(() => jobs.start()).not.toThrow()
    jobs.stop()
  })

  test('stop() before start() is not an error', async () => {
    const { db } = counter()
    expect(() => createAuthCleanupJobs(db as any).stop()).not.toThrow()
  })

  test('the handle survives being destructured', () => {
    // `this.stop()` inside the object literal reads correctly and throws here.
    const { db } = counter()
    const { start, stop } = createAuthCleanupJobs(db as any)
    expect(() => { start(); start(); stop(); stop() }).not.toThrow()
  })
})
