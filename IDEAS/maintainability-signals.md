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
log carries package, outcome, cost, turns and phases per attempt
(`scripts/fix-loop.mjs` `appendLog`); the register carries severity, area,
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

- [ ] 0.1 A § Cost section in `scripts/loop-review.mjs` — it is the one reader of the log, and a second script beside it is the second owner Invariant 4 forbids. Cost per CLOSED row by package (closed count, attempts, spend, spend ÷ closed), sorted by spend ÷ closed. A package high on this table is one hard to change, whatever its rows say.
- [ ] 0.2 Same section: sent-back rows (`sentBack` in `fix-loop.mjs`) by package, and `busy` outcomes by FILE from the `dirty` field. A file that is `busy` across lanes is a file more than one row needs — a split candidate, and the number `FJS-1157` (×3) was paid to learn by hand.
- [ ] 0.3 Read the three tables once and write what they say into this file as a **Done** paragraph. If they say nothing, the rest of the paper waits.

### Phase 1 — Write the loop's verdicts back into the register

Goal: a row the loop gave up on says so where a person reads.
Done when: `fli next` shows the mark, and `fix:loop` dodges by the row rather than by re-reading the log.

- [ ] 1.1 After the second non-closing verdict (`sentBack` already counts two), `fix:loop` sets the row's status to `contested` with a note naming the verdicts — the same word the conventions give a doubted diagnosis, applied from the other side. Today the knowledge dies in `.cache` and the next `fli next` ranks the row as if nobody had looked.
- [ ] 1.2 `fli next` prints the attempt count beside a `contested` row, so the reader sees two failed sessions and re-diagnoses rather than spending a third.

### Phase 2 — A seam segment

Goal: the Bridge index as a scoreboard.
Done when: `fli next --by seam` groups rows, and `register:check` refuses a seam the key list does not name.

- [ ] 2.1 Run `decision-rules` on the segment (Q1). It is `env:`'s sibling: `seam: <name>`, its own ` · `-joined segment, name from the root `CLAUDE.md` § Bridge index key list, which `seam-listed` already parses. `env:` says where the FIX lives; `seam:` says which handoff the bug crosses.
- [ ] 2.2 `seamOf` beside `envCause` in `cli/core/next.js`; a `seam-name` rule in `register-check.js` (error, name outside the key list) mirroring `env-cause`.
- [ ] 2.3 `fli next --by seam`: rows grouped by segment, count first. Eight rows on one seam is a design wrong there, not eight bugs, and it is the number that decides whether a seam gets a paper.
- [ ] 2.4 Backfill: the open rows whose title names a Bridge index owner get the segment. Done by one pass, not by rule — a row's seam is written by hand like its cause.

### Phase 3 — An env row carries its proof

Goal: `env: timing` is a measurement, not a guess.
Done when: every `env: timing` row has a `repro:` segment written by the tool, or has lost the tag. `repro:` is already written free in six rows today; this is the segment given a parser and a writer.

- [ ] 3.1 `fli register:repro <id> [--runs N] [--lanes N]`: finds the test the row names, runs it N times alone and N times under lane load, prints pass counts for each. Named for the segment it writes; *flaky* is the symptom word `FJS-D1118` refused for the same reason. Rides `FJS-3019`'s quiet run — same rows, same machine.
- [ ] 3.2 Passes alone and fails loaded: the tool writes `repro: N/N alone · k/N under M lanes` into the row through `fli amend`. Fails alone: the tool strips `env: timing` and says so, because a test that fails on a quiet machine is code, and the loop should see it again.
- [ ] 3.3 `env-smell` learns the reverse: an `env: timing` row with no `repro:` segment is a warning. A guessed cause that nothing measured is the `stale?` fiction with a different label.

### Phase 4 — Hazards graded like invariants

Goal: a live hazard either has a rule or says why not.
Done when: `hazards.snapshot.md` exists and `snapshots` fails a stale one.

- [ ] 4.1 `fli ws:hazards` writes `hazards.snapshot.md`: one row per entry in the three realm skills' indexes — hazard, the `fli check` rule that grades it, or `none` with the reason, the shape `invariants.snapshot.md` has for the invariants (`FJS-D190`).
- [ ] 4.2 Rank the `none` rows by how often the hazard is named in failed attempts' transcripts (`loop-review.mjs` already finds repeated reads; this is the same read keyed by hazard). A hazard that lives only in prose is one every new session re-learns by failing, and the count says which to grade first.

### Phase 5 — Drives declare what they hold

Goal: `env: port` and `env: shared db` stop being filed, because the collision cannot happen.
Done when: two drives that name one port cannot be started together by `fli prove` or by a lane.

- [ ] 5.1 Run `decision-rules` on the declaration (Q2). Each `verify:*` script exports `needs`, something like `{ ports: [8110], db: 'dev', chrome: true, network: false }`; `proofs.js` reads it beside the DRIVES.md row it already parses. The *Start first* column stays prose for the reader; the resources are the half a scheduler can act on.
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

- **Q1** — Is the seam segment `seam: <Bridge index name>` (**A**), or does a row cite the owner in prose and `fli next` infer it by matching the key list against the title (**B**)? **Recommend A** — `FJS-D1118` ruled the same question for `env:` the same way: the suspicion may derive, the diagnosis is written by hand, and a closed list is what makes the count mean something.
- **Q2** — Does a drive's resource declaration live in the script as an export (**A**), in `example/package.json` beside the script line (**B**), or as a fourth DRIVES.md column (**C**)? **Recommend A** — the script is the one place that knows which port it binds, `proofs.js` already imports beside DRIVES.md, and a column in prose is what `env: port` rows are made of.
- **Q3** — Does `contested` set by the loop (1.1) stay distinct from `contested` set by a person, or is one word enough? **Recommend one word** — both mean *re-diagnose before spending*, and the note beside it says who doubted and why.

## See also

- `FJS-D1118` — the `env:` segment this paper extends.
- `FJS-3019` — the quiet run Phase 3 rides.
- `FJS-D190` — the snapshot shape Phase 4 copies.
- `scripts/loop-review.mjs` — the transcript read this paper's Phase 0 sits beside.
- `invariants.snapshot.md` — what Phase 4 produces for hazards.
