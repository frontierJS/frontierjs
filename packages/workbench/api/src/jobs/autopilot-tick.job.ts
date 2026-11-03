// src/jobs/autopilot-tick.job.ts — the Switch's clock.
//
// `domain/atlas/autopilot-run.ts` is the work; this is the schedule. Every
// five minutes, while ~/.fli/autopilot.json says On, it starts each entry
// whose cron line fell inside the window since the last tick, and refuses the
// pass when the day's cap is spent or an entry's lanes are held. Off, it does
// nothing at all: a run already going is the loop's own, and this stops none.
//
// `runsAsApp` because nobody asked: the schedule is the
// installation's own.

import { defineJob }           from '@frontierjs/caravan'
import { runsAsApp }           from '../domain/job/job-context.ts'
import { loadFli, registerRoot } from '../domain/atlas/atlas.ts'
import { tick, readTick, tickSince } from '../domain/atlas/autopilot-run.ts'

/** What the last pass said, so a pass that says it again is silent. */
let lastReported = ''

export default defineJob({
  name:    'autopilot-tick',
  cron:    '*/5 * * * *',
  timeout: 60_000,
  handler: async (ctx) => {
    const { app } = runsAsApp(ctx, 'autopilot-tick')
    const root = await registerRoot()
    if (!root) return
    const f = await loadFli()

    let schedule
    try { schedule = f.readSchedule() } catch (err) { report(`refused: ${(err as Error).message}`); return }
    if (!schedule.on) return

    const now   = new Date()
    const logs  = f.logFiles().flatMap(l => f.readLog(l))
    const cap   = f.overDayCap(schedule.day, f.spentToday(logs))
    const free  = f.readLoopLog({ root }).lanes.filter(l => !l.busy).length
    const since = tickSince(readTick(), now)
    const out   = tick({ root, loops: f.LOOPS, entries: schedule.entries, env: app.workbench.shellEnv(), cap, freeLanes: free, since, now })

    for (const s of out.started) console.log(`[autopilot-tick] started entry ${s.entry} (${s.loop}), pid ${s.pid}`)
    report(out.skipped.map(s => `entry ${s.entry} (${s.loop}) not started: ${s.why}`).join('; '))
  },
})

function report(line: string) {
  if (line === lastReported) return
  lastReported = line
  if (line) console.warn(`[autopilot-tick] ${line}`)
}
