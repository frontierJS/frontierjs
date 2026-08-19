// src/services/projects/projects.service.ts
// Projects — the unit a workspace organises environments under.
//
// Mounted at /projects. Zero raw SQL: every read and write goes through the
// caller-scoped Litestone client on ctx.locals.db.
//
// The hand-written CreateProjectSchema/PatchProjectSchema are gone.
// `model: 'Project'` derives validation from db/schema.lite, so the field
// rules live in one place instead of two that drift — `name` was capped at 80
// in both, but only the schema knew `slug` had to be unique per workspace.

import { createService } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, assertSlugFree, stampWorkspace, narrowPatch, changesNothing, dbOf, wsOf }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

export function createProjectsService(app: BasecampApp) {
  return createService({
    name:  'projects',
    model: 'Project',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const status = ctx.query.status as string | undefined
      return findScoped(ctx, 'project', { where: status ? { status } : {}, limit, offset })
    },

    get: (ctx: ServiceContext) => getScoped(ctx, 'project', 'Project'),

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      await assertSlugFree(ctx, 'project', { workspaceId: wsOf(ctx), slug: data.slug },
        `Project slug '${data.slug}' already exists in this workspace`)

      const project = await dbOf(ctx).project.create({ data })
      app.events.emit('project:created', { id: project.id, workspace_id: wsOf(ctx) })
      return project
    },

    async patch(ctx: ServiceContext) {
      await getScoped(ctx, 'project', 'Project')
      // slug is immutable: it is half of the @@unique([workspaceId, slug]) key
      // and appears in URLs the UI has already handed out.
      const patch = narrowPatch(ctx.data as Record<string, unknown>, ['slug'])
      if (changesNothing(patch)) return getScoped(ctx, 'project', 'Project')
      return dbOf(ctx).project.update({ where: { id: ctx.id as string }, data: patch })
    },

    async remove(ctx: ServiceContext) {
      // @@softDelete(cascade) on Project — this also stamps its Environments,
      // and through them their Apps and Jobs. That cascade is why archiving a
      // project cannot leave live children behind.
      const removed = await removeScoped(ctx, 'project', 'Project')
      app.events.emit('project:deleted', { id: ctx.id, workspace_id: wsOf(ctx) })
      return removed
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), stampWorkspace],
        patch:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
