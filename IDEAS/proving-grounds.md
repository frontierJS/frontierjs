---
id: proving-grounds
status: idea
dated: 2026-08-29
---

# Idea — the proving grounds: what to build next to find what is missing

**Status: IDEA. Nothing here is built.** Dated 2026-08-29. Every claim about *this
repo* below was read off `CLAUDE.md` and the tree rather than run, so a gap named
here is a gap **as far as reading goes** — the whole point of the exercise is to make
each one fail at a terminal instead of on a page. See `VERIFYING.md`.

---

## The claim

`example/` and `basecamp/` have between them found dozens of framework defects, and
they found them because they are real applications rather than fixtures. But they are
the same **shape** of real. Both exercise the framework across *space* — many rows,
many tenants, five surfaces, thirty-odd screens, nineteen drives. Two things neither
one touches:

1. **Time as a dimension.** Nothing in either app asks *what was true on 12 April*.
   Litestone has `@version` (which revision) and `@@softDelete` (hidden or not) and
   `@@log(audit)` (what happened, in a log). It has no **valid time** — the interval
   over which a fact was true of the world, as against the interval over which the
   database believed it. Every row in both apps is current-state-with-history-beside-it.
2. **Permission as the product.** Both apps have real gates, real policies, real
   capabilities — and in both, authorisation is a property *of a column on the row*
   (`workspaceId`, `ownerId`, `isStaff`). Neither has an access rule that must join
   through a **relationship table with a validity window**, and neither has a rule
   whose input is a **third table's rows** (a consent, a lock, a period close).

Invariant 6 says access is declared in the schema, not in hooks. That claim has never
been tested by an app where the declaration is *hard*.

**What follows is three candidates, ranked by what they break rather than by what they
are.** They are complements, not rivals — A stresses the engine, B stresses the rules,
C is the cheap rehearsal for A that an indie developer would actually pay for.

---

## Candidate A — a payroll bureau

**Payroll is the notorious one.** Vendors have been getting it wrong for thirty years,
and not because arithmetic is hard. It is hard because five hard things stack:

| Hard thing | What FJS has today | What breaks |
| --- | --- | --- |
| **Effective dating** — salary £40k *from 1 Mar*, £45k *from 1 Jul*; read what was true on 12 Apr | nothing. `@version` is a revision counter, `@@softDelete` is a visibility flag | every read becomes `asAt(date)`. No `@@effective` spelling exists; no row policy carries a date window; `findWindow` pages a list and says nothing about a period |
| **Bitemporality** — what was true *then*, as we knew it *then*, against as we know it *now* | `@@log(audit)` records writes and redacts protected fields | a log is not a queryable dimension. *Reproduce March's payslip as March saw it* has no answer that is not a replay of the log by hand |
| **Retroactive correction** — backdate a raise; three closed periods recompute and emit *adjustment* lines, never edits | caravan, `occurrenceKey` (`@frontierjs/toolbelt/history`), the outbox | nothing declares *this row was derived from those rows*. A recompute cascade has no owner, and idempotency per employee per period is hand-built |
| **Immutable document** — a payslip is never updated. A wrong one is reversed | `@system`, `@guarded`, gates | no `@@immutable`. Today's nearest spelling is a gate of 9 on update, which is a fudge dressed as a declaration |
| **Cross-row invariant** — payslip lines must sum to net; a journal must balance to zero | `@@check` reads **one row** (`FJS-351`'s five constraints are all single-row, deliberately) | **no spelling at all.** This is the sharpest gap in the list and it fails on day one |

**What it exercises that the two apps do not.**

- **Money that is not a shop price.** Allocating £100 across three cost centres is
  33.33 / 33.33 / 33.34, and which line takes the penny is a domain rule.
  `@frontierjs/toolbelt/units` currently formats; it does not allocate.
- **Batch as a first-class thing.** A pay run is 5,000 employees. One transaction is
  the wrong answer, partial failure is the normal case, and the run must be resumable
  and re-runnable without paying anybody twice. Caravan gets a harder test than
  `verify:jobs` has ever given it, and the outbox gets the case it was designed for —
  a payslip that has been *sent* cannot be un-sent.
- **Reference data with validity windows.** Tax bands and thresholds per tax year.
  That is not a `valueset` (`FJS-D120`) and not an enum; it is a table whose rows are
  each true for an interval.
- **A bureau is `strategy database`** — one deployment, many employers, per-tenant
  config (`FJS-D126`) carrying each employer's own pay calendar and from-address.
  Already built; this is what would pressure-test it.
- **An approval ladder with consequence** — draft → calculated → approved → paid →
  corrected, under `@@transitions` + `@gate` + the capability grid (`FJS-D146`), where
  approving moves real money.

### The first slice, and where each step is expected to fail

1. `Employee` + `EmploymentTerms`, effective-dated. Write the as-at read **by hand**.
   The ugliness of that read is the specification for `@@effective`.
2. `PayRun` state machine, `Payslip` immutable, `PayslipLine` summing to net. Try to
   *declare* the sum. Fail. That failure is the ruling worth having.
3. One retroactive change across three closed periods. Watch what a recompute cascade
   costs when nothing owns it.

Nothing above needs a new package before it is attempted. Each step should be done the
hard way first, because a gap argued from a page is a guess and a gap met at a terminal
is a specification.

**Sequenced 2026-08-30 as `payroll.md`.** Billing shipped first as planned, and the
wall count it left is **one and a half of five** rather than the two predicted here:
`@immutable` stands, the cross-row invariant was argued and left without a grammar
(`FJS-D162`), and effective dating has a pattern and a ruling (`FJS-D164`) but no
`@@effective`; *one open window per parent* is declarable since `FJS-603` closed. The
plan takes the ledger early and narrow — the sale that already exists posting a
balanced journal — because the cross-row invariant is the sharpest gap on this list
and the cheapest place to meet it is the smallest one.

---

## Candidate B — a clinical record system

Payroll attacks the framework on **time**. This one attacks it on the axis the
framework put its name on.

> Payroll asks *when was this true?* A clinical record asks *who may know this, why,
> and who looked?*

| Hard thing | What FJS has today | What breaks |
| --- | --- | --- |
| **Relationship-based read** — a clinician may read a patient because a *care relationship* row exists whose validity window covers now | the membership spelling `@@allow('read', auth().id in memberIds)`; `@from` correlating on a relation's full key | the policy must join to another table **with a time window**. Never proven. If it falls to a hook, Invariant 6 is prose |
| **Consent as data** — a patient records a dissent for one purpose | policies compile into the caller's WHERE off their own accessor | the predicate's input is a *third table's rows*, negated. Does it compile, or does it become an empty screen with a 200? |
| **Purpose of use** — same clinician, same patient, different answer for treatment against billing against research | `auth().capabilities` (`FJS-D151`) is per-principal; `callHeaders` is per-call transport | purpose is **per call** and standing is per session. Nothing joins them |
| **Break-glass** — refuse normally; permit when the caller states a reason, and make the permission itself an event somebody reviews | `db.$audit()` (an event, awaited, throwing — the right raw material), gates, capabilities | there is no **allow-with-obligation** tier. The language is allow / deny / filter, and this is a fourth answer |
| **Per-row visibility** — this note is visible to the author's team, that one to everybody | `@encrypted` / `@guarded`, per column, binary | redaction that varies *by reader and by row* has no spelling |
| **Disclosure log as a feature** — a patient asks who read their record last year | `@@log(audit)` writes JSONL; `database audit { retention 90d }` | is that log queryable *per subject*? A subject-access request is an ordinary query over it, and the log is not shaped for one |

**Why it suits this framework specifically.** It grows the Testing realm, which is the
most differentiated thing here: `verifyGateLadder`, `verifyRowPolicies` and
`verifyTenantIsolation` already exist and already report honestly (`unscoped`,
`unparented`, `unreachable`). A clinical app wants `verifyConsent` and
`verifyRelationshipAccess` in the same shape, and the shape is proved. It also forces
the **negative** assertion everywhere — every feature is *this person cannot see this*,
and `FJS-351`'s discipline (a refusal must be shown to come from the rule it names)
would apply to a whole application rather than to five constraints.

**What it does not test:** no money, no batch, weak on time. It proves permission
deeply and leaves the temporal gap exactly where it is.

---

## Candidate C — subscription billing, and why it goes first

**Both of the above are months. This one is weeks, half of it already exists, and it
rehearses candidate A's every gap at one-tenth the domain size.** It is also the single
thing an indie developer building a SaaS product will hit in week three and get wrong.

Proration is **time-slicing**. An invoice is an **immutable document**. A credit note is
**reversal rather than edit**. A plan change mid-cycle is a **retroactive recompute**.
Dunning is **durable retry with a deadline**. Invoice lines summing to the charged total
is the **cross-row invariant**. Plan versions are **reference data with validity
windows**. Every gap named under payroll appears here, smaller, with a customer.

**What already ships that it builds on:** `example/api/src/core/psp-sink.ts` and the
Stripe connector (`FJS-D153`), `verify:stripe` (a real vendor's dialect crossing the
conduit boundary — form encoding, bearer key, webhook secret rotation), `verify:pay`
(HMAC in both directions, a signed webhook driving a state machine, `Idempotency-Key`
on the one outbound call where a retry costs money), `verify:money` (one owner for the
arithmetic, the discount/threshold crossing, the redemption race). Billing is those
pieces pointed at a recurring charge instead of a one-off sale.

**The strategic reason to do it first is not the domain.** Wave 3's slice mechanism has
no real consumer. `@frontierjs/billing` — models, services, screens, jobs, a conduit
target and a webhook route, installed as one slice — would be the first genuine test of
`slices.md`, and it is a slice people would install. Auth is currently the only package
that contributes into the seed, and it contributes two files and a plugin. A billing
slice contributes all five realms at once, which is the shape the mechanism claims to
support and has never had to.

**One thing blocks it and should be settled first, and it is not the one this record
originally named.** The storage half is done: `Int @money(CUR)` shipped 2026-08-26
(`FJS-D142`), so an exact money column is expressible today, and the epsilon in
`example`'s receipt identity was a migration that had not happened rather than a
language gap. That migration has since landed (`FJS-562`): `example` is minor
units throughout and the identity is an exact equality, which took two defects
with it (`FJS-582`, `FJS-583`). What was genuinely unruled is **allocation** — proration is a third of a monthly
price split across lines that must sum to what was charged, and `FJS-D142`
deliberately left rounding mode and the leftover penny to the application without
saying where in the application they live. Ruled as `FJS-D154`: a pure
`allocate(amount, ratios, scale)` in toolbelt, largest-remainder, half away from
zero and overridable, with no value object and nothing handed out by the seed.
The function shipped with the ruling —
`allocate(amount, ratios)` and `roundMinor(value, { mode })` in
`@frontierjs/toolbelt/units` — and has no caller yet; proration is the one that
arrives. **The sequencing is `billing.md`**, eight phases from where it lives to
the slice.

**Risk is low and bounded.** Roughly ten models. No regulator. Getting it wrong costs a
credit note, not a tribunal. And the failure modes are already documented by other
people, so the drive can be written against known-hard cases rather than invented ones:
an upgrade mid-cycle, a downgrade mid-cycle, a trial that converts, a seat added on day
19, a card that fails three times, a refund after a plan change, and a webhook that
arrives twice out of order.

---

## Considered, with reasons

- **Booking and scheduling** (a Calendly-shaped thing). Genuinely hard — timezones,
  recurrence, double-booking, cancellation windows — and genuinely practical. It is
  ranked below billing only because `IDEAS/time-and-recurrence.md` already argues the
  hardest part of it and `datetime-kit` is a parked prototype, so the design debt is
  *known* rather than *undiscovered*. It is the best second small app, and it is the
  one that would force `@frontierjs/toolbelt/datetime` to become real.
- **CMS with draft, schedule and preview.** Attractive because draft-against-published
  is effective dating with the interval count fixed at two, and because `site/` is a
  differentiator that would get a second real consumer. Declined as a *proving ground*
  because the two-version case is exactly the one that can be faked with a status
  column, so it would not force the general answer.
- **A shared inbox / support desk.** Would stress conduit, notifications, live
  membership and the window (`FJS-D145`) hard, and threading is underrated. No temporal
  or permission gap that the three above do not already cover.
- **Analytics ingestion.** Tests throughput, which is not where this framework's claims
  live.
- **User-defined forms — clinical EDC, form builders.** Declined. It asks whether
  `schema.lite` should be data at all, which is an existential question about the
  premise rather than a test of it; the likely answer is *don't*, and a proving ground
  whose conclusion is a refusal teaches very little for the money.

---

## The recommended order

1. **C, subscription billing** — weeks, half-built, ships as the first real slice, and
   every gap it hits is a gap A will hit again. If the cross-row invariant and the
   immutable-document questions get rulings here, payroll starts with two of its five
   walls already standing.
2. **A, payroll** — folded into `example/`, below. **The sequencing is
   `payroll.md`**, nine phases from the corpus port to the drives, with the
   ledger taken early and narrow and a stated size budget of eight models.
3. **B, clinical** — a *separate* app, not folded into anything. Its whole value is
   that permission is the product, and grafting it onto a shop would make it a feature.

---

## Where A lives — `example/` stops being a shop

**Decision taken 2026-08-29; recorded 2026-08-30 as `FJS-D166`.**
Payroll goes into `example/` rather than into a fourth app.

The objection is obvious: `example/` is a Shopify-shaped thing, and payroll is not
shopping. The answer is that `example/` was never really a shop — it is **a business**,
and it has been drifting that way since it grew a fleet of tenants, a payment provider
it signs to, an inventory ledger and a receipt that is copied at the moment of sale. A
business that sells things also employs people, and the two halves meet at a general
ledger: an order posts journals, a pay run posts journals, and the ledger is where the
cross-row invariant finally has to be declared. That shared ledger is the argument for
one app rather than two — in two apps it would be two implementations.

**What it costs, stated rather than discovered later:**

- More drives. There are nineteen (579 assertions) and payroll wants at least three of
  its own — an as-at read, a pay run, a retro correction.
- The login limiter already bites: sign-in is capped at 10 per 15 minutes across every
  browser drive, so a payroll drive that signs in is a drive that makes the existing
  suite flakier. It should follow `verify:site`'s example and stay off the limiter
  where it can, and mint per-run fixtures where it cannot (`FJS-530`, `FJS-546`).
- `db:seed` grows, and every payroll drive's assertions must be **deltas** for the same
  reason `verify:shop`'s stock assertions are.
- The schema roughly doubles. `example` currently reads as something a newcomer can
  hold in their head, and that is a real asset worth spending deliberately rather than
  by accident.

---

## The corpus — porting real schemas, and why a build-time rule cannot replace it

**These are different jobs and the project needs both.** A `fli check` rule catches a
gap somebody already thought of, forever after; it is blind to every gap nobody
thought of, because a rule is written by someone who knows what `.lite` can say. A
mechanically converted schema knows nothing and simply hits the wall.
`test/fixtures/scale/openmrp.lite` found `FJS-480` for exactly that reason — it was
derived from a real MySQL schema rather than designed, and the source table declared
an index `@@softDelete` already builds.

The loop, rather than the choice:

> port a real schema → it fails → the failure becomes either a **ruling** (new
> grammar) or a **`fli check` rule** (a known gotcha, pinned forever) → the port stays
> as a regression fixture

**Two gaps were found this way in ninety seconds on 2026-08-29**, by trying to express
things a converter would emit rather than by any rule: a composite primary key is not
expressible (`FJS-561`), and a decimal column has nowhere obvious to land — though that
second one turned out to be **a stale roadmap rather than a missing feature**
(`FJS-560`): `Int @scale(n)` had shipped four days earlier and three signposts in
litestone's own docs said it had not. The first would never have been reported by a
checker, because a checker grades what an author wrote and a composite key is something
an author cannot write. The second is the opposite failure and now has a checker
(`fli check`'s `roadmap-shipped`).

### It landed, and what the first run cost

**Shipped 2026-08-29** as `packages/litestone/test/fixtures/corpus/` — the
converter, a fetcher, one committed fixture and `test/corpus.test.ts` in
`openmrp`'s shape. Three published Prisma schemas (Cal.com 100 models,
Trigger.dev 81, Documenso 51 — **232 models, 124 enums**) parse, build a database
and re-boot with zero drift.

Two defects fell out — `FJS-563` (an unlabelled one-to-one back-reference reports
`unknown type` for a registered model; 37 occurrences, and the cause of every
`unknown type` error in all three) and `FJS-564` (no array defaults; 11) — plus
evidence for `FJS-561` and a vindication of `FJS-D130`, hit 22 times.

**The method's failure mode is over-claiming, and it fired three times in one
afternoon**: 348 "gaps" that were one converter bug (`onDelete`/`onUpdate` are
supported), a duplicate index invented by stripping an opclass, and a divergence
that would not reproduce at minimum size. All three were withdrawn before being
written down, which is the discipline the loop needs — the same one the withdrawn
`FJS-560` did not get. **A parser refusing a name is evidence about the name.**

### The build-time half that is worth building — **shipped 2026-08-29**

> `litestone import <path> [--from prisma|rails|sql|frappe] [--out] [--report]
> [--strict]` — `packages/litestone/src/import/`, `docs/import.md`. Four readers,
> the refusal list graded `changed` / `lost` / `noted`, and every `changed` one
> marked on its own line in the written file. What follows is the argument that
> got it built, kept because the ranking below is still live. **`fli`'s half is
> deliberately not built** — § *The half that is NOT built* below.

**A converter whose refusal list is the artifact.** `.lite` is deliberately
Prisma-shaped — `parser.js` pairs relations Prisma's way, takes positional relation
names, uses the same `@@map` convention — so Prisma → `.lite` is close to mechanical.
`openmrp.lite`'s header already documents four unconvertible things *in prose*: an
ambiguous double-FK relation left as plain columns, every decimal flattened to
`Float`, `@@index([deletedAt])` dropped, and camelCase with no `@map`.

That prose is what a tool should emit as **data**. `litestone import --from prisma
<file> --report` makes the corpus cheap and repeatable: running it over twenty
repositories costs an afternoon instead of twenty hand ports, and re-running it after
a grammar change says immediately what the change unlocked. **The refusal list is the
roadmap** — it is the one artefact here that finds unknown unknowns automatically.

Seven applications in, that is measured rather than hoped: 1,377 models, 2,178
recorded constructs, two defects nothing else could have found (`FJS-563`,
`FJS-571`), and one construct — the partial index, 251 instances — large enough
to have become a feature.

### Candidates, ranked by what they probe

Prefer projects that ship a Prisma schema (one file, mechanical) — marked ⚡.

**Feeding candidate C, worth porting before the first billing model is written**

| Project | Shape | Probes |
| --- | --- | --- |
| **Lago** | modern usage-based billing (Rails/Postgres) | `BillableMetric`, `Charge`, `Plan`, `Subscription`, `Invoice`, `CreditNote`, `Wallet`, `Coupon` — the nearest existing thing to what candidate C would write. Money precision, credit-note-not-edit, usage rollup |
| **Kill Bill** | the long-lived billing reference (Java/MySQL) | an **effective-dated catalogue** — plan versions with a valid-from. Immutable invoice items, a subscription event stream. Candidate A's temporal gap, met in the small domain |

**Feeding candidate A**

| **ERPNext / Frappe HR** | payroll *and* double-entry accounting in one repository, as doctype JSON | `Salary Structure`, `Salary Slip`, `Salary Component`, `Income Tax Slab`, and `GL Entry` / `Journal Entry` — where the cross-row balance invariant lives |

**The runner-up domain**

| **Cal.com** ⚡ | booking | recurrence, availability windows, per-user timezone. Would force `@frontierjs/toolbelt/datetime` to become real |

**Gotcha classes `.lite` has no word for**

| Project | What it drags in |
| --- | --- |
| **Discourse** or **Redmine** | **single-table inheritance** — a `type` column, one table, many classes — which has no spelling here, and every Rails port meets it in its first fifty lines. **Polymorphism is NOT on this list any more and the correction is worth keeping**: this record predicted *no spelling*, and `@@arc` landed while it was open — an exclusive arc of nullable foreign keys with a table CHECK, so a CLOSED target set keeps every key, every cascade and the cross-model query. An OPEN set keeps the `(subjectType, subjectId)` pair, which is a stated choice with a stated cost (a sweep job, because the database will not) rather than a gap — `packages/litestone/references/Tag.lite` sets out all three shapes. What a Rails port asks now is **countable and better**: of N polymorphic pairs, how many are closed-and-small enough for `@@arc`, whose ceiling is around six? That is evidence about whether the boundary sits in the right place. It also cannot be answered from a schema — a `commentable_type` column says nothing about how many values it takes — so the converter reports candidates and never emits an arc |
| **Twenty**, **Formbricks** ⚡ | user-defined objects and fields — the schema-as-data question met as *data* rather than as an argument (and the reason § Considered declines building an EDC) |
| **OpenMRS** | EAV (the `obs` table) plus a privilege/role model — candidate B's adversary without a clinical domain to learn first |
| **Trigger.dev** ⚡ | runs, queues, schedules — a second opinion on caravan's model |
| **OpenFGA's sample stores** | not a schema: the canonical relationship-based access models (GitHub, Drive, Slack). A direct, cheap adversary for Invariant 6 |
| **Documenso** ⚡ | an immutable document with an audit trail and recipients — the payslip's shape, dev-sized |

Check the licence and the current ORM before vendoring anything, and copy
`openmrp.lite`'s header discipline: name the repository, the licence, the exact source
file, and every place the conversion made a choice the source did not.

### What a fixture costs

**A fixture nobody runs is worse than none.** `openmrp.lite` is honest because
`test/scale.test.ts` pins it — it parses, it builds a database, and booting again
against that database migrates nothing — and `bench/scale-schema.mjs` times it. Any new
port needs the same: one test that would go red if the parser regressed on that shape,
or it is four thousand lines of rot with a citation on top.

The natural home once there are two or three is a **CI phase** rather than a suite: parse
each corpus schema, emit its DDL and JSON Schema, and diff against a committed snapshot,
which is `scripts/ci.mjs`'s `snapshots` phase with no new machinery — every generated
artefact already names the command that wrote it in its own header.

### The half that is NOT built — `fli`'s side of the door

**Status: idea, nothing written.** `litestone import` is a Data-realm command: it
takes a file and answers a `.lite` plus a graded list of what the reading cost. What
it does not answer is the question an app arrives with — *I already have a schema,
give me an application* — and that answer lives one package up, in `fli`.

Two shapes, and they are not the same feature:

| | |
| --- | --- |
| `fli import <path>` | into an app that already exists. Mostly a passthrough: `fli` knows where `db/schema.lite` is, so the value it adds is the path and the refusal to clobber a schema somebody has edited |
| `fli new --from <path>` | the scaffold, seeded. This is the interesting one and the one with the argument against it |

**The argument against seeding the scaffold is not effort, it is what an imported
schema does not say.** It carries no `@@gate`, no `@@allow`, no `@@softDelete` and
no `tenancy { }`, because the source had nowhere to say any of them — so
`fli new --from` would scaffold an app whose Data boundary is **wide open by
construction**, and hand back something that looks finished. Every other route into
an FJS app starts from a schema somebody wrote a gate on. This one would not, and
nothing in the scaffold currently notices.

Three questions decide it, and none needs the code written to answer:

1. **Does `fli new --from` pass `--strict`?** A `changed` construct is a column
   whose meaning moved, and reviewing them is a step a person does. A scaffold that
   runs the reading, prints the warnings and carries on has converted a refusal into
   a log line — which is the shape `--strict` exists to refuse. Either the scaffold
   stops on `changed` and the person fixes the schema first, or the feature is
   `fli import` alone.
2. **Who says the boundary is undeclared?** The honest answer is probably
   `litestone advise` (legal-and-MISSING is already its half) or a `fli check` rule
   that fires on a model with no `@@gate` in an app that HAS gated models — not a
   banner the scaffold prints once and nobody sees again.
3. **Is the target a new app or a live database?** *Import* and *adopt* are
   different: an imported schema describes tables that already exist somewhere else,
   and pointing a new app at them needs `litestone migrate baseline`, which is a
   separate command with a separate refusal. Conflating the two is how a scaffold
   ends up generating a first migration that would drop somebody's production
   tables. **Whatever is built here moves no data and connects to nothing.**

What is cheap and probably right regardless of the above: `fli import` as the
passthrough, because an app that already exists has already answered question 1 by
having a person in front of it.

---

## See also

- `IDEAS/time-and-recurrence.md` — the calendar half of candidate A, already argued
- `IDEAS/compliance-from-the-seed.md` — candidate B's `@pii`/`@retain` neighbour, and
  the retention footgun (`FJS-521`) a disclosure log would inherit
- `IDEAS/time-travel.md` — why the UI-realm version of *what was true then* does not
  work, and why the answer is one realm down
- `IDEAS/slices.md` — what candidate C would be the first real consumer of
- `IDEAS/testing-realm.md` — the executed checks candidate B would extend
- `example/PROJECT_STATE.md` and its README's *Found by building this* — the ledger
  this record is arguing to extend
- `ISSUES.md` `FJS-561` (no composite `@@id`) — the gap § The corpus found on the day
  this record was written, invisible to every rule `fli check` could carry. Its sibling
  `FJS-560` was filed the same hour as *no `Decimal`* and was a misread of shipped
  behaviour; what it is now is the migration `example` still owes
- `DECISIONS.md` `FJS-D154` — allocation, the half `FJS-D142` left open and the one
  candidate C actually waits on
