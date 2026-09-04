// api/jobs/announce-payment.job.ts — who hears that an order was paid.
//
// Two audiences, one event: the customer gets an email, the staff get a row in
// the app. Both are `app.notify()`, and both happen AFTER the response — an
// email is an outbound HTTP call to somebody else's API, which is exactly the
// thing that must not sit inside a state transition.
//
// The two are dispatched together and delivered independently: `notify()` runs
// a notification's channels through `Promise.allSettled`, and this job runs two
// notifications in sequence, so an unreachable mail provider still leaves the
// staff notification written. What it does NOT do is swallow the failure —
// throwing is what makes Caravan retry, and a confirmation email that silently
// never arrives is the failure mode worth being loud about.

import { defineJob } from '@frontierjs/caravan'
import { db } from '../core/db.ts'
import orderPaid         from '../notifications/OrderPaid.notification.ts'
import orderConfirmation, { asRecipient } from '../notifications/OrderConfirmation.notification.ts'

interface AnnouncePayment {
  orderId: number
}

export default defineJob<AnnouncePayment>(
  'announce-payment',
  async (ctx) => {
    const app = ctx.app!

    const order = (await db
      .asSystem()
      .order.findUnique({ where: { id: ctx.data.orderId } })) as {
      id: number
      reference: string
      total: number
      customerId: number
    } | null

    // The order was deleted between the payment and this job. Not an error and
    // not worth retrying — there is nobody left to tell.
    if (!order) return

    const customer = (await db
      .asSystem()
      .customer.findUnique({ where: { id: order.customerId } })) as {
      id: number
      name: string
      email: string
    } | null

    const failures: string[] = []

    // ── the customer, by email ────────────────────────────────────────────
    if (customer) {
      try {
        // Rendered before it is sent: `build()` compiles the .mesa template and
        // hands the result to the notification, because `toEmail()` is sync.
        await app.notify(asRecipient(customer), orderConfirmation({ order, customer }))
      } catch (err) {
        failures.push(`email: ${(err as Error).message}`)
      }
    }

    // ── the staff, in the app ─────────────────────────────────────────────
    //
    // Everyone who can act on an order, which in this shop is everyone with a
    // login. A real one would scope this to a role or a workspace; the point
    // here is that the row belongs to a USER and the UI reads it back through
    // the model's own `@@allow('read', userId == auth().id)` — no service code
    // says "only your own notifications".
    const staff = (await db.asSystem().user.findMany({})) as { id: string; email: string }[]

    // Built once, sent many times. The payload is bound here and the recipient
    // arrives per send, which is what `via(payload, recipient)` is for — the
    // class had to be constructed inside the loop because it held the payload
    // and answered nothing without one.
    const paid = orderPaid(order)

    for (const user of staff) {
      try {
        await app.notify(user, paid)
      } catch (err) {
        failures.push(`inApp ${user.email}: ${(err as Error).message}`)
      }
    }

    // Throwing is what schedules the retry. Partial delivery is recorded in the
    // message so the failed job says which half is missing.
    if (failures.length) throw new Error(`announce-payment: ${failures.join(' | ')}`)
  },
  {
    queue: 'fulfillment',
    maxAttempts: 5,
    retryDelay: [30_000, 120_000, 600_000]
  }
)
