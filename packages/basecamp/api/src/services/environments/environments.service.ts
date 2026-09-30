// src/services/environments/environments.service.ts
// Environments — a named deploy target inside a Project.
//
// Mounted at /environments. Its variables are `Variable` rows, at /variables.
//
// `model: 'Environment'` derives validation from db/schema.lite. The
// hand-written schemas here declared TIERS as five values while the schema enum
// had three — the schema has been widened to match, because the service was the
// older and better evidence of what a tier is.

import { createService, NotFound, Forbidden, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, refuseProtectedForDeveloper, WORKSPACE_QUERY }
  from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, assertSlugFree, deriveSlug, narrowPatch, changesNothing, ws }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

export function createEnvironmentsService(app: BasecampApp) {

  /**
   * An environment's project must be in the caller's workspace.
   *
   * Checked on create, because `projectId` arrives from the client: without it
   * a caller could attach an environment to another tenant's project by id.
   */
  async function assertProjectInWorkspace(projectId: string) {
    const project = await db().project.findFirst({ where: { id: projectId, workspaceId: ws() } })
    if (!project) throw new NotFound(`Project '${projectId}' not found in this workspace`)
  }

  return createService({
    name:  'environments',
    model: 'Environment',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find() {
      const { limit, offset } = getPagination()
      const projectId = ($.query.projectId ?? $.query.project_id) as string | undefined
      return findScoped('environment', {
        where:   projectId ? { projectId } : {},
        orderBy: { name: 'asc' },
        limit, offset,
      })
    },

    get: () => getScoped('environment', 'Environment'),

    async create() {
      const data = $.data as Record<string, unknown>
      await assertProjectInWorkspace(data.projectId as string)
      await assertSlugFree('environment', { projectId: data.projectId, slug: data.slug },
        `Environment slug '${data.slug}' already exists in this project`)

      const env = await db().environment.create({ data })
      app.events.emit('environment:created',
        { id: env.id, project_id: env.projectId, workspace_id: ws() })
      return env
    },

    async patch(ctx: ServiceContext) {
      const env = await getScoped('environment', 'Environment')

      refuseProtectedForDeveloper(env, ctx)

      // projectId and slug are @immutable and the schema refuses them by name.
      const patch = narrowPatch($.data as Record<string, unknown>)
      if (changesNothing(patch)) return env
      return db().environment.update({ where: { id: $.id as string }, data: patch })
    },

    async remove() {
      const env = await getScoped('environment', 'Environment')
      if (env.isProtected)
        throw new Forbidden('Cannot delete a protected environment — unprotect it first')

      // @@softDelete(cascade) — this stamps the environment's Apps and Jobs too.
      const removed = await removeScoped('environment', 'Environment')
      app.events.emit('environment:deleted', { id: $.id })
      return removed
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), deriveSlug],
        patch:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
