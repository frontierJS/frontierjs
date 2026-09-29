---
id: changes-retirement
status: proposed
dated: 2026-09-28
---

# Idea — Retire `CHANGES.md`: history is git, lessons go where they are read

**Status: PROPOSED. Nothing described here as the proposal exists.** Dated
2026-09-28. Do not cite this file as behavior — see `VERIFYING.md`. The numbers
were measured on 2026-09-26 and are true for that afternoon.

---

## The claim

**A per-package change log is a copy of git with the reasons braided into it,
and the reasons are the only part nothing else holds.** Pre-alpha there is no
consumer reading it as release notes (`CLAUDE.md` § Evolution policy), so the log
half is paid for and never spent. The lesson half is real and is filed where an
agent does not look: an agent working on a `$:` watch loads `ui-hazards`, not
`packages/mesa/CHANGES.md`.

So: extract the lessons into the homes that already exist for them, then delete
the files.

## What is there

Measured 2026-09-26: **23 files, 1,802 `## ` entries, 3.4 MB**, all written
since 2026-07-25 — litestone 838 KB, cli 533 KB, junction 435 KB, basecamp and
mesa 309 KB each. Entries arrive at 20–70 a day.

**The growth is the gate, not the work.** `fli done`'s `changes-entry` check
(`packages/cli/core/done.js`, `changesEntries`) fails any package touched without
a new `## ` heading, so every change writes one. Commit messages meanwhile read
*updates* and *cli optimizing* — `CHANGES.md` became the commit body.

A typical entry is a median 1.6 KB and mixes five things:

| Content | How common | Already owned by |
| --- | --- | --- |
| What changed, file by file | nearly every entry | git diff |
| Test counts (*1306 tests, 0 fail*) | 509 entries | nothing — stale on the next commit, and § VII forbids an ungenerated number |
| The defect narrative | 1,091 cite an `FJS-###` | its `ISSUES.md` row |
| The design argument | 461 cite an `FJS-D##` | `DECISIONS.md` |
| **A lesson — behavior that is correct and surprising, or a mistake not to repeat** | ≤ 623 match a lesson vocabulary (*silent*, *no error*, *stale*, *trap* …) — an over-count | **often nothing else** |

The last row is the reason this is not a one-line `git rm`. Sampled example:
`packages/mesa/CHANGES.md` § *`$:` on a value with no depth is refused* (`FJS-505`)
records that a bare `$: n` on a primitive compiles to a snapshot — right value,
stale screen, no error. It is not in `ui-hazards`, and the `ISSUES.md` row does
not carry the mechanism.

## Where each kind of content goes

| Kind | Home | Form |
| --- | --- | --- |
| Surprising behavior still true of the code | the realm's hazard skill (`data-hazards` / `api-hazards` / `ui-hazards`) | one index line in `SKILL.md` + its paragraph in `references/` (`doc-hygiene` § The ladder) |
| Why the code is shaped this way | the package's `docs/internals.md` (junction and litestone have one; others get one only when an entry needs it) | a paragraph under the module it explains |
| A ruling nobody recorded | `DECISIONS.md` | an `FJS-D##`, dated, citing the entry's commit |
| A repo-wide working mistake (process, not code) | the owning skill, or `CLAUDE.md` § Live hazards → Repo | one line |
| Everything else | git | nothing — dropped |

**A lesson that is no longer true of the code is dropped, not moved.** The
extraction reads the current source before it files anything; a hazard skill line
is obeyed whether or not it is still true.

## The plan

1. **Ruling.** An `FJS-D##` in `DECISIONS.md`: `CHANGES.md` is retired; history is
   git. It amends in the same commit:
   - **Invariant 17** — three standard files at a package root (`README.md`,
     `CLAUDE.md`, `PROJECT_STATE.md`), `AGENTS.md` still a permitted fourth.
   - **`PHILOSOPHY.md` § VII** — the Register tier is `DECISIONS.md` and
     `ISSUES.md`; the sentence *history lives here and nowhere else* points at git.
   - **`CLAUDE.md`** — *History belongs in `packages/*/CHANGES.md`* becomes *history
     is git*; § Packages' *History is its `CHANGES.md`* line goes.
   - **`FJS-D163`** keeps `frontierjs-vscode/CHANGELOG.md` — that file is for the
     marketplace, a real consumer, and is out of scope here.
2. **Extraction, one package at a time.** Pilot on caravan (39 entries), then the
   small packages, then the six large ones. Per entry: classify by the table
   above, check the lesson against current source, file it, move on. The package's
   `CHANGES.md` is deleted in the same commit that files its lessons, so a
   half-extracted file never sits beside its extracts.
3. **Tooling moves with the doc.** Each reader of `CHANGES.md`:
   - `packages/cli/core/done.js` — `changesEntries` and its tests in
     `test/done.test.js` (see open question 1)
   - `packages/cli/core/checks.js` — `package-root-md`'s `STANDARD` list and its
     message; `test/checks.test.js`'s *CHANGES.md is missing* cases
   - `packages/cli/core/doc-audit.js` — the `HISTORY` pattern
   - `packages/cli/core/doc-commands.js` — the reference-doc exclusion
   - `packages/cli/core/git-status.js` — the `RECORDS` set
   - `scripts/fix-loop.mjs` — the `close` classifier's `CHANGES\.md` match
   - `packages/cli/test/proofs.test.js`, `doc-audit.test.js`,
     `git-status.test.js` — fixtures that name the file
4. **Inbound links.** About 80 citations of `CHANGES.md` outside the files
   themselves — `IDEAS/ontology.md` (17), `ISSUES.md` (15), `DECISIONS.md` (6),
   the rest in IDEAS, `PROJECT_STATE.md` files, READMEs and `DRIVES.md`. Each is
   repointed at the `FJS` id, the extracted lesson, or a commit — or dropped.
   `rg 'CHANGES\.md' -g '*.md'` returning only `frontierjs-vscode` and
   `docs/handoff-archive/` is the done signal; the archive is history and keeps
   its dead links.
5. **Code comments.** `packages/caravan/test/scale.test.ts` and
   `packages/mesa/test/inert-block.test.js` point readers at `CHANGES.md` for a
   reason; the reason moves into the comment or into `docs/internals.md`.

## Cost

Reading every entry is about 850k tokens. Reading only the lesson-signal entries
is roughly a third of that, at the risk of missing lessons phrased without the
vocabulary. The large packages run as one agent each, one area at a time
(the fan-out cap in memory), Opus throughout.

**The cheap alternative is deletion alone**: every entry stays in `git log -p`.
It is rejected because git is where an agent does not look either — the loss is
the lessons' reach, which is the same loss that motivates the move.

## The nine (`decision-rules`)

1. **Origin** — removes one: the log restated git, `ISSUES.md` and `DECISIONS.md`.
2. **Concept** — removes a document kind; no new noun, every destination exists.
3. **Complexity** — the volume was added by the `changes-entry` gate, not owed
   by the problem.
4. **Predictability** — one fewer place a fact might be; each remaining home
   answers one question.
5. **Derived** — the log is derivable from git and the test counts from running
   the suite; the lessons are not, which is why they are extracted rather than
   dropped.
6. **Owner** — git, the hazard skills, `docs/internals.md`, `DECISIONS.md`: all
   existing owners.
7. **Boundary** — `fli done` is where a change is graded finished; what it asks
   instead is open question 1.
8. **Failure** — deletion is reversible from git, so nothing needs a refusal; the
   irreversible-in-practice loss is lesson reach, answered by extracting first.
9. **Silence** — must stay true: no `CHANGES.md` returns at a package root →
   `package-root-md` warns on it as an unknown sixth file once `STANDARD` drops it.
   Must stay true: no live lesson is dropped in extraction → **`none`**; the only
   guard is the per-entry pass, and a dropped lesson reads identically to a
   correctly dropped log line.

**Adjudication:** *preservation vs. evolution* — nobody depends on these files,
so the file kind goes rather than being slimmed. *Coherence vs. convention*
(*write it down or lose it*) is the tension the extraction answers: the lessons
stay written, in the place they are read.

**Tier:** an Assessment now; lands as a Register ruling amending an Invariant and
§ VII.

## Open questions for the owner

1. **What `fli done` asks instead.** **A** — nothing; the diff is the record.
   **B** — a non-empty commit body per package touched. **Recommend A** — B grades
   a commit that `fli done` runs before, and a body written to satisfy a gate is
   the same padding this retires.
2. **A lesson with no hazard-skill realm** — a cli, css or toolbelt trap.
   **Recommend** the package's own `CLAUDE.md`, which loads on first read of the
   package — the same reach a realm skill buys.
3. **`IDEAS/release-notes.md`** names `CHANGES.md` as the developer changelog
   half. It becomes git plus `fli changelog`, which already writes one from
   commits — the file's claim is amended, not its proposal.
4. **`ISSUES.md` (2 MB) and `DECISIONS.md` (1 MB)** carry long narratives on
   closed rows — the same disease. Out of scope here; a separate pass after this
   one proves the extraction method.
