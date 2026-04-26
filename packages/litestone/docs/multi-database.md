# Multi-Database

A single Litestone schema can route models to multiple SQLite databases, append-only JSONL log files, and auto-schema audit loggers. One `createClient` call handles all of them.

## Database blocks

Declare databases at the top of your schema file. Models without `@@db` go to the default database:

```prisma
database main      { path env("MAIN_DB", "./app.db") }
database analytics { path env("ANALYTICS_DB", "./analytics.db") }
database logs      { path "./logs/";  driver jsonl;   retention 30d }
database audit     { path "./audit/"; driver logger;  retention 90d }
```

`env("VAR", "fallback")` reads from environment variables with an optional fallback.

## Assigning models

```prisma
model User {
  id    Integer @id
  email Text
  // no @@db — goes to 'main' (first database block, or db: option)
}

model PageView {
  id        Integer  @id
  path      Text
  duration  Integer
  createdAt DateTime @default(now())
  @@db(analytics)
}

model ApiRequest {
  method  Text
  path    Text
  status  Integer
  @@db(logs)      // append-only JSONL, no migrations
}

model User {
  @@log(audit)    // writes fire entries into the audit logger database
}
```

## createClient

For multi-DB schemas, omit `db:` — the client reads paths from the `database` blocks:

```js
const db = await createClient({ path: './schema.lite' })

// Queries route automatically
await db.user.findMany()                  // → main.db
await db.pageView.create({ data: {...} }) // → analytics.db
await db.apiRequest.create({ data: {...} }) // → logs/
await db.auditLog.findMany()              // → audit/ (auto-generated model)
```

## Drivers

### sqlite (default)

Standard SQLite file with full ORM support — all queries, migrations, soft delete, policies, etc.

### jsonl

Append-only log files, one `.jsonl` file per model under the specified directory. No migrations, no UPDATE/DELETE. Ideal for event logs, API request logs, analytics events.

Supports: `create`, `createMany`, `findMany`, `findFirst`, `count`. Retention pruning on startup.

### logger

Auto-managed audit log that receives `@log` and `@@log` write entries. Auto-creates `<dbName>Logs` model with a structured log entry schema. Queryable through the standard ORM API.

See [audit-logging.md](audit-logging.md) for full details.

## @@external — tables you don't own

Mark a model as externally managed — Litestone skips DDL/migrations but still queries it:

```prisma
model active_users {
  id        Integer @id
  email     Text
  accountId Integer
  @@external
}
```

Common uses: SQLite views, FTS5 virtual tables, legacy tables from another tool, cross-database `ATTACH`ed tables. See [querying.md#external](querying.md) for the view pattern.

## Raw SQL across databases

```js
db.$attach('./archive.db', 'archive')
const rows = await db.sql`SELECT * FROM users UNION ALL SELECT * FROM archive.users`
db.$detach('archive')
```

## Migration directories

File migrations use per-database subdirectories:

```
migrations/
  main/
    20240101000001_initial.sql
  analytics/
    20240101000001_initial.sql
```

`litestone migrate create` and `litestone migrate apply` handle all databases in one command.
