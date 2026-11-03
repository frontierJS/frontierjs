// src/notifications/MonitorCertExpiring.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface MonitorCertExpiringPayload {
  monitorId:   string
  monitorName: string
  /** Whole days left; zero or less is a certificate that has already expired. */
  daysLeft:    number
  expiresAt:   string
}

const when = (p: MonitorCertExpiringPayload) =>
  p.daysLeft <= 0 ? 'has expired' : `expires in ${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'}`

export default defineNotification<MonitorCertExpiringPayload>({
  via: declaredTransports,

  // The expiry is in the key: a renewed certificate is a new warning, and a
  // retried send of this one is not a second row.
  key: (p) => `cert:${p.monitorId}:${p.expiresAt}:${Math.max(0, p.daysLeft)}`,

  inApp: (p) => inApp()
    .title('Certificate expiring')
    .body(`${p.monitorName}: the certificate ${when(p)}`)
    .action('View monitor', `/monitors/${p.monitorId}/`)
    .context('Monitor', p.monitorId)
    .data({ monitorName: p.monitorName, daysLeft: p.daysLeft, expiresAt: p.expiresAt }),

  email: (p) => mail()
    .subject(`Certificate ${p.daysLeft <= 0 ? 'expired' : 'expiring'} — ${p.monitorName}`)
    .line(`The TLS certificate ${p.monitorName} presents ${when(p)} (${p.expiresAt}).`)
    .line('Renew it before visitors see a browser warning.')
    .action('View monitor', appUrl(`/monitors/${p.monitorId}/`)),
})
