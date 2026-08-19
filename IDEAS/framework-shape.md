---
id: framework-shape
status: assessment
dated: 2026-08-02
---

# Idea — Framework shape: what FJS is missing to be a complete framework

**Status: ASSESSMENT + IDEA. Nothing here is a plan or a commitment.** Dated
2026-08-02. Claims below were probed against the tree, not read off status files
(`VERIFYING.md`); where something was verified, the evidence is named. Package
state moves — re-probe before acting.

---

## The one-line verdict

The idea is better than most funded frameworks have, and the backend delivers on
it. The gap between *"great backend framework"* and *"awesome framework"* is one
thing: **the derivation stops at the API boundary.** Everything else on this list
is small by comparison.

---

## What is actually strong

**The seed thesis is implemented, not aspirational.** One `.lite` file yields
migrations, TypeScript declarations (`packages/litestone/src/tools/typegen.js`,
exposed as `litestone types`), JSON Schema, runtime validation, and authorization.
Most "schema-first" frameworks close two of those loops.

**Authorization at the Data boundary is the single best asset.** Gates as ordinal
levels plus policies compiled into SQL means authz cannot be bypassed by a code
path that forgot to check. Nearly every competitor bolts authz onto handlers,
where forgetting is one missing line. This is also the strongest answer to the
AI-authored-code risk raised in `IDEAS/slices.md` — a Gate on a Model is much
harder for an agent to get wrong than a guard in a controller. **This, not the
schema, is what the framework should lead with.**

**Coverage is broader than a gap-hunt expects.** Probing for "obvious" holes kept
finding real implementations: `packages/junction/src/testing/index.ts`
(`createTestApp`, `request`, `createStubAuth`, `testCtx`), `core/logger.ts`,
`storage/filestorage/`, plus jobs, cron, mail, cache, webhooks, AI, channels,
tenants, studio.

**The failure envelope already crosses realms.** `core/errors.ts` has the full
`FrameworkError` hierarchy, and `toFrameworkError()` normalizes Litestone's
`AccessDeniedError` → 403 and `ValidationError` → 400, lifting field errors onto
`.data`. A Data-realm failure and an API-realm throw produce one shape the client
can match. *Fragility, not gap:* it matches on `err.name` because `instanceof`
cannot cross the package boundary — same duck-typing category as the rest of the
undeclared-dependency wiring. A Litestone error rename silently degrades every
gate denial to a 500.

**Vocabulary discipline** (`ARCHITECT.md` §2) is underrated and is why design
conversations here move fast.

---

## The shape problem

The framework is **bottom-heavy**, and not merely in maturity.

Data is v1.1.0, published, 1241 tests. API is 703 tests and coherent. The UI realm
is Sierra (README added 2026-08-02; `static` target now implemented, `widget` still
a config shape with no build loop), css (v0.10.0, 202 tests, and as of 2026-08-02
it has its **first consuming app** in `packages/css/demo/` — which promptly found 8
shipped bugs and 4 core gaps, exactly the value a consumer provides), and jetty
(resources layer is a diverged hand-copy of Sierra's).

*Note: the UI-realm maturity numbers moved substantially on 2026-08-02 — the
argument below does not rest on them.*

But maturity is the symptom. The structural issue: **Junction derives services,
validation, and 401s from a Model. Sierra derives nothing from a Model.**
`generateJsonSchema` reaches `registerSchemas()` in `virtual:sierra` and then
nothing renders from it — a grep across `packages/sierra/src`, `packages/mesa`,
and `packages/cli/commands` for schema→form generation returns nothing; `make()`
scaffolds files only.

So the Data → API → UI story is two realms deriving and a UI library sitting
beside them.

---

## Missing, ranked

### 1. Schema → Resource. By a distance.

> **Corrected 2026-08-02.** `fli admin:generate` (595 lines,
> `packages/cli/commands/admin/generate.md`) already generates a gate-aware CRUD UI —
> list, detail, create, edit — from `schema.lite`. So "nothing renders from it" was
> wrong as written: a codegen path exists. It has drifted badly from the current
> stack, though — it emits `.svelte` into `web/src/routes/`, generates
> `_layout.svelte` rather than `_module.mesa`, and documents a lowercase-plural
> `users` model. Details and the repair-or-retire question in
> `IDEAS/ecosystem-gaps.md`. The argument below still stands for *derived* (rather
> than generated) UI, which is the stronger claim.

The payoff of "schema-seeded" is that `model Lead` yields a working, validated,
gate-aware form and table without writing either. Something like
`<Form model="Lead" />` that knows `@email` is an email input, `@length(1,200)` is
a maxlength, `LeadStatus` is a select, `@default(now())` is not user-editable, and
that this user's level fails the create Gate so the submit is disabled rather than
round-tripping to a 403.

Every input needed is already in the browser bundle. Nothing consumes it. Until
this exists the central claim is two-thirds true, and **no new package would add
more value than closing this seam.**

Prerequisite question: does this render through the css package (giving it its
first consumer and settling that package's fate) or stay unstyled and slot-driven?

### 2. Storage drivers. — **corrected 2026-08-12**

This item read *"a grep for `S3Client`/`aws-sdk`/`presignedUrl` finds nothing outside
test fixtures."* The grep was run against Junction only, and the answer is different
one package down: **Litestone ships an S3 provider** (`src/storage/providers/s3.js`
over a hand-written `sigv4.js` — signed requests and presigned URLs, no SDK), driving
R2, B2, MinIO and S3 from the `FileStorage` plugin, documented and tested.

`IFileStorage` in `packages/junction/src/storage/filestorage/index.ts` really is
local-disk-only. So the remaining work is not a driver — it is that **two file-storage
abstractions exist and one of them cannot reach object storage**, which is an
Invariant 4 question (one owner per translation) rather than a missing feature.
Delegate Junction's to Litestone's plugin, or retire it. Full note in
`IDEAS/ecosystem-gaps.md` §3.

### 3. A Release story.

Five realms are named; Deployment/Release is the only one with no package and no
primitives. `fli` has deploy commands and caprover/cloudflare targets, but there
is no artifact concept — what *is* a deployable FJS app, when do migrations run
relative to cutover, how do secrets flow, what does a Slice contribute to a
release. Signal worth noting: this surfaced independently as an open question in
`IDEAS/slices.md`. A gap that appears twice from different directions is
structural.

**Upgraded from gap to blocker 2026-08-02** by the stated project vision —
offline-first, small and portable, FOSS, self-hostable. Those constraints imply
*distinct artifact kinds* (single binary, container, static+API, offline PWA)
rather than one deploy command, and they have to shape the Release design from the
start rather than be retrofitted. Full treatment in
`IDEAS/offline-first-and-release.md`; it also sharpens item 1, since an
offline-first form must validate and gate-check with no server reachable.

### 4. Observability that matches the pitch.

`@@log(audit)` writing zero rows is worse than not having the feature. For a
framework whose thesis is "the schema knows everything," schema-declared audit
trails should be flagship. Fix the driver, then add request-correlated structured
logging that survives transport → service → db, and this becomes something to
sell rather than a landmine to document.

### 5. Type-checking the derivation at the seams.

Not a package — the quiet threat to the whole thesis. Ten of twelve packages have
no tsconfig, so `typegen` emits Model declarations and **nothing verifies that
Junction's service types agree with them.** A framework whose value is derivation
needs the derivation type-checked end to end, or drift is invisible until runtime.
Junction's `bun run typecheck` baseline of 219 is the only ratchet that exists.

### 6. Nothing runs any of this automatically.

**Added 2026-08-03.** There is no `.github/` directory in the repo — no CI, no hook,
no scheduled job. The aggregate scripts are real and correct (`bun run test` runs 13
packages, continues past a failure, exits 1 on jetty's known one), so this is a
missing file rather than a design problem. But three of sixteen package directories
are skipped in silence, `packages/basecamp` and `packages/orion` are untracked by git
entirely, and every landmine in `CLAUDE.md` was found by hand — most of them
silent-success bugs that compile, render and exit 0.

Testing is also the second named realm (**Suite**) with no package and no primitives,
alongside Release at item 3. Full treatment in `IDEAS/testing-and-ci.md`.

---

## Consolidate rather than add

Three hand-copies are doing structural damage and each one is a divergence waiting
to be discovered by a user:

- jetty's `src/resources/` ⟷ sierra's (already diverged — `createStore` signature)
- the mesa-vite HMR algorithm, present in three places
- the auth schema, in `packages/auth/schema.ts` and
  `packages/cli/commands/auth/install.md` (fixed by item 1 of `IDEAS/slices.md` —
  bare-specifier `.lite` imports)

And css now has a standalone demo consumer (`packages/css/demo/`) but **no consumer
inside the framework** — Sierra does not import it. That decision is still waiting
to happen: either Sierra ships it by default, with item 1 above as the natural
vehicle, or the two stay deliberately independent and that is written down.

---

## Relationship to the Slices idea

`IDEAS/slices.md` is about *distributing* vertical features. This document is
about whether the vertical exists to distribute. They meet in one place: a Slice's
`resource/` part is only worth shipping if item 1 here is built. Ship Model+Service
slices first (as that document already sequences), and let schema→UI decide what a
`resource/` part actually contains.

## See also

- `IDEAS/slices.md` — the packaging half of the same problem
- `IDEAS/testing-and-ci.md` — item 6 in full: automated CI, and the Suite realm
- `ARCHITECT.md` §5 — "UI plugin system limited; JSON Schema → UI drives `make()`
  only" is the existing, understated statement of item 1
- `coherence-review.md` — the hand-copy and duck-typing findings (§8)
- `HANDOFF.md` — the numbered issue ledger this should inform, not duplicate
