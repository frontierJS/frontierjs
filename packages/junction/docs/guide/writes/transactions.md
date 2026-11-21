# Transactions

`transactional: true` wraps a service call, hooks included, in one database transaction, so a call that fails anywhere leaves no row behind.

```ts
import { createClient } from '@frontierjs/litestone'

const db  = await createClient({ db: ':memory:', schema: 'model Order { id Int @id @default(autoincrement())  item String }' })
const app = createApp({ db })

app.services.register(createService({
  name: 'orders',
  transactional: true,
  hooks: {
    after: { create: [ctx => { if (ctx.data.item === 'bad') throw new Error('refused after the write') }] },
  },
}))

const orders = app.service('orders')
await orders.create({ item: 'pen' })
await orders.create({ item: 'bad' }).catch(() => {})

const rows = await db.asSystem().order.findMany({})
if (rows.length !== 1 || rows[0].item !== 'pen') throw new Error(`expected only the pen, got ${JSON.stringify(rows)}`)
```

## What else it can do

- `transactional: ['create', 'patch']` limits it to the methods named
- A service that calls another is one transaction: the write is done when the outermost one commits
- `db.$transaction(async tx => ...)` is the escape hatch for work that spans services
- A write made through `tx` skips the service hooks and the service cache, and the data gate and row policies still apply
- `ctx.afterCommit()` and `ctx.enqueue()` run once the transaction has committed

**In depth:** [README § Transactions](../../../README.md#transactions)
