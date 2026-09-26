---
name: fix-next
description: Take the top open row from `fli next` (or a named id, or `--pkg <name>`) and carry it from re-probe to closed. Use when asked to fix the next issue.
disable-model-invocation: true
---

# Fix next

The loop from *what is open* to *closed with proof*, run without a person copying a row in. Arguments: none (top row), an `FJS-###` (that row), or `--pkg <name>` (top row of that package).

## 1. Pick

`fli next --json --limit 5`, with `--pkg` forwarded. Take the first entry of `ready` unless an id was named. **Say the id and its title before doing anything else**, so a person watching can redirect before the work starts.

Skip a row another session is plainly working on — its files dirty in `git status` and not yours — and end with status `busy`. Two sessions picking the same top row is the likeliest collision here. **When the arguments say an earlier attempt left those edits, they are yours**: read `git diff` and build on them.

## 2. Brief

**The context this row needs is read by one `Explore` subagent, never in this session.** A package `CLAUDE.md` runs to 160 KB and a hazards skill to 55 KB, and a row needs a few paragraphs of either; read whole here, they cost 70–90k tokens before the first edit. Hand the agent the id, the `ISSUES.md` line and the packages, and ask for a brief of at most 60 lines holding exactly:

- **The row**, verbatim.
- **Rulings and rows it cites** — each `FJS-D###` from `DECISIONS.md` and `FJS-###` from `ISSUES.md` or `ISSUES_ARCHIVE.md`, one line each on what it settles for this fix. A ruling the row leans on is usually where the fix's shape already lives.
- **Hazards that apply** — the matching paragraphs of the realm skill for each package (`.claude/skills/{data,api,ui}-hazards/SKILL.md`, and `bridge-index` if the row crosses a package), found by grepping for the row's files, functions and attributes, quoted in the shortest form that keeps the rule.
- **Where the code is** — `file:line` for the functions involved, and the owner the package's `CLAUDE.md` names for that concern.
- **Whether it still reproduces** — what the agent saw reading the current code, stated as *still present*, *looks fixed* or *unclear*, with the lines that decide it.
- **A red test** — which test file it belongs in, the nearest existing test to copy the setup from, and the assertion that fails today.

**When the arguments carry a `## Pre-brief`** (`fix:loop` builds one by script), the row, what it cites, where its identifiers are and the tests naming them are already found. Hand the pre-brief to the agent and ask only for the hazards, whether it reproduces and the red test.

Read a file here only when the brief points at it and the edit needs it.

## 3. Re-probe

**Reproduce the defect before fixing it.** The register drifts toward closed faster than its rows do — a row can be fixed in the tree, or describe a neighboring bug. Write the brief's red test and run it. If it will not go red, stop: the row is wrong or already fixed, and the answer is `fli close <id> --how "<what the probe showed>"` or a corrected row, not a fix.

## 4. Stop for a ruling

If the fix adds an option, coins a noun, or picks between two designs, run `decision-rules`. **Where it leaves a genuine choice, stop and put the options to the user** — the session's job ends at the question, since a ruling made mid-fix is graded by the code already written.

## 5. Fix and prove

Fix at the owner (Invariant 4). Run the package's own `test` script from its directory, piped through `tail -40`; read further only when the tail shows a failure. Stub the fix once and watch the new test go red, then restore it. Then **`fli prove`**, one call: it runs every drive `fli proves` names, starting what each needs first and stopping it after, and prints one line per drive with a tail for a failure. It refuses a server port that already answers — report that, rather than starting servers by hand around it. A drive that cannot start is reported, not skipped silently.

**A drive that fails is asked whether it failed before the change, and HEAD is read in a worktree, never written over this one.** Search `ISSUES.md` for the failure first — it is usually filed. If a baseline run is still needed, `git worktree add` a HEAD checkout outside the repo and run it there. Copying HEAD's bytes over your files for the length of a drive loses the fix if the run is killed, and shows another session sharing this tree code it did not write.

## 6. Record and close

A `CHANGES.md` entry per package touched — a `## ` heading, then prose. Then the register, by command and never by editing `ISSUES.md`:

```
fli close FJS-### --how "<the cause, the fix, and the test or drive that proves it>"
fli file --sev S3 --area <pkg> --title "<the defect, one sentence>" --detail "<how it was measured · [file](path)>"
```

The How column is the closed row's whole explanation, in the register's own prose voice. `fli file` is for what the fix found and did not fix; it takes the next id and tops that severity's table. Finish with `fli done` and clear what it lists.

## 7. Report

The id, the cause in one sentence, what proves it, and anything found along the way filed as its own `FJS-###` (`fli file`) rather than folded in. **The last line of the report is exactly `fix-next: <id> <status>`**, status one of `closed`, `ruling` (stopped at step 4), `corrected` (step 3 found the row wrong and rewrote it), `busy` (step 1 found another session on it) or `failed`. `scripts/fix-loop.mjs` reads it: `failed` is retried at higher effort, `busy` is skipped, `ruling` ends the loop.

Then end the session. **One row per session**: a second row in the same context carries every file the first one read. A batch is `bun run fix:loop`, which gives each row a fresh session.
