// src/notifications/job_failed.notification.ts

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface JobFailedPayload {
  runId:   string
  jobId:   string
  jobName: string
  reason?: string
}

export default defineNotification<JobFailedPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title('Job failed')
    .body(`${p.jobName}${p.reason ? ` — ${p.reason}` : ''}`)
    .action('View run', `/jobs/${p.jobId}/`)
    .context('JobRun', p.runId)
    .data({ jobName: p.jobName, reason: p.reason }),

  email: (p) => mail()
    .subject(`Job failed — ${p.jobName}`)
    .line(`${p.jobName} ended in failure.`)
    .line(p.reason ? p.reason : 'No reason was recorded.')
    .action('View run', appUrl(`/jobs/${p.jobId}/`)),
})
