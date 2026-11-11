// src/errors.ts — Airtable's refusal → the app's answer. The one reader of
// `error.raw` and the status (C3).
//
// The status is read BEFORE the type. Airtable answers `403
// INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND` for a missing record, a missing table
// and a missing base alike (measured 2026-11-10), so a 403 cannot say whether
// the token is wrong and is `forbidden`, never `auth_failed`: nothing may
// forget a good token over a record that is not there. A 401 is the key's.
// A 404 is `gone` on the docs' word, unmeasured.
//
// A 429 names no `Retry-After` (measured) and its body is the PLURAL
// `{ errors: [{ error, message }] }`; the documented 30 s is supplied so the
// caller always has a wait (C5, google-maps). A 422 is the caller's request
// and carries Airtable's own type in `code`, except two that are a different
// thing: a dead `offset` is `refused` with `code: 'iterator_expired'` (the walk
// starts over), and an upsert that matched two rows is `conflict` with
// `code: 'ambiguous_match'` and wrote nothing.

import type { ConduitError } from '@frontierjs/conduit'
import type { AirtableErrorBody } from './types.ts'

export type AirtableFailureKind =
  | 'invalid_request'  // 422: this request was wrong; `code` is Airtable's type
  | 'refused'          // an offset that died, or any other 4xx the caller cannot fix by resending
  | 'forbidden'        // no access, or no such record, table or base — Airtable cannot say which
  | 'gone'             // 404
  | 'conflict'         // an upsert matched more than one row
  | ConduitError['kind']

export interface AirtableFailure {
  kind:           AirtableFailureKind
  message:        string
  retryable:      boolean
  /** Airtable's own type — `INVALID_VALUE_FOR_COLUMN` — or this connector's word for the two cases above. */
  code?:          string
  retryAfterMs?:  number
  /** The request may have been applied: its answer was lost. A create is unkeyed, so this is `findCreated`'s case (C6). */
  indeterminate?: true
}

/** A 30 s wait, the docs' number: no 429 here carries a `Retry-After`. */
export const RATE_LIMIT_WAIT_MS = 30_000

export function bodyOf(raw: unknown): AirtableErrorBody | null {
  if (raw && typeof raw === 'object') return raw as AirtableErrorBody
  if (typeof raw !== 'string') return null
  try { const b = JSON.parse(raw); return b && typeof b === 'object' ? b as AirtableErrorBody : null } catch { return null }
}

/** The type and sentence out of either error shape. */
function read(body: AirtableErrorBody | null): { type?: string; message?: string } {
  if (!body) return {}
  const one = body.errors?.[0]
  if (one) return { type: one.error, message: one.message }
  if (typeof body.error === 'string') return { type: body.error }
  if (body.error) return { type: body.error.type, message: body.error.message }
  if (body.details?.message) return { type: body.details.message, message: body.details.reasons?.join('; ') }
  return {}
}

export function translate(error: ConduitError, status?: number): AirtableFailure {
  const body = bodyOf(error.raw)
  const { type, message } = read(body)
  const text = typeof error.raw === 'string' && !body ? error.raw.trim() : ''
  const base: AirtableFailure = {
    kind:      error.kind,
    message:   message ?? type ?? (text || error.message),
    retryable: error.retryable,
    ...(type ? { code: type } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true as const } : {}),
  }
  if (status === 401) return { ...base, kind: 'auth_failed', retryable: false }
  if (status === 403) return { ...base, kind: 'forbidden', retryable: false }
  if (status === 404) return { ...base, kind: 'gone', retryable: false }
  if (status === 429) return { ...base, kind: 'rate_limited', retryable: true, retryAfterMs: error.retry_after_ms ?? RATE_LIMIT_WAIT_MS }
  if (status === 422) {
    if (type === 'LIST_RECORDS_ITERATOR_NOT_AVAILABLE') return { ...base, kind: 'refused', code: 'iterator_expired', retryable: false }
    if (type === 'INVALID_VALUE_FOR_COLUMN' && /cannot update more than one record/i.test(message ?? '')) return { ...base, kind: 'conflict', code: 'ambiguous_match', retryable: false }
    return { ...base, kind: 'invalid_request', retryable: false }
  }
  if (error.kind === 'client_error') return { ...base, kind: 'refused', retryable: false }
  return base
}
