# Idea — Reversible deployment transitions: the Release realm, sequenced

**Status: IDEA / ARCHITECTURE — except Phase 0, which shipped 2026-08-15**
(`litestone release` / `fli release:check`; see § Phases). Dated 2026-08-12. Produced
by two rounds of outside research — first a survey of how eleven deployment systems
actually fail, then a deliberate attempt to falsify the conclusions of the first.
Two of the six starting claims were falsified and are recorded as such below; the
rest survived in a narrower form. Sources are named inline, and where the evidence
is a vendor blog rather than an incident it says so.

This does not replace `IDEAS/offline-first-and-release.md` (which asks *what kinds
of artefact* a Release can be) or `IDEAS/operational-edge.md` (which asks *what an
operational edge would contain*). It answers the third question both of them leave
open: **what a Release is, and what a deploy may promise.** Artefact kind is a field
on the object this record describes.

---

## The finding

Every deployment system surveyed fails at the same seam, and it is not a maturity
problem. **The unit of a deploy is code; the unit of state is not; and the tools ship
a rollback button that only restores the first one.** Said in the systems' own words:

- Fly: *"you're rolling back the VM image, not the database… Fly isn't going to
  time-travel your data"*, and separately *"Rollbacks don't undo config changes"* —
  an older image runs against today's `fly.toml`, env and secrets.
- Heroku: a config-var change *is* a release, but if the release command fails
  *"the config var value remains changed even if the release command fails."*
- Kamal: `rollback` stops a container and starts an older image. Its documentation
  does not mention the database at all, and old images are pruned after three days,
  so the rollback target expires.
- Prisma: no down migrations by default; a migration that fails mid-way on a
  database without transactional DDL wedges (`P3009`) until a human resolves it.
- Rails: `IrreversibleMigration` is a documented feature — the schema is allowed to
  say *you cannot undo me*.

The same shape appears one layer out. A browser holding an old bundle is a fourth
version of the application, and after a deploy it requests chunks that no longer
exist. So the honest unit of a deploy is **code, schema, config, and the clients
already out there**, and every tool surveyed versions exactly one of the four.

**The conclusion that survived falsification is not "atomicity is impossible".** It
is that atomicity has a *location*:

> A deploy is a saga with a **pivot**. Steps before the pivot can be made
> compensable — including schema, including config, including which clients see
> what. Steps after it cannot. The job is not to provide rollback. It is to make the
> pivot explicit and push it as late as possible.

The vocabulary is borrowed from the saga literature, where a *pivot transaction* is
the point after which compensation is no longer available and only forward, idempotent
recovery remains (Azure's compensating-transaction pattern; Temporal's saga writeup).
**It appears in no deployment tool found.** That absence is the opening.

---

## What FJS can do that the field cannot

A generic deployer sees an opaque image, so it cannot answer *is this reversible?*
and therefore ships a rollback that guesses.

FJS owns the seed. A schema diff is structured, so it is classifiable: adding a
nullable column, a table or an index leaves the previous code working; dropping a
column, narrowing a type or tightening a constraint does not. That is the same
declaration-beats-recovery argument the framework already makes about access — and
it lands here for free, off a file the developer has already written.

The other end is owned too. Sierra builds the assets, so a Release can stamp its own
identity into the served HTML and keep the previous Release addressable for clients
that already loaded it. Vercel sells that as *skew protection*; here it is a
consequence of owning both ends of the wire rather than a product.

**Both are instances of the framework's existing pattern**: a fact that other
frameworks recover at runtime, FJS reads out of a declaration.

---

## The five invariants

Stated as invariants because each one, dropped, reproduces a specific documented
failure.

**1. A Release is immutable and environment-independent.** One artefact promotes
from staging to production unchanged; only bindings differ. Content-addressed, the
way Mesa scope ids already are.

*Needs an enforcer, or it is a wish.* A build that bakes configuration into the
artefact must be refused. This is live for us specifically: SvelteKit's
`$env/static/private` inlines at build time and its own documentation says *"Do not
use in combination with published Docker containers"*, and Vite gives us the same
gun.

**2. An Environment is mutable but generational.** It provides bindings only —
values, and *references* to secrets, never secret values.

The generation counter is the repair to the obvious version of this design. If an
Environment is mutable and uncounted, then reverting a Release restores the code and
whatever bindings happen to exist at that moment, which is precisely the Fly and
Heroku failure quoted above. **Serving state is the pair (Release, Generation)**, and
both halves are recorded.

Secrets stay references because the alternative deadlocks: AWS Secrets Manager
already gives a secret its own rollback axis through staging labels
(`AWSCURRENT`/`AWSPREVIOUS`), and pinning a *value* into a Release fights rotation —
a failed rotation blocks later rotations, and partial propagation leaves some
instances holding a cached credential that stops working when the old one is
revoked. It also means a revert can resurrect a credential, which is why Helm
practitioners reach for SOPS or External Secrets. **The guarantee is therefore
"revert restores the same bindings", never "the same secret values."** A rotation
underneath is invisible and correct.

**3. Transitions are journaled and idempotent.** Restart resumes; drift refuses.

Kubernetes solves the same problem with level-triggered reconciliation — controllers
compare current state to desired state continuously, which is what lets it survive
missed events, partitions and restarts. That property is real and it is why
Kubernetes is large. **We decline it and pay the stated price: no self-healing.** A
journal of idempotent steps plus a precondition check gives restart-safety without a
control plane.

*Drift needs a named surface* or the rule is decorative. Three things, all cheap and
all ours: schema against expected-at-last-applied (Atlas made exactly this a
pre-apply gate), the Release id currently serving, and the binding generation.

*Idempotent is not free* for steps that touch the world — a registry push, DDL, an
outbound send. The journal step id is the idempotency key. The repo has learned this
shape once already: Caravan's `unique` is a lock on work in flight, **not** an
idempotency key.

**4. The pivot is explicit.** Derived conservatively by FJS; declarable and
overridable by the developer; recorded **in the Release**, not passed as a flag, so
that the plan carries it and the decision reproduces.

Two directions are needed, not one. A developer must be able to *declare* a pivot the
schema cannot see — code that begins writing an existing column in a new format is a
pivot with an additive diff — and to *override* a pivot FJS called, which is the more
dangerous direction and belongs in the journal loudly.

**5. Revert restores serving state, not database history.** Before the pivot,
guaranteed. After it, forward-only, and said before you cross rather than after.

Two qualifiers ship with it. It holds **within the retention window** — a client that
loaded the previous Release after the window closed is not covered, and Vercel cannot
pin a hard refresh either. And **revert never contracts**: an expand is by definition
compatible with the previous code, so leaving it in place is safe and lossless, while
undoing it would destroy whatever the newer code wrote.

---

## Pivot is N-1 compatibility, and that makes the model smaller

Defining a pivot as *irreversible* describes the consequence. The definition one step
down is more useful:

> **A pivot is the transition at which N-1 compatibility ends** — where Release N-1
> and Release N can no longer serve simultaneously.

Any overlap of two versions forces N-1: a rolling deploy, a canary and a retention
window all put two Releases against one database at once, which is stated as guidance
in AWS's own DevOps material and is the standing rule in canary practice. Once the
definition is compatibility rather than reversibility, four separate features collapse
into one test:

| Thing | Under "irreversible" | Under N-1 |
| --- | --- | --- |
| expand migration | additive, so reversible | N-1 holds — not a pivot |
| contract migration | destructive, so a pivot | N-1 breaks — a pivot |
| old browser tabs | a separate retention feature | **the duration N-1 must hold** |
| gradual rollout | a separate canary feature | requires N-1, so legal only pre-pivot |

The retention window stops being a bolted-on setting and becomes the same number as
*how long must the previous Release keep working*. One knob, whole system. And the
question changes from a judgement (*is this migration reversible?*) to a query
(*can N-1 and N serve at once?*), which is answerable from a file we parse.

**Derived rule worth stating on its own: a pivot collapses every Audience onto one
Release.** Early adopters cannot sit on N while everyone else sits on N-1 when N-1
compatibility is exactly what just ended.

---

## Audience — preview releases without the canary machinery

An **Audience** is a named set of principals that a Release can be served to. Early
adopters, internal staff, one workspace, everybody.

This is deliberately *not* percentage canary, and the distinction is what makes it
cheap. Everything expensive about canary in the research was the **verdict**: Argo
Rollouts practitioners report static thresholds as a maintenance burden, note that a
1% canary at low traffic produces statistically meaningless metrics, and that short
analysis windows miss what appears a minute later. A cohort preview needs none of it —
the verdict is a human who tells you.

**The routing is the retention mechanism with a different selector.** Retention
already keeps two Releases addressable and routes by *which Release did this client
load*. An Audience routes by *who this principal is*. One table, two ways of filling
it.

**Only a framework that owns auth can do this**, which is why platforms offer
percentages and headers instead. Basecamp already resolves standing onto the principal
once per request; a cohort is one more resolved property. Membership must be a
server-side fact, not a client cookie — the same affordance-versus-enforcement split
that `x-gate` already draws. A self-serve beta opt-in is fine, being simply a cohort
one is allowed to join.

**Consequence for the earliest phase:** the journal records serving assignment as a
set keyed by Audience even while the only entry is `everyone`. One column now, a
journal migration later.

This absorbs `IDEAS/overview.md` 4.10 (preview environments) from the other side: 4.10
is a *branch* getting its own environment and TTL, and an Audience is a *cohort*
getting its own Release. They meet at the same routing table and should be built as
one thing.

---

## The hole in this record: the step between expand and contract

Added 2026-08-12, found by a sweep for what a developer still has to wire up by hand.
It is a gap in the design above rather than beside it, so it is recorded here rather
than in a new file.

Phase 1's guarantee ends with *"a contract deploy is refused and offered as a split."*
That sentence hands back a three-step plan — **expand now, backfill, contract later** —
and this record specifies the first step, the third step, and the classifier that tells
them apart. **It specifies nothing at all for the middle one, which is the only step
that takes hours and the only one that can fail halfway.**

Adding a nullable column is a migration. Filling it for ten million existing rows is
not: it must be resumable after a restart, throttled so it does not starve the live
application, observable while it runs, and re-runnable without doubling its own work.
None of those are properties of a migration, and Litestone's migration runner should
not grow them — a migration is a schema change applied once inside a transaction, and
that definition is worth keeping.

The consequence is that the split we offer is not currently a plan a person can follow.
Offering it while the middle step is a hand-written script is worse than not classifying
the pivot at all, because the refusal implies there is a supported alternative.

**It is the same machinery as the journal, which is the useful part.** A backfill is a
sequence of idempotent steps with a resumable position, recorded somewhere durable —
which is what the deploy journal already is. That makes this the second workflow in a
system built to hold exactly one, and it is the strongest available evidence for
`IDEAS/operational-edge.md` §4: **the noun is arriving twice now, not once.** Whether a
backfill is a Caravan job with a cursor, a journalled transition, or the first user of
a general durable-workflow primitive is the decision, and it should be made once rather
than discovered when the second implementation does not match the first.

Two smaller things fall out and are worth stating so they are not rediscovered:

- **A backfill is a bulk write, so it is a bulk audit problem.** `FJS-074` closed the
  hole where bulk writes logged nothing; what a bulk entry still does not record is
  *contents* (`IDEAS/overview.md` 4.13). A backfill over the whole table is the largest
  such write an application will ever make.
- **The classifier should know about it.** *Expand / contract / unknown* could grow a
  fourth answer — *expand, and a backfill is required before the matching contract can
  pass* — which is derivable, because a new non-null column with no default is exactly
  that case. That turns the split from advice into a checked sequence.

---

## Phases

Sequenced by one rule, which is the reason the phases fall where they do:

> **State shape early, behaviour late.** Anything that changes what gets *recorded* —
> Release fields, journal rows, binding generations, audience keys — belongs in the
> first phase even when unused, because a recorded-state migration is the expensive
> kind of change. Anything that only *does* something can wait.

### Phase 0 — Know — **shipped 2026-08-15**

A pivot classifier and nothing else. `fli release:check` reads a schema diff and
answers **expand / contract / unknown**, with unknown counting as contract. A
committed snapshot and a CI phase that fails a stale one.

Built as `litestone release` (`packages/litestone/src/release.js`) with
`fli release:check` as the app-facing door. Three things it settled that this
record left open:

- **The baseline is git, not a second file.** `db/release.snapshot.md` holds the
  release SURFACE and never the verdict — a verdict is a fact about two schemas
  while the file describes one, so writing it in makes the file depend on its own
  previous contents, which is not a fixed point and therefore not recheckable.
  The schema at `HEAD` (or `--from v1.4.0`, or a path) is the other side.
- **Access is in the comparison.** Raising a `@@gate` and adding an `@@allow` are
  compatibility changes — N-1 callers are refused, or quietly filtered with a 200
  — and this is the half no generic deployer can reach at any price. Run over
  basecamp's working tree it reported 14 contracts, one per model that gained the
  row-level tenancy predicate: the first time that change was visible as a deploy
  risk rather than as a schema edit.
- **The fourth answer is a plan, not a verdict.** A new required column with no
  default comes back as a contract carrying its three steps (expand → backfill →
  contract) rather than as a fourth state. The classifier stays tri-state, and
  the split is attached to the finding that needs it — which leaves the open
  question below about a fourth answer answered in the narrower direction.

It needed no CI edit, which was the claim: the snapshot names its own generator
in its header, and the `snapshots` phase found it.

**This is an existing repo idiom, not a new mechanism**: it is the shape of
`fli test:access` → committed `db/access.snapshot.md` → the `access` phase in
`scripts/ci.mjs`, asking a different question. It slots in beside it.

Worth first because it is the differentiating idea, it needs no infrastructure, and
it has value even for an app deployed entirely by hand.

### Phase 1 — Ship

The minimum that deploys a beta app and takes it back: the Release object,
content-addressed; the build check that refuses baked-in configuration; the
Environment binding set with its generation counter; the journal, in a Litestone
database, so the deploy realm is inspected with the tools the framework already has;
build → push → expand-migrate → start → health → switch → keep previous; and
`fli revert`.

`--plan` belongs here rather than later. It is how phase 1 is debugged and how it is
trusted, and it is cheap because the steps already exist as journal rows — printing
instead of executing. Terraform's `plan` is the good half of Terraform.

Guarantee: *before the pivot, revert restores code, configuration and schema to the
previous serving state; a contract deploy is refused and offered as a split.*
Promises nothing about already-loaded browsers, nothing about third-party services,
one host, and a health check that means "the process answers" and is described that
way.

### Phase 2 — Attach

The **attached service** — a third-party dependency the app needs and does not own.
Declared in the app, bound per Environment, and a missing or mismatched binding is a
startup refusal rather than a runtime mystery. Dev-side convenience is a generated
compose file with ports from the existing `fli` broker, so collisions are impossible
by construction.

We never manage the service: not install, not upgrade, not health-check, not back up.
Provisioning is easy and *de*-provisioning is where integrated platforms die — the
loudest complaint from a paying Encore customer in the research was an environment
stuck destroying for days. This is the same line `IDEAS/operational-edge.md` §1 draws
around provisioning, held at the Release boundary.

**The answer to "keep dev and prod in sync" is to sync the declaration, not the
instance.** Syncing instances is the trap.

Placed second because it is a daily pain and it is small — Environment bindings from
phase 1 already do most of the work.

### Phase 3 — Survive

Release identity stamped into served HTML, the previous Release's assets kept
addressable for a stated retention window, and the routing table that serves two
Releases at once. **Audience preview falls out of this phase rather than being its
own.** The first phase that crosses into the UI realm, so it wants Sierra.

Extends the guarantee to browsers that already loaded the old version, within the
window. Still refuses full-page navigation pinning, which nobody has.

### Phase 4 and later — not soon, and say so

Multi-host; percentage canary; metric verdicts; automated schema shadowing of the
pgroll or PlanetScale kind; anything that provisions infrastructure. Canary in
particular is gated on the N-1 test being trustworthy in real use, which is phase 0
matured rather than a new build.

**Basecamp as the deploy console** lives here — the fleet view, triggering a deploy or
a revert, watching progress live. It is a small build because basecamp already has
every part: a gate ladder for who may deploy, channels so a triggered deploy announces
and a second tab sees it, and `/hub/` for the cross-workspace view of many apps. A
deploy console is services plus a resource, which is the app's whole shape.

Two rules keep it from becoming Forge. **Basecamp is a viewer and a trigger, never the
source of truth** — the journal lives with the app, and if basecamp vanishes `fli`
still deploys and still reverts. And **CLI-first, always**: basecamp must be deployable
by `fli` with no basecamp running, or the first bad deploy of the console leaves no
hands to fix it.

What this needs from phase 1 is shape, not work: `fli` output that a machine can read,
which is `IDEAS/overview.md` 4.2b's contract arriving where it is first needed, and a
journal that is already a queryable database.

---

## What each phase lets us honestly say

| After | The claim |
| --- | --- |
| 0 | *We know whether this change is reversible.* |
| 1 | *…and if it is, one command puts it back.* |
| 2 | *…and every external dependency is declared, so environments cannot drift silently.* |
| 3 | *…and that includes the browsers already out there, for N days.* |

Each line is true when shipped and stays true afterwards. No phase invalidates the
previous mental model, which is the actual test — *preserve the mental model, not the
mechanism*.

---

## Escape hatches

Three tiers, because the failures live at different depths.

1. **Replace a step.** Every transition is named and swappable — the migration step,
   the health check, the asset upload.
2. **Take the plan.** `fli deploy --plan` emits the whole transition as a readable
   script to run yourself, in your own CI. The plan is simultaneously the escape hatch
   and the documentation, which is what stops anyone having to trust a black box.
3. **Declare the pivot yourself.** Classification is the default, not the authority.

The rule that keeps them from rotting: **an escape hatch must not disable a guarantee
silently.** Replace the migration step and the tool says the reversibility claim is now
yours.

---

## Refusals

Stated up front, because refusals are the product and every system surveyed grew heavy
by not having any.

- **No orchestrator.** One host by default, a few by convention. Not a scheduler, not
  a mesh, not a control plane.
- **No managed database.** Fly ships a documentation page titled *"This Is Not Managed
  Postgres"* while the command is `fly postgres`; we will not build a thing whose docs
  have to disown it.
- **No percentage canary in the first pass**, because a canary offered without
  enforcing N-1 is a footgun sold as a feature.
- **No secret values in a Release.** References and stages only.
- **No reconciliation loop.** Detect drift, refuse, name it. A Terraform apply that
  "fixes drift" is a documented way to take down a live database.

**And the constraint inherited from `IDEAS/offline-first-and-release.md`: this must
degrade to nothing.** The single-binary-plus-one-file path stays the shortest one. It
does degrade — a Release is still an object and a journal is still a row when the
artefact is one executable; what disappears is the traffic switch, which becomes
stop-then-start with a stated downtime window rather than a missing feature.

---

## What was falsified, and what it cost

Kept because a claim that died is worth more than one that was never tested.

**"Database state can never participate in a rollback" — false.** Four counterexamples
exist: PlanetScale keeps the pre-change table alive and syncing after cutover so a
revert is a second table swap; pgroll serves both schema versions as views; Neon
restores a branch to any point inside its history window; Dolt keeps a commit graph in
the database. Each has a price — Dolt is *"slower on write by design"* and wants RAM at
10–20% of disk, Neon's window is hours to days by plan, and PlanetScale publishes no
list of unsupported changes.

What survives underneath is sharper than the original claim, and it is the useful part:
**schema state and row state have different physics.** Schema is reversible where the
two versions can represent the same rows, which is expand-contract restated. Rows are
restorable only by returning to a point in time, which discards every write since. You
may have *undo the schema* or *keep the writes*; both only where old and new are
mutually representable.

**"Config cannot be versioned with a release without creating secret problems" —
false.** Cloud Run's revisions capture image, environment variables and settings as one
immutable object; Helm stores manifest and values per revision; Nomad versions jobs and
reverts them. Kubernetes' own gap is the counterexample that proves it: Brian Grant,
one of its authors, records that controllers ignore ConfigMap updates and
`kubectl rollout undo` does not restore one, that the cause was ConfigMap and Deployment
shipping together with no time to build rollout mechanics, and that both working
patterns **couple the config version to the workload version** by content hash. The
residue is secrets alone, and invariant 2 is the answer to it.

Two claims from the same round that did **not** fall, and are load-bearing above:
atomicity genuinely stops at external effects, already-delivered clients, rows written
under the new schema, in-flight requests, and caches below us — Cloud Run states four
of the five in its own documentation. And a generic transition model is real but
smaller than hoped: the four nouns recur across Cloud Run, Lambda, Nomad, ECS, Helm and
Kamal by convergent evolution, while the *execution* does not generalise — plain
Compose has no traffic layer at all and stops the old container before starting the new.

---

## Open questions

- ~~**Does the classifier need a third answer?**~~ — **answered by shipping it.**
  *Expand / contract / unknown* stands; the verdict is the worst finding and the
  findings are all reported, so a mostly-additive diff with one narrowing reads as
  a contract WITH its expands listed beside it rather than as a flat refusal. What
  is still unmeasured is whether *required → optional* (a contract, because this
  release may write a NULL N-1 has no case for) is the one that annoys in real use.
- **Where does the Release declaration live** — its own file beside `db/schema.lite`,
  or `frontier.config.js`, which `IDEAS/app-manifest.md` is already shaping. If the
  former, whether *everything derives from the schema* holds literally here or by
  analogy.
- **Is the compose file for an attached service ours to generate or yours to write?**
  The line between helpful and Caprover is exactly there.
- **Retention economics.** Nobody publishes the storage and routing cost of keeping N
  Releases addressable for a week. We would be finding out.
- **Who owns a backfill** — a Caravan job holding a cursor, a journalled transition, or
  the first caller of a general durable-workflow primitive. Made once, or discovered
  twice.
- **Whether an Audience is a Deployment-realm noun or a Data-realm one.** It is a set
  of principals, which sounds like the Trust Hierarchy's neighbourhood, and if it is
  declarable in the seed then `@@gate` and Audience should be checked against each
  other before either name is settled.

## See also

- `IDEAS/offline-first-and-release.md` — artefact kinds, and the degrade-to-nothing
  constraint this record inherits
- `IDEAS/operational-edge.md` — §1 provisioning (refused here for now), §2 preview
  environments (meets Audience at the routing table)
- `IDEAS/app-manifest.md` — declared intent versus observed fact; the Release object is
  the same argument one realm over
- `IDEAS/testing-realm.md`, `IDEAS/testing-and-ci.md` — where the phase-0 snapshot
  lands in `bun run ci`
- `ARCHITECT.md` §2 — the Deployment-realm vocabulary these nouns are proposed into
- `packages/basecamp/` — the deploy console's host, and the first real deploy target
