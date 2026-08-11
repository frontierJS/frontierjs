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
  litestone.test.ts  — 1191 tests (plus cli-smoke, elegance-fixes,
                       migrations-fixes, nullable-optional: 1289 total)
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
Int        Float     String    Boolean
DateTime   Bytes     Json
File                           — stores JSON ref in SQLite, bytes in S3/R2/local
Enum       — inline: status Status  OR standalone: enum Status { active inactive }
Type[]     — arrays stored as JSON: tags String[]
Model[]    — implicit many-to-many: tags Tag[]  (join table takes each side's own
             @id name and type — see docs/relations.md § The implicit join table)
Type?      — optional (nullable)
```

### Field attributes
```
@id                              primary key (auto-increment for Int)
@unique                          UNIQUE constraint
@default(value)                  literal, now(), uuid(), ulid(), cuid(), nanoid()
@default(auth().field)           stamp from ctx.auth at write time (runtime-only)
@default(fieldName)              copy sibling field value on create
@map("col_name")                 custom DB column name
@updatedAt                       auto-set to now() on every UPDATE
@updatedBy                       stamp ctx.auth.id on every UPDATE
@updatedBy(auth().field)         stamp custom auth field on every UPDATE
@createdBy                       stamp ctx.auth.id on CREATE — a stamp, not a
                                 default, so the principal beats a caller-supplied
                                 value; skipped entirely when ctx.auth is null
@createdBy(auth().field)         stamp custom auth field on CREATE
@version                         optimistic concurrency. Int, non-optional, one per
                                 model. Bumped on every write; `update()` REQUIRES
                                 the version it read in `data` and throws
                                 VersionConflictError (409, retryable) if it moved,
                                 VersionRequiredError (400) if absent. updateMany /
                                 upsert / upsertMany bump but do not require.
                                 asSystem() skips the check
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
@markdown                        semantic annotation — String field contains Markdown (no validation)
@label("Customer")               human-readable field name → JSON Schema `title`
@required("msg")                 wording for the required rule (does NOT make the field
                                 required — the absence of `?` does). Parse error on an
                                 optional field, where the message could never fire.
@trim  @lower  @upper  @slug     string transforms applied before write
@email  @url  @date  @datetime   string format validators
@phone                           E.164 phone format validator
@length(min, max)                string length validator
@gte @gt @lte @lt                numeric validators
@regex("pattern")                regex validator
@minItems @maxItems              array validators
@from(Model, count: true)        derived count from relation — first arg is the MODEL, not the
@from(Model, sum: field)         relation field. sum/max/min take a field; count needs Int,
@from(Model, last: true)         exists needs Boolean, first/last are typed Model? (whole row)
@from(Model, count: true, where: "sql", orderBy: field)  filtered / ordered derived field
```

Every validator above takes an optional trailing message —
`@length(3, 20, "A reference is 3 to 20 characters")`, `@email("...")`,
`@gte(0, "Totals cannot be negative")` — the ZenStack convention. Those reach
`generateJsonSchema` as `x-messages`, keyed BOTH by rule name and by the JSON
Schema keyword it compiles to (`length` → `minLength`/`maxLength`), so Junction
and Sierra look up the keyword they just failed and say the sentence the schema
declared. One authored string, all three realms.

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
@@transitions(field, ...)        state machine on an enum field; `name:` optional, `@gate(N)` per move
@@auth                           marks model as the auth subject
@@createdBy                      sugar: adds createdById @createdBy + a createdBy
                                 relation to the @@auth model
@@updatedBy                      sugar: adds updatedById @updatedBy + an updatedBy relation
@@createdBy(owner)               same pair, renamed → ownerId + owner
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
model Account {
  id        Int  @id
  users     User[]                   // ← soft-deleted when account is soft-deleted
  sessions  Session[]  @hardDelete   // ← hard-deleted (row gone) when account is soft-deleted
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
  filters: {                          // keyed by ACCESSOR (db.post), not model name
    post: { status: 'published' },
    user: (ctx) => ({ tenantId: getTenant() }),
  },
})

// Multi-DB (database blocks in schema — db: not needed)
const db = await createClient({ parsed: parseResult })

// Inline schema
const db = await createClient({ schema: `model users { id Int @id; name String }`, db: ':memory:' })
```

All models route automatically to their declared database.

### Read
```js
db.user.findMany({ where, orderBy, limit, offset, include, select, withDeleted, onlyDeleted })
db.user.findMany({ where, distinct: true })                    // SELECT DISTINCT
db.user.findMany({ where, window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })
db.user.findFirst({ where, orderBy, include, select })
db.user.findUnique({ where, include, select })
db.user.findFirstOrThrow({ where })    // throws { code: 'NOT_FOUND', model }
db.user.findUniqueOrThrow({ where })
db.user.findManyAndCount({ where, orderBy, limit, offset, include, select })  // → { rows, total }
db.user.count({ where })                                                       // → number
db.user.exists({ where })                                                      // → boolean
db.user.aggregate({ where, _count, _sum, _avg, _min, _max })
db.user.aggregate({ _countPaid: { count: true, filter: sql`status = 'paid'` } })  // named + FILTER
db.user.groupBy({ by, where, having, orderBy, limit, offset, _count, _sum, _avg, _min, _max })
db.user.groupBy({ by, interval: { createdAt: 'month' }, fillGaps: true, _count, _sum })
db.user.query({ ...args })                                    // dispatches to findMany/groupBy/aggregate
db.user.search('query', { where, limit, offset })     // FTS5 — requires @@fts
db.user.findManyCursor({ where, limit, cursor, orderBy })
db.user.findMany({ where, recursive: true })           // CTE tree query (self-referential models)
db.user.findMany({ where, recursive: { direction: 'ancestors', nested: true, maxDepth: 3 } })
```

### Write
```js
// Single-row ops — return the full row (with include/select applied)
db.user.create({ data, include, select })                    // → row
db.user.update({ where, data, include, select })             // → row | null
db.user.upsert({ where, create: {...}, update: {...} })      // → row
db.user.restore({ where })                                   // → row[]
db.user.remove({ where })               // soft delete on @@softDelete models → row
db.user.delete({ where })               // always hard delete → row

// select: false — skip RETURNING, return null (fastest write path)
db.user.create({ data, select: false })   // → null
db.user.update({ where, data, select: false })  // → null

// Bulk ops — return { count: number } only, no row data
db.user.createMany({ data: [...] })                          // → { count }
db.user.updateMany({ where, data })                          // → { count }
db.user.upsertMany({ data, conflictTarget, update })         // → { count }
db.user.removeMany({ where })                                // → { count }
db.user.deleteMany({ where })                                // → { count }

db.user.optimizeFts()                   // merge FTS5 segments — requires @@fts
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

db.product.findMany({ where: { $raw: sql`price > IF(state = ${state}, ${min}, 100)` } })
db.order.findMany({ where: { status: 'active', $raw: sql`json_extract(meta, '$.tier') = ${3}` } })
db.user.findMany({ where: { AND: [{ accountId: 1 }, { $raw: sql`score > ${50}` }] } })
```

### Window functions
```js
db.order.findMany({
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
db.order.aggregate({
  _count:       true,
  _countPaid:   { count: true,   filter: sql`status = 'paid'` },
  _sumPaid:     { sum: 'amount', filter: sql`status = 'paid'` },
  _avgPaid:     { avg: 'amount', filter: sql`status = 'paid'` },
})

// Also in groupBy
db.order.groupBy({ by: ['accountId'], _count: true, _countPaid: { count: true, filter: sql`status = 'paid'` } })
```

### query() dispatcher
```js
db.order.query({ where: { status: 'paid' }, limit: 20 })          // → findMany
db.order.query({ _count: true, _sum: { amount: true } })           // → aggregate
db.order.query({ by: ['status'], _count: true })                   // → groupBy
db.order.query({ _countPaid: { count: true, filter: sql`...` } })  // → aggregate
// Pass req.query directly: app.get('/orders', req => db.order.query(req.query))
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
db.sql`SELECT * FROM user WHERE id = ${1}`
                           // raw read. On a schema declaring access rules
                           // (@@gate/@@allow/@guarded/@scoped) this THROWS —
                           // raw SQL enforces none of them. Use
                           // db.asSystem().sql`...` to bypass deliberately, or
                           // where: { $raw: sql`...` } to keep the policies.
```

---

## Row-Level Policies

```
model Post {
  id      Int @id
  ownerId Int @default(auth().id)
  status  String    @default("draft")
  title   String

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
model Post {
  ownerId Int @default(auth().id)
}
```

---

## Field-Level `@allow`

```
model User {
  id     Int @id
  salary Float?   @allow('read',  auth().role == 'admin')
  apiKey String?   @allow('write', auth().role == 'admin')
  name   String
}
```

Conflicts with `@guarded` and `@secret` — validation error.

---

## `@secret`

Composite — expands at parse time to `@encrypted + @guarded(all) + @log(audit)`.

```js
const stats = await db.$rotateKey(newKey)
// → { User: { rows: 42, fields: 1 }, Order: { rows: 18, fields: 2 } }
```

---

## Computed fields

Derived values computed in JS, not stored in SQLite.

```js
// computed.js
export default {
  User: {
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
model User {
  fullName String    @computed
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

**A schema declaring any `@@gate` auto-installs `GatePlugin({ getLevel: FrontierGateGetLevel })`** if the app supplies none — a declared-but-unenforced gate is fail-open. In that resolver, an **absent** `verifiedAt`/`activatedAt` means "the app does not model this stage" and is NOT an objection; only `null` grades down. Explicit standing (`isSystemAdmin`/`isOwner`/`isAdmin`) is checked before the lifecycle. Junction's `sessionGateLevel()` is the same function across the dependency boundary — a hand copy; change one, change both.

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
model User {
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

model ApiRequest {
  method    String
  path      String
  status    Int
  duration  Int
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

**Protected fields are redacted.** Any `@encrypted` / `@guarded` / `@secret` field has its value replaced with `'[redacted]'` in both the field-level entry and the model-level `before`/`after` snapshot — the trail records *that* the field was written, never what it holds. This is what makes `@secret`'s expansion safe: `@secret` implies `@log(<first logger db>)`, so declaring a logger database alone starts logging every `@secret` field, and without redaction that writes plaintext beside a correctly-encrypted row. `null` is preserved rather than redacted (nothing to leak, and it keeps `null → value` transitions visible); unprotected fields on the same model are still logged in full; the row returned to the caller is untouched.

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
model Quote {
  id          Int  @id
  accountId   Int
  quoteNumber Int  @sequence(scope: accountId)
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
  inlineEnums:       false,
  title:             undefined,       // top-level title, API-only (no CLI flag)
})
```

There is no `includeComputed` — it was listed here and passed by the CLI, and
the generator never read it. Computed / generated / `@from` / `@version` fields
are a property of `mode: 'full'`.

**`docs/jsonschema.md` is the full key reference** — every standard keyword and
every `x-` extension this emits, which mode and audience produces it, and which
package reads it. Several extensions (`x-litestone-policies`,
`x-litestone-read-policy`, `x-litestone-from`, `x-litestone-secret`) currently
have no reader anywhere.

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
litestone types [out.d.ts] [--only=User,Post]
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
  $.user.filter(`deleted_at IS NULL`).drop('password'),
  $.all.drop('email'),
  $.shard(),
  $.lead.sample(500),
]

export let config = { db: './production.db', pipeline }
```

---

## Seeder + Factory

```js
import { Factory, Seeder, runSeeder } from '@frontierjs/litestone'

class UserFactory extends Factory {
  model = 'User'
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

Relation chain (needs the schema + registry from `makeTestClient`/`factoryFrom`):

```js
factories.deployment.withParents().createOne()      // every required belongsTo, recursively
factories.author.has('posts', 3).createOne()        // hasMany children, FK pointed back
factories.post.attach('tags', 3).createOne()        // implicit m2m via { connect: [...] }
factories.order.asSystem().withParents().createOne() // @@gate refuses an anonymous factory
```

`create(n, o)`/`build(n, o)` overload on the FIRST argument — a **number** is a
count, anything else is overrides. Every chain method returns a clone.

Without the class ceremony, plus ordering and authored data:

```js
import { defineFactory, loadFixture, Seeder } from '@frontierjs/litestone'

export const UserFactory = defineFactory({ model: 'User', definition: (seq, rng) => ({ … }), traits: { … } })

class OrderSeeder extends Seeder { static dependsOn = [AccountSeeder]; async run(db) { … } }

await loadFixture(db, 'Plan', './db/fixtures/plans.csv', { upsert: 'code' })
```

Seeded factories draw real words for well-known field names (`firstName`, `city`,
`company`, …) from `src/fake.js`. **Unseeded output is unchanged** — schema-derived
test cases must stay stable.

---

## Testing utilities (`./testing` subpath)

```js
import { makeTestClient, Factory, defineFactory, truncate, reset, snapshot, restore,
         generateFactory, generateGateMatrix, generateValidationCases,
         factoryFrom, loadFixture, parseCsv } from '@frontierjs/litestone/testing'

const { db, factories } = await makeTestClient(schemaText, {
  seed:          42,           // deterministic RNG seed
  autoFactories: true,         // auto-generate factories for all SQLite models
  factories:     { user: MyUserFactory },
  data:          async (db) => { /* seed data */ },
})
// Always a throwaway tmpdir — a `database` block in the schema is overridden, so a
// test pointed at a real app schema can never open the app's real database.

// Helpers
await truncate(db, 'User')     // DELETE FROM "user"
await reset(db)                // truncate all tables in dependency order

// Seed once, reset between tests — raw rows, so @encrypted keeps its ciphertext
const clean = snapshot(db)
restore(db, clean)

// Test generation
const matrix  = generateGateMatrix(schema, 'Post')        // gate allow/deny cases
const cases   = generateValidationCases(schema, 'User')   // valid + invalid + boundary
const factory = factoryFrom(schema, 'User', db)
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
await tenants.query(db => db.user.count())
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
bun run test
# 1286 tests across 5 files, 0 fail (verified 2026-08-03)
```

Suites cover: parser, DDL, migrations, autoMigrate, client CRUD, soft delete, soft delete cascade, `@hardDelete` cascade, softDelete footgun warning, select/include, transactions, cursor pagination, FTS, backup, attach, WAL, computed fields, query helpers, metadata, `@updatedAt`, `@date`, `@sequence`, `@markdown`, File type, File[], `@accept`, RETURNING, `$walStatus`, `createClient` input forms, `@omit`/`@guarded`, `@guarded(all)`, `@encrypted`, `@secret`, `$rotateKey`, `onLog` callback, `@@allow`/`@@deny`, `@allow` field-level, `policyDebug`, GatePlugin, `FrontierGateGetLevel`, plugin system, `onAfterDelete`, `onAfterDelete` soft-delete boundary, FileStorage, `fileUrl`, `fileUrls`, `buildReadFilter`, `onAfterRead`, upsert/upsertMany/removeMany hooks, transform hooks, event listeners, enum transitions, `@@transitions` parser/desugar/gates/`transitions()`, lock primitive, seeder/factory, entity generator, `makeTestClient`, `generateFactory`, `generateGateMatrix`, `generateValidationCases`, `factoryFrom`, auto-factories, `generateTypeScript`, `@markdown` generateTypeScript, `generateJsonSchema` x-gate/x-relations/x-transitions, implicit many-to-many, `@from` derived fields, `aggregate`, `groupBy`, `groupBy` interval+fillGaps, `findManyAndCount`, `@@external`, `ExternalRefPlugin`, recursive CTE tree queries, JS migrations, `@phone`, `@slug`, `@updatedBy`, doc comments, relation orderBy, relation aggregate orderBy, `exists`, `$raw`/`sql` tag, `NULLS FIRST/LAST`, `distinct`, `_stringAgg`, `_count distinct`, named aggregates + FILTER, `select: false`, window functions, `query()` dispatcher, audit log redaction of `@secret`/`@encrypted`/`@guarded` fields.

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

---

## Proving a change

`bun run test` (bun; `test:smoke` is the CLI only). Then, because this is the
realm every other package sits on: `example`: `bun run verify` and `basecamp`:
`bun run verify`, plus `sierra`: `bun run test:safety` — the five checks that run
against a real client rather than a stand-in.

**Traps that cost time here, all verified by running:**

- **Raw SQL requires `asSystem()`** once a schema declares access rules — `db.sql`
  and `db.$setAuth(u).sql` both throw. Raw statements enforce no `@@gate`,
  `@@allow`, `@guarded`, `@scoped` or `@@softDelete`; they all live above SQLite.
  ``where: { $raw: sql`…` }`` keeps every policy and is the escape hatch to reach
  for. A JS migration is exempt — the runner hands it the system client.
- **`$setAuth(user)` RETURNS a scoped client, it does not mutate.** `db.$setAuth(u)`
  then `db.thing.create(…)` grades as anonymous, silently.
- **A schema declaring any `@@gate` auto-installs `GatePlugin`.** You cannot run
  without gates; installing your own replaces the default, installing none does
  not disable it. Absent ≠ null in the lifecycle: absent means the app does not
  model that stage, only `null` grades down.
- **`sessionGateLevel()` is duplicated in Junction** (which this package may not
  import). Change one, change both.
- **`createClient({ db })` is ignored when the schema declares `database main`** —
  the declaration wins, so a test that believes it is in-memory is writing the
  declared file and accumulating state across runs.
- **Columns are emitted verbatim camelCase; `DateTime` is ISO-8601 TEXT.** Hand-
  written SQL assuming snake_case or epoch-ms will not match.
- **The audit logger defers one event-loop tick** — `fireLog()` writes via
  `setImmediate`, then the jsonl driver appends synchronously. A read in the same
  tick sees 0 rows and the `.jsonl` may not exist yet; anything after an `await`
  sees the row. Yield once rather than waiting: there is no timed buffer, and no
  flush on exit to wait for.
- **`@guarded` is not a level** — it takes only `(all)`; `@guarded(5)` does not
  parse. Per-role column access is field-level `@allow`.
- **`encryptionKey` is parsed as hex**, so a 64-*character* key is not necessarily
  a 32-byte one.
