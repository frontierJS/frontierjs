// src/domain/notification/owed.ts — the notice a state move owes, and who pays it.
//
// A monitor going down and a machine going quiet are moves first and notices
// second. When the two were separate writes a crash between them left the row
// `down` or `unreachable` with nobody ever told, because the next sweep sees a
// row already in its new state and has nothing to move (`FJS-3858`). So the
// move's event row carries `noticeOwedAt`, written in the move's transaction,
// and it is cleared here once the people were told and every channel either
// delivered or holds a queued retry (`FJS-D1801`). Anything still owed is
// re-driven by the next sweep through `notify:deliver`.
//
// At least once, on purpose: a crash after the send and before the clear sends
// again, and a duplicate page is the failure a pager can survive. PagerDuty
// folds it into the open incident by its dedup key.

import { fanOutToChannels } from './delivery.ts'
import { notifyPeople, workspaceMembers } from './notify.ts'
import type { App } from '@frontierjs/junction'

export type OwedKind = 'monitor' | 'server'

/** How long an owed notice waits before a sweep re-drives it. The move's own
 *  pass delivers inline; a re-drive inside this window would race that pass
 *  and page twice for one move. */
export const OWED_GRACE_MS = 2 * 60_000

/** What a monitor's notice says, from what the sweep knows. One builder, so the
 *  move's own send, a resend and a re-driven send cannot word it three ways. */
export async function noticeMonitor(
  app: App, db: any,
  monitor: { id: string; name: string; workspaceId: string },
  notice:  { down: boolean; message: string; resend?: boolean },
): Promise<void> {
  const { down, message } = notice
  // People and channels fail separately, and neither may cost the other. A
  // throw from people is rethrown after the channels ran, so an owed notice
  // whose people were not told stays owed.
  let peopleErr: unknown = null
  try {
    await notifyPeople(app, down ? 'MonitorDown' : 'MonitorUp',
      await workspaceMembers(app, monitor.workspaceId), {
        monitorId:   monitor.id,
        monitorName: monitor.name,
        message,
        resend:      !!notice.resend,
      }, monitor.workspaceId)
  } catch (err) { peopleErr = err }

  const links = await db.monitorChannel.findMany({
    where:   { monitorId: monitor.id },
    include: { channel: true },
  })
  await fanOutToChannels(app, () => db, links.map((l: any) => l.channel), {
    title:    `[${down ? 'down' : 'recovered'}] ${monitor.name}`,
    text:     message,
    severity: down ? 'critical' : 'info',
    action:   down ? 'trigger' : 'resolve',
    // One open incident per monitor, which `nextState` guarantees, so the
    // monitor's id is the key that lets a recovery close what the outage opened.
    dedupKey: `basecamp:monitor:${monitor.id}`,
  }, `monitor-sweep ${monitor.name}`)

  if (peopleErr) throw peopleErr
}

/** The channels a machine's going and coming pages: the workspace's live ones
 *  that have not opted out. A Server has no channel join the way a Monitor has
 *  `MonitorChannel`, so the column is the whole of the choice (`FJS-3895`). */
async function fleetChannels(db: any, workspaceId: string): Promise<any[]> {
  return db.notificationChannel.findMany({
    where: { workspaceId, isActive: true, isPagedForFleet: true, deletedAt: null },
  })
}

/** What a machine going quiet says: the workspace's people, then every channel
 *  that pages the fleet. People and channels fail separately, as in
 *  `noticeMonitor`; a throw from people is rethrown after the channels ran. */
export async function noticeServer(
  app: App,
  server: { id: string; name: string; workspaceId: string },
  lastSeenAt: string | null,
): Promise<void> {
  let peopleErr: unknown = null
  try {
    await notifyPeople(app, 'ServerUnreachable',
      await workspaceMembers(app, server.workspaceId), {
        serverId:   server.id,
        serverName: server.name,
        lastSeenAt,
      }, server.workspaceId)
  } catch (err) { peopleErr = err }

  const db = (app.db as any).asSystem()
  await fanOutToChannels(app, () => db, await fleetChannels(db, server.workspaceId), {
    title:    `[unreachable] ${server.name}`,
    text:     lastSeenAt
      ? `${server.name} has stopped checking in. Last heard from ${lastSeenAt}.`
      : `${server.name} has stopped checking in.`,
    severity: 'critical',
    action:   'trigger',
    dedupKey: `basecamp:server:${server.id}`,
  }, `server-reachability ${server.name}`)

  if (peopleErr) throw peopleErr
}

/** The machine answered again: close what `noticeServer` opened, on the same
 *  channels under the same key. Best effort -- a check-in is the machine's own
 *  report, and a Slack outage must not fail it. */
export async function resolveServer(
  app: App,
  server: { id: string; name: string; workspaceId: string },
): Promise<void> {
  try {
    const db = (app.db as any).asSystem()
    await fanOutToChannels(app, () => db, await fleetChannels(db, server.workspaceId), {
      title:    `[recovered] ${server.name}`,
      text:     `${server.name} is checking in again.`,
      severity: 'info',
      action:   'resolve',
      dedupKey: `basecamp:server:${server.id}`,
    }, `server-reachability ${server.name}`)
  } catch (err) {
    console.error(`[notify] resolving server ${server.id}: ${(err as Error).message}`)
  }
}

/**
 * Pay one owed notice and clear it. Answers whether anything was owed.
 *
 * Reads the event row rather than taking the notice from its caller, so the
 * move's own pass, the job and a re-drive after a crash send the same words.
 * A throw leaves the notice owed, which is the point.
 */
export async function deliverOwed(app: App, kind: OwedKind, eventId: string): Promise<boolean> {
  const db = (app.db as any).asSystem()
  if (kind === 'monitor') {
    const event = await db.monitorEvent.findFirst({
      where: { id: eventId, noticeOwedAt: { not: null } }, include: { monitor: true } })
    if (!event?.monitor) return false
    await noticeMonitor(app, db, event.monitor, { down: event.toStatus === 'down', message: event.message })
    await db.monitorEvent.updateMany({ where: { id: eventId }, data: { noticeOwedAt: null } })
    return true
  }
  const event = await db.serverEvent.findFirst({
    where: { id: eventId, noticeOwedAt: { not: null } }, include: { server: true } })
  if (!event?.server) return false
  const meta = (event.metadata ?? {}) as { last_heartbeat_at?: string | null }
  await noticeServer(app, event.server, meta.last_heartbeat_at ?? null)
  await db.serverEvent.updateMany({ where: { id: eventId }, data: { noticeOwedAt: null } })
  return true
}

/**
 * Hand every notice still owed from before `at - OWED_GRACE_MS` to
 * `notify:deliver`, or pay it here where the app runs no queue. Answers how
 * many were re-driven. `unique` per event is what keeps two sweeps from
 * queueing one notice twice while the first is in flight.
 */
export async function redriveOwed(app: App, kind: OwedKind, at: number): Promise<number> {
  const db     = (app.db as any).asSystem()
  const before = new Date(at - OWED_GRACE_MS).toISOString()
  const where  = { noticeOwedAt: { not: null, lt: before } }
  const owed   = kind === 'monitor'
    ? await db.monitorEvent.findMany({ where, limit: 500 })
    : await db.serverEvent.findMany({ where, limit: 500 })

  let n = 0
  for (const event of owed) {
    try {
      if ('jobs' in app)
        await (app as any).jobs.dispatch('notify:deliver', { owed: kind, eventId: event.id },
          { unique: `notice:${kind}:${event.id}`, actor: null })
      else await deliverOwed(app, kind, event.id)
      n++
    } catch (err) {
      console.error(`[notify] re-driving ${kind} notice ${event.id}: ${(err as Error).message}`)
    }
  }
  return n
}
