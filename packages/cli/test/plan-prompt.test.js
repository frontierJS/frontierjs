// ─── plan-prompt.test.js — what a plan run says ───────────────────────────
//
// Each guardrail is a sentence the prompt must keep: losing *do only this step*
// runs the plan in one session, losing *commit nothing* commits for the owner.
// And the shape the build prompt asks for is the shape `plan.js` reads.

import { describe, test, expect } from 'bun:test'

import { parsePlan } from '../core/plan.js'
import { PLAN_SHAPE, buildPlanPrompt, stepPrompt, nextHandoff, HANDOFF_MAX, PLAN_READ_APP, PLAN_READ_REPO } from '../core/plan-prompt.js'

describe('plan prompts', () => {
  const step  = { id: '2.2', title: 'Rotate and flip', box: 'open', phase: '2' }
  const phase = { n: '2', title: 'Writes to pixels', doneWhen: 'the drive is green' }

  test('buildPlanPrompt names the one path, forbids building, and states the shape', () => {
    const p = buildPlanPrompt({ goal: 'crop images', path: 'IDEAS/crop.md', today: '2026-10-13' })
    expect(p).toContain('Write a plan at `IDEAS/crop.md`')
    expect(p).toContain('Build nothing, edit no source file')
    expect(p).toContain('counting from 0')
    expect(p).toContain('`Done when:`')
    expect(p).toContain('- **Recommend A** — why')
    expect(p).toContain('Do not answer them')
    expect(p).toContain('The goal:\n\ncrop images')
    expect(p).toContain('dated:` today')
    expect(p).not.toContain('one guide per package')
    expect(p).not.toContain('Asked from the page')
    expect(p).toContain(PLAN_READ_REPO)
    expect(p).not.toContain(PLAN_READ_APP)
  })

  test('from the ask panel it carries the guides an app reads, and the page', () => {
    const guides = [{ pkg: 'sierra', file: '/r/sierra/AGENTS.md', about: 'routes and resources' }]
    const p = buildPlanPrompt({ goal: 'export', path: '/app/PLAN.md', page: 'http://localhost:8010/leads', guides })
    expect(p).toContain('one guide per package')
    expect(p).toContain('- /r/sierra/AGENTS.md — routes and resources')
    expect(p).toContain('Asked from the page: http://localhost:8010/leads')
    expect(p.indexOf('Asked from the page')).toBeLessThan(p.indexOf('The goal:'))
    expect(p).toContain(PLAN_READ_APP)
    expect(p).not.toContain('.claude/skills/')
    expect(buildPlanPrompt({ goal: 'export', path: '/app/PLAN.md', guides: [] })).toContain(PLAN_READ_APP)
  })

  test('stepPrompt carries the step, its phase and every guardrail', () => {
    const p = stepPrompt({ path: 'IDEAS/crop.md', step, phase, today: '2026-10-13' })
    expect(p).toContain('Carry out step 2.2 of the plan at `IDEAS/crop.md`: Rotate and flip')
    expect(p).toContain('Phase 2 — Writes to pixels, done when: the drive is green')
    for (const rule of [
      'Say the step\'s id and title before doing anything else',
      'Do ONLY this step',
      '`decision-rules`',
      'undo your edits to source files',
      'the session\'s job ends at the question',
      'fli file --sev S3',
      'Commit nothing',
      'Run `fli done`',
      'tick the box to `[x]`',
      '`**Done <date>.**`',
      '` — dropped: why`',
      'The reply is handed to the next session',
    ]) expect(p).toContain(rule)
  })

  test('nextHandoff reads the file first, carries the last reply capped, then the step', () => {
    const long = 'x'.repeat(HANDOFF_MAX + 50)
    const p = nextHandoff({ path: 'IDEAS/crop.md', step, phase, lastResult: long, today: '2026-10-13' })
    expect(p.indexOf('Read it first')).toBeLessThan(p.indexOf('The last session\'s reply'))
    expect(p).toContain('…' + 'x'.repeat(HANDOFF_MAX))
    expect(p).not.toContain('x'.repeat(HANDOFF_MAX + 1))
    expect(p.indexOf('The last session\'s reply')).toBeLessThan(p.indexOf('Carry out step 2.2'))
    expect(p).toContain('Do ONLY this step')
  })

  test('nextHandoff with nothing to carry is the read line and the step', () => {
    const p = nextHandoff({ path: 'PLAN.md', step, today: '2026-10-13' })
    expect(p).not.toContain('last session')
    expect(p).toContain('Carry out step 2.2 of the plan at `PLAN.md`')
  })
})

// A plan written to the shape the prompt describes, as a builder following it
// would write one: the sample is the shape's rules applied, and `parsePlan` is
// the reader that has to accept it. A rule that drifts from the parser shows
// here as a plan the workbench cannot find its next step in.
describe('PLAN_SHAPE', () => {
  const written = [
    '---',
    'id: crop',
    'status: proposed',
    'dated: 2026-10-13',
    '---',
    '',
    '# Crop',
    '',
    '### Phase 0 — Groundwork',
    '',
    'Goal: the original measured.',
    'Done when: `bun run measure` prints the baseline.',
    '',
    '- [x] 0.1 Measure the original',
    '  - It takes 40ms.',
    '- [ ] 0.2 Read the source',
    '',
    '### Phase 1 — Crop',
    '',
    'Goal: a crop with handles.',
    'Done when: the drive is green.',
    '',
    '- [ ] 1.1 Handles',
    '- [ ] 1.1a A step inserted later',
    '',
    '## Open questions (owner)',
    '',
    '- **Q1 — keep the aspect?**',
    '  - **A** — always',
    '  - **B** — never',
    '  - **Recommend A** — fewer surprises.',
    '',
  ].join('\n')

  test('the shape names every part the sample uses', () => {
    for (const part of ['### Phase N — title', 'counting from 0', '`Goal:`', '`Done when:`', '- [ ] N.M title', '`2.3a`', '## Open questions (owner)', '- **Q1 — the question?**', '- **Recommend A** — why', '`id:`', '`status: proposed`', '`dated:`'])
      expect(PLAN_SHAPE).toContain(part)
  })

  test('parsePlan reads phases from 0, steps by id, the first open box as next, and the open question', () => {
    const plan = parsePlan(written, { file: 'IDEAS/crop.md' })
    expect(plan.phases.map(p => p.n)).toEqual(['0', '1'])
    expect(plan.next.id).toBe('0.2')
    expect(plan.phases[1].steps.map(s => s.id)).toEqual(['1.1', '1.1a'])
    expect(plan.blocking).toHaveLength(1)
  })
})
