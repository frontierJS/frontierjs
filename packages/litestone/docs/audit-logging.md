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
  id    Int @id
  email String
  name  String?
  @@log(audit)
}
```

Every `create`, `update`, and `delete` on `users` produces an entry in the audit logger database.

## Field-level logging — @log

Log reads and writes of a specific sensitive field:

```prisma
model User {
  salary Float?   @log(audit)
  apiKey String?   @secret    // @secret implies @log(audit) automatically
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

`before`/`after` snapshots are only included for single-row writes — `update()`, `delete()` and `remove()`. A bulk write records **which** rows it touched and **what** it did to them, never their contents:

```js
// db.widget.updateMany({ where: { state: 'draft' }, data: { state: 'live' } })
{ operation: 'update', model: 'widget', records: [1, 2, 3], before: null, after: null, ... }
```

Every write path reaches the trail: `create`, `createMany`, `update`, `updateMany`, `upsert`, `upsertMany`, `remove`, `removeMany`, `delete`, `deleteMany` and `restore`. A bulk op on a logged model takes a `RETURNING` path so the entry can name the rows by id — an autoincrement id does not exist until SQLite assigns one — and `upsertMany` splits its batch into a `create` entry and an `update` entry, because it did both. `restore` logs as `update`: a restored row changed state, it was not created.

An unlogged model pays none of this — the `RETURNING` path is taken only when the model declares `@log` / `@@log`.

## Protected fields are redacted

The audit trail records **that** a protected field was written — by whom, to which rows, when — never what it holds. Any field carrying `@encrypted`, `@guarded`, or `@secret` (which implies both) has its value replaced with `'[redacted]'` in every log entry, in both the field-level entry and the model-level `before`/`after` snapshot:

```prisma
model Vault {
  id      Int     @id
  name    String
  apiKey  String? @secret
  @@log(audit)
}
```

```js
{ operation: 'update', model: 'vault', field: 'apiKey',
  records: [7], before: '[redacted]', after: '[redacted]', actorId: 'user_abc', ... }

// model-level snapshot — name is logged, apiKey is not
{ operation: 'update', model: 'vault', field: null, records: [7],
  before: { id: 7, name: 'prod', apiKey: '[redacted]' },
  after:  { id: 7, name: 'prod', apiKey: '[redacted]' }, ... }
```

This is what makes `@secret`'s expansion safe. `@secret` is `@encrypted + @guarded(all) + @log(<first logger db>)`, so **declaring a logger database is on its own enough to start logging every `@secret` field in the schema** — without redaction that would write plaintext to a file sitting next to a correctly-encrypted database row, with none of the column's read protections.

Two details worth knowing:

- **`null` is preserved, not redacted.** It holds nothing to leak, and keeping it means a `null → value` transition stays visible: `before: null, after: '[redacted]'` tells you a secret was set without telling you what it is.
- **Unprotected fields on the same model are logged in full.** Redaction is per-field, not per-model, so the trail stays useful.

The value returned to the caller is never affected — redaction happens on the way to the log, on a copy.

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
const writes = await db.auditLogs.findMany({
  where:   { model: 'users' },
  orderBy: { createdAt: 'desc' },
  limit:   50,
})

// Writes by a specific actor
const actorWrites = await db.auditLogs.findMany({
  where: { actorId: 'user_abc', operation: { in: ['create', 'update', 'delete'] } }
})

// All changes to a specific record
const history = await db.auditLogs.findMany({
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
  apiKey String? @secret                 // @encrypted + @guarded(all) + @log(audit)
  token  String? @secret(rotate: false)  // same, but excluded from $rotateKey
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
