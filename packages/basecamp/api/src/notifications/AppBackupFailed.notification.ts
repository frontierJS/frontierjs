// src/notifications/AppBackupFailed.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface AppBackupFailedPayload {
  appId:   string
  appName: string
  /** What failed: the scheduled `backup`, or the restore `drill` that proves one. */
  what:    'backup' | 'drill'
  /** Why, in the machine's words. */
  error:   string
}

export default defineNotification<AppBackupFailedPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title(p.what === 'drill' ? 'Restore drill failed' : 'App backup failed')
    .body(`${p.appName}: ${p.error}`)
    .action('View app', `/apps/${p.appId}/`)
    .data({ appName: p.appName, what: p.what, error: p.error }),

  email: (p) => mail()
    .subject(`${p.what === 'drill' ? 'Restore drill' : 'Scheduled backup'} failed — ${p.appName}`)
    .line(`The scheduled ${p.what} of ${p.appName} failed:`)
    .line(p.error)
    .line('Until one succeeds, this app\'s newest good copy is the last one that did.')
    .action('View app', appUrl(`/apps/${p.appId}/`)),
})
