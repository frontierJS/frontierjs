---
id: process-entropy
status: proposed
dated: 2026-09-27
---

# Idea — process entropy: the ladder and the pump

**Status: PROPOSED.** Dated 2026-09-27. The counts below were taken on that date
and are true for an afternoon. Nothing here ships. See `VERIFYING.md`.

---

## The claim

`entropy.md` counts facts the TREE states twice. This counts facts a SESSION
has to re-derive because the tree states them nowhere it can be graded. Same
law, applied to the loop that edits the tree rather than the tree.

Every session re-discovers things: which runner a package uses, that a port
answering is not the right process, that a hand map understates the tree. Each
re-discovery is paid in tokens and turns, every session, and captured only as
prose. A coding process that IMPROVES is one where each session's discoveries
land somewhere the next session does not have to discover them.

## The ladder

A discovery can land on three rungs, in order of decay:

| Rung | Where | Cost to keep | Cost to use | Drifts |
| --- | --- | --- | --- | --- |
| 1 | prose — `CLAUDE.md`, a `*-hazards` skill, a memory file, `HANDOFF.md` | hand | read every session | silently |
| 2 | generated — `*.snapshot.md`, `fli ws:atlas`, `reference.snapshot.md` | none | read when needed | never; goes stale loudly (`snapshots` phase) |
| 3 | grader — a `fli check` rule, a test, a refusal at the boundary | none | zero until it fires | never; fires exactly when needed |

The repo has all three rungs. What it lacks is the pump: nothing moves a fact
DOWN the ladder, so rung 1 grows. Measured today: the three hazard skills are
255 lines; the data skill lists 48 hazards and none of the three cites a
`fli check` rule. Every one is a rule that decays, read in full by every session
that touches a `.lite` file.

## The pump

Cheapest first. Each is one mechanism, and the first is the metric without which
the rest are vibes.

1. **Count the cost.** `fix-next` already carries a row from re-probe to closed.
   Log per close: tokens, turns, files read more than once, skills loaded but
   never cited. One table, ratcheted the way `entropy.md` ratchets. Without it
   *the process improved* cannot be said.
2. **The exit question.** Before `fli done` passes: *which fact did I learn that
   the tree should have told me, and which rung does it go on?* Rung 3 or 2 by
   default; rung 1 only with a sentence saying why it cannot be graded. This
   turns `HANDOFF.md` from a narrative into a ledger of ladder moves.
3. **Skills that shrink.** `prose-rule-ungraded` (`entropy.md`) is the pump for
   the hazard skills: a hazard cites a rule id or is debt. Success is the skill
   file getting shorter every month while `checks.js` gets longer, and the token
   load per session falling as a side effect.
4. **Eval the traps.** `skill-creator` runs evals. Build a trap corpus: tasks
   with a known hazard on the path. Run with and without the skill, count trips.
   A hazard nobody trips → cut from prose. A hazard tripped despite the skill →
   prose failed, it needs a grader. This is the audit-and-tweak loop, measured.
5. **Compile the map.** A package `CLAUDE.md`'s layout half is a hand restatement
   of the tree that `fli ws:atlas` already reads. Generate the layout, keep only
   the traps by hand. The memory rule *CLAUDE.md understates the tree* is what
   happens when this is not done.
6. **A grader per close.** Closing a row adds the thing that would have caught
   it — a test, a rule, a refusal — or says why none can. `DRIVES.md` is the
   proof half; this is the prevention half.
7. **Refuse the read.** The `fli outline` hook already stops a whole-file read.
   Extend it: a read of a document a rule already grades is answered with the
   rule's verdict, not the document.

## What this is not

Not more memory. Memory files and hazard prose are where this repo already
leaks: helpful, hand-written, never graded. A memory older than N sessions with
no grader behind it is a question, not a fact.

## Prior art

- **Voyager** (Wang et al., 2023) — an agent's skill library where a skill enters
  only after it RAN. The rung-3 discipline; Invariant 16 says the same of examples.
- **Reflexion** (Shinn et al., 2023), **Self-Refine** — reflection stored as
  prose across attempts. Rung 1, and it decays the same way.
- **DSPy** — prompts compiled against a metric rather than hand-written. Pump 4
  is a skill's prose optimized against trap-corpus pass rate.
- **ArchUnit / Pest architecture tests** — `checks.js` cites Pest. Rules as
  executable assertions rather than review comments; the rung-3 canon.
- **Ratchet tests** — a count of a bad thing may only fall. Invariant 14, reused.
- **Knuth, literate programming** — one source, documents derived. Rung 2.
- **Hyrum's law** — why undeclared residual is the enemy: someone depends on it.
- **MetaGPT** — agents given SOPs that produce artefacts, not chat.
  `packages/cli/commands/*.md` are SOPs that execute.

## The nine (answered before the edit, 2026-09-27)

1. Origin — a fact a session re-derives has its origin in the tree; prose is a
   second origin that drifts. The pump moves it to the one that is graded.
2. Concept — no new noun. *Ladder* and *pump* are this file's words for
   § VII's tiers and for `doc-hygiene`'s inline-or-pointer question; if either
   outlives this file it is folded into those, not kept.
3. Complexity — the cost is a table and an exit question. The 255 lines of prose
   are complexity already paid every session.
4. Predictability — one ladder for every discovery; today each session decides
   fresh where a fact goes.
5. Derived — the layout half of a `CLAUDE.md` is derivable and is not. The
   metric is derivable from `fix-next`'s own run.
6. Owner — `fli check` owns graders, the `snapshots` phase owns rung 2,
   `doc-hygiene` owns rung 1. The pump goes inside `fix-next` and `fli done`,
   the two places a session already passes through.
7. Boundary — a session should not have to know the tree's history to avoid a
   trap; a grader fires without it.
8. Failure — the exit question WARNS; a missing answer is not a red. A stale
   snapshot is already a red. A rung-1 fact with no reason is a `warn` from
   `prose-rule-ungraded`.
9. Silence — must stay true: every hazard has a grader or a reason. What fails:
   `prose-rule-ungraded`. Until it lands, **none**, and the count above is the
   evidence it is needed.

Adjudication: *batteries vs. smallness* — one more phase in `fli done` against
a process that pays 255 lines a session. Sided with the battery, because it
is the one that makes the others smaller. Tier: Assessment.

## See also

- `entropy.md` — the tree's restatement count; this is the session's.
- `provable-enforcement.md` — the promise both counts make checkable.
- `.claude/skills/fix-next/SKILL.md` — where pumps 1 and 6 live.
