// src/errors.ts — conduit's error → the mailer's.
//
// Resend answers `{ statusCode, name, message }`. Two 429s mean different
// things: `rate_limit_exceeded` clears in a second, `daily_quota_exceeded`
// clears at midnight UTC — the same status, the same conduit kind, and one is
// worth a retry while the other is not until tomorrow.

import type { ConduitError } from '@frontierjs/conduit'
import type { ResendErrorBody } from './types.ts'

export type ResendFailureKind = 'refused' | 'quota' | 'suppressed' | ConduitError['kind']

export interface ResendFailure {
  kind:          ResendFailureKind
  message:       string
  retryable:     boolean
  name?:         string
  retryAfterMs?: number
}

const body = (raw: unknown): ResendErrorBody | null => {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw as ResendErrorBody) } catch { return null }
}

export function translate(error: ConduitError): ResendFailure {
  const base: ResendFailure = { kind: error.kind, message: error.message, retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  const e = body(error.raw)
  if (!e?.name) return base
  const name = e.name
  const kind: ResendFailureKind =
    name === 'daily_quota_exceeded' ? 'quota'
    : name === 'validation_error' || name === 'invalid_parameter' || name === 'not_found' ? 'refused'
    : base.kind
  return { ...base, kind, name, message: e.message ?? base.message, retryable: kind === 'quota' ? false : kind === 'refused' ? false : base.retryable }
}
