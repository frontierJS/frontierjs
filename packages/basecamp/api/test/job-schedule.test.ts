// api/test/job-schedule.test.ts
//
// The clock has to agree with the Job row, and it did not.
//
// A scheduled Job is a database row, so its schedule has the row's lifetime.
// Registration only ever happened in the service's `create()`, against
// junction's in-process `app.scheduler`, and nothing anywhere unregistered —
// so an edit kept the old schedule (`FJS-328`) and a restart lost every
// schedule in the app (`FJS-327`).
//
// Against a REAL Caravan queue rather than a stand-in: the whole claim is about
// what a scheduler holds after a sequence of calls, and a fake answers whatever
// it was written to answer — which is how the original went unnoticed.

import { describe, it, expect, afterEach } from 'bun:test'
import { createCaravan } from '@frontierjs/caravan'
import type { CaravanInstance } from '@frontierjs/caravan'

import { syncSchedule, unscheduleJob, scheduleName } from '../src/engine/job-schedule.ts'
import type { BasecampApp } from '../src/basecamp.types.ts'

const queues: CaravanInstance[] = []
afterEach(async () => { for (const q of queues.splice(0)) await q.stop() })

/** An app that is nothing but a real queue — all these functions touch. */
function makeApp(): { app: BasecampApp; jobs: CaravanInstance } {
  const jobs = createCaravan({ db: ':memory:', pollInterval: 20 })
  queues.push(jobs)
  return { app: { jobs } as unknown as BasecampApp, jobs }
}

const row = (over: Record<string, unknown> = {}) => ({
  id:             'job-1',
  kind:           'scheduled',
  status:         'pending',
  cronExpression: '0 2 * * *',
  workspaceId:    'ws-1',
  ...over,
}) as never

const scheduled = (jobs: CaravanInstance) =>
  jobs.nextRuns().map(r => ({ name: r.name, cron: r.cron }))

describe('syncSchedule — the clock agrees with the row', () => {

  it('a scheduled job with an expression is on the clock', () => {
    const { app, jobs } = makeApp()
    syncSchedule(app, row())

    expect(scheduled(jobs)).toEqual([{ name: scheduleName('job-1'), cron: '0 2 * * *' }])
  })

  it('editing the expression REPLACES the schedule rather than adding one', () => {
    // The filed defect (FJS-328), stated as a test: patch() validated the new
    // expression and never touched the clock, so the old one kept firing.
    const { app, jobs } = makeApp()
    syncSchedule(app, row())
    syncSchedule(app, row({ cronExpression: '0 5 * * *' }))

    expect(scheduled(jobs)).toEqual([{ name: scheduleName('job-1'), cron: '0 5 * * *' }])
  })

  it('a cancelled job comes off the clock', () => {
    const { app, jobs } = makeApp()
    syncSchedule(app, row())
    syncSchedule(app, row({ status: 'cancelled' }))

    expect(scheduled(jobs)).toEqual([])
  })

  it('a job that stops being scheduled comes off the clock', () => {
    // `kind` is as patchable as the expression, so an edit has to move a job in
    // BOTH directions — off the clock is the direction nothing did before.
    const { app, jobs } = makeApp()
    syncSchedule(app, row())
    syncSchedule(app, row({ kind: 'one_shot' }))

    expect(scheduled(jobs)).toEqual([])
  })

  it('a scheduled job with no expression is not on the clock', () => {
    const { app, jobs } = makeApp()
    syncSchedule(app, row({ cronExpression: null }))

    expect(scheduled(jobs)).toEqual([])
  })

  it('one job coming off the clock leaves the others on it', () => {
    const { app, jobs } = makeApp()
    syncSchedule(app, row())
    syncSchedule(app, row({ id: 'job-2', cronExpression: '0 3 * * *' }))

    unscheduleJob(app, 'job-1')

    expect(scheduled(jobs)).toEqual([{ name: scheduleName('job-2'), cron: '0 3 * * *' }])
  })

  it('unscheduling leaves the run handler registered', async () => {
    // Unbinding the clock is not removing the work: a run already queued when
    // the schedule was dropped still has to find something to execute.
    const { app, jobs } = makeApp()
    syncSchedule(app, row())
    unscheduleJob(app, 'job-1')

    const id = await jobs.dispatch(scheduleName('job-1'), {})
    expect(jobs.find(id)!.queue).toBe('jobs')
  })
})
