// src/jobs/release-image-export.job.ts
// Uploads a successful release's image to its App's replica bucket, and is the
// one place that asks a machine to export one (`POST /image/export`,
// Invariant 4). Dispatched as `release-image:export` by `deployment-run.job.ts`
// once a release is recorded `success`, for an App that names a replica
// destination (`FJS-D1914`).
//
// A failure is a warning and nothing else: the release shipped, `imageSha256`
// stays null, and a refresh of the copy elsewhere fails in its own words.

import { defineJob }                            from '@frontierjs/caravan'
import { runsAsApp }                            from '../domain/job/job-context.ts'
import { exportReleaseImage, IMAGE_EXPORT_TIMEOUT_MS } from '../domain/release/image-export.ts'

const releaseImageExport = defineJob<{ deploymentId: string; serverId: string }>({
  name:        'release-image:export',
  queue:       'fleet',
  maxAttempts: 1,
  timeout:     IMAGE_EXPORT_TIMEOUT_MS + 60_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'release-image:export')
    const { deploymentId, serverId } = ctx.data
    const result = await exportReleaseImage(app, deploymentId, serverId)
    if (!result.uploaded && result.reason)
      app.logger.child('release-image-export').warn('release image not exported', { deploymentId, reason: result.reason })
  },
})

export default releaseImageExport
