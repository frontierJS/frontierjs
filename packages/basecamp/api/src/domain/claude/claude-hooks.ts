// src/domain/claude/claude-hooks.ts — the hooks a plugin or a settings file declares.
//
// Two files share one shape: a plugin's `hooks/hooks.json` and the `hooks` key
// of a `settings.json` both map an event to matcher groups, each group holding
// handlers. A group is a matcher plus its handlers, so the entry here is the
// group; the handlers stay under it.
//
// Claude Code adds events and handler types between releases, so an event this
// file does not know is KEPT with an issue — dropping it would hide a hook that
// still runs. A handler carries its command and timeout; every other key is
// named in `otherKeys` and its value left behind, because an `http` handler's
// headers and URL query carry tokens.
//
// `matcher` belongs to the group. On an event that has no matcher it is
// ignored silently by Claude Code, which makes a hook the author believes is
// narrowed fire on everything — the entry says so.

import { read, readJsonObject, unreadable, type Read } from './claude-read.ts'

export type HookHandler = {
  type:          string | null
  command:       string | null
  /** Seconds, as written. */
  timeout:       number | null
  async:         boolean | null
  statusMessage: string | null
  otherKeys:     string[]
}

export type HookEntry = {
  event:    string
  matcher:  string | null
  handlers: HookHandler[]
  issues:   string[]
}

const WITH_MATCHER = [
  'Setup', 'SessionStart', 'UserPromptExpansion', 'PreToolUse', 'PermissionRequest',
  'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart',
  'SubagentStop', 'StopFailure', 'InstructionsLoaded', 'ConfigChange', 'DirectoryAdded',
  'FileChanged', 'PreCompact', 'PostCompact', 'PreModelSwitch', 'PostModelSwitch',
  'Elicitation', 'ElicitationResult', 'SessionEnd',
]

const WITHOUT_MATCHER = [
  'UserPromptSubmit', 'PostToolBatch', 'MessageDisplay', 'TaskCreated', 'TaskCompleted',
  'Stop', 'TeammateIdle', 'CwdChanged', 'WorktreeCreate', 'WorktreeRemove',
]

const MATCHES  = new Set(WITH_MATCHER)
const EVENTS   = new Set([...WITH_MATCHER, ...WITHOUT_MATCHER])
const HANDLED  = new Set(['type', 'command', 'timeout', 'async', 'statusMessage'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function readHandler(raw: unknown, issues: string[]): HookHandler | null {
  if (!isObject(raw)) { issues.push('a handler is not an object'); return null }
  const type = typeof raw.type === 'string' ? raw.type : null
  if (type === null) issues.push('a handler has no type')

  const command = typeof raw.command === 'string' ? raw.command : null
  if (type === 'command' && !command) issues.push('a command handler has no command')

  let timeout: number | null = null
  if (raw.timeout !== undefined) {
    if (typeof raw.timeout === 'number' && Number.isFinite(raw.timeout) && raw.timeout > 0) timeout = raw.timeout
    else issues.push('a handler timeout is not a positive number')
  }

  return {
    type,
    command,
    timeout,
    async:         typeof raw.async === 'boolean' ? raw.async : null,
    statusMessage: typeof raw.statusMessage === 'string' ? raw.statusMessage : null,
    otherKeys:     Object.keys(raw).filter(k => !HANDLED.has(k)),
  }
}

/** The value of a `hooks` key — an event to its matcher groups. */
export function readHooks(value: unknown): Read<HookEntry[]> {
  if (!isObject(value)) return unreadable('hooks is not an object')
  const entries: HookEntry[] = []

  for (const [event, groups] of Object.entries(value)) {
    const known = EVENTS.has(event)
    const eventIssue = known ? [] : [`unknown event ${event}`]

    if (!Array.isArray(groups)) {
      entries.push({ event, matcher: null, handlers: [], issues: [...eventIssue, 'the event is not a list of matcher groups'] })
      continue
    }

    for (const group of groups) {
      const issues = [...eventIssue]
      if (!isObject(group)) {
        entries.push({ event, matcher: null, handlers: [], issues: [...issues, 'a matcher group is not an object'] })
        continue
      }

      let matcher: string | null = null
      if (group.matcher !== undefined) {
        if (typeof group.matcher === 'string') matcher = group.matcher
        else issues.push('matcher is not a string')
      }
      if (matcher !== null && matcher !== '' && known && !MATCHES.has(event)) {
        issues.push(`${event} has no matcher; Claude Code ignores it`)
      }

      const handlers: HookHandler[] = []
      if (!Array.isArray(group.hooks)) issues.push('a matcher group has no hooks list')
      else for (const raw of group.hooks) {
        const handler = readHandler(raw, issues)
        if (handler) handlers.push(handler)
      }
      entries.push({ event, matcher, handlers, issues })
    }
  }
  return read(entries)
}

/** A plugin's `hooks/hooks.json`. */
export function parseHooksJson(text: string): Read<HookEntry[]> {
  const json = readJsonObject(text)
  if (!json.ok) return json
  if (json.value.hooks === undefined) return unreadable('no hooks key')
  return readHooks(json.value.hooks)
}

// ─── what a command calls ─────────────────────────────────────────────────────

// Words that start a segment without being the program it runs.
const PREFIXES = new Set(['!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'exec', 'command', 'env', 'nohup', 'time', 'sudo', 'xargs', '{', '('])
// Builtins and keywords: never on PATH, never missing.
const BUILTINS = new Set([
  'cd', 'echo', 'printf', 'test', '[', '[[', 'true', 'false', 'exit', 'export', 'set', 'unset', 'read', 'source', '.',
  'eval', 'return', 'local', 'shift', 'trap', 'wait', 'type', 'fi', 'done', 'esac', 'case', 'for', 'in', '}', ')', ':',
])

const unquote = (w: string): string => w.replace(/"([^"]*)"|'([^']*)'/g, '$1$2')

/** Split on unquoted `|`, `||`, `&&`, `;`, `&` and newlines; a regex in quotes holds `|` too. */
function segments(command: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const ch of command) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if ('|;&\n'.includes(ch)) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

/**
 * The programs a hook command line calls, in order and once each — the first word
 * of each pipeline segment past env assignments and wrappers like `sudo`. A path
 * (`${CLAUDE_PLUGIN_ROOT}/hooks/x.sh`) is kept as written; the caller resolves its
 * variables. A shell parse would be exact; this reads the common shapes, so a
 * miss shows as a tool not listed rather than a wrong one, and `$(…)` is not entered.
 */
export function commandTools(command: string): string[] {
  const out: string[] = []
  for (const seg of segments(command.replace(/\\\n/g, ' '))) {
    // `"$DIR"/x.sh` is one word: quoted and bare parts run together.
    const words = seg.trim().match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []
    let i = 0
    while (i < words.length && (PREFIXES.has(words[i]) || /^[A-Za-z_]\w*=/.test(words[i]) || (words[i - 1] === 'env' && words[i].startsWith('-')))) i++
    const word = words[i] ? unquote(words[i]) : ''
    if (!word || BUILTINS.has(word) || word.startsWith('-') || word.startsWith('#') || /^[<>]/.test(word) || word.startsWith('$(')) continue
    if (!out.includes(word)) out.push(word)
  }
  return out
}
