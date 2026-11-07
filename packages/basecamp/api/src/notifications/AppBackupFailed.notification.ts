// src/notifications/AppBackupFailed.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl, marked } from './_shared.ts'

export interface AppBackupFailedPayload {
  appId:   string
  appName: string
  /** What failed: the scheduled `backup`, the restore `drill` that proves one,
   *  or the refresh of the read-only `copy`, which keeps serving the old one. */
  what:    'backup' | 'drill' | 'copy'
  /** Why, in the machine's words. */
  error:   string
}

const TITLE = { backup: 'Scheduled backup', drill: 'Restore drill', copy: 'Read-only copy refresh' } as const

export default defineNotification<AppBackupFailedPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title(p.what === 'backup' ? 'App backup failed' : `${TITLE[p.what]} failed`)
    .body(`${p.appName}: ${p.error}`)
    .action('View app', `/apps/${p.appId}/`)
    .data({ appName: p.appName, what: p.what, error: p.error }),

  email: (p) => mail()
    .subject(marked('warning', `${TITLE[p.what]} failed — ${p.appName}`))
    .line(`The scheduled ${p.what} of ${p.appName} failed:`)
    .line(p.error)
    .line('Until one succeeds, this app\'s newest good copy is the last one that did.')
    .action('View app', appUrl(`/apps/${p.appId}/`)),
})
