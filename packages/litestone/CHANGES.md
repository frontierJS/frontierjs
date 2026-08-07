# Changes — @frontierjs/litestone

## 2026-08-06 — `@version`: the lost update is now a 409

1437 tests (was 1416). `IDEAS/declared-semantics.md` item 1, shipped.

Nothing in litestone carried a row version, so two people editing one order both
`PATCH`, both succeed, and the second silently erases the first — the oldest
silent-wrong-data bug there is.

```js
const alice = await db.order.findUnique({ where: { id: 1 } })   // version 1
const bob   = await db.order.findUnique({ where: { id: 1 } })   // version 1

await db.order.update({ where: {id:1}, data: { status: 'paid', version: alice.version } })
// → { status: 'paid', version: 2 }
await db.order.update({ where: {id:1}, data: { status: 'void', version: bob.version } })
// → VersionConflictError: expected 1, row is at 2
```

### The mechanism already existed

`@@transitions` has run a compare-and-swap since 2026-08-04:
`applyTransitionWhereClause` narrows the `WHERE` by the value it read, and no
rows changed means somebody got there first. `@version` is that with the column
unfrozen — the same *generalise the mechanism rather than add a second one* move
`cascading-fields.md` argues for `@@softDelete(cascade)`. The bump rides the
`SET`, which also means a versioned update always has a column to write.

### Where it applies, and where insisting would be wrong

| Path | Requires | Bumps |
| --- | --- | --- |
| `create` / `createMany` | — | starts at **1**, whatever the payload says |
| `update` | **yes** | ✓ |
| `updateMany` | no | ✓ |
| `upsert` / `upsertMany` | no | ✓ |

`update` is the concurrent-editor path. A bulk `where` matches many rows and so
many versions — there is no single value to compare — and an upsert is reached by
natural key from a sync or an import, which cannot have read one. **Both still
bump**, which is the half that matters: without it a bulk write would leave every
open editor's version looking current. Pinned by a test.

The `upsertMany` trap was worth catching: taking the version from `excluded`
would reset a live row to 1 and make every stale editor current again. It is
`"version" = "order"."version" + 1` instead.

### Two errors, because they mean different things

`VersionRequiredError` is **400, not retryable** — you left out an input, and the
identical request fails identically. `VersionConflictError` is **409 + retryable**
— re-read and re-apply is a real strategy. Both carry `status`, so Junction maps
them with no registration (verified: → `Conflict` 409 / `BadRequest` 400). Not-found
still returns `null`; a 409 means the row is there and moved.

### The rest of the surface

`asSystem()` skips the check and still bumps — a migration or a job is not a
second editor, the same reason it skips gates. The version travels in `data`
rather than `where`, because a Resource fetch carries every column and a form
round-trips it with no plumbing. It reaches the client as `readOnly` in the
update schema plus **`x-version`** naming the column, is absent from the create
schema, and typegen drops it from `*Create` and makes it **required** in
`*Update` — the type saying what the runtime does. One per model, `Int`, not
optional, not the `@id`; all four are schema errors.

**The client half landed the same day** — `createResource` remembers the version
of every record it reads and puts it on the next patch, so an app writes nothing.
See sierra's `CHANGES.md` (`FJS-105`).

## 2026-08-06 — the bulk write paths run the `ctx.auth` stamps

1416 tests (was 1408). Closes `FJS-092`, which was filed too narrow.

`upsertMany` stamped nothing from `ctx.auth` — not `@default(auth().id)`, not
`@createdBy`, not `@updatedBy`. Probing the whole table rather than the one
filed method turned up a second hole:

| Path | `@updatedAt` | `@updatedBy` | `@createdBy` / `@default(auth().id)` |
| --- | --- | --- | --- |
| `create` / `createMany` | ✓ | — | ✓ |
| `update` | ✓ | ✓ | n/a |
| `updateMany` | ✓ | **✗** | n/a |
| `upsertMany` | ✓ | **✗** | **✗** |

**`updateMany` was the worse of the two, and it wrote a wrong name rather than
no name.** `@updatedAt` is a SQL trigger (`ddl.js`), so the timestamp half of the
pair kept working on every path while the identity half — which needs `ctx.auth`,
which SQLite does not have — silently did not:

```js
await asBob.doc.update(…)       // updatedById: 2   ← Bob
await asAnn.doc.updateMany(…)   // updatedById: 2   ← still Bob, timestamp moved
```

A row reading *edited four seconds ago by Bob* when Ann edited it is worse than
a null: null says unknown, a stale name says something false in an audit shape.

### A conflict is an update

`upsertMany` needed more than a stamp call. `updateCols` defaults to every column
that is not the conflict target, so simply filling `createdById` would have put it
in the `ON CONFLICT … SET` clause and made every bulk upsert rewrite the original
author. Create-time columns are now held out of that clause — **but only the ones
we filled**. A column the caller supplied stays in, because naming it is an
explicit request and excluding it would change behaviour that predates the
stamps; an explicit `update: ['createdById']` moves it too.

### One owner for "ctx.auth → column"

The stamp was inline in four places with two different meanings mixed between
them. Now two functions, named for the distinction:

- `stampFromAuth` — the **principal wins**. `@createdBy`, `@updatedBy`.
- `applyAuthDefaults` — the **payload wins**. `@default(auth().field)`, which is
  a default and documented as one.

Neither fires without `ctx.auth`, which is what keeps `asSystem()` seeders,
imports and backfills able to carry an explicit author in.

8 tests; **4 fail if the stamps are removed.**

## 2026-08-06 — raw SQL goes through `asSystem()` when the schema declares access rules

1408 tests (was 1399).

`db.sql` reads the base table: no `@@gate`, no `@@allow`, no `@guarded`, no
`@scoped`, no `@@softDelete` — they are all enforced above SQLite. For a
deliberate escape hatch that is defensible. What was not is that it was the
**same function on every proxy**. `authSql` closed over `user` and never read
it, so it was byte-identical to the unscoped `sql` — while `authQuery`, directly
beneath it in the same closure, goes to real trouble to keep that same auth
context alive through `$transaction`. One preserved the scope; one silently
dropped it.

Measured on one model with `@@allow` + `@guarded` + `@@softDelete`:

```
$setAuth({id:1}).invoice.findMany()   → 1 row,  ssn absent
$setAuth({id:1}).sql`SELECT * …`      → 3 rows, ssn in plaintext, another
                                         owner's row and a soft-deleted one
```

### The unscoped client was the wider gap

An unauthenticated `db.invoice.findMany()` returns **0** rows — the policy
evaluates with `auth() == null` and matches nothing — while `db.sql` returned
all 3. So this was never "the scoped proxy drops its scope". Raw SQL ignored the
schema on *every* path and the ORM never does, and the anonymous path is where
the two disagree most. `IDEAS/scoped-sql.md` argued `db.sql` should be left
unchanged on the grounds that there is no identity to scope by; that is
overturned.

### The rule

| Surface | Schema declares access rules | It does not |
| --- | --- | --- |
| `db.sql` | **throws** | unchanged |
| `db.$setAuth(u).sql` | **throws** | unchanged |
| `db.asSystem().sql` | works — the documented bypass | works |

"Access rules" is `@@gate`, `@@allow`/`@@deny`, `@guarded`, `@encrypted`/
`@secret`, field `@allow`, `@scoped`. **Not** `@omit` or `@@softDelete` — those
shape what a read returns rather than who may read it, and refusing raw SQL for
a soft-delete column would fire on most schemas for a lifecycle rule.

### Coarse per schema, not per statement — on purpose

Deciding per statement means parsing the statement, and a hand-written SQL
validator that is subtly wrong grants a **false** guarantee, which is worse than
an honest raw hatch because people trust it. The escape routes are numerous and
all real: `main.`/`temp.` qualification, `ATTACH` (which this client exposes on
the proxy), `PRAGMA`, views created mid-statement, comment and string-literal
tricks. SQLite's own authorizer would be the right mechanism and **`bun:sqlite`
does not expose it** — verified, `Database` has no `setAuthorizer`.

### The refusal names both ways forward

`asSystem().sql` to bypass deliberately, or stay on the ORM — and for an
expression the query builder cannot express, `where: { $raw: sql\`…\` }` keeps
every policy. Verified rather than assumed: through `$raw` a scoped caller still
gets 1 row with the `@guarded` column withheld.

Also: three byte-identical copies of the raw runner (`sql`, `sysSql`, `authSql`)
collapsed to one.

9 tests; **5 fail if the refusal is removed**. The first caller it caught was
this package's own `@encrypted: stored as ciphertext in DB`, which peeked at a
raw column with `db.sql` — a genuine bypass, now saying so. Ruled in
`DECISIONS.md` § Access control. **Scoped raw SQL — the per-identity view set in
`IDEAS/scoped-sql.md` — is deliberately not built**; revisit with `herald`.

## 2026-08-06 — the audit log can record a String actor

1399 tests (was 1396).

The synthetic audit model declared `actorId Int`, and the jsonl driver's
companion index is a STRICT table. So the first audited write with a known actor
threw

```
SQLiteError: cannot store TEXT value in INTEGER column auditLogs_idx.actorId
```

and took the request with it. **Every FrontierJS app is exposed**:
`@frontierjs/auth` issues `id String @id @default(uuid())`, so its users are
uuids, and `@@log(audit)` on any model then fails on its first write by a
signed-in caller.

It was invisible until the same afternoon, and for a precise reason: Junction
handed the Data boundary a principal with no `id` at all, so `actorId` was always
null — and NULL fits an INTEGER column. Fixing that (junction's
`toDataPrincipal`) uncovered this. Two defects, one masking the other.

`actorId` is now `Any` — a real SQLite STRICT column type, and the honest one:
the trail records whoever the host app keys its users by, which is an Int in one
app and a uuid in another. The `.jsonl` itself was always untyped JSON.

**An existing index is rebuilt, not abandoned.** `CREATE TABLE IF NOT EXISTS`
does nothing to a table that already exists, so an index built before the type
changed would keep the old column and keep failing against a schema that no
longer explains it. The driver now compares the declared column types against
`pragma_table_info`, drops the table when they disagree, and **refills it from
the `.jsonl`** — which has every line and every byte offset. Dropping without
refilling would have been worse than the error: an audit trail that silently
looks shorter.

Found by `example/`, whose orders and customers are `@@log(audit)` and whose
users are auth's uuids.


## 2026-08-06 — `@encrypted` works on a `Json` field instead of destroying it

1396 tests (was 1387).

`@encrypted` on a `Json` field **silently destroyed the value**. `encryptField`
does `String(plaintext)`; an object stringifies to `'[object Object]'`, and what
went into the column was a faithful AES-256-GCM ciphertext of that literal
string. Nothing threw. The row looked correctly encrypted. The original was
unrecoverable.

```js
await db.vault.create({ data: { blob: { secret: 'hunter2', n: 42 } } })
// before → "[object Object]"
// after  → { secret: 'hunter2', n: 42 }
```

`ISSUES.md` FJS-006, S1. It had been "mitigated" by a `CLAUDE.md` hazard note
telling people to declare `String @encrypted` and serialize by hand — that note
is now removed.

### The fix is two points, because the pipeline is already symmetric

The write path encrypts and *then* serializes (`serializeRow(..., jsonFields)`);
the read path parses and *then* decrypts (`read()` → `applyFieldPolicy`). So a
Json field only needed its own serialization stepped inside the encryption:

- **encrypt:** `JSON.stringify(val)` before `encryptField`, so what is encrypted
  is text rather than `String(object)`.
- **decrypt:** `JSON.parse` after `decryptField`, mirroring it.

Keyed on the **declared** type — `json: field.type?.name === 'Json'`, captured in
`buildFieldPolicyMap` beside the other per-field facts, because neither call site
has the schema in scope. Keying on "the value looks like JSON" would have parsed
a `String @encrypted` field that happens to hold `{"a":1}`.

### What is covered

Objects, nested structures, arrays, and the JSON scalars (`string`, `number`,
`boolean`) — the scalars matter because `String(plaintext)` handled *those*
correctly, so a fix that only special-cased objects would have passed the obvious
tests and quietly double-encoded the rest. `null` stays null. `@secret`,
`$rotateKey` and `@encrypted(searchable: true)` all verified on a Json field; an
unencrypted Json field on the same model is untouched, and `@encrypted` still
implies `@guarded(all)`.

Verified beyond round-tripping: the stored column is ciphertext, and the
plaintext does not appear anywhere in the database file. A round-trip test alone
would also pass if the field were simply not being encrypted.

### Legacy rows read as the broken string, not null

Data written before this is already lost and cannot be recovered. A parse
failure therefore leaves the decrypted value alone rather than nulling it: `null`
reads as "this was empty", `'[object Object]'` reads as "something went wrong
here", and only the second sends anyone looking.

9 tests; **4 fail if the fix is reverted**.

## 2026-08-06 — authorship is one line, and cannot be forged

1387 tests (was 1370).

`@@createdBy` and `@@updatedBy` on a model each expand at parse time into the
pair of fields you were writing by hand:

    model Doc { id Int @id  title String  @@createdBy  @@updatedBy }

    // → createdById Int?  @createdBy
    //   createdBy   User? @relation("Doc_createdBy", fields: [createdById], references: [id])
    //   updatedById Int?  @updatedBy
    //   updatedBy   User? @relation("Doc_updatedBy", fields: [updatedById], references: [id])

Pure desugaring — nothing downstream knows the attribute existed. DDL emits both
foreign keys, `include: { createdBy: true }` resolves, typegen and JSON Schema see
ordinary fields. The FK type is copied from the `@@auth` model's `@id`, so an `Int`
id and a `String @default(uuid())` id both land right. `@@createdBy(owner)` renames
the pair. A field you already declare under either name wins and is left alone.
Without a model marked `@@auth`, both are a schema error — the same ruling
`@scoped` already makes.

**The field-level `@createdBy` is new, and it is a stamp, not a default.** The
obvious expansion was `@default(auth().id)`, and probing it is what killed that:

    const asAnn = db.$setAuth({ id: 1 })
    await asAnn.doc.create({ data: { title: 'x', createdById: 2 } })
    //  → createdById: 2      ← Bob. A default loses to the payload.

Authorship you can forge by adding a key to the request body is not authorship.
`@createdBy` overwrites instead, matching `@updatedBy`, which had these semantics
all along. Both are skipped entirely when `ctx.auth` is null, so `asSystem()`
writes, seeders and backfills still carry an explicit author in — that is the
only way a migration can.

Stamped on `create`, `createMany` and both `upsert` paths; the upsert fast path
stamps the INSERT branch only, so a conflict does not rewrite the original
author. `upsertMany` and `updateMany` were the two paths that stamped nothing —
see the entry below, which closes that as `FJS-092`.
`generateFactory` skips both attributes, and typegen drops them from the
`*Create` interface: a value there loses to the principal anyway.

## 2026-08-05 — every bulk write reaches the audit trail

1370 tests (was 1362).

`updateMany` and `deleteMany` on a model declaring `@@log` wrote **no audit entry
at all** — not an entry without snapshots, no entry. Both called `fireQuery` and
never `emitLogs`, and so did `removeMany`, `restore` and `upsertMany`. Probed
rather than read:

    createMany 3 rows · updateMany 3 · deleteMany 3   →  entries: 2 (the creates)

Two bulk writes destroyed three audited rows and the trail said nothing happened.
An append-only trail that omits the most destructive operation in the API is worse
than no trail, because it is trusted.

All five paths now log. `createMany`'s entry named no rows for the same underlying
reason — an `@id @default(autoincrement())` row has no id until SQLite assigns one,
and the entry was built from the pre-insert data — so the bulk paths take
`RETURNING` on a logged model and name their rows by id. An unlogged model is
untouched: the `RETURNING` path is guarded by `tableHasAnyLog`, so `run()` still
serves the common case.

Details worth knowing:

- **A bulk write records which rows and what operation, never contents.**
  `before`/`after` stay single-row-only, as documented. Naming the rows is what
  makes the trail complete; snapshotting a million-row update is a different
  feature with a different cost.
- **`upsertMany` splits its batch** into a `create` entry and an `update` entry.
  It looks up which conflict keys already exist *before* writing — one prepared
  `SELECT` per row, on logged models only — because after the write every row
  looks like an update.
- **`restore` logs as `update`.** The vocabulary is create|update|delete|read, and
  a restored row changed state; it was not created.

`docs/audit-logging.md` said "`before`/`after` snapshots are only included for
single-row `update()` calls — not `updateMany()`", which reads as *the entry exists
without snapshots*. It did not exist. Corrected there, along with three `db.auditLog`
call sites that should be `db.auditLogs`.

Repo register: `ISSUES.md` FJS-074.

## 2026-08-05 — a transaction can read its own writes

1362 tests (was 1355).

`$transaction` opened a write transaction on the write connection and then handed
the callback the ordinary client, whose reads go to the separate readonly WAL
connection. WAL isolation means that reader cannot see uncommitted work, so:

    await db.$transaction(async (tx) => {
      await tx.t.create({ data: { name: 'a' } })   // succeeds, returns the row
      await tx.t.findMany()                        // → []
      await tx.t.count()                           // → 0
    })

Every read-after-write inside a transaction saw stale data — check-then-act,
read-modify-write, and any `include` resolved against a parent created moments
earlier. Nothing threw; the reads simply described the world as it was before the
transaction started.

Each read connection is now wrapped in a router sharing the transaction manager's
depth. While a transaction is open, reads go to the **write** connection, which
observes its own uncommitted work; outside one, nothing changes and reads still run
concurrently on the readonly connection. The two prepared-statement fast paths
(`findMany()` with no args, `findUnique` by pk) stand down inside a transaction —
they were prepared against the read connection at table-build time and cannot be
re-pointed.

Read-only clients are untouched: their write connection is a throwing stub, and
they can never open a transaction to route into.

Found while trying to build per-test isolation on `$transaction` for the seeding
work below. Pinned by seven tests: findMany, findUnique, read-modify-write,
`include`, rollback, routing restored after commit *and* after rollback, and
nested savepoints.

## 2026-08-05 — seeding ergonomics

1355 tests (was 1334).

Six additions and one retry, all on top of the relation work below.

- **`snapshot(db)` / `restore(db, snap)`** — seed once, reset between tests. A
  truncate + bulk re-insert of the exact rows, which beats re-seeding. Deliberately
  raw: rows move through the write connection, so `@encrypted`/`@secret` columns
  keep the ciphertext they already have (a round trip through the ORM would
  re-encrypt them) and no gate, policy, hook or audit entry fires. FTS5 shadow
  tables are skipped — writing those directly corrupts the index.
- **`defineFactory({ model, definition, traits, afterCreate })`** — the Factory
  without the class. Returns a class, so it registers exactly as before. A subclass
  declares `traits` as an instance field, which initialises only after `super()`
  returns; that is the only reason `Factory`'s constructor returns a Proxy, and
  this path never needs it.
- **A value catalogue** (`src/fake.js`). Well-known field names — `firstName`,
  `city`, `company`, `title`, `description`, … matched case- and
  separator-insensitively — draw real words instead of `Name a4f2`. **Only when a
  seed was set.** Unseeded output is byte-identical to before, because
  schema-derived test *cases* have to stay stable and diff-able.
- **`static dependsOn = [OtherSeeder]`** — a seeder names what it needs instead of
  every caller knowing the order. Each class runs at most once per `call()`; a
  cycle throws naming the classes in it.
- **`loadFixture(db, model, jsonOrCsvOrArray, { upsert })`** — authored reference
  data (countries, plans, currencies) is written down, not generated. Rows go
  through the ORM, unlike `restore`. Ships a small RFC-4180 `parseCsv`.
- **`fli make:factory <Model>`** — scaffolds a `defineFactory` stub into
  `db/factories/`, refusing a model the schema does not declare.
- **UNIQUE collisions retry.** Generated values carry a seq token so a `@unique`
  column is unique by construction, but the token pool is finite and the catalogue
  is small. `createOne` now rebuilds and retries (5 attempts) — a rebuild advances
  `seq`, which changes every generated value — rather than failing a long seed.

`withParents()` also stops **silently skipping** a required relation whose target is
already in the parent chain. A cycle cannot be satisfied by creating more rows, so
it now says that, names the chain, and suggests `.for(…)` — previously it surfaced
as an opaque `FOREIGN KEY constraint failed` far from the cause.

### Why snapshot/restore rather than a transaction

The intended implementation was a per-test transaction rolled back at the end.
`$transaction` could not serve it: reads inside one did not observe its own writes.
That turned out to be a general correctness bug rather than a test-helper problem,
and is fixed in its own entry above. `snapshot`/`restore` remains the isolation
primitive here — it survives a client restart and does not hold a write lock for the
length of a test.

## 2026-08-04 — factories can seed a relation graph

1334 tests (was 1321).

Factories could only reach one relation shape: `withRelation`/`for`, a single named
belongsTo, wired by hand. Everything else was on the caller. Measured by pointing
`autoFactories` at the two real schemas in this repo and creating one row per model:

    example  (Int keys)   3 of 3  models seeded
    basecamp (uuid keys)  5 of 24 models seeded

The 19 failures were all `FOREIGN KEY constraint failed`. An `Int` FK falls back to
`1`, which accidentally works when the parent happens to be row 1; a `String`/uuid FK
has no fallback at all, so the generator emitted `"AccountId 1"` and every write with
a parent failed. Four additions:

- **`withParents()`** — reads the schema and auto-creates a parent for every
  *required* belongsTo, recursively. `{ optional: true }` covers nullable ones,
  `{ fresh: true }` gives each row its own. Relation cycles are skipped rather than
  followed; `depth` is only a backstop.
- **`has(name, count, opts)`** — hasMany children, created after the parent with the
  FK pointed back at it. The FK comes from the child's own `@relation`; a child with
  two relations to the same parent is an error naming both, not a guess.
- **`attach(name, countOrRows)`** — implicit many-to-many, via the `{ connect: […] }`
  form the client already takes. Accepts a count or existing rows.
- **`usingDb()` / `asSystem()` / `actingAs()`** — a schema declaring any `@@gate`
  auto-installs GatePlugin, so an anonymous factory grades STRANGER and cannot create
  anything. The client now propagates through the whole wired graph; rebinding only
  the top factory left every parent on the gated client.

`has`/`attach`/`withParents` need the parsed schema and a factory registry, which
`makeTestClient({ autoFactories: true })` and `factoryFrom()` now supply — to
hand-written factory classes as well as generated ones. Without them the methods
throw a message naming what to pass.

Same measurement after:

    example   3 of 3  models seeded via factories.X.asSystem().withParents()
    basecamp  24 of 24

## 2026-08-04 — the factory generator stops emitting data the schema rejects

1321 tests (was 1306).

`generateFactory` derives a row from a model's field types. It was not reading most
of the rules on those fields, so `autoFactories` produced rows that could not be
written. Probed with one hostile model — every line below is a separate failure:

    { code:"xxxx", phone:"Phone c9zs", age:11001, meta:null, tags:[], plan:"free" }

    createOne     → phone: must be a valid phone number, age: must be at most 99,
                    meta is required, ref: must match ^[A-Z]{3}-[0-9]{4}$
    createMany(2) → UNIQUE constraint failed: code.v

- **`@unique` + `@length` generated a constant.** The whole branch was
  `'x'.repeat(min)` — no seq — so the second insert always collided. Every string
  now carries the seq token and is padded/truncated into the declared range.
- **`Int` ignored `@gte`/`@lte`**, and both types ignored exclusive `@gt`/`@lt`.
  One bounds resolver now serves `Int` and `Float`, and the value walks the range
  with `seq` so a bounded `@unique` column also survives `createMany`.
- **Required `Json`/`Bytes` generated `null`** → "is required" on every write. Now
  `{}` / bytes when required, `null` only when optional.
- **`@phone` was unhandled** → plain text, always invalid.
- **`@regex` emitted `field-abcd`**, which matches almost no pattern. There is now a
  generator for the common subset (anchors, escapes, classes, groups, alternation,
  quantifiers) that **checks its own output against the pattern** and warns instead
  of emitting an invalid value.
- **`@minItems` was ignored** — arrays were always `[]`.
- **`@startsWith` / `@endsWith` were ignored.**
- **`DateTime` used `new Date()`**, so a seeded factory was not reproducible — the
  one promise the seeded-RNG design makes. Derived from `seq` now.
- **Enums always returned the first value** — five seeded builds gave five `free`.
  `rng.pick` when seeded; still the first value unseeded, so generated test cases
  stay stable.
- **`@sequence` columns are no longer emitted.** An explicit value is honoured and
  moves the per-scope counter (verified), so writing one both defeats the feature
  and collides with any `@@unique([scope, seqField])` beside it.

### makeTestClient could open the project's real database

Found while running the above against `packages/basecamp/db/schema.lite`: rows
appeared in tables that should have been empty. `makeTestClient` builds a throwaway
db in a tmpdir and passes it as `db:` — but **a `database` block in the schema wins
over `db:`**, which is documented litestone behaviour. So pointing this helper at a
real app schema opened `./db/basecamp.db` — the actual project database — and wrote
test rows into it. The docs said "always uses `:memory:` — no files created".

It now overrides every declared database path into the tmpdir, one file per declared
database, with per-database DDL. Pinned by two tests, including one asserting the
declared path is never created on disk.

## 2026-08-04 — `Factory.create(overrides)` no longer returns nothing

1306 tests (was 1302).

`build(n, o)` and `create(n, o)` branched on `n != null`, so the first argument was
a count whenever it was present at all. Laravel's `factory()->create($attrs)` is the
muscle memory everyone brings, and `factory.create({ role: 'admin' })` took the
overrides object as the count:

    Array.from({ length: {} })   // → []

No row written, nothing thrown, an empty array returned where a row was expected.
Both now branch on `typeof n === 'number'` — a number is a count, anything else
(object or function) is overrides. All four forms are pinned by tests:

    create()                    → 1 row
    create({ role: 'admin' })   → 1 row with overrides
    create(5)                   → 5 rows
    create(5, { role: 'x' })    → 5 rows with overrides

**Types corrected alongside.** `index.d.ts` described a `Factory` that does not
exist — `for(relatedId)` and `withRelation(model, id)` have taken
`(name, row|factory, fk?, pk?)` for as long as they have existed, `afterCreate` is a
subclass field and not a fluent method, and `seed`, `traits`, `build` and `create`
were undeclared. `testing.d.ts` typed `factories` and `factoryFrom` as `unknown`,
claimed `generateFactory` "returns code as string" (it returns the
`definition(seq, rng)` function), and gave `generateGateMatrix` /
`generateValidationCases` return shapes neither one has ever produced —
`{op, level, label, expect}` and `{valid, invalid, boundary}`, not what was written.

`docs/testing.md` told you to write `model = 'users'` and
`factoryFrom(schema, 'users', db)`. Lowercase plural throws
`model "users" not found in schema` — model names are PascalCase singular
(Invariant 2). README had it right; the doc had drifted.

## 2026-08-04 — transition errors carry an HTTP status

1302 tests (was 1298).

`TransitionGateError` always set `this.status = 403`, with a comment saying that
is the contract: Junction reads `err.status` directly, so an error class you own
needs no mapper and no registration. The other three were missed, so a caller
asking for an illegal move got `500 GeneralError` — the wrong class of error
entirely, telling a client to retry something that will never work.

    TransitionViolationError  → 409   conflicts with the row's current state
    TransitionConflictError   → 409   optimistic-lock loss; also retryable: true
    TransitionNotFoundError   → 400   named a move the model does not declare

Found by driving `@@transitions` from a UI for the first time in `example/`.

## 2026-08-04 — @label and @required, and messages that leave the Data boundary

1298 tests (was 1289).

Every validator already took its own wording — `@length(3, 20, "…")`,
`@email("…")`, `@gte(0, "…")`, the ZenStack convention — and this package's own
validator honoured them. `generateJsonSchema` emitted **none** of them, so a
sentence authored once in `db/schema.lite` died here: invisible to Junction's
autoValidate and to Sierra's client-side rules, both of which derive from that
document. A form said `customerId is required` and no amount of schema
authoring could change it.

**Messages are now emitted as `x-messages`**, keyed BOTH by rule name and by
the JSON Schema keyword the rule compiles to — `@length` publishes under
`length`, `minLength` and `maxLength`. Keying by keyword is the point: a
consumer that just failed `minLength` looks up `minLength`. The alternative,
publishing only the rule name, puts a keyword→rule table in Junction *and*
Sierra, and this file is the one that already owns that mapping (it is
documented at the top of it). `MESSAGE_KEYWORDS` is pinned by a test asserting
the aliases match what the field actually emits — `@gt` is `exclusiveMinimum`,
not `minimum`.

**`@label("Customer")` → JSON Schema `title`.** Every generated message on
every side builds its sentence from it, so an error stops reading `customerId`
under a form label that says "customer". Consumers must read it off the
FIELD's own schema and never a `$ref` target: every enum `$def` is titled with
the type name, so a deref'd title would make `status OrderStatus` introduce
itself as "OrderStatus".

**`@required("…")`** fills the one gap the trailing-message convention could
not: required-ness is the absence of `?`, not an attribute, so there was
nowhere to hang a message. ZenStack reaches for model-level
`@@validate(expr, msg)` here; this follows Remult's field-level
`Validators.required(msg)` so the wording sits beside the rule like every other
message in the file. It carries the wording only — it does **not** make the
field required, and on an optional field it is a parse error rather than a
message that could never fire.

Nine tests in `test/messages.test.ts`.

Newest first. Entries older than 2026-08-02 live in `PROJECT_STATE.md` §What's
been done (phases 1–10) — this file starts where that log left off.

## 2026-08-03 — `@@transitions`: state machines move to the model, and gain gates

A `status` column's rules used to live in whatever service handler was written
first. They are now declared once on the model, enforced at the Data boundary,
and readable by the browser.

```prisma
enum OrderStatus { pending  paid  shipped  refunded  cancelled }

model Order {
  status OrderStatus @default(pending)

  @@transitions(status,
    pay:    pending         -> paid,
    ship:   paid            -> shipped,
    refund: paid            -> refunded @gate(5),
    cancel: [pending, paid] -> cancelled)
}
```

**What's new**

- **`@@transitions(field, …)`** on the model, beside `@@gate` and `@@allow`
  where every other access declaration already lives. The transition name is
  optional (`pending -> paid` names itself after the target); `from` takes a
  list; a trailing `@gate(N)` takes a number or a level name.
- **`@gate(N)` per transition** — a floor on top of `@@gate`'s update level,
  which had to pass to reach the write at all. Shipping an order and refunding
  one are not the same authority. Under-level moves throw the new
  **`TransitionGateError`**, which carries its own `status: 403` so Junction
  maps it with no registration.
- **`db.order.transitions(row)`** — the legal next states for *this* record at
  *this* user's level. A gated move the caller can't make comes back with
  `allowed: false` rather than being dropped; a disabled button is usually
  better UI than a missing one. Takes a row (no round trip) or an id.
- **`x-transitions` on the model in `generateJsonSchema`**, so the machine
  reaches the browser. Sierra's `resource.transitions(row, level)` returns the
  identical shape — a UI affordance only, the server enforces regardless.
- A gated transition **auto-installs a level resolver** when the app configures
  no `GatePlugin`, the same way `@@gate` does. A declared gate that silently did
  nothing would be a fail-open default.

**Why the model and not the enum**

The existing `enum X { transitions { … } }` block attached rules to the *enum*,
so every model with a field of that type shared one machine — and therefore
would have had to share one authority level. Two models using one `Status` can
now differ. The enum block is kept as shorthand for the common case and
**desugars into `@@transitions`** at parse time, so there is one enforcement
path, one representation in the JSON Schema, and the existing behaviour is
unchanged (all 20 of its tests pass untouched). A model that declares its own
`@@transitions` for that field overrides the enum's outright.

**Breaking**

- `x-litestone-transitions` is **no longer emitted on the enum `$def`**. The
  resolved machine is on the model as `x-transitions`. Emitting both would give
  a client two sources that drift the moment one model narrows.

**Documentation corrections** — three places described syntax that never
existed: `docs/schema.md` documented a `@from(pending)` enum-value attribute,
and `docs/roadmap.md` and `docs/soft-delete.md` both showed an array form
`@@transitions([{ name, from, to }])`. `docs/soft-delete.md` additionally
claimed `remove()` enforces transitions — **it does not**, and never did;
enforcement runs on `update()` and `upsert()` only. Use a `@@deny('delete', …)`
policy to require a state before deletion.

1286 tests green (was 1253).

## 2026-08-03 — `@encrypted` on a `Json` field silently destroys the value

**Open. Not fixed — route around it.**

A `Json @encrypted` column round-trips as the string `"[object Object]"`. The
value is stringified with `String(obj)` instead of `JSON.stringify` before it
reaches the cipher, so the object is gone before encryption ever happens.

Everything *around* it works, which is what makes it dangerous: the column is
genuinely encrypted at rest, `@guarded(all)` read-withholding is enforced, the
write returns normally, nothing throws and nothing warns. Only the payload is
missing, and only on read-back.

```prisma
model Secret {
  data  Json @encrypted     // ← writes {"key":"…"}, reads back "[object Object]"
}
```

**Workaround:** declare the column `String @encrypted` and do the
`JSON.parse` / `JSON.stringify` at the service layer. That is what
`packages/basecamp/db/schema.lite` does — see `packages/basecamp/db/README.md`
§"A Litestone bug to route around".

Also recorded in `docs/gotchas.md`.

---

## 2026-08-03 — the audit logger was never dropping rows; reads lag writes

Reported repeatedly as "**`@@log(audit)` writes 0 rows**", including in the root
`CLAUDE.md`, where it sat unexplained for weeks. It is not a bug and nothing is
lost.

The logger driver buffers and flushes on a **~1s timer and on process exit**, so
a read in the same session immediately after a write sees nothing — and the
`.jsonl` file may not exist yet. Litestone's own examples read straight after
writing, which is exactly the shape that reports zero.

Measured on a fresh database:

| after | `auditLogs.findMany()` | file |
| --- | --- | --- |
| 1 write, immediately | 0 rows | does not exist |
| +2s | 1 row | 297 B |
| +50 more writes, same process | 1 row | 297 B |
| next process | **51 rows** | 15,137 B |

Entries carry `operation` / `model` / `records` / `before` / `after` /
`actorId` / `createdAt`, and are queryable through the **`auditLogs`** accessor
that declaring a logger database synthesizes.

Two related facts worth keeping together with this one:

- **`@secret` expands to `@encrypted + @guarded(all) + @log(<first logger db>)`.**
  Merely *declaring* a logger database therefore starts logging every `@secret`
  field in the schema. That is by design.
- **The logger `path` resolves against the process CWD, not the schema file.**
  Where the trail lands depends on where you launch from.

### Protected fields are redacted (same date, and this is what makes the above safe)

`src/core/client.js`. Any `@encrypted` / `@guarded` / `@secret` value is written
as `'[redacted]'` in **both** the field-level entry and the model-level
`before`/`after` snapshot. The trail records *that* a field was written, by
whom, to which rows, when — never what it holds.

- `null` is preserved rather than redacted: nothing to leak, and it keeps a
  `null → value` transition visible (`before: null, after: '[redacted]'`).
- Unprotected fields on the same model are still logged in full.
- The row returned to the caller is untouched — redaction happens on a copy, on
  the way to the log.

**Before this fix the plaintext landed in the JSONL while the database row was
correctly ciphertext**, so any audit file written before 2026-08-03 may hold
secrets in the clear. Consumers that log identity or credential models —
`packages/basecamp` does, on all 16 of its non-event models — require a
Litestone from this date or later.

Pinned by 8 tests (`test/litestone.test.ts` → "audit log redaction"), 5 of which
fail if the redaction is removed. Reference docs: `docs/audit-logging.md`
§"Protected fields are redacted".

---

## 2026-08-02 — v1.1.0 published; the dialect trap is closed

**The trap:** in-repo packages resolved a *registry* Litestone rather than the
workspace one, so schemas written against the current dialect
(`Int` / `String` / `Float` / `Bytes`) were parsed by a build that still spoke
`Integer` / `Text` / `Real` / `Blob`. The failure surfaced far from its cause —
Junction carried **7 test failures filed for months as "test drift"** that were
this mismatch and nothing else. Fixing the resolution cleared all 7.

Two halves, both closed:

- **In-repo:** junction and auth now take `workspace:*` as a dev-dependency with
  a `^1.1.0` peer, so workspace code gets the workspace parser.
- **Registry:** 1.1.0 is published and npm `latest` points at it. Verified by
  `npm view` dist-tags *and* by unpacking the tarball — `SCALARS` carries
  `Int/String/Float/Bytes` and `RENAMED_TYPES` rejects `Integer/Text/Real/Blob`.

**Type renames are a hard cut, not aliases.** `Text`, `Integer`, `Real` and
`Blob` are rejected outright with a rename message (`PROJECT_STATE.md` §"Type
rename — hard cut").

**Still true, and the reason this went unnoticed for so long:** don't pin
Litestone with a bare `"latest"` or `"*"`. A floating range is what let a
consumer silently sit on the old dialect. Use `^1.1.0`. Anything installed from
the registry before 2026-08-02 needs a reinstall.
