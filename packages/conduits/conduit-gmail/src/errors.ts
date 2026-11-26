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
//
// Calendar speaks the same envelope, so `translateCalendar` shares this file's
// reader and the rate, scope and quota tables; it adds only what Calendar
// spells with a status of its own: a 409 on a reused event id, and a 410 that
// is either a deleted event or a sync token Google no longer honors.

import { errorBody, type ConduitError } from '@frontierjs/conduit'
import type { GoogleErrorBody } from './types.ts'

/** What both Google dialects can name. */
type GoogleFailureKind =
  | 'forbidden'             // the policy's or the scope's refusal; the credential is kept
  | 'quota'                 // the day's units are spent: not now, not never
  | 'gone'                  // the resource no longer exists at Google
  | 'refused'               // our request was wrong; never retried
  | ConduitError['kind']    // anything the transport already named

export type GmailFailureKind = GoogleFailureKind
  | 'history_gap'           // the watermark aged out of history; the app re-syncs by query

export type CalendarFailureKind = GoogleFailureKind
  | 'conflict'              // 409: the event id is taken; for an insert, it already landed
  | 'sync_reset'            // 410: the sync token or updatedMin is too old; the app lists in full

/** Which per-user ceiling a 429 named, read off Google's message text. */
export type RateLimitKind = 'sending' | 'bandwidth' | 'concurrency' | 'units'

export interface GoogleFailure<K extends string = GoogleFailureKind> {
  kind:          K
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

export type GmailFailure    = GoogleFailure<GmailFailureKind>
export type CalendarFailure = GoogleFailure<CalendarFailureKind>

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

/** Everything one failure says, read once; both dialects start here. */
interface Read {
  base:   GoogleFailure
  extra:  { message?: string; reason?: string; status?: string }
  e:      GoogleErrorBody['error'] | undefined
  reason: string | undefined
  http:   number | undefined
  wait:   number
  error:  ConduitError
}

function read(error: ConduitError, status?: number): Read {
  const base: GoogleFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true as const } : {}),
  }
  const e      = errorBody<GoogleErrorBody>(error.raw)?.error
  const reason = e ? reasonOf(e) : undefined
  const extra  = {
    ...(e?.message ? { message: e.message } : {}),
    ...(reason     ? { reason } : {}),
    ...(e?.status  ? { status: e.status } : {}),
  }
  return { base, extra, e, reason, http: status ?? e?.code, wait: base.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS, error }
}

/** The statuses both dialects grade alike: 429, the four 403s, 401 and 404. */
function shared(r: Read): GoogleFailure | null {
  const { base, extra, e, reason, http, wait, error } = r

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
  return null
}

/** What no status named: a 4xx is our request's fault, a challenge is the credential's. */
function rest(r: Read, headers?: Record<string, string>): GoogleFailure {
  const { base, extra, error } = r
  if (error.kind === 'client_error') return { ...base, ...extra, kind: 'refused', retryable: false }

  // A `WWW-Authenticate` on anything else is still the credential's refusal.
  if (headers?.['www-authenticate']?.includes('invalid_token')) return { ...base, ...extra, kind: 'auth_failed', retryable: false }

  return { ...base, ...extra }
}

export function translate(error: ConduitError, status?: number, headers?: Record<string, string>): GmailFailure {
  const r = read(error, status)
  return (shared(r) ?? rest(r, headers)) as GmailFailure
}

const SYNC_RESET_REASONS = new Set(['fullSyncRequired', 'updatedMinTooLongAgo'])

/**
 * Calendar's dialect. A 409 is an event id that is taken, and a 410 is two
 * things: `deleted` (the event is gone) or a sync token Google no longer
 * honors. `quotaExceeded` stays `quota` although Calendar's guide words it
 * "usage limits exceeded"; the app cannot tell from the status whether it
 * clears in a minute, so it is never retried.
 */
export function translateCalendar(error: ConduitError, status?: number, headers?: Record<string, string>): CalendarFailure {
  const r = read(error, status)
  const hit = shared(r)
  if (hit) return hit as CalendarFailure
  const { base, extra, reason, http } = r
  if (http === 409) return { ...base, ...extra, kind: 'conflict', retryable: false }
  if (http === 410) {
    if (reason === 'deleted') return { ...base, ...extra, kind: 'gone', retryable: false }
    if (reason && SYNC_RESET_REASONS.has(reason)) return { ...base, ...extra, kind: 'sync_reset', retryable: false }
  }
  return rest(r, headers) as CalendarFailure
}
