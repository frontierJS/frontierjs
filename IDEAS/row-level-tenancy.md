# Idea — Row-level tenancy: the primitive basecamp has paid for 37 times

**Status: IDEA. Nothing here is built.** Dated 2026-08-12, from a sweep asking what
whole *categories* the framework has no answer for, as distinct from features it is
missing. Every claim below was probed against the tree.

Db-per-tenant already works at the Litestone level and is not what this record is
about. This is the other half — **many tenants in one database, separated by a
column** — which is the shape almost every B2B application actually has.

---

## The evidence that this is a missing primitive

Not an argument, a count.

- `ARCHITECT.md` §5: *"row-scoped tenancy has no primitive yet."*
- `ISSUES.md` `FJS-007`, closing the largest access-control piece of work in the repo:
  *"Still open beside it: `@@allow` for row-level tenancy, which the gates deliberately
  do not express."*
- **basecamp declares 37 models and exactly one of them expresses its tenancy in the
  schema** — `Server`, with `@@allow('all', workspaceId == auth().workspaceId)`. The
  other 36 are a service where-clause plus `scopeToWorkspace`, written by hand, one
  model at a time.
- No file in `IDEAS/` owns the subject. Ten mention tenancy in passing; none is about
  it.

**One thing written thirty-seven times is a missing declaration.** That is the same
observation that produced `@@gate` — `FJS-007` records that the levels *"are not a
design drawn on paper, they are the `requireWorkspaceRole` calls the services were
already making, moved to the one place that also covers an engine calling a service
in-process."* The identical sentence is available here, about the where-clause.

---

## Why it is a category rather than a feature

A missing feature costs work. **This one decides which applications can be built
safely at all.** B2B SaaS is the dominant shape of the software people pay for, and
every one of those applications is one forgotten `WHERE` away from serving one
customer's rows to another — the class of failure that ends a company rather than a
sprint.

The framework's existing answer makes the stakes worse rather than better, and this is
worth being blunt about. `CLAUDE.md` already records the hazard: **a `@@gate` refuses
and a `@@allow` filters, so a wrong policy is an empty screen rather than an error.**
Row tenancy is entirely built out of the filtering half. Done well, a cross-tenant leak
becomes unexpressible. Done by hand, thirty-seven times, the failure is silent in both
directions — a missing clause leaks, and a wrong one returns nothing with a 200.

---

## What already exists to build on

More than it looks, which is the argument for doing it properly rather than
generalising basecamp's helper.

- **Policies compile into SQL.** `@@allow`/`@@deny` are already predicates over
  `auth()`, applied at the Data boundary rather than in a handler. The mechanism is
  shipped; what is missing is a way to say *this model belongs to a tenant* once.
- **The principal already crosses the boundary properly.** `toDataPrincipal()` is the
  named seam that turns a `SessionContext` into what `auth()` reads, and `CLAUDE.md`
  records what happens without it — every row policy compares against `undefined` and
  matches nothing, silently.
- **`$scopedBy` is already a client flavour.** Whatever this becomes has a place to
  live that is not a new concept, and the `$check*` rule applies: a capability that
  depends only on the schema belongs on every flavour of client.
- **basecamp has already solved the hard part by hand.** `applyStanding()` resolves
  membership per *request* onto the principal, because — quoting `FJS-007` — *"the same
  person is `owner` in one workspace and `viewer` in the next"*. That is the discovery
  the primitive has to absorb: **a tenant is not a property of a user.** A design that
  puts `tenantId` on the session and stops there reproduces exactly the bug that
  investigation started from.

---

## The shape of the declaration — the question, not the answer

Three candidates, deliberately not chosen here.

1. **Per-model marker** — `@@tenant(workspaceId)`, sugar that expands to the `@@allow`
   basecamp writes on `Server`. Smallest change, keeps the existing mechanism visible,
   and still repeats the column name 37 times.
2. **Schema-level declaration** — name the tenant model once, and let each model say
   only that it participates. Fewest repetitions, and the strongest position for
   deriving everything downstream, but it invents a top-level noun and the seed has
   resisted those.
3. **Convention with an opt-out** — a column of a known name makes a model tenanted
   unless it says otherwise. Cheapest to write and the worst to debug, because the most
   important fact about a model would be invisible in it. **Probably refuse**: the
   framework's own rule is that declaration beats derivation where a mistake is silent,
   and this mistake is silent.

Whichever wins, two things have to be true of it: **a model that is *not* tenanted must
say so out loud** — the dangerous default is the one where forgetting is indistinguishable
from deciding — and the tenant must be resolvable per request, per the `applyStanding`
finding above.

---

## What it must not make impossible

The escape hatch is not optional here, because legitimate cross-tenant reads exist and
basecamp already has one: `/hub/` is a separate service taking no workspace, behind a
single `requireSystemAdmin` hook, reading through `asSystem()`. That pattern is the
right shape — **crossing tenants is a different service, gated once, visibly** — and any
declaration that makes it awkward will be worked around in ways nobody can audit.

Three bypasses already exist and each needs an answer rather than a discovery:

- **`asSystem()`** crosses everything by design. Fine, and it should stay the one
  audited door.
- **Raw SQL.** `CLAUDE.md` records that raw statements enforce no `@@allow`, which makes
  every raw query in a tenanted app a potential cross-tenant read. This is the same seam
  as `IDEAS/scoped-sql.md` (4.4a) and the two should be designed together — a view
  derived from the policy set is exactly what a tenanted app needs SQL to run against.
- **Relations and aggregates.** A policy on the parent does not obviously constrain a
  batched include or a `count`. Whatever the answer is, it has to be tested rather than
  assumed, because this is where a hand-written version leaks first.

---

## What it unblocks

- **Derived tenancy suites.** `IDEAS/testing-realm.md` 3.4 already generates gate and
  policy tests per model from the seed. A declared tenant makes *"model X returns no row
  belonging to tenant B"* a generated test rather than a hoped-for one, on all 37 models
  rather than the one somebody remembered.
- **The permission diff gets a second column.** 4.3 reports *this PR widens
  `User.email` from level 5 to 2*; with tenancy declared it can also report *this PR
  makes `Invoice` cross-tenant readable*, which is the sentence an auditor actually
  wants.
- **Live queries stop being a special case.** `IDEAS/live-queries.md` already argues
  that a fan-out can withhold a row per socket by comparing the row against each
  subscriber's level. A declared tenant is one more term in that comparison, rather
  than a second mechanism.
- **Audience, from `IDEAS/release-transitions.md`, stops being a lone idea.** An
  Audience is a declared set of principals; a tenant is a declared set of rows. If both
  are settled independently the framework will grow two vocabularies for *which
  subset*, which is exactly the duplication `ARCHITECT.md` §2 exists to prevent.

---

## Open questions

- **Is the tenant column a policy or a schema fact?** Everything above treats it as a
  policy with better ergonomics. The stronger version — the tenant is part of a row's
  *identity*, so a write cannot name another tenant even by accident — is a different
  and more invasive claim, and it is the one that would make leaks unexpressible rather
  than merely unlikely.
- **What happens to a foreign key across tenants?** basecamp's workspace FK cascade is
  load-bearing for its own seed teardown (`FJS-007`), so the answer has consequences
  beyond reads.
- **Does this subsume `scopeToWorkspace`, or sit under it?** Thirty-six models use the
  helper today, and the migration path decides whether this lands incrementally or as a
  rewrite of the app that proves it.
- **How does it interact with 4.5 (`warden`)?** Orthogonal named roles and a tenant
  scope are two different non-ordinal axes arriving at the same boundary. Deciding them
  separately is how a system ends up with two answers to *may this caller see this row*.
- **Db-per-tenant and row-per-tenant in one application.** Litestone supports the first
  today. Whether an app may use both, and what that means for a migration between them,
  is unasked.

## See also

- `ISSUES.md` `FJS-007` — the gate ladder that stopped exactly here, and the
  per-request standing discovery this design has to absorb
- `IDEAS/scoped-sql.md` — the raw-SQL bypass, which is the same seam
- `IDEAS/compliance-from-the-seed.md` — the permission diff this would extend
- `IDEAS/testing-realm.md` — the derived suites that would cover it
- `IDEAS/release-transitions.md` — Audience, the other declared subset
- `packages/basecamp/db/` — 37 models, one of which declares its tenancy
