# Webhooks

`webhooks()` turns the events your services already fire into signed HTTP deliveries to subscribers, retried with backoff until they answer. A subscriber registers a URL and the events it wants, and the registration returns the secret that signs every delivery.

```ts
import { Database } from 'bun:sqlite'
import { webhooks, createSqliteWebhookStore } from '@frontierjs/junction/webhooks'

// The subscriber: a receiver on any free port
const received: { headers: Headers, body: any }[] = []
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    received.push({ headers: req.headers, body: JSON.parse(await req.text()) })
    return new Response('ok')
  },
})

// A destination is graded at registration, so a receiver on this machine needs the guard opened
app.configure(webhooks({
  events: ['orders:created'],
  store:   createSqliteWebhookStore(new Database(':memory:')),
  targets: { allowHttp: true, allowPrivate: true },
}))
await app._startForTest()

const hook = await app.webhooks.register(`http://localhost:${receiver.port}/hooks/orders`, ['orders:created'])
if (!hook.secret) throw new Error('expected a signing secret')

await app.webhooks.deliver('orders:created', { id: 'ord_1', total: 4200 })

receiver.stop(true)
if (received.length !== 1) throw new Error(`expected one delivery, got ${received.length}`)
if (received[0].body.event !== 'orders:created') throw new Error('wrong event')
if (received[0].body.data.id !== 'ord_1') throw new Error('wrong payload')
if (!received[0].headers.get('x-webhook-signature')) throw new Error('delivery was not signed')
```

## What else it can do

- A service mutation that fires `orders:created` fans out on its own, and `events: ['*']` catches everything
- A failed delivery retries at 1m, 5m, 30m, 2h, 8h and 24h, then is marked `dead` and kept
- A receiver outside FrontierJS verifies with `verifyRequest({ prefix: 'X-Webhook' })` from `@frontierjs/toolbelt/signature`
- The body is `{ id, event, timestamp, data }` and `id` is stable across retries, so deduplicate on it
- `receive` in the config mounts a route that verifies a far app's deliveries, and `app.webhooks.subscribe({ to })` mints its secret
- `app.webhooks.retry(id)`, `list()`, `deliveries(hookId)`, `subscriptions()` and `unsubscribe(id)` manage them in code
- `/webhooks` and `/webhook-deliveries` routes register, list, test and retry for a caller at gate level `manage`
- The REPL has a `webhooks` command for the same
- `store` is required: `createSqliteWebhookStore(db)`, or an `IWebhookStore` of your own

**In depth:** [README § Webhooks](../../../README.md#webhooks)
