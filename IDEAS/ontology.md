---
id: ontology
status: proposed
dated: 2026-09-21
---

# Idea — the modeling tree: what kind of thing is this, and the one cell with no word in it

**Status: IDEA. All eight steps of § 6 are built (`@@commitment` in litestone, `commitments()` in junction, four adopters in `example`, the date on screen, and `fli check`'s `commitment-swept`).** Dated 2026-09-21. The tree is authored
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
is dead the instant it passes whether or not anything ran; `holds-release` deletes
the rows and is explicitly housekeeping. The column's own comment in
`db/schema.lite` states the rule in a sentence the framework should own:
*correctness must not depend on a cron having fired, because then a queue outage
quietly stops the shop selling.*

**Shape 2 — idempotent re-derivation.** A sweep recomputes the verdict from
immutable columns on every run and applies a declared transition that is a no-op
the second time. `subscriptions-dun` derives the deadline as the days from an
`@immutable` `dueOn` to the shop's today, on the oldest unpaid invoice, and moves
`lapse` / `cancel` / `recover`. It needs no key of any kind, and its comment says
why the obvious `failedAttempts` counter is the bug: *a counter is a second answer
to a question the invoices already answer.*

**Shape 3 — keyed dispatch.** The effect is external and not repeatable — an
invoice, a charge, a message — so the sweep mints
`occurrenceKey('renew', subscriptionId, periodEnd)` and `dispatch({ id })` makes
it once for all time. `subscriptions-renew` finds what is due and dispatches one
`subscription-renew` per row, and the split is stated: a sweep that billed inline
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
- **A fourth shape — a commitment a person can SEE — had exactly one instance
  and it was broken** ([`FJS-1241`](../ISSUES_ARCHIVE.md#fjs-1241), closed by reading
  caravan's `nextRuns()` rather than storing a column). *What is going to
  happen to this order, and when* cannot be answered by any sweep, because
  nothing exists until the sweep runs. `basecamp`'s jobs screen asks it anyway:
  `Job.nextRunAt` is rendered as *Next run*, is set once on create to
  `now + 60s` by a line whose own comment calls it a placeholder, and is never
  written again by anything. So the one place in this repo that needed the
  fourth shape invented a column and filled it with a guess — which is the
  evidence for the branch rather than a counter-example to it, and it is what
  the `no instance` sentence here said before the tree was grepped.
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
│  ├─ a RELATIONSHIP that is itself a thing → a relator: a model whose
│  │          identity is its relata, and whose repeatability is the
│  │          declaration. Repeat bounded by nothing means it HAPPENS
│  │          instead, and belongs on the right-hand branch
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
  Oracle is being rebuilt (`FJS-D600`), so the tree is written down first and
  the rebuild reads it.
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

## 6. Build order

**Ruled 2026-09-22; all eight steps built.** `FJS-D353` (a commitment is a transition the
system owes at a time), `FJS-D354` (`@@commitment`), `FJS-D355` (offsets are a
literal or an `@immutable @unit` column of the same row) and `FJS-D356`
(model-level). Each step below lands on its own, proves the one before it, and
names the open question it waits on. **Steps 1 → 2 → 3 are the critical path**;
after 3 the pipe is proved end to end and each later step deletes one
hand-written job.

**Side fix, independent of all of it:** [`FJS-1241`](../ISSUES_ARCHIVE.md#fjs-1241)
closes by basecamp reading `app.jobs.nextRuns()`
(`packages/caravan/src/cron.ts`) instead of the `nextRunAt` column it guesses
once. A cron's next run is Caravan's answer and not a commitment.

**Step 1 — Litestone: the declaration, no clock.** Template: `@@expires`,
shipped the same day (`FJS-D351`/`FJS-D352`) across `src/core/parser.js`
(`case 'expires'`), `client.js`, `schema-maps.js`, `catalog.js`,
`jsonschema.js`, `index.d.ts`, `tools/typegen.js`, `tools/eject.js`,
`mutate.js`, `testing.js`, with `test/effective.test.ts` as the test shape.
- Parse `@@commitment(<transition>, on: <expr>, while: <pred>)`, own-model
  transitions only (a related target is step 4's, `FJS-D362`). `on:` is a
  time column, optionally `+`/`-` a duration literal or a same-row column;
  `while:` reuses `@frontierjs/toolbelt/predicate`
- Refuse: a transition `@@transitions` does not declare; an `on:` that is not
  a time kind; an offset column with no duration `@unit` or not `@immutable`;
  `mo`/`yr` added to an instant (legal on a day kind)
- The read — *which rows are due by T* — one query per declaration with the
  transition's from-state in the WHERE, at the injected clock exactly as
  `@@expires` reads it; a day kind takes its zone as a parameter (`FJS-D143`)
- `x-commitments` beside `x-transitions` in the JSON Schema; typegen,
  catalog, reference and assistant snapshots; eject; mutate
- Proof: the litestone suite with deadlines staged by `env.clock.advance()`,
  the DDL byte-identical with and without the attribute, and every snapshot
  regenerated from its own header's command

  **Built 2026-09-22** (`packages/litestone/CHANGES.md`). The read is
  `db.<model>.due({ by, timeZone, transition, where })` →
  `[{ transition, id, dueAt }]`, through `findMany`; step 2's fire re-asks it
  with `where: { id }`. Three departures from the list above: the toolbelt
  lexer had no `+` and learned `PLUS`/`MINUS`; `eject` promotes edges and
  prints no model attributes, so it was not touched; and `mutate` gains no
  operator until a derived check could notice a commitment dropped. A
  `$commitments` listing for the generic sweep is step 2's to add.

**Step 2 — Junction: the `commitments()` plugin.** Ruled B, `FJS-D358`. Template: the `outbox()`
plugin, `packages/junction/src/plugins/outbox/index.ts`.
- `requires: ['caravan']`; a schema declaring `@@commitment` with the plugin
  absent is refused at boot
- ONE `app.jobs.schedule(…)` (`packages/caravan/src/index.ts`) and never a
  `setInterval` — `FJS-D36`. A tick dispatches `commitment:fire` per row due
  within a lookahead, with a `delay` to its time, keyed on (declaration, id,
  dueAt); under `strategy database` it walks every tenant, as `outboxPass` does
- The fire re-derives `on:` and `while:`, then makes the transition as system;
  a from-state that no longer holds is a quiet no-op
- `$tapEvents` on a declaring model kicks that row after a write;
  `app.registerMetricsSource('commitments', …)`
- **Probe first — which path makes the transition.** Through the owning
  service's method when the app wrote one (`orders.pay`), service hooks run,
  so a hook's `ctx.enqueue` rides the transition's transaction and an effect
  outside the database happens once. Through `db.x.transition()` only the
  announcement fires — junction already announces it as `orders:pay`
  (`src/core/litestone.ts`, the `e.event === 'transition'` branch) — and an
  observer cannot enqueue inside the transaction. Lean: the service method
  when one exists, `db` otherwise, which is `FJS-D258`'s one-execution-path
  clause
- Proof: junction tests against a REAL Caravan and a REAL Litestone client

  **Built 2026-09-22** (`packages/junction/CHANGES.md`). `commitments()` at
  `@frontierjs/junction/commitments`; `db.$commitments` in litestone is the
  listing it walks. Four departures from the list above, each measured:
  - **The probe refused the service path.** `example`'s `subscriptions.cancel`
    sets `cancelAtPeriodEnd` while its `cancel` transition cancels now, so
    routing a fire by name would have done the other thing. The fire always
    moves through `db.<model>.transition(id, name, { system: true })` — which
    leaves an effect that must ride the move's transaction (step 4's
    `recover`, step 6's invoice on `close`) without a home yet; that is the
    reactions question, not this plugin's
  - **"As system" is read as `FJS-D150`, not `asSystem()`.** `asSystem()`
    bypasses `@@transitions` whole — no from-state in the WHERE, no
    `transition` event — so it would remove the lock `FJS-D353` gets once-ness
    from. The fire READS as system and MOVES on the job's client, scoped to
    `createApp({ system })`; a gate that principal does not clear fails the fire
  - **The key is caravan's `unique`, not a stated `id`.** A row held by
    `while:` and released comes due at the SAME time, and an id is idempotent
    for all time
  - **No kick on write.** A minute cron with a five-minute lookahead and a
    delay to each row's time bounds lateness to a due time inside the first
    minute after a write; the kick waits for a caller that needs better. The
    plugin-absent refusal is `check-authoring`, which asks `app.db` or the
    tenant registry's parsed schema
  Proof: `packages/caravan/test/commitments.test.ts`, 13 tests, beside
  `outbox-relay.test.ts` for its reason; swapping the move back to `asSystem()`
  and the key back to `id` each turn one red.

**Step 3 — first adopter, `Order` in `example`.** Own model, literal offset,
no external effect: the smallest case that runs every piece.
- Add `abandon: pending -> cancelled @system` and
  `@@commitment(abandon, on: createdAt + 14d)`; delete
  `api/src/jobs/abandoned-orders-sweep.job.ts` and `ABANDON_AFTER_DAYS`
- Regenerate example's snapshots; run what `fli proves` names

  **Built 2026-09-22** (`example/CHANGES.md`). Three things the list did not
  name:
  - **The screens.** `x-transitions` carries `abandon` to the browser, where it
    rendered as a disabled button on every pending order. The orders screens
    now leave out `@system` moves. Step 5 is where one comes back, as a date
    rather than a button
  - **The refusal missed the adopter.** `example` is `strategy database`, so
    it has no `app.db`, and it booted with the plugin removed. The refusal now
    also reads the registry's parsed schema
  - **The audit trail did not name the move** (`FJS-1294`, closed). The
    reason `FJS-D353` gives for `abandon` being its own transition held for
    the announcement and not for the audit row. The trail now carries a
    `transition` column
  Proof: `verify:jobs` ages one of two fresh orders in the shop's file and
  runs the sweep, 12 assertions; `verify` 66 and `verify:ui` 35 for the
  screens. Each goes red when its piece is removed.

**Step 4 — dunning.** *May a commitment make a transition on a RELATED
model?* is answered (`FJS-D362`, A), and so is *Where does `recover` live?*
(`FJS-D363`, A). Unblocked.
- Add `graceDays` and `dunningDays` (`Int @unit(d) @immutable`) to `Invoice`,
  stamped in `domain/billing/billing.ts` beside `dueOn`; `GRACE_DAYS` and
  `DUNNING_DAYS` become the values stamped. Pre-alpha: no upgrade steps
- `@@commitment(subscription.lapse, on: dueOn + graceDays, while: status == issued)`
  and the same for `subscription.cancel`; delete
  `api/src/jobs/subscriptions-dun.job.ts`
- **Trap:** that job also runs `recover` (`pastDue -> active` once paid). That
  is a reaction and not a commitment. It moves first, to `recoverIfClear` in
  `domain/billing/billing.ts`, called from `settleInvoice` and a new
  `voidInvoice` (`FJS-D363`), and the job goes after

  **Built 2026-09-23** (`packages/litestone/CHANGES.md`,
  `packages/junction/CHANGES.md`, `example/CHANGES.md`). Two things the list
  did not name:
  - **`due()` asks the TARGET's from-state**, as a relation filter. Leaving it
    to the fire would have been enough for the case the ruling names, but not
    for the one after it: an unpaid invoice under a subscription already
    cancelled would be due on every sweep, forever, as a fire into a refused
    move. `due()` answers a `target` on every row, so the fire has one path
  - **The zone.** `dueOn` is a day, and the sweep read every day in UTC and
    delayed each fire to UTC midnight, where the job it replaced read the
    shop's calendar. `commitments({ timeZone })` takes a zone or an async
    `(tenant) => zone`, and `example` loads the shop's
  The staff settle recovered through the subscription's existing update policy,
  so `FJS-D363`'s condition held with nothing widened. Proof: litestone
  `test/commitment.test.ts`; caravan `test/commitments.test.ts`, 18, where
  removing the target filter and delaying to UTC midnight each turn one red;
  `verify:billing` 38 with no job run; `verify:jobs` 15, whose dunning section
  goes red when the filter is removed.

**Step 5 — shape 4 on screen.** Sierra and `@frontierjs/ui` read
`x-commitments`: *Will be abandoned on 5 Oct* on the order screen, *Lapses on …*
on the subscription screen. The first thing a person sees; proof is the drive
`fli proves` names.

  **Built 2026-09-23** (`packages/toolbelt/CHANGES.md`,
  `packages/litestone/CHANGES.md`, `packages/sierra/CHANGES.md`,
  `example/CHANGES.md`). Sierra alone: `@frontierjs/ui` needed nothing, since a
  date is a `StatCard` or an `Alert`. Three things the line did not name:
  - **The date has one owner at both ends.** Litestone's JS `dueAt` moved to
    `@frontierjs/toolbelt/datetime`; `due()` and the screen call the same
    function, and the SQL half is still graded against it
  - **`x-commitments` carries the move** — `target`, `field`, `from` — because
    *is it still owed* is a question about the row the move is made on, which
    for `subscription.lapse` is in another model's document. The screen passes
    that row as `{ target }`; one it did not read is not graded
  - **The invoice screen is the third.** The commitment is declared there, and
    it is where a subscription already lapsed by an older invoice has to stop
    claiming a lapse
  Proof: sierra `test/resource-commitments.test.js`, 13; `verify` 70, four of
  them new, computing the dates in node without the function under test.
  `verify:build` is held by the offline shell budget, of which this is 1 kB.

**Step 6 — renewal as a row per period.** Waits on *Renewal is not a
transition* (recommend A). `SubscriptionPeriod` with
`close: open -> closed @system` and `@@commitment(close, on: endsOn)`; a hook
on `close` issues the invoice and opens the next period; the renewal sweep
job goes and `occurrenceKey` leaves renewal. The largest reshape of
`example`, so it goes last among the steps with a caller.

  **Built 2026-09-23** (`packages/junction/CHANGES.md`, `example/CHANGES.md`),
  after `FJS-D367` answered *Renewal is not a transition* A and `FJS-D368`
  answered where the close's effect runs. Three things the line did not name:
  - **The hook is the plugin's, not a service's.** The fire was a bare
    `transition()` and an announcement is held until the commit, so
    `commitments({ hooks })` runs `renewPeriod` after the move inside one
    `$transaction` on the fire's client, with `afterCommit` for the collection.
    The plugin still makes the move, so the from-state lock stays its own
  - **The window is derived.** `Subscription.currentPeriodStart`/`End` are
    `@from` the latest period, and `@@unique([subscriptionId], where: status ==
    'open')` refuses a second open period at the database
  - **A drive with no app fires the real path.** `fireCommitment` is the fire,
    exported; `verify:billing` hands it the app's own hooks, so there is no
    renewal function a drive calls that the queue does not
  Proof: caravan `test/commitments.test.ts`, 22, where running the hook outside
  the transaction turns one red; `verify:billing` 39, seven red when the next
  period is not opened; `verify:jobs` 17, whose renewal section goes red with
  the hook removed from the app; `verify:collect` 49 across the whole chain.

**Step 7 — reminders.** Waits on *Is a reminder a transition?* (recommend A, a
transition on a Boolean column) **and on a caller** — nothing in the tree
sends one, so it waits the way `FJS-D143` waited for a second caller.

  **Built 2026-09-23** (`packages/litestone/CHANGES.md`,
  `packages/junction/CHANGES.md`, `example/CHANGES.md`), after `FJS-D370`
  answered A. The caller is `example`'s own: an invoice reminds its customer
  three days before `dueOn`, while it is `issued`. Two things the line did not
  name:
  - **A second machine did not parse** (`FJS-1315`). The runtime keeps one per
    field, and `FJS-1174`'s refusal of an attribute declared twice caught a
    second `@@transitions` anyway. Repeatable again, per field, with one move
    name on two machines refused
  - **The hook enqueues.** `afterCommit` loses the email to a crash after the
    commit, with `reminded` already true and the row never due again, so the
    hook context gained `enqueue`: an outbox row on the move's transaction
  Proof: `verify:jobs` 19, its reminder section read off the real mail sink and
  red with the hook removed; `verify` 70, whose invoice dates include the
  reminder; litestone `test/commitment.test.ts` and caravan
  `test/commitments.test.ts`, each red when its half is removed.

**Step 8 — closing the silence.** A `fli check` rule: a hand-written job
sweeping a model that declares `@@commitment` is a finding. A `data-hazards`
section on *the window is the truth for reads, the transition is the record*.
An `invariants` row if an enforcer lands.

  **Built 2026-09-23** (`packages/cli/CHANGES.md`). `commitment-swept`, an app
  warning: a `*.job.*` file naming a declaring model and making its committed
  move. Two things the line did not name:
  - **The move has three spellings.** The sweep `abandon` replaced made
    `cancel`, another move from `pending` into `cancelled`, so a rule on the
    move's name would not have seen the one job it exists for. It accepts the
    name, a move of the same model sharing a from-state and the to-state, or
    the to-state
  - **No `invariants` row.** The rule serves none of the nineteen, so it is
    one of the rules guarding a live hazard, which is what `data-hazards`
    § `@@transitions` now states beside the window-against-record argument
  Proof: `test/checks.test.js`, six cases, each of four mutations turning one
  red. Put back into `example`, the jobs steps 3, 4 and 6 deleted are reported
  three of four times; `subscriptions-renew` swept `Subscription`, which the
  period's commitment does not move.

**Every step:** a `CHANGES.md` entry per package touched, the snapshots
regenerated, and `fli done` clean before it is called finished.

---

## Open questions

**Where the argument stands, 2026-09-22.** Four words now sit on this tree and
they answer four different questions about a row. `@@relator` (`FJS-D350`) —
*is this row a link, and can it happen twice*; structure, no clock.
`@@expires` (`FJS-D351`, `FJS-D352`) — *is this row dead yet*; imposed, and the
clock passing writes nothing. `@@effective` (`FJS-D352`) — *was this row in
force at T*; asked, history, and the clock passing writes nothing. And the
proposal below — *what transition does the system owe this row, and when*; the clock
passing makes a WRITE. The line between the last and the two before it is the
whole design: **the clock changing what counts is a window; the clock causing a
transition is a commitment.** A row may carry both on one date — a membership that
stops counting at `endsOn` and is also moved `active -> ended` — and then the
window is the truth for reads and the transition is the record that catches up, which
is shape 1 against shape 2 inside one row. Legal, not refused.

- ~~**What kind of noun is a deferred obligation?**~~ **Answered 2026-09-22 (`FJS-D353`): A — **a commitment is a TRANSITION at a TIME** — the word the code already types (`@@transitions`, `db.x.transition(id, name)`, `x-transitions`), rather than *move*, which is prose's second name for it. The first argument names a transition on `@@transitions`; the model declares when the system owes it: `@@commitment(abandon, on: createdAt + 14d)` beside `abandon: pending -> cancelled @system`. The from-state is the guard, so most `while:` clauses vanish. The optimistic lock is the once-ness, so `occurrenceKey` is not needed wherever the state changes. A transition is a write, so firing ANNOUNCES — the silent-expiry gap (`FJS-1274`) does not exist for it — and the audit trail records the transition by name, which is why `abandon` is its own transition and not `cancel` with a `while:`. `x-transitions` already reaches the browser, so *will be abandoned on 5 Oct* beside the Cancel button is shape 4 read off the schema. An effect OUTSIDE the database stays a hook on the transition, as `IDEAS/state-machines.md` settled (*side effects stayed hooks; the machine runs no jobs*), and a hook's `ctx.enqueue` rides the transition's own transaction through the outbox, so it happens once per transition. The schema names no job. A transition fired by a commitment whose from-state no longer holds is a quiet no-op, since that is the once-ness working; a caller's transition from the wrong state stays an error.** The three shapes and the
  fourth, measured against `@@transitions` rather than against a job file.
  **Shape 2** keeps its deadline nowhere — `subscriptions-dun` reads `dueOn`
  against the shop's today and compares it with two JS constants, `GRACE_DAYS`
  (3) and `DUNNING_DAYS` (21), so one anchor carries two commitments, and both
  consequences (`lapse`, `cancel`) are already declared `@system` transitions on
  `Subscription`. **Shape 4** has no clean instance:
  `FJS-1241`'s `Job.nextRunAt` was a guess, and a cron's
  next run is already Caravan's answer (`app.jobs.nextRuns()`), so that defect
  closed by reading it. What is unowned is *what will happen to THIS row, and
  when*, where the time derives from the row.
  - **A** — **a commitment is a TRANSITION at a TIME** — the word the code already types (`@@transitions`, `db.x.transition(id, name)`, `x-transitions`), rather than *move*, which is prose's second name for it. The first argument names a
    transition on `@@transitions`; the model declares when the system owes it:
    `@@commitment(abandon, on: createdAt + 14d)` beside
    `abandon: pending -> cancelled @system`. The from-state is the guard, so
    most `while:` clauses vanish. The optimistic lock is the once-ness, so
    `occurrenceKey` is not needed wherever the state changes. A transition is a
    write, so firing ANNOUNCES — the silent-expiry gap
    (`FJS-1274`) does not exist for it — and the audit
    trail records the transition by name, which is why `abandon` is its own transition and
    not `cancel` with a `while:`. `x-transitions` already reaches the browser,
    so *will be abandoned on 5 Oct* beside the Cancel button is shape 4 read off
    the schema. An effect OUTSIDE the database stays a hook on the transition, as
    `IDEAS/state-machines.md` settled (*side effects stayed hooks; the machine
    runs no jobs*), and a hook's `ctx.enqueue` rides the transition's own transaction
    through the outbox, so it happens once per transition. The schema names no job. A
    transition fired by a commitment whose from-state no longer holds is a quiet
    no-op, since that is the once-ness working; a caller's transition from the wrong
    state stays an error
  - **B** — a framework-shipped `Commitment { subject, kind, dueAt, state, key }`
    table. Closest to REA; the gate, the audit trail and the visible row come
    free. It fails *derived, not restated* — `dueAt` is a copy of a row's time,
    which is `FJS-1241` made framework-wide — and it is a second owner beside
    Caravan's `jobs.run_at`
  - **C** — a declaration naming a JOB (`run: 'subscription-renew'`). The Data
    realm then names an API-realm file, which Litestone cannot resolve, and a
    rename breaks it silently; it is also a second place a job's trigger is
    written, beside the `cron:` option the job file already owns
  - **D** — no noun. The shapes become a section of `data-hazards` and a
    `fli check` rule over job files. Cheapest, and shape 4 stays inexpressible
  - **Recommend A** — every consequence in the measured shapes is already a
    declared transition, so the noun costs one attribute and no new machinery at the
    Data boundary, and everything a transition already gets — gate, audit, announce,
    `x-transitions` — the commitment inherits. § V: one origin (the model owning
    the time), one noun for an empty cell, derived by construction, Data owns
    *when* and Caravan owns *run*, and the ninth becomes gradeable. Tension is
    *batteries vs. smallness*, bounded by the executor being an ordinary Caravan
    job. Renewal is where it strains, and that is its own question below
- ~~**What is the word?**~~ **Answered 2026-09-22 (`FJS-D354`): B — `@@commitment`. REA's, and business people say it. The objection was REA's reciprocal duality; under A above the word fits better than it did, because REA's commitment is FULFILLED BY AN EVENT and here it is fulfilled by a transition — an invoice's commitment to pay is discharged by `settle`, and breached into `subscription.lapse`. The reminder email is the case the word still strains.**
  - **A** — `@@due`. Small and neutral, imports nothing
  - **B** — `@@commitment`. REA's, and business people say it. The objection
    was REA's reciprocal duality; under A above the word fits better than it
    did, because REA's commitment is FULFILLED BY AN EVENT and here it is
    fulfilled by a transition — an invoice's commitment to pay is discharged by
    `settle`, and breached into `subscription.lapse`. The reminder email is the
    case the word still strains
  - **C** — `@@obligation`. The deontic word; reads legal on a five-minute hold
  - **Recommend B** — the owner's preference, and with the transition as its first
    argument the REA meaning arrives mostly true rather than mostly borrowed
- ~~**Where do the offsets live?**~~ **Answered 2026-09-22 (`FJS-D355`): B — a literal OR a column of the SAME row: `@@commitment(subscription.lapse, on: dueOn + graceDays, while: status == issued)`, where `graceDays Int @unit(d) @immutable` is stamped when the invoice is issued, from wherever the terms come from — the plan, the tenant's config, a negotiated contract. The issuing code already stamps `dueOn` from `TERMS_DAYS` in the same place (`billing.ts`), so this is one more column on a path that exists. It is the tree's own leaf — *a value at an instant is a copied column, never a join* — and the order total's rule: the terms are a receipt. The expression never reads outside its row, so the sweep is one table and the offset is visible to a client as a field. It refuses an offset column without a duration `@unit` (`FJS-D348` gets its first consumer) and one that is not `@immutable`. `mo` and `yr` are legal on a day kind, where a month is calendar arithmetic, and refused on an instant, where it would need a zone the expression does not have.** Five offset constants in the two apps
  (2026-09-22), and they split in two before any option applies. **Stamped**:
  `TERMS_DAYS` (7) computes `Invoice.dueOn` at issue and `HOLD_MINUTES` (20)
  computes `StockReservation.expiresAt` at hold — the offset is part of the
  AGREEMENT, it is written into a column, and changing it must not transition a
  deadline already promised. Those stay where they are, and the column is the
  `on:`. **Policy**: `GRACE_DAYS` (3), `DUNNING_DAYS` (21) and
  `ABANDON_AFTER_DAYS` (14) are read at sweep time, so changing one moves every
  open deadline today. `HOLD_MINUTES` is also served to the browser so the
  basket can say the number the sweep enforces, which is the case for an offset
  a client can read off the schema rather than off a service.
  - **A** — a literal only: `@@commitment(abandon, on: createdAt + 14d)`. The
    constant moves into the schema beside the transition it drives, and
    `generateJsonSchema` can carry it to a client
  - **B** — a literal OR a column of the SAME row:
    `@@commitment(subscription.lapse, on: dueOn + graceDays, while: status == issued)`,
    where `graceDays Int @unit(d) @immutable` is stamped when the invoice is
    issued, from wherever the terms come from — the plan, the tenant's config,
    a negotiated contract. The issuing code already stamps `dueOn` from
    `TERMS_DAYS` in the same place (`billing.ts`), so this is one more column
    on a path that exists. It is the tree's own leaf — *a value at an instant
    is a copied column, never a join* — and the order total's rule: the terms
    are a receipt. The expression never reads outside its row, so the sweep is
    one table and the offset is visible to a client as a field. It refuses an
    offset column without a duration `@unit` (`FJS-D348` gets its first
    consumer) and one that is not `@immutable`. `mo` and `yr` are legal on a
    day kind, where a month is calendar arithmetic, and refused on an instant,
    where it would need a zone the expression does not have
  - **C** — a relation hop: `on: dueOn + subscription.planVersion.graceDays`.
    Terms read LIVE, so editing a plan moves every open invoice's deadline, and
    the sweep compiles a join per declaration
  - **D** — the tenant's config: `on: dueOn + config.graceDays`. Per-shop, no
    join, read live, and the schema names a key the config file must supply
  - **Recommend B** — every source C and D reach is reached by the stamp
    instead, at the one moment the terms were agreed. A is B with the column
    never used. Live terms are the wrong default for anything issued
- ~~**One sweep per declaration, or one generic sweep over all of them?**~~ **Answered 2026-09-23 (`FJS-D358`): B — one generic sweep that reads every declaration and dispatches a keyed wake-up per due row; the executor re-derives `on:` and `while:` and then makes the transition as system, so a wake-up minted before its row moved finds nothing due and does nothing — shape 1's rule applied to shape 3.**
  - **A** — a Caravan cron generated per declaration, at a cadence the
    declaration states. N declarations are N crons
  - **B** — one generic sweep that reads every declaration and dispatches a
    keyed wake-up per due row; the executor re-derives `on:` and `while:` and
    then makes the transition as system, so a wake-up minted before its row moved
    finds nothing due and does nothing — shape 1's rule applied to shape 3
  - **Recommend B** — one cadence, and the re-derivation is what lets a queue
    hold a time without being its owner. **Where it runs**: a Junction plugin,
    `commitments()`, with `requires: ['caravan']` — the `outbox()` shape.
    Litestone declares and answers *which rows are due by T* but has no clock
    and may not dispatch (Invariant 1); Caravan reads no schema. The plugin
    registers ONE `app.jobs.schedule(…)` rather than a `setInterval`, because a
    timer that dispatches into the queue is the queue's schedule (`FJS-D36`). A
    tick dispatches per row due within a lookahead, with a `delay` to its time,
    so the cadence is not the precision; a write to a declaring model kicks
    that row, as a commit kicks the outbox; under `strategy database` a tick
    walks every tenant, as `outboxPass` does. A schema declaring
    `@@commitment` with no `commitments()` installed is refused at boot
- ~~**Renewal is not a transition — what is it?**~~ **Answered 2026-09-23 (`FJS-D367`): A — a row per period: `SubscriptionPeriod` with `close: open -> closed @system` and `@@commitment(close, on: endsOn)`; a hook on `close` issues the invoice and opens the next period. The state machine is the once-ness with no key, and *next renewal* is a row a person can see. The cost is reshaping `example`'s billing.** `Subscription` stays `active` across
  a renewal; only the period rolls. `@@transitions` refuses a self-transition
  (measured: *'renew': self-transition (from and to are both 'active')*), and
  `transition(id, name, { system })` carries no data, so no transition can advance
  `currentPeriodEnd`.
  - **A** — a row per period: `SubscriptionPeriod` with
    `close: open -> closed @system` and `@@commitment(close, on: endsOn)`; a
    hook on `close` issues the invoice and opens the next period. The state
    machine is the once-ness with no key, and *next renewal* is a row a person
    can see. The cost is reshaping `example`'s billing
  - **B** — lift the self-transition refusal. A self-loop has no from-state to
    lock on, so it also needs a key, and transitions would need to carry data — two
    language changes for one case
  - **C** — renewal stays a job that CLAIMS the commitment
    (`defineJob(…, { commitment: 'Subscription.renew' })`), beside `cron:`. The
    direction is right (API names Data), and it reintroduces a second kind of
    effect the transition frame had removed
  - **Recommend A** — the only exit where every commitment is a transition with
    nothing left over, and it is the relator reading of a subscription taken
    one step further: a period is a thing with a start, an end and a state
- ~~**Where does what a commitment's move OWES run?**~~ **Answered 2026-09-23 (`FJS-D368`): A — the app names it on the plugin, keyed by commitment: `commitments({ hooks: { 'SubscriptionPeriod.close': renewPeriod } })`. The fire still re-derives and still makes the move; the hook runs after it inside one `$transaction` on the fire's client, a throw rolls both back, and `afterCommit` carries a dispatch to a queue in another file. A key naming no declared commitment is refused at boot.** A period closing owes an
  invoice and the next period, in the same transaction as the move. The fire is a
  bare `db.<model>.transition()` (step 2), and a litestone announcement is held
  until the commit, so neither has a place for it.
  - **A** — the app names it on the plugin, keyed by commitment:
    `commitments({ hooks: { 'SubscriptionPeriod.close': renewPeriod } })`. The
    fire still re-derives and still makes the move; the hook runs after it inside
    one `$transaction` on the fire's client, a throw rolls both back, and
    `afterCommit` carries a dispatch to a queue in another file. A key naming no
    declared commitment is refused at boot
  - **B** — a litestone plugin's `onAfterWrite`, reacting to `close` on every path
    that makes it. Billing code in the Data layer's client config, and whether it
    runs inside the transaction is unmeasured
  - **C** — an observer on the `subscriptionPeriod:close` announcement dispatches
    a keyed renewal job. After the commit, so a crash between the two loses the
    renewal and nothing re-derives it
  - **D** — keep the renewal sweep beside the period rows. The polling this paper
    exists to remove
  - **Recommend A** — the one path the move is made on is the one path the effect
    rides, and the move stays the plugin's, so the from-state lock `FJS-D353`
    gets once-ness from cannot be forgotten by a hook. Hook tier by `FJS-D06`: it
    may halt the move
- ~~**Is a reminder a transition?**~~ **Answered 2026-09-23 (`FJS-D370`): A — a transition on a Boolean column: `remind: false -> true` on `reminded`, a second `@@transitions` beside the status one (one machine per field), with `@@commitment(remind, on: startsAt - 24h)` and a hook that ENQUEUES the mail on the move's transaction — never `afterCommit`, since a crash between the commit and the send would leave the column saying the mail went, and a moved row is never due again. Once-ness from the column.** *Email 24h before the booking* changes no state.
  - **A** — a transition on a Boolean column: `remind: false -> true` on `reminded`,
    a second `@@transitions` beside the status one (one machine per field),
    with `@@commitment(remind, on: startsAt - 24h)` and a hook that ENQUEUES the
    mail on the move's transaction — never `afterCommit`, since a crash between
    the commit and the send would leave the column saying the mail went, and a
    moved row is never due again. Once-ness from the column
  - **B** — a status state (`booked -> reminded`). Wrong: a reminder is not a
    stage the booking passes through, and it multiplies the enum
  - **C** — not a commitment; notifications grow their own schedule. A second
    clock, which `FJS-D36` refuses
  - **Recommend A** — it keeps *every commitment is a transition* true for the case
    the word fits least, and the Boolean is the record that the mail went
- ~~**Where does `recover` live?**~~ **Answered 2026-09-23 (`FJS-D363`): A — the domain owns it: `recoverIfClear(client, subscriptionId)` beside `unpaidInvoices`, called from `settleInvoice` and from a `voidInvoice` that `void` grows, on the same client inside the same call. Recovery the moment the ledger clears, and one function a reader finds next to the two moves.** `subscriptions-dun.job.ts` makes three moves
  and only two are commitments. `recover` (`pastDue -> active`) is owed when
  the LAST unpaid invoice leaves `issued`, not at a time, and the job finds it
  by reading a clean ledger once a day. Deleting the job in step 4 deletes it,
  and a customer who paid stays `pastDue` for good. Two exits reach it, not one:
  `settle` (one owner, `settleInvoice` in `domain/billing/billing.ts`) and
  `void` (the `invoices` service, a bare transition). The rule is *nothing
  issued remains*, not *this invoice moved*: settling the newer of two unpaid
  invoices recovers nothing
  - **A** — the domain owns it: `recoverIfClear(client, subscriptionId)` beside
    `unpaidInvoices`, called from `settleInvoice` and from a `voidInvoice` that
    `void` grows, on the same client inside the same call. Recovery the moment
    the ledger clears, and one function a reader finds next to the two moves
  - **B** — a junction `after` hook on the `invoices` service's `settle` and
    `void`. Misses every settle that does not go through the service — the
    payment webhook calls `settleInvoice` on the system client
  - **C** — an `orion` flow on `Invoice` reaching `paid` or `void`. The
    reaction's proper territory by *B* of `FJS-D362`'s question, and a
    dependency on a port still in progress for one line of logic
  - **D** — keep a small `subscriptions-recover` sweep. The polling shape this
    paper exists to remove, with a day of latency on the customer who paid
  - **Recommend A** — both exits already have or can have one owner, the check
    is one query, and it needs no word the schema lacks. If a second app wants
    the same reaction, that is the evidence for C
- ~~**May a commitment make a transition on a RELATED model?**~~ **Answered 2026-09-23 (`FJS-D362`): A — yes, through a to-one relation; a null relation (`subscriptionId` is optional) is a quiet skip. The target's own from-state still guards it.**
  `@@commitment(subscription.lapse, …)` on `Invoice` fires a transition on its
  parent.
  - **A** — yes, through a to-one relation; a null relation (`subscriptionId`
    is optional) is a quiet skip. The target's own from-state still guards it
  - **B** — own-model transitions only; `Invoice` grows its own state (`overdue`) and
    the subscription reacts to it. A transition triggered by a transition is a reaction,
    which is `orion`'s territory, and the recovery transition (`pastDue -> active` on
    `settle`) is already that shape
  - **Recommend A** — without it shape 2 needs an aggregate on `Subscription`
    (*the oldest unpaid invoice*); with it, the oldest invoice fires first and
    the later ones meet a transition already made
- ~~**Model-level `@@commitment`, or a modifier inside `@@transitions`?**~~ **Answered 2026-09-22 (`FJS-D356`): A — model-level: `@@commitment(transition, on:, while:)`. Can target a related model's transition, and `@@transitions` stays a plain graph.**
  - **A** — model-level: `@@commitment(transition, on:, while:)`. Can target a
    related model's transition, and `@@transitions` stays a plain graph
  - **B** — a modifier on the edge: `abandon: pending -> cancelled @system
    @after(createdAt + 14d)`. Reads beside the transition it times, and cannot reach
    another model
  - **Recommend A** — B cannot express the dunning case at all
- **Does the tree ship as a skill, as `oracle`'s knowledge base, or as neither?**
  Its left half is `discovery` already, so a skill would be a second copy of four
  forks; its right half has no home at all.
- ~~**What grades shape 1?**~~ **Answered 2026-09-22 (`FJS-D351`, `FJS-D352`):
  nothing has to — `@@expires` makes the filter automatic, so an omitted filter
  becomes a stated `withExpired` rather than a read to be graded.**

---

## See also

- `IDEAS/effective-time.md` — **the deadline half of this file, settled with
  valid time and the zone in one design.** Shape 1's column becomes
  `@@expires` and a history becomes `@@effective(from:, to:)` (`FJS-D352`
  split the two by their default), `asOf` is the directive, and the reason the three could
  not be shipped separately is that expiry alone needs a boolean where valid
  time needs a value. What stays HERE is the NOUN question, which only shape 2
  — an obligation with no column at all — can decide
- `IDEAS/time-and-recurrence.md` — the other axis: what kind of time a COLUMN
  holds, the zone question ruled three ways (`FJS-D143`), and why the general
  `RRULE` is refused
- `IDEAS/declared-semantics.md` §3 — bitemporality; §4's resumable process is the
  sibling remainder
- `IDEAS/oracle-reasoning.md` — the recognizer's ladder, which this tree would
  run under
- `IDEAS/intent-recognizer.md` — a customer's words against a seed, and the
  *nowhere to live yet* verdict this classifies
- `IDEAS/relators.md` — the continuant leaf added above: what a relationship
  that persists is, and why *can this happen twice* is the half of it that
  can be declared
- `IDEAS/state-machines.md` — the *happening now* leaf
- `example/api/src/jobs/` — the three shapes, each with its reasoning in its own
  header. `holds-release`, `subscriptions-dun`, `subscriptions-renew`
- `packages/toolbelt/src/history/history.js` — `occurrenceKey`, shape 3's once-ness
