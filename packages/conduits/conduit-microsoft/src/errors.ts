// src/errors.ts — Microsoft's refusals → the app's answer. The one reader of
// `error.raw`, the HTTP status and the response headers (CONTRACT C3).
//
// Two vendors wear one name. The identity platform refuses in RFC 6749 words
// (`invalid_grant`, `invalid_client`) with an AADSTS code in the description,
// and Graph refuses in an `{ error: { code } }` envelope. Conduit grades both
// by status, and the status is not the fact a sync branches on:
//
//   410 SyncStateNotFound      `sync_reset`  — Exchange dropped the delta state; the folder starts over
//   404 ErrorItemNotFound       `gone`        — the message, folder or subscription is not there
//   429 ApplicationThrottled    `rate_limited`, with Graph's Retry-After, which conduit already parsed
//   401 InvalidAuthenticationToken `auth_failed` — the access token; conduit forgets it and replays once
//   403                          `forbidden`   — the grant lacks the scope or the mailbox's policy says no; kept
//   400 invalid_grant (token)    `grant_lost`  — the refresh token is dead: revoked, expired, the password changed
//   400 anything else            `refused`     — our request was wrong; never retried
//
// Graph's 503 and 504 are retried by conduit before they arrive here; what
// arrives is `retryable` as conduit graded it. A lost answer to a write is
// `indeterminate`, and § C6 in the README names the read that resolves each.

import type { ConduitError } from '@frontierjs/conduit'
import type { GraphErrorBody, TokenRefusal } from './types.ts'

export type MicrosoftFailureKind =
  | 'grant_lost'            // the refresh token is dead; the person signs in again
  | 'sync_reset'            // 410: the delta cursor is void, start the folder over
  | 'gone'                  // 404
  | 'forbidden'             // 403: a policy's or scope's refusal; the credential is kept
  | 'refused'               // 400: our request; never retried
  | ConduitError['kind']    // what the transport already named

export interface MicrosoftFailure {
  kind:           MicrosoftFailureKind
  message:        string
  retryable:      boolean
  /** Graph's `error.code` (`ErrorItemNotFound`), or the token endpoint's `error` (`invalid_grant`). */
  code?:          string
  /** HTTP status, where the target answered. */
  status?:        number
  /** The first AADSTS code in a token refusal's description. */
  aadsts?:        string
  retryAfterMs?:  number
  /** The request may have been applied: a write whose answer was lost. */
  indeterminate?: true
}

export function parseBody<T>(raw: unknown): T | null {
  if (raw && typeof raw === 'object') return raw as T
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) as T } catch { return null }
}

const AADSTS = /AADSTS(\d+)/

export function translate(error: ConduitError, status?: number, headers?: Record<string, string>): MicrosoftFailure {
  const base: MicrosoftFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable,
    ...(status !== undefined ? { status } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true as const } : {}),
  }
  const body = parseBody<GraphErrorBody & TokenRefusal>(error.raw)

  // The token endpoint: a flat `error` word.
  if (typeof body?.error === 'string') {
    const word = body.error
    const description = body.error_description ?? word
    const aadsts = AADSTS.exec(description)?.[1]
    const extra = { code: word, message: description, ...(aadsts ? { aadsts } : {}) }
    if (word === 'invalid_grant') return { ...base, ...extra, kind: 'grant_lost', retryable: false }
    if (word === 'invalid_client' || status === 401) return { ...base, ...extra, kind: 'auth_failed', retryable: false }
    if (status !== undefined && status >= 500) return { ...base, ...extra }
    return { ...base, ...extra, kind: 'refused', retryable: false }
  }

  // Graph: the envelope.
  const e = body?.error && typeof body.error === 'object' ? body.error : null
  const extra = { ...(e?.code ? { code: e.code } : {}), ...(e?.message ? { message: e.message } : {}) }

  if (status === 410 || e?.code === 'SyncStateNotFound' || e?.code === 'SyncStateInvalid') return { ...base, ...extra, kind: 'sync_reset', retryable: false }
  if (status === 404) return { ...base, ...extra, kind: 'gone', retryable: false }
  if (status === 429 || error.kind === 'rate_limited') return { ...base, ...extra, kind: 'rate_limited', retryable: true }
  if (status === 401) return { ...base, ...extra, kind: 'auth_failed', retryable: false }
  if (status === 403) return { ...base, ...extra, kind: 'forbidden', retryable: false }
  if (status !== undefined && status >= 400 && status < 500) return { ...base, ...extra, kind: 'refused', retryable: false }
  if (error.kind === 'client_error') return { ...base, ...extra, kind: 'refused', retryable: false }
  if (headers?.['www-authenticate']?.includes('invalid_token')) return { ...base, ...extra, kind: 'auth_failed', retryable: false }
  return { ...base, ...extra }
}

/** A refusal a retry cannot change. 401 is left out: conduit's one replay on a fresh token is the retry. */
export const permanent = (f: MicrosoftFailure) =>
  f.kind === 'gone' || f.kind === 'forbidden' || f.kind === 'refused' || f.kind === 'grant_lost' || f.kind === 'sync_reset'
