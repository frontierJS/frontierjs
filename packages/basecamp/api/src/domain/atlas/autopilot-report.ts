// src/domain/atlas/autopilot-report.ts — the morning after the loops, counted.
//
// `jobs/autopilot-report.job.ts` sends what this reads. Nothing is stored and
// no marker says what was last reported: the window is the 24 hours before
// the send, off `readLoopLog`, so a re-run and a test standing at a fixed
// instant say the same thing, and a morning the API was down is a morning with
// no report rather than a doubled one next day.
//
// When it is silent: Off with nothing in the window. On and quiet still sends,
// naming the last tick, because a tick job that died looks like a quiet night
// from every other seat; a hand run while Off sends too, since something ran.

import { loadFli, type LoopLog } from './atlas.ts'
import { readTick }     from './autopilot-run.ts'
import { notifyPeople } from '../notification/notify.ts'
import type { AutopilotReportPayload } from '../../notifications/AutopilotReport.notification.ts'

export type ReportInput = {
  loop:  LoopLog
  on:    boolean
  day:   { attempts: number | null, dollars: number | null } | null
  spent: { attempts: number, dollars: number }
  tick:  string | null
}

/** The payload, or null for a morning that gets no report. */
export function reportOf({ loop, on, day, spent, tick }: ReportInput): AutopilotReportPayload | null {
  const c = loop.counts
  if (!on && !c.fixLines && !c.frameLines) return null
  return {
    from:    loop.window.start,
    to:      loop.window.end,
    on,
    ran:     (c.started ?? 0) + loop.events.filter(e => e.kind === 'paper' && e.from === 'plans').length,
    closed:  c.closed ?? 0,
    blocked: c.blocked ?? 0,
    failed:  (c.failed ?? 0) + (c.busy ?? 0) + (c.corrected ?? 0) + (c.other ?? 0),
    framed:  loop.events.filter(e => e.kind === 'question' && e.label === 'framed').length,
    spend:   loop.spend,
    day:     { attempts: spent.attempts, dollars: spent.dollars, capAttempts: day?.attempts ?? null, capDollars: day?.dollars ?? null },
    patches: loop.dock.patches.length,
    tick,
    review:  loop.review ? { modified: loop.review.modified, repeated: loop.review.repeated } : null,
  }
}

/** This machine's morning, read at `now`: the logs, the switch and the last tick. */
export async function collectReport({ root, now = new Date() }: { root: string, now?: Date }): Promise<AutopilotReportPayload | null> {
  const f    = await loadFli()
  const loop = f.readLoopLog({ root, until: now.getTime() })
  // A file the reader refuses is the Switch's to explain; the morning still reports what ran.
  let schedule: { on: boolean, day: ReportInput['day'] } | null = null
  try { schedule = f.readSchedule() } catch {}
  const spent = f.spentToday(f.logFiles().flatMap(l => f.readLog(l)), { now })
  return reportOf({ loop, on: schedule?.on === true, day: schedule?.day ?? null, spent, tick: readTick()?.at ?? null })
}

/** Tell every system admin; answers how many were told. The report is the installation's, like the hub posture. */
export async function notifyAutopilotReport(app: any, db: any, payload: AutopilotReportPayload): Promise<number> {
  const admins = await db.user.findMany({ where: { isSystemAdmin: true }, select: { id: true } })
  return notifyPeople(app, 'AutopilotReport', admins.map((u: any) => u.id as string), payload)
}
