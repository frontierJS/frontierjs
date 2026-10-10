# Alongside

**How to work beside the owner's sessions without colliding with them.** `main`
moves around a hundred commits a fortnight, each touching dozens to hundreds of
files, so a branch that edits the same code is stale before it is reviewed.
The work below stays true while `main` moves: it lands in files nobody else is
writing, or in packages nobody else is in.

Read the root `CLAUDE.md` first; everything there applies here.

## 1. Pick a lane

A lane is a package, or a stressor app, that `main` is quiet in. Measure it
rather than trust a list — the hot set changes week to week:

```sh
git log --since='14 days ago' --name-only --pretty=format: \
  | awk -F/ 'NF{ print ($1=="packages") ? $1"/"$2 : $1 }' | sort | uniq -c | sort -rn
```

The top of that list is where the owner is working. Choose from the bottom
third. Claim the lane by writing one line under **Claimed** in your
`alongside/<your-name>.md` and pushing it before you start, so both sides can see it.

## 2. The work, in order of how well it survives

1. **A failing test.** A new file in the package's `test/`, one defect per
   test, marked `test.failing(name, fn)` so the suite stays green while the bug
   is open. A new file conflicts with nothing. The test is the bug report and,
   once the fix lands, the proof of it. Run it with the package's own
   `bun run test` (root `CLAUDE.md` § Running things).
2. **An audit.** Take one package and check what its `CLAUDE.md`, `README.md`
   and `docs/` claim against what the code does, by running it
   (`VERIFYING.md`). Each finding goes in your `alongside/` file with a repro,
   and the strongest ones also get a failing test.
3. **A stressor app.** Build something real on FJS and record each place the
   framework fought you. The stressors live in `../fjs-prototypes/`, each its
   own repo, outside this tree — ask the owner for one. The app is yours, so
   nothing collides; what the owner needs from it is the friction list.
4. **A fix in your lane.** Once a lane has been yours for a while, fix what you
   found there. Keep each fix to one finding, one PR.

## 3. A menu

Each item below is either an audit or an experiment. Each one is read-only
against `main`, or runs in a worktree of its own, and ends as a report in
`alongside/`. Pick one and say which in your claim line.

### Audits

- **Re-probe the `stale?` rows.** `ISSUES.md` has rows inherited from older
  audits that nobody has re-run (Status `stale?`). Run each one and record a
  verdict: *still present*, *fixed* (name the commit, if it can be found) or
  *wrong diagnosis*. Every verdict clears a row from the register, or confirms it.
- **Docs against code, one package.** List every claim the package's
  `README.md`, `CLAUDE.md` and `docs/` make, then run each one. Invariant 16
  makes a runnable example that does not run a bug, so execute every code block
  as written.
- **A clean machine.** Your machine is not the owner's, which is the point.
  Run `npm create frontier@latest` and then each `fli tutor:*` from a clean
  checkout, and record every step that fails, hangs, or assumes something
  that is not there.
- **`THREATS.md`, attacked.** For each row whose defense is claimed, try to
  get past it, and write each success as a `test.failing`.
- **Skill triggers.** For each hazard skill (`.claude/skills/*-hazards`),
  write prompts that should fire it and prompts that should not, run them
  headless (`claude -p`), and count the firings. A skill that misses its own
  realm means the wording of its `description` needs work (`doc-hygiene`
  § The ladder).

### Experiments on how the work is done

These measure the process, not the code, so they can run against any commit
and still give a true answer after `main` has moved on.

- **Which model for which ticket.** Replay closed rows: for a row in
  `ISSUES_ARCHIVE.md`, find its fix commit, make a worktree at that commit's
  parent, and run the `fix-next` skill on the row with each model at a fixed
  effort. Score each run on whether the fix's own test passes, tokens spent,
  and wall time. Group the rows by realm, severity and kind (defect, gap, doc)
  to get a table of which model to send each kind of ticket to. The current
  ladder is Sonnet first, then Opus — this is the experiment that confirms it
  or overturns it.
- **Effort level.** The same replay at fixed model, varying effort. Where
  low effort closes the row, high effort is spent for nothing.
- **Does the pre-brief pay?** `fix-next` takes a scripted `## Pre-brief` in
  place of an `Explore` agent. Replay the same rows with it and without it,
  and compare tokens spent before the first edit.
- **What `CLAUDE.md` buys.** Run a fixed task set with the root `CLAUDE.md`
  as it stands, then with sections cut, and compare the outcomes. A section
  whose removal changes nothing is context load that buys no behavior
  (`doc-hygiene` § The four cuts).
- **Cold-start cost.** Give a fresh session one scripted task and count the
  tokens and files read before its first edit. The files it reads in the
  wrong order show where the docs failed to route it. The owner has a
  `token-audit` skill that breaks down a session's tokens; ask for a copy.

An experiment's report states the task set, the commit, the model and effort,
and the raw numbers, so it can be rerun and checked.

## 4. Where findings go

Write findings in **`alongside/<your-name>.md`**. One section per finding:

```md
## <one-line claim>
- Where: packages/<pkg>/<file>:<line>
- Repro: <command that shows it>
- Expected / actual: …
- Sev: S1–S4 (ISSUES.md § Conventions)
- Test: packages/<pkg>/test/<file> (if written)
```

The owner's session moves each finding into `ISSUES.md` with an `FJS-###` id
and deletes it from your file. Each finding needs exactly one owner, and that
handoff keeps it that way: the shared registers — `ISSUES.md`,
`DECISIONS.md`, `HANDOFF.md`, `IDEAS/` and every `*.snapshot.*` — are written
by the owner's session only. Your branch touches your `alongside/` file, new
test files, and your claimed lane.

## 5. Before you push

```sh
git fetch && git rebase origin/main
fli proves --from main     # names the drives this change needs
fli prove                  # runs them
fli done                   # what is unfinished; clear it or say why it stays
```

A conflict in a `*.snapshot.*` file is resolved by rerunning its generator,
never by editing it — `fli ws:atlas --as=report` names the generator for each
one. Rebase daily even when you are not pushing; resolving conflicts a day at a
time is cheap, and a week's worth all at once is not.

## For the owner

- Push small commits with messages that say what changed — the log is the only
  view a parallel worker has of where `main` is heading.
- Sweep `alongside/*.md` into `ISSUES.md` on a cadence, so a finding is never
  left in two places.
- Answer a lane claim the same day; a lane you are about to enter is a lane to
  say no to.
