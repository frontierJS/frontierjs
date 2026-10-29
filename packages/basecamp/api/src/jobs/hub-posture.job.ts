// src/jobs/hub-posture.job.ts — tells the system admins what /hub/security/ is failing.
//
// The `hub.*` controls are graded on read, so before this job a backup five
// days stale or an install with no mailer was found only by someone opening
// the screen. Daily rather than on change: the env controls move only at a
// restart and the backup one by days, and a reminder that repeats until it is
// fixed needs no row remembering what was already sent.

import { defineJob }    from '@frontierjs/caravan'
import { runsAsApp }    from './context.ts'
import { gradeHubNow }  from '../domain/host/host-machine.ts'
import { notifyPeople } from '../domain/notification/notify.ts'

/** Notify every system admin of the failing `hub.*` controls; answers how many were told. */
export async function notifyHubPosture(app: any, db: any, now = Date.now()): Promise<number> {
  const { hub }  = await gradeHubNow(db, app.push, now)
  const failing  = hub.filter(c => c.ok === false)
  if (!failing.length) return 0

  const admins = await db.user.findMany({ where: { isSystemAdmin: true }, select: { id: true } })
  return notifyPeople(app, 'HubPostureFailed', admins.map((u: any) => u.id as string), {
    failed: failing.map(c => `${c.id}: ${c.message}${c.fix ? ` — ${c.fix}` : ''}`),
  })
}

export default defineJob({
  cron: '0 9 * * *',
  handler: async (ctx) => {
    const { app, db } = runsAsApp(ctx, 'hub-posture')
    await notifyHubPosture(app, db)
  },
})
