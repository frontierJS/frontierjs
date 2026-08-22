// src/services/deployments/deployments.service.ts
// A Deployment is one release of an App to its Environment — a Manifest
// realized at a point in time (VISION.md §Where Basecamp Fits).
//
// Mounted at /deployments. Append-only from a person's point of view: creating
// one is a user action, advancing its status is the job's, and `remove` is
// a cancel rather than a delete — deployment history is the audit surface for
// "what is actually running", so it is never erased here.
//
// `service_id` is now `appId`. The join to app+environment is
// `include: { app: { include: { environment: true } } }` — declared in the
// schema rather than spelled out as SQL.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, getScoped, deriveSlug, changesNothing, ws, actor } from '../../core/resource.ts'
import { resolveExecutor, isExecutor } from '../../providers/executor.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'
import deploymentRun from '../../jobs/deployment-run.job.ts'

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

  function steps(deploymentId: string) {
    return db().deploymentStep.findMany({
      where:   { deploymentId },
      orderBy: { startedAt: 'asc' },
    })
  }

  return createService({
    name:  'deployments',
    model: 'Deployment',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination()
      const appId  = ($.query.appId ?? $.query.service_id) as string | undefined
      const status = $.query.status as string | undefined

      const { rows, total } = await db().deployment.findManyAndCount({
        where:   { workspaceId: ws(), ...(appId ? { appId } : {}), ...(status ? { status } : {}) },
        include: WITH_APP,
        orderBy: { queuedAt: 'desc' },
        limit, offset,
      })
      return { total, limit, offset, data: rows }
    },

    async get(ctx: ServiceContext) {
      const row = await db().deployment.findFirst({
        where:   { id: $.id as string, workspaceId: ws() },
        include: WITH_APP,
      })
      if (!row) throw new NotFound(`Deployment '${$.id}' not found`)
      return { ...row, steps: await steps(row.id) }
    },

    async create() {
      const data  = $.data as Record<string, unknown>
      const appId = data.appId as string

      const target = await db().app.findFirst({ where: { id: appId, workspaceId: ws() } })
      if (!target) throw new NotFound(`App '${appId}' not found in this workspace`)

      // Refused here, where the person who pressed the button is still looking.
      // The job asks the same question again when it runs — this is not
      // the enforcement, it is the message: a release created and failed a
      // second later tells an operator their app is broken, where a 400 naming
      // the missing placement tells them what to do (FJS-257).
      const executor = await resolveExecutor(app, appId)
      if (!isExecutor(executor)) throw new BadRequest(executor.reason)

      // What the app looked like at release time. `source`/`config` are Json
      // columns, so these are already objects — the old code JSON.parse'd them.
      data.configSnapshot = { source: target.source ?? {}, config: target.config ?? {} }
      data.environmentId  = target.environmentId
      data.triggeredBy    = actor() === 'system' ? null : actor()

      // Chain to the last successful release so a rollback knows where to go.
      const prev = await db().deployment.findFirst({
        where:   { appId, status: 'success' },
        orderBy: { finishedAt: 'desc' },
      })
      if (prev) data.previousDeploymentId = prev.id

      const deployment = await db().deployment.create({ data })

      await db().deploymentStep.createMany({
        data: buildInitialSteps(target.type).map(name => ({
          deploymentId: deployment.id, name, status: 'pending',
        })),
      })

      // Durable hand-off — survives a restart mid-release.
      await app.jobs.dispatch(deploymentRun, {
        deployment_id: deployment.id,
        app_id:        appId,
        workspace_id:  ws(),
      }, { queue: 'deployments', priority: 5 })

      return deployment
    },

    async patch() {
      const deployment = await getScoped('deployment', 'Deployment')

      // No terminal-state guard here. `@@transitions(status, …)` on Deployment
      // is the one statement of what a release may do next, and it is enforced
      // at the Data boundary — so a status this row cannot reach is refused
      // with a 409 that NAMES the moves it can make, which the list here never
      // did. What is left is the field allow-list, which is a different rule:
      // which columns a caller may write at all.
      const data  = $.data as Record<string, unknown>
      const ALLOWED = ['status', 'builtImage', 'startedAt', 'finishedAt', 'durationMs']
      const patch: Record<string, unknown> = {}
      for (const key of ALLOWED) if (key in data) patch[key] = data[key]

      if (changesNothing(patch)) return deployment

      const updated = await db().deployment.update({ where: { id: deployment.id }, data: patch })
      if (patch.status)
        app.events.emit(`deployment:${patch.status}`,
          { id: deployment.id, workspace_id: ws(), status: patch.status })

      return updated
    },

    // `remove` cancels an in-flight release. It does NOT delete the row: the
    // deployment record is how you answer "what shipped, when, by whom", and a
    // cancelled release is part of that answer.
    async remove() {
      const deployment = await getScoped('deployment', 'Deployment')

      // `cancel: [pending, building, pushing, deploying] -> cancelled` is the
      // guard, declared on the model. Writing the status IS the enforced path;
      // `transition()` is sugar for the move alone and this one stamps
      // `finishedAt` with it.
      const updated = await db().deployment.update({
        where: { id: deployment.id },
        data:  { status: 'cancelled', finishedAt: new Date().toISOString() },
      })
      app.events.emit('deployment:cancelled', { id: deployment.id, workspace_id: ws() })
      return updated
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), deriveSlug],
        patch:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
    },
  })
}
