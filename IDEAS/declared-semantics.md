# Idea — The categories of data the seed should know about

**Status: IDEA — except item 1, which SHIPPED 2026-08-06.** `@version` is built,
tested (21 tests) and documented in `packages/litestone/docs/schema.md`; the
section below is kept as the argument for it, with a note on where the built
thing differs. Items 2–4 are unbuilt, and one item is a live defect with an id
(`FJS-088`). Claims about current behaviour
were read off the source on 2026-08-06 with line numbers named. See `VERIFYING.md`.

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
use on the one path that matters. `price Money(GBP)` is a column that cannot be
added to a float.

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
> the column unfrozen — which is the same "generalise the mechanism, do not add
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

## 2. `Money` — a scalar that is not a float

`Money` appears in `packages/litestone/docs/roadmap.md` and nowhere in the
source. Meanwhile the kitchen-sink app models money as `Float`:

```
price Float          # Product
total Float @gte(0)  # Order
```

Both are money. Both are subject to binary-float error, neither carries a
currency, and `coerceToSchema` will happily cast `"42.5"` into one.

```
price Money           // integer minor units, app default currency
total Money(GBP)      // or pinned
```

- Stored as an INTEGER of minor units. `DateTime` already sets the precedent
  that a declared type gets its own storage encoding (ISO-8601 TEXT), so this
  is a shape litestone already has.
- Arithmetic across mismatched currencies is undefined rather than silently
  wrong.
- Reaches the browser as its own JSON Schema `format`, which means
  `@frontierjs/ui`'s controls can resolve a money input from the schema exactly
  as they now resolve `type="email"` — the seam shipped 2026-08-06.
- **Escape hatch:** `Float` still exists. This is opt-in per column, not a ban.

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

Not a proposal. `ctx.idempotencyKey` is read off the `idempotency-key` header
(`junction/src/core/app.ts:1154`), declared on the request-metadata type
(`core/context.ts:208`), and **read by nothing**. A double-submitted create runs
twice while carrying the header that says it must not.

The sharp part is the asymmetry: **Conduit sends `Idempotency-Key` outbound and
treats its presence as licence to retry a non-idempotent POST**
(`conduit/src/transports/http.ts:79` and `:159`). FJS asks other people's APIs
for a guarantee that FJS's own API accepts the header for and does not honour.

The fix has the same shape as the rest of this file — a declaration, not a
library. A service, or a model, states that its writes are replayable; the
framework stores `(key, route, response)` for a window and replays instead of
re-executing. `<Form>` already refuses a second submit while one is in flight,
which covers the fast double-click and covers nothing else: a retry after a
dropped socket is exactly the case the key exists for, and it is the case a
client cannot fix.

## Sequencing

1. **`FJS-088`** — inert plumbing that reads as a feature. Cheapest, and it is
   a defect rather than a proposal.
2. **`@version`** — the one that makes a correct app wrong under load.
3. **`Money`** — the one most likely to be someone's first surprise, and now
   cheap to carry to the UI because the schema→control seam exists.
4. **Bitemporality** — small, low urgency.
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
is already large. `Money` and `@version` pay for themselves in one sentence
each. Bitemporality does not, and should probably wait for a second app that
wants it.

## Relationship to the other files

- `time-travel.md` — bitemporality is what makes `db:restore` unambiguous about
  which clock it rewinds.
- `scoped-sql.md` — the derived view is a **Projection** (ruled 2026-08-06),
  and a `Money` column's storage encoding has to survive it.
- `state-machines.md` — `@@transitions`, the field-level half of item 4.
- `compliance-from-the-seed.md` — the same argument (`@pii`/`@retain`) applied
  to a category this file does not cover.
