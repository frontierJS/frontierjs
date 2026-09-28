---
id: entropy
status: proposed
dated: 2026-09-27
---

# Idea — entropy: the restatement count, ratcheted

**Status: PROPOSED.** Dated 2026-09-27. One prototype was run on that date and its
numbers are below; nothing here ships. See `VERIFYING.md`.

---

## The claim

Progress on this framework is one direction: fewer places a fact is written by
hand, and every surviving copy either DERIVED from its origin or GRADED against
it. `PHILOSOPHY.md` § V asks this per proposal (q1 origin, q5 derived, q9
silence). This idea asks it of the whole tree, as a number that only moves one
way.

**Entropy here means restatement**: a fact stated by hand in more than one place.
Each copy drifts alone, and the drift is silent because each copy is right about
itself. Work spent keeping copies aligned is CI, `fli check`, the snapshot
phase — the second law's cost. The cheaper move is a copy that cannot be born.

Not a new noun in code. The word names the metric and nothing else; the
mechanism is q5, and the rule ids say what they grade.

## The metric

Per package, a count of restatements in named classes. Each class is a `fli
check` rule with an AUTHORITY in the tree (`doc-audit.js` § *What a rule here
may grade*): a schema, a path, a register id, a countable directory. What a
paragraph argues is never graded.

Counts go to `scripts/entropy-baselines.json`, one number per package, absent
means 0, **ratchet down only** — Invariant 14's shape, reused rather than
restated. `--update` writes an improvement back.

The residual is allowed. A declared departure — an irregular resource name
(Invariant 19), a form narrowed by `only`, a list with a stated reason — is not
entropy, it is the app. What the ratchet refuses is the UNDECLARED copy.

## The classes, cheapest first

| Rule | Authority | Copy it catches | Scope |
| --- | --- | --- | --- |
| `restated-fields` | `db/schema.json` | a hand-typed array of one model's field names — an allow-list, a deny-list, a form's columns, a fixture | app |
| `prose-rule-ungraded` | `.claude/skills/*-hazards/SKILL.md` | a hazard no rule id cites; a prose-only rule decays | repo |
| `path-derived` | Invariant 3 | a config path built from where a vite config sits | app |
| `route-restated` | `web/src/routes/` | a route table typed by hand where the tree already says it | app |
| `gate-untested` | `@@gate` | a gated model with no test at each level | app |

`restated-fields` first, because it was run and found something (§ below).
`prose-rule-ungraded` second, because it makes the catalog honest about which
rules are real, and a grader is what stops the next copy.

## What the prototype found (2026-09-27)

A scratchpad script: every string array of three or more names in `web/`,
`api/`, `tests/`, matched against the models in `db/schema.json`.

| App | Models | Files | Full restatement | Subset | Drift |
| --- | --- | --- | --- | --- | --- |
| `example` | 56 | 240 | 0 | 6 | 0 |
| `basecamp` | 50 | 225 | 1 | 10 | 0 |

`example`'s six are `only={[…]}` narrowing and two test fixtures — declared
residual. `basecamp`'s eleven are nine services restating the schema's write
policy by hand: an allow-list in `hub-config.service.ts` and the deny-list
argument of `narrowPatch()` at fifteen call sites. Filed as `FJS-1393`. The
comment beside each list — *kind, status, appId and the run bookkeeping belong
to the job* — is the schema attribute nobody wrote.

**What the prototype cannot see is the case that bites.** Its drift test fires
only when a listed name is not a field. A schema column ABSENT from an
allow-list — new column, stale list — is invisible to it. The real rule needs
to know which lists are allow-lists and compare both ways; a variable named
`WRITABLE`/`ALLOWED`, or the argument of a known narrower, is the heuristic.

## What this is not

Zero entropy is one file nobody can read. The goal is not the minimum number of
copies. It is that every copy is generated or graded, and every departure is
declared. `kernel-and-projections.md` is the structural half of the same
thought — surfaces as projections of the seed; this is the measuring half.

## The nine (answered before the edit, 2026-09-27)

1. Origin — the schema; a service's list is the second origin this removes.
2. Concept — no new noun in code; *entropy* names the metric only. Rule ids name what they grade.
3. Complexity — the lists are complexity the design added.
4. Predictability — one reader of the schema replaces fifteen lists that each teach nothing about the next.
5. Derived — from `@immutable`/`@system` and the boundary's readOnly set.
6. Owner — `db.$protectedFields()` (bridge index); the fix goes inside it.
7. Boundary — a caller no longer has to know which columns are bookkeeping.
8. Failure — `warn`, silenced by a declared reason; the omission it catches is silent.
9. Silence — must stay true: no hand list of writable columns outside the schema. What fails: `restated-fields`. Until it lands, **none**.

Adjudication: *doctrine vs. discovery* — basecamp discovered the need before the
schema said it; the hearing moves the fact into the schema. Tier: Assessment.

## See also

- `provable-enforcement.md` — the promise this metric makes checkable.
- `kernel-and-projections.md` — the structure that makes the count small.
- `ISSUES.md` `FJS-1393` — the first row the count produced.
