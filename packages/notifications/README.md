# @frontierjs/notifications

Channel-agnostic notification system for FrontierJS apps. The same notification class delivers across multiple channels (in-app, email) based on user preferences and driver availability.

Standalone package — same pattern as `@frontierjs/auth`. No changes to Junction core required.

---

## Installation

```bash
bun add @frontierjs/notifications
```

Then scaffold the schema model:

```bash
fli add notifications
fli db:migrate
```

---

## Schema

`fli add notifications` appends this model to your `schema.lite`:

```litestone
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
```

Gate is RCUD: read=open (the row policy scopes it to your own records), create=SYSTEM
(only `db.asSystem()`, which is what `notify()` uses), update=USER (mark as read),
delete=SYSTEM.

**Eight, not nine.** `9` is LOCKED — an absolute wall that `asSystem()` does not pass
either — so a `9` in the create slot would stop `notify()` from ever writing a row.
`8` is SYSTEM. Comments use `//`; `--` is a parse error. Row policies are
`@@allow`/`@@deny` with schema expressions (`auth().id`) — there is no `@@policy`
attribute and no JS-string predicate.

`type` stores the notification class's `static type` identifier — not a foreign key, not an enum. Adding a new notification type requires no migration.

`contextType`/`contextId` are a loose polymorphic reference. No foreign key by design — notifications survive record deletion without cascades.

---

## Wiring

```typescript
// api/server.ts
import { notificationsPlugin } from '@frontierjs/notifications'

// mailerPlugin must be configured before notificationsPlugin if email channel is used
app.configure(mailerPlugin(createResendMailer({ apiKey, from })))

app.configure(notificationsPlugin({
  db,
  channels: {
    email: { mailer: 'default' },
  }
}))

// app.notify is now available everywhere
```

---

## Writing a notification class

```typescript
// api/src/notifications/PaymentReceived.ts
import { Notification, inApp, mail } from '@frontierjs/notifications'
import type { InAppMessage, MailMessage, User } from '@frontierjs/notifications'

export class PaymentReceived extends Notification {
  // Stable identifier written to the DB — survives class renames
  static type = 'PaymentReceived'

  constructor(private payment: Payment) {
    super()
  }

  via(user: User): string[] {
    // Respect per-user preferences when available
    return user.notificationPreferences ?? ['inApp', 'email']
  }

  toInApp(user: User): InAppMessage {
    return inApp()
      .title('Payment received')
      .body(`$${this.payment.amount} has been received.`)
      .action('View order', `/orders/${this.payment.orderId}`)
      .context('Order', this.payment.orderId)
      .data({ amount: this.payment.amount, orderId: this.payment.orderId })
      .build()
  }

  toEmail(user: User): MailMessage {
    return mail()
      .subject('Payment received')
      .greeting(`Hi ${user.firstName ?? 'there'}`)
      .line(`$${this.payment.amount} received for order #${this.payment.orderId}.`)
      .action('View order', `https://app.example.com/orders/${this.payment.orderId}`)
      .build()
  }
}
```

Notification classes live in `api/src/notifications/`. One file per class, same convention as `services/` and `hooks/`.

If `via()` returns a channel but the corresponding `toChannel()` method is not implemented, `notify()` throws `NotificationChannelNotImplementedError` at send time.

---

## Sending

```typescript
// From anywhere with app context:
await app.notify(user, new PaymentReceived(payment))

// From a service hook — ctx.app is always available on ServiceContext
after: {
  create: [
    async (ctx) => {
      const user = await db.asSystem().users.findUnique({ where: { id: ctx.result.data.userId } })
      await ctx.app.notify(user, new PaymentReceived(ctx.result.data))
    }
  ]
}

// From a Caravan job
export const sendInvoiceJob = job({
  name: 'send-invoice',
  perform: async ({ userId, invoiceId }, { app }) => {
    const user    = await db.asSystem().users.findUnique({ where: { id: userId } })
    const invoice = await db.asSystem().invoices.findUnique({ where: { id: invoiceId } })
    await app.notify(user, new InvoiceSent(invoice))
  }
})

// From a route handler
app.post('/orders/{id}/complete', async (ctx) => {
  // Route handlers get a TransportContext: ctx.params holds the path captures
  // (:id) and ctx.user is the caller. There is no ctx.app here — close over
  // the app you created.
  const order = await completeOrder(ctx.params.id)
  await app.notify(ctx.user, new OrderCompleted(order))
  return ctx.json(order)
})
```

---

## @frontierjs/auth integration

`@frontierjs/auth` sets `authMethod: 'created'` on the `SessionContext` returned by `createUser()`. Use this in an after hook to send a welcome notification on registration — no coupling between the two packages:

```typescript
// api/src/notifications/WelcomeUser.ts
export class WelcomeUser extends Notification {
  static type = 'WelcomeUser'

  via(_user: User) { return ['inApp', 'email'] }

  toInApp(user: User): InAppMessage {
    return inApp()
      .title('Welcome!')
      .body(`Good to have you${user.firstName ? `, ${user.firstName}` : ''}.`)
      .action('Get started', '/dashboard')
      .build()
  }

  toEmail(user: User): MailMessage {
    return mail()
      .subject('Welcome to the app')
      .greeting(`Hi ${user.firstName ?? 'there'}`)
      .line('Your account is ready.')
      .action('Go to dashboard', 'https://app.example.com/dashboard')
      .build()
  }
}

// api/src/services/users.ts
after: {
  create: [
    async (ctx) => {
      // authMethod: 'created' is stamped by @frontierjs/auth createUser()
      if (ctx.auth.user?.authMethod === 'created') {
        await ctx.app.notify(ctx.result.data, new WelcomeUser())
      }
    }
  ]
}
```

---

## Execution model

`notify()` validates eagerly then executes all channels in parallel:

1. Call `notification.via(user)` — get channel list
2. Validate all channels before any delivery:
   - Missing `toChannel()` → `NotificationChannelNotImplementedError`
   - Unregistered custom channel → `NotificationDriverNotFoundError`
3. `Promise.allSettled` across all channels — a failed email does not block inApp delivery
4. Failures collected and thrown as `NotificationDeliveryError` with per-channel detail

---

## inApp channel

Persists a record to the `notifications` table via `db.asSystem()` (bypasses gate and policy — create is locked at gate level). Then publishes a WS event via `app.channel()` if the `channels()` plugin is configured.

Degrades gracefully when `channels()` is absent — DB record still persists, WS push is skipped without error.

Stored `data` payload structure:

```json
{
  "title":   "Payment received",
  "body":    "$100 has been received.",
  "action":  { "label": "View order", "url": "/orders/123" },
  "amount":  100,
  "orderId": 123
}
```

UI reads `type` to decide how to render. `title` and `body` are generic fallback fields. Custom fields from `.data()` enable type-specific rendering.

---

## email channel

Delegates to `app.mail.send()`. Requires `mailerPlugin` to be configured before `notificationsPlugin`. Recipient resolves as `message.to` (explicit override) → `user.email`. Missing both throws at send time.

---

## Custom drivers

```typescript
// api/src/drivers/SlackDriver.ts
import type { NotificationDriver, User, App } from '@frontierjs/notifications'

export class SlackDriver implements NotificationDriver {
  channel = 'slack'

  constructor(private opts: { webhookUrl: string }) {}

  async send(user: User, message: unknown, app: App): Promise<void> {
    await fetch(this.opts.webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message),
    })
  }
}

// api/server.ts
app.configure(notificationsPlugin({
  db,
  channels: {
    slack: new SlackDriver({ webhookUrl: process.env.SLACK_WEBHOOK! })
  }
}))

// api/src/notifications/OrderAlert.ts
export class OrderAlert extends Notification {
  static type = 'OrderAlert'
  via(_user: User) { return ['inApp', 'slack'] }

  toInApp(user: User): InAppMessage { ... }

  toSlack(user: User) {
    return { text: `New order #${this.order.id} received.` }
  }
}
```

---

## Sierra resource

`fli add notifications` creates `web/src/resources/Notification.mesa` with:

- `store` — reactive notification list
- `service` — Junction service client
- `unreadCount` — derived store, reactive unread count for bell icon
- `markRead(id)` — PATCH single notification
- `markAllRead()` — PATCH all unread (one call per record — add a bulk endpoint for large counts)
- `onEvent('notification:created')` — real-time WS push into store (requires `channels()` plugin)

---

## Querying

Standard Junction service — policy scopes all queries to the current user automatically:

```
GET  /notifications               — all for current user
GET  /notifications?readAt=null   — unread only
GET  /notifications?contextType=Order&contextId=123
PATCH /notifications/456          { readAt: "2026-04-18T..." }
```

---

## Errors

| Error | When |
|---|---|
| `NotificationChannelNotImplementedError` | `via()` returns a channel but `toChannel()` is not implemented |
| `NotificationDriverNotFoundError` | `via()` returns a channel name with no registered driver — thrown before delivery starts |
| `NotificationDeliveryError` | One or more channels failed — contains per-channel error detail |

---

## Key distinctions

`_method()` bypasses hooks, not gates. `db.asSystem()` bypasses gates, not hooks. The inApp driver uses `db.asSystem()` to bypass the `create=9` gate — this is intentional. App users cannot create notification records via the API.

---

## Out of scope (future)

- SMS driver — when Conduit SMS provider is available
- Push notifications — APNs / FCM, requires device token model
- Notification preferences model — per-user channel preferences in DB
- Digest mode — batch into scheduled email digest
- Bulk mark-as-read endpoint
- Read receipts via WS — mark read when notification panel opened
- Soft delete / archive
