---
id: effective-time
status: proposed
dated: 2026-09-22
---

# Idea — a row that stops counting: one declaration for expiry, for validity, and for the clock that decides both

**Status: IDEA. Nothing here is built.** Dated 2026-09-22. Every number and
every file reference under § 1 was read off the tree on that date. Do not cite
this file as describing behavior — see `VERIFYING.md`.

It came out of asking whether three of the eight gaps in the `.lite` language
survey are three designs or one:

> **07** a thing that must happen later · **03** valid time · **08** zoned wall clock

They are two and a half. **03 and 07 are one mechanism at two arities**, and
**08 supplies a value the other two consume**. What makes that worth settling
in one place rather than three is not tidiness — it is that shipping 07 alone
commits the language to a BOOLEAN where a VALUE belongs, in a directive family
where a boolean has never yet been walked back.

`overview.md` row 4.21 already said so, before this paper existed:

> Settle **with** 4.15's bitemporality or one will invent a vocabulary the
> other must live with.

---

## 1. The evidence — six instances of one idea, zero declarations

| Kind | Where | How it is done today |
| --- | --- | --- |
| **Deadline** — one column, the row stops counting | `StockReservation.expiresAt` · `Invitation.expiresAt` · `ApiKey.expiresAt` · `KvEntry.expiresAt` (orion) · `Job.nextRunAt` | hand-written `expiresAt: { gt: nowIso() }` in each read that remembers |
| **Validity window with one open row** | `PlanVersion` · `PayWindow` · `PayRate` | **the same four-part idiom, hand-rolled three times** |
| **Validity window checked in JS** | `Discount.startsAt` / `endsAt` | a fifth implementation, in a service, producing sentences |
| **A described interval** — NOT this | `Invoice` · `InvoiceLine` · `PayRun` · `Payslip` `periodStart`/`periodEnd` | correctly undeclared. See § 2 |

**The window idiom is four facts and every instance writes all four by hand:**
an `effectiveFrom`, a nullable `effectiveTo`, `@immutable` on the from column,
and `@@unique([parentId], where: effectiveTo == null)` for *at most one open
row*. `example/db/schema.lite` carries a comment at the third one saying it *was
met here* — the idiom was rediscovered, not reused.

**Shape 1 is filtered by hand and the discipline is ungraded.** Every read of
`StockReservation`, graded:

| `example/api/src/domain/shop/inventory.ts` | filters | verdict |
| --- | --- | --- |
| `:138` availability `groupBy` | `expiresAt: { gt: nowIso() }` | the correctness-critical one |
| `:230` `heldUntil` | same | correct |
| `:380` `releaseExpired` | `lte: before` | deliberately inverted |
| `:206` `hold()` `findFirst` | **none** | correct — it revives the dead row on purpose |
| `:221` `release()` | **none** | correct — a purge takes them all |

**No live defect, and that is the finding.** A `fli check` rule saying *every
read must filter* would find nothing here and fire twice wrongly. **A lint is
not the answer; an automatic filter is** — because under one the two unfiltered
reads become `withExpired: true` and their intent stops being invisible.

**The clock the filter reads is not the framework's.**
`inventory.ts:91` is `const nowIso = () => new Date().toISOString()`. So
`env.clock.advance()` moves nothing, and shape 1's entire correctness condition
— *a hold is dead the instant it passes, whether or not the job ran* — **is not
tested and cannot be**. `example/web/test/verify-stock.mjs:232` shows the cost:
unable to move time, it moves the CUTOFF, passing `before: '2099-01-01'` to the
sweep. That proves the job deletes rows. It does not touch the read.

**One instance is already a filed defect.** `Job.nextRunAt` is the fourth shape
— a commitment a person can SEE — implemented by writing `now + 60s` once on
create and never again, and rendering it as *Next run*
([`FJS-1241`](../ISSUES.md#fjs-1241)).

---

## 2. What this must never sweep up

`Invoice`, `InvoiceLine`, `PayRun` and `Payslip` carry `periodStart` /
`periodEnd`. They are spelled almost identically to a validity window and they
are **not one**: they are `@immutable` facts copied onto a document, describing
the period the document covers. Nobody asks *as at now* of them.

**A declaration that auto-filtered those would silently break payroll** — a
payslip vanishing from a read because its period ended. So:

- the declaration is **opt-in per model**, never inferred from column names;
- it is named for *the row stops counting*, never for *these two columns are
  dates*;
- and nothing may ever grow a rule that guesses it from a naming convention.

This is the single largest risk in treating the three gaps together, and it is
also the reason to: a one-gap write-up would not have had to think about it,
and would have been free to get it wrong later.

---

## 3. Why 03 and 07 are one design

`expiresAt > now` is the **one-sided case** of
`effectiveFrom <= now AND (effectiveTo IS NULL OR effectiveTo > now)`. Same
filter, same opt-out, same clock, same structure `@@softDelete` and
`@@hasTemplates` already have — *a row that does not count is out of every read
unless you ask for it*.

**The load-bearing argument is the directive, not the filter.**
`@frontierjs/toolbelt/directives` holds one row per directive (Invariant 10),
and its four opt-back-in directives are all booleans:

```
{ param: '$withDeleted',   name: 'withDeleted',   read: asBool },
{ param: '$onlyDeleted',   name: 'onlyDeleted',   read: asBool },
{ param: '$withTemplates', name: 'withTemplates', read: asBool },
{ param: '$onlyTemplates', name: 'onlyTemplates', read: asBool },
```

Expiry alone needs only a fifth boolean. **Valid time needs a VALUE** — *as the
world stood on 2024-06-01* — and a value cannot be retrofitted onto a flag
without the language carrying two directive families for one idea, permanently.
`withDeleted` is the precedent for how immovable a flag becomes once an app
writes it into a URL.

So the general form is `asOf: <instant>`, and every flag is sugar over it:

| directive | means |
| --- | --- |
| `asOf: <instant>` | the rows in force at that instant |
| *(unstated)* | `asOf: now` — the default, and what every read gets free |
| `withExpired` | no window filter at all |
| `onlyExpired` | only the rows NOT in force now |

`asOf` is SQL:2011's own word (`FOR BUSINESS_TIME AS OF`), kept by SQL Server
and MariaDB. It would be the first value-shaped member of that directive
family, which is exactly why it has to be designed before the family grows a
fifth flag.

---

## 4. Why 08 composes and does not merge

`FJS-D143` already ruled the zone, and the word it chose is the tell:

> a zoned comparison is **a window the framework binds** and never a predicate
> SQLite evaluates

The window's edge IS `asOf`. `datetime('now','America/New_York')` answers
**NULL** in SQLite — not an error — so a zoned comparison can only ever be a
value the framework computes and binds, which is the same thing `asOf` is.

So gap 08 is **a parameter of this design, not a fourth gap folded into it**,
and its three answers already have homes (`FJS-D143`): the row's zone is a
sibling column, the viewer's is a claim on the principal, the tenant's is
`$.config` (`FJS-D126`). What is left to say is *which, per model*.

**Build 03/07 against a hardcoded UTC `now()` and you hardcode the second value
too** — the same mistake as the boolean, one dimension over. Every sweep in
`example` already dodges this by running HOURLY rather than daily, which is
right for a day-granular period and never reaches *09:00 in the customer's
zone*.

---

## 5. The shape of the declaration

**One word, two arities.** A second word for the one-sided case would be a
second name for one thing, which the evolution policy refuses:

```
model StockReservation {
  expiresAt DateTime
  @@effective(to: expiresAt)
}

model PayWindow {
  effectiveFrom String  @date @immutable
  effectiveTo   String? @date
  @@effective(from: effectiveFrom, to: effectiveTo)
  @@unique([employeeId], where: effectiveTo == null)
}
```

Both arguments optional, at least one required. `@@expires(col)` is the
rejected sugar.

**What it does.** Every read AND write filters to the rows in force at `asOf`,
defaulting to the client's own clock — `createClient({ now })`, the same clock
`@default(now())`, `@updatedAt`, `@@softDelete`'s stamp, a policy's `now()` and
retention all already read. That one change is what makes hold expiry testable
with `advance()`.

**What it does NOT do, and each is deliberate:**

- **It does not imply the partial unique.** *At most one open row per parent* is
  `@@unique([…], where: … == null)`, which already exists and already works.
  Implying it would be a second answer to a question the language has answered.
- **It does not schedule anything.** Caravan keeps the clock (`FJS-D36`). This
  is a read filter and a declaration; nothing here dispatches.
- **It does not reach shape 2.** `subscriptions-dun` derives its deadline from
  an `@immutable dueOn` against today and stores **nothing**. There is no column
  to name, so no declaration can see it — and that is the case which decides
  whether a NOUN (`IDEAS/ontology.md`'s option C, `Commitment`) is ever needed.
- **It is not an access rule**, so `asSystem()` does not lift it — the same line
  `@@softDelete` and `@@hasTemplates` sit on.

**Three things the design has to answer and this paper does not:** whether a
hard `delete` bypasses the filter (today `delete` bypasses soft-delete's and
does not bypass the template one, so there is no precedent to copy); whether
`asOf` reaches a WRITE or reads only; and what an `@@effective` model's rows
look like to a broadcast, where `$readAs` has no query to filter through.

---

## 6. Shipping order — one paper, three ships

The paper's job is the parts that cannot be retrofitted: **the directive**, the
**clock**, and the **exclusion rule** in § 2. Each gap still ships alone.

| # | Ships | Why first | Retires |
| --- | --- | --- | --- |
| 1 | `@@effective(to:)` + the full `asOf` directive | smallest, five live columns, and [`FJS-1241`](../ISSUES.md#fjs-1241) is the second caller `FJS-D143` said to wait for | hand-filtering in 5 reads; makes expiry testable |
| 2 | `@@effective(from:, to:)` | the idiom is already hand-rolled three times | 3 copies, plus `Discount`'s JS version |
| 3 | the zone on the window | by then it is a parameter, not a redesign | the hourly-sweep dodge |

Phase 1 ships the whole directive even though only `withExpired` is reachable
from it. That is the point of the sequencing: the boolean is the trap, so the
value goes in first and the flag arrives as sugar over something that already
exists.

---

## 7. What it must not make impossible

- **A raw instant stays an instant.** A log line, an audit entry, `@version`,
  and every `createdAt` want a time with no window attached. A model that
  declares nothing behaves exactly as it does today.
- **A described interval stays undeclared** (§ 2), and the language must not
  grow a way to guess one.
- **The escape hatch is the column.** Anyone who wants none of this keeps
  writing the filter by hand, and that must remain true.
- **`@@unique(where:)` keeps its job.** The open-row constraint is orthogonal
  and must not be absorbed.

---

## 8. The nine, answered before the first edit

- **Another origin?** No, and one is REMOVED — the deadline filter has six
  hand-written origins today. The zone and the time taxonomy are CITED from
  `FJS-D143` and never restated.
- **Concept budget?** One model attribute and one directive, for a fact six
  places in this repo already express. `@@expires` as a second spelling is
  refused for that reason.
- **Whose complexity?** The problem's. Expiry and effectivity are in every
  booking, billing, credential and pricing system written.
- **Predictability?** Improves. The third model to need a window currently
  rediscovers a four-part idiom; and a read that omits the filter is today
  indistinguishable from a bug.
- **Derived, not restated?** The filter derives from the declaration; `asOf`
  defaults to the client clock rather than each caller passing one. What cannot
  derive is WHICH models have a window — that is the declaration, and § 2 is
  why it must not be guessed.
- **One owner, and does it exist?** Yes, all of them. The filter joins
  `@@softDelete`'s composition point in `client.js`; the directive is one row in
  `@frontierjs/toolbelt/directives` (Invariant 10); the clock is
  `createClient({ now })`; the zone seams are `FJS-D143`'s three. No new owner.
- **Boundary explicit?** Named and typed: a model attribute naming one or two
  columns, and a directive whose value is an instant. Refused at parse when the
  columns are not a time, or when a `from` is not before its `to`.
- **Failure proportional?** An expired credential honoured, or a payslip that
  vanishes, are both real-world costs — so the filter is on by default and the
  opt-out is explicit, which is `@@softDelete`'s calibration.
- **Wrong without anything saying so — what artefact?** Today **yes and
  silently**: nothing grades that a window is filtered everywhere, and the one
  drive that tries cannot move the clock. After phase 1 the artefact is the
  filter itself — a read that would have been wrong now returns the right rows
  by construction — plus a `test/effective.test.ts` staging expiry with
  `advance()`, which is the assertion that cannot be written at all today.
  For **this paper** the artefact is **none**: an assessment is gated by nothing.

**Adjudications in tension** (§ IV): *familiarity vs. precision* over `asOf`,
which is SQL:2011's word and arrives with SQL:2011's meaning — that is the
`timestamptz` risk `FJS-522` named, and here the meanings agree, which is the
check that has to be made rather than assumed. *Batteries vs. smallness* if the
declaration grows toward scheduling: it must stay a read filter, and Caravan
must keep the clock.

**Tier** (§ VII): Assessment. Dated, statused, never cited as behavior.

---

## Open questions

- **Is the word `@@effective`?** For: Fowler's Effectivity pattern, SQL:2011's
  `PERIOD FOR`, and it reads correctly at both arities. Against: *effective*
  reads faintly legal for a five-minute stock hold, where *expires* is what a
  developer would have typed. **Recommend `@@effective`** — one mechanism gets
  one word, and the one-sided case reading slightly formally is cheaper than two
  names for one thing. Decide with phase 1, not before.
- **Does `asOf` reach a WRITE, or reads only?** Reads-only is smaller and is
  what `withDeleted` does not settle, since `update({ withDeleted: true })` is
  already legal. A write *as at* a past instant is a different feature and may
  be a mistake to allow at all.
- **Does a hard `delete` bypass the window?** No precedent to copy: `delete`
  bypasses `@@softDelete`'s filter by design and does NOT bypass
  `@@hasTemplates`'. The argument that decided the second one — *destroying rows
  no read returns is data loss the caller cannot anticipate* — applies here,
  which points at NOT bypassing.
- **What does an `@@effective` row look like to a BROADCAST?** `$readAs` has a
  row in hand and no query to filter through, so a row that has just expired is
  a push nobody should receive and there is no WHERE to catch it. This is
  `FJS-631`'s shape on a new declaration and is not answered here.
- **Does shape 2 ever get a noun?** An obligation with no column cannot be
  declared by this. `IDEAS/ontology.md` § Open questions holds that question and
  this paper does not close it.

---

## See also

- `IDEAS/time-and-recurrence.md` — the column's side: what KIND of time, whose
  zone (`FJS-D143`), and why the general `RRULE` is refused
- `IDEAS/ontology.md` — the row's side: the three shapes of a deferred
  obligation, the tree they hang off, and the `Commitment` naming question
- `IDEAS/declared-semantics.md` § 3 — bitemporality, the OTHER time axis:
  *when it happened* against *when we heard*, which this does not touch
- `DECISIONS.md` § `FJS-D143` — the zone ruled three ways, and the measurement
  that a zoned comparison cannot be a SQL predicate
- `DECISIONS.md` § `FJS-D36` — Caravan owns the clock
- `ISSUES.md` § `FJS-1241` — the fourth shape, implemented by guessing
- `example/api/src/domain/shop/inventory.ts` — shape 1, filtered by hand
- `example/db/schema.lite` — `PlanVersion`, `PayWindow`, `PayRate`: the idiom,
  three times
