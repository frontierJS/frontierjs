// src/services/variables/variables.service.ts
// Variables — what a container's environment is, set on an Environment for
// every app in it or on one App.
//
// Mounted at /variables. `?environmentId=<id>&appId=null` is an environment's
// own; `?appId=<id>` is one app's. What a release merges from the two is
// `core/variables.ts`.
//
// A secret's value is written to `secretValue`, which is `@encrypted` and so
// absent from every read here. A secret is replaced, never read back.

import { createService, NotFound, BadRequest, parseWhere, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, refuseProtectedForDeveloper, WORKSPACE_QUERY }
  from '../../core/hooks.ts'
import { db, findScoped, getScoped, narrowPatch, changesNothing, ws } from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

export function createVariablesService(app: BasecampApp) {

  /**
   * before/create hook: the environment a write lands in, found through the
   * caller's own client. An app's variable takes its app's environment, so the
   * two columns cannot disagree whatever the payload said.
   *
   * A HOOK because `environmentId` is required and autoValidate runs after the
   * user hooks — a caller naming only the app would be refused by the schema
   * before `create()` could fill it in.
   */
  async function scopeFromPayload() {
    const data = ($.data ?? {}) as Record<string, unknown>
    if (data.appId) {
      const target = await db().app.findFirst({ where: { id: data.appId, workspaceId: ws() } })
      if (!target) throw new NotFound(`App '${data.appId}' not found in this workspace`)
      data.environmentId = target.environmentId
      return
    }
    if (!data.environmentId) throw new BadRequest('A variable is set on an environment or an app — name one')
    if (!await db().environment.exists({ where: { id: data.environmentId, workspaceId: ws() } }))
      throw new NotFound(`Environment '${data.environmentId}' not found in this workspace`)
    data.appId = null
  }

  /** An environment-wide variable is the environment's to guard. An app's own
   *  is the app's, at the authority that may patch the app. */
  async function guard(row: { environmentId: string; appId: string | null }, ctx: ServiceContext) {
    if (row.appId) return
    refuseProtectedForDeveloper(await getScoped('environment', 'Environment', row.environmentId), ctx)
  }

  /** `value` is what a person types; a secret row keeps it in `secretValue`. */
  function placeValue(data: Record<string, unknown>, secret: boolean) {
    if ('secretValue' in data) throw new BadRequest('A secret is sent as `value`, and stored where the variable says')
    if (!('value' in data)) return
    if (typeof data.value !== 'string') throw new BadRequest('value must be text')
    if (secret) { data.secretValue = data.value; delete data.value }
  }

  return createService({
    name:  'variables',
    model: 'Variable',
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,
    // No `restore`: a variable comes back with the app or environment that
    // cascaded it, and one removed on its own is gone so its key can be set again.
    methods: ['find', 'get', 'create', 'patch', 'remove'],

    async find() {
      const { limit, offset } = getPagination()
      return findScoped('variable', { where: parseWhere($.query), orderBy: { key: 'asc' }, limit, offset })
    },

    get: () => getScoped('variable', 'Variable'),

    async create(ctx: ServiceContext) {
      const data = $.data as Record<string, unknown>
      await guard(data as { environmentId: string; appId: string | null }, ctx)
      if (data.value === undefined) throw new BadRequest('value is required')
      placeValue(data, Boolean(data.secret))
      return db().variable.create({ data })
    },

    async patch(ctx: ServiceContext) {
      const row = await getScoped('variable', 'Variable')
      await guard(row, ctx)
      // key, secret and the scope are @immutable and the schema refuses them by
      // name; `value` is the one thing a person changes.
      const patch = narrowPatch($.data as Record<string, unknown>)
      placeValue(patch, row.secret)
      if (changesNothing(patch)) return row
      return db().variable.update({ where: { id: row.id }, data: patch })
    },

    async remove(ctx: ServiceContext) {
      const row = await getScoped('variable', 'Variable')
      await guard(row, ctx)
      // Gone rather than stamped, or the key stays held by a row nobody can see
      // and setting it again is a 409.
      await db().variable.delete({ where: { id: row.id }, withDeleted: true })
      return row
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), scopeFromPayload],
        patch:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
    },
  })
}
