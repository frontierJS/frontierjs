// src/notifications/alert_firing.notification.ts
//
// **This is not the same thing as the alert fan-out**, and the distinction is
// the reason both exist. `alert-evaluate.job.ts` delivers a fired event to the
// rule's `NotificationChannel`s — Slack, PagerDuty, a webhook — which is where
// the WORKSPACE is paged. This tells one PERSON, in the app they are already
// looking at, and it is the thing they can switch off for themselves.

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface AlertPayload {
  eventId:  string
  ruleName: string
  severity: string
  message:  string
}

export default defineNotification<AlertPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title(`${p.ruleName} is firing`)
    .body(p.message)
    .action('View alerts', '/alerts/')
    .context('AlertEvent', p.eventId)
    .data({ ruleName: p.ruleName, severity: p.severity, message: p.message }),

  email: (p) => mail()
    .subject(`[${p.severity}] ${p.ruleName}`)
    .line(p.message)
    .action('View alerts', appUrl('/alerts/')),
})
