// src/jobs/retention.job.ts — the one the schema declares and nothing ran.
//
// `db/schema.lite` says `database audit { … retention 90d }`, and until this
// file existed that sentence was true for one moment only: litestone sweeps
// once inside `createClient`, so a hub that stays up for a month pruned on the
// day it booted and never again (`FJS-521`). For an audit trail that is a
// retention claim resting on a boot time.
//
// The declaration is the policy; the schedule is the app's, because unattended
// recurring work belongs to the queue (`FJS-D36`) and litestone cannot import
// it. This file is the whole wiring — its name is the job's name and `cron` on
// the definition is when it runs.

import { defineJob }  from '@frontierjs/caravan'
import { runsAsApp }  from '../domain/job/job-context.ts'

const POSTURE_KEEP_MS = 30 * 86_400_000

/**
 * `ServerPosture` older than thirty days, except each machine's newest: a box
 * whose Outpost went quiet a month ago still shows its last answer as stale,
 * rather than as never having reported.
 */
export async function prunePosture(db: any, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - POSTURE_KEEP_MS).toISOString()
  const old    = await db.serverPosture.findMany({ where: { at: { lt: cutoff } }, select: { id: true, serverId: true } })
  if (!old.length) return 0
  const keep = new Set<string>()
  for (const serverId of new Set<string>(old.map((r: any) => r.serverId))) {
    const newest = await db.serverPosture.findFirst({ where: { serverId }, orderBy: { at: 'desc' }, select: { id: true } })
    if (newest) keep.add(newest.id)
  }
  const ids = old.map((r: any) => r.id as string).filter((id: string) => !keep.has(id))
  if (ids.length) await db.serverPosture.deleteMany({ where: { id: { in: ids } } })
  return ids.length
}

// ─── Monitoring rows (`FJS-D1800`) ───────────────────────────────────────
//
// Days come from `HubConfig`, one row per install. A MonitorCheck is a row a
// minute per monitor, so it is rolled up into `MonitorUptimeDay` before it is
// deleted; the rest are incident history and are only deleted.

const DAY_MS = 86_400_000

/** The UTC midnight at or before `t`. Whole days only, so a day is rolled up once and from all of its rows. */
const dayStart = (t: number) => t - (t % DAY_MS)

export interface MonitoringRetention {
  retentionCheckDays: number; retentionEventDays: number
  retentionAlertDays: number; retentionNotificationDays: number
}

export const DEFAULT_RETENTION: MonitoringRetention = {
  retentionCheckDays: 30, retentionEventDays: 90, retentionAlertDays: 90, retentionNotificationDays: 90,
}

/** Most days one pass rolls up: a first run over a long backlog finishes over a few nights rather than in one transaction-sized lump. */
const MAX_ROLLUP_DAYS = 60

/**
 * Roll up and delete MonitorChecks older than the check window, then delete
 * the other monitoring rows past theirs. Returns the rows removed per table.
 */
export async function pruneMonitoring(db: any, now = Date.now()): Promise<Record<string, number>> {
  const config = { ...DEFAULT_RETENTION, ...(await db.hubConfig.findFirst({ where: { id: 'hub' } })) }
  const iso    = (daysAgo: number) => new Date(now - daysAgo * DAY_MS).toISOString()
  const removed: Record<string, number> = {}

  const checkCutoff = dayStart(now - config.retentionCheckDays * DAY_MS)
  for (let pass = 0; pass < MAX_ROLLUP_DAYS; pass++) {
    const oldest = await db.monitorCheck.findFirst({
      where: { at: { lt: new Date(checkCutoff).toISOString() } }, orderBy: { at: 'asc' }, select: { at: true },
    })
    if (!oldest) break
    const from = dayStart(Date.parse(oldest.at))
    const to   = from + DAY_MS
    const rows = await db.monitorCheck.findMany({
      where: { at: { gte: new Date(from).toISOString(), lt: new Date(to).toISOString() } },
      select: { monitorId: true, isOk: true, latencyMs: true }, limit: 500_000,
    })
    const byMonitor = new Map<string, { checks: number; ok: number; lat: number[] }>()
    for (const r of rows) {
      const m = byMonitor.get(r.monitorId) ?? { checks: 0, ok: 0, lat: [] }
      m.checks++
      if (r.isOk) m.ok++
      if (typeof r.latencyMs === 'number') m.lat.push(r.latencyMs)
      byMonitor.set(r.monitorId, m)
    }
    for (const [monitorId, m] of byMonitor) {
      const data = {
        checks: m.checks, okChecks: m.ok,
        avgLatencyMs: m.lat.length ? Math.round(m.lat.reduce((a, b) => a + b, 0) / m.lat.length) : null,
        maxLatencyMs: m.lat.length ? Math.max(...m.lat) : null,
      }
      const day      = new Date(from).toISOString()
      const existing = await db.monitorUptimeDay.findFirst({ where: { monitorId, day } })
      // Set, not added to: a pass that rolled this day up and died before the
      // delete would otherwise count its rows twice.
      if (existing) await db.monitorUptimeDay.update({ where: { id: existing.id }, data })
      else await db.monitorUptimeDay.create({ data: { monitorId, day, ...data } })
    }
    removed.monitorCheck = (removed.monitorCheck ?? 0)
      + await db.monitorCheck.deleteMany({ where: { at: { lt: new Date(to).toISOString() } } }).then(countOf)
  }

  removed.monitorEvent  = await db.monitorEvent.deleteMany({ where: { at: { lt: iso(config.retentionEventDays) } } }).then(countOf)
  removed.serverEvent   = await db.serverEvent.deleteMany({ where: { createdAt: { lt: iso(config.retentionEventDays) } } }).then(countOf)
  // Resolved and read only: a firing alert or an unread notice is still owed to somebody.
  removed.alert         = await db.alert.deleteMany({ where: { status: 'resolved', resolvedAt: { lt: iso(config.retentionAlertDays) } } }).then(countOf)
  removed.notification  = await db.notification.deleteMany({ where: { readAt: { lt: iso(config.retentionNotificationDays) } } }).then(countOf)
  return removed
}

const countOf = (r: unknown): number => typeof r === 'number' ? r : (r as { count?: number })?.count ?? 0

/** What `$retain()` answers, one row per table it touched. */
interface Swept { model: string; table: string; removed: number; error?: string }

/**
 * Sweep every declared retention policy.
 *
 * `runsAsApp` because nobody asked: there is no membership to resolve and no
 * workspace to scope to, and a sweep is the installation acting on its own
 * behalf. It hands back the system client, which is what `$retain()` requires —
 * a DELETE against the base table applies no gate, no row policy and no
 * `@@softDelete`, so the bypass is said rather than assumed.
 *
 * 04:00 daily. A pass that removed nothing is the normal case and is silent; a
 * table that could not be swept is a declared policy quietly not applying,
 * which is the failure this job exists to stop being invisible.
 */
export default defineJob({
  cron: '0 4 * * *',
  handler: async (ctx) => {
    const { db }  = runsAsApp(ctx, 'retention')
    const swept   = (await db.$retain()) as Swept[]
    const removed = swept.reduce((n: number, r: Swept) => n + r.removed, 0)

    for (const row of swept.filter((r: Swept) => r.error))
      console.error(`[retention] ${row.model}: ${row.error}`)

    if (removed)
      console.log(`[retention] removed ${removed} row(s) across ${swept.filter((r: Swept) => r.removed).length} table(s)`)

    const monitoring = await pruneMonitoring(db)
    for (const [table, n] of Object.entries(monitoring))
      if (n) console.log(`[retention] removed ${n} ${table} row(s)`)

    const postures = await prunePosture(db)
    if (postures) console.log(`[retention] removed ${postures} posture report(s)`)
  },
})
