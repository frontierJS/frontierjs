---
id: effective-time
status: partial
dated: 2026-09-22
---

# Idea — a row that stops counting: one declaration for expiry, for validity, and for the clock that decides both

**Status: PHASE 1 IS BUILT** — `@@effective(to:)` with the whole `asOf`
directive, ruled [`FJS-D351`](../DECISIONS.md#fjs-d351) and recorded in
`packages/litestone/CHANGES.md`. **PHASE 2 IS BUILT AND ADOPTED**, and building
it split the word: [`FJS-D352`](../DECISIONS.md#fjs-d352) makes an expiry
`@@expires(col)`, imposed as phase 1 shipped it, and a validity window
`@@effective(from:, to:)`, ASKED — a read stating no `asOf` gets every row,
because a closed price is still pointed at. `PlanVersion`, `PayWindow` and
`PayRate` declare it; `Discount` is not a candidate, measured. **Adoption is closed**
([`FJS-1275`](../ISSUES_ARCHIVE.md#fjs-1275)): auth's four models and orion's `KvEntry`
declare `@@expires`, and a deadline is minted from `db.$now()` — the client's
clock, the one the window grades on. **Phase 3 has
nothing to do on a validity window**: an asked window has no default, so no
*today* is ever derived and no zone spent. **Cite the
ruling and `packages/litestone/docs/schema.md` § The window for behavior, never
this file** — see `VERIFYING.md`. Everything below is the argument as it stood
before the build, kept because the measurements under § 1 are what decided it;
where building moved something, § Open questions says so.

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

**One instance was a filed defect.** `Job.nextRunAt` was the fourth shape
— a commitment a person can SEE — implemented by writing `now + 60s` once on
create and never again, and rendering it as *Next run*
([`FJS-1241`](../ISSUES_ARCHIVE.md#fjs-1241)); it is now read off caravan's clock and
is not a column.

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

**The window's two columns are not one TYPE, and the live instances disagree
inside one file.** `PlanVersion.effectiveFrom` is a `DateTime`;
`PayWindow.effectiveFrom` and `PayRate`'s are `String @date` — the conversion
`FJS-D143` records, where *a price changes at a moment, a salary changes on a
day*. A window is over instants or over days, per model, and the declaration
cannot pick.

**That decides what `asOf` carries: the column's own kind.** An instant against
an instant window, a day against a day window — and no zone is spent, because
no crossing happens: the caller is already on the side the column is on. The
zone is owed by the DEFAULT alone — *unstated* on a day window means *today*,
and *today* is a day derived from an instant, which is `FJS-D143`'s
`plainDateIn` and its one crossing. **That is what makes gap 08 a parameter
rather than a redesign**: a stated `asOf` never needs the zone, and the default
reads UTC until phase 3 says whose midnight it is.

Refused at parse: a `from` and a `to` of different kinds, and a column that is
neither a `DateTime` nor a `String @date`.

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
| 1 | `@@effective(to:)` + the full `asOf` directive | smallest, five live columns, and [`FJS-1241`](../ISSUES_ARCHIVE.md#fjs-1241) is the second caller `FJS-D143` said to wait for | hand-filtering in 5 reads; makes expiry testable |
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

**Four of the five are CLOSED by [`FJS-D351`](../DECISIONS.md#fjs-d351)** and
the recommendations below are what it took: `@@effective` (A), `asOf` reads-only
(A), a hard delete APPLIES the window (B), and the broadcast carved at the event
(C). They are kept as written because the options are the argument; the ruling
is the answer. **The fifth — does shape 2 ever get a noun — is still open. A sixth was found adopting phase 2 and is ruled by [`FJS-D352`](../DECISIONS.md#fjs-d352): an expiry is `@@expires(col)`, imposed; a validity window is `@@effective(from:, to:)`, asked.**

**Building moved one thing this section did not predict.** A `@from` over a
windowed model is now REFUSED unless it states its own `where:`: a `@from`
compiles once at startup into SQL with no binds and cannot read the injected
clock, so filtering it with SQLite's would give one model two clocks that agree
in production and disagree under exactly the frozen clock a test stages expiry
with. That is a fourth decision with no precedent, and it is in the ruling.

*Each option below was measured against the code on 2026-09-22 and the
measurement is stated, because the argument that decides three of them is a
precedent and a precedent read from memory is how a settled question gets
re-answered wrongly.*

- ~~**Is the word `@@effective`?**~~ **Answered by [`FJS-D351`](../DECISIONS.md#fjs-d351) (A), and reversed in half by [`FJS-D352`](../DECISIONS.md#fjs-d352)**: the measurement that decided it is below, under the sixth question. For: Fowler's Effectivity pattern, SQL:2011's
  `PERIOD FOR`, and it reads correctly at both arities. Against: *effective*
  reads faintly legal for a five-minute stock hold, where *expires* is what a
  developer would have typed.
  - **A** — `@@effective`, one word at both arities.
  - **B** — `@@expires(col)` for the one-sided case and `@@effective` for the
    two-sided one.
  - **Recommend A** — B is two names for one mechanism, which the evolution
    policy refuses outright; the one-sided case reading slightly formally is the
    cheaper of the two costs. Decide with phase 1, not before.

- ~~**Does `asOf` reach a WRITE, or reads only?**~~ **Answered by [`FJS-D351`](../DECISIONS.md#fjs-d351) (A).**
  - **A** — reads only. The window still filters a write (at `now`), and
    `withExpired` / `onlyExpired` reach a write as flags — which is exactly what
    `update({ withDeleted: true })` already is. A stated `asOf` on a write is
    REFUSED by name, pointing at `withExpired`.
  - **B** — `asOf` reaches a write, so an update can be made *as the world stood*
    at a past instant.
  - **Recommend A.** The filter must reach writes either way, or `update()`
    silently resurrects a row no read returns. What A withholds is the VALUE on
    a write, and that is not a smaller version of this feature — it is
    bitemporality (`IDEAS/declared-semantics.md` § 3), which this paper does not
    touch and must not ship by accident as a directive default.

- ~~**Does a hard `delete` bypass the window?**~~ **Answered by [`FJS-D351`](../DECISIONS.md#fjs-d351) (B)**, and it binds `@@expires` alone since [`FJS-D352`](../DECISIONS.md#fjs-d352). Measured: `_hardDeleteWhere`
  ([`client.js:6350`](../packages/litestone/src/core/client.js)) is the one
  place the two existing exclusions part company, and its own comment says why —
  `delete` is the purge hatch FOR soft delete, the verb that exists beside
  `remove`; templates get the filter because destroying rows no read returns is
  *data loss the caller has no way to anticipate* (`FJS-176`).
  - **A** — bypasses, like `@@softDelete`.
  - **B** — applies, like `@@hasTemplates`, with `withExpired` / `onlyExpired`
    as the opt-in.
  - **Recommend B**, on two arguments and not the analogy. **First: there is no
    verb pair to honor.** Soft delete's bypass is not a rule about exclusions, it
    is the contract of `delete` against `remove`; `@@effective` declares no verb,
    so a bypass would mean nothing in particular. **Second: A splits the two
    arities.** A row past its `to` is an end state, which is soft delete's shape;
    a row before its `from` is a live row in a parallel category, which is the
    template's shape and `FJS-176`'s exact words. One word cannot mean both, and
    only B is one thing at both arities.
  - **What B costs, named**: `releaseExpired`
    ([`inventory.ts:380`](../example/api/src/domain/shop/inventory.ts)) deletes
    on `expiresAt: { lte: before }`, and under B that WHERE is ANDed with
    `expiresAt > now` and matches nothing. It becomes
    `deleteMany({ onlyExpired: true, … })` — which is the intent it was already
    spelling by hand, and is the paper's own claim in § 1 that the two
    unfiltered reads stop being invisible.

- ~~**What does an `@@effective` row look like to a BROADCAST?**~~ **Answered by [`FJS-D351`](../DECISIONS.md#fjs-d351) (C)**; the half C cannot close is [`FJS-1274`](../ISSUES.md#fjs-1274). Measured, and the
  precedent does not transfer. `$readAs`
  ([`client.js:12383`](../packages/litestone/src/core/client.js)) grades the
  gate, the row policy and the field policies, and grades **neither
  `@@softDelete` nor `@@hasTemplates`** — so the standing answer is *a data
  exclusion is invisible to a fan-out*. **It is invisible safely there for a
  reason this does not have: soft delete's transition is a WRITE, so it
  announces. Expiry's transition is the CLOCK, and nothing announces.** A
  subscriber's store therefore holds a dead row for ever with no frame that
  could correct it, which is a case neither existing declaration has.
  - **A** — nothing. A frame is not a read; the window is a read filter.
  - **B** — `$readAs` applies the window. One local comparison against the row in
    hand, no query, no relation.
  - **C** — B, carved at the event: applied to `created` and `updated`, never to
    `deleted`. `gradeRecipients`
    ([`channels.ts:501`](../packages/junction/src/transport/channels.ts))
    already holds `event`, so the carve costs no plumbing.
  - **D** — the client grades it. `@frontierjs/toolbelt/match` already answers
    *does this record still belong in this query's results* and already has
    `null` for *ask the server*.
  - **Recommend C.** B alone is worse than A in one direction: suppressing the
    `deleted` frame for a row the subscriber already holds strands it for ever,
    where A at least delivers the removal. C is right for every frame the fan-out
    emits and costs an `if`. **D closes the half C cannot** — silent expiry, where
    no write ever happens — and is a second feature, because re-grading a row
    already in a store needs a TICK, which is a clock in a store, which
    `FJS-D111` keeps out of toolbelt. It belongs with live queries and is named
    here so the gap is written down rather than discovered.
  - **One implementation note C depends on**: `$readGrading` answers `open` for a
    model with no read gate, no read policy and no field policy, and the fan-out
    skips `$readAs` entirely on that answer. An `@@effective` model must grade as
    `graded`, or the carve never runs — and a catalog-shaped model is exactly the
    one likely to declare a window and no gate.

- ~~**Is a validity window IMPOSED like an expiry, or ASKED?**~~ **Answered by [`FJS-D352`](../DECISIONS.md#fjs-d352) (C1).** Measured 2026-09-22
  while adopting phase 2, and it is the one thing § 3 did not predict: the two
  arities share a PREDICATE and not a DEFAULT. Every phase 1 model is an expiry
  — a row out of its window is dead, nothing points at it, and nine reads in ten
  want the filter. Every phase 2 candidate is a HISTORY — a row out of its
  window is the price a subscriber is still paying, the terms a payslip was
  computed under, the rate a line applied — and it is pointed at. Counted across
  `PlanVersion`, `PayWindow` and `PayRate`: of the reads in `example`, **six ask
  the window's question** (`payAsAt`, `payAsAtMany`, `ratesAsAt`,
  `allRatesAsAt`, the offered-plans picker, the *On* column), **four follow a
  pointer** (`subscription-renew`, billing's two proration reads, and
  `planVersions.record(id)` on the subscription screen), **four read the whole
  history** (the price table, the pay-history panel, `setPay`'s overlap check,
  the seed), and **two want the open row whenever it opens** (`reprice`,
  `setPay`). Imposed, ten of sixteen must opt out, and forgetting one is silent:
  renewal stops finding the price for every subscriber on an old one, and
  `setPay` loses the history it checks overlaps against. **`Discount` is not a
  candidate at all** — both of its reads want the out-of-window row, because
  *not valid yet* and *has expired* are sentences a filter cannot produce.
  - **A** — imposed, as phase 1. State `withExpired` at the ten reads. The shape
    `@@softDelete` already has, and the trap it already has.
  - **C** — asked. An unstated `asOf` on a validity window filters nothing; a
    stated one filters to the rows in force. Expiry stays imposed. It needs a
    spelling, because only the author knows whether a row out of its window is
    dead or history: **C1** a second word, `@@expires(expiresAt)` for the
    imposed one, which reverses the part of `FJS-D351` that refused it as *a
    second name for one thing* — on the evidence that they are two things
    sharing a predicate; or **C2** an argument on the one word.
  - **D** — imposed, but a pointer bypasses it: a `belongsTo` include and a
    read pinned to the primary key ignore the window. Fixes four of the ten,
    and adds a rule a caller has to know — *by id returns it, by code does not*.
  - **Recommend C1.** `example` already ruled this for itself: `employment.ts`
    says *`on` is required and there is no default — a default would be a clock
    in this module, and a clock with no zone is the thing `FJS-D288` took out of
    billing*. An imposed default on a day window IS that clock, and it is phase
    3's zone; asked, a day window never spends one, which is also why phase 3
    has no caller. C fails no question in § V; A and D both fail the ninth.

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
