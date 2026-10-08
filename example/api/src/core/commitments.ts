// api/src/core/commitments.ts — what a commitment's move owes, beyond itself.
//
// Handed to junction's `commitments()` as `hooks:`, which runs each one inside
// the transaction that made its move (`FJS-D368`). One module rather than a
// literal in app.ts, because `verify:billing` fires a period with no app behind
// it through junction's own `fireCommitment` and has to hand it the same hooks
// — a copy in the drive would grade the copy.

import type { CommitmentHook } from '@frontierjs/junction/commitments'
import { occurrenceKey }       from '@frontierjs/toolbelt/history'
import { renewPeriod }         from '../domain/billing'
import collectInvoice          from '../jobs/invoice-collect.job.ts'
import remindInvoice           from '../jobs/invoice-remind.job.ts'

/** The queue a hook dispatches to after the commit — `app.jobs`, or a drive's recorder. */
type Dispatcher = { dispatch(job: unknown, payload: unknown, opts?: Record<string, unknown>): unknown }

export function commitmentHooks(jobs: () => Dispatcher | undefined): Record<string, CommitmentHook> {
  return {
    // A period closing is a renewal (`FJS-D367`): the next period and its
    // invoice, in the same transaction as the close.
    //
    // The invoice is presented AFTER the commit, as its own job: taking money
    // for a document that then rolled back is the one ordering billing cannot
    // get wrong, and a provider outage should cost a retry there rather than
    // the renewal. `unique` and not a dispatch id — a soft decline leaves the
    // invoice owed and presentable again, and an id would forbid that forever.
    'SubscriptionPeriod.close': async ({ db, record, timeZone, now, afterCommit }) => {
      const invoice = await renewPeriod(db, record as { subscriptionId: number, endsOn: string },
        { timeZone, at: now.toISOString() })
      if (invoice) afterCommit(() => jobs()?.dispatch(collectInvoice, { invoiceId: invoice.id },
        { unique: occurrenceKey('collect', String(invoice.id)) }))
    },

    // The reminder email, as an outbox row on the move's transaction rather
    // than an afterCommit: `reminded` is the record that it went, and a moved
    // row is never due again, so a crash after the commit would lose the email
    // with the column saying otherwise.
    'Invoice.remind': async ({ record, enqueue }) => {
      await enqueue(remindInvoice, { invoiceId: record.id })
    },
  }
}
