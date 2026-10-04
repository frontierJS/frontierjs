---
id: review-decisions
status: assessment
dated: 2026-10-03
---

# Review — the decisions, read as one body

**Read on 2026-10-03: `PHILOSOPHY.md`, the `decision-rules` skill, every ruling
heading in `DECISIONS.md` (535) and a handful of full bodies.** The question was
not whether any one ruling is right but what the rulings have in common — the
patterns in the framework they produce, and in the process that produces them.
Proposes nothing to build. Its use is as an instrument: a new proposal that
breaks a pattern below is either the exception the pattern needs or a sign the
proposal missed the prior art in this file.

## Patterns in the framework

**1. The doctrine is self-similar.** One origin, one name, one owner is applied
to app code, then to the documents (`PHILOSOPHY.md` § VII), to the skills
(`decision-rules` refuses to restate the nine), to the register itself
(`fli register:check`) and to the invariants (`invariants.snapshot.md`). The
framework is the same three axioms pointed at successive targets.

**2. Silence and refusal are kept distinct.** The most consistent pattern in the
file. Undeclared imposes nothing (`FJS-D53`); `@@sync` has no default and silence
means not syncable (`FJS-D298`); a null tenant is nobody's and a shared row says
`@@tenant(none)` (`FJS-D141`); an anonymous write is a declaration (`FJS-D349`);
`none` is a recorded enforcement answer (`FJS-D190`); a ruling in force carries no
status word (`FJS-D196`). Every default is either declared or deliberately
meaningful.

**3. A ruling is usually a re-classification.** The capitalized word in a heading
is its hinge: a database is a FILE (`FJS-D232`), a device's db is a CACHE
(`FJS-D309`), a capability is a REFERENCE (`FJS-D139`), renewal is a row per
period (`FJS-D367`), a reminder is a transition (`FJS-D370`), a deferred
obligation is a transition the system owes (`FJS-D353`). The move is rarely a new
feature; it is showing the new thing is an existing noun, which is how the
concept budget stays flat.

**4. Every question is asked as "one or two".** Split: `@guarded` and `@omit` are
two axes (`FJS-D205`), journal and lock are two questions (`FJS-D156`), querying
with an engine and storing in one are two (`FJS-D248`), Bar and Toolbar differ by
a promise and not a pixel (`FJS-D96`). Merge: `ws:map` and `ws:atlas` are one
command (`FJS-D223`), three duplications close (`FJS-D16`).

**5. Measurement outranks preference.** `FJS-D239` reversed `FJS-D43` because the
corpus voted 320 to 5; `FJS-D32` measured 7,249 lint findings against ~600;
`FJS-D174` refused `safeIntegers` on measurement. *Not a taste call* recurs — a
taste question is converted into a fact before it is ruled.

**6. Generality waits for a second consumer.** `Slice` waits for a second author
(`FJS-D06`), `@zoned` for a second app (`FJS-D288`), Mesa's IR for the first
non-DOM backend (`FJS-D545`), the flow canvas stays orion-local with one consumer
(`FJS-D510`), `@@sync` grows only when an app asks (`FJS-D304`). The stressor
apps exist to supply that second consumer.

**7. The owner is whoever already computes the fact** (`FJS-D16`). A copy exists
because a door was shut, so open the door and delete the copy rather than sync
it (`FJS-D260`). Shared facts sink into toolbelt (`FJS-D197`, `FJS-D287`,
`FJS-D339`, `FJS-D533`).

**8. Authority sinks to the Data boundary.** Gates, transitions, merge comparison
(`FJS-D334`), broadcast grading (`FJS-D175`) and the caller's level (`FJS-D308`)
all land in Litestone. There is no ambient system escape either:
`asSystem()` lifts authority and never integrity (`FJS-D502`), deferred work runs
as the enqueuing principal (`FJS-D69`), a job whose actor is gone fails
(`FJS-D202`).

**9. The mechanism, never the vendor.** `FJS-D215`, `FJS-D153`, `FJS-D31`,
`FJS-D110`, `FJS-D233`. The framework commits rather than abstracting over
backends, and a third party is a conduit target rather than a dependency.

## Patterns in the process

**A. Reversal is cheap and written.** `FJS-D239`, `FJS-D169` and `FJS-D112` each
reverse an earlier ruling; `FJS-D63` amended one the same day. Code may beat
doctrine, through a hearing on the record.

**B. An override is explicit and pays for itself.** `FJS-D255` says the nine
refused it and lands anyway, then constrains the alias until it cannot drift —
it forwards argv and grades nothing. The cost of the exception is designed in.

**C. Every rule wants an enforcer.** Snapshots, ratchets (Invariant 14,
`FJS-D302`, `FJS-D476`), `fli check`, `register:check`. Prose is distrusted as a
carrier of truth, including the authors' own.

**D. A ruling stores its reason so it can be amended to it.** `FJS-D369` amends
`FJS-D71` "to its reason". The reason is what a later reader tests, not the
mechanism.

**E. One mind, scaled through agents.** `PHILOSOPHY.md` § IV calls the design one
mind's and says coherence transfers only through vocabulary, documents and
enforcement. Recent rulings arrive as numbered question batches with a
recommendation line — agents propose, the owner rules — and the skills,
`doc-hygiene` and the bridge index are the transfer mechanism.

**F. The rate is rising.** 161 rulings dated 2026-09-25…29 against 156 dated in
all of August.

## Cracks worth a hearing

**The meta-layer is exempt from the concept budget.** 19 invariants, nine
questions, seven adjudications, four document kinds, ~100 bridge names, 535
rulings. A framework against restatement now carries a large apparatus, and many
rulings re-apply one principle in new words. The risk is the one § I names: the
doctrine itself becoming a second mental model to hold.

**The register doubles as a changelog.** `FJS-D41` (`.pagination-link`) and
`FJS-D442` (a pinned CDN version) read as `CHANGES.md` entries rather than
settled arguments. A test for what earns an `FJS-D` id would keep the register a
register.

**`FJS-D159` keeps an alias.** A service filename's own spelling stays mounted
beside the canonical name. Dated 2026-08-29, before `FJS-D224` (2026-09-05)
ruled that a rename keeps no alias — a likely survivor of the older stance. Not
checked against the code.

**Checks of checks have no stopping rule.** `register:check` grades the register,
`invariants.snapshot.md` grades the invariants. Each layer is defensible; nothing
says when the next one is not.
