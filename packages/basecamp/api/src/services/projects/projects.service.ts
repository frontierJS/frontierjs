// src/services/projects/projects.service.ts
// Projects — the unit a workspace organises environments under.
//
// Mounted at /projects. Zero raw SQL: every read and write goes through the
// caller-scoped Litestone client on $.locals.db.
//
// The hand-written CreateProjectSchema/PatchProjectSchema are gone.
// `model: 'Project'` derives validation from db/schema.lite, so the field
// rules live in one place instead of two that drift — `name` was capped at 80
// in both, but only the schema knew `slug` had to be unique per workspace.

import { createService, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, assertSlugFree, deriveSlug, narrowPatch, changesNothing, ws }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'

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

    async find() {
      const { limit, offset } = getPagination()
      const status = $.query.status as string | undefined
      return findScoped('project', { where: status ? { status } : {}, limit, offset })
    },

    get: () => getScoped('project', 'Project'),

    async create() {
      const data = $.data as Record<string, unknown>
      await assertSlugFree('project', { workspaceId: ws(), slug: data.slug },
        `Project slug '${data.slug}' already exists in this workspace`)

      const project = await db().project.create({ data })
      app.events.emit('project:created', { id: project.id, workspace_id: ws() })
      return project
    },

    async patch() {
      await getScoped('project', 'Project')
      // slug is immutable: it is half of the @@unique([workspaceId, slug]) key
      // and appears in URLs the UI has already handed out.
      const patch = narrowPatch($.data as Record<string, unknown>, ['slug'])
      if (changesNothing(patch)) return getScoped('project', 'Project')
      return db().project.update({ where: { id: $.id as string }, data: patch })
    },

    async remove() {
      // @@softDelete(cascade) on Project — this also stamps its Environments,
      // and through them their Apps and Jobs. That cascade is why archiving a
      // project cannot leave live children behind.
      const removed = await removeScoped('project', 'Project')
      app.events.emit('project:deleted', { id: $.id, workspace_id: ws() })
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
