---
id: autopilot
status: proposed
dated: 2026-11-02
---

# Autopilot — the project's loops as a town, with a switch that runs them

**Status: PROPOSED.** Dated 2026-11-02. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

A Basecamp route, `/atlas/autopilot`, that draws what the loops do to this
repo as a town — rows moving between tables, questions walking to the council,
lanes fixing, apps being built and proved, the gate going red and green — and
ends in one toggle, **Turn On**, that schedules those loops so nobody has to
start them. It is the Claude Rig picture (the 2026-10-31 artifact) with the
project in the middle instead of Claude.

**Autopilot** is a mode, not a thing: the loops the repo already has
(`scripts/fix-loop.mjs`, `frame-loop.mjs`, `loop-review.mjs`) running on a
schedule with the owner as the only human touch. It coins no other noun. Each
scheduled entry is *a loop's schedule* — a loop kind, a cron line and caps —
and the caps are the scripts' own arguments (`--lanes`, `--rows`, `--budget`,
`--sev`), never a new flag (`decision-rules`, 2026-11-02: paved road over a
widened one).

## What already exists, and what is still hand-cranked

| Exists | Where | Still a person |
| --- | --- | --- |
| Open questions become decidable | `frame-loop.mjs`, skill `frame-next` | someone starts it |
| Owner rules | `fli decide`, `/atlas/decide/` | stays the owner's, by doctrine |
| Rows get researched and batched | skill `rule-next` | an interactive session |
| Rows get fixed in lanes, harvested into the main tree | `fix-loop.mjs`, `lanes.mjs`, `headless.mjs` | someone starts it; the harvest sits uncommitted |
| What repeats gets named | `loop-review.mjs` (`--ask` proposes) | someone applies it |
| New rows, questions and ideas | audits, stressor passes (`docs/STRESSOR-UPGRADE.md`: a framework gap is filed, never worked around) | someone opens the app and takes its plan's next box; CI red and a stalled stranger build file nothing |

Autopilot takes the first column's *someone starts it* and the morning after.
It never rules, never commits to `main`, and never files more than its cap.

## The town

Every building is a place the registers or the logs already describe. The map
draws state; it holds none.

| Building | Stands for | Read from |
| --- | --- | --- |
| **Registry** | `ISSUES.md` — crates on three tables: *ready*, *blocked*, *busy*; a crate closed today leaves by the door | `fli next --json` |
| **Council** | `DECISIONS.md` and every paper's open questions — *open* in the hall, *decidable* at the bench, *ruled* on the wall | `fli decisions --json` |
| **Lanes** (workshops 1–5) | one `fix-loop` lane each: the row on the bench, the model and effort, cost and turns ticking | `~/.fli/lanes`, `~/.fli/fix-loop.jsonl` |
| **Framing desk** | `frame-loop` at work on one paper | `~/.fli/frame-loop.jsonl` |
| **Review** | `loop-review`'s last report — what repeated | `~/.fli/fix-loop-review.md` |
| **Plan office** | the `IDEAS/` papers with an open box, and every opted-in stressor as a site under construction with its phase on the hoarding | `fli plan <paper>`, `fli plan <stressors.dir>/<app>/PLAN.md` |
| **Proving ground** | drives and stressor checks running; CI's last run as the gate at the edge of town | `.cache/ci-last.txt`, `fli proves` |
| **Dock** | harvested fixes waiting to land — a patch per closed row | `~/.fli/lanes/patches` |
| **Post** | rulings asked of the owner, and answers back (Phase 4; `IDEAS/phone-ping.md`) | the ntfy topic |
| **Switch** | Turn On / Off, the schedule table, today's spend against the cap | `~/.fli/autopilot.json`, the logs |

Roads carry the three things that move: a **row** (Registry → a lane → the
Dock, or Registry → Council when it files a question), a **question** (Council
hall → bench → wall, with a trip to Post), and a **paper** (Plan office → the
Proving ground). A dot on a road is one of them in flight; the log line that
moved it is the tooltip.

## Where things live, and who runs what

- **The schedule is a file on the machine, beside the logs** —
  `~/.fli/autopilot.json`, fli's, read by `scripts/headless.mjs` (which already
  owns `LOG_DIR` and the session), never a Litestone model and never a Basecamp
  setting: loop state is machine-local, and a checkout can sit on a different
  host from a Basecamp (the workbench's `WORKBENCH_DIR` settled the same shape).
  A typed shape, an unknown loop kind refused by name, and a hard cap the
  script reads itself, so the caps hold with Basecamp down.
- **The stressors are the feeder, and the schedule file points at them.**
  `stressors: { dir: '../fjs-prototypes', apps: ['serpgrid', …] }`, the dir
  resolved against the framework root (the sibling `fli ws:surface --also`
  already spells), the apps a list the owner writes. An app is a feeder
  because its `PLAN.md` is Phases of Steps that `fli plan` already reads and
  its doctrine already says where a gap goes: a defect is `fli file --area
  <app>`, a question is `fli file --sev decision` with its options, or a
  question under the plan's own bullet ruled with `fli decide … --file
  PLAN.md`. Nothing new is parsed. The list is consent (Q5), and it lives
  beside the caps because an agent in the app's checkout must not be able to
  grant itself the run.
- **Basecamp spawns the existing scripts.** A caravan job
  (`api/src/jobs/autopilot-tick.job.ts`, `cron: '*/5 * * * *'`, the shape of
  `claude-index.job.ts`) fires whatever the schedule says is due, the way
  `workbench-run.ts` spawns `fli dev`. No new command, no second log: an
  autopilot run is a hand run in the log plus one field, `source: 'autopilot'`.
  Reopen path: `fli loop`, a command wrapping the scripts, if a Basecamp ever
  needs to spawn from outside the repo.
- **A scheduled fix never harvests into the main tree.** Nobody is there, and
  other sessions may share the tree. It runs on the patch path (`--trial`'s
  `~/.fli/lanes/patches`), and landing is Phase 3's own step with its own
  ruling.
- **Frame runs first and alone** in the earliest phase: `frame-next` writes only
  under a paper's bullets and never rules, so it is the loop safe to schedule
  before anything else.
- **The town is one route over the `atlas` service** — severable, drawn from
  readers that already exist, polled like the overview.

## Guards

A run that cannot be stopped by a cap is not scheduled. V1 caps: attempts per
day, dollars per day, lanes at once, a severity floor for anything it files,
and a model ceiling. A row the loop filed about the loop (FJS-3264 is one) is
the failure to watch: the per-day cap on filed rows is what stops the spiral,
and the stressor loop, the largest feeder, sits under the same cap.

A stressor step runs in a worktree of the app's repo, never in its working
tree, the rule the fix loop already keeps for this one. An app whose boot can
reach outside — a dev db that is prod data, a cron that polls a live service
(`docs/STRESSOR-UPGRADE.md` § 0 names the check) — is listed only after the
owner has pinned every such variable to a stand-in; the loop cannot attest
that, which is why the list is the owner's.

## Phases

### Phase 0 — Mock the town

Goal: the vocabulary above settled on real motion before any API is written.
Done when: the owner walks the mockup and the building list needs no new word.

- [x] 0.1 A scratch builder reads `~/.fli/fix-loop.jsonl`, `frame-loop.jsonl`,
      `fli next --json`, `fli decisions --json` and the stressor plans into one
      JSON day — the last 24 hours of attempts as events with a time, a thing
      (row, question, paper) and a from/to building.
- [x] 0.2 An artifact in the Rig's style: the town, a replay scrubber over the
      day, dots on roads, the Switch drawn Off with the schedule table and caps.
  - Published 2026-11-02: https://claude.ai/code/artifact/1c3228de-8366-4ecc-8d0a-6fbd5ed1cfd5
    — one real day (2026-10-31 10:54 → 11-01 10:54), 333 events, 106 attempts,
    81 closed, $50.48, lanes 1–2 only. What the building list could not say,
    for 0.3: harvests write the MAIN TREE and only trial patches reach the
    Dock; 20 of 104 harvests were a blocked row's register edit; `corrected`
    (6) has no table; `fli next --json` has no busy table and ignores
    `--limit`; the Council has a fourth state (settled by a ruling) and its
    text header and JSON disagree by one; the Framing desk was idle all day
    (every question came from a blocked row); none of the 13 overview papers
    has an open box, so which papers the Plan office shows needs a rule; the
    ELA plan reads 0/24 (its boxes do not parse); nothing logs a drive run, so
    no paper ever moves; `~/.fli` holds other checkouts' lanes, `merge`,
    `holds/` and a trial log with no building; cost arrives only at an
    attempt's end, so a ticking cost is interpolation.
- [ ] 0.3 The owner names what is missing or misnamed; this file is amended.
  - Deferred 2026-11-02: the owner sleeps on it and will use the live town
    first; Phase 1 proceeds and the walk happens on the real route.

### Phase 1 — The reader

Goal: the town drawn live from the real logs and registers, polled.
Done when: `verify-atlas.mjs` holds the town's counts against the logs read
in-process, as it holds the ring cards against `dataOf`.

- [x] 1.1 a new `loop-log.js` beside the other readers in `packages/cli/core/` — one reader of the jsonl logs and the
      lanes directory, shared by `loop-review.mjs` and the API (today the review
      script parses them alone).
- [x] 1.2 `autopilot` method on the `atlas` service: the town state — lanes and
      their rows, attempts in the last day, Registry tables, Council benches,
      papers with an open box, the Dock, the last CI run — under the same
      LOCAL_MACHINE and agent refusals as `overview`.
  - Built 2026-11-02. Council counts are the atlas's question states, not
    `fli decisions`' headline; every paper with an open box is returned (45
    today), so which the office draws is the route's rule.
- [x] 1.3 `web/src/routes/atlas/autopilot/index.mesa` draws the town from that
      state; a building opens its register tab on `/atlas/`.
  - Built 2026-11-02, `verify:atlas` holds it against the log read in-process.
    A building is selected first and its place card opens the tab, by
    `/atlas/?tab=<name>`. For 0.3: the Registry's *ready* table is
    `collectRegisterAtlas`'s 138 (ready, by hand and env together), where the
    rings page's strict *ready* is 21; the Framing desk always reads idle
    because no loop writes a live framing state; the Switch's Turn On is drawn
    disabled until Phase 3 writes the file.

### Phase 2 — The schedule, run by hand

Goal: a schedule file a person edits and a loop a button starts.
Done when: *Run now* on the fix entry closes a row on the patch path and the
town shows the crate move, with `source: 'autopilot'` in the log line.

- [x] 2.1 `~/.fli/autopilot.json` and its reader in `core/autopilot.js`: entries of
      `{ loop, cron, caps }`, the caps mapped to the scripts' own flags, an
      unknown loop refused by name, an over-cap entry refused at read time
      (script test). *Built 2026-11-02: the reader is
      `packages/cli/core/autopilot.js` (`readSchedule`, `flagsOf`,
      `worstCost`, `spentToday`, `overDayCap`), which `headless.mjs` wraps and
      the Atlas API imports as 1.1 did `loop-log.js` — one reader for both. The
      file's own cap is `day: { attempts, dollars }`; `model` is a ceiling
      (`sonnet` pins the rung, `opus` keeps the ladder). A cap not set is
      listed in `missing`, never defaulted (FJS-D1778).
      `packages/cli/test/autopilot.test.js`.*
- [x] 2.2 `fix-loop.mjs` and `frame-loop.mjs` take `--source autopilot` and
      write it, and `fix-loop` writes `lane` on the `started` line too: today
      only the finishing line names the lane, so the reader draws an
      unfinished start on lane 1 and reads *busy* off the lane's lock file
      alone; `loop-review.mjs` still reads the log (test). *Built 2026-11-02:
      a scheduled fix run is the third landing, `dock` — lanes required, the
      register copied, every outcome kept as a patch and never harvested
      (FJS-D1779) — and both scripts refuse a start past the day cap with
      Basecamp down. `loop-log.test.js` draws the start on its lane.*
- [x] 2.3 The Switch's schedule table on the route, read-only, with *Run now*
      per entry: the API spawns the script the way `workbench-run.ts` spawns
      `fli dev`, and the run shows in its lane. *Built 2026-11-02:
      `POST /atlas/:n run` (`api/src/domain/atlas/autopilot-run.ts`), the
      entry's number 1-based, refused past the day cap, while that entry runs,
      or where the script is not beside the registers. A starter file is
      written on this machine with `on: false`. The hand proof in* Done when
      *— Run now on the fix entry — is the owner's click, since one costs a
      session; the drive proves the table and never clicks.*

### Phase 3 — Turn On

Goal: the toggle, and a morning the owner wakes up to.
Done when: Turn On runs one night with the API up, and the morning shows
patches on the Dock, a decidable list at the Council, spend under the cap, and
a report.

- [x] 3.1 `autopilot-tick.job.ts`: every five minutes, when On, start each entry
      that is due and whose lanes are free; refuse when the day's cap is spent.
      *Built 2026-11-02: `tick()` in `api/src/domain/atlas/autopilot-run.ts`,
      the job a thin caller. Due is a cron minute since the last tick's
      persisted record, `~/.fli/autopilot/tick.json` (`FJS-D1783`); the Switch
      reads it as* Last tick. *Held lanes and the day cap are skipped by name
      in the record. Off, the job returns at once. The job's handler is proved
      by the API booting with it and `tick()` by `api/test/atlas.test.ts`; the
      night run is this phase's* Done when.*
- [x] 3.2 The toggle, refused until every cap is set; Off stops nothing running
      and starts nothing new. *Built 2026-11-02: `writeSwitch` beside the
      reader in `core/autopilot.js`, the file's one writer, re-reads the file
      and writes `on` back and nothing else (FJS-D1778: On waits on `missing`);
      `POST /atlas/:id turn` with on|off; the route's toggle is held with its
      reason in `#ap-sw-why`. The tick job returns at once on false, so Off
      stops nothing. The drive asserts held or live and never clicks: a turn
      writes the owner's file, and On would let the drive's own API start a
      loop. `packages/cli/test/autopilot.test.js`.*
- [x] 3.3 Landing — a closed row's patch stays on the Dock (`FJS-D1779`):
      the route lists each with its row and the lane command that applies it,
      and applying is the owner's read; nothing is committed. *Built
      2026-11-02: a Dock tab on the route, one row per patch under
      `~/.fli/lanes/patches` with its register row, the newest attempt off the
      log, its size (`loop-log.js` counts it) and the apply command, which the
      page copies and never runs. The command's one spelling is `applyArgv` in
      `core/autopilot.js`; the lanes apply through it too. The drive asserts
      the list and that no button but Copy exists.*
- [x] 3.4 The morning report as a Basecamp notification: ran, closed, blocked,
      framed, spent, and what the Review says repeated. *Built 2026-11-03: a
      fifteenth `NotificationKind`, `AutopilotReport`, email and in-app to the
      system admins and never push, sent by `jobs/autopilot-report.job.ts` at
      eight on the host's clock — the loops' cron lines are host-clock too, so
      the night is inside the window. Counted at send time by
      `domain/atlas/autopilot-report.ts` over `readLoopLog`'s last 24 hours,
      nothing stored (the weekly digest's shape): starts, closed, blocked, the
      rest as failed, framed questions, the window's spend, today's scheduled
      spend against the day cap, patches on the Dock, the last tick, and the
      Review's top-level bullets under its four repeat headings
      (`loop-log.js` reads them as* review.repeated*). Silent only when Off
      with nothing in the window; On and quiet sends, naming the last tick, so
      a dead tick job cannot pass for a quiet night. Local dev only
      (FJS-D1776). Migration `20261103002231_autopilot_report`, applied by the
      API at boot.*

### Phase 4 — More loops, later

Goal: the entries the first three phases did not need.
Done when: each has its own ruling and its own cap.

- [x] 4.1 Stressor steps — a `stress` entry and a `stress-next` skill beside
      `fix-next` and `frame-next`: of the listed apps, the one whose first open
      box has waited longest; that one box in a headless session in a worktree
      of the app's repo; every framework gap filed (`fli file --area <app>`, or
      `--sev decision` with options), the box ticked, stop. Outcome read off
      the box and the registers, never the session; the site on the map under
      construction. Refuses an app not in the list and a run over the
      filed-rows cap (script test). *Built 2026-11-03: `scripts/stress-loop.mjs`
      (its pure half `scripts/stressors.mjs`, held by
      `packages/cli/test/stressors.test.js`) and `.claude/skills/stress-next`.
      The entry's caps are `rows`, `filed`, `budget`, `model`; `filed` is the
      rows one day of stress runs may file, counted off the loop's own log
      lines, hand runs included. The list refuses by name on a hand run too,
      `--app` choosing among the listed. Waited longest is the later of the box
      line's last commit (`git blame`; the file's mtime when uncommitted) and
      the loop's last attempt at it, ties in list order. The step runs in
      `~/.fli/stress/<app>` on the branch `stress/<step>`, the app's
      uncommitted work committed there as a base and the session's work
      committed on top, the app's own tree never written; a step ticked on an
      unmerged branch is passed over until the owner merges it. The session's
      cwd is the framework root with the worktree as `--add-dir`, so `fli
      file` finds the registers. Every loop's log is named once, in
      `LOOPS[*].log` / `LOG_NAMES` (`core/autopilot.js`), and a test refuses a
      second spelling; the town draws a step as a site to the Proving ground
      and each filed row as a crate to the Registry. Proved end to end with a
      stand-in `claude` against a scratch app repo; a real step costs a
      session and is the owner's run.*
- [x] 4.2 Feeders — CI red files a row; a stranger build from the npm packages
      files what stalls it; each under the filed-rows cap.
  Built 2026-11-03 (`FJS-D1789`): one `feed` loop, `scripts/feed-loop.mjs` with the pure half in `scripts/feeders.mjs` (`packages/cli/test/feeders.test.js`); caps `feeder: ci | stranger` and `filed`, one log `feed-loop.jsonl` and one filed count over both; a feed entry's worst run is $0. `ci` resets a worktree at HEAD (`~/.fli/feed/ci`), `bun install`s and runs `node scripts/ci.mjs` (`--fast` by hand), reads the run back through `core/ci-log.js`; a run already going is `busy`. `stranger` is the README's line, `bunx @frontierjs/cli@<latest> new demo --full --yes --source npm` in a temp dir, then `bun run check` and `bun run build`; the first non-zero exit is the stall, `npm view` unanswered is `offline`. A red unit files S3 under a fixed title — `CI red: <phase> · <key, or label without its counts>`, `A stranger's build from npm stalls at <step>` — an open row with the title is amended once a day (`core/amend.js`), a closed one is cited, an `envSmells` title is logged `env` and never filed (`issuesTitled` in `core/registers.js`). The town draws each filed row as a crate from the Proving ground. Proved: `--help`, refusals by name (feeder, cap, source), `--feeder ci --dry-run` off the last recorded run, stranger dry run green from `@frontierjs/cli@0.1.11` (the first stalled on `--no-install`, whose app has no first migration and fails its own `migration-history` check — by design, so the stranger installs), and a real `--feeder ci --fast --filed 1` under a scratch HOME that filed `FJS-3840` and held the registers red past the cap. Two schedule entries in `~/.fli/autopilot.json` (`0 4` ci, `0 5` stranger, filed 3 each), `on: false`. Owner's call on record: CI runs on a worktree at HEAD, not the dirty main tree.
- [ ] 4.3 Post — rulings asked over `IDEAS/phone-ping.md`'s topic, a one-letter
      reply ruling; a new write path into `DECISIONS.md`, so its ruling first.
- [ ] 4.4 Review applied — `loop-review --ask`'s suggestions as a frame entry.

## Open questions

- ~~**Q1 — Can the shipped Basecamp reach `scripts/`?**~~ **Answered 2026-11-02 (`FJS-D1776`): A — V1 is local dev only: the job refuses with the same message the atlas screen gives when not offered.** In local dev the checkout
  is this repo and the route is only offered on `LOCAL_MACHINE`, so the scripts
  are beside it; the image installs none.
  - **A** — V1 is local dev only: the job refuses with the same message the
    atlas screen gives when not offered.
  - **B** — Move the three loop scripts under `packages/cli/core/` now, so a
    `fli loop` command can ship them.
  - **Recommend A** — the reopen path is named; moving the scripts is a ruling
    for the day a second machine needs them.
- ~~**Q2 — What counts as *due*?**~~ **Answered 2026-11-02 (`FJS-D1777`): A — A cron line per entry, read by the tick job; the owner writes the file.** A cron line per entry, or one nightly window.
  - **A** — A cron line per entry, read by the tick job; the owner writes the
    file.
  - **B** — One window (`after 22:00, before 07:00`) and the entries run in
    order inside it.
  - **Recommend A** — it is the shape every scheduler reader already knows and
    the window is one cron line.
- ~~**Q3 — V1 caps and their defaults.**~~ **Answered 2026-11-02 (`FJS-D1778`): B — No defaults: every cap set by hand before Turn On is offered.** Attempts/day, dollars/day, lanes, the
  severity floor for filed rows, the model ceiling.
  - **A** — 20 attempts, $20, 2 lanes, S3, Sonnet; Opus only by the ladder's
    second rung.
  - **B** — No defaults: every cap set by hand before Turn On is offered.
  - **Recommend B** — the toggle is refused until the owner has written each
    number once; a default is a number nobody chose.
- ~~**Q4 — Landing.**~~ **Answered 2026-11-02 (`FJS-D1779`): B — Patches stay on the Dock and the owner applies each with the lane tool.** What a closed row on the patch path becomes.
  - **A** — One commit per closed row on `autopilot/<day>`, from the patch,
    with the register edit in it; the owner merges.
  - **B** — Patches stay on the Dock and the owner applies each with the lane
    tool.
  - **Recommend A** — a branch is the thing a person reviews; a pile of patches
    is a chore.
- ~~**Q5 — Where an app says it may be run.**~~ **Answered 2026-11-02 (`FJS-D1780`): C — The apps listed by name under `stressors.apps` in `~/.fli/autopilot.json`; the check is `bun run check`, which every app has.** Forty plans in `../fjs-prototypes`,
  statuses free text, no two alike.
  - **A** — Frontmatter in the app's `PLAN.md`: `autopilot: on`, and the check
    script named beside it.
  - **B** — A `.project/autopilot.json` per app.
  - **C** — The apps listed by name under `stressors.apps` in
    `~/.fli/autopilot.json`; the check is `bun run check`, which every app
    has.
  - **Recommend C** — consent to spend and to boot an app is the machine
    owner's, beside the caps; A puts it in the file the session ticks, so the
    session could grant itself the run, and B is a second origin in forty
    repos. Reopen path: A, once apps should self-declare, the check still
    derived.
- ~~**Q6 — What an idea a step turns up becomes.**~~ **Answered 2026-11-02 (`FJS-D1781`): C — A `fli file --sev decision` question with options, `--area <app>`, so it sits in `fli decisions` under the filed-rows cap.** A stressor finds things that
  are neither a defect nor its own next box.
  - **A** — A new step at the end of the app's current phase, plus a
    `## Ideas found` list in its `PLAN.md`; promotion to `IDEAS/` is a
    person's.
  - **B** — A new `IDEAS/` paper per idea.
  - **C** — A `fli file --sev decision` question with options, `--area <app>`,
    so it sits in `fli decisions` under the filed-rows cap.
  - **Recommend C** — A lets the session grow its own work and moves the
    review gate; B gives every idea a paper and a lifecycle; C is the one sink
    the owner already reads. Reopen path: A as the list only, if questions
    swamp the council.
- ~~**Q7 — How a tap on the phone comes back.**~~ **Answered 2026-11-03 (`FJS-D1811`): A — The button POSTs `{id, letter}` to a reply topic, `<topic>-reply`, on the same ntfy server; the five-minute autopilot tick polls it outbound.** Workbench is LAN-only in local
  dev (`FJS-D1776`), so a phone off the LAN cannot reach it. ntfy's `http`
  action button POSTs from the phone to a URL; `GET /<topic>/json?poll=1&since=<id>`
  reads a topic's cache (docs.ntfy.sh, publish § Action buttons, subscribe § API).
  - **A** — The button POSTs `{id, letter}` to a reply topic, `<topic>-reply`,
    on the same ntfy server; the five-minute autopilot tick polls it outbound.
  - **B** — The button POSTs straight to Workbench's `POST /atlas/:id`.
  - **C** — The owner types the letter as a message into the topic.
  - **Recommend A** — outbound only, so it works with the laptop off the LAN
    and needs no second route; B dies off the LAN, and C is ambiguous with two
    asks open. Reopen path: B, the day a Workbench is reachable from outside.
- ~~**Q8 — What one tap may rule.**~~ **Answered 2026-11-03 (`FJS-D1812`): A — Only the recommended, unqualified letter is a button, beside **Open** (a `view` link to `/atlas/decide/`); any other question or pick stays at the bench.** `decide.js` refuses a pick against the
  recommendation, or a qualified one, without a reason, and a phone has no
  text box; ntfy shows at most three buttons.
  - **A** — Only the recommended, unqualified letter is a button, beside
    **Open** (a `view` link to `/atlas/decide/`); any other question or pick
    stays at the bench.
  - **B** — Every letter a button; a pick that needs a reason is parked until
    one is written.
  - **C** — Every letter rules, with the reason "ruled from the phone".
  - **Recommend A** — `decide`'s guard stays untouched, nothing half-ruled is
    stored, and C writes a reason nobody gave. The poll re-reads the
    recommendation from the paper; the tap carries only `{id, letter}`.
- ~~**Q9 — Which `DECISIONS.md` section a phone ruling goes under.**~~ **Answered 2026-11-03 (`FJS-D1813`): A — A `section` cap on the `post` schedule entry, checked against `rulingSections` when the file loads.** `decide`
  needs one and the phone has no picker.
  - **A** — A `section` cap on the `post` schedule entry, checked against
    `rulingSections` when the file loads.
  - **B** — Derived from the paper.
  - **C** — Whatever `/atlas/decide/` last remembered in the browser.
  - **Recommend A** — explicit and refused at load rather than at 3am; B
    guesses and C is a second origin in a browser. Reopen path: a per-question
    `section:` line in the paper.
- ~~**Q10 — Who can rule on public ntfy.sh.**~~ **Answered 2026-11-03 (`FJS-D1814`): A — Ruling buttons only on rung 1 (own server, token and ACL on both topics); rung 3 asks carry **Open** only.** On rung 3 the topic suffix is the
  read secret and the write secret at once (`push.ts`), so anyone who reads an
  ask can publish a ruling. This machine's Workbench runs on rung 3 (no
  `NTFY_BASE_URL`).
  - **A** — Ruling buttons only on rung 1 (own server, token and ACL on both
    topics); rung 3 asks carry **Open** only.
  - **B** — Rung 3 too, with a one-shot nonce per ask kept under `~/.fli`.
  - **C** — Rung 3 too; the suffix is the secret, as it is for the pings.
  - **Recommend A** — a nonce rides in the ask anyone reading the topic sees,
    so it stops only replays; a forged ruling is a binding record written by
    someone else. On this machine Post rings but cannot rule until
    `NTFY_BASE_URL` points at an own server (`push.awe.dev` on thod is one).
