// src/door.ts — `anthropicDoor`: the Messages API as a one-answer door.
//
// A door is `@frontierjs/toolbelt/ask`'s contract: one question in, one `Reply`
// out, never a throw, a reason from the closed set when nothing answered. The
// sibling is `@frontierjs/claude`'s `claudeDoor`, the local program signed in as
// the developer; an app moves between the two without changing a line
// (FJS-D2327).
//
// ─── The one resend ──────────────────────────────────────────────────────
// `createMessage` never retries: a completion is a bill. A 429 and a 529 are
// the vendor refusing at the door, before anything ran, so this door sends once
// more on either (FJS-D2326) and returns the second failure as it came. A
// dropped connection, a timeout and a 500 may have run and been billed, so
// none of them is resent.
//
// There is no `fetch` here: `send` is `bindSend(conduit)`.

import { unanswered } from '@frontierjs/toolbelt/ask'
import type { AskOptions, Door, Failure, Question, Reason, Reply } from '@frontierjs/toolbelt/ask'
import { createMessage, type Send } from './index.ts'
import type { AnthropicFailure } from './errors.ts'
import type { MessagesRequest, MessagesResponse } from './types.ts'

export type AnthropicDoorOptions = {
  /** Where `bindSend(conduit)` goes. */
  send:       Send
  /** The door's model; a question's own `model` wins. Absent, `DEFAULT_MODEL`. */
  model?:     string
  /** The cap on one answer; default 16 000. */
  maxTokens?: number
  /** `output_config.effort`. Absent, the field is left out and the model's default holds. */
  effort?:    string
}

/** FJS-D2357. */
export const DEFAULT_MODEL = 'claude-sonnet-5-5'
export const DEFAULT_MAX_TOKENS = 16_000

/** A 429 that carries no `retry-after` is waited out this long before the one resend. */
const RESEND_WAIT_MS = 1_000
/** Past this the caller is better placed to decide than a door holding the question open. */
const RESEND_WAIT_CAP_MS = 30_000

// What the API refuses in a structured-output schema. A bound it cannot enforce
// is a 400 naming the keyword, and the 400 reads as the caller's malformed
// request when the schema was only written for a validator that supports more.
const UNSUPPORTED = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'uniqueItems']

const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * `schema` as the API accepts it (FJS-D2356): a deep copy, every object schema
 * closed with `additionalProperties: false`, the keywords it refuses dropped
 * (`minItems` stays for 0 and 1, the two it supports). Walks `properties`,
 * `items`, `anyOf`, `allOf` and `$defs`/`definitions`; a property NAMED
 * `minimum` is a key of `properties` and is kept, and `enum`/`const`/`default`
 * values are data and never walked.
 */
export function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const node = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(node)
    if (!isObject(s)) return s
    const out: Record<string, any> = { ...s }
    for (const k of UNSUPPORTED) delete out[k]
    if (typeof out.minItems === 'number' && out.minItems > 1) delete out.minItems
    const types = Array.isArray(out.type) ? out.type : [out.type]
    if (types.includes('object') || isObject(out.properties)) out.additionalProperties = false
    if (isObject(out.properties)) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, node(v)]))
    for (const k of ['items', 'anyOf', 'allOf']) if (k in out) out[k] = node(out[k])
    for (const k of ['$defs', 'definitions']) {
      if (isObject(out[k])) out[k] = Object.fromEntries(Object.entries(out[k]).map(([n, v]) => [n, node(v)]))
    }
    return out
  }
  return node(structuredClone(schema)) as Record<string, unknown>
}

const NO_KEY = 'No Anthropic API key: set ANTHROPIC_API_KEY.'

/** The reason a failed request is, from the one reader of status and code (`errors.ts`). */
function reasonOf(f: AnthropicFailure): Reason {
  if (f.status === 529 || f.code === 'overloaded_error') return 'rate_limited'
  switch (f.kind) {
    // No status: conduit never reached the vendor because no key resolved.
    case 'auth_failed':       return f.status === undefined ? 'not_set_up' : 'signed_out'
    case 'forbidden':
    case 'model_gone':
    case 'too_long':
    case 'refused':           return f.kind
    case 'client_error':
    case 'invalid_request':   return 'refused'
    // Conduit's concurrency cap: shed locally before dispatch, and it clears.
    case 'rate_limited':
    case 'overloaded':        return 'rate_limited'
    case 'timeout':           return 'timeout'
    case 'connection_failed': return 'lost'
    case 'aborted':           return 'aborted'
    case 'target_not_found':  return 'not_set_up'
    default:                  return 'model_error'
  }
}

/** Refused before it ran, so unbilled and safe to send again (FJS-D2326). */
const resendable = (f: AnthropicFailure) => f.status === 429 || f.status === 529 || f.code === 'overloaded_error'

/** Resolves true after `ms`, false if `signal` fires first. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false)
    const finish = (waited: boolean) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(waited) }
    const onAbort = () => finish(false)
    const timer = setTimeout(() => finish(true), ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const count = (n: number | null | undefined) => typeof n === 'number' ? n : 0

export function anthropicDoor(options: AnthropicDoorOptions): Door {
  const door = async (question: Question, opts: AskOptions = {}): Promise<Reply> => {
    const t0 = Date.now()
    const requested = opts.model || options.model || DEFAULT_MODEL
    const fail = (reason: Reason, message?: string, detail?: unknown, model = requested): Reply => ({
      ok: false, door: 'anthropic', model, ms: Date.now() - t0,
      failure: unanswered(reason, message, detail == null ? undefined : detail) as Failure,
    })
    const failed = (f: AnthropicFailure): Reply => {
      const reason = reasonOf(f)
      return fail(reason, reason === 'not_set_up' && f.kind === 'auth_failed' ? NO_KEY : undefined, f.message)
    }

    try {
      if (opts.signal?.aborted) return fail('aborted')

      const request: MessagesRequest = {
        model: requested,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(question.system ? { system: question.system } : {}),
        messages: [{ role: 'user', content: question.prompt }],
      }
      const config: NonNullable<MessagesRequest['output_config']> = {}
      if (question.schema) config.format = { type: 'json_schema', schema: normalizeSchema(question.schema) }
      if (options.effort) config.effort = options.effort
      if (Object.keys(config).length) request.output_config = config

      let sent = await createMessage(options.send, request, { signal: opts.signal })
      if (sent.error && resendable(sent.error)) {
        const wait = sent.error.retryAfterMs ?? RESEND_WAIT_MS
        if (wait > RESEND_WAIT_CAP_MS) return failed(sent.error)
        if (!await pause(wait, opts.signal)) return fail('aborted')
        sent = await createMessage(options.send, request, { signal: opts.signal })
      }
      if (sent.error) return failed(sent.error)

      const message = sent.message as MessagesResponse
      const model = message.model || requested
      const text = message.content.flatMap(b => b.type === 'text' ? [b.text] : []).join('')

      if (message.stop_reason === 'refusal') return fail('refused', message.stop_details?.explanation || undefined, text || message.stop_details?.category, model)
      if (message.stop_reason === 'max_tokens') return fail('cut_off', undefined, text, model)
      if (message.stop_reason !== 'end_turn' && message.stop_reason !== 'stop_sequence') return fail('model_error', undefined, `stop_reason: ${message.stop_reason}`, model)

      const u = message.usage
      const usage = {
        inputTokens:  count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens),
        outputTokens: count(u.output_tokens),
      }
      const answered = (answer: Record<string, unknown> | string): Reply =>
        ({ ok: true, door: 'anthropic', model, ms: Date.now() - t0, answer, usage, costUsd: null })

      if (!question.schema) return text.trim() ? answered(text) : fail('no_answer', undefined, text, model)
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return fail('no_answer', undefined, text, model) }
      return isObject(parsed) ? answered(parsed) : fail('no_answer', undefined, text, model)
    } catch (e) {
      return fail('lost', undefined, e instanceof Error ? e.message : String(e))
    }
  }
  return door as Door
}
