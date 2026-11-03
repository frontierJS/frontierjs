// src/jobs/backup-verify.job.ts -- reads the newest hub archive back, weekly (`FJS-3881`).
//
// An archive nobody has restored is a guess. The drill lands as an `AppDrill`
// on the hub App (`domain/backup/archive-drill.ts`); a failed one tells every
// system admin through `HubPostureFailed`, the notice a stale backup already
// uses. A week rather than a day: the archive is the same bytes until the next
// backup, and a download of up to a gigabyte is not worth repeating.

import { defineJob }       from '@frontierjs/caravan'
import { runsAsApp }       from '../domain/job/job-context.ts'
import { drillHubArchive } from '../domain/backup/archive-drill.ts'
import { notifyPeople }    from '../domain/notification/notify.ts'

/** Drill once and tell the admins if it failed. Answers the drill's outcome. */
export async function verifyHubBackup(app: any, db: any): Promise<'success' | 'failed' | 'skipped'> {
  const out = await drillHubArchive(app, { kind: 'scheduled' })
  if ('skipped' in out) { app.logger.child('backup-verify').info('hub archive not drilled', { why: out.skipped }); return 'skipped' }
  if (out.status === 'success') return 'success'

  const admins = await db.user.findMany({ where: { isSystemAdmin: true }, select: { id: true } })
  await notifyPeople(app, 'HubPostureFailed', admins.map((u: any) => u.id as string), {
    failed: [`hub.backup-restorable: the newest hub archive would not restore -- ${out.error}`],
  })
  return 'failed'
}

export default defineJob({
  cron: '0 4 * * 0',
  // A download, an unpack and an integrity_check of every database.
  timeout: 30 * 60_000,
  handler: async (ctx) => {
    const { app, db } = runsAsApp(ctx, 'backup-verify')
    await verifyHubBackup(app, db)
  },
})
