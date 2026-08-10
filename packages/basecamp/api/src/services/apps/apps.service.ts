// src/services/apps/apps.service.ts
// Apps — the deployable unit. Lives in an Environment, runs on one or more
// Servers.
//
// Mounted at /apps. `model: 'App'` derives validation from db/schema.lite.
//
// The table is `app`, not `service`. The old header here said "table name in
// DB: service (legacy — kept for migration continuity)"; that name was the
// exact overload VISION.md §Vocabulary forbids and it is gone — Service is the
// API realm's noun. See db/README.md §Two renames.
//
// The hand-rolled WITH_ENV JOIN is replaced by `include: { environment: true }`.
// The relation is declared in the schema, so the join is derived rather than
// spelled out — and it returns a nested object instead of flattened
// `environment_name` / `environment_tier` columns.

import { createService, NotFound, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, assertSlugFree, stampWorkspace, narrowPatch, dbOf, wsOf }
  from '../../core/resource.ts'
// The ONE definition of a certificate's condition, imported rather than
// recomputed: an include returns raw Domain rows, so without this the app
// detail screen received hostnames with no cert_status at all and every one of
// them rendered as "no certificate" — including the expired ones.
import { certStatusOf } from '../domains/domains.service.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

const WITH_ENV = { environment: true }

// The detail read. `domains` comes with the app because `App.domain` — one
// nullable string — is gone: a hostname is a row now, and an app with an apex
// and a www is the ordinary case rather than the case the column could not
// describe. Litestone batches an include into one `IN` per relation level, so
// this is a second query for the whole page, not one per app.
const WITH_DETAIL = { environment: true, domains: true }

export function createAppsService(app: BasecampApp) {

  async function assertEnvironmentInWorkspace(ctx: ServiceContext, environmentId: string) {
    const env = await dbOf(ctx).environment.findFirst({ where: { id: environmentId, workspaceId: wsOf(ctx) } })
    if (!env) throw new NotFound(`Environment '${environmentId}' not found in this workspace`)
  }

  return createService({
    name:  'apps',
    model: 'App',

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const environmentId = (ctx.query.environmentId ?? ctx.query.environment_id) as string | undefined
      const type          = ctx.query.type as string | undefined

      const { rows, total } = await dbOf(ctx).app.findManyAndCount({
        where: {
          workspaceId: wsOf(ctx),
          ...(environmentId ? { environmentId } : {}),
          ...(type          ? { type }          : {}),
        },
        include: WITH_DETAIL,
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })
      return { total, limit, offset, data: rows }
    },

    async get(ctx: ServiceContext) {
      const row = await dbOf(ctx).app.findFirst({
        where:   { id: ctx.id as string, workspaceId: wsOf(ctx) },
        include: WITH_DETAIL,
      })
      if (!row) throw new NotFound(`App '${ctx.id}' not found`)

      // What the detail screen needs and a list does not: where the replicas
      // landed, what has been released, and what runs on a schedule. Three
      // reads here rather than three round trips from the browser — the screen
      // is one question ("what is this app doing"), so it is one request.
      const [placement, deployments, jobs] = await Promise.all([
        dbOf(ctx).appServer.findMany({ where: { appId: row.id }, include: { server: true } }),
        dbOf(ctx).deployment.findMany({ where: { appId: row.id }, orderBy: { queuedAt: 'desc' }, limit: 10 }),
        dbOf(ctx).job.findMany({ where: { appId: row.id }, orderBy: { createdAt: 'desc' }, limit: 10 }),
      ])

      return {
        ...row,
        domains: (row.domains ?? []).map((d: Record<string, unknown>) => ({ ...d, ...certStatusOf(d as never) })),
        placement,
        recent_deployments: deployments,
        jobs,
      }
    },

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      await assertEnvironmentInWorkspace(ctx, data.environmentId as string)
      await assertSlugFree(ctx, 'app', { environmentId: data.environmentId, slug: data.slug },
        `App slug '${data.slug}' already exists in this environment`)

      const created = await dbOf(ctx).app.create({ data })
      app.events.emit('app:created', {
        id: created.id, workspace_id: wsOf(ctx), environment_id: created.environmentId, type: created.type,
      })
      return dbOf(ctx).app.findFirst({ where: { id: created.id }, include: WITH_DETAIL })
    },

    async patch(ctx: ServiceContext) {
      await getScoped(ctx, 'app', 'App')
      // environmentId and slug are immutable — moving an app between
      // environments would orphan its deployment history.
      // `status` is the engine's to set, never a client's.
      const patch = narrowPatch(ctx.data as Record<string, unknown>, ['environmentId', 'slug', 'status'])
      if (Object.keys(patch).length)
        await dbOf(ctx).app.update({ where: { id: ctx.id as string }, data: patch })

      return dbOf(ctx).app.findFirst({ where: { id: ctx.id as string }, include: WITH_DETAIL })
    },

    async remove(ctx: ServiceContext) {
      await getScoped(ctx, 'app', 'App')
      // Mark it stopped as well as deleted: a soft-deleted app that still reads
      // "running" would keep showing up as live in any status rollup.
      await dbOf(ctx).app.update({ where: { id: ctx.id as string }, data: { status: 'stopped' } })
      const removed = await removeScoped(ctx, 'app', 'App')
      app.events.emit('app:deleted', { id: ctx.id, workspace_id: wsOf(ctx) })
      return removed
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), stampWorkspace],
        patch:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}
