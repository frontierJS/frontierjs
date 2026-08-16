// ─── schema.lite ─────────────────────────────────────────────────────────────
//
// Add this model via `fli add notifications` or paste manually.
// Run `fli db:migrate` after adding.
//
// Gate: RCUD = 0.8.4.8
//   R (read):   0 — open (the row policy enforces ownership — you see only yours)
//   C (create): 8 — SYSTEM — db.asSystem(), which is what notify() uses
//   U (update): 4 — USER   — mark as read (PATCH readAt)
//   D (delete): 8 — SYSTEM
//
// Eight, not nine: 9 is LOCKED, a wall that asSystem() does not pass either, so
// a 9 in the create slot stops notify() from ever writing a row. 8 is SYSTEM.
//
// ─────────────────────────────────────────────────────────────────────────────

/*
model Notification {              // PascalCase singular → accessor db.notification
  id          Int       @id
  userId      String              // String, not Int — @frontierjs/auth issues uuid ids
                                  // (use Int only if your own User.id is an Int)
  type        String              // stable notification class id, e.g. 'PaymentReceived'
  data        Json                // payload built by toInApp() — varies by type
  contextType String?             // optional: 'Order', 'Project', 'Invoice'
  contextId   Int?                // optional: id of the related record (loose ref, no FK)
  readAt      DateTime?           // null = unread
  createdAt   DateTime  @default(now())

  @@gate("0.8.4.8")
  @@allow('read',   userId == auth().id)
  @@allow('update', userId == auth().id)
}
*/

// ─── api/server.ts wiring ─────────────────────────────────────────────────────

/*
import { notificationsPlugin } from '@frontierjs/notifications'
import { mailerPlugin, createResendMailer } from '@frontierjs/junction'

// mailerPlugin must be configured before notificationsPlugin
app.configure(mailerPlugin(createResendMailer({
  apiKey: process.env.RESEND_API_KEY!,
  from:   'noreply@example.com',
})))

app.configure(notificationsPlugin({
  db,
  transports: {
    email: { mailer: 'default' },       // uses app.mail
    // slack: new SlackDriver({ ... }) // custom driver example
  }
}))

// app.notify is now available everywhere
*/

// ─── Usage examples ───────────────────────────────────────────────────────────

/*
// 1. From a service hook (authMethod: 'created' integration with @frontierjs/auth)
//    ctx.result is the envelope — a single travels as { kind: 'single', data }.
after: {
  create: [
    async (ctx) => {
      if (ctx.auth.user?.authMethod === 'created') {
        await ctx.app.notify(ctx.result.data, new WelcomeUser())
      }
    }
  ]
}

// 2. From any service hook with a related record
//    `db.user`, singular — the accessor is derived from `model User`.
after: {
  create: [
    async (ctx) => {
      const user = await db.asSystem().user.findUnique({ where: { id: ctx.result.data.userId } })
      await ctx.app.notify(user, new PaymentReceived(ctx.result.data))
    }
  ]
}

// 2b. To somebody who has no account at all — a shop customer, a mailing-list
//     address. A Recipient is not a User: leave `id` off and email is the only
//     transport that can address them, which notify() enforces rather than
//     writing a notification row nobody could ever read.
await app.notify({ email: customer.email, name: customer.name }, new OrderConfirmation(order))

// 3. From a Caravan job
export const sendInvoiceJob = job({
  name: 'send-invoice',
  perform: async ({ userId, invoiceId }, { app }) => {
    const user    = await db.asSystem().users.findUnique({ where: { id: userId } })
    const invoice = await db.asSystem().invoices.findUnique({ where: { id: invoiceId } })
    await app.notify(user, new InvoiceSent(invoice))
  }
})

// 4. From a Junction route handler
app.post('/orders/{id}/complete', async (ctx) => {
  // TransportContext: path captures are ctx.route — there is no ctx.params
  // anywhere in Junction. `{id}`, not `:id`, or the segment is a literal.
  // No ctx.app on a route handler either — close over the app you created.
  const order = await completeOrder(ctx.route.id)

  // ctx.user is a SessionContext: `userId`, not `id`. Handing it to notify()
  // straight would address a recipient with no id — refused on inApp by name
  // rather than written as a row nobody can read.
  await app.notify({ id: ctx.user.userId, email: ctx.user.email }, new OrderCompleted(order))
  return ctx.json(order)
})
*/
