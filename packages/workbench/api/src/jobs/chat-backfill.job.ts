// api/src/jobs/chat-backfill.job.ts
//
// One member's view of the team chat brought up to date over REST: what their
// socket could not carry because it was not open. Queued unique per cause
// from the socket's every new connection, a skip in its `seq`, and a frame
// naming a channel they could not read before; it runs as that member, so
// every read spends their own token (`FJS-D1153`). A read that fails throws,
// the job retries, and the cursor has not moved.

import { defineJob } from '@frontierjs/caravan'
import { backfill } from '../providers/chat/index.ts'

export default defineJob<{ memberId: string }>({
  name: 'chat-backfill',
  async handler (job) {
    if (!job.app) throw new Error('chat-backfill: runs inside the app, which holds the chat server')
    await backfill(job.app, job.data.memberId)
  },
})
