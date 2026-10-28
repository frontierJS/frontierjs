// src/jobs/restore-reconcile.job.ts
// Dispatched once by `app.ts` at the boot that swapped a staged archive in
// (`restoreStaged` answered `done`); the work is `domain/backup/found-replicas.ts`,
// then one `app-archive:rescan` per app with a backup destination, since the
// restored rows are as old as the archive and the buckets are not.
// The app's own work, so SYSTEM (`runsAsApp`): the replicas span workspaces.
//
// Queued rather than run inline: each finding is a bucket round trip, and
// boot must not wait on a bucket.

import { defineJob }      from '@frontierjs/caravan'
import { runsAsApp }      from './context.ts'
import { reconcileFound } from '../domain/backup/found-replicas.ts'
import { queueAppArchiveRescan } from './app-archive-rescan.job.ts'

export default defineJob({
  name:        'restore:reconcile',
  queue:       'fleet',
  maxAttempts: 3,
  retryDelay:  [30_000, 120_000],
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'restore:reconcile')
    const findings = await reconcileFound(app)
    const log = app.logger.child('restore-reconcile')
    for (const f of findings) {
      if ('error' in f) log.warn('replica not listed', f)
      else              log.info(f.databases.length ? 'replica found' : 'replica empty', f)
    }
    const backedUp = await (app.db as any).asSystem().app.findMany({
      where: { backupDestinationId: { not: null }, deletedAt: null }, select: { id: true },
    }) as { id: string }[]
    for (const a of backedUp) await queueAppArchiveRescan(app, a.id)
  },
})
