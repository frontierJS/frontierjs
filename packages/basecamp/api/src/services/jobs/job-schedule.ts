// src/services/jobs/job-schedule.ts
// The one place this app binds a Job row to a clock.
//
// A scheduled Job is a database ROW, so its schedule has the row's lifetime: it
// appears on create, changes on patch, and stops on cancel or delete. Caravan
// owns the clock (`FJS-D36`) — junction's `app.scheduler` is in-process and
// ephemeral, and reaching for it here bought a timer with none of the queue's
// durability, retry or principal.
//
// Three functions rather than a method somewhere, because the SERVICE is what
// knows a job changed and the APP is what restores them at boot; a shared
// module is what keeps the caravan name from being spelled in two places.

import type { BasecampApp } from '../../basecamp.types.ts'
import type { Job }         from '../../../../db/schema.d.ts'

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
        {
          queue: 'jobs',
          // STATED, not inherited. Nobody asked for this fire — a cron is the
          // app acting on its own behalf — and `job:run`'s handler branches on
          // exactly this: with an actor it confines its reads to that person's
          // workspace, without one it is the app and legitimately spans them
          // (`FJS-384`). Caravan defaults `actor` to whoever is in scope at
          // dispatch, and this callback runs on a timer where that is nobody,
          // so the default would be right by accident. Saying it is what makes
          // the handler's refusal meaningful.
          actor:  null,
          tenant: job.workspaceId,
        })
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

// ─── restoreSchedules ────────────────────────────────────────────────────────
//
// Re-register every live scheduled job from the database.
//
// A cron registration is in-process in both caravan and junction, so it does not
// survive a restart on its own — and the only place a Job's schedule was ever
// registered was the service's `create()`. Every scheduled job in the app
// therefore stopped firing at the first deploy, silently, with the row still
// saying `scheduled` in the UI (`FJS-327`). This is the half that makes the row
// the source of truth rather than the request that happened to create it.
//
// It reads rows, so it belongs to the app's boot rather than to a job file: the
// handler that RUNS a job has no reason to know how many were scheduled.

export async function restoreSchedules(app: BasecampApp): Promise<number> {
  const db  = app.data.asSystem()
  const log = app.logger.child('job-schedule')

  const jobs = await db.job.findMany({
    where: { kind: 'scheduled', status: { not: 'cancelled' } },
  })

  let restored = 0
  for (const job of jobs) {
    if (!job.cronExpression) continue
    try {
      scheduleJob(app, job)
      restored++
    } catch (err) {
      // One unparseable expression must not cost every other job its schedule.
      // It is already refused on the way in, so reaching this means a row that
      // predates the check or was written around it.
      log.error('could not restore schedule', {
        job_id: job.id, cron: job.cronExpression, error: (err as Error).message,
      })
    }
  }
  return restored
}
