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
    encryption.js  — @encrypted/@hashed primitives + comparisonEncoderFor():
                     the one owner of "how a value becomes the bytes a column
                     holds", asked by both a where and a policy predicate

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
    jsonl-index.js — the SQLite sidecar beside a .jsonl, and the LOCK on that file

  import/          — a foreign schema → .lite. Four readers (prisma, rails, sql,
                     frappe) + the tier table that grades what the reading could
                     not express. Exported at `@frontierjs/litestone/import`;
                     `litestone import` is a shell over it and the corpus fixtures
                     are regenerated through it, so there is one implementation

  tools/           — dev/ops utilities, never imported by app code
    cli.js         — litestone CLI (all commands)
    studio.html    — browser-based Studio UI
    repl.js        — the console prompt: eval loop, completion, history
    ddl-snapshot.js — renderDdlSnapshot(): the emitted DDL as a committed file
    introspect.js  — generateLiteSchema(): reverse-engineer DB → .lite
    typegen.js     — generateTypeScript() → .d.ts
    retention.js   — JSONL/logger retention pruning
    replicate.js   — Litestream wrapper: continuous WAL replication

  transform/       — SQLite transformation pipeline — CLI-only, not ORM
    framework.js   — $, params, preview, execute, introspectSQL
    runner.js      — pipeline execution engine
    split-worker.js — Bun worker for parallel shard execution
    run.js         — standalone entrypoint (used by CLI)

  release.js       — the release surface + classifyPivot(): can N-1 and N serve
                     one database at once? Never imported by production code
  tenant.js        — createTenantRegistry()
  core/tenancy.js  — resolveTenancy() + tenantFrom(): what a `tenancy { }` block
                     MEANS, resolved once. Four readers — the registry, the CLI,
                     Studio, Junction — and none of them may answer differently
  testing.js       — makeTestClient, Factory, Seeder, factoryFrom, generateFactory, etc.
  seeder.js        — Factory, Seeder, runSeeder (re-exported from testing.js)
  jsonschema.js    — generateJsonSchema()
  index.js         — public API re-exports
  index.d.ts       — static TypeScript declarations

references/          — the catalogue: one .lite per common model, heavy /// notes,
                       parsed by test/references.test.ts. NOT shipped, imported or
                       installed by anything — a shape you read before writing a
                       model half a dozen apps have already written differently.
                       Each file is self-contained (a @relation to a model it does
                       not declare is two parse errors), so it carries the foreign
                       key COLUMN and leaves the relation to the installing app

test/
  litestone.test.ts  — 1191 tests (plus cli-smoke, elegance-fixes,
                       migrations-fixes, nullable-optional: 1289 total)
  scale.test.ts      — the fixture below, parsed and built. Two assertions
  import.test.ts     — `litestone import`: the tiers, the marker, and the guard
                       that every `gap('…')` literal in the four readers is
                       graded. That guard found 18 refusals the seven corpus
                       schemas had never fired

  fixtures/scale/    — openmrp.lite: 188 models, ~1,900 columns, ~300 relations,
                       derived from the MySQL schema of a real manufacturing ERP.
                       The apps in this repo top out near 40 models, so a rule
                       quadratic in model count, or two features deriving one
                       index name, is invisible without it

bench/
  scale-schema.mjs   — the same fixture, timed: parse, DDL, JSON Schema,
                       autoMigrate, a second boot, and the diff proving the
                       second boot changed nothing. Asserts nothing on purpose
```

---

## Schema DSL (`.lite`)

### Imports

```
import "./models/users.lite"                       // a path, relative to this file
import "@frontierjs/auth/schema.lite"              // a package, resolved through node
import "@frontierjs/auth/schema.lite" into auth    // …and land its models in `auth`
```

A package specifier resolves the way an ESM import would, so the package's
`exports` decides what is importable. `into` names the database everything that
import brings in lands in; the nearest one wins (an inner `into` beats an outer
one) and any of them beats a `@@db` written in the imported file, since only the
importing app knows what its own databases are called.

Resolved by `parseFile`, and by `createClient` through it — not by `parse`, which
takes text with no file behind it.

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

### Tenancy block

At most one per schema, and it may not arrive through an import — only the app
knows what its own tenants are. See § Tenancy below.

```
tenancy {
  strategy database | row
  dir      "./tenants"              // database only; env() accepted
  registry "./tenants-registry.db"  // database only
  maxOpen  100                      // database only
  key      env("TENANT_KEY")        // database only — a value, never a path
  column   workspaceId              // row only, required
  claim    workspaceId              // row only; default: the column's own name
  resolve  subdomain | header("X-Tenant-Id") | claim(workspaceId)
}
```

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
@unique(global)                  …and under `tenancy { strategy row }`, one that is deliberately
                                 unique across the WHOLE INSTALLATION rather than per tenant. Only
                                 meaningful there, and only to silence the warning: a unique on a
                                 tenant-scoped model whose columns carry neither the tenant column
                                 nor a key reaching a scoped model is reported, because two tenants
                                 then cannot hold the same value and the refusal names it to the
                                 second. A token or a public subdomain is legitimately global
@default(value)                  literal, now(), uuid(), ulid(), cuid(), nanoid()
@default(auth().field)           stamp from ctx.auth at write time (runtime-only)
@default(fieldName)              copy sibling field value on create
@map("col_name")                 custom DB column name
@updatedAt                       set to now() on create and on every UPDATE — any
                                 field name, however many. Written by the CLIENT,
                                 from the clock it was given; a raw SQL UPDATE
                                 stamps nothing. See SQLite gotchas
@updatedBy                       stamp ctx.auth.id on every UPDATE
@updatedBy(auth().field)         stamp custom auth field on every UPDATE
@createdBy                       stamp ctx.auth.id on CREATE — a stamp, not a
                                 default, so the principal beats a caller-supplied
                                 value; skipped entirely when ctx.auth is null
@createdBy(auth().field)         stamp custom auth field on CREATE
@scale(n)                        exact fixed-point: an INTEGER column with the point
                                 n places in. What a caller sends and reads back
                                 is the whole number of MINOR units — 1299, not
                                 12.99. At most 9 places, and bounded at both ends
                                 by a CHECK — see SQLite gotchas
@money(USD)                      @scale with the places DERIVED from the currency
@money(field: currency)          the code is on the row; no static scale
@money                           the app's default currency
@big                             the OPPOSITE end: an Int whose values use all 64
                                 bits, crossing as a STRING of digits in and out.
                                 Storage stays INTEGER, so ordering, a range
                                 filter, an index and AUTOINCREMENT are numeric.
                                 Refused beside @scale/@money — see SQLite gotchas
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
@system                          the application writes it, its caller does not. Readable
                                 by anyone; refused by name on every write unless the
                                 column is named on the call — `update({ …, system: ['col'] })`
                                 — or asSystem(). Reaches the client as `readOnly` and is
                                 never in create-mode `required`
@transient                       accepted on the wire, stored nowhere — no column, no DDL,
                                 no audit entry, never in a result. The API validates it
                                 and lifts it onto ctx.transients; a value reaching this
                                 client is refused by name. Emitted `writeOnly` into the
                                 create/update JSON Schema and absent from the read modes
@guarded                         system-context column — stripped from every read, refused
                                 on every write, and refused in a where/orderBy/distinct/
                                 cursor, unless asSystem()
@guarded(all)                    the same; an explicit select cannot unlock the read
@encrypted                       AES-256-GCM at rest — hidden from a non-system read,
                                 and writable by a non-system caller
@encrypted(deterministic: true)  IV derived from the value — equality search AND readable
@hashed                          HMAC-SHA256, one-way — matchable, never readable, not rotatable
@secret                          @encrypted + @guarded(all) + @log(audit) + $rotateKey support
@secret(rotate: false)           same but excluded from key rotation — and therefore
                                 unreadable after one; $rotateKey refuses while one exists
@allow('read'|'write'|'all', expr)  field-level access policy — a PREDICATE, compiled
                                 into SQL both ways (FJS-D129). A read predicate is AND-ed
                                 outside the caller's own where, so a column they may not
                                 read cannot be filtered or sorted on; a write predicate is
                                 the WHEN of a CASE in the SET, so it reads the STORED row.
                                 Refused through a relation. On CREATE the payload IS the
                                 row, so that half stays a JS evaluation of it
@log(dbName)                     log reads/writes to a logger database
@keepVersions                    on File? fields: skip old S3 object cleanup on update
@computed                        derived field — implement in computed.js, not stored in DB
@derived(expr)                   a value computed in SQL from this row's own columns, in the
                                 @@allow expression language — so unlike @computed it can be
                                 FILTERED and SORTED by. Static: `now()` is allowed and emits
                                 SQLite's clock, `auth()`/`check()` are refused (that is @@scope).
                                 Reaches the client as readOnly + `x-litestone-kind: 'derived'`,
                                 plus `x-litestone-volatile: 'clock'` when it reads the clock —
                                 a FLAG, never the expression. The declared type is checked
                                 against the branches at startup
@generated("sql expr")           SQL-generated column
@generated(`{a} {b}`)            the SAME attribute in its other language, and the QUOTE says
                                 which: double quotes are SQL, BACKTICKS are a template — the
                                 string the column produces. `{name}` is a column in both; the
                                 delimiter only changes what the text around the braces is.
                                 **A NULL column takes the separator beside it** — uniform gaps
                                 compile to concat_ws, mixed or outer literals to a coalesce
                                 chain each field vanishes with. The hand-spelled coalesce
                                 version leaves a DOUBLE SPACE where a middle name is missing,
                                 which is why the second language exists. A backtick is its own
                                 token, so one anywhere that wants a plain string is refused
@hardDelete                      on a relation field: hard-delete children during @@softDelete(cascade)
@keep                            on a relation field: these children stay LIVE when the parent is
                                 soft-deleted, and so does everything below them. The third fate,
                                 beside cascade and @hardDelete — a receipt outliving the customer
                                 record it names. Also what silences the footgun warning below
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
@minItems @maxItems @uniqueItems array validators (also: the value must be an array,
                                 and Int[]/String[] elements must be of that type)
@values(SetName)                 the column's legal values come from a declared `valueset`.
@values(SetName, open)           A second declaration BESIDE @relation, never instead of it —
@values(SetName, suggested)      storage is a foreign key, this is resolution. Strength is on
                                 the BINDING because one list is legitimately enforced on one
                                 column and merely offered on another: `required` (unstated)
                                 refuses a value outside the set, `open` accepts it AND creates
                                 the row, `suggested` enforces nothing. Checked at the Data
                                 boundary through the CALLER'S OWN accessor, so a caller may
                                 only pick what they can read and the source model's own
                                 @@gate/@@allow decide who may grow an `open` set
@from(Model, count: true)        derived count from relation — first arg is the MODEL, not the
@from(Model, sum: field)         relation field. sum/max/min take a field; count needs Int,
@from(Model, last: true)         exists needs Boolean, first/last are typed Model? (whole row)
@from(Model, count: true, where: "sql", orderBy: field)  filtered / ordered derived field
@from(Model, count: true, withDeleted: true, withTemplates: true)  opt back into the
                                 target's soft-deleted / template rows. By DEFAULT a @from
                                 reads the target the way the target is read — both out
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
@@id([col1, col2])               the row's identity IS the tuple. Sugar over `@id` on each
                                 named field, so every reader already handles it — what it
                                 adds is the key's column ORDER, which is prefix-matched and
                                 which field declaration order is a different fact about.
                                 Refused beside a field-level @id, and over a nullable field,
                                 a relation, an array or a virtual column
@@unique([col1, col2])           composite unique constraint. A nullable member is a PARSE
                                 ERROR — two NULLs never compare equal, so the rows that
                                 leave it unset are all distinct to the index
@@unique([a, b], nullsDistinct: true)
                                 …and this is how a schema says it meant that. SQL's own
                                 word for SQLite's behavior; emits identical DDL. Single
                                 @unique over an optional column is untouched
@@unique([a, b], global: true)   the tuple form of @unique(global) — see it above
@@unique([a], where: expr)       conditional uniqueness — the constraint holds over the rows
                                 the predicate admits and says nothing about the rest. *At
                                 most one OPEN row per parent* is `where: effectiveTo == null`.
                                 A predicate cannot ride a table constraint, so this parses to
                                 `partialUnique` and emits a standalone CREATE UNIQUE INDEX;
                                 it migrates by one DROP and one CREATE where the plain form
                                 rebuilds the table, and it does NOT satisfy a one-to-one.
                                 May compare against a VALUE, which @@index(where:) refuses —
                                 enforcement never consults the planner — and the literals are
                                 inlined, because SQLite prohibits a bound parameter there.
                                 `now()`/`auth()` refused by name. Not combinable with
                                 nullsDistinct. @@softDelete's clause is NOT ANDed in
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
@@label(fullName)                which column identifies a row to a person — what a
                                 picker SHOWS for a foreign key. FHIR calls it `display`.
                                 A field NAME, not a caption (that is @label on the field).
                                 Must be a String column the database can order and match:
                                 a relation, an array, an enum, a non-String, @computed,
                                 @transient, @guarded, @encrypted, @hashed and @omit(all)
                                 are each refused BY NAME at parse. A @generated one is the
                                 case it exists for. Undeclared, the client guesses from
                                 eight conventional column names and says that it guessed
@@hasTemplates                   categorical definition-vs-instance: adds isTemplate
                                 Boolean @default(false); every read AND write excludes
                                 templates unless given withTemplates/onlyTemplates
@@hasTemplates(field: "isPreset")  same, under a name you choose
@@scope(name, expr)              a named predicate in the @@allow expression language,
                                 asked for as `where: { $scope: 'name' }`. Predicate-only —
                                 no value, no property in the generated schema. Several
                                 names AND; a disjunction goes INSIDE one scope. The name is
                                 looked up in the declared table, never interpolated, and
                                 `db.$scopes(accessor)` publishes the list `$checkWhere` uses
@@external                       table managed outside Litestone (skip DDL/migrations)
@@allow('read'|'create'|'update'|'delete'|'write'|'all', expr)
@@allow('read'|..., expr, "custom error message")
@@deny('read'|'create'|..., expr)
@@deny('read'|..., expr, "custom error message")
@@log(dbName)                    model-level audit log: all writes fire a log entry
@@tenant(none)                   under `tenancy { strategy row }`: this model spans tenants
@@tenant(column: "accountId")    …or is scoped by a column of its own
```

### `@@softDelete` and `@hardDelete`

Without `@@softDelete(cascade)`, soft-deleting a parent row leaves FK children live — this is almost always a bug. The parser emits a warning when a `@@softDelete` model has a `hasMany` relation to another `@@softDelete` model without cascade.

`@hardDelete` on a relation field overrides cascade behavior for that specific child:

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

`@keep` is the third answer to the same warning, and the one that used to have no
spelling: the children stay live on purpose. Without it, the only way to stop the
parser warning about children left live was to stop leaving them live — and *the
customer goes, the receipts stay* is a shape any app holding financial records
has. It covers the whole subtree beneath that child, and says nothing about
removing the child directly.

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
db.user.restore({ where })                                   // → row[] (may be empty)
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

// The escape hatch `where` has. The fragment is the whole ORDER BY tail,
// direction included; a plain string is refused (it is how an injected one
// would arrive). Not available with a cursor or on groupBy.
orderBy: { $raw: sql`CASE WHEN "snoozedUntil" > ${now()} THEN 1 ELSE 0 END ASC, "dueAt" ASC` }

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
import { sql, now } from '@frontierjs/litestone'

db.product.findMany({ where: { $raw: sql`price > IF(state = ${state}, ${min}, 100)` } })
db.order.findMany({ where: { status: 'active', $raw: sql`json_extract(meta, '$.tier') = ${3}` } })
db.user.findMany({ where: { AND: [{ accountId: 1 }, { $raw: sql`score > ${50}` }] } })

// The clock. `datetime('now')` is REFUSED by name — it cannot match a stored
// DateTime. Modifiers are bound, not spliced.
db.task.findMany({ where: { $raw: sql`dueAt < ${now()} AND completedAt IS NULL` } })
db.task.findMany({ where: { $raw: sql`startedAt > ${now('-7 days')}` } })
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
db.$inTransaction         // is one open on this connection right now? Same answer
                          // on every flavor — one write connection, one counter.
                          // For a write whose meaning depends on rolling back
                          // with everything else (junction's outbox row)
db.$attach('./other.db', 'other')
db.$detach('other')
db.$rotateKey(newKey)      // re-encrypt all @secret(rotate: true) fields; returns per-model stats
await db.$audit({ operation: 'login.failed', model: 'User', records: [id],
                 actorId: id, meta: { reason: 'bad-password' } })
                           // the ONE owner of putting a row in the audit trail.
                           // For what @@log(audit) cannot see: an event that
                           // performs no write, or one whose asSystem() write
                           // names no actor. THROWS — unlike @@log, the record
                           // is what the caller asked for. actorId defaults to
                           // this client's principal; a system context has none.
db.$capabilitiesFor(user)
                           // { held, unknown, byModel } — what can this person do.
                           // Fourth sibling of the three above and the same
                           // contract: takes its subject as an ARGUMENT, and every
                           // flavor answers identically for the same one. `unknown`
                           // is the half that earns it — a capability is a
                           // reference, so a rename leaves the OLD string sitting in
                           // every Role row; this is what shows you the data
                           // migration that did not run. Accepts a principal or the
                           // bare list, since the union of somebody's roles exists
                           // before a principal does
db.$readAs('order', row, principal)
                           // the row as that principal would have read it, or
                           // null. FIFTH sibling, and the one that exists
                           // because a BROADCAST IS NOT A SELECT: @@allow
                           // compiles into a WHERE, so a row reaching a caller
                           // through a query is filtered by construction and
                           // one reaching them through a WS frame was filtered
                           // by nothing (FJS-631). Gate, then row policy, then
                           // that principal's own field policies. No query —
                           // the row is in hand, so a @from/@computed on it is
                           // the writer's. Fails closed: an undecidable policy
                           // throws and a throw refuses
db.$readGrading('product') // 'open' | 'graded' — whether $readAs can ever
                           // answer anything but the row it was given. Gate 0,
                           // no read policy, no field policy → open, so a
                           // catalogue costs nothing. An UNKNOWN accessor is
                           // 'graded': the other siblings answer {} because
                           // *I cannot judge this* is not *this is wrong*, and
                           // here it is a permission, so it falls the other way
db.$protectedFields('secret')
                           // { data: 'encrypted' } — which columns must never be
                           // written down in plain text, and which protection
                           // each carries ('guarded' | 'encrypted' | 'hashed').
                           // For an APPLICATION keeping a trail of its own:
                           // @@log(audit) redacts these in its own JSONL, and an
                           // app writing its own audit table had nothing to ask.
                           // Same contract as $checkWhere — unknown accessor is
                           // {}, every flavor of client answers the same
db.$softDelete             // { ModelName: boolean } — which models hide a removed
                           // row rather than destroying it. A COPY, and on every
                           // flavor of client: the live map is what every read
                           // filters against, and junction holds a $setAuth one
db.$schema                 // parsed schema object
db.$plugins                // installed plugin names, in run order — every client
                           // flavor. A gated schema auto-installs GatePlugin, so
                           // what you passed is not necessarily what is running
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
check(field)              — delegates to the related model's ROW POLICY and to
                            nothing else. A parent held only by a @@gate or a
                            capability grid delegates as unrestricted — both are
                            enforced a tier above any compiled predicate — so
                            createClient warns, naming what the parent is
                            actually protected by. A cycle (a mutual pair, or a
                            self-relation checking its own parent) is REFUSED
                            there: it compiles to a predicate no row satisfies,
                            which admits only rows whose FK is NULL and reads
                            like a filter working (`FJS-636`).
field == value  field != value  field > value  field >= value  field < value  field <= value
value in list             — membership. The list is ALWAYS the right operand:
                            `auth().id in memberIds` (an array column),
                            `ownerId in auth().teamIds` (a list on the principal),
                            `status in ['draft', 'review']` (written literally).
                            An array column compiles to the json_each EXISTS a
                            `where: { col: { has } }` produces; the other two to
                            `IN (?, …)`, and an empty list admits nothing.
                            What the schema can refuse is refused at startup
cond ? a : b              — a value chosen by a condition. Looser than `||` and
                            RIGHT-associative, so `a ? x : b ? y : z` nests into
                            the else. A parenthesised group is an operand on
                            either side of a comparison. In BOTH compilers —
                            CASE WHEN in SQL, `?:` in JS
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

The expression is checked at startup by the same walk `@@allow` and `@@scope`
run — a column that is not on the model and a claim the principal cannot carry
are each refused by name, naming the operation and the field (`FJS-667`). It
fails CLOSED, so an ungraded typo strips the column from every row and reads as
the policy working strictly.

---

## Encryption keys

A stored value names its key: `v2.<kid>.<payload>`, kid = a domain-separated
HMAC of the key truncated to 8 hex (`FJS-714`, ruled `FJS-D183`). An unknown kid
still tries the ring — GCM's tag is the authority, the kid is only the order.

`createClient({ previousEncryptionKeys: [...] })` is a READ-only ring. The old
key stays on it after `$rotateKey`, so a rotation that crashed between two
databases (it is one transaction PER DATABASE) is readable and resumable.

Three traps, all closed and all worth knowing:

  the operand is widened  a deterministic encoding is a function of the KEY, so
                          a filter is encoded under every key on the ring — else
                          a not-yet-rotated row silently matches nothing
  the v1 twin is emitted  the payload is BYTE-IDENTICAL across versions, so a
                          pre-upgrade `v1d.<p>` would not match `v2d.<kid>.<p>`.
                          No suite here can see this: they all build a fresh db
  a caller sends none     a ciphertext-shaped value from a non-system caller is
                          refused by name (`FJS-715`); a system write may carry
                          one and it is skipped only where it VERIFIES

A decrypt that fails **raises** (`FJS-716`). The one column that degrades is
`@secret(rotate: false)` — a loss the schema declares.

---

## A bulk write and the state machine

`updateMany` and `upsertMany`'s `update:` half **refuse a transitions-typed
column by name** — `BulkTransitionError`, 400 (`FJS-671`, ruled `FJS-D182`).
There is no `from` state to grade, because a bulk write matches rows without
reading them, and the skip took the per-move `@gate` and the `@system` marking
with it: measured, a level-4 caller made a `@gate(5)` move, a `@system` move and
an undeclared move through the bulk verb.

400 rather than 403 — no level and no grant answers it, because the VERB is
wrong rather than the caller. Every other column stays bulk-writable in the same
call, which is `FJS-044`'s power tool kept rather than overturned; the insert
half of `upsertMany` is a create, has no from-state, and is untouched.
`asSystem()` still writes it and warns, because `update()` announces its bypass
through `emitTransitionEvent` and a bulk write reaches none.

---

## What `auth().x` may name

Refused at client build unless the claim is one of four things (`FJS-666`, ruled
`FJS-D181`):

  the framework's eight   `id` · `capabilities` · and the six `FrontierGateGetLevel`
                          reads — `role` `isAdmin` `isOwner` `isSystemAdmin`
                          `verifiedAt` `activatedAt`. A standing is not a column
  the `@@auth` model      its own field names, which is what `sessionFields` carries
  `tenancy { claim }`     the one claim the schema declares
  `createClient({ claims })`  a claim resolved PER REQUEST — on no row, in no schema

**It grades only when there is a set.** No `@@auth` and no `claims:` means
nothing to compare against, and that silence is announced once per distinct set
of names rather than assumed. `claims: []` is a statement; absent is silence.

**An absent claim is UNKNOWN and both interpreters read it that way** (`FJS-668`):
an `@@allow` holds only on TRUE, an `@@deny` fires on TRUE and UNKNOWN alike,
which is `(allows) AND NOT (denies)` on both sides. `x == null` is exempt and
answers a boolean — that is how the language spells `IS NULL`, and it is the
only way to write *the caller carries no such claim*.

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

    // Declaring the inputs narrows the SELECT to them. The row handed to a
    // declared fn carries only those names, and reading anything else throws.
    initials: {
      needs:   ['firstName', 'lastName'],
      compute: row => `${row.firstName[0]}${row.lastName[0]}`,
    },

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
autoMigrate(db, parsed, { acceptDataLoss: true })        // …including a change that drops a column
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

**More than one process writes it, and the companion index's write transaction is
what serialises them** (`FJS-D180`, `FJS-665`). A byte offset cannot be computed
before the append or recovered after it, so `create`/`createMany` hold
`BEGIN IMMEDIATE` on `<path>/<model>.jsonl.index.db` across `stat`+`append`, and
the index row naming the offset commits with it. A transaction rather than a
lockfile: the OS drops a dead process's file locks and a lockfile has no answer
for a writer that dies holding one.

**Two rules the sidecar depends on and neither is optional.** It is in WAL, which
is what makes taking the lock affordable — measured, 8 writers on a rollback
journal killed 2 of them and dropped 12 rows with a worst insert of 5,007 ms.
And **nothing may unlink it**: an unlink leaves `-wal`/`-shm` behind and the next
write then answers `ok` into an inode with no directory entry, where a rollback
journal answers `SQLITE_READONLY_DBMOVED`. Compaction rebuilds the index instead,
holding the lock across its READ as well as its write — locking the write alone
leaves the window and widens it.

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

**A jsonl/logger retention pass reads the FIRST line and stops if it is inside the window.** An append-only log is oldest-first, so a fresh first line means every line is fresh — the right optimization for a check that runs on every boot over a file that grows for the life of the deployment. What it costs is a probe: append an old row to the END and the pass returns `null`, having read nothing, so `$retain()` answers `[]` and the job that called it reports success while removing nothing. A test planting an old row has to plant it where an old row would actually be. The companion `.index.db` holds byte offsets and is DELETED by a compaction that rewrites the file, then rebuilt lazily — so anything rewriting that file by hand owes the same removal.

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
litestone studio [--port=8502]
litestone repl [--as <who|Model:who>] [--level <0-9>] [--gate <path[#export]>]
litestone doctor
litestone types [out.d.ts] [--only=User,Post] [--audience=client|system] [--augment=junction]
litestone seed [SeederClass]
litestone seed run [name] [--db=main] [--force]
litestone introspect <db> [--out=schema.lite] [--report=<path>] [--strict] [--no-camel]
litestone import <path> [--from=prisma|rails|sql|frappe] [--out=<path>] [--report=<path>] [--strict]
litestone transform config.js [--preview] [--dry-run]
litestone explain [@word] [--visibility] [--json]        # the language, no schema needed
litestone catalog --snapshot [--check]                   # the language surface, committed
litestone catalog --reference [--check]                  # docs/reference.snapshot.md, the A-Z page
litestone advise [--json]                                # legal-and-wrong, plus legal-and-MISSING
litestone jsonschema [--out=./schemas/] [--format=flat]
litestone jsonschema --snapshot [--check] [--stdout] [--out=<path>]
litestone access [--check] [--json] [--stdout] [--out=<path>]
litestone access --from=<ref|path> [--strict] [--json]   # the permission diff
litestone ddl [--check] [--stdout] [--pluralize] [--out=<path>]
litestone release [--from=<ref|path>] [--strict] [--check] [--json] [--out=<path>]
litestone replicate config.js
litestone backup [dest] [--vacuum]
litestone optimize [table]
litestone tenant list|create|delete|migrate
```

---

## Litestream replication

Schema-driven, like `backup` — every declared **SQLite** database, one replica
each at `<url>/<name>`. jsonl/logger have no WAL and cannot be replicated; they
are named and skipped. **Refuses litestream below v0.5** (0.3.x cannot parse
STRICT tables and loops forever without exiting, so `pgrep` reports healthy
against an empty replica). `LITESTREAM_BIN` overrides the lookup.

**There is no `litestone restore`, and the asymmetry is the trap** (`ISSUES.md`
`FJS-552`): the outbound side reads the schema and covers every database, while
coming back is `litestream restore -o ./main.db <url>/<name>` typed once per
SQLite database plus a directory copy for the jsonl/logger ones. A two-database
app that restores `main` alone starts, and looks fine. `docs/replication.md`
§ Restoring is the checklist until the command exists.

```bash
litestone replicate --schema db/schema.lite --url s3://mybucket/myapp
litestone replicate --db main            # one database
litestone replicate ./litestone.config.js
```

```js
export default {
  schema: './db/schema.lite',
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
import { createTestEnv, makeTestClient, Factory, defineFactory, truncate, reset,
         snapshot, restore, generateFactory, generateGateMatrix,
         generateValidationCases, deriveAccess, renderAccessSnapshot, gateLadder,
         expectedVerdict, factoryFrom, loadFixture, parseCsv,
         readOnly, schemaMutants, mutationScore } from '@frontierjs/litestone/testing'

// The environment: migrated database, client, factories, principal. Tables
// arrive as a file copy from a template migrated once per schema per process —
// 476ms → 13ms per database on a 37-model schema.
// `migrations:` replays the committed files instead of generating DDL, so the
// tests run against the database a deploy produces. basecamp uses it.
const env = await createTestEnv({
  schema:     'db/schema.lite',
  migrations: 'db/migrations',
  plugins:    [myGatePlugin],
})

env.actingAs(user)                  // the app's own getLevel — anything about behavior
await env.atLevel(4)                // a SYNTHETIC standing — the gate grid only
await env.verifyGateLadder()        // every gated model × every level × all four ops
await env.verifyReadLadder()        // the read column alone — no fixtures needed
await env.verifyConstraints()       // every declared rule, against a real write
await env.verifyFieldProtection()   // @guarded/@encrypted/@secret, actually read
await env.verifyRowPolicies()       // @@allow/@@deny, rows on BOTH sides
await env.verifyTenantIsolation()   // tenancy { }, actually crossed — one tenant reaching into another

// Mutate the schema, run the ORIGINAL's checks against the mutant's database.
// A mutant nothing notices is a hole in the SUITE, and it names itself.
const { score, survived } = await mutationScore({
  schema, build: (text) => createTestEnv({ schema: text }),
})
env.seal(); env.reset(); env.close()

// Arrange / Act / Assert as three clients rather than three comments. `setup` is
// the arrange every scenario shares — run once, restored by each phases() call.
const fx = await env.setup(({ factories }) => factories.account.createOne())
const t  = env.phases({ as: developer })
const lead = await t.arrange(({ factories }) => factories.lead.createOne())
await t.act(as => as.lead.remove({ where: { id: lead.id } }))
await t.assert(read => expect(read.lead.count()).resolves.toBe(0))

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

// Test generation — the second argument is the MODEL name, never the accessor
const matrix  = generateGateMatrix(schema, 'Post')        // every op × every level 0–8
const edges   = generateGateMatrix(schema, 'Post', { levels: 'edges' })  // 2 per op
const cases   = generateValidationCases(schema, 'User')   // valid + invalid + boundary
const factory = factoryFrom(schema, 'User', db)

// The declared access surface — gates, policies, protected fields, and per move
// its gate AND its @system, which are two facts that compose rather than one
// grade. `litestone access` renders it to the committed access.snapshot.md.
const access  = deriveAccess(schema)
```

---

## Tenancy

**Declared in the seed, one block, two strategies** — `docs/multi-tenancy.md`
is the full reference.

```
tenancy {                          tenancy {
  strategy database                  strategy row
  dir      "./tenants"               column   workspaceId
  registry "./tenants-registry.db"   claim    workspaceId   // default: the column
  maxOpen  100                     }
  key      env("TENANT_KEY")
  resolve  subdomain               // subdomain | header("X-T") | claim(field)
}
```

`strategy database` is a SQLite file per tenant plus a registry that indexes
them; `strategy row` is one database and a tenant column. Every reader asks the
same resolution — `resolveTenancy(schema, { schemaPath })`, on `db.$tenancy` and
`registry.tenancy` — and precedence is **option → declaration → default**, in
one place.

```js
const tenants = await createTenantRegistry({ path: './db/schema.lite' })  // reads the block
const db      = await tenants.get('acme')
await tenants.query(db => db.user.count())
await tenants.migrate()

const release = tenants.retain('acme')   // pin for a unit of work
try { … } finally { release() }
tenants.poolStats()  // { pooled, leased, retired, overflows, maxOpen }
```

**`maxOpen` is how many tenants to keep WARM, not a ceiling** (`FJS-D172`).
Eviction never closes a client it lent out — `get()` hands one to a request that
holds it across every await it makes, and closing it left a MIXED client rather
than a dead one. `retain(id)` is what makes an eviction able to close anything:
junction's `withTenantDb` pins for the length of a request, so a client whose
every lease has ended closes at the next eviction, and one from a bare `get()`
is dropped for bun's finaliser instead. A fan-out inserts COLD into a ring, so
an admin dashboard does not evict the tenants being served.

**Row tenancy desugars into `@@deny`, never `@@allow`.** Allows are OR'd within
an operation, so an allow added to a model that already has one WIDENS its reads
to every row in the tenant. Two rules per scoped model, because create and read
want opposite answers about an absent value — `checkCreatePolicy` runs before
the `@default(auth().<claim>)` stamp, so an omitted column on create is
legitimate and a row holding no tenant on read belongs to nobody.

**A stamped column is `readOnly` in the generated JSON Schema**, with
`x-litestone-kind: 'tenancy'` — `@system`'s treatment for `@system`'s reason:
the application writes it and the caller does not. Being out of create-mode
`required` was NOT enough on its own, and the way that failed is worth keeping
in mind for any server-written column. `make()` seeds every WRITABLE column,
sierra's `normalizeBlanks` rewrites a blank to `null`, and a stated null is a
VALUE rather than an absence — so the `@default(auth().<claim>)` never applied
and the write came back `400 must be a string` (`FJS-387`). A column nothing may
send has to stop being OFFERED, not just stop being demanded.

`@@tenant(none)` marks a model that spans tenants; `@@tenant(column: "x")` names
a different column. Models declaring neither are reported by name, once, at
parse. `jsonl`/`logger` models are never scoped — no policy engine there — and
those databases stay schema-global under `strategy database` too.

`registry.tenantFor({ host, headers, principal })` applies the declared
`resolve`; Junction's `createApp({ tenants })` calls exactly that rather than
carrying a second reading of it.

---

## A field predicate is not a strip

`@guarded` is decided once per model; `@allow('read'|'write', …)` on a field is a
predicate, and a predicate has to be answered where the ROW is. Both halves were
not, and both were live holes (`FJS-D129`).

**A read predicate does not merely hide the answer.** Stripping the column and
leaving it filterable recovers the value by binary search — measured, a salary
in seventeen requests — and an `orderBy` leaks the ordering of every row in one.
The predicate is now AND-ed into the caller's arguments as a **sibling** of
their `where`, which is what stops their own `NOT` from complementing it. Two
things follow and both are deliberate: naming the column narrows the read to the
rows the caller may read it on (a row-dependent predicate therefore still works
over their own rows, which is the case the feature exists for), and an `OR`
branch naming it narrows the WHOLE read, including branches that do not — safe,
blunt, and the way out is two reads.

**A write predicate must not be graded against the payload.** It was:
`@allow('write', auth().id == ownerId)` on an update compared against whatever
the caller sent, so omitting `ownerId` dropped a column its owner was entitled to
write and STATING `ownerId: me` wrote the column on somebody else's row. It is
the WHEN of `SET col = CASE WHEN <pred> THEN ? ELSE col END` now, so it reads the
stored row and a bulk update grades every row separately. **CREATE keeps the JS
evaluation** — there is no stored row and the payload IS the row being made,
which is what `checkCreatePolicy` grades one layer up.

Through a RELATION both are refused by name: the predicate decides rows of the
other model and a filter one hop away has no row of it to decide against.

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

## A tuple key is not a unique column

**`@@id([a, b])` stamps `@id` on EVERY member**, so asking the fields which
column identifies a row answers all of them — and one member of a tuple
identifies nothing. Three faults came out of that single read and the worst is
silent (`FJS-694`): with `orderBy: { userId }` on `@@id([userId, teamId])`,
three rows sharing a userId paged two at a time served the first two and then
answered EMPTY, because the tie-break thought the ordering was already total and
the cursor said `userId > 1`. Beside it, the default ordering was the literal
`id` — a column such a model does not have, so every derived list over one was a
400 — and the tie-break appended only the key's FIRST column, which is still not
total.

`_keyCols()` reads the model ATTRIBUTE, because that is the only place the key's
column ORDER is stated, and `$primaryKey(accessor)` is the same answer for the
layer above. `normaliseOrderBy` still defaults to `id` and must: it is pure and
has no model in scope, so the default belongs at the caller that has one.

## SQLite gotchas

**`busy_timeout` is 5000ms on every connection this package opens, and it is a CROSS-PROCESS device only.** `src/core/pragmas.js` is the one owner — the number was a literal in three files and absent from four others, so whether a database waited under contention was an accident of which file opened it (`FJS-569`). The one with no wait was the `logger` index, which is schema-global and therefore the single file every tenant and every process writes; a second API beside a running one died on its first audit write, in about a millisecond. **Inside one process the timeout is not a safety net, it is a stall** — `bun:sqlite` is synchronous, so a connection waiting on the lock blocks the event loop, and it can deadlock outright: the waiter blocks the loop, the holder's continuation never runs to commit, and the wait can only expire. Measured both ways — 5000ms then failure in one process for an 800ms hold, 1444ms then commit across two. What makes the in-process case fine is `$transaction`'s FIFO lock, which queues two transactions on one client in JavaScript so they never reach the SQLite lock — and what keeps THAT true is **one client per database file per process**, since `createClient` twice on one path is two connections that can deadlock where `$setAuth`/`asSystem`/`$scopedBy` are views over one handle. **The number is `createClient({ busyTimeout })`, precedence option → env (`LITESTONE_BUSY_TIMEOUT`) → 5000**, per database as `{ default, <db> }` because the audit index wants the opposite answer to main — its write is fire-and-forget and its failure swallowed, so `{ audit: 250 }` says *drop the row rather than stall the loop*. A malformed value and a key naming a database the schema does not declare are both refused by name at `createClient`, since a dropped key is a database silently keeping the default. **There is deliberately no `database { }` spelling** (`FJS-D155`): how long to wait for another process is a fact about THIS process, and the same schema is opened by an API answering a person and a queue draining a batch. `docs/concurrency.md` is the whole of it, including the worker-thread answer for a query that is genuinely long — measured, a worker holding the lock for 600ms let the main loop keep ticking and the main thread's write waited 639ms and committed, where the same shape on one thread deadlocks.

**A scaled column's ceiling is 2^53, not int64, and it is now enforced at both ends.** `Int @scale(n)` promises an exact round trip, and the round trip goes through a JS `number` — nothing here sets `safeIntegers`, so `bun:sqlite` answers a `number` on every path, a column read and an aggregate alike. Past 2^53 the rounded double is stored and a DIFFERENT number is read back with nothing raised: `12345678900000001` reads back `…000` and `9007199254740993` reads back `…992`, which is `prisma#20635` — the bug `FJS-D142` cites as the reason `Int @scale` exists at all — reproduced one layer up. The documentation reasoned from the 64-bit column and said nine places leaves nine figures in front of the point; the true answer is **seven**, and two distinct minor-unit values collided into one row value (`FJS-583`). The boundary now refuses a value past `Number.MAX_SAFE_INTEGER` by name, in a different sentence from the fraction refusal because they are different mistakes, and `@scale`/`@money` emit `CHECK ("c" BETWEEN -9007199254740991 AND 9007199254740991)` — a CHECK because four writers never reach the boundary: a migration, a seed, a raw statement and `asSystem()`. `EXACT_INT_MAX` in `validate.js` is the one owner and `ddl.js` imports it. **A plain `Int` is deliberately NOT bounded** — it makes no exactness promise, and bounding every integer column in every app to buy back one is the wrong trade — so a snowflake id kept in an `Int` has the same ceiling — and `Int @big` is what that column declares instead (`FJS-643`, ruled `FJS-D174`).

**`@big` is `@scale`'s opposite and it emits no CHECK, which is the part that looks inconsistent and is not.** `@scale` narrows the column to the range a JS number carries; `@big` says the values use all 64 bits and pays by crossing as a **string of digits** — a `BigInt` is exact and `JSON.stringify` throws on one, which is every HTTP response, every WS frame and every `before`/`after` audit snapshot. node-postgres answers `int8` the same way; mysql2 has `bigNumberStrings` for it. The type does not vary with the magnitude (`42` reads back `'42'`) or a caller would branch on the size of the value; a JS number is still accepted going IN below 2^53. The column keeps `INTEGER` storage, which is what makes it worth doing over a `TEXT` column of digits — measured, a text parameter takes the column's affinity, so `ORDER BY` puts `100` before `9007…`, a range filter compares numerically, EXPLAIN answers `SEARCH … USING COVERING INDEX (v=?)`, and `AUTOINCREMENT` continues past 2^53. **No CHECK because `STRICT` is on every table this package writes** and already refuses all three ways a wide value stops being exact: past int64 (a loose table stores REAL `9.22e+18`), a non-numeric string, a fraction. A constraint that cannot fire is worse than none; `@@noStrict` is the one shape that earns it, and there it is emitted. The distinction from `@scale` is the bound — `@scale`'s is NARROWER than the column's own, `@big`'s IS the column's own.

**Two traps in implementing it, both measured.** `safeIntegers` is per-STATEMENT and all-or-nothing, so a wide model's statements answer BigInts for `id`, a count and a Boolean's 0/1 as well — and asking at the statement while narrowing in `read`/`readAll` is an enumeration: `count()` answered `0n`, because a statement also serves counts and aggregates that reach a caller through neither. The **statement** narrows what it returns (`wideStmt`/`wideDb` in `client.js`), and `wideDb` unwraps through `$plain` before re-wrapping, because a wide model's `readDb` is handed to the include and `@from` resolvers, which read a DIFFERENT model. For a key the row read does not recognize — `_max__col`, a window's row number — the fallback is the VALUE: one that fits becomes a number, one that does not becomes digits.

**No ILIKE** — use `WHERE LOWER(name) LIKE '%term%'`

**A plain object in `bun:sqlite`'s parameter list voids every positional binding in that statement.** It is read as a named-parameter bag, and a statement built with `?` matches none of its keys — so nothing is bound, including the WHERE, and no error is raised. `SELECT ? IS NULL` passed `{x:1}` answers 1; `UPDATE t SET a = ? WHERE id = ?` passed `({x:1}, 1)` changes no rows, because the id was voided along with the value. Every symptom of FJS-199 is this one fact wearing different clothes. Anything that reaches `run`/`query`/`prepare` with a caller-supplied value has to know the value is a bindable primitive first.

**There are THREE schemas and most migration confusion is a comparison between the wrong two** — declared (`schema.lite`), shadow (the migration files replayed into an empty database) and live. `migrate create` and `migrate check` compare declared ↔ shadow: *what migration is missing*. `migrate dev` and `migrate baseline` also compare shadow ↔ live: *has somebody changed this database without writing a file*. It was ONE comparison, declared ↔ live, doing both jobs — which is why a `db push` database, matching the declaration by construction, made `migrate create` answer *already in sync* at the exact moment a migration was needed, while the deploy refused for want of one (`FJS-388`, ruled `FJS-D123`). `buildShadow` and `historyGap` in `core/migrations.js` are the owners; `migrate check` is the repo-only question with no database opened, and `fli deploy:doctor` asks it before an image is built while `migrate apply` asks the same function at container start. **`db push` is prototyping only** — it reaches no deploy — and `migrate baseline` is the way back for a database that is already correct and has no history to say so, refusing when the database does not actually hold what the files build.

**A protection that only STRIPS is not a protection.** `@guarded` hid its value from every read and let the same caller name the column in a `where`, which recovers it one `startsWith` at a time, and in an `orderBy`, which leaks the ordering of every row at once (`FJS-393`). The refusal is `collectGuardedArgs` in `client.js`, at the read where `ctx.isSystem` is known — NOT in `filterableKeysFor`, which answers whether a column CAN be compared and is therefore the same answer on every flavor of client, which is what lets junction ask `$checkWhere` of a caller's own. **It walks the relation graph**, because the filter grammar does: `where: { author: { is: { … } } }`, a relation `orderBy` and a nested `include` all ask about a model the table is not. `ctx.guardedMap.reaches` is the gate — a model from which no guarded column is reachable at any depth costs one boolean — and the walk descends only into a relation key or a logical/relation operator, since a nested object under an ordinary column is a typed-Json path where a key sharing a guarded column's name means something else. The sibling hole through a field-level `@allow('read', …)` is open and measured (`FJS-442`): a predicate is not a set, and refusing it needs a ruling first. **A credential lookup is now a system read by construction** — a `Session`/`Invitation`/`ApiKey` token is `@guarded(all)` and found BY its value, so `where: { token }` on a caller's client is refused; auth and basecamp already went through `asSystem()` for it, and the comment in `invitations.service.ts` says why. Allowing bare equality instead would have kept them working and left the hole open for anything low-entropy, which is what a probe enumerates.

**`@updatedAt` is stamped by the CLIENT, and there is no trigger any more.** It was an AFTER UPDATE trigger, and a trigger can only ever read SQLite's own clock — so `createClient({ now })` moved a policy's `now()` and left every stamp on today, which meant the one thing a frozen clock is for (staging a row aging past a window) could not be staged (`FJS-531`). Three mechanisms became one: `@default(now())` and `@updatedAt`-on-create go through `buildGeneratedDefaultMap`, `@updatedAt`-on-update through `stampSets`, all three reading the client's clock. `isUpdatedAtField` in `ddl.js` is the one answer to *is this a stamp column* — the ATTRIBUTE, or the name `updatedAt` on a `DateTime`, because binding to the attribute alone leaves a column named for the job unstamped. **`FJS-396` is closed at the root rather than narrowed**: RETURNING is evaluated before an AFTER trigger, so a write that leaned on one handed back a value the row no longer held, and naming the column in the SET clause only fixed that while the two values DIFFERED — which they do not when the clock has not moved between two writes to one row (under an injected clock, every write after the first). With no trigger there is no window. **The floor is now asymmetric and that is the price**: the column DEFAULT stays, so a raw INSERT still stamps; a raw UPDATE does not, and a hand-written statement owns its own stamp. An existing database is migrated by `litestone migrate` — pristine stops carrying the trigger, `droppedTriggers` in `migrate.js` sees it, one `DROP TRIGGER IF EXISTS` and no table rebuild. `@@external` answers no stamp columns at all: a client stamp into a table litestone does not own is a silent write into somebody else's.

**Retention measures from the client's clock too.** `runSqliteRetention` and `compactJsonl` both took `Date.now()`, so `env.clock.advance('100d')` moved nothing either pass could see — the sweep is a crossing, and the clock could not stage the one thing it was reached for. One reading of the option (`nowMs` in `retention.js`) because both halves take it, and two interpretations is how the jsonl half ends up sweeping to a different instant than the SQLite half.

**`json_extract` returns native types** — `json_extract(data, '$.id')` returns integer; comparing to string silently fails. Cast: `CAST(json_extract(data, '$.id') AS TEXT)`

**`sqlite_sequence` is a historical counter** — shows total rows ever created, not current count.

**Concurrent deploys + shared WAL** — blue-green with overlapping containers sharing the same SQLite file can cause WAL contention. Mitigations: Litestream WAL replication, `wal_autocheckpoint` pragma (both implemented).

**`kamal app exec` memory spikes** — each exec container adds ~500MB RAM. Run `litestone studio` on the host.

---

## The context in this package

**One, and it is not a request context** (`FJS-D03`). A Litestone plugin's `ctx`
is the **client's compiled state** — `relationMap`, `policyMap`, `typeMap`,
`computedFns`, `softDeleteMap`, `schema`, `now`, `tx`, and about forty more —
plus `auth` and `isSystem`.

| | |
| --- | --- |
| Created per | **client scope.** Built once in `createClient`; `asSystem()`, `$setAuth()` and `$scopedBy()` each SPREAD it with `auth`/`isSystem` changed |
| Lives until | that client is closed |
| Carries | the compiled schema, the maps every query is built against, and the principal that scoped this client |
| Does NOT carry | a method, arguments, a request, or anything per-call. There is no `ctx.query`, no `ctx.method`, no `ctx.locals` |

The lifetime is the thing to hold on to: **`ctx.auth` is the principal that
scoped the CLIENT, not a per-call value**, which is exactly why `$setAuth(user)`
returns a new client instead of mutating one. A plugin hook receives the
per-operation data as its own arguments (`model`, `args`, `rows`) and the ctx
beside them.

`enc` is a CELL rather than a value for the same reason the spread exists — see
the note in `client.js`: a spread copies a string by value, so `$rotateKey` would
update the root and leave every derived client decrypting with the old key.

---

## Proving a change

`bun run test` (bun; `test:smoke` is the CLI only). Then, because this is the
realm every other package sits on: `example`: `bun run verify` and `basecamp`:
`bun run verify`, plus `sierra`: `bun run test:safety` — the five checks that run
against a real client rather than a stand-in.

**`test/verbs-rules.test.ts` is the grid underneath that one**, and it asks the
question `makeTable`'s shape makes urgent: *does every verb that can reach a row
apply every rule that guards it?* Twenty verbs × five row-reaching rules, ONE
SCHEMA PER RULE — a fixture carrying every rule at once has the gate refusing
everything and every other rule then reports as applied (`FJS-351`). Each rule
is arranged the same way: two rows, and the rule admits exactly one, so a verb
that applies it sees one and a verb that skips it sees two. **The verdict is
never read off the verb's own return value** — a count, a row, a boolean and a
throw are four vocabularies, and the first cut of this file scored `upsertMany`
as passing because `count && 2` is 2 for any non-zero count. Every cell asks the
SYSTEM what the caller could reach or move. `VERBS_REPORT=1` prints the grid;
fill it from that, never by hand. Its first run found `FJS-720`.

**`test/matrix.test.ts` is where a CROSSING is answered.** 20 column kinds × 16
operations, one cell each, under one invariant — *no cell may silently return a
wrong answer*: supported, or refused **by name**. Adding a column kind or an
operation means filling its row or column; a missing cell fails rather than being
skipped, because every defect the crossing sweep found lived in an intersection
that each feature's own suite passed. A cell reading `200:ref` is open FJS-200,
asserted **still broken** — fix it and the matrix goes red telling you to promote
the cell, so a fix cannot leave the grid stale. Fill cells from
`MATRIX_REPORT=1 bun test test/matrix.test.ts`, never by hand: a grid written
from belief asserts a wish. **What is still out is named in the file's own
header**, and the reasons differ: the relation kinds and `@from` need a second
model and therefore a second expectation table; `File` needs a `FileStorage`;
and `@version` is not a column kind at all — declaring one makes every update on
the model carry a revision, so it would change what every other row's `update`
cell means.

**Traps that cost time here, all verified by running:**

- **A `@from` correlates on EVERY column of its relation's key, and that is
  three places rather than one.** The subquery's WHERE, the `first`/`last`
  repick (`IN` over row values, `PARTITION BY` over all of it, a JSON tuple as
  the lookup key), and `parseSelectArg`'s injection of the correlation columns
  for a `select` that named only the derived field. Correlating on the first
  column alone answered a count of every row sharing it — 8, 8, 7 where the
  truth was 3, 5, 7 — and nothing could raise it, because that is a count of
  real rows (`FJS-377`). `inferFromFk` answers `{fkCols, refCols}`, aligned
  arrays; a single-column relation is a one-element case of the same code.
- **A `@from(first/last)` field is an id in SQL and a ROW after `read()`.** The
  subquery resolves the target's primary key; `resolveFromRowRefs` fetches the
  rows in one batched query and swaps them in, before `applyComputed` so a
  parent computed reading `row.lastOrder.amount` sees a row. It was a
  `json_object` of the target's columns, which filtered out the *virtual*
  attributes and left the *protective* ones — so it returned `@guarded(all)`,
  `@omit(all)` and `@encrypted` values to any caller (`FJS-223`) while missing
  the target's own `@computed`/`@from` (`FJS-222`). Protections live in `read()`;
  anything that assembles a row without it will leak them. The three include
  branches share `finishRelated` for the same reason — each had its own copy of
  deserialize → compute → shape, and a step added to one missed the other two.
  **On a policied target the id from SQL is discarded and the pick is redone**
  under the caller's policy, with `ROW_NUMBER()` choosing per parent — the
  startup subquery cannot know `ctx.auth`, so it picked the newest row that
  exists and a denied one read as `null` rather than falling through to the next
  visible one (`FJS-224`). The repick correlates on the column the target points
  back at, which `parseSelectArg` injects like an FK, so a narrow `select` still
  gets it right.
- **A read that builds its own SELECT has to compose what `buildSQL` composes.**
  Global filter, plugin read filters, soft-delete, `@@hasTemplates`, the
  caller's where, then the policy — in that order, because positional binds make
  the order the correctness. `findManyCursor` and `search()` applied none of the
  first four and neither the policy, so `findMany` answered one row where they
  answered every row in the table (`FJS-262`). And a `@@gate` lives in a
  plugin's `beforeRead`: `aggregate`, `groupBy` and `search` never called it, so
  a gated model answered a refused caller's COUNT while its row policy — which
  DID apply — made the number look scoped. The grid in
  `test/litestone.test.ts` § *every read applies the filter, the policy and the
  gate* is what a new read method has to pass.
- **A tree read goes through the ordinary read path, and it has to stay that
  way.** `findMany({ recursive })` resolves ids in a CTE and fetches the rows
  with `findMany`, so the gate, the policy, the select and the derived fields
  have one owner each. It was a second SELECT path once, and it asked none of
  them past the anchor row: a caller refused on the model read its whole subtree
  (`FJS-216`). The walk carries the anchor's visibility predicate, so an
  invisible node hides its branch — reparenting orphans upward hands back the
  children of a refused row. Only `findMany` walks a tree; every other read
  refuses `recursive` by name.
- **`@system`, `@guarded`, `@computed` and `@transient` are one grid, and the two
  questions are *is there a column* and *which way does the value travel*.**

  |              | column | caller writes | caller reads |
  | ------------ | ------ | ------------- | ------------ |
  | `@guarded`   | yes    | system only   | system only  |
  | `@system`    | yes    | system only   | anyone       |
  | `@computed`  | no     | no            | yes          |
  | `@transient` | no     | yes           | no           |

  `@computed` and `@transient` are mirrors, which is what decides everything
  downstream rather than deciding it twice: computed is emitted into the READ
  modes of the generated schema and transient into the WRITE ones, computed is
  out of the create/update types and transient is out of the row type and out of
  `Where`. Neither is a column, so `isStoredField` in `ddl.js` is the one answer
  to that — `CREATE TABLE` and the rebuild's `INSERT … SELECT` were asking it
  separately and had drifted. A transient field is refused by name in a `where`,
  an `orderBy`, an aggregate, a policy predicate and a `@@index`, because SQLite
  reads an identifier it cannot bind as a string literal: the filter matches
  every row or none, and nothing says so.

  Both refuse a write BY NAME rather than dropping it, because the client is told
  `readOnly` and a generated form does not offer the column — so a payload
  naming one is code that meant to write it. A field `@allow('write', …)` still
  drops silently, and must: there the same payload is legitimate for another
  caller. The pair `@guarded(all) @system` is legal and means both halves; a
  field `@allow('write')` beside `@system` is refused, because one says nobody
  ever and the other says it depends who is asking.
- **Attribute legality is asked of a FACET, and there are two owners.** The
  parser refuses `@unique` over a randomly-encrypted column; the same class one
  attribute over was ruled nowhere, so three things that cannot work at all
  parsed clean — `@unique`/`@@unique`/`@@index` over a field with no column
  (`@@unique([c])` over a `@computed` makes a table SQLite refuses at boot),
  a fractional `@default` on `@scale`/`@money` (an INTEGER of minor units takes
  `DEFAULT 12.99` and the first defaulted row is refused at runtime), and a
  `@relation` across two `database` blocks (an FK that resolves nowhere).
  Derived from *what does the column physically hold* rather than from a pair,
  so the next virtual kind arrives covered; `@generated` is outside it, being a
  real column (`FJS-721`). **What belongs in the parser is what cannot be
  EXPRESSED; what is legal and WRONG belongs in `advise.js`**, whose own
  contract is that every rule in it parses — `@@fts` over an encrypted column is
  one of those, and putting it in the parser as well made that rule unreachable
  and broke its own test.
- **A converter is graded by reading its output BACK, never by matching strings
  in it.** `generateLiteSchema` had six tests and every one was
  `expect(schema).toContain(...)`; none fed the result to `parse()`, and the
  emitter wrote a `.lite` litestone could not read for its whole life — no comma
  before `onDelete:`, SQLite's `CASCADE` where `ON_DELETE_ACTIONS` wants
  `Cascade`, and `@@index([deletedAt])` beside `@@softDelete`, which the parser
  refuses BY NAME since `FJS-480` added that rule without asking who emitted the
  pair. `test/introspect-roundtrip.test.ts` asserts the FIXED POINT instead —
  reading a database built from the output must give the same output — over the
  seven corpus schemas and `openmrp`. It found four more the same day, and every
  one of them is a shape no substring assertion can see: a SQL expression default
  emitted as a string literal (so the quotes doubled on every pass), a
  `@@index(where:)` re-emitting the clause `createIndexes` ANDs on for
  `@@softDelete` (so the predicate nested a level deeper each time), a relation
  field named for the table it points at (which takes a real COLUMN's name and
  deletes it, since the parser keeps one field per name), and an enum name
  colliding with a MODEL name (which makes that model's own relations resolve as
  enums and become TEXT columns). Anything here that WRITES `.lite` owes the same
  property.
- **The console's standing is only as true as its resolver, and the default is
  usually the wrong one.** `litestone repl --as <who>` grades with
  `FrontierGateGetLevel` unless `--gate <path[#export]>` points at the app's own.
  Measured on `example`: the default grades `ops@acme.test` at **3 (CREATOR)**
  and the app's `shopGateLevel` grades the same row at **4 (USER)** — and `Order`
  is `@@gate("0.4.4.5")`, so a create is refused in the console and permitted in
  the app. A console that is *approximately* somebody's session is worse than
  none, because you act on what it shows you, so the banner names which resolver
  answered. Related: a `--level` standing has **no `auth()`**, so every
  `auth().id ==` row policy matches nothing and its model answers an empty list
  rather than refusing — indistinguishable from a gate refusal by the result, and
  said out loud for that reason.
- **A REPL that does not serialize its lines executes them out of order, and
  `rl.pause()` does not fix it.** Pausing does not hold back lines readline has
  already buffered, so a pasted block or a piped heredoc fires every handler and
  the statements complete in whatever order their awaits finish — against a
  database, writes landing in an order nobody wrote. A promise chain is the fix
  and `close` has to await it too, or the session reports over with a write in
  flight. Both shapes are pinned in `test/repl.test.ts`, verified by breaking it.
- **One comparison, two gradings, and they are close to inverted.** `release.js`
  walks two release surfaces once; `classifyPivot` grades *can N-1 and N serve
  one database* and `classifyAccess` grades *who may now do more*. They disagree
  by construction — removing a `@@gate` is an `expand` and the widest thing a
  schema change can do — and on the five-part widening in `test/release.test.ts`
  **every widening is an expand**. A new comparison belongs in the existing walk
  with a direction attached, never in a second traversal: two walks over one set
  of declarations is how two answers to one question drift apart. The finding a
  field-level `@allow` was missing from the surface entirely came out of building
  the second grading, which is the argument.
- **A `@values` binding is on the deploy axis and not the access one.** It
  narrows by VALUE, identically for every caller, so `classifyAccess` says
  nothing about it — but a column gaining `@values(X)` starts refusing writes
  N-1 has been making all along, with no column, no type and no constraint
  moving, which nothing else in the surface can see. The three strengths are not
  a ladder: only `required` refuses, so `suggested` → `open` is an expand and
  anything → `required` is the pivot. The SET is carried separately from the
  binding because narrowing one narrows every column bound to it, and that is
  unreadable from any single field's row — and a set narrowed where nothing
  binds it as `required` is an expand, since a picker offering less refuses
  nothing.
- **A snapshot that carries a verdict cannot be rechecked.** `release.snapshot.md`
  holds the release surface and never the classification, because a verdict is a
  fact about two schemas while the file describes one — write it in and the file
  depends on its own previous contents, which is not a fixed point. Same reason
  `repo-map.snapshot.html` carries no dates and no timings. `--check` is
  therefore staleness alone, and the classification is printed.
- **A generated expectation must not come from the code it grades.**
  `expectedVerdict()` in `access.js` restates what `@@gate` means and does not
  call `levelPasses()` in the gate plugin, which is the opposite of the rule
  everywhere else here. It is not an oversight: when `gateLadder` asked the
  plugin, deleting a branch from the plugin produced **zero** mismatches across
  333 executed assertions. One exhaustive test over every (required × level) pair
  holds the two statements together. Describing the gate (the access snapshot)
  shares the predicate; grading it may not.
- **A row policy has TWO implementations and they can disagree** — see the
  policy note below. `verifyRowPolicies` grades one against the other, which is
  a real oracle rather than a restatement. `create` is not covered because
  `evalJs` is its only implementation, and grading it with `evalJs` is circular.
- **Rows on one side of a predicate prove nothing.** A policy that admits
  everything and a policy that is not applied at all are the same observation.
  Reported as `error`, never as a pass.
- **A mutation score that counts its own harness failures is worthless.** Only a
  verdict disagreement kills a mutant. Counting the `error` and `skipped`
  outcomes was worth 36 points on a 14-mutant schema: every mutant came back with
  the same 22 error rows and the score read 93% while four mutations went
  completely unnoticed. Same rule as the gate matrix, one level up.
- **The same rule one level up again: a mutant refused by the LOADER counts as a
  kill, and only while the ORIGINAL builds.** A schema the framework will not
  load cannot ship, so refusing it is a real kill — but nothing checked that the
  original loads, and on basecamp it does not: it declares `@secret`, so
  `createTestEnv` wants a key, so every mutant was refused and the run printed
  `100% killed · 14/14` having graded nothing (`FJS-597`). `mutationScore` builds
  the original first now and refuses with the reason attached. A thing that
  always passes and a thing that never ran are the same observation until
  something separates them.
- **`litestone mutate` mutates the schema with its IMPORTS INLINED.** `parse`
  does not follow an import, so reading the file's own bytes made every mutant of
  an importing schema die for a reason unrelated to the mutation — all 300 of
  basecamp's, and the command refused outright. `inlineImportsFromDisk` rather
  than `parseFile`, because the catalogue is line-oriented and wants text; a
  fragment that cannot be read is NAMED, since its models are otherwise silently
  outside the run. What this buys is reach: the `@secret` and `@guarded` columns
  auth ships are only mutable once the fragment is in.
- **Mutation is code-only and quote-aware.** An attribute named inside a doc
  comment is prose; editing it produces a mutant identical in behavior, which
  survives everything. `example` reported four surviving `guarded-drop` mutants
  on a model with no `@guarded` field before this.
- **A UNIQUE collision is indistinguishable from a validator working.** Both are
  a throw on a write that should have been refused, so a constraint runner that
  counts any throw as *rejected* passes against a validator that does nothing.
  `verifyConstraints` checks for `ValidationError` by name and reports anything
  else as `error`; its first run on basecamp was 23 such rows, none about
  basecamp. Three separate guards keep them out — see the comment there before
  changing how it creates rows.
- **A row policy is compiled twice, into two languages, and they can disagree.**
  `read`/`update` become a WHERE (`compileSql`); `create` and the post-update
  check are evaluated in JS (`evalJs`). Every comparison form has to be handled
  in both — `field == null` was in neither and fell to `"col" = NULL`, so create
  allowed a row that read then hid (`FJS-195`). Adding a form to one half is
  half a change. **An encrypted column is where the two halves legitimately
  differ**: the WHERE encodes its operand (`comparisonEncoderFor`, the same
  rewrite a `where` gets, `FJS-214`), the JS evaluator compares plaintext
  because `create` hands it the data as written. `post-update` gets the row read
  BACK, where the column is stripped by `@guarded(all)` — refused at startup
  rather than denying every write. **`test/policy-interpreters.test.ts` is the
  oracle between them** — the same predicate over the same rows, asked of both
  halves, 29 forms × 3 principals × 5 rows plus the clock, a `check()`
  delegation and a `@@deny` beside an `@@allow`. Adding a form to the parser
  means adding a row there, or the two compilers can take it in different
  directions with nothing failing.
- **The JS half compares the way SQLite does, and `===` is not that.** SQLite
  applies the COLUMN's affinity to the other operand and then orders by storage
  class; JS does neither, so `ownerId == auth().id` over an `Int` column and a
  caller whose id is the string `'5'` — which is every junction principal, a
  `SessionContext` carrying `userId` as TEXT — was TRUE through a query and
  FALSE on create and in `$readAs` (`FJS-713`). Measured across column type ×
  operator × operand, **54 of 594 cells disagreed**, in both directions and on
  every operator, so the filed pairing was one of a class. `compare()` in
  `policy.js` now puts a JS value in the storage class the binder would have
  given it (a boolean is 0/1, a `Date` its ISO text), applies the column's
  affinity, and orders by class; `in` takes the same affinity per element. Two
  things are deliberately left alone: a value that is neither a number nor a
  string after all that keeps JavaScript's answer, because two distinct Buffers
  rank EQUAL under a class comparison and `==` would answer TRUE for them; and
  the affinity is read through `sqlType`, the DDL emitter's own function, so it
  cannot drift from the column that gets built.
- **The create half is evaluated against the PAYLOAD, so a column SQLite
  computes from the row can never be named in a create policy.** `@derived`,
  `@generated` and `@from` read `undefined` there, so the allow never holds and
  the model is uncreatable by everybody — while the read half, being SQL,
  answers it perfectly (`FJS-719`). Refused at build, and derived from the FACET
  rather than from a list, because the enumeration that already refused
  `@computed` and `@transient` is what missed these three. `@system` is
  deliberately not in it: `system: ['col']` puts one in the payload, so a create
  policy naming one is answerable. A `@@deny` fails the opposite way and gets
  the opposite sentence — an allow that never holds refuses everybody, a deny
  that never fires refuses nobody.
- **Raw SQL requires `asSystem()`** once a schema declares access rules — `db.sql`
  and `db.$setAuth(u).sql` both throw. Raw statements enforce no `@@gate`,
  `@@allow`, `@guarded`, `@scoped` or `@@softDelete`; they all live above SQLite.
  ``where: { $raw: sql`…` }`` keeps every policy and is the escape hatch to reach
  for. A JS migration is exempt — the runner hands it the system client.
- **`$transaction` serialises per client, and re-entrancy is decided by the async
  context rather than by the depth counter.** One connection holds one
  transaction, so a second REQUEST arriving while the first awaits used to look
  exactly like a genuinely nested call: it took a SAVEPOINT inside the first
  request's transaction, was told it committed, and lost its rows when that
  request rolled back (`FJS-244`). A nested call inherits an `AsyncLocalStorage`
  store and still SAVEPOINTs; anything else waits on a FIFO lock. This only
  serialises what SQLite already does — two `BEGIN IMMEDIATE`s cannot overlap on
  one connection. `createMany`/`upsertMany` go through the same lock, awaiting the
  acquire while their batch body stays synchronous.
- **Row tenancy is a NARROWING, so it desugars into `@@deny` and never
  `@@allow`.** An allow added to a model that already declares one is OR'd with
  it, which widens every read to the whole tenant — the opposite of the feature.
  Two rules per scoped model, because `checkCreatePolicy` runs BEFORE
  `applyAuthDefaults`: on create the column is legitimately absent (the stamp
  has not happened yet), on read a row holding no tenant belongs to nobody. Get
  that ordering wrong in one direction and every create is refused, in the other
  and orphan rows are visible to everybody. Both directions are pinned in
  `test/tenancy.test.ts` against a real client — a policy that admits everything
  and a policy that is not applied at all look identical from one side.
- **`$close()` finalises the statement cache, and without that it closes
  nothing.** bun's `close()` is `sqlite3_close_v2` — it defers the real
  destruction until the last prepared statement is finalized — and `wrapDb`
  holds up to 500. Measured: a close with one live statement freed **0 file
  descriptors**, and finalizing that statement freed 3. So for its whole life
  `$close()` produced a client that answered a cached query off a closed,
  checkpointed handle and threw on a fresh one, and the tenant pool's eviction
  paid a 7.97 ms `wal_checkpoint(TRUNCATE)` for a release that never happened
  (`FJS-640`). Every path now throws `ClientClosedError` naming the file. The
  read side needs its own call: `conn.readDb` is REPLACED by the read router,
  so anything reaching for `conn.readDb.close()` is talking to the router and
  not to the wrapper it closes over.
- **`$setAuth(user)` RETURNS a scoped client, it does not mutate.** `db.$setAuth(u)`
  then `db.thing.create(…)` grades as anonymous, silently.
- **A schema declaring any `@@gate` auto-installs `GatePlugin`.** You cannot run
  without gates; installing your own replaces the default, installing none does
  not disable it. Absent ≠ null in the lifecycle: absent means the app does not
  model that stage, only `null` grades down.
- **`sessionGateLevel()` is duplicated in Junction** (which this package may not
  import). Change one, change both.
- **`createClient({ db })` names MAIN's path and nothing else.** It overrides a
  declared `database main`, so `db: ':memory:'` is the in-memory test client. A
  SECOND declared database keeps its declared path regardless — `databases:
  ':memory:'` is the shorthand that moves every one of them, jsonl and logger
  included. Most specific wins: `databases: ':memory:'` > `databases: { main }` >
  `db` > the declaration.
- **`upsertMany` is TWO writes and they are policed by two different rules.** A
  row that will INSERT is a create and one that will conflict is an update, so
  the split has to be known before either rule can be applied — and it was
  neither: `create()` refused planting a row owned by somebody else and
  `upsertMany` planted it, `update()` refused writing to their row and
  `upsertMany` wrote it, and a `@@hasTemplates` template `updateMany` correctly
  skipped was written too (`FJS-720`). The presence lookup a logged model
  already pays for is now paid whenever the model has policies; the insert half
  calls `checkCreatePolicy` and refuses the batch WHOLE, like `createMany`; the
  update half rides SQLite's own `ON CONFLICT … DO UPDATE … WHERE`, where an
  unqualified column is the EXISTING row, and narrows rather than throwing —
  because that is what `updateMany` beside it does. `count` counts what SQLite
  moved rather than what the caller handed in, or a guarded skip reports as a
  write.
- **A bulk write prepares one statement per row SHAPE, and the shapes come from
  the rows.** `createMany`/`upsertMany` no longer take the column list from row
  0, so a batch may be ragged; rows still insert in caller order, because an
  autoincrement id is assigned in insert order. What a row does NOT carry, it
  does not write — the column takes its DDL default.
- **A key set to `undefined` is dropped from a write payload.** Only `null`
  clears (Invariant 9). `{ views: form.views }` off a form with no views field
  used to bind NULL and defeat the column's default.
- **An enum array has no CHECK behind it.** `targets ReclaimTarget[]` is a JSON
  TEXT column; SQLite cannot read a JSON array's elements without `json_each`,
  and a CHECK may not contain the subquery that would take. Membership is
  enforced at the client boundary only — the same tier as `@minItems` and
  `Int[]` element typing. Raw SQL writes anything.
- **A bare array in a `where` is not `equals`, on either kind of column.** It
  means *the column's value is in this list* — `IN` for a scalar, `IN` inside
  `json_each` for an array column, which is `hasSome`. **Prisma reads it as an
  exact match**, so a schema ported from there filters wider than it did. The
  exact, ordered comparison is `{ equals: [...] }`.
- **Columns are emitted verbatim camelCase; `DateTime` is ISO-8601 TEXT.** Hand-
  written SQL assuming snake_case or epoch-ms will not match — **and neither do
  SQLite's own clock functions.** `datetime('now')` answers `2026-08-13
  07:38:31`, the stored value is `2026-08-13T07:38:31.984Z`, the comparison is
  string-wise, and `'T'` sorts above a space: every row stored TODAY compares
  greater than a same-day `datetime('now')`, so the predicate is right for
  yesterday and wrong for this morning (`FJS-226`). `now()` is the spelling that
  matches, and the six forms that cannot are refused by name — in the `sql` tag,
  in a plain-string `$raw`, and in a `@from(where:)` at startup. `julianday()`
  is untouched: it answers a number, so it compares like with like.
- **`@@log(audit)` covers WRITES, so the events an app most wants are the ones
  it cannot see.** A failed login performs no write and left no trace at all; a
  successful one left `create:session` with `actorId: null`, because the write
  goes through `asSystem()` and a system context names no principal (`FJS-276`,
  `FJS-277`). `db.$audit()` is the one owner of recording deliberately, and it
  **throws** where `@@log` is fire-and-forget — there the record is a side effect
  of a write that already succeeded and must not fail it, here it is the point.
  A caller on a hot path that must not fail (auth's login) is the one that
  catches, and says so. `meta` is written as given: nothing redacts it, because
  field redaction protects columns the SCHEMA declared protected and this has no
  schema behind it.
- **A write event says whether it can name the row, and it says so in `scope`.**
  `row` is one row — `result` is it, or `null` where `select: false` skipped the
  RETURNING. `collection` is `count` rows matching `where`, from a statement that
  never built them. Do not read the discriminator off `result`: `result: null` is
  two different facts, and treating it as *no rows* is exactly what dropped every
  `select: false` write a layer up (`FJS-307`). Every one of the eleven write
  methods announces now — seven did not, `restore` and `delete` among them, both
  of which had their rows the whole time. `test/write-events.test.ts` is the grid
  and a new write path has to appear in it. **A write matching no rows announces
  nothing**: a count of zero sending every open tab back to the server is worse
  than saying nothing.
- **`announce` in the SCHEMA is the other axis — how far an announcement
  travels, not what shape it takes.** `database main { announce crossProcess }`
  (default `inProcess`) records each announced write in a table so every other
  process ON THIS MACHINE sharing the file hands it to its own `$tapEvents`
  subscribers, marked `foreign: true`, on the same seam — junction cannot tell
  the two apart (`FJS-D173`). Declared, because it costs **+14 µs on a 25 µs
  single-row insert** and nothing on a bulk one. The row carries the **id and
  never the row** — writing the row would put the plaintext of every
  `@encrypted` and `@guarded` column into a table beside the ciphertext — so the
  receiver re-reads, which means **the row arrives as it is NOW** rather than as
  it was when the event fired. Refused on a `jsonl`/`logger` driver by name.
  Two things it does not promise and both are stated: **one machine**, and
  **at-most-once across a crash**, since the row is recorded after the write's
  own transaction commits.
- **`announce` is the dial on a bulk write, and it is per CALL** — `collection`
  (default, one event, O(1), every list re-asks) · `rows` (one event per row, off
  `RETURNING`) · `none`. `createClient({ announce })` is the floor and a call
  beats it; an unknown value is refused by name before the statement runs.
  **Not decidable by size**: the count is unknowable before the write without a
  second query, so this is declared and never guessed — which is also why it is
  the CALL and not the model, since one model carries both a three-row cancel and
  a two-million-row purge. `rows` is ANDed with the audience, so an app that opts
  in and has nobody listening still takes no `RETURNING`. A logged model already
  takes one, so there it is free. **An announced bulk row goes through `read()`**
  — straight off `RETURNING` it still carries `@guarded` and `@encrypted`
  columns, which every other event path strips. `announceBulk` is the one owner
  of the three-way branch for that reason.
- **The audit logger defers one event-loop tick** — `fireLog()` writes via
  `setImmediate`, then the jsonl driver appends synchronously. A read in the same
  tick sees 0 rows and the `.jsonl` may not exist yet; anything after an `await`
  sees the row. Yield once rather than waiting: there is no timed buffer, and no
  flush on exit to wait for. **The swallow has to be on the PROMISE**: every
  driver's `create` is `async`, so the `try`/`catch` that was around the call
  caught nothing and a failed audit write became an unhandled rejection rather
  than the dropped row it is documented to be. It could not be seen while the
  index had a five-second wait; `busyTimeout: { audit: 0 }` makes it every time.
  Dropped but not silent — the first loss per model warns, once, because whatever
  produces one produces thousands.
- **`@guarded` is not a level** — it takes only `(all)`; `@guarded(5)` does not
  parse. Per-role column access is field-level `@allow`. It is a system-context
  lock in BOTH directions: a non-system write naming a guarded column is refused
  with an `AccessDeniedError` that names the field. `@encrypted` alone is not —
  it hides a value from a reader, and whoever supplies a secret is routinely not
  the system. A **required** `@guarded` column therefore makes the model
  uncreatable below level 8, and `verifyGateLadder` reports that create column
  ungraded rather than reading the field lock as a gate verdict.
- **A `@computed` field cannot be sorted, and `orderBy` now says so.** It is a JS
  function over a fetched row; SQLite cannot order or paginate by one. Both that
  and an unknown key THROW — stricter than the where-key check, which only warns
  on a read, because a bad filter returns fewer rows and a bad sort returns the
  right rows in the wrong order. `@from` sorts fine (it is a subquery in the
  SELECT). `db.$checkOrderBy(accessor, orderBy)` asks without running the query.
- **Nor can a column whose stored TEXT is a storage detail** — an array or a
  `Json` document (a serialization), a `File` (a reference), `@encrypted` or
  `@hashed` (an encoding). SQLite orders by that text, so `[10]` sorts before
  `[9]` and ciphertext reshuffles on every re-encryption. One bucket,
  `reason: 'opaque'` (`FJS-200`). An implicit m2m (`Tag[]`) is an array in the
  AST and a join table in SQLite — it is claimed as a RELATION before the array
  bucket sees it, or `orderBy: { tags: { _count } }` stops compiling.
- **An aggregate NAMES a column and builds no row, so it has to do both halves
  of `read()` itself.** Neither was done. A name that is not a column reaches
  SQLite as a quoted identifier, which it resolves as a string CONSTANT — so
  `_max: { comp: true }` answered `"comp"`, `_sum` answered `0`, and a plain
  typo did the same (`FJS-202`); and nothing stripped a protected column, so
  `_max` over a `@guarded` salary answered it, `_stringAgg` over one answered
  the whole column joined with commas, and `by: ['salary']` answered every
  distinct value with a count (`FJS-273`). **Eight arguments can carry a field
  name** — `_min`/`_max`/`_sum`/`_avg`, `_stringAgg`'s `field` and `orderBy`, a
  named aggregate's field, `_count: { distinct }` — plus `groupBy`'s `by` and
  `interval`. Two tiers: `by`/`distinct`/`interval` need a real column and
  nothing more (grouping stored text is self-consistent), everything producing a
  VALUE also refuses the opaque bucket. `fieldReadRefusal` mirrors
  `applyFieldPolicyTo`'s strip ladder over a name; a field-level
  `@allow('read', …)` is refused rather than evaluated, because it is a
  predicate over a row. The grid in `test/litestone.test.ts` § *an aggregate
  names a column* is what a new argument has to pass.
- **`@@unique(where:)` must never get `@@softDelete`'s clause ANDed into it, and
  `@@index(where:)` must keep getting it.** On an index the AND is an
  optimization — the clause is what makes the index reachable on such a model at
  all. On a UNIQUE index the predicate IS the constraint, so ANDing it is
  `FJS-204`'s rejected derivation arriving through the back door: the deleted row
  stops holding its `@unique` slot, and `SoftDeletedUniqueError` can never fire
  for a partial unique because the index no longer covers the row that would
  raise it. An author who wants uniqueness among live rows writes
  `where: deletedAt == null` themselves. `createIndexes` in `ddl.js` is the one
  place either rule lives, and the two loops are separate for that reason.
- **A partial unique's predicate has its literals INLINED, and an index's may not
  have any.** SQLite refuses a bound parameter in a partial index predicate
  whichever kind it is — `parameters prohibited in partial index WHERE clauses`,
  raised at migration time — and this compiler binds every value. The index form
  refuses a value comparison at parse for a different reason (the planner cannot
  prove a query implies it), so the two rules look like one and are not:
  `predicateToLite`'s `{ values: true }` is asked for on the unique path alone,
  because emitting a value comparison as `@@index(where:)` writes a `.lite` this
  parser refuses (`FJS-594`).
- **A soft-deleted row KEEPS its `@unique` values, and every write path says so
  the same way.** Ruled rather than fixed: freeing the slot makes `@unique`
  false for any read that includes deleted rows — `findUnique(withDeleted)`
  would legitimately match two — and makes `restore()` conditionally
  impossible, which is the whole contract. SQLite also cannot make an inline
  `UNIQUE` partial, so the alternative rebuilds every affected table.
  `SoftDeletedUniqueError` (409) names the field, the value and the holding
  row; releasing a slot is deliberate — `update({ …, withDeleted: true })` to
  move the value, `delete({ …, withDeleted: true })` to stop keeping the row
  (`FJS-204`, `DECISIONS.md` § Query & write semantics). **The four write paths
  gave four answers before, two silently** (`FJS-278`): `upsert` returned `null`
  having written nothing, because its race-recovery fallback assumes a UNIQUE
  conflict means a LIVE row appeared and retried as an `update` that filtered
  the deleted row; `upsertMany` is `ON CONFLICT DO UPDATE`, which SQLite
  resolves knowing nothing about soft delete, so the write landed IN the deleted
  row and reported success. A new write path that can hit the constraint routes
  through `asSoftDeletedConflict`, which only runs on the failing path.
- **`@@hasTemplates` and `@@softDelete` are the same two flags on every method,
  reads and writes alike** — `withTemplates`/`onlyTemplates`,
  `withDeleted`/`onlyDeleted`. Neither is an access rule, so **`asSystem()` does
  not lift either**; the flags are the only way past. They part company in one
  place: a hard `delete`/`deleteMany` bypasses the soft-delete filter by design
  (it is the purge hatch, and exists beside `remove` for that), while the
  template filter applies to it — a template is a live row in a parallel
  category, and destroying rows no read of the model returns is data loss the
  caller cannot anticipate (`FJS-176`). `restore()` is soft delete's way back;
  a template's is `update({ isTemplate: false, withTemplates: true })`.
- **A `@derived` field is built into the SAME map as `@from`, and that is why it
  reaches every read.** Both are virtual columns carried in the SELECT,
  filterable through `_fromExprMap` and stripped from writes by `stripVirtual`,
  so the six SELECT-building sites, the WHERE substitution and the ORDER BY all
  work unchanged — a seventh that forgot it would be silent, the way a forgotten
  `@from` is. It carries no params: compiled once at startup, `now()` emitting
  SQLite's own clock, which SQLite fixes for the duration of a statement.
  `aggregate`/`groupBy` build their own SELECTs and substitute the expression
  where a column name would go, or `MAX("urgency")` answers `'urgency'`
  (`FJS-202` through a new field kind). `auth()` is refused — a derived field is
  one value for the ROW, and per-caller is `@@scope` (`FJS-233`).
- **A `@from` applies the TARGET model's `@@softDelete` and `@@hasTemplates`.**
  Same as `include: { _count: true }` over the same relation. `withDeleted: true`
  / `withTemplates: true` opt back in; an explicit `where:` composes on top.
- **A `@computed` field the `select` did not name is not computed at all**, and
  one that declares `needs` narrows the SELECT to what it listed. A **bare** fn
  still widens to `SELECT *` — undeclared has to mean fetch everything — so one
  bare fn in a select widens it for the declared ones too. A declared fn is
  handed only its declared names and **throws** on any other read; that guard is
  what makes the narrow fetch safe, because the alternative is `undefined` and a
  plausible answer. `@from` values are resolved first, so a computed field may
  read one, and naming one in `needs` emits just that subquery.
  **Six sites build SELECTs of their own** — the
  query pipeline, `findManyCursor`, `search()`, `resolveIncludes` (×3 relation
  shapes) — and each has to append the `@from` subqueries itself;
  `fromSelectExpr()` / `deserializeFromRow()` are the shared definition.
  Forgetting one is silent, not loud: the field goes absent and `applyComputed`
  still runs, so a computed field over it answers a plausible `0`.
- **A write cannot return a `@from` field from `RETURNING`** — SQLite takes no
  correlated subquery there. `create`/`update`/`upsert`/`remove` re-read them
  (`hydrateFromFields`, one extra SELECT, only when the model declares `@from`);
  `delete` reads them on its pre-DELETE SELECT, the last moment they correlate.
  A new write path must opt in with `read(row, { hydrateFrom: true })` or it
  silently reintroduces the bug.
- **An FTS index mirrors its table, soft-deleted rows included** — `search()` is
  the only reader and does the filtering, which is what makes its
  `withDeleted`/`onlyDeleted` mean anything. Keeping deleted rows *out* of the
  index needs a second trigger, and two triggers firing on one soft delete is
  what made `@@softDelete` + `@@fts` unusable: FTS5 answers a repeated `'delete'`
  for one docid with `database disk image is malformed`, and only when the extra
  delete empties the structure — above one row it corrupts in silence.
- **A generated column is not in `PRAGMA table_info`, and a diff built on it is
  blind in both directions.** `introspect()` reads `table_xinfo` for that reason
  — `hidden` 2 = VIRTUAL, 3 = STORED — and the expression comes off the table's
  own `CREATE` statement, the only place SQLite keeps it. The pragma decides
  WHETHER a column is generated and the text parse only supplies the expression,
  so a parse miss cannot invent one. Three shapes follow from SQLite and none of
  them is a choice: a STORED add is a rebuild (`cannot add a STORED column` on a
  populated table), a VIRTUAL add is an `ADD COLUMN` **that has to carry its
  `GENERATED ALWAYS AS` clause** — without it the ALTER applies cleanly and
  leaves a plain writable column of the same name — and a rebuild must leave the
  column out of its `INSERT … SELECT` entirely (`cannot INSERT into generated
  column`), which loses nothing because the new table computes it.

- **A `@values` binding is checked through the CALLER'S accessor, and that is the
  whole of its permission story.** `enforceValueSets` reads the source model off
  `ctx.tables[accessor]` — the sibling at this client's own flavor — so the set
  a caller sees is the set their own `@@allow` shows them, and `open` creates
  through that same accessor, which means the source model's `@@gate` and
  `@@allow` answer who may extend it. Written against `asSystem()` it would
  offer every row to everybody and let any caller grow a shared list, and it
  would pass every test that uses one principal. **`suggested` issues no query
  at all** — enforcing nothing has to cost nothing, or nobody uses the strength
  that keeps the list traveling. **Six write paths carry a payload and all six
  call it**; `test/valuesets.test.ts` § every write path derives that list from
  `client.js` itself rather than restating it, because a seventh added later
  would be silent.
- **A column that LEAVES the schema is refused by `autoMigrate`, because a rename
  is a drop plus an add.** `diffColumns` has no rename detection, so
  `body` → `content` is a drop and an add, the rebuild copies only what the two
  tables share, and the values went — `state: 'migrated'`, with the row-count
  guard passing because it counts rows and not values (`FJS-641`). A plain drop
  was exactly as silent, which is why the rule is *any column drop* rather than
  the rename-shaped case. `{ acceptDataLoss: true }` is the escape — Prisma's
  `--accept-data-loss` on the mechanism this is modeled on — and the hash is
  withheld like the other blocked rules, so it re-announces on every boot. One
  column out and one in of the same type is reported as a probable rename with
  the `ALTER TABLE … RENAME COLUMN` to use instead; that guess changes the
  SENTENCE and never the decision, so being wrong costs a reader nothing. **The
  file path still applies** and gets a boxed DESTRUCTIVE banner instead: the
  file IS the review step, which is the whole difference between the two.
- **A rebuild SQLite refuses answers `state: 'failed'` rather than throwing.**
  A STRICT table takes no TEXT into an INTEGER column, so `String` → `Int` over a
  populated table threw `cannot store TEXT value in INTEGER column
  post__new.body` out of the migrator — at boot, naming a table that exists only
  inside the migration it died in (`FJS-645`). The transaction had already
  rolled back either way, so what was missing was the vocabulary. `failed` is a
  third state and honestly distinct from `blocked`: one is a pre-flight refusal,
  the other is SQLite declining what was attempted. A view the rebuild
  invalidates is `failed` too, where it used to throw.
- **The differ compares an enumerated list, and there is now a catch-all under
  it.** Six issues of this package's history are one dimension arriving in
  `ddl.js` and not in `diffSchemas` — generated columns, CHECK, table uniques,
  index order, index sorts, index predicates — each reading *schema is in sync*
  over a database that is not the declared one. Once the enumeration has spoken,
  the two `sqlite_master`s are compared whole and the leftovers are `diff.residue`
  (`FJS-717`, ruled `FJS-D186`). **Its first run named the seventh**: `onUpdate`
  was emitted, parsed, introspected and dropped by `fkKey` (`FJS-718`). It is
  deliberately **not part of `hasChanges`** — nothing here can write a migration
  for a dimension it cannot see, so counting it would generate an empty migration
  every boot for ever — and it does not block, because the commonest cause is the
  adoption door rather than a defect: a real database has a `COLLATE NOCASE` on
  its email column, and this language cannot say that. `autoMigrate` announces it
  and records it beside the DDL hash, so the fast path re-announces for one
  SELECT; `{ acceptResidue: true }` is the caller stating it, beside the
  `acceptDataLoss` it is modeled on. **Adding a dimension to the enumeration is
  what makes the tripwire go quiet**, which is the relationship to keep: a
  residue is a question, and the answer is usually a comparison this file is not
  making yet.
- **A migration only drops what litestone named.** Triggers: `*_fts_*`,
  `*_updatedAt`. Indexes: `idx_<table>_<fields>`. Anything the app created
  survives an ordinary migration — `introspect()` reads triggers into
  `__triggers` and a rebuilt table has its generated triggers restated, because
  a rebuild drops the table and its triggers with it. **A rebuild destroys an
  app-created trigger or index and litestone does not support carrying one
  through** (ruled, `FJS-183`); the generated migration names what it is about
  to destroy, and `autoMigrate` applies that SQL without showing it.
- **A view over a rebuilt table IS carried through** — dropped before, restated
  verbatim after, schema-declared and hand-made alike; left in place it takes
  the migration down, because `ALTER TABLE … RENAME` reparses every view. Each
  restored view is then read once inside the transaction, so one the rebuild
  invalidated refuses the migration instead of surviving broken. Not catchable
  when the body double-quotes the column — SQLite reads `"scratch"` as a string
  literal and reports nothing.
- **`encryptionKey` is parsed as hex**, so a 64-*character* key is not necessarily
  a 32-byte one.
- **Anything that loads a schema from a PATH loads it with `parseFile`, never
  `parse`.** A schema may `import "./other.lite"`, and only `parseFile` resolves
  that. Three readers had it wrong and each failed differently, all silently
  (`FJS-264`): the CLI read the root file for every command, so `db push`
  reported *already in sync* while three tables were never created; sierra's
  build handed the browser a `$defs` table with the imported models missing, so
  `createResource` degraded to a bare `make()` and a generated `<Form>` rendered
  nothing; and **`createTestEnv` graded a partial schema and passed** — a green
  `verifyGateLadder` over models it never saw, which is the worst of the three
  because it is the thing that exists to catch the other two.
- **`parse` is for TEXT with no file behind it** — an editor buffer, a git blob —
  and there the caller owes the imports. `inlineImports` / `inlineImportsFromDisk`
  in `parser.js` are the one owner of following an import line as text; reading
  and resolving are the caller's, because a git ref is addressed with posix paths
  through `git show` and a file on disk is not. Two callers: `release`'s baseline,
  which inlines **at the ref** (from the working tree it would compare the
  previous release's root schema against today's imported models and call every
  one unchanged), and `createTestEnv`, which needs ONE text because that text is
  the template cache key — keyed on the root file alone, editing an imported file
  reuses the previous run's database.
- **An import specifier is a path OR a package.** Relative and absolute are
  resolved against the importing file; anything else goes through node, so the
  package's own `exports` decides what is importable and nothing guesses at a
  path inside one. That is what lets a package SHIP a schema fragment
  (`import "@frontierjs/auth/schema.lite"`) instead of every app keeping a copy a
  package upgrade cannot reach (`FJS-265`). The failure message names both causes
  — not installed, or not exported — **always**, because node distinguishes them
  and bun collapses both into `MODULE_NOT_FOUND`; branching on the code makes the
  error depend on which runtime read the schema.
- **`import "..." into <db>` is how the importing app says where.** A shipped
  fragment has to spell some database name and only the app knows what its own are
  called, so `into` is the one parameter that varies. One rule, stated twice: the
  NEAREST statement wins — an inner `into` on a nested import beats an outer one,
  and any `into` beats a `@@db` written in the imported file. A model naming no
  database gets one. Importing one file twice under two different `into`s is an
  ERROR, not a precedence puzzle: it is merged once, so only one could hold.
- **`parse` and `parseFile` answer the same shape.** `parseFile` used to let a
  `ParseError` throw where `parse` returned `{valid: false, errors}`, so every
  caller that warns and keeps going — the CLI's error box, sierra's build, which
  is meant to leave the app running on explicitly-passed schemas — got a stack
  trace the moment a schema had a typo. An error in an imported file names that
  file, since imports chain.
