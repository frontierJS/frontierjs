// src/domain/monitor/managed.ts — the Monitor the system keeps for an App (`FJS-D1859`).
//
// An App with a primary Domain is probed from outside without anyone creating
// a Monitor for it. The row is an ordinary Monitor, so the sweep, checks,
// uptime days and channels all apply, and `isManaged` marks it as the
// system's: one per App, found by `appId` + `isManaged`, with a `url` that is
// regenerated here on every write that could move it. A hand-made Monitor
// naming the same `appId` is never touched.

import type { App } from '@frontierjs/junction'
import { resolveDownMonitor } from './resolve.ts'

/** What the App answers on from outside: its primary hostname at `/`, with the
 *  Domain's port when it is not https' own (`FJS-D1867`, `FJS-D1868`). The App's
 *  health path is left out on purpose: it may be unrouted or unauthenticated
 *  from outside, and what the monitor asks is what a visitor asks. */
export function managedMonitorUrl(hostname: string, port: number | null = 443): string {
  const suffix = port && port !== 443 ? `:${port}` : ''
  return `https://${hostname}${suffix}/`
}

const now = () => new Date().toISOString()

/**
 * Bring an App's managed Monitor in line with the App and its primary Domain:
 * create it, regenerate its `url`, pause it while the App is removed and
 * resume it when the App comes back (`FJS-D1870`), or remove it when the App
 * has no hostname left. `sys` is an `asSystem()` client — `isManaged` is
 * `@system`, and a person removing the row is refused by the monitors service.
 * Returns the row, or null when the App has none.
 */
export async function syncManagedMonitor(app: App, sys: any, appId: string) {
  const owner   = await sys.app.findFirst({ where: { id: appId } })
  const primary = owner ? await sys.domain.findFirst({ where: { appId, isPrimary: true } }) : null
  const managed = await sys.monitor.findFirst({ where: { appId, isManaged: true } })

  if (!owner) {
    // Removed, not gone: the uptime history stays with the row, and a restore
    // resumes it. A row the person already paused is left as it is.
    if (!managed || managed.status === 'paused') return managed ?? null
    await resolveDownMonitor(app, sys, managed, 'Monitor paused with its App\'s removal')
    return sys.monitor.transition(managed.id, 'pause')
  }

  if (!primary) {
    if (!managed) return null
    // Before the delete: the cascade takes the channel links the resolve goes through.
    await resolveDownMonitor(app, sys, managed, 'Monitor removed with its App\'s last hostname')
    await sys.monitor.remove({ where: { id: managed.id } })
    return null
  }

  const url = managedMonitorUrl(primary.hostname, primary.port)
  if (!managed) return sys.monitor.create({ data: {
    workspaceId: owner.workspaceId, appId, name: owner.name, url, isManaged: true,
  } })

  let row = managed
  if (row.status === 'paused') {
    // The App is back. The streak is the old outage's, as in the service's resume.
    await sys.monitor.transition(row.id, 'resume')
    row = await sys.monitor.update({ where: { id: row.id }, data: { failStreak: 0, nextCheckAt: now() } })
  }
  if (row.url === url) return row
  // The grade the row holds is the old hostname's: back to pending, due at once.
  if (row.status === 'up' || row.status === 'down') {
    await resolveDownMonitor(app, sys, row, 'Monitor moved to a new hostname')
    await sys.monitor.transition(row.id, 'retarget')
  }
  return sys.monitor.update({
    where: { id: row.id },
    data:  { url, failStreak: 0, nextCheckAt: now() },
  })
}
