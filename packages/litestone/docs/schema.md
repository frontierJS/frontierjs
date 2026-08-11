# Schema

Schemas live in `.lite` files. Syntax is close to Prisma's SDL with SQLite-native extensions.

## Types

| Schema type | SQLite storage | JS type |
|---|---|---|
| `Int` | `INTEGER` | `number` |
| `Float` | `REAL` | `number` |
| `String` | `TEXT` | `string` |
| `Boolean` | `INTEGER` 0/1 | `boolean` (auto-coerced) |
| `DateTime` | `TEXT` ISO-8601 | `string` |
| `Json` | `TEXT` | `object` (auto-parsed) |
| `Bytes` | `BLOB` | `Buffer` |
| `File` | `TEXT` JSON ref | bytes in S3/R2/local (FileStorage plugin) |
| `File[]` | `TEXT` JSON array | multiple files |
| `EnumName` | `TEXT` + CHECK | `string` |
| `Type[]` | `TEXT` JSON | `Array` (auto-parsed) |
| `Type?` | nullable | `null` when absent |

## Field attributes

### Identity & constraints
```
@id                              primary key (auto-increment for Int @id)
@unique                          UNIQUE constraint
@map("column_name")              custom DB column name
```

### Default values
```
@default(now())                  current UTC timestamp
@default(uuid())                 UUID v4
@default(ulid())                 ULID
@default(cuid())                 CUID
@default(nanoid())               21-char URL-safe ID
@default(true)                   boolean / number / string literal
@default(auth().id)              stamped from ctx.auth at write time (runtime only, no SQL DEFAULT)
@default(fieldName)              copy sibling field value on create (compose with @slug)
```

### Lifecycle
```
@updatedAt                       auto-set to now() on every UPDATE
@updatedBy                       stamp ctx.auth.id on every UPDATE
@updatedBy(auth().field)         stamp custom auth field on every UPDATE
@createdBy                       stamp ctx.auth.id on CREATE
@createdBy(auth().field)         stamp custom auth field on CREATE
@version                         optimistic concurrency — Int, bumped on every write
@sequence(scope: field)          per-scope auto-increment — see sequences.md
```

`@createdBy` is a **stamp, not a default** — that is the whole difference from
`@default(auth().id)`. A default loses to a value in the payload, so an
authenticated caller could forge authorship by sending the column; a stamp
overwrites it. With no `ctx.auth` — `asSystem()`, a seeder, an anonymous write —
nothing is stamped and an explicit value is honoured, which is how backfills and
imports carry authorship in. It never re-stamps on update; that is `@updatedBy`.

Most models want the pair on the model instead — see
[`@@createdBy` / `@@updatedBy`](#authorship) below.

### `@version` — optimistic concurrency

Without it, two people editing the same row both `PATCH`, both succeed, and the
second silently erases the first. Declare the column and that becomes a 409:

```prisma
model Order {
  id      Int    @id
  status  String
  version Int    @version
}
```

```js
const alice = await db.order.findUnique({ where: { id: 1 } })   // version 1
const bob   = await db.order.findUnique({ where: { id: 1 } })   // version 1

await db.order.update({ where: { id: 1 }, data: { status: 'paid',  version: alice.version } })
// → { status: 'paid', version: 2 }

await db.order.update({ where: { id: 1 }, data: { status: 'void',  version: bob.version } })
// → throws VersionConflictError — expected 1, row is at 2
```

Mechanically it is the compare-and-swap `@@transitions` already runs, with the
column unfrozen: the update narrows its `WHERE` by the version you read, so a row
that moved does not match, and the bump rides the `SET`.

**The version travels in `data`**, not `where` — a row fetched through a Resource
carries every column, so it round-trips through a form with no extra plumbing.
It is a precondition, never a value: the column is bumped by SQL and never set to
what arrived.

Per path:

| Path | Requires a version | Bumps |
| --- | --- | --- |
| `create` / `createMany` | — | starts at **1**, whatever the payload says |
| `update` | **yes** | ✓ |
| `updateMany` | no | ✓ |
| `upsert` / `upsertMany` | no | ✓ (insert starts at 1) |

`update` is the concurrent-editor path, so it is the one that insists. A bulk
`where` matches many rows and therefore many versions — there is no single value
to compare — and an upsert is reached by natural key from a sync or an import,
which cannot have read a version. Both still **bump**, which is what keeps an
open editor correctly stale after one lands.

- **Escape hatch:** `asSystem()` writes skip the check and still bump — a
  migration or a job is not a second editor. Same reason `asSystem()` skips gates.
- Errors: `VersionRequiredError` (400, not retryable — you left out an input) and
  `VersionConflictError` (409, **retryable** — re-read and re-apply). Both carry
  `status`, so Junction maps them with no registration.
- Not-found stays `null`. A 409 means the row is there and moved.
- Reaches the client as `readOnly` in the update schema plus **`x-version`** on
  the model naming the column; absent from the create schema. Typegen drops it
  from `*Create` and makes it **required** in `*Update`.
- One per model, `Int`, not optional, not the `@id` — all schema errors.

### Visibility & security
```
@omit                            excluded from findMany/findFirst (still in findUnique)
@omit(all)                       excluded from all reads
@guarded                         excluded unless asSystem()
@guarded(all)                    excluded from all operations unless asSystem()
@encrypted                       AES-256-GCM at rest (implies @guarded(all))
@encrypted(searchable: true)     HMAC-indexed — equality WHERE still works encrypted
@secret                          @encrypted + @guarded(all) + @log(auditDb)
@secret(rotate: false)           same but excluded from $rotateKey
```

### Field-level policy
```
@allow('read'|'write'|'all', expr)
```
See [access-control.md](./access-control.md).

### Derived & generated
```
@computed                        app-layer derived field (implement in computed.js)
@generated("sql expr")           SQL GENERATED ALWAYS AS column (STORED)
@from(Model, count: true)        derived count from relation (not stored) — field must be Int
@from(Model, sum: field)         derived sum/max/min — take a field name
@from(Model, first|last: true)   the whole related ROW — field must be typed Model?
@from(Model, exists: true)       field must be Boolean
@from(Model, count: true, where: "sql", orderBy: field)  filtered / ordered
@from(Model, count: true, withDeleted: true)     include the target's soft-deleted rows
@from(Model, count: true, withTemplates: true)   include the target's @@hasTemplates rows
```

A `@from` reads the target model the way the target model is read: if it declares
`@@softDelete`, deleted rows are out; if it declares `@@hasTemplates`, template
rows are out. That matches `include: { _count: true }` over the same relation.
The two flags opt back in independently, and an explicit `where:` composes on
top of whichever filters remain.

A `@from` field is a correlated subquery in the SELECT list, so it can be
filtered (`where: { orderCount: { gt: 5 } }`) and sorted
(`orderBy: { orderCount: 'desc' }`). A `@computed` field is a JS function over an
already-fetched row, so it can be neither — see
[sorting.md](./sorting.md#what-can-be-sorted).

### Computed fields resolve their own dependencies

You never list what a `@computed` field reads. Selecting one sets
`needsAllDbCols`, which widens the SQL to every column of the row, and the
result is trimmed back to what you asked for afterwards:

```js
db.client.findMany({ select: { chattiness: true } })   // → { chattiness: 20 }
// fetched every column plus the @from subqueries, ran the fn, then trimmed
```

`@from` values are resolved before computed functions run, so a `@computed`
field may read one. The cost is worth knowing: **naming one computed field in a
`select` turns it into a `SELECT *`.** There is no way to declare a narrower
dependency set.

Both hold on every read path — `findMany`, `findFirst`, `findUnique`,
`findManyAndCount`, `findManyCursor`, and a model reached through `include`.

### File storage
```
@keepVersions                    skip S3 object cleanup on File? update
@accept("mime/type")             validate MIME before upload (wildcards + comma-list OK)
```

### Validators (run on every create + update)
```
@email                           valid email address
@url                             valid URL
@phone                           E.164 + common formats
@date                            YYYY-MM-DD date string
@datetime                        ISO-8601 datetime string
@regex("pattern")                regex validation
@length(min, max)                string length (either bound optional)
@gt(n)  @gte(n)  @lt(n)  @lte(n)
@startsWith(s)  @endsWith(s)  @contains(s)
```

### Transforms (applied before validation + write)
```
@trim    @lower    @upper    @slug
```

### Annotations
```
@markdown                        semantic — field contains Markdown (no validation)
@hardDelete                      on relation field: hard-delete children in @@softDelete(cascade)
@log(dbName)                     field-level audit log to a logger database
```

## Naming conventions

**Model names** are `PascalCase` singular:

```prisma
model User { ... }
model ServiceAgreement { ... }
model BlogPost { ... }
```

**Client accessors** are `camelCase` singular — always, regardless of config:

```js
db.user.findMany()
db.serviceAgreement.findFirst()
db.blogPost.create({ data: {...} })
```

**Table names** are `snake_case` of the model name by default:

| Model | Table | Accessor |
|---|---|---|
| `User` | `user` | `db.user` |
| `ServiceAgreement` | `service_agreement` | `db.serviceAgreement` |
| `BlogPost` | `blog_post` | `db.blogPost` |

With `pluralize: true` in `litestone.config.js`, table names are pluralized:

| Model | Table | Accessor |
|---|---|---|
| `User` | `users` | `db.user` |
| `ServiceAgreement` | `service_agreements` | `db.serviceAgreement` |
| `Category` | `categories` | `db.category` |

`@@map("custom_name")` always wins over any derivation — use it for irregular plurals or legacy table names:

```prisma
model Person {
  @@map("people")    // table: people, accessor: db.person
}
```

## Model attributes

### Database routing
```
@@db(dbName)                     assign to a named database block
@@external                       table managed outside Litestone — queryable, no DDL/migrations
```

### Table structure
```
@@index([col1, col2])            composite index (partial on soft-delete tables automatically)
@@unique([col1, col2])           composite unique constraint
@@map("table_name")              custom DB table name
@@strict                         SQLite STRICT mode (default)
@@noStrict                       opt out of STRICT mode
```

### Soft delete
```
@@softDelete                     requires deletedAt DateTime? field
@@softDelete(cascade)            cascade remove/restore through FK children
```
See [soft-delete.md](./soft-delete.md).

### Full-text search
```
@@fts([field1, field2])          FTS5 virtual table + sync triggers
```
See [full-text-search.md](./full-text-search.md).

### Authorship
```
@@createdBy                      adds createdById + createdBy, stamped on create
@@updatedBy                      adds updatedById + updatedBy, restamped on every update
@@createdBy(owner)               same pair, named ownerId + owner
@@updatedBy(as: "editor")        same, long form
```

Sugar. Each one expands at parse time into the two fields you would otherwise
hand-write — a nullable FK carrying the stamp, and a named relation to the
`@@auth` model:

```prisma
model User { id Int @id  name String  @@auth }

model Doc {
  id    Int    @id
  title String
  @@createdBy
  @@updatedBy
}

// …is exactly:

model Doc {
  id          Int    @id
  title       String
  createdById Int?   @createdBy
  createdBy   User?  @relation("Doc_createdBy", fields: [createdById], references: [id])
  updatedById Int?   @updatedBy
  updatedBy   User?  @relation("Doc_updatedBy", fields: [updatedById], references: [id])
}
```

Nothing downstream knows the attribute existed — DDL emits both foreign keys,
`include: { createdBy: true }` resolves the row, typegen and JSON Schema see
ordinary fields.

- The FK type is copied from the `@@auth` model's `@id`, so an `Int` id and a
  `String @default(uuid())` id both land right.
- Both columns are **nullable**. `asSystem()` writes and anonymous creates have
  no author, and a `NOT NULL` here would break every seeder and backfill.
- The relations are **named** (`"<Model>_<base>"`) because a model carrying both
  attributes has two relations to the same model, which is otherwise ambiguous.
  A model marked `@@auth` may author itself.
- A field you declare yourself under either name **wins and is left alone** —
  write `createdById String? @createdBy @omit` and you still get the relation
  for free.
- Without a model marked `@@auth`, both are a schema error.

Every write path runs the stamps — `create`, `createMany`, `update`,
`updateMany`, `upsert` and `upsertMany`. In `upsertMany` an insert is stamped
and a conflict is treated as what it is: `@updatedBy` moves, and the create-time
columns (`@createdBy`, `@default(auth().field)`) are held out of the
`ON CONFLICT … SET` list so the author survives. Name one in an explicit
`update: [...]` and it moves anyway — that is a deliberate request.

### Access control
```
@@gate("R.C.U.D")                level-based access (read.create.update.delete)
@@auth                           marks model as auth subject for auth() expressions
@@allow('read'|'create'|'update'|'delete'|'all', expr)
@@allow('op', expr, "custom error message")
@@deny('read'|..., expr)
@@deny('op', expr, "custom error message")
```
See [access-control.md](./access-control.md).

### Audit logging
```
@@log(dbName)                    log all writes to a logger database
```
See [audit-logging.md](./audit-logging.md).

## Enums

```prisma
enum Plan { starter  pro  enterprise }
enum Role { admin  member  viewer }

model User {
  plan Plan @default(starter)
  role Role @default(member)
}
```

### State machines

An `Order` can go `pending → paid → shipped` but never `shipped → pending`, and only an admin can refund. Declare that once on the model and Litestone enforces it at the Data boundary:

```prisma
enum OrderStatus { pending  paid  shipped  refunded  cancelled }

model Order {
  id     Int @id
  status OrderStatus @default(pending)

  @@transitions(status,
    pay:    pending         -> paid,
    ship:   paid            -> shipped,
    refund: paid            -> refunded @gate(5),
    cancel: [pending, paid] -> cancelled)
}
```

- **The name is optional** — `pending -> paid` names itself after the target state. Name it when you want to call it: `db.order.transition(id, 'pay')`.
- **`from` takes a list** — `[pending, paid] -> cancelled`.
- **`@gate(N)`** is the minimum level allowed to make that particular move, on Litestone's 0–9 scale (a number or a name: `@gate(ADMINISTRATOR)`). It is a floor *on top of* `@@gate`'s update level, which had to pass to reach the write at all — shipping an order and refunding one are not the same authority.

Any move that isn't declared throws `TransitionViolationError`; a declared one the caller can't make throws `TransitionGateError` (which carries `status: 403`). The `WHERE` clause is narrowed to the from-state, so two concurrent writers can't both win — the loser gets a retryable `TransitionConflictError`.

> **`@gate` needs a level resolver.** A schema with any gated transition auto-installs `GatePlugin({ getLevel: FrontierGateGetLevel })` if you configure none — a declared gate that silently did nothing would be a fail-open default. But the shipped resolver grades a bare session at `VISITOR(1)`: it wants both `verifiedAt` and `activatedAt` on the user object, and returns `CREATOR(3)` when it gets them. It never returns 4+. Pass your own `getLevel` to `GatePlugin` for anything real.

`updateMany` skips enforcement, deliberately: it's a power tool and the caller takes responsibility. `asSystem()` bypasses it too, and says so on stderr.

#### Asking what's legal

```js
await db.order.transitions(row)   // or transitions(id)
// → [{ name: 'ship',   field: 'status', from: 'paid', to: 'shipped',  gate: null, allowed: true  },
//    { name: 'refund', field: 'status', from: 'paid', to: 'refunded', gate: 5,    allowed: false }]
```

The legal next states for *this* record at *this* user's level. A gated move the caller can't make is returned with `allowed: false` rather than dropped — a disabled button is usually better UI than a missing one.

The same list reaches the browser: `generateJsonSchema` emits `x-transitions` on the model, and Sierra's `resource.transitions(row, level)` returns the identical shape. That's a UI affordance only — the server enforces regardless.

#### Declaring it on the enum instead

When one enum means the same thing everywhere it's used, declare the machine once and every model with a field of that type picks it up:

```prisma
enum OrderStatus {
  pending  paid  shipped

  transitions {
    pay:  pending -> paid
    ship: paid    -> shipped
  }
}
```

This is shorthand: it desugars into a `@@transitions` on each model using the enum, so everything above applies unchanged. A model that declares its own `@@transitions` for that field overrides the enum's outright rather than merging. Gates need the model form — the same enum on two models would otherwise be forced to share one authority level.

## Schema functions

Reusable named SQL expressions — define once, reference on any model:

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
  displayName String  @fullName(firstName, lastName)  // → STORED generated column
}

model Post {
  title String
  slug  String  @slug(title)   // same function, different model
}
```

Generated columns are `STORED` in SQLite and indexable.

## Multi-file schemas

```prisma
// schema.lite
import "./functions.lite"
import "./enums.lite"
import "./models/users.lite"
import "./models/posts.lite"
```

Paths resolve relative to the importing file. Circular imports are deduplicated. Use `parseFile()` when your schema uses imports so paths resolve correctly from the file's location.

## Doc comments

`///` triple-slash comments become JSDoc on generated TypeScript types and `description` in JSON Schema output:

```prisma
/// A registered user account.
model User {
  id    Int @id
  email String    /// The user's primary email address.
  role  Role    /// Access level — affects what the user can see and do.
}
```
