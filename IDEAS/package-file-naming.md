---
id: package-file-naming
status: proposed
dated: 2026-10-08
---

# Idea — How a package names its own files, graded for the reader that cannot ask

**Status: PROPOSED.** Dated 2026-10-08; every count below was measured on the working
tree that day. Nothing here is built and nothing is ruled. It is about the files
INSIDE `packages/*`, never the files an app developer writes — those are already
ruled (`FJS-D40`, `FJS-D112`, `FJS-D626`) and the rule there is the one proposed
here, applied inward.

## The question this answers

*What does a filename have to do when its most frequent reader is an agent?*

An agent locates a file before it edits one, and it locates by name: a path in a
listing, a hit from `rg`, a line in a `CLAUDE.md` layout map, a summary left
behind when its context is compacted. A person who cannot tell which `index.ts`
they meant asks the colleague beside them. An agent cannot ask, so it guesses, and
the guess is where edits land in the wrong file. Localization, finding the file
before changing it, is the step that dominates the failure count when agents are
measured on real repositories (Agentless, Xia et al. 2024, separates it from repair
and finds it the larger error source). A name that predicts its file attacks that
step directly.

The repo already compensates in two places: every non-trivial file opens with a
header block (`.claude/rules/code-style.md`), and every package `CLAUDE.md` carries
a layout map that `fli done` checks for. Those are the right instruments. This idea
is about what they are compensating FOR.

## What the tree looks like

| Fact | Count |
| --- | --- |
| Files named `index.*` across packages | 61 |
| Of those, holding more than 300 lines of real code | 23 |
| Largest, `junction/src/client/index.ts` | 3,009 lines |
| Largest source file, `litestone/src/core/client.js` | 11,811 lines |
| Source files in the four spine packages with no header comment | 9 of 272 |
| Files in `litestone/src/core/` · `junction/src/core/` | 33 · 30 |

Near-duplicate names inside one package, where the wrong pick is one inflection
away: `core/migrate.js` beside `core/migrations.js`; `testing.js` beside
`testdb.js`; `core/client.js` beside `browser/client.js`; two `smtp.ts` and two
`sender.ts` in junction; `core/hooks.ts` beside `plugins/email/hook.ts`.

Role is stated two ways: sierra writes `build/mesa-plugin.js` (suffix), litestone
writes `plugins/gate.js` (folder). The app surface already chose the suffix
(`*.service.ts`, `*.job.ts`, `*.notification.ts`, `*.mount.js`) and `FJS-D626`
says why: a loader finds a file by its kind wherever the file sits.

## The five changes

1. **An index file is a barrel.** `index.*` re-exports and does nothing else; a
   non-export statement in one fails `fli check`. The code it held moves to a file
   named for what it is (`client/junction-client.ts`). A path that ends in `index`
   carries zero signal in a listing, a grep or a compaction summary, and 61 files
   share the name. Rust's 2018 edition retired `foo/mod.rs` for `foo.rs` on exactly
   this complaint; Python's `__init__.py` carries the same scar.
2. **No two files in a package differ only by inflection.** Stem the names
   (`migrate` / `migrations` → `migrat`) and fail a collision. Cheap rule; every pair
   above is a wrong edit waiting. Prior art: Zeitwerk, where a filename IS the
   constant and is unique per load path; Java's one public class per file.
3. **Role is a suffix inside a package, as it already is in an app.** `*-plugin.js`,
   not `plugins/*.js`. `rg --files -g '*-plugin.*'` then lists every plugin in the
   workspace, and the role survives into any path listing. Angular's style guide
   wrote this as LIFT, *Identify: name the file so you instantly know what it
   contains*; it was for IDE tabs and fits an agent better than it ever fit a tab.
4. **A file-size baseline that ratchets down**, the Invariant 14 shape: one number
   per package in `scripts/`, absent means the cap, an improvement written back.
   `Read` shows 2,000 lines; the 11,811-line client takes six reads to see and an
   `Edit` in it needs an `old_string` unique across all of them, so the agent pads
   context, misses and retries. Splitting is where size and naming meet: the
   pieces get names.
5. **The layout map is generated from the header block.** Today a file's purpose
   is stated twice, once in its first comment and once in the `CLAUDE.md` layout
   line that `fli done` checks for, and the repo's own one-owner rule says that is
   one too many. Make the first comment line canonical (`// client.js — the SQLite
   client; ...`), let `fli ws:atlas` emit `layout.snapshot.md` per package, and let
   the `snapshots` phase fail a stale one. Go's `// Package foo`, Rust's `//!` and
   Python's module docstring are the same move.

A smaller sixth: `core/` is where everything goes, and the word tells a reader
nothing. Rails puts the role on the directory and the noun on the file
(`app/models/lead.rb`); here both axes exist and `core/` uses neither.

## Not worth changing

Tests named by feature rather than by source file. An agent searches by concept,
and `fli proves` already maps a change to the drive that proves it. Mirror naming
would buy little and cost 187 renames in litestone alone.

## Prior art, agent-specific

- **Agentless** (Xia et al. 2024): localize-then-repair on SWE-bench; localization
  errors dominate. The whole idea is a localization aid.
- **Aider's repo map**: tree-sitter symbols per file ranked by PageRank. The map is
  only legible when files are small and named for their content.
- **RepoCoder** and repository-level completion: the file path is a retrieval
  signal. A path ending in `index.ts` is an empty one.
- **Convention over configuration** was always *the name predicts the location*. A
  person could always fall back to asking. The payoff was never as large for a
  human as it is for a reader that cannot.

## Doctrine check

Answered 2026-10-08, after the proposal was written and before anything is built;
late by the skill's own definition, and named as late.

- **Origin.** 1–4 add none. 5 removes one: a file's purpose is written in its header
  and again in the `CLAUDE.md` layout line, and only the header survives.
- **Concept budget.** No new noun. *Barrel* is the ecosystem's word for a re-export
  file and is used as such; the inflection rule is a check, not a concept.
- **Complexity.** The problem's. Localization has a name and a measurement in the
  field (Agentless), and every change here is a localization aid.
- **Predictability.** Up: a package's files follow the rule an app's already do
  (`FJS-D626`), so knowing one surface teaches the other. Picking the suffix means
  the folder form (`plugins/gate.js`) goes, one rule rather than two.
- **Derived.** 5 is the derivation. The size number is measured, never stated.
- **Owner.** `fli check` owns an arch rule (`FJS-D133`) and `fli done` already
  carries `layout-named`; 5 moves that check behind a generator rather than adding
  one beside it. **`FJS-D133` grades only a claim with an authority in the tree, so
  1–3 need one stated line**, in root `CLAUDE.md` § House style, before a rule can
  grade it. That line is the first edit.
- **Boundary.** A `fli check` rule is named and tested; the baseline is a file in
  `scripts/`. The header grammar is the boundary 5 depends on and must be written:
  `// <basename> — <one line, what it is and what it is for>`, first non-blank
  line, and a file without one is a `fli check` row, not a silent blank in the map.
- **Failure mode.** A barrel violation, an inflection pair and a size regression are
  errors, not warnings: the cost is a silent wrong edit and the remedy is a rename,
  which is cheap. The size rule ratchets like Invariant 14, so it never fails a file
  that was already that large.
- **Silence.** Today, yes, which is the point. Artefacts: three `fli check` rows, a
  `layout.snapshot.md` per package failed stale by the `snapshots` phase, and a
  baseline file whose number moves one way.

**Adjudications in tension.** *Preservation vs. evolution*: every rename here is a
rename, nothing is shipped, no alias. *Familiarity vs. precision*: the ecosystem
habit is `index.ts` holding code; the proposal keeps the familiar file and refuses
the half-fit use of it. *Coherence vs. convention*: the rule is unwritten today and
`FJS-D133` says an unwritten rule cannot be graded, which is the same finding.

**Tier.** Assessment, this file. The five become Register entries when ruled; the
authority line is Map.

## What to do with it

Rule the five as a set, write the authority line, then build 1, 2 and 4 as `fli check`
rules with 5 as the generator behind the layout map. 3 and the sixth are renames
and wait on the ruling.
