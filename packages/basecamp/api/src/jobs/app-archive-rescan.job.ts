// src/jobs/app-archive-rescan.job.ts
// One app's archives in its bucket that no row names, found and then read
// through once for their sha256 (`FJS-D1572`); the work is
// `domain/backup/backup-archives.ts`. Dispatched by `restore:reconcile` for
// every app with a backup destination, and by `app-backups.rescan` (a person).
//
// Queued rather than run inline: hashing reads every found archive whole.
// The app's own work, so SYSTEM (`runsAsApp`), as `backup:run` is when a
// person asks for it.

import { defineJob }                            from '@frontierjs/caravan'
import { runsAsApp }                            from './context.ts'
import { rescanAppArchives, hashFoundArchives } from '../domain/backup/backup-archives.ts'
import type { App }                             from '@frontierjs/junction'

const appArchiveRescan = defineJob<{ appId: string }>({
  name:        'app-archive:rescan',
  queue:       'fleet',
  maxAttempts: 3,
  retryDelay:  [30_000, 120_000],
  // A read that hangs would hold the fleet queue. A retry loses nothing: a
  // row already hashed is not read again.
  timeout:     2 * 3600_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'app-archive:rescan')
    const log     = app.logger.child('app-archive-rescan')
    const listing = await rescanAppArchives(app, ctx.data.appId)
    if ('error' in listing) log.warn('app archives not listed', { app_id: ctx.data.appId, error: listing.error })
    else                    log.info('app archives listed', { app_id: ctx.data.appId, ...listing })
    // Rows an earlier listing left unhashed are read even when this one failed.
    const hashed = await hashFoundArchives(app, ctx.data.appId)
    if (hashed.hashed || hashed.failed) log.info('found app archives read', { app_id: ctx.data.appId, ...hashed })
  },
})

export default appArchiveRescan

/** One rescan per app at a time; a second ask while one is queued is the same work. */
export function queueAppArchiveRescan(app: App, appId: string) {
  return app.jobs.dispatch(appArchiveRescan, { appId }, { unique: `app-archive:rescan:${appId}`, actor: null, tenant: null })
}
