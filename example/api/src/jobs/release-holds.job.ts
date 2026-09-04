// api/jobs/release-holds.job.ts — the housekeeping half of a reservation.
//
// A hold has a clock on it, and the clock is what makes the whole design work:
// nothing has to come back and undo an abandoned basket, because the row stops
// counting on its own. Every availability sum filters on `expiresAt > now`, so
// a hold is dead the instant it passes whether or not this job has ever run.
//
// ─── Which means this job is NOT what makes the shop correct ──────────────
//
// It deletes rows that have already stopped mattering. That is worth saying out
// loud, because the obvious design — a sweep that "releases" stock by putting a
// number back — is one where a queue outage silently stops the shop from
// selling, and it looks identical from the outside until the day it happens.
// Here the queue can be down for a week and every price, every buy button and
// every checkout is still right; the table just gets bigger.
//
// It runs every five minutes rather than nightly for that reason too: nothing
// depends on it, so the schedule is chosen to keep the table small and the
// admin screen's hold count honest, not to hit a deadline.

import { defineJob }  from '@frontierjs/caravan'
import type { JobContext } from '@frontierjs/caravan'
import { db }         from '../core/db.ts'
import { releaseExpired } from '../domain/shop'

/**
 * Drop every hold that ran out before `before` — an ISO-8601 instant,
 * defaulting to now.
 *
 * Parameterised for the same reason `sweep-abandoned` takes `days`: a cron
 * whose only proof is `nextRuns()` is a schedule and not a behavior. The drive
 * posts `{"before":"2099-01-01T00:00:00.000Z"}` to expire every live hold, and
 * that runs the SAME comparison the scheduled fire runs — where a `releaseAll`
 * flag would be a second code path proving nothing about the first.
 *
 * `db.asSystem()` and not a service: StockReservation is `@@gate("5.8.8.8")`,
 * so nothing below a system context deletes one, and there is no service over
 * the table to route through. Nothing needs announcing either — a hold is never
 * broadcast (a channel does not re-check the gate), and the availability every
 * screen reads is recomputed on demand rather than pushed.
 */
export async function releaseHolds(ctx: JobContext<{ before?: string }>): Promise<number> {
  const before = ctx.data?.before ?? new Date().toISOString()

  // Refused rather than passed through. `expiresAt` is TEXT and the comparison
  // is lexicographic, so a cutoff that is not an ISO-8601 instant does not
  // fail — it matches some arbitrary prefix of the table and deletes live
  // holds, which is a shop overselling because somebody typo'd a timestamp.
  if (Number.isNaN(Date.parse(before)))
    throw new Error(`release-holds: 'before' must be an ISO-8601 instant, got ${JSON.stringify(before)}`)

  const released = await releaseExpired(db.asSystem(), before)
  if (released) console.log(`[holds] released ${released} expired hold(s)`)
  return released
}

/**
 * Every five minutes. See the header — nothing depends on this having run, so
 * the interval is about keeping the table small rather than about a deadline.
 *
 * The wrapper drops the count: a job handler answers nothing to the queue, and
 * the only caller who wants the number is a drive calling `releaseHolds`
 * directly.
 */
export default defineJob<{ before?: string }>(
  'release-holds',
  async (ctx) => { await releaseHolds(ctx) },
  { cron: '*/5 * * * *' },
)
