// api/src/jobs/chat-scheduled.job.ts
//
// Sends the scheduled chat posts that are due (`domain/chat/scheduled.ts`).
// Every minute, and a due row waits in chat.db across a restart. Runs as the
// app; each post is sent as its own member.

import { defineJob } from '@frontierjs/caravan'
import { runsAsApp } from '../domain/job/job-context.ts'
import { sendDue } from '../domain/chat/scheduled.ts'

export default defineJob({
  name: 'chat-scheduled',
  cron: '* * * * *',
  timeout: 300_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'chat-scheduled')
    const r = await sendDue(app)
    if (r.sent || r.failed) console.log(`[chat-scheduled] sent ${r.sent}, failed ${r.failed}`)
  },
})
