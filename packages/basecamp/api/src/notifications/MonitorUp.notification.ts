// src/notifications/MonitorUp.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface MonitorUpPayload {
  monitorId:   string
  monitorName: string
  message:     string
}

export default defineNotification<MonitorUpPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Monitor recovered')
    .body(`${p.monitorName}: ${p.message}`)
    .action('View monitor', `/monitors/${p.monitorId}/`)
    .context('Monitor', p.monitorId)
    .data({ monitorName: p.monitorName, message: p.message }),

  email: (p) => mail()
    .subject(`Recovered — ${p.monitorName}`)
    .line(`${p.monitorName} is answering again.`)
    .line(p.message)
    .action('View monitor', appUrl(`/monitors/${p.monitorId}/`)),
})
