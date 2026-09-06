---
name: doc-hygiene
description: How to write and prune a document an agent reads — a root or package `CLAUDE.md`, a `SKILL.md`, or anything reached by a pointer. Use when adding to one, when deciding whether material belongs inline or behind a pointer, or when a document has grown and needs cutting.
---

# Doc hygiene

Every document here is read by an agent before it is read by a person, and the two want opposite things. This is the method for deciding what a document carries, where it sits, and what comes out of it. The vocabulary is adapted from Matt Pocock's `writing-for-agents` ([mattpocock/skills](https://github.com/mattpocock/skills)); the numbers were measured here.

## The two loads

Every document and every pointer spends one of two budgets, and naming which one is what makes the trade decidable.

**Context load is always-loaded material** — the root `CLAUDE.md`, a skill's `description`, anything in the window every turn — and it is spent whether or not it fires. **Cognitive load is the cost on a person**: which documents exist, and when to reach for each. That second one is not a cost to minimize. It is the price of human agency, so spend it where judgment matters and remove it where it does not.

Material behind a pointer escapes context load and pays the pointer's own line instead. **A skill is still a document**: `.claude/skills` is in `doc-audit`'s corpus, so a path, an id or an Invariant it cites is graded like one cited anywhere else, and `fli check`'s `skill-pointer` resolves every skill name the root `CLAUDE.md` gives to a `SKILL.md` whose frontmatter agrees. Material with no pointer at all rides entirely on cognitive load, which is how a document nobody remembers quietly stops being true.

**Measured: the root `CLAUDE.md` was 254 KB**, about 63k tokens on every turn of every session. § Live hazards and § Bridge index were 57% of it and neither is read by anything but a person; both are skills now and the file is 119 KB.

## The ladder

Three rungs, ranked by how immediately the agent needs the material.

1. **In-file step** — what to do, in order.
2. **In-file reference** — consulted on demand. A flat peer set of rules is a fine arrangement, not a smell.
3. **Disclosed reference** — its own file behind a pointer, loaded only when the pointer fires.

**What decides the rung is branching, not size.** Inline what every branch needs; disclose what only some branches reach. A `@@softDelete` trap costs nothing on a turn spent in sierra and everything on the turn it is needed, which is why the hazards split by realm rather than by weight.

**The pointer's wording decides whether the material is reached; its target does not.** A must-have document behind a weakly worded pointer is a variance bug — sharpen the wording first, and inline the material only if sharpening fails. Front-load the word that does the triggering, give one trigger per genuinely distinct branch, and cut the identity the body already carries.

Where the ladder decides how far down a piece sits, **co-location decides what sits beside it** once there: a term's definition, its rules and its caveats under one heading, so reading one part brings its neighbors with it.

## What cannot move

**A section a program parses is a source of truth and stays where the parser looks.** Six modules read the root `CLAUDE.md` by path — `preflight.js` the drives table's *Start first* column, `invariants.js` the numbered list, `repo-map.js` and `repo-atlas.js` the package table, `checks.js` the proof rows (through `proofs.js`), `doc-audit.js` the invariant count. Moving one of those is editing a parser, and doing it by accident is a green build over a table nothing reads any more.

That is also the case the cache rule below gets wrong on first look. The drives table restates 31 `verify:*` scripts that are already in `example/package.json`, so it reads as a copy of the environment. It is not one: `preflight.js` parses the column beside them, and there is nowhere else that column lives.

## The four cuts

- **The delete test**, which `PHILOSOPHY.md` § VII states for a document sentence and House style states again for a code comment: if it vanished, could someone acting on this file make a mistake it would have prevented? For a document an agent reads there is a sharper form of the same question — does this change behavior against the model's default? A line the model already obeys pays load to say nothing. That form is model-relative rather than reader-relative, so two people disagreeing about it disagree about the default and settle it by running the document rather than by arguing. When a sentence fails, delete the whole sentence rather than trim words out of it.
- **Cache.** The environment is a source of truth too — `package.json` scripts, a config file, `--help` output — and a document that restates a one-command lookup is a copy that goes stale with nothing failing. Cache what cannot be found by looking: the unwritten convention, the reason behind a choice, the gotcha no config confesses.
- **Negation.** Steering by prohibition drags the forbidden behavior into context and makes it more available, not less; the ban half-reads as an instruction to do the thing. State the target behavior instead, so the banned one is never spoken. A prohibition earns its place only as a guardrail that cannot be phrased positively, and then it is paired with the positive.
- **Sprawl.** A document simply too long, with every line live and unique. Attention thins across the excess, and every extra line is one more to keep true. The cure is the ladder rather than the blue pencil.

**A restatement made at three sites is a word waiting to be coined.** This repo already does that well — *drive*, *realm*, *seam*, *pivot*, *residue*, *ladder* each carry a paragraph in one token — so the work is hunting the passages that have not collapsed yet, not adding vocabulary. A word too weak to beat the default is itself a no-op, and the fix is a stronger word rather than a different technique.
