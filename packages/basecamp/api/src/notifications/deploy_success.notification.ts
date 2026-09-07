// src/notifications/deploy_success.notification.ts
//
// THE FILE NAME IS THE TYPE AND THE TYPE IS A `NotificationKind`. The loader
// stamps `deploy_success` verbatim onto every row it writes, and that is the
// same string `NotificationPreference.kind` holds — which is what makes the
// preference screen decidable against the senders instead of decorative.
// `db/test/schema.test.ts` holds the enum, `kinds.ts` and this directory
// together, both directions. Renaming this file renames a persisted value.

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface DeployPayload {
  deploymentId: string
  appName:      string
  environment:  string
  release?:     string
}

const where = (p: DeployPayload) => `${p.appName} → ${p.environment}`

export default defineNotification<DeployPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Deploy succeeded')
    .body(`${where(p)}${p.release ? ` — ${p.release}` : ''}`)
    .action('View deployment', `/deployments/${p.deploymentId}/`)
    // A loose reference with no foreign key: a deleted deployment leaves this
    // row readable as a dead link rather than cascading it away.
    .context('Deployment', p.deploymentId)
    .data({ appName: p.appName, environment: p.environment, release: p.release }),

  email: (p) => mail()
    .subject(`Deploy succeeded — ${where(p)}`)
    .line(`${where(p)} is live${p.release ? ` at ${p.release}` : ''}.`)
    .action('View deployment', appUrl(`/deployments/${p.deploymentId}/`)),
})
