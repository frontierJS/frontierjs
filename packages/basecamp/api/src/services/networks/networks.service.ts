// src/services/networks/networks.service.ts
// Private networks, and which servers are on them.
//
// Mounted at /networks. Custom methods dispatch on X-Service-Method:
//   members · attach · detach
//
// `Network`, `ServerNetwork` and `AppNetwork` have been in db/schema.lite since
// the Data realm was rebuilt with **no API surface at all**. Three models, one
// of them a join table nothing could write.
//
// The join is the whole point of this service. A network on its own is a CIDR
// and a name; what an operator needs to know is who is ON it, which is why
// `members` returns the join rows with their servers included rather than
// making the browser fan out one request per server.

import { createService, NotFound, BadRequest, Conflict, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { findScoped, getScoped, removeScoped, stampWorkspace, narrowPatch, changesNothing, assertSlugFree, dbOf, wsOf }
  from '../../core/resource.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'
import type { ServiceContext } from '@frontierjs/junction'

// A /8 through /30. Deliberately shape-only: whether the range overlaps another
// network is the provider's judgement, not ours, and guessing it here would be
// a rule that disagrees with the thing actually doing the routing.
const CIDR = /^(\d{1,3}\.){3}\d{1,3}\/(8|9|1\d|2\d|30)$/

export function createNetworksService(app: BasecampApp) {

  /** A network plus what is on it — the shape `get` answers, so a custom
   *  method can return the same record rather than a projection of it. Written
   *  as a plain function and not `this.get(ctx)`: a service's methods are
   *  collected into a definition object and calling one through `this` binds to
   *  whatever the pipeline happens to invoke it with, which is not a contract. */
  async function withCounts(ctx: ServiceContext, network: Record<string, unknown>) {
    const server_count = await dbOf(ctx).serverNetwork.count({ where: { networkId: network.id } })
    const app_count    = await dbOf(ctx).appNetwork.count({ where: { networkId: network.id } })
    return { ...network, server_count, app_count }
  }

  async function serverInWorkspace(ctx: ServiceContext, serverId: string) {
    const server = await dbOf(ctx).server.findFirst({ where: { id: serverId, workspaceId: wsOf(ctx) } })
    if (!server) throw new NotFound(`Server '${serverId}' not found in this workspace`)
    return server
  }

  return createService({
    name:  'networks',
    model: 'Network',
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination(ctx)
      const type = ctx.query.type as string | undefined
      return findScoped(ctx, 'network', { where: { ...(type ? { type } : {}) }, limit, offset })
    },

    async get(ctx: ServiceContext) {
      // Counts, not the rows: this is the summary read, and `members` is the
      // one that pays for the join.
      return withCounts(ctx, await getScoped(ctx, 'network', 'Network'))
    },

    async create(ctx: ServiceContext) {
      const data = ctx.data as Record<string, unknown>
      if (data.cidr && !CIDR.test(data.cidr as string))
        throw new BadRequest(`cidr must look like 10.0.0.0/16 — got '${data.cidr}'`)

      await assertSlugFree(ctx, 'network', { workspaceId: wsOf(ctx), slug: data.slug },
        `A network with slug '${data.slug}' already exists in this workspace`)

      return dbOf(ctx).network.create({ data })
    },

    async patch(ctx: ServiceContext) {
      await getScoped(ctx, 'network', 'Network')
      const data = ctx.data as Record<string, unknown>

      if (data.cidr && !CIDR.test(data.cidr as string))
        throw new BadRequest(`cidr must look like 10.0.0.0/16 — got '${data.cidr}'`)

      // slug is immutable: it is half of a @@unique and every join row already
      // points at this id. Renaming the display name is free; renaming the
      // handle is a migration.
      const patch = narrowPatch(data, ['slug', 'provider'])
      if (changesNothing(patch)) return getScoped(ctx, 'network', 'Network')
      return dbOf(ctx).network.update({ where: { id: ctx.id as string }, data: patch })
    },

    async remove(ctx: ServiceContext) {
      const network = await getScoped(ctx, 'network', 'Network')
      // Refused rather than cascaded. The schema WOULD cascade the join rows,
      // which is right for referential integrity and wrong as a default here:
      // detaching a live server from its network is an operational act, and
      // doing it as a side effect of a delete is how a fleet loses routing
      // without anyone deciding to.
      const attached = await dbOf(ctx).serverNetwork.count({ where: { networkId: network.id } })
      if (attached > 0)
        throw new Conflict(`${attached} server(s) are still attached — detach them first`)

      return removeScoped(ctx, 'network', 'Network')
    },

    // ── members ───────────────────────────────────────────────────────
    async members(ctx: ServiceContext) {
      const network = await getScoped(ctx, 'network', 'Network')
      ctx.dispatch = false   // read-shaped

      const rows = await dbOf(ctx).serverNetwork.findMany({
        where:   { networkId: network.id },
        include: { server: true },
        orderBy: { joinedAt: 'asc' },
      })
      return { total: rows.length, data: rows }
    },

    // ── attach ────────────────────────────────────────────────────────
    async attach(ctx: ServiceContext) {
      const network  = await getScoped(ctx, 'network', 'Network')
      const { serverId, ipAddress } = (ctx.data ?? {}) as Record<string, string>
      if (!serverId) throw new BadRequest('serverId is required')

      await serverInWorkspace(ctx, serverId)

      if (await dbOf(ctx).serverNetwork.exists({ where: { serverId, networkId: network.id } }))
        throw new Conflict('That server is already on this network')

      await dbOf(ctx).serverNetwork.create({
        data: { serverId, networkId: network.id, ipAddress: ipAddress ?? null },
      })

      // The NETWORK row, not the join row. A custom method's return shape is
      // load-bearing (junction FJS-020): a client assigning this over the
      // record it is rendering must get that record back, and a join row has
      // neither the network's id nor its name.
      return withCounts(ctx, network)
    },

    // ── detach ────────────────────────────────────────────────────────
    async detach(ctx: ServiceContext) {
      const network   = await getScoped(ctx, 'network', 'Network')
      const { serverId } = (ctx.data ?? {}) as Record<string, string>
      if (!serverId) throw new BadRequest('serverId is required')

      const link = await dbOf(ctx).serverNetwork.findFirst({ where: { serverId, networkId: network.id } })
      if (!link) throw new NotFound('That server is not on this network')

      await dbOf(ctx).serverNetwork.remove({ where: { id: link.id } })
      return withCounts(ctx, network)
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'admin', 'owner'), stampWorkspace],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Attaching a server to a network changes what can reach what, so it is
        // held at the same bar as authoring the network.
        attach: [requireWorkspaceRole(app, 'admin', 'owner')],
        detach: [requireWorkspaceRole(app, 'admin', 'owner')],
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}
