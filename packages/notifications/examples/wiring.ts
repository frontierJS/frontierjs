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
  channels: {
    email: { mailer: 'default' },       // uses app.mail
    // slack: new SlackDriver({ ... }) // custom driver example
  }
}))

// app.notify is now available everywhere
*/

// ─── Usage examples ───────────────────────────────────────────────────────────

/*
// 1. From a service hook (authMethod: 'created' integration with @frontierjs/auth)
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
after: {
  create: [
    async (ctx) => {
      const user = await db.asSystem().users.findUnique({ where: { id: ctx.result.data.userId } })
      await ctx.app.notify(user, new PaymentReceived(ctx.result.data))
    }
  ]
}

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
  // TransportContext: ctx.params = path captures (:id), ctx.user = caller.
  // No ctx.app on a route handler — close over the app you created.
  const order = await completeOrder(ctx.params.id)
  await app.notify(ctx.user, new OrderCompleted(order))
  return ctx.json(order)
})
*/
