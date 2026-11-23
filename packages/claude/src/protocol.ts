// src/protocol.ts — the host's half of Claude Code's stream-json control
// protocol (docs/control-protocol.md), with no process in it: bytes in, frames
// out, lines to write. `session.ts` owns the child; this owns what a line means.

export type Frame = Record<string, unknown> & { type?: string }
export type Decision =
  | { behavior: 'allow', updatedInput: unknown, updatedPermissions?: unknown[] }
  | { behavior: 'deny', message: string, interrupt?: boolean }

/** A `can_use_tool` the CLI is waiting on: the card's facts, and the input an allow must send back. */
export type Ask = {
  request: string
  tool: string
  input: unknown
  suggestions: unknown[]
  toolUseId: string | null
  description: string | null
}

/**
 * Splits stdout into frames. A chunk may end mid-line, so the tail is held for
 * the next one; a line that is not JSON (a warning the CLI printed) is handed
 * back as junk rather than ending the read.
 */
export class LineReader {
  private buf = ''

  push(chunk: string): { frames: Frame[], junk: string[] } {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop() ?? ''
    return read(lines)
  }

  /** What is left when the stream closes, a last line with no newline among it. */
  flush(): { frames: Frame[], junk: string[] } {
    const rest = this.buf
    this.buf = ''
    return read([rest])
  }
}

function read(lines: string[]) {
  const frames: Frame[] = []
  const junk: string[] = []
  for (const l of lines) {
    if (!l.trim()) continue
    try {
      const v = JSON.parse(l)
      if (v && typeof v === 'object' && !Array.isArray(v)) frames.push(v as Frame)
      else junk.push(l)
    } catch {
      junk.push(l)
    }
  }
  return { frames, junk }
}

/** What one incoming frame is for the host. */
export type Incoming =
  | { kind: 'ask', ask: Ask }
  | { kind: 'withdrawn', request: string }
  | { kind: 'replay', frame: Frame }
  | { kind: 'frame', frame: Frame }
  | { kind: 'none' }

/** A request the CLI answered with an error, or one the process ended under. */
export class ControlError extends Error {}

type Waiting = { resolve(v: unknown): void, reject(e: Error): void }

/**
 * The control channel over one process. `write` takes one line; ids for the
 * host's own requests are chosen here and matched on the way back, because
 * the CLI answers out of order.
 */
export class Protocol {
  private waiting = new Map<string, Waiting>()
  private next = 0
  /** The `can_use_tool` requests not yet answered, by the CLI's id. */
  readonly asks = new Map<string, Ask>()

  private prefix: string
  private write:  (line: string) => void
  private host:   string

  /** `host` names this side: the ids of its requests, and the error a request it does not serve gets. */
  constructor(write: (line: string) => void, host = 'host') {
    this.write  = write
    this.host   = host
    this.prefix = host.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'host'
  }

  /** One user message: text, or Messages API content blocks. */
  user(content: string | unknown[]): void {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
    this.send({ type: 'user', message: { role: 'user', content: blocks }, parent_tool_use_id: null, session_id: '' })
  }

  /** A control request of the host's; the promise is the CLI's `response` body. */
  request(subtype: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    const id = `${this.prefix}-${++this.next}`
    const p = new Promise<unknown>((resolve, reject) => this.waiting.set(id, { resolve, reject }))
    this.send({ type: 'control_request', request_id: id, request: { subtype, ...fields } })
    return p
  }

  initialize(): Promise<unknown> {
    return this.request('initialize')
  }

  /** Ends the turn, keeps the process. */
  interrupt(): Promise<unknown> {
    return this.request('interrupt')
  }

  /** Answers a `can_use_tool` by its id. False when the CLI is not waiting on it. */
  answer(request: string, decision: Decision): boolean {
    if (!this.asks.delete(request)) return false
    this.send({ type: 'control_response', response: { subtype: 'success', request_id: request, response: decision } })
    return true
  }

  /** Classifies one frame from stdout, settling the host's own requests on the way. */
  receive(f: Frame): Incoming {
    if (f.type === 'control_response') {
      const r = (f.response ?? {}) as { subtype?: string, request_id?: string, response?: unknown, error?: string }
      // The CLI also echoes the host's own can_use_tool answers: ids this side did not issue are not a reply.
      const w = r.request_id ? this.waiting.get(r.request_id) : undefined
      if (!w || !r.request_id) return { kind: 'none' }
      this.waiting.delete(r.request_id)
      if (r.subtype === 'error') w.reject(new ControlError(r.error ?? 'the control request failed'))
      else w.resolve(r.response ?? null)
      return { kind: 'none' }
    }
    if (f.type === 'control_request') {
      const id = typeof f.request_id === 'string' ? f.request_id : null
      const q = (f.request ?? {}) as Record<string, unknown>
      if (!id) return { kind: 'none' }
      if (q.subtype === 'can_use_tool') {
        const ask: Ask = {
          request: id,
          tool: String(q.tool_name ?? q.display_name ?? 'a tool'),
          input: q.input ?? {},
          suggestions: Array.isArray(q.permission_suggestions) ? q.permission_suggestions : [],
          toolUseId: typeof q.tool_use_id === 'string' ? q.tool_use_id : null,
          description: typeof q.description === 'string' ? q.description : null,
        }
        this.asks.set(id, ask)
        return { kind: 'ask', ask }
      }
      // hook_callback and mcp_message only come for SDK hooks or servers registered in
      // initialize, which this host never registers; an answer keeps the CLI from waiting on one.
      this.send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `${this.host} does not answer ${String(q.subtype)}` } })
      return { kind: 'none' }
    }
    if (f.type === 'control_cancel_request') {
      const id = typeof f.request_id === 'string' ? f.request_id : null
      if (!id || !this.asks.delete(id)) return { kind: 'none' }
      return { kind: 'withdrawn', request: id }
    }
    if (f.type === 'user' && f.isReplay === true) return { kind: 'replay', frame: f }
    return { kind: 'frame', frame: f }
  }

  /** The process ended: every request still waiting fails, and every ask is gone. Answers the asks dropped. */
  close(reason: string): string[] {
    for (const w of this.waiting.values()) w.reject(new ControlError(reason))
    this.waiting.clear()
    const dropped = [...this.asks.keys()]
    this.asks.clear()
    return dropped
  }

  private send(o: object) {
    this.write(`${JSON.stringify(o)}\n`)
  }
}
