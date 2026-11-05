// src/errors.ts — Telnyx's `{ errors: [{ code, title, detail }] }` → the app's.
//
// Two refusals matter more than the rest and both are 4xx `client_error` to
// conduit: a recipient who texted STOP (sending again is a legal problem, not a
// retry) and a number that is not a number. The CODES below are the ones the
// sink answers; they are copied from Telnyx's error catalog from memory and
// `PROJECT_STATE.md` marks them as unverified against a real account.

import type { ConduitError } from '@frontierjs/conduit'
import type { TelnyxErrorBody } from './types.ts'

export type TelnyxFailureKind = 'opted_out' | 'invalid_destination' | 'refused' | ConduitError['kind']

export interface TelnyxFailure { kind: TelnyxFailureKind; code?: string; message: string; retryable: boolean; retryAfterMs?: number }

export const OPTED_OUT_CODES          = new Set(['40300'])
export const INVALID_DESTINATION_CODES = new Set(['40001', '40310', '40311'])

export function translate(error: ConduitError): TelnyxFailure {
  let body: TelnyxErrorBody | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as TelnyxErrorBody) } catch { /* not JSON */ }
  const first = body?.errors?.[0]
  const base: TelnyxFailure = { kind: error.kind, message: first ? `${first.title}${first.detail ? ` — ${first.detail}` : ''}` : error.message, retryable: error.retryable,
    ...(first?.code ? { code: first.code } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (!first || error.kind !== 'client_error') return base
  if (OPTED_OUT_CODES.has(first.code))           return { ...base, kind: 'opted_out', retryable: false }
  if (INVALID_DESTINATION_CODES.has(first.code)) return { ...base, kind: 'invalid_destination', retryable: false }
  return { ...base, kind: 'refused', retryable: false }
}
