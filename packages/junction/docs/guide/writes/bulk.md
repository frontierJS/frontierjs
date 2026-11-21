# Bulk operations

`patch` and `remove` without an `id` are refused unless the service sets `allowBulk: true`, a guard against a request that changes a whole table by accident. A bulk write needs a filter and runs one row at a time.

```ts
import { createClient } from '@frontierjs/litestone'
import { request } from '@frontierjs/junction/testing'

const db  = await createClient({ db: ':memory:', schema: 'model Log { id Int @id @default(autoincrement())  status String }' })
const app = createApp({ db })
app.services.register(createService({ name: 'logs', allowBulk: true, bulkMax: 1000 }))

for (const status of ['open', 'archived', 'archived']) await db.asSystem().log.create({ data: { status } })

const removed = await request(app).delete('/logs?status=archived')
const left = await db.asSystem().log.findMany({})
if (removed.status !== 200 || left.length !== 1 || left[0].status !== 'open') throw new Error(`expected only the open row left, got ${removed.status} ${JSON.stringify(left)}`)

const everything = await request(app).delete('/logs')
if (everything.status < 400) throw new Error('a bulk write with no filter must be refused')
```

## What else it can do

- A bulk answer is the list envelope: the rows written in `data`, one `{ data, error }` pair per row that failed in `errors`
- `bulkMax` (default 1000) refuses an over-large filter or array create with a 400 before the first write
- An array `POST` creates many rows in one transaction, with a savepoint per row, so a failed row rolls back alone
- Only rows the caller can read are touched, and the update or delete policy grades each write
- Each row goes through `update()`, so `@@transitions` and `@version` apply as they do by id
- A caller-supplied `@version` is refused, since one value cannot be right for many rows
- `transactional: true` makes a bulk write all-or-nothing

**In depth:** [README § Bulk operations](../../../README.md#bulk-operations)
