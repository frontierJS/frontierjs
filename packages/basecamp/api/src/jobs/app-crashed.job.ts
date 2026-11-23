// src/jobs/app-crashed.job.ts — an App's crash, told to its people and its picked channels.
// Dispatched as `app:crashed` by the crash route (`plugins/app-crash.ts`), which
// answers the app at once: the app holds its exit for 3 s at most.
//
// People through the `AppCrashed` kind (email, the bell, the workspace's
// critical push topic), then every channel the App picked (`AppChannel`). The
// two fail separately, as `noticeMonitor` does: a throw from people is
// rethrown after the channels ran, so the retry re-sends to both, and a
// duplicate page is the failure a pager survives. A channel that refuses is
// `fanOutToChannels`'s to retry, not this job's.
//
// Trigger only, no `dedupKey` (`FJS-D2275`): a crash has no recovery Basecamp
// can see, so a person closes the incident.

import { defineJob }  from '@frontierjs/caravan'
import { runsAsApp }  from '../domain/job/job-context.ts'
import { notifyPeople, workspaceMembers } from '../domain/notification/notify.ts'
import { fanOutToChannels } from '../domain/notification/delivery.ts'
import type { AppCrashedPayload } from '../notifications/AppCrashed.notification.ts'

export const CRASH_JOB = 'app:crashed'

/** What the app reported, as the route took it. */
export type CrashReport = Pick<AppCrashedPayload, 'message' | 'stack' | 'host' | 'missed'>

export default defineJob<CrashReport & { appId: string }>({
  name:        CRASH_JOB,
  queue:       'default',
  maxAttempts: 3,
  timeout:     60_000,
  handler: async (ctx) => {
    const { app, db } = runsAsApp(ctx, CRASH_JOB)
    const { appId, ...report } = ctx.data

    // Read again: an App deleted or switched off since the report pages nobody.
    const row = await db.app.findFirst({
      where:  { id: appId, deletedAt: null },
      select: { id: true, name: true, workspaceId: true, isCrashAlerted: true },
    })
    if (!row?.isCrashAlerted) return

    const payload: AppCrashedPayload = { appId: row.id, appName: row.name, ...report }
    const where = report.host ? ` on ${report.host}` : ''

    let peopleErr: unknown = null
    try {
      await notifyPeople(app, 'AppCrashed', await workspaceMembers(app, row.workspaceId), payload, row.workspaceId)
    } catch (err) { peopleErr = err }

    const links = await db.appChannel.findMany({ where: { appId: row.id }, include: { channel: true } })
    await fanOutToChannels(app, () => db, links.map((l: any) => l.channel), {
      title:    `[crashed] ${row.name}`,
      text:     [`${row.name} died of an uncaught error${where}: ${report.message}`,
                 report.missed > 0 ? `Crashed ${report.missed} more time${report.missed === 1 ? '' : 's'} before this without a page.` : '',
                ].filter(Boolean).join('\n'),
      severity: 'critical',
      action:   'trigger',
      data:     { appId: row.id, host: report.host, missed: report.missed, stack: report.stack },
    }, `app-crashed ${row.name}`)

    if (peopleErr) throw peopleErr
  },
})
