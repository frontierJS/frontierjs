// ─── plan-prompt.js — what a plan run says to Claude ────────────────────────
//
// The words of the three plan buttons (`IDEAS/shipped/workbench-plans.md`):
// Build plan, Go and Next. `plan.js` owns the format these sentences describe;
// `@frontierjs/claude` owns how the session is started and reads none of this.
//
// The plan FILE is the handoff: a step ends by writing what it found under its
// box, so Next is a fresh session told to read the file. The sentences are
// constants because the test asserts each guardrail is still in the prompt — a
// prompt that loses *do only this step* runs the whole plan in one session,
// which is the flow this replaces.

/** The ruled shape (`FJS-D927`), as the builder is told it. */
export const PLAN_SHAPE = [
  'A plan is Phases of Steps. A phase is a `### Phase N — title` heading, counting from 0: Phase 0 is the groundwork — scaffolding, measuring the original, reading the source.',
  'Under each phase heading: a `Goal:` line, the outcome in one sentence, and a `Done when:` line naming the command, drive or measurement that proves it. Every phase ends in something checkable.',
  'A step is `- [ ] N.M title`, about one commit of work, cited `2.3`. A number is issued once and never reused: a step inserted later is `2.3a`, new work goes at the end.',
  'Open questions the owner must rule on go under `## Open questions (owner)` as `- **Q1 — the question?**` bullets, each with lettered `- **A** — …` options and a `- **Recommend A** — why` line. Do not answer them.',
  'Frontmatter: `id:` (the file name without `.md`), `status: proposed`, `dated:` today.',
].join('\n\n')

export const BUILD_PLAN_RULES = [
  'You are writing a plan, not carrying it out. Build nothing, edit no source file; the one file you write is the plan.',
  'Each step names the files it touches and the test or drive that proves it. A step that cannot name its proof is not a step yet.',
].join('\n\n')

// What to read before Phase 0. A checkout of this workspace has its packages'
// CLAUDE.md, the realm skills and DECISIONS.md; an app asked from the page has
// none of them and may not read its own root, so it reads the guides and the
// schema — sent after the other, it spends its turns on denied reads.
export const PLAN_READ_REPO = 'Before writing Phase 0, read the `CLAUDE.md` of each package the goal touches and the realm hazards skill under `.claude/skills/` that covers it, and check `DECISIONS.md` for a ruling that already settles part of the goal.'
export const PLAN_READ_APP  = 'Before writing Phase 0, read `db/schema.lite` and the guide below for each package the goal touches. Nothing else outside the Vite root is readable here, so do not look for one.'

/** Build plan: the goal, the shape, and the one path the session may write.
 *  From the ask panel it also carries the framework guides an app reads in
 *  place of this repo's skills — a list, even an empty one, is the app's
 *  case — and the page it was asked from. */
export function buildPlanPrompt({ goal, path, page = null, guides = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const asked = String(goal ?? '').trim().slice(0, 8000)
  return [
    `Write a plan at \`${path}\` for the goal below. Today is ${today}.`,
    BUILD_PLAN_RULES,
    guides ? PLAN_READ_APP : PLAN_READ_REPO,
    PLAN_SHAPE,
    guides?.length ? guideList(guides) : null,
    page ? `Asked from the page: ${String(page).slice(0, 300)}` : null,
    `The goal:\n\n${asked}`,
  ].filter(Boolean).join('\n\n')
}

/** The framework guides an app reads in place of this repo's skills, one line each. */
export const guideList = guides => ['The framework this app is built on, one guide per package — read the one a change touches before you make it, and follow it over the habits of other frameworks:', ...guides.map(g => `- ${g.file} — ${g.about}`)].join('\n')

export const STEP_RULES = [
  'Say the step\'s id and title before doing anything else.',
  'Do ONLY this step. Do not start the next one, however small it looks; the owner says Go for each.',
  'A judgment call — an option, a flag, a new noun, a choice between two designs — runs the `decision-rules` skill. Where a genuine choice is left, undo your edits to source files, write the question as the next `Q` bullet under the plan\'s `## Open questions (owner)` with lettered options and a recommendation, and stop: the session\'s job ends at the question.',
  'A defect you find that this step does not fix is filed with `fli file --sev S3 --area <package> --title "…" --detail "…"` and left alone.',
  'Commit nothing. The owner commits.',
  'Run `fli done` before calling the step finished, and clear what it lists or say in a sentence why an item stays.',
  'Finish by editing the plan: tick the box to `[x]`, write what the step found as bullets indented under it, and when this was the phase\'s last open box add the phase\'s `**Done <date>.**` paragraph after its steps. A step that should not be done is `[~]` with ` — dropped: why` after its title.',
  'Reply in a few lines: what the step found, what the next step is, and anything the owner must decide. The reply is handed to the next session.',
].join('\n\n')

/** Go: one step of the plan, in a session that may already hold the plan's context. */
export function stepPrompt({ path, step, phase = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const where = phase ? `Phase ${phase.n}${phase.title ? ` — ${phase.title}` : ''}${phase.doneWhen ? `, done when: ${phase.doneWhen}` : ''}` : null
  return [
    `Carry out step ${step.id} of the plan at \`${path}\`: ${step.title}${where ? `\n(${where})` : ''}. Today is ${today}.`,
    STEP_RULES,
  ].join('\n\n')
}

export const HANDOFF_MAX = 4000

/** Next: a fresh session handed the plan and the last reply, then the step.
 *  No open questions: Next is refused while one is unruled, and a ruled one
 *  is struck in the plan the session reads first. */
export function nextHandoff({ path, step, phase = null, lastResult = '', today } = {}) {
  const tail = String(lastResult ?? '').trim()
  return [
    `This is a fresh session continuing the plan at \`${path}\`. Read it first: the next step is the first open box, and what earlier steps found is written under their boxes.`,
    tail ? `The last session's reply:\n\n${tail.length > HANDOFF_MAX ? '…' + tail.slice(-HANDOFF_MAX) : tail}` : null,
    stepPrompt({ path, step, phase, today }),
  ].filter(Boolean).join('\n\n')
}
