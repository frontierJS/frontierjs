// src/errors.ts — Cloudflare's envelope → the app's answer.
//
// Cloudflare answers `{ success, errors, result }` and `success` can be false
// on a 200. Conduit grades the status, so the connector attaches a `validate`
// to every call that refuses a false `success`; that lands as
// `invalid_response` with the body on `raw`, and this reads the message out.
// A 4xx carries the same envelope, and its message is the only place that
// says WHY — `client_error (HTTP 400)` tells an operator nothing about the
// CNAME already at that name.

import type { ConduitError, ResponseValidator } from '@frontierjs/conduit'
import type { CfEnvelope } from './types.ts'

export type CfFailureKind = 'refused' | 'conflict' | 'forbidden' | 'missing' | ConduitError['kind']

export interface CfFailure { kind: CfFailureKind; code?: number; message: string; retryable: boolean; retryAfterMs?: number }

export const envelope: ResponseValidator<CfEnvelope> = {
  validate(data) {
    const e = data as CfEnvelope | null
    if (!e || typeof e !== 'object' || !('success' in e)) return { ok: false, errors: ['not a Cloudflare envelope'] }
    if (e.success !== true) return { ok: false, errors: [e.errors?.[0]?.message ?? 'success was not true'] }
    return { ok: true, value: e }
  },
}

const first = (raw: unknown): { code: number; message: string } | undefined => {
  try { const b = (typeof raw === 'string' ? JSON.parse(raw) : raw) as CfEnvelope | null; return b?.errors?.[0] } catch { return undefined }
}

/** Codes Cloudflare answers a write refusal with, where the drive can see them. */
export const CONFLICT_CODES = new Set([81053, 81057, 81058])
export const MISSING_CODES  = new Set([81044, 7003])

export function translate(error: ConduitError, status?: number): CfFailure {
  const e = first(error.raw)
  const base: CfFailure = { kind: error.kind, message: e?.message ?? error.message, retryable: error.retryable,
    ...(e ? { code: e.code } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (error.kind === 'auth_failed' && status === 403) return { ...base, kind: 'forbidden' }
  if (error.kind !== 'client_error' && error.kind !== 'invalid_response') return base
  if (e && CONFLICT_CODES.has(e.code)) return { ...base, kind: 'conflict', retryable: false }
  if (e && MISSING_CODES.has(e.code))  return { ...base, kind: 'missing', retryable: false }
  if (status === 404) return { ...base, kind: 'missing', retryable: false }
  return { ...base, kind: 'refused', retryable: false }
}
