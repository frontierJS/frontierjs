// src/services/deployments/deployments.service.ts
// A Deployment is one release of an App to its Environment — a Manifest
// realized at a point in time (VISION.md §Where Basecamp Fits).
//
// Mounted at /deployments. Append-only from a person's point of view: creating
// one is a user action, advancing its status is the engine's, and `remove` is
// a cancel rather than a delete — deployment history is the audit surface for
// "what is actually running", so it is never erased here.
//
// `service_id` is now `appId`. The join to app+environment is
// `include: { app: { include: { environment: true } } }` — declared in the
// schema rather than spelled out as SQL.

import { createService, NotFound, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import { getScoped, stampWorkspace, changesNothing, dbOf, wsOf, actorOf } from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

const WITH_APP = { app: { include: { environment: true } } }

/** The step list a deployment starts with, by app type. */
function buildInitialSteps(appType: string): string[] {
  if (appType === 'container' || appType === 'function')
    return ['Validate', 'Build image', 'Push image', 'Stop previous', 'Start container', 'Health check']
  if (appType === 'static')
    return ['Validate', 'Build assets', 'Upload to storage', 'Invalidate CDN cache']
  if (appType === 'database')
    return ['Validate', 'Run migrations', 'Verify connectivity']
  return ['Validate', 'Pull image', 'Stop previous', 'Start container', 'Health check']
}

export function createDeploymentsService(app: BasecampApp) {

  function steps(ctx: ServiceContext, deploymentId: string) {
    return dbOf(ctx).deploymentStep.findMany({
      where:   { deploymentId },
      orderBy: { startedAt: 'asc' },
    })
  }

  return createService({
    name:  'deployments',
    model: 'Deployment',

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const appId  = (ctx.query.appId ?? ctx.query.service_id) as string | undefined
      const status = ctx.query.status as string | undefined

      const { rows, total } = await dbOf(ctx).deployment.findManyAndCount({
        where:   { workspaceId: wsOf(ctx), ...(appId ? { appId } : {}), ...(status ? { status } : {}) },
        include: WITH_APP,
        orderBy: { queuedAt: 'desc' },
        limit, offset,
      })
      return { total, limit, offset, data: rows }
    },

    async get(ctx: ServiceContext) {
      const row = await dbOf(ctx).deployment.findFirst({
        where:   { id: ctx.id as string, workspaceId: wsOf(ctx) },
        include: WITH_APP,
      })
      if (!row) throw new NotFound(`Deployment '${ctx.id}' not found`)
      return { ...row, steps: await steps(ctx, row.id) }
    },

    async create(ctx: ServiceContext) {
      const data  = ctx.data as Record<string, unknown>
      const appId = data.appId as string

      const target = await dbOf(ctx).app.findFirst({ where: { id: appId, workspaceId: wsOf(ctx) } })
      if (!target) throw new NotFound(`App '${appId}' not found in this workspace`)

      // What the app looked like at release time. `source`/`config` are Json
      // columns, so these are already objects — the old code JSON.parse'd them.
      data.configSnapshot = { source: target.source ?? {}, config: target.config ?? {} }
      data.environmentId  = target.environmentId
      data.triggeredBy    = actorOf(ctx) === 'system' ? null : actorOf(ctx)

      // Chain to the last successful release so a rollback knows where to go.
      const prev = await dbOf(ctx).deployment.findFirst({
        where:   { appId, status: 'success' },
        orderBy: { finishedAt: 'desc' },
      })
      if (prev) data.previousDeploymentId = prev.id

      const deployment = await dbOf(ctx).deployment.create({ data })

      await dbOf(ctx).deploymentStep.createMany({
        data: buildInitialSteps(target.type).map(name => ({
          deploymentId: deployment.id, name, status: 'pending',
        })),
      })

      // Durable hand-off — survives a restart mid-release.
      await app.jobs.dispatch('deployment:run', {
        deployment_id: deployment.id,
        app_id:        appId,
        workspace_id:  wsOf(ctx),
      }, { queue: 'deployments', priority: 5 })

      return deployment
    },

    async patch(ctx: ServiceContext) {
      const deployment = await getScoped(ctx, 'deployment', 'Deployment')

      // No terminal-state guard here. `@@transitions(status, …)` on Deployment
      // is the one statement of what a release may do next, and it is enforced
      // at the Data boundary — so a status this row cannot reach is refused
      // with a 409 that NAMES the moves it can make, which the list here never
      // did. What is left is the field allow-list, which is a different rule:
      // which columns a caller may write at all.
      const data  = ctx.data as Record<string, unknown>
      const ALLOWED = ['status', 'builtImage', 'startedAt', 'finishedAt', 'durationMs']
      const patch: Record<string, unknown> = {}
      for (const key of ALLOWED) if (key in data) patch[key] = data[key]

      if (changesNothing(patch)) return deployment

      const updated = await dbOf(ctx).deployment.update({ where: { id: deployment.id }, data: patch })
      if (patch.status)
        app.events.emit(`deployment:${patch.status}`,
          { id: deployment.id, workspace_id: wsOf(ctx), status: patch.status })

      return updated
    },

    // `remove` cancels an in-flight release. It does NOT delete the row: the
    // deployment record is how you answer "what shipped, when, by whom", and a
    // cancelled release is part of that answer.
    async remove(ctx: ServiceContext) {
      const deployment = await getScoped(ctx, 'deployment', 'Deployment')

      // `cancel: [pending, building, pushing, deploying] -> cancelled` is the
      // guard, declared on the model. Writing the status IS the enforced path;
      // `transition()` is sugar for the move alone and this one stamps
      // `finishedAt` with it.
      const updated = await dbOf(ctx).deployment.update({
        where: { id: deployment.id },
        data:  { status: 'cancelled', finishedAt: new Date().toISOString() },
      })
      app.events.emit('deployment:cancelled', { id: deployment.id, workspace_id: wsOf(ctx) })
      return updated
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), stampWorkspace],
        patch:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}
