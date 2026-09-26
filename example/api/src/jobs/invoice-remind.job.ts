// api/jobs/invoice-remind.job.ts — the email an invoice's `remind` move owes.
//
// Dispatched by the outbox relay, never by hand: the `Invoice.remind` hook
// (`api/src/core/commitments.ts`) writes the row in the transaction that sets
// `reminded`, so the move and the intent to send commit together and a crash
// between them costs a delay rather than the email.
//
// Delivery is at least once. A retry after a send that reached the mailer and
// then failed to report back sends twice, which for a reminder is the cheaper
// mistake than none.

import { defineJob }       from '@frontierjs/caravan'
import { db }              from '../core/db.ts'
import invoiceDue          from '../notifications/InvoiceDue.notification.ts'
import { asRecipient }     from '../notifications/OrderConfirmation.notification.ts'

export default defineJob<{ invoiceId: number }>(
  'invoice-remind',
  async (ctx) => {
    const sys     = db.asSystem() as Record<string, any>
    const invoice = await sys.invoice.findUnique({ where: { id: ctx.data.invoiceId }, include: { customer: true } })

    // Paid or voided since the reminder fell due: telling them now would be
    // wrong, and the move already records that it was owed.
    if (!invoice || invoice.status !== 'issued' || !invoice.customer) return

    await ctx.app!.notify(asRecipient(invoice.customer), invoiceDue({ invoice, customer: invoice.customer }))
  },
)
