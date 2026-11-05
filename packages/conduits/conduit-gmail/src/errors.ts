// src/errors.ts — Google's error envelope → the app's answer. The one reader
// of `error.raw`, the HTTP status and the response headers (CONTRACT C3).
//
// Conduit grades by status, and Gmail spells FOUR different things as 403: a
// scope the grant lacks, a Workspace admin's policy, the day's quota, and the
// per-user unit rate. Conduit calls every one `auth_failed`; only the scope
// case is about the credential, and even that one a refresh cannot cure. The
// `reason` is in the body — `details[].reason` for the scope case, then
// `errors[].reason` — so four kinds come out of one status here and nowhere
// else. A 404 is `gone` by status alone; `listHistory` renames it
// `history_gap`, which is the one place the call knows more than the body.

import type { ConduitError } from '@frontierjs/conduit'
import type { GoogleErrorBody } from './types.ts'

export type GmailFailureKind =
  | 'forbidden'             // the policy's or the scope's refusal; the credential is kept
  | 'quota'                 // the day's units are spent: not now, not never
  | 'history_gap'           // the watermark aged out of history; the app re-syncs by query
  | 'gone'                  // the message or thread no longer exists at Gmail
  | 'refused'               // our request was wrong; never retried
  | ConduitError['kind']    // anything the transport already named

/** Which per-user ceiling a 429 named, read off Google's message text. */
export type RateLimitKind = 'sending' | 'bandwidth' | 'concurrency' | 'units'

export interface GmailFailure {
  kind:          GmailFailureKind
  message:       string
  retryable:     boolean
  /** Google's `reason`, where it gave one — `userRateLimitExceeded`. */
  reason?:       string
  /** Google's gRPC status word — `PERMISSION_DENIED`. */
  status?:       string
  /** The grant lacks the scope: the app asks for a re-consent, no refresh helps. */
  scopeMissing?: true
  limit?:        RateLimitKind
  /** The wait, in ms. Google sends no `Retry-After`, so a rate limit carries the fallback. */
  retryAfterMs?: number
  /** The request may have been applied: a send whose answer was lost. */
  indeterminate?: true
}

/**
 * Google names no wait on a per-user rate limit. The window is 6,000 units a
 * minute per user, so one second usually clears a burst; the caller sleeps
 * this and tries once more, and conduit never does it for an unkeyed POST.
 */
export const RATE_LIMIT_FALLBACK_MS = 1_000

const SCOPE_REASONS  = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientScopes'])
const POLICY_REASONS = new Set(['domainPolicy', 'forbidden', 'accessNotConfigured'])
const QUOTA_REASONS  = new Set(['dailyLimitExceeded', 'quotaExceeded', 'dailyLimitExceededUnreg'])
const RATE_REASONS   = new Set(['userRateLimitExceeded', 'rateLimitExceeded', 'RATE_LIMIT_EXCEEDED'])

export function parseBody(raw: unknown): GoogleErrorBody | null {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw as GoogleErrorBody) } catch { return null }
}

/** `details[].reason` is the scope case's spelling; `errors[].reason` everything else's. */
function reasonOf(e: NonNullable<GoogleErrorBody['error']>): string | undefined {
  const detail = e.details?.find(d => d.reason)?.reason
  return detail ?? e.errors?.find(x => x.reason)?.reason
}

function limitOf(message: string): RateLimitKind {
  if (/mail sending/i.test(message))               return 'sending'
  if (/concurrent/i.test(message))                 return 'concurrency'
  if (/bandwidth/i.test(message))                  return 'bandwidth'
  return 'units'
}

export function translate(error: ConduitError, status?: number, headers?: Record<string, string>): GmailFailure {
  const base: GmailFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true as const } : {}),
  }
  const e      = parseBody(error.raw)?.error
  const reason = e ? reasonOf(e) : undefined
  const http   = status ?? e?.code
  const extra  = {
    ...(e?.message ? { message: e.message } : {}),
    ...(reason     ? { reason } : {}),
    ...(e?.status  ? { status: e.status } : {}),
  }
  const wait = base.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS

  // The 429 carries no `reason`; the message text names the ceiling.
  if (http === 429 || (error.kind === 'rate_limited' && http === undefined))
    return { ...base, ...extra, kind: 'rate_limited', retryable: true, retryAfterMs: wait, limit: limitOf(e?.message ?? error.message) }

  if (http === 403) {
    if (reason && RATE_REASONS.has(reason))
      return { ...base, ...extra, kind: 'rate_limited', retryable: true, retryAfterMs: wait, limit: 'units' }
    if (reason && QUOTA_REASONS.has(reason))
      return { ...base, ...extra, kind: 'quota', retryable: false }
    const scope = (reason && SCOPE_REASONS.has(reason)) || /insufficient authentication scopes/i.test(e?.message ?? '')
    if (scope || (reason && POLICY_REASONS.has(reason)) || e?.status === 'PERMISSION_DENIED' || !reason)
      return { ...base, ...extra, kind: 'forbidden', retryable: false, ...(scope ? { scopeMissing: true as const } : {}) }
    return { ...base, ...extra, kind: 'forbidden', retryable: false }
  }

  if (http === 401) return { ...base, ...extra, kind: 'auth_failed', retryable: false }
  if (http === 404) return { ...base, ...extra, kind: 'gone', retryable: false }
  if (error.kind === 'client_error') return { ...base, ...extra, kind: 'refused', retryable: false }

  // A `WWW-Authenticate` on anything else is still the credential's refusal.
  if (headers?.['www-authenticate']?.includes('invalid_token')) return { ...base, ...extra, kind: 'auth_failed', retryable: false }

  return { ...base, ...extra }
}
