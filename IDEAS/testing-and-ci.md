# Idea — A testing environment and automated CI

**Gap B is superseded by `IDEAS/testing-realm.md`** (2026-08-11), which turns it into
an ordered plan and revises two of its conclusions against research into how other
frameworks fail at this. Read this file for how the question was first framed;
read that one for what to do. § Design — the Suite realm and § Design — derived
suites are the parts that moved.

**Status: gap A is BUILT, gap B is still an idea.** Dated 2026-08-03; gap A shipped
2026-08-10 as `scripts/ci.mjs` + `scripts/hooks/pre-push` + `.github/workflows/ci.yml`
— read the script, not the § Design — CI sketch below, which is what was proposed
rather than what runs. Everything from § Design — the Suite realm onward is
unbuilt. Every claim below was probed by running, not read off a status file
(`VERIFYING.md`); the evidence is named inline. Do not cite this file as
describing behaviour.

**What the assessment below got wrong, re-probed 2026-08-10.** Two of its three
skipped packages are no longer skipped — `packages/basecamp` has a `package.json`
and 146 files in git, and `packages/frontierjs-vscode` has a `test` script — and
the repo has no untracked files left. `packages/orion` is still invisible, joined
by `datetime-kit`, `oracle` and `toolbelt`; all four are now exempt **by name**,
which is the difference between a skip and a decision.

**Vocabulary note:** Testing's noun is **Suite** (`ARCHITECT.md` §2). Like Release,
it is a named realm with no package and no primitives — see
`IDEAS/framework-shape.md` item 3 for the same shape one realm over.

---

## The one-line verdict

There is no automation of any kind. The aggregate scripts are *better than expected*
— `bun run test` genuinely runs 13 packages and fails correctly — but nothing runs
them except a person who remembers to, and three packages are skipped without
saying so. **Every landmine in `CLAUDE.md` was found by hand.** Most of them are the
kind a machine finds for free, forever, on every commit.

---

## What was probed (2026-08-03)

**No CI exists.** There is no `.github/` directory anywhere in the repo. No workflow,
no action, no pre-commit hook, no scheduled anything.

**The aggregate scripts work, and they are the foundation.** Root `package.json` has
`test`, `build` and `typecheck`, each `bun run --filter '*' <script>`. Running
`bun run test` end to end: 13 packages ran, `@frontierjs/jetty` exited 1 (its known
phase8 failure), the other 12 exited 0, and the aggregate exited **1**. It does not
stop at the first failure — every package still ran. `bun run typecheck` behaves the
same and honours the per-package `--baseline` ratchet: junction printed its
long-standing diagnostics and still exited 0.

That matters because it means **CI is not a design problem here, it is a missing
file.** The commands already exist and already have correct exit codes.

**Three packages are skipped, silently.** `packages/*/` has 16 entries; 13 appeared
in the run.

- `packages/basecamp` — no `package.json` anywhere under it, so the workspace glob
  never sees it
- `packages/orion` — same, and the directory is empty
- `packages/frontierjs-vscode` — has a `package.json` but no `test` script, so
  `--filter '*'` passes over it without a word

A skipped package is indistinguishable from a passing one in the output. That is the
failure mode to design against, not the absence of a runner.

**Two packages are not in git at all.** `git ls-files packages/basecamp` returns
**0 files**; so does `packages/orion`. The framework's largest dogfooding surface
(~15k lines, per `CLAUDE.md`) exists only on this machine. 22 untracked files repo-wide.

**The environment is heterogeneous and undeclared.** Four runners across 13 packages:
bun (auth, caravan, cli, conduit, junction, litestone, notifications), vitest (mesa,
sierra, email-kit), plain `node` (jetty, ui), and **headless Chrome** (css). Chrome is
on PATH on this machine — `/usr/bin/google-chrome`, `/snap/bin/chromium` — and
`FJS_CHROME` is unset, so css passes here by luck of the local box. Nothing declares
that dependency; a fresh runner without a browser fails one package and it will read
as a css bug.

---

## Two distinct gaps, often conflated

### A. Automated CI — mechanical, cheap, overdue

No commit is verified by anything. This is the smaller and more urgent half.

### B. A testing *environment* — the Suite realm

Junction ships a genuinely good test kit (`createTestApp`, `request`,
`createStubAuth`, `testCtx` — `packages/junction/src/testing/index.ts`). It covers
one realm. There is no way to stand up **an app** — schema migrated into a scratch
database, services mounted, a browser pointed at the UI — and assert across the
seam. Every cross-realm claim in this repo is currently verified by a hand-written
one-off: `packages/sierra/tests/fixtures/island-site/verify.mjs` drives real Chrome,
`packages/css/test/run.js` has its own harness, basecamp's schema was proved by
applying it to a scratch db in a shell session. Each is good work; none is reusable.

These are separable. **A is worth doing this week and does not wait on B.**

---

## What CI would have caught — from this repo's own history

Not hypotheticals. Each is a documented landmine that a machine would have found the
day it landed:

- **`build/` in `.gitignore` hid 20 source files.** Sierra's entire build pipeline
  was untracked and absent from a fresh clone. A `git clone && bun install &&
  bun run test` job in a clean directory fails instantly on this. Still relevant:
  `island-bundle.js` is untracked *today*, and basecamp/orion are wholly untracked.
- **`bun install` resolves `workspace:*` to a copy, not a symlink.** A suite can
  report green against a stale snapshot of a sibling package — this cost a debugging
  cycle during the `packages/ui` work, and `packages/ui/node_modules/@frontierjs/mesa`
  is currently a hand-placed symlink that will not survive a reinstall. CI always
  installs from scratch, so it sees the real resolution every time.
- **The dialect trap.** `Integer/Text/Real/Blob` → `Int/String/Float/Bytes` was a
  hard cut that could only bite consumers *outside* the workspace. A job that
  installs a published tarball into a scratch app and parses a `.lite` file catches
  that class permanently.
- **`packages/ui` shipped 55 of 63 components in UnoCSS utility classes**, compiling
  perfectly and rendering unstyled. `test/render.mjs` now asserts no utility class
  comes back — but only if someone runs it.
- **`{class}` replaced classes instead of merging**, silently unstyling all 63 ui
  components for the life of the package. Nothing threw; nothing warned.
- **`002_server_agent.sql` was never valid SQLite.** A migration-applies job on a
  fresh database is three lines of YAML.

The pattern: **the expensive bugs here are silent-success bugs.** They compile, they
render, they exit 0. That is precisely what a machine running the same assertions on
every commit is for — and precisely what a human spot-check misses.

---

## Design — CI (gap A)

**Built 2026-08-10, against these six constraints.** 1 partly — the workflow
checks out fresh and installs `--frozen-lockfile`, and the hygiene phase catches
the `build/` class locally by failing on any source file `.gitignore` hides, but
nothing clones into a scratch directory. 2, 3 and 4 in full: Chrome is named in
the workflow rather than inherited, a package with no `test` script fails unless
it is exempt by name with a reason, and a raised baseline fails against the merge
base. 5 and 6 **not built** — no job installs a published tarball, and the
example drives are outside CI because they need servers started by hand and
`example` signs in against a 10-per-15-min login limit.

Constraints this repo actually has, which shape the job:

1. **A fresh clone, always.** The `build/`-gitignore incident is the reference test
   case: an upgrade that only passes on a machine with untracked files is not a pass.
   Job one is `git clone` → `bun install` → `bun run test` in a clean directory.
2. **A browser must be provisioned.** css needs Chrome and sierra's island
   verification does too. Declare it (`FJS_CHROME`) rather than inheriting it.
3. **Skipped is not passed.** The job must assert package *coverage* — every
   directory under `packages/` either has a `test` script or is explicitly listed as
   exempt, and adding a package without one fails. Today three are invisible.
4. **Typecheck baselines are a ratchet — enforce the direction.** `scripts/typecheck.mjs`
   already prints `below the baseline of N. Lower the baseline…`. CI should fail on
   a *raise* and ideally nag on a not-lowered improvement. `CLAUDE.md`'s rule
   ("lower when you improve it; never raise one") is currently honour-system.
5. **The registry, not just the workspace.** A job that installs the published
   package into a scratch app is the only thing that would have caught the dialect
   trap, and the only thing that will catch the next one.
6. **The examples are load-bearing.** `CLAUDE.md` says a broken example is a bug, not
   a sketch — junction's four-rung ladder, litestone's, sierra's `example/`. They
   were "verified over HTTP 2026-08-01" *by hand*. That verification should be a job.

Deliberately **not** proposed: a coverage threshold. This repo's failures are
silent-success, not uncovered-line, and a percentage gate would add ceremony without
touching the actual failure mode.

---

## Design — the Suite realm (gap B)

The shape follows the framework's own thesis: if Data → API → UI all derive from one
seed, then a test app should be **seeded the same way** rather than hand-assembled.

Sketch, not a commitment:

```ts
const app = await createTestEnv({
  schema: 'db/schema.lite',   // migrated into a scratch db, per-test or per-file
  as:     { level: 5 },       // a gate level, so authz is exercised not stubbed
  ui:     true,               // optional: build + serve, hand back a browser page
})
```

What each realm contributes, and what already exists for it:

| Realm  | Contributes                             | Exists today                                        |
| ------ | --------------------------------------- | --------------------------------------------------- |
| Data   | scratch db from a `.lite` seed          | `makeTestClient()` — in-memory, seeded, `@frontierjs/litestone/testing` |
| Data   | **factories** from field types + rules  | **exists** — `Factory`, `autoFactories`, `generateFactory`; no caller outside litestone |
| API    | mounted app, request helper, stub auth  | `packages/junction/src/testing/index.ts` — good     |
| UI     | built site, a page, an assertion API    | one-off harnesses (sierra, css, ui)                 |
| Suite  | the runner and the env                  | four different runners, no shared env               |

Two things this unlocks that a per-package suite cannot:

- **Gate levels as a first-class test axis.** Authorization at the Data boundary is
  the framework's best asset (`IDEAS/framework-shape.md`); it deserves
  `for (const level of [0,3,5,7])` rather than a stub.
- **Slice conformance.** `IDEAS/slices.md` proposes a `suite/` part that runs against
  the *consuming* app, and `fli slice:doctor` to run every installed slice's suite.
  That part has nowhere to plug in until this exists — the two ideas meet here.

**Sequencing note** (revised 2026-08-04): this used to say factories were the cheapest
next step. They were built — `ecosystem-gaps.md` tier-2 item 5 — so the cheapest next
step is now *using* them: point Junction's test kit at `makeTestClient()` so a mounted
app gets its rows from the schema instead of by hand. The kit is good and still
under-used, and now that is a wiring gap rather than a missing piece.

`generateGateMatrix()` also already emits the `for (const level of [0,3,5,7])` axis
described below, per model, from `@@gate`. Nothing consumes it yet.

---

## Design — derived suites (added 2026-08-04)

Gap B above is about a place to *write* tests. This is the stronger version of the
same thesis: **if the migration, the validator and the form all derive from one
seed, so do the tests.**

Every model already declares its constraints, its gates, its relations and its
formats. For a 24-model app that is several hundred meaningful assertions nobody has
to write, per model, for free:

| Derived from | The test it generates |
| --- | --- |
| `@@gate("4")` | anonymous read is 401; level 3 create is 403; level 4 succeeds |
| `@guarded(all)` | the column is **absent** — not null — from find, get, bulk read, and the WS broadcast |
| `@length(2,60)` | property test: 1 rejected, 2 accepted, 60 accepted, 61 rejected |
| `@email` / `@unique` | format rejection; second insert conflicts |
| `onDelete: Cascade` | the children actually go |
| `@scoped` | tenant A never sees tenant B's rows on any method |
| enum fields | a non-member is rejected at the boundary, not just in the UI |
| the envelope | list keeps `total`; single unwraps — on every service, over both transports |

Three properties make this materially better than handwritten equivalents:

1. **They cannot rot.** Change the schema, the suite re-derives. A handwritten gate
   test survives a gate change and keeps passing against a rule that no longer
   exists — which is the exact failure mode `VERIFYING.md` was written about.
2. **They cover the boring paths nobody writes.** Bulk reads and WS broadcasts are
   where `@guarded` leaks (the July password leak was a wrapper/record confusion of
   precisely this kind — see `packages/junction/src/core/envelope.ts`). A generator
   does not get bored.
3. **They answer the slice-conformance question properly.** A slice should not ship
   handwritten tests for its own models; it should *inherit* derived ones, and
   `fli slice:doctor` runs them against the consuming app
   (`IDEAS/slices.md`). That removes the last hand-maintained part from the slice
   format.

Open sub-questions specific to this: are derived tests materialised as files a
developer can read and edit (codegen — inspectable, driftable), or produced at run
time from the schema (derivation — always current, opaque)? The framework's own
precedent points at **derivation**, since Litestone migrations are the one place it
deliberately chose the opposite and that choice is defended by a diff you read
first. Also: what is a derived test's escape hatch when a model legitimately
violates a generated expectation, and how loud is opting out?

---

## Open questions

- Does CI run per-package on change, or the whole workspace every time? The whole
  thing takes minutes today, so start with everything and split when it hurts.
- Does the runner heterogeneity get normalized (one runner) or declared (a manifest
  saying which each package uses, so coverage can be asserted)? Declaring is cheaper
  and loses nothing; normalizing is a large change for a cosmetic win.
- Where does `createTestEnv` live — a new `@frontierjs/suite`, or inside junction's
  existing `testing/`? Junction's already exists and works, but the env crosses into
  Data and UI, and junction may not import Sierra (dependency direction).
- Is `packages/basecamp` in CI? It cannot be until it has a `package.json` and is in
  git. Given it is the largest dogfooding surface, it is also the most valuable thing
  a CI job could be watching.
- Browser testing as a package (`ecosystem-gaps.md` tier-2 item 8, "Laravel Dusk") —
  is that the UI half of this idea, or a separate thing? Probably the same thing; the
  technique is already in-repo three times.

## See also

- `IDEAS/framework-shape.md` — the realm-by-realm gaps; Release has the same
  named-realm-with-no-package shape
- `IDEAS/ecosystem-gaps.md` — tier-2 item 5 (factories, **built** — the gap there is
  adoption) and item 8 (browser testing) are both components of this
- `IDEAS/slices.md` — the `suite/` part and `fli slice:doctor` depend on gap B
- `VERIFYING.md` — the manual discipline this proposes to automate, not replace
- `CLAUDE.md` § Landmines — the corpus of silent-success bugs CI is aimed at
