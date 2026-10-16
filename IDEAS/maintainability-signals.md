---
id: maintainability-signals
status: proposed
dated: 2026-10-16
---

# Idea — Maintainability signals: the register and the loop log read as a map of where the code hurts

**Status: PROPOSED.** Dated 2026-10-16. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`. Every noun below is
provisional until `decision-rules` has run on it; the open questions are at the
end and a ruling cites one by its `Q` number.

**Trigger.** `FJS-D1118` gave a register row a way to say its fix is the
environment (`env: <cause>`), and `FJS-3019` is the first row that uses the
count — ten `env: timing` rows, never given a quiet run. The same move applies
further: the register and `~/.fli/fix-loop.jsonl` already hold the data that
says which package is expensive to change, which seam collects bugs, which
file every lane collides on, and which diagnosis has been wrong twice. None of
it is read back. This paper is the list of reads, cheapest first, and the two
structural changes that stop two `env:` causes being filed at all.

---

## The claim

**A pain point is a count, and every count here is already written.** The loop
log carries row, outcome, cost, turns and phases per attempt
(`scripts/fix-loop.mjs` `appendLog`); the register carries each row's area
(its package), severity,
`env:` cause and `blocked by`; `fli check` carries which invariant each rule
grades. What is missing is the read, and in two cases a segment vocabulary the
read can count.

**What exists and is not this.** `scripts/loop-review.mjs` reads the
TRANSCRIPTS behind the last N attempts for repeated detours — files every
session reads, calls that fail the same way. It answers *what does a session
waste a turn on*; this paper answers *where in the tree does the money go*.
`seam-owner` and `seam-listed` grade the Bridge index against the tree; nothing
grades a register row against the Bridge index. `test-port-literal`,
`drive-opens-chrome` and `drive-preamble` grade a drive's port and preamble;
nothing refuses two drives on one port at once.

---

## Phases

### Phase 0 — Measure what the log already says

Goal: one report over `fix-loop.jsonl`, before any new field is written.
Done when: `bun run loop:review` prints the three tables below from the current log, above the transcript section it already prints.

- [x] 0.1 A § Cost section in `scripts/loop-review.mjs` — it is the one reader of the log, and a second script beside it is the second owner Invariant 4 forbids. Cost per CLOSED row by package (closed count, attempts, spend, spend ÷ closed), sorted by spend ÷ closed. A package high on this table is one hard to change, whatever its rows say. Built over the whole log, not the last N; the log names no package, so it is the register's — which read every closed row's package as its title until `FJS-3112`.
- [x] 0.2 Same section: sent-back rows by package, a column in the cost table, and the files `busy` rows collided on. `sentBack` moved from `fix-loop.mjs` into `headless.mjs`, so the loop and the review count one definition. `dirty` is every changed file under the row's packages rather than the file that collided, so one wide edit ties every file in it; the collision is the dirty file the session's transcript names, since the log keeps only a report's last 500 characters. A file more than one row collided on is a split candidate — the number `FJS-1157` (×3) was paid to learn by hand.
- [x] 0.3 Read the three tables once and write what they say into this file as a **Done** paragraph. If they say nothing, the rest of the paper waits.

**Done 2026-10-16.** Read over 1101 attempts. The tables say less than the
paper assumed, and two of the three readings point somewhere else.

- **Cost is flat.** $810.60 over 837 closed rows is $0.97 a row. A closed
  attempt costs $0.59 at the median and $1.65 at p90. The packages with 20 or
  more closed rows run from $0.78 (toolbelt) to $1.38 (basecamp), less than
  2×. No package stands out as hard to change. outpost tops the table at $2.17,
  but on only 8 rows.
- **Sent back is mostly an owner's wait, not a wrong diagnosis.** 15 rows (18
  in the table, since a row naming two packages counts in both). 8 of the 15
  later closed. 5 were `blocked` on every attempt, which means a ruling was
  owed, and `blocked by` already names it. Step 1.1's bar, two verdicts of any
  kind, would have marked all 15 `contested`, including 8 the loop then fixed.
  Only 5 rows were failed or corrected twice, and 4 of those closed later.
- **A collision is one change filed as several rows, not a file to split.**
  22 attempts were busy (2%), and 14 of them name a dirty file. The ten files
  in the list come from five collisions, because a pair that collides drags in
  every file it shares. Each colliding set is one job: `basecamp/api/src/core/hooks.ts`
  (3 rows: `FJS-2353`, `FJS-2356`, `FJS-2856`) is the move of role hooks into
  `@@gate` (Invariant 6). litestone `retention.js` (`FJS-2285`, `FJS-2290`) is
  retention, and conduit's three files (`FJS-710`, `FJS-1014`) are its error
  taxonomy. Splitting the file would not separate them. What they need is one
  row that the others hang under, and the register has no structured way to
  say that today; "under FJS-###" appears only as prose.

So Phase 0 does not justify Phase 1 as written, and it does not reach
Phases 2–6, which rest on their own evidence (`FJS-3019`'s ten `env: timing`
rows, the `env: port` and `env: shared db` rows Phase 5 names). The gate above holds:
the owner ruled 2026-10-16: Phase 1 is cut, and Phase 2 goes next. A collision
set is several rows that are one change, and rows grouped by seam (2.3) is the
nearest count the paper has for that. Retention is no Bridge index seam, so 2.3
catches the role-hook and conduit sets and not that one.

### Phase 1 — Write the loop's verdicts back into the register

**Cut 2026-10-16** by the Phase 0 reading. `fix-loop` already stops picking a row after two verdicts, and 8 of the 15 rows that bar caught closed later.

Goal: a row the loop gave up on says so where a person reads.
Done when: `fli next` shows the mark, and `fix:loop` dodges by the row rather than by re-reading the log.

- [ ] ~~1.1 After the second non-closing verdict (`sentBack` already counts two), `fix:loop` sets the row's status to `contested` with a note naming the verdicts — the same word the conventions give a doubted diagnosis, applied from the other side. Today the knowledge dies in `.cache` and the next `fli next` ranks the row as if nobody had looked.~~ cut
- [ ] ~~1.2 `fli next` prints the attempt count beside a `contested` row, so the reader sees two failed sessions and re-diagnoses rather than spending a third.~~ cut

### Phase 2 — A seam segment

Goal: the Bridge index as a scoreboard.
Done when: `fli next --by seam` groups rows, and `register:check` refuses a seam the key list does not name.

- [x] 2.1 Run `decision-rules` on the segment (Q1, ruled `FJS-D1135`). It is `env:`'s sibling: `seam: <name>`, its own ` · `-joined segment, name from the root `CLAUDE.md` § Bridge index key list, which `seam-listed` already parses. `env:` says where the FIX lives; `seam:` says which handoff the bug crosses.
- [x] 2.2 `seamOf` beside `envCause` in `cli/core/next.js`; a `seam-name` rule in `register-check.js` (error, name outside the key list) mirroring `env-cause`. Matched by `identifierOf`, the way `seam-listed` matches, so `seam: $setAuth` and `seam: $setAuth(user)` are one seam; a root with no § Bridge index refuses every name.
- [x] 2.3 `fli next --by seam`: rows grouped by segment, count first. Eight rows on one seam is a design wrong there, not eight bugs, and it is the number that decides whether a seam gets a paper.
- [x] 2.4 Backfill: the open rows whose title names a Bridge index owner get the segment. Done by one pass, not by rule — a row's seam is written by hand like its cause. `fli next --by seam` is the count. A title that names an owner as a WORKAROUND (*needs `asSystem()`*) or as a plain word (*principal*, *options*) got none. The pass found `FJS-3139`: `*.mount.js` puts `js` in the key list, so any file name passes `seam-name`.

### Phase 3 — An env row carries its proof

Goal: `env: timing` is a measurement, not a guess.
Done when: every `env: timing` row has a `repro:` segment written by the tool, or has lost the tag. `repro:` is already written free in six rows today; this is the segment given a parser and a writer.

- [x] 3.1 `fli register:repro <id> [--runs N] [--load N]`: finds the test the row names and runs three cells of N: the file alone, the package's own `bun run test` (the file's result read from bun's junit report — the console prints a file's header only when that file printed something, so a clean file and an unrun one read alike there), and the file alone under N typechecks (`FJS-D1148`), all but the last on a quiet machine. Prints the three pass counts. The suite cell is what tells order from load (`FJS-D1146`): half the timing rows say *fails under the full suite, passes alone*, which is both at once. Named for the segment it writes; *flaky* is the symptom word `FJS-D1118` refused for the same reason. Rides `FJS-3019`'s quiet run — same rows, same machine.
- [x] 3.2 The verdict goes into the row through `fli amend`. Fails alone, or passes alone and fails in the quiet suite: the tool strips `env: timing` and says so, because a test failing on a quiet machine — or leaking state into the next file — is code, and the loop should see it again (`repro: 9/9 alone · 3/9 in suite`); the loaded cell is not run, since it cannot change that. Passes both and fails loaded: `repro: 9/9 alone · 9/9 in suite · 4/9 under 7 typechecks`, tag kept. Clean in all three did not reproduce: counts written, tag kept, because nine quiet passes do not prove the guess wrong. `reproVerdict` reads the counts; `amendIssue` took a `drop` (one whole segment removed in the same write). `reproOf` in `next.js` parses the tool's shape only — six rows carry a free `repro:` that is a hand recipe — and `env-smell` is silent on a row it finds, or a stripped row would be told to put back the tag its measurement took off. `--dry` prints the segment and writes nothing.
- [x] 3.3 `env-smell` learns the reverse: an `env: timing` row with no `repro:` segment is a warning. A guessed cause that nothing measured is the `stale?` fiction with a different label. The warning names the way out: `fli repro <id>` on a row linking one collected test, and on any other row the refusal `register:repro` would give (`linkedTest`, the row half of `reproTarget`), so five drive and spec rows are not told to run a command that refuses them. They warn until `repro` can measure a drive or the tag comes off, so Done-when is unmet by design. Building it found two timing rows and three `shared db` rows invisible to every segment parser: `registers.js` joined a row's cells on a space, so a Detail whose FIRST segment was `env:` followed the date, not a `·`. The cells join on ` · ` now. `FJS-3019` (a task, not a timing defect) traded `env: timing` for `by hand`, which fix:loop also skips.

### Phase 4 — Hazards graded like invariants

Goal: a live hazard either has a rule or says why not.
Done when: `hazards.snapshot.md` exists and `snapshots` fails a stale one.

- [x] 4.1 `fli ws:hazards` writes `hazards.snapshot.md`: one row per entry in the three realm skills' indexes — hazard, and the `fli check` rule that grades it or `none`, the shape `invariants.snapshot.md` has for the invariants (`FJS-D190`). A rule names its hazard as `hazard: '<realm>: <prefix of the bold lead>'`, and `hazard-enforcer` reds a key matching zero bullets or two. A `none` carries no reason (owner, 2026-10-16): the gap is the finding. First run: 13 of 172 graded.
- [ ] 4.2 Rank the `none` rows by how often the hazard is named in failed attempts' transcripts (`loop-review.mjs` already finds repeated reads; this is the same read keyed by hazard). A hazard that lives only in prose is one every new session re-learns by failing, and the count says which to grade first.

### Phase 5 — Drives declare what they hold

Goal: `env: port` and `env: shared db` stop being filed, because the collision cannot happen.
Done when: two drives that name one port cannot be started together by `fli prove` or by a lane.

- [x] 5.1 Run `decision-rules` on the declaration (Q2, ruled `FJS-D1136`). Each `verify:*` script exports `needs`, something like `{ ports: [8110], db: 'dev', chrome: true, network: false }`; `proofs.js` reads it beside the DRIVES.md row it already parses. The *Start first* column stays prose for the reader; the resources are the half a scheduler can act on.
- [ ] 5.2 `fli prove` orders drives so no two sharing a port or a db run at once; `fix:loop` lanes schedule by resource, not only by package. The worktree-per-lane workaround for a shared `8110`/`db/` becomes unnecessary for drives that declare they hold neither.
- [ ] 5.3 `drive-needs` rule: a drive that opens a port or a db it did not declare is an error. The check already knows a drive's ports (`test-port-literal`, `portFor`); this is the same read against the declaration.

### Phase 6 — A collected test is hermetic by rule

Goal: a unit failure is never environment, by construction.
Done when: `fli check` passes the tree with the rule on, and every file it moved sits in `specs/`.

- [ ] 6.1 `test-not-hermetic` rule: a `*.test.*` file that calls `Bun.serve`, opens Chrome, or fetches a `localhost` URL is a driven test wearing a collected name — it belongs in `specs/` with a `run.mjs` beside it. The split is the house rule already (root `CLAUDE.md` § Running things); this grades it.
- [ ] 6.2 `test-timeout-inline` warning: a `{ timeout }` option on a test call, where the package's `bunfig.toml` is the one owner (Invariant 4's shape applied to tests). `FJS-3019` probes whether a package timeout clears half the timing rows; this keeps the answer from drifting back into twenty files.

---

## The nine, answered late

Answered after the file was drafted, which is named here so the next reader
can tell a decision from a defense.

1. **Origin** — none added. `seam:` names come from the root `CLAUDE.md` § Bridge index key list that `seam-listed` already parses; `repro:` is written by a tool from a run; `needs` lives in the drive script and DRIVES.md keeps prose (Q2); Phase 0 and Phase 4 are reads of data already written. `contested` is one word whoever sets it (Q3).
2. **Concept** — two segments of a kind that exists (`by hand`, `env:`) and one declaration (`needs`). `repro:` is governed, not coined — six rows write it free today. `flaky` was rejected: it names the symptom, and `FJS-D1118` refused it once already.
3. **Complexity** — the problem's. Several drives on one machine is resource scheduling, an old name; the ecosystem's *flaky-test quarantine* is the same problem solved by hiding the symptom, which is where the existing name fails and why the segment names the cause.
4. **Predictability** — each piece copies a sibling: a segment parses like `env:`, a rule reds like `env-cause`, the snapshot has `invariants.snapshot.md`'s shape, the report is a section of the report that exists.
5. **Derived** — the counts and the snapshot derive. The seam and the cause are written by hand, which `FJS-D1118` settled: the suspicion derives, the diagnosis does not. `needs` is a declaration, and 5.3 grades it against what the drive binds so the declaration cannot drift.
6. **Owner** — every owner exists: `core/next.js` parses segments, `core/register-check.js` grades them, `core/proofs.js` reads drives, `core/checks.js` holds rules, `scripts/loop-review.mjs` reads the log. The paper's first draft put Phase 0 in a new script beside it, and this question moved it.
7. **Boundary** — a segment is a word from a closed list; `needs` is a typed object; a rule has an id and a severity.
8. **Failure** — `seam-name` and `drive-needs` are errors because the fix is one word and the silent case is a bug nobody counts; `test-timeout-inline` and the reverse `env-smell` are warnings because the row may be right.
9. **Silence** — each phase's *Done when* is its artefact: the report section, the status word in the register, the two rules, the `repro:` segment and its smell rule, the snapshot under the `snapshots` phase, `drive-needs`, `test-not-hermetic`. `none` is recorded nowhere here on purpose: a signal with no red is the thing this paper is about.

**Adjudications in tension.** *Paved road vs. the workaround* — a worktree per lane is the same workaround in the same place, which § IV calls a measurement of the road, and Phase 5 changes the road. *Familiarity vs. precision* — `flaky`, rejected. *Ergonomics vs. strictness* — severity per rule by what the mistake destroys, above. **Tier:** Assessment; Q1–Q3 become Register entries when ruled.

## Open questions

- ~~**Q1 — How does a register row name the Bridge index seam a bug crosses?**~~ **Answered 2026-10-16 (`FJS-D1135`): A — `seam: <name>`, its own ` · ` segment beside `env:`, written by hand, name from the root `CLAUDE.md` § Bridge index key list.**
  - **A** — `seam: <name>`, its own ` · ` segment beside `env:`, written by
    hand, name from the root `CLAUDE.md` § Bridge index key list.
  - **B** — the row cites the owner in prose and `fli next` infers it by
    matching the key list against the title.
  - **Recommend A** — `FJS-D1118` ruled the same question for `env:` the same
    way: the suspicion may derive, the diagnosis is written by hand, and a
    closed list is what makes the count mean something.
- ~~**Q2 — Where does a drive declare the resources it holds?**~~ **Answered 2026-10-16 (`FJS-D1136`): A — an export from the `verify:*` script, read by `proofs.js` beside the DRIVES.md row.**
  - **A** — an export from the `verify:*` script, read by `proofs.js` beside
    the DRIVES.md row.
  - **B** — in `example/package.json` beside the script line.
  - **C** — a fourth DRIVES.md column.
  - **Recommend A** — the script is the one place that knows which port it
    binds, `proofs.js` already imports beside DRIVES.md, and a column in
    prose is what `env: port` rows are made of.
- ~~**Q3 — Is `contested` set by the loop (1.1) the same status as `contested` set by a person?**~~ **Answered 2026-10-16 (`FJS-D1137`): A — one word; the note beside it says who doubted and why.**
  - **A** — one word; the note beside it says who doubted and why.
  - **B** — a second word for the loop's doubt.
  - **Recommend A** — both mean *re-diagnose before spending*, and a second
    status costs a `fli next` branch and a conventions row for a distinction
    the note already carries.

- ~~**Q4 — How does `register:repro` tell a test that fails by order from one that fails by load?**~~ **Answered 2026-10-16 (`FJS-D1146`): A — a third cell, the package's own `bun run test` on a quiet machine, every run (same N), reading the named file's result from the per-file headers bun prints. Alone-pass and suite-fail is order: a file leaking state into another is test code, so the tool strips `env: timing` (`repro: 9/9 alone · 3/9 in suite`). A package whose runner is not `bun test` is refused by name, and so is a run whose output never prints the file's header: an unseen file is not a pass.**
  - **A** — a third cell, the package's own `bun run test` on a quiet
    machine, every run (same N), reading the named file's result from the
    per-file headers bun prints. Alone-pass and suite-fail is order: a file
    leaking state into another is test code, so the tool strips
    `env: timing` (`repro: 9/9 alone · 3/9 in suite`). A package whose runner
    is not `bun test` is refused by name, and so is a run whose output
    never prints the file's header: an unseen file is not a pass.
  - **B** — a seventh cause, `env: order`, in `ENV_CAUSES`.
  - **C** — the suite cell behind a `--suite` flag.
  - **Recommend A** — half the timing rows say *fails under the full suite,
    passes alone*, which is order and load at once; only a quiet suite run
    separates them. `env:` names where the fix lives, and a leak's fix is the
    test, so B mislabels it. C defaults to the false *9/9 alone, so load*.
    The package script stays the one owner of file order and `tmp-run`.

- ~~**Q5 — What load runs beside the test in `register:repro`'s third cell?**~~ **Answered 2026-10-16 (`FJS-D1148`): A — `--load N` copies of junction's own `bun run typecheck`, each restarted until the cell's runs finish; N defaults to `ceil(nproc / 1.8)` (7 on 12 cores), and the row reads `k/N under 7 typechecks`. A typecheck that exits nonzero refuses the run: a load that died is no load.**
  - **A** — `--load N` copies of junction's own `bun run typecheck`, each
    restarted until the cell's runs finish; N defaults to
    `ceil(nproc / 1.8)` (7 on 12 cores), and the row reads
    `k/N under 7 typechecks`. A typecheck that exits nonzero refuses the run:
    a load that died is no load.
  - **B** — N busy loops, one core each.
  - **C** — N other packages' suites, looped.
  - **D** — `fix:loop --lanes N` beside it.
  - **Recommend A** — hermetic (no port, db or tmp, so the load cannot file
    its own `env: port`), real repo work at ~1.8 cores and 500 MB, and the
    one load that reproduced a row (`FJS-1172`, failing beside orion's
    typecheck). B found nothing at 12 loops (`FJS-2854`); C and D vary per
    run. N fills the cores because a timeout under load is starvation, and
    nothing starves at half load. Not `--lanes` and not *lanes*: a lane is a
    `fix:loop` worktree, and one word for two loads is two meanings.

## See also

- `FJS-D1118` — the `env:` segment this paper extends.
- `FJS-3019` — the quiet run Phase 3 rides.
- `FJS-D190` — the snapshot shape Phase 4 copies.
- `scripts/loop-review.mjs` — the transcript read this paper's Phase 0 sits beside.
- `invariants.snapshot.md` — what Phase 4 produces for hazards.
