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
  path, the last run's result text (capped), and the open `Q` bullets. Refused
  while a run is live or while a question blocks.
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

- [ ] 1.1 The pin carries `plan: { path, steps } | null`; the service gains
  `plan` (read + parse) and `buildPlan`.
- [ ] 1.2 The Build plan form: goal, path with the default for the checkout
  (`IDEAS/<slug>.md` where `IDEAS/` exists, else `PLAN.md`), runs `askArgv`
  in edit mode on that path.
- [ ] 1.3 The Plan tab renders phases, steps and boxes, the first open box
  marked.

### Phase 2 — Go

Goal: a step runs in the shown chat and the file shows it ran.
Done when: two Go's in a row each advance the box with findings under it.

- [ ] 2.1 Go = `send(stepPrompt(plan, next))`; the step's
  `{ chat, startedAt, registerHigh }` on the pin.
- [ ] 2.2 After the run: reparse; a box that did not move is shown with a
  manual tick.
- [ ] 2.3 Cost per step off the chat fold.

### Phase 3 — Next

Goal: the handoff is composed, not pasted.
Done when: a three-step plan runs through three fresh sessions with nothing
copied by hand.

- [ ] 3.1 Next = `fresh()` + `send(nextHandoff)`; the handoff is the plan path,
  the last result text capped, and the open `Q` bullets.
- [ ] 3.2 Next is refused while a run is live or a question blocks.

### Phase 4 — The registers in the tab

Goal: what a step filed, and what blocks it, is answered where it is seen.
Done when: a step that stops on a question shows it, the owner answers with a
letter in the tab, and Next resumes.

- [ ] 4.1 The register delta per step, as rows.
- [ ] 4.2 File issue / Ask question forms → `fileIssue` from `core/file.js`.
- [ ] 4.3 A letter on a `Q` → `fli decide`, which unblocks Next.

### Phase 5 — Later

- [ ] 5.1 Several plans per pin.
- [ ] 5.2 A *needs you* notification (item 3 of `workbench.md`).
- [ ] 5.3 A commit affordance off the Diff tab.

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
