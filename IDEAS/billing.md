---
id: billing
status: partial
dated: 2026-08-30
---

# Idea — subscription billing, in phases

**Status: PARTIAL — phases 0–6 are built, in `example/`; phase 7 (the slice) is
deferred; phase 8 (the instrument) is BUILT — the instrument on file and
cancel-at-period-end on 2026-08-30, SCA on 2026-08-31.** Each built
phase carries its own *It landed* section saying what it cost, so the plan and
the record are one document. This is the sequencing for
`IDEAS/proving-grounds.md` § Candidate C, which ranked billing first of three
proving grounds and argued *why*. This file answers *in what order*, and every
phase ends with something runnable — a phase whose output is only a schema is a
phase that cannot be shown to be wrong.

Two things it depends on are done: `@money` reaches every money column in
`example` (`FJS-562`), and allocation is ruled and built —
`allocate(amount, ratios)` and `roundMinor(value, { mode })` in
`@frontierjs/toolbelt/units` (`FJS-D154`). `allocate` has **no caller yet**;
proration is the one that arrives here.

---

## Phase 0 — where it lives, and it is a fork rather than a detail

`proving-grounds.md` says billing is *the first real slice* and the strategic
reason to build it. `IDEAS/overview.md` row 1.10 says *candidate C (billing) into
`example/`*. Those are two different file trees and every path below depends on
which one is meant, so it is settled before the first model rather than
discovered at the fourth.

**Decided 2026-08-30: it lives in `example/`**, as ordinary application code,
with the slice extracted in Phase 7. `slices.md`'s own argument is that the format is
inferred from a directory layout rather than declared; a package boundary drawn
before anything works is a guess about which files are the slice's, and the
extraction is mechanical once they exist. The strategic prize — a slice
contributing all five realms — is not lost by arriving one phase later, and
`IDEAS/overview.md` row 3.8's objection (teams is the better *structural* first
slice) is answerable either way.

The counter-case is honest and should be recorded if the other branch is taken:
an app grows shortcuts a package cannot take — reaching into a sibling service,
sharing a helper across a boundary that will not exist — and extraction then
costs a rewrite rather than a move.

**Also owed here:** a green `verify:money`. It is the drive that grades the
arithmetic every phase below adds to.

---

## Phase 1 — the seed: what recurs, and what a document is

Roughly ten models. The three that carry the argument:

- **`Plan` and its versions.** A price that changed in March must not reprice a
  subscription sold in February. That is **reference data with a validity
  window** — effective dating with the interval count left open, which is
  candidate A's temporal gap in the small. Kill Bill's catalogue is the prior art
  worth reading before writing this.
- **`Subscription`** — a `@@transitions` state machine (`trialing → active →
  past_due → cancelled`, plus `paused`), which is the framework feature this
  domain exercises hardest. `example` already drives one on `Order`.
- **`Invoice` and `InvoiceLine`** — an invoice is an **immutable document**. Once
  issued it does not change: a correction is a `CreditNote`, never an edit.

**Two language gaps, ruled 2026-08-30 as `FJS-D162` before the first model.**
Both were narrower than this file first claimed, and the ruling is one shape
rather than two features: **a document is a row whose columns are written once
and whose invariant is checked at the moment it is issued.**

1. **`@immutable` is a column, and it refuses the KEY.** An update payload
   naming one is refused by name, the way `@system` already is — no comparison
   with the stored row, which is the thing nothing in the seed can do. It is the
   **constraint tier**, so `asSystem()` cannot drop it: the renewal job and the
   settler both run as system, and a rule they may drop is absent from every
   caller that writes an invoice. A raw `UPDATE` still bypasses, as it does a
   `@check`.
2. **The sum is checked at the TRANSITION, not continuously**, and the freeze is
   what makes once enough — a draft that does not add up is legal, which is what
   a draft is. The lines freeze with the parent, or the sum drifts after the one
   moment it was checked.

What the ruling deliberately leaves to this phase: what SPELLS *check at this
transition*, whether `@immutable` refuses a delete and how it reads against
`@@softDelete`, the error class, and whether the child's cascade is a parent read
or a condition on the child's own write.

**Ends with:** the schema parsing, `db/access.snapshot.md` and
`db/ddl.snapshot.sql` regenerated, and a seed that writes one plan, one
subscription and one issued invoice.

### It landed, and what it cost

**Shipped 2026-08-30.** Six models and three enums in `example/db/schema.lite`
(23 models total), all four committed snapshots regenerated and passing
`--check`, and the seed writing a plan whose price has MOVED — a closed window
at 19 and an open one at 24, with the subscriber still on the old one, because
effective dating is invisible in a shop with one price.

**`@immutable` was built first**, since the schema could not parse without it:
`packages/litestone`, 11 tests, and the suite green at 3616. Proved against the
app's own database rather than a fixture — restating a total, sending the SAME
total back, and moving the issue date are each refused through `asSystem()`,
while `settle` still moves the status and a `CreditNote` records the correction
beside the row.

**One gap found, which is what a proving ground is for.** `@@unique` took no
predicate, so *one OPEN window per plan* — the constraint effective dating is
built on — could not be declared ([`FJS-603`](../ISSUES.md#fjs-603)). The near
miss was the sharp part: `@@unique([planId, effectiveTo])` is refused by name
because two NULLs never compare equal, and the refusal offered
`nullsDistinct: true`, which is the correct declaration of the opposite of what
was wanted. **Closed 2026-08-31** — `@@unique([planId], where: effectiveTo == null)`
— and the refusal names both answers now, with the column list changed in the
suggestion.

~~**One thing the ruling implied and this phase discovered:** there is no `draft`
invoice status. `@immutable` freezes a column at CREATE, so a row assembled over
several writes cannot hold a frozen total — an invoice is built in memory and
written whole, and exists only from the moment it is issued.~~ **Retired
2026-08-31 by `FJS-D167`.** The finding was correct and its cause was the
language rather than the domain: `@seals` on a move says WHEN a row becomes a
document, and on a sealing model `@immutable` means frozen at the SEAL. `draft`
is back, `issueInvoice` writes the header, adds the lines and then issues, and
`lines InvoiceLine[] @sealed` is what refuses a line added to an issued invoice
— which was legal until then, since every writable column on `InvoiceLine` was
already `@immutable` and neither `create` nor `delete` is a column.

The cross-row invariant therefore moves BACK to *checked at the transition*, and
still has no spelling: `subtotal` is the sum of the lines, no `@@check` can see a
child table, and `@seals` supplies the moment without yet spending it.

`fli check` reports four `transition-methods` warnings — `activate`, `lapse`,
`recover` and `void` are declared and nothing drives them. That is phase 2's
to-do list, written by the tree rather than by hand.

---

## Phase 2 — the clock: renewal and dunning

Caravan, second real consumer after `example`'s existing five job files.

- **Renewal** is a cron that finds subscriptions due and issues invoices. The fire
  must be idempotent per period — `dispatch({ id })` under
  `occurrenceKey('renew', subscriptionId, periodStart)`, which is
  `@frontierjs/toolbelt/history`'s existing definition and not a new one.
- **Dunning is durable retry with a DEADLINE**, and the deadline is the part a
  queue cannot express: caravan's retry ladder answers *try again*, and *give up
  and move the subscription to `cancelled` on day 21* is a business state. So the
  retry is the queue's and the deadline is a column, and the phase is about
  keeping those two from being written as one thing.
- The renewal writes through the **outbox** where an effect must survive a crash
  (the invoice email), and through `ctx.afterCommit` where it must not.

**Ends with:** `verify:billing` — a subscription renewing on a moved clock, with
`createClient({ now })` doing the moving, as `verify:jobs`'s retention pass
already does.

### It landed, and what it cost

**Shipped 2026-08-30.** `api/src/billing.ts` (the one owner of what a cycle
costs), three job files, six services, and `verify:billing` — **23 assertions,
under bun, with no server**, because everything it asks is a fact about the Data
boundary and the two handlers the queue calls.

**The clock is a PARAMETER rather than a mock.** `sweepRenewals({ at })` and
`dunSubscriptions({ at, subscriptionId })` take the instant to grade at and the
row to grade, and both are an operator's parameters before they are a drive's —
*re-run dunning for this customer, I have just taken their payment by hand* is a
real request. The cron passes neither and gets now and everybody, which is what
keeps it one code path.

**Dunning keeps no counter.** *How long has this been unpaid* is `now - dueAt`
on the oldest unpaid invoice — two frozen columns — so running the job twice at
one instant is the same answer, which the drive asserts. A `failedAttempts`
column is a second answer to a question the rows already answer, and the two
disagree the first time anything runs twice.

**Three defects, two of them in litestone and both silent.**
[`FJS-604`](../ISSUES.md#fjs-604): a migration that BLOCKED a column reported
`migrated`, with the reason in a SQL comment nobody reads — the app then ran
against a table missing a column its own seed declares, and mass-assignment
protection stripped every write of it, so a required field read back `undefined`.
[`FJS-605`](../ISSUES.md#fjs-605): `@default(now())` on a new column emits an
expression default, which `ALTER TABLE ADD COLUMN` cannot take — so adding one
to a populated table threw `near "(": syntax error` out of `autoMigrate` at
boot, naming nothing. The third was this app's own: settling an invoice ran the
transition and stamped no `paidAt`, in three copies of the same two lines, so
`settleInvoice` is now the one owner and the drive pins it.

---

## Phase 3 — proration, and `allocate`'s first caller

The four cases that are the domain: an upgrade mid-cycle, a downgrade mid-cycle,
a trial that converts, and a seat added on day 19.

Each is *a fraction of a period's price, split across lines that must sum to what
was charged*. `allocate` answers the split; what this phase decides is what the
ratios ARE — days remaining, seat-days, or a mix — and that decision belongs in
one module for the reason `pricing.ts` exists: two places that compute a
proration are two answers, and the day they disagree a customer is charged a
number no screen showed them.

**The sharp assertion this phase owes** is the one `verify:money` already models
for a basket: a proration whose parts are each plausible and whose sum is one
unit short of the charge. That is the failure `allocate` was ruled for, and a
drive that only checks each line passes with it broken.

**Ends with:** `verify:proration`, or a section of `verify:billing`, asserting
sums rather than lines.

### It landed, and what it cost

**Shipped 2026-08-30.** `prorate()` and `changePlan()` in `api/src/billing.ts`,
a `subscriptions.changePlan` method over a declared `type PlanChange`, and
`verify:proration` — **21 assertions, all sums**, green on its first run.

**`allocate` has its first caller**, and the drive's headline is the case that
justifies it: six seats at 9.99 with 19 days left prorates to 3796, and
3796 ÷ 6 is 632.67 — six lines of 633 is 3798 and six of 632 is 3792, while the
shop has taken 3796. The assertion is `naiveSplitWouldBeShort`, so replacing
`allocate` with a division fails it. Beside it, `everySeatWithinOneUnit`, because
a split that summed correctly by dumping the whole remainder on one line would
pass the first assertion alone.

**Which document a change writes is the SCHEMA's answer, not a branch.**
`Invoice.subtotal` is `@gte(0)`, so a negative document is refused at the Data
boundary — an upgrade owes money and is an invoice, a downgrade is owed money
and is a `CreditNote`. The drive asserts the refusal directly, so the rule cannot
be quietly replaced by an `if`.

**A change worth nothing writes nothing.** A zero invoice is a document
recording that a customer was charged nothing, which is a different claim from
having made no charge.

`fli check` over the app is now at **zero findings** — the four
`transition-methods` warnings phase 1 left are closed by the services phases 2
and 3 added, which is the rule doing what it is for rather than being
baselined.

---

## Phase 4 — the vendor: who owns the schedule

**Recommendation: this app owns the schedule and the vendor charges.** Stripe
Billing will run the whole cycle if asked, and a framework that hands it over
proves nothing about the framework — the declarative state machine, the durable
clock and the cross-row invariant all move into the vendor's product. Charging is
where the boundary is genuinely interesting, and `example` already has both
halves of it: a real Stripe connector (`api/src/core/stripe.ts`, `FJS-D153`) with
`verify:stripe` grading form encoding, bearer auth and webhook secret rotation,
and `verify:pay`'s four refusals plus an `Idempotency-Key` on the one outbound
call where a retry costs real money.

What is new here and is not covered by either drive:

- **A charge that fails is a domain answer**, not a retry — the dunning ladder
  starts, and the failure code decides whether it starts at all (a stolen card is
  not a soft decline).
- **Webhooks arrive twice and out of order.** `verify:pay` proves a redelivered
  event is absorbed by the ledger. A subscription adds *arriving in the wrong
  order*, where the later state must not be overwritten by the earlier one — and
  `@version` is the mechanism, not a timestamp comparison somebody writes.

**Ends with:** the payment half of `verify:billing`, against the existing dev
Stripe sink on 7114/8114 rather than a new one.

### It landed, and what it cost

**Shipped 2026-08-30** as `verify:collect` — **21 assertions**, against the dev
provider `bun run api` already starts.

**`Payment` became `@@arc([orderId, invoiceId])`**, which is the declaration's
first user in either app: a shop that sells things and also bills for them takes
money for two nouns, and a payment belongs to exactly one. Both-set and
neither-set are refused by the Data boundary, so no service holds the rule and
no second table exists. The migration was a rebuild and carried 26 existing
payments across.

**A decline is a domain answer and the provider's code decides which.** Soft
leaves the dunning clock to run; hard lapses at once, because a shop that keeps
re-presenting a stolen card gets its merchant account reviewed. An unknown code
is soft, deliberately — a code the provider invents next year must not cancel
subscriptions on the day it ships.

**Two defects, both found by the drive.**

A stale `payment.failed` arriving after a settlement lapsed a subscription that
was paid up. The guard was on the SUBSCRIPTION's state, which is `active` in
the stale case and the real one alike; it is the INVOICE's state that separates
them, and `settle: issued -> paid` was already doing the same job on the success
side. Out-of-order protection turns out to be the state machine in both
directions, not a timestamp comparison.

And the drive could not charge anything at first: **a conduit target is
registered in the plugin's `boot()`, so an app that has been built and not
started has `app.conduit` and no targets** — `target_not_found`, a correct
refusal to a question nobody meant to ask. Starting the app in the drive's own
process then hit the documented autoload trap: `resolveServicesDir` probes
beside the ENTRY file and under a test runner that is the test, so the app came
up with 4 services instead of 26 and every route but the raw ones was a 404.
`api/src/app.ts` states its services directory absolutely now, which is what the
hazard says an app should do and what the reference app was not doing.

---

## Phase 5 — the surfaces

Three audiences, and the third is the one `example` grew recently enough that it
is worth naming: staff in `web/`, the public in `site/`, and **a shopper with an
account**, which `verify:account` established.

- `web/` — plans, a subscription detail screen, an invoice. The detail screen is
  `record(id, { composed: true })` by construction (`FJS-D161`): an invoice is a
  row plus its lines, so a plain node would drop the lines at the first push.
- `site/` — a pricing page, prerendered, with the price corrected by an island
  the way `verify:site`'s stale price already is.
- The account area — my subscription, my invoices, cancel.

**What this phase actually tests** is the generated form over `@money`: `FJS-582`
shipped the control that turns a stored integer into a price box, and billing is
the first screen set where a person types money that is not a product price.


### It landed, and what it cost

**Shipped 2026-08-30.** Six resource files, five screens across two surfaces,
and the account area — with **no new drive**: the three audiences are three
drives this app already had, and each got the section only it can ask.
`verify:build` 56, `verify:site` 45, `verify:account` 27, all green together,
and `fli check` back at zero findings.

**The headline is the form.** `PlanVersion.price` is `@money(USD)`, so the
column holds cents and the box is in dollars — and the drive types `31.50` into
a browser and then asks the DATABASE what it stored. Nothing on the page rounds,
divides or names a currency: `web/src/money-control.js` resolves the control off
`x-money` on the rule (`FJS-582`), and `<PlanVersion only={['price']}>` narrows
the generated list rather than replacing it, so the label, the step and the
message a bad amount produces are all still the schema's.

**A price is not a field, so repricing is not a PATCH.** `price` and
`effectiveFrom` are `@immutable`, so `plans.reprice` closes the open window and
opens the next one in one transaction — and the invariant it holds is the one
`@@unique` cannot state (`FJS-603`), so the service refuses a plan that somehow
holds two open windows rather than quietly picking one. The screen asserts the
other half: the new window has **no subscribers** and an older one still does,
which is the whole of what effective dating buys and is invisible in a shop
with one price.

**Two things a live store cannot do, both found by running it.**

A derived column moves when a CHILD row is written. `Plan.currentPrice` is
`@from(PlanVersion, …)`, so a reprice changes it while the `Plan` row itself
does not move — nothing announces it, and the tile held the old price until the
page re-read. `row.refresh()` is the answer and the screen that made the change
is the only place that knows to call it.

And a `Map` that is mutated is not a `Map` that was assigned. `held.set(…)` on
the rendered map left every subscriber count reading 0, which looks exactly like
a plan nobody is subscribed to — the same shape as the `arr.push()` trap, on a
count rather than on a list.

**One defect filed, and it is a silent total failure.**
[`FJS-607`](../ISSUES.md#fjs-607): a `slot="actions"` child wrapped in `{#if}`
makes `$slots.default` truthy, so `<Form>` reads the caller as having written
the form and generates NOTHING. Every field disappears, the form still submits,
and the page looks like a component that failed to load.

**And the drives were leaving rows behind.** `verify:billing`, `verify:proration`
and `verify:collect` each mint a subscription per run against the same shopper
whose account `verify:account` renders — 32 subscriptions and 45 invoices had
accumulated, enough to push the seeded one off the screen and make *their
standing orders* an assertion about nothing. All three clear up after themselves
now, `verify:account` mints and removes both the document it issues as a
negative control and the subscription it CANCELS — cancelling the seeded one
left the shop's only subscription dead for every drive after it, which is the
fixed-fixture trap (`FJS-530`) wearing a state machine instead of a `@unique` —
and the seed puts `SUB-3001` back on the version and seat count it was sold at,
the way it already put a cancelled one back on its feet.

**Nineteen type errors closed on the way through**, all of them phases 2–4's:
`PaymentRow` had no `invoiceId` after `@@arc` (phase 4), the three new job files
read an untyped system client, and **two handlers declared `{ attempts: n }`,
which is not an option** — the name is `maxAttempts`, so the retry ladder those
files meant to set was never set. `fli typecheck` over the app is at 16, all of
them pre-dating billing.

---

## Phase 6 — the drives

One drive per question, following the existing shapes:

| Drive | Asks |
| --- | --- |
| `verify:billing` | a cycle: subscribe → renew → invoice → charge → paid |
| `verify:dunning` | three failures and a deadline, on a moved clock |
| `verify:proration` | the four mid-cycle cases, asserted as sums |

**Three traps this repo has already paid for.** Mint fixtures per run
(`FJS-530`, `FJS-546`) — a subscription keyed on a literal passes once per seed.
Assert **deltas**, not absolutes, because `db:seed` restores only the rows it
owns. And stay off the login limiter where possible: sign-in is capped at 10 per
15 minutes across every browser drive, and three new drives that each sign in
make the existing nineteen flakier.


### It landed, and what it cost

**Shipped 2026-08-30**, and the table above turned out to be wrong in two ways
that are worth keeping rather than editing away — it was written before any of
these drives existed.

**`verify:dunning` is not a drive and should not be.** The argument is not
cost, it is the fixture: `verify:billing`'s dunning half stands on the invoice
its own RENEWAL issued, and every instant it grades is measured from that
invoice's `dueAt`. Split into its own drive, dunning has to mint an invoice by
hand — and then *how long has this been unpaid* is being asked of a document the
drive wrote rather than one the shop issued, which is the same weakness the
chain below exists to remove. The other half of the row's phrasing, *three
failures and a deadline*, describes a retry-COUNT design; this app deliberately
has no counter (`now − dueAt` on the oldest unpaid invoice), so there is no
third failure to count.

**What was genuinely missing was the CHAIN.** Every assertion in the three
drives calls one half of a handoff directly: `verify:billing` runs the sweep
against a recorder, which captures the dispatch and never executes it, and
`verify:collect` charges an invoice it made itself. So

    sweep → dispatch(renew) → issue → dispatch(collect) → present → signed event → paid

had run **zero times end to end** — four handoffs, each proven on one side, and
a drive on either side of any of them passes with the crossing broken. It is
seven assertions in `verify:collect` now (28 total), because that is the only
drive that starts a real app: draining needs `app.jobs` and presenting needs
`app.conduit`, and a fourth drive would have duplicated both to assert less.

It passed on its first run, which is the right outcome — phase 4 wired it
correctly — and the value is that it is now proven rather than assumed. Two of
the seven are about what the chain must NOT do: the window moved, so the
subscription survived its own renewal, and a second sweep at the same instant
bills nothing — which is the WINDOW rather than the dispatch id, since the
renewal changed the period end and therefore the occurrence key. `verify:billing`
cannot separate those two, because its sweep never advances anything.

**And it found one, which is the whole reason a chain is worth running.**
[`FJS-609`](../ISSUES.md#fjs-609): the collection was dispatched under a
`{ id }` built from the invoice's id. A dispatch id is the jobs table's PRIMARY
KEY, so a taken one is a no-op **for all time** — once `collect:56` exists that
invoice can never be presented again, and *presented again* is ordinary (a soft
decline leaves the invoice issued and owed). What the line means is *never two
presentations of one invoice in flight at once*, which is `unique`, a lock that
frees itself at a terminal state. **And the key cannot be built from a row id
under either option**: SQLite reuses a rowid once the row is gone, which is what
made this visible at all — the drive's own cleanup deletes invoices, so ids
recycle and the fourth run collided with the first. Three green runs, then two
assertions failing with the renewal visibly having worked, which is exactly what
a latent forever-key looks like from outside.

**The trap audit came out clean**, with one note. Every billing drive mints its
fixtures under a run prefix and clears them up (phase 5), none of the three
signs in at all, and the counts they assert are deltas or are scoped to a row
that run created. The note is that `jobs.snapshot.md` records a handler's
EFFECTIVE `maxAttempts` — so it would have caught the `{ attempts: n }` typo
phase 5 found, except that the value the typo fell back to was the one the file
was asking for.

---

## Phase 7 — the slice · **DEFERRED 2026-08-30**

**It stays application code in `example/` for a good while.** Not blocked and
not abandoned — the phase is written and still right; what is missing is the
second consumer that would tell anyone whether the boundary is in the correct
place. Phase 0 chose `example/` on the argument that a package boundary drawn
before anything works is a guess, and the same argument says a boundary drawn
before a second app needs it is the same guess one phase later.

What deferring costs is stated so it is not rediscovered: an app grows shortcuts
a package cannot take — reaching into a sibling service, sharing a helper across
a boundary that will not exist — and the longer this runs as app code the more
of them there are to unpick. `api/src/billing.ts` is the one to watch, since it
is already the module a slice would be built around.

Extract `@frontierjs/billing` in `slices.md`'s inferred layout — `model/`,
`service/`, `resource/`, `suite/`, `.env.example` — with `slice.ts` carrying the
one thing no directory expresses: `after: ['mailer']`.

What the extraction has to answer, and what makes it the first genuine test of
the format:

- **`model/` contributes into the seed**, which today only auth does, and it does
  it with two files and a plugin. Billing contributes models an app must relate
  to its own `User`/`Customer` — which is `extend model`'s direction, not the
  package's.
- **`resource/` ejects and `model/` links.** Restyling an invoice is certain;
  forking a migration is not wanted. That split is stated in `slices.md` and has
  never been executed.
- **The Suite part runs against the consuming app**, which is how *I installed
  only the Service part* becomes verified rather than assumed.

---

## Phase 8 — the instrument: charging somebody who is not there

**Phases 2 and 4 proved the clock and the handoff, and neither of them proved a
charge.** `chargeInvoice` mints a fresh intent every cycle
(`api/src/billing.ts`), which is the customer-present shape — it describes a
person at a keyboard being asked for a card. Nobody is at a keyboard when the
renewal cron fires, so `verify:collect`'s end-to-end chain passes only because
the dev provider approves an intent that nothing ever confirmed. Against a real
vendor the same chain stops at the first invoice with no way to take the money,
and it stops **silently**: *the provider was asked and did not say yes* is
exactly the soft decline the dunning ladder was built to absorb, so the shop
lapses a paying subscriber over a feature it never had.

Three pieces, in this order, because each is the reason the next one exists.

### An instrument on file

A `PaymentMethod` — customer, provider reference, brand, last four, expiry,
default — and a second verb on the boundary (`createSetupIntent` in
`api/src/core/psp.ts`, its counterpart in `core/stripe.ts`) that asks the vendor
for a token which outlives the session. The conduit target is already there and
already signed, so this is a method rather than a mechanism.

**The interesting half is that the row is not uniformly secret.** The provider
reference can move money and is `@guarded`; the brand and the last four are
what a person reads to know *which card*, and gating the model at 8 to protect
the token takes that screen away with it. So the split is per column, which is
what `@guarded` is for, and it is the first place in this app where one model
carries both answers.

**`isDefault` is `FJS-603` a second time** — and it is the instance that survived
closing it. *At most one default per customer* is
`@@unique([customerId], where: isDefault == true)`, the predicate is well inside
what the attribute takes, and the DECLARATION is still refused: this model
already carries `@@index([customerId])` for the ordinary read, an index is named
for its columns alone, and the two derive one name
([`FJS-614`](../ISSUES.md#fjs-614)). So the invariant is still a service
transaction here. Two instances is the point at which it stopped being one app's
arrangement, and the second one is now also what shows where the fix stops.

`Payment` gains `paymentMethodId Int?` at `onDelete: Restrict`, because a card
that is taken off file must not take the payments it made with it.

#### It landed, and what it cost

**Shipped 2026-08-30.** `model PaymentMethod` with `providerRef @guarded` beside
a plain `brand`/`last4`, `createSetupIntent` and `confirmOffSession` on the
conduit target, both halves in the dev provider, a `payment-methods` service
that is reads plus `startSetup`, and a `chargeInvoice` that presents a filed
card. `verify:collect` 28 → **39**.

**It is TWO calls to the provider and that is the finding.** The obvious shape
is one — Stripe's `confirm: true` — and it is a race the shop loses silently: a
provider's event arrives on its own connection and routinely beats the reply to
the call that caused it, so the webhook saying *paid* can reach
`payments.record` before the `Payment` row exists, which is `unknown-payment`,
a 200, and money taken against nothing. So the shop mints the intent, writes its
row, and only then presents the card. The two calls also fall out symmetrically:
the shopper's confirm is UNSIGNED because a person at a browser is the
authorization, and the shop's is SIGNED because there is nobody there and a
signature is the only caller that can stand in for one.

**No instrument is its own answer, and it pays for itself immediately.** Before
this, a charge minted an intent nobody would ever confirm, so the invoice sat
`issued` — which is what a card saying no looks like — and dunning then ran its
full twenty-one days at somebody who had never been asked for a card.
`retryable: false`, because no number of attempts produces an instrument, and
`charge.andPresentsNothing` is the assertion that nothing is minted either.

**The shop is never told which card it has by the browser that confirmed.** That
reply is on the person's own machine, so `setup.succeeded` — signed, on the
provider's own connection — is what files the row, and `payments.record` grows
one branch ABOVE its payment lookup because a setup intent has no `Payment` for
the generic path to find.

**`isDefault` is `FJS-603` a second time**, and the drive is what stands in for
the constraint: the newest card becomes the default and the clear-then-create is
only sound because `record` is already `transactional:` — between the two there
is an instant with no default at all, and a renewal landing in it charges nobody
and duns them for it.

Two things are deliberately absent and are named so they are not mistaken for
oversights. **Removal** wants rules this pass does not have — which card the
default moves to, and what happens to a live subscription whose only instrument
has just gone — and a `remove` that leaves a subscriber unbillable without
saying so is worse than none. And there is **no screen**: filing a card ends on
the provider's own page, which is the vendor's script running on a page we
serve, and that is exactly the CSP and static-safety question the third piece
below has to answer. The two arrive together or the front end is written twice.

### Cancelling at the end of the period, rather than now

`cancel: [trialing, active, pastDue] -> cancelled` is immediate, so a subscriber
cancelling on day two of a month they have paid for forfeits the other
twenty-eight. Every shop cancels at the period end; Cashier calls the interval a
grace period and has `resume()` to go with it.

**There are two spellings and the choice is the substance.** A fifth status —
`cancelling` — makes the move declared, so it lands in `x-transitions` and the
console's button set stays derived. It also doubles what every reader has to
grade: `dueForRenewal`, `unpaidInvoices`, the dunning read and both row policies
all currently ask one question about `status`, and *is this live* becoming a set
membership is the shape that goes wrong in one caller and nowhere else.

**Recommendation: a `cancelAtPeriodEnd Boolean @system` beside `active`**, so
*live* stays one comparison and the flag decides only what the renewal job does
when it reaches the boundary. `resume` clears it, and is refused once
`currentPeriodEnd` has passed — at that point the subscription is cancelled and
coming back is a new one at whatever `PlanVersion` is open now, which is phase
1's argument arriving from the other end.

The cost is real and is recorded rather than argued away: the flag is invisible
to `@@transitions`, so Cancel and Resume are the first buttons in this app that
cannot be derived from what the schema declares, and are hand-written. That is
the evidence for whether the language should be able to declare a move that
happens *at an instant* rather than *from a state*.

#### It landed, and what it cost

**Shipped 2026-08-30.** `Subscription.cancelAtPeriodEnd` is a `@system` boolean,
`cancel` joined the other three moves as `@system`, and `subscriptions.cancel` /
`.resume` write the one column through the model's own gate and row policies —
so a shopper stopping their own arrangement is still
`@@allow('update', userId == auth().id)` and nothing in either screen grades
anybody. `renew-subscription` reads the flag AT the boundary, after both of its
existing guards, and ends the arrangement there instead of issuing.

**Three drives, +11 assertions.** `verify:billing` 23 → 29 for the job half: a
flagged subscription and an unflagged one at one instant, because a cancellation
asserted alone cannot be told apart from a renewal that failed. `verify:account`
26 → 29 for the service half — over HTTP and in a browser, where the assertion
that matters is that the status does NOT move. `verify` 56 → 58 for the console.

**The guard ORDER is an assertion rather than a comment.** The flag is read after
*already advanced*, so a stale dispatch — a queue redelivery, an operator
re-running a half-finished sweep — cannot cancel a subscription whose next period
has already been issued and possibly paid. Reading it first is the plausible
order and it is wrong; `boundary.staleDispatchDoesNotEndIt` is what pins it.

**It found two things.**

[`FJS-613`](../ISSUES.md#fjs-613): a transition declared `@system` is
**byte-identical in `db/access.snapshot.md`** to one anybody may ask for.
Measured by generating the file from two schemas differing in that one token —
the output differs in the filename in its own header and nowhere else. The whole
of this change is that a person may no longer ask for `cancel`, which is the
widest narrowing a state machine can make, and the artefact that exists so *what
did this branch do to who may do what* is a diff had nothing to say about it.
`jsonschema.snapshot.md` has the same hole from the client's side.

And a race in the console's subscription screen, fixed on the way through: the
plan was resolved once, on the line after `await watchVersion(…)`, and a record
view fills in through its subscribe callback — so `version` was still null about
half the time, `watchPlan(null)` cleared the plan, nothing called it again, and
the *this plan now sells at* alert never appeared while the price tile beside it
rendered correctly. It is watched off `version` now. The shape is worth knowing
because it is silent in the direction that matters: the screen looks right.

### `requires_action` is not a decline, and the taxonomy has to say so

`declineKind` answers `soft` or `hard`. Strong customer authentication is a
third answer that is neither: the charge has not failed and has not succeeded,
and the only thing that can advance it is a person in a browser. On an
off-session charge — which is what phase 8's first piece makes possible — it is
the answer a real vendor gives most often on a first renewal in the EU, and
treating it as a soft decline dunned somebody who was never asked.

So the job records the state and gets a person back: the invoice stays `issued`,
the `Payment` stays `pending` carrying the vendor's action, and a notification
carries a link to the shopper's own account screen.

**Two things follow that make this a phase rather than an afternoon.** The
confirmation happens against the vendor's own SDK on a page we serve, which is
the first third-party script on `site/` and is a CSP question and a
static-safety question at once. And `Payment` is `@@gate("5.8.8.9")` with no
`userId`, so a shopper cannot read their own payment at all — it grows the
column and the row policy `Invoice` already has, or the screen is built on a
read that only staff can make.

#### It landed, and what it cost

**Shipped 2026-08-31.** `PaymentStatus` gained `requiresAction`, `Payment` gained
`actionUrl` and `userId` and dropped its read gate from ADMINISTRATOR(5) to
VISITOR(1) behind the pair of row policies `Invoice` already had, the dev
provider grew a third test card and an issuer's challenge page, and the
storefront's account island grew the one thing on it a person has to act on.
`verify:collect` 39 → **49**, `verify:account` 29 → **32**.

**The plan above was wrong about the front end, and the correction is the
finding.** No vendor script runs on a page this shop serves: the challenge is
the CARD NETWORK's, run by the issuer, and the shop redirects to the provider's
own origin. Hosting it would put a third party's script on a prerendered
storefront in order to collect the one thing every other line in this app is
arranged not to see — and the CSP and static-safety questions the phase was
braced for do not arise, because there is nothing third-party to admit. The
assertion is written as *where the link GOES*.

**It is its own event and its own status, not a third `declineKind`.** The
instinct in the plan — *the taxonomy's name is wrong once this exists* — pointed
at the wrong repair. `declineKind` only ever runs on `payment.failed`, so it
stays a two-way answer and correctly never sees a challenge; what needed a third
value was the EVENT and the STATUS. And a status rather than a flag, which is
the deliberate opposite of `cancelAtPeriodEnd` one section up: a flag is right
when one job reads it, a status is right when every reader has to grade it — a
collection must not present again, dunning must not read it as a card saying no,
and a screen has to send somebody somewhere. Having both in one domain is what
makes the distinction teachable rather than folklore.

**The dunning clock keeps running, and that is correct.** A challenge nobody
ever answers is an invoice nobody ever pays, measured against the same `dueAt`
as any other. What must not happen is the immediate lapse, and it does not,
because that is the hard-decline path and this is not a decline —
`sca.theSubscriptionIsNotLapsed` is the assertion, beside
`sca.theInvoiceIsStillOwed`.

**`requiresAction` counts as in flight.** Re-presenting the same card produces
the same challenge and a second row to reconcile, so it joins `pending` in the
guard — which is a one-word change and the difference between a queue retry
being a no-op and being a duplicate charge attempt per attempt.

This is the third out-of-order guard in one file, and they are all the same
shape: a provider retrying an event it thinks it owes. A challenge delivered
after settlement would move a finished payment back to *waiting for somebody*.

**Ends with:** the off-session half in `verify:collect`, which already owns the
sweep → dispatch → issue → collect chain and can assert that the second cycle
charges with nobody there; and the confirmation half in `verify:account`, which
is the only drive that signs a shopper in on the storefront's own origin in a
real browser.

### What is deliberately not in it

**A discount on a subscription.** `Discount` exists and `pricing.ts` applies it
to a basket; `billing.ts` mentions it nowhere. Joining the two is a negative
`InvoiceLine` and a day's work, and it proves nothing this file has not already
proved — the arithmetic is `pricing.ts`'s and the document is phase 1's.

**An invoice as a PDF.** A rendering question for `@frontierjs/email-kit`, not a
billing one.

---

## Out of scope, stated so it is not rediscovered

- **Usage-based metering.** It wants twelve decimal places and that means BigInt
  at the wire (`FJS-575`) — junction's `type: 'integer'`, the form controls and
  `pricing.ts` all assume a JS number. A separate feature with its own ruling.
- **Tax as a domain.** `example` has a rate and a `@@check`; jurisdictions,
  nexus and exemption certificates are a product, not a proving ground.
- **Multi-currency subscriptions.** `Payment` already binds
  `@money(field: currency)`, so the language is ready and the domain question
  (which rate, at what moment) is a second app's.

---

## The rulings this will force, in the order it forces them

1. ~~**Is *immutable after a state* expressible in the seed**~~ and ~~**where does
   a cross-row invariant live**~~ — both ruled ahead of the code as
   [`FJS-D162`](../DECISIONS.md#fjs-d162), because they are one shape and the
   shape decides the schema.
2. ~~**Effective-dated reference data**~~ — ruled after Phase 1 built it, as
   [`FJS-D164`](../DECISIONS.md#fjs-d164): a row with a WINDOW, and the thing
   that consumes it names the version rather than the parent. The general
   question — whether the language should know about validity windows rather
   than an app arranging them — is candidate A's and stays open.
3. ~~**Who owns a recurring schedule's deadline**~~ — ruled after Phase 2 built
   it, as [`FJS-D165`](../DECISIONS.md#fjs-d165): the queue owns *try again*,
   the deadline is a comparison against a document's own date, and there is no
   counter.
4. **Is a SCHEDULED move declarable** — `@@transitions` says what may move from
   where, and nothing in the language says *this move happens at that instant*,
   which is the whole of cancel-at-period-end. Phase 8 builds it as a flag and a
   job, and the ruling is owed once the hand-written buttons exist to argue
   against.
5. **Is a partial UNIQUE declarable** — not a new question but a second
   instance: [`FJS-603`](../ISSUES.md#fjs-603) was found writing `PlanVersion`
   and phase 8's `PaymentMethod.isDefault` is the same shape from another
   domain. Two instances is when it stops being one app's arrangement, and the
   issue already names both candidate spellings.
6. ~~**May a third party's script run on a prerendered page**~~ — **it does not
   arise, and that is the answer.** SCA shipped by redirecting to the provider's
   own origin: the challenge belongs to the card network, so there is nothing
   third-party to admit to `site/` and `static-safety.md` is not asked anything
   new. Recorded rather than dropped, because the question is the one a shop
   embedding a vendor's SDK would have to answer, and the reason not to is the
   same reason the shop never sees a card number.

Each was filed once the code existed rather than before it: a question filed
ahead of the code it is about is answered in the abstract, which is how
`FJS-560` happened. Both are stronger for it — each names the alternative it
rejected and the drive that proves the choice.
