// src/services/jobs/jobs.service.ts
// Jobs — one-shot commands, scheduled cron jobs, triggered workflows.
// Each run is recorded as a JobRun with exit code and output.
//
// Mounted at /jobs. Custom methods dispatch on X-Service-Method:
//   trigger · cancel
//
// `service_id` is now `appId`: the model it points at is App, not Service.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, deriveSlug, narrowPatch, changesNothing, ws }
  from '../../core/resource.ts'
import { syncSchedule, unscheduleJob } from './job-schedule.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'
import jobRun from '../../jobs/job-run.job.ts'

/** Five fields: min hour dom month dow. */
function isValidCron(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5
}

export function createJobsService(app: BasecampApp) {

  async function assertAppInWorkspace(appId: string) {
    if (!await db().app.exists({ where: { id: appId, workspaceId: ws() } }))
      throw new NotFound(`App '${appId}' not found in this workspace`)
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

    async find(ctx: ServiceContext) {
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

    async create(ctx: ServiceContext) {
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

    hooks: {
      before: {
        all:     [sessionScope(app)],
        create:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), deriveSlug],
        patch:   [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove:  [requireWorkspaceRole(app, 'admin', 'owner')],
        trigger: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        cancel:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
    },
  })
}
