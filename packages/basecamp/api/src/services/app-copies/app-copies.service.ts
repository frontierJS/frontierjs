// src/services/app-copies/app-copies.service.ts
// An app's read-only copy turned on, moved or turned off (`FJS-D2001`,
// `IDEAS/read-only-copy.md` 2.1). The row is the copy being on; the refresh
// and every call to a machine are `jobs/app-copy-refresh.job.ts`'s.
//
// Mounted at /app-copies, `?appId=<id>` for one app's. ADMINISTRATOR
// throughout, by the model's `@@gate(5)`, matching `apps.restoreReplica`: a
// copy serves the app's data on a machine the caller picks.
//
// A change the clock does not see is a copy nobody can explain, so every
// write that touches `cron` or the row calls `syncAppCopySchedule`, and a
// cron the clock cannot hold is refused before the write.

import { createService, BadRequest, $ }                  from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, narrowPatch, changesNothing, actor } from '../../core/resource.ts'
import { cronProblem, syncAppCopySchedule }             from '../../domain/job/job-schedule.ts'
import appCopyRefresh, { unserveCopy }                  from '../../jobs/app-copy-refresh.job.ts'
import { keyScope }                                     from '../../domain/api-key/scopes.ts'

function checkCron(data: Record<string, unknown>): void {
  const problem = typeof data.cron === 'string' && cronProblem(data.cron)
  if (problem) throw new BadRequest(`cron: ${problem}`)
}

/** The machine is read through the caller's client, so another workspace's is not found. */
async function machineOf(serverId: unknown) {
  if (typeof serverId !== 'string' || !serverId) throw new BadRequest('A copy runs on a machine — name one with serverId')
  return getScoped('server', 'Server', serverId)
}

/** A refresh now, so turning a copy on is a copy within minutes rather than at its first cron. */
const refreshNow = (appId: string) => $.app.jobs.dispatch(appCopyRefresh, { appId })

export default createService({
  name:    'appCopies',
  scope:   keyScope('appCopies'),
  model:   'AppCopy',
  channel: workspaceChannel,
  reservedQuery: WORKSPACE_QUERY,
  methods: ['find', 'get', 'create', 'patch', 'remove'],

  async find() {
    const { limit, offset } = getPagination()
    const where: Record<string, unknown> = {}
    for (const key of ['appId', 'serverId'])
      if ($.query[key]) where[key] = $.query[key]
    return findScoped('appCopy', { where, limit, offset })
  },

  get: () => getScoped('appCopy', 'Read-only copy'),

  async create() {
    const data = { ...($.data as Record<string, unknown>) }
    checkCron(data)
    const target = await getScoped('app', 'App', data.appId as string)
    await machineOf(data.serverId)
    if (await db().appCopy.exists({ where: { appId: target.id } }))
      throw new BadRequest(`App '${target.slug}' already has a read-only copy; change it rather than adding a second`)
    const created = await db().appCopy.create({ data: { ...data, requestedBy: actor() } })
    syncAppCopySchedule($.app, target.id, created, !!target.deletedAt)
    await refreshNow(target.id)
    return created
  },

  async patch() {
    const current = await getScoped('appCopy', 'Read-only copy')
    const patch   = narrowPatch($.data as Record<string, unknown>)
    delete patch.appId
    delete patch.requestedBy
    if (changesNothing(patch)) return current
    checkCron(patch)
    const moved = 'serverId' in patch && patch.serverId !== current.serverId
    if (moved) await machineOf(patch.serverId)

    let updated = await db().appCopy.update({ where: { id: current.id }, data: patch })
    syncAppCopySchedule($.app, current.appId, updated)
    if (!moved) return updated

    // The old machine's copy is not this row's any more, and its as-of
    // would describe a copy the new machine has not served.
    const old = await db().server.findFirst({ where: { id: current.serverId } })
    const machine = await unserveCopy($.app, current.appId, current.serverId, old?.name)
    updated = await db().asSystem().appCopy.update({
      where: { id: current.id },
      data:  { status: null, asOf: null, error: null, refreshedAt: null },
    })
    await refreshNow(current.appId)
    return { ...updated, machine }
  },

  async remove() {
    const row    = await getScoped('appCopy', 'Read-only copy')
    const server = await db().server.findFirst({ where: { id: row.serverId } })
    await db().appCopy.delete({ where: { id: row.id } })
    syncAppCopySchedule($.app, row.appId, null)
    const machine = await unserveCopy($.app, row.appId, row.serverId, server?.name)
    return { ...row, machine }
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
