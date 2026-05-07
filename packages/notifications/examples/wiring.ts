// ─── schema.lite ─────────────────────────────────────────────────────────────
//
// Add this model via `fli add notifications` or paste manually.
// Run `fli db:migrate` after adding.
//
// Gate: RCUD = 0.9.4.9
//   R (read):   0 — open (policy enforces ownership — users see only their own)
//   C (create): 9 — locked — system only via db.asSystem() inside notify()
//   U (update): 4 — USER  — mark as read (PATCH readAt)
//   D (delete): 9 — locked — system only
//
// ─────────────────────────────────────────────────────────────────────────────

/*
model notifications {
  id          Integer   @id
  userId      Integer
  type        Text                   -- stable notification class identifier e.g. 'PaymentReceived'
  data        Json                   -- payload built by toInApp() — varies by type
  contextType Text?                  -- optional: 'Order', 'Project', 'Invoice'
  contextId   Integer?               -- optional: id of the related record (loose ref, no FK)
  readAt      DateTime?              -- null = unread
  createdAt   DateTime  @default(now())

  @@gate("0.9.4.9")
  @@policy(
    read:   "record.userId === ctx.user.id",
    update: "record.userId === ctx.user.id"
  )
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
      if (ctx.params.user?.authMethod === 'created') {
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
app.post('/orders/:id/complete', async (ctx) => {
  const order = await completeOrder(ctx.params.id)
  await ctx.app.notify(ctx.params.user, new OrderCompleted(order))
  return ctx.json(order)
})
*/
