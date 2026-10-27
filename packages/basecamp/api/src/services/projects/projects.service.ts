// src/services/projects/projects.service.ts
// Projects — the unit a workspace organizes environments under.
//
// Mounted at /projects. Zero raw SQL: every read and write goes through the
// caller-scoped Litestone client on $.db.
//
// The hand-written CreateProjectSchema/PatchProjectSchema are gone.
// `model: 'Project'` derives validation from db/schema.lite, so the field
// rules live in one place instead of two that drift — `name` was capped at 80
// in both, but only the schema knew `slug` had to be unique per workspace.

import { createService, $ } from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, deriveSlug, narrowPatch, changesNothing }
  from '../../core/resource.ts'
import { retireAppsIn }         from '../apps/apps.service.ts'
import { syncReplicasOf }       from '../../jobs/replicate-sync.job.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'

export default createService({
  name:  'projects',
  scope: keyScope('projects'),
  model: 'Project',
  // Announced by the service DEFINITION, not by an after hook: `callService`
  // is junction's one announcement point and it excludes `find`/`get` by name,
  // where an `after: { all: [...] }` hook broadcast every read to every browser
  // in the workspace (FJS-031). Declaring both is refused at construction.
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

  async find() {
    const { limit, offset } = getPagination()
    const status = $.query.status as string | undefined
    return findScoped('project', { where: status ? { status } : {}, limit, offset })
  },

  get: () => getScoped('project', 'Project'),

  async create() {
    const data = $.data as Record<string, unknown>
    return db().project.create({ data })
  },

  async patch() {
    await getScoped('project', 'Project')
    // slug is immutable: it is half of the @@unique([workspaceId, slug]) key
    // and appears in URLs the UI has already handed out.
    const patch = narrowPatch($.data as Record<string, unknown>)
    if (changesNothing(patch)) return getScoped('project', 'Project')
    return db().project.update({ where: { id: $.id as string }, data: patch })
  },

  async remove() {
    // @@softDelete(cascade) on Project — this also stamps its Environments,
    // and through them their Apps and Jobs. That cascade is why archiving a
    // project cannot leave live rows behind; it tells no machine, so the
    // Apps are retired first.
    const project = await getScoped('project', 'Project')
    const envs    = await db().environment.findMany({ where: { projectId: project.id }, select: { id: true } })
    const apps    = await retireAppsIn($.app, envs.map((e: { id: string }) => e.id))
    const removed = await removeScoped('project', 'Project')
    await syncReplicasOf($.app, apps.map(a => a.id))
    return { ...removed, apps }
  },

  hooks: {
    before: {
      all:    [sessionScope()],
      create: [deriveSlug],
    },
  },
})
