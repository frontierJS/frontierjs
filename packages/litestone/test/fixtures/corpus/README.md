# The corpus — schemas nobody here wrote

`../scale/openmrp.lite` asks whether the Data realm survives **size**. These ask
whether it survives **shapes this project did not invent**.

Every file here is read mechanically out of a published schema by **`litestone
import`** — `src/import/`, the shipped readers, not a copy of them, so what this
directory regenerates is a regression fixture over the command an app runs.
That is the whole point: nothing in these was chosen by somebody who already
knew what `.lite` can say, so they hit walls a hand-written fixture never
approaches — and walls a `fli check` rule can never reach, because a rule is
written by someone who has already thought of the case.

**The `.lite` output is not the artifact. The refusal list is.** Every construct
the reading could not express is recorded in `gaps.json` with its model, its
field, and what was emitted instead — and graded `changed` / `lost` / `noted`
(`docs/import.md`), which is what makes 2,178 of them readable.

`fetch.mjs` downloads each source and runs the readers over it. `gaps.json` is
regenerated rather than tracked.

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
| **3 polymorphic candidates** | see `src/import/polymorphic.js` — reported, never resolved to `@@arc` |

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
a `Float`. The row asked for the cap to be raised and closed the other way.
Measuring the ceiling found it is **2^53** rather than int64 — the value crosses
a JS `number` at both ends — so raising the cap would have moved a silent hole
further into the dark; that half is `FJS-583`, fixed. The other half is in this
very fixture: Lago's `Fee` writes `amountCents Int` beside
`preciseAmountCents numeric(40,15)`, and `preciseCouponsAmountCents` at scale 5,
which `@scale` took cleanly. A **rate** is small-magnitude and many-placed and
nine places holds every one of the 25; a **precise accumulated total** is
big-magnitude *and* many-placed, fits no 64-bit integer at any scale, and is an
un-rounded intermediate rather than a stored quantity — which is `FJS-D154`,
allocation, and not a column type.

## Discourse — the scale ceiling, 2026-08-29

**356 models**, nearly twice `openmrp`'s 188 and with real relations rather than
a mechanical MySQL conversion. Parses in 82ms, builds in 365ms, re-boots in
116ms, zero drift. It reused the `sql` reader unchanged, which is the argument
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

## Frappe HR — payroll, and the walls a schema does not carry, 2026-08-30

**160 models**, fetched because `erpnext` no longer contains payroll: HR was
split back out into `frappe/hrms`, so the ERP port has `GLEntry` and `Employee`
and no `Salary Slip` at all. Added as phase 0 of `IDEAS/payroll.md` — read the
refusals before writing a model.

**526 unexpressed, and `0 changed`.** Nothing was silently mis-stated; the whole
list is `lost` (335) or `noted` (191), which is the grading working as intended
on a source that leans hard on framework convention.

| | |
| --- | --- |
| **323 `link-to-unknown-doctype`** | hrms is an app **on top of** ERPNext, so `Employee`, `Company` and `Account` are links to doctypes that are not in this repository. Not a language gap — a reminder that a Frappe app's schema is only ever half a schema |
| **74 `child-table-field` · 54 `frappe-child-parent`** | the same `(parenttype, parent)` open pair ERPNext uses 252 times |
| **53 `submit-workflow`** | `docstatus` 0/1/2 as a bare `Int`. A real draft → submitted → cancelled machine that `@@transitions` could carry, declared nowhere |
| **12 `select-not-an-enum` · 7 open / 2 closed polymorphic · 1 STI** | the shapes every Frappe port produces |

### What it says about payroll specifically

**The five walls are absent from the source too, and that is the finding.** A
mature payroll application's schema declares none of them:

- **Money is `Float`.** 59 float columns across the six payroll-core models —
  `grossPay`, `netPay`, `totalDeduction`, `base`, `amount`. Zero `@money`-shaped
  intent anywhere, and no scale on anything. This is the hazard `FJS-D142` exists
  for, met in the wild in the domain least able to afford it.
- **The cross-row invariant is undeclared and has an exclusion.** `SalarySlip`
  stores `grossPay`, `netPay`, `totalDeduction` and `roundedTotal` as ordinary
  columns with no stated relation to `SalaryDetail`, and the line carries
  `doNotIncludeInTotal` and `statisticalComponent` — so the real invariant is not
  *lines sum to net* but *lines that count sum to net*. Any spelling this project
  rules has to admit a predicate over the child, not just an aggregate.
- **Effective dating has a THIRD shape.** `SalaryStructureAssignment` carries
  `fromDate` and **no `toDate`** — the window is implied by the next row's start.
  `example`'s `PlanVersion` uses a nullable `effectiveTo` pair (`FJS-D164`), and
  a closed interval is a third. Evidence that the two-column window is a choice
  rather than the only shape — which is what the open question about declaring
  validity windows in the schema needs in front of it before it is answered
  (`IDEAS/payroll.md` § The rulings this will force).
- **Amend-not-edit is a plain self-relation, used 54 times.** `amendedFrom` points
  a new document at the cancelled one it replaces. That is *reversal rather than
  edit* already in the wild, and it is the nearest thing in this corpus to
  declaring **derived from** — a link, not a computation.
- **The formula is in the schema as a string.** `SalaryDetail` carries
  `condition`, `formula` and `amountBasedOnFormula`; `TaxableSalarySlab` carries
  `condition`. Frappe evaluates them as Python. That is schema-as-data, which
  `IDEAS/proving-grounds.md` § Considered declined to build and
  `IDEAS/payroll.md` § Out of scope declines again — now with the source in front
  of it rather than from memory.

**And it prices the 80/20 budget.** Of 160 models, roughly 38 are payroll proper;
the rest are recruitment, appraisal, leave, travel, expenses, shifts and
onboarding — every one of them a domain `IDEAS/payroll.md` § Out of scope names.
The plan's budget of **eight models** is measured against that 38, not invented.

## The whole corpus

1,537 models across eight applications and four front-ends, 2,929 recorded
constructs. Every one parses, builds and re-boots with zero drift.

The per-class table below is from the seven-application run of 2026-08-29 and
does not yet include `hrms`, whose classes are broken out in its own section
above. `bun test/fixtures/corpus/fetch.mjs` with no argument rewrites `gaps.json`
over every target — **naming one target rewrites the file as if the others did
not exist**, which is worth knowing before reading a total off it.

| Class | Count | Where |
| --- | --- | --- |
| partial index (`FJS-576`) | **251** | lago 105 · discourse 103 · mastodon 43 |
| wide integer (`FJS-583`) | **235** | discourse 124 · lago 64 · mastodon 38 |
| array default (`FJS-564`, shipped) | 108 | every schema |
| composite unique over nullable (`FJS-D130`, works) | 62 | every schema |
| index over an expression (`FJS-584`) | 47 | discourse · lago |
| view | 41 | lago 38 |
| polymorphic candidate | 36 | every schema |
| no primary key at all | 29 | discourse 22 |
| `@scale` over 9 (`FJS-575`, closed) | 25 | lago 20 |
| STI candidate | 24 | every schema |
| `numeric` with no precision | 15 | lago 10 |
| composite primary key (`FJS-561`) | 7 | three schemas |
| **exclusive arc found as SQL** | **5** | lago — all arity 2 |

**A partial index is the largest unrepresented construct**, and it is the one
thing every source has and `.lite` cannot say.

**A wide integer is the second, and it is the one that grades `changed`.** A
`bigint` becomes `Int` and the COLUMN is fine — SQLite's INTEGER is 64-bit too —
but the value crosses a JS `number` at both ends, so past 2^53 what is read back
is not what was written (`FJS-583`). It was graded `noted` on the claim that
*the range holds*, which measurement contradicted, and two of the four readers
did not report it at all. Keys and key references are exempt or the report is
unreadable: discourse holds 458 bigint columns and 124 are reported; lago holds
67 and 64 are, because lago declares its keys as `uuid` and its VALUES as
bigint — 61 of them `*_amount_cents`, which is money.

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

## What is committed, and the question nobody has answered

`@frontierjs/litestone` is MIT.

| Target | Upstream licence | Committed |
| --- | --- | --- |
| `triggerdev` | Apache-2.0 — permissive, attribution in the file header | **yes** |
| `discourse` | GPL-2.0 | **yes** |
| `mastodon` | AGPL-3.0 | **yes** |
| `lago` | AGPL-3.0 | **yes** |
| `erpnext` | GPL-3.0 | **yes** |
| `hrms` | GPL-3.0 | **yes** — same upstream org and licence as `erpnext` |
| `calcom` | AGPL-3.0, with a commercial `/ee` | no — fetched |
| `documenso` | AGPL-3.0 | no — fetched |
| `maidtech` | private — a legacy FJS app of this repository's own | no — **local only, and not in the tree either**: set `FJS_CORPUS_LOCAL` to the directory holding it. `fetch.mjs` has no entry and nobody else can regenerate it |

**A LOCAL fixture is read from `$FJS_CORPUS_LOCAL` and must not sit in the
tree.** A private schema kept here is a source file `.gitignore` has to hide, and
the `hygiene` CI phase fails on exactly that — correctly, because a hidden source
file is what made 20 files of Sierra's build pipeline invisible to a fresh clone.
The `generatedIgnored` allowance cannot cover it either: every entry there must
be GENERATED, and this one is converted by hand. So the fixture lives outside the
repository and the target still runs, which is the only arrangement where the
hygiene sweep stays honest and the coverage survives. The override is LOCAL only
— redirecting a committed fixture would let a green run grade bytes nobody
reviewed.

**This table used to say only `triggerdev` was committed, and four copyleft
fixtures had been added under it without the paragraph being revisited.** It is
corrected here to describe the directory rather than the intention, because a
policy statement contradicted by `git ls-files` is worse than none.

The argument that produced the original split still stands and is now unresolved
rather than applied: a schema converted from a copyleft source is plausibly a
derived work, and vendoring one into an MIT package is a licensing decision
rather than a testing one. Somebody should either take that decision or move six
files. Nothing about the test changes either way — an absent fixture is skipped
by name and `fetch.mjs` regenerates it.

Adding a target is an entry in `fetch.mjs`'s `TARGETS` and a name in
`corpus.test.ts`. Check the licence first.

See `IDEAS/proving-grounds.md` § The corpus for the argument. The product form of
the converter is no longer hypothetical: `litestone import <path> --from
prisma|rails|sql|frappe` shipped 2026-08-29 (`docs/import.md`), and it is the
code this directory runs.
