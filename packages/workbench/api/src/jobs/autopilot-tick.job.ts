// src/jobs/autopilot-tick.job.ts — the Switch's clock.
//
// `domain/atlas/autopilot-run.ts` is the work; this is the schedule. Every
// five minutes, while ~/.config/fli/autopilot.json says On, it starts each entry
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
import { inProcess, pollReplies }    from '../domain/atlas/autopilot-post.ts'

/** What the last pass said, so a pass that says it again is silent. */
let lastReported = ''
let lastPollError = ''

export default defineJob({
  name:    'autopilot-tick',
  cron:    '*/5 * * * *',
  timeout: 60_000,
  handler: async (ctx) => {
    const { app, db } = runsAsApp(ctx, 'autopilot-tick')
    const root = await registerRoot()
    if (!root) return
    const f = await loadFli()

    const push = (app as any).push
    if (push?.rung === 1 && push.token) {
      try {
        const r = await pollReplies({ root, push })
        if (r.ruled || r.refused) console.log(`[autopilot-tick] replies: ${r.ruled} ruled, ${r.refused} refused`)
        lastPollError = ''
      } catch (err) {
        const line = `reply poll failed: ${(err as Error).message}`
        if (line !== lastPollError) console.warn(`[autopilot-tick] ${line}`)
        lastPollError = line
      }
    }

    let schedule
    try { schedule = f.readSchedule({ root }) } catch (err) { report(`refused: ${(err as Error).message}`); return }
    if (!schedule.on) return

    const now   = new Date()
    const logs  = f.logFiles().flatMap(l => f.readLog(l))
    const cap   = f.overDayCap(schedule.day, f.spentToday(logs))
    const free  = f.readLoopLog({ root }).lanes.filter(l => !l.busy).length
    const since = tickSince(readTick(), now)
    const out   = tick({ root, loops: f.LOOPS, entries: schedule.entries, env: app.workbench.shellEnv(), cap, freeLanes: free, since, now, inProcess: inProcess(app, root, db) })

    for (const s of out.started) console.log(`[autopilot-tick] started entry ${s.entry} (${s.loop}), ${s.pid ? `pid ${s.pid}` : 'in the API'}`)
    report(out.skipped.map(s => `entry ${s.entry} (${s.loop}) not started: ${s.why}`).join('; '))
  },
})

function report(line: string) {
  if (line === lastReported) return
  lastReported = line
  if (line) console.warn(`[autopilot-tick] ${line}`)
}
