# Multi-Database

A single Litestone schema can route models to multiple SQLite databases, append-only JSONL log files, and auto-schema audit loggers. One `createClient` call handles all of them.

## Database blocks

Declare databases at the top of your schema file. Models without `@@db` go to the default database:

```lite
database main      { path env("MAIN_DB", "./app.db") }
database analytics { path env("ANALYTICS_DB", "./analytics.db") }
database logs      { path "./logs/";  driver jsonl;   retention 30d }
database audit     { path "./audit/"; driver trail;  retention 90d }
```

`env("VAR", "fallback")` reads from environment variables with an optional fallback.

## Assigning models

```lite
database main      { path env("MAIN_DB", "./app.db") }
database analytics { path env("ANALYTICS_DB", "./analytics.db") }
database logs      { path "./logs/";  driver jsonl;   retention 30d }
database audit     { path "./audit/"; driver trail;  retention 90d }

model User {
  id    Int @id
  email String
  // no @@db — goes to 'main' (first database block, or db: option)
  @@trail(audit)    // writes fire entries into the audit trail database
}

model PageView {
  id        Int  @id
  path      String
  duration  Int
  createdAt DateTime @default(now())
  @@db(analytics)
}

model ApiRequest {
  method  String
  path    String
  status  Int
  @@db(logs)      // append-only JSONL, no migrations
}
```

## createClient

For multi-DB schemas, omit `db:` — the client reads paths from the `database` blocks. A relative `path` resolves against the process's working directory, not the schema file; `createClient({ resolveFrom })` anchors it elsewhere, and the client says so once when a relative path is in play:

```js
const db = await createClient({ path: './schema.lite' })

// Queries route automatically
await db.user.create({ data: { id: 1, email: 'a@example.com' } })               // → app.db
await db.pageView.create({ data: { id: 1, path: '/', duration: 12 } })          // → analytics.db
await db.apiRequest.create({ data: { method: 'GET', path: '/', status: 200 } }) // → logs/ApiRequest.jsonl

// audit/ (auto-generated model, @@gate("8") — read it as the system; an entry
// lands one event-loop tick after the write that produced it)
await new Promise(r => setTimeout(r, 0))
const entries = await db.asSystem().auditTrail.findMany()
if (entries.length !== 1) throw new Error(`expected the user create in the trail, got ${entries.length}`)
```

## Raw SQL across databases

```js
const db = await createClient({ path: './schema.lite' })
db.$attach('./archive.db', 'archive')   // synchronous; SQLite creates the file if it is absent
await db.asSystem().sql`CREATE TABLE IF NOT EXISTS archive.user (id INTEGER PRIMARY KEY, email TEXT)`
// asSystem(): raw SQL enforces no access rule, so on a schema that declares
// one it is available through the documented bypass only.
const rows = await db.asSystem().sql`SELECT * FROM user UNION ALL SELECT * FROM archive.user`
db.$detach('archive')
```

`$attach` needs a client over files: an in-memory client (`db: ':memory:'`, `databases: ':memory:'`) refuses it with `database archive is already in use`, because its read and write handles are one connection and the alias is attached twice.

## Drivers

### sqlite (default)

Standard SQLite file with full ORM support — all queries, migrations, soft delete, policies, etc.

### jsonl

Append-only log files, one `.jsonl` file per model under the specified directory. No migrations, no UPDATE/DELETE. Ideal for event logs, API request logs, analytics events.

Supports: `create`, `createMany`, `findMany`, `findFirst`, `findUnique` (and their `OrThrow` forms), `count`; `findManyCursor` answers a single page. Every other verb — `update`, `delete`, `upsert`, `remove`, `restore` and their bulk forms, `search` — throws by name. Retention pruning on startup.

### trail

Auto-managed audit log that receives `@trail` and `@@trail` write entries. Auto-creates `<dbName>Trail` model with a structured log entry schema. Queryable through the standard ORM API.

See [audit-logging.md](audit-logging.md) for full details.

## @@external — tables you don't own

Mark a model as externally managed — Litestone skips DDL/migrations but still queries it:

```lite
model active_users {
  id        Int @id
  email     String
  accountId Int
  @@external
}
```

Common uses: SQLite views, FTS5 virtual tables, legacy tables from another tool, cross-database `ATTACH`ed tables. See [querying.md#external](querying.md) for the view pattern.

## Transactions across databases

A write is inside the transaction whichever database its model is in. A bulk write (`createMany`, `updateMany`, `upsertMany`, …) that is refused writes none of its rows, and a `$transaction` that throws rolls back every database it wrote to.

The COMMIT is the one thing that is not shared. Each database FILE commits on its own, one after another with `main` last, because SQLite makes a commit atomic within one connection and never across two. A commit that fails part way throws, naming the databases that committed and the ones that rolled back (`err.committed`, `err.rolledBack`). Two `database` blocks on one path are one file and one commit, so under `strategy database`, which puts every sqlite database into the tenant's own file, a `$transaction` is atomic outright (`FJS-D232`).

A transaction takes a write lock on every sqlite file the client writes to, not only the ones it touches. Another process writing one of those files waits for it, up to that database's `busyTimeout`.

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
