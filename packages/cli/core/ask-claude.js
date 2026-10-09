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
//
// WORK is the opposite end, for Basecamp's workbench: a build session in a
// checkout its operator pinned, every tool and every permission. Nothing above
// holds there — it is the account's own Claude Code, minus the prompts — so
// the two levers left are what this file still owns: the budget, and whether
// the repo's own hooks run (a Stop hook that blocks spends the run's turns).
// The workbench's REVIEWER is the read-only default again, with its own prompt.

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

// What the browser's picker sends with an element: the page renders as narrow
// a reply as the console does, and the file and line are where to start, not a
// fence — a change asked of one element is often one in the component it uses.
export const EDIT_RULES = [
  'I picked one or more elements on a page running in a FrontierJS dev server and asked for a change to them. When I pick several, the one instruction covers all of them.',
  'Make the change with the Edit tool. Use Write only to create a new file, such as a new section or component. You may change files under the app directory and nowhere else; a call outside it is denied, so say what you would change there instead.',
  'The page hot-reloads when a file is saved, so I will see the result as soon as you edit. Make the smallest change that does what I asked, in the style of the file you are in.',
  'Another session may be editing this tree. Re-read a file before you edit it, and never rewrite more of it than the change needs.',
  'Reply in two or three short lines: what you changed and where (file:line).',
].join('\n\n')

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

// `fork` resumes `session` under a NEW id filed under the run's own directory,
// which is what lets `claude --resume` from a workbench branch's folder find it;
// a plain resume from there answers but stays filed under the old directory.
export function askArgv({ session = null, edit = null, work = null, fork = false } = {}) {
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
      '--allowedTools',    `Edit(/${String(edit).replace(/\/+$/, '')}/**)`,
      '--max-budget-usd',  String(ASK_BUDGET_USD),
    ]
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
 * whole length when the page already cut `html`. The rules travel only on a
 * first question, as in `askPrompt`.
 */
export function editPrompt({ instruction, picks = [], page = null, followUp = false }) {
  const parts = []
  if (!followUp) parts.push(EDIT_RULES)
  const change = String(instruction ?? '').trim()
  if (change) parts.push(`Change: ${change}`)
  if (page) parts.push(`The page: ${String(page).slice(0, 300)}`)
  const htmls = picks.map(p => String(p.html ?? ''))
  const cuts  = shareBudget(htmls.map(h => h.length))
  picks.forEach((p, i) => {
    const lines = [picks.length > 1 ? `Element ${i + 1} of ${picks.length}:` : 'The element:']
    if (p.loc) lines.push(`- source: ${p.loc}`)
    const h = htmls[i], size = Math.max(Number(p.size) || 0, h.length)
    if (h) lines.push(`- rendered HTML${cuts[i] < size ? ` (first ${cuts[i]} of ${size} chars)` : ''}:\n\`\`\`html\n${h.slice(0, cuts[i])}\n\`\`\``)
    parts.push(lines.join('\n'))
  })
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

/** One parsed stream-json event → the events the page draws (often none). */
export function readAskEvent(event) {
  if (!event || typeof event !== 'object') return []
  if (event.type === 'system' && event.subtype === 'init' && event.session_id)
    return [{ type: 'session', id: event.session_id }]
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
 * Start one question. Returns `{ error }` for a session id that is not one, or
 * `{ child, done }` where `done` resolves to the exit code. Detached, so a stop
 * signals the group and takes a running `rg` with it.
 */
export function runAsk({ root, prompt, session = null, edit = null, bin = 'claude', onEvent }) {
  if (session && !SESSION_ID.test(String(session)))
    return { error: `not a session id: ${JSON.stringify(String(session).slice(0, 40))}` }

  const child = spawn(bin, askArgv({ session, edit }), {
    cwd: root, detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)

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
