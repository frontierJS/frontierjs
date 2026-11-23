// src/argv.ts — the command line each profile starts `claude` with.
//
// `claude -p` started in the project root, the prompt on STDIN (a CI run's
// output is past the size one argv string may be), stream-json read line by
// line into the few events the page draws. A follow-up resumes the session by
// id, so the second question does not re-send what the first already did, and
// the same id is what `claude --resume` takes in a terminal.
//
// READ-ONLY, by construction rather than by asking: `--tools` leaves the
// built-ins in `ASK_TOOLS` and nothing else, Bash answers only `ASK_BASH`, and
// a print session denies every other call instead of prompting — measured, a
// `touch` came back as a permission denial and the file was never made. Another
// session is usually editing this tree, and an agent nobody is watching must
// not join it.
//
// Hooks are OFF. This repo's Stop hook runs `fli done` (~25s) and BLOCKS on an
// unfinished item, so a one-question session would spend its turns chasing the
// tree's close-out — and the hook writes which items were SHOWN beside `.git`,
// so an ask would silence them for the person's own session. `--strict-mcp-config`
// with no config drops every MCP tool the account would otherwise lend it.
//
// EDIT is the one widening, and it is a path, not a mode: `Edit` and `Write`
// scoped to one directory or one file, every settings source dropped so no
// allow rule in a settings file reaches past it, and `dontAsk` so a call
// outside it is denied rather than accepted by whatever mode the account
// defaults to. An `Edit` rule covers Write too — measured, for each tool the
// call inside the scope landed and the one beside it came back as a denial.
// The path gets two rules, `Edit(<path>)` and `Edit(<path>/**)`, so it may name
// a file the session has yet to write (the workbench's Build plan) as well as a
// directory; whichever of the two does not apply grants nothing. Measured with
// a file path: a Write to it landed and a Write beside it was denied.
// `reads` adds a `Read(<dir>/**)` rule per directory, which Grep and Glob obey
// too; with no rule a Read outside the cwd is denied, and so are an app's
// framework packages, installed at the app root above the Vite root.
//
// WORK is the opposite end, for Basecamp's workbench: a build session in a
// checkout its operator pinned, every tool and every permission. Nothing above
// holds there — it is the account's own Claude Code, minus the prompts — so
// the two levers left are the budget, and whether the repo's own hooks run (a
// Stop hook that blocks spends the run's turns). The workbench's REVIEWER is
// the read-only default again.

import { ASK_BASH, ASK_BUDGET_USD, ASK_TOOLS, DRAW_BUDGET_USD, EDIT_TOOLS, WORK_BUDGET_USD, isEffort } from './limits.ts'
import { MODES } from './catalog.ts'

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `:ask`'s agent: one MCP server, named as its tools are allowed under. */
export type Agent = { server: string, url: string }
export type Draw  = { system: string, budget?: number }
// `permission`, `settingSources`, `mcp` and `addDirs` are the headless loops' (`scripts/headless.mjs`):
// an auto-mode or plan run over the project's own settings, a lane's worktree beside its main tree.
export type Work  = {
  budget?:         number
  hooks?:          boolean
  permission?:     string
  settingSources?: string
  /** `false` keeps the account's MCP servers out (`--strict-mcp-config`). */
  mcp?:            boolean
  addDirs?:        readonly string[]
}

export type AskProfile = {
  session?: string | null
  edit?:    string | null
  reads?:   readonly string[]
  work?:    Work | null
  agent?:   Agent | null
  draw?:    Draw | null
}

export type AskArgvOptions = AskProfile & {
  fork?:   boolean
  images?: boolean
  effort?: string | null
  model?:  string | null
  /** `--include-partial-messages`: the reply as it is written (an edit run has it already). */
  partial?: boolean
  /** `--append-system-prompt`: what the host adds to Claude Code's own. */
  appendSystem?: string | null
}

// `fork` resumes `session` under a NEW id filed under the run's own directory,
// which is what lets `claude --resume` from a workbench branch's folder find it;
// a plain resume from there answers but stays filed under the old directory.
// No `effort` leaves it to the account, which is what the workbench passes.
export function askArgv({ session = null, edit = null, reads = [], work = null, agent = null, draw = null, fork = false, images = false, effort = null, model = null, partial = false, appendSystem = null }: AskArgvOptions = {}): string[] {
  const argv = askFlags({ session, edit, reads, work, agent, draw, fork })
  if (effort) argv.push('--effort', effort)
  if (model)  argv.push('--model', model)
  if (partial && !argv.includes('--include-partial-messages')) argv.push('--include-partial-messages')
  if (appendSystem) argv.push('--append-system-prompt', appendSystem)
  if (images) argv.push('--input-format', 'stream-json')
  return argv
}

// SESSION is a long-lived process a host talks to over stdin
// (`fjs-prototypes/lathe/docs/claude-control-protocol.md`): every permission
// prompt, question and plan approval comes back to the host as a
// `can_use_tool` request, which is why the settings sources are named — they
// are what turns the project's hooks on, and without `stdio` as the prompt
// tool AskUserQuestion and the plan tools silently vanish.

export type SessionArgvOptions = {
  session?:        string | null
  model?:          string | null
  effort?:         string | null
  permissionMode?: string | null
  allowBypass?:    boolean
}

// `allowBypass` is for a host whose mode picker offers bypassPermissions: Claude
// Code refuses a `set_permission_mode` to it unless the process was launched
// with `--allow-dangerously-skip-permissions`, which makes the mode reachable
// without starting in it.
export function sessionArgv({ session = null, model = null, effort = null, permissionMode = null, allowBypass = false }: SessionArgvOptions = {}): string[] {
  const argv = [
    '-p',
    '--output-format',          'stream-json',
    '--verbose',
    '--input-format',           'stream-json',
    '--permission-prompt-tool', 'stdio',
    '--include-partial-messages',
    '--include-hook-events',
    '--setting-sources',        'user,project,local',
    '--replay-user-messages',
  ]
  if (model) argv.push('--model', String(model))
  if (effort && isEffort(effort)) argv.push('--effort', effort)
  if (permissionMode && (MODES as readonly string[]).includes(permissionMode)) argv.push('--permission-mode', permissionMode)
  if (allowBypass) argv.push('--allow-dangerously-skip-permissions')
  if (session && SESSION_ID.test(String(session))) argv.push('--resume', String(session))
  return argv
}

function askFlags({ session, edit, reads = [], work, agent, draw, fork }: AskProfile & { fork: boolean }): string[] {
  // DRAW is `project:diagram`: no tool at all and the whole system prompt
  // replaced, so stdin is the only thing it reads and one input gives one page.
  if (draw) return [
    '-p',
    '--output-format',   'stream-json',
    '--verbose',
    '--system-prompt',   String(draw.system),
    '--settings',        JSON.stringify({ disableAllHooks: true }),
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools',           '',
    '--max-budget-usd',  String(Number(draw.budget) > 0 ? Number(draw.budget) : DRAW_BUDGET_USD),
  ]
  // AGENT is `:ask`: no built-in tool, one MCP server (`agent.server`, the name
  // the tools are allowed under) and every tool on it. `dontAsk` denies anything
  // else rather than prompting, as in EDIT.
  if (agent) {
    if (!agent.server) throw new Error('askArgv: an agent names its MCP server')
    const argv = [
      '-p',
      '--output-format',   'stream-json',
      '--verbose',
      '--settings',        JSON.stringify({ disableAllHooks: true }),
      '--setting-sources', '',
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--mcp-config',      JSON.stringify({ mcpServers: { [agent.server]: { type: 'http', url: String(agent.url) } } }),
      '--tools',           '',
      '--allowedTools',    `mcp__${agent.server}`,
      '--max-budget-usd',  String(ASK_BUDGET_USD),
    ]
    if (session) argv.push('--resume', session)
    return argv
  }
  if (work) {
    const argv = [
      '-p',
      '--output-format',  'stream-json',
      '--verbose',
      '--permission-mode', work.permission || 'bypassPermissions',
      '--max-budget-usd', String(Number(work.budget) > 0 ? Number(work.budget) : WORK_BUDGET_USD),
    ]
    if (!work.hooks) argv.push('--settings', JSON.stringify({ disableAllHooks: true }))
    if (work.settingSources !== undefined) argv.push('--setting-sources', work.settingSources)
    if (work.mcp === false) argv.push('--strict-mcp-config')
    for (const d of work.addDirs ?? []) argv.push('--add-dir', d)
    if (session) argv.push('--resume', session)
    if (session && fork) argv.push('--fork-session')
    return argv
  }
  if (edit) {
    const scope = String(edit).replace(/\/+$/, '')
    const argv = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--settings',        JSON.stringify({ disableAllHooks: true }),
      '--setting-sources', '',
      '--permission-mode', 'dontAsk',
      '--strict-mcp-config',
      '--tools',           EDIT_TOOLS.join(','),
      // A file outside the working directory is not readable by default, and
      // Edit refuses a file it has not read: the plan the ask panel writes
      // at the app root, beside a Vite root that is the working directory.
      '--allowedTools',    `Edit(/${scope})`, `Edit(/${scope}/**)`, `Read(/${scope})`, `Read(/${scope}/**)`, ...reads.map(d => `Read(/${String(d).replace(/\/+$/, '')}/**)`),
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
export function resumeCommand(root: string, session: string | null | undefined): string | null {
  if (!SESSION_ID.test(String(session))) return null
  return `cd ${shellWord(root)} && claude --resume ${session}`
}

const shellWord = (s: string) => /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`
