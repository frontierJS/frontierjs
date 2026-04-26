# Litestone — Project Reference

`@frontierjs/litestone` — a professional-grade SQLite ORM for Bun.
Schema-first, declarative, zero-dependency, `.lite` DSL.

---

## Repository layout

```
src/
  core/            — must-have, always loaded
    parser.js      — .lite schema parser → AST
    ddl.js         — AST → CREATE TABLE / INDEX / TRIGGER SQL
    client.js      — createClient(), all table ops, plugins, hooks, events
    migrate.js     — introspect(), diffSchemas(), buildPristine(), buildPristineForDatabase()
    migrations.js  — create/apply/status/verify/autoMigrate, createForDatabase()
    validate.js    — ValidationError, field validators
    query.js       — buildWhere(), buildOrderBy(), boolean/date coercion
    plugin.js      — Plugin, PluginRunner, AccessDeniedError
    policy.js      — buildPolicyMap(), buildPolicyFilter(), checkCreatePolicy()

  tools/           — dev/ops utilities, never imported by app code
    cli.js         — litestone CLI (all commands)
    studio.html    — browser-based Studio UI
    repl-server.js — REPL server helper
    introspect.js  — generateLiteSchema(): reverse-engineer DB → .lite
    typegen.js     — generateTypeScript() → .d.ts
    retention.js   — JSONL/logger retention pruning
    replicate.js   — Litestream wrapper: continuous WAL replication

  plugins/         — optional add-ons
    gate.js        — GatePlugin, LEVELS, parseGateString, FrontierGateGetLevel
    file.js        — FileStorage plugin: @file field type + S3/R2/local storage
    external-ref.js — ExternalRefPlugin base class (field backed by external data)

  storage/         — file storage internals
    index.js       — fileUrl(), fileUrls(), useStorage(), createProvider()
    sigv4.js       — AWS Signature V4 (zero-dependency, SubtleCrypto)
    providers/
      s3.js        — S3-compatible provider (R2, S3, B2, MinIO)
      local.js     — local filesystem provider (dev)

  drivers/         — database backends
    jsonl.js       — JSONL append-only driver for logs/audit databases

  transform/       — SQLite transformation pipeline — CLI-only, not ORM
    framework.js   — $, params, preview, execute, introspectSQL
    runner.js      — pipeline execution engine
    split-worker.js — Bun worker for parallel shard execution
    run.js         — standalone entrypoint (used by CLI)

  tenant.js        — createTenantRegistry()
  testing.js       — makeTestClient, Factory, Seeder, factoryFrom, generateFactory, etc.
  seeder.js        — Factory, Seeder, runSeeder
  jsonschema.js    — generateJsonSchema()
  index.js         — public API re-exports
  index.d.ts       — static TypeScript declarations

test/
  litestone.test.ts  — 929 tests, 122 suites
```

---

## Schema DSL (`.lite`)

### Database blocks

Multi-DB schemas declare all databases at the top of the schema file.
Models are assigned to databases via `@@db(name)`.

```
database main {
  path env("MAIN_DB_PATH", "./app.db")   // env() with fallback, or literal string
}

database analytics {
  path "./analytics.db"
}

database logs {
  path      "./logs/"
  driver    jsonl           // append-only JSONL, no migrations
  retention 30d             // prune rows older than 30 days on startup
}

database audit {
  path      "./audit/"
  driver    logger          // auto-schema audit log for @log / @@log writes
  retention 90d
}
```

Drivers: `sqlite` (default), `jsonl`, `logger`.
Single-DB schemas omit database blocks and pass `db:` to `createClient`.

### Field types
```
Integer    Real    Text    Boolean    DateTime    Blob    Json
File       — stores JSON ref in SQLite, bytes in S3/R2/local
Enum       — inline: role Role  OR standalone: enum Role { admin member }
Type[]     — arrays stored as JSON: tags Text[]
Model[]    — implicit many-to-many: tags tags[]
Type?      — optional (nullable)
```

### Field attributes
```
@id                              primary key (auto-increment for Integer)
@unique                          UNIQUE constraint
@default(value)                  literal, now(), uuid(), ulid(), cuid(), nanoid()
@default(auth().field)           stamp from ctx.auth at write time (runtime-only)
@default(fieldName)              copy sibling field value on create
@map("col_name")                 custom DB column name
@updatedAt                       auto-set to now() on every UPDATE
@updatedBy                       stamp ctx.auth.id on every UPDATE
@updatedBy(auth().field)         stamp custom auth field on every UPDATE
@sequence(scope: fieldName)      per-scope auto-increment (e.g. per-tenant doc numbers)
@omit                            excluded from findMany/findFirst
@omit(all)                       excluded everywhere
@guarded                         excluded unless asSystem()
@guarded(all)                    excluded from everything unless asSystem()
@encrypted                       AES-256-GCM encrypted at rest (implies @guarded(all))
@encrypted(searchable: true)     HMAC-indexed for encrypted equality search
@secret                          @encrypted + @guarded(all) + @log(audit) + $rotateKey support
@secret(rotate: false)           same but excluded from key rotation
@allow('read'|'write'|'all', expr)  field-level access policy (see Policies section)
@log(dbName)                     log reads/writes to a logger database
@keepVersions                    on File? fields: skip old S3 object cleanup on update
@computed                        derived field — implement in computed.js, not stored in DB
@generated("sql expr")           SQL-generated column
@hardDelete                      force hard delete even on @@softDelete models
@trim  @lower  @upper  @slug     string transforms applied before write
@email  @url  @date  @datetime   string format validators
@phone                           E.164 phone format validator
@length(min, max)                string length validator
@gte  @gt  @lte  @lt             numeric validators
@regex("pattern")                regex validator
@minItems  @maxItems             array validators
@from(relation, count: true)     derived count from relation
@from(relation, sum: field)      derived sum/max/min/first/last/exists from relation
@from(relation, count: true, where: "sql")  filtered derived field
```

### Model attributes
```
@@db(dbName)                     assign model to a named database
@@softDelete                     enable soft delete (requires deletedAt DateTime?)
@@softDelete(cascade)            cascade soft deletes to FK children
@@fts([field1, field2])          FTS5 full-text search virtual table
@@index([col1, col2])            composite index
@@unique([col1, col2])           composite unique constraint
@@strict                         SQLite STRICT mode (default)
@@noStrict                       disable STRICT mode
@@gate("R.C.U.D")                level-based access control (see GatePlugin)
@@auth                           marks model as the auth subject
@@map("table_name")              custom DB table name
@@external                       table managed outside Litestone (skip DDL/migrations)
@@allow('read'|'create'|'update'|'delete'|'write'|'all', expr)
@@allow('read'|..., expr, "custom error message")
@@deny('read'|'create'|..., expr)
@@deny('read'|..., expr, "custom error message")
@@log(dbName)                    model-level audit log: all writes fire a log entry
```

---

## Client API

```js
import { createClient } from '@frontierjs/litestone'

// Single-DB (no database blocks in schema)
const db = await createClient({
  path:        './schema.lite',
  db:          './app.db',
  encryptionKey: process.env.ENC_KEY,     // 64-char hex = 32 bytes
  computed:    './db/computed.js',
  plugins:     [new GatePlugin({ getLevel }), FileStorage({ ... })],
  hooks: {
    before: { setters: [fn], update: [fn], all: [fn] },
    after:  { getters: [fn], all: [fn] },
  },
  onEvent: { create: fn, update: fn, remove: fn, change: fn },
  filters: {
    posts: { status: 'published' },
    users: (ctx) => ({ tenantId: getTenant() }),
  },
})

// Multi-DB (database blocks in schema — no db: option needed)
const db = await createClient({ parsed: parseResult })

// Inline schema
const db = await createClient({ schema: `model users { id Integer @id; name Text }`, db: ':memory:' })
```

All models route automatically to their declared database. `db.pageViews` goes to the analytics connection; `db.users` goes to main.

### Read
```js
db.users.findMany({ where, orderBy, limit, offset, include, select, withDeleted, onlyDeleted })
db.users.findMany({ where, distinct: true })
db.users.findMany({ where, window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })
db.users.findFirst({ where, orderBy, include, select })
db.users.findUnique({ where, include, select })
db.users.findFirstOrThrow({ where })    // throws { code: 'NOT_FOUND', model }
db.users.findUniqueOrThrow({ where })
db.users.findManyAndCount({ where, orderBy, limit, offset, include, select })  // → { rows, total }
db.users.count({ where })                                                       // → number
db.users.exists({ where })                                                      // → boolean
db.users.aggregate({ where, _count, _sum, _avg, _min, _max })
db.users.aggregate({ _countPaid: { count: true, filter: sql`status = 'paid'` } })  // named + FILTER
db.users.groupBy({ by, where, having, orderBy, limit, offset, _count, _sum, _avg, _min, _max })
db.users.groupBy({ by, interval: { createdAt: 'month' }, fillGaps: true, _count, _sum })
db.users.query({ ...args })                                    // dispatches to findMany/groupBy/aggregate
db.users.search('query', { where, limit, offset })   // FTS5 — requires @@fts
db.users.findManyCursor({ where, limit, cursor, orderBy })
db.users.findMany({ where, recursive: true })           // CTE tree query (self-referential models)
db.users.findMany({ where, recursive: { direction: 'ancestors', nested: true, maxDepth: 3 } })
```

### Sorting
```js
orderBy: { createdAt: 'desc' }
orderBy: [{ status: 'asc' }, { createdAt: 'desc' }]

// NULLS FIRST / LAST
orderBy: { deletedAt: { dir: 'asc', nulls: 'last' } }

// Relation field (belongsTo) — LEFT JOIN
orderBy: { author: { name: 'asc' } }
orderBy: { company: { country: { name: 'asc' } } }  // two-hop

// Relation aggregate (hasMany / manyToMany) — correlated subquery
orderBy: { books: { _count: 'desc' } }
orderBy: { books: { _sum: { price: 'desc' } } }
orderBy: { tags:  { _count: 'asc' } }               // manyToMany — _count only
```

### Raw SQL in where
```js
import { sql } from '@frontierjs/litestone'

db.products.findMany({ where: { $raw: sql`price > IF(state = ${state}, ${min}, 100)` } })
db.orders.findMany({ where: { status: 'active', $raw: sql`json_extract(meta, '$.tier') = ${3}` } })
db.users.findMany({ where: { AND: [{ accountId: 1 }, { $raw: sql`score > ${50}` }] } })
```

### Window functions
```js
db.orders.findMany({
  window: {
    rn:    { rowNumber: true, partitionBy: 'accountId', orderBy: { id: 'asc' } },
    prev:  { lag: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } },
    total: { sum: 'amount', orderBy: { id: 'asc' } },
    ma7:   { avg: 'price', orderBy: { date: 'asc' }, rows: [-6, 0] },
    paid:  { sum: 'amount', filter: sql`status = 'paid'`, orderBy: { id: 'asc' } },
  }
})
```

### Named aggregates with FILTER
```js
db.orders.aggregate({
  _countPaid:   { count: true,   filter: sql`status = 'paid'` },
  _sumPaid:     { sum: 'amount', filter: sql`status = 'paid'` },
})
db.orders.groupBy({ by: ['accountId'], _count: true, _countPaid: { count: true, filter: sql`status = 'paid'` } })
```

### query() dispatcher
```js
db.orders.query({ where: { status: 'paid' }, limit: 20 })   // → findMany
db.orders.query({ _count: true, _sum: { amount: true } })    // → aggregate
db.orders.query({ by: ['status'], _count: true })            // → groupBy
// Pass req.query directly: app.get('/orders', req => db.orders.query(req.query))
```

### Write
```js
// Single-row ops — return the full row (with include/select applied)
db.users.create({ data, include, select })                    // → row
db.users.update({ where, data, include, select })             // → row | null (null if policy blocked)
db.users.upsert({ where, create, update })                    // → row
db.users.restore({ where })                                   // → row[]
db.users.remove({ where })               // soft delete on @@softDelete models → row
db.users.delete({ where })               // always hard delete → row

// select: false — skip RETURNING, return null (fastest write path)
db.users.create({ data, select: false })         // → null
db.users.update({ where, data, select: false })  // → null

// Bulk ops — return { count: number } only, no row data
db.users.createMany({ data: [...] })                          // → { count }
db.users.updateMany({ where, data })                          // → { count }
db.users.upsertMany({ data, conflictTarget, update })         // → { count }
db.users.removeMany({ where })                                // → { count }
db.users.deleteMany({ where })                                // → { count }

db.users.optimizeFts()                   // merge FTS5 segments
```

### Auth context
```js
const userDb = db.$setAuth(req.user)    // scoped client — policies + plugins see ctx.auth
const sysDb  = db.asSystem()            // bypasses @@allow/@@deny, returns guarded fields
```

### Utilities
```js
db.$transaction(fn)
db.$backup('./backup.db')
db.$backup('./backup.db', { vacuum: true })
db.$attach('./other.db', 'alias')
db.$detach('alias')
db.$rotateKey(newKey)      // re-encrypt all @secret(rotate: true) fields with new key
db.$cacheSize              // { read: n, write: n } single-DB; { main: {...}, analytics: {...} } multi-DB
db.$schema                 // parsed schema object
db.$rawDbs                 // { main: Database, analytics: Database, ... } raw write connections
db.$databases              // { main: { driver, path }, analytics: {...}, ... }
db.$close()
db.sql`SELECT * FROM users WHERE id = ${1}`
```

---

## Row-Level Policies

Declared on the model, compiled to SQL `WHERE` injections at runtime.

```
model posts {
  id      Integer @id
  ownerId Integer @default(auth().id)
  status  Text    @default("draft")
  title   Text

  @@allow('read',   ownerId == auth().id || status == 'published')
  @@allow('create', auth() != null)
  @@allow('update', ownerId == auth().id)
  @@deny('update',  status == 'archived')
  @@allow('delete', ownerId == auth().id)
}
```

- `@@allow` — whitelist: operation blocked unless at least one allow matches
- `@@deny` — blacklist: operation blocked if any deny matches (overrides allow)
- Without any `@@allow` for an operation, that operation is **unrestricted**
- `auth()` resolves to `ctx.auth` — set via `db.$setAuth(user)`
- `auth()` with no auth set → `null` → policies that reference `auth().field` return no rows
- `asSystem()` bypasses all policies entirely

### Policy expressions
```
auth()                    — the current auth object (null if unauthenticated)
auth().field              — field on the auth object
auth() != null            — authenticated check
now()                     — current UTC timestamp
check(field)              — delegates to the related model's read policy
check(field, 'update')    — delegates to a specific operation
field == value
field != value  field > value  field >= value  field < value  field <= value
expr1 && expr2
expr1 || expr2
!expr
```

### `@default(auth().id)`

Auto-stamp a field from the auth context at create time.
Only fires when the field is absent or null in the data — explicit values always win.

```
model posts {
  ownerId Integer @default(auth().id)
  teamId  Integer @default(auth().teamId)
}

// With auth set:
await db.$setAuth({ id: 42, teamId: 7 }).posts.create({ data: { title: 'Hi' } })
// → ownerId: 42, teamId: 7 (auto-stamped)

// Without auth — field must be supplied explicitly
await db.asSystem().posts.create({ data: { ownerId: 42, title: 'Hi' } })
```

No SQL `DEFAULT` is emitted in DDL — this is runtime-only.
Natural companion to `@@allow('create', ownerId == auth().id)`.

---

## Field-Level @allow

Conditionally exposes or accepts a field based on the auth context.

```
model users {
  id     Integer @id
  salary Real?   @allow('read',  auth().role == 'admin')
  apiKey Text?   @allow('write', auth().role == 'admin')
  name   Text
}
```

- `@allow('read', expr)` — field silently stripped from results when expr is false
- `@allow('write', expr)` — field silently dropped from write data when expr is false
- `@allow('all', expr)` — both read and write
- `asSystem()` always sees and writes all fields
- Conflicts with `@guarded` and `@secret` — validation error

---

## @secret

Composite attribute — expands at parse time to:

```
@encrypted          — AES-256-GCM at rest (implies @guarded(all))
@guarded(all)       — excluded from all reads unless asSystem()
@log(audit)         — every read/write logged to the logger database (if declared)
```

Options:
```
@secret               — rotate: true (default) — included in $rotateKey
@secret(rotate: false) — excluded from $rotateKey, stays bound to original key
```

### Key rotation

```js
const stats = await db.$rotateKey(newKey)
// → { users: { rows: 42, fields: 1 }, orders: { rows: 18, fields: 2 } }
```

Re-encrypts all `@secret(rotate: true)` fields with the new key.
Returns per-model stats showing how many rows were updated.
Operates directly on the raw write connection; autocommit per row.

---

## Implicit Many-to-Many

```
model posts { id Integer @id; tags tags[] }
model tags  { id Integer @id; posts posts[] }
```

Join table: `_posts_tags (postsId, tagsId)` — composite PK, CASCADE on both.

```js
await db.posts.update({ where: { id: 1 }, data: {
  tags: { connect: [{ id: 1 }] }
  tags: { disconnect: { id: 3 } }
  tags: { set: [{ id: 1 }] }         // replace all
  tags: { create: { name: 'new' } }
}})
```

---

## Migrations

```js
import { create, apply, status, verify, autoMigrate } from '@frontierjs/litestone'

// Dev — applies changes directly, no files
autoMigrate(db)

// File-based (production)
create(db, parseResult, 'add-users', './migrations')
apply(db, './migrations')
status(db, './migrations')
verify(db, parseResult, './migrations')
```

Multi-DB migrations use per-database subdirectories: `migrations/main/`, `migrations/analytics/`.
The CLI handles this automatically.

---

## Plugin system

```js
class MyPlugin extends Plugin {
  onInit(schema, ctx) {}
  async onBeforeRead(model, args, ctx) {}
  async onBeforeCreate(model, args, ctx) {}
  async onBeforeUpdate(model, args, ctx) {}
  async onBeforeDelete(model, args, ctx) {}
  async onAfterRead(model, rows, ctx) {}
  async onAfterWrite(model, operation, result, ctx) {}
  async onAfterDelete(model, rows, ctx) {}   // rows = all deleted rows
  buildReadFilter(model, ctx) { return { tenantId: ctx.auth?.tenantId } }
}
```

---

## GatePlugin

```js
import { GatePlugin, LEVELS } from '@frontierjs/litestone'

new GatePlugin({
  async getLevel(user, model) {
    if (!user)              return LEVELS.STRANGER
    if (user.isSystemAdmin) return LEVELS.SYSADMIN
    if (user.role === 'admin') return LEVELS.ADMINISTRATOR
    return LEVELS.USER
  }
})
```

### Level scale
```
0  STRANGER      — unauthenticated
1  VISITOR       — authenticated but unverified
2  READER        — verified, read-only
3  CREATOR       — can create/submit, can't manage (useful for public forms, free tier)
4  USER          — full member, standard CRUD
5  ADMINISTRATOR — app admin
6  OWNER         — account/tenant owner
7  SYSADMIN      — global system admin (user.isSystemAdmin, real human, revocable)
8  SYSTEM        — asSystem() only — no user identity, background jobs
9  LOCKED        — absolute wall, not even asSystem() passes
```

### @@gate schema syntax
```
@@gate("R.C.U.D")       — four positions: Read, Create, Update, Delete
@@gate("4")             — all ops require level 4+
@@gate("2.4.4.6")       — fully explicit
@@gate("5.8.8.9")       — R=ADMIN, C/U=SYSTEM, D=LOCKED
```

`getLevel()` return values clamped to 0–7. `asSystem()` sets level 8 unconditionally.

---

## FileStorage plugin

```js
import { FileStorage, fileUrl, useStorage } from '@frontierjs/litestone'

const db = await createClient({
  path: './schema.lite',
  db: './app.db',
  plugins: [FileStorage({
    provider:        'r2',
    bucket:          'my-app',
    endpoint:        process.env.S3_ENDPOINT,
    accessKeyId:     process.env.S3_KEY,
    secretAccessKey: process.env.S3_SECRET,
    keyPattern:      ':model/:id/:field/:uuid.:ext',
    dev:             'local',   // falls back to ./storage/ when no endpoint
  })]
})
```

```
model users {
  avatar  File?              // upload on create/update, delete old on update
  resume  File?  @keepVersions  // keep old S3 object on update
}
```

```js
fileUrl(user.avatar)                              // → 'https://cdn.example.com/...'
const storage = useStorage(config)
await storage.sign(user.avatar, { expiresIn: 3600 })
await storage.download(user.avatar)               // → Buffer
```

---

## JSONL driver

Append-only log database. No migrations, no schema — just write and read rows.
Defined with `driver jsonl` in a database block. Rows are appended to `<path>/<modelName>.jsonl`.

```
database logs {
  path      "./logs/"
  driver    jsonl
  retention 30d
}

model apiRequests {
  // No @id — JSONL uses byte offset as natural key
  method    Text
  path      Text
  status    Integer
  duration  Integer
  createdAt DateTime @default(now())

  @@db(logs)
}
```

```js
// Write (append-only)
await db.apiRequests.create({ data: { method: 'GET', path: '/api/users', status: 200, duration: 4 } })
await db.apiRequests.createMany({ data: [...] })

// Read (full scan or filtered)
const errors = await db.apiRequests.findMany({ where: { status: { gte: 400 } } })
const count  = await db.apiRequests.count()
```

Supports: `create`, `createMany`, `findMany`, `findFirst`, `count`.
Does not support: `update`, `delete`, migrations, FTS5, cursors.

---

## Logger driver

Auto-managed audit log for `@log` / `@@log` writes. Unified log shape.
Defined with `driver logger` in a database block. Auto-creates `auditLogs` (or custom `logModel`).

```
database audit {
  path      "./audit/"
  driver    logger
  retention 90d
}
```

Fields with `@log(audit)` (synthesized by `@secret`) and models with `@@log(audit)` 
write here automatically. Log shape:

```
operation   Text         — create | update | delete | read
model       Text         — model name
field       Text?        — field name (for field-level @log)
records     Json         — array of affected record IDs
before      Json?        — pre-update snapshot (single-record writes only)
after       Json?        — post-write snapshot (single-record writes only)
actorId     Integer?     — from ctx.auth
actorType   Text?        — from ctx.auth
meta        Json?        — extra context
createdAt   DateTime
```

```js
// Query audit log
await db.auditLogs.findMany({ where: { model: 'users', operation: 'update' } })
```

---

## JSON Schema output

```js
import { generateJsonSchema } from '@frontierjs/litestone'

const schema = generateJsonSchema(parseResult.schema, {
  format:            'definitions',   // 'definitions' (default) | 'flat'
  mode:              'create',        // 'create' | 'update' | 'full'
  audience:          'client',        // 'client' (default) | 'system'
  includeTimestamps: false,
  includeDeletedAt:  false,
  includeComputed:   false,
  inlineEnums:       false,
})
```

### `audience` option

| Field type | `client` create | `client` full | `system` full |
|---|---|---|---|
| `@secret` | excluded | excluded | included + `x-litestone-secret: true` |
| `@guarded(all)` | excluded | excluded | included + `x-litestone-guarded: true` |
| `@guarded` | excluded (write) | included | included + annotated |
| `@allow('read', expr)` | optional + `x-litestone-read-policy: true` | same | included |

Models with `@@allow`/`@@deny` get `x-litestone-policies: true` so Junction knows to enforce them.

Fields with `@default(auth().id)` are not listed in `required[]` in create mode.

---

## Studio

```bash
litestone studio                  # http://localhost:5001
litestone studio --port=5002
```

Features:
- **Browse panel** — paginated table browser, filter, CSV/JSON export, cursor pagination
- **Acting as** selector — dropdown at top of sidebar: System (bypasses all policies) or any user from the `@@auth` model. Switching immediately refreshes the browse panel and REPL under that auth context.
- **REPL** — `db` respects current auth selection; `sys` is always `asSystem()`. Tab completion for `db.`, `sys.`, `db.$setAuth(...)..`
- **Migrations panel** — per-database sections in multi-DB mode
- **Schema browser + ER diagram**
- **Performance panel** — Schema Advisor, Query Analyzer with `EXPLAIN QUERY PLAN`
- **Transform panel** — GUI pipeline builder, drag-to-reorder, live preview
- **Multi-DB** — sidebar groups tables by database with driver badge; header shows "Multi-DB (N databases)"
- **JSON cells** — click to expand inline, click again to collapse

---

## @sequence — per-scope auto-increment

```
model quotes {
  id          Integer  @id
  accountId   Integer
  quoteNumber Integer  @sequence(scope: accountId)
  title       Text
}
```

Each `accountId` gets its own counter starting at 1. Managed in `_litestone_sequences` table.
Explicit values advance the counter: supply `quoteNumber: 100` → next auto is 101.
Works with `createMany` (per-row) and `upsertMany`.

```js
String(quote.quoteNumber).padStart(4, '0')  // → '0042'
```

---

## CLI

```bash
litestone init
litestone migrate create [label]
litestone migrate dry-run [label]
litestone migrate apply
litestone migrate status
litestone migrate verify
litestone studio [--port=5001]
litestone repl
litestone doctor
litestone types [out.d.ts] [--only=users,posts]
litestone seed [SeederClass]
litestone seed run [name] [--db=main] [--force]
litestone introspect <db> [--out schema.lite] [--no-camel]
litestone transform config.js [--preview] [--dry-run]
litestone jsonschema [--out=./schemas/] [--format=flat]
litestone replicate config.js
litestone backup [dest] [--vacuum]
litestone optimize [table]
litestone tenant list|create|delete|migrate
```

---

## Litestream replication

```js
export let config = {
  db: './production.db',
  replicate: {
    url:             's3://mybucket/myapp',
    syncInterval:    '10s',
    retentionPeriod: '720h',
    l0Retention:     '24h',    // keeps historical LTX for time-travel queries
  }
}
```

```bash
litestone replicate config.js
```

---

## Transform pipeline (CLI-only)

```js
import { $, params } from '@frontierjs/litestone'

export let pipeline = [
  $.users.filter(`deleted_at IS NULL`).drop('password'),
  $.all.drop('email'),
  $.shard(),
  $.leads.sample(500),
]

export let config = { db: './production.db', pipeline }
```

---

## Seeder + Factory

```js
import { Factory, Seeder, runSeeder } from '@frontierjs/litestone'

class UserFactory extends Factory {
  model = 'users'
  definition(seq, rng) {
    return { name: `User ${seq}`, email: `u${seq}@x.com`, role: rng.pick(['admin','member']) }
  }
  admin() { return this.state({ role: 'admin' }) }
}

class DatabaseSeeder extends Seeder {
  async run(db) {
    await new UserFactory(db).seed(42).createMany(10)
    await new UserFactory(db).admin().createOne()
  }
}

await runSeeder(db, DatabaseSeeder)
```

---

## Tenant registry

```js
import { createTenantRegistry } from '@frontierjs/litestone'

const tenants = await createTenantRegistry({
  dir:           './tenants/',
  schema:        './schema.lite',
  maxOpen:       100,
  encryptionKey: async (id) => getKey(id),
  migrationsDir: './migrations',
})

const db = await tenants.get('acme')
await db.posts.findMany()

await tenants.query(db => db.users.count())
await tenants.migrate()
```

**Multi-DB note:** Each tenant gets a SQLite file for the `main` database only.
`jsonl`/`logger` databases are schema-global — not replicated per tenant.
If per-tenant analytics or audit databases are needed, create them separately.

---

## introspect.js — limitations

`generateLiteSchema()` can reconstruct column types, FK relations, indexes, `@@softDelete`, and enum CHECK constraints from a live SQLite database.

**Cannot be introspected** (not stored in SQLite):
- `@@allow` / `@@deny` row-level policies
- `@allow` field-level policies
- `@secret`, `@encrypted`, `@guarded`
- `@@log` / `@log`
- `@@gate`
- `@@fts`
- `@@db` (database assignment)

Add these manually after reviewing the generated output. The CLI emits a comment to this effect.

---

## Test suite

```bash
bun test test/litestone.test.ts
# 929 tests, 122 suites
```

Suites: parser, DDL, migrations, client (CRUD, soft delete, select/include,
transactions, cursor pagination, FTS, backup, attach, WAL, computed fields, query helpers,
metadata, updatedAt, soft delete cascade, @omit/@guarded, @encrypted, @secret,
@@allow/@@deny, @allow field-level, policyDebug, transform hooks, events, arrays,
findOrThrow, global filters, nested writes, seeder/factory, entity generator,
plugin system, GatePlugin, implicit many-to-many, onAfterDelete, File parser,
FileStorage, autoMigrate, upsertMany, upsert hooks, removeMany hooks,
buildReadFilter, onAfterRead, optimizeFts, @updatedAt, @date, @sequence).

---

## npm scope

`@frontierjs` — publish with `npm publish --access public`
Unscoped `litestone` name was blocked by npm similarity check — use scoped name or retry.

---

## Backlog

- Publish `@frontierjs/litestone` to npm (retry unscoped name, or scoped-only)
- `CREATOR` (level 3) — most apps skip VISITOR→USER; only useful for "submit but
  can't manage" patterns (public forms, free tier, external contributors)
- `introspect.js` — emit `@@db(name)` if multi-DB target is known at introspect time
- `jsonschema.js` — views support
- Vector search: `Embedding(1536)` type + `findSimilar()` + cosine similarity
- `Money` type (stored as JSON: `{ amount, currency, scale }`)
- `LatLng` type + `findNear()`
- `@slug(source: title)` — auto-slug attribute with collision handling
- `@default(:auth.id)` colon syntax — not needed, `auth().id` is cleaner

---

## SQLite gotchas (docs backlog)

**1. No ILIKE** — use `WHERE LOWER(name) LIKE '%term%'`

**2. json_extract returns native types** — `json_extract(data, '$.id')` returns integer;
comparing to string silently fails. Cast: `CAST(json_extract(data, '$.id') AS TEXT)`

**3. sqlite_sequence as historical counter** — `SELECT seq FROM sqlite_sequence WHERE name = 'tasks'`
shows total rows ever created, not current count.

**4. Concurrent deploys + shared WAL = data loss** — blue-green deploys with overlapping
containers sharing the same SQLite file can cause WAL contention. Mitigations:
Litestream WAL replication, `wal_autocheckpoint` pragma (both implemented), deploy discipline.

**5. kamal app exec memory spikes** — each exec container adds ~500MB RAM.
Run `litestone studio` on the host, not via exec containers.

---

## Potential future types

### `Money` — HIGH PRIORITY
Stored as JSON TEXT: `{ "amount": 1299, "currency": "USD", "scale": 2 }`.
Read back as `{ amount: 12.99, currency: 'USD', formatted: '$12.99' }`.

### `Embedding(n)` — HIGH PRIORITY
Stored as BLOB (float32 array). `findSimilar({ vector, limit, threshold })`.
Requires sqlite-vec extension. Plugin handles auto-embedding.

### `LatLng` — MEDIUM PRIORITY
Stored as JSON TEXT. `findNear({ lat, lng, radiusKm, limit })`. Haversine in JS.
