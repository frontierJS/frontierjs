// ─── ask-prompt.js — what `fli ai` and the console say to Claude ────────────
//
// The output panel's ask, `fli ask`'s question and the `:ask` agent: the rules
// each sends and the prompt each builds. `@frontierjs/claude` owns how the session
// is started and reads none of this.

import { gitOut } from './git.js'

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

// `fli ask`. Without the FrontierJS framing a bare "how do I make a server?"
// gets Express and FastAPI back.
export const QUESTION_RULES = [
  'I asked from `fli ask` in a terminal, inside a FrontierJS workspace. Answer for FrontierJS — its fli CLI, its schema (db/schema.lite), its packages — not with another framework\'s habits. Where the question could mean several things, answer the FrontierJS reading of it rather than asking which I meant.',
  'Every fli command is listed below with its one-line description. A fli command is a markdown file under packages/cli/commands/<namespace>/<name>.md (or an app\'s own commands/) whose frontmatter lists its flags and examples.',
  'Never invent a command, flag or API. Every command you give is one you saw listed below or in the tree.',
  'Lead with the command or snippet that does it, then what to know about it in a few short lines, then the file that says more. Plain markdown, short — it prints in a terminal.',
].join('\n\n')

// The API route has no tools, and a model told to open a file it cannot open
// says it did.
export const QUESTION_SEARCH = {
  tools: 'Find the answer in this project before answering from memory: the command file (open it before you quote a flag), README.md, CLAUDE.md and docs/. You are read-only: Read, Grep, Glob, and rg, ls and git in Bash. Read only what you need and stop as soon as you can answer.',
  none:  'You cannot read this project, only the command list below: where a flag or detail matters, name the command file to open rather than guessing it.',
}

/**
 * One `fli ask`: the rules, any the person added, the command list, then the
 * question — left out for the API route, which sends this as its system prompt.
 */
export function questionPrompt({ question = '', commands = [], system = '', tools = true } = {}) {
  const q = String(question ?? '').trim()
  return [
    QUESTION_RULES,
    tools ? QUESTION_SEARCH.tools : QUESTION_SEARCH.none,
    String(system).trim().slice(0, ASK_MAX_RULES),
    commands.length && `The fli commands:\n${commands.join('\n')}`,
    q && `The question:\n\n${q}`,
  ].filter(Boolean).join('\n\n')
}

// `:ask` (`IDEAS/one-console.md` Phase 5): an agent over the running app, its
// only tools the app's MCP tools at the standing the pane declared
// (`FJS-D1391`). The standing is in the URL the agent is handed, so no
// sentence here can widen it.
export const AGENT_SERVER = 'app'

export const AGENT_RULES = [
  'I asked from the :ask pane of the fli console, the FrontierJS control surface. You act on the running app through its MCP tools and nothing else.',
  'The tools are what the standing I declared is offered, and the app grades every call as it grades that person\'s. A refusal is the app answering: report it as it came back, never work around it.',
  'The answer renders in a narrow console: keep it short and plain.',
].join('\n\n')

/** One `:ask` question: the rules on a first question, the standing, the question. */
export function agentPrompt({ question, as = '', tenant = '', followUp = false } = {}) {
  const who = String(as).trim() ? `as ${String(as).trim()}` : 'as nobody, the guest standing'
  const where = String(tenant).trim() ? `, in tenant ${String(tenant).trim()}` : ''
  return [followUp ? null : AGENT_RULES, `Standing: ${who}${where}.`, `Question: ${String(question ?? '').trim().slice(0, 4000)}`]
    .filter(Boolean).join('\n\n')
}

// A pasted essay is still a question, but not one a $2 budget should spend
// its tokens re-reading on every turn.
export const ASK_MAX_RULES = 4000

export function gitContext(root) {
  const out = gitOut(root, ['status', '--short', '--branch'])
  if (out === null) return null
  const lines = out.trimEnd().split('\n')
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
