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
| `EnumName[]` | `TEXT` JSON, no CHECK | `string[]` — a set of declared values |
| `Capability[]` | `TEXT` JSON, no CHECK | `string[]` — synthesised from the models declaring `@@capabilities`; see `access-control.md` |
| `Type[]` | `TEXT` JSON | `Array` (auto-parsed) |
| `Type?` | nullable | `null` when absent |

An array column is JSON text with a `json_type = 'array'` CHECK, and the empty
array is its null state — every array field is `NOT NULL DEFAULT '[]'`, so an
absent one reads back as `[]` rather than `null`, and a write of `null` is
refused. That holds with no attribute at all, which is why `@default([])` says
out loud what the column already does; declare it if the schema reads better for
saying so.

A non-empty default is an array literal — `@default(["a", "b"])`, `@default([1, 2])`,
`@default([Active, Pending])` for enum members, written bare exactly as a scalar
enum default is. Every element is graded against the column's own base type, so
`String[] @default([1])` is a schema error rather than a number sitting in a text
column. `@default("[…]")`, the JSON-string spelling, still parses and is graded
by the same rules; it is normalized into the literal, so everything downstream —
the DDL, the JSON Schema, `release:check` — reads one shape. A `Json` column
takes the literal too, since it can hold a list; a column that holds one value
refuses it by name.

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
@default([])                     an array column's empty list — what it does anyway
@default(["a", "b"])             an array literal; elements typed against the column
@default([Active])               enum members, bare — the scalar enum spelling, in a list
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
nothing is stamped and an explicit value is honored, which is how backfills and
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
@guarded                         system-context column: stripped from every read, refused on
                                 every write, and refused in a where/orderBy/distinct/cursor
                                 — naming it recovers it — unless asSystem()
@guarded(all)                    the same, and an explicit select cannot unlock the read
@encrypted                       AES-256-GCM at rest — hidden from a non-system read, and
                                 writable by a non-system caller
@encrypted(deterministic: true)  IV derived from the value — equality WHERE works, and it reads back
@hashed                          HMAC-SHA256, one-way — matchable in a WHERE, never readable
@secret                          @encrypted + @guarded(all) + @log(auditDb)
@secret(rotate: false)           same but excluded from $rotateKey — and therefore
                                 unreadable after one, since the key swap is global.
                                 $rotateKey refuses while one exists
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
@generated(`{a} {b}`)            BACKTICKS: a template — the string it produces, rather
                                 than SQL. A NULL column takes the separator beside it
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

**None of them can be written.** Passing a `@computed` or `@generated` field in a
`create` or `update` is refused naming the field and saying which it is; the value
comes from its expression or its function, and a write that appeared to succeed
would be a write that never landed. An *unknown* key is still stripped silently —
that is the mass-assignment protection, and it is a different thing.

### Computed fields may declare what they read

A computed function written bare resolves its own dependencies, and pays for it:
naming the field in a `select` widens the SQL to every column of the row, plus
every `@from` subquery on the model, and the result is trimmed back afterwards.

```js
// computed.js
export default {
  Client: {
    chattiness: row => row.noteCount * 2,                       // → SELECT *
  },
}
```

Declaring the inputs narrows the fetch to exactly them:

```js
export default {
  Client: {
    chattiness: {
      needs:   ['noteCount'],                                   // stored columns and @from fields
      compute: row => row.noteCount * 2,
    },
  },
}

db.client.findMany({ select: { chattiness: true } })
// SELECT (SELECT COUNT(*) …) AS "noteCount" FROM "client"   → [{ chattiness: 20 }]
```

The dependency is fetched and then trimmed — asking for a computed field never
smuggles its inputs into the result.

**A declared fn is handed only what it declared, and reading anything else
throws** naming the field and the list. Without that the declaration would be a
footgun: add a line to the fn, forget the list, and the value goes quietly wrong
instead of failing. `'x' in row` is left alone, so feature-detection still works.
A `needs` naming something that is not a readable field of the model is refused
at `createClient`.

Undeclared has to mean *fetch everything*, since nothing can know what a bare fn
will touch — so **one bare fn in a `select` widens it for the declared ones too.**

`@from` values are resolved before computed functions run, so a computed field
may read one, declared or not.

**A computed field the `select` did not ask for is not computed at all.** With no
`select`, every computed field runs over the whole row.

All of it holds on every read path — `findMany`, `findFirst`, `findUnique`,
`findManyAndCount`, `findManyCursor`, `search`, and a model reached through
`include`.

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
@time                            HH:MM, 24-hour, leading zeros required
@time(seconds: true)             HH:MM:SS accepted as well — named args only
@regex("pattern")                regex validation
@length(min, max)                string length (either bound optional)
@gt(n)  @gte(n)  @lt(n)  @lte(n)
@startsWith(s)  @endsWith(s)  @contains(s)
@minItems(n)  @maxItems(n)  @uniqueItems     array columns only
```

`@time` is a wall clock and not an instant: no date, no zone. It reaches a form
as `<input type="time">` — carried by a `pattern` rather than by JSON Schema's
`format: 'time'`, which means RFC 3339 full-time and would demand seconds and an
offset this rule does not accept. The seconds flag WIDENS what may be stored; it
does not make a finer value mandatory. What a zoned time would look like is not
settled — `IDEAS/time-and-recurrence.md`.

An array column also carries two rules that come from its TYPE rather than an
attribute: the value must be an array, and on `Int[]` / `String[]` the elements
must be of that type. SQLite stores the column as a JSON document whichever they
are, so nothing below this boundary would notice.

**Every validator here takes an optional trailing message** —
`@length(3, 20, "A reference is 3 to 20 characters")`,
`@minItems(2, "Pick at least two tags")`, `@uniqueItems("No duplicate codes")`.
It is enforced by the server AND emitted to the client in `x-messages`, so one
authored string is what every realm says. The wording when there is none comes
from `DEFAULT_MESSAGES` in `core/validate.js`, which is the single definition of
it — a rule enforced anywhere else, with its wording built at the throw site, is
how the two realms end up refusing the same write in different words.

### Constraints the database enforces (`@check`, `@@check`)

```
@check("qty > 0")                          on a field — a SQLite CHECK on that column
@check("qty > 0", "must be at least one")  with the sentence a form shows
@@check("startsAt < endsAt")               on the model — spans columns. Repeatable
@@check("startsAt < endsAt", "an end must come after its start")
```

**These are the rules the database refuses, not the ones the client checks.** A
validator above runs in this package and is emitted to the client, so a form can
refuse a value before sending it; a CHECK is in the table, so it holds against a
job writing through `db.`, a migration, `asSystem()`, a seed and `fli tinker` —
every writer that does not pass through a service. The cost of that reach is
that it cannot be evaluated in a browser, so it arrives as a refusal rather than
as an affordance.

**`@@check` is the half that spans columns**, which nothing else can say: a
validator sees one field, `@@unique` is about rows in a table rather than values
in a row, `@@allow` is who rather than what is valid, and `@@transitions` is one
column's moves. `startsAt < endsAt`, `discount <= subtotal` and
`status != 'shipped' OR trackingCode IS NOT NULL` have no other home in the seed.

**A violation is a `ValidationError`** — 400, with `errors` — so it lands under
the control like any other refused value. A field `@check` names its column; a
`@@check` spans them, so its message is on the record rather than on a box.

**Write the message.** Without one the person sees `is not valid` and the
expression goes to the developer on `err.constraint`, because `qty > 0` under a
form control is SQL reaching somebody who did not write it. The message is the
last argument, where every validator above carries one.

**Editing an expression rebuilds the table.** SQLite cannot alter a CHECK in
place, so the migrator compares the constraint text and rebuilds when it moves.
Adding one to a populated table is also a **contract** for `fli release:check`:
the release still serving can write rows the new constraint forbids.

### What a `@@check` cannot say

**It sees one ROW.** *The lines sum to `subtotal`*, *the journal balances*, *the
counting lines add up to net* each read a child table, and there is no attribute
for them — deliberately, and the reason is worth knowing before you look for one
(`FJS-D168`).

The obstacle is not that the rule is hard to write down. It is **when it would be
evaluated**. A declared check reads the child table, so it can only fire once
those rows exist; the child carries the parent's id, so the parent is written
first and the last statement is always a child insert. After every child insert
the invariant is legitimately false until the final one, and nothing in SQL knows
which one is final:

| statement | rows in the child table | a declared `sum(lines) = net` |
| --- | --- | --- |
| `payslip.create({ net: 45000 })` | 0 | `0 != 45000` → refuse |
| `payslipLine.createMany([…])` | 7 | would pass — never reached |

**Write it in the function that writes the document, against the values you are
about to insert.** That runs before the first INSERT rather than after it, names
the two figures that disagree, and is the shape all three of `example`'s take.
The one place something else can say *now* is a `@seals` move, which is why a
sealing model can afford to check at the seal — and a model with no state machine
has no equivalent moment to borrow.

**What the schema does owe a document is the MOMENT and the FREEZE**, and those
are declarable: `@seals` on the transition and `@immutable` on the columns, so
nothing can restate a figure after the assertion passed.

### Exclusive foreign keys (`@@arc`)

```
@@arc([orderId, productId])                                  exactly one is set
@@arc([orderId, productId], optional: true)                  at most one — the row may point at nothing
@@arc([orderId, productId], message: "an order or a product")  the sentence a form shows
```

**The question it answers is *this row points at an Order or a Product*.** The
reach for that is usually a polymorphic pair — a `subjectType` naming a model and
a `subjectId` holding a key — and the pair keeps none of what a relation is for:
no foreign key, so nothing refuses an id that was deleted; no `onDelete`, so
something has to sweep the orphans and that something is a job, because the
database will not; and no `include`, so reading the subject is a second query per
type.

**An arc keeps all three, because the members are ordinary relations.** Each is a
real `@relation` with a real `onDelete`, and the only thing the attribute adds is
the rule that exactly one of them is set — emitted as a table CHECK counting the
non-null members. So it holds where every constraint in this section holds:
against a job on `db.`, a migration, a seed, an atomic operator, and against
`asSystem()`, which drops the gate, every row policy and `@@softDelete` and
cannot drop a CHECK.

```
model Attachment {
  id        Int      @id
  tagId     Int
  tag       Tag      @relation(fields: [tagId], references: [id], onDelete: Cascade)

  orderId   Int?
  order     Order?   @relation(fields: [orderId],   references: [id], onDelete: Cascade)
  productId Int?
  product   Product? @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@arc([orderId, productId])
}
```

**Members must exist and must be optional.** A required member is refused at
parse, because a column that is always set is always the answer — with two of
them the arc can never be satisfied, and with one among optionals it is not a
choice. An unknown member is refused by the same check that covers every
`@@`-attribute naming a field, so a renamed column fails at parse rather than at
migration time against a table you are no longer looking at.

**The message is derived when you do not write one** — `exactly one of orderId,
productId must be set`, or `at most one … may be set` under `optional: true`.
That is better than the generic sentence and worse than domain language, so write
`message:` where a person will read it. As with `@@check`, the expression stays
on `err.constraint` for the developer and out of the message: a rule spanning
columns marks no single box, so it is a record-level error.

**One column per member, and it does not scale far.** Six is uncomfortable and
ten is a mistake. That ceiling is the useful part of the design: reaching it
means the set of things this row can point at is *open*, and an open set is the
one case no relation can serve — there, the polymorphic pair is the honest
answer, along with the sweep job and the absence of integrity it comes with. See
`references/Tag.lite`, which argues both sides at the file somebody copies.

**When you do take the pair, make the discriminator an `enum`.** There is no
foreign key on it by construction, so the type column is the one thing left that
can carry a rule — and an enum emits a table CHECK, which holds where every
constraint in this section holds: against a migration, a seed, an atomic
operator and `asSystem()`. It also reaches the browser as a set, so a generated
form offers a picker instead of a text box for a model name.

```
enum NoteSubject { Order Product }

model Note {
  subjectType NoteSubject
  subjectId   Int
  @@index([subjectType, subjectId])
}
```

`@@check("subjectType IN ('Order', 'Product')")` is the same enforcement where
the values are not identifiers. Neither buys integrity — the *id* is still
unenforced and the sweep is still owed — but it is the difference between *this
points at something* and *this points at nothing and nobody noticed*.

**Leave it a `String` only where the set grows with every model you add**: an
audit trail naming the service that wrote the row is that case, and an enum
there refuses the first row a new service writes. `fli check`'s
`polymorphic-subject` asks the question and takes a baseline entry for the
answer. Measured across seven published schemas, the genuine case is rare —
ERPNext declares the target set for 17 of its 78 polymorphic fields and leaves
61 unconstrained, and the split is not the domain: `party_type` is declared
closed twice and left open sixteen times in the same codebase.

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
@@index([a, b(sort: Desc)])      a per-column DIRECTION. SQLite walks a b-tree either way,
                                 so one column never needs it; a COMPOSITE index whose
                                 columns disagree does, and that is the only shape it is
                                 for. Prisma's spelling, and ZenStack v2 and v3 declare
                                 @@index byte-identically and mark it @@@prisma — inherited
                                 unchanged — so an imported schema carries it through.
                                 `Asc`/`Desc`; lowercase is the client's own orderBy word
                                 for the same thing and is accepted. The index NAME is
                                 derived from the columns and not from the directions, so
                                 adding one does not rename an existing index — the
                                 migrator sees the change, drops and recreates
@@index([col], where: <expr>)    a PARTIAL index — it holds only the rows the predicate
                                 admits, so it is smaller, cheaper to maintain, and can
                                 express what a full index cannot. The predicate is the
                                 @@scope expression language, narrowed to what a partial
                                 index can actually be REACHED by: SQLite proves that a
                                 query implies the index when it PREPARES the query, and
                                 litestone binds every value in a `where` except a null
                                 test — so a predicate comparing against a value would be
                                 matched by nothing and maintained on every write. Refused
                                 at parse, therefore, along with auth() (one index, every
                                 caller), now() (SQLite refuses a non-deterministic index
                                 predicate) and anything compiling to a subquery. What is
                                 left is `col == null`, `col != null`, `col == true`,
                                 `col == false`, and those joined with && or ||. On a
                                 soft-delete model the declared
                                 predicate is ANDed with `deletedAt IS NULL` rather than
                                 replacing it. Two @@index over the same columns derive one
                                 index name whatever their predicates, and the second is
                                 refused. See docs/performance.md § Partial indexes
@@id([col1, col2])               the row's identity IS the tuple — see § A key that is a
                                 tuple below
@@unique([col1, col2])           composite unique constraint. A NULLABLE member is
                                 refused at parse: two NULLs never compare equal, so rows
                                 that leave it unset are all distinct to the index and the
                                 constraint holds only where it was never in doubt. Give
                                 the column a @default, or say the shape is deliberate —
@@unique([a, b], nullsDistinct: true)
                                 SQL's own word for what SQLite does, and it changes no
                                 emitted SQL. Single-column @unique over an optional column
                                 is untouched: unique-when-present has one reading
@@unique([a], where: expr)       …or the other answer to the same question: the constraint
                                 holds over the rows the predicate admits and says nothing
                                 about the rest. *At most one OPEN row per parent* is
                                 `where: effectiveTo == null`, and the nullable column moves
                                 OUT of the tuple to get there. Not combinable with
                                 nullsDistinct — a predicate already says which rows are
                                 constrained. See § Conditional uniqueness below
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
@@strict                         SQLite STRICT mode (default)
@@noStrict                       opt out of STRICT mode
```

### Conditional uniqueness (`@@unique(where:)`)

*At most one open window per employee.* *One current price per plan.* *One
active membership per person.* Every one of those is uniqueness over SOME rows,
and it is what effective dating is built on.

```
model PayWindow {
  employeeId    Int
  effectiveFrom DateTime
  effectiveTo   DateTime?

  @@unique([employeeId], where: effectiveTo == null)
}
```

**The nullable column moves out of the tuple.** The near miss is
`@@unique([employeeId, effectiveTo])`, which is refused: `effectiveTo` is null on
exactly the row that matters and two NULLs never compare equal, so the tuple
constrains the CLOSED rows and nothing else. `nullsDistinct: true` declares that
on purpose; `where:` is the other answer, and the two cannot both be given.

**One word, two mechanisms.** A plain `@@unique` is emitted inside `CREATE TABLE`
as a table constraint. No SQL dialect takes a predicate on one, so this form is a
standalone `CREATE UNIQUE INDEX … WHERE` — which is worth knowing three times
over: it migrates by one DROP and one CREATE where a table constraint rebuilds the
table, it does **not** make a relation one-to-one (a constraint holding over some
rows does not say *at most one row per parent, always*), and it is read back as an
index rather than as declared uniqueness.

**It may compare against a value, where `@@index(where:)` may not.** A partial
index earns its place by being matched, and SQLite has to prove a query implies it
at PREPARE time; enforcement on INSERT never consults the planner. So
`where: status == "active"` is a correct constraint that happens to be a useless
read path, and the same predicate on `@@index` is nothing but a useless read path.
The literals are inlined into the emitted DDL, because SQLite prohibits a bound
parameter in a partial index predicate. `now()` and `auth()` are refused by name —
SQLite accepts a clock there, and a constraint whose coverage moves under a row
that never moved is a duplicate.

**`@@softDelete`'s clause is not ANDed in.** On an `@@index` it is, because that
clause is what makes the index reachable on such a model. Here the predicate IS
the constraint, and ANDing it would free the `@unique` slot a soft-deleted row
holds — which is the derivation `FJS-204` refused. Uniqueness among live rows is
`where: deletedAt == null`, written by you.

**Adding one is a contract for `release:check`**, like any row invariant: the
release still serving knows nothing about it and writes rows the new one forbids.
Removing one is an expand. A predicate ADDED where there was none is an expand
(the constraint now covers fewer rows); one REMOVED is a contract; a move between
two predicates is `unknown`, because whether one implies the other is implication
between two SQL expressions.

### A key that is a tuple (`@@id`)

Where a row is identified by several columns together — a membership, a join
table with its own columns, a partitioned table, a reading keyed by
`(key, action)` — the key is declared once at the model level:

```
model Membership {
  orgId  String
  userId String
  role   String

  @@id([orgId, userId])
}
```

**It is sugar over `@id` on each named field**, and that is what makes it cheap:
several `@id` fields is a shape the rest of the package already handles, so a
composite key works through `findUnique({ where: { orgId, userId } })`, a
relation, an `include`, `@@softDelete` and the migrator with nothing taught to
any of them. Litestone's own implicit many-to-many join table has been one of
these since it was written.

**What it adds over marking the fields is the key's column ORDER.** A primary key
builds an implicit index, and an implicit index is prefix-matched like any other:
`PRIMARY KEY (orgId, userId)` answers `WHERE orgId = ?` and the swap does not.
With `@id` on the fields the key order is the *field declaration* order, which is
a different fact about the model — so there was nowhere to say it, and
`litestone introspect` read `PRIMARY KEY ("userId","orgId")` off a real table and
wrote a schema that builds it the other way round, silently
([FJS-561](../../../ISSUES.md#fjs-561)).

It is also the spelling Prisma, Rails and raw DDL all use, so `litestone import`
carries the key across instead of inventing `id String @id @default(cuid())`
plus a `@@unique` — which is a *different* statement, because it admits a second
identity for the same tuple.

Five things are refused at parse, each because it would be a key that does not
identify a row:

| Written | Why |
| --- | --- |
| `@@id([a, b])` beside `@id` on a field | two answers to *what identifies a row* |
| `@@id` twice | a row has one identity — name every column in one |
| a nullable member | SQLite permits a NULL in a primary key on a rowid table, and there is no `nullsDistinct` reading of one. `@@unique([...], nullsDistinct: true)` is the spelling for *unique when present* |
| a relation field | a primary key is over columns — name the foreign key beside it |
| an array, or a `@computed` / `@transient` / `@from` / `@derived` field | an array is stored as JSON text, so the key would be over a serialization; a virtual field is not a stored column at all |

**Changing one is a table rebuild**, order included — there is no `ALTER` that
reaches a table constraint. See [migrations.md](migrations.md) § *Uniqueness the
table declares itself*.

A model whose key is a tuple cannot yet be served as a REST resource: junction
and sierra each carry a single `idField`, and `/{service}/{id}` has one slot. The
Data realm is complete; the API and UI realms are not.

### Soft delete
```
@@softDelete                     requires deletedAt DateTime? field
@@softDelete(cascade)            cascade remove/restore through FK children
```
See [soft-delete.md](./soft-delete.md).

**It indexes the column itself**, partially, over live rows — so
`@@index([deletedAt])` beside it is refused at parse rather than emitted: both
derive `idx_<table>_deletedAt` and the second `CREATE INDEX` fails inside
SQLite, on a schema nothing objected to (`FJS-480`). A composite leading with
the column (`@@index([deletedAt, status])`) derives a different name and is an
ordinary index. Every index on a soft-delete table gets the same
`WHERE "deletedAt" IS NULL` clause.

### Templates
```
@@hasTemplates                   adds isTemplate Boolean @default(false)
@@hasTemplates(field: "isPreset")  same, under a name you choose
```

The categorical *definition vs instance* pattern. A quote template and a quote
are the same shape, so they are the same table, and the marker column says which
one a row is. **Every read and every write excludes templates by default** —
reporting, list screens and operational queries see only real rows without
saying so — and both take the same two flags to opt out:

```js
await db.quote.findMany()                            // instances
await db.quote.findMany({ withTemplates: true })     // instances + templates
await db.quote.findMany({ onlyTemplates: true })     // templates

await db.quote.update({ where: { id }, data, withTemplates: true })   // edit a template
await db.quote.updateMany({ where: {}, data, onlyTemplates: true })   // edit all templates
await db.quote.delete({ where: { id }, withTemplates: true })         // destroy one
```

**Writes take the flags because a template is a live row, not an end state.**
That is the difference from `@@softDelete`, which the flags otherwise mirror
exactly: a deleted row is out of play and `restore()` is its way back, so
"cannot be edited" is coherent there. A template is a parallel category you
maintain — the thing every instance was cloned from — and the marker is
writable, so an instance can be promoted and a template demoted:

```js
await db.quote.update({ where: { id }, data: { isTemplate: true } })                        // promote
await db.quote.update({ where: { id }, data: { isTemplate: false }, withTemplates: true })  // demote
```

`asSystem()` does **not** lift the filter. It lifts the access rules —
`@@gate`, `@@allow`/`@@deny`, `@guarded` — and this is not one; it shapes which
rows a statement is about. The flags are the only way past it, for every client.

A `@from(Target, …)` reads its target the way the target reads: templates are
out unless the `@from` declares `withTemplates: true`.

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

### A member that is not an identifier

A closed set in the wild is usually written for a person to read, and a space is
all it takes to put it out of reach. So a member may be a quoted string:

```prisma
enum PurchaseStatus {
  Draft
  "On Hold"
  "To Receive and Bill"
  Completed
}

model Order {
  status PurchaseStatus @default("To Receive and Bill")
  @@transitions(status, complete: "To Receive and Bill" -> Completed)
}
```

**The stored value IS the string.** There is no second name and nothing
translates: the CHECK constrains it, the JSON Schema enumerates it, a picker
renders it and the generated type is `'Draft' | 'On Hold' | …`. Postgres's own
enums work this way. Prisma answers the same problem with `@map` on the member,
which buys a separate code-name at the price of a bidirectional layer on every
read and write — and `@label` below already covers display, so the code-name
would be a third thing rather than a missing one.

Three rules, each of which exists because the alternative is quietly wrong:

- **A quoted member that IS a legal identifier is the same member.** `"Draft"`
  beside `Draft` is a duplicate, not two values — so an importer may quote
  everything and still emit a canonical schema.
- **The empty string is not a member.**
- **A move onto a quoted member must be named.** An unnamed move takes the name
  of its target, which reads on a bare member (`-> refunded` is `refund`) and
  says nothing as a sentence: write `complete: … -> "To Receive and Bill"`.

### Labeling a member

A member's own name is what a picker shows, which is fine while the code reads
as the words and useless the moment it does not. `@label` — the same attribute
a field takes — gives one member its human text:

```prisma
enum Plan {
  starter     @label("Starter")
  pro         @label("Professional")
  enterprise  @label("Enterprise")
}
```

It is the only attribute a member may carry, and anything else is refused by
name. Labeling is per member and partial is normal: label the codes whose
spelling is not already the words and leave the rest, since a member with no
label falls back to its own name.

**A label is not a doc comment.** A doc comment above a member is its
*definition* — what the code means, for someone reading the schema — and travels
as documentation. A label is the short string a person sees in a picker. Both
can sit on one member:

```prisma
enum Plan {
  /// Five seats, no SSO, monthly billing only.
  starter  @label("Starter")
}
```

The label reaches the browser as `x-labels` on the enum definition, keyed by
code, holding only the members that stated one — see `jsonschema.md`.

### A set of enum values

A field can hold *several* of the declared values. It is one declaration, and it
feeds the column, the API validation and the picker the same way a single-valued
enum does:

```prisma
enum ReclaimTarget { logs  cache  artifacts }

model ReclaimRule {
  id      Int @id
  targets ReclaimTarget[]
}
```

Stored as a JSON TEXT column, typed `ReclaimTarget[]`, and published as
`{"type":"array","items":{"$ref":"#/$defs/ReclaimTarget"}}` — the `$ref` on the
items, so a picker reading the field's schema offers the whole vocabulary rather
than one choice. Membership is checked on every create and update, naming every
value that is not in the enum.

**There is no membership CHECK, and there cannot be.** Reading the elements of a
JSON array needs `json_each`, which is a table-valued function, and SQLite
forbids a subquery inside a CHECK. So the client is the boundary here — the same
tier `@minItems`, `@uniqueItems` and `Int[]` element typing already sit at. Raw
SQL (`db.asSystem().sql`) can write anything into the column.

Filter it like any other array column — see
[filtering.md](./filtering.md#array-fields):

```js
db.reclaimRule.findMany({ where: { targets: { has: 'logs' } } })          // holds this one
db.reclaimRule.findMany({ where: { targets: ['logs', 'cache'] } })        // holds either
db.reclaimRule.findMany({ where: { targets: { equals: ['logs'] } } })     // is exactly this
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

- **The name is optional on an enum** — `pending -> paid` names itself after the target state. Name it when you want to call it: `db.order.transition(id, 'pay')`.
- **A `Boolean` column is a state machine too**, and it is the one every schema has. `@@transitions(isPrimary, promote: false -> true, demote: true -> false @gate(5))` — the two directions are routinely different authorities (suspend and unsuspend, publish and unpublish), which a single field `@allow('write', …)` answers with one predicate and this answers with two. A boolean move **must be named**: `-> true` says which value is written, not what a person did.
- **`from` takes a list** — `[pending, paid] -> cancelled`.
- **`@gate(N)`** is the minimum level allowed to make that particular move, on Litestone's 0–9 scale (a number or a name: `@gate(ADMINISTRATOR)`). It is a floor *on top of* `@@gate`'s update level, which had to pass to reach the write at all — shipping an order and refunding one are not the same authority.
- **`@gate(8)` on a move means the engine makes it through `asSystem()` and nothing else.** `getLevel` is clamped to 7, so SYSADMIN is refused by name — `TransitionGateError: 'build' … requires level 8, user has 7` — and a system context bypasses the check entirely. `transitions(row)` reports `allowed: false` for one, so a screen offers the right buttons with nothing written. `@gate(9)` refuses everything, `asSystem()` included, which is a move declared for its from-state and never made.
- **`@system` on a move is the other way of saying *the engine decides this*, and it is usually the one you want.** It means what `@system` means on a column: the application makes the move, its caller does not, and the application says so on the call — `transition(id, name, { system: true })`, which becomes `system: [field]` on the update underneath, so writing the column directly is refused and permitted by exactly the same rule. The difference from `@gate(8)` is the whole point: the move runs on the CALLER's own client, so the model gate, the row policies and the audit actor all still apply, where `asSystem()` drops all three to make one move. Refused with `TransitionSystemError` (403), which is a separate class from the gate's 403 because no caller at any level can answer it. `transitions(row)` reports `refusedBy: 'system'`, and `x-transitions` carries the flag, so a browser renders no button rather than a disabled one — the one verdict on that side that is not permissive-when-unknown.
- **The two compose, and they answer different questions.** `@gate(N)` is *how senior must a caller be*; `@system` is *whose decision is this*. `@system @gate(5)` is the person-REQUESTED engine move — somebody presses *sync*, a provider's answer picks the move — which is the shape `@gate(8)` cannot express at all. Declaring `@system` with `@gate(8)` or `@gate(9)` is refused at parse: those admit no caller, which contradicts it. So the filter that separates the two halves of a machine is **every move carrying neither `@gate(8)` nor `@system`** (`FJS-D150`, `IDEAS/permission-sets.md`).

Any move that isn't declared throws `TransitionViolationError`; a declared one the caller can't make throws `TransitionGateError` (which carries `status: 403`). The `WHERE` clause is narrowed to the from-state, so two concurrent writers can't both win — the loser gets a `TransitionConflictError`.

**`transition(id, name)` and an update carrying the column are the same write and not the same question.** The difference is one row state — the one the move was taking it to. Carrying the value a row already holds is legitimate on an update, because a form round-trips the whole row, so it is a silent no-op; asked for by NAME it means the move did not happen here, and the answer is a `TransitionConflictError`. Two opposite races arrive under that one class and `retryable` separates them, because `isStaleWrite()` reads it: `actual === to` means the move you asked for has already been made, so re-applying can never succeed (`retryable: false`), and any other value means the row simply moved and you should re-read and decide (`retryable: true`). The error carries `expected` (the move's from-states), `actual` (where the row is) and `move`.

**A named move is graded on its caller before its row.** A gate, a capability and `@system` are statements about the caller and the declared move — true whatever the row is doing — so `transition(id, 'refund')` from a caller below the level answers `TransitionGateError` rather than telling them the row is in the wrong state, which would be a refusal confirming state to somebody with no authority over the move. It applies to a named move alone: an ordinary update matching no `(from, to)` pair has identified no move, so there is no gate to consult (`FJS-611`).

> **`@gate` needs a level resolver.** A schema with any gated transition auto-installs `GatePlugin({ getLevel: FrontierGateGetLevel })` if you configure none — a declared gate that silently did nothing would be a fail-open default. But the shipped resolver grades a bare session at `VISITOR(1)`: it wants both `verifiedAt` and `activatedAt` on the user object, and returns `CREATOR(3)` when it gets them. It never returns 4+. Pass your own `getLevel` to `GatePlugin` for anything real.

`updateMany` **refuses** a transitions-typed column rather than writing it ungraded — `BulkTransitionError`, 400. A bulk write matches rows without reading them, so there is no from-state to grade, and the skip took the per-move `@gate` and the `@system` marking with it: a level-4 caller could make a `@gate(5)` move, a `@system` move and an undeclared move by asking `updateMany` instead of `update` (`FJS-671`). 400 rather than 403, because the verb is wrong rather than the caller — no level and no grant answers it. `upsertMany`'s `update:` half refuses with it; its insert half is a create, has no from-state, and does not. **Every other column stays bulk-writable in the same call**, which is the power tool kept rather than removed. `asSystem()` writes it and says so on stderr.

#### Asking what's legal

```js
await db.order.transitions(row)   // or transitions(id)
// → [{ name: 'ship',   field: 'status', from: 'paid', to: 'shipped',  gate: null, allowed: true,  refusedBy: null },
//    { name: 'refund', field: 'status', from: 'paid', to: 'refunded', gate: 5,    allowed: false, refusedBy: 'gate' }]
```

The legal next states for *this* record, for *this* caller. A move the caller can't make is returned with `allowed: false` rather than dropped — a disabled button is usually better UI than a missing one.

**Both halves of *may I* are graded, and `refusedBy` says which said no.** A move is an update, so a row policy refuses one exactly as a gate does: `@@allow('update', ownerId == auth().id)` on the model means somebody else's order offers no moves at all, and `refusedBy` is `'policy'` rather than `'gate'`. The two are different sentences on a screen — *you are not senior enough* and *not this record* — and a status code cannot carry the difference.

The `update` policy is graded against the row as it is, so it is one evaluation per call. A `post-update` policy is graded against the row as it *would be* — the current row with that one column moved — so it is one per distinct target state, and it is the half that genuinely varies between moves.

> A policy this cannot evaluate in JS — a `check()` over a relation that isn't to-one — is treated as permissive, like every other affordance. The Data boundary refuses regardless.

The same list reaches the browser: `generateJsonSchema` emits `x-transitions` on the model, and Sierra's `resource.transitions(row, level)` returns the same shape — but it is the **gate half only**. `x-transitions` carries a gate and not a predicate, and a browser has no policy engine, so a move a policy refuses reads `allowed: true` there and 403s when pressed. That's a UI affordance either way — the server enforces regardless, and a screen that needs the graded list asks the server for it.

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

This is shorthand: it desugars into a `@@transitions` on each model using the enum, so everything above applies unchanged. A model that declares its own `@@transitions` for that field overrides the enum's outright rather than merging.

**The two spellings differ in exactly one thing: a gate needs the model form**, because the same enum on two models would otherwise force them to share one authority level. Writing `@gate` inside the enum block is refused at parse and the message names the model form to write instead. Everything else — a from-list, an optional name, the compare-and-swap — is the same feature.

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

## ``@generated(`{a} {b}`)`` — a template, not SQL

`@generated` takes two languages, and **the quote says which**: double quotes
are SQL, backticks are a template — the string the column produces. `{field}`
means this row's column in both, so the delimiter changes only what the text
*around* the braces is.

The commonest `@generated` by a distance is a string joined out of two or three
columns, and the reason that shape earns a second language is not length. It is
the null rule:

```
model Person {
  firstName String
  middle    String?
  lastName  String?

  fullName  String? @format("{firstName} {middle} {lastName}")
}
```

`{field}` is a column and everything outside the braces is literal text. **A
NULL column takes the separator beside it**, so a person with no middle name
reads `Ada Lovelace` and one with only a first name reads `Cher`.

The hand-spelled version is what makes the point:

```
fullName String? @generated("trim(coalesce({firstName},'') || ' ' || coalesce({middle},'') || ' ' || coalesce({lastName},''))")
```

That is longer, and it is also **wrong** — a missing middle name leaves
`Ada  Lovelace` with two spaces, a plausible string with nothing to say it
happened. The template compiles to `concat_ws`, which drops a NULL
argument and its separator together.

### What it compiles to

Two shapes, both visible in `db/ddl.snapshot.sql`:

| template | SQL |
| --- | --- |
| `"{firstName} {lastName}"` | `concat_ws(' ', "firstName", "lastName")` |
| `"{code}-{year}"` | `concat_ws('-', "code", "year")` |
| `"[{code}-{year}]"` | `trim(coalesce('[' \|\| "code", '') \|\| coalesce('-' \|\| "year", '') \|\| ']')` |

Where every gap between fields is the same text and nothing sits outside them,
that is exactly `concat_ws`. A template with mixed or outer literals has no
single separator, so each field carries the text in front of it and the pair
vanishes together — `coalesce('-' || "year", '')` is empty when `year` is NULL,
taking the dash with it.

### It is a generated column, because it is one

The template compiles at parse and nothing below that point knows it happened:
a `GENERATED ALWAYS AS` column, `VIRTUAL` by default and
``@generated(`…`, stored)`` to materialise it, filterable and sortable and
indexable, refused on write, `readOnly` at the client. The unknown-field,
self-reference and cycle checks are the ones `@generated` already ran.

**One attribute rather than two**, so the field reads as what it is. A write
refused on one says which language it was in — *its value comes from its
template* against *from its expression*.

**When backticks are not the answer:** a derivation that is not a joined string.
The double-quoted form takes arbitrary SQL and is still how to write
`@generated("{qty} * {price}")` or a `lower(replace(…))` slug.


## `@derived(expr)` — computed in SQL, so it can be queried

`@computed` is a JS function over a fetched row: SQLite has never heard of it,
so it cannot be filtered or sorted by. `@derived` is the same idea one layer
down — an expression over the row's own columns, emitted into the SELECT:

```
model Task {
  priority    Int
  dueAt       DateTime?
  completedAt DateTime?

  overdue Boolean @derived(dueAt < now() && completedAt == null)
  urgency Int     @derived(priority > 8 ? 3 : priority > 5 ? 2 : 1)
}
```

```js
db.task.findMany({ where: { overdue: true }, orderBy: { urgency: 'desc' } })
db.task.groupBy({ by: ['urgency'], _count: true })
```

It is not a column: no DDL, no migration, and a write naming it is refused by
name. A non-optional derived field is never "required" on create.

**It is not `@generated`.** That creates a real stored column and must stay
deterministic; the point here is a value that changes on its own because the
clock moved.

### What the client is told

A **flag**, not the expression:

```json
"overdue": {
  "type": "boolean",
  "readOnly": true,
  "x-litestone-kind": "derived",
  "x-litestone-volatile": "clock"
}
```

`x-litestone-volatile` is the one thing a consumer cannot work out for itself —
this value goes stale with **no write, no event and nothing to announce it**, so
a cached copy has a shelf life. Shipping the expression instead would mean a
third implementation of the language in the browser, beside the SQL compiler and
the JS evaluator; the server's answer is the only one.

### What it may contain

The `@@allow` expression language, and it must be **static** — one value for the
row, not one per reader:

| | |
| --- | --- |
| `now()` | allowed — emits SQLite's clock, one instant per statement |
| `auth()`, `check()` | refused, naming `@@scope` as the per-caller tier |
| another `@derived` field | refused — not yet |
| a `@computed` field | refused — SQLite cannot see it |

The declared type is checked against the branches at startup, so
`Level @derived(p > 8 ? 'hgih' : 'low')` is a schema error rather than a row
that reads back a string no enum member matches.
