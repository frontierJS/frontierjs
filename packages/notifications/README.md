# @frontierjs/notifications

Transport-agnostic notification system for FrontierJS apps. One notification class delivers across several transports — in-app, email, whatever you register a driver for — chosen per recipient.

**A transport is a delivery medium; a channel is junction's broadcast set.** The in-app driver uses both: it writes a row, then publishes on `app.channel('notifications:user:<id>')`. The two words are not interchangeable here (`FJS-D06`).

Standalone package — same pattern as `@frontierjs/auth`. No changes to Junction core required.

---

## Installation

```bash
bun add @frontierjs/notifications
```

Then add the model below to your `db/schema.lite` and migrate:

```bash
fli db:migrate
```

---

## Schema

The model this package expects in your `schema.lite`:

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

// mailerPlugin must be configured before notificationsPlugin if the email transport is used
app.configure(mailerPlugin(createResendMailer({ apiKey, from })))

app.configure(notificationsPlugin({
  db,
  transports: {
    email: { mailer: 'default' },
  }
}))

// app.notify is now available everywhere
```

The plugin declares `requires: ['mailer']` when the email transport uses the mailer, so Junction refuses to start on the wrong order rather than failing at the first send. `boot()` then checks that `app.mail` is actually set — a mailer plugin can register and install nothing. On shutdown each registered driver's own `shutdown()` is awaited; one that throws is logged and the rest still run.

---

## Writing a notification class

```typescript
// api/src/notifications/PaymentReceived.ts
import { Notification, inApp, mail } from '@frontierjs/notifications'
import type { InAppMessage, MailMessage, Recipient, Transport } from '@frontierjs/notifications'

export class PaymentReceived extends Notification {
  // Stable identifier written to the DB — survives class renames
  static type = 'PaymentReceived'

  constructor(private payment: Payment) {
    super()
  }

  via(recipient: Recipient): Transport[] {
    // Respect per-user preferences when available
    return recipient.notificationPreferences ?? ['inApp', 'email']
  }

  toInApp(recipient: Recipient): InAppMessage {
    return inApp()
      .title('Payment received')
      .body(`$${this.payment.amount} has been received.`)
      .action('View order', `/orders/${this.payment.orderId}`)
      .context('Order', this.payment.orderId)
      .data({ amount: this.payment.amount, orderId: this.payment.orderId })
      .build()
  }

  toEmail(recipient: Recipient): MailMessage {
    return mail()
      .subject('Payment received')
      .greeting(`Hi ${recipient.firstName ?? 'there'}`)
      .line(`$${this.payment.amount} received for order #${this.payment.orderId}.`)
      .action('View order', `https://app.example.com/orders/${this.payment.orderId}`)
      .build()
  }
}
```

Notification classes live in `api/src/notifications/`. One file per class, same convention as `services/` and `hooks/`.

If `via()` returns a transport but the corresponding `to<Transport>()` method is not implemented, `notify()` throws `NotificationTransportNotImplementedError` — before anything is delivered, so a two-transport notification cannot half-land.

---

## Sending

```typescript
// From anywhere with app context:
await app.notify(user, new PaymentReceived(payment))

// From a service hook — ctx.app is always available on ServiceContext
after: {
  create: [
    async (ctx) => {
      // `db.user`, singular — the accessor derived from `model User`.
      const user = await db.asSystem().user.findUnique({ where: { id: ctx.result.data.userId } })
      await ctx.app.notify(user, new PaymentReceived(ctx.result.data))
    }
  ]
}

// From a Caravan job
export const sendInvoiceJob = job({
  name: 'send-invoice',
  perform: async ({ userId, invoiceId }, { app }) => {
    const user    = await db.asSystem().user.findUnique({ where: { id: userId } })
    const invoice = await db.asSystem().invoice.findUnique({ where: { id: invoiceId } })
    await app.notify(user, new InvoiceSent(invoice))
  }
})

// From a route handler
app.post('/orders/{id}/complete', async (ctx) => {
  // Route handlers get a TransportContext: ctx.route holds the path captures
  // ({id}) and ctx.user is the caller. There is no ctx.app here — close over
  // the app you created.
  const order = await completeOrder(ctx.route.id)

  // ctx.user is a SessionContext — `userId`, not `id`. A Recipient wants `id`.
  await app.notify({ id: ctx.user.userId, email: ctx.user.email }, new OrderCompleted(order))
  return ctx.json(order)
})

// To somebody with no account — a shop customer, a mailing-list address.
// No `id`: email is the only transport that can address them, and notify()
// enforces that rather than writing a row nobody could read.
await app.notify({ email: customer.email, name: customer.name }, new OrderConfirmation(order))
```

---

## @frontierjs/auth integration

`@frontierjs/auth` sets `authMethod: 'created'` on the `SessionContext` returned by `createUser()`. Use this in an after hook to send a welcome notification on registration — no coupling between the two packages:

```typescript
// api/src/notifications/WelcomeUser.ts
export class WelcomeUser extends Notification {
  static type = 'WelcomeUser'

  via(_recipient: Recipient): Transport[] { return ['inApp', 'email'] }

  toInApp(user: Recipient): InAppMessage {
    return inApp()
      .title('Welcome!')
      .body(`Good to have you${user.firstName ? `, ${user.firstName}` : ''}.`)
      .action('Get started', '/dashboard')
      .build()
  }

  toEmail(user: Recipient): MailMessage {
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

`notify()` formats and validates eagerly, then executes every transport in parallel:

1. Call `notification.via(recipient)` — get the transport list
2. Format each transport's message **once**, and validate before any delivery:
   - Missing `to<Transport>()` → `NotificationTransportNotImplementedError`
   - Unregistered custom transport → `NotificationDriverNotFoundError`
   - Recipient not addressable on it → `NotificationRecipientError`
3. `Promise.allSettled` across all transports — a failed email does not block inApp delivery
4. Failures collected and thrown as `NotificationDeliveryError` with per-transport detail

The message formatted in step 2 is the one delivered in step 3. It used to be built twice — once to check the method existed, once to send — so a `to*()` that rendered a template did it twice per notification.

---

## The recipient

`Recipient` is `{ id?, email?, phone?, ...yours }`. **It is not a `User`** — a shop customer, a mailing-list address and a signed-in account are all recipients, and only the last has a row anything can read. Extra keys travel untouched, which is what `via()` and the `to*()` methods read.

`id` is optional, and each transport says what it needs:

| Transport | Needs | If it is missing |
|---|---|---|
| `inApp` | `id` — the row is keyed by it | `NotificationRecipientError`, before any transport runs |
| `email` | `message.to` or `recipient.email` | `NotificationRecipientError`, same point |
| a registered driver | whatever it addresses by | the driver's own answer — only it knows |

Addressing a customer used to mean passing them as a `User` with an invented id (`customer:42`), which is right for email and writes an unreadable in-app row for anybody who later adds `inApp` to `via()`. Leave the id off instead.

---

## inApp transport

Persists a record to the `notifications` table via `db.asSystem()` (bypasses gate and policy — create is locked at gate level). Then publishes a WS event on junction's `app.channel()` — the broadcast sense of the word — if the `channels()` plugin is configured.

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

## email transport

Delegates to `app.mail.send()`. Requires `mailerPlugin` to be configured before `notificationsPlugin`. The address resolves as `message.to` (explicit override) → `recipient.email`; missing both is refused before delivery.

The builder's `lines` are rendered to text and HTML here — `MailMessage` is this package's authoring shape, and no mailer understands it. `.html()` / `.text()` override either half, which is how an `@frontierjs/email-kit` template supplies the HTML and the builder still writes the plain-text alternative.

---

## Custom drivers

```typescript
// api/src/drivers/SlackDriver.ts
import type { NotificationDriver, Recipient, App } from '@frontierjs/notifications'

export class SlackDriver implements NotificationDriver {
  transport = 'slack'

  constructor(private opts: { webhookUrl: string }) {}

  async send(recipient: Recipient, message: unknown, app: App): Promise<void> {
    await fetch(this.opts.webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message),
    })
  }

  /** Optional — awaited once on app shutdown. */
  async shutdown(): Promise<void> {}
}

// api/server.ts
app.configure(notificationsPlugin({
  db,
  transports: {
    slack: new SlackDriver({ webhookUrl: process.env.SLACK_WEBHOOK! })
  }
}))

// api/src/notifications/OrderAlert.ts
export class OrderAlert extends Notification {
  static type = 'OrderAlert'
  via(_recipient: Recipient): Transport[] { return ['inApp', 'slack'] }

  toInApp(recipient: Recipient): InAppMessage { ... }

  toSlack(recipient: Recipient) {
    return { text: `New order #${this.order.id} received.` }
  }
}
```

---

## Sierra resource

The UI half is a resource file whose data half is `<script module>`, per Invariant 18 — `web/src/resources/Notification.mesa`. `examples/Notification.mesa` is the one this package ships to copy:

- `notifications` — `createResource('notifications', { model: 'Notification' })`; `.store` is the live list, `.service` the client
- `isUnread(n)` — what the bell counts and the list styles
- `markRead(id)` — `service.patch(id, { readAt })`

Real-time needs no code: the resource's live store receives the `notification:created` event the inApp driver publishes, as long as the `channels()` plugin is configured on the server.

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
| `NotificationTransportNotImplementedError` | `via()` returns a transport but `to<Transport>()` is not implemented |
| `NotificationRecipientError` | the recipient cannot be addressed on a transport `via()` named — no `id` for `inApp`, no address for `email` |
| `NotificationDriverNotFoundError` | `via()` returns a transport name with no registered driver |
| `NotificationDeliveryError` | one or more transports failed — carries per-transport error detail |

The first three are thrown before any delivery starts; the last is the only one raised after.

---

## Key distinctions

`_method()` bypasses hooks, not gates. `db.asSystem()` bypasses gates, not hooks. The inApp driver uses `db.asSystem()` to write past the `create=8` gate — deliberately. App users cannot create notification records through the API.

---

## Out of scope (future)

- SMS driver — when a Conduit SMS provider is available. `sms` is not built in, so it needs a registered driver like any other custom transport
- Push notifications — APNs / FCM, requires a device token model
- Notification preferences model — per-recipient transport preferences in the DB
- Digest mode — batch into scheduled email digest
- Bulk mark-as-read endpoint
- Read receipts via WS — mark read when notification panel opened
- Soft delete / archive
