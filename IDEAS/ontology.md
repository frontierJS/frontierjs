---
id: ontology
status: proposed
dated: 2026-09-21
---

# Idea — the modeling tree: what kind of thing is this, and the one cell with no word in it

**Status: IDEA. Nothing here is built.** Dated 2026-09-21. The tree is authored
and the evidence under § *Three safe shapes* is read off the tree on that date.
Do not cite this file as describing behavior — see `VERIFYING.md`.

It came out of a stress-test question that had no answer in any document here:

> *What owns a thing that must happen later, exactly once, at a time derived
> from another row's time in a third party's zone?*

The answer turned out to be **three answers, all of them already implemented in
`example`, none of them named anywhere**. That is the finding, and it is another
instance of the class `overview.md`'s fourth pass identified: not a capability
FJS lacks, a **declaration** FJS lacks for a capability it already has.

---

## 1. The question has a name, and the name is old

*A thing that must happen later* is one of the oldest modeled entities there is,
and every tradition that named it named the same thing.

| Tradition | The word | Worth reading for |
| --- | --- | --- |
| REA accounting ontology (McCarthy 1982; ISO/IEC 15944-4) | **Commitment** — a promise to execute an economic event in future | The full set is Resource · Event · Agent · Commitment · Contract · Claim, and the *commitment* half is what distinguishes it from every event-only model |
| Deontic logic | **Obligation** | Permission, prohibition and obligation are one triad. Access control took permission and prohibition; nothing took the third |
| David Hay, *Data Model Patterns* | **Activity** against **Activity-Occurrence** | The planned/actual split, which is the distinction the question is really about |
| Len Silverston, *The Data Model Resource Book* | **Agreement** and **Work Effort** | Industry-tested universal models; the commitment lives on the agreement |
| Arlow & Neustadt, *Enterprise Patterns and MDA* | **Order** as the commitment archetype | The most directly reusable set — Party, Product, Order, Inventory, Rule, Money, Quantity |
| Martin Fowler, *Analysis Patterns* + Temporal Patterns | Effectivity · Temporal Property · Bitemporal | The time half, and where `declared-semantics.md` §3 already points |
| DDD / durable execution | **Saga timeout**, **process manager**, **durable timer** | Temporal.io and Azure Durable Functions both make the timer a first-class persisted thing rather than a queue entry |
| BPMN | **timer intermediate catch event**, boundary timer | *24 hours before X* is drawn, not coded |
| Accounting and law, pre-computer | **tickler file** · **bring-forward** · **diary date** | A physical box of dated cards. The oldest correct implementation of shape 1 below |
| RFC 5545 (iCalendar) | `VEVENT` · `VALARM` with `TRIGGER;RELATED=START` | **The one to actually read.** It already solves the exact sentence: a trigger derived from another component's time, in a stated zone, with once-ness under recurrence (`RECURRENCE-ID`, `EXDATE`) and the floating/UTC/zoned three-way |

`time-and-recurrence.md` § *Prior art* already carries the time taxonomy and the
recurrence verdict — Temporal's six kinds, and why the general `RRULE` is refused.
**That is the other axis and it is not restated here.** What that record does not
carry is a noun for the obligation itself; it settles what a COLUMN holds and says
nothing about what a ROW is.

**Commitment is the word with the strongest claim, and it carries a risk this repo
has already been bitten by once.** `time-and-recurrence.md`'s own lesson from
`FJS-522` is that *a vocabulary that borrows a standard's word inherits the
standard's meaning*. REA's Commitment is specifically economic — one half of a
reciprocal exchange, with a Claim on the other side. A reminder email is not that.
Borrowing the word imports a duality that most commitments here do not have, and
the question is in § Open questions rather than settled in this sentence.

---

## 2. Three safe shapes, all of them in the tree, none of them named

Read off `example/api/src/jobs/` and `example/db/schema.lite` on 2026-09-21.
Every one of these was paid for by a defect and each carries its reasoning in a
header comment of its own. **They do not agree with each other, and they are all
correct** — which is the thing a reader cannot possibly know.

**Shape 1 — the read is the truth.** No scheduler participates in correctness at
all. `StockReservation.expiresAt` is filtered by every availability sum, so a hold
is dead the instant it passes whether or not anything ran; `release-holds` deletes
the rows and is explicitly housekeeping. The column's own comment in
`db/schema.lite` states the rule in a sentence the framework should own:
*correctness must not depend on a cron having fired, because then a queue outage
quietly stops the shop selling.*

**Shape 2 — idempotent re-derivation.** A sweep recomputes the verdict from
immutable columns on every run and applies a declared transition that is a no-op
the second time. `dun-subscriptions` derives the deadline as the days from an
`@immutable` `dueOn` to the shop's today, on the oldest unpaid invoice, and moves
`lapse` / `cancel` / `recover`. It needs no key of any kind, and its comment says
why the obvious `failedAttempts` counter is the bug: *a counter is a second answer
to a question the invoices already answer.*

**Shape 3 — keyed dispatch.** The effect is external and not repeatable — an
invoice, a charge, a message — so the sweep mints
`occurrenceKey('renew', subscriptionId, periodEnd)` and `dispatch({ id })` makes
it once for all time. `renew-subscriptions` finds what is due and dispatches one
`renew-subscription` per row, and the split is stated: a sweep that billed inline
would be one long transaction whose failure halfway leaves half a shop billed.

**What picks among the three is one question and it is not the one people ask.**
Not *how do I schedule this* — **is the effect inside the database, and is doing
it twice the same as doing it once?** Inside and repeatable is shape 1 or 2.
Outside, or not repeatable, is shape 3 and nothing else will do.

**The zone half is answered the same way three times and the answer is a dodge
that works.** Every sweep here runs HOURLY rather than daily, because a period
ends on a day in the shop's calendar and a fixed UTC hour bills one zone the
evening before and another most of a day late. That is correct for a day-granular
obligation and it does not reach *09:00 in the customer's zone*, which still has
no expressible form — the zoned wall-clock column `time-and-recurrence.md` leaves
open is the same gap seen from the row instead of the column.

### What is actually missing

- **Nothing names the three shapes**, so choosing between them is a thing each
  developer rediscovers. The knowledge exists as prose headers in individual job
  files in one app, which is the least findable place it could be.
- **`basecamp` uses none of them.** No `occurrenceKey` anywhere in its API, and
  `alert-evaluate` runs every minute. Whether that is right is not knowable from
  outside the file, which is the point.
- **A fourth shape has no instance here at all: a commitment a person can SEE.**
  *What is going to happen to this order, and when* cannot be answered by any
  sweep, because nothing exists until the sweep runs. That is the case where a
  materialized row earns itself, and no screen in this repo has ever asked for it.
- **A sweep cannot be graded.** Nothing checks that the thing filtered on
  `expiresAt` is filtered on it everywhere, which is shape 1's entire correctness
  condition.

---

## 3. The tree

The three shapes above are one branch of a larger question the `discovery` skill
asks in prose and no document draws: **given a sentence a client said, what kind
of thing is it?** The top fork is the oldest one in ontology — BFO's
*continuant* against *occurrent*, a thing that persists against a thing that
happens — and every leaf below terminates in a construct `.lite` already has.

```
does it PERSIST, or does it HAPPEN?
│
├─ persists — a continuant
│  ├─ a party, and can one human be two of them at once?
│  │        → model + identity shape: a level on the ladder, a membership row,
│  │          or a capability set. The three do not convert into one another
│  ├─ a thing, a place, a document          → model
│  ├─ a value AT AN INSTANT                 → a copied column, never a join
│  ├─ true only for a span                  → a window: validFrom/validTo plus
│  │                                          a partial unique on the open row
│  └─ a measurement, a quantity, money      → @money, /units, @scale
│
└─ happens — an occurrent
   ├─ already happened   → append-only record: immutable, retained, audited
   ├─ happening now      → a named move on @@transitions, if the business has
   │                       a word for it. A word means a move; no word means
   │                       a column
   └─ MUST HAPPEN LATER  → the branch above
      ├─ is the effect inside the database?
      │    yes, and repeatable  → shape 1: the read is the truth
      │    yes, and derivable   → shape 2: idempotent re-derivation
      │    no                   → shape 3: keyed dispatch
      ├─ who set the time?   a clock · another row · an event · a recurrence
      ├─ whose zone?         the app's · the row's · the viewer's · the tenant's
      │                      (ruled: all three of the last, FJS-D143)
      └─ must a person SEE it before it happens?
           yes → it is a row, not a queue entry. No instance in this tree
```

**Four of these forks are already the `discovery` skill's and are cited rather
than restated** — the identity shape, the copied value, the window, and *a word means
a move*. What the tree adds is the ORDER and the top fork; what it adds that is
new is the whole right-hand branch.

**Prior art for the tree itself**, best first — each is a different answer to
*what are the core entities of an information system*:

- **Event Storming** (Brandolini) — Event · Command · Actor · Policy · Read Model
  · External System · Aggregate. The closest thing to a working version of this
  that exists, and its *Policy* — whenever X then Y — with a timer on it is
  exactly the branch above.
- **BFO**, continuant against occurrent — the top fork, and the reason it is the
  top fork.
- **Bunge-Wand-Weber** — the academic answer to this literal question: thing,
  property, state, event, law. Dry and rigorous.
- **Zachman** — the six interrogatives as a spine. Good frame, no content.
- **Sowa**, *Knowledge Representation* — the twelve-category lattice.
- **Object Role Modeling** (Halpin) — fact-based, and the elicitation method
  rather than the taxonomy: verbalize, then model.

---

## 4. Where it would live

**Not as a new document to read.** A tree that is only prose is `discovery`'s
material a second time, which is the origin question failing.

- **`discovery`** gets the spine and the order of asking, and loses nothing —
  its four forks are leaves of this one. It is an agent skill outside this tree
  rather than a repo asset, which is why nothing here cites it by path.
- **`oracle`** gets the knowledge base. Recognizing *what kind of thing is this*
  is the package's entire stated job, and `oracle-reasoning.md` §1's ladder —
  derived beats variant beats novel — runs over each leaf rather than beside it.
  V2-deferred (`FJS-D14`), so this costs nothing now and is the reason to write
  the tree down before the tool exists.
- **`fli intent`** already resolves a customer's words against a seed
  (`packages/cli/core/intent.js`). The tree is what it would classify INTO when
  the seed has no candidate, which is the case `intent-recognizer.md` records as
  the interesting finding — *this fact has nowhere to live yet*.
- **`VOCABULARY.md`** takes the noun, if the noun is coined.

---

## 5. The nine, answered before the first edit

- **Another origin?** No, with a constraint that is load-bearing: the tree's
  left-hand branches CITE `discovery` and `time-and-recurrence.md` and must never
  restate them. The right-hand branch is new material.
- **Concept budget?** One noun, for a cell that currently has none. Every other
  leaf terminates in a word `.lite` already has.
- **Whose complexity?** The problem's. A deferred obligation is in every booking,
  billing and dunning system written.
- **Predictability?** Improves — three shapes exist and nothing says which is
  which, so today a reader cannot predict the next job file from the last one.
- **Derived, not restated?** The finding itself: a due time derived from a row is
  derived state, so a queue entry holding a copy is a cache that goes stale when
  the row moves. All three shapes in the tree re-derive; none caches. The tree
  itself is judgment and cannot be derived.
- **One owner, and does it exist?** Caravan owns the clock (`FJS-D36`) and stays
  the executor. *When is this due* has no owner; it is derived from a row, which
  by Invariant 6's logic puts it in the Data realm. Checked against the bridge
  index key list — no existing seam answers it.
- **Boundary explicit?** Not yet. That is the open question rather than an
  assumption.
- **Failure proportional?** A doubled charge or a reminder never sent is a
  real-world cost, so the boundary refuses rather than warns.
- **Wrong without anything saying so — what artefact?** Today, **yes and
  silently**, which is the whole finding: nothing grades that shape 1's filter is
  applied everywhere, and nothing notices a fourth job file inventing a fourth
  shape. For this paper the artefact is **none** — an assessment is gated by
  nothing, and the tree becomes checkable only where it lands in `discovery`,
  `oracle`, or a `fli check` rule.

**Adjudication in tension** (§ IV): *familiarity vs. precision*, over the name —
REA's word arrives with REA's economic duality attached. *Batteries vs.
smallness* if the noun becomes machinery: it must be severable, one seam, and
Caravan must keep the clock.

**Tier** (§ VII): Assessment. Dated, statused, never cited as behavior.

---

## Open questions

- **Does a deferred obligation get a noun in FJS, and is it a Data-realm one?**
  The three shapes exist and are unnamed; the question is whether naming them is
  a document or a declaration.
  - **A** — No noun. The three shapes become a section of `data-hazards` and a
    `fli check` rule that grades a new job file against them. Cheapest, and it
    leaves the fourth shape — a commitment a person can see — unexpressible.
  - **B** — An API-realm option: caravan grows `dispatch({ at, timeZone })` and a
    row-watch. Small, and wrong-homed — a due time derived from a row is Data,
    and a job option is invisible to the gate, the audit trail and `fli check`.
  - **C** — A Data-realm declaration: the model states its own obligation, the
    schema derives the due time, `occurrenceKey` becomes the once-ness, and
    Caravan executes exactly as it does now. Pays for the fourth shape for free,
    since a declared commitment is a thing a screen can read.
  - **Recommend C** — the three existing implementations all re-derive from the
    row, which is the Data realm doing the work already; and the one shape with
    no instance in the tree is the one only a declaration can give. But the
    spelling waits on a second caller, the way `FJS-D143` waited.
- **If it is coined, is the word `Commitment`?** REA's, and business people say
  it. Against: REA's is economic and half of a reciprocal pair, which is the
  `timestamptz` failure in vocabulary form. `Obligation` is the deontic word and
  reads legal. `Due` is small and collides with a column name. `Tickler` is the
  oldest and unsearchable.
- **Does the tree ship as a skill, as `oracle`'s knowledge base, or as neither?**
  Its left half is `discovery` already, so a skill would be a second copy of four
  forks; its right half has no home at all.
- **What grades shape 1?** *Every read filters on this instant* is the entire
  correctness condition of the pattern most used here, and nothing checks it. A
  `fli check` rule over a column carrying the obligation attribute is plausible
  and has never been tried.

---

## See also

- `IDEAS/time-and-recurrence.md` — the other axis: what kind of time a COLUMN
  holds, the zone question ruled three ways (`FJS-D143`), and why the general
  `RRULE` is refused
- `IDEAS/declared-semantics.md` §3 — bitemporality; §4's resumable process is the
  sibling remainder
- `IDEAS/oracle-reasoning.md` — the recognizer's ladder, which this tree would
  run under
- `IDEAS/intent-recognizer.md` — a customer's words against a seed, and the
  *nowhere to live yet* verdict this classifies
- `IDEAS/state-machines.md` — the *happening now* leaf
- `example/api/src/jobs/` — the three shapes, each with its reasoning in its own
  header. `release-holds`, `dun-subscriptions`, `renew-subscriptions`
- `packages/toolbelt/src/history/history.js` — `occurrenceKey`, shape 3's once-ness
