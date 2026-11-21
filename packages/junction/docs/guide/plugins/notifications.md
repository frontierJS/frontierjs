# Notifications

`@frontierjs/notifications` sends one notification over several transports, chosen per recipient: a row for the in-app bell, an email, a push. A notification is a definition, and `app.notify(user, definition(payload))` delivers it.

```ts
import { createClient } from '@frontierjs/litestone'
import { channels } from '@frontierjs/junction'
import { notifications, defineNotification, inApp } from '@frontierjs/notifications'

const schema = `
model Notification {
  id          Int       @id
  userId      String
  type        String
  data        Json
  subjectType String?
  subjectId   String?
  deliveryKey String?
  readAt      DateTime?
  createdAt   DateTime  @default(now())
  @@gate(0.8.4.8)
}`
const db = await createClient({ db: ':memory:', schema })

app.configure(channels())
app.configure(notifications({ db }))
await app._startForTest()

// In a file this is `PaymentReceived.notification.ts`, and the file name is the type
const paymentReceived = defineNotification<{ amount: number }>({
  type:  'PaymentReceived',
  via:   () => ['inApp'],
  inApp: (payment) => inApp().title('Payment received').body(`$${payment.amount} has been received.`),
})

await app.notify({ id: 'u1' }, paymentReceived({ amount: 42 }))

const rows = await db.asSystem().notification.findMany({})
if (rows.length !== 1 || rows[0].type !== 'PaymentReceived') throw new Error(`expected one row, got ${JSON.stringify(rows)}`)
if (rows[0].userId !== 'u1' || rows[0].readAt !== null) throw new Error('row is not an unread one for u1')
```

## What else it can do

- `fli notifications:install` adds the `Notification` model to your schema, and the model is yours to extend
- A definition in `notifications/PaymentReceived.notification.ts` loads on its own, named for its file
- `via(payload, recipient)` picks the transports for this payment and this recipient
- `email: (payload) => mail().subject(…).line(…).action(…)` builds the email, and `.attach()` carries a file
- Configure `mail()` before `notifications()` when the email transport is used
- `key: (payload) => …` keeps a retried send from writing a second in-app row
- `app.notify({ email, name })` reaches somebody with no account, by email alone
- Send from a hook, a job or a route, and read the declared types from `app.notifications`
- The in-app transport also publishes on a `notifications:user:<id>` channel, so the bell updates live
- Web Push and ntfy are drivers, and a Sierra resource draws the bell and the list

**In depth:** [Notifications README § Writing a notification](../../../../notifications/README.md#writing-a-notification)
