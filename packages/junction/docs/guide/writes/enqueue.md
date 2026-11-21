# Effects that must not be lost

`ctx.afterCommit()` fixes the order but not a crash: the process can die between the commit and the callback. `ctx.enqueue(job, payload)` writes the intent into your own database inside the call's transaction, so it commits with the write or rolls back with it, and a relay hands it to the job queue afterwards.

```ts
import { createClient } from '@frontierjs/litestone'
import { caravan } from '@frontierjs/caravan'
import { outbox, outboxSchemaFragment } from '@frontierjs/junction/outbox'

// An app imports db/outbox.lite with `fli outbox:install`; the fragment is the same text
const schema = `
database main { path "./app.db" }
model Order { id Int @id @default(autoincrement())  item String  @@gate(0)  @@db(main) }
${outboxSchemaFragment()}
`
const db  = await createClient({ databases: ':memory:', schema })
const app = createApp({ db })

app.configure(caravan())
app.configure(outbox())

app.services.register(createService({
  name: 'orders',
  transactional: ['create'],
  async create(ctx) {
    const order = await $.db.order.create({ data: ctx.data })
    await ctx.enqueue('order-shipped', { orderId: order.id })
    if (ctx.data.item === 'bad') throw new Error('refused after the enqueue')
    return order
  },
}))

const orders = app.service('orders')
await orders.create({ item: 'pen' })
await orders.create({ item: 'bad' }).catch(() => {})

const owed = await db.asSystem().outboxMessage.findMany({})
if (owed.length !== 1 || owed[0].job !== 'order-shipped') throw new Error(`expected one row owed, got ${JSON.stringify(owed)}`)
```

## What else it can do

- `fli outbox:install` imports the `OutboxMessage` model into `db/schema.lite`
- A row commits with the write and rolls back with it, so a failed call owes nothing
- It refuses outside a transaction, on a schema with no `OutboxMessage`, and with no relay configured
- Delivery is at-least-once, so write the job handlers to be idempotent
- A job or receiver has no call and writes with `app.outbox.enqueueOn(tx, job, payload)`
- `outbox({ intervalMs, batch, claimTimeoutMs, retentionMs })` tunes the relay, and `GET /metrics` reports `outbox`
- Jobs themselves are the [Caravan](../plugins/caravan.md) page

**In depth:** [README § `ctx.enqueue()` — the effect that must not be lost](../../../README.md#ctxenqueue--the-effect-that-must-not-be-lost)
