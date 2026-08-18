// src/engine/job-schedule.ts
// The one place this app binds a Job row to a clock.
//
// A scheduled Job is a database ROW, so its schedule has the row's lifetime: it
// appears on create, changes on patch, and stops on cancel or delete. Caravan
// owns the clock (`FJS-D36`) — junction's `app.scheduler` is in-process and
// ephemeral, and reaching for it here bought a timer with none of the queue's
// durability, retry or principal.
//
// Two functions rather than a method on the engine, because the SERVICE is what
// knows a job changed and the ENGINE is what restores them at boot; a shared
// module is what keeps the caravan name from being spelled in two places.

import type { BasecampApp } from '../basecamp.types.ts'
import type { Job }         from '../../../db/schema.d.ts'

/**
 * The caravan registration name for a job's schedule.
 *
 * Derived from the row id, which is what makes re-registering a job REPLACE its
 * schedule rather than add a second one — caravan keys a schedule by name and
 * two entries under one name fired the job twice a minute.
 */
export const scheduleName = (jobId: string): string => `job:cron:${jobId}`

/** Register — or replace — a scheduled job's cron. A job with none is a no-op. */
export function scheduleJob(
  app: BasecampApp,
  job: Pick<Job, 'id' | 'cronExpression' | 'workspaceId'>,
): void {
  if (!job.cronExpression) return

  app.jobs.schedule(
    scheduleName(job.id),
    job.cronExpression,
    async () => {
      await app.jobs.dispatch('job:run',
        { id: job.id, workspace_id: job.workspaceId, trigger: 'scheduled' },
        { queue: 'jobs' })
    },
    { queue: 'jobs' },
  )
}

/**
 * Stop a job's cron firing.
 *
 * The `job:run` handler stays registered — a run already queued under it still
 * has to find something to execute. This unbinds the clock and nothing else.
 */
export function unscheduleJob(app: BasecampApp, jobId: string): void {
  app.jobs.unschedule(scheduleName(jobId))
}

/**
 * Make the clock agree with the row — the whole rule, in one place.
 *
 * A job is on the clock when it is `scheduled`, carries an expression, and has
 * not been cancelled; otherwise it is off it. Stating that once is what makes a
 * patch safe: `cronExpression` is patchable, and so is the row stopping being a
 * scheduled job at all, so an edit has to be able to move a job in EITHER
 * direction. `patch()` used to validate a new expression and never touch the
 * clock, so an edit was accepted, shown in the UI, and the old schedule kept
 * firing.
 */
export function syncSchedule(
  app: BasecampApp,
  job: Pick<Job, 'id' | 'kind' | 'status' | 'cronExpression' | 'workspaceId'>,
): void {
  const onTheClock = job.kind === 'scheduled'
    && !!job.cronExpression
    && job.status !== 'cancelled'

  if (onTheClock) scheduleJob(app, job)
  else            unscheduleJob(app, job.id)
}
