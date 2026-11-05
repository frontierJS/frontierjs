// src/fcm/errors.ts -- conduit's error -> the app's.
//
// Conduit grades by status, and for a push the status is the wrong axis: a
// 404 `UNREGISTERED` says *delete the row* where an `INVALID_ARGUMENT` 400 says
// *fix the build*. FCM puts the answer under `error.details[].errorCode` and
// conduit keeps the body on `error.raw`. One owner: nothing else in the module
// reads `raw` or `meta.status`.

import type { ConduitError } from '@frontierjs/conduit'
import type { FcmErrorBody } from './types.ts'

export type FcmFailureKind =
  | 'unregistered'   // the device is gone: delete the token row, never retry
  | 'refused'        // our request was wrong (argument shape)
  | 'forbidden'      // the credential is fine and this project/sender is not ours
  | ConduitError['kind']

export interface FcmFailure {
  kind:          FcmFailureKind
  message:       string
  retryable:     boolean
  /** Google's own word: `UNREGISTERED`, `SENDER_ID_MISMATCH`. */
  code?:         string
  retryAfterMs?: number
  indeterminate?: boolean
}

const parse = <T>(raw: unknown): T | null => {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw as T) } catch { return null }
}

const CODES: Record<string, FcmFailureKind> = {
  UNREGISTERED:       'unregistered',
  INVALID_ARGUMENT:   'refused',
  SENDER_ID_MISMATCH: 'forbidden',
  THIRD_PARTY_AUTH_ERROR: 'forbidden',
  PERMISSION_DENIED:  'forbidden',
}

export function translate(error: ConduitError): FcmFailure {
  const base: FcmFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true } : {}),
  }
  const body = parse<FcmErrorBody>(error.raw)?.error
  if (!body) return base
  const code = body.details?.find(d => typeof d.errorCode === 'string')?.errorCode ?? body.status
  const kind = (code ? CODES[code] : undefined) ?? (error.kind === 'client_error' ? 'refused' : error.kind)
  return {
    ...base,
    kind,
    ...(code ? { code } : {}),
    message:   body.message ? `FCM: ${body.message}` : base.message,
    // A vendor word changed the kind, and no word above is worth a second try as-is.
    retryable: kind === error.kind ? error.retryable : false,
  }
}
