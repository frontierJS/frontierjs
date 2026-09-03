---
id: partial-unique
status: argued
dated: 2026-08-30
---

# Argued — `@@unique(where:)`: conditional uniqueness

**Status: BUILT — shipped 2026-08-31, in the build order below.** The record is
kept as written; § *What building it corrected* at the end says where it was
wrong, because that is the half worth reading next time.

This is `FJS-603`, and it is `IDEAS/partial-indexes.md` § *Option C — settle
`FJS-204` first*, taken up. Every measurement below was made against the tree on
2026-08-30 and the probes are quoted where they carry the argument.

**The short version.** The spelling is `@@unique([cols], where: <expr>)`. It does
not reopen `FJS-204`, because `FJS-204` refused a predicate the FRAMEWORK derives
and this is one the AUTHOR declares. Most of the machinery is already built and
was measured, not estimated. The two pieces of real work are `release.js`, which
keys a unique on its column list alone and would grade a narrowed constraint as
no change, and the rule that the soft-delete clause is **not** ANDed in here — the
one place this feature could silently become the thing that was refused.

## Where the question came from

Three models in `example/db/schema.lite` declare the same near miss, each with a
comment naming `FJS-603` in the schema itself:

```lite
@@unique([planId, effectiveTo],            nullsDistinct: true)   // PlanVersion
@@unique([employeeId, effectiveTo],        nullsDistinct: true)   // PayWindow
@@unique([kind, fromAmount, effectiveTo],  nullsDistinct: true)   // PayRate
```

Every one of them wants *at most one OPEN row per parent* and declares the exact
opposite: `nullsDistinct: true` is the way to say *the open rows are deliberately
unconstrained*. The parser offers it by name in the refusal for
`@@unique([planId, effectiveTo])`, so the language currently walks an author from
the right question to the wrong answer.

Three instances is what one could not give. Effective dating is not a corner of
this repo — it is `PlanVersion`, it is the whole of `IDEAS/payroll.md` phase 2,
and `example`'s `verify:employment` already carries the hole as an executed
assertion (`gap.twoOpenWindowsAreAcceptedByTheSchema`), which turns red when this
ships. That is the drive doing its job.

The reference corpus agrees at a scale nothing here can, **as counted on
2026-08-29**: 119 of its 251 partial indexes are unique ones — lago 73,
discourse 32, mastodon 14 — recorded in `IDEAS/partial-indexes.md`, which shipped
the plain half and left this the larger remainder.

**That number could not be re-derived on 2026-08-30 and is carried on the earlier
record's authority alone.** The committed `test/fixtures/corpus/gaps.json` holds
526 rows from `hrms` and nothing else, with no partial-index kind among them, so
the multi-source run those counts came from is not what is in the tree now.
Re-running `bun test/fixtures/corpus/fetch.mjs` (network) is what settles it, and
it is worth doing before the corpus figure is quoted anywhere a decision rests on
it. The three instances in `example/db/schema.lite` are the evidence this record
actually stands on, and they are re-derivable at any time.

## What the neighbours do

**Prisma shipped it, and picked this spelling.** v7.4, February 2026, behind the
`partialIndexes` preview flag, for PostgreSQL, SQLite, SQL Server and
CockroachDB, with migration and introspection support:

```prisma
@@unique([email], where: raw("status = 'active'"))
@@unique([title], where: { published: { not: false } })
```

Not `@@index(unique: true)`. The same `where:` argument name already carried by
`@@index`. Two predicate forms — a typed object literal and a `raw()` escape.

**ZenStack adds nothing of its own**, and could not: its schema language is
Prisma's, so it inherits the construct and the spelling together. Before v7.4 its
own published answer to precisely this problem — uniqueness among live rows on a
soft-deleting model — was to hand-write the predicate into a migration file.
There is no ZenStack spelling to copy, only the Prisma one.

**Django is the other schema language in the sample and it agrees.**
`UniqueConstraint(condition=Q(...))` keeps the uniqueness word and documents
loudly that supplying a condition makes it emit `CREATE UNIQUE INDEX` rather than
a table constraint. That is exactly the divergence § *One word, two node kinds*
proposes, made by a project that has lived with it since 2019.

**Rails, Ecto, Drizzle, EF Core and SQLAlchemy all say index** —
`add_index …, unique: true, where:` and its four dialects. They are migration
DSLs: thin, deliberate skins over DDL, where naming the mechanism is the point.
The split in the prior art is clean and it decides nothing by itself, but it is
the right axis: **schema languages keep the uniqueness word, migration DSLs keep
the mechanism.** Litestone is a schema language.

## The spelling — `@@unique([cols], where: <expr>)`

The prior art is a tiebreak. Four arguments from inside this tree decide it, and
they compound.

**`@@index` means *changes no answer* here, and this changes answers.** The
package's own summary of what proves a partial index is the EXPLAIN, precisely
because every behavioural test passes with the index dropped. A partial unique
refuses writes. Putting it on `@@index` puts a write refusal behind the one
attribute whose whole documented property is that it has no observable effect.

**`@@index(unique: true)` mints a third spelling of plain uniqueness.**
`@unique`, `@@unique([col])` and `@@index([col], unique: true)` would all be one
constraint. `test/index-predicates.test.ts` carries a negative control that
`@unique ⇄ @@unique([col])` migrates nothing, for the good reason that SQLite
builds the same index for both; a third spelling is a third permanent row in that
matrix and a third thing `tableUniques`' `origin` filter has to be right about.

**The fix has to be reachable from the refusal that sends people wrong.** The
whole sting of `FJS-603` is the near miss: an author writes
`@@unique([planId, effectiveTo])`, is refused by name, and is handed
`nullsDistinct: true`. The correct answer must be one clause further along the
same sentence. Nobody reads a `@@unique` refusal and then goes to read about
`@@index`.

**The error classes are already named for it.** `UniqueConflictError` and
`SoftDeletedUniqueError` are what a caller gets, and both are derived from
SQLite's own message rather than from the attribute — measured below. An
`@@index` that raises a unique conflict is a lie in the error's name.

The predicate keeps litestone's expression grammar — `where: effectiveTo == null`,
the same argument shape `@@index(where:)` already parses and compiles. **Prisma's
object literal is not adopted**: two spellings of a predicate in one language is
the cost, and the compiled-SQL text is what the migrator compares (§ below), so
the predicate has to go through the compiler that writes it. The Prisma importer
gains a construct to carry — the object form translates, `raw()` does not — which
is a row in `src/import/tiers.js`, `changed` for the first and `noted` for the
second.

## Why this is not `FJS-204`

`IDEAS/partial-indexes.md` refuses `@@unique(where:)` in one sentence — *a
partial unique index reopens `FJS-204`, which is ruled* — and that sentence is
about a different feature that shares a DDL statement. This is the load-bearing
paragraph of this record and nothing should ship until it is agreed.

`FJS-204` ruled that **a soft-deleted row KEEPS its `@unique` slot**, and the
rejected alternative was that litestone would *derive* `WHERE "deletedAt" IS NULL`
onto every unique index in order to free it. That derivation is what breaks the
contract: it makes `@unique` conditional for a reader who never asked for a
condition, so `findUnique({ withDeleted: true })` legitimately matches two rows on
a column the schema calls unique, and `restore()` becomes conditionally
impossible. Every word of that stands.

**A declared predicate over a domain column is the opposite construction.**
`@@unique([employeeId], where: effectiveTo == null)` is conditional because the
author wrote the condition, on a column that has nothing to do with deletion.
`@@unique([email])` on the next model is unconditional and stays so. There is one
answer to *is this column unique* per declaration, which is Invariant 4's
requirement; the failure Invariant 4 names is two answers to ONE declaration, and
that is what the derivation would have produced and a declaration cannot.

**So the rule that keeps both true is one line, and it is the sharpest thing in
this record.** `createIndexes` ANDs `@@softDelete`'s `"deletedAt" IS NULL` into a
declared `@@index(where:)` predicate, deliberately, because on such a model that
clause is what makes the index reachable at all. **It must not be ANDed into a
declared `@@unique(where:)`.** For an index the AND is an optimisation; for a
unique index the AND is the constraint, and ANDing it is `FJS-204`'s rejected
derivation arriving through the back door — the deleted row stops holding its
slot, and `SoftDeletedUniqueError` can never fire for a partial unique because
the index no longer covers the deleted row that would have raised it.

An author who wants uniqueness among live rows writes `deletedAt == null` into
the predicate themselves, at which point they have said it and the error they get
back is the ordinary `UniqueConflictError`. That is the honest shape and it is
what `FJS-204` refused to have done on their behalf.

## One word, two node kinds

`@@unique([a, b])` is emitted **inside `CREATE TABLE`** as `UNIQUE (a, b)`
(`ddl.js:253`). A predicate cannot ride a table constraint in any SQL dialect, so
a partial unique must be a standalone `CREATE UNIQUE INDEX … WHERE`. The two
migrate differently and the gap is not cosmetic: a table constraint can only
change by rebuilding the table, which is why `FJS-592`'s cheap half shipped
alone, and an index changes with one DROP and one CREATE.

Measured — the two are cleanly distinguishable in the live database:

```
PRAGMA index_list, explicit partial unique : { unique: 1, origin: 'c', partial: 1 }
PRAGMA index_list, UNIQUE (a) constraint   : { unique: 1, origin: 'u', partial: 0 }
sqlite_master.sql, the first               : CREATE UNIQUE INDEX … WHERE "effectiveTo" IS NULL
sqlite_master.sql, the second              : null
```

So the parser should emit a **distinct node kind** for the predicate form rather
than adding a field to `uniqueIndex`, and the emitter should route it to
`createIndexes` with `unique: true` rather than to `tableConstraints`. One word
in the language, two mechanisms underneath, which is what Django does and
documents. The alternative — one node kind whose migration cost silently varies
between *rebuild the table* and *swap an index* depending on whether an argument
is present — is the shape nobody can reason about at the point of writing it.

## What is already built

Measured, and this is why the record recommends building rather than deferring.

**The migration differ handles it whole, today.** `tableUniques` filters
`PRAGMA index_list` to `origin === 'u' || 'pk'`, with a comment saying `c` is an
explicit `CREATE INDEX` *which the index diff already owns and must not see
twice* — so a partial unique lands in the index path by construction, with no
edit. And `indexKey` is already the right key:

```js
return `${idx.unique ? 'u' : ''}:${cols.join(',')}:${idx.where ?? ''}`
```

Uniqueness and predicate are both terms of it. `introspect` captures the `WHERE`
tail and `parseIndexColumns` steps over quoted names and expression members —
`FJS-576` and `FJS-586`, both closed. **Nothing in the migrator needs changing**,
which was not true of the plain half when it was proposed.

**The error translation needs nothing.** SQLite's message is byte-identical for a
partial unique index and a table constraint, so `uniqueConflictColumns` reads it
unchanged. Measured, including a value-carrying predicate:

```
CREATE UNIQUE INDEX … ON pay_window (employeeId) WHERE effectiveTo IS NULL
  three closed rows for employee 1 → accepted
  a second OPEN row for employee 1 → UNIQUE constraint failed: pay_window.employeeId

CREATE UNIQUE INDEX … ON t2 (email) WHERE status = 'active'
  two archived duplicates          → accepted
  a second active duplicate        → UNIQUE constraint failed: t2.email
```

**Nothing crosses to the browser.** `uniqueIndex` is read by five modules —
`parser`, `ddl`, `release`, `advise`, `catalog` — and by `studio.html`. It is
absent from `jsonschema.js` and from `typegen`, so there is no `x-` key, no
JSON Schema keyword and no generated type to widen. A partial unique is invisible
above the Data boundary exactly as an index is.

**`findUnique` is not key-restricted here**, which is the sharp edge Prisma is
currently bleeding from. Litestone's `findUnique` runs the caller's `where` and
throws if more than one row comes back; it derives no `WhereUniqueInput` from the
`@@unique` set, so there is no generated lookup type to be wrong. Prisma's
[#29282](https://github.com/prisma/prisma/issues/29282) is exactly that mistake —
a partial unique generating a compound lookup input, so a caller is offered a
key that identifies at most one row *among those matching the predicate* and any
number outside it. Litestone gets the right answer by not having the feature.
**It should be written down rather than relied on**: the day a `WhereUniqueInput`
is derived, a partial unique must be excluded from it.

## The grammar may be wider here than on `@@index`

`@@index(where:)` refuses a value-carrying predicate at parse, in a long sentence
about the planner: litestone binds every filter value as a parameter, SQLite has
to prove a query implies the index at PREPARE time, so `status = ?` cannot be
matched against `status = 'pending'` and the index would be maintained on every
write and matched by nothing. The rule is *the compile pushes no parameters*, and
it is enforced by the compiler that would violate it.

**That argument does not bind the unique case, and this is the one place the two
attributes genuinely differ.** A unique index's job is enforcement on INSERT, and
enforcement does not go through the query planner at all. The `t2.email` probe
above is exactly that: `WHERE status = 'active'` is unreachable for reads by
litestone's own rule, and it refused the duplicate correctly. So
`@@unique([email], where: status == "active")` is a **correct constraint that
happens to be a useless read path**, where the same predicate on `@@index` is
nothing but a useless read path.

Two consequences, and the second is a decision to take rather than a fact:

- The zero-parameter rule is not a correctness requirement here, so the unique
  form can accept the value comparisons the index form refuses — which is what
  covers the unique partial indexes the corpus was reported to hold, most of
  which are `where deleted_at is null` or a status comparison.
- **A predicate is still worth compiling rather than passing through as text.**
  SQLite refuses a subquery and a non-deterministic function in an index
  predicate *by name*, which sounds like it makes a parse-time check redundant.
  It does not — measured:

  ```
  WHERE a IN (SELECT a FROM t)      → REFUSED: subqueries prohibited in partial index WHERE clauses
  WHERE random() > 0                → REFUSED: non-deterministic functions prohibited …
  WHERE createdAt > datetime('now') → ACCEPTED
  ```

  SQLite takes `datetime('now')`, which is a predicate whose truth changes under
  a row that never moved — an index that silently stops covering rows it once
  covered, on a UNIQUE index, where the consequence is a duplicate. **`now()` has
  to be refused at parse**, by litestone, because nothing below will do it. Same
  for `auth()`, which is not a Data-boundary concept in an index at all.

The recommended acceptance rule is therefore: **the `@@index(where:)` grammar,
minus the zero-parameter restriction, plus a by-name refusal of `now()`,
`auth()`, subqueries and foreign columns.**

## What it costs

**`release.js`, and this is the one real correctness item.** `describeModel`
keys a unique on its **sorted column list alone** —
`attrs.filter(a => a.kind === 'uniqueIndex').map(a => [...a.fields].sort())` —
and `compareConstraints` diffs those lists. `IDEAS/partial-indexes.md` predicted
this exactly: *it becomes a correctness hole the day Option C ships — on a UNIQUE
index the predicate IS the constraint, and narrowing one is a contract that a
column-list diff cannot see.* Narrowing `where: effectiveTo == null` to
`where: effectiveTo == null && active == true` is a widening of what is permitted
and grades as EXPAND; widening the predicate refuses rows N-1 writes happily and
is a **contract**. The predicate has to be carried into `m.uniques` and compared,
before or with the feature, never after.

**Adding one is a contract for `release:check`**, like any new row invariant, and
for the same reason a new `@@unique` and a new `@@check` are: the release still
serving knows nothing about it and writes rows the new one forbids. Removing one
is expand.

**`db/release.snapshot.md`, `db/ddl.snapshot.sql` and `db/access.snapshot.md`
regenerate**; the `snapshots` CI phase catches any surface this touches that was
not predicted. `access.snapshot.md` should not move — a unique index is physical
and grades nothing.

**`advise.js` reads `uniqueIndex` for column coverage** in two places and will
need to know that a partial one covers only some rows.

**The `@@unique` over a nullable column check needs a clause.** The parse error
that offers `nullsDistinct: true` is now offering the second-best answer, and its
sentence should name both: `nullsDistinct: true` if the open rows are deliberately
unconstrained, `where:` if at most one of them is meant to exist. That sentence is
the whole reason the spelling is `@@unique`, so it is not a nicety.

**The importer.** Prisma's `where: { … }` object form and its `raw()` form both
need a reading in `src/import/prisma.js`, graded in `src/import/tiers.js`. The
Rails and SQL readers already meet `CREATE UNIQUE INDEX … WHERE` in the wild
and each currently drops it rather than emitting
a stronger constraint than the source declares, which is a `lost` row that
becomes a carried construct.

## Build order

1. **Carry the predicate into `release.js`** — `m.uniques` and the
   `compareConstraints` diff, with the direction rule: predicate widened is
   CONTRACT, predicate narrowed is EXPAND. It stands alone, it is the only
   correctness hole, and without it step 3 ships a constraint whose changes the
   deploy gate cannot see.
2. **Parse `where:` on `@@unique`** — the `@@index(where:)` grammar, compiled by
   the same compiler so `whereSql` is byte-identical to what the migrator reads
   back; refuse `now()`, `auth()`, subqueries and foreign columns by name; do NOT
   apply the zero-parameter rule; emit a distinct node kind.
3. **Emit** — route the new kind to `createIndexes` with `UNIQUE`, named to stay
   inside the `idx_<table>_<fields>` ownership prefix that `ownedIndex` reads, and
   **without** the soft-delete clause ANDed in.
4. **Amend the nullable-composite refusal** to offer both answers.
5. **`example`** — turn the three near misses into the real declaration and watch
   `verify:employment`'s `gap.twoOpenWindowsAreAcceptedByTheSchema` go red, then
   rewrite it as the assertion that the second open window is refused, and that
   the batch read no longer has to re-check an invariant its own database holds.
6. **The importer**, last, because it is the only step whose value does not
   depend on the others being right.

Effort: S for 1–4, S for 5, M for 6. Steps 1 and 3 are where a mistake is
expensive; the rest is additive.

## What proves it

- `packages/litestone`: `test/index-predicates.test.ts` — the same file, a second
  reader. The negative controls that have to be there are the ones this record's
  arguments turn on: **a partial unique accepts the rows outside its predicate**
  (three closed windows, one open), **the soft-delete clause is absent from the
  emitted DDL** (asserted against the text, because nothing else can see it), and
  **an unchanged predicate migrates nothing**.
- `packages/litestone`: `test/migrations-fixes.test.ts` — a predicate edited in
  place is one DROP and one CREATE and never a table rebuild.
- `example`: `verify:employment` — step 5. It is already the drive that pins
  `FJS-603`, and it is the only place a second open window is created against a
  real database through a real service.
- `example`: `verify:payrun` and `verify:retro` both read across pay windows and
  are the regression surface for getting the predicate wrong in the direction
  that refuses a legitimate row.

## Open questions

- **Does the parse error tell an author which of the two they want?** The
  sentence has to separate *the open rows are deliberately unconstrained* from
  *at most one open row exists*, and those are one word apart in English. Worth
  writing before the feature, because it is the whole discoverability argument.
- **`@@unique(where:)` and `nullsDistinct: true` together** — legal, meaningless,
  or refused? A predicate that already excludes the NULL rows makes the flag
  moot; a predicate that does not may still want it. Refusing the pair is the
  cheap answer and is probably right until somebody produces the case.
- **Does a partial unique belong in `db/release.snapshot.md`'s rendering as
  `@@unique(cols)` or with its predicate?** The rendering is what a reviewer
  reads; the comparison is step 1. They should agree, and the current code
  produces the constraint's text from the column list.
- **Prisma's `raw()` escape** — an author converting a real schema meets it, and
  litestone has no verbatim predicate anywhere. `@@check` takes SQL straight
  through, so the precedent exists; the argument against reusing it here is
  § *The grammar*, and it should be answered rather than assumed.

## See also

- `ISSUES.md` — `FJS-603` (this), `FJS-592` (the constraint-kind migration split)
- `DECISIONS.md` § Query & write semantics — `FJS-204`, the soft-delete slot ·
  `FJS-D130`, `nullsDistinct`
- `IDEAS/partial-indexes.md` — the plain half, shipped; § *The split* and
  § *Option C* are what this record answers
- `IDEAS/payroll.md` phase 2 · `IDEAS/billing.md` phase 1 — the two domains that
  produced all three instances
- [ddl.js `createIndexes`](../packages/litestone/src/core/ddl.js) ·
  [migrate.js `indexKey`/`tableUniques`](../packages/litestone/src/core/migrate.js) ·
  [release.js `describeModel`](../packages/litestone/src/release.js)
- Prior art: [Prisma 7.4.0 release](https://github.com/prisma/prisma/releases/tag/7.4.0) ·
  [Prisma indexes docs](https://www.prisma.io/docs/orm/prisma-schema/data-model/indexes) ·
  [prisma#29282, the lookup-input mistake](https://github.com/prisma/prisma/issues/29282) ·
  [prisma#29263, migrations](https://github.com/prisma/prisma/issues/29263) ·
  [ZenStack on soft delete and unique](https://zenstack.dev/blog/soft-delete-real) ·
  [Django constraints reference](https://docs.djangoproject.com/en/6.0/ref/models/constraints/)

---

## What building it corrected

**The spelling, the `FJS-204` reconciliation, the node-kind split, the
soft-delete rule and the `release.js` hole were all right and all shipped as
written.** Three things were not, and two of them were only findable by running.

**1. The grammar argument was half wrong, and the half that is wrong is the half
the record was most confident about.** § *The grammar may be wider here* reasons
that enforcement never consults the planner, so the zero-parameter rule is not a
correctness requirement — true. It then concludes the unique form can simply
accept value comparisons, and quotes a probe that ACCEPTED
`CREATE UNIQUE INDEX … WHERE status = 'active'`. That probe was hand-written SQL
with a LITERAL in it. Litestone's compiler BINDS every value, so the same
predicate reaches SQLite as `?`, and:

```
parameters prohibited in partial index WHERE clauses
```

— refused, for a unique index as much as for a plain one, at migration time,
against a table the author is no longer looking at. Dropping the rule without
inlining the literals ships DDL SQLite will not build. The fix is one function
(`inlineParams`) and it is safe for a reason worth stating: these are the
SCHEMA's own literals, written into a `.lite` file by a person, never a caller's.

**2. The importer cannot carry a partial unique whose tuple has a nullable
member**, and the record does not anticipate it. Such a tuple wants
`nullsDistinct: true`; a predicate excludes it; emitting both is a schema this
parser refuses — so carrying it writes a `.lite` that does not parse, which is
`FJS-594`'s rule. It is dropped whole with the reason in the gap record. The
existing corpus fixture is exactly this shape, so the test suite found it on the
first run.

**3. `predicateToLite` is shared with `@@index`, so widening it is not free.**
The value form had to arrive as an argument asked for on the unique path alone.
Widening it unconditionally would have made every reader emit
`@@index([c], where: status == "active")`, which the parser refuses — the same
fixed-point failure one attribute along.

**The four open questions, answered by building:**

- *Does the parse error tell an author which of the two they want?* Yes, and the
  answer is sharper than the record expected: the two are not one word apart, they
  are a COLUMN LIST apart. The suggestion is
  `@@unique([planId], where: effectiveTo == null)` — the nullable column moves OUT
  of the tuple — and printing the changed list is what makes the difference legible.
- *`where` and `nullsDistinct` together?* **Refused**, as the record guessed.
- *Rendering in `release.snapshot.md`?* With the predicate, so the rendering and
  the comparison agree: `@@unique(employeeId), where: "effectiveTo" IS NULL`.
- *Prisma's `raw()`?* **Not adopted.** The object form is read and translated; a
  `raw()` predicate is dropped whole with its reason. `.lite` has no verbatim
  predicate anywhere, and inventing one for an importer is a second spelling of a
  predicate in a language that has one.

**What it cost.** Steps 1–5 in one sitting; the importer with them rather than
after, because the corpus test is what caught (2). 21 new assertions in
`test/index-predicates.test.ts` and 8 in `example`'s `verify:employment`,
replacing the two that pinned the gap.
