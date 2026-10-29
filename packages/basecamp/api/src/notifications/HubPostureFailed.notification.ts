// src/notifications/HubPostureFailed.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface HubPostureFailedPayload {
  /** Each failing `hub.*` control as `id: message — fix`. */
  failed: string[]
}

export default defineNotification<HubPostureFailedPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Installation needs attention')
    .body(p.failed.join('; '))
    .action('View host security', '/hub/security/')
    .data({ failed: p.failed }),

  email: (p) => mail()
    .subject(`Basecamp needs attention — ${p.failed.length} failing`)
    .line('A check on the box this Basecamp runs on is failing:')
    .line(p.failed.join('\n'))
    // Sent daily while anything fails, so a quiet day is the all-clear.
    .line('This repeats each day until every check passes.')
    .action('View host security', appUrl('/hub/security/')),
})
