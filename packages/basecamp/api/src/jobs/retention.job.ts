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
import { runsAsApp }  from './context.ts'

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

    const postures = await prunePosture(db)
    if (postures) console.log(`[retention] removed ${postures} posture report(s)`)
  },
})
