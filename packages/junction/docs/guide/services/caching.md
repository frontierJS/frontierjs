# Service caching

`cache: true` keeps the answers of a service's `find` and `get`, and a write to the service clears them.

```ts
import { createClient } from '@frontierjs/litestone'

const db  = await createClient({ db: ':memory:', schema: 'model Product { id Int @id  name String }' })
const app = createApp({ db })
app.services.register(createService({ name: 'products', cache: true }))

const products = app.service('products')
await products.create({ name: 'Pen' })
const first = await products.find({})
await db.asSystem().product.create({ data: { name: 'Ink' } })
const stale = await products.find({})
if (stale.data.length !== first.data.length) throw new Error('the second find missed the cache')

await products.create({ name: 'Pad' })
const fresh = await products.find({})
if (fresh.data.length !== 3) throw new Error('a write did not clear the cache')
```

## What else it can do

- `cache: true` keeps an entry for 30 seconds; `cache: { ttl: '5 minutes' }` sets another
- `cache: { keyBy: ctx => ... }` replaces the key
- A key includes the caller's id, so one user never reads another's answer, and public calls share one entry per query
- The store belongs to the app, and `app.own('serviceCache', createSqliteCache({ path }))` keeps it across restarts

**In depth:** [README § Service caching](../../../README.md#service-caching)
