---
id: tenancy-exterior
status: argued
dated: 2026-08-25
---

# Plan — locking the tenancy exterior: proving what a tenant IS, and committing it

**Status: PLAN, 2026-08-25.** Written from the open register after an audit that
probed the tree rather than reading the rows, and **the first thing it found was
that two of the rows were about work already done**. `IDEAS/membership-tenancy.md`
still opens *ruled, not yet built*; [FJS-D113](../ISSUES.md#fjs-d113) was built as
[FJS-374](../ISSUES.md#fjs-374) and `IDEAS/tenancy-pass.md` shipped §1–§4 after it.
What is genuinely open is one ruling, [FJS-D126](../ISSUES.md#fjs-d126), and two
holes neither record names.

The subject is not a feature. It is the question this framework answers everywhere
else and does not answer here: **which face of this is exterior, so that the
interior can keep moving.**

---

## 0. What the probes changed

Three rows read differently after being run.

**The Data half is already locked, and locked well.** `tenancy { }` desugars into
`@@deny`, and the desugared denies are in the committed artefact —
`packages/basecamp/db/access.snapshot.md` carries 198 lines of *Outside your
workspaceId*, gated by the `snapshots` CI phase. A declaration that moves is a diff.
Nothing in this plan touches that; it is the model the rest should copy.

**`membership-tenancy.md`'s status line is stale and its argument is not.** The
three constraints it discovered the hard way — compose inside `withLitestoneDb`,
write the PRINCIPAL not just the client, a FRESH object because a WS session is
frozen — are all live in `packages/junction/src/core/litestone.ts` and all still
true. The file should keep its argument and lose its status line.

**The gap `tenancy-pass.md` §5 named is bigger than a missing feature, and its cost
is already accruing.** `packages/junction/src/mail/index.ts:142` destructures the
default from-address out of the plugin's options at construction. That closure is
the whole of [FJS-D126](../ISSUES.md#fjs-d126) in one line: nothing varies today, so
nothing is wrong today, and the price of the boundary rises with every reader added
before it moves.

---

## 1. The four holes, and they are one axis

Every one of them is the same sentence: **the predicate is committed and its input
is not.**

**H1 — where `auth().workspaceId` comes from is in no artefact.** The access
snapshot states the comparison. Nothing committed states who emits that claim, off
which request input, verified against which model and column. A resolver that emits
the *wrong* tenant leaves the snapshot byte-identical, CI green, and every read
answering somebody else's rows. This is the largest one and it is the one the whole
plan is arranged around.

**H2 — the standing ladder is unrepresented.** The snapshot's `## Levels` section
names the labels 0–9. That `viewer` is 2, `developer` 4, `admin` 5 and `owner` 6
lives in application JavaScript, in nothing that is diffed. Move a role one rung
and no committed file moves.

**H3 — `verifyRowPolicies` declines to grade a delegated model, by name.** A rule
holding a `check()` node is reported `skipped` — correct, honest, and it means that
in basecamp **18 models are graded and 14 are not**. [FJS-382](../ISSUES.md#fjs-382)
was a `check()` defect: the two implementations of one rule disagreed about a null
foreign key, and litestone's own checker graded the policy correct because it skips
that class. The deepest half of declared tenancy has no executed proof.

**H4 — there is no executed cross-tenant proof under `strategy row` at all.**
`example`'s `verify:tenants` is `strategy database`, where isolation is the
filesystem — it proves the case that cannot fail, and says so in its own header.
The strategy where isolation is a *predicate* has a handful of hand-picked service
tests in `packages/basecamp/api/test/services.test.ts` and nothing exhaustive.

---

## 2. The output shape to work backwards against

This repo already has the answer and applies it in every other realm: **a committed
artefact that is diffable, and an executed check that proves the artefact true.**
`access.snapshot.md` beside `verifyRowPolicies`; `surface.snapshot.md` beside the
suites; `exports.snapshot.md` beside `scaffold`. Neither half is sufficient — a
snapshot diffs what was declared, a check proves the declaration was not a lie.

Tenancy has the first half for its Data end and neither half for its API end.

**A. `principal.snapshot.md`** — what a caller ARRIVES as and what they BECOME
before the Data boundary. Read off a BUILT app, like `surface` and `jobs`, because a
resolver is wired in application code and no file tree can answer it. Seven
sections, each an exterior face:

1. **Tenancy** — strategy · how the tenant is named (subdomain · header · claim ·
   stated) · the claim key
2. **Resolver** — name · model · subject column · tenant column · standing column ·
   *no row is no claim*
3. **Claims** — the key NAMES emitted, never values · the keys refused (`userId`,
   `id`)
4. **Standing** — the value→level table off the app's own `getLevel` (H2)
5. **Exempt** — `@@tenant(none)` models by name · services that take no tenant
6. **Refusals** — the three sentences and their statuses: unnamed 400, refused 403,
   no resolver configured 403
7. **Config** — the allow-list of keys a tenant may override

Section 7 is empty until §5 of this plan builds it, **and the section exists from
the first commit**. That is the whole trick: per-tenant configuration then arrives
as a diff in a file people already read, rather than as a new face.

**B. `verifyTenantIsolation()`** — the fifth executed check in `createTestEnv`, beside
`verifyGateLadder`, `verifyConstraints`, `verifyFieldProtection` and
`verifyRowPolicies`. Per model × three actors — a member of A, a member of B, a
caller with no membership — × the four operations. It grades a `check()` delegation
by EXECUTING it, which is exactly the class `verifyRowPolicies` reports rather than
answers, so it closes H3 and H4 together.

Everything else — how `membershipClaim` queries, where `liftRowTenant` sits, the
tenant pool, memoisation — is interior and may keep moving.

---

## 3. Phase 1 — `verifyTenantIsolation()` — **SHIPPED 2026-08-25**

Litestone, `src/testing.js`. No design risk, no ruling needed, and it is the only
thing that can say whether the bones are good today.

**The shape.** Three actors and one assertion each, per model, per operation: a
member of A reaches A's rows and no others; a member of B reaches none of A's; a
caller with no membership reaches none. Under `strategy database` the actors are in
two files and the assertion is that a client for A never answers a row of B's.

**What it must get right, learned from the four checks already there.**

- A model declaring `@@tenant(none)` is **exempt and listed**, not silently passed.
  Reporting a row is how [FJS-381](../ISSUES.md#fjs-381) would have been caught the
  day it appeared rather than when sixteen models moved at once.
- A gate above 7 is `uncheckable`, not a pass. The same answer `verifyGateLadder`
  gives.
- The seeder must stamp the tenancy claim for the actor being seeded, which
  [FJS-381](../ISSUES.md#fjs-381) already taught `verifyFieldProtection`, and the
  fix has to be shared rather than copied.
- A delegated model whose parent chain reaches no tenant column at all is a
  **finding**, not a skip: that is a model nothing scopes, and it is the shape H3
  hides.

**Prove it by running it on basecamp**, which is the only app in the tree on
`strategy row` with a per-request claim. Expect findings in the fourteen delegated
models; a clean run there is itself a result worth recording.

Shipped as [FJS-513](../ISSUES.md#fjs-513). Four of the four *must get right*
items above hold, and the run against basecamp is the result the phase existed
for: **31 models graded — 17 by column, 14 by delegation — 14 exempt, 18
uncheckable ops behind a gate above 7, and no leak, no unscoped model, no
unreachable row.** The fourteen delegated ones had never been graded by anything.

Two things the plan did not predict, both found by running it rather than
reasoning about it. Seeding SKIPPED optional scoped relations, which grades a
delegated model only in its degenerate unparented form — so the seeder now fills
them and the unparented row is probed once, separately, under its own name. And
the per-model restore rolled back past the two tenants themselves, so the first
model that passed cleanly took the fixture with it and the remaining 28 reported
a foreign key error that had nothing to do with tenancy — a whole-run false
negative that a green suite would never have shown.

---

## 4. Phase 2 — `principal.snapshot.md` — **SHIPPED 2026-08-25**

Junction. `junction principal --app <module> [--services <dir>]`, written at the app
root, added to the `snapshots` CI phase by naming its own generator in its header
like every other snapshot does — so this costs a generator and no CI edit.

Pure derivation. It changes no behaviour and can be read off both apps the day it
exists: `example` on `strategy database` with `cartClaim`, basecamp on `strategy
row` with `membershipClaim`. Two strategies and two resolvers is enough to know
whether the seven sections are the right seven.

Shipped as [FJS-514](../ISSUES.md#fjs-514), and reading it off both apps was
worth more than the plan expected: the two strategies disagree about where the
declaration even LIVES. `createApp({ tenants })` has no app-wide client, so the
first version reported *no tenancy* about `example`, which is nothing but
tenancy — the registry answers instead. The seven sections held; what moved is
that three of them render differently for a resolver that reads no row, because
five blank membership cells say *forgot to verify* where the truth is *nothing to
verify*.

---

## 5. Phase 3 — move the READ, keep the source — **SHIPPED 2026-08-25**

The half of [FJS-D126](../ISSUES.md#fjs-d126) that is a boundary move rather than a
feature, and the half that gets more expensive the longer it waits.

`$.config` through the ambient call, resolving over `app.config` as the floor;
`app.configFor(tenant)` for a caller holding no call. **Built with no resolver
behind it** — it answers `app.config` exactly, byte for byte, and changes nothing.
Then migrate the readers, `mail/index.ts:142`'s closure first.

Twenty-five reads across five files inside junction, plus whatever an app captured
of its own. Cheap while nothing varies. Not cheap under a live feature, which is
what every system surveyed in §7 pays for.

**It must never write.** See §7 for what that costs the one framework that chose
otherwise. Shipped as `$.config` + `app.configFor(tenant)` over one owner, with
the view read-only **deep** — the shallow version refuses `$.config.name = x` and
admits `$.config.http.cors.origin = x`, which is the same defect one level down
and the one somebody actually writes.

**The survey changed the estimate, downward.** Of the 25 reads, almost all are
boot-scope and correctly so — ports, `database.url`, helmet, CORS,
`http.callHeaders` — and every one of them belongs on the deny half of §6's
allow-list. Only `collectHealth`/`collectMetrics` were genuinely per-call, and
they are migrated. The expensive part is not in junction at all: it is the
closures an app and a provider capture, of which `createResendMailer(opts)`
destructuring its from-address at construction is the one this plan named. That
one cannot move until there is a config key for it to read, which is §6's
business rather than this section's — so `mail/index.ts:142` stays as it is, and
is still the clearest single illustration of why the boundary had to move.

---

## 6. Phase 4 — rule `FJS-D126`, then build the source — **SHIPPED 2026-08-25**

Three clauses, and only the third is new work by the time the phases above land.

1. **Read** — `$.config`, resolving this tenant's answer over `app.config`. Never a
   mutation of `app.config`, never a rebind.
2. **Override** — an explicit declared map, one entry per key, in the shape §7
   confirms is the only one anybody has made work. Ports, database paths and secrets
   are unreachable **by construction** rather than by a deny-list, which is the half
   that makes it safe.
3. **Source** — `createApp({ tenantConfig })`, a resolver answering a plain object
   per tenant id, memoised with an explicit invalidation. A resolver rather than a
   declaration for [FJS-D113](../ISSUES.md#fjs-d113)'s reason: the source is a row
   for one app, a file for another and a control plane for a third.

The input the source needs already exists — `ctx.locals.tenantId` is assigned under
both strategies and `app.tenant()` answers off the call, both shipped by
`tenancy-pass.md` §1.

**Ruled and built.** All three clauses stand as written. The one thing the plan
did not see is the seam that makes clause 1 and clause 3 compatible at all: a
property read cannot await a resolver, so the resolve had to move to where the
tenant is ALREADY resolved — the around hook that sets `ctx.locals.tenantId`, and
`runAs`. That is the same placement `applyClaims` uses for the principal, which is
the argument for it: a value the Data boundary depends on is resolved once, in the
hook that knows the tenant, and everything downstream reads it as a lookup.

The second thing worth recording is that **clause 2 turned out to be the clause
the prior art decides**, rather than a detail of clause 1. Read-only is not
tidiness: it is the entire difference between this and the rebind every surveyed
implementation chose, and it is what lets the ALS carry the feature for free.

---

## 7. Prior art, probed rather than remembered

Six searches and one document fetched, 2026-08-25. One of the claims this plan
started with was **wrong** and is corrected here rather than quietly dropped.

**Per-tenant configuration.** `stancl/tenancy` is the mature implementation and
rebinds Laravel's container per request through five bootstrappers — Database,
Cache, Filesystem, Queue, Redis. Its configuration feature is `TenantConfig`, and
what it maps with is `storage_to_config_map`: **an explicit declared list, one
tenant-storage key to one config key**, arrays where a value feeds two. That is
§6's clause 2, already invented, in the field, and it is not free-form.

The cost of the shape it chose is documented in its own pages. Bootstrappers are
singletons; the docs instruct you to capture the original central value in the
constructor, because once `bootstrap()` has mutated the config the original is
unreachable. There is an open issue about Laravel's config cache fighting the
feature. Django's guidance is the same lesson stated as a prohibition — never
module-level variables, use request context. NestJS documents that a request-scoped
provider silently makes every dependent request-scoped, and **its own docs point at
AsyncLocalStorage as the alternative**.

Three independent systems, one conclusion: **read through the ambient, never rebind
a global.** Junction already has the primitive — `$` is an ALS — so the thing every
one of them pays for is the thing this framework gets for nothing, and only by not
choosing the mutation.

**The correction.** This plan's first draft said Laravel needs the tenant serialised
into a queued job by hand. It does not — `QueueTenancyBootstrapper` puts the tenant
id in the payload and re-initialises on the way out. **Django** is the one requiring
manual serialise-and-restore. The corrected reading is more useful: the two systems
split on exactly the seam junction already has, and `app.runAs(actor, { tenant })`
is on the side that works.

**Artefact plus executed check.** OpenFGA commits an authorisation model and a set
of assertions in one `.fga.yaml`, and ships a GitHub Action that runs them on every
push touching it. Declared file diffed, assertions executed, both gated. Same split
as `access.snapshot.md` beside `verifyRowPolicies`, arrived at independently, which
is the strongest evidence available that §2's shape is right.

**Where the prior art runs out, and it is H3/H4.** OWASP carries a multi-tenant
cheat sheet; the security industry's consensus is that cross-tenant IDOR is the
first way this architecture leaks and that it is normally found after deployment.
The reason given for it not being automated is that tools have no semantic knowledge
of which data belongs to which tenant. The closest existing thing is runtime — a
SQL parser checking every query filters on the tenant.

**This framework has that semantics and it is the seed.** Nobody does this at build
time from a declaration because almost nobody has a declaration to do it from.
Phase 1 is not catching up; it is the part that has no equivalent.

---

## Order, and why

1. **§3 `verifyTenantIsolation()`** — the only phase that answers *are the bones
   good today*, and the one with no design left in it.
2. **§4 `principal.snapshot.md`** — derivation only. Once §3 has said what is true,
   this is what stops it drifting.
3. **§5 `$.config` with no resolver** — no behaviour change, and its cost only rises.
4. **§6 the ruling, then the source** — last, because by then two of its three
   clauses are already standing.

Phases 1, 2 and 3 change no exterior face. Phase 4 fills an interior.

**Drives.** `packages/litestone`: `bun run test` — and §3's own run against
basecamp's schema, which is the only real one. `packages/junction`: `bun run test`.
`packages/basecamp`: `bun run verify` — the only app in the tree running row
tenancy with a per-request claim. `example`: `verify:tenants` for the other
strategy, `verify` for the request path.

**Concurrent-session note.** §3 edits `packages/litestone/src/testing.js`, which is
one file holding all four existing checks. Targeted edits only, no whole-file
writes.

---

## Links

- [FJS-D126](../ISSUES.md#fjs-d126) the ruling · [FJS-385](../ISSUES.md#fjs-385) the
  gap it came from
- [FJS-513](../ISSUES.md#fjs-513) phase 1 · [FJS-514](../ISSUES.md#fjs-514) phase 2
- [FJS-D113](../ISSUES.md#fjs-d113) and [FJS-374](../ISSUES.md#fjs-374) — the claim
  seam, ruled and built, which everything here stands on
- [FJS-382](../ISSUES.md#fjs-382) — the `check()` defect that is H3's evidence
- [membership-tenancy.md](membership-tenancy.md) the argument ·
  [tenancy-pass.md](tenancy-pass.md) the four defects and §5
