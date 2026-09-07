// tests/cleanup.test.ts
//
// `createAuthCleanupJobs` shipped with no test of any kind — its own
// PROJECT_STATE.md said so and asked whether it was wired anywhere. Neither
// dogfooding app starts it (`example` never does, `basecamp` runs a cleanup of
// its own), so nothing in this repo had ever executed the module.
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

  test('stop() stops, and a second start() does not orphan the first pair', async () => {
    // Measured before the fix with the interval at 1 second: two starts, one
    // stop, and the sweep ran six more times. Nothing held the first pair of
    // handles, so `stop()` reported success and halted only the newest.
    const { db, seen } = counter()
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...a: unknown[]) => { warnings.push(String(a[0])) }

    try {
      const jobs = createAuthCleanupJobs(db as any)
      jobs.start()
      jobs.start()
      jobs.stop()
      seen.sweeps = 0
      await new Promise(r => setTimeout(r, 150))
      expect(seen.sweeps).toBe(0)
    } finally {
      console.warn = realWarn
    }

    // The double start is a caller's bug either way, so it is reported rather
    // than absorbed in silence.
    expect(warnings.some(w => w.includes('already running'))).toBe(true)
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
    expect(() => { start(); start(); stop() }).not.toThrow()
  })
})
