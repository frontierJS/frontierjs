// api/jobs/renew-subscriptions.job.ts — the sweep that owns the clock.
//
// It finds what is due and dispatches one `renew-subscription` per row. It does
// no billing itself, and that split is the point: a sweep that issued invoices
// inline would be one long transaction whose failure halfway leaves half a
// shop billed, with nothing to retry but the whole thing.
//
// Hourly rather than daily. A period ends at an instant, not on a date, so a
// daily sweep bills up to 24 hours late — which is invisible in a demo and is a
// real complaint from anybody whose trial ended at nine in the morning.

import { defineJob }       from '@frontierjs/caravan'
import type { JobContext } from '@frontierjs/caravan'
import { occurrenceKey }   from '@frontierjs/toolbelt/history'
import { db }              from '../core/db.ts'
import { dueForRenewal }   from '../domain/billing'
import renewSubscription   from './renew-subscription.job.ts'

/**
 * Dispatch a renewal for everything due at `at`.
 *
 * Answers how many it QUEUED, which is not how many it billed — a dispatch the
 * queue already holds answers false and is not counted, so a second sweep over
 * the same minute reports 0 rather than doing the work twice.
 */
export async function sweepRenewals(ctx: JobContext<{ at?: string }>): Promise<number> {
  const at  = ctx.data?.at ?? new Date().toISOString()
  const due = await dueForRenewal(db.asSystem(), at)

  let queued = 0
  for (const sub of due) {
    // The id IS the idempotency, and it is `occurrenceKey`'s definition rather
    // than a string built here: four call sites built one of these by hand and
    // two interpolated caller text into a `:`-joined key, so `report:daily` and
    // `report` shared a fire id (`FJS-342`).
    const id = occurrenceKey('renew', String(sub.id), sub.currentPeriodEnd)
    const ok = await ctx.app?.jobs?.dispatch(renewSubscription,
      { subscriptionId: sub.id, periodEnd: sub.currentPeriodEnd, at }, { id })
    if (ok) queued++
  }

  if (queued) console.log(`[billing] queued ${queued} renewal(s) of ${due.length} due`)
  return queued
}

export default defineJob<{ at?: string }>(
  'renew-subscriptions',
  async (ctx) => { await sweepRenewals(ctx) },
  { cron: '0 * * * *' },
)
