// ─── plan.js — a plan read off its boxes ─────────────────────────────────────
//
// A plan is Phases of Steps (`FJS-D927`, `doc-hygiene` § A plan's shape):
//
//     ### Phase 2 — Writes to pixels
//
//     Goal: one line, the outcome.
//     Done when: the command, drive or measurement that proves it.
//
//     - [x] 2.1 Crop with handles and aspect
//     - [ ] 2.2 Rotate and flip
//       - What the step found goes indented under it.
//     - [~] 2.3 Touch drags — dropped: the reason
//
// ── The position is derived, never written ───────────────────────────────────
//
// The next step is the FIRST OPEN BOX, and nothing else in the file says where
// the plan is. A `Next:` line was proposed and cut (`FJS-D927`): a second
// origin that drifts. So this reads boxes and answers `next`; a caller that
// wants to move the plan edits the box.
//
// ── One parse for the questions ──────────────────────────────────────────────
//
// A plan's `## Open questions` is the same shape a paper's is, so its `Q`
// bullets are read by `decisions.js`'s `paperQuestions` rather than a second
// parser here. An open question BLOCKS the next step: the workbench refuses
// Next while one stands, and `fli decide` is what unblocks it.
//
// Plain ESM, node or bun; `@frontierjs/toolbelt` through `compiler.js` for the
// frontmatter, like its neighbors.

import { basename }           from 'node:path'
import { extractFrontmatter } from './compiler.js'
import { paperQuestions }     from './decisions.js'

const PHASE     = /^#{2,4}\s+Phase\s+(\d+[a-z]?)\s*(?:[—–:-]\s*(.*))?$/i
const STEP      = /^- \[([ x~])\]\s+(\d+\.\d+[a-z]?)\s+(.*)$/
const GOAL      = /^\*{0,2}Goal:?\*{0,2}:?\s*(.*)$/i
const DONE_WHEN = /^\*{0,2}Done when:?\*{0,2}:?\s*(.*)$/i
const DONE_PARA = /^\*{0,2}Done\s+(\d{4}-\d{2}-\d{2}|[A-Z][a-z]+ \d{1,2}(?:, \d{4})?)\.?\*{0,2}/
const DROPPED   = /\s[—–-]+\s*dropped:?\s*(.*)$/i
const BOX       = { ' ': 'open', 'x': 'done', '~': 'dropped' }

/**
 * Parse a plan. Returns `{ file, title, status, phases, steps, next, questions,
 * blocking }` — `phases` is `[{ n, title, line, goal, doneWhen, steps, done }]`,
 * `steps` the same steps flat, `next` the first open step or null, `questions`
 * every `Q` bullet (`decisions.js`'s shape) and `blocking` the ones not ruled.
 */
export function parsePlan(text, { file = 'PLAN.md' } = {}) {
  const meta   = extractFrontmatter(text, file)
  const lines  = text.split('\n')
  const phases = []
  let title    = null
  let phase    = null
  let step     = null
  let last     = null
  let fence    = false

  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*```/.test(line)) { fence = !fence; return }
    if (fence) return

    if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, '').trim(); return }

    const ph = line.match(PHASE)
    if (ph) {
      phase = { n: ph[1], title: (ph[2] ?? '').trim(), line: i + 1, goal: null, doneWhen: null, steps: [], done: null }
      phases.push(phase)
      step = null
      last = null
      return
    }
    // A heading of any other kind ends the phase: its steps are over.
    if (/^#{1,6}\s/.test(line)) { phase = null; step = null; last = null; return }
    if (!phase) return

    const st = line.match(STEP)
    if (st) {
      const box     = BOX[st[1]]
      const dropped = box === 'dropped' ? st[3].match(DROPPED) : null
      step = {
        id:     st[2],
        phase:  phase.n,
        title:  (dropped ? st[3].slice(0, dropped.index) : st[3]).trim(),
        box,
        reason: dropped ? dropped[1].trim() : null,
        line:   i + 1,
        notes:  [],
      }
      phase.steps.push(step)
      return
    }

    // Indented under a step: a bullet is what it found; a bare wrapped line
    // continues the title until the first note, then the note above it.
    if (step && /^\s+\S/.test(line)) {
      const m = line.match(/^\s+[-*]\s+(.*)$/)
      if (m) step.notes.push(m[1].trim())
      else if (step.notes.length) step.notes[step.notes.length - 1] += ' ' + line.trim()
      else step.title += ' ' + line.trim()
      return
    }
    if (!line.trim()) { step = null; last = null; return }
    step = null

    const g = line.match(GOAL)
    if (g && phase.goal === null) { phase.goal = g[1].trim(); last = 'goal'; return }
    const d = line.match(DONE_WHEN)
    if (d && phase.doneWhen === null) { phase.doneWhen = d[1].trim(); last = 'doneWhen'; return }
    if (DONE_PARA.test(line) && phase.done === null) { phase.done = line.replace(/\*\*/g, '').trim(); last = 'done'; return }
    // A line with no blank above it wraps the Goal, Done when or Done paragraph.
    if (last && !/^[-*#]/.test(line)) phase[last] += ' ' + line.trim()
  })

  const steps     = phases.flatMap(p => p.steps)
  const paper     = { id: meta.id || basename(file).replace(/\.md$/, ''), status: meta.status || '', file }
  const questions = paperQuestions(text, { paper, rel: file })
  return {
    file,
    title,
    status:    meta.status || null,
    phases,
    steps,
    next:      steps.find(s => s.box === 'open') ?? null,
    questions,
    blocking:  questions.filter(q => q.state !== 'ruled'),
  }
}

/** The phase a step belongs to, by the step's id. */
export function phaseOf(plan, step) {
  return plan.phases.find(p => p.n === step.phase) ?? null
}

/**
 * The plan's text with step `id`'s open box ticked, or null when no open box
 * carries that id. The line is the parser's, so a step quoted in a fence is
 * never the one written.
 */
export function tickStep(text, id, { file } = {}) {
  const step = parsePlan(text, { file }).steps.find(s => s.id === id && s.box === 'open')
  if (!step) return null
  const lines = text.split('\n')
  lines[step.line - 1] = lines[step.line - 1].replace(/^- \[ \]/, '- [x]')
  return lines.join('\n')
}

/** Step ids issued twice, which `FJS-D927` forbids; empty when the plan is sound. */
export function reissued(plan) {
  const seen = new Map()
  for (const s of plan.steps) seen.set(s.id, (seen.get(s.id) ?? 0) + 1)
  return [...seen].filter(([, n]) => n > 1).map(([id]) => id)
}

// ─── terminal ─────────────────────────────────────────────────────────────────

const MARK = { open: '☐', done: '☑', dropped: '⊘' }

/** The plan as terminal rows — `chalk` is fli's own tag; `next` is marked `→`. */
export function renderPlan(plan, chalk) {
  const c    = chalk ?? ((strs, ...vals) => strs.reduce((out, str, i) => out + str + (i < vals.length ? vals[i] : ''), '').replace(/\{[a-z.]+ ([^{}]*)\}/g, '$1'))
  const rows = []
  if (plan.title) rows.push(c`  {bold ${plan.title}}${plan.status ? c` {dim · ${plan.status}}` : ''}`, '')
  for (const p of plan.phases) {
    const done  = p.steps.filter(s => s.box !== 'open').length
    const label = p.title ? `Phase ${p.n} — ${p.title}` : `Phase ${p.n}`
    rows.push(c`  {bold ${label}}  {dim ${done}/${p.steps.length}}`)
    if (p.goal)     rows.push(c`    {dim Goal:} ${p.goal}`)
    if (p.doneWhen) rows.push(c`    {dim Done when:} ${p.doneWhen}`)
    for (const s of p.steps) {
      const here = plan.next && s.id === plan.next.id
      const mark = MARK[s.box]
      const text = s.box === 'dropped' ? c`{dim ${s.title}}` : s.title
      rows.push(here ? c`  {cyan →} ${mark} {bold ${s.id}} ${text}` : c`    ${mark} ${s.id} ${text}`)
      if (s.reason) rows.push(c`        {dim dropped: ${s.reason}}`)
      for (const n of s.notes) rows.push(c`        {dim ${n}}`)
    }
    if (p.done) rows.push(c`    {green ${p.done}}`)
    rows.push('')
  }
  if (plan.questions.length) {
    const open = plan.blocking.length
    rows.push(c`  {bold Open questions}  {dim ${plan.questions.length - open} ruled · ${open} open}`)
    for (const q of plan.questions) {
      const mark = q.state === 'ruled' ? '☑' : q.state === 'decidable' ? '?' : '…'
      // The id is what `fli decide <id> <letter> --file <plan>` answers it by.
      rows.push(q.state === 'ruled' ? c`    ${mark} ${q.question}` : c`    ${mark} ${q.question} {dim ${q.id}}`)
    }
    rows.push('')
  }
  rows.push(plan.next
    ? c`  {cyan next} ${plan.next.id} ${plan.next.title}${plan.blocking.length ? c` {yellow — blocked by ${plan.blocking.length} open question${plan.blocking.length === 1 ? '' : 's'}}` : ''}`
    : c`  {green every box is closed}`)
  return rows
}
