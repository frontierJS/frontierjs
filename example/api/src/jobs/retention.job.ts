// api/src/jobs/retention.job.ts — the one the schema declares and nothing ran.
//
// `db/schema.lite` says `database audit { … retention 90d }`, and until this
// file existed that sentence was true for exactly one moment: litestone sweeps
// once inside `createClient`, so a shop whose API stays up for a month pruned
// on the day it booted and never again (`FJS-521`). The declaration is the
// policy; the schedule is the app's, because the clock belongs to the queue
// (`FJS-D36`) and litestone cannot import it.
//
// This is the whole wiring. The file name is the job's name, `cron` on the
// definition is when it runs, and autoloading from `jobsDir` is the rest.

import { defineJob } from '@frontierjs/caravan'
import { sys }       from '../core/db.ts'

/**
 * Sweep every declared retention policy.
 *
 * `asSystem()` because it is a DELETE against the base table and applies no
 * gate, no row policy and no `@@softDelete` — the bypass is said here rather
 * than assumed. Answers one row per table it touched, which is what the log
 * line below wants.
 *
 * 04:00 daily: after `sweep-abandoned` at 03:00, so a run that cancels an order
 * has already happened and the audit rows it wrote are the ones being aged, not
 * ones written a minute later.
 */
export default defineJob(
  'retention',
  async () => {
    const swept   = sys.$retain()
    const removed = swept.reduce((n, r) => n + r.removed, 0)

    // A pass that removed nothing is the normal case and says nothing. A pass
    // that could not sweep a table is a declared policy quietly not applying,
    // which is the whole failure this job exists to stop being invisible.
    for (const row of swept.filter(r => r.error))
      console.error(`[retention] ${row.model}: ${row.error}`)

    if (removed)
      console.log(`[retention] removed ${removed} row(s) across ${swept.filter(r => r.removed).length} table(s)`)
  },
  { cron: '0 4 * * *' },
)
