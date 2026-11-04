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

/** What the App answers on from outside: its primary hostname, at the App's
 *  own health path when it declares one. */
export function managedMonitorUrl(hostname: string, healthCheck?: string | null): string {
  return `https://${hostname}${healthCheck || '/'}`
}

/**
 * Bring an App's managed Monitor in line with the App and its primary Domain:
 * create it, regenerate its `url`, or remove it when the App is gone or has no
 * hostname left. `sys` is an `asSystem()` client — `isManaged` is `@system`, and
 * a person removing the row is refused by the monitors service. Returns the
 * row, or null when the App has none.
 */
export async function syncManagedMonitor(app: App, sys: any, appId: string) {
  const owner   = await sys.app.findFirst({ where: { id: appId } })
  const primary = owner ? await sys.domain.findFirst({ where: { appId, isPrimary: true } }) : null
  const managed = await sys.monitor.findFirst({ where: { appId, isManaged: true } })

  if (!primary) {
    if (!managed) return null
    // Before the delete: the cascade takes the channel links the resolve goes through.
    await resolveDownMonitor(app, sys, managed, 'Monitor removed with its App\'s last hostname')
    await sys.monitor.remove({ where: { id: managed.id } })
    return null
  }

  const url = managedMonitorUrl(primary.hostname, owner.healthCheck)
  if (!managed) return sys.monitor.create({ data: {
    workspaceId: owner.workspaceId, appId, name: owner.name, url, isManaged: true,
  } })
  if (managed.url === url) return managed
  // Due at once: the grade the row holds is the old hostname's.
  return sys.monitor.update({
    where: { id: managed.id },
    data:  { url, nextCheckAt: new Date().toISOString() },
  })
}
