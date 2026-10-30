// src/services/monitors/monitors.service.ts
// Monitors — the URLs Basecamp probes, and what the probes found.
//
// Mounted at /monitors. Custom methods dispatch on X-Service-Method:
//   history · pause · resume · attachChannel · detachChannel
//
// This is the service, not the prober. What decides a monitor is down is
// `jobs/monitor-sweep.job.ts` and `domain/monitor/probe.ts`: a monitor's state is written
// by the sweep, so none of `status`, `failStreak` or the stamps is a column a
// caller can set (`@system`), and `status` moves only by `@@transitions`.
// `MonitorCheck` and `MonitorEvent` are written by the system and read here.

import { createService, NotFound, Conflict, parseWhere, $ } from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, narrowPatch, changesNothing, ws }
  from '../../core/resource.ts'
import { keyScope }         from '../../domain/api-key/scopes.ts'

/** The heartbeat bar's length: the newest checks `get` carries. */
const RECENT_CHECKS = 50

/** A monitor with where it pages and what it last saw — the shape `get`
 *  answers, so attach/detach and pause/resume return the record the client is
 *  rendering. A plain function, not `this.get`: a service's methods are
 *  collected into a definition and `this` is whatever the pipeline bound. */
async function withDetail(monitor: Record<string, unknown>) {
  const channels = await db().monitorChannel.findMany({
    where:   { monitorId: monitor.id },
    include: { channel: true },
    orderBy: { createdAt: 'asc' },
  })
  const recent_checks = await db().monitorCheck.findMany({
    where:   { monitorId: monitor.id },
    orderBy: { at: 'desc' },
    limit:   RECENT_CHECKS,
  })
  const recent_events = await db().monitorEvent.findMany({
    where:   { monitorId: monitor.id },
    orderBy: { at: 'desc' },
    limit:   10,
  })
  return { ...monitor, channels, recent_checks, recent_events }
}

export default createService({
  name:  'monitors',
  scope: keyScope('monitors'),
  model: 'Monitor',
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts
  // `methods:` is the whole surface: the base answers every CRUD verb the
  // service does not name, and `restore` has nothing to restore here.
  methods: [
    'find', 'get', 'create', 'update', 'patch', 'remove',
    'history', 'pause', 'resume',
    { method: 'attachChannel', input: 'MonitorChannelRef' },
    { method: 'detachChannel', input: 'MonitorChannelRef' },
  ],

  async find() {
    const { limit, offset } = getPagination()
    return findScoped('monitor', { where: parseWhere($.query), limit, offset })
  },

  async get() {
    return withDetail(await getScoped('monitor', 'Monitor'))
  },

  async create() {
    return db().monitor.create({ data: $.data as Record<string, unknown> })
  },

  async patch() {
    await getScoped('monitor', 'Monitor')
    const patch = narrowPatch($.data as Record<string, unknown>)
    if (changesNothing(patch)) return getScoped('monitor', 'Monitor')
    return db().monitor.update({ where: { id: $.id as string }, data: patch })
  },

  async remove() {
    const monitor = await getScoped('monitor', 'Monitor')
    // A real delete: the schema cascades the checks, events and channel links.
    await db().monitor.remove({ where: { id: monitor.id } })
    return monitor
  },

  // ── history ───────────────────────────────────────────────────────
  // Read-shaped: it opts out of the announcement every other method makes.
  async history() {
    const monitor = await getScoped('monitor', 'Monitor')
    const { limit, offset } = getPagination()
    $.dispatch = false

    const { rows, total } = await db().monitorEvent.findManyAndCount({
      where:   { monitorId: monitor.id },
      orderBy: { at: 'desc' },
      limit, offset,
    })
    return { total, limit, offset, data: rows }
  },

  // ── pause / resume ────────────────────────────────────────────────
  // The declared moves, each at the level the schema puts on it. A paused
  // monitor comes back `pending`, not `up`: nothing has graded it since.
  async pause() {
    const monitor = await getScoped('monitor', 'Monitor')
    return withDetail(await db().monitor.transition(monitor.id, 'pause'))
  },

  async resume() {
    const monitor = await getScoped('monitor', 'Monitor')
    return withDetail(await db().monitor.transition(monitor.id, 'resume'))
  },

  // ── attachChannel / detachChannel ─────────────────────────────────
  async attachChannel() {
    const monitor = await getScoped('monitor', 'Monitor')
    const { channelId } = $.data as { channelId: string }

    // Scoped to the workspace, not merely to existence — an id from another
    // workspace would otherwise route this workspace's pages elsewhere.
    const channel = await db().notificationChannel.findFirst({
      where: { id: channelId, workspaceId: ws() },
    })
    if (!channel) throw new NotFound(`Channel '${channelId}' not found in this workspace`)

    if (await db().monitorChannel.exists({ where: { monitorId: monitor.id, channelId } }))
      throw new Conflict('That channel is already attached to this monitor')

    await db().monitorChannel.create({ data: { monitorId: monitor.id, channelId } })
    return withDetail(monitor)
  },

  async detachChannel() {
    const monitor = await getScoped('monitor', 'Monitor')
    const { channelId } = $.data as { channelId: string }

    const link = await db().monitorChannel.findFirst({ where: { monitorId: monitor.id, channelId } })
    if (!link) throw new NotFound('That channel is not attached to this monitor')

    await db().monitorChannel.remove({ where: { id: link.id } })
    return withDetail(monitor)
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
