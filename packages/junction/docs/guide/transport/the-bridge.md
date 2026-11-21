# The bridge

The bridge is where a request becomes a service call and a result becomes a response. Nothing above it touches `req` or `res`, and nothing below it knows what HTTP is, so one service answers HTTP, the socket and an in-process call the same way.

```ts
import { request } from '@frontierjs/junction/testing'

const seen: unknown[] = []

app.services.register(createService({
  name: 'notes',
  async find(ctx) {
    seen.push(ctx.query, ctx.directives.limit)
    return [{ id: 1, title: 'Hello' }]
  },
}))

const wire = await request(app).get('/notes').query({ status: 'open', $limit: '5' })
const body = wire.body as { data: { title: string }[] }
if (wire.status !== 200 || body.data[0].title !== 'Hello') throw new Error('the request did not reach the service')
if (JSON.stringify(seen[0]) !== '{"status":"open"}') throw new Error('the filters hold more than filters')
if (seen[1] !== 5) throw new Error('$limit did not become a directive')

const inProcess = await app.service('notes').find({ status: 'open' }, { directives: { limit: 5 } })
if (inProcess.data[0].title !== 'Hello') throw new Error('the in-process call answered differently')
```

## What else it can do

- `ctx.query` is the filters and `ctx.directives` is `{ limit, offset, orderBy, select }`; a `$limit` on the wire lands in the second
- A `$`-prefixed key the bridge does not know is refused by name
- The result is wrapped in the `{ data }` envelope on the way out, and unwrapped for an in-process caller
- A thrown error becomes its status in one place, so a service throws and never builds a response
- Path captures reach a hook as `ctx.route`, and a raw route reads them there too
- A filter value `{ $auth: 'employeeId' }` stands for that claim on the caller, so a screen asks for "not mine" without its own id
- `requestMeta()` reads request-wide values such as the correlation id at any call depth
- `app.runAs(userId, fn)` opens a call as somebody for work that outlives the request

**In depth:** [README § 1. The transport bridge](../../../README.md#1-the-transport-bridge--transportbridgets)
