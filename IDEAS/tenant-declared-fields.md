---
id: tenant-declared-fields
status: proposed
dated: 2026-09-01
---

# Idea — A column the TENANT declares, at runtime, that is still segmentable

**Status: PARTIAL — the fast design is buildable TODAY and was built, in
`scratchpad/demo`, against a real Litestone client. What is missing is
ergonomics, not capability.** Dated 2026-09-01, revised the same day after
running it: the first draft of this file said the migrator forbade the design.
It does not. `@generated("sql expr")` already emits
`GENERATED ALWAYS AS (…) VIRTUAL`, so a POOL of promoted columns can be declared
in the seed and a tenant's field bound to one at runtime — no DDL, no migrator
change, every rule intact. Written from an audit of
[bento-node-sdk](https://github.com/bentonow/bento-node-sdk) — *is FJS equipped
to build a marketing-automation platform* — where this was the one blocker that
was neither a missing feature nor an engineering trade, but a direct collision
with the thing the framework is for. Every number below was measured on this
tree, not reasoned about.

**In progress as of 2026-09-08, in a separate session.** The ergonomics half is
being taken there. A second consumer arrived the same day:
`conversion-maid-tech.md` reads an application where tenant-declared fields are
in production use — a free-JSON `custom` column on **six** models (`Account`,
`User`, `Client`, `Task`, `Asset`, `Group` — counted off `db/prisma/schema.prisma`),
with the field list, its default and its visibility stored per account. There is
no segment predicate: a `client_segment` is a hand-picked membership list
(`api/src/models/group.model.js`), so nothing there filters on a declared key at
all. It is the same shape this file designs, built the way this
file argues against, so it is worth reading as the negative control.

## The shape

A customer of your SaaS adds a field at three o'clock on a Tuesday and builds an
audience out of it on Wednesday:

```
Field  { key: 'company_size', type: Int, indexed: true }   ← a ROW the tenant wrote
Segment: company_size > 50 AND plan = 'pro' AND source = 'ads'
```

Bento ships exactly this — `Subscriber.fields` is an untyped blob and a `Field`
model registers which keys are legal (`whitelisted`) — and it is not a corner of
the product, it is the product. Every CRM, help desk, ATS and marketing tool has
the same pair. So does Salesforce, Frappe, Airtable, HubSpot and Notion.

**Storing it is free and says nothing.** A `Json` column holds the blob today.
What a tenant-declared field must ALSO have is the seven things an ordinary
column gets: an index, a type, a place in a `where`, a `@@check`, a gate, a
generated form control and a `$checkWhere` answer. *Segmentable* is the short
word for that list, and it is the whole of the difference between a feature and
a blob.

## Where the language stops today

Litestone's query builder emits **no `json_extract` anywhere** — grepped across
`src/`, zero hits outside tests. A `Json` column is filtered as a whole value:
`{ addr: { city: 'x' } }` on a `Json @type(Addr)` compares the object
(`packages/litestone/docs/querying.md` § operators). There is no path syntax, so
there is no `where` a segment could compile to, so `$checkWhere` refuses the key,
so Junction's `autoFilter` answers 400 — correctly, at every step. Nothing here
is broken. The language simply has no way to say the thing.

## What was measured

1,000,000 subscribers, three conditions, one file, WAL, this laptop. Two
selectivities, because indexes and scans swap places across that axis and a
single row would have argued for the wrong design:

| design | broad (6% match) | selective (0.1%) |
| --- | --- | --- |
| `json_extract` over the blob (what an app writes today) | 612 ms | 485 ms |
| **Salesforce's shape** — typed index sidecar, `INTERSECT` | 1,911 ms | 170 ms |
| **Frappe's shape** — real column, real index | **36 ms** | **1.8 ms** |

The third row is a generated column (`json_extract` promoted to
`GENERATED ALWAYS AS … VIRTUAL`) with an ordinary composite index over it, which
is a real column in every way that matters here and costs no extra storage.
17× on the broad case, 270× on the selective one.

At 200,000 subscribers a fourth design was measured and dropped: **EAV as
storage** — one row per subscriber per field — which came in at 292 ms
unindexed and **837 ms indexed**, the index making it worse by pushing the
planner onto a nested loop over the 66,000 rows matching the least selective
term. Worth recording so nobody re-derives it: on this substrate, EAV is not a
slower index, it is an anti-index.

## The prior art disagrees, and the disagreement is the finding

Two platforms solved this at scale and chose opposite mechanisms.

**Salesforce does not run DDL.** Custom field data lives in flex columns, and any
field marked indexed is *synchronously copied* into a pivot table, `MT_Indexes`,
into a column typed for it (`StringValue`, `NumValue`), where a native index can
be built — with `MT_Unique_Indexes` beside it for uniqueness
([Force.com multitenant architecture](https://www.oreilly.com/library/view/the-force-com-multitenant/30000LTI00089/30000LTI00089_ch08lev1sec5.html)).
It is a beautiful design and **it does not port**. It rests on the database being
able to combine several single-column indexes cheaply, which Oracle does and
SQLite does not: three indexed lookups `INTERSECT`ed materialize three sorted id
sets, and the measurement above is what that costs — *slower than the full scan
it was meant to replace* on the broad case. The shape is not wrong; the substrate
underneath it is a different one.

**Frappe runs DDL.** A `Custom Field` is a doctype row, and saving it
synchronizes the schema — `frappe.db.sql_ddl()` issuing `ALTER TABLE`, per site,
across a multi-tenant install
([schema sync](https://deepwiki.com/frappe/frappe/2.3-doctype-system-and-metadata-management)).
This is the one that matches the numbers. And the detail that matters most is not
that it adds columns but what it refuses to do: **Frappe's sync does not drop a
column unless dropping is explicitly allowed**, so a column the running schema
does not know about survives the next migration.

That sentence is the entire gap, because litestone's says the opposite.

## The one line — why DDL-at-runtime stays off the table

The pool exists to avoid this, and it is worth recording what it is avoiding.
`packages/litestone/src/core/migrate.js:644` —

```js
if (!pm.has(col.name)) dropped.push(col)
```

Any live column the pristine schema does not declare is a column to drop. Which
is correct, and is the property that makes `autoMigrate` trustworthy: the schema
file is the truth, and drift is repaired rather than accumulated. It is also why
the design that measures 270× faster cannot be built on top of the framework
today. A generated column hand-added to one tenant's file is deleted by that
tenant's next boot, silently, and the segment that used it goes from 1.8 ms to a
full scan with nothing reporting a change.

**Per-tenant schema divergence is not an unsupported state here. It is a state
the migrator exists to eliminate.** So the design does not ask for it. A slot is
a column the schema declared and a row bound — divergence in the BINDING, which
is data, and never in the schema, which is the file.

## What was built, and it works

The insight the first draft missed: **the tenant does not need a new column, it
needs a free one.** The seed declares a pool of typed generated columns over a
slot-keyed mirror of the blob, and a `FieldDef` row binds `company_size` to `n2`.
The schema is fixed, the binding is a row, and `migrate.js` has nothing to drop.

```lite
model Subscriber {
  id     Int    @id @default(autoincrement())
  email  String @unique
  fields Json   @default("{}")               // human-keyed — what a person reads
  slots  Json   @default("{}") @guarded // slot-keyed mirror — what is indexed

  t1 String? @generated("json_extract({slots}, '$.t1')")
  …                                          // the pool, sized from this model's write rate
  n4 Float?  @generated("json_extract({slots}, '$.n4')")

  @@index([t1, t2, t3, n1, n2, t4, t5, t6, n3, n4])
  @@gate("4.5.5.5")
}

model FieldDef {
  key   String  @unique
  label String
  type  FieldType
  slot  String? @unique @system      // the APPLICATION allocates; a caller may not
}
```

Litestone emits exactly what is wanted, verified off `ddl.snapshot.sql`:

```sql
"t1" TEXT GENERATED ALWAYS AS (json_extract("slots", '$.t1')) VIRTUAL,
"n1" REAL GENERATED ALWAYS AS (json_extract("slots", '$.n1')) VIRTUAL,
CREATE INDEX "idx_subscriber_t1_t2_t3_n1_n2_…" ON "subscriber" ("t1","t2",…);
```

A `where` compiled from a segment's terms is then an ordinary `where` over
declared columns, so nothing else in the stack had to learn anything: measured
against a real client at 200,000 rows, an anonymous read is refused
`AccessDeniedError … requires level 4`, a hand-set `t1` is refused as
`@generated`, `$checkWhere` grades `n1` clean, and the unpromoted key is refused
by name with the legal set listed.

### The index shape is the whole of it, and the obvious one is wrong

Declaring one index per slot **does not work**, and it fails the same way
Salesforce's sidecar does. Measured at 200,000 rows on a three-term segment:

| index shape | ids | plan |
| --- | --- | --- |
| ten single-column indexes | 139 ms | `SEARCH … USING INDEX idx_subscriber_n1 (n1>?)` — one index, then filter |
| **one composite over the pool** | **2.7 ms** | `SEARCH … USING INDEX idx_pool (t1=? AND t2=? AND n1>?)` |

51×, and the reason is the same sentence in both cases: SQLite will not combine
several single-column indexes. So the pool takes **one composite index** and
slots are allocated in order, which makes allocation order load-bearing — the
field a shop segments on first should land leftmost, because a leading prefix is
what serves a one-term or two-term segment.

The second measured surprise is that the query is not the cost once the index is
right. The same segment returning **ids** is 2.7 ms and returning **whole rows**
is 48 ms; the 45 ms is hydrating 13,200 rows and parsing each one's `fields`
blob. A segment wants a `select`, and the naive version spends 94% of its time
building objects nobody reads.

### What a slot costs, and therefore what the cap is for

The first draft of this file capped the pool at ten and implied the cost was
storage. Measured at 200,000 rows, that is wrong twice and right once:

| declared · indexed | write 200k | file | 2-term segment |
| --- | --- | --- | --- |
| 10 · 6 | 2,531 ms | 74 MB | 0.4 ms |
| 50 · 6 | 5,076 ms | 74 MB | 0.9 ms |
| 100 · 6 | 7,434 ms | 74 MB | 0.6 ms |
| 200 · 6 | 12,402 ms | 74 MB | 0.3 ms |
| 50 · 20 | 4,960 ms | 81 MB | 0.4 ms |

**Storage is flat** — a VIRTUAL generated column stores nothing, so the table
does not accrete the way a Rails STI table does, and the 68→74 MB spread is the
index rather than the columns. **Read speed is flat** — an unused slot slows no
query down at any pool size. And **the index width is nearly free on writes**:
50·6 and 50·20 are the same number.

What costs is the **declared** count, because SQLite parses the whole table
definition per statement — roughly 0.25 µs per row per column, which is 12.6 µs
an insert at ten slots and 62 µs at two hundred, a 4.9× spread on write
throughput alone.

So the cap is not a round number and not a storage budget. It is **one model's
write rate**, and it belongs in the seed with its reason beside it:

> An unused slot is not free. It is a tax on every write to that table, forever,
> paid by every tenant including the ones who declared nothing.

On a `Customer` table, where writes are rare and reads dominate, forty slots is
nearly free and ten is needlessly stingy. On an event log ingesting continuously,
ten is already generous. A single global number would be wrong for both.

The eleventh field — or the forty-first — is unpromoted rather than refused: it
stores, it displays, and a segment naming it falls back to the scan. The service
reports that as `unindexed` rather than dropping the term, because a compiler
that silently ignored a condition would answer the wrong audience with a 200.
Raising the cap is a schema edit and therefore a deploy, which is the property
that makes it safe and the one that makes it annoying.

## Design B — the tenant's own file, ATTACHed

The pool's cap is its one real cost, and there is a design with no cap: **give
the tenant a second SQLite file holding their custom attributes as REAL columns,
attach it, and reach it from a `$raw` inside an ordinary ORM `where`.** Built and
measured the same day; it works, and it is better than the pool everywhere except
one place.

```js
await sys.sql`ATTACH DATABASE 'db/custom.db' AS cust`
await sys.sql([`ALTER TABLE cust.attr ADD COLUMN "company_size" REAL`])   // a tenant declares a field
await sys.sql`CREATE INDEX cust.ix1 ON attr(plan, signup_source, mrr)`

db.subscriber.findMany({ where: { $raw: sql`
  id IN (SELECT subscriberId FROM cust.attr WHERE plan = ${'pro'} AND mrr > ${1000})` } })
```

`$raw` is ANDed into the structured where rather than replacing it, so **every
rule survives** — measured, an anonymous caller is refused
`AccessDeniedError … requires level 4` on exactly this query. The DDL is the
tenant's own and litestone's migrator never looks at that file, so there is no
pool, no cap, no slot allocator and no `@@extensible` needed.

At 200,000 rows, and the planner does the right thing on its own:

```
SEARCH cust.attr USING COVERING INDEX ix1 (plan=? AND signup_source=? AND mrr>?)
SEARCH subscriber USING INTEGER PRIMARY KEY (rowid=?)  ·  CREATE BLOOM FILTER
```

| | |
| --- | --- |
| the subquery alone | 5.0 ms |
| through the ORM, ids only | 32.5 ms |
| through the ORM, whole rows | 84.4 ms |

### The two things that decide whether it is buildable

**A read never sees the ATTACH, and this is the whole blocker.** Litestone opens
**two** connections per database — `rawWriteDb` and a `readonly: true`
`rawReadDb`, so WAL can serve reads concurrently — and `makeReadRouter` sends a
read to the reader unless a transaction is open. `ATTACH` through
`asSystem().sql` lands on the writer, so `findMany` outside a transaction fails
`no such table: cust.attr`. Wrapping the read in `$transaction` routes it to the
writer and everything above works, which is a probe rather than a design: it
serializes every segment behind the write lock.

What is missing is one seam — **a connection hook**. `createClient` runs a
hardcoded pragma list against each handle and offers nothing to extend it; an
`onConnect(db, role)` would let an app attach its own file to both, and would also
be the answer for every other per-deployment pragma somebody currently cannot
set. Smaller than `@@extensible` and it unlocks more.

**Atomic commit across the two files does not exist here, and the pragma readout
says why.** `main` comes up `wal` because litestone forces it; the attached file
came up `delete`. SQLite's atomic multi-database commit needs a master journal
and does not apply when a participating database is in WAL, so a transaction
spanning main and cust can commit one and not the other.

That is not fatal, it is a constraint that picks the design: **the attached file
must be a derived projection and never the truth.** The blob in `main` stays
authoritative — audited, policied, atomic — and `cust.attr` is a rebuildable
index over it. Divergence is then a repair rather than a lost write, and the
repair is a full rebuild of one tenant's file.

### Pool versus attached file

| | pool of generated columns | the tenant's own attached file |
| --- | --- | --- |
| buildable today | **yes, fully** | no — needs a connection hook |
| cap on fields | sized per model, a deploy to raise | none |
| segment (ids, 200k) | 2.7 ms | 32.5 ms via ORM, 5.0 ms raw |
| index shape | one composite, allocation order matters | ordinary indexes the app creates per tenant |
| truth lives in | `main`, atomic | `main`, atomic — the file is derived |
| what can go stale | nothing, the columns are generated | the projection, on a partial write |
| tenancy | either strategy | `strategy database` only |

The pool wins on *today*, on atomicity and on speed. The attached file wins on
the cap, which is the thing an app hits second. **The honest sequence is the pool
now and the connection hook next**, because the hook is small, is useful for more
than this, and turns the cap from a wall into a choice.

## What `@@extensible` would add

**Revised by Phase 1 below, which measured it.** The sketch here names three
copy-pasted pieces and a `max:` that is always present; both turned out to be
wrong in the same direction — the pool is the OPTIONAL half, and the piece that
actually needs owning is not in the list. Read this for the argument and Phase 1
for the shape.

The pool above needs no framework change, and it costs an app three hand-written
pieces that every app with this feature will write identically: the allocator,
the slot projector, and the segment compiler. That is the case for a
declaration — not because the feature is impossible, but because it is
copy-pasted:

```lite
model Subscriber {
  id     Int    @id
  email  String @unique
  fields Json

  // The seed says: this app has tenant-declared columns, they come out of
  // `fields`, a row of `Field` is what declares one, and here is the ceiling.
  @@extensible(fields, declaredBy: Field, max: 40)
}

model Field {
  key      String
  type     FieldType
  indexed  Boolean @default(false)
}
```

`@@extensible` would generate the pool, own the allocation, project the mirror on
every write, and rewrite a `where` naming `company_size` into one naming `n2` —
so the tenant's own key is what crosses the wire and the slot never leaves the
Data boundary. It would also let the migrator grow the pool safely, which is the
one thing the hand-built version cannot do without a deploy.

The rest falls out rather than being designed: `$checkWhere` answers on a
promoted key, so `autoFilter` stops refusing it and a segment is an ordinary
`where` that keeps its gate and every row policy; `jsonschema` emits the key so a
generated form offers a control; `access.snapshot.md` has a shape to report. A
segment then needs no new query mechanism at all — it is a stored `where` clause
replayed through the ORM, which [scoped-sql.md](scoped-sql.md) already argues is
the right refusal to keep.

## What it must not become

**Not a per-tenant schema file.** The moment a tenant can declare a *model*, or a
relation, or a `@@gate`, there are two schema languages and one of them is a
database table. The extension point is one column shape on one model, capped, and
the cap is in the seed rather than in a runbook.

**Not a migration a tenant triggers.** A tenant adds a row; a promotion is
asynchronous, idempotent, and its absence degrades to the scan rather than to an
error. A customer clicking *save* must not be able to hold a write lock on their
own database while an `ALTER TABLE` rebuilds it — which under `strategy row` is
every other tenant's write lock too, and is the argument that this feature is
`strategy database` only until somebody proves otherwise.

**Not a way around the gate.** A promoted column is `@guarded`-less, policy-less
and typed by a row, so the honest default is that it inherits the model's rules
and can state none of its own. A tenant-declared column that could carry
`@allow` would be an access rule written by a customer, which is Invariant 6
inverted.

## Footguns already visible

**The promotion is a fact about a file, and `ddl.snapshot.sql` is a fact about a
schema.** Two tenants with different promoted sets have different DDL and the
same snapshot, so the committed artefact stops describing any particular
database. Either the snapshot grows a section saying *plus N tenant-declared
columns of this shape*, or the guarantee it currently makes quietly weakens.

**SQLite's `ALTER TABLE ADD COLUMN` refuses an expression default**, which
`CLAUDE.md` already records as a live hazard: a generated column is fine, a
promoted column with a computed default is a table rebuild, and a rebuild is
refused where the app made its own index over that table. The promotion path has
to stay inside the subset that is a cheap `ADD COLUMN`.

**A cap is not optional, and the number is a write-rate decision rather than a
round one** — measured above at 0.25 µs per row per declared column, so the pool
is sized from how often that model is written and nothing else. Salesforce's
per-object field limits are famous for being felt; they exist for a different
reason (their flex columns are real storage) and the shape of the lesson still
holds: the number belongs in the seed, beside its reason, so it is a decision
somebody made rather than a limit somebody hit.

**The measurement that has to stay green is the negative one.** A promoted column
changes no answer — the same rows come back either way — so every behavioral
test passes with the promotion silently not happening. The assertion is the
`EXPLAIN`, exactly as it is for `@@index([cols], where: …)`
([partial-indexes.md](partial-indexes.md)), and for the same reason.

## Open

- Whether the promoted column is `GENERATED … VIRTUAL` off the blob or a real
  stored column the writer maintains. Virtual measured well and needs no write
  path at all, which is most of the appeal; stored is what you want if the value
  is ever computed from more than the blob.
- What `release:check` classifies a promotion as. It is not expand and not
  contract — the running release does not know the column exists and does not
  need to, which may make it the first change that is genuinely neither.
- Whether `@@extensible` should be able to say *and these keys are promoted for
  every tenant*, which is the ordinary case of a field the platform ships and
  every customer has.
- Whether a tenant-declared key can carry a `@@unique`, which is the second thing
  Salesforce needed a whole second pivot table for.
- **`createClient({ onConnect })`, which Design B needs and nothing else offers.**
  Two handles per database and a hardcoded pragma list mean an app cannot attach a
  file, set `mmap_size` for its own hardware, or register a custom function. It is
  the smallest item on this page and the one that unblocks the most.

## Phase 0 — the two rulings, settled 2026-09-01

Both were probed against the tree rather than argued.

**The pool, not the attached file, for the first slice.** `example` is
`strategy database` with shops under `./shops/`, so a pool is already per-shop
and every tenant's file is migrated from the one schema. Design B stays blocked
on `createClient({ onConnect })` and is out of scope; the cap is the price and it
is recorded above rather than solved.

**The app wraps the resource; `<Form>` and sierra are untouched.** The first
guess was that a generated form would grow a declared field by itself, and that
is false — `buildFieldRules(schema)` reads the JSON Schema, which is compiled
from `.lite`, so a `FieldDef` row is invisible to it. The second guess was that
the app would therefore hand-compose children. Also unnecessary: `<Form>` calls
`resource?.formFields?.({ only, except })` duck-typed, and `$context.form` reads
`resource?.fields`, so an app can hand `<Form>` a **wrapped resource** whose
`fields` and `formFields()` merge the schema's rules with one synthesized rule
per declared field — `{ type, required, nullable }` is the whole shape
`controlFor` needs. Generation then works unchanged, in app code, with no
framework edit and no children.

That second ruling is the one worth carrying: **the seam already exists and is a
duck-typed call.** If it later deserves to be a real extension point, the shape
it should take is the one an app is already forced to discover.

## Phase 1 — the second model, and the one thing it settled (2026-09-08)

Everything above is about ONE model with a pool. The question left open by it is
the one that decides whether `@@extensible` is a word: **is a declared key that
is never segmented on the same feature, or a different one?** It was answered by
building it rather than argued — `example` now has a second extensible model,
`Product`, carrying declared keys and **no pool at all**, and the assertions are
in `verify:custom-fields` (55 rows, `blob.*` and `assembler.*`).

**They are one feature, and the evidence is that almost nothing had to change.**

| what | change for a model with no pool |
| --- | --- |
| the form assembler (`web/src/custom-fields.js`) | **none.** `rulesFor` reads `key`, `type`, `label` — it never knew a slot existed |
| `compileSegment` | **none.** Every term comes back `unindexed`, through the path a full pool's thirteenth field already took |
| the declaration route over HTTP | **none.** Same route, same hook, same 201 |
| the allocator's caller | **one line** — `pool ? allocateSlot(pool, declared, type) : null` |

The sharpest row is `assembler.aPromotedFieldAndAnUnpromotedOneRenderIdentically`:
a promoted `Customer` field and an unpromoted `Product` one of the same type
produce the same rule object, label aside. If those had differed, the two tiers
would be two features and would need two names.

So the pool is not the feature. **The feature is *a key a tenant declares*, and a
pool is an optimization some of those keys get** — which inverts the sketch
above, where `max:` is always present.

### The draft

```lite
model Customer {
  id     Int  @id
  fields Json @default("{}")

  // Segmentable: 12 slots and the composite index that serves them.
  @@extensible(fields, declaredBy: CustomField, max: { text: 8, number: 4 })
}

model Product {
  id     Int  @id
  fields Json @default("{}")

  // The ordinary case. Keys store, render and edit; a segment naming one is
  // reported `unindexed`. No pool, no mirror, no index, no tax on every write.
  @@extensible(fields, declaredBy: CustomField)
}
```

`max:` absent is the common declaration and `max:` present is the one that costs
something — measured above at ~0.25 µs per row per declared column, paid by
every write to that table forever, including by tenants who declared nothing.

### What it must own, ranked by how silently the hand-written version fails

**1. Scoping the declarations to the model. This is the whole of it.** Adding the
second model turned two `customField.findMany({})` calls into bugs that fail in
total silence — `customers.service.ts`'s `declared()` and `carts.service.ts`'s
`declaredFields()`, the second of which feeds `Discount.audience`. Unnarrowed, a
key declared on a product is an accepted segment term over customers that matches
**nobody**: the request succeeds, the count is plausible, and a discount goes to
the wrong people. That is the exact failure this whole feature exists to prevent,
reintroduced by adding a model to it. `declaredBy:` knows which model is asking
and no service can get it wrong.

**2. The pool and its index as ONE fact.** Allocation order and index column
order are the same thing and were two hand-written lists here; measured at 20,000
rows, the disagreement cost the two-term segment its second column —
`(t1=?)` where the agreeing order gives `(t1=? AND n1>?)`. A generated pool
cannot disagree with its own index.

**3. The mirror.** `ctx.system.add('slots')` in a `validated:` hook, per model,
is `FJS-644`'s seam used correctly and it is still a hook an app must remember.

**4. `$checkWhere` answering on a declared key**, so `autoFilter` stops refusing
one and a segment is an ordinary `where` with its gate and row policies intact.

### What it must NOT own, and each was tried

**The rendering.** The assembler is pool-agnostic, app-side, and about thirty
lines. `formFieldList`, `validateAgainstFields` and `coerceToSchema` all take a
plain `Record<string, rule>` — only `buildFieldRules` takes a schema — so a
runtime field list is already a first-class input to sierra's form layer. There
is nothing to add there and Phase 0's second ruling stands.

**A default, and whether a list offers the key as a column.** Both are ORDINARY
COLUMNS on the declaring model (`defaultValue String?`, `show Boolean`), because
what a shop stores about its own field is the shop's business and no attribute
can enumerate it. `default` is already one of the keys a field rule carries, so a
declared default prefills a generated form with nothing added to `<Form>`; `show`
decides a table's columns and never an answer, which keeps it an affordance
(Invariant 6).

**Refusing an undeclared key.** A dump is a dump. maid.tech validates nothing
across six models and that is not the thing wrong with it — the declared list
there exists to RENDER, and making declaration a precondition of writing would
remove the only property that makes the untyped tier worth having.

### Two refusals the language made unprompted, and both were right

`@@unique([model, slot])` over a nullable column was refused by name, with the
three escapes listed including the one this design wants —
`nullsDistinct: true`, because a model with no pool declares every field with
`slot` null and those rows are not in conflict.

The migration was refused too: `adds NOT NULL column(s) with no DEFAULT:
custom_field.model`. `example` is a fixture and was reset. **An app with rows
cannot do that**, which is the real adoption blocker and has nothing to do with
slots: giving an existing single-model declaration table a required discriminator
is a backfill. Any app converting to this hits it first.

### Tier 1, whole — and it needs no framework change

The pool is the optimization. What is left when you take it away is the tier
every consumer so far actually runs, and it is two tables and one column. Run
against a real client, 11 assertions, all green:

```lite
enum CustomFieldType { text number }

/// What a tenant has declared. A ROW, so adding a field is not a deploy.
model CustomField {
  id           Int             @id
  model        String          @length(1, 40)
  key          String          @lower @length(1, 40) @regex("^[a-z][a-z0-9_]*$")
  label        String          @length(1, 80)
  type         CustomFieldType
  defaultValue String?         @length(0, 200)
  show         Boolean         @default(true)

  @@unique([model, key])
  @@gate("5.5.5.5")
}

model Product {
  id     Int    @id
  name   String @length(1, 80)
  fields Json   @default("{}")      // the dump
}
```

`Product` gains exactly one column — `"fields" TEXT NOT NULL DEFAULT '{}'` — and
**no server code at all**: no hook, no `ctx.system`, no mirror, no projector, no
segment compiler. `CustomField` takes derived CRUD like any model. The only thing
an app writes is the ~30-line rule assembler in the browser, and even that is
assembling rather than teaching: `formFieldList`, `validateAgainstFields` and
`coerceToSchema` all take a plain `Record<string, rule>`, so a runtime field list
is already a first-class input to sierra's form layer.

**A declared key is not a whitelist, and that is the feature.** An undeclared key
in the blob is accepted; declaring says what a form OFFERS, not what may be
written. Making declaration a precondition of writing would remove the only
property that makes an untyped tier worth having, and no consumer read so far
validates it.

### And it must not be a `type`, which was tried

The obvious economy is to skip the table and describe the blob instead —
`fields Json @default("{}") @type(ClientFields)`. It parses, and it inverts the
feature. **A `type` is CLOSED on write**, measured:

```
a key the type declares         ACCEPTED  → {"care":"wash 30"}
a key the tenant added at 3pm   refused   → fields.fabric: unknown field — type ClientFields has …
```

So a tenant adding a key on Tuesday has every write refused until somebody edits
the `.lite` and deploys, which is the one thing this design exists to avoid. A
`type` says *these keys, decided at build time*; tier 1 says *keys decided at
runtime, by somebody who cannot deploy*. Same column, opposite claims.

Where both are wanted they are **two columns, because they answer to two
different people**:

```lite
model Client {
  address Json @type(Address)      // yours — closed, typed, validated
  fields  Json @default("{}")      // theirs — open, whatever they declared
}
```

The same probe also asked whether the SET could live in one typed column
(`type Set { fields Def[] }`, since `Json @type(T[])` is a parse error). It
cannot, and the reason is worth carrying: that wrapper is exactly the depth at
which type validation stops running (`FJS-1030`), so the column would look
declared, generate a TypeScript interface, emit a JSON Schema with every
constraint intact — and validate nothing. Strictly worse than an honest blob,
which at least does not read as guarded. Two more holes were found in the same
sitting: an enum member inside a type is never validated (`FJS-1031`), and a
`@default` its own `@type` would refuse is accepted with no word from the parser
(`FJS-1032`).

**All three survived because nothing in this repo declares one.** Eleven `type`s
across `example` and the packages, zero nested, and zero used as `Json @type(T)`
on a column — they are all service `input:` contracts. Shipped complete, never
run: the shape of `FJS-970` and `FJS-972` one realm over.

### Still open after Phase 1 — every one of these is answered in Phase 2 below

- **What `max:` says about index ORDER, which is a bet and not a fact.** Measured
  at 20,000 rows on the two orders a generated pool could pick: four text terms
  reach four columns under text-first and one under interleaved (0.03 ms against
  0.94), and the trade runs the other way on a mixed pair (0.21 ms against 0.06).
  Neither is right for both mixes, so a generator has to choose one and say so.
  `max: { text: 8, number: 4 }` states the shape; it does not yet state the order.
- **How `declaredBy` finds the key columns.** The declaring model needs a column
  holding the model name, one holding the key and one holding the slot. Convention
  (`model` / `key` / `slot`) or named arguments — unresolved, and it is the
  difference between an attribute that reads a model and one that dictates it.
- Whether one `@@extensible` model may serve several extensible models, which is
  what `example` now does and what makes the scoping rule load-bearing.
- **Whether `shape:` is an alternative to `declaredBy:` at all**, given the three
  defects above. Naming a `type` to say what one declaration LOOKS like is the
  cleanest answer to the column-guessing question, and it is only worth having
  once `FJS-1030` and `FJS-1031` are closed — a shape whose constraints do not
  run is a comment with syntax.

## Phase 2 — built, and `example` is the first user (2026-09-08)

`@@extensible(column, declaredBy: Model[, max: { kind: N }])` ships. What closed
each of Phase 1's four open questions was building the thing, and three of the
four were answered by MEASUREMENT rather than by argument.

**The order.** Three orderings × six field mixes at 20,000 rows scored **13
index columns reached, all three** — the trade is conserved, so there is no
ordering that is better, only orderings better for different mixes. That makes
the order a statement rather than a search: the pool is laid down by the RATIO
`max:` declares, so `{ text: 8, number: 4 }` is 2:1 and lays two text per
number, and an app expecting mostly text says so and gets a run of text at the
front. Not a `order:` argument, because the ratio already carries it and a
second way to say one thing is the thing this file's own § *What it must not
become* refuses.

**`declaredBy` finds its columns by convention** — `model`, `key`, `type`, and
`slot` where `max:` is present — and whichever is missing is named at parse.
Convention rather than named arguments because a second spelling for columns the
app has already written is a second thing to keep in step; what keeps it from
being a silent guess is that the refusal is by name. **`shape:` was not built
and no longer looks worth building**: naming a `type` answers *what one
declaration looks like*, and four column names looked for by name answer the
same question with nothing new to learn.

**One declaring model serves several extensible models**, which is what makes the
scoping rule load-bearing rather than tidy: `$declaredFields()` is narrowed to
the model it was called on and cannot be widened, because a plain `findMany`
answers with another model's keys and the failure is TOTAL SILENCE — a key
declared on a product becomes an accepted term in a query over customers,
matching nobody, request succeeding, count plausible.

### The fourth thing, which Phase 1 did not have on its list

**The slot is allocated at the Data boundary.** Phase 1 ranked what
`@@extensible` should own by how silently the hand-written version fails, and
put the allocator outside it — it looked like app policy. It is not: the three
things it takes are the pool, its order, and what is already spoken for, and all
three are facts the schema states. What made the case was the ranking's own
test. An app writing the allocator reads `max:` back out of the parsed seed and
the order off the generated index, and when that goes wrong every declaration
reads as *the pool is full* — a slotless field stores, renders and edits exactly
like a promoted one, every query still answers correctly, and only the plan is
different. That is the same silence the feature exists to end.

A slot the payload STATES is honored rather than recomputed, which is the half
that keeps a restore possible: re-deriving them would repoint live fields onto
slots whose values were written for other keys, and unlike the mirror that does
not self-heal.

### What adopting it deleted from `example`

The app was the hand-written version this whole file is about, so the diff is
the measurement:

| gone | what it was |
| ---- | ----------- |
| `core/schema.ts` | a second reader of `db/schema.lite`, parsing it as a DOCUMENT at import to derive the pool |
| `derivePool` / `hasPool` | a regex over `@generated("json_extract(…)")` and a search for the composite index that covered every slot |
| `allocateSlot` | first-free-of-kind over that derived order |
| `projectSlots` | the mirror, rebuilt whole on every save |
| `custom-fields.service.ts`'s hook | the allocator's caller, plus `ctx.system.add('slot')` |
| `customers.service.ts`'s three `validated:` hooks | the projector's callers, plus `ctx.system.add('slots')` on each |
| twelve `@generated` columns, the mirror and one `@@index` in the seed | one `@@extensible(…, max: { text: 8, number: 4 })` |

What is left in `api/src/domain/shop/custom-fields.ts` is two functions over the
shop's own keys that name no slot at all — and they are the half a framework
cannot have, because they are a POLICY: a term on a declared-but-unpromoted
field is REPORTED to the merchant rather than refused. The boundary refuses one
and is right to, since there is no index to read it by; a segment builder needs
to be told which of its terms did not apply, which is a sentence and not an
error.

**Two defects became unreachable rather than fixed.** `FJS-660` (the hook with
Feathers' `(data, params)` signature, so every declaration over HTTP was a 500)
and `FJS-644` (a hook writing a `@system` column without saying so, so every
customer create over HTTP was a 403) were both defects in code that no longer
exists. Neither was findable from one side of the crossing, which is why
`verify:custom-fields` grew an `http.*` section, and that section is now the
half of the drive that still grades something the framework cannot.

**And the migration is the honest cost.** `CustomField.model` is NOT NULL with
no default, so `migrate create` wrote the rebuild COMMENTED OUT — correctly:
what the old rows meant is a fact about the app. Here it is `'Customer'` and it
is exact rather than a guess, because `key` was `@unique` on its own until this
change, which is only correct while one model has any declarations. **That
backfill is the real conversion blocker for an app with live rows**, and it is
one hand-written `INSERT … SELECT` rather than a hazard.

## See also

- [scoped-sql.md](scoped-sql.md) — why a segment must be a `where` through the ORM
  and never authored SQL, and the ruling that closed that hole by refusal
- [schema-variants.md](schema-variants.md) — a different runtime-shaped schema
  question, and the Django-versus-Rails prior art split that this file's
  Frappe-versus-Salesforce split is the same argument as
- [scaling.md](scaling.md) — why the whole of this is `strategy database`'s
  problem, and what that strategy does and does not isolate
- `packages/litestone/src/core/migrate.js` — `diffColumns`, and the line
