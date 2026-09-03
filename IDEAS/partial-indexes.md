---
id: partial-indexes
status: partial
dated: 2026-08-29
---

# Idea — partial indexes: `where:` on `@@index`, and the `@@unique` half deferred

**The unique half is argued separately and is BUILT** — `IDEAS/partial-unique.md`
(argued 2026-08-30, shipped 2026-08-31), which answers § *The split* and
§ *Option C* below. The short of it: this record's refusal is about a predicate
the FRAMEWORK derives, and `FJS-603` asks for one the AUTHOR declares. Read the
two together; where they disagree the later one is the reconciliation.

**Status: PARTIAL — Option A is built (2026-08-29).** `@@index([col], where:
<expr>)` parses, validates by asking the compiler, and emits; `FJS-576` and
`FJS-577` and `FJS-578` are closed. Every claim below was measured against the tree the same
day and the probes are quoted where they carry the argument.

**Two things changed on contact with the code and they are the useful part.**

The build turned up a SECOND defect under the first — `FJS-577`, the rebuild
path recreating a soft-delete model's indexes without their predicate, which is
`FJS-443`'s shape in a branch its fix did not reach. It compounds with `FJS-576`
exactly: 577 degrades the index, 576 is why nothing notices.

And § The decision was wrong about the reachable set, because there are **TWO
compilers** rather than one. The policy compiler inlines a boolean as `0`/`1`;
the query builder a caller's own `where` goes through bound it. So
`where: live == true` compiled to a literal, passed the parameter test, and was
reachable through `$scope` and never through `where: { live: true }` — the exact
silent no-op the rule exists to prevent.

That was filed as `FJS-578` and then **fixed** rather than lived with: the query
builder inlines a boolean too, which is one decision (`operandSql`) applied at
the six sites a boolean can reach. A boolean is 0 or 1 and nothing else, so there
is no escaping and no injection surface. Booleans therefore ship.

**The rule survived being wrong, which is the argument for it.** A grammar would
have had to be rewritten; asking the compiler meant the reduction grew one clause,
and the mistake was caught by a corpus count rather than by an app.

## Where the question came from

The reference corpus — 843 models, 6 applications, 803 recorded constructs —
puts **partial index at 251 instances**, the largest construct `.lite` cannot
express, by 2.3×. Discourse 103, Lago 105, Mastodon 43. Every source that has
index predicates at all has a lot of them, which is the signal: this is not one
project's habit.

**The headline overstates what a `where:` on `@@index` would cover, and by
nearly half.** Counted from `gaps.json` on 2026-08-29: **119 of the 251 are
partial UNIQUE indexes** — lago 73, discourse 32, mastodon 14 — which is exactly
the construct § *The split* refuses. The in-scope population is **132**. That
number is the one this record should be judged against, and it means the demand
the corpus actually expresses is majority *conditional uniqueness* rather than
conditional indexing — which is pressure on the refusal, not on the feature.

## Litestone already emits partial indexes

It has for as long as `@@softDelete` has existed. `createIndexes` in
[ddl.js](../packages/litestone/src/core/ddl.js) opens with

```js
const partial = softDelete ? ` WHERE "deletedAt" IS NULL` : ''
```

so **every `@@index` on a soft-deleting model is already partial**, and a second
one is emitted over `deletedAt` itself. `FJS-480` is downstream of the same
fact: a declared `@@index([deletedAt])` derives the identical name and is
refused at parse, because it compiles to exactly the index the attribute was
about to write.

This matters for sizing the gap rather than for closing it. The single most
common predicate in the corpus is `deleted_at IS NULL` / `is_deleted = false`,
and litestone gets that shape **derived, and better than a declaration could**:
the read path injects `deletedAt IS NULL` into every query, so the planner can
match the index. A declared predicate has no such guarantee — see § *Reachability*.

**Worth counting before building anything**: of the 251, how many are the
soft-delete shape? That number is already covered. The remainder is the feature.

## The split — `@@index` yes, `@@unique` deferred

**Reconciled 2026-08-30 by `IDEAS/partial-unique.md`, which recommends the
unique form.** The three reasons below stand as written about the construct they
were written about — litestone DERIVING a soft-delete predicate onto a unique
index — and the reconciliation is that a declared predicate over a domain column
is a different construct that leaves `FJS-204` untouched. The rule that keeps
both true is that the soft-delete clause is ANDed into a declared `@@index`
predicate and must NOT be ANDed into a declared `@@unique` one.

Three reasons, and they compound.

**A partial unique index reopens `FJS-204`, which is ruled.** The ruling (2026-08-15,
`DECISIONS.md` § Query & write semantics) is that a soft-deleted row *keeps* its
`@unique` slot, and the rejected alternative was precisely a partial unique index
freeing it, because that makes `@unique` false for any read that includes deleted
rows: `findUnique({ withDeleted: true })` legitimately matches two, and every
export, audit query and migration reading with deleted rows sees duplicates on a
column declared unique. It also makes `restore()` conditionally impossible, which
is soft delete's whole contract. The parser carries the argument in a comment
beside the nullable-composite check. Growing `@@unique(..., where:)` gives two
answers to *is this column unique*, and they disagree — Invariant 4's shape.

**It is not where the emitter puts a `@@unique` anyway.** Unique constraints are
emitted inside `CREATE TABLE` as `UNIQUE (cols)`, not as standalone indexes.
A predicate cannot ride a table constraint, so every model carrying one would
have to move to a separate `CREATE UNIQUE INDEX` — a table rebuild for a feature
whose value is a slot-freeing behaviour the project already refused.

**The asymmetry is what makes the index half safe.** A wrong predicate on a plain
index costs a table scan. A wrong predicate on a unique index costs a duplicate
row. Keeping `@@unique` out is what lets the whole feature be fail-safe by
construction, which is the property that decides whether a check has to be
exhaustive before it ships.

`FJS-D130`'s `nullsDistinct: true` stays the answer for conditional uniqueness
over nullable columns, and it is a better one: it says the same thing
declaratively without making the constraint conditional on the reader.

## Shape

```lite
model Note {
  id        Int       @id @default(autoincrement())
  status    String
  kind      String
  archivedAt DateTime?

  @@index([kind], where: archivedAt == null)
  @@index([assigneeId, createdAt], where: status == "pending")
}
```

`where:` is a named argument, matching `@@unique([a, b], nullsDistinct: true)`.

**Restricted grammar, emitted as SQL — not verbatim SQL.** `@@check` takes the
author's SQL straight through, and the temptation is to copy that, because it is
the cheapest thing that works. Three things argue against it here.

The migrator compares `CHECK` text and that comparison is exact *because both
sides are this emitter's own output* — the emitter's own comment says so. A
verbatim predicate keeps that property, so this is not the deciding reason.

The deciding reason is that a predicate litestone has *parsed* can be refused
with a sentence. `now()` is non-deterministic and SQLite refuses it in an index
predicate; so is a subquery, a correlated column, and `auth()` — which is not a
Data-boundary concept at all here. Each of those is a failure that either lands
as SQLite's message about a physical index, or lands at boot in production
rather than at parse. And a parsed predicate has a structured form the
reachability check needs (§ below), where a string does not.

Proposed grammar, and nothing else: a column of this model, a literal, `==`
`!=` `<` `<=` `>` `>=` `in`, `null` comparison, joined by `&&` / `||`. Same
surface as a `@@allow` predicate minus everything that reaches outside the row.

## Cost 1 — the migrator is blind to index predicates, today

**Measured.** `introspect` reads `sqlite_master` and keeps `{name, cols, unique}`
for each index. The `WHERE` tail is dropped on the floor. So two databases
holding genuinely different indexes diff as identical:

```
hasChanges: false
tableDiffs: []

what SQLite actually holds:
 pristine: CREATE INDEX "idx_note_status" ON "note" ("status") WHERE "deletedAt" IS NULL
 live    : CREATE INDEX "idx_note_status" ON "note" ("status")
```

This is **not only a cost of the proposed feature — it is a defect in the tree
now**, because the derived partial index already exists. An existing model that
gains `@@softDelete` keeps its full index while the schema says partial:

```
before: CREATE INDEX "idx_note_status" ON "note" ("status")
after : CREATE INDEX "idx_note_status" ON "note" ("status")
VERDICT: FULL — stale index survives, schema says partial
```

`db push` and `migrate apply` therefore build different databases — the class
`FJS-443` and `FJS-D123` are about, arrived at from a different direction.
Filed as **`FJS-576`**. Severity is bounded by the same asymmetry as above: an
index predicate never changes which rows a query returns, only which index the
planner may use, so the whole blast radius is speed and drift. It becomes
load-bearing the moment a predicate is author-written, because then an edit to
it silently does not apply.

**The repair is small and the technique is already load-bearing here.** Capture
the `WHERE` tail in `introspect` and compare it as text, exactly as `parseChecks`
already does for `CHECK` — both sides being litestone's own emit is what makes a
string comparison exact. It belongs in the same change as the feature, and
arguably before it.

## Cost 2 — reachability, and this is the real one

A partial index is used only when the planner can prove the query's predicate
implies the index's, and it must prove it **at prepare time**. That is a sharper
constraint than *does the caller restate the predicate*, and it decides the
feature.

**Litestone parameterises every value-carrying filter.** A `$scope` compiles to
a bound parameter — measured through a real client:

```
db.note.findMany({ where: { $scope: 'pending', kind: 'k3' } })
  → SELECT * FROM "note" WHERE "kind" = ? AND ("status" = ?)
```

and SQLite cannot match `status = ?` against an index predicate of
`status = 'pending'`, because at prepare time it does not know what `?` holds:

```
literal predicate                : SEARCH note USING COVERING INDEX idx_pending
bound parameter (what litestone  : SCAN note
  actually emits)
bound column, literal predicate  : SEARCH note USING COVERING INDEX idx_pending
```

**So restating the predicate does not help** — a caller's restatement is
parameterised too. The reachable set is decided by the emitter, never by the
caller, which also disposes of the `@@scope` alternative in its naive form.

**Why the derived soft-delete index escapes this**, and it is not a general
property but luck about one operator: `IS NULL` carries no value to bind, so
litestone emits it as literal SQL.

```
db.note.findMany({ where: { kind: 'k1' } })     // model has @@softDelete
  → SELECT * FROM "note" WHERE ("deletedAt" IS NULL AND "kind" = ?)
```

That literal is the entire reason the index is reachable.

**The rule this leaves.** A partial index is reachable only where litestone
emits its predicate as literal SQL, which today is null tests and nothing else.
A `where:` admitting value comparisons ships an index that is bytes on disk,
maintained on every write, matched by nothing, with no error, no warning and a
green suite — **unless the query compiler is taught to inline schema-authored
literals**. That inlining is safe on Invariant 8's terms, since the literal comes
from the schema and never from a caller, but it is a change in the hot path of
query compilation and it is a separate decision from this one.

Counted against the corpus, the split is the whole sizing. Of the **132 in-scope
plain** partial indexes (the other 119 of the 251 are unique, § above):

| | count | share | |
| --- | --- | --- | --- |
| null tests only | 90 | 68% | **ships** |
| boolean | 7 | 5% | **ships** (`FJS-578` closed) |
| truncated in `gaps.json` | 24 | 18% | unclassified |
| carries a value | 11 | 8% | needs the inlining (Option B) |

So the built feature answers **97 of 132 (73%)** as measured, and that is the
honest headline rather than the 251 the corpus summary leads with.

## What the corpus says about the refusal

`FJS-204` is ruled and this record does not reopen it. But the count belongs on
the record rather than in a footnote: **119 of the 251 partial indexes in the
corpus are unique ones**, and the canonical shape is
`unique (email) where deleted_at is null` — uniqueness among live rows. The
corpus README already notes that such an index is dropped rather than emitted,
because emitting it whole would be a stronger constraint than the source
declares.

So the honest summary is that the corpus is asking for the thing that was
refused, and the reasons for the refusal are unchanged by the count. What the
count does change is the sizing of this record: a `where:` on `@@index` answers
132 instances, not 251, and whoever reads *largest unrepresented construct by
2.3×* should not read it as *and this feature covers it*.

## The decision — which predicates `where:` may hold

Reachability (§ Cost 2) is not a grammar question, and that is what makes this
smaller than it looked. `compileSql`'s `literal` branch already inlines three
values and binds everything else:

```js
case 'literal':
  if (node.value === null)  return 'NULL'
  if (node.value === true)  return '1'
  if (node.value === false) return '0'
  params.push(node.value)
  return '?'
```

So the reachable set has a definition that needs no whitelist: **a predicate is
reachable exactly when compiling it pushes no parameters.** Compile it with the
compiler that already exists, and refuse when `params.length > 0`. The rule is
enforced by the same code that would violate it, so it cannot drift, and
relaxing it later is backward-compatible — schemas that were refused start
working, none break.

Counted against the corpus's 132 in-scope plain partial indexes: **97 (73%) are
reachable today** — null tests, booleans, and their conjunctions — **11 (8%)
need literal inlining** (`status = 2`, `post_number > 1`, an `IN` list), and 24
are truncated in `gaps.json`. Mastodon 26/29, discourse 50/71, lago 21/32.

### Option A — no bound value (recommended)

*Accept any predicate that compiles to zero parameters; refuse the rest at parse.*

| | |
| --- | --- |
| **for** | Covers 97 of 132 with **no change to query compilation at all**. Every index it emits is provably reachable — not checked, *constructed*. The rule is self-enforcing, so it cannot rot. No advise rule needed for the shipped subset, which removes the one open-ended cost this record started with. Effort S, and most of it is `FJS-576`. |
| **against** | Refuses a predicate an author converting a real schema will write, and the refusal has to explain a *planner* fact — *this binds a value, so SQLite cannot match the index at prepare time* — which reads as arbitrary until understood. It is also a language rule derived from an **implementation** detail: what litestone happens to bind. That coupling is the honest cost, mitigated by the rule being executed rather than written down, and by relaxation being backward-compatible. Answers none of the unique half. |

### Option B — full predicates, with literal inlining

*Also accept value comparisons, and teach the compiler to inline schema-authored
literals so they stay reachable.*

| | |
| --- | --- |
| **for** | Covers the remaining 11 known instances and probably most of the 24 truncated. The change is one branch — `compileSql`'s `literal` case behind a flag — and Invariant 8 is untouched, because the literal comes from the schema and never from a caller. Plan-cache pressure is nil: schema literals are fixed at parse. |
| **against** | Eight per cent of the corpus for a change in the hot path of every policy and scope query. It needs string escaping for schema-authored strings, and a decision about *scope*: inline everywhere (which rewrites the SQL text of every policy query in every app, for this) or only for index-backed predicates (which means the compiler must know which scope backs which index — new coupling). Reintroduces the advise rule, because a predicate can now be written that is reachable in principle and matched by nothing in practice. |

### Option C — settle `FJS-204` first

**Taken up: `IDEAS/partial-unique.md`.**

*Decide whether partial UNIQUE is back on the table before spending on the rest.*

| | |
| --- | --- |
| **for** | 119 of the 251 are unique. The corpus is mostly asking for the refused construct, and if the ruling ever moves, the syntax should be designed for both at once rather than retrofitted onto an `@@index`-only feature. |
| **against** | The reasons for the refusal are unchanged by the count — `findUnique({ withDeleted: true })` still legitimately matches two, `restore()` is still conditionally impossible. New information about *demand* is not new information about *correctness*. It also blocks a cheap, provably-correct 73% win on a hard question that can be asked at any time. |

### Option D — ship nothing

| | |
| --- | --- |
| **for** | Zero cost. The derived soft-delete index already covers the corpus's single commonest predicate, and covers it reachably. |
| **against** | 97 instances the corpus asks for, expressible in a rule of one sentence, over machinery that already exists. And `FJS-576` needs fixing either way. |

**Recommended: A**, with B as a later relaxation of one predicate and C asked on
its own merits whenever somebody wants to. A is the only option whose
correctness is structural rather than checked, and it is the only one that
leaves both of the others open without prejudice.

## What it does not cost

- **`release:check`** — an index is always *expand*. Added, dropped, or with an
  edited predicate, N-1 keeps serving. This is entirely a consequence of leaving
  `@@unique` out; a partial unique would have been a contract.

  Measured after shipping: the release surface keys an index on its **column
  list alone** (`release.js`, `m.indexes`), so a predicate appears in neither the
  rendering nor the comparison. Edit one and `ddl.snapshot.sql` moves while
  `release.snapshot.md` does not. The verdict stays correct, because the verdict
  does not depend on the predicate — so this is an artefact that is less
  informative than the DDL beside it, and not a misclassification. **It becomes a
  correctness hole the day Option C ships**: on a UNIQUE index the predicate IS
  the constraint, and narrowing one is a contract that a column-list diff cannot
  see. Anyone taking C on has to carry the predicate into `m.indexes`/`m.uniques`
  first.
- **Access and policy** — an index is physical. Nothing to grade, nothing in
  `access.snapshot.md`, no interaction with gates, row policies or tenancy.
- **Correctness** — see the asymmetry above. Worst case is a scan.
- **The client** — no JSON Schema key, no `x-` field, nothing crosses to the
  browser. An index is invisible above the Data boundary.

## Build order

1. **`FJS-576` first** — capture and compare the `WHERE` tail in `introspect`.
   It stands alone, fixes a live drift, and without it step 2 ships a
   declaration that cannot be edited.
2. **Parse `where:` on `@@index`**, restricted grammar, refusing `now()`,
   `auth()`, subqueries and foreign columns by name at parse.
3. **Emit**, which is a one-line change — `createIndexes` already interpolates a
   `partial` suffix; it stops being derived-only and takes the declared
   predicate where there is one. Interaction with the soft-delete predicate has
   to be decided: `AND` them, or refuse the pair. **`AND` them** — the soft-delete
   clause is what makes the index reachable at all on such a model, and dropping
   it to honour a declaration would silently un-optimise every existing read.
4. **The advise rule**, before this is documented as a feature anybody should use.
5. `ddl.snapshot.sql` and `jsonschema.snapshot.md` regenerate; the `snapshots`
   CI phase catches any surface this touches that was not predicted.

Effort: S for 1–3, S for 4. The expensive part is step 4's judgement, not its code.

## What declares one in this repo

`example`'s `ProductVariant` — the only `where:` outside the corpus, added
2026-08-29:

```
@@index([productId], where: active == true)
```

The storefront reads `{ productId, active: true }` on the product page, the buy
box and the catalogue, once per product at prerender. It is here rather than in a
fixture because three things can only be proven in an app: the migrator adding a
partial index to a database that already holds rows, the predicate ANDing with
`@@softDelete`'s own clause (`WHERE ("deletedAt" IS NULL) AND ("active" = 1)`),
and the planner reaching it through a query where the caller wrote **half** the
predicate and litestone injected the other half.

Measured on the seeded shop, with the four ways to miss it as the control:

```
both conjuncts (the real query)   SEARCH ... USING INDEX idx_product_variant_productId
no active  -> cannot prove        SEARCH ... USING INDEX sqlite_autoindex_product_variant_3
no deletedAt -> cannot prove      SEARCH ... USING INDEX sqlite_autoindex_product_variant_3
active = 0 -> contradicts         SEARCH ... USING INDEX sqlite_autoindex_product_variant_3
active = ? -> bound, unprovable   SEARCH ... USING INDEX sqlite_autoindex_product_variant_3
```

The last row is `FJS-578` seen from the app: before the query builder inlined
booleans, the storefront's own filter emitted `"active" = ?` and would have
missed the index it had just declared, with nothing anywhere reporting it.

## Open questions

- **Does an index predicate belong in `@@index` at all, or is the honest answer
  a `@@scope` the reads already carry?** A named scope is a predicate litestone
  *knows* callers use, which is the exact thing missing in § Reachability. If a
  declared partial index were expressed as *index this scope*, reachability
  would be a property of the design rather than a check bolted beside it. This
  is the strongest unexplored alternative and it should be priced before step 2.
  `IDEAS/scoped-sql.md` and `IDEAS/schema-variants.md` § the generated partial
  index are adjacent.
- ~~Does `introspect`'s column parse survive a predicate containing
  parentheses?~~ **Answered, and it did not.** `indexOf('(')` found the bracket
  inside a QUOTED table name before it found the column list, and the corpus's
  **47 expression indexes** broke the same function for a second reason. Both are
  `FJS-586`, closed: the parse steps over the table name, counts depth, and an
  expression member is reported rather than emitted as a column that does not
  exist. `parseIndexColumns` is one owner for all three readers now.
- Prior art in the JS ecosystem is worth one pass for the argument's sake, not
  for the design's — checked as a lead, not stated as a fact here.

## See also

- `DECISIONS.md` § Query & write semantics — `FJS-204`, the soft-delete slot
- `ISSUES.md` — `FJS-576` (the migrator blindness), `FJS-480` (the derived index)
- [ddl.js `createIndexes`](../packages/litestone/src/core/ddl.js) ·
  [migrate.js `introspect`](../packages/litestone/src/core/migrate.js)
- `IDEAS/schema-variants.md`, `IDEAS/scoped-sql.md`
