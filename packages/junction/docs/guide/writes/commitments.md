# Commitments

A schema says what the system owes a row and when, such as `@@commitment(abandon, on: createdAt + 14d)`. Litestone answers which rows are due but moves none of them; the `commitments()` plugin is the clock that makes the move.

```ts
import { createClient } from '@frontierjs/litestone'
import { caravan } from '@frontierjs/caravan'
import { commitments, fireDue } from '@frontierjs/junction/commitments'

const schema = `
database main { path "./app.db" }
enum OrderStatus { pending paid cancelled }
model Order {
  id        Int         @id @default(autoincrement())
  status    OrderStatus @default(pending)
  createdAt DateTime    @default(now())
  @@transitions(status,
    pay:     pending -> paid,
    abandon: pending -> cancelled @system)
  @@commitment(abandon, on: createdAt + 14d)
  @@db(main)
}
`
let now = Date.parse('2026-01-01T00:00:00.000Z')
const db  = await createClient({ databases: ':memory:', schema, now: () => new Date(now) })
const app = createApp({ db })

app.configure(caravan())       // the sweep is a Caravan cron; a test fires by hand instead
app.configure(commitments())
await app._startForTest()

const order = await db.order.create({ data: {} })
const early = await fireDue(app)
if (early.fired !== 0) throw new Error('nothing is due on day one')

now += 14 * 86_400_000
const late = await fireDue(app)
const after = await db.asSystem().order.findUnique({ where: { id: order.id } })
if (late.fired !== 1 || after.status !== 'cancelled') throw new Error(`expected the abandon move, got ${JSON.stringify(late)} ${after.status}`)
```

## What else it can do

- One cron (`commitment-sweep`, every minute) covers every declaration and dispatches a `commitment-fire` per due row
- The fire asks again before it moves, so a row that moved or was edited since the sweep is `lapsed`
- A commitment moves the declaring row, or the one a to-one relation reaches
- The move is made as the app's `system`, which unlocks an `@system` transition and nothing else
- `*.commitments.ts` under the app root default-exports `{ 'Model.commitment': defineCommitment({ after }) }`, and its hooks run in the move's transaction
- A hook has `afterCommit(fn)` and the durable `enqueue(job, payload)` beside the move
- `commitments({ cron, lookaheadMs, queue, timeZone, hooks })` tunes the clock, and `GET /metrics` reports `commitments`
- A schema with `@@commitment` and no `commitments()` is refused by a process that keeps time
- `fireDue(app)` fires everything due by the client's clock now, with no queue, for a test

**In depth:** [README § `commitments()` — the clock under `@@commitment`](../../../README.md#commitments--the-clock-under-commitment)
