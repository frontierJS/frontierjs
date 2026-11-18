// api/src/jobs/chat-followup.job.ts
//
// Raises the "nobody has replied" nudges that are due (`domain/chat/followup.ts`).
// Every minute, and a due row waits in chat.db across a restart. Runs as the
// app; each notice is written for its own member.

import { defineJob } from '@frontierjs/caravan'
import { runsAsApp } from '../domain/job/job-context.ts'
import { raiseDue } from '../domain/chat/followup.ts'

export default defineJob({
  name: 'chat-followup',
  cron: '* * * * *',
  timeout: 300_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'chat-followup')
    const r = await raiseDue(app)
    if (r.raised || r.cleared) console.log(`[chat-followup] raised ${r.raised}, cleared ${r.cleared}`)
  },
})
