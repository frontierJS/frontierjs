// src/errors.ts — conduit's error → the caller's.
//
// Conduit grades by status, and for a model vendor the status is most of the
// answer: the body's `error.type` restates it one for one. Three cases need
// the status read directly, because conduit folds them into a neighbor —
// a 403 arrives as `auth_failed` beside the 401 that should forget a key, a
// 404 and a 413 arrive as `client_error` beside the 400 that was our fault.
// One owner: nothing else in the package reads `error.raw` or `meta.status`.

import type { ConduitError } from '@frontierjs/conduit'
import type { AnthropicErrorBody, AnthropicErrorType } from './types.ts'

export type AnthropicFailureKind =
  | 'refused'      // 400 invalid_request_error: our request was wrong
  | 'forbidden'    // 403 permission_error: the key is good and the policy says no — never forget the key
  | 'model_gone'   // 404 not_found_error: the model id was retired; the cadence cost of pinning one (FJS-D153)
  | 'too_long'     // 413 request_too_large: the prompt, not the network
  | 'turn_limit'   // the tool loop hit `maxTurns` — local, nothing was refused
  | ConduitError['kind']

export interface AnthropicFailure {
  kind:           AnthropicFailureKind
  message:        string
  retryable:      boolean
  /** The vendor's `error.type`, where a body carried one. */
  code?:          AnthropicErrorType
  status?:        number
  /** How long the vendor asked us to wait, where it said. */
  retryAfterMs?:  number
  /** The request went out and may have been billed; conduit's verdict, passed through. */
  indeterminate?: boolean
}

export function parseBody(raw: unknown): AnthropicErrorBody | null {
  try {
    const body = typeof raw === 'string' ? JSON.parse(raw) : raw
    return body && typeof body === 'object' && (body as AnthropicErrorBody).type === 'error' ? body as AnthropicErrorBody : null
  } catch { return null }
}

export function translate(error: ConduitError, status?: number): AnthropicFailure {
  const e = parseBody(error.raw)?.error
  const base: AnthropicFailure = {
    kind:      error.kind,
    message:   e?.message ?? error.message,
    retryable: error.retryable,
    ...(e?.type                           ? { code: e.type }                        : {}),
    ...(status !== undefined              ? { status }                              : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate               ? { indeterminate: true }                 : {}),
  }

  switch (status) {
    case 400: return { ...base, kind: 'refused',    retryable: false }
    case 403: return { ...base, kind: 'forbidden',  retryable: false }
    case 404: return { ...base, kind: 'model_gone', retryable: false }
    case 413: return { ...base, kind: 'too_long',   retryable: false }
  }

  // A 529 is the vendor refusing at the door, before any tokens were spent: the
  // request was not run, so nothing was billed and sending it again is safe.
  // Conduit cannot know that and answers an unkeyed POST's 5xx as indeterminate;
  // the vendor's own word overrides it here. A 500 `api_error` stays as conduit
  // graded it, because that one may have run.
  if (status === 529 || e?.type === 'overloaded_error') {
    const { indeterminate: _open, ...rest } = base
    return { ...rest, kind: 'server_error', retryable: true }
  }

  return base
}
