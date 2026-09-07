// src/notifications/deploy_failed.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface DeployFailedPayload {
  deploymentId: string
  appName:      string
  environment:  string
  /** Which step stopped it. A failure with no step is one the pipeline could
   *  not attribute, which is worth saying rather than leaving blank. */
  step?:        string
  reason?:      string
}

const where = (p: DeployFailedPayload) => `${p.appName} → ${p.environment}`

export default defineNotification<DeployFailedPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Deploy failed')
    .body(`${where(p)}${p.step ? ` — stopped at ${p.step}` : ''}`)
    .action('View deployment', `/deployments/${p.deploymentId}/`)
    .context('Deployment', p.deploymentId)
    .data({ appName: p.appName, environment: p.environment, step: p.step, reason: p.reason }),

  email: (p) => mail()
    .subject(`Deploy FAILED — ${where(p)}`)
    .line(`${where(p)} did not finish.`)
    .line(p.step   ? `It stopped at ${p.step}.`   : 'The pipeline did not say which step stopped it.')
    .line(p.reason ? p.reason : 'No reason was recorded.')
    .action('View deployment', appUrl(`/deployments/${p.deploymentId}/`)),
})
