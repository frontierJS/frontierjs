// src/jobs/dependency-check.job.ts — what the registry says about every
// Dependency a project has pushed.
//
// Daily, and after every push for that push's workspace, because a push is the
// moment a new name or a new installed version arrives with nothing known about
// it. The registry columns are @system, so the app is the only writer and the
// handler runs as it.

import { defineJob }           from '@frontierjs/caravan'
import { runsAsApp }           from './context.ts'
import { refreshDependencies } from '../core/dependencies.ts'

export interface DependencyCheckPayload { workspaceId?: string }

/**
 * Check one workspace's names (a push) or every workspace's (the cron).
 *
 * A name the registry could not answer keeps its previous answer and records
 * why in `checkError`; a whole run that answered nothing throws, so the queue
 * retries a registry that was down rather than recording a day of errors.
 */
export default defineJob<DependencyCheckPayload>({
  cron: '15 6 * * *', queue: 'sync', maxAttempts: 3, retryDelay: [60_000, 600_000], timeout: 300_000,
  handler: async (ctx) => {
    const { app, db } = runsAsApp(ctx, 'dependency-check')
    const res = await refreshDependencies(app, db, { workspaceId: ctx.data?.workspaceId })

    if (res.checked && res.failed === res.checked)
      throw new Error(`[dependency-check] no registry answer for any of ${res.checked} package(s)`)
    if (res.failed)
      console.warn(`[dependency-check] ${res.failed} of ${res.checked} package(s) could not be checked`)
  },
})
