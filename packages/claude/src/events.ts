// src/events.ts — one stream-json line from `claude` into the events a page draws.
//
// `StreamLine` is the part of the protocol `readAskEvent` reads, typed from the
// recordings in `test/fixtures/`; every member keeps an index signature for the
// fields it ignores. Any other line — `rate_limit_event`, a control frame, a
// `system` subtype other than `init` and `status` — reads as no event.

/** What a tool was called with; the reader looks at these keys only. */
export type ToolInput = {
  command?:     string
  file_path?:   string
  pattern?:     string
  path?:        string
  old_string?:  string
  new_string?:  string
  replace_all?: boolean
  content?:     string
  [key: string]: unknown
}

export type ContentPart =
  | { type: 'text', text: string, [key: string]: unknown }
  | { type: 'thinking' | 'redacted_thinking', [key: string]: unknown }
  | { type: 'tool_use', id: string, name: string, input: ToolInput, [key: string]: unknown }
  | { type: 'tool_result', tool_use_id: string, content: string | Array<{ type: string, text?: string }>, is_error?: boolean, [key: string]: unknown }

type Loose = { [key: string]: unknown }

/** A Messages API stream event, as `--include-partial-messages` wraps it. */
export type ApiEvent =
  | { type: 'content_block_start', index: number, content_block: ContentPart } & Loose
  | { type: 'content_block_delta', index: number, delta: { type: string, text?: string } & Loose } & Loose
  | { type: 'content_block_stop' | 'message_start' | 'message_delta' | 'message_stop' } & Loose

export type StreamLine =
  | { type: 'system', subtype: string, session_id?: string, status?: string | null } & Loose
  | { type: 'stream_event', event: ApiEvent, parent_tool_use_id: string | null } & Loose
  | { type: 'assistant', message: { content: ContentPart[] } & Loose, parent_tool_use_id: string | null } & Loose
  | { type: 'user', message: { content: ContentPart[] } & Loose } & Loose
  | { type: 'result', subtype: string, is_error: boolean, total_cost_usd?: number, num_turns?: number, permission_denials?: unknown[] } & Loose

/**
 * What the page draws. A `delta` is reply text as it streams; the `text` after
 * it is the same block whole, and replaces it. `read`, `edit` and `write` are
 * what an undo reverses; `landed`/`refused` say whether the call with that id
 * went through. `error` is `runAsk`'s own, never the stream's. The `agent*`
 * events are a subagent's: its Agent call, and the `system/task_*` frames of
 * its start, progress and end; `readAskEvent` makes none of them, a session does.
 */
export type AskEvent =
  | { type: 'session', id: string }
  | { type: 'status' | 'delta' | 'text' | 'tool' | 'error', text: string }
  | { type: 'read', id: string, file: string }
  | { type: 'edit', id: string, file: string, old: string, new: string, all: boolean }
  | { type: 'write', id: string, file: string, content: string }
  | { type: 'refused', id: string, text: string }
  | { type: 'landed', id: string, created?: true }
  | { type: 'result', ok: boolean, stop: string | null, cost: number | null, turns: number | null, denied: number }
  | { type: 'agent', id: string, title: string, kind: string, background: boolean, prompt: string }
  | { type: 'agent-started', id: string, task: string, background: boolean }
  | { type: 'agent-progress', id: string, doing: string, tokens: number, tools: number, ms: number }
  | { type: 'agent-done', id: string, status: string, summary: string, tokens: number, tools: number, ms: number }

type ToolUse    = Extract<ContentPart, { type: 'tool_use' }>
type ToolResult = Extract<ContentPart, { type: 'tool_result' }>

// A tool call in one line: the part of its input a person would recognize.
function toolLine(part: ToolUse): string {
  const i = part.input ?? {}
  // An app tool's input is the whole of what it was asked to do.
  const what = i.command ?? i.file_path ?? i.pattern ?? i.path ?? (String(part.name).startsWith('mcp__') ? JSON.stringify(i) : '')
  return `${part.name}${what ? ` ${String(what).split('\n')[0].slice(0, 160)}` : ''}`
}

// A Write's result is the one witness that the file did not exist before it:
// looking at the call races the write itself. Measured wording; if it ever
// changes, a new file is only undone when the look won the race.
const CREATED = /^File created successfully/
const resultText = (part: ToolResult): string => typeof part.content === 'string' ? part.content
  : (part.content ?? []).map(c => c?.text ?? '').join('')

// What a block starting means to somebody waiting on it.
const BLOCK_DOING: Record<string, string> = { thinking: 'thinking', redacted_thinking: 'thinking', text: 'writing' }
const TOOL_DOING:  Record<string, string> = { Read: 'reading', Grep: 'reading', Glob: 'reading', Edit: 'editing', Write: 'editing' }

/** One parsed stream-json line → the events the page draws (often none). */
export function readAskEvent(line: unknown): AskEvent[] {
  if (!line || typeof line !== 'object') return []
  const event = line as StreamLine
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
    const out: AskEvent[] = []
    for (const part of event.message?.content ?? []) {
      if (part.type === 'text' && part.text?.trim()) out.push({ type: 'text', text: part.text })
      if (part.type !== 'tool_use') continue
      out.push({ type: 'tool', text: toolLine(part) })
      // What an undo reverses. Reported at the CALL, which may yet be denied;
      // the tool's result below is what says whether it landed. A Read is
      // reported because it comes before any change to that file, so it is
      // the moment the file's original can be copied without racing the write.
      const input = part.input
      if (!input?.file_path) continue
      if (part.name === 'Read') out.push({ type: 'read', id: part.id, file: input.file_path })
      if (part.name === 'Edit') out.push({
        type: 'edit', id: part.id, file: input.file_path,
        old: input.old_string ?? '', new: input.new_string ?? '', all: !!input.replace_all,
      })
      if (part.name === 'Write') out.push({
        type: 'write', id: part.id, file: input.file_path, content: input.content ?? '',
      })
    }
    return out
  }
  if (event.type === 'user') return (event.message?.content ?? [])
    .filter((part): part is ToolResult => part?.type === 'tool_result')
    .map((part): AskEvent => part.is_error ? { type: 'refused', id: part.tool_use_id, text: resultText(part).slice(0, 400) }
      : { type: 'landed', id: part.tool_use_id, ...(CREATED.test(resultText(part)) ? { created: true as const } : {}) })
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

// ─── subagents ────────────────────────────────────────────────────────────

const AGENT_TOOLS = new Set(['Agent', 'Task'])
const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** The `agent` event of a main-chat `tool_use` part that starts a subagent, or null for any other part. */
export function agentCall(part: Record<string, unknown>): Extract<AskEvent, { type: 'agent' }> | null {
  if (part?.type !== 'tool_use' || !AGENT_TOOLS.has(String(part.name)) || typeof part.id !== 'string') return null
  const i = (part.input ?? {}) as Record<string, unknown>
  return { type: 'agent', id: part.id, title: str(i.description) || 'Agent', kind: str(i.subagent_type) || 'general-purpose', background: !!i.run_in_background, prompt: str(i.prompt) }
}

/**
 * The event a `system` frame about a subagent's task makes: its start, its
 * progress (live only) and its end. Null for any other frame, and for a task
 * that is no agent's (a background command has `task_*` frames too); `known`
 * is the agents started so far, which a `task_started` adds to.
 */
export function agentEventOf(f: Record<string, unknown>, known: Set<string>): AskEvent | null {
  if (f.type !== 'system' || typeof f.tool_use_id !== 'string') return null
  const id = f.tool_use_id
  const usage = (f.usage ?? {}) as Record<string, unknown>
  const use = { tokens: num(usage.total_tokens), tools: num(usage.tool_uses), ms: num(usage.duration_ms) }
  if (f.subtype === 'task_started') {
    if (f.task_type !== 'local_agent') return null
    known.add(id)
    return { type: 'agent-started', id, task: str(f.task_id), background: !!f.is_backgrounded }
  }
  if (!known.has(id)) return null
  if (f.subtype === 'task_progress') return { type: 'agent-progress', id, doing: str(f.description), ...use }
  if (f.subtype === 'task_notification') return { type: 'agent-done', id, status: typeof f.status === 'string' ? f.status : 'completed', summary: str(f.summary), ...use }
  return null
}
