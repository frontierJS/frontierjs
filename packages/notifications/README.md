# @frontierjs/notifications

Transport-agnostic notification system for FrontierJS apps. One notification delivers across several transports — in-app, email, whatever you register a driver for — chosen per recipient.

**A transport is a delivery medium; a channel is junction's broadcast set.** The in-app driver uses both: it writes a row, then publishes on `app.channel('notifications:user:<id>')`. The two words are not interchangeable here (`FJS-D06`).

Standalone package — same pattern as `@frontierjs/auth`. No changes to Junction core required.

---

## Installation

```bash
bun add @frontierjs/notifications
fli notifications:install
```

`notifications:install` appends the model this package ships to your
`db/schema.lite` and pushes it. `fli new --with notifications` runs it for you.
§ Schema below is what that model says and why.

---

## Schema

One model, and it is the app's rather than this package's — the same split
`@frontierjs/auth` makes between `user.lite` and `auth.lite`. It ships as a real `.lite` file so there is one copy of the text and an app's
copy can be graded against it — `fli notifications:install` is what appends it.
Read `db/notification.lite` for the column-by-column reasoning; the shape is:

```litestone
model Notification {
  id          Int       @id
  userId      String              // String, not Int — auth issues uuid ids
  type        String              // the notification's stable name
  data        Json                // whatever its formatter built
  contextType String?             // a loose reference, with no foreign key
  contextId   Int?
  readAt      DateTime?           // null = unread
  createdAt   DateTime  @default(now())

  @@db(main)
  @@gate("0.8.4.8")
  @@allow('read',   userId == auth().id)
  @@allow('update', userId == auth().id)
}
```

**It is copied rather than imported, on purpose.** Everything an app does next
happens to this model — a relation back to its own `User`, a tenant key, a
column its bell menu wants, `@@log(audit)` — and none of that is this package's
to decide. What the copy costs is drift, which is why the file is exported:
`fli check`'s `package-model-drift` compares your copy against it and names a
column this package writes that yours does not have.

Gate is RCUD: read=open (the row policy scopes it to your own records),
create=SYSTEM (only `db.asSystem()`, which is what `notify()` uses), update=USER
(mark as read), delete=SYSTEM.

**Eight, not nine.** `9` is LOCKED — an absolute wall that `asSystem()` does not
pass either — so a `9` in the create slot would stop `notify()` from ever writing
a row. `8` is SYSTEM. Comments use `//`; `--` is a parse error. Row policies are
`@@allow`/`@@deny` with schema expressions (`auth().id`) — there is no `@@policy`
attribute and no JS-string predicate.

`type` stores the notification's stable identifier — its file name
(`PaymentReceived.notification.ts`), or the `type:` it states. Not a foreign key,
not an enum: adding a notification type requires no migration.

`contextType`/`contextId` are a loose polymorphic reference. No foreign key by
design — notifications survive record deletion without cascades.

That is also why `fli check`'s `polymorphic-subject` asks about `contextType`:
with no foreign key, nothing refuses a value that names nothing — not a
migration, not a seed, not `asSystem()`. An app whose contexts are a known set
constrains the one column that can be, `@@check("contextType IN ('Order',
'Invoice')")` or a `@values` set; an app whose set grows with every model
baselines the rule to say so. Either answer is fine and neither is the default,
which is why the check asks.

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

## Writing a notification

A notification is a file under `notifications/`, named for the type it writes.
The file name IS the type — `PaymentReceived.notification.ts` is
`PaymentReceived`, verbatim, the same rule `<name>.job.ts` follows — so nothing
restates it and nothing can drift from what the browser reads back.

```typescript
// api/src/notifications/PaymentReceived.notification.ts
import { defineNotification, inApp, mail } from '@frontierjs/notifications'

export default defineNotification<Payment>({
  // Which transports, for THIS payment and THIS recipient.
  via: (payment, recipient) => recipient.notificationPreferences ?? ['inApp', 'email'],

  inApp: (payment) => inApp()
    .title('Payment received')
    .body(`$${payment.amount} has been received.`)
    .action('View order', `/orders/${payment.orderId}`)
    .context('Order', payment.orderId)
    .data({ amount: payment.amount, orderId: payment.orderId }),

  email: (payment, recipient) => mail()
    .subject('Payment received')
    .greeting(`Hi ${recipient.firstName ?? 'there'}`)
    .line(`$${payment.amount} received for order #${payment.orderId}.`)
    .action('View order', `https://app.example.com/orders/${payment.orderId}`),
})
```

Send it by calling the definition with its payload:

```typescript
import paymentReceived from '../notifications/PaymentReceived.notification.ts'

await app.notify(user, paymentReceived(payment))
```

**A formatter may be async.** That is what lets a body be rendered where it is
read, rather than earlier:

```typescript
email: async (order) => {
  const { subject, html, text } = await renderEmailFile(TEMPLATE, { data: order })
  return mail().subject(subject).html(html).text(text)
}
```

**`via` takes the payload rather than closing over it**, so a definition can be
asked what it supports before anything is sent — which is what a preferences
screen and a devtools panel need:

```typescript
paymentReceived.type        // 'PaymentReceived'
paymentReceived.transports  // ['inApp', 'email']
app.notifications           // every type this app declares, by name
```

### Where they are found

Two directories are probed beside the entry — `notifications/` and
`src/notifications/` — which covers the flat layout and the scaffolded one.
State the path when neither applies, or when the entry is not the app (a test
runner and a drive that imports the app module both make themselves the entry):

```typescript
app.configure(notificationsPlugin({
  db,
  notifications: new URL('./notifications', import.meta.url).pathname,
  transports:    { email: { mailer: 'default' } },
}))
```

A stated path that is not a directory throws naming it. `notifications: false`
turns loading off, and definitions then have to state `type:` themselves.

### Renaming

The type is persisted — it is written into `notifications.type` and read by the
browser to choose a renderer — so renaming the file renames the type, and rows
already written keep the old one. State `type:` to hold it still:

```typescript
export default defineNotification<Payment>({
  type: 'PaymentReceived',   // rows were written under this; the file moved on
  via:  () => ['inApp'],
  inApp: (payment) => inApp().title('Payment received'),
})
```

The loader reports the divergence, because a deliberate rename and a typo look
identical from where it stands.

### The class form

`class X extends Notification` still works and is not deprecated —
`notify()` reads three members and never asks which shape produced them. It
costs a `static type` restating the file name, and a `static async` factory
behind a private constructor wherever a body has to be rendered, because its
`toEmail()` cannot be async.


Notification classes live in `api/src/notifications/`. One file per class, same convention as `services/` and `hooks/`.

If `via` returns a transport the definition has no formatter for, `notify()` throws `NotificationTransportNotImplementedError` — before anything is delivered, so a two-transport notification cannot half-land.

---

## Sending

```typescript
// From anywhere with app context:
await app.notify(user, paymentReceived(payment))

// From a service hook — ctx.app is always available on ServiceContext
after: {
  create: [
    async (ctx) => {
      // `db.user`, singular — the accessor derived from `model User`.
      const user = await db.asSystem().user.findUnique({ where: { id: ctx.result.data.userId } })
      await ctx.app.notify(user, paymentReceived(ctx.result.data))
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

```typescript
// api/src/notifications/WelcomeUser.notification.ts
import { defineNotification, inApp, mail } from '@frontierjs/notifications'

export default defineNotification<void>({
  via: () => ['inApp', 'email'],

  inApp: (_, user) => inApp()
    .title('Welcome')
    .body(`Good to have you${user.firstName ? `, ${user.firstName}` : ''}.`)
    .action('Get started', '/dashboard'),

  email: (_, user) => mail()
    .subject('Welcome to the app')
    .greeting(`Hi ${user.firstName ?? 'there'}`)
    .line('Your account is ready.')
    .action('Go to dashboard', 'https://app.example.com/dashboard'),
})

// api/src/services/users.ts
import welcomeUser from '../notifications/WelcomeUser.notification.ts'

after: {
  create: [
    async (ctx) => {
      // authMethod: 'created' is stamped by @frontierjs/auth createUser()
      if (ctx.auth.user?.authMethod === 'created') {
        await ctx.app.notify(ctx.result.data, welcomeUser())
      }
    }
  ]
}
```

A notification with nothing to carry is `defineNotification<void>` and is sent
as `welcomeUser()`. The recipient still arrives — it is every formatter's second
argument, which is where `user.firstName` above comes from.


---

## Execution model

`notify()` formats and validates eagerly, then executes every transport in parallel:

1. Call `notification.via(recipient)` — get the transport list
2. Format each transport's message **once**, awaiting it, and validate before any delivery:
   - No formatter for that transport → `NotificationTransportNotImplementedError`
   - Unregistered custom transport → `NotificationDriverNotFoundError`
   - Recipient not addressable on it → `NotificationRecipientError`
3. `Promise.allSettled` across all transports — a failed email does not block inApp delivery
4. Failures collected and thrown as `NotificationDeliveryError` with per-transport detail

The message formatted in step 2 is the one delivered in step 3. It is built once: formatting to check the method exists and formatting to send are one call, or a formatter that renders a template does it twice per notification.

Step 2 awaits, so a formatter may be async. Validation is still eager: every transport is formatted and checked before any of them is delivered.

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

// api/src/notifications/OrderAlert.notification.ts
export default defineNotification<Order>({
  via: () => ['inApp', 'slack'],

  inApp: (order) => inApp().title('New order').body(`#${order.id}`),

  // A formatter is named for the transport its driver is registered under.
  slack: (order) => ({ text: `New order #${order.id} received.` }),
})
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
| `NotificationTransportNotImplementedError` | `via` returns a transport the definition has no formatter for |
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
