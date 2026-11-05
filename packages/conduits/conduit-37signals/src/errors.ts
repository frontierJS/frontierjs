// src/errors.ts — Basecamp's refusal → the app's answer. The one reader of
// `error.raw`, the status and the response headers (C3).
//
// A 403 is the POLICY's answer — an Agent outside its endpoint set, a person
// on a tool their role cannot reach — and conduit grades it `auth_failed`
// beside a 401, but reminting the token changes nothing, so it is `forbidden`.
// A 404 is `gone`, and here that means gone TO THIS PRINCIPAL: deleted, or a
// project the token was never on, answer the same 404, so a mirror must not
// read it as a deletion. A trashed recording may still answer 200 with
// `status: trashed`; nothing has measured it. The one 404 that is not about the row
// carries `Reason: Account Inactive` — an expired or suspended account, where
// every path answers alike — and is `inactive`. A 429's wait is conduit's
// `Retry-After`. A 507 is the account's project limit, which no retry passes.
//
// Only the event feed answers 409 or 410 (every section of bc-api read
// 2026-10-20), and neither body names a `reason`, so the code is this
// connector's: a 409 is `filters_changed`, a position minted for other
// filters, and a 410 is `before_epoch`, a position below the feed's floor,
// with the `resume` URL that re-enters at it. A 400's `reason` is already the
// code. Each is a cursor to re-enter, never one to retry.

import type { ConduitError } from '@frontierjs/conduit'
import type { BasecampErrorBody } from './types.ts'

export type BasecampFailureKind =
  | 'refused'    // this request was wrong: a bad id, a bad position, no User-Agent
  | 'forbidden'  // the token is good and the answer is no
  | 'gone'       // not there for this principal — deleted or never visible
  | 'inactive'   // the account itself is expired or suspended
  | 'capacity'   // the account is at its project limit
  | ConduitError['kind']

export interface BasecampFailure {
  kind:          BasecampFailureKind
  message:       string
  retryable:     boolean
  /** Basecamp's own word, where the body names one — `invalid_position`. */
  code?:         string
  retryAfterMs?: number
  /** The request may have been applied: its answer was lost. Every create is unkeyed, so this is `findCreated`'s case (C6). */
  indeterminate?: true
  /** `before_epoch`'s way back in: the feed's own URL, at its epoch with the filters kept, followed whole. */
  resume?:       string
}

export function bodyOf(raw: unknown): BasecampErrorBody | null {
  if (raw && typeof raw === 'object') return raw as BasecampErrorBody
  if (typeof raw !== 'string') return null
  try { const b = JSON.parse(raw); return b && typeof b === 'object' ? b as BasecampErrorBody : null } catch { return null }
}

export function translate(error: ConduitError, status?: number, headers?: Record<string, string>): BasecampFailure {
  const body = bodyOf(error.raw)
  const text = typeof error.raw === 'string' && !body ? error.raw.trim() : ''
  const base: BasecampFailure = {
    kind:      error.kind,
    message:   body?.error ?? (text || error.message),
    retryable: error.retryable,
    ...(body?.reason ? { code: body.reason } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true as const } : {}),
  }
  if (status === 403) return { ...base, kind: 'forbidden', retryable: false }
  if (status === 404 && /account inactive/i.test(headers?.reason ?? '')) return { ...base, kind: 'inactive', retryable: false }
  if (status === 404) return { ...base, kind: 'gone', retryable: false }
  if (status === 429) return { ...base, kind: 'rate_limited', retryable: true }
  if (status === 507) return { ...base, kind: 'capacity', retryable: false }
  if (status === 409) return { ...base, kind: 'refused', code: 'filters_changed', retryable: false }
  if (status === 410) return { ...base, kind: 'refused', code: 'before_epoch', retryable: false, ...(typeof body?.resume === 'string' ? { resume: body.resume } : {}) }
  if (error.kind === 'client_error') return { ...base, kind: 'refused', retryable: false }
  return base
}
