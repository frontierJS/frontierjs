// src/services/domain-routes/domain-routes.service.ts
// The prefixes of a Domain that another App answers (`FJS-D1040`).
//
// Mounted at /domain-routes. `shop.example.com` belongs to its Domain's App,
// and a route sends `/api` of it to a second App — the pair `fli deploy`'s
// Caddy serves as one origin, so the SPA and the API it calls share cookies
// and need no CORS.
//
// The prefix is validated here AND by Outpost, which owns what Caddy's path
// matcher expands: a wildcard or a brace in a prefix would match more than the
// person who wrote it meant.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, narrowPatch, changesNothing, ws } from '../../core/resource.ts'
import domainDns from '../../jobs/domain-dns.job.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'

/** Outpost's `PREFIX`, lowercased with no trailing slash: segments of URL-safe characters. */
const PREFIX = /^(?:\/[a-z0-9._~-]+)+$/

export function normalizePrefix(raw: unknown): string {
  const prefix = String(raw ?? '').trim().toLowerCase().replace(/\/+$/, '')
  if (!PREFIX.test(prefix) || prefix.split('/').some(seg => seg === '.' || seg === '..'))
    throw new BadRequest(`'${raw}' is not a path prefix — start with / and name a segment, with no wildcard or braces (the Domain itself routes the whole host)`)
  return prefix
}

/** Tell the machines. The id carries the row, so a replayed write is one push. */
const toMachines = (domainId: string, rowId: string, what: string) =>
  $.app.jobs.dispatch(domainDns, { domainId }, { id: `dns:${domainId}:route:${rowId}:${what}` })

async function guard(domainId: string, appId: string) {
  const domain = await db().domain.findFirst({ where: { id: domainId, workspaceId: ws() } })
  if (!domain) throw new NotFound(`Domain '${domainId}' not found in this workspace`)
  if (domain.redirectTo) throw new BadRequest(`${domain.hostname} redirects, so it answers no prefix of its own`)
  const app = await db().app.findFirst({ where: { id: appId, workspaceId: ws() } })
  if (!app) throw new NotFound(`App '${appId}' not found in this workspace`)
  if (appId === domain.appId)
    throw new BadRequest(`${domain.hostname} already goes to that App — a prefix is for a different one`)
  return domain
}

export default createService({
  name:  'domainRoutes',
  scope: keyScope('domainRoutes'),
  model: 'DomainRoute',
  methods: ['find', 'get', 'create', 'patch', 'remove'],
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,

  async find() {
    const { limit, offset } = getPagination()
    const domainId = $.query.domainId as string | undefined
    return findScoped('domainRoute', {
      where:   { ...(domainId ? { domainId } : {}) },
      orderBy: { pathPrefix: 'asc' },
      limit, offset,
    })
  },

  get: () => getScoped('domainRoute', 'Domain route'),

  async create() {
    const data = $.data as Record<string, unknown>
    const domain = await guard(data.domainId as string, data.appId as string)
    const pathPrefix = normalizePrefix(data.pathPrefix)
    const created = await db().domainRoute.create({ data: { ...data, pathPrefix } })
    await toMachines(domain.id, created.id, 'created')
    return created
  },

  async patch() {
    const route = await getScoped('domainRoute', 'Domain route')
    // The Domain is fixed: moving a prefix to another host is a delete and a create.
    const patch = narrowPatch($.data as Record<string, unknown>)
    if ('pathPrefix' in patch) patch.pathPrefix = normalizePrefix(patch.pathPrefix)
    if (changesNothing(patch)) return route
    const domain = await guard(route.domainId, (patch.appId as string | undefined) ?? route.appId)
    const updated = await db().domainRoute.update({ where: { id: route.id }, data: patch })
    await toMachines(domain.id, route.id, `patched:${updated.updatedAt}`)
    return updated
  },

  async remove() {
    const route = await getScoped('domainRoute', 'Domain route')
    await db().domainRoute.delete({ where: { id: route.id } })
    await toMachines(route.domainId, route.id, 'removed')
    return route
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
