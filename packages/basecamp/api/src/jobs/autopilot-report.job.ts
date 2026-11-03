// src/jobs/autopilot-report.job.ts — the morning after the loops.
//
// `domain/atlas/autopilot-report.ts` counts and sends; this is the clock. Eight
// on the host's clock, after the schedule's own cron lines in ~/.fli/autopilot.json
// (host clock too, so the night's 00:00 and 01:00 runs are inside the window)
// and before the nine o'clock hub posture. A no-op unless the Workbench is
// offered (`localMachineRefusal()`): the loops run from a checkout on this
// machine (FJS-D1776). `at` is a parameter so an operator re-running a morning
// and a test stand at the same instant.

import { defineJob }           from '@frontierjs/caravan'
import { runsAsApp }           from '../domain/job/job-context.ts'
import { localMachineRefusal } from '../core/env.ts'
import { registerRoot }        from '../domain/atlas/atlas.ts'
import { collectReport, notifyAutopilotReport } from '../domain/atlas/autopilot-report.ts'
import { summary }             from '../notifications/AutopilotReport.notification.ts'

export default defineJob<{ at?: number }>({
  name:    'autopilot-report',
  cron:    '0 8 * * *',
  timeout: 60_000,
  handler: async (ctx) => {
    if (localMachineRefusal()) return
    const { app, db } = runsAsApp(ctx, 'autopilot-report')
    const root = await registerRoot()
    if (!root) return
    const payload = await collectReport({ root, now: new Date(ctx.data?.at ?? Date.now()) })
    if (!payload) return
    const told = await notifyAutopilotReport(app, db, payload)
    console.log(`[autopilot-report] ${summary(payload)} — ${told} told`)
  },
})
