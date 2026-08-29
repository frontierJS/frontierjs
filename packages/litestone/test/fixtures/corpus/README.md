# The corpus — schemas nobody here wrote

`../scale/openmrp.lite` asks whether the Data realm survives **size**. These ask
whether it survives **shapes this project did not invent**.

Every file here is converted mechanically from a published schema — Prisma by
`prisma-to-lite.mjs`, Rails `db/schema.rb` by `rails-to-lite.mjs`, a PostgreSQL
dump by `sql-to-lite.mjs`, Frappe DocType JSON by `frappe-to-lite.mjs`. That is the whole point: nothing in them was chosen by
somebody who already knew what `.lite` can say, so they hit walls a hand-written
fixture never approaches — and walls a `fli check` rule can never reach, because
a rule is written by someone who has already thought of the case.

**The `.lite` output is not the artifact. The refusal list is.** Every construct
the conversion could not express is recorded in `gaps.json` with its model, its
field, and what was emitted instead.

## What it found on its first run, 2026-08-29

| | |
| --- | --- |
| `FJS-563` | the non-owning side of a one-to-one must be labelled, and unlabelled it reports `unknown type 'B'` for a model it has registered — 37 occurrences across three schemas, and the single cause of every `unknown type` error in all of them |
| `FJS-564` | an array column is expressible and its default is not, `@default([])` included — 11 occurrences |
| `FJS-561` | no composite primary key — 7, plus 4 models with no primary key at all |
| `FJS-D130` | **working as ruled**: 22 composite `@@unique` over a nullable column, every one of them answered by `nullsDistinct: true` |
| `FJS-571` | `singularize` never reached a compound's head, so `user_statuses` read back as `user_statuse` — found needing model names for Rails tables |

## What the Rails front-end added, 2026-08-29

Three Prisma schemas largely agree with each other. Mastodon disagrees, which is
the only reason to add a second front-end — and it arrived carrying two
constructs Prisma cannot express and one it can:

| | |
| --- | --- |
| **43 partial indexes** | `unique … where: "deleted_at IS NULL"` is uniqueness among LIVE rows. `.lite` cannot say it, and a **unique** one is therefore DROPPED rather than emitted whole — emitting it would be a stronger constraint than the source declares |
| **1 single-table inheritance** | a string `type` column partitioning one table across several classes. No spelling; the column is emitted as an ordinary String and the partition is lost |
| **3 polymorphic candidates** | see `polymorphic.mjs` — reported, never resolved to `@@arc` |

Rails also inverts one default that matters: **a column is nullable unless
`null: false`**, the opposite of `.lite`, so every conversion decides optionality
per column rather than inheriting it.

## What the SQL front-end added — Lago, 2026-08-29

A `structure.sql` is the only source carrying **CHECK constraints, views and
native enums**, so it is the first input `.lite`'s own `@@check` and `@@arc` have
ever had that somebody else wrote. 139 models, and both surfaces took it:

```
CHECK ((invoice_grace_period >= 0))                    →  @@check("(invoiceGracePeriod >= 0)")
CHECK ((plan_id IS NOT NULL) <> (subscription_id …))   →  @@arc([planId, subscriptionId])
                                                       →  CHECK (("planId" IS NOT NULL) + ("subscriptionId" IS NOT NULL) = 1)
```

and a raw `INSERT` with neither arc member set is refused by SQLite. 17 `@@check`
and 5 `@@arc` emitted, 8 checks dropped as genuinely inexpressible
(`jsonb_typeof`, `cardinality`, the `~` regex operator, a `::text` cast on a
column).

**All five arcs are arity 2** — `plan XOR subscription`, `feature XOR privilege`,
`subscription XOR wallet` — which is the first real-world evidence about
`@@arc`'s ceiling: production billing writes exclusive arcs, writes them small,
and writes them as hand-rolled SQL because it has nothing better to say.

It also produced `FJS-575`: **20 columns are `numeric(40, 15)`** and `@scale`
stops at 9, so every per-unit rate in a real usage-based billing schema lands as
a `Float`. The 9 is not arbitrary — a minor-unit integer in a 64-bit INTEGER has
about four digits left in front of the point at 15 places — so it is a shape
question rather than a limit to raise, and it is the first thing the billing work
will hit.

## Discourse — the scale ceiling, 2026-08-29

**356 models**, nearly twice `openmrp`'s 188 and with real relations rather than
a mechanical MySQL conversion. Parses in 82ms, builds in 365ms, re-boots in
116ms, zero drift. It reused `sql-to-lite.mjs` unchanged, which is the argument
for a front-end paying for itself across targets.

**15 polymorphic pairs, and these are the unambiguous ones** — `bookmarkable`,
`chatable`, `votable`, `linkable`, `assigned_to`. The Rails `-able` suffix is the
idiom for *anything that can be X'd*, which is weak evidence for an OPEN target
set and therefore for the `(subjectType, subjectId)` shape rather than `@@arc`.
Weak evidence, not a finding: the set still lives in Ruby, not in the schema.

Two column types earned names of their own rather than being lumped into
*unknown*: **`tsvector`**, where `.lite`'s answer is `@@fts` — a different engine
on a different table, so a replacement the author makes and never a conversion —
and **`halfvec`** (pgvector embeddings), where `.lite` has no type and no index
that would make one useful.

## The whole corpus

843 models across six applications and three front-ends, 803 recorded
constructs. Every one parses, builds and re-boots with zero drift.

| Class | Count | Where |
| --- | --- | --- |
| partial index | **251** | discourse 103 · lago 105 · mastodon 43 |
| array default (`FJS-564`) | 108 | every schema |
| composite unique over nullable (`FJS-D130`, works) | 62 | every schema |
| index over an expression | 47 | discourse · lago |
| view | 41 | lago 38 |
| polymorphic candidate | 35 | every schema |
| STI candidate | 21 | every schema |
| `@scale` over 9 (`FJS-575`) | 25 | lago 20 |
| composite primary key (`FJS-561`) | 7 | three schemas |
| **exclusive arc found as SQL** | **5** | lago — all arity 2 |

**A partial index is now the largest unrepresented construct in the corpus by
2.3×**, and it is the one thing every source has and `.lite` cannot say.

## ERPNext — and a declared answer to the `@@arc` question, 2026-08-29

**534 models**, the new scale ceiling: parses in 248ms, builds in 732ms,
re-boots in 470ms, zero drift. It arrives as a tarball of one JSON per doctype
rather than a file, so `fetch.mjs` extracts it and hands the reader parsed
documents; `tar` has to be on PATH.

**It is the only source in this corpus where the schema says whether a
polymorphic target set is CLOSED.** A Frappe `Dynamic Link` names the field
holding its target doctype, and that controlling field answers the question
directly — a `Select` with N options is a closed set of N, a `Link` to `DocType`
is open. So the boundary `references/Tag.lite` leaves to the author is, here, a
fact in the file:

```
78 declared polymorphic fields
  61  OPEN    (78%)  — controlling field is a Link to DocType
  17  CLOSED  (22%)  — controlling field is a Select

closed-set arity:   2 ×1   3 ×7   4 ×4   5 ×1   6 ×2   7 ×1   16 ×1
                    ^^^^^^^^^^^^^^^^^^^^^^^^^ 15 of 17 inside @@arc's ceiling
```

**Both halves of the taxonomy come out right, and they say different things.**
Where a set is closed it is *small* — three is the mode, and 15 of 17 fit inside
`@@arc`. That matches Lago from the other direction, where all five arcs found as
hand-rolled SQL were arity 2. But **open is the common case at 78%**, so `@@arc`
serves the minority and the `(subjectType, subjectId)` pair serves the majority —
which means case 3's stated cost, *something has to sweep attachments whose
subject is gone*, is the cost most applications actually pay, and the sweep is
the half worth making cheaper.

Two more shapes it carries: every child table is addressed by
`(parenttype, parent)`, so the framework itself uses an open pair 252 times; and
84 doctypes are submittable, a real draft → submitted → cancelled machine that
`@@transitions` could carry but which is a framework convention rather than
anything this file declares.

### An observation that would not reduce

Twice — Documenso and Mastodon — a converted schema that produced a **duplicate
`CREATE INDEX`** (two source indexes made identical once a predicate or an
opclass was stripped) failed to build against a **file** database while the same
schema built clean in `:memory:`. It does not reproduce at two models on either
target, so it is recorded here as a lead rather than filed. To see it again,
disable the `index-collapsed` dedupe in either reader and build a full fixture.
Both readers now dedupe, which is correct independently of whatever this is.

Three things the first run reported were **the converter's own bugs**, not the
language's, and each was withdrawn after being probed at minimum size:
referential actions (`onDelete`/`onUpdate` are supported — 348 false gaps), a
duplicate index that came from stripping an opclass, and a `:memory:`-against-file
divergence that would not reproduce. A parser refusing a name is evidence about
the name; probe the neighbourhood before writing anything down.

## Running it

```bash
bun test test/corpus.test.ts               # parse · build · re-boot migrates nothing
bun test/fixtures/corpus/fetch.mjs         # refresh every target, rewrite gaps.json
bun test/fixtures/corpus/fetch.mjs calcom  # just one
```

An absent fixture is **skipped by name**, never silently not run.

## Why only one is committed

`@frontierjs/litestone` is MIT.

| Target | Upstream licence | Committed |
| --- | --- | --- |
| `triggerdev` | Apache-2.0 — permissive, attribution in the file header | **yes** |
| `calcom` | AGPL-3.0, with a commercial `/ee` | no — fetched |
| `documenso` | AGPL-3.0 | no — fetched |

A schema converted from a copyleft source is plausibly a derived work, and
vendoring one into an MIT package is a licensing decision rather than a testing
one. Until somebody makes it deliberately, those two are fetched on demand and
git-ignored. Nothing about the test changes if that ruling goes the other way —
drop the files in and they run.

Adding a target is an entry in `fetch.mjs`'s `TARGETS` and a name in
`corpus.test.ts`. Check the licence first.

See `IDEAS/proving-grounds.md` § The corpus for the argument, and for the product
form of the converter — `litestone import --from prisma`, which does not exist.
