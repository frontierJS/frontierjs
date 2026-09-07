// src/jobs/weekly-digest.job.ts — the seventh kind, and the only one with no
// event behind it.
//
// Six of `NOTIFICATION_KINDS` are triggered by something happening. This one is
// triggered by a clock, so it has to go and COUNT — which is why it is a job
// and not a line in another handler.
//
// **Nothing is stored.** A digest is a rendering of a week, and a stored one is
// a second answer that goes stale the first time anything is backfilled or a
// run is reverted. It is counted at send time from rows this app already has,
// and the payload is the whole of it.
//
// **Spend is not in it**, though `kinds.ts` promised it until now: `cloudSpend`
// is a declared adapter with nothing behind it (`docs/ADAPTERS.md`), and a
// figure this app cannot source is one somebody would act on. The description
// on the kind says what is actually counted; wiring the adapter adds a field
// here and a word there.

import { defineJob }  from '@frontierjs/caravan'
import { runsAsApp }  from './context.ts'
import { notifyPeople, workspaceMembers } from '../core/notify.ts'

const WEEK_MS = 7 * 24 * 60 * 60_000

/** The half-open window this app uses everywhere else — `from` inclusive, `to`
 *  exclusive — so a run that lands on a boundary counts a row once and not
 *  twice or never. */
function lastWeek(at: number): { from: string; to: string } {
  return { from: new Date(at - WEEK_MS).toISOString(), to: new Date(at).toISOString() }
}

export default defineJob<{ at?: number }>(
  'weekly-digest',
  async (ctx) => {
    // `runsAsApp`: a digest is the installation's own work across every
    // workspace, nobody asked for it, and a service call from here answers 401.
    const { app, db } = runsAsApp(ctx, 'weekly-digest')
    // The instant is a PARAMETER and not `Date.now()` in three places. An
    // operator re-running last Monday's digest and a test standing at a fixed
    // point are the same need, and a job that reads the clock four times can
    // straddle a boundary within one run.
    const at         = ctx.data?.at ?? Date.now()
    const { from, to } = lastWeek(at)

    // `deletedAt` is stated by hand because a system client bypasses
    // `@@softDelete` along with everything else, and `status` beside it because
    // suspension is NOT deletion (`db/schema.lite`): a suspended tenant is one
    // nobody signs into, and mailing it a weekly summary of a fleet it cannot
    // reach is the digest reporting on a thing that is not happening.
    const workspaces = await db.workspace.findMany({
      where: { deletedAt: null, status: 'active' },
    })
    let sent = 0

    for (const ws of workspaces) {
      const window = { gte: from, lt: to }

      // `finishedAt` and not `createdAt`: a release that STARTED in the window
      // and ended after it has no outcome yet, and counting it as a success is
      // the kind of number a digest is read for.
      const [deploysOk, deploysFailed, alertsFired, jobsFailed] = await Promise.all([
        db.deployment.count({ where: { workspaceId: ws.id, status: 'success', finishedAt: window } }),
        db.deployment.count({ where: { workspaceId: ws.id, status: 'failed',  finishedAt: window } }),
        countAlerts(db, ws.id, from, to),
        countJobFailures(db, ws.id, from, to),
      ])

      sent += await notifyPeople(app, 'weekly_digest', await workspaceMembers(app, ws.id), {
        workspaceId: ws.id, workspaceName: ws.name, from, to,
        deploysOk, deploysFailed, alertsFired, jobsFailed,
      })
    }

    if (sent) console.log(`[weekly-digest] ${sent} digest(s) for ${workspaces.length} workspace(s)`)
  },
  // Monday 09:00. A digest that arrives at 04:00 with the sweeps is one nobody
  // reads; this one is addressed to a person.
  { cron: '0 9 * * 1' },
)

/** `AlertEvent` carries no `workspaceId` — an event belongs to its rule and the
 *  rule carries the workspace, which is the schema saying an event is
 *  meaningless without one. So the count is two reads rather than a join the
 *  accessor cannot express. */
async function countAlerts(db: any, workspaceId: string, from: string, to: string): Promise<number> {
  const rules = await db.alertRule.findMany({ where: { workspaceId } })
  if (!rules.length) return 0
  return db.alertEvent.count({
    where: { ruleId: { in: rules.map((r: any) => r.id) }, firedAt: { gte: from, lt: to } },
  })
}

/** Same shape one table along: a `JobRun` belongs to its `Job`. */
async function countJobFailures(db: any, workspaceId: string, from: string, to: string): Promise<number> {
  const jobs = await db.job.findMany({ where: { workspaceId } })
  if (!jobs.length) return 0
  return db.jobRun.count({
    where: { jobId: { in: jobs.map((j: any) => j.id) }, status: 'failed', startedAt: { gte: from, lt: to } },
  })
}
