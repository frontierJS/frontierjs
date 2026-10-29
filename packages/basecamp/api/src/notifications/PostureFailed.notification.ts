// src/notifications/PostureFailed.notification.ts

import { defineNotification, inApp, mail, push } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface PostureFailedPayload {
  serverId:   string
  serverName: string
  /** The controls that moved to failing in this report, each `id: message`. */
  failed:     string[]
}

export default defineNotification<PostureFailedPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Server posture failing')
    .body(`${p.serverName}: ${p.failed.join('; ')}`)
    .action('View server', `/servers/${p.serverId}/`)
    .context('Server', p.serverId)
    .data({ serverName: p.serverName, failed: p.failed }),

  // A finding, not an outage: loud enough to ring, not loud enough to break
  // through do-not-disturb.
  push: (p) => push()
    .title('Server posture failing')
    .body(`${p.serverName}: ${p.failed.join('; ')}`)
    .priority(4)
    .tags('warning')
    .url(appUrl(`/servers/${p.serverId}/`))
    .build(),

  email: (p) => mail()
    .subject(`Server posture failing — ${p.serverName}`)
    .line(`${p.serverName} reported a security control that stopped holding:`)
    .line(p.failed.join('\n'))
    // A finding, not an outage: nothing here refuses a deploy, so the mail is
    // the only thing that makes a drifted box different from a clean one.
    .line('Deploys to it continue. The server page shows every control and when each one moved.')
    .action('View server', appUrl(`/servers/${p.serverId}/`)),
})
