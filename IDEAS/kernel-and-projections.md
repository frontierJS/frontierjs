---
id: kernel-and-projections
status: proposed
dated: 2026-09-12
---

# Idea — Kernel and projections: the structure the seed thesis implies

**Status: PROPOSED. A retrospective, not a plan.** Dated 2026-09-12. The numbers
below were measured on that date and are true for an afternoon (`PHILOSOPHY.md`
§ VII); the prior art was read on the same day and each entry says what it is
evidence of. Nothing here is a commitment, and the migration order at the end is
the only part meant to be acted on.

---

## Trigger

*"In the age of AI, code is tech debt"* — and the follow-up: *in retrospect, is
there a better way this could have been structured?*

The slogan is half right. Code that nothing constrains is debt; code derived from
an origin and graded by a check that fails is closer to an asset. FrontierJS's
thesis is already the second kind (`PHILOSOPHY.md` § III, *Everything is a
projection*). The finding here is that **the thesis is a derivation and the
structure grew as an accretion**: parallel implementations, then verification
built to hold them together.

---

## The finding, in one line

**Tripwires are standing in for structure.** Wherever a rule has to be restated
at many sites, the repo has answered with a completeness test rather than a
shape that removes the sites. Each tripwire is correct; together they are
the proof layer growing faster than the thing it proves.

---

## Evidence from the tree

Measured 2026-09-12.

| Symptom | Measurement | What it compensates for |
| --- | --- | --- |
| Rule sequence hand-restated per verb | root `CLAUDE.md` § *Which drive proves a change*: "a rule costs about fifteen insertion sites and a missed one is silent" (`FJS-262`, `FJS-216`, `FJS-671`, `FJS-720`, `FJS-1044`, `FJS-601`) | no single operation pipeline in `makeTable` |
| One client file | `packages/litestone/src/core/client.js` — 12,955 lines | the pipeline is the file |
| Two policy compilers | `compileSql` + `evalJs`, held by an oracle; 54 of 594 cells disagreed once (`FJS-713`) | no single evaluator with a residual |
| Hand-kept pairs of lists | outpost sends vs. basecamp keeps (`FJS-1027`); `core/capabilities.ts` vs. the schema's moves | no derivation between the two sides |
| Cross-package seams | bridge index — roughly ninety named handoffs across litestone, junction, sierra and the client | kernel logic spread across three packages |
| Bespoke drives | 37 `verify*` scripts in `example/package.json` | no conformance suite derived from the schema |
| Map size | root `CLAUDE.md` — 412 lines, 175 KB; `DECISIONS.md` — 11,887 lines | prose carrying what a generator could |
| Package count | 24 directories under `packages/` | boundaries drawn before they were stable |

None of these is a defect on its own. The pattern is the finding.

---

## Prior art

Read for this record; `prior-art.md` already covers Ash in depth and is not
restated.

**Ash Framework — one action lifecycle, policies on every action.** Every Ash
action runs the same pre-transaction → transaction → post-transaction phases,
and shared behavior is declared once as a pipeline that actions `pipe_through`.
Authorization is a phase of that lifecycle rather than a check each action makes.
**Evidence for:** the one-pipeline claim. A rule added to the lifecycle reaches
every action by construction, which is the property `verbs-rules.test.ts`
currently tests for instead of having.
[Actions](https://hexdocs.pm/ash/actions.html) ·
[Action lifecycle](https://alembic.com.au/blog/ash-action-lifecycle)

**ZenStack v3 — policy as a query-rewrite plugin.** V3 replaced Prisma with its
own engine on Kysely, and access control moved into a runtime plugin hooking
`onKyselyQuery`/`onEntityMutation`: one interception point under every verb.
**Evidence for:** enforcing at the query-builder layer below the verbs, so a new
verb cannot skip a rule. **Evidence of cost:** it took a full engine rewrite to
get there. [V3 README](https://github.com/zenstackhq/zenstack-v3/blob/dev/README.md) ·
[New plugin system](https://zenstack.dev/blog/next-chapter-3)

**OPA and Cedar — partial evaluation.** Both evaluate a policy with some inputs
unknown and emit the *residual* — the part depending on row data — which is then
translated to a SQL predicate. One evaluator, one AST; SQL is an output of
evaluation, not a second compiler. Cedar's is still marked experimental.
**Evidence for:** replacing `compileSql` + `evalJs` with one interpreter whose
residual has a SQL emitter. **Evidence of risk:** the residual-to-SQL step is
where both projects are least mature.
[OPA partial evaluation](https://www.openpolicyagent.org/docs/filtering/partial-evaluation) ·
[Cedar paper](https://arxiv.org/pdf/2403.04651)

**Supabase / PostgREST — one enforcement point, and what it still costs.** The
API is derived from the schema and RLS is enforced below every path. It is the
cleanest single-origin shape in the field, and the most common critical finding
in audits of Supabase apps is still a misconfigured policy exposing every row.
**Evidence for:** a single enforcement point does not remove the need for
conformance — it makes conformance *derivable*, because there is one place to
probe. [RLS docs](https://supabase.com/docs/guides/database/postgres/row-level-security) ·
[Pentest findings](https://www.precursorsecurity.com/blog/row-level-recklessness-testing-supabase-security)

**Schemathesis — conformance generated from a schema.** Property-based tests
generated from OpenAPI, run against a live app. Authorization is left to user
hooks. **Evidence for:** generated conformance is proven practice. **Gap it
leaves:** it has no notion of *who* — which is exactly what `.lite` declares, so
FJS can generate the part Schemathesis cannot.
[Schemathesis](https://schemathesis.io/)

**Wasp — five years and $5M on a custom language, abandoned.** In May 2026 Wasp
replaced its DSL with a TypeScript SDK. Stated reasons: adoption friction, no
ecosystem, IDE support "reached 80% of where we wanted to be," and the
ergonomics mattered less than expected. **What they kept** is the part that
mattered: the compiler's whole-app understanding at build time; only the input
surface changed. **Evidence against a piece of FJS's current shape:** `.lite`
and `.mesa` are two custom languages with their own LSP. Not a verdict — `.lite`
carries policy expressions a TS object would spell worse — but the bill Wasp
describes is the one `frontierjs-vscode` is paying.
[Wasp postmortem](https://wasp.sh/blog/2026/05/13/new-language-for-web-dev-was-a-mistake)

**Model-driven engineering — why it failed.** The recurring causes: generation
without an evolution story, no model-level testing, tooling gaps, DSL
proliferation. The one approach reported to work: *narrow the problem space
until generation is complete, so there is no round trip.*
**Evidence for:** FJS's runtime-derivation (no generated code to edit) already
avoids the round-trip trap. **Evidence against:** "DSL proliferation" and
"tooling insufficiency" describe the surface count below.
[8 reasons MDE fails](https://www.infoq.com/articles/8-reasons-why-MDE-fails/)

**Rails, Angular, Babel — lockstep monorepos.** Many packages, one version,
released together. **Evidence for a middle path** on publishing: the boundary
cost this repo pays (`registry`, `advisories`, peer-range traps, the exports
snapshot) is mostly the cost of *independent* versions, not of separate
tarballs. [Versioning strategies](https://gitmodules.com/versioning-strategies-in-monorepositories-releases-dependencies-and-team-ownership/)

---

## The proposal

### 1. One operation pipeline under every verb

Every read and write passes one ordered sequence — resolve principal → gate →
row policy → field protection → validate → transition → execute. (Not
`→ announce`: `FJS-D267` settles that announcing stays junction's, as an
observer on `$tapEvents`, rather than a pipeline stage.) A verb is a
*configuration* of the pipeline, not a method body restating it. This is
Ash's lifecycle and ZenStack's interception point.

**What it retires:** the fifteen insertion sites, and `verbs-rules.test.ts` as a
tripwire (it stays as a smaller assertion that every verb is registered).
**What it costs:** the heaviest refactor here, inside the most-audited file.

### 2. One policy evaluator, SQL as a residual

One interpreter over the policy AST. With every input known it answers
allow/deny (today's `evalJs`); with row data unknown it returns a residual that a
SQL emitter prints (today's `compileSql`). This is OPA/Cedar's shape.

**What it retires:** the oracle as the only thing holding two compilers
together, and `FJS-713`'s class. **Risk:** residual-to-SQL is where the prior
art is least mature; the oracle should stay until the emitter has survived it.

### 3. Conformance generated from the schema

Grow litestone's `verifyGateLadder` / `verifyRowPolicies` / … into a suite the
schema emits for any app, over the API tier (`@frontierjs/testing`) as well as
the Data tier, each assertion paired with its negative control the way the
drives already are. Schemathesis for *who*.

**What it retires:** every drive whose assertions are a function of the schema.
**What stays hand-written:** true crossings — a browser sending multipart, a
real vendor, a clock, a second process. That is the list the drive table is
genuinely good at.

### 4. The kernel is one package; realms are projections

**Settled by `FJS-D267`:** the kernel is litestone, the pipeline ends at execute,
and announcing stays junction's as an observer on `$tapEvents`. No package moves.

Schema IR + pipeline + evaluator is the kernel. API transport, UI resources,
studio, export, MCP are projections reading it. Mesa already works this way for
surfaces (`FJS-D38`); this applies the same rule to the Data realm. Invariant 1's
direction survives as *kernel ← projections*.

### 5. Lockstep versions before fewer tarballs

Release every `@frontierjs` package at one version until alpha. Removes the
peer-range and version-gap classes without re-merging packages.

### 6. Maps generated, prose for *why*

Following `fli ws:atlas`, `fli proves` and `invariants.snapshot.md`: the drive
and proves tables become generated from a declaration beside each drive, and
root `CLAUDE.md` shrinks to pointers. `DECISIONS.md` keeps the *why*.

### 7. Surface freeze until 1–3 land

No new surface (terminal, mobile, a new cloud) until the pipeline and generated
conformance exist, because every surface currently multiplies the proof layer.

---

## What this is not

- **Not a rewrite.** Each step lands alone and is graded by the existing drives.
- **Not a verdict on `.lite` or `.mesa`.** Wasp is recorded as evidence; the
  open question is below.
- **Not a reason to delete the drives now.** A drive is retired only after the
  generated suite reds on the same stub the drive reds on.

---

## Decision rules — `PHILOSOPHY.md` § V

Answered before writing.

1. **Another origin of truth?** No — it removes two (the second compiler, per-verb rule copies).
2. **Enlarges the concept budget?** Adds *pipeline* and *residual*; removes per-verb rule knowledge and the oracle as a concept a contributor must hold.
3. **Problem's complexity or ours?** Ours — the sites and the second compiler are artifacts of shape.
4. **Reduces predictability?** Increases it: *a verb applies every rule* becomes true by construction.
5. **Derived instead of restated?** That is the proposal.
6. **Exactly one owner?** Yes — one pipeline, one evaluator (Invariant 4 honored more strictly).
7. **Boundary explicit?** Kernel ← projections, named; the pipeline phase list is typed.
8. **Failure proportional?** A pipeline bug is wide — so step 1 lands behind the existing drives and `verbs-rules`, not instead of them.
9. **Wrong without anything saying so?** A generated suite that generates nothing passes green; each generated suite asserts its own count of assertions, the way the `scaffold` import check counts packages read.

**Adjudications in tension:** *Batteries vs. smallness* — the kernel is the core
admitted as such, and batteries become projections. *Doctrine vs. discovery* —
the code taught that restated rules drift; this amends structure to match
doctrine rather than the reverse.

**Tier:** Assessment. A step that is taken becomes a ruling in `DECISIONS.md`.

---

## Migration order

1. **Pipeline in litestone's table API.** Highest drift, clearest win, best-covered file.
2. **Generated conformance** from the `verify*` functions, over the Data tier then the API tier; retire drives one at a time against stubs.
3. **Lockstep versioning.** Cheap, independent, do anytime.
4. **Single evaluator** once the pipeline gives it one call site.
5. **Generated drive/proves tables**, then trim root `CLAUDE.md`.
6. **Kernel package boundary** last, when the seams it removes are visible in the bridge index shrinking.

---

## Open questions

- ~~**Does `.lite` survive Wasp's lesson?**~~ **Closed by `FJS-D266`** — both stay languages.
- ~~**Does `.mesa` need to be a language?**~~ **Closed by `FJS-D266`.**
- **Is `example/` the right home for framework proof**, or should capability fixtures move beside the packages and `example/` stop being load-bearing?

---

## See also

- `prior-art.md` — Ash in depth · `one-mental-model.md` — the extension-point catalog
- `framework-shape.md` · `provable-enforcement.md` · `testing-realm.md`
