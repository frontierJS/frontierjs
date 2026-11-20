# Logging queries

`onQuery` is called with an event for every verb the client runs: the model, the operation, the SQL, its bound parameters, how long SQLite took and how many rows came back.

```lite
model User {
  id     Int    @id
  email  String @unique
  status String @default("active")
}
```

```js
const events = []
const db = await createClient({ path: './schema.lite', db: ':memory:', onQuery: e => events.push(e) })

await db.user.findMany({ where: { status: 'active' }, limit: 20 })

const e = events[0]
if (e.model !== 'user' || e.operation !== 'findMany') throw new Error(`unexpected event ${e.model} ${e.operation}`)
if (!e.sql.includes('"status" = ?') || e.params[0] !== 'active') throw new Error('expected a bound status parameter')
if (typeof e.duration !== 'number') throw new Error('expected a duration')
```

A throw inside the listener is swallowed, so a failing logger never fails the read it watches.

## What else it can do

- The event also carries `database`, `actorId`, `system`, `args` and `rowCount`
- `system` is true under `asSystem()`, which `actorId` alone cannot say
- `db.$tapQuery(fn)` adds a listener to a running client and returns the function that removes it
- A listener can be `async`, and is never awaited by the caller
- `duration` is the SQLite call only, not network or serialization
- Slow-query detection, telemetry and per-actor audit are each a few lines
- Statements around a verb, such as the `@sequence` counter or the trail's writes, do not fire it
- `select: false` still reads the row on a model with `@@trail`, and the event says so

**In depth:** [onQuery § Setup](../../onquery-logging.md#setup), [§ Event shape](../../onquery-logging.md#event-shape), [§ Common patterns](../../onquery-logging.md#common-patterns), [§ $tapQuery](../../onquery-logging.md#tapquery--listeners-added-at-runtime)
