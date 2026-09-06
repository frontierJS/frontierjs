// src/services/jobs/jobs.service.ts
// Jobs — one-shot commands, scheduled cron jobs, triggered workflows.
// Each run is recorded as a JobRun with exit code and output.
//
// Mounted at /jobs. Custom methods dispatch on X-Service-Method:
//   trigger · cancel
//
// `service_id` is now `appId`: the model it points at is App, not Service.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, internalOnly, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, narrowPatch, changesNothing, ws }
  from '../../core/resource.ts'
import { syncSchedule, unscheduleJob } from './job-schedule.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import jobRun from '../../jobs/job-run.job.ts'
import { announce } from '../../channels.ts'

/** Five fields: min hour dom month dow. */
function isValidCron(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5
}

export function createJobsService(app: BasecampApp) {

  async function assertAppInWorkspace(appId: string) {
    if (!await db().app.exists({ where: { id: appId, workspaceId: ws() } }))
      throw new NotFound(`App '${appId}' not found in this workspace`)
  }


  /** `JobRun` is `@@gate("2.8")` — created and updated by the machine alone. */
  const sys = () => $.db.asSystem() as any

  /**
   * The job this call is about — through the CALLER's client where there is a
   * caller, and through the system client where there is not.
   *
   * `job:run` is the one job here dispatched BOTH ways (`FJS-384`): a person
   * triggers it, and a cron fires it with no actor at all. The confinement is
   * the scoped read — a job in another workspace answers nothing — and it
   * applies exactly when there is somebody to confine to. A cron fire is the
   * app acting on its own behalf and legitimately spans workspaces, which is
   * what `runsAsApp` in the handler declares.
   */
  async function jobInScope(jobId: string) {
    const client = $.auth?.user ? db() : sys()
    const row    = await client.job.findUnique({ where: { id: jobId } })
    if (!row) throw new NotFound(`Job '${jobId}' not found`)
    return row as Record<string, any>
  }

  /** The whole row, announced to the workspace the ROW names — `ws()` is the
   *  request's workspace and a cron fire has no request. */
  async function pushJob(jobId: string, workspaceId: string) {
    const row = await sys().job.findUnique({ where: { id: jobId } })
    if (row) announce(app, workspaceId, 'jobs patched', row)
    return row
  }

  return createService({
    name:  'jobs',
    model: 'Job',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find() {
      const { limit, offset } = getPagination()
      const appId  = ($.query.appId ?? $.query.service_id) as string | undefined
      const kind   = $.query.kind   as string | undefined
      const status = $.query.status as string | undefined

      return findScoped('job', {
        where: { ...(appId ? { appId } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
        limit, offset,
      })
    },

    async get() {
      const job = await getScoped('job', 'Job')
      const recent_runs = await db().jobRun.findMany({
        where:   { jobId: job.id },
        orderBy: { startedAt: 'desc' },
        limit:   5,
      })
      return { ...job, recent_runs }
    },

    async create() {
      const data = $.data as Record<string, unknown>

      if (data.kind === 'scheduled') {
        if (!data.cronExpression)
          throw new BadRequest('cronExpression is required for scheduled jobs')
        if (!isValidCron(data.cronExpression as string))
          throw new BadRequest('Invalid cron expression — expected 5 fields (min hour dom month dow)')
      }

      if (data.appId) await assertAppInWorkspace(data.appId as string)

      // A scheduled job's first run is a minute out, so the row is visible in
      // the UI before the scheduler picks it up.
      if (data.kind === 'scheduled')
        data.nextRunAt = new Date(Date.now() + 60_000).toISOString()

      const job  = await db().job.create({ data })
      const wsId = ws()

      if (job.kind === 'one_shot')
        await app.jobs.dispatch(jobRun, { id: job.id, workspace_id: wsId }, { queue: 'jobs' })

      syncSchedule(app, job)

      return job
    },

    async patch() {
      await getScoped('job', 'Job')
      const data = $.data as Record<string, unknown>

      if (data.cronExpression && !isValidCron(data.cronExpression as string))
        throw new BadRequest('Invalid cron expression')

      // kind, status, appId and the run bookkeeping belong to the job.
      const patch = narrowPatch(data, ['kind', 'status', 'appId', 'retryCount', 'lastRunAt', 'lastRunStatus', 'nextRunAt'])
      if (changesNothing(patch)) return getScoped('job', 'Job')

      const updated = await db().job.update({ where: { id: $.id as string }, data: patch })
      // Off the UPDATED row, not off the patch: `cronExpression` is only one of
      // the ways a job's schedule changes, and the row is what the clock has to
      // agree with either way.
      syncSchedule(app, updated)
      return updated
    },

    async remove() {
      const job = await getScoped('job', 'Job')
      // Cancel as well as delete — a soft-deleted job left 'pending' would still
      // be picked up by anything reading status without the deletedAt filter.
      //
      // Guarded on the current status, because `cancelled -> cancelled` is not
      // a transition and the Data boundary now refuses it: removing an already
      // cancelled job used to be a silent no-op write and would otherwise start
      // failing with a 409.
      if (job.status !== 'cancelled')
        await db().job.update({ where: { id: $.id as string }, data: { status: 'cancelled' } })
      const removed = await removeScoped('job', 'Job')
      // A soft-deleted row is invisible to every read, so a schedule still
      // holding its id would dispatch runs for a job nobody can see.
      unscheduleJob(app, $.id as string)
      app.events.emit('job:deleted', { id: $.id })
      return removed
    },

    // ── trigger ───────────────────────────────────────────────────────
    async trigger() {
      const job = await getScoped('job', 'Job')
      if (job.status === 'running') throw new BadRequest('Job is already running')

      await app.jobs.dispatch(jobRun,
        { id: job.id, workspace_id: ws(), trigger: 'manual' },
        { queue: 'jobs', priority: 10 })

      // The whole row plus the ack, not `{ id, queued }` on its own. A client
      // that assigns a method's result over the record it is rendering keeps
      // every field this way; the third time this pattern bit (setVariable,
      // the deploy job's projection, the server heartbeat) it stopped
      // being a coincidence.
      return { ...job, queued: true }
    },

    // ── cancel ────────────────────────────────────────────────────────
    async cancel() {
      const job = await getScoped('job', 'Job')

      // `cancel: [pending, running, failed] -> cancelled` on the model is the
      // guard. A 409 naming the moves this job CAN make beats a 400 that only
      // says which one it cannot.
      const updated = await db().job.update({ where: { id: job.id }, data: { status: 'cancelled' } })
      unscheduleJob(app, job.id)
      app.events.emit('job:cancelled', { id: job.id, workspace_id: ws() })
      return updated
    },


    // ── The engine's writes ───────────────────────────────────────────
    //
    // `job:run` used to open `asSystem()` and write these itself. `JobRun` is
    // `@@gate("2.8")` — created and updated by the machine — so what moves here
    // is not the standing but the CONFINEMENT and the announcement, which the
    // handler had to remember to do and once did not (`FJS-384`).

    async startRun() {
      const job     = await jobInScope(String($.id))
      const trigger = (($.data ?? {}) as { trigger?: string }).trigger ?? 'manual'

      // The ROW is the truth about whether this should run, not the thing that
      // dispatched it: a cancel stamps the row, and a run already queued when
      // it happened is still in the queue.
      if (job.status === 'cancelled') return { runnable: false, status: job.status }

      const startedAt = new Date().toISOString()
      const run = await sys().jobRun.create({
        data: { jobId: job.id, status: 'running', trigger, startedAt },
      })
      await sys().job.update({
        where: { id: job.id },
        data:  { status: 'running', lastRunAt: startedAt },
      })
      await pushJob(job.id, job.workspaceId)

      return { runnable: true, runId: run.id, job, startedAt }
    },

    async finishRun() {
      const job = await jobInScope(String($.id))
      const { runId, status, output, error, exitCode, startedAt } = ($.data ?? {}) as {
        runId: string; status: 'success' | 'failed'; output?: string
        error?: string; exitCode?: number; startedAt?: string
      }

      const finishedAt = Date.now()
      const startedMs  = startedAt ? Date.parse(startedAt) : finishedAt

      // Addressed by the job as well as the run, so a run id from another job
      // cannot be closed through this method.
      await sys().jobRun.updateMany({
        where: { id: runId, jobId: job.id },
        data:  {
          status,
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs: finishedAt - startedMs,
          exitCode:   exitCode ?? (status === 'success' ? 0 : 1),
          // Json column — an object, never a string.
          ...(status === 'success' ? { output: { stdout: output ?? '' } } : { error }),
        },
      })

      await sys().job.update({
        where: { id: job.id },
        data:  status === 'success'
          ? { status: 'pending', lastRunStatus: 'success', retryCount: 0 }
          : { status: 'failed',  lastRunStatus: 'failed' },
      })

      app.events.emit(status === 'success' ? 'job:success' : 'job:failed',
        { job_id: job.id, run_id: runId, ...(error ? { error } : {}) })
      await pushJob(job.id, job.workspaceId)

      return { runId, status }
    },

    hooks: {
      before: {
        // The engine's two are exempt from the session scope, the way
        // invitations' two are and for the same kind of reason: `job:run` is
        // also fired by a cron, where there is no session to authenticate and
        // no header to name a workspace. `internalOnly` is what guards them —
        // they are unreachable off the wire — and `jobInScope` is what confines
        // them where there IS a caller.
        all:     [sessionScope(app, { except: ['startRun', 'finishRun'] })],
        // No deriveSlug: `Job` has no `slug` column, so the shared hook stamped a
        // key the model does not declare and the write dropped it in silence.
        create:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        patch:   [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove:  [requireWorkspaceRole(app, 'admin', 'owner')],
        trigger: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        startRun:  [internalOnly()],
        finishRun: [internalOnly()],
        cancel:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
    },
  })
}
