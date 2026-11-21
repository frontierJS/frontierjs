# Effects after the commit

`after` means after the method, not after the call, so an `after` hook that sends an email can run and then a later step fails the call. `ctx.afterCommit(fn)` queues an effect that runs only once the whole call has succeeded and, under `transactional:`, committed.

```ts
import { createClient } from '@frontierjs/litestone'

const db  = await createClient({ db: ':memory:', schema: 'model Order { id Int @id @default(autoincrement())  item String }' })
const app = createApp({ db })
const sent: string[] = []

app.services.register(createService({
  name: 'orders',
  transactional: true,
  hooks: {
    after: {
      create: [
        ctx => { ctx.afterCommit(() => { sent.push(ctx.data.item) }) },
        ctx => { if (ctx.data.item === 'bad') throw new Error('refused after the write') },
      ],
    },
  },
}))

const orders = app.service('orders')
await orders.create({ item: 'pen' })
await orders.create({ item: 'bad' }).catch(() => {})

if (sent.join() !== 'pen') throw new Error(`expected only the pen to be sent, got ${sent.join()}`)
```

## What else it can do

- Queue from any phase: callbacks run once, in the order queued, after the announcement
- An async callback is awaited before the call returns
- A throw in a callback is logged and does not fail the call; the remaining callbacks still run
- A failed call runs nothing, even where the write committed because the service is not `transactional:`
- It is not durable: a crash before the callback loses the effect, and [`ctx.enqueue()`](enqueue.md) survives that

**In depth:** [README § `ctx.afterCommit()` — the effect that must not run early](../../../README.md#ctxaftercommit--the-effect-that-must-not-run-early)
