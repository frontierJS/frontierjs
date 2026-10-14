---
id: workbench-plans
status: proposed
dated: 2026-10-13
---

# Idea — a plan run from the Workbench: Build, Go, Next

**Status: PROPOSED.** Item 4 of [`workbench.md`](workbench.md) (a check before
*done*) and the handoff it still does by hand. The Workbench runs a chat per
pinned checkout (`packages/basecamp/api/src/core/workbench.ts`); the argv is
`packages/cli/core/ask-claude.js`. A plan's shape is ruled (`FJS-D927`,
`doc-hygiene` § A plan's shape).

## The flow this replaces

Today a plan is carried out by hand: say *Go*, the session does a phase, a
question or a defect comes up, and the owner COPIES THE LAST OUTPUT, clears the
session, pastes it into a new one and says *Go* on the next step. The paste is
the handoff, and it is the one part nothing records.

## What already exists

- A chat per Claude Code session, `fresh` (a new chat, no session), Fork (a
  worktree of its own), Review (a read-only session over the tree), Check
  (`fli done`, started on its own whenever a run ends with nothing queued), the
  Diff tab, a queue, Stop, and cost per run.
- `fli file --sev S3|decision` files a defect or a question; `fli decide` rules
  on one; `fli decisions` lists what waits on the owner.
- `askArgv({ edit, reads })` is a read-only session allowed to edit ONE path —
  the mode `fli edit` runs in.
- The `fix-next` skill already states the guardrails a step needs: say what you
  are doing before doing it, stop at a judgment call, file the question, undo
  the half-built edits.

## The design

**The plan file is the handoff.** The shape already puts what a step found
indented under the step, ticks its box, and ends a phase with a `Done <date>.`
paragraph. A step prompt that makes the session write those at the end of
every step makes the paste unnecessary: *Next* is a fresh chat told to read the
plan, where the next step is the first open box. The position is derived from
the boxes and written nowhere else (`FJS-D927`).

**Three buttons, no new noun.** *Build plan*, *Go*, *Next*. Plan, Phase, Step
and Question (`Q1`) are the ruled words; nothing here is an orchestrator or a
runner — it is the Workbench sending a message it composed.

- **Build plan** — the owner types a goal and a path. The session runs in the
  `edit` mode of `askArgv` with that path as the one editable file, so it can
  read the checkout and cannot start building. The prompt carries the goal,
  § A plan's shape, and the instruction to read the package `CLAUDE.md` and the
  realm hazards before writing Phase 0.
- **Go** — sends the step prompt for the first open box into the shown chat.
  The prompt: do ONLY this step; a judgment call runs `decision-rules`, files
  the question with `fli file --sev decision`, undoes edits to source files and
  stops; a defect found on the way is `fli file --sev S3`; finish by editing the
  plan — tick the box, findings under it, the `Done` paragraph when the phase
  ends; commit nothing. The pin records `{ chat, startedAt, registerHigh }` for
  the step, where `registerHigh` is the highest `FJS-###` and `FJS-D##` at the
  start, so every row above it afterwards is what the step filed.
- **Next** — `fresh()` then `send(handoff)`, where the handoff is the plan's
  path and the last run's result text (capped). Refused while a run is live or
  while a `Q` is unruled, so the handoff carries no open question; a ruled one
  is struck in the plan the session reads first.
- **The tab** — phases as sections, steps with their boxes, the current one
  marked, a spinner while its run is live, cost per step off the chat's fold,
  the rows it filed, and the open questions with the letters to answer them.
  A box the session did not move is shown as such with a manual tick, which
  is the one case the UI writes the file.
- **Sequential only.** A wave is Fork by hand.

**Where the pieces live.** The parser is `packages/cli/core/plan.js` with a
`fli plan <file> --json` command, so the UI and a test read the same thing. The
three prompts sit beside `reviewPrompt` in `ask-claude.js`, versioned and
tested rather than inlined in a `.mesa`. The Workbench imports both the way it
imports `ask-claude.js` today, and `core/file.js` for the forms.

## Plan

### Phase 0 — Groundwork

Goal: the parser and the prompts exist and are proved without a screen.
Done when: `fli plan <file> --json` prints phases, steps, boxes, the first open
step and the `Q` bullets of the example in `doc-hygiene`, and the prompt tests
pass.

- [x] 0.1 Rule Q1–Q4 below with `fli decide`.
  - `FJS-D966`–`FJS-D969`, all A.
- [x] 0.2 `packages/cli/core/plan.js` — parse `### Phase N — title`, `Goal:`,
  `Done when:`, `- [ ] N.M`, `[x]`, `[~]`, `2.3a`, the indented findings, the
  `Done <date>.` paragraph and `Q` bullets with their options; `fli plan`
  prints it; a test over the skill's example.
  - The `Q` bullets are read by `decisions.js`'s `paperQuestions`, lifted out
    of `ideaQuestions` so a plan and a paper share one parse.
  - `fli plan` took the `plan` alias off `deploy:plan`, which nothing in prose
    used and whose own examples spell `fli deploy:plan`.
  - A wrapped line under a step continues its TITLE until the first note; a
    markdown-wrapped step read as a finding before that.
  - `core/plan.js` and `test/plan.test.js` were the deploy journal's transition
    plan, and the first write replaced them. They are `deploy-plan.js` and
    `deploy-plan.test.js` now, named for `fli deploy:plan` and its `deployPlan`,
    and `plan.js` is the Phases-of-Steps plan `fli plan` reads.
- [x] 0.3 `buildPlanPrompt()`, `stepPrompt()` and `nextHandoff()` beside
  `reviewPrompt` in `ask-claude.js`, each with a test that the guardrail
  sentences are present.
  - `nextHandoff` is the read line, the last reply capped at `HANDOFF_MAX`,
    the unruled `Q`s, then `stepPrompt` — so Go and Next share one set of
    step rules.

**Done 2026-10-13.** The parser and the prompts exist without a screen;
`fli plan IDEAS/workbench-plans.md` reads this paper and names 1.1 as next.

### Phase 1 — Build plan

Goal: a goal typed in the tab becomes a plan file the tab renders.
Done when: a one-line goal against `example/` produces a plan at the given
path that `fli plan` parses, shown in a Plan tab.

- [x] 1.1 The pin carries `plan: { path, steps } | null`; the service gains
  `plan` (read + parse) and `buildPlan`.
  - `steps` is `Record<stepId, { chat, startedAt, registerHigh }>` (`PlanStep`),
    typed now and empty until 2.1 writes it; a Build plan resets it.
  - `plan` parses the file through `parsePlan` on every read, never cached;
    `parsed` is null until the session has written it. No plan is a 404.
  - `buildPlan { goal, path }` refuses no goal, a path outside the checkout or
    not `.md`, and any live run in the checkout; it opens a new chat (`fresh`)
    and runs there with `askArgv({ edit: <abs path> })`.
  - `askArgv`'s `edit` scoped a DIRECTORY only (`Edit(<p>/**)`), which grants
    nothing on a file. It now emits `Edit(<p>)` and `Edit(<p>/**)` — no new
    option (`decision-rules`: C over an `editFile` key or a stat). Measured with
    a real `claude -p`: the plan file landed, a Write beside it was denied.
  - For 1.2: edit mode runs at `ASK_BUDGET_USD` ($2) with every setting source
    dropped, so no `CLAUDE.md` loads unasked and no skill is offered — the
    prompt's reads are by `Read`. A real build against `example/` is what says
    whether $2 is enough. The run's follow-ups fire as after any run: `fli done`,
    and a review where the pin asks for one.
  - Red and not this step's: basecamp typecheck 13 against a baseline of 12, and
    `db/schema.d.ts` / generated-migration tests — the dirty litestone parser.
- [x] 1.2 The Build plan form: goal, path with the default for the checkout
  (`IDEAS/<slug>.md` where `IDEAS/` exists, else `PLAN.md`), runs `askArgv`
  in edit mode on that path.
  - The form IS the Plan tab while the pin has no plan, and *New plan* opens it
    again over one. The pins answer carries `hasIdeas` (beside `checkable`); the
    slug is toolbelt's `slug(goal, { max: 48 })`, and the path follows the goal
    until it is typed in.
  - The drive is `verify:provision` § The Plan tab, on a checkout of its own so
    the plan chat and file reach nothing the preview cuts. Its stand-in claude
    writes a fixture plan to the path the prompt names and records its argv:
    the rule is `Edit(//<abs path>)` — Claude Code's absolute form — and the
    mode is `dontAsk`, never `bypassPermissions`.
- [x] 1.3 The Plan tab renders phases, steps and boxes, the first open box
  marked.
  - Reread whenever the card's rev moves while the tab shows, so a box ticked
    mid-run is drawn. `next` is `aria-current="step"` with a *next* badge, the
    tab reads `Plan · <id>` (`Plan ✓` with no open box), findings fold under
    their step, a dropped step is struck with its reason, and the unruled `Q`s
    are a warning callout — answering them is 4.3.
  - Red and not this step's: `verify:provision` stops at *Start app put no port
    on the card* in the Run tab, three runs of three (`FJS-2831`).
  - Phase 1's *Done when* — a real build against `example/` — is not run: it
    spends up to `ASK_BUDGET_USD` and is the owner's to start.

### Phase 2 — Go

Goal: a step runs in the shown chat and the file shows it ran.
Done when: two Go's in a row each advance the box with findings under it.

- [x] 2.1 Go = `send(stepPrompt(plan, next))`; the step's
  `{ chat, startedAt, registerHigh }` on the pin.
  - `go` refuses while ANY run in the checkout is live rather than queueing
    like `send`: the marks are read when the step starts, and a queued Go would
    read them under a run still filing and hand its rows to the step. It also
    refuses no plan, an unwritten file and a plan with no open box.
  - The marks are fli's `registerHigh(root)` in `core/file.js`, beside `nextId`
    and `nextDecisionNumber` — `{ issue: 0, decision: 0 }` for a checkout
    declaring no registers. They are read before the send and the step is
    written onto the pin only after it, so a refused send records nothing.
  - The tab's *next* step carries a **Go** button, held while a run is live;
    a recorded step shows *Started <time>*. The drive's stand-in claude ticks
    the box a step prompt names, so `verify:provision` § The Plan tab sees
    `0.2` go from open to done and the tab read `Plan ✓`.
  - Red and not this step's: as at 1.3 — `FJS-2831`, basecamp typecheck 13 of
    12, `db/schema.d.ts` and the generated-migration test; in cli, `ask.test`
    (a citation now `FJS-D909`) and `signatures.test` (`bearerClaim`'s return
    type), both other sessions' edits.
- [x] 2.2 After the run: reparse; a box that did not move is shown with a
  manual tick.
  - The reparse was already there (1.3 rereads on the card's rev). A step is
    *left open* when Go recorded it, its box is still `[ ]` and no run is live
    — the line reads *The run ended and the box is still open* with **Tick**.
  - Tick is `tick { step }`, a 409 on refusal: no plan, a step Go did not
    start (so the tab writes no other box), a live run (the session may still
    tick it), or a box that is not open. The write is fli's `tickStep(text, id)`
    in `core/plan.js`, at the parser's own line, so a step quoted in a fence is
    never the one ticked. No finding is written under the step.
  - `verify:provision` § The Plan tab gains a step `0.4` the stand-in leaves
    open: no tick while its run is live, the line and Tick once it ends, then
    the file reads `- [x] 0.4` and the tab `Plan ✓`. 16/16; the run is 147/148,
    the one red `FJS-2831` as before.
- [x] 2.3 Cost per step off the chat fold.
  - A step's cost is every run in its chat from its Go up to the next Go in
    that chat, so the owner's answer to a step that stopped on a question is
    the step's too. Summed on read in `readPlan` (`PlanStepRead`), never stored
    on the pin; null until a run finishes, and null once the chat is closed and
    its log gone.
  - The fold keeps `runs: { at, cost, turns }[]` whole beside `byDay`, because
    `items` drops the oldest past `MAX_ITEMS` and a long step chat would lose
    its first result.
  - The tab's *Started* line ends `· $0.42 · 3 turns`. `decision-rules` ran
    BEFORE the edit this time: all nine pass, no adjudication in tension.
  - `workbench.test.ts` 38/38 (one new: Build plan's run excluded, a follow-up
    counted, the next Go's run excluded, a closed chat null).
    `verify:provision` § The Plan tab 17/17 (one new); the run 148/149, the one
    red `FJS-2831` as before. Basecamp typecheck 13 against 12, none in
    workbench files.
  - Phase 2's *Done when* — two real Go's in a row — is not run: it spends
    real sessions and is the owner's to start. The drive runs two against the
    stand-in.

### Phase 3 — Next

Goal: the handoff is composed, not pasted.
Done when: a three-step plan runs through three fresh sessions with nothing
copied by hand.

- [x] 3.1 Next = `fresh()` + `send(nextHandoff)`; the handoff is the plan path,
  the last result text capped, and the open `Q` bullets.
  - The last result is the final `text` item of the checkout's LATEST run
    (`chatsOf(p).latest`, the chat Review already reads its request from),
    after that run's prompt — not the shown chat, and not every text of the
    run, whose earlier lines are narration. `nextHandoff` caps it.
  - `go` and `next` share `nextStep` (the refusals and the step) and
    `startStep` (marks read, send, step written only after the send), so a
    Next is recorded on the pin exactly as a Go is, with its NEW chat. Next
    refuses a live run for Go's reason, before `fresh()`, so a refusal leaves
    no empty chat behind; the question block is 3.2's.
  - The tab's *next* step carries **Next** beside **Go**. The drive's stand-in
    reads `Carry out step` on any line, so Next's handoff is ticked like a Go.
  - `workbench.test.ts` 39/39 (one new: refused live, a new chat with no
    `--resume`, the last reply, the unruled `Q` and not the ruled one, the
    step recorded with its cost). `verify:provision` § The Plan tab 19/19
    (two new: Next opens and shows a chat; the handoff's four parts). The
    whole run was 206/206 on 7120/7020 — `FJS-2831` did not reproduce this
    time. Basecamp typecheck 13 against 12, none in workbench files.
  - `decision-rules` ran before the edit: all nine pass, no adjudication in
    tension; the design is the paper's (`FJS-D967`).
- [x] 3.2 Next is refused while a run is live or a question blocks.
  - A question blocks when it is unruled — `parsePlan`'s `blocking`, which the
    tab's callout and `fli plan`'s *blocked by* already read; no second rule.
    `next` refuses on it after `nextStep` and before `fresh()`, naming the
    first question, so a refusal opens no chat. Go is not refused on it: 3.2
    names Next, and whether Go should be is the owner's.
  - With Next refused on any unruled `Q`, the handoff's open-question block
    could never be filled, so `nextHandoff` lost it and its `questions`
    option; § The design is amended to match. `decision-rules` ran before the
    edit: all nine pass, no adjudication in tension.
  - The tab holds **Next** while `blocking` is non-empty, its title naming the
    question. The tab rereads the plan on opening and on the card's rev, so a
    `Q` ruled from a terminal while the checkout is idle shows on the next
    open — 4.3 rules it from the tab.
  - `workbench.test.ts` 39/39 (the Next test: refused with Q1 open, no chat,
    no step; struck, then started with no question in the handoff).
    `vite-ask.test.js` 72/72. `verify:provision` 208/208 on 7120/7020 (two
    new: Next held with the question in its title; the API's 409 opens no
    chat). Basecamp typecheck 13 against 12, none in workbench files.
  - Phase 3's *Done when* — three real fresh sessions — is not run: it spends
    real sessions and is the owner's to start.

### Phase 4 — The registers in the tab

Goal: what a step filed, and what blocks it, is answered where it is seen.
Done when: a step that stops on a question shows it, the owner answers with a
letter in the tab, and Next resumes.

- [x] 4.1 The register delta per step, as rows.
  - The rows are fli's `filedSince(root, spans)` in `core/file.js`, beside
    `registerHigh`: one register read for every step, each span from a step's
    marks to the next step's by `startedAt` (in any chat), none above the last.
    A `D` id is one row — the ruling where `decide` answered under it, else its
    § Needs a decision row. `readPlan` puts them on `PlanStepRead` as `filed`;
    nothing is stored on the pin.
  - Attribution is by NUMBER, not author: a row another session files in the
    checkout while a step runs, or a paper `Q` the owner rules between steps
    (which mints a `D` id), lands on the step before it. 4.3's letter will do
    the second — it reads as the ruling of the step whose question it answers.
  - The tab draws them under *Started*: id, a badge (the severity, `question`
    in warning while unruled, `ruling`), the title, `file:line` in its tooltip.
  - `readPlan` now reads the registers whenever the plan has steps — ~0.4s on
    this repo, on every reread and on Go/Next through `nextStep`.
  - `file.test.js` 9/9 (two new: the span between two marks and above the
    last; a root with no registers). `workbench.test.ts` 39/39 (the Go test:
    a row above 0.2's marks is 0.2's, one filed after 0.3 started is 0.3's).
    `verify:provision` 210/210 on 7120/7020 (two new: 0.2 draws the question
    then the defect and not the row filed before it; 0.4 filed nothing).
    Basecamp typecheck 13 against 12, none in workbench files.
  - `decision-rules` ran before the edit: all nine pass, no adjudication in
    tension.
- [x] 4.2 File issue / Ask question forms → `fileIssue` from `core/file.js`.
  - `file { severity, area, title, detail }` on the workbench is fli's
    `fileIssue` over the pin's checkout, under its register guard; severity
    `decision` is Ask question. A refusal is fileIssue's own reason as a 400
    (no `registers.prefix`, no `## S2` table, a severity it does not name).
  - Not refused while a run is live: the guard and `register:check` already
    keep two writers off one id, and by number a row filed mid-step is that
    step's — the owner's own report on what the step is doing.
  - The tab's header carries **File issue** and **Ask question** beside New
    plan; each opens a form (severity S1–S4 for an issue, then area, title or
    question, detail), held until all are written. A filing names its id and
    `file:line`, and the plan reread draws it under the last step started. A
    refused one keeps the form as typed, its reason in the banner.
  - An asked question is a § Needs a decision row, not a plan `Q`: it does not
    hold Next, which reads `blocking` off the plan file (3.2). Whether it
    should is 4.3's to meet.
  - The severity list S1–S4 is restated in the tab; a wrong one is refused by
    fileIssue rather than drifting silently.
  - `workbench.test.ts` 40/40 (one new: no prefix refused; an issue and a
    question filed while 0.2 runs land on 0.2, questions first; a bad
    severity and a blank area refused). `verify:provision` 216/216 on
    7120/7020 (six new: the held button, a refused S2 keeping the form, the
    row in ISSUES.md with its note, Ask with no severity, both rows under
    0.4, the API's 400). Basecamp typecheck 13 against 12, none in workbench
    files.
  - `decision-rules` ran before the edit: all nine pass; *paved road* (one
    writer, `fileIssue`) holds, no adjudication in tension.
- [x] 4.3 A letter on a `Q` → `fli decide`, which unblocks Next.
  - `decide` found a question only through `readDecisions` — `IDEAS/` papers
    and § Needs a decision rows — so a plan at an app's `PLAN.md` could not be
    ruled at all, from the tab or a terminal. `decide`/`settle` gain `file`
    (`fli decide … --file <path>`): the id is looked up in that one file
    through `paperQuestions`, the parse `parsePlan` uses, so the id the tab
    shows is the id answered. `fli plan` now prints each unruled `Q`'s id.
  - `decide { question, pick, why, section }` on the workbench is fli's
    `decide` with the plan as `file`, a refusal its own reason as a 400.
    Refused while a run is live: the strike rewrites the plan file the
    session may be writing. `plan` carries the checkout's ruling `sections`.
  - The callout draws each decidable `Q`'s letters, the recommendation
    badged; a letter opens Section (none chosen, the last one offered after a
    ruling) and Why, required exactly where `decide` would refuse without
    one. Another letter keeps what was typed. A `Q` with no options says to
    write them in the plan. Rule draws *Ruled <id>*, the question leaves the
    callout, and Next is no longer held.
  - By number the ruling is the step's whose question it answers (4.1's
    prediction, now asserted in both the test and the drive).
  - 4.2's open point: an asked question (a § Needs a decision row) does not
    hold Next. Next's one rule is the plan's `blocking` (3.2), and a row has
    no letters to answer it by here; a row that should hold the plan is a `Q`
    written into it.
  - `decisions.test.js` 2 new (a `PLAN.md` `Q` refused without `file` and
    ruled and settled with it; a path outside the root, not markdown, absent).
    `plan.test.js` asserts the printed id. `workbench.test.ts` 40/40 (the Next
    test rules `Q1` through `decide`: refused live, against the
    recommendation, an unknown section; then ruled, struck, refused again,
    drawn under 0.2, and Next starts). `verify:provision` 223/223 on
    7120/7020 (seven new). Basecamp typecheck 13 against 12, none in
    workbench files.
  - `decision-rules` ran before the first edit: all nine pass; *paved road*
    (`decide` widened to reach a plan, no strike written beside it), tier Map.

**Done 2026-10-14.** A step's filed rows draw under it, File issue and Ask
question write through `fileIssue`, and a letter on a `Q` rules it through
`decide` and lifts Next's hold — `verify:provision` § The Plan tab runs that
against the stand-in. Phase 4's *Done when* with a real session is the
owner's to start.

### Phase 5 — Later

- [x] 5.1 Several plans per pin.
  - The pin's `plan: { path, steps } | null` is `plans: { path, steps }[]` and
    `plan: path | null`, the shown one — the shape of `chats` and `chat`. Go,
    Next, tick and decide act on the shown plan; a step is recorded on the
    plan it started in, by path, whatever is shown when the send returns.
  - `openPlan { path }` shows a plan on the pin, or adds a file already
    written (refused where nothing is, Build plan being how one is made);
    `closePlan { path }` forgets it and its steps here, the file kept, the
    shown one passing to its neighbor; refused while a run is live, since the
    step running may be one of its. Build plan at a path already on the pin
    starts that plan over. A path is keyed normalized, so `./PLAN.md` is
    `PLAN.md`.
  - A step's filed rows and its cost stop at the next step of ANY plan: the
    registers and the chats are the checkout's, so stopping at the next step
    of the same plan would hand one plan's rows to another.
  - The tab: a Plan picker once there are two, Open plan (a path) and Close
    plan beside New plan.
  - No live pin held a plan, so nothing on disk needed moving.
  - `workbench.test.ts` 41/41 (one new: open refusals, Go on each plan, the
    cross-plan span in rows and cost, tick on the shown file only, close).
    `verify:provision` 227/227 on 7120/7020 (four new). Basecamp typecheck
    13 against 12, unchanged, none in workbench files. `surface.snapshot.md`
    regenerated.
  - `decision-rules` ran before the first edit: all nine pass — the shown
    path is a reference into `plans`, not a copy (1, 5); no new noun (2);
    `chats`/`chat` is the sibling it mirrors (4); the cross-plan span is the
    silent wrong answer, asserted in the test (9). *Preservation vs.
    evolution*: `plan` changes meaning with no alias. Tier Map.
- [x] 5.2 A *needs you* notification (item 3 of `workbench.md`).
  - A step that hits a judgment call writes a `Q` into the plan and stops
    (`STEP_RULES`), so *the run ended on a question* is already written down:
    it is the plan's `blocking`. No guess from the reply's last line, and
    nothing stored. Every status carries `questions` — `{ plan, id, question }`
    for each unruled `Q` on every plan on the pin, the shown one or not —
    parsed per file and kept until its mtime and size move, since the poll
    reads every pin.
  - It is apart from *unread*: seeing the chat clears `new`, and only a
    ruling (or the `Q` leaving the file) clears *needs you*. While a run is
    working the card says working instead.
  - The tab: a warning dot and a **needs you · N** button in the place of
    `new`, which opens the Plan tab on the plan holding the first question; a
    warning badge on a docked tile; `? N ·` in the tab title, counted apart
    from `(N)`; the browser notification says *needs you* and the question
    rather than *done*; Alt+J and Next waiting take a question before the
    oldest unread finish.
  - `workbench.test.ts` 41/41 (two tests extended: the question on the
    status, kept after `seen` and gone after the ruling; a `Q` on a plan not
    shown, gone with Close plan). `verify:provision` on 7120/7020: the six
    new checks pass (badge and title text, the notification, the tab title,
    kept after a look, opening the Plan tab, gone after Rule), 177/178 —
    the Run tab's Start app failed because port 8000 was held by another
    session's Haven Vite, so the checks after it did not run. Basecamp
    typecheck 13 against 12, unchanged, none in workbench files.
  - `decision-rules` ran before the first edit: all nine pass — one origin
    (the plan file's `blocking`, `parsePlan` the owner Next already reads);
    no new noun (*Question* is ruled, *needs you* is the paper's label);
    it mirrors `unread`'s dot, badge, title and notification (4); derived,
    never stored (5); a `Q` left standing that the card stops showing is
    the silent wrong answer, asserted in the test and the drive (9). No
    adjudication in tension. Tier Map.
- [x] 5.3 A commit affordance off the Diff tab.
  - `commit { message, files: [{ path, blob }] }` on the workbench. Every
    diff file carries `blob`, the object id of what the tree held when read
    (null where it is gone); a file whose id has moved by the commit is
    refused by name — the tree is shared, so it could hold lines nobody saw.
    `git commit --only -- <paths>`, untracked ones added first and unstaged
    again if the commit is refused: what another session staged stays
    staged and uncommitted, and the checkout's own commit hooks run, their
    refusal the answer. Refused on a branch (Land, then commit on its
    checkout: one way out) and while a run is live.
  - The tab: a box on each file's line, every listed file chosen until it is
    unticked; a box over them (mixed when some are), the message, and
    **Commit N files**, held without a message, a file, or while working.
    The notice names the short sha; the diff and the card's count read again.
  - Which files a run wrote is not chosen for the owner: the diff cannot
    separate a run's edits from another session's, so the default is every
    file listed and the boxes are the choice.
  - `workbench.test.ts` 42/42 (one new: refusals for no message, no files, a
    path with nothing to commit, a bare path; a file written after the read;
    a pre-commit hook refusing, the untracked file untracked again; then the
    commit — the message, the three files, the staged file still staged and
    the unchosen one untracked; a branch refused). `verify:provision`
    238/238 on 7120/7020 (five new, and 5.2's run through to the end now that
    8000 is free). Basecamp typecheck 13 against 12, unchanged, none in
    workbench files. `surface.snapshot.md` regenerated.
  - `decision-rules` ran before the first edit: all nine pass — git is the
    origin, `blob` derived on each read (1, 5); no new noun (2); refusals
    shaped as Land's (4); the git calls beside `readDiff` in the diff
    panel's module, `fli git:commit` being a TTY prompt and no owner to
    reuse (6); committing unseen lines or another session's staging is the
    silent wrong answer, asserted in the test and the drive (9). *Paved
    road*: `FJS-D968` names this as the one way a step's work is committed.
    Tier Map.
- [ ] 5.4 Build plan in the ask panel (`vite-ask-client.js`) — a *Make a plan*
  button beside the pick, because a pick is an element on the page and a new
  feature has none to select.

## Open questions (owner)

- ~~**Q1 — Where does a plan live?**~~ **Answered 2026-10-14 (`FJS-D966`): A — a markdown file in the checkout, at a path the owner gives: `IDEAS/<slug>.md` in this repo, `PLAN.md` at an app's root.**
  - **A** — a markdown file in the checkout, at a path the owner gives:
    `IDEAS/<slug>.md` in this repo, `PLAN.md` at an app's root.
  - **B** — a file under `WORKBENCH_DIR`, beside the pin's logs.
  - **Recommend A** — the session edits it natively, it diffs and commits with
    the work, and a plan already is a file in this repo.
- ~~**Q2 — What is Next: a fresh session, or a fork of the last one?**~~ **Answered 2026-10-14 (`FJS-D967`): A — a fresh chat; the plan file is the carry.**
  - **A** — a fresh chat; the plan file is the carry.
  - **B** — `--fork-session`, which keeps the context and its cost.
  - **Recommend A** — a fresh session is the flow being replaced, and Fork
    stays as the escape hatch when the context is worth paying for.
- ~~**Q3 — Does a step commit?**~~ **Answered 2026-10-14 (`FJS-D968`): A — never; the step prompt says so, and the owner commits off the Diff tab.**
  - **A** — never; the step prompt says so, and the owner commits off the Diff
    tab.
  - **B** — a pin option, *commit each step*.
  - **Recommend A** — no option, and it matches the rule that a session commits
    only when asked.
- ~~**Q4 — Who ticks the box?**~~ **Answered 2026-10-14 (`FJS-D969`): A — the session, by instruction; the UI reparses and offers a manual tick when the box did not move.**
  - **A** — the session, by instruction; the UI reparses and offers a manual
    tick when the box did not move.
  - **B** — the UI, on the result event.
  - **Recommend A** — the findings under the step need the session anyway, and
    a box the UI ticks can tick a step that was not done.
