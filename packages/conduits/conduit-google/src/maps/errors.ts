// src/errors.ts — Google's `{ error: { code, status, message } }` → the app's.
//
// Conduit grades by HTTP status and Google puts the answer in `error.status`,
// a gRPC canonical code spelled as a word. The two disagree where it matters:
// a 403 is `auth_failed` to conduit and would forget the credential, while
// Google's PERMISSION_DENIED means the KEY is fine and the API is not enabled
// on the project — forgetting the key fixes nothing. A bad key is the other
// way round: Google says 400 INVALID_ARGUMENT, which conduit calls
// `client_error`, and only `details[].reason === 'API_KEY_INVALID'` says it
// was the credential. One owner: nothing else in the package reads `raw`.

import type { ConduitError } from '@frontierjs/conduit'
import type { GoogleErrorBody } from './types.ts'

export type GoogleMapsFailureKind =
  | 'refused'               // INVALID_ARGUMENT: our request was wrong, never retried
  | 'forbidden'             // PERMISSION_DENIED: the key is accepted and the project may not do this
  | 'gone'                  // NOT_FOUND: the place id no longer resolves
  | ConduitError['kind']    // anything the transport already named

export interface GoogleMapsFailure {
  kind:      GoogleMapsFailureKind
  message:   string
  retryable: boolean
  /** Google's canonical code — `INVALID_ARGUMENT`, `PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`. */
  status?:   string
  /** `details[].reason` where Google gave one — `API_KEY_INVALID`, `SERVICE_DISABLED`. */
  reason?:   string
  /** How long to wait. A 429 with no `Retry-After` gets `RATE_LIMIT_FALLBACK_MS`. */
  retryAfterMs?: number
}

/**
 * Google's quotas are per minute and a 429 almost never carries `Retry-After`.
 * A caller handed `rate_limited` with no wait retries at once and is refused
 * again, so the connector states the window the quota is measured over.
 */
export const RATE_LIMIT_FALLBACK_MS = 60_000

export function parseBody(raw: unknown): GoogleErrorBody | null {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw as GoogleErrorBody) } catch { return null }
}

export function translate(error: ConduitError): GoogleMapsFailure {
  const base: GoogleMapsFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
  }
  if (error.kind === 'rate_limited' && base.retryAfterMs === undefined) base.retryAfterMs = RATE_LIMIT_FALLBACK_MS

  const e = parseBody(error.raw)?.error
  if (!e) return base
  const reason = e.details?.find(d => d.reason)?.reason

  const kind: GoogleMapsFailureKind =
    e.status === 'INVALID_ARGUMENT' && reason === 'API_KEY_INVALID' ? 'auth_failed'
    : e.status === 'INVALID_ARGUMENT'    ? 'refused'
    : e.status === 'PERMISSION_DENIED'   ? 'forbidden'
    : e.status === 'NOT_FOUND'           ? 'gone'
    : e.status === 'RESOURCE_EXHAUSTED'  ? 'rate_limited'
    : e.status === 'UNAVAILABLE'         ? 'server_error'
    : base.kind

  return {
    ...base,
    kind,
    message:   e.message ?? base.message,
    retryable: kind === 'rate_limited' || kind === 'server_error',
    ...(e.status ? { status: e.status } : {}),
    ...(reason   ? { reason } : {}),
    ...(kind === 'rate_limited' && base.retryAfterMs === undefined ? { retryAfterMs: RATE_LIMIT_FALLBACK_MS } : {}),
  }
}
