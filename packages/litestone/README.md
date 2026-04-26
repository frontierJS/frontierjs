# Litestone

**SQLite-first ORM for Bun.** Schema-first, zero dependencies, production-ready.

```js
const db = await createClient({ path: './schema.lite', db: './app.db' })

const users = await db.users.findMany({
  where:   { role: 'admin' },
  include: { account: true },
  orderBy: { createdAt: 'desc' },
  limit:   20,
})
```

---

## Why

Most ORMs treat SQLite as a dev convenience. Litestone treats it as the target. The result:

- **Zero dependencies** — one package, no Rust binary, no WASM
- **STRICT mode on by default** — no silent type coercion
- **Soft delete built-in** — add `deletedAt DateTime?`, get filtering, restore, and cascade automatically
- **Dual connections** — WAL mode with separate read/write connections so reads never block writes
- **FTS5 first-class** — `@@fts([body])` gives you `db.messages.search('hello world')`
- **Cursor pagination** — `findManyCursor` is O(log n), not O(n) offset scans
- **Pristine migrations** — diff against a fresh in-memory build, no shadow database
- **Multi-database** — route models to different SQLite files, JSONL logs, or audit loggers in one schema
- **Row-level policies** — `@@allow` / `@@deny` compile to SQL WHERE injections, not app-layer filtering

---

## How it compares

### Access control

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Row-level policies (SQL WHERE injection)** | ✓ | ✗ | ✗ | ✓ |
| **Field-level policies** | ✓ | ✗ | ✗ | ✓ |
| **`auth()` in policy expressions** | ✓ | ✗ | ✗ | ✓ |
| **Relation-based policy checks** | ✓ | ✗ | ✗ | ✓ |
| **Level-based access control (GatePlugin)** | ✓ | ✗ | ✗ | ✗ |
| **Schema-level field encryption** | ✓ | ✗ | ✗ | ✗ |

### Querying

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Nested writes on relations** | ✓ | ✓ | ✓ | ✓ |
| **Include on writes** | ✓ | ✓ | ✓ | ✓ |
| **Raw SQL escape hatch** | ✓ | ✓ | ✓ | ✓ |
| **Cursor pagination** | ✓ | ✓ | ✓ | ✓ |
| **Recursive CTE tree queries** | ✓ | manual | manual | manual |
| **Window functions** (`ROW_NUMBER`, `RANK`, `LAG`, rolling aggs) | ✓ | manual | manual | manual |
| **FTS5 `search()`** | ✓ | ✗ | ✗ | ✗ |
| **`query()` per-model dispatcher** (auto-routes findMany/aggregate/groupBy by shape) | ✓ | ✗ | ✗ | ✗ |
| **`db.query(spec)` multi-model batch** (one transaction, named results) | ✓ | ✗ | ✗ | ✗ |
| **Reusable scopes** (named query fragments, chainable, auth-aware) | ✓ | ✗ | ✗ | ✗ |
| **`@@external` — query tables Litestone doesn't own** | ✓ | ✗ | partial ⁴ | ✗ |

### Data modeling

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Soft delete built-in** | ✓ | ✗ | ✗ | ✓ ² |
| **Cascading soft delete** | ✓ | ✗ | ✗ | ✗ |
| **Reusable model traits** (cross-cutting concerns spliced as fields) | ✓ | ✗ | ✗ | ✓ ⁶ |
| **Typed JSON columns** (write-time validation + path filter pushdown) | ✓ | partial ⁷ | partial ⁷ | partial ⁶ |
| **`@sequence` per-scope auto-increment** | ✓ | ✗ | ✗ | ✗ |
| **`@from` derived relation fields** | ✓ | ✗ | ✗ | ✗ |
| **Enum state machines + transitions** | ✓ | ✗ | ✗ | ✗ |
| **File storage primitives in schema** (`@file`, S3/R2) | ✓ | ✗ | ✗ | ✗ |
| **Per-model storage backend** (SQLite + JSONL append-only) | ✓ | ✗ | ✗ | ✗ |

### Operations

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **`onQuery` production logging** | ✓ | ✓ | ✓ | ✓ |
| **Studio browser UI** | ✓ | ✓ | ✓ | ✓ |
| **`$backup` / `$walStatus` / WAL replication** | ✓ | ✗ | ✗ | ✗ |
| **Application-level locks (`$lock`)** | ✓ | ✗ | ✗ | ✗ |
| **First-class multi-tenant client cache** | ✓ | ✗ | ✗ | plugin |
| **Testing utilities (`/testing`)** | ✓ | ✗ | ✗ | ✗ |
| **Managed connection pooling** | ✗ | ✗ | ✓ ³ | ✓ ³ |
| **Auto-generated API / tRPC hooks** | ✗ | ✗ | ✗ | ✓ |

### Schema & migrations

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Multi-database support** | ✓ | ✓ | ✓ | ✓ |
| **TypeScript declaration generation** | ✓ | ✓ | ✓ | ✓ |
| **`db push` (autoMigrate)** | ✓ | ✓ | ✓ | ✓ |
| **Schema file (not code)** | ✓ | ✗ | ✓ | ✓ |
| **Multi-file schema imports** | ✓ | ✗ ¹ | ✓ | ✓ |
| **Multi-database in one schema** | ✓ | ✗ | ✗ | ✗ |
| **Migrations without an external dev database** | ✓ | ✓ | ✗ | ✗ |
| **Zero npm dependencies** | ✓ | ✓ | ✗ | ✗ |

### Platform

|  | Litestone | Drizzle | Prisma | ZenStack |
|---|:---:|:---:|:---:|:---:|
| **Database support** | SQLite | PostgreSQL, MySQL, SQLite, D1, etc. | PostgreSQL, MySQL, SQLite, MongoDB, etc. | (inherits Prisma's) |
| **Runtime support** | Bun | Node, Bun, Deno, Cloudflare Workers, edge | Node, Bun, edge ⁵ | Node, Bun |

¹ Drizzle schema is TypeScript code — you can split it across files using normal JS imports, but there is no dedicated schema import declaration like `import "./models/users.lite"`. Multi-file is a code organization choice, not a language feature.

² ZenStack implements soft delete via access control policy (`@@deny('read', deleted)`) rather than a dedicated `@@softDelete` attribute. There is no built-in cascade.

³ Via Prisma Accelerate / ZenStack Cloud — managed external services, not part of the local ORM.

⁴ Prisma supports `@@ignore` to exclude a model from the client, and `prisma db pull` can introspect external tables — but there is no first-class way to query an externally-managed table through the Prisma client with full type safety. The top-requested issue (#8864, 74 comments) for ignore-list migration support has been open since 2021.

⁵ Prisma supports edge runtimes (Cloudflare Workers, Vercel Edge) only via Prisma Accelerate or specific drivers; the native Prisma engine targets Node and Bun.

⁶ ZenStack v3 introduced `type X / model M with X` for column splicing — equivalent to Litestone's `trait` / `@@trait(T)`. ZenStack's typed JSON is via a separate Zod plugin, and runtime validation requires bolting Zod onto the Prisma layer.

⁷ Drizzle's `$type<T>()` and Prisma's typed-JSON plugins provide TypeScript types only — the type is asserted at compile time but not enforced at runtime, and filter operations on JSON sub-keys require dropping into raw SQL. Bad data slips through writes; type drift surfaces silently on reads. Litestone validates the shape on every write and lets you filter inside typed JSON columns using the same query shape you'd use on real columns (`where: { address: { city: 'NYC' } }` compiles to `json_extract(...)`).

**When to choose the others instead:**

- **Drizzle** — you need Postgres or MySQL; you want schema-as-code with full TypeScript inference; you prefer a thin query builder over a higher-level ORM
- **Prisma** — largest ecosystem, most tutorials, strongest hiring pool; you need Prisma Accelerate (managed connection pooling + edge caching); you're already on the Prisma ecosystem
- **ZenStack** — you want auto-generated tRPC or REST APIs from your schema; you need model inheritance; you're building on Prisma and want access control layered on top

---

## Install

```bash
bun add @frontierjs/litestone
```

---

## Quick start

```bash
bunx litestone init              # create schema.lite + litestone.config.js
bunx litestone migrate create initial
bunx litestone migrate apply
bunx litestone studio            # browser UI at http://localhost:5001
```

---

## Schema

Schemas live in a `.lite` file. Syntax is close to Prisma's SDL with SQLite-native additions.

```prisma
enum Plan { starter  pro  enterprise }
enum Role { admin  member  viewer }

function slug(text: Text): Text {
  @@expr("lower(trim(replace({text}, ' ', '-')))")
}

model accounts {
  id        Integer  @id
  name      Text
  slug      Text     @slug(name)         // schema function → STORED generated column
  plan      Plan     @default(starter)
  meta      Json?
  createdAt DateTime @default(now())

  @@index([slug])
  @@gate("2.5.5.6")                      // access control: R=VISITOR, C/U=ADMIN, D=OWNER
}

model users {
  id          Integer   @id
  account     accounts  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  accountId   Integer
  email       Text      @unique @email @lower
  name        Text?     @trim
  role        Role      @default(member)
  salary      Real?     @allow('read', auth().role == 'admin')   // field-level policy
  apiKey      Text?     @secret                                   // encrypted + guarded + audited
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
| `Integer` | `INTEGER` | `number` |
| `Real` | `REAL` | `number` |
| `Text` | `TEXT` | `string` |
| `Boolean` | `INTEGER` 0/1 | `boolean` (auto-coerced) |
| `DateTime` | `TEXT` ISO-8601 | `string` |
| `Json` | `TEXT` | `object` (auto-parsed) |
| `Blob` | `BLOB` | `Buffer` |
| `File` | `TEXT` JSON ref | stored in S3/R2/local via FileStorage plugin |
| `File[]` | `TEXT` JSON array | multiple files, each ref stored in S3/R2/local |
| `EnumName` | `TEXT` + CHECK | `string` |
| `Type[]` | `TEXT` JSON | `Array` (auto-parsed) |
| `Type?` | nullable | `null` when absent |

### Field attributes

```
@id                              primary key (auto-increment for Integer)
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
@encrypted(searchable: true)     HMAC-indexed encrypted equality search
@secret                          @encrypted + @guarded(all) + @log(auditDb)
@allow('read'|'write'|'all', expr)   field-level conditional visibility
@log(dbName)                     field-level audit log to a logger database
@keepVersions                    on File? / File[]: skip old S3 object cleanup on update
@accept("mime/type")             on File / File[]: validate content type before upload
@markdown                        semantic annotation — field contains Markdown (no validation)
@hardDelete                      force hard delete even on @@softDelete models
@from(relation, count: true)     derived count from a relation (not stored in DB)
@from(relation, sum: field)      derived sum/max/min/first/last/exists from a relation
@from(relation, count: true, where: "sql")  filtered derived field

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
@@gate("R.C.U.D")                level-based access control (see GatePlugin)
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

model pageViews {
  id        Integer  @id
  path      Text
  duration  Integer
  createdAt DateTime @default(now())
  @@db(analytics)
}

model apiRequests {
  method  Text
  path    Text
  status  Integer
  @@db(logs)     // append-only JSONL — no migrations, no schema changes
}
```

```js
// Single createClient — routes automatically
const db = await createClient({ path: './schema.lite' })

await db.pageViews.create({ data: { path: '/home', duration: 142 } })  // → analytics.db
await db.apiRequests.create({ data: { method: 'GET', path: '/', status: 200 } })  // → logs/
await db.auditLogs.findMany({ where: { model: 'users' } })  // → audit/ (auto-created by logger driver)
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
  id        Integer @id
  email     Text
  name      Text?
  accountId Integer
  @@external
}

// FTS5 virtual table managed by a third-party tool
model docs_fts {
  rowid   Integer @id
  title   Text
  body    Text
  @@external
  @@fts([title, body])
}

// Table owned by another migration tool (e.g. a legacy schema)
model legacy_audit_log {
  id        Integer  @id
  action    Text
  actorId   Integer
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
const posts = await db.posts.findMany({ include: { author: true } })

// @@external models are excluded from autoMigrate and litestone migrate create
// — Litestone will never emit CREATE TABLE, ALTER TABLE, or DROP for them
```

**Common patterns:**

A SQLite view is the most useful form — define the view in a JS migration, then query it through the ORM with full type safety:

```js
// migrations/20240101000000_create-active-users-view.js
export async function up(db) {
  await db.sql`
    CREATE VIEW IF NOT EXISTS active_users AS
    SELECT id, email, name, accountId
    FROM users
    WHERE deletedAt IS NULL
  `
}
```

```prisma
model active_users {
  id        Integer @id
  email     Text
  name      Text?
  accountId Integer
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
model posts {
  id        Integer  @id
  accountId Integer
  status    Text     @default("draft")

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
const posts = await userDb.posts.findMany()

// Returns ALL posts — policies bypassed
const all = await db.asSystem().posts.findMany()
```

**Policy expressions** support: `auth()`, `auth().field`, `now()`, comparison operators, `&&`, `||`, string/number/boolean literals, and `check(relatedModel, expr)` for relation-based checks.

---

## Access control — GatePlugin

Level-based access control. Assign levels 0–9, declare required levels per operation:

```prisma
model posts {
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
model users {
  ssn    Text  @encrypted                   // AES-256-GCM, guarded — asSystem() only
  email  Text  @encrypted(searchable: true)  // HMAC-indexed — equality WHERE works
  apiKey Text  @secret                       // @encrypted + @guarded(all) + @log(audit)
}
```

```js
const db = await createClient({ path: './schema.lite',
  encryptionKey: process.env.ENC_KEY,     // 64 hex chars = 32 bytes
})

// searchable: true allows WHERE on encrypted fields
await db.users.findFirst({ where: { email: 'alice@example.com' } })  // ✓ works
await db.users.findFirst({ where: { ssn: '123-45-6789' } })           // → always null (not searchable)

// Rotate encryption key
await db.$rotateKey(newKey)
```

---

## Query API

### Read

```js
db.users.findMany({ where, orderBy, limit, offset, include, select, withDeleted, onlyDeleted })
db.users.findMany({ where, distinct: true })                    // SELECT DISTINCT
db.users.findMany({ where, window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })
db.users.findFirst({ where, orderBy, include, select })
db.users.findUnique({ where, include, select })
db.users.findFirstOrThrow({ where })
db.users.findUniqueOrThrow({ where })
db.users.findManyAndCount({ where, orderBy, limit, offset, include, select })  // → { rows, total }
db.users.count({ where })                                                       // → number
db.users.exists({ where })                                                      // → boolean
db.users.aggregate({ where, _count, _sum, _avg, _min, _max })
db.users.groupBy({ by, where, having, orderBy, limit, offset, _count, _sum, _avg, _min, _max })
db.users.groupBy({ by, interval: { createdAt: 'month' }, fillGaps: true, _count, _sum })
db.users.query({ ...args })                                    // unified dispatcher — see below
db.users.search('query', { where, limit, offset, highlight, snippet })  // requires @@fts
db.users.findManyCursor({ where, limit, cursor, orderBy })              // O(log n) pagination
db.users.findMany({ where, recursive: true })                           // CTE tree (self-referential)
db.users.findMany({ where, recursive: { direction: 'ancestors', nested: true, maxDepth: 3 } })
```

### Write

```js
// Single-row ops — return the full row (with include/select applied)
db.users.create({ data, include, select })          // → TRow
db.users.update({ where, data, include, select })   // → TRow | null
db.users.upsert({ where, create: {...}, update: {...} })  // → TRow
db.users.restore({ where })                         // → TRow[]

// select: false — skip RETURNING, return null. Fastest write path.
// No benefit on @@log models (logging requires the row snapshot).
db.users.create({ data, select: false })            // → null
db.users.update({ where, data, select: false })     // → null

// Bulk ops — return { count: number } only, no row data
// Use single-row ops in a $transaction if you need the affected rows back
db.users.createMany({ data: [...] })                // → { count: number }
db.users.updateMany({ where, data })                // → { count: number }
db.users.upsertMany({ data, conflictTarget, update })  // → { count: number }
db.users.removeMany({ where })                      // → { count: number }
db.users.deleteMany({ where })                      // → { count: number }

db.users.remove({ where })      // soft delete if @@softDelete, else hard delete → TRow
db.users.delete({ where })      // always hard delete → TRow
db.users.optimizeFts()          // merge FTS5 segments — requires @@fts
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
db.posts.findMany({ orderBy: { author: { name: 'asc' } } })

// Two-hop
db.users.findMany({ orderBy: { company: { country: { name: 'asc' } } } })

// Mixed flat + relation
db.posts.findMany({ orderBy: [{ author: { name: 'asc' } }, { createdAt: 'desc' }] })

// Relation aggregate orderBy — sort by count/sum/avg/min/max of a hasMany or manyToMany
// Uses a correlated subquery — no row duplication, works on any table size
db.authors.findMany({ orderBy: { books: { _count: 'desc' } } })
db.authors.findMany({ orderBy: { books: { _sum: { price: 'desc' } } } })
db.authors.findMany({ orderBy: { books: { _max: { rating: 'desc' } } } })
db.authors.findMany({ orderBy: { tags:  { _count: 'asc' } } })   // manyToMany — _count only
```

Relation field orderBy (`belongsTo` only — single-row joins). Aggregate orderBy works on `hasMany` and `manyToMany`; `_sum`/`_avg`/`_min`/`_max` require `hasMany`. Both compose with `where`, `limit`, `offset`, `include`, and `select`.

### Raw SQL — `where: { $raw }`

For predicates the structured `where` builder can't express — `json_extract`, date arithmetic, `LIKE` with complex patterns, etc. Use the `sql` tagged template for safe parameter binding:

```js
import { sql } from '@frontierjs/litestone'

// Simple
db.products.findMany({
  where: { $raw: sql`price > IF(state = ${state}, ${minPrice}, 100)` }
})

// Mixed with structured where — ANDed together
db.orders.findMany({
  where: {
    status: 'active',
    $raw: sql`json_extract(meta, '$.tier') = ${3}`,
  }
})

// Composed inside AND / OR
db.users.findMany({
  where: {
    AND: [
      { accountId: 1 },
      { $raw: sql`DATEDIFF(next_review_dt, added_dt) <= ${30}` },
    ]
  }
})

// Works everywhere where: is accepted — findMany, findFirst, count, exists, update, updateMany...
const n = await db.products.count({ where: { $raw: sql`stock < ${10}` } })
```

The `sql` tag pulls interpolated values out as params and substitutes `?` placeholders — values are never concatenated into the SQL string. For simple parameterless expressions a plain string also works: `where: { $raw: 'deletedAt IS NULL' }`.

### Cursor pagination

```js
const page1 = await db.users.findManyCursor({ limit: 50, orderBy: { id: 'asc' } })
// → { items: [...], nextCursor: 'eyJ...', hasMore: true }

const page2 = await db.users.findManyCursor({
  limit: 50, orderBy: { id: 'asc' }, cursor: page1.nextCursor
})
```

### Transactions

```js
await db.$transaction(async tx => {
  const acct = await tx.accounts.create({ data: { name: 'Acme' } })
  const user = await tx.users.create({ data: { accountId: acct.id, email: 'a@b.com' } })
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
  model:     'users',
  operation: 'findMany',        // all ORM operations
  database:  'main',
  actorId:   'user_abc',        // ctx.auth?.id
  sql:       'SELECT * FROM "users" WHERE "status" = ? LIMIT ?',
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
await db.users.findMany()
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
function slug(text: Text): Text {
  @@expr("lower(trim(replace({text}, ' ', '-')))")
}

function fullName(first: Text, last: Text): Text {
  @@expr("COALESCE({first}, '') || ' ' || COALESCE({last}, '')")
}

model users {
  firstName   Text?
  lastName    Text?
  displayName Text  @fullName(firstName, lastName)  // STORED generated column
}

model posts {
  title Text
  slug  Text  @slug(title)   // same function, different model
}
```

Generated columns are `STORED` and indexable:

```js
await db.posts.findMany({ where: { slug: 'hello-world' } })
await db.users.findMany({ orderBy: { displayName: 'asc' } })
```

---

## @sequence — per-scope auto-increment

```prisma
model quotes {
  id          Integer @id
  accountId   Integer
  quoteNumber Integer @sequence(scope: accountId)
}
```

Each account gets its own counter starting at 1:

```js
const q = await db.quotes.create({ data: { accountId: 5, ... } })
// q.quoteNumber → 1  (first quote for account 5)
String(q.quoteNumber).padStart(4, '0')  // → '0001'
```

---

## @from — derived relation fields

Computed aggregates and lookups from related models — evaluated at query time, not stored.

```prisma
model accounts {
  id           Integer  @id
  name         Text
  userCount    Integer  @from(users, count: true)
  revenue      Real     @from(orders, sum: amount)
  lastOrderAt  DateTime @from(orders, last: true)   // last related object
  hasOverdue   Boolean  @from(invoices, exists: true, where: "due_at < date('now') AND paid = 0")
}
```

Derived fields are read-only — they appear in query results automatically. Supported aggregations: `count`, `sum`, `max`, `min`, `first`, `last`, `exists`. All accept an optional `where` SQL fragment for filtering.

---

## aggregate() and groupBy()

```js
// Simple aggregate
const stats = await db.orders.aggregate({
  where:  { status: 'completed' },
  _count: true,
  _sum:   { amount: true },
  _avg:   { amount: true },
  _min:   { amount: true },
  _max:   { amount: true },
})
// → { _count: 142, _sum: { amount: 98432.50 }, _avg: { amount: 693.19 }, ... }

// COUNT(DISTINCT field)
db.orders.aggregate({ _count: { distinct: 'accountId' } })

// string_agg / group_concat
db.orders.aggregate({
  _stringAgg: { field: 'status', separator: ', ', orderBy: 'status' }
})
// → { _stringAgg: { status: 'paid, pending, refund' } }

// Named aggregates — any _-prefixed key with an agg fn spec
// Supports FILTER (WHERE ...) for single-pass pivot queries
const pivot = await db.orders.aggregate({
  _count:       true,
  _countPaid:   { count: true,   filter: sql`status = 'paid'` },
  _countRefund: { count: true,   filter: sql`status = 'refund'` },
  _sumPaid:     { sum: 'amount', filter: sql`status = 'paid'` },
  _avgPaid:     { avg: 'amount', filter: sql`status = 'paid'` },
})
// → { _count: 100, _countPaid: 72, _countRefund: 8, _sumPaid: 3200, _avgPaid: 44.4 }

// Group by field
const byStatus = await db.orders.groupBy({
  by:      ['status'],
  _count:  true,
  _sum:    { amount: true },
  having:  { _count: { gt: 5 } },
  orderBy: { _count: 'desc' },
})

// Per-group filtered stats
await db.orders.groupBy({
  by:           ['accountId'],
  _count:       true,
  _countPaid:   { count: true,   filter: sql`status = 'paid'` },
  _sumPaid:     { sum: 'amount', filter: sql`status = 'paid'` },
})

// Time-series bucketing with gap fill
const monthly = await db.orders.groupBy({
  by:       ['createdAt'],
  interval: { createdAt: 'month' },   // year | quarter | month | week | day | hour
  where:    { createdAt: { gte: '2024-01-01', lte: '2024-12-31' } },
  fillGaps: true,   // default true when interval present — CTE-based, no missing buckets
  _count:   true,
  _sum:     { amount: true },
})
// → [{ createdAt: '2024-01', _count: 18, _sum: { amount: 4200 } }, ...]

// findManyAndCount — single query, total for pagination
const { rows, total } = await db.posts.findManyAndCount({
  where: { status: 'published' },
  limit: 20, offset: 40,
})
```

---

## Recursive tree queries

Self-referential models (a field referencing the same model) automatically support CTE-based tree traversal:

```prisma
model categories {
  id       Integer     @id
  name     Text
  parent   categories? @relation(fields: [parentId], references: [id])
  parentId Integer?
  children categories[]
}
```

```js
// All descendants of node 5
const tree = await db.categories.findMany({
  where:     { id: 5 },
  recursive: true,             // direction: 'descendants' (default)
})

// All ancestors (path to root)
const breadcrumb = await db.categories.findMany({
  where:     { id: 42 },
  recursive: { direction: 'ancestors' },
})

// Nested tree structure (children array on each node)
const nested = await db.categories.findMany({
  where:     { parentId: null },
  recursive: { direction: 'descendants', nested: true, maxDepth: 3 },
})

// Multiple self-relations — disambiguate with via:
const reports = await db.employees.findMany({
  where:     { id: 1 },
  recursive: { direction: 'descendants', via: 'reports' },
})
```

---

## Window functions

Window functions add computed columns to each row based on a set of surrounding rows — rankings, running totals, moving averages, period comparisons. Pass a `window` object to `findMany`:

```js
db.orders.findMany({
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
  return db.orders.query(req.query)
})

// → findMany (no aggregate keys, no by)
db.orders.query({ where: { status: 'paid' }, orderBy: { id: 'asc' }, limit: 20 })

// → aggregate (has _count/_sum/etc, no by)
db.orders.query({ _count: true, _sum: { amount: true }, where: { accountId: 1 } })

// → groupBy (has by)
db.orders.query({ by: ['status'], _count: true, where: { accountId: 1 } })

// → findMany + window
db.orders.query({ window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })

// → aggregate (named agg with FILTER)
db.orders.query({ _countPaid: { count: true, filter: sql`status = 'paid'` } })
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
  const posts = await db.posts.findMany({ where: { slug: null } })
  for (const post of posts) {
    await db.posts.update({
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

```prisma
model users {
  fullName Text    @computed
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
model users {
  avatar  File?              // single file — upload on create/update, delete on row delete
  resume  File?  @keepVersions  // keep old S3 object on update
  photos  File[]             // multiple files — array of refs stored as JSON
  docs    File[] @accept("application/pdf,application/msword")  // type-validated
  banner  File?  @accept("image/*")   // images only
}
```

```js
// Single file
const user = await db.users.update({ where: { id: 1 }, data: { avatar: file } })
fileUrl(user.avatar)                              // → 'https://cdn.example.com/...'

// Multiple files
const user2 = await db.users.update({ where: { id: 1 }, data: { photos: [file1, file2] } })
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
  factories: { users: UserFactory },  // explicit factories (override auto-generated)
  data: async (db) => {          // seeder fn runs after tables created
    await db.accounts.create({ data: { id: 1, name: 'Test Co' } })
  },
})
```

### Factory

```js
class UserFactory extends Factory {
  model = 'users'

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
```

### factoryFrom — zero-config

```js
const { schema } = parse(schemaText)
const users = factoryFrom(schema, 'users', db)
const admin = await users.state({ role: 'admin' }).createOne()
```

### generateFactory — schema-derived definition

```js
const defFn = generateFactory(schema, 'users')
// Returns a definition(seq, rng) function that generates valid data from field types + constraints
// @email → 'users1@test.com', @gte(0) @lte(100) → 50, Text? → null, etc.
```

### generateGateMatrix — permission test cases

```js
const matrix = generateGateMatrix(schema, 'posts')
// → [{ op: 'read', level: 1, label: 'VISITOR', expect: 'allow' }, ...]

for (const { op, level, label, expect: expected } of matrix) {
  test(`${op} as ${label} → ${expected}`, async () => { ... })
}
```

### generateValidationCases — constraint boundary data

```js
const { valid, invalid, boundary } = generateValidationCases(schema, 'leads')

// valid   — a complete valid record (correct by construction)
// invalid — one failing case per constraint: { field, value, rule, expect: 'fail', message }
// boundary — boundary values that should pass: { field, value, rule, expect: 'pass' }

test('valid data passes', async () => {
  await db.leads.create({ data: valid })
})

for (const c of invalid) {
  test(`${c.field}: ${c.rule} rejects ${c.value}`, async () => {
    await expect(db.leads.create({ data: { ...valid, [c.field]: c.value } }))
      .rejects.toThrow(c.message)
  })
}
```

### Teardown

```js
await truncate(db, 'posts')    // hard-delete all rows in one table
await reset(db)                // hard-delete all tables in FK-safe order
await factory.truncate()       // instance method shorthand
```

### Seeder.once — idempotent seed blocks

```js
class BaseSeeder extends Seeder {
  async run(db) {
    await this.once(db, 'base-v1', async () => {
      await db.accounts.createMany({ data: [...] })
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
const rows = await db.sql`SELECT * FROM users UNION ALL SELECT * FROM archive.users`
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
  --only=users,posts                 emit types for specific models only
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

Global flags:
  --config=<path>       litestone.config.js
  --schema=<path>       .lite file
  --db=<path>           database file
  --migrations=<dir>    migrations directory
  --port=<n>            studio port (default 5001)
```

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
