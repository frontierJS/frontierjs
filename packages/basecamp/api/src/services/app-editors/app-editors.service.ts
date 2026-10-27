// src/services/app-editors/app-editors.service.ts
// App editors — who may change a static site's words, and who may also publish
// them (`FJS-D1230`).
//
// Mounted at /app-editors, an admin's surface; `?appId=<id>` lists one site's.
// Who may read or write a row is the model's policy. This service adds which
// App may have an editor at all.

import { createService, BadRequest, NotFound, $ } from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, narrowPatch, changesNothing } from '../../core/resource.ts'
import { isGit } from '../../domain/release/app-source.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'

/**
 * before/create: an editor changes the markdown of a site its build reads from
 * git, so only a static App with a git source may have one. The App is found
 * through the caller's own client, so one in another workspace is not found.
 */
async function siteFromGit() {
  const { appId } = ($.data ?? {}) as { appId?: unknown }
  if (typeof appId !== 'string' || !appId) throw new BadRequest('An editor is added to an app — name one with appId')
  const app = await db().app.findFirst({ where: { id: appId } })
  if (!app) throw new NotFound(`App '${appId}' not found`)
  if (app.type !== 'static' || !isGit(app.source))
    throw new BadRequest(`App '${app.slug}' is not a static site built from git, so it has no words to edit`)
}

export default createService({
  name:    'appEditors',
  scope:   keyScope('appEditors'),
  model:   'AppEditor',
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,
  methods: ['find', 'get', 'create', 'patch', 'remove'],

  // The read policy also admits the caller's own rows in other workspaces, so
  // the list is narrowed to this workspace's apps by name.
  async find() {
    const { limit, offset } = getPagination()
    const appId = $.query.appId as string | undefined
    const apps  = appId ? [appId] : (await db().app.findMany({ select: { id: true } })).map((a: { id: string }) => a.id)
    return findScoped('appEditor', { where: { appId: apps }, limit, offset })
  },

  get: () => getScoped('appEditor', 'App editor'),

  create: () => db().appEditor.create({ data: $.data }),

  async patch() {
    await getScoped('appEditor', 'App editor')
    const patch = narrowPatch($.data as Record<string, unknown>)
    if (changesNothing(patch)) return getScoped('appEditor', 'App editor')
    return db().appEditor.update({ where: { id: $.id as string }, data: patch })
  },

  async remove() {
    const row = await getScoped('appEditor', 'App editor')
    await db().appEditor.delete({ where: { id: row.id } })
    return row
  },

  hooks: {
    before: {
      all:    [sessionScope()],
      create: [siteFromGit],
    },
  },
})
