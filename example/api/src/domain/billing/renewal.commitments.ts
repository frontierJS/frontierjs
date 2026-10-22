// api/src/domain/billing/renewal.commitments.ts — what a commitment's move owes, beyond itself.
//
// Found by junction's `commitments()` as any `*.commitments.ts` under the app
// root (`FJS-D1141`), each hook running inside the transaction that made its
// move (`FJS-D368`). `verify:billing` fires a period with no app behind it
// through junction's own `fireCommitment` and imports this same map, so the
// drive grades the hooks and not a copy.

import { defineCommitment } from '@frontierjs/junction/commitments'
import { renewPeriod }      from './billing.ts'

// Jobs are named, not imported: the loader that stamps a job's name from its
// file has not run in a drive with no app, and an unstamped definition throws
// when `enqueue` reads its name.
const COLLECT = 'invoice-collect'
const REMIND  = 'invoice-remind'

export default {
  // A period closing is a renewal (`FJS-D367`): the next period and its
  // invoice, in the same transaction as the close. `after`: the closing
  // period holds the one-open-period guard until it has moved (`FJS-D1022`).
  //
  // The invoice is presented AFTER the commit, as its own job: taking money
  // for a document that then rolled back is the one ordering billing cannot
  // get wrong, and a provider outage should cost a retry there rather than
  // the renewal. An outbox row on the move's transaction, so a crash after
  // the commit cannot leave a renewed period whose invoice is never presented.
  // No `unique`: the close's own lock makes this run once per period, and a
  // soft decline's retries are dispatched by the payment service under keys of
  // their own.
  'SubscriptionPeriod.close': defineCommitment({ after: async ({ db, record, timeZone, now, enqueue }) => {
    const invoice = await renewPeriod(db, record as { subscriptionId: number, endsOn: string },
      { timeZone, at: now.toISOString() })
    if (invoice) await enqueue(COLLECT, { invoiceId: invoice.id })
  } }),

  // The reminder email, as an outbox row on the move's transaction rather
  // than an afterCommit: `reminded` is the record that it went, and a moved
  // row is never due again, so a crash after the commit would lose the email
  // with the column saying otherwise.
  'Invoice.remind': defineCommitment({ after: async ({ record, enqueue }) => {
    await enqueue(REMIND, { invoiceId: record.id })
  } }),
}
