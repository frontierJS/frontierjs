// src/errors.ts — Ahrefs' refusal → the app's answer. The one reader of
// `error.raw`, the status and the response headers (C3), and of the five
// `x-api-*` cost headers (`costOf`).
//
// Conduit grades every 401 and 403 `auth_failed` and never replays one. Ahrefs
// spends three different things on that grade, measured 2026-11-25: a wrong
// key (401 `["Error","Unauthorized"]`), no key at all (403 `["Error","Forbidden"]`)
// and a spent allowance (403 `{ "error": "API units limit reached. … API units
// left: 0." }`). Left alone, a key with its monthly units gone reads to the app
// as "make a new key" and the owner remakes a working one.

import { errorBody, type ConduitError } from '@frontierjs/conduit'
import type { AhrefsErrorBody, Cost } from './types.ts'

export type AhrefsFailureKind =
  | 'quota'       // a 403 that says the key's or the workspace's units are spent: raise the limit, the key is fine
  | 'refused' // a 400: the request itself was wrong, and Ahrefs' text says which argument
  | ConduitError['kind']

export interface AhrefsFailure {
  kind:           AhrefsFailureKind
  message:        string
  retryable:      boolean
  /** Set where the request left and its outcome is unknown: the caller reads before writing again (C6). */
  indeterminate?: boolean
  /** On `rate_limited`: how long to wait, from `Retry-After`, else a minute. */
  retryAfterMs?:  number
  /** What the refused call cost, where the answer said. A refused call spends nothing. */
  cost?:          Cost
}

/** Ahrefs' documented limit is 60 requests a minute, and no 429 has been captured to say otherwise. */
export const DEFAULT_WAIT_MS = 60_000

/** The units-spent 403's own words. A different wording falls back to `auth_failed` with Ahrefs' text. */
export const QUOTA_TEXT = /units limit reached/i

const seconds = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** Ahrefs' sentence out of either body shape: `{ error }`, or `["Error","Unauthorized"]`. */
function said(raw: unknown): string | undefined {
  const body = errorBody<AhrefsErrorBody>(raw)
  if (Array.isArray(body)) return body.filter(s => typeof s === 'string').join(': ') || undefined
  return typeof body?.error === 'string' ? body.error : undefined
}

/**
 * `quota` is an argument so a drive can take the match away and watch the
 * quota row read `auth_failed` (C11's negative control).
 */
export function translate(
  error: ConduitError,
  meta: { status?: number; headers?: Record<string, string> } = {},
  opts: { quota?: RegExp } = {},
): AhrefsFailure {
  const text = said(error.raw)
  const base: AhrefsFailure = {
    kind:      error.kind,
    message:   text ?? error.message,
    retryable: error.retryable,
    ...(error.indeterminate ? { indeterminate: true } : {}),
  }
  const status = meta.status

  if (status === 429 || error.kind === 'rate_limited') {
    const after = seconds(meta.headers?.['retry-after'])
    const wait = after !== undefined ? Math.max(0, Math.ceil(after * 1000)) : error.retry_after_ms ?? DEFAULT_WAIT_MS
    return { ...base, kind: 'rate_limited', retryable: true, retryAfterMs: wait }
  }
  if (status === 401) return { ...base, kind: 'auth_failed', retryable: false }
  if (status === 403) {
    if ((opts.quota ?? QUOTA_TEXT).test(text ?? '')) return { ...base, kind: 'quota', retryable: false }
    return { ...base, kind: 'auth_failed', retryable: false }
  }
  if (status === 400) return { ...base, kind: 'refused', retryable: false }
  return base
}

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** What a call cost, from the response's lowercased headers. */
export function costOf(meta: { headers?: Record<string, string> } = {}): Cost {
  const h = meta.headers ?? {}
  const cache = h['x-api-cache']
  return {
    rows:   num(h['x-api-rows']),
    perRow: num(h['x-api-units-cost-row']),
    total:  num(h['x-api-units-cost-total']),
    actual: num(h['x-api-units-cost-total-actual']),
    cache:  cache === 'hit' || cache === 'miss' || cache === 'no_cache' ? cache : null,
  }
}
