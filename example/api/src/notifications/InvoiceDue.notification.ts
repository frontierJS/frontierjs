// api/src/notifications/InvoiceDue.notification.ts — an invoice about to fall due.
//
// Sent once per invoice, three days before `dueOn`, by `invoice-remind` — the
// job the `Invoice.remind` commitment enqueues with its move. A customer is
// addressed by email alone, as `OrderConfirmation` explains, so `via` is email
// and nothing else.

import { defineNotification, mail } from '@frontierjs/notifications'
import { money }                    from '../domain/shop'

type Due = {
  invoice:  { id: number, number: string, total: number, dueOn: string }
  customer: { name: string }
}

export default defineNotification<Due>({
  via: () => ['email'],

  email: ({ invoice, customer }) => mail()
    .subject(`Invoice ${invoice.number} is due on ${invoice.dueOn}`)
    .greeting(`Hi ${customer.name}`)
    .line(`Invoice ${invoice.number} for ${money(invoice.total)} is due on ${invoice.dueOn}.`)
    .line('If you have already paid it, there is nothing to do.')
    .action('View invoice', `http://localhost:8010/invoices/${invoice.id}/`),
})
