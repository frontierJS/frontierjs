// src/services/environments/environments.service.ts
// Environments — a named deploy target inside a Project.
//
// Mounted at /environments. Custom methods dispatch on X-Service-Method:
//   setVariable · deleteVariable
//
// `model: 'Environment'` derives validation from db/schema.lite. The
// hand-written schemas here declared TIERS as five values while the schema enum
// had three — the schema has been widened to match, because the service was the
// older and better evidence of what a tier is.

import { createService, NotFound, Forbidden, BadRequest } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, assertSlugFree, stampWorkspace, narrowPatch, changesNothing, dbOf, wsOf, slugify }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

interface EnvVariable { key: string; value: string; secret: boolean }

export function createEnvironmentsService(app: BasecampApp) {

  /** Rewrite the variables array and return the saved row.
   *
   *  Takes the row rather than reaching for `ctx.id`: Environment declares
   *  @version, so the write states the version this call read. Two people on
   *  the variables screen at once is the ordinary case, and without it the
   *  second save erases the first person's key with no sign it did. */
  async function saveVariables(ctx: ServiceContext, env: Record<string, unknown>, variables: EnvVariable[]) {
    // Return the WHOLE row, like every other method on this service.
    //
    // This used to answer `{ id, variables }`. Nothing was wrong with the write
    // — but a caller that does the obvious thing with the result of a method
    // that updates a record (`environment = await ...setVariable(...)`) silently
    // loses name, tier and projectId, and the page renders "undefined" as its
    // heading. A custom method is still a method on this model; a partial row
    // is a shape no caller can distinguish from a full one until it breaks.
    return dbOf(ctx).environment.update({
      where: { id: ctx.id as string },
      data:  { variables, version: env.version },
    })
  }

  /**
   * An environment's project must be in the caller's workspace.
   *
   * Checked on create, because `projectId` arrives from the client: without it
   * a caller could attach an environment to another tenant's project by id.
   */
  async function assertProjectInWorkspace(ctx: ServiceContext, projectId: string) {
    const project = await dbOf(ctx).project.findFirst({ where: { id: projectId, workspaceId: wsOf(ctx) } })
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

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const projectId = (ctx.query.projectId ?? ctx.query.project_id) as string | undefined
      return findScoped(ctx, 'environment', {
        where:   projectId ? { projectId } : {},
        orderBy: { name: 'asc' },
        limit, offset,
      })
    },

    get: (ctx: ServiceContext) => getScoped(ctx, 'environment', 'Environment'),

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      await assertProjectInWorkspace(ctx, data.projectId as string)
      await assertSlugFree(ctx, 'environment', { projectId: data.projectId, slug: data.slug },
        `Environment slug '${data.slug}' already exists in this project`)

      const env = await dbOf(ctx).environment.create({ data })
      app.events.emit('environment:created',
        { id: env.id, project_id: env.projectId, workspace_id: wsOf(ctx) })
      return env
    },

    async patch(ctx: ServiceContext) {
      const env = await getScoped(ctx, 'environment', 'Environment')

      // A protected environment is the production guard: a developer may deploy
      // to it but not reshape it.
      if (env.isProtected && ctx.locals.memberRole === 'developer')
        throw new Forbidden('Protected environments require admin or owner role to modify')

      // projectId and slug are immutable — moving an environment between
      // projects would silently reparent its apps and deployments.
      const patch = narrowPatch(ctx.data as Record<string, unknown>, ['projectId', 'slug', 'variables'])
      if (changesNothing(patch)) return env
      return dbOf(ctx).environment.update({ where: { id: ctx.id as string }, data: patch })
    },

    async remove(ctx: ServiceContext) {
      const env = await getScoped(ctx, 'environment', 'Environment')
      if (env.isProtected)
        throw new Forbidden('Cannot delete a protected environment — unprotect it first')

      // @@softDelete(cascade) — this stamps the environment's Apps and Jobs too.
      const removed = await removeScoped(ctx, 'environment', 'Environment')
      app.events.emit('environment:deleted', { id: ctx.id })
      return removed
    },

    // ── setVariable ───────────────────────────────────────────────────
    // `variables` is a Json column, so it arrives as an array and is written
    // back as one — no JSON.parse/stringify at this layer.
    async setVariable(ctx: ServiceContext) {
      const { key, value, secret } = (ctx.data ?? {}) as Partial<EnvVariable>
      if (!key?.trim())        throw new BadRequest('key is required')
      if (value === undefined) throw new BadRequest('value is required')

      const env       = await getScoped(ctx, 'environment', 'Environment')
      const variables = [...((env.variables ?? []) as EnvVariable[])]
      const entry: EnvVariable = { key: key.trim(), value, secret: Boolean(secret) }
      const idx       = variables.findIndex(v => v.key === entry.key)

      if (idx >= 0) variables[idx] = entry
      else          variables.push(entry)

      return saveVariables(ctx, env, variables)
    },

    async deleteVariable(ctx: ServiceContext) {
      const { key } = (ctx.data ?? {}) as { key?: string }
      if (!key) throw new BadRequest('key is required')

      const env = await getScoped(ctx, 'environment', 'Environment')
      return saveVariables(ctx, env, ((env.variables ?? []) as EnvVariable[]).filter(v => v.key !== key))
    },

    hooks: {
      before: {
        all:            [sessionScope(app)],
        create:         [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), stampWorkspace],
        patch:          [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove:         [requireWorkspaceRole(app, 'admin', 'owner')],
        setVariable:    [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        deleteVariable: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
    },
  })
}
