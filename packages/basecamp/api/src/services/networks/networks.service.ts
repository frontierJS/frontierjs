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

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, deriveSlug, narrowPatch, changesNothing, assertSlugFree, ws }
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
  async function withCounts(network: Record<string, unknown>) {
    const server_count = await db().serverNetwork.count({ where: { networkId: network.id } })
    const app_count    = await db().appNetwork.count({ where: { networkId: network.id } })
    return { ...network, server_count, app_count }
  }

  async function serverInWorkspace(serverId: string) {
    const server = await db().server.findFirst({ where: { id: serverId, workspaceId: ws() } })
    if (!server) throw new NotFound(`Server '${serverId}' not found in this workspace`)
    return server
  }

  return createService({
    name:  'networks',
    model: 'Network',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination()
      const type = $.query.type as string | undefined
      return findScoped('network', { where: { ...(type ? { type } : {}) }, limit, offset })
    },

    async get(ctx: ServiceContext) {
      // Counts, not the rows: this is the summary read, and `members` is the
      // one that pays for the join.
      return withCounts(await getScoped('network', 'Network'))
    },

    async create() {
      const data = $.data as Record<string, unknown>
      if (data.cidr && !CIDR.test(data.cidr as string))
        throw new BadRequest(`cidr must look like 10.0.0.0/16 — got '${data.cidr}'`)

      await assertSlugFree('network', { workspaceId: ws(), slug: data.slug },
        `A network with slug '${data.slug}' already exists in this workspace`)

      return db().network.create({ data })
    },

    async patch() {
      await getScoped('network', 'Network')
      const data = $.data as Record<string, unknown>

      if (data.cidr && !CIDR.test(data.cidr as string))
        throw new BadRequest(`cidr must look like 10.0.0.0/16 — got '${data.cidr}'`)

      // slug is immutable: it is half of a @@unique and every join row already
      // points at this id. Renaming the display name is free; renaming the
      // handle is a migration.
      const patch = narrowPatch(data, ['slug', 'provider'])
      if (changesNothing(patch)) return getScoped('network', 'Network')
      return db().network.update({ where: { id: $.id as string }, data: patch })
    },

    async remove(ctx: ServiceContext) {
      const network = await getScoped('network', 'Network')
      // Refused rather than cascaded. The schema WOULD cascade the join rows,
      // which is right for referential integrity and wrong as a default here:
      // detaching a live server from its network is an operational act, and
      // doing it as a side effect of a delete is how a fleet loses routing
      // without anyone deciding to.
      const attached = await db().serverNetwork.count({ where: { networkId: network.id } })
      if (attached > 0)
        throw new Conflict(`${attached} server(s) are still attached — detach them first`)

      return removeScoped('network', 'Network')
    },

    // ── members ───────────────────────────────────────────────────────
    async members() {
      const network = await getScoped('network', 'Network')
      $.dispatch = false   // read-shaped

      const rows = await db().serverNetwork.findMany({
        where:   { networkId: network.id },
        include: { server: true },
        orderBy: { joinedAt: 'asc' },
      })
      return { total: rows.length, data: rows }
    },

    // ── attach ────────────────────────────────────────────────────────
    async attach(ctx: ServiceContext) {
      const network  = await getScoped('network', 'Network')
      const { serverId, ipAddress } = ($.data ?? {}) as Record<string, string>
      if (!serverId) throw new BadRequest('serverId is required')

      await serverInWorkspace(serverId)

      if (await db().serverNetwork.exists({ where: { serverId, networkId: network.id } }))
        throw new Conflict('That server is already on this network')

      await db().serverNetwork.create({
        data: { serverId, networkId: network.id, ipAddress: ipAddress ?? null },
      })

      // The NETWORK row, not the join row. A custom method's return shape is
      // load-bearing (junction FJS-020): a client assigning this over the
      // record it is rendering must get that record back, and a join row has
      // neither the network's id nor its name.
      return withCounts(network)
    },

    // ── detach ────────────────────────────────────────────────────────
    async detach(ctx: ServiceContext) {
      const network   = await getScoped('network', 'Network')
      const { serverId } = ($.data ?? {}) as Record<string, string>
      if (!serverId) throw new BadRequest('serverId is required')

      const link = await db().serverNetwork.findFirst({ where: { serverId, networkId: network.id } })
      if (!link) throw new NotFound('That server is not on this network')

      await db().serverNetwork.remove({ where: { id: link.id } })
      return withCounts(network)
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'admin', 'owner'), deriveSlug],
        patch:  [requireWorkspaceRole(app, 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Attaching a server to a network changes what can reach what, so it is
        // held at the same bar as authoring the network.
        attach: [requireWorkspaceRole(app, 'admin', 'owner')],
        detach: [requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
