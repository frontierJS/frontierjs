// src/jobs/claude-index.job.ts — keeps the Claude Code usage index current.
//
// `domain/claude/claude-index.ts` is the work; this is the schedule. Every five
// minutes it reads what the transcripts on this machine gained since the last
// pass. The first pass reads gigabytes, so the cron never starts it: an empty
// index waits for the Claude Code tab's button (`claude: index`), which
// dispatches this job with `build`.
//
// A no-op unless the Workbench is offered (`localMachineRefusal()`): a deployed
// Basecamp would index its own server's `~/.claude`, which is nobody's.
// `runsAsApp` because the index is the installation's own, written as the
// system — the button's dispatch says `actor: null` for the same reason.

import { defineJob }           from '@frontierjs/caravan'
import { runsAsApp }           from '../domain/job/job-context.ts'
import { localMachineRefusal } from '../core/env.ts'
import { hasIndex, indexOnce } from '../domain/claude/claude-index.ts'

const claudeIndex = defineJob<{ build?: boolean }>({
  name: 'claude-index',
  cron: '*/5 * * * *',
  timeout: 1_800_000,
  handler: async (ctx) => {
    if (localMachineRefusal()) return
    const { db } = runsAsApp(ctx, 'claude-index')
    if (!ctx.data?.build && !await hasIndex(db)) return
    const r = await indexOnce(db)
    if (r?.read) console.log(`[claude-index] read ${r.read}/${r.files} transcript(s), +${r.added} message(s), ${r.gone} gone, ${r.ms} ms`)
  },
})

export default claudeIndex

/** Queue the first pass; `unique`, so a second click while one waits adds nothing. */
export const dispatchIndex = (app: { jobs: { dispatch: Function } }) =>
  app.jobs.dispatch(claudeIndex, { build: true }, { unique: 'claude-index:build', actor: null, tenant: null })
