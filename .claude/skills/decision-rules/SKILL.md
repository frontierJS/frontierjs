---
name: decision-rules
description: Run FrontierJS doctrine against a design choice. Use when adding an option, flag or config key; coining a noun or concept; stating a second time something already stated once; choosing between two designs; deciding how strict a surface should be; when the code and a document disagree; or before writing a ruling into `DECISIONS.md` or a proposal into `IDEAS/`.
---

# Decision rules

**The doctrine is `PHILOSOPHY.md` and it is not repeated here.** Read § V (the nine questions), § IV (the seven standing adjudications) and § VII (which kind of document may hold the answer) before answering anything. A skill that restated them would be a second origin for the material that exists to forbid second origins.

What this carries is the half a document cannot: when to run it, and how hard.

## Run it

**Answer all nine of § V's questions out loud, one line each.** Not a summary of them, and not the subset that looks relevant — the two that decide most proposals are the two nobody reaches for on their own: *can this be derived instead of restated*, and *can this be wrong without anything saying so*.

**The ninth is TWO answers and one line hides that.** What must stay true, then what fails when it stops — a test, a snapshot, a CI phase, a refusal at the boundary. **`none` is a permitted answer** and it records the invariant as unenforced, which `invariants.snapshot.md` already carries as a `none` row; what is not permitted is an invariant stated with its artefact left implied, because from the outside that reads exactly like an enforced one.

**The owner question asks where the owner IS before it asks how many there are.** A second implementation beside an existing owner answers *exactly one owner* truthfully about itself and breaks Invariants 4 and 5 anyway. `bridge-index` is the list of the ones that already exist — read it before concluding that nothing owns this.

**Where two goods are in tension, name the adjudication in § IV rather than weighing them fresh.** Seven are already settled — preservation against evolution, ergonomics against strictness, the paved road against the workaround, batteries against smallness, familiarity against precision, coherence against convention, doctrine against discovery. Re-deriving one of those in the moment is how a settled question reopens.

**Reaching for a NEIGHBORING row is the failure mode, and it does not feel like one.** *Familiarity vs. precision* is about habits a developer brings in from the ecosystem and says so twice; it was cited to argue that an existing command name should survive, which is *preservation vs. evolution* — a different row with the opposite answer. Read the row you are naming before you lean on it.

**Name the adjudication, or write that none is in tension.** A silent skip and an honest none read identically from the outside, so the one that was skipped is the one nobody can find afterwards.

**Say which of § VII's four tiers holds the answer** — Guiding, Register, Map or Assessment. An answer with no tier is an opinion, and it reads as doctrine to the next person.

## What each one catches

The rows are § V's own order and the keyword is an index into it, not a second spelling of it. Use them to notice which question you skipped, not to answer in their place.

| § V | Catches |
| --- | --- |
| 1 origin | a second place the same truth can be written, so the two drift and neither is wrong on its own |
| 2 concept | a fourth noun for what three already cover — and a dependency is charged to the same budget |
| 3 complexity | complexity the design added, then attributed to the problem |
| 4 predictability | one thing behaving unlike its siblings, so knowing one teaches nothing about the next |
| 5 derived | a restatement maintained by hand, which is a stale copy from the first time its source moves |
| 6 owner | a second implementation beside the owner rather than inside it |
| 7 boundary | a caller that has to know what the far side does in order to use it correctly |
| 8 failure | a refusal where a warning was owed, or a warning where the mistake is destructive |
| 9 silence | a wrong answer nothing reports — the artefact is what turns it into a red |

## Done when

Every one of the nine is answered, the tier is named, and the proposal is in one of three states.

**The nine are answered BEFORE the first edit.** Answers written after the code is green are a defense rather than a decision — they pass by construction, because the thing they are grading is the thing that was already built. Answering late is allowed and is named as late, which is the only way the next reader can tell one from the other.

- **It passes.** Build it, and the answers are the commit message.
- **It fails one.** Change the proposal rather than the answer.
- **It fails one and should land anyway.** That is a ruling: the `FJS-D##` goes in `DECISIONS.md` naming the question it overrides, or the change does not land.

Where two proposals both pass, the tiebreak is six months out — the one that lets a developer predict more from less knowledge.

## When the code disagrees

§ IV's last adjudication is the one that gets skipped, because siding with the doctrine feels like rigor. **Hold a hearing instead**, then either fix the code or amend the doctrine, in writing. An undocumented divergence is the failure both directions share, and it is the one that survives.
