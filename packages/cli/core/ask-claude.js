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

import { spawn, spawnSync } from 'node:child_process'

export const ASK_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']
export const ASK_BASH  = ['git status:*', 'git diff:*', 'git log:*', 'git show:*', 'rg:*', 'ls:*']

// A press is a question, not a work session; a loop that reads the whole tree
// stops here rather than on the account's limit.
export const ASK_BUDGET_USD = 2

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

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function askArgv({ session = null } = {}) {
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

// A tool call in one line: the part of its input a person would recognize.
function toolLine(part) {
  const i = part.input ?? {}
  const what = i.command ?? i.file_path ?? i.pattern ?? i.path ?? ''
  return `${part.name}${what ? ` ${String(what).split('\n')[0].slice(0, 160)}` : ''}`
}

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
    }
    return out
  }
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
export function runAsk({ root, prompt, session = null, bin = 'claude', onEvent }) {
  if (session && !SESSION_ID.test(String(session)))
    return { error: `not a session id: ${JSON.stringify(String(session).slice(0, 40))}` }

  const child = spawn(bin, askArgv({ session }), {
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
