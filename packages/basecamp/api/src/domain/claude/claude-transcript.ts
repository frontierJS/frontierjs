// src/domain/claude/claude-transcript.ts — one Claude Code transcript folded into turns.
//
// A transcript is a JSONL of everything a session did, and most of it is not
// conversation: request blobs, file-history snapshots, hook output, one line
// per streamed content block. A turn is one prompt the user typed and
// everything up to the next one — the assistant's text, each tool call with
// what came back of it, and what the turn cost.
//
// **A streamed reply repeats its `message.id` across lines, one content block
// each**, so blocks merge by id and the last line's `usage` is the reply's.
// Counting a line per message would multiply every reply's tokens.
//
// **A tool call is a name and a one-line summary, never its input**, and a
// result is ok/error plus a byte count, never its text: inputs carry file
// bodies and commands with tokens in them, and a screen listing turns must not
// be the place a secret from a session resurfaces. Prompt and reply text is
// the conversation itself and is shown, cut at `TEXT_CAP` characters with the
// cut said.
//
// `readTranscript` reads any file path a caller names, so it refuses one that
// is not inside `<configDir>/projects/` after symlinks resolve: the path
// arrives from a request.
//
// `foldTranscript` is pure and never throws; a line that does not parse is
// skipped, because Claude Code appends while this reads.

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, sep } from 'node:path'
import { claudeConfigDir } from './claude-scan.ts'
import { read, unreadable, type Read } from './claude-read.ts'

export type Text = {
  text:      string
  /** Characters in the original; more than `text.length` when cut. */
  chars:     number
  truncated: boolean
}

export type ToolCall = {
  id:      string
  name:    string
  /** One line: a Bash description, a file path, a pattern. Empty when the input names nothing worth showing. */
  summary: string
  /** null while no result line follows (a call still running, or interrupted). */
  result:  { ok: boolean, bytes: number } | null
}

export type Turn = {
  index:     number
  at:        string | null
  prompt:    Text
  /** The assistant's text blocks in order; thinking is not kept. */
  replies:   Text[]
  tools:     ToolCall[]
  /** Distinct model ids that answered this turn, in order. */
  models:    string[]
  tokens:    { input: number, cacheCreation: number, cacheRead: number, output: number }
  /** Distinct replies (message ids) in the turn. */
  messages:  number
}

export type Folded = {
  sessionId: string | null
  cwd:       string | null
  title:     string | null
  turns:     Turn[]
}

export const TEXT_CAP    = 4096
export const SUMMARY_CAP = 120
/** A transcript is read whole; past this it is refused rather than held in memory. */
export const MAX_BYTES   = 50 * 1024 * 1024

// ─── the pure half ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function cap(text: string): Text {
  return text.length > TEXT_CAP
    ? { text: text.slice(0, TEXT_CAP), chars: text.length, truncated: true }
    : { text, chars: text.length, truncated: false }
}

const oneLine = (s: string): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > SUMMARY_CAP ? `${flat.slice(0, SUMMARY_CAP - 1)}…` : flat
}

const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null

/** What a tool call was about, from the input fields that name it. Never the whole input. */
function summarize(name: string, input: unknown): string {
  if (!isObj(input)) return ''
  const first = (...keys: string[]): string | null => {
    for (const k of keys) { const v = str(input[k]); if (v) return v }
    return null
  }
  const picked =
    name === 'Bash'                                 ? first('description', 'command')
    : /^(Read|Edit|Write|NotebookEdit|MultiEdit)$/.test(name) ? first('file_path', 'notebook_path', 'path')
    : /^(Grep|Glob)$/.test(name)                    ? first('pattern')
    : /^(Agent|Task)$/.test(name)                   ? first('description', 'subagent_type')
    : name === 'Skill'                              ? first('skill')
    : first('description', 'file_path', 'path', 'pattern', 'query', 'url', 'command', 'name')
  return picked ? oneLine(picked) : ''
}

/** A tool result's size in bytes of the text it carried. */
function resultBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content)
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) n += isObj(b) && typeof b.text === 'string' ? Buffer.byteLength(b.text) : isObj(b) ? JSON.stringify(b).length : 0
  return n
}

/** The words of a user line, or null when it is not a typed prompt (a tool result, a notification). */
function promptText(o: Record<string, any>): string | null {
  if (o.isMeta === true || !isObj(o.message)) return null
  // `peer` and `task-notification` lines are injected, not typed; they belong to the turn they land in.
  const kind = isObj(o.origin) ? o.origin.kind : null
  if (kind && kind !== 'human') return null
  const c = o.message.content
  if (typeof c === 'string') return c.trim() ? c : null
  if (!Array.isArray(c) || c.some(b => isObj(b) && b.type === 'tool_result')) return null
  const words: string[] = []
  let image = false
  for (const b of c) {
    if (!isObj(b)) continue
    if (b.type === 'image') image = true
    // The IDE's selection and Claude Code's own reminders ride in the same message as the words.
    else if (b.type === 'text' && typeof b.text === 'string' && !/^\s*<(system-reminder|ide_)/.test(b.text)) words.push(b.text)
  }
  const text = words.join('\n').trim()
  return text || image ? (image ? `${text}${text ? '\n' : ''}[image]` : text) : null
}

type Open = Turn & { byId: Map<string, Record<string, any>>, calls: Map<string, ToolCall> }

function close(t: Open): Turn {
  const tokens = { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }
  for (const u of t.byId.values()) {
    tokens.input         += Number(u.input_tokens) || 0
    tokens.cacheCreation += Number(u.cache_creation_input_tokens) || 0
    tokens.cacheRead     += Number(u.cache_read_input_tokens) || 0
    tokens.output        += Number(u.output_tokens) || 0
  }
  const { byId, calls, ...turn } = t
  return { ...turn, tokens, messages: byId.size }
}

/** The transcript as turns. `unreadable` only when no line parses as a transcript line at all. */
export function foldTranscript(text: string): Read<Folded> {
  const out: Folded = { sessionId: null, cwd: null, title: null, turns: [] }
  let cur: Open | null = null
  let parsed = 0

  for (const line of text.split('\n')) {
    if (!line) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    if (!isObj(o) || typeof o.type !== 'string') continue
    parsed++

    out.sessionId ??= str(o.sessionId)
    if (o.type !== 'attachment') out.cwd ??= str(o.cwd)
    if (o.type === 'ai-title' && str(o.aiTitle)) out.title = o.aiTitle
    if (o.type === 'custom-title' && str(o.customTitle)) out.title = o.customTitle
    if (o.isSidechain === true) continue

    if (o.type === 'user') {
      const prompt = promptText(o)
      if (prompt !== null) {
        if (cur) out.turns.push(close(cur))
        cur = {
          index: out.turns.length, at: str(o.timestamp), prompt: cap(prompt), replies: [], tools: [], models: [],
          tokens: { input: 0, cacheCreation: 0, cacheRead: 0, output: 0 }, messages: 0,
          byId: new Map(), calls: new Map(),
        }
        continue
      }
      if (cur && isObj(o.message) && Array.isArray(o.message.content)) {
        for (const b of o.message.content) {
          if (!isObj(b) || b.type !== 'tool_result') continue
          const call = cur.calls.get(String(b.tool_use_id))
          if (call) call.result = { ok: b.is_error !== true, bytes: resultBytes(b.content) }
        }
      }
    } else if (o.type === 'assistant' && cur && isObj(o.message)) {
      const m = o.message
      // The last line of a streamed reply carries its final usage.
      if (typeof m.id === 'string' && isObj(m.usage)) cur.byId.set(m.id, m.usage)
      if (typeof m.model === 'string' && !m.model.startsWith('<') && !cur.models.includes(m.model)) cur.models.push(m.model)
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!isObj(b)) continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) cur.replies.push(cap(b.text))
        else if (b.type === 'tool_use' && typeof b.id === 'string' && !cur.calls.has(b.id)) {
          const call: ToolCall = { id: b.id, name: String(b.name ?? ''), summary: summarize(String(b.name ?? ''), b.input), result: null }
          cur.calls.set(b.id, call)
          cur.tools.push(call)
        }
      }
    }
  }
  if (cur) out.turns.push(close(cur))
  if (parsed === 0) return unreadable('no line of this file parses as a Claude Code transcript line')
  return read(out)
}

// ─── the fs half ──────────────────────────────────────────────────────────────

/**
 * A transcript's turns, from a path a caller named. Refused unless the real
 * path is a `.jsonl` file under `<configDir>/projects/`.
 */
export function readTranscript(path: string, opts: { configDir?: string } = {}): Read<Folded> {
  if (typeof path !== 'string' || !path || path.includes('\0')) return unreadable('no transcript path given')
  if (!isAbsolute(path)) return unreadable('a transcript path must be absolute')
  if (path.split(/[\\/]/).includes('..')) return unreadable("a transcript path may not contain '..'")
  if (!path.endsWith('.jsonl')) return unreadable('a transcript is a .jsonl file')

  let root: string, real: string
  try { root = realpathSync(join(opts.configDir ?? claudeConfigDir(), 'projects')) }
  catch { return unreadable('no Claude Code projects folder') }
  try { real = realpathSync(path) } catch { return unreadable('transcript not found') }
  if (!real.startsWith(root + sep)) return unreadable('that path is not inside the Claude Code projects folder')

  let size: number
  try {
    const st = statSync(real)
    if (!st.isFile()) return unreadable('that path is not a file')
    size = st.size
  } catch { return unreadable('transcript not found') }
  if (size > MAX_BYTES) return unreadable(`transcript is ${Math.round(size / 1024 / 1024)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB`)

  let text: string
  try { text = readFileSync(real, 'utf8') } catch { return unreadable('transcript could not be read') }
  return foldTranscript(text)
}
