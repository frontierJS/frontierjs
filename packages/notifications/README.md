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
  subjectType String?             // a loose reference, with no foreign key
  subjectId   String?
  deliveryKey String?             // the definition's `key`, so a retry writes no second row
  readAt      DateTime?           // null = unread
  createdAt   DateTime  @default(now())

  @@db(main)
  @@gate(0.8.4.8)
  @@unique([userId, type, deliveryKey], nullsDistinct: true)
  @@allow(read,   userId == auth().id)
  @@allow(update, userId == auth().id)
}
```

**It is copied rather than imported, on purpose.** Everything an app does next
happens to this model — a relation back to its own `User`, a tenant key, a
column its bell menu wants, `@@trail(audit)` — and none of that is this package's
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

`subjectType`/`subjectId` are a loose polymorphic reference. No foreign key by
design — notifications survive record deletion without cascades.

That is also why `fli check`'s `polymorphic-subject` asks about `subjectType`:
with no foreign key, nothing refuses a value that names nothing — not a
migration, not a seed, not `asSystem()`. An app whose contexts are a known set
constrains the one column that can be, `@@check("subjectType IN ('Order',
'Invoice')")` or a `@values` set; an app whose set grows with every model
baselines the rule to say so. Either answer is fine and neither is the default,
which is why the check asks.

---

## Wiring

```typescript fragment
// api/src/app.ts
import { notifications } from '@frontierjs/notifications'
import { mail, createResendMailer } from '@frontierjs/junction/mail'

// mail must be configured before notifications if the email transport is used
app.configure(mail({ mailer: createResendMailer({
  credentials: { get: ref => process.env[ref] },   // or a Conduit resolver
  apiKeyRef:   'RESEND_API_KEY',
  from,
}) }))

app.configure(notifications({
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

A notification is a `*.notification.ts` file, named for the type it writes.
The file name IS the type — `PaymentReceived.notification.ts` is
`PaymentReceived`, verbatim, the same rule `<name>.job.ts` follows — so nothing
restates it and nothing can drift from what the browser reads back.

```typescript fragment
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

```typescript fragment
import paymentReceived from '../notifications/PaymentReceived.notification.ts'

await app.notify(user, paymentReceived(payment))
```

**A retried send needs a `key`.** `notify()` delivers every transport and
throws when any one failed, and a job retries by throwing — so without a key, an
unreachable mail provider is a new in-app row per attempt. `key` names what
makes two sends the same send, and a recipient who already has a row under that
key and type gets no second one:

```typescript fragment
export default defineNotification<Order>({
  via:   () => ['inApp', 'email'],
  key:   (order) => `order:${order.id}`,
  inApp: (order) => inApp().title('Order paid').context('Order', order.id),
  email: (order) => mail().subject('Order paid').line(order.reference),
})
```

It is optional: a definition without one writes a row every time it is sent,
which is what a weekly reminder about one invoice wants. The class form states
it as a `key(recipient)` method. A key dedupes the in-app ROW only — the email a
retry sends is sent again (`FJS-D872`).

**A formatter may be async.** That is what lets a body be rendered where it is
read, rather than earlier:

```typescript fragment
email: async (order) => {
  const { subject, html, text } = await renderEmailFile(TEMPLATE, { data: order })
  return mail().subject(subject).html(html).text(text)
}
```

**A mail may carry files.** `.attach({ filename, content, type })` takes junction's
`MailAttachment` and the driver hands it to the mailer untouched, so a booking
confirmation with an `.ics` goes through the notification, its preferences and
its in-app sibling rather than around them.

**`via` takes the payload rather than closing over it**, so a definition can be
asked what it supports before anything is sent — which is what a preferences
screen and a devtools panel need:

```typescript fragment
paymentReceived.type        // 'PaymentReceived'
paymentReceived.transports  // ['inApp', 'email']
app.notifications           // every type this app declares, by name
```

### Where they are found

Anywhere under the app's root — `createApp({ root: import.meta.url })`
(`FJS-D1080`, `FJS-D1141`), so a notification sits in its domain folder; `node_modules` is skipped. An app with no root loads none, and its definitions then have to
state `type:` themselves.

### Renaming

The type is persisted — it is written into `notifications.type` and read by the
browser to choose a renderer — so renaming the file renames the type, and rows
already written keep the old one. State `type:` to hold it still:

```typescript fragment
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

```typescript fragment
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

// From a Caravan job — jobs/send-invoice.job.ts
export default defineJob({
  handler: async ({ data, app }) => {
    const { userId, invoiceId } = data as { userId: string; invoiceId: string }
    const user    = await db.asSystem().user.findUnique({ where: { id: userId } })
    const invoice = await db.asSystem().invoice.findUnique({ where: { id: invoiceId } })
    await app!.notify(user, invoiceSent(invoice))
  },
})

// From a route handler
app.post('/orders/{id}/complete', async (ctx) => {
  // Route handlers get a TransportContext: ctx.route holds the path captures
  // ({id}) and ctx.user is the caller. There is no ctx.app here — close over
  // the app you created.
  const order = await completeOrder(ctx.route.id)

  // ctx.user is a SessionContext — `userId`, not `id`. A Recipient wants `id`.
  await app.notify({ id: ctx.user.id, email: ctx.user.email }, orderCompleted(order))
  return ctx.json(order)
})

// To somebody with no account — a shop customer, a mailing-list address.
// No `id`: email is the only transport that can address them, and notify()
// enforces that rather than writing a row nobody could read.
await app.notify({ email: customer.email, name: customer.name }, orderConfirmation(order))
```

---

## @frontierjs/auth integration

```typescript fragment
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

// api/src/services/users.service.ts
import welcomeUser from '../notifications/WelcomeUser.notification.ts'

after: {
  create: [
    async (ctx) => {
      // authMethod: 'created' is stamped by @frontierjs/auth createUser()
      if (ctx.user?.authMethod === 'created') {
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

`notify()` formats and validates eagerly, then delivers the in-app record before anything else leaves:

1. Call `notification.via(recipient)` — get the transport list
2. Format each transport's message **once**, awaiting it, and validate before any delivery:
   - No formatter for that transport → `NotificationTransportNotImplementedError`
   - Unregistered custom transport → `NotificationDriverNotFoundError`
   - Recipient not addressable on it → `NotificationRecipientError`
3. `inApp` first — if it fails, nothing else is sent (no mail about a notification that does not exist). Then `Promise.allSettled` across the rest — a failed email does not block the record
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

Persists a record to the `notifications` table via `db.asSystem()` (bypasses gate and policy — create is gated at SYSTEM, 8). Then publishes a WS event on junction's `app.channel()` — the broadcast sense of the word — if the `channels()` plugin is configured.

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

Delegates to `app.mail.send()`. Requires `mail` to be configured before `notifications`. The address resolves as `message.to` (explicit override) → `recipient.email`; missing both is refused before delivery.

The builder's `lines` are rendered to text and HTML here — `MailMessage` is this package's authoring shape, and no mailer understands it. `.html()` / `.text()` override either half, which is how an `@frontierjs/email-kit` template supplies the HTML and the builder still writes the plain-text alternative.

---

## Custom drivers

**`inApp` and `email` are the only transports this package ships.** SMS, push, Slack — every other medium is a driver the APP registers, usually a few lines over a Conduit target, because a connector to a named vendor lives in the app and not in the framework (`FJS-D153`). Nothing in this package names the transport: the key under `transports:` is the name, and a formatter of the same name on the definition is its message. The recipient carries whatever the driver addresses by — a `phone`, a `deviceToken`.

A value under `transports:` with no `send()` is refused when the plugin is constructed, naming the key. `email: { mailer }` is the one plain object accepted, since it selects the built-in path; `sms: { provider: 'twilio' }` would configure nothing and was otherwise found at the first send.

```typescript fragment
// api/src/drivers/SlackDriver.ts
import type { NotificationDriver, Recipient, App } from '@frontierjs/notifications'

export class SlackDriver implements NotificationDriver {
  transport = 'slack'

  constructor(private opts: { webhookUrl: string }) {}

  async send(recipient: Recipient, message: unknown, app: App): Promise<unknown> {
    const res = await fetch(this.opts.webhookUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(message),
    })
    if (!res.ok) throw new Error(`slack answered ${res.status}`)
    return { ts: (await res.json()).ts }
  }

  /** Optional — awaited once on app shutdown. */
  async shutdown(): Promise<void> {}
}

// api/src/app.ts
app.configure(notifications({
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

**What `send()` answers, `notify()` answers back.** `await app.notify(…)` resolves to `{ [transport]: answer }` for every registered driver that answered something — the vendor's message id, which a later delivery receipt names. A refusal throws; a driver that must say whether the send may still have gone out throws an error class of its own, and the caller finds it in `NotificationDeliveryError.failures[].error`. The error also carries `receipts` for the transports that did land. `notify()` writes nothing to stderr on a failure: the error holds every one, so a caller that handles an expected refusal prints nothing.

### Web Push

An app that sends push writes one formatter. The rest is five lines, each an owner's:

1. `fli crypto:keygen vapid --env --subject mailto:ops@acme.test` — the pair, in `.env`.
2. `push: true` in `web/config/sierra.config.js` — `sw.js` shows a push and opens its `url` on a click. A build writes it; `vite dev` has no worker.
3. `push: webPush({ vapid })` under `transports` — below.
4. `examples/PushToggle.mesa` copied into `web/src/components/` and put on a page — the click the permission prompt needs, showing on, off, blocked or not available.
5. `'push'` in a definition's `via`, and a `push:` formatter.

`via` naming `push` with no driver registered throws at `notify()`, so an app whose pair may be absent decides "is push on" in one module that both the driver registration and every such `via` read: `example/api/src/core/push.ts`, where `OrderPaid` is the formatter.

`webPush()` is the one driver this package ships beyond the two built-ins, because the part worth sharing is not the vendor (there is none: a push service is plain HTTPS) but the RFC 8291/8188/8292 cryptography, which fails identically whether right or wrong — the push service answers `201` to a body it cannot read.

```typescript fragment
import { webPush } from '@frontierjs/notifications'

// once: fli crypto:keygen vapid --env --subject mailto:ops@acme.test
app.configure(notifications({
  db,
  transports: {
    push: webPush({
      vapid: {
        publicKey:  process.env.VAPID_PUBLIC_KEY!,
        privateKey: process.env.VAPID_PRIVATE_KEY!,
        subject:    process.env.VAPID_SUBJECT!,
      },
      // devices are the recipient's PushSubscription rows, read off `db`
    }),
  },
}))
```

`fli crypto:keygen vapid` makes the pair with `generateVapidKeys()` from the app's installed copy of this package, and writes the three names. It refuses to replace a pair already in the `.env` without `--rotate`, because every browser subscribed under the old public key stops receiving pushes until it subscribes again.

**The subscription row is the app's; its text is this package's** (`FJS-D1442`). `PushSubscription` ships in `db/notification.lite`, so `fli notifications:install` appends it beside `Notification` and `package-model-drift` grades your copy the same way. Its keys are `@encrypted`, so an app installing this package passes `encryptionKey` to `createClient` whether or not it sends push — a scaffolded app already does. The driver lists a recipient's rows by `userId` through `asSystem()` and soft-deletes one by `endpoint` when its push service answers 404 or 410. An app whose devices live in another table passes `subscriptions: { list(recipient), remove(sub) }` instead.

**A browser subscribes through `push-subscriptions`**, a service the plugin registers at boot when the schema installs `PushSubscription`. `POST` takes `subscription.toJSON()` and upserts by endpoint under the signed-in caller — a retired row is restored, and a browser profile that signs in as somebody else moves its one subscription to them. `GET` lists the caller's own devices without their keys, `GET /push-subscriptions/key` answers `{ publicKey }` from the `webPush()` driver registered under `transports.push`, and `DELETE /push-subscriptions/{id}` retires one. The key is served rather than built into the page, so a rotated pair reaches the next page load with no rebuild (`FJS-D1626`); an app with no `webPush()` driver gets a 404 naming it. The door refuses keys the driver could not encrypt to, an endpoint that is not public HTTPS, and a support operator or an agent over `/mcp`, since a subscription outlives the session that made it. The driver grades the endpoint again before every send. An app already serving that name renames ours with `notifications({ services: { pushSubscriptions: 'devices' } })`, or drops it with `false`.

**The page calls `subscribeToPush` from `@frontierjs/notifications/client`** in a click handler, as `subscribeToPush({ service: getClient().service('push-subscriptions') })`. The page passes the service proxy, not its name, so a renamed door is named once, by the app. It asks permission, then reads the key from `GET /key` unless `vapidPublicKey` was passed, and subscribes with the key as bytes, since Safari refuses a string. If the browser already holds a subscription made under another key, its row is retired and the browser re-subscribes. Then it posts `toJSON()`. `unsubscribeFromPush({ service })` retires the row first and then the browser's subscription. Neither function registers a worker; `push: true` in `sierra.config.js` writes it, and without one both throw rather than wait on `serviceWorker.ready` forever.

A formatter named `push:` answers a `PushMessage` (`types.ts`), built with `push()`; the same message feeds `ntfy()` below, so a definition formats once whichever driver the app registered. `ttl` and `urgency` go only in headers; `topic` goes in both, so a later message with the same topic replaces one still queued at the push service and, through the worker's `tag`, one already on screen. What the formatter answers, what the worker receives and what it shows are `test/fixtures/push-message.json`, which this package's driver test and Sierra's worker test both read. One recipient is every device the store lists, each sent independently: a retired endpoint is removed, any other refusal is thrown after every device was tried. **The driver holds the decrypted keys, so it cannot keep `@guarded` columns out of a payload — the `push:` formatter is where the payload is built and the only place that can.** A body over ~3.9 KB is refused; send an id and let the service worker fetch the rest.

**A recipient with a tab of the app on screen gets no push** (`FJS-D1627`): the page has just shown the in-app notification. The junction browser client reports `document.visibilityState` on its socket at every connect and on each `visibilitychange`, and the driver asks `app.channels.hasVisibleConnection(id)` before listing devices. A socket that never reports, and an app without `channels()`, count as hidden, so the push goes.

A message that must buzz anyway -- a new sign-in, not an order the page just showed -- says so with `push().always()`. The check is one process's: `channels` holds only the sockets this instance accepted, so on a multi-instance deploy a user whose tab is connected to another node reads hidden and is pushed to as well.


### ntfy

`ntfy()` is the other `push` driver — a phone one HTTP request away. ntfy (`ntfy.sh`, or your own from the Basecamp `ntfy` blueprint) is topic pub/sub with a phone app: the app subscribes to a NAME, and publishing is an authenticated POST with the text as the body and the metadata as headers. No service worker, no device rows, and a 4xx is a 4xx.

```typescript fragment
import { ntfy, push } from '@frontierjs/notifications'

app.configure(notifications({
  db,
  transports: {
    push: ntfy({ url: process.env.NTFY_BASE_URL, token: process.env.NTFY_TOKEN }),
  },
}))

// the formatter
push: (monitor) => push()
  .title('Monitor down')
  .body(`${monitor.host} stopped answering`)
  .priority(5)                       // rings through do-not-disturb; a resend is 4
  .tags('rotating_light')
  .url(`https://hub.acme.test/monitors/${monitor.id}`)
  .build()
```

**The topic is the recipient's address**, `recipient.pushTopic`, and a recipient without one is refused by name: on a public server a guessable name is readable by anyone, so an app mints `<slug>-critical-<random>` once and shows it as a subscribe link. `title`, `body`, `priority`, `tags`, `url` (sent as `Click`) and `actions` go on the wire; `data`, `ttl`, `urgency` and `topic` are web push's and are dropped. ntfy's own limits are applied rather than refused: a body is cut to 4095 bytes with an ellipsis, since 4096 makes it a file attachment, and only the first three actions are sent. A payload carries titles and links, never a secret — the `push:` formatter is where `@guarded` columns stay out, for both drivers.

---

## Sierra resource

The UI half is a resource file whose data half is `<script module>`, per Invariant 18 — `web/src/resources/Notification.mesa`. `examples/Notification.mesa` is the one this package ships to copy:

- `notifications` — `createResource('notifications', { model: 'Notification' })`; `.tethered({ state: 'local' })` is the live list, `.service` the client
- `isUnread(n)` — what the bell counts and the list styles
- `markRead(id)` — `notifications.mutate(id, { readAt }, run)`, `run` being `service.patch(id, { readAt })`. **A write goes through `mutate`, never `service` alone**: the tether moves only on pushed frames and a patch pushes none to a per-person channel, so a bare service call leaves the row unread in every list that holds it and the bell's count holds until a reload.

Real-time needs no code, given two things on the server: the `channels()` plugin, and a connection joined to `notifications:user:<id>`. The inApp driver pushes `notifications created` there, and the client routes a frame to a tether only as `<service> <verb>` — which is why the app mounts the list as the `notifications` service.

---

## Querying

Standard Junction service — policy scopes all queries to the current user automatically:

```
GET  /notifications               — all for current user
GET  /notifications?readAt=null   — unread only
GET  /notifications?subjectType=Order&subjectId=123
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

- Notification preferences model — per-recipient transport preferences in the DB
- Digest mode — batch into scheduled email digest
- Bulk mark-as-read endpoint
- Read receipts via WS — mark read when notification panel opened
- Soft delete / archive
