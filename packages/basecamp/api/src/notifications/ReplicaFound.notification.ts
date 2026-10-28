// src/notifications/ReplicaFound.notification.ts
// One per workspace after a hub restore, naming every app whose replica the
// reconcile found (`jobs/restore-reconcile.job.ts`). An app still running
// shows no card on its screen, so the notice says the card decides.

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface ReplicaFoundPayload {
  workspaceId: string
  apps:        { id: string; name: string; syncedAt: string | null }[]
}

const line = (a: ReplicaFoundPayload['apps'][number]) =>
  `${a.name} — last synced ${a.syncedAt ?? 'at an unknown time'}`

export default defineNotification<ReplicaFoundPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title(p.apps.length === 1 ? 'Replica found' : `${p.apps.length} replicas found`)
    .body(`Basecamp was restored, and the bucket holds a replica of ${p.apps.map(a => a.name).join(', ')}.`)
    .action('View apps', '/apps/')
    .context('Workspace', p.workspaceId)
    .data({ apps: p.apps }),

  email: (p) => {
    const m = mail()
      .subject(`Basecamp restored — ${p.apps.length === 1 ? 'a replica' : `${p.apps.length} replicas`} found`)
      .line('Basecamp was restored from an archive, and these apps have a replica in their bucket:')
    for (const a of p.apps) m.line(line(a))
    return m
      .line('An app still running needs nothing. One that is gone offers its restore on its own screen.')
      .action('View apps', appUrl('/apps/'))
  },
})
