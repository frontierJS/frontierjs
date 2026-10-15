// src/notifications/monitor_down.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface MonitorDownPayload {
  monitorId:   string
  monitorName: string
  /** What the last probe saw (`Request failed with status code 502`). */
  message:     string
  /** The monitor was already down and this is the reminder, not the outage. */
  resend:      boolean
}

export default defineNotification<MonitorDownPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title(p.resend ? 'Monitor still down' : 'Monitor down')
    .body(`${p.monitorName}: ${p.message}`)
    .action('View monitor', `/monitors/${p.monitorId}/`)
    .context('Monitor', p.monitorId)
    .data({ monitorName: p.monitorName, message: p.message, resend: p.resend }),

  email: (p) => mail()
    .subject(`${p.resend ? 'Still down' : 'Down'} — ${p.monitorName}`)
    .line(`${p.monitorName} is not answering.`)
    .line(p.message)
    .action('View monitor', appUrl(`/monitors/${p.monitorId}/`)),
})
