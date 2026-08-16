// ============================================================
// What a job file may declare about itself, and what reconciles it.
//
// Two things used to be split across places:
//
//   • WHEN a job runs. `defineJob` had no `cron`, so a recurring job was half
//     in its own file and half in the app.ts call to schedule() — and an app
//     kept the handler out of `jobsDir` on purpose so it could not autoload
//     without its schedule (FJS-094).
//   • WHAT it is called. The name was stated in defineJob, again at every
//     dispatch, and a third time by the file it lives in — and nothing
//     compared them, so `send-emial.job.ts` registered a handler no dispatch
//     ever reached (FJS-090).
// ============================================================

import { describe, it, expect, afterEach } from 'bun:test'
import { resolve } from 'node:path'
import { createCaravan, defineJob } from '../src/index.ts'
import { autoloadJobs } from '../src/autoload.ts'
import type {
  CaravanInstance, HandlerOptions, JobContext, JobHandler, JobRegistrar,
} from '../src/types.ts'

const CRON_FIXTURES = resolve(import.meta.dir, 'fixtures/cron-jobs')
const BAD_FIXTURES  = resolve(import.meta.dir, 'fixtures/bad-jobs')

const queues: CaravanInstance[] = []

function makeQueue(opts: Parameters<typeof createCaravan>[0] = {}): CaravanInstance {
  const q = createCaravan({ db: ':memory:', pollInterval: 20, ...opts })
  queues.push(q)
  return q
}

afterEach(async () => {
  while (queues.length) await queues.pop()!.stop()
})

// ─── A job file declares its own schedule ────────────────────

describe('cron on a registration', () => {

  it('a job file that declares cron is scheduled by autoloading it', async () => {
    const q = makeQueue({ jobsDir: CRON_FIXTURES })
    await q.start()

    expect(q.nextRuns()).toEqual([
      { name: 'nightly-sweep', cron: '0 3 * * *', nextRun: expect.any(Date) },
    ])
  })

  it('the schedule dispatches onto the queue the same registration names', async () => {
    const q = makeQueue({ jobsDir: CRON_FIXTURES })
    await q.start()

    // The scheduler fires on a clock; what is assertable without one is that
    // the handler behind the schedule is registered where it said, so a fire
    // lands in front of a worker rather than in 'default' with nobody polling.
    const id = await q.dispatch('nightly-sweep', {})
    expect(q.find(id)!.queue).toBe('maintenance')
  })

  it('handle(name, fn, { cron }) is the same registration schedule() makes', () => {
    const q = makeQueue()
    q.handle('report', () => {}, { cron: '30 4 * * *' })

    expect(q.nextRuns().map(r => ({ name: r.name, cron: r.cron })))
      .toEqual([{ name: 'report', cron: '30 4 * * *' }])
  })

  it('registering the same name twice replaces the schedule rather than adding one', () => {
    const q = makeQueue()
    q.schedule('report', '0 2 * * *', () => {})
    q.schedule('report', '0 5 * * *', () => {})

    expect(q.nextRuns()).toHaveLength(1)
    expect(q.nextRuns()[0].cron).toBe('0 5 * * *')
  })

  it('schedule() registers the handler as well as the schedule', async () => {
    const q = makeQueue()
    q.schedule('report', '0 2 * * *', () => {}, { queue: 'reports' })

    const id = await q.dispatch('report', {})
    expect(q.find(id)!.queue).toBe('reports')
  })

  it('an unparseable expression is refused by the JOB name, not just the expression', () => {
    const q = makeQueue()
    expect(() => q.handle('report', () => {}, { cron: 'every night' }))
      .toThrow(/job "report"/)
  })

  it('a registration with no cron schedules nothing', () => {
    const q = makeQueue()
    q.handle('report', () => {})
    expect(q.nextRuns()).toEqual([])
  })
})

// ─── The name is stated once, and reconciled ─────────────────

describe('a job file is named by its file', () => {

  it('refuses a defineJob name that does not match the file, naming both', async () => {
    const registered: string[] = []
    const stub: JobRegistrar = { handle: (name: string) => { registered.push(name) } }

    await expect(autoloadJobs(BAD_FIXTURES, stub)).rejects.toThrow(/send-repot.*send-report/s)
    expect(registered).toEqual([])
  })

  it('carries the cron and timezone from the file through to the registration', async () => {
    const registered: Array<{ name: string; opts: HandlerOptions }> = []
    const stub: JobRegistrar = {
      handle(name: string, _fn: JobHandler, opts: HandlerOptions = {}) {
        registered.push({ name, opts })
      },
    }

    await autoloadJobs(CRON_FIXTURES, stub)

    expect(registered).toHaveLength(1)
    expect(registered[0].opts.cron).toBe('0 3 * * *')
    expect(registered[0].opts.timeZone).toBe('UTC')
    expect(registered[0].opts.queue).toBe('maintenance')
  })
})

// ─── The definition IS the dispatch handle ───────────────────

describe('dispatch by definition', () => {

  it('takes the name from the definition, so no call site restates it', async () => {
    const q = makeQueue()
    const sendEmail = defineJob('send-email', () => {}, { queue: 'email' })
    q.handle(sendEmail)

    const id = await q.dispatch(sendEmail, { to: 'alice@example.com' })

    const job = q.find(id)!
    expect(job.name).toBe('send-email')
    expect(job.queue).toBe('email')
  })

  it('handle(definition) registers the options the definition carries', async () => {
    const q = makeQueue()
    const nightly = defineJob('nightly', () => {}, {
      queue: 'maintenance', maxAttempts: 7, cron: '0 1 * * *',
    })
    q.handle(nightly)

    expect(q.nextRuns()[0]).toMatchObject({ name: 'nightly', cron: '0 1 * * *' })

    const id = await q.dispatch(nightly, {})
    expect(q.find(id)!.max_attempts).toBe(7)
  })

  it('runs the handler the definition holds', async () => {
    const seen: Array<{ to: string }> = []
    const q = makeQueue()
    const sendEmail = defineJob<{ to: string }>('send-email', (job: JobContext<{ to: string }>) => {
      seen.push(job.data)
    })

    q.handle(sendEmail)
    await q.start()
    await q.dispatch(sendEmail, { to: 'alice@example.com' })

    const deadline = Date.now() + 2_000
    while (seen.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    expect(seen).toEqual([{ to: 'alice@example.com' }])
  })
})

// ─── Lifetime ────────────────────────────────────────────────

describe('stop() and start() again', () => {

  it('runs work after a restart', async () => {
    // A worker holds the database and its prepared statements. stop() closes
    // that database, so a restart has to build both again — reusing the
    // workers polls through a closed handle.
    const path = `${resolve(import.meta.dir, '..')}/.tmp-restart-${process.pid}.db`
    const done: string[] = []
    const q = makeQueue({ db: path })

    q.handle('ping', () => { done.push('ran') })
    await q.start()
    await q.stop()

    await q.start()
    await q.dispatch('ping', {})

    const deadline = Date.now() + 2_000
    while (done.length === 0 && Date.now() < deadline) await Bun.sleep(10)
    await q.stop()

    const { rmSync } = await import('node:fs')
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })

    expect(done).toEqual(['ran'])
  })
})
