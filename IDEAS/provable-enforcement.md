---
id: provable-enforcement
status: idea
dated: 2026-09-01
---

# Idea — provable enforcement: the promise no other ORM can copy

**Status: IDEA. Nothing here is built**, though roughly 70% of the mechanism already
ships under other names. Dated 2026-09-01. Written out of the six-pass litestone
design audit of the same date, whose findings are the evidence for §2 — the audit
itself is a published artefact and the register entries it produced are in
`ISSUES.md`. See `VERIFYING.md`.

---

## The question this answers

*What sentence does someone say when they recommend Litestone to a colleague, and
what has to be true so that Prisma cannot copy that sentence in a weekend?*

Today the honest sentence is **"SQLite ORM for Bun, zero dependencies,
schema-first"**, and every clause of it is copyable. Bun ships its driver to
everybody. Schema-first is Prisma's own pitch and Prisma has the tutorials. Zero
dependencies is a build property, not a reason to move an application. `docs/why-litestone.md`
argues the position well and every argument in it is an argument about *this
engine being a reasonable choice*, which is a different job from being the one
somebody recommends unprompted.

## 1. The observation

**Litestone can prove what it enforces, and no other ORM can — and the project does
not say so anywhere.** The organ already exists, spread across five names that read
as testing utilities rather than as the product:

| Ships today | What it proves |
| --- | --- |
| `verifyGateLadder` | every gated model × every level × all four operations |
| `verifyRowPolicies` | the compiled WHERE graded against an independent evaluator, rows on both sides |
| `verifyConstraints` | every declared rule, isolated, against a real write |
| `verifyFieldProtection` | `@guarded`/`@encrypted`/`@secret`, actually read back |
| `verifyTenantIsolation` | a tenancy declaration actually crossed, both directions |
| `litestone mutate` | the schema mutated, the ORIGINAL's checks run against the mutant — a hole in the checks names itself |
| `test/matrix.test.ts` | 20 column kinds × 16 operations under *no cell may silently return a wrong answer* |
| `access.snapshot.md` · `release.snapshot.md` | the declared surface committed, so a change is a diff rather than a production refusal |

Prisma cannot grow this, because its access rules live in application code and there
is nothing there to prove. ZenStack cannot, because it does not own the runtime the
rules are enforced in. Drizzle is deliberately close to SQL and declares nothing to
verify. **The moat is not the feature list; it is that the rules are declarations and
a declaration is checkable.**

## 2. The evidence that this is the real axis

The audit found twenty-eight items. What matters here is not the count but **where
they sit**: every fail-open it found is precisely a place the verification organ does
not reach, and the alignment is exact rather than suggestive.

| Hole found | Blind spot it sits in |
| --- | --- |
| bulk verbs bypass the state machine and the capability partition | `verifyGateLadder` grades single-row verbs only |
| the JS policy interpreter fails **open** on an unknown node, and `create` is the only op it grades | `verifyRowPolicies` cannot grade create — the evaluator IS the implementation, so the check is circular |
| a typo'd `auth()` claim compiles to a rule that never fires | nothing grades the principal's shape; only `capabilities` is checked |
| a `check()` policy cycle compiles to allow-all | `verifyRowPolicies` reports a rule holding `check()` as *not graded*, by name |
| an unknown `where` key warns to stderr and is interpolated into the SQL | nothing verifies the filter boundary at all — that check lives one package up, in junction |
| a second process announces nothing to the first | no check crosses a process |
| `@unique` is global across tenants under `strategy row` | `verifyTenantIsolation` grades reads, not write-side uniqueness |

Read the right-hand column on its own and it is a to-do list that would have
prevented the left. **That is the argument of this file in one table.** The project
has been finding these one at a time, by building applications and by audit; the
alternative is that the tool finds them, in CI, on every schema in every app that
installs it.

## 3. What to build — `litestone prove`

One command, one exit code, one sentence: **every rule you declared is enforced on
every path, and here is the proof.** It is not a new mechanism; it is the existing
checks promoted from `./testing` to a first-class command, plus the coverage the
table in §2 names.

- **A grid, not a suite.** The unit is *(rule kind × path)*, and every cell is
  supported, refused-by-name, or **red**. `matrix.test.ts` already established the
  discipline and the sentence that makes it work: a missing cell fails rather than
  being skipped, and a known defect is a cell asserted *still broken*, so fixing it
  turns the grid red and tells you to promote it. What the grid needs is the second
  axis: not only column-kind × operation, but **rule × verb** (does `@@transitions`
  hold on `updateMany`?) and **expression form × interpreter** (does `a in b` mean
  the same thing to the SQL compiler and to `evalJs`?).
- **The paths must be enumerated by the tool, not by the author.** Every silent hole
  in §2 exists because a path was added and a rule was not re-asked. If the command
  derives its path list from the client's own method table, a new read method arrives
  in the grid as a column of empty cells, which is a failure.
- **It grades a real database**, as the existing verifiers do. This is the half that
  makes it uncopyable: a static analyser can say a rule is declared, and only a
  harness that writes rows can say it is enforced.
- **`--fix` never.** A proof that repairs its own subject proves nothing.

The work is mostly filling cells rather than inventing mechanism, and each filled
cell is an audit nobody has to run again.

## 4. The half that makes it a product rather than a chore

**Every fail-open in §2 is invisible to an agent by construction.** A warning on
stderr, a silently stripped column, an empty list with a 200 — a person eventually
notices one of these; an agent writing the application never does, because none of
them is a return value or an exception. This matters more here than in other
codebases, because this repository is already built agent-first and has been for
months: `catalog.snapshot.md` and `litestone explain` publish the language as data,
`litestone advise` reports legal-and-wrong, refusals carry the fix in the message,
and every generated artefact is committed so that a change is a diff.

That is a thesis nobody else is building an ORM around, and it converts the
project's existing instincts into the reason for them: **fail-open is the cardinal
sin, refuse-by-name is the interface, and `prove` is the feedback loop.** An agent
that can run one command and be told which of its declarations do not hold is a
different working relationship from one that ships a green build over a policy that
matches nothing.

If that framing is accepted, three things already ruled get re-read rather than
reopened — a warn-and-continue is not a kindness to a typo (`FJS-D57`), a
documented gotcha is not a mitigation, and an opt-in verifier is a check that is not
running on the schemas that need it.

## 5. The price, and it should be paid deliberately

**Would the language freeze — or shrink — to make everything left provable?**
`catalog.snapshot.md` counts 100 words against Prisma's ~15 field attributes. The
audit's own diagnosis is that breadth is what produced the holes: attribute legality
is ruled pairwise across the surface, so each unruled pair is one probe from a silent
hole (`@encrypted + @@fts` builds a search index over ciphertext; `@unique` on a
virtual field vanishes with no diagnostic). Every word added is a row in the grid of
§3 and a pair in the matrix of legality.

The trade to weigh: a 100-word language where the guarantee is *most rules hold on
most paths*, against a 60-word language where the guarantee is *every rule holds on
every path, and the command proves it*. **The second is the recommendable sentence.**
The first is a feature race with a better-funded incumbent on the incumbent's own
axis.

Nothing here argues for removing a word that is carrying an application. It argues
that the next word should be priced in grid cells, and that the ones carrying nothing
should be found — `litestone advise` and the catalogue are already most of the way to
answering *which words does any app in this repo actually use*.

## 6. What would falsify this

- If the checks, extended to the §2 blind spots, find **nothing** — the organ is
  already adequate and the audit's findings were incidental rather than structural.
  (The audit's prediction is the opposite, and it is a cheap prediction to test:
  extend `verifyGateLadder` to bulk verbs first, since that is one loop and the hole
  is known to be there.)
- If an application author, offered the choice, wants the language to say 40% more
  things rather than to prove what it already says. Worth asking directly before any
  of §3 is built.
- If the grid cannot be made to run in a time an application will tolerate. This one
  has a real warning sign already: `litestone mutate` runs in no CI phase because
  basecamp took over 25 minutes and was killed (`FJS-598`). A proof nobody runs is a
  document. **Tiering is therefore part of the design, not a later optimisation.**

## 7. Order

None of this is urgent and all of it gets cheaper the sooner it is decided, because
every cell is priced in call sites. The audit's own sequencing puts three tiers of
repair ahead of it — the exploitable and corrupting findings, then the coordination
layer, then the process-model ruling. **This file is what the repair work should be
converted into afterwards**: each fix landing as a cell that is now green and cannot
silently go red again, rather than as a commit nobody can find in a year.
