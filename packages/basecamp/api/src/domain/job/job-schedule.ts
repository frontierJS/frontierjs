// src/domain/job/job-schedule.ts
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

import { parseCron }        from '@frontierjs/toolbelt/cron'
import { queueBackup }      from '../../jobs/backup-run.job.ts'
import { hubApp, isHubApp } from '../host/host-machine.ts'
import appBackupRun         from '../../jobs/app-backup-run.job.ts'
import appDrillRun          from '../../jobs/app-drill-run.job.ts'
import type { App }         from '@frontierjs/junction'
import type { App as AppRow, Job } from '../../../../db/schema.d.ts'

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
  app: App,
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
export function unscheduleJob(app: App, jobId: string): void {
  app.jobs.unschedule(scheduleName(jobId))
}

/**
 * When the clock will next fire a job, asked of the clock itself.
 *
 * Not a column: nothing but the scheduler knows the answer, so a stored copy is
 * a second answer that goes stale — the one this app had was written once on
 * create as *a minute from now* and shown to an operator for ever after
 * (`FJS-1241`). `null` is a job the clock does not hold, which is every job
 * `syncSchedule` took off it.
 */
export function nextRunAt(app: App, jobId: string): string | null {
  const name = scheduleName(jobId)
  const next = app.jobs.nextRuns().find(r => r.name === name)?.nextRun
  return next ? next.toISOString() : null
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
  app: App,
  job: Pick<Job, 'id' | 'kind' | 'status' | 'cronExpression' | 'workspaceId'>,
): void {
  const onTheClock = job.kind === 'scheduled'
    && !!job.cronExpression
    && job.status !== 'cancelled'

  if (onTheClock) scheduleJob(app, job)
  else            unscheduleJob(app, job.id)
}

// ─── The hub's backup ───────────────────────────────────────────────────────
//
// The hub's schedule is its App row's `backupCron` (`FJS-D1606`), so it is on
// the clock as every app's is, under `appBackupSchedule`. Only the fire
// differs: the hub App's volume is not where its databases are, so its fire
// takes the hub archive rather than dispatching `app-backup:run`.

/** The refusal for an expression the clock cannot hold, or null. Asked before
 *  the row is written, so a save never stores a schedule that then fails to
 *  register. */
export function cronProblem(expr: string): string | null {
  try { parseCron(expr); return null }
  catch (err) { return (err as Error).message }
}

/**
 * Take one scheduled hub archive. The destination is the hub App's, read at
 * FIRE time, so changing it needs no re-registration.
 *
 * A fire that finds an archive still in flight skips rather than queues behind
 * it — the next one is a whole interval away, and two back to back are the
 * same bytes twice.
 */
export async function fireBackup(app: App): Promise<void> {
  const log = app.logger.child('job-schedule')
  const hub = await hubApp(app.db!.asSystem())
  if (!hub?.backupCron || hub.deletedAt) return

  const queued = await queueBackup(app, {
    kind: 'scheduled', destinationId: hub.backupDestinationId ?? null, requestedBy: null,
  })
  if ('inFlight' in queued) log.warn('scheduled backup skipped', { in_flight: queued.inFlight.status })
}

// ─── An app's backup ────────────────────────────────────────────────────────
//
// `App.backupCron` is on the clock while it is set and the app is not deleted
// (`IDEAS/backups.md` 1.6). One name per app, derived from the row id as a
// Job's is, so a patch replaces the registration. The fire dispatches
// `app-backup:run`, or takes the hub archive when the row is the hub App's;
// both read the row again — the bucket, the cron and the deletion are all
// fire-time facts, so changing any of them needs no re-registration but
// clearing the cron, which `syncAppBackupSchedule` does.

export const appBackupSchedule = (appId: string): string => `app:backup:${appId}`

/** Make the clock agree with the app row. */
export function syncAppBackupSchedule(app: App, row: Pick<AppRow, 'id' | 'backupCron' | 'deletedAt'>): void {
  if (row.backupCron && !row.deletedAt)
    app.jobs.schedule(
      appBackupSchedule(row.id),
      row.backupCron,
      async () => {
        if (await isHubApp(app.db!.asSystem(), row.id)) return fireBackup(app)
        // `actor: null`: nobody asked, and the handler declares `runsAsApp`.
        await app.jobs.dispatch(appBackupRun, { appId: row.id }, { queue: 'fleet', priority: 5, actor: null })
      },
      { queue: 'fleet' },
    )
  else
    app.jobs.unschedule(appBackupSchedule(row.id))
}

// ─── An app's drill ─────────────────────────────────────────────────────────
//
// `App.drillCron`, the same rule over the other column (`IDEAS/backups.md`
// 3.3): the fire dispatches `app-drill:run`, which reads the row again.

export const appDrillSchedule = (appId: string): string => `app:drill:${appId}`

/** Make the drill's clock agree with the app row. */
export function syncAppDrillSchedule(app: App, row: Pick<AppRow, 'id' | 'drillCron' | 'deletedAt'>): void {
  if (row.drillCron && !row.deletedAt)
    app.jobs.schedule(
      appDrillSchedule(row.id),
      row.drillCron,
      async () => { await app.jobs.dispatch(appDrillRun, { appId: row.id }, { queue: 'fleet', priority: 5, actor: null }) },
      { queue: 'fleet' },
    )
  else
    app.jobs.unschedule(appDrillSchedule(row.id))
}

// ─── restoreSchedules ────────────────────────────────────────────────────────
//
// Re-register every schedule the database holds: each live scheduled job and
// each app's backup and drill, the hub App's among them.
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

export async function restoreSchedules(app: App): Promise<number> {
  const db  = app.db!.asSystem()
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

  // The system client reads past `@@softDelete`, so the deleted are filtered
  // here: a deleted app's schedule would otherwise fire at 02:00.
  const apps = await db.app.findMany({ where: { backupCron: { not: null }, deletedAt: null } })
  for (const row of apps) {
    try {
      syncAppBackupSchedule(app, row)
      restored++
    } catch (err) {
      log.error('could not restore an app backup schedule', { app_id: row.id, cron: row.backupCron, error: (err as Error).message })
    }
  }
  const drilled = await db.app.findMany({ where: { drillCron: { not: null }, deletedAt: null } })
  for (const row of drilled) {
    try {
      syncAppDrillSchedule(app, row)
      restored++
    } catch (err) {
      log.error('could not restore an app drill schedule', { app_id: row.id, cron: row.drillCron, error: (err as Error).message })
    }
  }
  return restored
}
