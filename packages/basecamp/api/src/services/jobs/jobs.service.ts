// src/services/jobs/jobs.service.ts
// Jobs — one-shot commands, scheduled cron jobs, triggered workflows.
// Each run is recorded as a JobRun with exit code and output.
//
// Mounted at /jobs. Custom methods dispatch on X-Service-Method:
//   trigger · cancel
//
// `service_id` is now `appId`: the model it points at is App, not Service.

import { createService, NotFound, BadRequest, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, stampWorkspace, narrowPatch, changesNothing, dbOf, wsOf }
  from '../../core/resource.ts'
import { syncSchedule, unscheduleJob } from '../../engine/job-schedule.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

/** Five fields: min hour dom month dow. */
function isValidCron(expr: string): boolean {
  return expr.trim().split(/\s+/).length === 5
}

export function createJobsService(app: BasecampApp) {

  async function assertAppInWorkspace(ctx: ServiceContext, appId: string) {
    if (!await dbOf(ctx).app.exists({ where: { id: appId, workspaceId: wsOf(ctx) } }))
      throw new NotFound(`App '${appId}' not found in this workspace`)
  }

  return createService({
    name:  'jobs',
    model: 'Job',

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const appId  = (ctx.query.appId ?? ctx.query.service_id) as string | undefined
      const kind   = ctx.query.kind   as string | undefined
      const status = ctx.query.status as string | undefined

      return findScoped(ctx, 'job', {
        where: { ...(appId ? { appId } : {}), ...(kind ? { kind } : {}), ...(status ? { status } : {}) },
        limit, offset,
      })
    },

    async get(ctx: ServiceContext) {
      const job = await getScoped(ctx, 'job', 'Job')
      const recent_runs = await dbOf(ctx).jobRun.findMany({
        where:   { jobId: job.id },
        orderBy: { startedAt: 'desc' },
        limit:   5,
      })
      return { ...job, recent_runs }
    },

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>

      if (data.kind === 'scheduled') {
        if (!data.cronExpression)
          throw new BadRequest('cronExpression is required for scheduled jobs')
        if (!isValidCron(data.cronExpression as string))
          throw new BadRequest('Invalid cron expression — expected 5 fields (min hour dom month dow)')
      }

      if (data.appId) await assertAppInWorkspace(ctx, data.appId as string)

      // A scheduled job's first run is a minute out, so the row is visible in
      // the UI before the scheduler picks it up.
      if (data.kind === 'scheduled')
        data.nextRunAt = new Date(Date.now() + 60_000).toISOString()

      const job  = await dbOf(ctx).job.create({ data })
      const wsId = wsOf(ctx)

      if (job.kind === 'one_shot')
        await app.jobs.dispatch('job:run', { id: job.id, workspace_id: wsId }, { queue: 'jobs' })

      syncSchedule(app, job)

      return job
    },

    async patch(ctx: ServiceContext) {
      await getScoped(ctx, 'job', 'Job')
      const data = ctx.data as Record<string, unknown>

      if (data.cronExpression && !isValidCron(data.cronExpression as string))
        throw new BadRequest('Invalid cron expression')

      // kind, status, appId and the run bookkeeping belong to the engine.
      const patch = narrowPatch(data, ['kind', 'status', 'appId', 'retryCount', 'lastRunAt', 'lastRunStatus', 'nextRunAt'])
      if (changesNothing(patch)) return getScoped(ctx, 'job', 'Job')

      const updated = await dbOf(ctx).job.update({ where: { id: ctx.id as string }, data: patch })
      // Off the UPDATED row, not off the patch: `cronExpression` is only one of
      // the ways a job's schedule changes, and the row is what the clock has to
      // agree with either way.
      syncSchedule(app, updated)
      return updated
    },

    async remove(ctx: ServiceContext) {
      const job = await getScoped(ctx, 'job', 'Job')
      // Cancel as well as delete — a soft-deleted job left 'pending' would still
      // be picked up by anything reading status without the deletedAt filter.
      //
      // Guarded on the current status, because `cancelled -> cancelled` is not
      // a transition and the Data boundary now refuses it: removing an already
      // cancelled job used to be a silent no-op write and would otherwise start
      // failing with a 409.
      if (job.status !== 'cancelled')
        await dbOf(ctx).job.update({ where: { id: ctx.id as string }, data: { status: 'cancelled' } })
      const removed = await removeScoped(ctx, 'job', 'Job')
      // A soft-deleted row is invisible to every read, so a schedule still
      // holding its id would dispatch runs for a job nobody can see.
      unscheduleJob(app, ctx.id as string)
      app.events.emit('job:deleted', { id: ctx.id })
      return removed
    },

    // ── trigger ───────────────────────────────────────────────────────
    async trigger(ctx: ServiceContext) {
      const job = await getScoped(ctx, 'job', 'Job')
      if (job.status === 'running') throw new BadRequest('Job is already running')

      await app.jobs.dispatch('job:run',
        { id: job.id, workspace_id: wsOf(ctx), trigger: 'manual' },
        { queue: 'jobs', priority: 10 })

      // The whole row plus the ack, not `{ id, queued }` on its own. A client
      // that assigns a method's result over the record it is rendering keeps
      // every field this way; the third time this pattern bit (setVariable,
      // the deployment engine's projection, the server heartbeat) it stopped
      // being a coincidence.
      return { ...job, queued: true }
    },

    // ── cancel ────────────────────────────────────────────────────────
    async cancel(ctx: ServiceContext) {
      const job = await getScoped(ctx, 'job', 'Job')

      // `cancel: [pending, running, failed] -> cancelled` on the model is the
      // guard. A 409 naming the moves this job CAN make beats a 400 that only
      // says which one it cannot.
      const updated = await dbOf(ctx).job.update({ where: { id: job.id }, data: { status: 'cancelled' } })
      unscheduleJob(app, job.id)
      app.events.emit('job:cancelled', { id: job.id, workspace_id: wsOf(ctx) })
      return updated
    },

    hooks: {
      before: {
        all:     [sessionScope(app)],
        create:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), stampWorkspace],
        patch:   [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove:  [requireWorkspaceRole(app, 'admin', 'owner')],
        trigger: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        cancel:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}
