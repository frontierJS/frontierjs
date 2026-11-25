// src/calls.ts — every tool call a transcript records, with its input and what came back.
//
// For a review of what sessions did on this machine — which files a run read,
// which command failed and why, which skill it loaded — and never for a page.
// The turn fold (`transcript.ts`) keeps a call's name and a one-line summary
// and a result's size, because inputs carry file bodies and commands with
// tokens in them; this keeps the INPUT and the result's TEXT. A screen that
// lists sessions reads `foldTranscript`.
//
// A streamed reply repeats its `message.id` across lines, one content block
// each, so a call is kept once by its `tool_use` id. A subagent's lines in the
// parent's file (`isSidechain`) are kept and marked, since one review counts a
// skill a subagent loaded and another reads only the main thread. `replies` is
// the main thread's text alone.
//
// Pure and never throws; a line that does not parse is skipped, because
// Claude Code appends while this reads.

import { read, unreadable, type Read } from './read.ts'
import { promptText } from './transcript.ts'

export type ToolUse = {
  id:        string
  name:      string
  input:     Record<string, unknown>
  /** The directory the session was in when it made the call. */
  cwd:       string | null
  at:        string | null
  sidechain: boolean
  /** null while no result line follows (a call still running, or interrupted). */
  result:    { error: boolean, text: string } | null
}

export type ToolCalls = {
  sessionId: string | null
  cwd:       string | null
  /** The first line's time that has one. */
  startedAt: string | null
  /** The first prompt typed, whole. */
  prompt:    string | null
  calls:     ToolUse[]
  /** The main thread's text blocks, in order. */
  replies:   string[]
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => typeof v === 'string' && v ? v : null

const resultText = (content: unknown): string =>
  typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(b => isObj(b) && typeof b.text === 'string' ? b.text : '').join('\n')
  : ''

/** The transcript's tool calls and replies. `unreadable` only when no line parses as a transcript line. */
export function readToolCalls(text: string): Read<ToolCalls> {
  const out: ToolCalls = { sessionId: null, cwd: null, startedAt: null, prompt: null, calls: [], replies: [] }
  const byId = new Map<string, ToolUse>()
  let parsed = 0

  for (const line of text.split('\n')) {
    if (!line) continue
    let o: any
    try { o = JSON.parse(line) } catch { continue }
    if (!isObj(o) || typeof o.type !== 'string') continue
    parsed++

    out.sessionId ??= str(o.sessionId)
    out.startedAt ??= str(o.timestamp)
    if (o.type !== 'attachment') out.cwd ??= str(o.cwd)
    const sidechain = o.isSidechain === true
    const content = isObj(o.message) && Array.isArray(o.message.content) ? o.message.content : []

    if (o.type === 'user') {
      if (!sidechain && out.prompt === null) out.prompt = promptText(o)
      for (const b of content) {
        if (!isObj(b) || b.type !== 'tool_result') continue
        const call = byId.get(String(b.tool_use_id))
        if (call) call.result = { error: b.is_error === true, text: resultText(b.content) }
      }
    } else if (o.type === 'assistant') {
      for (const b of content) {
        if (!isObj(b)) continue
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim() && !sidechain) out.replies.push(b.text)
        else if (b.type === 'tool_use' && typeof b.id === 'string' && !byId.has(b.id)) {
          const call: ToolUse = {
            id: b.id, name: String(b.name ?? ''), input: isObj(b.input) ? b.input : {},
            cwd: str(o.cwd), at: str(o.timestamp), sidechain, result: null,
          }
          byId.set(b.id, call)
          out.calls.push(call)
        }
      }
    }
  }
  if (parsed === 0) return unreadable('no line of this file parses as a Claude Code transcript line')
  return read(out)
}
