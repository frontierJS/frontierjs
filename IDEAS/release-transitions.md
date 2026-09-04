---
id: release-transitions
status: partial
dated: 2026-08-12
revised: 2026-08-26
---

# Idea — Reversible deployment transitions: the Release realm, sequenced

**Status: IDEA / ARCHITECTURE — except Phase 0, which shipped 2026-08-15**
(`litestone release` / `fli release:check`; see § Phases). Dated 2026-08-12. Produced
by two rounds of outside research — first a survey of how eleven deployment systems
actually fail, then a deliberate attempt to falsify the conclusions of the first.
Two of the six starting claims were falsified and are recorded as such below; the
rest survived in a narrower form. Sources are named inline, and where the evidence
is a vendor blog rather than an incident it says so.

**Revised 2026-08-26 by a third round, which asked a narrower question than either
of the first two: not *how do these systems fail* but **what do they record**.** Nine
systems were read for their recorded-state format alone — Cloud Run, Cloudflare
Workers, Helm, Nomad, NixOS, Kamal, Argo CD, Erlang/OTP and Vercel — and the answer
was the same two nouns everywhere: a frozen artefact-plus-bindings, and a mutable
pointer at it. That is the Release ⨯ Environment pair below, arrived at
independently by nine systems, which is as close to a settled shape as this field
offers. **What the round changed is five details inside it**, folded into the
invariants rather than listed apart, because a detail kept beside the rule it
corrects is one somebody reads. It also ran an audit of this tree, which is
§ What is already recorded — the finding being that the retrofit this record was
written to avoid has already started in five places.

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

**The other end of this road is Erlang/OTP, and it is a warning rather than a
target.** OTP is the one system in the survey where a framework owns enough to do the
maximalist version: a release ships an `appup` per application and a `relup` per
release *pair*, carrying explicit upgrade **and downgrade** instruction lists that the
release handler evaluates in place. It is real, it is decades old, and it is used by
almost nobody, because authoring a downgrade for every pair is a cost paid on every
release against a risk taken on few. **Classifying reversibility is the cheap version
of the same idea** — the classifier is a function of two schemas rather than a
document a person writes — and this record does not grow toward `relup`. If a
transition cannot be reversed, that is said before the pivot rather than repaired
after it.

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

**A counter alone is the weaker half, and the field has already found the stronger
one.** Kubernetes' documented gap is that `kubectl rollout undo` does not restore a
ConfigMap, and the working answer practitioners converged on is not a counter but a
**content hash**: kustomize's `configMapGenerator` appends a hash suffix to the
generated name, so a changed value renames the object, the workload's reference
changes with it, and the rollout — and therefore the rollback — is exact. A counter
answers *which one came first*; a hash answers *are these two the same*, which is the
question a revert actually asks. So the binding set records **both**: `generation`
for order and for a person reading a list, `bindingsHash` for identity. Recording
only the counter means a revert can say *generation 7 exists* and cannot say *nothing
has moved since*.

Secrets stay references because the alternative deadlocks: AWS Secrets Manager
already gives a secret its own rollback axis through staging labels
(`AWSCURRENT`/`AWSPREVIOUS`), and pinning a *value* into a Release fights rotation —
a failed rotation blocks later rotations, and partial propagation leaves some
instances holding a cached credential that stops working when the old one is
revoked. It also means a revert can resurrect a credential, which is why Helm
practitioners reach for SOPS or External Secrets. **The guarantee is therefore
"revert restores the same bindings", never "the same secret values."** A rotation
underneath is invisible and correct.

**A reference must be pinned, and `latest` is refused.** Cloud Run resolves a secret
reference **at instance startup** and its own documentation says to pin the version
rather than use `latest` — because with `latest` two instances of one immutable
revision hold two different values, which makes the revision immutable in name only.
The reference recorded in a Release is therefore `name@version`; a Release naming
`latest` is refused at build, the same way a baked-in configuration value is. This
does not weaken the rotation argument above: a rotation moves the Environment's
binding to a new pinned version, which is a new generation and a new `bindingsHash`,
and that is exactly the event a generation is for.

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

**That key now exists and this is its fourth caller.** `@frontierjs/toolbelt/history`'s
`occurrenceKey(kind, ...parts)` is the one definition of *this exact unit of work
already happened*, with injectivity as its stated property and a namespace separating
the mechanisms that share one table — junction's idempotency claim, junction's outbox
relay and caravan's cron fire are the other three (`FJS-342`). A deploy step is
`occurrenceKey('deploy', releaseId, step)` and nothing new is invented.

**A journal format is a replay contract, so it carries a version from row zero.**
Temporal is the system that pays for this in public: workflow code must be
deterministic against recorded history, and its versioning call writes a marker into
that history **permanently** — the call cannot be removed even after every workflow
that needed it has drained, because removing it changes the past. Terraform states the
same lesson from the storage end: its state carries a `version` field and newer state
is unreadable by an older binary, which is a one-way compatibility that has to be
designed rather than discovered. Two rules fall out and both are free today and
impossible later. **The journal carries a format version**, so a newer `fli` reads an
older journal and an older `fli` refuses a newer one *by name*. And **step kinds are
additive only** — a kind that has ever been written is never removed or repurposed,
because a resumed transition replays rows a previous version wrote.

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

**Retention is where every surveyed system's guarantee quietly dies, so it is recorded
on the Release rather than configured beside it.** Kamal keeps the last five
containers and prunes after three days, and its own documentation states the
consequence — `kamal rollback` works only for a version whose container is still
there, and otherwise you redeploy. Argo CD's `revisionHistoryLimit` defaults to ten.
Helm's `maxHistory` is tuned *down* in practice to keep etcd small, trading rollback
depth for storage. Cloudflare raised the versions available for rollback from ten to
one hundred in September 2025, which is what hitting the limit looks like from
outside. In every case the setting lives away from the object it bounds, so the
promise expires silently and is discovered by the person reverting at the worst
moment. **A Release therefore records its own retention**, and `fli revert` refuses a
target whose window has closed by naming the date it closed — a refusal that says
*this is gone and here is when it went* rather than an obscure failure against a
missing image.

---

## What is already recorded, in five places that do not know about each other

Added 2026-08-26 from an audit of the tree. The sequencing note in
`IDEAS/overview.md` says this row's shape matters more than its scope because *a verb
can be added later, a recorded-state format cannot*. **The audit's finding is that the
retrofit has already begun**: five stores in this repo hold a piece of the serving
state, in five formats, none aware of the others.

| Where | What it holds | Shape |
| --- | --- | --- |
| `db/release.snapshot.md` | the schema surface | a committed file; git is the baseline |
| `releases/<commit>` + `current` | which build is live | a **directory name** is the release id |
| the `_replaced` container | the rollback target | **one** renamed container |
| `Deployment` / `DeploymentStep` | basecamp's pipeline | rows: `configSnapshot`, `builtImage`, `previousDeploymentId` |
| `Environment.variables` + `version` | per-environment bindings | a `Json` column and an `@version` |

Three things follow, and each is cheaper to act on now than after an install exists.

**The schema term is done and the other terms are the gap.** `release.snapshot.md`
is committed for both apps and the `snapshots` CI phase already fails a stale one and
catches a *removed* one against the base ref. So the Release's schema half is built,
gated and reviewed; what is missing is the image digest, the binding set and the
recorded verdict. That is a smaller build than this record's phase 1 implies.

**`Environment.version` is the right column with the wrong semantics.** It is a
`@version` — an optimistic-concurrency guard, so two people editing the bindings
cannot silently overwrite one another. It moves on every edit and nothing pins a
Release to a value of it, which is precisely the uncounted Environment invariant 2
refuses. It is one field away from being the generation, and adding the second field
(`bindingsHash`) beside it is free today.

**Depth one is not history.** The symlink, the `_replaced` container and
`previousDeploymentId` each hold exactly one step back, so a revert can be taken once
and not twice. That is the shipped state's honest description and it should be said
out loud rather than fixed incidentally.

One rule from the survey applies directly to the journal rows this record proposes.
**A journal row names bytes; it never holds them.** Helm stores each revision's
rendered manifest and values in a Kubernetes Secret, which meets etcd's 1MB object
limit — so on a large chart the *history* mechanism fails the *upgrade*, and the
field's workaround is to lower `maxHistory`, trading rollback depth for storage. A row
here records a digest, a hash and a path; the bytes live where bytes live.

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

## The hole in this record: the step between expand and contract — **filled 2026-08-29**

Added 2026-08-12, found by a sweep for what a developer still has to wire up by hand.
It is a gap in the design above rather than beside it, so it is recorded here rather
than in a new file.

**It is built** (`FJS-D157`). `defineBackfill({ name, model, field, fill })`, a
`BackfillRun` row and `app.configure(backfills([...]))`, shipped from junction the way
the outbox is. Four of the five properties below come from the shape rather than being
built — the row is the checkpoint, Caravan makes each chunk durable and retried, and
**idempotence is the PREDICATE and not the cursor**: a chunk re-reads *the column is
still null*, so an interrupted one skips what it already wrote whatever position was
saved. Throttling is the one build and it is a duty cycle, measured on this side of
the wire; what it cannot see is said out loud. The classifier's fourth answer arrived
as the layering this record did not predict: **litestone names the column and stops**
(`needsBackfill` on the finding), because which mechanism fills it is a question about
the running application, and `fli release:check` renders the advice.

**One thing below is now disagreed with**, and it is the paragraph about 4.19. The
reading taken is the opposite: two narrow mechanisms that look alike are not yet a
primitive, and a backfill is a *cursor over one table* — no steps, no compensation, no
point past which it can only go forward. 4.19 stays where it is.

The rest of this section is kept as it was written, because the property list is the
part that turned out to be right.

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

**The five properties are not a guess, and pgroll has already paid for them.** It runs
the expand/contract pattern on Postgres with the backfill inside the tool rather than
beside it, and what it reports needing is: **idempotent**, **resumable** after an
interruption, **chunked** into batches, **checkpointed** so the position survives a
restart, and **throttled** against live traffic. A Caravan job holding a cursor gives
the first four almost for free. **Throttling is the one nothing here has** — no
mechanism in this repo slows itself down because the application is busy — and it is
therefore the part of 2.3e that is a build rather than an assembly.

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

> **State shape early, behavior late.** Anything that changes what gets *recorded* —
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
content-addressed over an image **digest**, a `bindingsHash`, the schema surface and
the recorded pivot; the build check that refuses baked-in configuration and a secret
reference naming `latest`; the Environment binding set with its generation counter
beside that hash; the journal, in a Litestone database, carrying a format version and
step ids from `occurrenceKey`, so the deploy realm is inspected with the tools the
framework already has; build → push → expand-migrate → start → health → switch → keep
previous, for a stated retention recorded on the Release; and `fli revert`.

`--plan` belongs here rather than later. It is how phase 1 is debugged and how it is
trusted, and it is cheap because the steps already exist as journal rows — printing
instead of executing. Terraform's `plan` is the good half of Terraform.

Guarantee: *before the pivot, revert restores code, configuration and schema to the
previous serving state; a contract deploy is refused and offered as a split.*
Promises nothing about already-loaded browsers, nothing about third-party services,
one host, and a health check that means "the process answers" and is described that
way.

#### Phase 1, decomposed — six steps, in this order

Added 2026-08-26. Sequenced by the same rule the phases are: **state shape early,
behavior late**, so the first two steps write nothing and deploy nothing, and the
thing that is expensive to change is settled while it is free. Each step is
independently shippable and each names what proves it.

**1a · The models, and nothing that writes them.** `Release`, the Environment binding
set with `generation` + `bindingsHash`, and the journal with its steps — declared as a
`.lite` fragment a package ships and the app imports, which is the idiom junction's
outbox and auth's machinery already use, so an upgrade reaches an installed app.
Every field is present including the ones nothing writes yet: the audience key
(§ Audience says one column now, a journal migration later), `retentionUntil`, and the
journal's format version. Proved by the artefacts the repo already gates — the models
appear in `release.snapshot.md` and `access.snapshot.md` as a reviewable diff, and
`verifyGateLadder` and `verifyRowPolicies` grade them. **Two decisions belong here and
nowhere later.** Where the journal physically lives is the first (see § Open
questions). The second is what basecamp's existing `Deployment` and `DeploymentStep`
become: they describe the fleet console's own actions, the journal describes the
app's, and one of the two has to be declared a mirror of the other before both are
written to.

**1b · The Release is minted, and nothing deploys it.** — **shipped 2026-08-26**
as `fli release:mint` over `packages/cli/core/release.js`; reproducibility proved
against basecamp, and the environment is asserted OUT of the id so promotion
cannot quietly become a rebuild. Two things it settled that this record left
open: the schema term is the committed `release.snapshot.md` HASHED rather than
re-derived, so there is one answer to *what is the data boundary of this
release*; and bindings are declared in the deploy block as `bindings` (values)
beside `secrets` (pinned references), which is where invariant 2's *never secret
values* becomes a shape rather than a rule to remember. The digest term is still
absent by construction — `2.3f` is its prerequisite and it says *not built*
rather than showing a tag. A command that computes the
four terms and writes one row: the image digest, the `bindingsHash` over the resolved
binding set, the schema-surface hash off the snapshot that already exists, and the
pivot verdict from `classifyPivot` against the Release currently serving. **`2.3f` is
a prerequisite rather than a neighbor** — a Release cannot be content-addressed while
its artefact is named by a tag that means different bytes on different hosts — so
*digest, not tag* is either taken first or folded in here. Proved by reproducibility:
two builds of an unchanged tree mint the same Release id, which is the assertion
Mesa's content-addressed scope ids already carry.

**1c · The build check that refuses baked-in configuration.** — **shipped 2026-08-26**
as `packages/cli/core/build-check.js`, with three callers: `fli deploy`'s
`02b-build-check` step, which **refuses**; `fli deploy:local`, which reports; and
`fli deploy:doctor`, which asks the question without deploying anything.

**It is not a `fli check` rule, and the reason is the input.** This record proposed
one, and `FJS-D133` does make that the arch-test surface — but `fli check` reads the
app's own tree, and the file most likely to be baked is the one deliberately in no
repository: `.env.production` sits at the deploy root, which IS the build context, so
a rule that only ever runs locally passes on every app and misses the case it exists
for. The pipeline step therefore reads the SERVER, after `02-pull`, because before the
pull the server's Dockerfile is the previous release's. Adoption is
`deploy.api.buildCheck = false` rather than `check-baseline.json` — a per-app boolean
beside the `envCheck` that already sits there, because this fires in ones rather than
in the dozens a baseline exists to ratchet down.

**Three doors, and closing one does not close the others**, which is what the survey's
single shape turned out to be:

| | | closed by |
| --- | --- | --- |
| the CONTEXT | a value file the build copies | `.dockerignore` |
| an `ENV` line | a value written into the image | nothing but removing it |
| a build `ARG` | a value recorded in `docker history` | a secret mount |

`latest` is the fourth and it is the BASE image, not a secret reference — 1b already
refuses an unpinned secret at mint time, so this is the same rule at the other door.
It is graded twice rather than once: no tag or `:latest` refuses, because that build is
not reproducible from the tree at all; a version tag like `oven/bun:1` **warns**, since
that is what this repo's own `fli make:deploy` writes and a default whose first use is
red is worse than no default.

**Measured rather than argued, in both directions.** Two build contexts identical
except for a `.env.production`, `COPY . .`, no `.dockerignore`:

```
stage       sha256:dfa9655f267c02…      DIFFERENT — the configuration is in the digest
production  sha256:32ab9ba5e266f8…
```

and the negative control, the same two trees with `.env*` ignored:

```
stage       sha256:fa3ecac547cb08…      IDENTICAL — one artefact serves both
production  sha256:fa3ecac547cb08…
```

**The first version of the rule was wrong and the measurement is what caught it.**
Grading a file as baked the moment a context `COPY` reached it refused every
multi-stage build in this repo: two trees whose `.env` differed, copied wholesale into
a build stage whose runtime stage takes only `dist/`, produce a byte-IDENTICAL final
image. So the question is not *did a COPY reach it* but *does it reach the FINAL
image*, which is a walk across stages — `COPY --from=build /app /app` ships everything
that stage held and `COPY --from=build /app/site/dist ./dist` ships a subtree, and both
forms are in this repo. The intermediate case is not nothing (the value sits in a layer
on the build host, readable with `docker build --target build`) so it is a warning
rather than either silence or a refusal. **The trace was then graded against the
daemon** on four shapes × two files at two depths: 8 of 8 agreed, and those eight are
the fixtures in `tests/build-check.test.js`.

**It found a real one on its first run.** Docker matches an ignore pattern with Go's
`filepath.Match`, where a plain `*` does not cross a separator — so `db/*.db` excluded
`db/basecamp.db` and admitted `db/db/basecamp.db`, and `db/db/` is exactly what a
relative `database { path }` resolved against the wrong working directory creates
(`FJS-449`). Git-ignored, so it appeared in no diff; `COPY db ./db` then
`COPY --from=build /app /app` put it in the shipped image. `FJS-543`.

The suite is pure — no daemon, no network, no fixtures on disk — because a check that
needs Docker is a check that stops running. Every measurement above is recorded in the
module header instead, which is where this repo puts a number it paid for.

**1d · `--plan`, which executes nothing.** — **shipped 2026-08-26** as
`fli deploy:plan` and `fli deploy --plan`, over `packages/cli/core/plan.js`. Both
entry points call one helper, because two implementations of a plan is the failure
this whole design is arranged against: a plan is what somebody reads to decide.

It builds the rows 1e will insert — one `Transition`, one `TransitionStep` per step —
and prints them. **The same object either way**, which is the model's own instruction
rather than a reading of it: `Transition.plan` carries the plan, so the document a
person read and the record a deploy wrote cannot disagree.

**The steps are read, never listed.** `_steps-docker/`, with the runner's own filter
and sort, and each `skip:` evaluated the way the runner evaluates it — including its
fail-open direction, so a predicate that throws is reported as *it will RUN* rather
than quietly dropped. A step added to the pipeline appears in the plan with nobody
editing the command. A skipped step is SHOWN rather than removed, for two reasons and
the second is the one a dropped row cannot serve: an operator needs *the backup did
not run* to be visible, and 1e needs the ordinals stable so a resume finds the step it
stopped at even after a `skip:` has changed its answer.

**It surfaced the term nobody had named, which is what a plan is for.** The
transition id is

```
deploy:shop:production:none:a1b2c3d4e5f6:1:1
 kind  app  environment  from  to  generation  attempt
```

and every term prevents a collision with a different intent. `from → to` is what lets a
crashed deploy resume — rerunning computes the same id and finds the same row — while
keeping R1→R2 and R2→R1 apart; `generation` is there because a rotated secret is a new
intent rather than a replay. **`attempt` is the journal's count of prior transitions
for that pair, and a plan has no journal to count**, so it states `1` and labels the id
provisional. The case: deploy R2, revert to R1, deploy R2 again — every other term is
identical to the first attempt, so without a counter the third operation resumes a
transition already marked `succeeded` and leaves R1 serving. **1e owes this one read**,
and it is cheap: the count of transitions already recorded for `(app, environment,
from, to, generation)`.

**The pivot leads the report**, because it is the fact that decides whether to run the
thing at all, and where the classifier offered the three-step way out the plan prints
it — a refusal carrying its own remedy is advice, and one that does not is a wall.
Unknown renders as *counts as a contract*, which is where the fail-closed direction
becomes something a person reads rather than a rule in a file.

Proved on basecamp's own tree, which currently classifies **contract** on 37 findings
from the tenancy work in flight — so the contract path is exercised against a real
schema rather than a fixture. 46 tests, pure.

**1e · The journal executes.** — **shipped 2026-08-26** as `core/journal.js` +
`core/journal-runner.mjs`, opened by `_steps-docker/01c-journal` and read by
`fli deploy:journal`.

**The dependency question this row was expected to force did not need forcing**, and
what settled it was measuring the target rather than reasoning about it.
`deploy:setup` installs docker, nginx, git, **bun**, rsync and sqlite3; `02-pull`
leaves a git checkout with **no `node_modules`**, because the build happens inside
Docker. So litestone cannot be imported there — and it does not have to be. The
schema stays `db/deploy.lite`, its DDL is a committed snapshot
(`litestone ddl --schema deploy.lite`), and what ships to the target is that file
plus a runner whose only import is `bun:sqlite`. **`packages/cli` gained no
dependency**, and the `snapshots` CI phase picked the new DDL up with no CI edit —
the property that mechanism claims, observed rather than assumed.

**The brain is local and the runner is dumb.** Every statement and every verdict is a
pure function in `core/journal.js`, where the tests are; the shipped file binds
parameters and returns rows and decides nothing. Same split as
`@frontierjs/outpost`'s `createDocker({ run })`, for the same reason: the half that
is hard to test is the half that gets shipped somewhere else, so it is made too
small to be wrong. Which is also what lets the suite drive the REAL runner against a
temp database — the sequence walked is deploy, die inside a step, rerun.

**The pipeline became journal rows without eleven step files learning to write one.**
The hook is on the step RUNNER (`core/runtime.js`), which knows a step ran and how it
ended and nothing about deploys: a command installs `config.journal` and gets
`beforeStep`/`afterStep`. `01c-journal` installs it, `09-cleanup` settles on both
paths — `runOnAbort: true` is what makes that reachable, and an aborted deploy must
leave a `failed` transition rather than a `running` one the next run would read as a
crash.

**Three things it decided that the record had left open:**

**The digest is not in the recorded Release, and that is the honest state.** A Release
id is content-addressed on its four terms, one of which is the image digest — and
this pipeline builds ON THE TARGET, so the bytes do not exist until step 04. Minting
around a digest that arrives later would change the id halfway through the transition
it names, which is the one thing an idempotency key may not do: a resume would
compute a different id and open a second row. So the Release recorded is exactly the
one `fli deploy:plan` printed, and what step 04 built is that step's **output**. It
also means a rerun resumes at all, because the id does not depend on a rebuild
producing identical bytes — which a build on the target cannot promise. **That is a
sharper argument for `2.3f`'s second half than the roadmap row makes**: building
centrally is what lets the digest become a term of the id rather than a note.

**`serving` is the last transition that SUCCEEDED, not the last transition.** A failed
deploy leaves the previous release up, and a journal that called the attempted one
serving would be lying in exactly the situation somebody is reading it to get out of.

**`attempt` is answered, and it is the term 1d flagged.** Counted off the rows by
COLUMNS rather than by id — the number is inside the id, so asking by id could only
find the attempt you already guessed. A `planned` or `running` row is the interrupted
attempt and is resumed at its own number; a `succeeded` or `failed` one is finished,
so the next run is a new attempt. `readAttempts` + `attemptDecision`.

Proved by 45 tests, 19 of them against a real SQLite file through the shipped runner.
**What is NOT yet proved is the interruption in the `deploy` CI phase** — that phase
runs the whole pipeline twice against two package sources, so the assertion that the
app still works exists and needs a kill and a rerun added to it. That is the one piece
of this step's stated proof still owed.

**1f · `fli revert`.** — **shipped 2026-08-26** as `fli deploy:revert` (alias
`revert`) over `core/revert.js`, journaled as a `kind: 'revert'` transition of its own.

**The refusals are the feature, and there are SIX rather than the two this row
named.** A rollback that puts the previous image back and says nothing is what every
other tool ships, and it is wrong in exactly the situations somebody reaches for it:

| | | override |
| --- | --- | --- |
| `pivot` | a deploy since then crossed it — that release cannot serve this database | `--past-pivot` |
| `retention` | the release stopped being a revert target, and it names the date | `--past-retention` |
| `bindings` | the generation moved: this restores the code and NOT the configuration | `--onto-current-bindings` |
| `no-image` | nothing recorded which bytes that release ran | **none** |
| `in-flight` | a transition is still open — a deploy is running, or died unsettled | **none** |
| `nothing-prior` | this is the first release | **none** |

**Every one is reported, never just the first.** An operator deciding whether to force
needs the whole picture; a checker that stops at the first makes them discover the
rest one flag at a time, mid-incident. Three carry no override at all, and that is
stated on the line rather than left to be discovered — *no override — this one is not
a judgement call*.

**The bindings refusal is the one this record under-specified.** Serving state is the
PAIR, and `fli` writes no `.env` on a target — the operator owns that file. So once
the generation has moved, a revert genuinely *cannot* restore the pair; it can only
put old code onto today's configuration, which is the documented Fly failure the
generation counter exists to refuse. It is therefore a refusal rather than something
this fixes, and `--onto-current-bindings` is the operator saying a different sentence
on purpose. The journal records which sentence happened.

**`revert` and `rollback` are both kept, and the split is stated.**
`fli deploy:rollback` puts the previous IMAGE back with no journal and no questions —
it works on a target that has never deployed through one. `fli deploy:revert` restores
the PAIR and refuses. The second never silently becomes the first: with no journal it
says so and names the other command rather than quietly degrading.

**Two extractions came out of building it**, both for the same reason: the going-back
path is the one nobody exercises until the day it matters, so a copy that had drifted
would be discovered at the worst moment. `swapContainer` and `healthOrRestore` are now
in `deploy/_module.md`, called by both `_steps-docker` and `_steps-revert`.

**Where a revert reads the bytes from is the consequence 1e predicted.** The digest is
not a term of the Release under build-on-target, so the way back to an image is the
`04-build-api` output of the transition that put that release into service. That
output is JSON now, and a row an older `fli` wrote as prose is reported as unreadable
rather than scraped — a revert that ran the wrong bytes is the worst outcome available
here. It is one more thing that becomes simpler once `2.3f` builds centrally.

38 tests.

### 1g — the proof, and what running it found

The debt 1e and 1f both left, paid: `deployJournalCycle` in
`scripts/scaffold-build.mjs`, in CI's `deploy` phase. Deploy → deploy → crash →
resume → revert → revert, against a machine, with a journal on it and a container
serving from it.

**Nothing had ever run `fli deploy`.** The phase ran `fli deploy:local`, which is a
different command: it builds an image and runs it, and never touches
`_steps-docker/`, the journal, the swap, the health poll or the revert. Phase 1
shipped ~1250 green tests over a path that had executed zero times.

It had never run because it needs a server, so the first move was to give *run a
command on that machine* one owner and let the machine be this one —
`packages/cli/core/machine.js`, the script piped to `sh -s` with or without an ssh
prefix. `localhost` is a transport rather than a simulation: real docker, real
journal, real revert, and only ssh itself unexercised.

What one run of it found, in order:

- **Nine of the ten multi-line shell commands in the pipeline were syntax errors on
  the target.** `.replace(/\n\s*/g, '; ')` turns `then` into `then;` and `do` into
  `do;`. The lock, the rename, the stop, the health poll, the restore, the cleanup,
  the rollback and both revert steps. The health check compounded it: interpolated
  into `ssh host "…"`, its `$(curl …)` ran on the OPERATOR'S machine and `"$STATUS"`
  expanded here to empty, so the target received `[  = 200 ]`.
- **`deploy:setup` wrote an nginx config with every variable stripped** —
  `proxy_set_header Host ;` — because the quoted heredoc protecting them was itself
  inside ssh's double quotes.
- **`fli deploy:revert` restored the bytes it was reverting FROM**, and reported
  success. This one is the sharpest argument 2.3f has: build-on-target puts no digest
  in the Release id, so two deploys of different source mint the SAME id and a lookup
  by id answers whichever transition is newest. Revert targets the previous
  *transition* now, `same-bytes` is a seventh refusal with no override, and what is
  running is asked of the machine rather than the journal.
- **A resumed deploy started `undefined`.** A replayed step contributes nothing to the
  run and one of those contributions is load-bearing; the projection the resume reads
  did not select `output`.
- **A revert could not itself be reverted** — `imageFromSteps` matched the build step
  by name and a revert has none.
- **`fli deploy --plan` could not grade `01c-journal`**, the journal step itself.

Two were filed rather than fixed. `FJS-574` is still open: every deploy of a freshly
scaffolded app fails its backup because a declared-but-never-written database has no
file, and blames the container.

**`FJS-573` was the other, and it is closed as a ruling** (`FJS-D156`, 2026-08-29).
A crashed deploy stranded its lock, and the cycle above had to `rm` that file itself
to reach the resume it was testing — so the two features 1e and 1f had just shipped
disagreed with each other in the one case they both exist for: the journal knew the
transition was `running` and graded exactly how to continue it, and the lock refused
the run that would.

The ruling is that these are **two questions, not two answers**. The journal owns
*what state did the last run leave*; the lock owns *is another run working in this
directory*, and it only ever looked like a rival answer because it could not expire.
The pid it recorded was `$$`, expanded by the `sh -s` that wrote it — a shell that
exits at once — and no better one is available: `fli` runs on the operator's machine
and reaches the target one command at a time, so **there is no process on the target
to point at**. So the lock records what is true — the run, the actor, when, and
**which step it is inside**, which is what makes the duration beside it mean
something. That comes from a `beforeStep` announcement in the step runner, the only
place it can: since 2.3f the build runs BEFORE the journal opens, and `execSync`
blocks the loop, so no timer can tick inside a step.

Neither register judges liveness, because that is a fact about a process the target
cannot see. The refusal reports and names both ways out — **`fli deploy --resume`**,
which continues what the journal holds and takes the lock over, and
**`fli deploy:unlock`**, which drops the lock and settles nothing. A resume was
always safe without a probe: a succeeded step replays into a no-op, a step is claimed
compare-and-set, and different bytes are a different Release and therefore a new
transition. The lock was only what made it unreachable.

**A freshness check on `--resume` was built and then removed, and the reason
generalises.** *A lock whose step moved seconds ago is a live run* looks sound and
is not: the recorded time is when a step STARTED, and nothing records one ending
or a pulse inside it — so a fresh timestamp is equally consistent with a run three
seconds into a five-minute build and with a run killed three seconds into it. It
was measured that way round, by the cycle: the crash it exists for leaves exactly
that lock. A sound version needs a heartbeat within a step, which `execSync`
forecloses. **Nothing was lost by removing it**, because the fact is already on
screen — *in step 06-swap — 3s in it* — where a person can weigh it and the
machine does not pretend to.

A TTL was considered and refused — the shape the field uses, and the one Caravan uses
one layer down (`FJS-294`) — because the heartbeat can only tick per step and a step
is minutes long, so the TTL would have to exceed the longest build.

### Phase 1 is complete

1a the models · 1b the Release · 1c the build check · 1d `--plan` · 1e the journal
executes · 1f revert · 1g the proof.

What is deliberately not in phase 1: the traffic switch stays stop-then-start with a
stated downtime window, retention keeps the previous Release only, and the audience
column has exactly one value in it.

### Phase 2 — Attach — **shipped 2026-08-29**

Ruled as [`FJS-D158`](../DECISIONS.md#fjs-d158). `attachments` is declared in the
app (`junction.config.js`, or `createApp({ config })`) and bound per environment
by the variables the process actually carries — **not** phase 1's binding set,
which is recorded into the Release and applied by nobody (`FJS-585`);
`check-attachments` is a
junction start phase that refuses to boot on a service that is unbound or bound
halfway.

**Three things this record did not predict, and each was found by building it.**

**It must not be a second `defineEnv`.** Every per-key question — present,
non-empty, a URL, long enough — was already answered inside `defineEnv`, so the
check would have been a second implementation of it (Invariant 4). `checkEnvField`
is extracted and both call it. What an attachment adds is what a flat spec cannot
say: these keys are ONE SERVICE, so the refusal names the service; ALL OR
NOTHING, so `optional: true` forgives a service nobody bound and still refuses one
bound halfway; and a DEFAULTED key is not evidence, or an unbound service with one
default looks half-bound.

**Half-bound is the case worth building for**, and it is the one this record's
phrase *missing or mismatched* was reaching for. It is what actually reaches
production — somebody binds the URL and forgets the key — and it is exactly the
shape a per-variable check cannot see, because every variable it can name is
either legitimately absent or legitimately set.

**A startup refusal nobody reads is not a refusal.** `healthOrRestore` printed
the polled URL, a hint about `apiPrefix` that is wrong whenever the app never came
up, and rolled back — so an app that refused to start had its own clear sentence
die in `docker logs`. Surfacing it (`showContainerTail`) turned out to be half the
build, and it is `fli`'s half rather than a second implementation of the check:
the app is the thing that knows, and the deploy only had to stop throwing its
answer away.

The original text of this phase follows.


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

### Phase 3 — Survive — **shipped 2026-08-30**

Ruled as [`FJS-D160`](../DECISIONS.md#fjs-d160), and the phase turned out to be
two halves of which one already existed.

**The assets were already covered and nobody had said so.** `03-build-web` merges
the previous release's assets into the new one, so a stale client's
content-hashed chunks keep resolving — and because each deploy merges from the
one before it, the coverage chains forward across `keep_releases`. What was
missing was never the assets. It was identity.

**The server STATES its build and the client compares** — a response header and a
field on the socket's `connected` frame. Not a per-request diff on the server:
that answers a question which changes at most once per deploy, on every call, and
has to be written twice because the two transports carry headers differently.

**It is the BUILD and not the Release, and that is a correction to this record.**
This section says *Release identity stamped into served HTML*. A browser holds
the web bundle; a Release is also an image digest and a schema surface, and two
Releases share one bundle on every API-only or schema-only deploy — so stamping
the Release id would fire a reload prompt for changes that cannot reach the
browser being prompted. (It is also the only identity available where it must be
stamped, since `03-build-web` runs before `04-build-api` — but that is a
consequence rather than the reason.)

**The routing table is REFUSED rather than deferred.** Serving two Releases at
once needs a second container, an nginx map and a lifecycle for the old one,
which is the orchestrator this document refuses three sections below and which
Phase 4 already defers alongside multi-host. The honest single-host claim is the
one now true: browsers already out there keep working, and are told when they
cannot. **Audience preview does NOT fall out of this**, contrary to the paragraph
below — it needs the routing half, so it stays with Phase 4.

The original text of this phase follows.


Release identity stamped into served HTML, the previous Release's assets kept
addressable for a stated retention window, and the routing table that serves two
Releases at once. **Audience preview falls out of this phase rather than being its
own.** The first phase that crosses into the UI realm, so it wants Sierra.

Vercel is the working reference and it confirms both halves. The deployment id is
encoded into the HTML on a hard navigation, later requests carry it as `?dpl=` or an
`x-deployment-id` header, and the edge routes them to the matching deployment for a
window of one hour by default. **The id is the application's to choose** — Next.js
accepts a custom `deploymentId`, commonly a git sha — which is what makes this
reachable without a vendor: Sierra owns the build that stamps it and Junction owns the
wire that reads it back.

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

| After | The claim | |
| --- | --- | --- |
| 0 | *We know whether this change is reversible.* | shipped |
| 1 | *…and if it is, one command puts it back.* | shipped |
| 2 | *…and every external dependency is declared, so environments cannot drift silently.* | shipped |
| 3 | *…and that includes the browsers already out there — they keep working, and are told when they cannot.* | shipped |

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
Kamal by convergent evolution, while the *execution* does not generalize — plain
Compose has no traffic layer at all and stops the old container before starting the new.

---

## Open questions

- ~~**Does the classifier need a third answer?**~~ — **answered by shipping it.**
  *Expand / contract / unknown* stands; the verdict is the worst finding and the
  findings are all reported, so a mostly-additive diff with one narrowing reads as
  a contract WITH its expands listed beside it rather than as a flat refusal. What
  is still unmeasured is whether *required → optional* (a contract, because this
  release may write a NULL N-1 has no case for) is the one that annoys in real use.
- **Where the JOURNAL physically lives, which phase 1a cannot start without.** Two
  sentences in this record pull apart: the journal is *in a Litestone database* so the
  framework's own tools inspect it, and it *lives with the app* so basecamp vanishing
  changes nothing. **Recommended answer below, probed against the tree 2026-08-26 and
  left unruled deliberately** — it is recorded-state shape, so it is settled when 1a
  starts and by someone holding the code.

  *The prior art is one-sided.* Capistrano writes `revisions.log` at the deploy root on
  the server, one line per deploy **and per rollback**, with the user; Kamal writes
  `.kamal/app-audit.log` on the server and takes its lock as a directory on the primary
  server; NixOS keeps generations on the machine, which is what lets a rollback work
  with no network; Helm stores revisions in the target cluster and Argo CD in the
  Application's own status; OTP's `RELEASES` file sits in the release directory on the
  node. **Terraform is the only one that exiles its state to a remote blob, and it does
  so because its target — a cloud API — has nowhere to put a file.** It pays with a
  locking subsystem and a permanent drift problem. Our target is a machine with SQLite
  on it, so the exception does not apply and the convergent answer does: **on the
  target**.

  *Inside the app's own database is refused, and each reason is independently
  sufficient.* It cannot record the steps that run before the app exists — a first
  deploy, a build, a push. It cannot be read at the moment it is most needed, which is
  when the app is down and someone is reverting. And `$backup` covers **every declared
  SQLite database** unless a caller narrows it with `only`, while `05-backup` takes a
  pre-deploy copy of exactly that set — so restoring the backup a deploy authorized
  would erase the journal recording the deploy that took it.

  *The recommendation is its own Litestone client whose `main` IS `deploy.db`*, a file
  at the deploy root beside `db/` rather than inside it, over a `.lite` fragment the
  framework ships. `createClient({ schema, db })` already takes an inline schema and a
  path, and a fresh SQLite file gets its DDL applied on first open, so this needs no
  new mechanism. **It is a separate client rather than a second `database` block on the
  app's, and the reason is `$locks`**: litestone's lock primitive already carries owner,
  TTL, heartbeat and expiry cleanup — which is exactly the deploy lock Terraform built a
  DynamoDB table for and Kamal a directory — but it stores in **main only**. Under a
  second block the lock lands in the app's database; under a separate client it lands in
  `deploy.db`, with the record it protects. The transaction property falls out the same
  way and is the outbox hazard read forwards: litestone's transaction manager holds
  main's alone, so a row outside it survives a rollback — a defect for an outbox
  (`FJS-D35`) and the requirement here, since the journal must outlive the app's own
  rollback by construction.

  *Three consequences worth stating before anyone builds on it.* One journal per host,
  with the Release id as the correlation key — content-addressing means the same id
  names the same bytes everywhere, so a multi-host deploy is N journals that agree
  without a central one, which is NixOS's property rather than Terraform's. Basecamp
  reads it **through the Outpost**, never by opening the file, because it is on another
  machine — the viewer rule of phase 4, unchanged. And **a journal on the target dies
  with the target**, which NixOS also accepts and which is the honest counterpart to
  `IDEAS/overview.md` 2.11: serving history is a machine-local fact, and the thing that
  survives the machine is the backup.

  *The one part not to settle on paper is who executes the write.* `deploy:setup`
  already installs `sqlite3` and `bun` on the target, so a step row can be an `INSERT`
  over ssh or a litestone open under bun; the constraint is Invariant 8, since a commit
  message and an author name come from git and must be bound rather than interpolated.
  That is a measurement, not an argument — `VERIFYING.md`'s rule — and it belongs in 1a
  beside the models rather than in this record.

  *Refused outright: the operator's machine*, because two operators then hold two
  disagreeing histories of one server.

  **Probed 2026-08-26, and all of it holds** — the three properties above were read in
  litestone's source and had never been run, and each one would have changed the models
  if it were false. A fragment opens as its own client with `main` at `deploy.db`, the
  file is created and its DDL applied on first open, and a row writes and reads back.
  `$locks` lands in **that** client's main, with the stated owner. And the app's own
  `$backup` over two declared databases wrote both of them and could not reach
  `deploy.db`. **The rejected alternative was run as a negative control and fails on
  both stated grounds**: with the journal as a second `database` block on the app's
  client, the deploy lock lands in the app's `main.db` while `deploy.db` gets no
  `_locks` table at all — the lock cannot sit with the record it protects — and the
  app's own `$backup` sweeps the journal into the backup set, naming it as one of the
  app's databases. Two things came out of running it that reading did not give. **A
  standalone fragment must not carry `@@db(main)`**: `outbox.lite` does, because it is
  pasted into an app that declares that database, and a fragment opened as its own
  client has no referent for it and fails to parse — the difference between a fragment
  that is INSTALLED and one that is OPENED, and it is the first line of
  `packages/cli/db/deploy.lite`. And **lock contention throws rather than answering
  falsy**: `LockNotAcquiredError`, 409, `retryable`, naming the current holder — which
  is already the *refuse by name* shape `fli revert` wants, so nothing needs writing for
  it. These four assertions are the first test 1a should carry.
- **Where does the Release declaration live** — its own file beside `db/schema.lite`,
  or `frontier.config.js`, which `IDEAS/app-manifest.md` is already shaping. If the
  former, whether *everything derives from the schema* holds literally here or by
  analogy. **The audit narrows this**: `frontier.config.js` already carries the deploy
  block that `fli make:deploy` writes and `fli deploy` reads, so the question is no
  longer where to put a new thing but whether the Release's declaration joins the one
  that exists.
- **How the Environment binding set composes with per-tenant configuration**, which
  arrived after this record was written. `FJS-D126` gives an app a resolver answering
  configuration per tenant, an explicit `tenantConfigKeys` allow-list, and a reserved
  set refused at boot — and it commits that list into `principal.snapshot.md`, which is
  the same *the safe half is the half worth committing* argument this record makes
  about the Release. Two layers now exist over one set of values, and three things
  need settling before either is built on: which wins, whether a revert restores a
  tenant override or only the Environment's binding, and whether the binding set
  should simply adopt the committed-allow-list idiom rather than invent a second one.
- **Is the compose file for an attached service ours to generate or yours to write?**
  The line between helpful and Caprover is exactly there. **Still open after the
  phase shipped, and narrowed by it**: the declaration names the variables a
  service is reached through and says nothing about its image, its version or its
  volumes — so generating a compose file means inventing all three, which is the
  crossing rather than a step toward it. What IS free is an `.env.example`
  grouped by service, since the declaration already carries every field spec
  `generateEnvExample` reads.
- **Retention economics.** Nobody publishes the storage and routing cost of keeping N
  Releases addressable for a week. We would be finding out.
- **Who owns a backfill** — a Caravan job holding a cursor, a journalled transition, or
  the first caller of a general durable-workflow primitive. Made once, or discovered
  twice. **The evidence is now three instances rather than two**: junction's outbox
  relay is a committed intent handed to a queue and marked delivered, caravan's cron
  fire is an occurrence claimed once across replicas, and the journal here is the
  third. That is enough to rule `IDEAS/overview.md` 4.19 rather than defer it, and the
  ruling wanted is narrow — whether these three are one primitive or three uses of
  `occurrenceKey`, which is the part they already share.
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
