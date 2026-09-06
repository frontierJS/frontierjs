---
id: declared-semantics
status: partial
dated: 2026-08-06
---

# Idea — The categories of data the seed should know about

**Status: IDEA — except item 1, which SHIPPED 2026-08-06.** `@version` is built,
tested (21 tests) and documented in `packages/litestone/docs/schema.md`; the
section below is kept as the argument for it, with a note on where the built
thing differs. Items 2–4 are unbuilt, and the defect this file carried
(`FJS-088`) **closed 2026-08-13**. Claims about current behavior
were read off the source on 2026-08-06 with line numbers named, item 2 was
re-read and rewritten on 2026-08-24 against a 188-model fixture, and the whole
file was **re-audited against the tree on 2026-08-25** — which moved item 2's
argument off aggregation after measuring it. See `VERIFYING.md`.

---

## Trigger

A 39-item glossary of framework concepts, reviewed against this repo. Most of it
either already ships here or is already filed. Four items did not map to
anything, and reading them together they are not four ideas — they are the same
idea four times:

> There are **categories of data whose semantics everyone knows and nobody
> declares**. Money. Time-of-record versus time-of-event. "This row is the one I
> read." "This request is the one I already sent." Each is handled by convention,
> in application code, correctly about eighty percent of the time — and the
> twenty percent is silent-wrong-data every time.

FJS already has the mechanism for exactly this. `@encrypted` says a column is a
secret. `@@softDelete` says a row can come back. `@@transitions` says a field is
a machine. `@@log` says history matters. None of those are types; they are
**declarations at the Data boundary**, and the enforcement is not something the
caller opts into.

So the question is not "should FJS have a Money type". It is: **which categories
have earned a word in `.lite`?**

## Why declaration beats a first-class type here

The glossary's own summary says the move is to "promote it to a first-class type
or structural rule the compiler enforces". Those are not equivalent, and FJS has
already picked a side.

A type is enforced **where you call it**. A declaration is enforced **at the
boundary whether you call it or not** — which is why a `@@gate` auto-installs
`GatePlugin` rather than waiting to be wired (`DECISIONS.md`, 2026-08-01: a
declared gate that silently does nothing is a fail-open default).

That difference is the whole reason to put these in the seed rather than in a
library of value objects. A `Money` class in `api/` is a thing you can forget to
use on the one path that matters. `price Int @money(GBP)` is a column the Data
boundary refuses to add to a float, whether or not anyone remembered.

---

## 1. `@version` — optimistic concurrency

> **SHIPPED 2026-08-06.** Built as argued, with three things this section did not
> settle:
> - **The version travels in `data`, not `where`** — a Resource fetch carries
>   every column, so a form round-trips it with no plumbing, and its absence is
>   detectable (which is what makes "required" enforceable).
> - **Only `update()` requires it.** `updateMany` matches many rows and therefore
>   many versions; `upsert` is reached by natural key and cannot have read one.
>   Both still bump, which is what keeps an open editor correctly stale.
> - **Two errors, not one.** `VersionRequiredError` is a 400 (you left out an
>   input; retrying is pointless) and `VersionConflictError` a 409 + retryable.
>   Collapsing them would tell a caller to retry something that cannot succeed.
>
> The implementation is the compare-and-swap `@@transitions` already ran, with
> the column unfrozen — which is the same "generalize the mechanism, do not add
> a second one" move `cascading-fields.md` argues for `@@softDelete(cascade)`.

**The strongest of the four.** Nothing in litestone carries a row version; there
is no OCC anywhere. So two users editing the same order both `PATCH`, both
succeed, and the second silently erases the first. Lost update — the oldest
silent-wrong-data bug there is, and the only class in this file with no partial
mitigation already present.

```
model Order {
  id      Int @id
  version Int @version        // bumped on every write, required on every update
  …
}
```

- `update`/`updateMany` on a `@version` model require the version they read and
  fail `409 Conflict` when it moved. Junction already maps a `Conflict` to 409
  and `example` already asserts one (`moves.illegalStatus`), so the API half is
  free.
- The client half is nearly free too: a record fetched through a Resource
  already carries every column, so the version rides along with no new plumbing
  and `<Form>`'s error map already has somewhere to put the failure.
- **Escape hatch:** `asSystem()` writes skip it, same as gates — a migration or
  a job is not a concurrent editor.

Why this one first: it is the only item here that makes a *currently correct*
app wrong under load, and the fix is one attribute plus a `WHERE version = ?`.

## 2. Exact numbers — `@scale(n)`, and `@money` on top of it

> **RULED 2026-08-25 — `FJS-D142`. BUILT 2026-08-26.** `Int @scale(n)` and
> `Int @money(…)` ship, with the refusals in `test/exact-numbers.test.ts` and the
> page at `packages/litestone/docs/exact-numbers.md`. Two things the build
> changed about this section: the ISO table is read off
> `Intl.supportedValuesOf('currency')` rather than shipped — which is the only
> way a typo'd code is refusable, since `Intl.NumberFormat` answers two decimal
> places for `UDS` rather than throwing — and *the column's own name* below
> closed itself, because under the integer return `cents` reading back `1299` is
> honest. This section is now the argument rather than the proposal. The ruling changed two
> things in it: the case is led by multiplication and comparison rather than by
> `SUM` (measured — see *Where the float bites*), and **what comes back in JS is
> the integer**, not the float an earlier draft asked for. Prior art is folded in
> below.
>
> **Revised 2026-08-24** against `packages/litestone/test/fixtures/scale/openmrp.lite`,
> a 188-model schema converted from a real MRP. The revision changes the shape:
> what this section originally asked for was a `Money` scalar, and the fixture
> says money is the smaller half of the problem and the wrong thing to build
> first. It also **retires the proposal in `packages/litestone/docs/roadmap.md`**,
> which stores a Money as JSON TEXT — see *Why not JSON* below.

`.lite` has no fixed-point numeric type at all: `Decimal` appears nowhere in
`parser.js` or `ddl.js`, and `TYPE_MAP` (`litestone/src/core/ddl.js:13`)
offers `Int`, `Float` and nothing between them. Every app therefore models an
exact quantity as a float and hopes. **One echo of the missing type is already
in the tree and it is dead**: `NUMERIC_TYPES` (`core/client.js:4421`), which
gates the write operators, names `BigInt` and `Decimal` — two types the parser
cannot produce.

The fixture the rest of this section argues from is real and committed, and
**it is not a decimal test bed**: `test/scale.test.ts` asserts two things over
it — that 188 models parse, and that booting twice migrates nothing. Nothing
there measures a number.

### What a real schema actually holds

OpenMRP's DDL has **95 decimal columns and zero currency columns**. Seven have
money-shaped names, and two of those are its own SaaS billing plan rather than
its domain:

| | |
| --- | --- |
| decimal columns | 95 |
| currency columns | **0** |
| money-shaped names | 7 — `unit_cost`, `setup_cost`, `holding_cost`, two `recommendation_*` costs, `price_per_seat`, `price_per_month` |

The other 88 are quantities, statistics and durations: `weekly_demand`,
`sigma_weekly`, `service_level_z decimal(6,4)`, `reorder_point`,
`safety_stock`, `projected_on_hand_before/after`, `hours_per_shift
decimal(6,3)`, `changeover_avg_minutes decimal(10,4)`, `weeks_of_cover
decimal(14,4)`, `capacity_headroom_pct decimal(5,4)`.

**The float harm is worse on those than on the prices**, which is the part that
inverts the original argument. A price is rounded the moment it is shown to
someone. A safety stock, a reorder point and a projected on-hand are sums over
many rows that are then *compared to each other*, and the comparison is what
raises a purchase order. Nobody reads the drifted number; a machine acts on it.

**Fifty of the ninety-five state a precision** — `(18,6)`, `(14,4)`, `(6,4)`,
`(10,2)`, `(5,4)`. That is the author saying what the column means, and both the
fixture and any app doing the same conversion throw all of it away. The
remaining 45 are Prisma's unqualified `Decimal`, which compiles to
`decimal(65,30)` and means the author said nothing — the class that has not
earned any trust.

### The spelling

An attribute rather than a new scalar, because a scalar costs six places —
`TYPE_MAP`, the JSON Schema emit, `types --augment`, `introspect`,
`field-rules.js`'s control table and `coerceToSchema` — and an attribute costs a
parse rule and one branch in `sqlType`.

```
qty    Int @scale(6)        // stored 1_500_000; the point sits six places in
total  Int @money(USD)      // scale 2, DERIVED from the currency
total  Int @money           // the app's default currency
```

**`Int`, not `Float @decimal(p, s)`.** Two reasons, and the first is the one
that decides it:

- **`p` does nothing.** SQLite has no column widths — `TYPE_MAP` maps to
  affinities. `decimal(18,6)` and `decimal(65,6)` emit an identical column, so
  `p` is `@lte` written shorter and only `s` is load-bearing.
- **`Float` names REAL affinity, which is the type's one job.** An attribute
  that stores a scaled integer overrides the type it sits on, so `Float` means
  two different things depending on a token further down the line.
  `@encrypted` is not the precedent it looks like: `String @encrypted` is still
  `TEXT`, because ciphertext is text — it changes what the bytes MEAN and never
  the storage class. This would change the class.

Under `Int @scale(n)` the type is true, the DDL is unchanged, and the column
sorts and compares exactly because it is an integer.

**What comes back in JS is the question both earlier proposals dodged**, and
this spelling forces it. `1500000` is honest and moves the work to every call
site that has to divide. `1.5` puts a float back at the boundary — and that is
the option this file used to prefer.

**Ruled the other way, and the prior art is why.** Rails hands back a `Money`,
Prisma a `Decimal`, Django a `Decimal`, Stripe an integer; **not one of them
returns a float**. Reading back `1.5` also contradicts this file's own opening
promise — `price Int @money(GBP)` was to be *a column the Data boundary refuses to
add to a float* — which cannot be true of a column that hands one out. So the
value is the integer, `formatMoney` is the read path, and the division has an
owner instead of being everywhere.

### Where the float bites, measured

> **Added 2026-08-25.** The paragraph above used to say the drift being fixed
> lives in the AGGREGATE — *SQLite sums the integers exactly* — with the
> implication that summing the floats does not. **That was asserted and it is
> false on this stack.** Run before repeating it.

SQLite's `sum()` over `REAL` is **Kahan–Babuška compensated**, and has been for
several releases; bun ships 3.51.2. Measured three ways:

| | |
| --- | --- |
| 5,000 random 2-dp amounts | `SUM(REAL)` === `SUM(INTEGER cents)/100`, exactly |
| 20,000 random 6-dp values, the fixture's commonest precision | `SUM(REAL)` === `SUM(scaled INTEGER)/1e6`, exactly |
| `sum(1e100, 1, -1e100)` | answers `1`. Naive float accumulation answers `0` |

So **aggregation is not the case**, and an argument for `@scale` that leads with
it is an argument a reader can disprove in a minute. Three cases survive the
same measurement and they are the ones to lead with:

- **Multiplication.** `SELECT price * qty` on `0.1 × 3` answers
  `0.30000000000000004`, and `price * qty = 0.3` answers **0**. A quantity times
  a rate is what every one of the fixture's 88 non-money decimals is, and no
  compensated accumulator touches it.
- **Equality and threshold comparison.** The reorder-point case — a projected
  on-hand compared against a safety stock, both derived — is a comparison of two
  drifted values, not a sum of clean ones.
- **The JS boundary.** `0.1 + 0.2 !== 0.3`, and ten accumulated tenths are
  `0.9999999999999999`, which is `< 1`. This is where `example` lived:
  [`api/src/pricing.ts`](../example/api/src/domain/shop/pricing.ts) carried a hand-rolled
  `round2()` at eight call sites plus a literal `.toFixed(2)`, which was
  `FJS-440`'s minor-unit assumption returning in the arithmetic after being
  removed from the formatting. It is minor units throughout since `FJS-562`,
  and one rounding survives it — the two multiplications that produce a
  non-integer at all.

That reorders the argument rather than retiring it: the harm is real and it is
in the operations, not in the accumulation.

### What the rest of the world does, and where each one lost

> **Added 2026-08-25** with the ruling. Seven implementations, read for where the
> mistake is rather than for the API.

| | got right | got wrong |
| --- | --- | --- |
| SQL `DECIMAL(p,s)` · PG `numeric` | scale declared, arithmetic exact, the database enforces it | nothing — **and SQLite has no such type**, which is the whole of this section |
| **Prisma `Decimal`** | a decimal type in the schema language, `decimal.js` on the JS side | **it does not work on the database this repo uses.** Prisma's own maintainers record that there is no reliable way to store a Decimal in SQLite; values are written and read back different (`prisma#20635`) |
| Rails + money-rails | integer minor units beside a per-row currency; a `Money` that refuses `USD + EUR` | the semantics live in the **column name** — the gem finds the field by its `_cents` suffix. A convention, not a schema fact |
| Django + django-money | one declaration creates **two columns**, `amount` and `<name>_currency` | the decimal places are the author's (`decimal_places=2`), never the currency's — the JPY mistake, institutionalised |
| Stripe | integer minor units, no float anywhere on the wire, a published zero-decimal list | the list is prose, so every client library hardcodes a copy that goes stale |
| Java `BigDecimal` | exact, carries its own scale | `equals` compares scale, so `2.0` and `2.00` are unequal |
| .NET `decimal` | exact base-10 **in the language** — the one mainstream primitive that got it right | still not a currency, and knows nothing about minor units |

Three of those decide something here.

**The minor-unit table is not ours to ship.** Measured:
`Intl.NumberFormat(…).resolvedOptions()` answers 2 for USD, **0 for JPY**, 3 for
KWD, 0 for CLP, 3 for BHD — ISO 4217, shipped with ICU and updated with it. That
is the whole objection to `@money` being its own attribute rather than an alias:
there is no table to keep. Stripe pays for that table; this repo does not have to.

**Prisma's failure is the argument for `Int`.** The sibling that HAS the type does
not have it working on SQLite, which is the only database here. `Int @scale(n)` is
not the poor relation; it is the one spelling that is exact on this stack.

**Money is TWO columns and ONE declaration.** django-money's `MoneyField` creates
the pair, and it is the shape the *per-row currency* question below is asking for:
`@money(field: currency)` naming a sibling, rather than a composite value in one
column — which is also what *Why not JSON* already rules out for a different
reason.

**And the naming rule has to be enforced, not documented.** money-rails is the
evidence: it derives the field from a `_cents` suffix, because a column called
`cents` that reads back major units is how a price gains two zeroes. That is the
*column's own name* bullet below, and prior art says a convention nobody checks
becomes a bug.

### Why `@money` is not sugar for `@scale`

**Scale is not a free parameter for money — the currency declares it.** JPY has
no minor unit, USD has two, KWD has three. `formatMoney` already turns on
exactly that fact (`FJS-440`, and `packages/toolbelt/CLAUDE.md` states it:
"a hand-rolled `toFixed(2)` invents a minor unit the yen does not have"). So
`@money(JPY)` is scale 0 and `Int @scale(2)` cannot express it without the
author knowing the ISO table by heart. `@money` DERIVES what `@scale` STATES,
and adds a currency `@scale` has no opinion about; that is what makes it its own
attribute rather than an alias with an argument prefilled.

### Why not JSON

`packages/litestone/docs/roadmap.md` proposed storing a Money as JSON TEXT,
`{ "amount": 1299, "currency": "USD", "scale": 2 }`. **The fixture rules it out,
and litestone already knows why**: `opaqueSortKind`
(`litestone/src/core/client.js:1872`) classifies a `Json` column as opaque, so
`$checkOrderBy` throws on it. A Money stored that way is a price you cannot sort
a list by, cannot `groupBy` and cannot `sum` — which is every question anyone
asks of a money column. `DateTime`→ISO TEXT is
the precedent for a declared type getting its own storage encoding, but the
encoding has to stay one SQLite can order.

### Open, and not solvable by picking a nicer name

- **Per-row currency.** `example/db/schema.lite:360`'s `Payment` is
  `amount Float @gte(0)` beside `currency String @default("USD") @length(3, 3)
  @upper` — two columns nothing pairs, and a currency that varies
  per row, so the scale is not statically known. **`@money(field: currency)`
  naming the sibling**, on django-money's evidence: one declaration, two columns,
  the pair created and kept together. Still open is what an aggregate over mixed
  currencies does — django-money's is the loudest place it goes wrong, since
  summing across them silently adds unlike things. This is the app that motivates
  the feature, so it cannot be deferred past a first build.
- **The column's own name.** `cents Int @money` reading back `12.99` is how a
  price gains two zeroes. **Refused at parse**, and money-rails is why it cannot
  merely be documented: that gem finds the field BY its `_cents` suffix, which is
  the same rule enforced by a naming convention instead of by the parser. Under
  the ruling the stored value IS the integer, so a column named for minor units is
  honest and one named `price` is the one that needs the attribute to say so.
- **Changing `n` is a migration that rescales every row**, which is the hard
  half. `@@transitions` and `@encrypted` both changed a column's meaning without
  ever needing to rewrite stored bytes; this one does. See the note under
  *Relationship to the other files* about views.
- **The wire.** `@frontierjs/toolbelt/query` deliberately keeps `'1.50'` as text
  (`FJS-D125` — a string is a number only if it round-trips), so `?price=1.50`
  arrives at the boundary as a string and the coercion is real work rather than
  something that falls out.

**Escape hatch:** `Float` still exists and nothing about it changes. Both of
these are opt-in per column.

## 3. Bitemporality — when it happened vs when we heard

No `occurredAt`, no bitemporal anything in the tree. Every model gets
`createdAt @default(now())`, which answers *when the row was written* and is
routinely used to mean *when the thing happened*. They differ whenever data
arrives late — an import, a webhook retry, a device that was offline — and the
gap is invisible until a report is wrong.

The declaration is small:

```
model Reading {
  occurredAt DateTime @eventTime
  recordedAt DateTime @recordTime @default(now())
}
```

What earns it a place is not the two columns — anyone can write those — but that
**declaring them lets everything downstream default correctly**: a report reads
event time, an audit trail reads record time, and `IDEAS/time-travel.md`'s
`db:restore` needs to know which one it is rewinding. Without the declaration
every consumer picks, and they will not all pick the same.

Lowest priority of the four. Cheapest to add, easiest to work around by hand.

## 4. A resumable process — the noun FJS does not have

`@@transitions` is a **field-level** machine: `status: pending → paid → shipped`,
enforced at the Data boundary, carried to the client as `x-transitions`. It
shipped 2026-08-04 and it is good.

A **process** is a different noun and there is nothing for it. Checkout,
onboarding, an approval chain: multi-step, spanning requests, resumable after a
disconnect, with state that today gets scattered across a session, a URL, a
draft row and some component state. The established name is *Saga* or *Process
Manager*; neither is a word this repo would want.

This is the largest of the four by a wide margin and the least ready. Recorded
because it is a genuine hole in the vocabulary — `ARCHITECT.md` §2 has a noun
for every realm and none for "a thing in progress" — and because Caravan (jobs)
and `@@transitions` (field machines) are the two halves it would be built from,
so a design that ignores either is wrong.

---

## The one that is already broken: `FJS-088`

> **CLOSED 2026-08-13**, and the shape below is what was built: `core/idempotency.ts`
> claims a key in `callService` — the one path both transports take — so a repeat
> replays the first call's result with no second hook, no second write and no
> second announcement. Scoped to `(service, method, principal, key)`; a failed
> call releases the key; a duplicate in flight is a retryable 409. The section is
> kept as the argument. See `ISSUES_ARCHIVE.md`.

Not a proposal. `ctx.idempotencyKey` is read off the `idempotency-key` header
(`junction/src/core/app.ts:1154`), declared on the request-metadata type
(`core/context.ts:208`), and **read by nothing**. A double-submitted create runs
twice while carrying the header that says it must not.

The sharp part is the asymmetry: **Conduit sends `Idempotency-Key` outbound and
treats its presence as license to retry a non-idempotent POST**
(`conduit/src/transports/http.ts:79` and `:159`). FJS asks other people's APIs
for a guarantee that FJS's own API accepts the header for and does not honor.

The fix has the same shape as the rest of this file — a declaration, not a
library. A service, or a model, states that its writes are replayable; the
framework stores `(key, route, response)` for a window and replays instead of
re-executing. `<Form>` already refuses a second submit while one is in flight,
which covers the fast double-click and covers nothing else: a retry after a
dropped socket is exactly the case the key exists for, and it is the case a
client cannot fix.

## Sequencing

1. ~~**`FJS-088`**~~ — inert plumbing that read as a feature. **Done 2026-08-13.**
2. ~~**`@version`**~~ — the one that makes a correct app wrong under load.
   **Done 2026-08-06.** Adoption is uneven and worth knowing before item 3 is
   argued from the same apps: `basecamp` declares it on seven models and
   `example` on none.
3. **`@scale(n)`** — the one a real schema needs 95 times, and the one whose
   absence is silent: a float column feeding a number a machine then acts on.
   **`@money` is a separate step ON it and is not the way in**, which is the
   2026-08-24 revision: building money first gives a feature that cannot express
   88 of those 95 columns. Lead the case with multiplication, comparison and the
   JS boundary — **not** with `SUM`, which the 2026-08-25 measurement took away.
4. **Bitemporality** — small, low urgency. Nothing in the tree wants it yet:
   `occurredAt` appears only inside the OpenMRP fixture, which is outside
   evidence that a real schema reaches for it and no migration debt here.
5. **The process noun** — needs a design, not an attribute. Do not start it
   with the other four.

## Why this is worth doing

Every one of these is a category where the application layer is currently
trusted to be careful, and `CLAUDE.md`'s own hazard list is the evidence for how
that goes. The framework's best properties — a gate you cannot run without, a
compiler-derived watch set, batched includes with no N+1 possible — are all
cases where being careful stopped being necessary. These are four more.

The counter-argument, which should be taken seriously: **every attribute added
to `.lite` is a word in a language a newcomer has to learn**, and the language
is already large. `@scale` and `@version` pay for themselves in one sentence
each, and `@money` pays for itself only because the currency carries the scale. Bitemporality does not, and should probably wait for a second app that
wants it.

## Relationship to the other files

- `time-travel.md` — bitemporality is what makes `db:restore` unambiguous about
  which clock it rewinds.
- `scoped-sql.md` — the derived shape is a **`view`** (`FJS-D46` coined
  *Projection* for it and was withdrawn 2026-09-04; the keyword had shipped),
  and a scaled column's storage encoding has to survive it. It is the same
  question as *changing `n` rescales every row*, asked one layer up: a view over
  a scaled column has to know the scale, or it reads the stored integer as the
  value.
- `state-machines.md` — `@@transitions`, the field-level half of item 4.
- `compliance-from-the-seed.md` — the same argument (`@pii`/`@retain`) applied
  to a category this file does not cover.
- `time-and-recurrence.md` — item 3 arrives there from the other direction. This
  file asks *which clock does a row record*; that one asks *what kind of time is
  this column*, and they are the same question. **Settle them together**, or one
  will fix a vocabulary the other has to live inside.
