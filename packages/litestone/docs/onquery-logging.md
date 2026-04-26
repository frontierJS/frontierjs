# onQuery — Production Query Logging

`onQuery` gives you visibility into every SQL query Litestone executes. Use it for slow query detection, telemetry, per-actor audit trails, and debugging.

## Setup

```js
const db = await createClient({
  path:    './schema.lite',
  onQuery: (event) => {
    appendFileSync('./query.log', JSON.stringify(event) + '\n')
  }
})
```

## Event shape

```js
{
  model:     'users',
  operation: 'findMany',         // all ORM operations
  database:  'main',             // which database block
  actorId:   'user_abc',         // ctx.auth?.id (if scoped via $setAuth)
  sql:       'SELECT * FROM "users" WHERE "status" = ? LIMIT ?',
  params:    ['active', 20],
  duration:  1.4,                // milliseconds — SQLite call only, not total request
  rowCount:  17,
  args:      { where: { status: 'active' }, limit: 20 },
}
```

`duration` measures only the SQLite execution time, not network or serialization overhead.

## Common patterns

```js
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
    msg:       'query',
    model:     e.model,
    op:        e.operation,
    ms:        e.duration.toFixed(2),
    rows:      e.rowCount,
    actor:     e.actorId ?? 'system',
  })
}
```

## $tapQuery — temporary captures

One-shot listener for tests or debugging — auto-removes itself:

```js
const log = []
const stop = db.$tapQuery(e => log.push(e))

await db.user.findMany()
await db.order.create({ data: {...} })

stop()
console.log(log)   // all queries that fired between tap and stop
```

Useful in tests to assert specific SQL was executed:

```js
test('uses index', async () => {
  const queries = []
  const stop = db.$tapQuery(e => queries.push(e))
  await db.user.findMany({ where: { email: 'alice@example.com' } })
  stop()
  expect(queries[0].sql).toContain('WHERE "email"')
})
```

## Query listeners

For persistent per-client listeners beyond `onQuery`:

```js
const unsubscribe = db.$onQuery((e) => {
  metrics.increment('db.queries', { model: e.model })
})

// Later
unsubscribe()
```

## select: false and logging

`select: false` skips `RETURNING *` for performance. On `@@log` models, however, the row snapshot is required for the before/after audit entry — `select: false` is silently ignored on those models and the full RETURNING path runs.
