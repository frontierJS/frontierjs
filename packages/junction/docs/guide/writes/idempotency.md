# Idempotency keys

A mutating request carrying an `Idempotency-Key` header executes once. A repeat replays the first answer without running the pipeline again, so a double-submitted form creates one row.

```ts
import { createTestApp, request } from '@frontierjs/junction/testing'

const app = await createTestApp({ users: [{ id: 'u1' }] })

let created = 0
app.services.register(createService({
  name: 'orders',
  async create(ctx) { created++; return { id: created, ...ctx.data } },
}))

const send = () => request(app).post('/orders')
  .auth(app.tokenFor('u1'))
  .set('idempotency-key', '8f3c-first-submit')
  .send({ item: 'pen' })

const first  = await send()
const repeat = await send()

if (created !== 1) throw new Error(`the method ran ${created} times`)
if (first.status !== 201 || JSON.stringify(repeat.body) !== JSON.stringify(first.body)) throw new Error('the repeat did not replay the first answer')
```

## What else it can do

- A key is scoped to the service, the method and the principal, so two callers never share an answer
- A caller with no principal has nothing to scope by, so its key is ignored
- Reads are never replayed
- A failed call releases its key, so the caller may retry
- A duplicate that arrives while the first is still running is a `409` with `retryable: true`
- `config.idempotency` takes `enabled` (default on), `ttl` (how long a finished key is kept) and `pendingTtl` (how long the in-flight marker lives)
- The store is the app cache, so it is per process; nothing is stored unless a caller sends a key

**In depth:** [README § Idempotency-Key](../../../README.md#idempotency-key)
