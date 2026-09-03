// api/jobs/collect-invoice.job.ts — present one invoice to the provider.
//
// A separate job from `renew-subscription` on purpose. Issuing a document and
// taking money are two different failures with two different answers: an
// invoice that was issued and not paid is the ordinary state of every business,
// and a renewal that rolled back because a card was declined would leave a
// customer un-billed for a month they used.
//
// So the renewal commits, and this is dispatched after it. A provider outage
// costs a retry here and nothing upstream.

import { defineJob }       from '@frontierjs/caravan'
import type { JobContext } from '@frontierjs/caravan'
import { db }              from '../core/db.ts'
import { chargeInvoice }   from '../domain/billing'

export type CollectPayload = { invoiceId: number }

/**
 * Answers the provider's reference, or null where there was nothing to
 * present — an invoice somebody settled by hand between the dispatch and here,
 * or one already in flight.
 *
 * `ctx.app` is what carries `app.conduit`, which is where the credential, the
 * timeout, the retry ladder and the breaker live. A `fetch` here would have
 * none of them and would put the provider's key in this file.
 */
export async function collectInvoice(ctx: JobContext<CollectPayload>): Promise<string | null> {
  const sys     = db.asSystem() as Record<string, any>
  const invoice = await sys.invoice.findFirst({ where: { id: ctx.data.invoiceId } })
  if (!invoice || invoice.status !== 'issued') return null

  const { paymentRef, error } = await chargeInvoice(ctx.app ?? {}, sys, invoice.id)

  // Thrown rather than returned, and only here. The caller of `chargeInvoice`
  // wants the failure as a value; a JOB wants it as a throw, because that is
  // what caravan's retry ladder reads — and `retryable: false` is a provider
  // configuration error that retrying cannot fix, so it is logged and finished.
  if (error) {
    if (error.retryable) throw new Error(`collect ${invoice.number}: ${error.kind} — ${error.message}`)
    console.error(`[billing] ${invoice.number} cannot be presented: ${error.kind} — ${error.message}`)
    return null
  }

  return paymentRef ?? null
}

export default defineJob<CollectPayload>(
  'collect-invoice',
  async (ctx) => { await collectInvoice(ctx) },
  { maxAttempts: 4 },
)
