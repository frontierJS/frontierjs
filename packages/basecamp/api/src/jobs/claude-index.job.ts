// src/jobs/claude-index.job.ts — keeps the Claude Code usage index current.
//
// `domain/claude/claude-index.ts` is the work; this is the schedule. Every five
// minutes it reads what the transcripts on this machine gained since the last
// pass. The first pass reads gigabytes (measured: ~21 s of parsing for ~5,000
// files), which is why it is a job and no request ever waits on it.
//
// A no-op unless the Workbench is offered (`localMachineRefusal()`): a deployed
// Basecamp would index its own server's `~/.claude`, which is nobody's.
// `runsAsApp` because nobody asked, and the index is written as the system.
// A pass that outlasts the five minutes is not started over; the next tick
// finds `running` set and leaves.

import { defineJob }           from '@frontierjs/caravan'
import { runsAsApp }           from './context.ts'
import { localMachineRefusal } from '../core/env.ts'
import { indexClaude }         from '../domain/claude/claude-index.ts'

let running = false

export default defineJob({
  cron: '*/5 * * * *',
  timeout: 1_800_000,
  handler: async (ctx) => {
    if (localMachineRefusal() || running) return
    running = true
    try {
      const { db } = runsAsApp(ctx, 'claude-index')
      const r = await indexClaude(db)
      if (r.read) console.log(`[claude-index] read ${r.read}/${r.files} transcript(s), +${r.added} message(s), ${r.gone} gone, ${r.ms} ms`)
    } finally { running = false }
  },
})
