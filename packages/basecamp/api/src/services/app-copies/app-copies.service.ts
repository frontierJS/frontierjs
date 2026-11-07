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
//
// ─── Serve at the main address ───────────────────────────────────────────
//
// `isServingMainAddress` sends the App's users to the copy
// (`IDEAS/read-only-copy.md` 3.1): the copy's machine routes the App's
// hostnames first, then `ingress:dns` points the record there, and
// `servingAddresses` keeps it there until the switch is turned back. A copy
// that has never served, a move and turning the copy off are refused while it
// would leave users on nothing. Switching back is refused while the App runs on
// no machine, and the copy keeps answering the main hostnames until its next
// refresh, so a resolver still holding its address reaches the copy rather
// than a route that is gone.

import { createService, BadRequest, BadGateway, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, narrowPatch, changesNothing, actor } from '../../core/resource.ts'
import { cronProblem, syncAppCopySchedule }             from '../../domain/job/job-schedule.ts'
import appCopyRefresh, { unserveCopy, routeCopyHosts } from '../../jobs/app-copy-refresh.job.ts'
import ingressDns                                       from '../../jobs/ingress-dns.job.ts'
import appCopyCert                                      from '../../jobs/app-copy-cert.job.ts'
import { keyScope }                                     from '../../domain/api-key/scopes.ts'
import { copyAddressOf, placementAddresses, placementRefusal } from '../../domain/release/runtime.ts'
import type { AppCopy }                                 from '#db/schema.d.ts'

function checkCron(data: Record<string, unknown>): void {
  const problem = typeof data.cron === 'string' && cronProblem(data.cron)
  if (problem) throw new BadRequest(`cron: ${problem}`)
}

/** The machine is read through the caller's client, so another workspace's is not found. */
async function machineOf(serverId: unknown) {
  if (typeof serverId !== 'string' || !serverId) throw new BadRequest('A copy runs on a machine — name one with serverId')
  return getScoped('server', 'Server', serverId)
}

/**
 * A refresh now, so turning a copy on is a copy within minutes rather than at
 * its first cron. The app owns it as it owns the cron's: the job writes the
 * row's @system columns and refuses to run as the person who asked.
 */
const refreshNow = (appId: string) => $.app.jobs.dispatch(appCopyRefresh, { appId }, { actor: null })

/** The Domains' certificates follow the row (`FJS-D1988`): minted and pushed to
 *  the machine it is on, or dropped once it is off. Not behind the refresh, so
 *  a refresh that fails does not hide a mint that would too. */
const certsNow = (appId: string) => $.app.jobs.dispatch(appCopyCert, { appId }, { actor: null })

/** Refused, or the copy's machine routed, before the switch is written. */
async function switchMainAddress(current: AppCopy, on: boolean): Promise<void> {
  if (on) {
    if (!current.refreshedAt)
      throw new Conflict('The copy has not served yet, so there is nothing to send users to — wait for its first refresh to succeed')
    const refused = await routeCopyHosts($.app, current.appId, true)
    if (refused) throw new BadGateway(`Machine '${refused.server}' did not route the App's hostnames to the copy: ${refused.error}`)
    return
  }
  if (!(await placementAddresses($.app.db!, current.appId)).length)
    throw new Conflict(`The App runs on no machine to switch back to: ${await placementRefusal($.app.db!, current.appId)}`)
}

/** The record follows the row: `servingAddresses` reads it. */
const recordNow = (row: AppCopy) =>
  $.app.jobs.dispatch(ingressDns, { appId: row.appId }, { id: `ingress:${row.appId}:copy:${row.updatedAt}` })

/** The row with the address its machine answers it at, or `address: null`
 *  while the workspace has no ingress zone and wildcard (`FJS-D1982`). */
async function withAddress<T extends { appId: string }>(row: T): Promise<T & { address: string | null }> {
  return { ...row, address: await copyAddressOf(db().asSystem(), row.appId) }
}

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
    const page = await findScoped('appCopy', { where, limit, offset })
    return { ...page, data: await Promise.all((page.data as AppCopy[]).map(withAddress)) }
  },

  get: async () => withAddress(await getScoped('appCopy', 'Read-only copy')),

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
    await certsNow(target.id)
    return withAddress(created)
  },

  async patch() {
    const current = await getScoped('appCopy', 'Read-only copy')
    const patch   = narrowPatch($.data as Record<string, unknown>)
    delete patch.appId
    delete patch.requestedBy
    if (changesNothing(patch)) return withAddress(current)
    checkCron(patch)
    const moved   = 'serverId' in patch && patch.serverId !== current.serverId
    const flipped = 'isServingMainAddress' in patch && !!patch.isServingMainAddress !== !!current.isServingMainAddress
    if (moved && (current.isServingMainAddress || patch.isServingMainAddress))
      throw new Conflict('The copy serves the main address — switch it back before moving the copy, or users are sent to a machine with no copy')
    if (moved) await machineOf(patch.serverId)
    if (flipped) await switchMainAddress(current, !!patch.isServingMainAddress)

    let updated = await db().appCopy.update({ where: { id: current.id }, data: patch })
    syncAppCopySchedule($.app, current.appId, updated)
    if (flipped) {
      await recordNow(updated)
      if (updated.isServingMainAddress) await certsNow(current.appId)
    }
    if (!moved) return withAddress(updated)

    // The old machine's copy is not this row's any more, and its as-of
    // would describe a copy the new machine has not served.
    const old = await db().server.findFirst({ where: { id: current.serverId } })
    const machine = await unserveCopy($.app, current.appId, current.serverId, old?.name)
    updated = await db().asSystem().appCopy.update({
      where: { id: current.id },
      data:  { status: null, asOf: null, error: null, refreshedAt: null, certError: null },
    })
    await refreshNow(current.appId)
    await certsNow(current.appId)
    return { ...await withAddress(updated), machine }
  },

  async remove() {
    const row    = await getScoped('appCopy', 'Read-only copy')
    if (row.isServingMainAddress)
      throw new Conflict('The copy serves the main address — switch it back before turning the copy off, or users are sent to a machine with no copy')
    const server = await db().server.findFirst({ where: { id: row.serverId } })
    await db().appCopy.delete({ where: { id: row.id } })
    syncAppCopySchedule($.app, row.appId, null)
    const machine = await unserveCopy($.app, row.appId, row.serverId, server?.name)
    await certsNow(row.appId)
    return { ...row, machine }
  },

  hooks: {
    before: { all: [sessionScope()] },
  },
})
