---
id: mental-model-load
status: assessment
dated: 2026-09-27
---

# Idea — mental-model load: where it lands, and that it lands differently on an agent

**Status: ASSESSMENT. Nothing here is a plan.** Dated 2026-09-27. The counts
are read off the tree that day and are leads, not facts. Nothing is built and
nothing is enforced — see `VERIFYING.md`.

**Why this is not `one-mental-model.md`.** That file asks where a CONCEPT repeats
in the code (three frontmatter parsers, two `ctx`). This one asks where the model
is heaviest to HOLD for the reader, and finds the answer depends on which reader.
`controlled-language.md` is the adjacent idea for the spelling half.

---

## The finding, in one line

The three nouns are cheap. The weight is in the seams, in one overloaded
character, and in enforcement declared in one place and read in four — and a
human and an agent are crushed by different ones of these.

## Where the load is highest

1. **The seam catalog.** The bridge index is roughly eighty named handoffs. Each
   is simple alone; together they ARE the model, and the recurring question
   *is there an owner for this already* is answered by a list and not by a
   principle a reader can derive from. The list is correct and it is a tax.
2. **The `$` character.** Transport directives (`$limit`), Junction's ambient
   call (`$`), the client seams (`$setAuth`, `$tapEvents`), the accessor checks
   (`db.$checkWhere`), the cursor (`$after`), the form context (`$context.form`).
   One glyph, five or six meanings. Invariant 10 exists because two of them were
   already confused once.
3. **Declared here, enforced there, hinted elsewhere.** Access is declared in the
   schema, enforced at the Data boundary, echoed to the UI as `x-gate` (a hint),
   redacted in the audit trail, reused by MCP as the permission model. One idea
   on four surfaces; the reader must know which surface is authoritative. The
   design is right; it is still the heaviest thing to hold.

Runner-up: the doctrine layer itself — Invariants, `DECISIONS.md`, `ISSUES.md`,
`IDEAS/`, nine skills, `VOCABULARY.md`, `PHILOSOPHY.md`, `ARCHITECT.md`. Correct
for pre-alpha and a second system to learn beside the framework.

## Human and agent: nearly inverted

| Load | Human | Agent |
| --- | --- | --- |
| ~80 bridge names | high — cannot memorize | low — grep or load the skill |
| Doctrine corpus | high once, then amortized | medium, re-paid every session |
| `$` overload | medium — learns by burn | high — pattern-matches the glyph, confuses meanings silently |
| *Where is the owner* | learns by osmosis | fails by default: builds a second owner beside the first |
| Three-noun model | low | low |
| Spelling conventions (case, no semicolons, `test/` vs `tests/`) | low after week one | recurring, each session starts at zero |

A human pays once and amortizes, so BREADTH is expensive and AMBIGUITY is
survivable — they ask. An agent reads fast and forgets everything, so breadth is
cheap and ambiguity is expensive — it does not ask, it picks, with confidence.

So the peak differs:

- **Human:** the seam catalog. Too many names to hold.
- **Agent:** anywhere two spellings mean one thing or one spelling means two —
  `$`, `provide` vs `claim`, `test/` vs `tests/`, `.test` vs `.spec`. Each is a
  coin flip the agent gets wrong without noticing.

## What follows, if anything

The tree already optimizes for the agent's cheap side: skills fire per realm,
`CLAUDE.md` is a map, snapshots grade drift. It does not yet cut the ambiguity
class — it documents it. Invariant 10 documents the `$` overload; a rename would
remove it, and the evolution policy says a rename is free pre-alpha.

That is the cheapest reduction left, and it helps the agent more than the human.
The adjudication in tension is § IV *doctrine vs. discovery*: this file is
discovery from one session's reading and claims nothing until a rename is
proposed on its own, through `decision-rules`, with the callers moved.

Enforcement: **none.** An assessment has nothing to keep true.

## See also

- `one-mental-model.md` — the same goal from the code's side
- `controlled-language.md` — one spelling per thing
- `entropy.md` · `process-entropy.md` — the restatement count, and why a session re-derives this
- `CLAUDE.md` Invariant 10 — the `$` ruling as it stands
