# Litestone

**Schema-first SQLite ORM for Bun.**

A single `.lite` file declares the **shape** of your data, **access** rules, **lifecycle** behavior, and the **generation** of everything downstream — TypeScript types, migrations, JSON Schema, runtime enforcement. Edit the schema; everything stays consistent. SQLite and Bun keep the runtime embedded, fast, and dependency-free.

```
// schema.lite
type Address {
  street     String
  city       String
  postalCode String
}

trait Dates {
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model User {
  id      Int @id
  name    String
  email   String  @email
  address Json  @type(Address)

  @@trait(Dates)
  @@allow('read',   auth() != null)
  @@allow('update', id == auth().id)
}
```

```js
// One declaration produces a typed, validated, access-controlled client
const db = await createClient({ schema: './schema.lite', db: './app.db' })

const me = await db.user.findUnique({ where: { id: 1 } })
me.address.city                                // typed as string

await db.user.findMany({
  where: { address: { city: 'Boston' } }       // compiles to json_extract
})
```

---

## Why

In most stacks, your data model is described in five places — an ORM schema, a validator library, TypeScript types, middleware for access control, JSON Schema for API consumers — and they drift.

Litestone collapses that to one `.lite` file. Row-level policies, traits, typed JSON, soft delete with cascade, encryption, audit logs, multi-database routing, full-text search — all declared in the schema, enforced at runtime, and reflected in generated types.

The runtime is implementation detail in service of the declarative model. SQLite is the target so the database is a single file you can back up, replicate, ship in a container, or run in a Bun script. Bun is the runtime because its native SQLite driver removes the C++/WASM hop other ORMs need.

Both choices are deliberate. Both keep the principles intact: **fast, embedded, single-binary, no external services to run alongside your app.**

---

## How it compares

The comparison is organized around what you can **declare** in the schema and what derives from those declarations.

### Shape — what you can declare about your data

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Schema as a file (not code)** | ✓ | ✗ | ✓ | ✓ |
| **Multi-file schema imports** | ✓ | ✗ ¹ | ✓ | ✓ |
| **Relations + nested writes + includes** | ✓ | ✓ | ✓ | ✓ |
| **Field validators in schema** (`@email`, `@regex`, `@length`, etc.) | ✓ | ✗ | ✗ | partial ⁶ |
| **Reusable model traits** (cross-cutting concerns spliced as fields) | ✓ | ✗ | ✗ | ✓ ⁶ |
| **Typed JSON columns** (write-time validation + path filter pushdown) | ✓ | partial ⁷ | partial ⁷ | partial ⁶ |
| **Derived relation fields** (`@from(Model, sum: amount)`) | ✓ | ✗ | ✗ | ✗ |
| **Computed fields** (`@computed`) | ✓ | ✗ | ✗ | ✗ |
| **Generated columns** (`@generated("expr")`) | ✓ | ✗ | ✗ | ✗ |
| **State machines** (`@@transitions`, enforced at the data boundary) | ✓ | ✗ | ✗ | ✗ |
| **Authorized transitions** (`@gate(5)` per move, and it reaches the client) | ✓ | ✗ | ✗ | ✗ |
| **Full-text search** (FTS5 declared with `@@fts`) | ✓ | ✗ | ✗ | ✗ |
| **`@@external`** (declare a table you don't own) | ✓ | ✗ | partial ⁴ | ✗ |
| **STRICT mode by default** | ✓ | ✗ | ✗ | ✗ |

### Access — who can do what to which rows and fields

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Row-level policies** (compiled to SQL WHERE) | ✓ | ✗ | ✗ | ✓ |
| **Field-level policies** | ✓ | ✗ | ✗ | ✓ |
| **`auth()` in policy expressions** | ✓ | ✗ | ✗ | ✓ |
| **Relation-based policy checks** | ✓ | ✗ | ✗ | ✓ |
| **Level-based access control** (GatePlugin) | ✓ | ✗ | ✗ | ✗ |
| **Field-level encryption at rest** (`@encrypted` / `@secret`) | ✓ | ✗ | ✗ | ✗ |
| **Hidden / guarded fields** (`@guarded`, `@guarded(all)`) | ✓ | ✗ | ✗ | ✗ |
| **System-mode bypass** (`asSystem()`) | ✓ | ✗ | ✗ | partial ⁶ |

### Lifecycle — what happens automatically over a row's life

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Auto timestamps** (`@default(now())`, `@updatedAt`) | ✓ | ✓ | ✓ | ✓ |
| **Soft delete built-in** | ✓ | ✗ | ✗ | ✓ ² |
| **Cascading soft delete** | ✓ | ✗ | ✗ | ✗ |
| **`@hardDelete` overrides for cascade** | ✓ | ✗ | ✗ | ✗ |
| **Auto attribution** (`@default(auth().id)`, `@updatedBy`) | ✓ | ✗ | ✗ | partial ⁶ |
| **Per-scope sequences** (`@sequence(scope: tenantId)`) | ✓ | ✗ | ✗ | ✗ |
| **File storage lifecycle** (S3/R2 upload + cleanup paired with row writes) | ✓ | ✗ | ✗ | ✗ |
| **Audit log per write** (`@@log(audit)` with full diff) | ✓ | ✗ | ✗ | ✗ |
| **Encryption key rotation** (`$rotateKey`) | ✓ | ✗ | ✗ | ✗ |

### Querying — how you read the data back

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Type-safe client** | ✓ | ✓ | ✓ | ✓ |
| **Cursor pagination** | ✓ | ✓ | ✓ | ✓ |
| **Aggregate / groupBy / count** | ✓ | ✓ | ✓ | ✓ |
| **Raw SQL escape hatch** | ✓ | ✓ | ✓ | ✓ |
| **Recursive CTE tree queries** | ✓ | manual | manual | manual |
| **Window functions** (`ROW_NUMBER`, `LAG`, rolling aggregates) | ✓ | manual | manual | manual |
| **FTS5 `search()`** | ✓ | ✗ | ✗ | ✗ |
| **Per-model `query(spec)` dispatcher** (auto-routes by spec shape) | ✓ | ✗ | ✗ | ✗ |
| **Multi-model batch `db.query(spec)`** (one transaction, named results) | ✓ | ✗ | ✗ | ✗ |
| **Reusable scopes** (named query fragments, chainable, auth-aware) | ✓ | ✗ | ✗ | ✗ |
| **JSON path filter pushdown** (`where: { addr: { city: 'X' } }`) | ✓ | ✗ | ✗ | ✗ |

### Operations — running this in production

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **`onQuery` query logging** | ✓ | ✓ | ✓ | ✓ |
| **Studio browser UI** | ✓ | ✓ | ✓ | ✓ |
| **`db push` (autoMigrate)** | ✓ | ✓ | ✓ | ✓ |
| **Multi-database support** | ✓ | ✓ | ✓ | ✓ |
| **Multi-database in one schema** | ✓ | ✗ | ✗ | ✗ |
| **Continuous WAL replication** (Litestream wrapper) | ✓ | ✗ | ✗ | ✗ |
| **`$backup` / `$walStatus`** | ✓ | ✗ | ✗ | ✗ |
| **Per-model storage backend** (SQLite + JSONL append-only) | ✓ | ✗ | ✗ | ✗ |
| **Application-level locks** (`$lock`) | ✓ | ✗ | ✗ | ✗ |
| **First-class multi-tenant client cache** | ✓ | ✗ | ✗ | plugin |
| **Migrations without an external dev database** | ✓ | ✓ | ✗ | ✗ |
| **Managed connection pooling** | ✗ | ✗ | ✓ ³ | ✓ ³ |

### Generation — what derives from the schema

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **TypeScript types** | ✓ | ✓ | ✓ | ✓ |
| **JSON Schema** (with `$defs` for typed JSON) | ✓ | ✗ | partial | partial |
| **Migration files** | ✓ | ✓ | ✓ | ✓ |
| **Test factories** (auto from schema) | ✓ | ✗ | ✗ | ✗ |
| **Test fixtures** (`generateGateMatrix`, `generateValidationCases`) | ✓ | ✗ | ✗ | ✗ |
| **Reverse introspection** (DB → `.lite`) | ✓ | ✓ | ✓ | ✓ |
| **Auto-generated API / tRPC hooks** | ✗ | ✗ | ✗ | ✓ |
| **Zero npm dependencies** | ✓ | ✓ | ✗ | ✗ |

### Platform reach (a tradeoff, not a feature)

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Database support** | SQLite | PostgreSQL, MySQL, SQLite, D1, etc. | PostgreSQL, MySQL, SQLite, MongoDB, etc. | (inherits Prisma's) |
| **Runtime support** | Bun | Node, Bun, Deno, Cloudflare Workers, edge | Node, Bun, edge ⁵ | Node, Bun |

¹ Drizzle schema is TypeScript code — you can split it across files using normal JS imports, but there is no dedicated schema import declaration like `import "./models/users.lite"`. Multi-file is a code organization choice, not a language feature.

² ZenStack implements soft delete via access control policy (`@@deny('read', deleted)`) rather than a dedicated `@@softDelete` attribute. There is no built-in cascade.

³ Via Prisma Accelerate / ZenStack Cloud — managed external services, not part of the local ORM.

⁴ Prisma supports `@@ignore` to exclude a model from the client, and `prisma db pull` can introspect external tables — but there is no first-class way to query an externally-managed table through the Prisma client with full type safety.

⁵ Prisma supports edge runtimes (Cloudflare Workers, Vercel Edge) only via Prisma Accelerate or specific drivers; the native Prisma engine targets Node and Bun.

⁶ ZenStack v3 introduced `type X / model M with X` for column splicing — equivalent to Litestone's `trait` / `@@trait(T)`. Field validators, attribution defaults, and system-mode bypass exist via Zod plugins or auth helpers — supported but not first-class to the schema language.

⁷ Drizzle's `$type<T>()` and Prisma's typed-JSON plugins provide TypeScript types only — the type is asserted at compile time but not enforced at runtime, and filter operations on JSON sub-keys require dropping into raw SQL. Litestone validates the shape on every write and lets you filter inside typed JSON columns using the same query shape you'd use on real columns (`where: { address: { city: 'NYC' } }` compiles to `json_extract(...)`).

**When to choose the others instead:**

- **Drizzle** — you need Postgres or MySQL; you want schema-as-code with full TypeScript inference; you prefer a thin query builder over a higher-level ORM
- **Prisma** — largest ecosystem, most tutorials, strongest hiring pool; you need Prisma Accelerate (managed connection pooling + edge caching); you're already invested in the Prisma ecosystem
- **ZenStack** — you want auto-generated tRPC or REST APIs from your schema; you're building on Prisma and want access control layered on top

---

## Install

```bash
bun add @frontierjs/litestone
```

The CLI also compiles to a dependency-free executable for machines without Bun — see [Standalone binary](#standalone-binary).

---

## Quick start

```bash
bunx litestone init              # create schema.lite + litestone.config.js
bunx litestone migrate create initial
bunx litestone migrate apply
bunx litestone studio            # browser UI at http://localhost:5001
```

---

### Where the schema lives in a FrontierJS app

Litestone is usable standalone — put the `.lite` file wherever you like. Inside a
FrontierJS app it has one home: **`db/schema.lite` at the app root**, a sibling of `api/`
and `web/` and inside neither.

```
my-app/
├── db/               ← this package's territory
│   ├── schema.lite   ← the single source of truth
│   ├── migrations/
│   └── backups/
├── api/              ← Junction reads the schema from here
└── web/              ← Sierra's build reads the same file
```

Both realms read that one file, so it belongs above both of them. Sierra's schema
auto-detection looks for `../db/schema.lite` from its own root for exactly this reason.
The full layout is in the [root README](../../README.md#project-structure).

---

## Schema

Schemas live in a `.lite` file. Syntax is close to Prisma's SDL with SQLite-native additions.

```prisma
enum Plan { starter  pro  enterprise }
enum Role { admin  member  viewer }

function slug(text: String): String {
  @@expr("lower(trim(replace({text}, ' ', '-')))")
}

model Account {
  id        Int  @id
  name      String
  slug      String   @slug(name)         // schema function → STORED generated column
  plan      Plan     @default(starter)
  meta      Json?
  createdAt DateTime @default(now())

  @@index([slug])
  @@gate(read: READER, write: ADMINISTRATOR, delete: OWNER)
}

model User {
  id          Int   @id
  account     Account   @relation(fields: [accountId], references: [id], onDelete: Cascade)
  accountId   Int
  email       String      @unique @email @lower
  name        String?     @trim
  role        Role      @default(member)
  salary      Float?     @allow('read', auth().role == 'admin')   // field-level policy
  apiKey      String?     @secret                                   // encrypted + guarded + audited
  deletedAt   DateTime?

  @@softDelete
  @@index([accountId, email])
  @@allow('read',   accountId == auth().accountId)
  @@allow('update', id == auth().id || auth().role == 'admin')
  @@log(audit)                           // write-audit every create/update/delete
}
```

### Types

| Schema type | SQLite | JS |
|---|---|---|
| `Int` | `INTEGER` | `number` |
| `Float` | `REAL` | `number` |
| `String` | `TEXT` | `string` |
| `Boolean` | `INTEGER` 0/1 | `boolean` (auto-coerced) |
| `DateTime` | `TEXT` ISO-8601 | `string` |
| `Json` | `TEXT` | `object` (auto-parsed) |
| `Bytes` | `BLOB` | `Buffer` |
| `File` | `TEXT` JSON ref | stored in S3/R2/local via FileStorage plugin |
| `File[]` | `TEXT` JSON array | multiple files, each ref stored in S3/R2/local |
| `EnumName` | `TEXT` + CHECK | `string` |
| `Type[]` | `TEXT` JSON | `Array` (auto-parsed) |
| `Type?` | nullable | `null` when absent |

### Field attributes

```
@id                              primary key (auto-increment for Int)
@unique                          UNIQUE constraint
@default(value)                  now(), uuid(), ulid(), nanoid(), true, "string", 42, enumValue
@default(auth().id)              stamped at write time from ctx.auth
@default(fieldName)              copy sibling field value on create
@relation(fields, references, onDelete?)
@generated("sql expr")           VIRTUAL or STORED generated column
@computed                        derived field — implement in computed.js, not stored in DB
@updatedAt                       auto-set to now() on every UPDATE
@updatedBy                       stamp ctx.auth.id on every UPDATE
@updatedBy(auth().field)         stamp custom auth field on every UPDATE
@sequence(scope: field)          per-scope auto-increment (e.g. per-account doc numbers)
@map("column_name")              custom DB column name
@omit                            excluded from findMany/findFirst
@omit(all)                       excluded everywhere
@guarded                         excluded unless asSystem()
@guarded(all)                    excluded everywhere unless asSystem()
@encrypted                       AES-256-GCM at rest (implies @guarded(all))
@encrypted(deterministic: true)  encrypted equality search, and the value still reads back
@hashed                          one-way digest — matchable, never readable
@secret                          @encrypted + @guarded(all) + @log(auditDb)
@allow('read'|'write'|'all', expr)   field-level conditional visibility
@log(dbName)                     field-level audit log to a logger database
@keepVersions                    on File? / File[]: skip old S3 object cleanup on update
@accept("mime/type")             on File / File[]: validate content type before upload
@markdown                        semantic annotation — field contains Markdown (no validation)
@hardDelete                      force hard delete even on @@softDelete models
@from(Model, count: true)        derived count from a relation (not stored in DB) — Int
@from(Model, sum: field)         derived sum/max/min from a relation — sum/max/min take a field
@from(Model, last: true)         first/last related ROW — field is typed Model?
@from(Model, exists: true)       Boolean
@from(Model, count: true, where: "sql", orderBy: field)  filtered / ordered derived field

// Validators — run on every create + update
@email  @url  @date  @datetime  @phone  @regex(pattern)
@length(min, max)  @gt(n)  @gte(n)  @lt(n)  @lte(n)
@startsWith(s)  @endsWith(s)  @contains(s)

// Transforms — applied before validation + write
@trim  @lower  @upper  @slug
```

### Model attributes

```
@@softDelete                     enable soft delete (requires deletedAt DateTime?)
@@softDelete(cascade)            + cascade remove/restore to FK children
@@fts([field1, field2])          FTS5 full-text search virtual table
@@index([col1, col2])            composite index
@@unique([col1, col2])           composite unique constraint
@@gate(read: L, create: L, update: L, delete: L)   level-based access control — `write` = shorthand
@@gate("R.C.U.D")                compact digit form of the same gate
@@allow('read'|'create'|'update'|'delete'|'all', expr)  row-level policy
@@allow('read'|..., expr, "custom error message")
@@deny('read'|..., expr)         row-level deny (always wins over allow)
@@deny('read'|..., expr, "custom error message")
@@log(dbName)                    model-level audit log to a logger database
@@auth                           marks model as the auth subject
@@noStrict                       opt out of STRICT mode
@@map("table_name")              custom DB table name
@@db(dbName)                     assign model to a named database block
@@external                       table managed outside Litestone — queryable but skip DDL/migrations
```

---

## Multi-database

Route models to separate SQLite files, JSONL logs, or auto-schema audit loggers:

```prisma
database main      { path env("MAIN_DB", "./app.db") }
database analytics { path env("ANALYTICS_DB", "./analytics.db") }
database logs      { path "./logs/"; driver jsonl; retention 30d }
database audit     { path "./audit/"; driver logger; retention 90d }

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
  @@db(logs)     // append-only JSONL — no migrations, no schema changes
}
```

```js
// Single createClient — routes automatically
const db = await createClient({ path: './schema.lite' })

await db.pageView.create({ data: { path: '/home', duration: 142 } })  // → analytics.db
await db.apiRequest.create({ data: { method: 'GET', path: '/', status: 200 } })  // → logs/
await db.auditLogs.findMany({ where: { model: 'User' } })  // → audit/ (auto-created by logger driver)
```

**Drivers:**
- `sqlite` (default) — standard SQLite file with full ORM support
- `jsonl` — append-only log files, one `.jsonl` per model, `findMany` supported
- `logger` — auto-schema audit log, receives `@log` / `@@log` entries; queries via `db.auditLogs`

---

## @@external — querying tables Litestone doesn't own

`@@external` marks a model whose table is managed outside Litestone — a SQLite view, an FTS5 virtual table, a table created by a migration tool, or a shared table from another process. Litestone skips DDL and migrations for it entirely, but exposes full query support: `findMany`, `findFirst`, `count`, `exists`, `aggregate`, `search`, etc.

```prisma
// SQLite view — created manually or via a JS migration
model active_users {
  id        Int @id
  email     String
  name      String?
  accountId Int
  @@external
}

// FTS5 virtual table managed by a third-party tool
model docs_fts {
  rowid   Int @id
  title   String
  body    String
  @@external
  @@fts([title, body])
}

// Table owned by another migration tool (e.g. a legacy schema)
model legacy_audit_log {
  id        Int  @id
  action    String
  actorId   Int
  createdAt DateTime
  @@external
}
```

```js
// Fully queryable — all read ops work
const users = await db.active_users.findMany({ where: { accountId: 1 } })
const n     = await db.active_users.count()
const found = await db.active_users.exists({ where: { email: 'alice@example.com' } })

// Works with include — other models can still relate to @@external models
const posts = await db.post.findMany({ include: { author: true } })

// @@external models are excluded from autoMigrate and litestone migrate create
// — Litestone will never emit CREATE TABLE, ALTER TABLE, or DROP for them
```

**Common patterns:**

A SQLite view is the most useful form — define the view in a JS migration, then query it through the ORM with full type safety:

```js
// migrations/20240101000000_create-active-users-view.js
// `db` here is the SYSTEM client — a migration is schema surgery by an operator,
// outside any request, so it bypasses every access rule by construction. This is
// the one place raw `db.sql` is correct on a schema that declares them.
export async function up(db) {
  await db.sql`
    CREATE VIEW IF NOT EXISTS active_users AS
    SELECT id, email, name, accountId
    FROM user
    WHERE deletedAt IS NULL
  `
}
```

```prisma
model active_users {
  id        Int @id
  email     String
  name      String?
  accountId Int
  @@external
}
```

This is also how you expose read-only projections, denormalized reporting tables, or cross-database `ATTACH`ed tables through the Litestone query API without any migration risk.

---

## createClient

```js
import { createClient } from '@frontierjs/litestone'

// Schema string with inline db path
const db = await createClient({ path: './schema.lite', db: './app.db' })

// Schema file with database blocks (no db: option needed)
const db = await createClient({ path: './schema.lite' })

// Pre-parsed result
const result = parseFile('./schema.lite')
const db = await createClient({ parsed: result })

// Full options
const db = await createClient({ path: './schema.lite',
  db:         './app.db',
  encryptionKey: process.env.ENC_KEY,     // 64-char hex = 32 bytes
  computed: './db/computed.js',
  plugins:    [new GatePlugin({ getLevel }), FileStorage({ provider: 'r2', ... })],
  onQuery:    (e) => logger.debug(e),          // production query logging
  hooks: {
    before: { setters: [fn], update: [fn], all: [fn] },
    after:  { getters: [fn], all: [fn] },
  },
  onEvent: { create: fn, update: fn, remove: fn, change: fn },
  filters: { posts: { status: 'published' } },  // global query filters per model
  onLog: (entry, ctx) => ({ meta: { requestId: ctx.auth?.requestId } }),
})
```

### Auth scoping

```js
const userDb = db.$setAuth(req.user)   // scoped per request — policies + field rules apply
const sysDb  = db.asSystem()           // bypasses @@gate + @@allow/@@deny, unlocks @guarded fields
```

---

## Row-level policies

`@@allow` and `@@deny` compile to SQL WHERE injections — filtering happens in SQLite, not JS:

```prisma
model Post {
  id        Int  @id
  accountId Int
  status    String     @default("draft")

  // Default is open. First @@allow makes it deny-by-default for that operation.
  @@allow('read',   status == 'published' || accountId == auth().accountId)
  @@allow('create', accountId == auth().accountId)
  @@allow('update', accountId == auth().accountId)
  @@deny('delete',  status == 'published')   // published posts can never be deleted
}
```

```js
const userDb = db.$setAuth({ id: 1, accountId: 5 })

// Only returns posts where status='published' OR accountId=5
const posts = await userDb.post.findMany()

// Returns ALL posts — policies bypassed
const all = await db.asSystem().post.findMany()
```

**Policy expressions** support: `auth()`, `auth().field`, `now()`, comparison operators, `&&`, `||`, string/number/boolean literals, and `check(relatedModel, expr)` for relation-based checks.

---

## Access control — GatePlugin

Level-based access control. Assign levels 0–9, declare required levels per operation:

```prisma
model Post {
  @@gate("1.3.4.6")   // read=VISITOR, create=CREATOR, update=USER, delete=OWNER
}
```

```js
import { GatePlugin, LEVELS } from '@frontierjs/litestone'

const gate = new GatePlugin({
  async getLevel(user, model) {
    if (!user)               return LEVELS.STRANGER       // 0
    if (user.role === 'admin') return LEVELS.ADMINISTRATOR  // 5
    return LEVELS.USER                                    // 4
  }
})

const db = await createClient({ path: './schema.lite', plugins: [gate] })
```

Levels: `STRANGER=0  VISITOR=1  READER=2  CREATOR=3  USER=4  ADMINISTRATOR=5  OWNER=6  SYSADMIN=7`
Reserved: `SYSTEM=8` (asSystem() only)  `LOCKED=9` (impassable — not even asSystem)

```
@@gate("0")          anyone can do everything
@@gate("4.4.4.6")    USER to read/create/update, OWNER to delete
@@gate("9")          nobody can do anything (model is locked)
@@gate("9.9.9.9")    same as above
```

---

## Encryption

```prisma
model User {
  ssn    String  @encrypted                        // AES-256-GCM, guarded — asSystem() only
  email  String  @encrypted(deterministic: true)   // equality WHERE works, and it reads back
  pwHash String  @hashed                           // one-way — matchable, never readable
  apiKey String  @secret                           // @encrypted + @guarded(all) + @log(audit)
}
```

```js
const db = await createClient({ path: './schema.lite',
  encryptionKey: process.env.ENC_KEY,     // 64 hex chars = 32 bytes
})

// A stable encoding is what makes a WHERE possible — deterministic ciphertext or a digest
await db.user.findFirst({ where: { email: 'alice@example.com' } })  // ✓ works, and email reads back
await db.user.findFirst({ where: { pwHash: submitted } })            // ✓ works, and pwHash never reads back
await db.user.findFirst({ where: { ssn: '123-45-6789' } })           // ✗ refused: random IV, nothing can match

// Rotate encryption key
await db.$rotateKey(newKey)
```

---

## Query API

### Read

```js
db.user.findMany({ where, orderBy, limit, offset, include, select, withDeleted, onlyDeleted })
db.user.findMany({ where, distinct: true })                    // SELECT DISTINCT
db.user.findMany({ where, window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })
db.user.findFirst({ where, orderBy, include, select })
db.user.findUnique({ where, include, select })
db.user.findFirstOrThrow({ where })
db.user.findUniqueOrThrow({ where })
db.user.findManyAndCount({ where, orderBy, limit, offset, include, select })  // → { rows, total }
db.user.count({ where })                                                       // → number
db.user.exists({ where })                                                      // → boolean
db.user.aggregate({ where, _count, _sum, _avg, _min, _max })
db.user.groupBy({ by, where, having, orderBy, limit, offset, _count, _sum, _avg, _min, _max })
db.user.groupBy({ by, interval: { createdAt: 'month' }, fillGaps: true, _count, _sum })
db.user.query({ ...args })                                    // unified dispatcher — see below
db.user.search('query', { where, limit, offset, highlight, snippet })  // requires @@fts
db.user.findManyCursor({ where, limit, cursor, orderBy })              // O(log n) pagination
db.user.findMany({ where, recursive: true })                           // CTE tree (self-referential)
db.user.findMany({ where, recursive: { direction: 'ancestors', nested: true, maxDepth: 3 } })
```

### Write

```js
// Single-row ops — return the full row (with include/select applied)
db.user.create({ data, include, select })          // → TRow
db.user.update({ where, data, include, select })   // → TRow | null
db.user.upsert({ where, create: {...}, update: {...} })  // → TRow
db.user.restore({ where })                         // → TRow[]

// select: false — skip RETURNING, return null. Fastest write path.
// No benefit on @@log models (logging requires the row snapshot).
db.user.create({ data, select: false })            // → null
db.user.update({ where, data, select: false })     // → null

// Bulk ops — return { count: number } only, no row data
// Use single-row ops in a $transaction if you need the affected rows back
db.user.createMany({ data: [...] })                // → { count: number }
db.user.updateMany({ where, data })                // → { count: number }
db.user.upsertMany({ data, conflictTarget, update })  // → { count: number }
db.user.removeMany({ where })                      // → { count: number }
db.user.deleteMany({ where })                      // → { count: number }

db.user.remove({ where })      // soft delete if @@softDelete, else hard delete → TRow
db.user.delete({ where })      // always hard delete → TRow
db.user.optimizeFts()          // merge FTS5 segments — requires @@fts
```

Bulk ops intentionally skip `RETURNING` — fetching potentially thousands of rows back negates the performance reason for using a bulk op. If you need the modified rows, use a single-row op in a `$transaction` loop, or `findMany` after the bulk op.

### Where clause

```js
{ id: 1 }
{ status: { in: ['active', 'pending'] } }
{ score: { gte: 0, lte: 100 } }
{ name: { contains: 'smith' } }
{ deletedAt: { not: null } }
{ AND: [...], OR: [...], NOT: {...} }
```

### Sorting

```js
// Flat field — standard
orderBy: { createdAt: 'desc' }
orderBy: [{ status: 'asc' }, { createdAt: 'desc' }]   // multi-field

// NULLS FIRST / LAST — object form
orderBy: { deletedAt: { dir: 'asc', nulls: 'last' } }
orderBy: { priority: { dir: 'desc', nulls: 'first' } }

// Relation field orderBy — sort by a field on a belongsTo relation (LEFT JOIN)
db.post.findMany({ orderBy: { author: { name: 'asc' } } })

// Two-hop
db.user.findMany({ orderBy: { company: { country: { name: 'asc' } } } })

// Mixed flat + relation
db.post.findMany({ orderBy: [{ author: { name: 'asc' } }, { createdAt: 'desc' }] })

// Relation aggregate orderBy — sort by count/sum/avg/min/max of a hasMany or manyToMany
// Uses a correlated subquery — no row duplication, works on any table size
db.author.findMany({ orderBy: { books: { _count: 'desc' } } })
db.author.findMany({ orderBy: { books: { _sum: { price: 'desc' } } } })
db.author.findMany({ orderBy: { books: { _max: { rating: 'desc' } } } })
db.author.findMany({ orderBy: { tags:  { _count: 'asc' } } })   // manyToMany — _count only
```

Relation field orderBy (`belongsTo` only — single-row joins). Aggregate orderBy works on `hasMany` and `manyToMany`; `_sum`/`_avg`/`_min`/`_max` require `hasMany`. Both compose with `where`, `limit`, `offset`, `include`, and `select`.

### Raw SQL — `where: { $raw }`

For predicates the structured `where` builder can't express — `json_extract`, date arithmetic, `LIKE` with complex patterns, etc. Use the `sql` tagged template for safe parameter binding:

```js
import { sql } from '@frontierjs/litestone'

// Simple
db.product.findMany({
  where: { $raw: sql`price > IF(state = ${state}, ${minPrice}, 100)` }
})

// Mixed with structured where — ANDed together
db.order.findMany({
  where: {
    status: 'active',
    $raw: sql`json_extract(meta, '$.tier') = ${3}`,
  }
})

// Composed inside AND / OR
db.user.findMany({
  where: {
    AND: [
      { accountId: 1 },
      { $raw: sql`DATEDIFF(next_review_dt, added_dt) <= ${30}` },
    ]
  }
})

// Works everywhere where: is accepted — findMany, findFirst, count, exists, update, updateMany...
const n = await db.product.count({ where: { $raw: sql`stock < ${10}` } })
```

The `sql` tag pulls interpolated values out as params and substitutes `?` placeholders — values are never concatenated into the SQL string. For simple parameterless expressions a plain string also works: `where: { $raw: 'deletedAt IS NULL' }`.

### Cursor pagination

```js
const page1 = await db.user.findManyCursor({ limit: 50, orderBy: { id: 'asc' } })
// → { items: [...], nextCursor: 'eyJ...', hasMore: true }

const page2 = await db.user.findManyCursor({
  limit: 50, orderBy: { id: 'asc' }, cursor: page1.nextCursor
})
```

### Transactions

```js
await db.$transaction(async tx => {
  const acct = await tx.account.create({ data: { name: 'Acme' } })
  const user = await tx.user.create({ data: { accountId: acct.id, email: 'a@b.com' } })
  return { acct, user }
})
```

---

## onQuery — production query logging

```js
const db = await createClient({ path: './schema.lite',
  onQuery: (event) => {
    appendFileSync('./query.log', JSON.stringify(event) + '\n')
  }
})
```

Event shape:

```js
{
  model:     'User',
  operation: 'findMany',        // all ORM operations
  database:  'main',
  actorId:   'user_abc',        // ctx.auth?.id
  sql:       'SELECT * FROM "user" WHERE "status" = ? LIMIT ?',
  params:    ['active', 20],
  duration:  1.4,               // ms — SQLite call only
  rowCount:  17,
  args:      { where: { status: 'active' } },
}
```

Common patterns:

```js
// Slow query detection
onQuery: (e) => e.duration > 100 && logger.warn('slow query', e)

// Async telemetry — never blocks the calling query
onQuery: async (e) => { await telemetry.track(e) }

// Per-actor audit
onQuery: (e) => e.actorId && audit.log(e)
```

Use `db.$tapQuery(fn)` for temporary one-shot captures (Studio REPL, tests):

```js
const log = []
const stop = db.$tapQuery(e => log.push(e))
await db.user.findMany()
stop()
// log contains all queries that fired
```

---

## Migrations

```js
import { create, apply, status, verify, autoMigrate } from '@frontierjs/litestone'

// Dev — apply changes directly, no files (like prisma db push)
autoMigrate(db)

// Production — file-based
create(db, parseResult, 'add-users', './migrations')  // generate SQL file
apply(db, './migrations')                              // apply pending
status(db, './migrations')                             // show applied/pending
verify(db, parseResult, './migrations')               // check live vs schema
```

```bash
litestone migrate create [label]   # generate migration SQL file
litestone migrate apply            # apply pending migrations
litestone migrate status           # show applied / pending / modified
litestone migrate verify           # check live db matches schema
litestone migrate dry-run [label]  # preview SQL, no file written
```

---

## Schema functions

Reusable named SQL expressions — define once, use on any model:

```prisma
function slug(text: String): String {
  @@expr("lower(trim(replace({text}, ' ', '-')))")
}

function fullName(first: String, last: String): String {
  @@expr("COALESCE({first}, '') || ' ' || COALESCE({last}, '')")
}

model User {
  firstName   String?
  lastName    String?
  displayName String  @fullName(firstName, lastName)  // STORED generated column
}

model Post {
  title String
  slug  String  @slug(title)   // same function, different model
}
```

Generated columns are `STORED` and indexable:

```js
await db.post.findMany({ where: { slug: 'hello-world' } })
await db.user.findMany({ orderBy: { displayName: 'asc' } })
```

---

## @sequence — per-scope auto-increment

```prisma
model Quote {
  id          Int @id
  accountId   Int
  quoteNumber Int @sequence(scope: accountId)
}
```

Each account gets its own counter starting at 1:

```js
const q = await db.quote.create({ data: { accountId: 5, ... } })
// q.quoteNumber → 1  (first quote for account 5)
String(q.quoteNumber).padStart(4, '0')  // → '0001'
```

---

## @from — derived relation fields

Computed aggregates and lookups from related models — evaluated at query time, not stored.

```prisma
model Account {
  id         Int      @id
  name       String
  orders     Order[]                                   // the relation @from reads
  orderCount Int      @from(Order, count: true)
  revenue    Float    @from(Order, sum: amount)
  biggest    Float    @from(Order, max: amount)
  lastOrder  Order?   @from(Order, last: true)         // the whole row, not a column
  hasBig     Boolean  @from(Order, exists: true, where: "amount > 100")
}

model Order {
  id        Int     @id
  accountId Int
  account   Account @relation(fields: [accountId], references: [id])
  amount    Float
}
```

**The first argument is the target model name, PascalCase** — `@from(Order, …)`, not the relation
field name; `@from(orders, …)` is *"unknown model 'orders'"*. **`first:`/`last:` return the whole
related row**, so the field is typed as that model (`Order?`), not as one of its columns.

Exactly one operation is required: `count: true` (field must be `Int`), `sum: field` /
`max: field` / `min: field`, `first: true` / `last: true` (field typed as the target model),
`exists: true` (field must be `Boolean`). Options are `where: "sql"` and `orderBy: field`
(what `first`/`last` order by — defaults to `id`).

Derived fields are read-only and appear in query results automatically. `sum` coalesces to `0`
on an empty set while `max`/`min` stay `null`. The declared relation is what `@from` joins on,
and a schema without one is a parse error naming the relation you need.

See `docs/relations.md` for the full table.

---

## aggregate() and groupBy()

```js
// Simple aggregate
const stats = await db.order.aggregate({
  where:  { status: 'completed' },
  _count: true,
  _sum:   { amount: true },
  _avg:   { amount: true },
  _min:   { amount: true },
  _max:   { amount: true },
})
// → { _count: 142, _sum: { amount: 98432.50 }, _avg: { amount: 693.19 }, ... }

// COUNT(DISTINCT field)
db.order.aggregate({ _count: { distinct: 'accountId' } })

// string_agg / group_concat
db.order.aggregate({
  _stringAgg: { field: 'status', separator: ', ', orderBy: 'status' }
})
// → { _stringAgg: { status: 'paid, pending, refund' } }

// Named aggregates — any _-prefixed key with an agg fn spec
// Supports FILTER (WHERE ...) for single-pass pivot queries
const pivot = await db.order.aggregate({
  _count:       true,
  _countPaid:   { count: true,   filter: sql`status = 'paid'` },
  _countRefund: { count: true,   filter: sql`status = 'refund'` },
  _sumPaid:     { sum: 'amount', filter: sql`status = 'paid'` },
  _avgPaid:     { avg: 'amount', filter: sql`status = 'paid'` },
})
// → { _count: 100, _countPaid: 72, _countRefund: 8, _sumPaid: 3200, _avgPaid: 44.4 }

// Group by field
const byStatus = await db.order.groupBy({
  by:      ['status'],
  _count:  true,
  _sum:    { amount: true },
  having:  { _count: { gt: 5 } },
  orderBy: { _count: 'desc' },
})

// Per-group filtered stats
await db.order.groupBy({
  by:           ['accountId'],
  _count:       true,
  _countPaid:   { count: true,   filter: sql`status = 'paid'` },
  _sumPaid:     { sum: 'amount', filter: sql`status = 'paid'` },
})

// Time-series bucketing with gap fill
const monthly = await db.order.groupBy({
  by:       ['createdAt'],
  interval: { createdAt: 'month' },   // year | quarter | month | week | day | hour
  where:    { createdAt: { gte: '2024-01-01', lte: '2024-12-31' } },
  fillGaps: true,   // default true when interval present — CTE-based, no missing buckets
  _count:   true,
  _sum:     { amount: true },
})
// → [{ createdAt: '2024-01', _count: 18, _sum: { amount: 4200 } }, ...]

// findManyAndCount — single query, total for pagination
const { rows, total } = await db.post.findManyAndCount({
  where: { status: 'published' },
  limit: 20, offset: 40,
})
```

---

## Recursive tree queries

Self-referential models (a field referencing the same model) automatically support CTE-based tree traversal:

```prisma
model Category {
  id       Int     @id
  name     String
  parent   Category? @relation(fields: [parentId], references: [id])
  parentId Int?
  children Category[]
}
```

```js
// All descendants of node 5
const tree = await db.category.findMany({
  where:     { id: 5 },
  recursive: true,             // direction: 'descendants' (default)
})

// All ancestors (path to root)
const breadcrumb = await db.category.findMany({
  where:     { id: 42 },
  recursive: { direction: 'ancestors' },
})

// Nested tree structure (children array on each node)
const nested = await db.category.findMany({
  where:     { parentId: null },
  recursive: { direction: 'descendants', nested: true, maxDepth: 3 },
})

// Multiple self-relations — disambiguate with via:
const reports = await db.employee.findMany({
  where:     { id: 1 },
  recursive: { direction: 'descendants', via: 'reports' },
})
```

---

## Window functions

Window functions add computed columns to each row based on a set of surrounding rows — rankings, running totals, moving averages, period comparisons. Pass a `window` object to `findMany`:

```js
db.order.findMany({
  where:   { accountId: 1 },
  orderBy: { id: 'asc' },
  window:  {
    // Positional — row number, rank, dense rank
    rn:        { rowNumber: true, partitionBy: 'accountId', orderBy: { id: 'asc' } },
    rank:      { rank: true,      partitionBy: 'accountId', orderBy: { amount: 'desc' } },
    denseRank: { denseRank: true,                           orderBy: { amount: 'desc' } },

    // Adjacent rows — previous / next value
    prev: { lag:  'amount', offset: 1, default: 0, orderBy: { id: 'asc' } },
    next: { lead: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } },

    // Partition boundary values
    first: { firstValue: 'amount', partitionBy: 'accountId', orderBy: { id: 'asc' }, rows: [null, null] },
    last:  { lastValue:  'amount', partitionBy: 'accountId', orderBy: { id: 'asc' }, rows: [null, null] },

    // Running aggregates
    runningTotal: { sum:   'amount', orderBy: { id: 'asc' } },
    runningCount: { count: true,     orderBy: { id: 'asc' } },

    // Rolling window — 7-day moving average
    ma7: { avg: 'price', orderBy: { date: 'asc' }, rows: [-6, 0] },

    // Conditional aggregate window — FILTER (WHERE ...)
    paidRunning: { sum: 'amount', filter: sql`status = 'paid'`, orderBy: { id: 'asc' } },
  }
})
// → rows with all normal fields + computed window columns mixed in:
// [{ id: 1, amount: 10, rn: 1, rank: 3, runningTotal: 10, prev: 0, ... }, ...]
```

All window functions support `partitionBy` (single field or array), `orderBy` (same syntax as query-level, including NULLS FIRST/LAST), and `rows`/`range` frame specs.

Frame spec: `rows: [-6, 0]` → `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW`. Use `null` for unbounded: `rows: [null, null]` → `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`.

Available functions: `rowNumber`, `rank`, `denseRank`, `cumeDist`, `percentRank`, `lag`, `lead`, `firstValue`, `lastValue`, `nthValue`, `ntile`, `sum`, `avg`, `min`, `max`, `count`.

---

## query() — unified dispatcher

Routes a single args object to `findMany`, `groupBy`, or `aggregate` based on its shape. Designed for API layers that receive query descriptors from request parameters:

```js
// One handler, all query types
app.get('/orders', async (req) => {
  return db.order.query(req.query)
})

// → findMany (no aggregate keys, no by)
db.order.query({ where: { status: 'paid' }, orderBy: { id: 'asc' }, limit: 20 })

// → aggregate (has _count/_sum/etc, no by)
db.order.query({ _count: true, _sum: { amount: true }, where: { accountId: 1 } })

// → groupBy (has by)
db.order.query({ by: ['status'], _count: true, where: { accountId: 1 } })

// → findMany + window
db.order.query({ window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })

// → aggregate (named agg with FILTER)
db.order.query({ _countPaid: { count: true, filter: sql`status = 'paid'` } })
```

Routing rules — checked in order: `by` present → `groupBy`; `_count`/`_sum`/`_avg`/`_min`/`_max`/`_stringAgg` or named agg present → `aggregate`; everything else → `findMany`. All standard args (`where`, `orderBy`, `limit`, `select`, `include`, `window`, `distinct`, `$raw`, etc.) pass through unchanged.

### Multi-model — `db.query(spec)`

`db.query(spec)` runs many per-model queries in one snapshot transaction and returns a named-result object. Each entry routes through the per-model dispatcher above:

```js
// Page-load fan-out — keys match model accessors, all run in one snapshot
const { user, order, revenue } = await db.query({
  user:    { where: { active: true } },                          // → findMany
  order:   { _count: true, _sum: { amount: true } },             // → aggregate
  revenue: { model: 'order', by: ['status'], _count: true },     // → groupBy (aliased)
})

// Same model, multiple queries — use `model:` to alias
const { paid, pending } = await db.query({
  paid:    { model: 'order', where: { status: 'paid' } },
  pending: { model: 'order', where: { status: 'pending' } },
})

// Auth scoping composes — each entry inherits the proxy's auth
const data = await db.$setAuth(req.user).query(req.body)

// Or trusted server work bypassing policies
const data = await db.asSystem().query({ jobs: { _count: true }, alerts: { _count: true } })
```

The spec is JSON-shaped (no methods, no promises — just args), so the simplest possible read API is one HTTP endpoint:

```js
app.post('/query', async (req, res) => {
  res.json(await db.$setAuth(req.user).query(req.body))
})
```

Whole-batch failure: any throw rolls back the transaction. For per-entry tolerance, call `db.<model>.query()` per model and use `Promise.allSettled`.

---

## Scopes

Reusable named query fragments registered per model. A scope is a plain object shaped like findMany args; the `where` may be a function for dynamic filtering.

```js
// api/src/models/customer.model.js
export const active = { where: { status: 'active' } }
export const premium = { where: { tier: 'premium' } }
export const mine = { where: (ctx) => ({ ownerId: ctx.auth?.id }) }
```

```js
import * as CustomerScopes from './models/customer.model.js'

const db = await createClient({
  schema: './schema.lite',
  scopes: { Customer: CustomerScopes },
})
```

Scopes appear as callable function-with-properties on the table accessor. The default call runs `findMany`; `count`, `findFirst`, `aggregate`, `groupBy`, `query`, and `search` are all available as methods. Scopes also chain.

```js
await db.customer.active()                          // findMany under one scope
await db.customer.active.count()                     // count under scope
await db.customer.active.premium.findMany()          // chained
await db.$setAuth(req.user).customer.mine.aggregate({ _count: true })
```

**Merge rules:** all `where` clauses (scope + caller) AND-merge; everything else is last-write-wins, with caller args overriding all scope args. Soft-delete filtering still applies.

**Conflict guard:** scope names cannot shadow built-in methods, relation fields on the same model, or start with `$`/`_`. Violations throw at `createClient` time.

**Scopes are not policies.** Scopes are opt-in — you have to call them. If a where clause must apply for security, write it as `@@allow`/`@@deny`, not as a scope.

**Parameterised scopes are not supported.** Write a function that returns a `where` clause and pass it as a caller override. See [docs/querying.md](./docs/querying.md#scopes) for full details.

---

## JS migrations

Migrations can be `.js` files alongside SQL files in the migrations directory:

```js
// migrations/20240101000001_backfill-slugs.js
export async function up(db) {
  // db = full Litestone client — all ORM operations available
  const posts = await db.post.findMany({ where: { slug: null } })
  for (const post of posts) {
    await db.post.update({
      where: { id: post.id },
      data:  { slug: post.title.toLowerCase().replace(/\s+/g, '-') },
    })
  }
}
```

JS migrations run in order alongside SQL migrations. Pass the client to `apply()` when using JS migrations programmatically:

```js
await apply(rawDb, './migrations', client)
```

---

## Computed fields

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

```prisma
model User {
  fullName String    @computed
  isActive Boolean @computed
}
```

---

## File storage — FileStorage plugin

```js
import { FileStorage, fileUrl, fileUrls, useStorage } from '@frontierjs/litestone'

const db = await createClient({ path: './schema.lite',
  plugins: [FileStorage({
    provider:   'r2',
    bucket:     'my-app',
    endpoint:   process.env.S3_ENDPOINT,
    accessKeyId:     process.env.S3_KEY,
    secretAccessKey: process.env.S3_SECRET,
    dev: 'local',   // fallback to ./storage/ when no endpoint set
  })]
})
```

```prisma
model User {
  avatar  File?              // single file — upload on create/update, delete on row delete
  resume  File?  @keepVersions  // keep old S3 object on update
  photos  File[]             // multiple files — array of refs stored as JSON
  docs    File[] @accept("application/pdf,application/msword")  // type-validated
  banner  File?  @accept("image/*")   // images only
}
```

```js
// Single file
const user = await db.user.update({ where: { id: 1 }, data: { avatar: file } })
fileUrl(user.avatar)                              // → 'https://cdn.example.com/...'

// Multiple files
const user2 = await db.user.update({ where: { id: 1 }, data: { photos: [file1, file2] } })
fileUrls(user2.photos)                            // → ['https://...', 'https://...']

// Storage utilities
const storage = useStorage(config)
await storage.sign(user.avatar, { expiresIn: 3600 })  // presigned URL
await storage.download(user.avatar)              // → Buffer
```

`@accept` validates MIME type before upload — supports wildcards (`image/*`, `video/*`) and comma-separated lists. Throws `ValidationError` with a clear message if the type doesn't match.

---

## ExternalRefPlugin — custom external-backed fields

`FileStorage` is built on `ExternalRefPlugin`, a base class for any field whose value is stored outside SQLite. Use it to build plugins where a field's raw value is a stored reference object and queries return a resolved value.

```js
import { ExternalRefPlugin } from '@frontierjs/litestone'

class MyPlugin extends ExternalRefPlugin {
  fieldType = 'MyType'   // matches the scalar type name used in .lite schema

  // Is this an un-serialized raw value (vs a stored ref object)?
  _isRawValue(v) { return v instanceof Buffer }

  // Store the raw value externally, return a ref object for SQLite
  async serialize(value, { field, model, id, ctx }) {
    const key = `${model}/${id}/${field}`
    await myStorage.put(key, value)
    return { key, size: value.length }
  }

  // Resolve a stored ref → the value returned to the caller
  async resolve(ref, { field, model, ctx }) {
    return myStorage.getUrl(ref.key)
  }

  // Clean up external storage when the row/field is deleted
  async cleanup(ref, { field, model, ctx }) {
    await myStorage.delete(ref.key)
  }

  // Optional: cache key for resolved values (null = no cache)
  cacheKey(ref) { return ref.key }
}
```

Set `autoResolve: true` (the default on `FileStorage`) to have `resolve()` called automatically on every read. Opt out per-field with `select: { field: { resolve: false } }` to get the raw ref object instead.

---

## Testing utilities

```js
import {
  makeTestClient,
  Factory,
  Seeder,
  factoryFrom,
  generateFactory,
  generateGateMatrix,
  generateValidationCases,
  truncate,
  reset,
} from '@frontierjs/litestone/testing'
```

### makeTestClient

```js
const { db, factories } = await makeTestClient(schemaText, {
  seed:         42,               // deterministic RNG for all factories
  autoFactories: true,            // auto-generate factories for all sqlite models
  factories: { user: UserFactory },  // explicit factories (override auto-generated)
  data: async (db) => {          // seeder fn runs after tables created
    await db.account.create({ data: { id: 1, name: 'Test Co' } })
  },
})
```

### Factory

```js
class UserFactory extends Factory {
  model = 'User'

  traits = {
    admin:  { role: 'admin' },
    viewer: { role: 'viewer' },
  }

  definition(seq, rng) {
    return { email: `user${seq}@test.com`, role: 'member', accountId: 1 }
  }
}

// Usage
const user    = await users.admin().createOne()
const users5  = await users.createMany(5)
const seeded  = users.seed(42).buildMany(10)   // deterministic

// withRelation — auto-create parent
const post = await posts.withRelation('author', users).createOne()
// post.userId = (auto-created user).id, post.author = the created user

// for() — use existing parent
const post2 = await posts.for('author', existingUser).createOne()

// withParents() — auto-create EVERY required parent, recursively, from the schema.
// The only way to seed a uuid-keyed model: a String FK has no fallback value.
const deployment = await factories.deployment.withParents().createOne()

// has() — hasMany children, FK pointed back at the parent
const author = await factories.author.has('posts', 3).createOne()
author.posts   // → 3 posts, each with authorId = author.id

// attach() — implicit many-to-many
await factories.post.withParents().attach('tags', 3).createOne()

// asSystem() / actingAs() — a schema with @@gate refuses an anonymous factory.
// The client propagates through the whole wired graph.
await factories.order.asSystem().withParents().createOne()

// create()/build() overload on the FIRST argument: a number is a count,
// anything else is overrides.
await users.create()                     // → 1 row
await users.create({ role: 'admin' })    // → 1 row with overrides
await users.create(5)                    // → 5 rows
await users.create(5, { role: 'admin' }) // → 5 rows with overrides
```

`model` is the schema's model name — PascalCase singular. Every chain method returns
a **clone**, so `f.seed(42)` does not mutate `f`.

### defineFactory — no subclass

```js
import { defineFactory } from '@frontierjs/litestone'

export const UserFactory = defineFactory({
  model:      'User',
  definition: (seq, rng) => ({ email: `u${seq}@x.com`, role: 'member' }),
  traits:     { admin: { role: 'admin' } },
})
// returns a CLASS — registers like any other:
await makeTestClient(schemaText, { factories: { user: UserFactory } })
```

`fli make:factory User` scaffolds one into `db/factories/`.

### snapshot / restore — seed once, reset between tests

```js
import { snapshot, restore } from '@frontierjs/litestone/testing'

await seedEverything(db)
const clean = snapshot(db)
beforeEach(() => restore(db, clean))
```

Raw rows through the write connection: `@encrypted` keeps its exact ciphertext, no
gate/hook/audit fires, FTS shadow tables are skipped. Not a transaction.

### Fixtures — authored reference data

```js
import { loadFixture } from '@frontierjs/litestone'

await loadFixture(db, 'Country', './db/fixtures/countries.json')
await loadFixture(db, 'Plan',    './db/fixtures/plans.csv', { upsert: 'code' })
```

### Seeder ordering

```js
class OrderSeeder extends Seeder {
  static dependsOn = [AccountSeeder, ProductSeeder]   // run first, once each
  async run(db) { … }
}
```

### factoryFrom — zero-config

```js
const { schema } = parse(schemaText)
const users = factoryFrom(schema, 'User', db)
const admin = await users.state({ role: 'admin' }).createOne()
```

### generateFactory — schema-derived definition

```js
const defFn = generateFactory(schema, 'User')
// Returns a definition(seq, rng) function that generates valid data from field types + constraints
// @email → 'users1@test.com', @gte(0) @lte(100) → 50, String? → null, etc.
```

### generateGateMatrix — permission test cases

```js
const matrix = generateGateMatrix(schema, 'Post')
// → [{ op: 'read', level: 1, label: 'VISITOR', expect: 'allow' }, ...]

for (const { op, level, label, expect: expected } of matrix) {
  test(`${op} as ${label} → ${expected}`, async () => { ... })
}
```

### generateValidationCases — constraint boundary data

```js
const { valid, invalid, boundary } = generateValidationCases(schema, 'Lead')

// valid   — a complete valid record (correct by construction)
// invalid — one failing case per constraint: { field, value, rule, expect: 'fail', message }
// boundary — boundary values that should pass: { field, value, rule, expect: 'pass' }

test('valid data passes', async () => {
  await db.lead.create({ data: valid })
})

for (const c of invalid) {
  test(`${c.field}: ${c.rule} rejects ${c.value}`, async () => {
    await expect(db.lead.create({ data: { ...valid, [c.field]: c.value } }))
      .rejects.toThrow(c.message)
  })
}
```

### Teardown

```js
await truncate(db, 'Post')    // hard-delete all rows in one table
await reset(db)                // hard-delete all tables in FK-safe order
await factory.truncate()       // instance method shorthand
```

### Seeder.once — idempotent seed blocks

```js
class BaseSeeder extends Seeder {
  async run(db) {
    await this.once(db, 'base-v1', async () => {
      await db.account.createMany({ data: [...] })
    })
    // runs once and never again, even across deploys
  }
}
```

---

## SQLite utilities

```js
// Hot backup — safe during writes
await db.$backup('./backups/prod.db')
await db.$backup('./backups/compact.db', { vacuum: true })

// Cross-database queries
db.$attach('./archive.db', 'archive')
// asSystem(): raw SQL enforces no access rule, so a schema that declares one
// reaches it through the documented bypass only.
const rows = await db.asSystem().sql`SELECT * FROM user UNION ALL SELECT * FROM archive.user`
db.$detach('archive')

// Schema introspection
db.$schema           // augmented parsed schema (includes auto-generated models)
db.$databases        // { main: { driver, access, path }, ... }
db.$softDelete       // { modelName: boolean }
db.$enums            // { EnumName: ['val1', 'val2', ...] }
db.$cacheSize        // { read: 24, write: 8 }
db.$close()
```

---

## Studio

```bash
bunx litestone studio   # → http://localhost:5001
```

- **Browse** — paginated table viewer, inline cell editing, soft-delete toggle, DB filter pills
- **SQL Query** — raw SQL editor across all databases
- **Schema** — ER diagram, draggable, color-coded by database, auto-generated models badged
- **Migrations** — applied/pending status + live schema diff per database
- **Stats** — per-database: page size, WAL mode, row counts, cache size
- **REPL** — Litestone query REPL with autocomplete, history, and **SQL log** per expression
- **schema.lite** — live editor with debounced validation (600ms), Ctrl+S save, error tray
- **Transform** — anonymize/shard pipeline (dev tool)
- **Performance** — schema advisor + query analyzer (EXPLAIN QUERY PLAN)

Acting-as picker: select any user from your `@@auth` model to browse with policies enforced.

---

## CLI reference

```
litestone init                       scaffold schema.lite + config
litestone migrate create [label]     generate migration SQL file
litestone migrate apply              apply pending migrations
litestone migrate status             show applied / pending / modified
litestone migrate verify             check live db matches schema
litestone migrate dry-run [label]    preview SQL, no file
litestone studio                     browser UI (default port 5001)
litestone types [out.d.ts]           generate TypeScript declarations
  --only=User,Post                 emit types for specific models only
litestone seed                       run seeder
litestone seed run [name]            run a named calendar/data seed
  --db=main --force
litestone doctor                     validate schema + db health
litestone backup [dest]              hot backup
litestone backup --vacuum            compact + backup
litestone optimize [table]           merge FTS5 index segments
litestone introspect                 reverse-engineer db → schema.lite
litestone replicate [config.js]      WAL replication via Litestream
litestone transform [config.js]      anonymize/shard pipeline (dev only)
litestone jsonschema                 generate JSON Schema from schema
litestone access                     write the access snapshot (--check in CI)
litestone ddl                        write the DDL snapshot (--check in CI)
litestone jsonschema --snapshot      write the JSON Schema snapshot (--check in CI)

Global flags:
  --config=<path>       litestone.config.js
  --schema=<path>       .lite file
  --db=<path>           database file
  --migrations=<dir>    migrations directory
  --port=<n>            studio port (default 5001)
```

---

## Standalone binary

The CLI compiles to a single executable with `bun build --compile`. The Bun runtime is embedded and SQLite is built into it, so the result has no external dependencies — no Bun, no `node_modules`, no Litestone source on the target machine. Useful for CI images, ops boxes, and handing a migration tool to someone who doesn't run Bun.

```bash
bun run build:binary                          # host platform → dist/litestone
bun run build:binary:all                      # every target, clean first
bun scripts/build-binary.js --target=bun-darwin-arm64
bun scripts/build-binary.js --no-bytecode     # smaller, slower to start
```

Targets: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64`, `bun-windows-x64`.

```bash
./dist/litestone db push --yes
./dist/litestone migrate apply
./dist/litestone studio            # full UI, HTML embedded in the binary
```

Roughly 100 MB on Linux x64, ~63 MB for darwin-arm64 — almost entirely the Bun runtime. Bytecode compilation is on by default: 4.5 MB larger (95.3 → 99.8 MB), and startup drops from ~54 ms to ~34 ms (10-run average, Bun 1.3.11, Linux x64).

**What still reads from disk.** Your `litestone.config.js`, `schema.lite`, migration files, and user seeds in `./seeds/` are loaded from the working directory as usual — a JS seed gets the full ORM client exactly as it does from source. Only files that ship *inside* the package (Studio's HTML, built-in seeds) are embedded.

**One command is unavailable.** `litestone repl` drives a separate `bun repl` process and hands it a file that imports Litestone by path, so it needs the package on disk. The binary detects this and tells you to use `bunx @frontierjs/litestone repl` instead.

**If you're modifying the CLI**, two rules keep it compilable — both fail loudly at build time rather than silently at runtime:

- Import sibling modules with literal relative specifiers (`import('../core/client.js')`), never computed ones (`import(import.meta.dir + '/../core/client.js')`). Computed specifiers are invisible to the bundler; the binary builds fine and then dies with `Cannot find module '/$bunfs/root/...'`.
- Load bundled assets with `import X from './file' with { type: 'text' }`, not `readFileSync(import.meta.dir + ...)`. There is no such directory inside a binary.

Note that `--bytecode` rewrites `import.meta.dir` to the *build machine's* source path rather than `/$bunfs/root`, so never detect "am I compiled?" by inspecting it — the CLI uses a `--define`-stamped `LITESTONE_COMPILED` flag instead.

---

## Single-file library build

Separately from the CLI binary, the *library* bundles to one file. Because the package has no third-party dependencies, the only externals are runtime built-ins (`bun:sqlite`, `fs`, `path`, `os`, `crypto`, `child_process`), so a single file is genuinely self-contained.

```bash
bun run build:lib             # dist/lib/litestone.js + .d.ts + .js.map
bun run build:lib:testing     # also emits testing.js (makeTestClient, Factory)
```

| Output | Size |
| --- | --- |
| `litestone.js` (minified) | 311 KB |
| gzipped | 94 KB |
| `litestone.d.ts` | 33 KB |

`src/index.d.ts` has no relative imports, so it's copied as-is — one `.js` plus one `.d.ts` is a complete typed drop-in with no build step for the consumer.

```js
import { createClient, parse } from './vendor/litestone.js'
```

**Why this exists: vendoring.** Dropping the bundle into another package pins it to *this* workspace build, instead of whatever `"@frontierjs/litestone": "latest"` resolves to from npm. The two are not interchangeable — 1.1.0 uses `Int`/`String`/`Float` and hard-rejects the older `Integer`/`Text`/`Real` scalars still served by npm's `latest`, so a package silently loading the registry copy fails on schemas that are valid here. Every bundle carries a banner naming its version and git SHA:

```js
// @frontierjs/litestone 1.1.0 (git 3560dba) — bundled single-file build
```

Sourcemaps are emitted by default (`--no-sourcemap` to skip) — without them, stack traces point into minified output. `--no-minify` gives readable source at 549 KB.

**`--with-testing` uses code splitting** rather than emitting two standalone files, because `src/testing.js` pulls in the whole core: two independent bundles cost ~547 KB against ~340 KB split across a shared chunk. Test helpers stay out of the default build.

Like the binary, this is Bun-only — it imports `bun:sqlite`, so it is a single *file*, not a portable one.

---

## Multi-file schemas

```prisma
// schema.lite
import "./functions.lite"
import "./enums.lite"
import "./models/users.lite"
```

Paths resolve relative to the importing file. Circular imports are safe (deduplicated). Use `parseFile()` when your schema uses imports:

```js
const result = parseFile('./schema.lite')
const db = await createClient({ parsed: result })
```


---

## Litestream

Litestone sets the pragmas Litestream requires (`WAL`, `synchronous=NORMAL`, `busy_timeout=5000`). Use `db.$backup()` for point-in-time snapshots before migrations. Use `litestone replicate config.js` for continuous WAL streaming to S3/R2.

---

## Convention decisions

| Convention | Why |
|---|---|
| `STRICT` mode on by default | No silent type coercion |
| `Boolean` stored as 0/1, returned as `true`/`false` | No leakage into app |
| `DateTime` stored as ISO-8601 TEXT | Lexicographically sortable, validated on write |
| `page_size = 8192` on new databases | Optimal for modern SSDs, set-once at creation |
| `BEGIN IMMEDIATE` for transactions | No mid-transaction write-lock deadlocks |
| `WAL mode` always on | Concurrent reads during writes |
| `foreign_keys = ON` on both connections | No silent orphan rows |
| Partial indexes on soft-delete tables | Indexes only cover live rows |
| `notIn` includes NULL rows | Matches developer expectation |
| Policies compile to SQL WHERE | Filtering in SQLite, not JS — no accidental data exposure |
| `autoMigrate` for dev, file-based for prod | Mirrors Prisma's `db push` / `migrate deploy` |
