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
SQLite does not: three indexed lookups `INTERSECT`ed materialise three sorted id
sets, and the measurement above is what that costs — *slower than the full scan
it was meant to replace* on the broad case. The shape is not wrong; the substrate
underneath it is a different one.

**Frappe runs DDL.** A `Custom Field` is a doctype row, and saving it
synchronises the schema — `frappe.db.sql_ddl()` issuing `ALTER TABLE`, per site,
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
  slots  Json   @default("{}") @guarded(all) // slot-keyed mirror — what is indexed

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
serialises every segment behind the write lock.

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
changes no answer — the same rows come back either way — so every behavioural
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
`fields` and `formFields()` merge the schema's rules with one synthesised rule
per declared field — `{ type, required, nullable }` is the whole shape
`controlFor` needs. Generation then works unchanged, in app code, with no
framework edit and no children.

That second ruling is the one worth carrying: **the seam already exists and is a
duck-typed call.** If it later deserves to be a real extension point, the shape
it should take is the one an app is already forced to discover.

## See also

- [scoped-sql.md](scoped-sql.md) — why a segment must be a `where` through the ORM
  and never authored SQL, and the ruling that closed that hole by refusal
- [schema-variants.md](schema-variants.md) — a different runtime-shaped schema
  question, and the Django-versus-Rails prior art split that this file's
  Frappe-versus-Salesforce split is the same argument as
- [scaling.md](scaling.md) — why the whole of this is `strategy database`'s
  problem, and what that strategy does and does not isolate
- `packages/litestone/src/core/migrate.js` — `diffColumns`, and the line
