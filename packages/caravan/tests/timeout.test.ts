// tests/timeout.test.ts
//
// `FJS-295` — a handler that never returns held its slot for the life of the
// process. On a `concurrency: 1` queue everything behind it stayed `pending`
// with no error, no telemetry, and a `running` count that never moved.
//
// Two halves are tested here and they are separate fixes. A declared `timeout`
// bounds the wait; `oldestRunningMs` makes an UNBOUNDED one visible, because
// most stalls will happen on jobs nobody thought to bound.

import { describe, it, expect, afterEach } from 'bun:test'
import { createCaravan } from '../src/index.ts'
import type { CaravanInstance } from '../src/types.ts'

const made: CaravanInstance[] = []
function makeQueue(opts: Parameters<typeof createCaravan>[0] = {}): CaravanInstance {
  // A short drain deliberately: two tests here leave a job running on purpose,
  // and the default 30s is the very cost `FJS-295` names — one stuck handler
  // and every shutdown waits its full deadline.
  const q = createCaravan({ db: ':memory:', pollInterval: 10, drainTimeout: 100, ...opts })
  made.push(q)
  return q
}
afterEach(async () => {
  for (const q of made.splice(0)) await q.stop().catch(() => {})
})

const never = () => new Promise<void>(() => {})

// `start()` staggers each queue's first poll by up to 200ms of jitter to spread
// lock contention, so every sleep here has to clear that before it is measuring
// anything. A 150ms wait was a race with the harness, not with the code.
const SETTLE = 500

describe('a declared timeout bounds one attempt', () => {
  it('fails the attempt and frees the slot, where nothing used to', async () => {
    const q = makeQueue({ queues: { solo: { concurrency: 1 } } })
    q.handle('stuck',  never,      { queue: 'solo', timeout: 50, maxAttempts: 1 })
    q.handle('behind', async () => {}, { queue: 'solo' })

    await q.start()
    const stuck  = await q.dispatch('stuck',  {}, { queue: 'solo' })
    const behind = await q.dispatch('behind', {}, { queue: 'solo' })

    await Bun.sleep(SETTLE)

    // The whole defect in two assertions: the stuck job reached a terminal
    // state, and the job behind it ran. Before the timeout both stayed where
    // they were for as long as the process lived.
    expect(q.find(stuck)!.status).toBe('failed')
    expect(q.find(stuck)!.error).toContain('timeout')
    expect(q.find(behind)!.status).toBe('done')
  })

  it('is an ordinary failure, so the retry ladder applies unchanged', async () => {
    const q = makeQueue()
    q.handle('flaky', never, { timeout: 40, maxAttempts: 2, retryDelay: [10] })

    await q.start()
    const id = await q.dispatch('flaky', {})
    await Bun.sleep(SETTLE)

    const row = q.find(id)!
    expect(row.attempts).toBe(2)
    expect(row.status).toBe('failed')
  })

  it('a handler that finishes inside its bound is untouched', async () => {
    const q = makeQueue()
    q.handle('quick', async () => { await Bun.sleep(10) }, { timeout: 500 })

    await q.start()
    const id = await q.dispatch('quick', {})
    await Bun.sleep(SETTLE)

    expect(q.find(id)!.status).toBe('done')
  })

  // Absent means no bound, honestly — the same contract every declaration here
  // has. This is the defect's original behaviour, kept deliberately and pinned
  // so that a default timeout cannot be introduced by accident: one would kill
  // every legitimately long job in every app that upgraded.
  it('no timeout declared is still no bound', async () => {
    const q = makeQueue()
    q.handle('unbounded', never)

    await q.start()
    const id = await q.dispatch('unbounded', {})
    await Bun.sleep(SETTLE)

    expect(q.find(id)!.status).toBe('running')
  })

  it('a queue-level default covers a handler that declares none', async () => {
    const q = makeQueue({ queues: { bounded: { concurrency: 1, timeout: 50 } } })
    q.handle('stuck', never, { queue: 'bounded', maxAttempts: 1 })

    // The bound is reported as the one that will be enforced, not as the one
    // the handler wrote — a snapshot saying `—` for a job the queue does bound
    // is a true statement about the handler and a false one about the app.
    expect(q.registrations()[0]!.timeout).toBe(50)

    await q.start()
    const id = await q.dispatch('stuck', {}, { queue: 'bounded' })
    await Bun.sleep(300)
    expect(q.find(id)!.status).toBe('failed')
  })

  it("a handler's own timeout beats the queue's", () => {
    const q = makeQueue({ queues: { bounded: { timeout: 50 } } })
    q.handle('slow', never, { queue: 'bounded', timeout: 9_000 })
    expect(q.registrations()[0]!.timeout).toBe(9_000)
  })
})

describe('what a timeout cannot do', () => {
  // Nothing in JavaScript cancels a promise. The abandoned invocation keeps
  // running, and its later rejection would otherwise be unhandled — which takes
  // the process down, turning a stalled job into a crash.
  it('an abandoned handler that throws later does not reach the process', async () => {
    const q = makeQueue()
    let rejectIt: (e: Error) => void = () => {}
    q.handle('late', () => new Promise<void>((_, rej) => { rejectIt = rej }),
      { timeout: 40, maxAttempts: 1 })

    await q.start()
    const id = await q.dispatch('late', {})
    await Bun.sleep(SETTLE)
    expect(q.find(id)!.status).toBe('failed')

    const before = q.find(id)!.finished_at
    rejectIt(new Error('the socket finally closed'))
    await Bun.sleep(50)

    // Still failed, and the row is untouched by the late arrival: the attempt
    // it belonged to was over.
    expect(q.find(id)!.status).toBe('failed')
    expect(q.find(id)!.finished_at).toBe(before)
  })

  it('an abandoned handler that SUCCEEDS later is announced, not swallowed', async () => {
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...a: unknown[]) => { warnings.push(String(a[0])) }

    try {
      const q = makeQueue()
      let finish: () => void = () => {}
      q.handle('late-ok', () => new Promise<void>(res => { finish = res }),
        { timeout: 40, maxAttempts: 1 })

      await q.start()
      const id = await q.dispatch('late-ok', {})
      await Bun.sleep(SETTLE)
      expect(q.find(id)!.status).toBe('failed')

      finish()
      await Bun.sleep(50)

      // The most useful sentence a person debugging this can be given: the work
      // you gave up on completed, after the retry had already done it again.
      expect(warnings.some(w => w.includes('late-ok') && w.includes('Its effects happened anyway')))
        .toBe(true)
      // And it still did not resurrect the row.
      expect(q.find(id)!.status).toBe('failed')
    } finally {
      console.warn = realWarn
    }
  })
})

describe('an unbounded stall is visible even though it is not stopped', () => {
  // Most stalls will be on jobs nobody thought to bound, so the counts have to
  // show one. `running: 1` for the life of the process is exactly what a queue
  // doing steady work reports; an age climbing beside it is not.
  it('oldestRunningMs separates a stuck queue from a busy one', async () => {
    const q = makeQueue({ queues: { solo: { concurrency: 1 } } })
    q.handle('unbounded', never, { queue: 'solo' })

    expect(q.stats().queues.solo!.oldestRunningMs).toBeNull()

    await q.start()
    await q.dispatch('unbounded', {}, { queue: 'solo' })
    await Bun.sleep(SETTLE)

    const stats = q.stats().queues.solo!
    expect(stats.running).toBe(1)
    expect(stats.oldestRunningMs).toBeGreaterThan(50)
    // null, never 0, where nothing is running — 0 reads as "started this instant"
    // on the one line somebody checks to see whether work is moving.
    expect(q.stats().queues.default?.oldestRunningMs ?? null).toBeNull()
  })
})

// A job FILE is the whole declaration, so a timeout written there has to survive
// `defineJob` → `handle()` → the registry. It did not: `defineJob` builds the
// definition from a whitelist of keys and the new one was not on it, so a job
// file's timeout was accepted, ignored, and reported as `none`. Caught by the
// jobs snapshot showing `**none**` for a job that had just declared 30s.
describe('a timeout declared in a job file survives the round trip', () => {
  it('reaches the registry through defineJob', async () => {
    const { defineJob } = await import('../src/index.ts')
    const def = defineJob('shipping', async () => {}, { timeout: 30_000, queue: 'fulfilment' })
    expect(def.timeout).toBe(30_000)

    const q = makeQueue()
    q.handle(def)
    expect(q.registrations()[0]!.timeout).toBe(30_000)
  })
})

// The other half of the same defect: autoload used to re-list a definition's
// keys into `handle(name, fn, opts)`, so a job FILE's declaration passed two
// whitelists and `timeout` was on neither. It passes the definition whole now,
// which is asserted here against the real loader rather than a stub.
describe('and through the autoloader', () => {
  it('registers a job file with the bound the file declared', async () => {
    const { autoloadJobs } = await import('../src/autoload.ts')
    const q = makeQueue()
    await autoloadJobs(new URL('./fixtures/timeout-jobs', import.meta.url).pathname, q)
    expect(q.registrations()).toEqual([
      { name: 'bounded', queue: 'default', cron: null, timeZone: null,
        maxAttempts: 3, retryDelay: [], timeout: 250 },
    ])
  })
})
