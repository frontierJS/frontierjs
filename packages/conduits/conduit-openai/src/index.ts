// @frontierjs/conduit-openai — the chat-completions PROTOCOL over conduit.
//
// A protocol connector (FJS-D889), not a vendor's: the same `POST
// /v1/chat/completions` is served by OpenAI, Ollama, Groq, Mistral, llama.cpp
// and vLLM, so the builder is called once PER IMPLEMENTATION and the id names
// it — `provider:openai:<name>`. `address` is the origin without `/v1`; the
// paths here add it.
//
// The builder returns a descriptor and installs nothing (FJS-D890); every call
// takes `send` rather than an app, so the connector runs in a drive with no
// junction in the process.
//
// ─── What a request costs decides how it is sent ─────────────────────────
// A completion is billed per request and no implementation collapses one under
// a key, so `chatCompletion` is an unkeyed, unreplayable POST: a 429, a 5xx and
// a lost response come back to the caller with `retryable` and `retryAfterMs`,
// and conduit never sends a second bill (CONTRACT C5). An embedding is
// deterministic and priced at a fraction of a cent, so `embeddings` is
// `replayable: true` and conduit replays it itself; a replay is at worst a
// second fraction, never a second answer.
//
// ─── No fetch ────────────────────────────────────────────────────────────
// `streamChatCompletion` goes through `conduit.stream()`, which reads the SSE
// and grades a refusal before the first chunk the way `send()` does
// (FJS-D934), so nothing here calls `fetch` and the breaker, the concurrency
// cap and the observers cover a stream as they cover a completion.

import { ConduitStreamError } from '@frontierjs/conduit'
import type { ConduitChunk, ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type OpenAIFailure } from './errors.ts'
import type { ChatChunk, ChatMessage, ChatRequest, ChatResponse, EmbeddingsRequest, EmbeddingsResponse, FinishReason, ModelsResponse, ToolCall, Usage } from './types.ts'

export * from './types.ts'
export * from './errors.ts'

export const OPENAI_ADDRESS = 'https://api.openai.com'

/** A completion can run for minutes; conduit's 10 s default times out a long answer and bills it anyway. */
export const OPENAI_TIMEOUT_MS = 120_000

export const openaiTargetId = (name: string) => `provider:openai:${name}`

/** The send half, bound to one implementation's target. */
export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string): Send {
  return req => conduit.send({ target, ...req })
}

/** The stream half, bound to one implementation's target. */
export type Stream = (req: Omit<ConduitRequest, 'target'>) => AsyncIterable<ConduitChunk>

export function bindStream(conduit: { stream(req: ConduitRequest): AsyncIterable<ConduitChunk> }, target: string): Stream {
  return req => conduit.stream({ target, ...req })
}

export interface OpenAITargetOptions {
  /** Which implementation: `openai`, `ollama`, `groq`, `llamacpp`. Becomes the id, so two servers are two targets. */
  name:     string
  /** The credential ref. Ollama and llama.cpp check no key, and still get one, because conduit refuses a bearer target whose ref resolves to nothing. */
  ref?:     string
  /** The origin WITHOUT `/v1`: `https://api.openai.com`, `http://127.0.0.1:11434`, `https://api.groq.com/openai`. */
  address?: string
  /** Per-attempt timeout on the target; defaults to `OPENAI_TIMEOUT_MS`. */
  timeoutMs?: number
  headers?: Record<string, string>
}

/**
 * The declared target for one implementation. The key is the process's, not
 * a tenant's, so one per process per server. No `idempotency` field on
 * purpose — no implementation collapses anything, and a header it ignores
 * makes a replayed request look collapsed.
 */
export function openaiTarget(opts: OpenAITargetOptions): TargetDescriptor {
  if (!opts.name || /[\s:]/.test(opts.name)) throw new Error(`openai: a target name is one word with no colon, got ${JSON.stringify(opts.name)}`)
  return {
    id:            openaiTargetId(opts.name),
    kind:          'provider',
    protocol:      'http',
    address:       (opts.address ?? OPENAI_ADDRESS).replace(/\/+$/, '').replace(/\/v1$/, ''),
    encoding:      'json',
    auth:          { type: 'bearer', ref: opts.ref ?? 'OPENAI_API_KEY' },
    ...(opts.headers ? { headers: opts.headers } : {}),
    // A completion is the slowest request an app makes; a drive overrides this.
    resilience:    { timeout_ms: opts.timeoutMs ?? OPENAI_TIMEOUT_MS },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── Local refusals (C9) ─────────────────────────────────────────────────────

const refused = (message: string): OpenAIFailure => ({ kind: 'refused', message, retryable: false })

const PROTOCOL_KEYS = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream', 'stream_options'])

/** What the server would refuse after a round trip, refused here in our words. `null` means send it. */
export function checkChatRequest(req: ChatRequest): OpenAIFailure | null {
  if (!req.model) return refused('openai: a request names a model')
  if (!Array.isArray(req.messages) || req.messages.length === 0) return refused('openai: a request carries at least one message')
  if ((req as { stream?: unknown }).stream) return refused('openai: `stream` is not a flag on chatCompletion — use streamChatCompletion, which reads the chunks')
  for (const m of req.messages) {
    if (m.role === 'tool' && !m.tool_call_id) return refused('openai: a tool message names the tool_call_id it answers')
  }
  const clash = Object.keys(req.extra ?? {}).find(k => PROTOCOL_KEYS.has(k))
  if (clash) return refused(`openai: extra.${clash} is a protocol field, not an extension — set it on the request`)
  return null
}

/** The body on the wire: protocol fields, then the vendor's extension beside them. */
function chatBody(req: ChatRequest, stream = false): Record<string, unknown> {
  const { extra, stream_options, ...protocol } = req
  return { ...protocol, ...(stream ? { stream: true, ...(stream_options ? { stream_options } : {}) } : {}), ...extra }
}

const isChat = {
  validate(data: unknown) {
    const d = data as Partial<ChatResponse> | null
    return d && Array.isArray(d.choices) && d.choices.length > 0 && d.choices[0]?.message
      ? { ok: true as const, value: d as ChatResponse }
      : { ok: false as const, errors: [`expected choices[].message, got ${JSON.stringify(data)?.slice(0, 200)}`] }
  },
}

const isEmbeddings = {
  validate(data: unknown) {
    const d = data as Partial<EmbeddingsResponse> | null
    return d && Array.isArray(d.data) && d.data.every(e => Array.isArray(e?.embedding))
      ? { ok: true as const, value: d as EmbeddingsResponse }
      : { ok: false as const, errors: [`expected data[].embedding, got ${JSON.stringify(data)?.slice(0, 200)}`] }
  },
}

const isModels = {
  validate(data: unknown) {
    const d = data as Partial<ModelsResponse> | null
    return d && Array.isArray(d.data)
      ? { ok: true as const, value: d as ModelsResponse }
      : { ok: false as const, errors: [`expected { data: Model[] }, got ${JSON.stringify(data)?.slice(0, 200)}`] }
  },
}

// ─── Calls ───────────────────────────────────────────────────────────────────

/**
 * One completion. Unkeyed and unreplayable: a retry is a second bill, and no
 * implementation has an idempotency key to collapse it under. A 429 comes back
 * with `retryAfterMs`, a 5xx as `server_error`, and the caller decides when to
 * spend again.
 */
export async function chatCompletion(send: Send, req: ChatRequest): Promise<{ completion?: ChatResponse; error?: OpenAIFailure }> {
  const bad = checkChatRequest(req)
  if (bad) return { error: bad }
  const result = await send<ChatResponse>({ method: 'POST', path: '/v1/chat/completions', body: chatBody(req), validate: isChat })
  if (result.error) return { error: translate(result.error, result.meta.status) }
  return { completion: result.data }
}

/**
 * Embeddings. `replayable: true`: the vector for an input is deterministic and
 * the call is priced per token at a fraction of a cent, so conduit may replay a
 * lost response or a 429 with `Retry-After` itself. A replay costs a second
 * fraction and never a second answer.
 */
export async function embeddings(send: Send, req: EmbeddingsRequest): Promise<{ embeddings?: EmbeddingsResponse; error?: OpenAIFailure }> {
  if (!req.model) return { error: refused('openai: embeddings name a model') }
  if (req.input === '' || (Array.isArray(req.input) && req.input.length === 0)) return { error: refused('openai: embeddings take a non-empty input') }
  const { extra, ...protocol } = req
  const result = await send<EmbeddingsResponse>({ method: 'POST', path: '/v1/embeddings', body: { ...protocol, ...extra }, replayable: true, validate: isEmbeddings })
  if (result.error) return { error: translate(result.error, result.meta.status) }
  return { embeddings: result.data }
}

/** The models this implementation serves. A GET, so conduit replays it on its own. */
export async function listModels(send: Send): Promise<{ models?: ModelsResponse; error?: OpenAIFailure }> {
  const result = await send<ModelsResponse>({ method: 'GET', path: '/v1/models', validate: isModels })
  if (result.error) return { error: translate(result.error, result.meta.status) }
  return { models: result.data }
}

// ─── The tool loop ───────────────────────────────────────────────────────────

export type ToolTable = Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown>

export interface ToolLoopResult {
  /** The final completion, where the loop ended on something other than `tool_calls`. */
  completion?: ChatResponse
  error?:      OpenAIFailure
  /** Every turn's usage summed, including the turn that failed or was capped. */
  usage:       Usage
  turns:       number
  /** The conversation as it stands, so a capped loop can be resumed with a larger budget. */
  messages:    ChatMessage[]
}

const zeroUsage = (): Usage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })

export function addUsage(sum: Usage, u: Partial<Usage> | null | undefined): Usage {
  if (!u) return sum
  sum.prompt_tokens     += u.prompt_tokens     ?? 0
  sum.completion_tokens += u.completion_tokens ?? 0
  sum.total_tokens      += u.total_tokens      ?? 0
  return sum
}

/** A tool's `arguments` is a JSON STRING on the wire; one that does not parse is handed to the tool as `{}` with the text under `_raw`. */
export function parseArguments(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { _raw: text }
  } catch { return { _raw: text } }
}

/**
 * `finish_reason: 'tool_calls'` → run every tool the turn asked for → append a
 * `role: 'tool'` message per call → ask again, until the model stops or
 * `maxTurns` is spent. A tool that throws, or a name the table lacks, is
 * handed back as the tool's answer rather than ending the loop: the model
 * asked, and the model can recover. Each turn is a bill, so the cap is not
 * optional and the sum is reported whichever way the loop ends.
 */
export async function runToolLoop(send: Send, req: ChatRequest, tools: ToolTable, opts: { maxTurns?: number } = {}): Promise<ToolLoopResult> {
  const maxTurns = opts.maxTurns ?? 10
  const messages = [...req.messages]
  const usage    = zeroUsage()
  let   turns    = 0

  while (turns < maxTurns) {
    const { completion, error } = await chatCompletion(send, { ...req, messages })
    turns++
    if (error) return { error, usage, turns, messages }
    addUsage(usage, completion!.usage)
    const choice = completion!.choices[0]
    messages.push({ role: 'assistant', content: choice.message.content, ...(choice.message.tool_calls ? { tool_calls: choice.message.tool_calls } : {}) })
    const asked = choice.message.tool_calls ?? []
    if (choice.finish_reason !== 'tool_calls' && asked.length === 0) return { completion, usage, turns, messages }

    for (const call of asked) {
      const fn = Object.hasOwn(tools, call.function.name) ? tools[call.function.name] : undefined
      let content: string
      if (!fn) content = JSON.stringify({ error: `no tool named '${call.function.name}'` })
      else {
        try {
          const out = await fn(parseArguments(call.function.arguments))
          content = typeof out === 'string' ? out : JSON.stringify(out)
        } catch (e) { content = JSON.stringify({ error: (e as Error).message }) }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content })
    }
  }

  return { error: { kind: 'turn_limit', message: `openai: the tool loop was still asking for tools after ${maxTurns} turn(s)`, retryable: false }, usage, turns, messages }
}

// ─── Streaming ───────────────────────────────────────────────────────────────

/**
 * `POST /v1/chat/completions` with `stream: true`, read as the protocol's chunks.
 *
 * Every stream ends in exactly one of `data: [DONE]` or a `stream_error`. A
 * socket that closes before `[DONE]` is `stream_error` even when the close is
 * clean: a server that dies between two deltas looks to a reader like a
 * stream that simply ended, and the text so far may be half an answer. A
 * `{ error }` object arriving as a data line (the way the protocol reports a
 * failure after 200) is a `stream_error` read by `translate`.
 */
export async function* streamChatCompletion(stream: Stream, req: ChatRequest, opts: { signal?: AbortSignal } = {}): AsyncGenerator<ChatChunk> {
  const bad = checkChatRequest(req)
  if (bad) { yield { object: 'stream_error', failure: bad }; return }

  const failed = (kind: ConduitError['kind'], message: string, extra: Partial<ConduitError> = {}): ChatChunk =>
    ({ object: 'stream_error', failure: translate({ kind, target: 'provider:openai', protocol: 'http', message, retryable: false, ...extra }) })

  try {
    const events = stream({ method: 'POST', path: '/v1/chat/completions', body: chatBody(req, true), headers: { accept: 'text/event-stream' }, signal: opts.signal })
    for await (const chunk of events) {
      const ev = chunk.data as { data?: unknown } | null
      if (ev?.data === '[DONE]') return
      const data = ev?.data as Record<string, unknown> | null | undefined
      if (!data || typeof data !== 'object') continue
      if ('error' in data && !('choices' in data)) { yield failed('invalid_response', 'the server reported an error inside the stream', { raw: JSON.stringify(data) }); return }
      if (!Array.isArray(data.choices)) continue
      yield { ...(data as Extract<ChatChunk, { object: 'chat.completion.chunk' }>), object: 'chat.completion.chunk' }
    }
  } catch (e) {
    if (!(e instanceof ConduitStreamError)) throw e
    yield { object: 'stream_error', failure: translate(e.conduit, e.meta?.status) }
    return
  }
  yield failed('stream_error', 'the stream ended before [DONE]')
}

/** The text a stream's deltas spell, the tool calls its fragments assemble, and the usage its last chunk carried. For a caller that wants the whole answer after all. */
export function assemble(chunks: ChatChunk[]): { text: string; toolCalls: ToolCall[]; finishReason: FinishReason | null; usage: Usage | null; error: OpenAIFailure | null } {
  let text = '', finishReason: FinishReason | null = null, usage: Usage | null = null, error: OpenAIFailure | null = null
  const calls: (ToolCall & { index: number })[] = []
  for (const c of chunks) {
    if (c.object === 'stream_error') { error = c.failure; continue }
    if (c.usage) usage = c.usage
    const choice = c.choices[0]
    if (!choice) continue
    if (choice.delta.content) text += choice.delta.content
    if (choice.finish_reason) finishReason = choice.finish_reason
    for (const d of choice.delta.tool_calls ?? []) {
      let call = calls.find(k => k.index === d.index)
      if (!call) { call = { index: d.index, id: d.id ?? '', type: 'function', function: { name: '', arguments: '' } }; calls.push(call) }
      if (d.id) call.id = d.id
      if (d.function?.name) call.function.name += d.function.name
      if (d.function?.arguments) call.function.arguments += d.function.arguments
    }
  }
  return { text, toolCalls: calls.sort((a, b) => a.index - b.index).map(({ index: _i, ...call }) => call), finishReason, usage, error }
}
