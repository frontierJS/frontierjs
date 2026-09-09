// src/notifications/server_unreachable.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface ServerUnreachablePayload {
  serverId:   string
  serverName: string
  /** When the machine was last heard from. Stated rather than a duration: a
   *  notification is read at an unknown later time, and "quiet for 6 minutes"
   *  is wrong by however long it sat in a mailbox. */
  lastSeenAt: string | null
}

export default defineNotification<ServerUnreachablePayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Server unreachable')
    .body(`${p.serverName} has stopped checking in.`)
    .action('View server', `/servers/${p.serverId}/`)
    .context('Server', p.serverId)
    .data({ serverName: p.serverName, lastSeenAt: p.lastSeenAt }),

  email: (p) => mail()
    .subject(`Server unreachable — ${p.serverName}`)
    .line(`${p.serverName} has stopped checking in.`)
    // What this notice cannot say, said rather than implied. The Outpost is
    // what reports, so its silence means either the machine is gone or only the
    // Outpost is — and the apps on a machine whose Outpost died keep serving.
    .line('Its apps may still be running: what stopped is the Outpost reporting, and this app cannot tell the two apart from here.')
    .line(p.lastSeenAt ? `Last check-in: ${p.lastSeenAt}` : 'No check-in has ever been recorded.')
    .action('View server', appUrl(`/servers/${p.serverId}/`)),
})
