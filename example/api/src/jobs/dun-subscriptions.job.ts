// api/jobs/dun-subscriptions.job.ts — what happens when nobody pays.
//
// Dunning is durable retry with a DEADLINE, and the two halves belong in
// different places. The retry is the queue's — caravan already has a ladder,
// and a second one written here would be a worse copy. The deadline is a
// business fact, and this file is where it is read.
//
// ─── The deadline is derived, never counted ───────────────────────────────
//
// The obvious design is `failedAttempts` on the subscription, incremented by
// whatever ran last. It is wrong in a way that only shows up in production: a
// counter is a second answer to a question the invoices already answer, so a
// job that runs twice, a replica that fires the same cron, or a restore from a
// backup makes the row disagree with the rows — and the disagreement is
// invisible until somebody is cancelled a week early.
//
// So: `now - dueAt` on the OLDEST unpaid invoice. That is a read of two frozen
// columns (`@immutable`, `FJS-D162`), it is the same answer however many times
// anything ran, and it is the number a person would have worked out by hand.
//
// ─── What it does not do ──────────────────────────────────────────────────
//
// It does not take money. Collection is a vendor's business and it is phase 4
// of `IDEAS/billing.md`; what this proves is the clock, which is the half that
// is wrong in most implementations and the half no payment provider supplies.

import { defineJob }       from '@frontierjs/caravan'
import type { JobContext } from '@frontierjs/caravan'
import { db }              from '../core/db.ts'
import { DUNNING_DAYS, GRACE_DAYS, unpaidInvoices } from '../domain/billing'

const DAY = 24 * 60 * 60 * 1000

export type DunningOutcome = { lapsed: string[], cancelled: string[], recovered: string[] }

/**
 * Grade every live subscription against its own unpaid invoices at `at`.
 *
 * Three moves and each is a declared transition, so what is legal from where is
 * in `db/schema.lite` and not here: `lapse` when the oldest unpaid invoice is
 * past its due date plus the grace, `cancel` when it is past the deadline, and
 * `recover` when there is nothing unpaid at all — which is how a subscription
 * comes back after a payment settles, without the settling code having to know
 * that dunning exists.
 */
export async function dunSubscriptions(
  ctx: JobContext<{ at?: string, subscriptionId?: number }>,
): Promise<DunningOutcome> {
  const sys = db.asSystem() as Record<string, any>
  const at  = new Date(ctx.data?.at ?? new Date().toISOString()).getTime()
  const out: DunningOutcome = { lapsed: [], cancelled: [], recovered: [] }

  // `subscriptionId` narrows the run to one row. It is an operator's parameter
  // before it is a drive's — *re-run dunning for this customer, I have just
  // taken their payment by hand* is a thing somebody asks for, and the
  // alternative is waiting for tomorrow's cron over the whole book. It is the
  // same code path either way, which is what stops it being a second one:
  // absent, every live subscription is graded, exactly as the cron does.
  const live = await sys.subscription.findMany({
    where: {
      status: { in: ['active', 'pastDue'] },
      ...(ctx.data?.subscriptionId ? { id: ctx.data.subscriptionId } : {}),
    },
    orderBy: { id: 'asc' },
  })

  for (const sub of live) {
    const unpaid = await unpaidInvoices(sys, sub.id)
    const oldest = unpaid[0]

    // Nothing outstanding. A subscription sitting at `pastDue` with a clean
    // ledger is one whose invoice was settled by somebody else — a webhook, a
    // member of staff, a bank transfer somebody reconciled — and this is the
    // one place that has to notice, because none of those callers knows the
    // subscription had lapsed.
    if (!oldest) {
      if (sub.status === 'pastDue') {
        await sys.subscription.transition(sub.id, 'recover')
        out.recovered.push(sub.reference)
      }
      continue
    }

    const overdueBy = at - new Date(oldest.dueAt).getTime()

    if (overdueBy >= DUNNING_DAYS * DAY) {
      // The deadline. Cancelling is legal from `active` as well as `pastDue`,
      // so a subscription that somehow skipped the middle state is still
      // stopped rather than left running unpaid forever.
      await sys.subscription.transition(sub.id, 'cancel')
      out.cancelled.push(sub.reference)
      continue
    }

    if (overdueBy >= GRACE_DAYS * DAY && sub.status === 'active') {
      await sys.subscription.transition(sub.id, 'lapse')
      out.lapsed.push(sub.reference)
    }
  }

  const moved = out.lapsed.length + out.cancelled.length + out.recovered.length
  if (moved) console.log(`[dunning] ${out.lapsed.length} lapsed · ${out.cancelled.length} cancelled · ${out.recovered.length} recovered`)
  return out
}

export default defineJob<{ at?: string, subscriptionId?: number }>(
  'dun-subscriptions',
  async (ctx) => { await dunSubscriptions(ctx) },
  // Daily, and early. A deadline measured in days does not need a finer clock,
  // and a person who is about to be cancelled should find out at the start of a
  // working day rather than at midnight.
  { cron: '0 6 * * *' },
)
