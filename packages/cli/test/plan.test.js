// test/plan.test.js — core/plan.js and `fli plan`
//
// The position is read off the boxes and nowhere else, so a parse that puts
// the next step one box off sends a session to redo finished work or skip
// open work. The fixture is the shape `doc-hygiene` § A plan's shape prints,
// with the cases the rule names: a dropped step with its reason, an inserted
// `2.3a`, findings under a step, a phase's `Done` paragraph, a fenced block
// holding a step that is not one, and the `Q` bullets.

import { test, expect, describe } from 'bun:test'
import { spawnSync }              from 'node:child_process'
import { readFileSync }           from 'node:fs'
import { resolve }                from 'node:path'
import { parsePlan, renderPlan, reissued, phaseOf, tickStep } from '../core/plan.js'

const REPO = resolve(import.meta.dir, '../../..')

const PLAN = `---
id: crop
status: partial
---

# Idea — crop

Prose before the phases.

### Phase 0 — Groundwork

Goal: measure the original.
Done when: the numbers are in the paper,
  and the paper is committed.

- [x] 0.1 Read the source
  - 1,200 lines, two owners.
  - The second owner is dead code.
- [x] 0.2 Measure it

**Done 2026-10-01.** Both owners were measured and
the dead one removed.

### Phase 2 — Writes to pixels

Goal: one line, the outcome.
Done when: the command, drive or measurement that proves it.

- [x] 2.1 Crop with handles and aspect
- [ ] 2.2 Rotate and flip
  wrapped onto a second line
  - What the step found goes indented under it.
- [ ] 2.2a Flip only, inserted later
- [~] 2.3 Touch drags — dropped: the reason

\`\`\`md
- [ ] 9.9 A step inside a fence is an example, not a step
\`\`\`

## Open questions (owner)

- **Q1 — Which axis?**
  - **A** — the long one
  - **B** — the short one
  - **Recommend A** — it is longer
- ~~**Q2 — Settled?**~~ **Answered 2026-10-01 (\`FJS-D1\`): A.**
  - **A** — yes
  - **B** — no
`

describe('parsePlan', () => {
  const plan = parsePlan(PLAN, { file: 'IDEAS/crop.md' })

  test('reads the frontmatter and title', () => {
    expect(plan.status).toBe('partial')
    expect(plan.title).toBe('Idea — crop')
  })

  test('phases carry goal, done-when and the Done paragraph, wrapped lines joined', () => {
    expect(plan.phases.map(p => p.n)).toEqual(['0', '2'])
    expect(plan.phases[0].goal).toBe('measure the original.')
    expect(plan.phases[0].doneWhen).toBe('the numbers are in the paper, and the paper is committed.')
    expect(plan.phases[0].done).toBe('Done 2026-10-01. Both owners were measured and the dead one removed.')
    expect(plan.phases[1].done).toBeNull()
  })

  test('steps carry their box, an inserted letter, a wrapped title and the findings', () => {
    const ids = plan.steps.map(s => `${s.id}:${s.box}`)
    expect(ids).toEqual(['0.1:done', '0.2:done', '2.1:done', '2.2:open', '2.2a:open', '2.3:dropped'])
    const s22 = plan.steps.find(s => s.id === '2.2')
    expect(s22.title).toBe('Rotate and flip wrapped onto a second line')
    expect(s22.notes).toEqual(['What the step found goes indented under it.'])
    expect(plan.steps[0].notes).toEqual(['1,200 lines, two owners.', 'The second owner is dead code.'])
    expect(s22.line).toBe(30)
  })

  test('a dropped step keeps its number and says why', () => {
    const s = plan.steps.find(s => s.id === '2.3')
    expect(s.title).toBe('Touch drags')
    expect(s.reason).toBe('the reason')
  })

  test('the next step is the first open box', () => {
    expect(plan.next.id).toBe('2.2')
    expect(phaseOf(plan, plan.next).n).toBe('2')
  })

  test('a step inside a fence is not a step', () => {
    expect(plan.steps.some(s => s.id === '9.9')).toBe(false)
  })

  test('Q bullets come through decisions.js, and the unruled ones block', () => {
    expect(plan.questions.map(q => [q.question, q.state])).toEqual([['Q1 — Which axis?', 'decidable'], ['Q2 — Settled?', 'ruled']])
    expect(plan.blocking.map(q => q.id)).toEqual(['crop:q1-which-axis'])
    expect(plan.questions[0].recommend.letter).toBe('A')
  })

  test('every box closed means no next', () => {
    const done = parsePlan('### Phase 0 — x\n\n- [x] 0.1 a\n- [~] 0.2 b — dropped: c\n')
    expect(done.next).toBeNull()
    expect(done.blocking).toEqual([])
  })

  test('a reissued number is reported', () => {
    expect(reissued(plan)).toEqual([])
    expect(reissued(parsePlan('### Phase 1\n\n- [ ] 1.1 a\n- [ ] 1.1 b\n'))).toEqual(['1.1'])
  })

  test('renders with the next step marked and the open question counted', () => {
    const rows = renderPlan(plan).join('\n')
    expect(rows).toContain('→ ☐ 2.2 Rotate and flip')
    expect(rows).toContain('⊘ 2.3 Touch drags')
    expect(rows).toContain('1 ruled · 1 open')
    // The open one carries the id `fli decide --file` answers it by; the ruled one does not.
    expect(rows).toMatch(/\? Q1 — Which axis\? \S+:q1-which-axis/)
    expect(rows).not.toMatch(/Q2 — Settled\? \S+:/)
    expect(rows).toContain('blocked by 1 open question')
  })
})

describe('tickStep', () => {

  test('ticks the named open box and nothing else on the page', () => {
    const out = tickStep(PLAN, '2.2')
    const was = PLAN.split('\n')
    const now = out.split('\n')
    expect(now[29]).toBe('- [x] 2.2 Rotate and flip')
    expect(now.filter((l, i) => l !== was[i])).toEqual(['- [x] 2.2 Rotate and flip'])
    expect(parsePlan(out).next.id).toBe('2.2a')
  })

  test('a done, dropped, fenced or absent step is null', () => {
    expect(tickStep(PLAN, '2.1')).toBeNull()
    expect(tickStep(PLAN, '2.3')).toBeNull()
    expect(tickStep(PLAN, '9.9')).toBeNull()
    expect(tickStep(PLAN, '7.1')).toBeNull()
  })
})

describe('fli plan', () => {
  const fli = (...args) => spawnSync(process.execPath, [resolve(import.meta.dir, '../bin/fli.js'), 'plan', ...args], { cwd: REPO, encoding: 'utf8' })

  test('--json prints the parse of a real paper, next is an open box', () => {
    const out = fli('IDEAS/shipped/workbench-plans.md', '--json')
    expect(out.status).toBe(0)
    const plan = JSON.parse(out.stdout)
    expect(plan.phases.length).toBeGreaterThanOrEqual(5)
    expect(plan.next === null || plan.next.box === 'open').toBe(true)
    expect(plan.reissued).toEqual([])
  })

  test('a file with no phase heading is refused by name', () => {
    const out = fli('README.md')
    expect(out.status).toBe(1)
    expect(out.stdout + out.stderr).toContain('not a plan')
  })

  test('the skill example parses', () => {
    const skill = readFileSync(resolve(REPO, '.claude/skills/doc-hygiene/SKILL.md'), 'utf8')
    const fence = skill.match(/```md\n([\s\S]*?)```/)[1]
    const plan  = parsePlan(fence)
    expect(plan.phases[0].n).toBe('2')
    expect(plan.next.id).toBe('2.2')
    expect(plan.steps.find(s => s.id === '2.3').reason).toBe('the reason')
  })
})
