# onQuery — Production Query Logging

`onQuery` sees every SQL statement Litestone executes. Use it for slow-query detection, telemetry, per-actor audit trails, and debugging.

The examples on this page use this schema:

```lite
database audit {
  path   "./audit.db"
  driver trail
}

model User {
  id     Int    @id
  email  String @unique
  status String @default("active")

  @@gate(0)
}

model Order {
  id    Int   @id
  total Float
  @@trail(audit)

  @@gate(0)
}
```

## Setup

```js
import { appendFileSync } from 'node:fs'

const db = await createClient({
  path:    './schema.lite',
  db:      ':memory:',
  onQuery: (event) => {
    appendFileSync('./query.log', JSON.stringify(event) + '\n')
  }
})
```

## Event shape

```js
const events = []
const db = await createClient({
  path:    './schema.lite',
  db:      ':memory:',
  onQuery: e => events.push(e),
})

await db.user.findMany({ where: { status: 'active' }, limit: 20 })

console.log(events[0])
// {
//   model:     'user',             // the accessor, as in db.user
//   database:  'main',             // which database block
//   actorId:   null,               // ctx.auth?.id when scoped via $setAuth
//   system:    false,              // true under asSystem()
//   operation: 'findMany',         // every ORM verb, plus 'sql' for db.sql
//   args:      { where: { status: 'active' }, limit: 20 },
//   sql:       'SELECT * FROM "user" WHERE "status" = ? LIMIT 20',
//   params:    ['active'],
//   duration:  0.3,                // milliseconds — the SQLite call only
//   rowCount:  0,
// }
```

`duration` measures only the SQLite execution time, not network or serialization overhead. `system` is there because `actorId` cannot say it: a bare client and `asSystem()` both report `null`, and only the second returns `@guarded` and `@encrypted` values.

A listener is an observer: a throw inside it is swallowed and a rejected promise is ignored, so a failing logger never fails the read it is watching.

## Common patterns

```js fragment
// Slow query detection
onQuery: (e) => {
  if (e.duration > 100) logger.warn('slow query', { sql: e.sql, duration: e.duration })
}

// Async telemetry — never blocks the caller
onQuery: async (e) => {
  await telemetry.track('db.query', { model: e.model, duration: e.duration })
}

// Per-actor audit
onQuery: (e) => {
  if (e.actorId) auditLog.append({ ...e, ts: Date.now() })
}

// Structured logging
onQuery: (e) => {
  logger.debug({
    msg:   'query',
    model: e.model,
    op:    e.operation,
    ms:    e.duration.toFixed(2),
    rows:  e.rowCount,
    actor: e.actorId ?? (e.system ? 'system' : 'anonymous'),
  })
}
```

## $tapQuery — listeners added at runtime

`onQuery` is fixed at `createClient`. `db.$tapQuery(fn)` adds a listener to a running client and returns the function that removes it; the listener receives the same events as `onQuery` until then.

```js
const log = []
const stop = db.$tapQuery(e => log.push(e))

await db.user.findMany()
await db.order.create({ data: { total: 9.5 } })

stop()
console.log(log.map(e => e.operation))   // ['findMany', 'create'] — nothing after stop()
```

Useful in tests to assert specific SQL was executed:

```js
import assert from 'node:assert/strict'

const queries = []
const stop = db.$tapQuery(e => queries.push(e))
await db.user.findMany({ where: { email: 'alice@example.com' } })
stop()
assert.ok(queries[0].sql.includes('WHERE "email"'))
```

## select: false and logging

`select: false` skips `RETURNING *`, and the write returns `null`. On a `@@trail` model the before/after images need the row, so the `RETURNING` still runs there; the result is still `null`.

```js
const sqls = []
const stop = db.$tapQuery(e => sqls.push(e.sql))

const plain   = await db.user.create({ data: { email: 'a@example.com' }, select: false })
const trailed = await db.order.create({ data: { total: 1 }, select: false })
stop()

console.log(plain, trailed)                     // null null
console.log(sqls[0].includes('RETURNING'))      // false
console.log(sqls[1].includes('RETURNING'))      // true — the trail needs the row
```
