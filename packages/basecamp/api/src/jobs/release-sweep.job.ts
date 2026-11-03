// src/jobs/release-sweep.job.ts — the thing that fails a release nothing is running.
//
// A release left `pending` or `building` with no live job behind it (a job
// given up on, a dispatch that never landed, a queue file lost with a restore)
// reads as in flight for ever, and `create` refuses every release of the App
// behind it (`FJS-3861`). The verdict is `sweepStuckReleases`; this is its
// clock. It left `server-reachability` because it is about releases and should
// be found from that side (`FJS-D1802`); `app.ts` runs the same sweep once at
// boot so a restart does not wait a minute.

import { defineJob }      from '@frontierjs/caravan'
import { sweepStuckReleases } from '../domain/release/release-record.ts'
import { runsAsApp }      from '../domain/job/job-context.ts'
import { otherRunIsLive } from '../domain/job/singleton.ts'

export default defineJob({
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'release-sweep')
    if (otherRunIsLive(ctx, 'release-sweep')) return
    const failed = await sweepStuckReleases(app)
    if (failed.length) console.warn(`[release-sweep] failed ${failed.length} release(s) no job was left running: ${failed.join(', ')}`)
  },
  // The fleet's own minute, as before the move: a slower sweep adds its whole
  // period to how long a stuck release blocks the App.
  cron: '* * * * *',
  timeout: 4 * 60_000,
})
