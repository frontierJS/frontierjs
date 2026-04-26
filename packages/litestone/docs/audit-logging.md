# Audit Logging

Litestone provides field-level and model-level audit logging via the `logger` database driver. Every write produces a structured log entry with before/after snapshots, actor attribution, and optional custom metadata.

## Setup

Declare a logger database in your schema:

```prisma
database audit {
  path      "./audit/"
  driver    logger
  retention 90d          // prune entries older than 90 days on startup
}
```

## Model-level logging — @@log

Log every write (create, update, delete) on a model:

```prisma
model User {
  id    Integer @id
  email Text
  name  Text?
  @@log(audit)
}
```

Every `create`, `update`, and `delete` on `users` produces an entry in the audit logger database.

## Field-level logging — @log

Log reads and writes of a specific sensitive field:

```prisma
model User {
  salary Real?   @log(audit)
  apiKey Text?   @secret    // @secret implies @log(audit) automatically
}
```

## Log entry shape

```js
{
  operation:  'update',             // create | update | delete | read
  model:      'users',
  field:      'salary',             // only for @log field-level entries
  records:    [1],                  // array of affected IDs
  before:     { salary: 50000 },    // single-row writes only
  after:      { salary: 75000 },
  actorId:    'user_abc',
  actorType:  'user',
  meta:       { requestId: 'req_xyz' },
  createdAt:  '2024-01-15T10:30:00.000Z',
}
```

`before`/`after` snapshots are only included for single-row `update()` calls — not `updateMany()`.

## onLog — enrich log entries

The `onLog` callback on `createClient` adds actor attribution and custom metadata:

```js
const db = await createClient({
  path:  './schema.lite',
  onLog: (entry, ctx) => ({
    actorId:   ctx.auth?.id,
    actorType: ctx.auth?.type ?? 'system',
    meta: {
      requestId: ctx.requestId,
      ip:        ctx.ip,
    },
  }),
})
```

The return value is merged into the log entry. Fires asynchronously via `setImmediate` — never blocks the calling operation.

## Querying logs

Log entries are queryable through the standard ORM API:

```js
// All writes to users table
const writes = await db.auditLog.findMany({
  where:   { model: 'users' },
  orderBy: { createdAt: 'desc' },
  limit:   50,
})

// Writes by a specific actor
const actorWrites = await db.auditLog.findMany({
  where: { actorId: 'user_abc', operation: { in: ['create', 'update', 'delete'] } }
})

// All changes to a specific record
const history = await db.auditLog.findMany({
  where: {
    model:   'users',
    records: { $raw: sql`json_extract(records, '$[0]') = ${userId}` }
  }
})
```

The auto-generated model name for a logger database is `<dbName>Logs` — `audit` → `auditLogs`.

## @secret — encrypted + guarded + logged

`@secret` is a composite that bundles all three security attributes:

```prisma
model User {
  apiKey Text? @secret                 // @encrypted + @guarded(all) + @log(audit)
  token  Text? @secret(rotate: false)  // same, but excluded from $rotateKey
}
```

Every access to `@secret` fields (reads via `asSystem()` and all writes) is automatically logged.

## Retention

The `retention` value on a logger database prunes old entries on startup:

```prisma
database audit {
  path      "./audit/"
  driver    logger
  retention 90d    // prune entries older than 90 days
}
```

Also applies to JSONL databases. Accepts: `30d`, `24h`, `2w`, `1y`.
