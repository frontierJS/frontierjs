---
id: partial-indexes
status: idea
dated: 2026-08-29
---

# Idea — partial indexes: `where:` on `@@index`, and why `@@unique` must not have one

**Status: IDEA.** Every claim below was measured against the tree on 2026-08-29;
the probes are quoted where they carry the argument. What is proposed is a
`where:` argument on `@@index` alone, a refusal on `@@unique`, and one repair
the feature needs and the tree needs anyway (`FJS-576`).

## Where the question came from

The reference corpus — 843 models, 6 applications, 803 recorded constructs —
puts **partial index at 251 instances**, the largest construct `.lite` cannot
express, by 2.3×. Discourse 103, Lago 105, Mastodon 43. Every source that has
index predicates at all has a lot of them, which is the signal: this is not one
project's habit.

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

## The split — `@@index` yes, `@@unique` no

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
implies the index's. Litestone's query builder knows nothing about a predicate
the app declared, so it never adds it. **Measured**, one table, two indexes,
5000 rows, `ANALYZE` run:

```
A litestone read (soft-delete predicate injected automatically):
   SEARCH note USING INDEX idx_soft (status=?)

Same read WITHOUT the injected predicate:
   SCAN note

App-declared partial — caller states the predicate:
   SEARCH note USING INDEX idx_app (kind=?)

App-declared partial — caller does NOT state it (the ordinary case):
   SCAN note
```

That is the whole risk in four lines. The derived soft-delete index works
because litestone injects its predicate on every read. A declared one works only
when the caller happens to restate it, and the ordinary case is that they do
not — at which point the index is bytes on disk, maintained on every write,
matched by nothing, with no error, no warning, and a green suite.

**A feature that silently no-ops is worse than an absent one**, so this half is
not optional. Two candidate answers:

- **An advise rule.** [opportunities.js](../packages/litestone/src/core/opportunities.js)
  and [advise.js](../packages/litestone/src/core/advise.js) already exist to say
  *your schema declares X and nothing uses it*. A declared predicate in
  structured form gives the columns it names; a rule can report a partial index
  no query in the app can match. Approximate, cheap, and in the right package.
- **`EXPLAIN QUERY PLAN` in a check.** Exact for the queries it is given, and it
  needs a corpus of the app's real queries to be given — which the Testing realm
  has and the schema does not.

Start with the first. It is the same shape as `FJS-480`'s refusal — telling an
author the line they wrote buys nothing.

## What it does not cost

- **`release:check`** — an index is always *expand*. Added, dropped, or with an
  edited predicate, N-1 keeps serving. This is entirely a consequence of leaving
  `@@unique` out; a partial unique would have been a contract.
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

## Open questions

- **Does an index predicate belong in `@@index` at all, or is the honest answer
  a `@@scope` the reads already carry?** A named scope is a predicate litestone
  *knows* callers use, which is the exact thing missing in § Reachability. If a
  declared partial index were expressed as *index this scope*, reachability
  would be a property of the design rather than a check bolted beside it. This
  is the strongest unexplored alternative and it should be priced before step 2.
  `IDEAS/scoped-sql.md` and `IDEAS/schema-variants.md` § the generated partial
  index are adjacent.
- Does `introspect`'s column parse survive a predicate containing parentheses?
  It takes the first parenthesised group, which is the column list, so it should
  — but the corpus also has **47 indexes over an expression**, where that parse
  breaks for a different reason. Separate gap, same function.
- Prior art in the JS ecosystem is worth one pass for the argument's sake, not
  for the design's — checked as a lead, not stated as a fact here.

## See also

- `DECISIONS.md` § Query & write semantics — `FJS-204`, the soft-delete slot
- `ISSUES.md` — `FJS-576` (the migrator blindness), `FJS-480` (the derived index)
- [ddl.js `createIndexes`](../packages/litestone/src/core/ddl.js) ·
  [migrate.js `introspect`](../packages/litestone/src/core/migrate.js)
- `IDEAS/schema-variants.md`, `IDEAS/scoped-sql.md`
