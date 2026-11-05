// src/errors.ts — conduit's error → the caller's.
//
// Conduit grades by status and the status is most of the answer. What it
// cannot tell apart is read here: a 400 that is OUR request from a 400 that is
// the prompt's length, a 429 that asks for a wait from a 429 that says the
// month's budget is spent, a 403 folded into `auth_failed` beside the 401 that
// should forget a key, a 404 folded into `client_error`.
//
// Two dialects of one protocol (FJS-D889). OpenAI answers
// `{ error: { message, type, code } }`; Ollama answers `{ error: "model 'x'
// not found" }` with a bare string, and llama.cpp puts a NUMBER in `code`. The
// body is read into one `{ message, type, code }` first, so the table below is
// written once. One owner: nothing else in the package reads `error.raw` or
// `meta.status`.

import type { ConduitError } from '@frontierjs/conduit'
import type { OpenAIErrorBody, OpenAIErrorCode, OpenAIErrorType } from './types.ts'

export type OpenAIFailureKind =
  | 'refused'      // 400 invalid_request_error: our request was wrong
  | 'too_long'     // 400 context_length_exceeded: the prompt, not the request
  | 'forbidden'    // 403: the key is good and the policy says no — never forget the key
  | 'model_gone'   // 404 model_not_found, or Ollama's "model 'x' not found": the id names nothing here
  | 'quota'        // 429 insufficient_quota: the budget, not the rate — a wait of seconds buys nothing
  | 'turn_limit'   // the tool loop hit `maxTurns` — local, nothing was refused
  | ConduitError['kind']

export interface OpenAIFailure {
  kind:           OpenAIFailureKind
  message:        string
  retryable:      boolean
  /** The vendor's `error.code` where a body carried one; absent on Ollama's string dialect. */
  code?:          OpenAIErrorCode
  /** The vendor's `error.type` where a body carried one. */
  type?:          OpenAIErrorType
  status?:        number
  /** How long the vendor asked us to wait, where it said. */
  retryAfterMs?:  number
  /** The request went out and may have been billed; conduit's verdict, passed through. */
  indeterminate?: boolean
}

/** One reading of both dialects. `null` where the body is not the protocol's error envelope at all. */
export function parseBody(raw: unknown): { message: string; type?: OpenAIErrorType; code?: OpenAIErrorCode } | null {
  try {
    const body = (typeof raw === 'string' ? JSON.parse(raw) : raw) as OpenAIErrorBody | null
    if (!body || typeof body !== 'object' || !('error' in body)) return null
    const e = body.error
    if (typeof e === 'string') return { message: e }
    if (!e || typeof e !== 'object') return null
    return {
      message: typeof e.message === 'string' ? e.message : JSON.stringify(e),
      ...(typeof e.type === 'string' ? { type: e.type } : {}),
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
    }
  } catch { return null }
}

const namesMissingModel = (e: { message: string; code?: string } | null): boolean =>
  e?.code === 'model_not_found' || /model\b.*\bnot (found|exist)/i.test(e?.message ?? '') || /does not exist/i.test(e?.message ?? '')

export function translate(error: ConduitError, status?: number): OpenAIFailure {
  const e = parseBody(error.raw)
  const base: OpenAIFailure = {
    kind:      error.kind,
    message:   e?.message ?? error.message,
    retryable: error.retryable,
    ...(e?.code                            ? { code: e.code }                           : {}),
    ...(e?.type                            ? { type: e.type }                           : {}),
    ...(status !== undefined               ? { status }                                 : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms }     : {}),
    ...(error.indeterminate                ? { indeterminate: true }                    : {}),
  }

  switch (status) {
    case 400:
    case 413:
      return { ...base, kind: e?.code === 'context_length_exceeded' || /context length|too (many tokens|long)/i.test(base.message) ? 'too_long' : 'refused', retryable: false }
    case 403: return { ...base, kind: 'forbidden', retryable: false }
    case 404: return { ...base, kind: namesMissingModel(e) ? 'model_gone' : 'refused', retryable: false }
    case 429: {
      // A spent budget is neither a wait nor a refusal of this request: the
      // next hour answers the same, so a `Retry-After` on it is not honored.
      if (e?.code === 'insufficient_quota' || e?.type === 'insufficient_quota') {
        const { retryAfterMs: _wait, ...rest } = base
        return { ...rest, kind: 'quota', retryable: false }
      }
      return { ...base, kind: 'rate_limited', retryable: true }
    }
  }

  // Conduit answers a 503 carrying `Retry-After` as `rate_limited`; for a model
  // server that is a restart, not a pace, and the caller should read it beside
  // the 500 it is.
  if (status !== undefined && status >= 500) return { ...base, kind: 'server_error' }

  return base
}
