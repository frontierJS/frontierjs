// src/notifications/alert_resolved.notification.ts
//
// Its default is in-app only, and that is a judgement rather than a shrug: a
// recovery is worth knowing and is not worth an interruption. See `kinds.ts` —
// **in-app is cheap and email is an interruption**.

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'
import type { AlertPayload }               from './alert_firing.notification.ts'

export default defineNotification<AlertPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title(`${p.ruleName} recovered`)
    .body(p.message)
    .action('View alerts', '/alerts/')
    .context('AlertEvent', p.eventId)
    .data({ ruleName: p.ruleName, severity: p.severity, message: p.message }),

  email: (p) => mail()
    .subject(`Resolved — ${p.ruleName}`)
    .line(p.message)
    .action('View alerts', appUrl('/alerts/')),
})
