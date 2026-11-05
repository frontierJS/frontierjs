// @frontierjs/conduit-anthropic — the Messages API over conduit.
//
// The builder returns a descriptor and installs nothing (FJS-D890); every call
// takes `send` rather than an app, so the connector runs in a drive with no
// junction in the process.
//
// ─── What a request costs decides how it is sent ─────────────────────────
// A completion is billed per request and Anthropic collapses nothing under a
// key, so `createMessage` is an unkeyed, unreplayable POST: a 429, a 529 and a
// lost response come back to the caller with `retryable` and `retryAfterMs`,
// and conduit never sends a second bill (CONTRACT C5). A count is free, so
// `countTokens` is `replayable: true` and conduit replays it itself.
//
// ─── No fetch ────────────────────────────────────────────────────────────
// `streamMessage` goes through `conduit.stream()`, which reads the SSE and
// grades a refusal before the first event the way `send()` does (FJS-D934), so
// nothing here calls `fetch` and the breaker, the concurrency cap and the
// observers cover a stream as they cover a completion.

import { ConduitStreamError } from '@frontierjs/conduit'
import type { ConduitChunk, ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type AnthropicFailure } from './errors.ts'
import type { ContentBlock, CountTokensResponse, Message, MessagesRequest, MessagesResponse, StreamEvent, ToolResultBlock, ToolUseBlock, Usage } from './types.ts'

export * from './types.ts'
export * from './errors.ts'

export const ANTHROPIC_TARGET  = 'provider:anthropic'
export const ANTHROPIC_ADDRESS = 'https://api.anthropic.com'

/**
 * Required, and pinned: the vendor refuses a request without it, and the shape
 * of every response is fixed by it rather than by whatever the account's
 * dashboard says this week.
 */
export const ANTHROPIC_VERSION = '2023-06-01'

/** A completion can run for minutes; conduit's 10 s default times out a long answer and bills it anyway. */
export const ANTHROPIC_TIMEOUT_MS = 120_000

/** The send half, bound to the target. `(req) => conduit.send({ target: ANTHROPIC_TARGET, ...req })`. */
export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = ANTHROPIC_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/** The stream half, bound to the target. `(req) => conduit.stream({ target: ANTHROPIC_TARGET, ...req })`. */
export type Stream = (req: Omit<ConduitRequest, 'target'>) => AsyncIterable<ConduitChunk>

export function bindStream(conduit: { stream(req: ConduitRequest): AsyncIterable<ConduitChunk> }, target = ANTHROPIC_TARGET): Stream {
  return req => conduit.stream({ target, ...req })
}

/**
 * The declared target. One per process: the key is the process's, not a
 * tenant's. No `idempotency` field on purpose — the vendor collapses nothing,
 * and a header it ignores makes a replayed request look collapsed.
 */
export function anthropicTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id:            opts.id ?? ANTHROPIC_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       (opts.address ?? ANTHROPIC_ADDRESS).replace(/\/$/, ''),
    encoding:      'json',
    auth:          { type: 'api_key', ref: opts.ref ?? 'ANTHROPIC_API_KEY', header: 'x-api-key' },
    headers:       { 'anthropic-version': ANTHROPIC_VERSION },
    resilience:    { timeout_ms: ANTHROPIC_TIMEOUT_MS },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── Local refusals (C9) ─────────────────────────────────────────────────────

const refused = (message: string): AnthropicFailure => ({ kind: 'refused', message, retryable: false })

/** What the vendor would refuse after a round trip, refused here in our words. `null` means send it. */
export function checkRequest(req: MessagesRequest): AnthropicFailure | null {
  if (!req.model) return refused('anthropic: a request names a model')
  if (!Number.isInteger(req.max_tokens) || req.max_tokens < 1) return refused(`anthropic: max_tokens is a positive integer, got ${req.max_tokens}`)
  if (!Array.isArray(req.messages) || req.messages.length === 0) return refused('anthropic: a request carries at least one message')
  if ((req as { stream?: unknown }).stream) return refused('anthropic: `stream` is not a flag on createMessage — use streamMessage, which reads the events')
  return null
}

/** A 2xx that is not a message is refused (C4); the vendor answers `type: 'error'` with a non-2xx, so this guards a proxy's 200. */
const isMessage = {
  validate(data: unknown) {
    const d = data as Partial<MessagesResponse> | null
    return d && d.type === 'message' && Array.isArray(d.content) && d.usage
      ? { ok: true as const, value: d as MessagesResponse }
      : { ok: false as const, errors: [`expected type 'message' with content and usage, got ${JSON.stringify(data)?.slice(0, 200)}`] }
  },
}

const isCount = {
  validate(data: unknown) {
    const d = data as Partial<CountTokensResponse> | null
    return d && Number.isInteger(d.input_tokens)
      ? { ok: true as const, value: d as CountTokensResponse }
      : { ok: false as const, errors: [`expected { input_tokens }, got ${JSON.stringify(data)?.slice(0, 200)}`] }
  },
}

// ─── Calls ───────────────────────────────────────────────────────────────────

/**
 * One completion. Unkeyed and unreplayable: a retry is a second bill, and the
 * vendor has no idempotency key to collapse it under. A 429 comes back with
 * `retryAfterMs`, a 529 as `server_error` + `retryable`, and the caller
 * decides when to spend again.
 */
export async function createMessage(send: Send, req: MessagesRequest): Promise<{ message?: MessagesResponse; error?: AnthropicFailure }> {
  const bad = checkRequest(req)
  if (bad) return { error: bad }
  const result = await send<MessagesResponse>({ method: 'POST', path: '/v1/messages', body: req, validate: isMessage })
  if (result.error) return { error: translate(result.error, result.meta.status) }
  return { message: result.data }
}

/** A count is free, so conduit may replay it: a lost response and a 429 with `Retry-After` are its to retry. */
export async function countTokens(send: Send, req: Omit<MessagesRequest, 'max_tokens'>): Promise<{ count?: CountTokensResponse; error?: AnthropicFailure }> {
  const bad = checkRequest({ ...req, max_tokens: 1 })
  if (bad) return { error: bad }
  const result = await send<CountTokensResponse>({ method: 'POST', path: '/v1/messages/count_tokens', body: req, replayable: true, validate: isCount })
  if (result.error) return { error: translate(result.error, result.meta.status) }
  return { count: result.data }
}

// ─── The tool loop ───────────────────────────────────────────────────────────

export type ToolTable = Record<string, (input: Record<string, unknown>) => Promise<unknown> | unknown>

export interface ToolLoopResult {
  /** The final message, where the loop ended on something other than `tool_use`. */
  message?:  MessagesResponse
  error?:    AnthropicFailure
  /** Every turn's usage summed, including the turn that failed or was capped. */
  usage:     UsageSum
  turns:     number
  /** The conversation as it stands, so a capped loop can be resumed with a larger budget. */
  messages:  Message[]
}

/** `Usage` with the vendor's `null`s read as zero, so it can be added to. */
export type UsageSum = { [K in keyof Required<Usage>]: number }

const zeroUsage = (): UsageSum => ({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })

function addUsage(sum: UsageSum, u: Partial<Usage> | undefined): void {
  if (!u) return
  sum.input_tokens                += u.input_tokens                ?? 0
  sum.output_tokens               += u.output_tokens               ?? 0
  sum.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
  sum.cache_read_input_tokens     += u.cache_read_input_tokens     ?? 0
}

/**
 * `stop_reason: 'tool_use'` → run every tool the turn asked for → append the
 * results → ask again, until the model stops or `maxTurns` is spent. A tool
 * that throws, or a name the table lacks, is handed back as an `is_error`
 * result rather than ending the loop: the model asked, and the model can
 * recover. Each turn is a bill, so the cap is not optional and the sum is
 * reported whichever way the loop ends.
 */
export async function runToolLoop(send: Send, req: MessagesRequest, tools: ToolTable, opts: { maxTurns?: number } = {}): Promise<ToolLoopResult> {
  const maxTurns = opts.maxTurns ?? 10
  const messages = [...req.messages]
  const usage    = zeroUsage()
  let   turns    = 0

  while (turns < maxTurns) {
    const { message, error } = await createMessage(send, { ...req, messages })
    turns++
    if (error) return { error, usage, turns, messages }
    addUsage(usage, message!.usage)
    messages.push({ role: 'assistant', content: message!.content })
    if (message!.stop_reason !== 'tool_use') return { message, usage, turns, messages }

    const asked = message!.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    const results: ToolResultBlock[] = []
    for (const call of asked) {
      const fn = Object.hasOwn(tools, call.name) ? tools[call.name] : undefined
      if (!fn) { results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: `no tool named '${call.name}'` }); continue }
      try {
        const out = await fn(call.input)
        results.push({ type: 'tool_result', tool_use_id: call.id, content: typeof out === 'string' ? out : JSON.stringify(out) })
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true, content: (e as Error).message })
      }
    }
    messages.push({ role: 'user', content: results })
  }

  return { error: { kind: 'turn_limit', message: `anthropic: the tool loop was still asking for tools after ${maxTurns} turn(s)`, retryable: false }, usage, turns, messages }
}

// ─── Streaming ───────────────────────────────────────────────────────────────

/**
 * `POST /v1/messages` with `stream: true`, read as the vendor's events.
 *
 * Every stream ends in exactly one of `message_stop`, the vendor's `error`
 * event, or `stream_error`. A socket that closes before `message_stop` is
 * `stream_error` even when the close is clean: a server that dies between two
 * deltas looks to a reader like a stream that simply ended.
 */
export async function* streamMessage(stream: Stream, req: MessagesRequest, opts: { signal?: AbortSignal } = {}): AsyncGenerator<StreamEvent> {
  const bad = checkRequest(req)
  if (bad) { yield { type: 'stream_error', failure: bad }; return }

  try {
    const events = stream({ method: 'POST', path: '/v1/messages', body: { ...req, stream: true }, headers: { accept: 'text/event-stream' }, signal: opts.signal })
    for await (const chunk of events) {
      const data = (chunk.data as { data?: unknown } | null)?.data as StreamEvent | null | undefined
      if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') continue
      yield data
      if (data.type === 'message_stop' || data.type === 'error') return
    }
  } catch (e) {
    if (!(e instanceof ConduitStreamError)) throw e
    yield { type: 'stream_error', failure: translate(e.conduit, e.meta?.status) }
    return
  }
  const ended: ConduitError = { kind: 'stream_error', target: ANTHROPIC_TARGET, protocol: 'http', message: 'the stream ended before message_stop', retryable: false }
  yield { type: 'stream_error', failure: translate(ended) }
}

/** The text a stream's `text_delta`s spell, and the tool calls its `input_json_delta`s assemble. For a caller that wants the whole answer after all. */
export function assemble(events: StreamEvent[]): { text: string; toolUse: ToolUseBlock[]; stopReason: MessagesResponse['stop_reason']; usage: Partial<Usage>; content: ContentBlock[] } {
  const blocks: (ContentBlock & { _json?: string })[] = []
  let stopReason: MessagesResponse['stop_reason'] = null
  const usage: Partial<Usage> = {}
  for (const ev of events) {
    if (ev.type === 'message_start')        Object.assign(usage, ev.message.usage)
    if (ev.type === 'content_block_start')  blocks[ev.index] = { ...ev.content_block }
    if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index]
      if (!b) continue
      if (ev.delta.type === 'text_delta' && b.type === 'text') b.text += ev.delta.text
      if (ev.delta.type === 'input_json_delta' && b.type === 'tool_use') b._json = (b._json ?? '') + ev.delta.partial_json
    }
    if (ev.type === 'message_delta') { stopReason = ev.delta.stop_reason; Object.assign(usage, ev.usage) }
  }
  const content: ContentBlock[] = blocks.filter(Boolean).map(b => {
    if (b.type === 'tool_use' && b._json !== undefined) { const { _json, ...rest } = b; return { ...rest, input: JSON.parse(_json || '{}') } }
    const { _json: _unused, ...rest } = b
    return rest
  })
  return {
    text:     content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join(''),
    toolUse:  content.filter((b): b is ToolUseBlock => b.type === 'tool_use'),
    stopReason, usage, content,
  }
}
