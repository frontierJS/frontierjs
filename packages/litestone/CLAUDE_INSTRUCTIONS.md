# Litestone — Project Instructions

## What this is

**`@frontierjs/litestone`** is a professional-grade SQLite ORM for Bun. Schema-first, type-safe, zero external dependencies. Published under the `@frontierjs` npm scope.

The guiding philosophy: simple, portable, 80/20, production-ready. Litestone handles everything from schema definition to migrations to querying to access control — in a single package, backed by a single SQLite file.

## Tech stack

- **Runtime**: Bun (native SQLite, workers, file I/O)
- **Language**: JavaScript ESM, no TypeScript
- **Database**: SQLite (WAL mode, dual read/write connections)
- **Distribution**: npm `@frontierjs/litestone`
- **Package scope**: `@frontierjs`

---

## Repository structure

```
src/
  core/
    parser.js      — .lite schema DSL → AST
    ddl.js         — AST → CREATE TABLE / INDEX / TRIGGER SQL
    client.js      — createClient(), all table ops, plugins, hooks, events
    migrate.js     — schema diffing: introspect, buildPristine, diffSchemas
    migrations.js  — file-based migrations: create, apply, status, verify, autoMigrate
    validate.js    — ValidationError, all field validators
    query.js       — buildWhere, buildOrderBy, boolean/date coercion
    plugin.js      — Plugin base class, PluginRunner, AccessDeniedError
    policy.js      — buildPolicyMap(), buildPolicyFilter(), checkCreatePolicy()

  plugins/
    gate.js        — GatePlugin: level-based access control
    file.js        — FileStorage plugin: @file field type + S3/R2/local storage
    external-ref.js — ExternalRefPlugin base class (field backed by external data)

  storage/
    index.js       — fileUrl(), fileUrls(), useStorage(), createProvider()
    sigv4.js       — AWS Signature V4 (zero-dependency, SubtleCrypto)
    providers/
      s3.js        — S3-compatible provider (R2, S3, B2, MinIO)
      local.js     — local filesystem provider (dev)

  drivers/
    jsonl.js       — JSONL append-only driver for logs/audit databases

  tools/           — dev/ops utilities, never imported by app code
    cli.js         — litestone CLI (all commands)
    studio.html    — browser-based Studio UI
    repl-server.js — REPL server helper
    introspect.js  — generateLiteSchema(): reverse-engineer DB → .lite
    typegen.js     — generateTypeScript() → .d.ts
    retention.js   — JSONL/logger retention pruning
    replicate.js   — Litestream wrapper: continuous WAL replication

  transform/       — SQLite transformation pipeline — CLI-only, not ORM
    framework.js   — $, params, preview, execute, introspectSQL
    runner.js      — pipeline execution engine
    split-worker.js — Bun worker for parallel shard execution
    run.js         — standalone entrypoint (used by CLI)

  tenant.js        — createTenantRegistry()
  testing.js       — makeTestClient, Factory, Seeder, factoryFrom, generateFactory, etc.
  seeder.js        — Factory, Seeder, runSeeder (re-exported from testing.js)
  jsonschema.js    — generateJsonSchema()
  index.js         — public API re-exports
  index.d.ts       — static TypeScript declarations

test/
  litestone.test.ts  — 929 tests, 122 suites
```

---

## Schema DSL (`.lite`)

### Database blocks

Multi-DB schemas declare all databases at the top of the schema file. Models are assigned via `@@db(name)`.

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
Integer    Real      Text      Boolean
DateTime   Blob      Json
File                           — stores JSON ref in SQLite, bytes in S3/R2/local
Enum       — inline: status Status  OR standalone: enum Status { active inactive }
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
@omit                            excluded from findMany/findFirst results
@omit(all)                       excluded everywhere
@guarded                         excluded unless asSystem()
@guarded(all)                    excluded from everything unless asSystem()
@encrypted                       AES-256-GCM encrypted at rest (implies @guarded(all))
@encrypted(searchable: true)     HMAC-indexed for encrypted equality search
@secret                          @encrypted + @guarded(all) + @log(audit) + $rotateKey support
@secret(rotate: false)           same but excluded from key rotation
@allow('read'|'write'|'all', expr)  field-level access policy
@log(dbName)                     log reads/writes to a logger database
@keepVersions                    on File? fields: skip old S3 object cleanup on update
@computed                        derived field — implement in computed.js, not stored in DB
@generated("sql expr")           SQL-generated column
@hardDelete                      on a relation field: hard-delete children during @@softDelete(cascade)
@markdown                        semantic annotation — Text field contains Markdown (no validation)
@trim  @lower  @upper  @slug     string transforms applied before write
@email  @url  @date  @datetime   string format validators
@phone                           E.164 phone format validator
@length(min, max)                string length validator
@gte @gt @lte @lt                numeric validators
@regex("pattern")                regex validator
@minItems @maxItems              array validators
@from(relation, count: true)     derived count from relation
@from(relation, sum: field)      derived sum/max/min/first/last/exists from relation
@from(relation, count: true, where: "sql")  filtered derived field
```

### Model attributes
```
@@db(dbName)                     assign model to a named database
@@softDelete                     enable soft delete (requires deletedAt DateTime?)
@@softDelete(cascade)            soft delete + cascade to FK children that also have @@softDelete
@@fts([field1, field2])          FTS5 full-text search virtual table
@@index([col1, col2])            composite index
@@unique([col1, col2])           composite unique constraint
@@strict                         SQLite STRICT mode (on by default)
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

### `@@softDelete` and `@hardDelete`

Without `@@softDelete(cascade)`, soft-deleting a parent row leaves FK children live — this is almost always a bug. The parser emits a warning when a `@@softDelete` model has a `hasMany` relation to another `@@softDelete` model without cascade.

`@hardDelete` on a relation field overrides cascade behaviour for that specific child:

```
model accounts {
  id        Integer  @id
  users     users[]                   // ← soft-deleted when account is soft-deleted
  sessions  sessions[]  @hardDelete   // ← hard-deleted (row gone) when account is soft-deleted
  deletedAt DateTime?
  @@softDelete(cascade)
}
```

`restore()` skips `@hardDelete` children — they're gone permanently.

---

## Client API

```js
import { createClient } from '@frontierjs/litestone'
import { sql } from '@frontierjs/litestone'   // tagged template for safe raw SQL in where: { $raw }

// Single-DB (no database blocks in schema)
const db = await createClient({
  path:          './schema.lite',     // path to .lite file
  db:            './app.db',
  encryptionKey: process.env.ENC_KEY, // 64-char hex = 32 bytes — required for @encrypted/@secret
  computed:      './db/computed.js',
  plugins:       [new GatePlugin({ getLevel }), FileStorage({ provider: 'r2', ... })],
  hooks: {
    before: { setters: [fn], update: [fn], all: [fn] },
    after:  { getters: [fn], all: [fn] },
  },
  onEvent: { create: fn, update: fn, remove: fn, change: fn },
  onLog:   (entry, ctx) => ({ meta: { requestId: ctx.auth?.requestId } }),
  filters: {
    posts: { status: 'published' },
    users: (ctx) => ({ tenantId: getTenant() }),
  },
})

// Multi-DB (database blocks in schema — db: not needed)
const db = await createClient({ parsed: parseResult })

// Inline schema
const db = await createClient({ schema: `model users { id Integer @id; name Text }`, db: ':memory:' })
```

All models route automatically to their declared database.

### Read
```js
db.users.findMany({ where, orderBy, limit, offset, include, select, withDeleted, onlyDeleted })
db.users.findMany({ where, distinct: true })                    // SELECT DISTINCT
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
db.users.search('query', { where, limit, offset })     // FTS5 — requires @@fts
db.users.findManyCursor({ where, limit, cursor, orderBy })
db.users.findMany({ where, recursive: true })           // CTE tree query (self-referential models)
db.users.findMany({ where, recursive: { direction: 'ancestors', nested: true, maxDepth: 3 } })
```

### Write
```js
// Single-row ops — return the full row (with include/select applied)
db.users.create({ data, include, select })                    // → row
db.users.update({ where, data, include, select })             // → row | null
db.users.upsert({ where, create: {...}, update: {...} })      // → row
db.users.restore({ where })                                   // → row[]
db.users.remove({ where })               // soft delete on @@softDelete models → row
db.users.delete({ where })               // always hard delete → row

// select: false — skip RETURNING, return null (fastest write path)
db.users.create({ data, select: false })   // → null
db.users.update({ where, data, select: false })  // → null

// Bulk ops — return { count: number } only, no row data
db.users.createMany({ data: [...] })                          // → { count }
db.users.updateMany({ where, data })                          // → { count }
db.users.upsertMany({ data, conflictTarget, update })         // → { count }
db.users.removeMany({ where })                                // → { count }
db.users.deleteMany({ where })                                // → { count }

db.users.optimizeFts()                   // merge FTS5 segments — requires @@fts
```

### Where clause
```js
{ id: 1 }
{ status: { in: ['active', 'pending'] } }
{ age: { gte: 18, lt: 65 } }
{ name: { contains: 'smith' } }
{ deletedAt: { not: null } }
{ AND: [...], OR: [...], NOT: {...} }
// Raw SQL escape hatch — use sql tag for safe parameter binding
{ $raw: sql`json_extract(meta, '$.tier') = ${3}` }
{ status: 'active', $raw: sql`price > ${100}` }   // mixed with structured where
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
    rank:  { rank: true, orderBy: { amount: 'desc' } },
    prev:  { lag: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } },
    total: { sum: 'amount', orderBy: { id: 'asc' } },
    ma7:   { avg: 'price', orderBy: { date: 'asc' }, rows: [-6, 0] },
    paid:  { sum: 'amount', filter: sql`status = 'paid'`, orderBy: { id: 'asc' } },
  }
})
```

Available: `rowNumber`, `rank`, `denseRank`, `cumeDist`, `percentRank`, `lag`, `lead`, `firstValue`, `lastValue`, `nthValue`, `ntile`, `sum`, `avg`, `min`, `max`, `count`. All support `partitionBy`, `orderBy` (with NULLS FIRST/LAST), `rows`/`range` frame, and `filter`.

### Named aggregates with FILTER
```js
// Single-pass pivot — replaces multiple queries
db.orders.aggregate({
  _count:       true,
  _countPaid:   { count: true,   filter: sql`status = 'paid'` },
  _sumPaid:     { sum: 'amount', filter: sql`status = 'paid'` },
  _avgPaid:     { avg: 'amount', filter: sql`status = 'paid'` },
})

// Also in groupBy
db.orders.groupBy({ by: ['accountId'], _count: true, _countPaid: { count: true, filter: sql`status = 'paid'` } })
```

### query() dispatcher
```js
db.orders.query({ where: { status: 'paid' }, limit: 20 })          // → findMany
db.orders.query({ _count: true, _sum: { amount: true } })           // → aggregate
db.orders.query({ by: ['status'], _count: true })                   // → groupBy
db.orders.query({ _countPaid: { count: true, filter: sql`...` } })  // → aggregate
// Pass req.query directly: app.get('/orders', req => db.orders.query(req.query))
```

### Auth scoping
```js
const userDb = db.$setAuth(req.user)      // scoped client — plugins + policies see ctx.auth
const sysDb  = db.asSystem()              // bypasses @@gate, @@allow/@@deny, @guarded
```

### Utilities
```js
db.$backup('./backups/prod.db')
db.$backup('./backups/prod.db', { vacuum: true })
db.$transaction(async (tx) => { ... })
db.$attach('./other.db', 'other')
db.$detach('other')
db.$rotateKey(newKey)      // re-encrypt all @secret(rotate: true) fields; returns per-model stats
db.$schema                 // parsed schema object
db.$rawDbs                 // { main: Database, ... } raw write connections
db.$databases              // { main: { driver, path }, ... }
db.$close()
db.sql`SELECT * FROM users WHERE id = ${1}`
```

---

## Row-Level Policies

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

- `@@allow` — whitelist: blocked unless at least one allow matches
- `@@deny` — blacklist: blocked if any deny matches (overrides allow)
- No `@@allow` for an operation → unrestricted
- `auth()` resolves to `ctx.auth`; null if unauthenticated
- `asSystem()` bypasses all policies

### Policy expressions
```
auth()                    — current auth object (null if unauthenticated)
auth().field              — field on auth object
auth() != null            — authenticated check
now()                     — current UTC timestamp
check(field)              — delegates to related model's read policy
field == value  field != value  field > value  field >= value  field < value  field <= value
expr1 && expr2  expr1 || expr2  !expr
```

### `@default(auth().id)`
Auto-stamps a field from `ctx.auth` at create time. Runtime-only — no SQL DEFAULT emitted.
```
model posts {
  ownerId Integer @default(auth().id)
}
```

---

## Field-Level `@allow`

```
model users {
  id     Integer @id
  salary Real?   @allow('read',  auth().role == 'admin')
  apiKey Text?   @allow('write', auth().role == 'admin')
  name   Text
}
```

Conflicts with `@guarded` and `@secret` — validation error.

---

## `@secret`

Composite — expands at parse time to `@encrypted + @guarded(all) + @log(audit)`.

```js
const stats = await db.$rotateKey(newKey)
// → { users: { rows: 42, fields: 1 }, orders: { rows: 18, fields: 2 } }
```

---

## Computed fields

Derived values computed in JS, not stored in SQLite.

```js
// computed.js
export default {
  users: {
    fullName: row => [row.firstName, row.lastName].filter(Boolean).join(' '),
    isActive: row => !row.deletedAt,

    $validate: [{
      check:   data => !data.email?.includes('+'),
      message: 'Email aliases not allowed',
      path:    ['email'],
    }]
  }
}
```

```
model users {
  fullName Text    @computed
  isActive Boolean @computed
}
```

Pass the file path (or inline object) as `computed:` to `createClient`.

---

## Migrations

```js
import { create, apply, status, verify, autoMigrate } from '@frontierjs/litestone'

autoMigrate(db)                                          // dev — applies directly, no files
create(db, parseResult, 'add-users', './migrations')     // generate SQL file
apply(db, './migrations')                                // apply pending files
status(db, './migrations')
verify(db, parseResult, './migrations')
```

Multi-DB: per-database subdirectories `migrations/main/`, `migrations/analytics/` — CLI handles automatically.

---

## Plugin system

```js
import { Plugin, PluginRunner, AccessDeniedError } from '@frontierjs/litestone'

class MyPlugin extends Plugin {
  onInit(schema, ctx) {}
  async onBeforeRead(model, args, ctx) {}
  async onBeforeCreate(model, args, ctx) {}
  async onBeforeUpdate(model, args, ctx) {}
  async onBeforeDelete(model, args, ctx) {}
  async onAfterRead(model, rows, ctx) {}
  async onAfterWrite(model, operation, result, ctx) {}   // operation: create|update|delete
  async onAfterDelete(model, rows, ctx) {}               // rows: all deleted rows
  buildReadFilter(model, ctx) { return { tenantId: ctx.auth?.tenantId } }
}
```

---

## GatePlugin

```js
import { GatePlugin, LEVELS } from '@frontierjs/litestone'

new GatePlugin({
  async getLevel(user, model) {
    if (!user)               return LEVELS.STRANGER
    if (user.isSystemAdmin)  return LEVELS.SYSADMIN
    if (user.role === 'admin') return LEVELS.ADMINISTRATOR
    return LEVELS.USER
  }
})
```

```
0  STRANGER      — unauthenticated
1  VISITOR       — authenticated but unverified
2  READER        — verified, read-only
3  CREATOR       — can create/submit, can't manage (public forms, free tier)
4  USER          — full member, standard CRUD
5  ADMINISTRATOR — app admin
6  OWNER         — account/tenant owner
7  SYSADMIN      — global system admin (real human, revocable)
8  SYSTEM        — asSystem() only
9  LOCKED        — absolute wall, not even asSystem() passes
```

```
@@gate("R.C.U.D")   — four positions: Read, Create, Update, Delete
@@gate("4")         — all ops require level 4+
@@gate("2.4.4.6")   — fully explicit
@@gate("5.8.8.9")   — R=ADMIN, C/U=SYSTEM, D=LOCKED
```

`getLevel()` clamped to 0–7. `asSystem()` sets level 8 unconditionally.

---

## FileStorage plugin

```js
import { FileStorage, fileUrl, fileUrls, useStorage } from '@frontierjs/litestone'

const db = await createClient({
  path: './schema.lite', db: './app.db',
  plugins: [FileStorage({
    provider:        'r2',
    bucket:          'my-app',
    endpoint:        process.env.S3_ENDPOINT,
    accessKeyId:     process.env.S3_KEY,
    secretAccessKey: process.env.S3_SECRET,
    keyPattern:      ':model/:id/:field/:uuid.:ext',
    dev:             'local',    // falls back to ./storage/ when no endpoint set
  })]
})
```

```
model users {
  avatar  File?              // upload on create/update, delete on row delete
  resume  File?  @keepVersions  // keep old S3 object on update
  photos  File[]             // multi-file — array of refs stored as JSON
  docs    File[] @accept("application/pdf")
}
```

```js
fileUrl(user.avatar)                         // → 'https://cdn.example.com/...'
fileUrls(user.photos)                        // → ['https://...', ...]
const storage = useStorage(config)
await storage.sign(user.avatar, { expiresIn: 3600 })
await storage.download(user.avatar)          // → Buffer
```

---

## JSONL driver

Append-only log database. No migrations, no schema. Rows appended to `<path>/<model>.jsonl`.

```
database logs {
  path      "./logs/"
  driver    jsonl
  retention 30d
}

model apiRequests {
  method    Text
  path      Text
  status    Integer
  duration  Integer
  createdAt DateTime @default(now())
  @@db(logs)
}
```

Supports: `create`, `createMany`, `findMany`, `findFirst`, `count`. No `update`, `delete`, migrations, FTS5, cursors.

---

## Logger driver

Auto-managed audit log for `@log` / `@@log` writes. Auto-creates `<dbName>Logs` model.

```
database audit {
  path      "./audit/"
  driver    logger
  retention 90d
}
```

Log entry shape: `operation, model, field?, records (id array), before?, after?, actorId?, actorType?, meta Json?, createdAt`.

`onLog` callback on `createClient` can enrich entries:

```js
onLog: (entry, ctx) => ({
  actorId:   ctx.auth?.id,
  actorType: ctx.auth?.type,
  meta:      { requestId: ctx.requestId },
})
```

---

## `@sequence` — per-scope auto-increment

```
model quotes {
  id          Integer  @id
  accountId   Integer
  quoteNumber Integer  @sequence(scope: accountId)
}
```

Each `accountId` gets its own counter starting at 1. Managed in `_litestone_sequences`.

```js
String(quote.quoteNumber).padStart(4, '0')   // → '0042'
```

---

## JSON Schema output

```js
import { generateJsonSchema } from '@frontierjs/litestone'

const schema = generateJsonSchema(db.$schema, {
  format:            'definitions',   // 'definitions' (default) | 'flat'
  mode:              'create',        // 'create' | 'update' | 'full'
  audience:          'client',        // 'client' (default) | 'system'
  includeTimestamps: false,
  includeDeletedAt:  false,
  includeComputed:   false,
  inlineEnums:       false,
})
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
    l0Retention:     '24h',
  }
}
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

## Testing utilities (`./testing` subpath)

```js
import { makeTestClient, Factory, truncate, reset,
         generateFactory, generateGateMatrix, generateValidationCases,
         factoryFrom } from '@frontierjs/litestone/testing'

const { db, factories } = await makeTestClient(schemaText, {
  seed:          42,           // deterministic RNG seed
  autoFactories: true,         // auto-generate factories for all SQLite models
  factories:     { users: MyUserFactory },
  data:          async (db) => { /* seed data */ },
})

// Helpers
await truncate(db, 'users')    // DELETE FROM users
await reset(db)                // truncate all tables in dependency order

// Test generation
const matrix  = generateGateMatrix(schema, 'posts')        // gate allow/deny cases
const cases   = generateValidationCases(schema, 'users')   // valid + invalid + boundary
const factory = factoryFrom(schema, 'users', db)
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
await tenants.query(db => db.users.count())
await tenants.migrate()
```

`jsonl`/`logger` databases are schema-global — not per-tenant. Create separately if needed.

---

## Key design decisions

- **`autoMigrate` for dev, file migrations for production** — mirrors Prisma's `db push` / `migrate deploy`
- **`@@softDelete(cascade)` explicit, not default** — cascade walks `hasMany` edges BFS; `@hardDelete` on a relation field hard-deletes that child branch instead of stamping `deletedAt`
- **Plugin system is the extension point** — caching, file storage, access control, row-level filtering
- **Transform pipeline is CLI-only** — not part of the public npm API
- **`encryptionKey` is a flat string** — 64-char hex (32 bytes); function form `(tenantId) => key` supported in tenant registry
- **`onLog` for audit enrichment** — return `{ actorId, actorType, meta }` to augment log entries; fire-and-forget via `setImmediate`
- **Breaking changes are fine** — project is pre-publish; clean architecture over backward-compat shims

---

## Test suite

```bash
bun test test/litestone.test.ts
# 929 tests, 122 suites
```

Suites cover: parser, DDL, migrations, autoMigrate, client CRUD, soft delete, soft delete cascade, `@hardDelete` cascade, softDelete footgun warning, select/include, transactions, cursor pagination, FTS, backup, attach, WAL, computed fields, query helpers, metadata, `@updatedAt`, `@date`, `@sequence`, `@markdown`, File type, File[], `@accept`, RETURNING, `$walStatus`, `createClient` input forms, `@omit`/`@guarded`, `@guarded(all)`, `@encrypted`, `@secret`, `$rotateKey`, `onLog` callback, `@@allow`/`@@deny`, `@allow` field-level, `policyDebug`, GatePlugin, `FrontierGateGetLevel`, plugin system, `onAfterDelete`, `onAfterDelete` soft-delete boundary, FileStorage, `fileUrl`, `fileUrls`, `buildReadFilter`, `onAfterRead`, upsert/upsertMany/removeMany hooks, transform hooks, event listeners, enum transitions, lock primitive, seeder/factory, entity generator, `makeTestClient`, `generateFactory`, `generateGateMatrix`, `generateValidationCases`, `factoryFrom`, auto-factories, `generateTypeScript`, `@markdown` generateTypeScript, `generateJsonSchema` x-gate/x-relations, implicit many-to-many, `@from` derived fields, `aggregate`, `groupBy`, `groupBy` interval+fillGaps, `findManyAndCount`, `@@external`, `ExternalRefPlugin`, recursive CTE tree queries, JS migrations, `@phone`, `@slug`, `@updatedBy`, doc comments, relation orderBy, relation aggregate orderBy, `exists`, `$raw`/`sql` tag, `NULLS FIRST/LAST`, `distinct`, `_stringAgg`, `_count distinct`, named aggregates + FILTER, `select: false`, window functions, `query()` dispatcher.

---

## npm scope

`@frontierjs` — `npm publish --access public`

---

## Backlog

- Publish `@frontierjs/litestone` to npm
- `introspect.js` — emit `@@db(name)` if multi-DB target is known at introspect time
- `jsonschema.js` — views support
- Vector search: `Embedding(1536)` type + `findSimilar()` + cosine similarity
- `Money` type — stored as JSON: `{ amount, currency, scale }`
- `LatLng` type + `findNear()` — Haversine in JS
- `@slug(source: title)` — auto-slug with collision handling (basic `@slug` transform built; collision-resistant version pending)
- `CREATOR` (level 3) — document "submit but can't manage" pattern more clearly

---

## SQLite gotchas

**No ILIKE** — use `WHERE LOWER(name) LIKE '%term%'`

**`json_extract` returns native types** — `json_extract(data, '$.id')` returns integer; comparing to string silently fails. Cast: `CAST(json_extract(data, '$.id') AS TEXT)`

**`sqlite_sequence` is a historical counter** — shows total rows ever created, not current count.

**Concurrent deploys + shared WAL** — blue-green with overlapping containers sharing the same SQLite file can cause WAL contention. Mitigations: Litestream WAL replication, `wal_autocheckpoint` pragma (both implemented).

**`kamal app exec` memory spikes** — each exec container adds ~500MB RAM. Run `litestone studio` on the host.
