// api/jobs/renew-subscription.job.ts — one subscription, one period, one invoice.
//
// The unit of work is a SUBSCRIPTION AND A PERIOD, never a subscription, and
// the whole design of this file follows from that. `renew-subscriptions` finds
// what is due and dispatches one of these each; this issues the document and
// advances the cycle.
//
// ─── Why the dispatch id is the idempotency ───────────────────────────────
//
// A cron fires in every replica, a queue retries, and an operator re-runs a
// sweep that half-finished. Charging twice for one month is the failure this
// domain is judged on, so the guard cannot be a `unique` key: that is a lock on
// work IN FLIGHT and it frees itself the moment the job is terminal, which is
// exactly when a re-run would double-charge.
//
// The guard is the ROW's primary key. `dispatch({ id })` treats a taken id as
// work already queued, for all time, and the id is
// `occurrenceKey('renew', subscriptionId, periodEnd)` — one definition of *this
// exact unit of work already happened*, shared with junction's idempotency
// claim and caravan's own cron fire (`@frontierjs/toolbelt/history`).
//
// The invoice number is NOT the guard. It is minted inside the transaction and
// `@unique`, so a second attempt that somehow arrives is refused by the Data
// boundary too — but a refusal there is an error to read, where a taken
// dispatch id is a no-op, and the difference matters when the cause is a
// replica rather than a bug.

import { defineJob }        from '@frontierjs/caravan'
import type { JobContext }  from '@frontierjs/caravan'
import { db }               from '../core/db.ts'
import { occurrenceKey }  from '@frontierjs/toolbelt/history'
import {
  advancePeriod, issueInvoice, nextInvoiceNumber, periodLines,
} from '../domain/billing'
import collectInvoice     from './collect-invoice.job.ts'

export type RenewPayload = { subscriptionId: number, periodEnd: string }

/**
 * Issue the next invoice for one subscription and move its window on.
 *
 * `at` is the instant to bill AT, defaulting to now and passed by the drive so
 * a renewal can be watched without waiting a month. It is the same code path
 * either way — a `force` flag would be a second one, proving nothing about the
 * first.
 *
 * Answers the invoice number, or null where there was nothing to do. Null is a
 * legitimate answer three times over: the period may have already been advanced
 * by an earlier attempt, the subscription may have been cancelled between the
 * sweep and this job, and it may have been asked to stop AT this boundary —
 * which is the one case where the job does something and still bills nothing.
 */
export async function renewSubscription(
  ctx: JobContext<RenewPayload & { at?: string }>,
): Promise<string | null> {
  const sys = db.asSystem() as Record<string, any>
  const at  = ctx.data?.at ?? new Date().toISOString()

  const sub = await sys.subscription.findFirst({ where: { id: ctx.data.subscriptionId } })
  if (!sub) return null

  // Cancelled between the sweep and here. Not an error: the sweep read a list
  // and the world moved, which is the ordinary state of any queue.
  if (sub.status === 'cancelled') return null

  // Already advanced. The dispatch id makes a second dispatch a no-op, and this
  // makes a second EXECUTION one — a job that was retried after its transaction
  // committed but before the queue recorded it done.
  if (new Date(sub.currentPeriodEnd) > new Date(ctx.data.periodEnd)) return null

  // Asked to stop, and this is where the asking lands. `subscriptions.cancel`
  // sets a flag rather than moving the row, because the period had been paid
  // for and ending it the moment somebody pressed the button forfeits the rest
  // of it; this is the boundary that flag names, so the arrangement ends here
  // and no document is issued for a period nobody wanted.
  //
  // It is read AFTER the two guards above and not before them. A stale dispatch
  // for a period that has already been billed must do nothing at all — reading
  // the flag first would let a retry cancel a subscription whose next period
  // has already been issued and paid for.
  //
  // The move is `@system` and this is a system client, which is the whole of
  // what makes it reachable: no request can ask for `cancel`, and the flag is
  // the only thing that can bring the job to it.
  if (sub.cancelAtPeriodEnd) {
    await sys.subscription.transition(sub.id, 'cancel')
    console.log(`[billing] ${sub.reference} → cancelled at its period end`)
    return null
  }

  const version = await sys.planVersion.findFirst({ where: { id: sub.planVersionId } })
  const plan    = version && await sys.plan.findFirst({ where: { id: version.planId } })
  if (!version || !plan) return null

  const periodStart = sub.currentPeriodEnd
  const periodEnd   = advancePeriod(periodStart, plan.interval).toISOString()

  const invoice = await issueInvoice(sys, {
    number:         await nextInvoiceNumber(sys),
    customerId:     sub.customerId,
    subscriptionId: sub.id,
    userId:         sub.userId,
    issuedAt:       at,
    periodStart, periodEnd,
    lines: periodLines({
      name:        plan.name,
      quantity:    sub.quantity,
      unitAmount:  version.price,
      periodStart, periodEnd,
    }),
  })

  // The window moves after the document exists, not before. The other order
  // loses a month's revenue to a crash between the two, and the row would then
  // read as billed.
  await sys.subscription.update({
    where: { id: sub.id },
    data:  { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd },
    system: ['currentPeriodStart', 'currentPeriodEnd'],
  })

  // A trial that ran out has converted, and *converted* is a declared move
  // rather than a status assignment — `@@transitions` is what refuses it from
  // anywhere but `trialing`, so this line is safe to reach twice.
  if (sub.status === 'trialing') await sys.subscription.transition(sub.id, 'activate')

  // Present it. Dispatched rather than called, and AFTER the transaction that
  // issued the document has committed: taking money for an invoice that then
  // rolled back is the one ordering this file cannot get wrong. A provider
  // outage costs a retry on that job and nothing here.
  //
  // `unique` and NOT a dispatch id, which is what this was. A dispatch id is a
  // taken primary key and therefore forever — so once `collect:56` exists the
  // invoice with id 56 can never be presented again, and *presented again* is
  // an ordinary thing to want: a soft decline leaves the invoice `issued` and
  // owed. What is actually meant here is *never two presentations of one
  // invoice in flight at once*, which is precisely what `unique` expresses —
  // the key frees itself when the job reaches a terminal state.
  //
  // The id also cannot be built from an invoice id at all: SQLite reuses a
  // rowid once a row is gone, so `collect:56` can name two different invoices
  // months apart. Caravan's own docstring says so about `unique`; it is true of
  // `id` and worse there, because that one never lets go.
  await ctx.app?.jobs?.dispatch(collectInvoice, { invoiceId: invoice.id },
    { unique: occurrenceKey('collect', String(invoice.id)) })

  console.log(`[billing] ${sub.reference} → ${invoice.number} (${invoice.total} minor units)`)
  return invoice.number
}

export default defineJob<RenewPayload & { at?: string }>(
  'renew-subscription',
  async (ctx) => { await renewSubscription(ctx) },
  // No cron. This one is dispatched, never scheduled — the sweep below owns the
  // clock, and a job that both schedules itself and is dispatched has two
  // answers to how often it runs.
  { maxAttempts: 3 },
)
