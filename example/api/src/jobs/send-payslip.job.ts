// api/jobs/send-payslip.job.ts — a payslip going out, at most once.
//
// ─── `id` and not `unique`, which is the opposite of its sibling ──────────
//
// `calculate-payslip` uses `unique` because its work is RESUMABLE: telling it
// to do the thing again has to reach the handler. This is the other kind. A
// payslip that has been sent cannot be un-sent, so the only safe answer to a
// redelivery is *nothing happens*, forever — and that is what
// `dispatch({ id })` means: the id is the jobs table's primary key, so a second
// dispatch under it is a no-op for all time (`FJS-609` is what happens when
// that is used where `unique` was meant; this is the case it is right for).
//
// The stamp is the second guard, and it is deliberately not the only one: the
// dispatch id stops the job being QUEUED twice, `sentAt` stops it being SENT
// twice if it somehow is, and neither is redundant because they fail at
// different layers.
//
// What it does not do is talk to a mail server. `conduit` and `notifications`
// are proved by `verify:notify`, and re-proving them here would be a second
// implementation of a boundary that already has one. What this owns is the
// once-ness.

import { defineJob }       from '@frontierjs/caravan'
import type { JobContext } from '@frontierjs/caravan'
import { db }              from '../core/db.ts'

export type SendPayslipPayload = { payslipId: number }

export type SendOutcome = { sent: boolean, reason?: 'gone' | 'already', reference?: string }

/** The work, exported so a drive can run it twice and read both answers. */
export async function sendPayslipJob(ctx: JobContext<SendPayslipPayload>): Promise<SendOutcome> {
  const sys  = db.asSystem() as Record<string, any>
  const slip = await sys.payslip.findFirst({ where: { id: ctx.data.payslipId } })
  if (!slip) return { sent: false, reason: 'gone' }

  // Already out. Answering rather than throwing, because a redelivered job
  // finding its work done is the normal case and not an error.
  if (slip.sentAt) return { sent: false, reason: 'already' }

  // `sentAt` is `@system` and NOT `@immutable` — the one column on a payslip
  // that is written after the document is frozen, because sending is an act
  // ON it rather than part of it.
  await sys.payslip.update({
    where: { id: slip.id }, data: { sentAt: new Date().toISOString() }, system: ['sentAt'],
  })
  return { sent: true, reference: slip.reference }
}

export default defineJob<SendPayslipPayload>(
  'send-payslip',
  async (ctx: JobContext<SendPayslipPayload>) => { await sendPayslipJob(ctx) },
  { maxAttempts: 5 },
)
