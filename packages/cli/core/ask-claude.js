// ─── ask-claude.js — the console's output handed to Claude Code, the reply read back
//
// `claude -p` started in the project root, the prompt on STDIN (a CI run's
// output is past the size one argv string may be), stream-json read line by
// line into the few events the page draws. A follow-up resumes the session by
// id, so the second question does not re-send what the first already did, and
// the same id is what `claude --resume` takes in a terminal.
//
// READ-ONLY, by construction rather than by asking: `--tools` leaves the
// built-ins below and nothing else, Bash answers only `ASK_BASH`, and a print
// session denies every other call instead of prompting — measured, a `touch`
// came back as a permission denial and the file was never made. Another session
// is usually editing this tree, and an agent nobody is watching must not join it.
//
// Hooks are OFF. This repo's Stop hook runs `fli done` (~25s) and BLOCKS on an
// unfinished item, so a one-question session would spend its turns chasing the
// tree's close-out — and the hook writes which items were SHOWN beside `.git`,
// so an ask would silence them for the person's own session. `--strict-mcp-config`
// with no config drops every MCP tool the account would otherwise lend it.
//
// EDIT is the one widening, and it is a path, not a mode: `Edit` and `Write`
// scoped to one directory, every settings source dropped so no allow rule in a
// settings file reaches past it, and `dontAsk` so a call outside it is denied
// rather than accepted by whatever mode the account defaults to. The one
// `Edit(<dir>/**)` rule covers Write too — measured, for each tool the call
// inside the scope landed and the one beside it came back as a denial.
// `reads` adds a `Read(<dir>/**)` rule per directory, which Grep and Glob obey
// too; with no rule a Read outside the cwd is denied, and so are an app's
// framework packages, installed at the app root above the Vite root.
//
// WORK is the opposite end, for Basecamp's workbench: a build session in a
// checkout its operator pinned, every tool and every permission. Nothing above
// holds there — it is the account's own Claude Code, minus the prompts — so
// the two levers left are what this file still owns: the budget, and whether
// the repo's own hooks run (a Stop hook that blocks spends the run's turns).
// The workbench's REVIEWER is the read-only default again, with its own prompt.
//
// A pasted image cannot ride a text prompt, so an ask carrying one goes in as
// one stream-json user message instead — the prompt as its text block, each
// image a base64 block after it. Measured on 2.1.296, a resume included.

import { spawn, spawnSync } from 'node:child_process'

export const ASK_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']
export const ASK_BASH  = ['git status:*', 'git diff:*', 'git log:*', 'git show:*', 'rg:*', 'ls:*']

// A press is a question, not a work session; a loop that reads the whole tree
// stops here rather than on the account's limit.
export const ASK_BUDGET_USD = 2

// The workbench's reviewer: a fresh read-only session over what a work run
// left in the tree. Fresh, because a reviewer that resumes the builder's
// session grades the change by the builder's own account of it.
export const REVIEW_RULES = [
  'You are reviewing a change another Claude Code session just made in this checkout. You are read-only: Read, Grep, Glob, and git, rg and ls in Bash.',
  'The change is the working tree against HEAD: run `git diff HEAD` and `git status --short`, and read an untracked file whole. Another session may share this tree, so a change unrelated to the request is not this change.',
  'Look for correctness bugs: a wrong condition, a missed case, a broken caller, a test that cannot fail. Skip style. Each finding is `file:line` and one or two sentences on what goes wrong and when.',
  'Reply with the findings, most severe first, or the one line "No findings." when there are none. The reply goes back to the builder as its next message, so write it to them.',
].join('\n\n')

/** The reviewer's prompt: the rules, then what the builder was asked to do. */
export function reviewPrompt({ request = '' } = {}) {
  const asked = String(request).trim()
  return [REVIEW_RULES, asked ? `The builder was asked:\n\n${asked.slice(0, 4000)}` : null].filter(Boolean).join('\n\n')
}

// ─── a plan run from the workbench ───────────────────────────────────────────
//
// Three prompts, one per button (`IDEAS/workbench-plans.md`). The plan FILE is
// the handoff: a step ends by writing what it found under its box, so Next is
// a fresh session told to read the file. The sentences are constants because
// the test asserts each guardrail is still in the prompt — a prompt that loses
// *do only this step* runs the whole plan in one session, which is the flow
// this replaces.

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
  'Before writing Phase 0, read the `CLAUDE.md` of each package the goal touches and the realm hazards skill under `.claude/skills/` that covers it, and check `DECISIONS.md` for a ruling that already settles part of the goal.',
  'Each step names the files it touches and the test or drive that proves it. A step that cannot name its proof is not a step yet.',
].join('\n\n')

/** Build plan: the goal, the shape, and the one path the session may write. */
export function buildPlanPrompt({ goal, path, today = new Date().toISOString().slice(0, 10) } = {}) {
  const asked = String(goal ?? '').trim().slice(0, 8000)
  return [
    `Write a plan at \`${path}\` for the goal below. Today is ${today}.`,
    BUILD_PLAN_RULES,
    PLAN_SHAPE,
    `The goal:\n\n${asked}`,
  ].join('\n\n')
}

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

/** Next: a fresh session handed the plan, the last reply and the open questions, then the step. */
export function nextHandoff({ path, step, phase = null, lastResult = '', questions = [], today } = {}) {
  const tail = String(lastResult ?? '').trim()
  const open = questions.filter(q => q.state !== 'ruled')
  return [
    `This is a fresh session continuing the plan at \`${path}\`. Read it first: the next step is the first open box, and what earlier steps found is written under their boxes.`,
    tail ? `The last session's reply:\n\n${tail.length > HANDOFF_MAX ? '…' + tail.slice(-HANDOFF_MAX) : tail}` : null,
    open.length
      ? `Open questions the owner has not ruled on — do not answer them, and do not build what depends on one:\n${open.map(q => `- ${q.question}`).join('\n')}`
      : null,
    stepPrompt({ path, step, phase, today }),
  ].filter(Boolean).join('\n\n')
}

// The tail is what was just run and what failed; a CI log's head is setup.
export const ASK_MAX_LINES = 1500

export const ASK_DEFAULT_QUESTION = 'What does this output say, and what should I do next?'

// The page shows these and lets the person rewrite them. Rewriting them cannot
// widen what Claude may do: that is the argv, which no text in the prompt reaches.
export const ASK_RULES = [
  'I pressed "ask Claude" on the output panel of the fli GUI, the FrontierJS control surface.',
  'You are read-only here: Read, Grep, Glob, and git, rg and ls in Bash. Where something should change, say what and where (file:line) rather than doing it.',
  'A fli command is a markdown file: "command source", when I name one, is its docs and its script in one.',
  'The answer renders in a narrow console: keep it short and plain.',
].join('\n\n')

// A pasted essay is still a question, but not one a $2 budget should spend
// its tokens re-reading on every turn.
export const ASK_MAX_RULES = 4000

export const EDIT_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write']

// The media types the API takes as an image block; anything else is refused there.
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

// What the browser's picker sends with an element: the page renders as narrow
// a reply as the console does, and the file and line are where to start, not a
// fence — a change asked of one element is often one in the component it uses.
export const EDIT_RULES = [
  'I picked one or more elements on a page running in a FrontierJS dev server and asked for a change to them. When I pick several, the one instruction covers all of them.',
  'Make the change with the Edit tool. Use Write only to create a new file, such as a new section or component. You may change files under the app directory and nowhere else; a call outside it is denied, so say what you would change there instead. You may also read the framework guides listed below and the app\'s db/ directory.',
  'The page hot-reloads when a file is saved, so I will see the result as soon as you edit. Make the smallest change that does what I asked, in the style of the file you are in.',
  'Another session may be editing this tree. Re-read a file before you edit it, and never rewrite more of it than the change needs.',
  'Reply in two or three short lines: what you changed and where (file:line).',
].join('\n\n')

// The panel's chips. The page sends a key and the sentence lives here, so a
// request cannot put words of its own into the prompt through them. "every" is
// the one a looped element needs: an ask about one card of twelve is otherwise
// read as a change to that card, edited in with a condition.
//
// A kind also names the guides to read first and the effort it runs at. The
// cost of a run is the guides it reads, not its thinking: a Style ask at low
// made the same edit as at high in half the time, so effort is the lever and
// not the model, and the panel's effort chip overrides it.
export const EDIT_KINDS = {
  text:     { says: 'the words only. Leave markup, classes and script alone.', guides: [], effort: 'low' },
  style:    { says: 'how it looks: classes, and @frontierjs/css tones and treatments rather than colors. Leave the markup structure and the script alone.', guides: ['css', 'ui'], effort: 'low' },
  layout:   { says: 'arrangement and size: markup structure and layout classes. Leave the data and the behavior alone.', guides: ['css', 'ui', 'mesa'], effort: 'high' },
  behavior: { says: 'what it does: event handlers and script. Keep how it looks.', guides: ['mesa', 'sierra', 'junction'], effort: 'high' },
  data:     { says: 'what it shows: which fields, records, order or filter. Reach the data through the resource the page already reads.', guides: ['sierra', 'junction', 'litestone'], effort: 'high' },
}

export const EDIT_SCOPES = {
  every:     'every item its loop draws. Edit the loop body once, not one item.',
  component: 'the whole component or section the element belongs to.',
  page:      'the whole page, wherever the same thing appears on it.',
}

// An outerHTML is context, not the subject; a page section is easily 50KB. The
// budget is for the whole prompt, so ten picks cost what one does.
export const EDIT_MAX_HTML = 4000

// Each length's cut of `total`: a short one keeps all of its own and what it
// leaves over goes to the longer ones, rather than every pick getting total/n.
export function shareBudget(lengths, total = EDIT_MAX_HTML) {
  const out = new Array(lengths.length).fill(0)
  let left = total
  const order = lengths.map((n, i) => i).sort((a, b) => lengths[a] - lengths[b])
  order.forEach((i, k) => {
    out[i] = Math.min(lengths[i], Math.floor(left / (order.length - k)))
    left -= out[i]
  })
  return out
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A work run builds rather than answers; the operator sets it per checkout.
export const WORK_BUDGET_USD = 10

// How hard Claude thinks, as `--effort`. Thinking itself cannot be switched off
// here: on Opus 5.5 and Sonnet 5.5 `claude -p` keeps it on through
// `alwaysThinkingEnabled: false`, `MAX_THINKING_TOKENS=0` and
// `CLAUDE_CODE_DISABLE_THINKING=1` alike (measured, 2.1.296), so a thinking
// toggle would be a control that does nothing. Effort reaches every model.
export const EFFORTS    = ['low', 'medium', 'high', 'xhigh', 'max']
export const ASK_EFFORT = 'high'
// The page panel offers three: the steps between them are too fine to choose
// from a glance.
export const PANEL_EFFORTS = ['low', 'high', 'max']

/** The effort an edit runs at: the one asked for, else its kind's, else `ASK_EFFORT`. */
export function editEffort(kind, asked = null) {
  return asked || (Object.hasOwn(EDIT_KINDS, kind ?? '') ? EDIT_KINDS[kind].effort : ASK_EFFORT)
}

// `fork` resumes `session` under a NEW id filed under the run's own directory,
// which is what lets `claude --resume` from a workbench branch's folder find it;
// a plain resume from there answers but stays filed under the old directory.
// No `effort` leaves it to the account, which is what the workbench passes.
export function askArgv({ session = null, edit = null, reads = [], work = null, fork = false, images = false, effort = null, model = null } = {}) {
  const argv = askFlags({ session, edit, reads, work, fork })
  if (effort) argv.push('--effort', effort)
  if (model)  argv.push('--model', model)
  if (images) argv.push('--input-format', 'stream-json')
  return argv
}

function askFlags({ session, edit, reads, work, fork }) {
  if (work) {
    const argv = [
      '-p',
      '--output-format',  'stream-json',
      '--verbose',
      '--permission-mode', 'bypassPermissions',
      '--max-budget-usd', String(Number(work.budget) > 0 ? Number(work.budget) : WORK_BUDGET_USD),
    ]
    if (!work.hooks) argv.push('--settings', JSON.stringify({ disableAllHooks: true }))
    if (session) argv.push('--resume', session)
    if (session && fork) argv.push('--fork-session')
    return argv
  }
  if (edit) {
    const argv = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--settings',        JSON.stringify({ disableAllHooks: true }),
      '--setting-sources', '',
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--tools',           EDIT_TOOLS.join(','),
      '--allowedTools',    `Edit(/${String(edit).replace(/\/+$/, '')}/**)`, ...reads.map(d => `Read(/${String(d).replace(/\/+$/, '')}/**)`),
      '--max-budget-usd',  String(ASK_BUDGET_USD),
    ]
    // The reply streams as it is written, and a block's start says what the
    // run is doing — seconds pass before the first tool call otherwise.
    argv.push('--include-partial-messages')
    if (session) argv.push('--resume', session)
    return argv
  }
  const argv = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--settings',      JSON.stringify({ disableAllHooks: true }),
    '--strict-mcp-config',
    '--tools',         ASK_TOOLS.join(','),
    '--allowedTools',  ...ASK_BASH.map(p => `Bash(${p})`),
    '--max-budget-usd', String(ASK_BUDGET_USD),
  ]
  if (session) argv.push('--resume', session)
  return argv
}

// The terminal half of a panel conversation. `claude --resume` finds the
// session from any directory (measured, 2.1.288), but the session's paths are
// relative to the root its runs were spawned in, and so is every tool it runs.
export function resumeCommand(root, session) {
  if (!SESSION_ID.test(String(session))) return null
  return `cd ${shellWord(root)} && claude --resume ${session}`
}

/** What goes on stdin: the prompt as is, or with images one stream-json message. */
export function askInput(prompt, images = []) {
  if (!images.length) return prompt
  const content = [
    { type: 'text', text: prompt },
    ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.type, data: i.data } })),
  ]
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n'
}

const shellWord = s => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`

export function gitContext(root) {
  const r = spawnSync('git', ['status', '--short', '--branch'], { cwd: root, encoding: 'utf8' })
  if (r.status !== 0) return null
  const lines = r.stdout.trimEnd().split('\n')
  return lines.length > 60 ? [...lines.slice(0, 60), `… ${lines.length - 60} more`].join('\n') : lines.join('\n')
}

/**
 * The prompt for one press. `context` is what the page knows about where the
 * person is, as `label: value` pairs; `git` and `rules` are only sent on a
 * first question, since a resumed session already has both.
 */
export function askPrompt({ question, output = '', context = {}, git = null, rules = null, followUp = false }) {
  const lines   = String(output).split('\n')
  const cut     = Math.max(0, lines.length - ASK_MAX_LINES)
  const shown   = lines.slice(cut).join('\n').trimEnd()
  const where   = Object.entries(context)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `- ${k}: ${String(v).slice(0, 200)}`)
  const q = String(question || '').trim() || ASK_DEFAULT_QUESTION

  const parts = []
  if (!followUp) parts.push(String(rules ?? '').trim().slice(0, ASK_MAX_RULES) || ASK_RULES)
  parts.push(`Question: ${q}`)
  if (where.length) parts.push(`Where I am:\n${where.join('\n')}`)
  if (git) parts.push(`Working tree (git status --short --branch):\n${git}`)
  if (shown) parts.push(
    `${followUp ? 'Output since my last question' : 'The output panel'} (${lines.length - cut} line(s)${cut ? `, the first ${cut} cut` : ''}):\n\`\`\`text\n${shown}\n\`\`\``,
  )
  return parts.join('\n\n')
}

/**
 * The prompt for one ask: the picked elements, where each one's source is, what
 * to do. `picks` is `[{ loc, html, size }]`, where `size` is the outerHTML's
 * whole length when the page already cut `html`; a pick may carry what
 * `core/ask-context.js` read off the source — `loops` around it, `inner` loops
 * and `files` under it — and `data` is the resources those files read, one
 * line each. `kind` and `scope` are `EDIT_KINDS`/`EDIT_SCOPES` keys. The rules
 * and the guide list travel only on a first question, as in `askPrompt`;
 * `rules: false` keeps the guides and drops the rules, for a prompt handed to
 * an agent the panel does not run.
 */
export function editPrompt({ instruction, picks = [], page = null, followUp = false, rules = !followUp, kind = null, scope = null, data = [], images = 0, guides = [] }) {
  const known = Object.hasOwn(EDIT_KINDS, kind ?? '')
  const parts = []
  if (rules) parts.push(EDIT_RULES)
  if (!followUp && guides.length) parts.push(['The framework this app is built on, one guide per package — read the one a change touches before you make it, and follow it over the habits of other frameworks:', ...guides.map(g => `- ${g.file} — ${g.about}`)].join('\n'))
  const first = known ? guides.filter(g => EDIT_KINDS[kind].guides.includes(g.pkg)) : []
  if (first.length) parts.push(`Before this change, read: ${first.map(g => g.file).join(', ')}`)
  const change = String(instruction ?? '').trim()
  if (change) parts.push(`Change: ${change}`)
  if (images > 0) parts.push(`I pasted ${images === 1 ? 'an image' : `${images} images`} with this; ${images === 1 ? 'it comes' : 'they come'} after this text.`)
  if (known) parts.push(`What to change: ${EDIT_KINDS[kind].says}`)
  if (Object.hasOwn(EDIT_SCOPES, scope ?? '')) parts.push(`How far: ${EDIT_SCOPES[scope]}`)
  if (page) parts.push(`The page: ${String(page).slice(0, 300)}`)
  const htmls = picks.map(p => String(p.html ?? ''))
  const cuts  = shareBudget(htmls.map(h => h.length))
  const loop  = l => `{#each ${l.head}} at ${l.at}`
  picks.forEach((p, i) => {
    const lines = [picks.length > 1 ? `Element ${i + 1} of ${picks.length}:` : 'The element:']
    if (p.loc) lines.push(`- source: ${p.loc}`)
    if (p.repeats > 1) lines.push(`- drawn ${p.repeats} times on the page from that source`)
    if (p.loops?.length) lines.push(`- inside: ${p.loops.map(loop).join(' › ')}`)
    if (p.files?.length) lines.push(`- written in, under it: ${p.files.join(', ')}`)
    if (p.inner?.length) lines.push(`- loops under it: ${p.inner.map(loop).join('; ')}`)
    const h = htmls[i], size = Math.max(Number(p.size) || 0, h.length)
    if (h) lines.push(`- rendered HTML, outlined (a run of siblings from one source folded to the first, long text clipped)${cuts[i] < size ? `, first ${cuts[i]} of ${size} chars` : ''}:\n\`\`\`html\n${h.slice(0, cuts[i])}\n\`\`\``)
    parts.push(lines.join('\n'))
  })
  if (data.length) parts.push(['What those loops can read — the resources their files import:', ...data.map(d => `- ${d}`)].join('\n'))
  return parts.join('\n\n')
}

// A tool call in one line: the part of its input a person would recognize.
function toolLine(part) {
  const i = part.input ?? {}
  const what = i.command ?? i.file_path ?? i.pattern ?? i.path ?? ''
  return `${part.name}${what ? ` ${String(what).split('\n')[0].slice(0, 160)}` : ''}`
}

// A Write's result is the one witness that the file did not exist before it:
// looking at the call races the write itself. Measured wording; if it ever
// changes, a new file is only undone when the look won the race.
const CREATED = /^File created successfully/
const resultText = part => typeof part.content === 'string' ? part.content
  : (part.content ?? []).map(c => c?.text ?? '').join('')

// What a block starting means to somebody waiting on it.
const BLOCK_DOING = { thinking: 'thinking', redacted_thinking: 'thinking', text: 'writing' }
const TOOL_DOING  = { Read: 'reading', Grep: 'reading', Glob: 'reading', Edit: 'editing', Write: 'editing' }

/**
 * One parsed stream-json event → the events the page draws (often none). A
 * `delta` is reply text as it streams; the `text` after it is the same block
 * whole, and replaces it.
 */
export function readAskEvent(event) {
  if (!event || typeof event !== 'object') return []
  if (event.type === 'system' && event.subtype === 'init' && event.session_id)
    return [{ type: 'session', id: event.session_id }]
  if (event.type === 'system' && event.subtype === 'status' && event.status === 'requesting')
    return [{ type: 'status', text: 'thinking' }]
  if (event.type === 'stream_event') {
    const e = event.event ?? {}
    if (event.parent_tool_use_id) return []
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text)
      return [{ type: 'delta', text: e.delta.text }]
    if (e.type !== 'content_block_start') return []
    const block = e.content_block ?? {}
    const doing = block.type === 'tool_use' ? TOOL_DOING[block.name] ?? 'working' : BLOCK_DOING[block.type]
    return doing ? [{ type: 'status', text: doing }] : []
  }
  if (event.type === 'assistant') {
    const out = []
    for (const part of event.message?.content ?? []) {
      if (part.type === 'text' && part.text?.trim()) out.push({ type: 'text', text: part.text })
      if (part.type === 'tool_use') out.push({ type: 'tool', text: toolLine(part) })
      // What an undo reverses. Reported at the CALL, which may yet be denied;
      // the tool's result below is what says whether it landed. A Read is
      // reported because it comes before any change to that file, so it is
      // the moment the file's original can be copied without racing the write.
      if (part.type !== 'tool_use' || !part.input?.file_path) continue
      if (part.name === 'Read') out.push({ type: 'read', id: part.id, file: part.input.file_path })
      if (part.name === 'Edit') out.push({
        type: 'edit', id: part.id, file: part.input.file_path,
        old: part.input.old_string ?? '', new: part.input.new_string ?? '', all: !!part.input.replace_all,
      })
      if (part.name === 'Write') out.push({
        type: 'write', id: part.id, file: part.input.file_path, content: part.input.content ?? '',
      })
    }
    return out
  }
  if (event.type === 'user') return (event.message?.content ?? [])
    .filter(part => part?.type === 'tool_result')
    .map(part => part.is_error ? { type: 'refused', id: part.tool_use_id }
      : { type: 'landed', id: part.tool_use_id, ...(CREATED.test(resultText(part)) ? { created: true } : {}) })
  if (event.type === 'result') return [{
    type:   'result',
    ok:     event.subtype === 'success' && !event.is_error,
    stop:   event.subtype ?? null,
    cost:   event.total_cost_usd ?? null,
    turns:  event.num_turns ?? null,
    denied: event.permission_denials?.length ?? 0,
  }]
  return []
}

/**
 * Start one question. Returns `{ error }` for a session id or effort that is not one, or
 * `{ child, done }` where `done` resolves to the exit code. Detached, so a stop
 * signals the group and takes a running `rg` with it.
 */
export function runAsk({ root, prompt, session = null, edit = null, reads = [], images = [], effort = ASK_EFFORT, model = null, bin = 'claude', onEvent }) {
  if (session && !SESSION_ID.test(String(session)))
    return { error: `not a session id: ${JSON.stringify(String(session).slice(0, 40))}` }
  if (!EFFORTS.includes(effort))
    return { error: `no such effort: ${JSON.stringify(String(effort).slice(0, 40))} — one of ${EFFORTS.join(', ')}` }

  const child = spawn(bin, askArgv({ session, edit, reads, effort, model, images: images.length > 0 }), {
    cwd: root, detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  child.stdin.end(askInput(prompt, images))

  let buf = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      let event
      try { event = JSON.parse(line) } catch { continue }
      for (const e of readAskEvent(event)) onEvent?.(e)
    }
  })

  // stderr is where `claude` says it is not logged in or not installed; the
  // page shows it as said rather than as a silent empty answer.
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { err += chunk })

  const done = new Promise(ok => {
    child.on('error', e => {
      onEvent?.({ type: 'error', text: e.code === 'ENOENT' ? `${bin} is not installed or not on PATH` : e.message })
      ok(null)
    })
    child.on('close', code => {
      if (code && err.trim()) onEvent?.({ type: 'error', text: err.trim().split('\n').slice(-5).join('\n') })
      ok(code)
    })
  })
  return { child, done }
}
