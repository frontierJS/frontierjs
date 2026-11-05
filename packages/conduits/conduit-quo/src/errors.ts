// src/errors.ts — Quo's `{ title, message, code?, errors[] }` → the app's.
//
// The status alone misleads three ways, which is why the body's `code` is read
// first. A 429 is two different things: the per-key rate (10/s, retry with
// backoff) and `0200429` Daily Conversation Limit Reached, which no retry this
// day will clear. A 403 is rarely the key's fault: the sender is not a member
// of the number, international texting is off, the 10DLC daily cap is spent.
// And a 400 can be `0206400`, A2P registration not approved, which no change
// to the request fixes. The codes come from Quo's v1 OpenAPI spec; the dated
// API mostly answers without one, so the status fallbacks below carry it.

import type { ConduitError } from '@frontierjs/conduit'
import type { QuoErrorBody } from './types.ts'

export type QuoFailureKind =
  | 'unregistered' | 'quota' | 'billing' | 'forbidden' | 'gone' | 'refused'
  | ConduitError['kind']

export interface QuoFailure {
  kind:           QuoFailureKind
  code?:          string
  message:        string
  retryable:      boolean
  retryAfterMs?:  number
  /** The send may have landed; `findSent` is the read that says. */
  indeterminate?: boolean
  /** Quo support finds the exact request by it. */
  trace?:         string
  fields?:        { path: string; message: string }[]
}

/** Texting is blocked until the brand's 10DLC registration is approved. */
export const UNREGISTERED_CODES = new Set(['0206400'])
/** A daily ceiling, not a rate: today's retries all fail. */
export const QUOTA_CODES        = new Set(['0200429', '0204403'])
/** A ceiling the dated API names by its title alone, which its spec fixes as a constant. */
export const QUOTA_TITLES       = new Set(['Open Tasks Limit Reached'])

export function translate(error: ConduitError, status?: number): QuoFailure {
  let body: QuoErrorBody | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as QuoErrorBody) } catch { /* not JSON */ }
  const code = body?.code
  const base: QuoFailure = {
    kind: error.kind, retryable: error.retryable,
    message: body?.message ? `${body.title ? `${body.title}: ` : ''}${body.message}` : error.message,
    ...(code ? { code } : {}),
    ...(body?.trace ? { trace: body.trace } : {}),
    ...(body?.errors?.length ? { fields: body.errors.map(e => ({ path: e.path, message: e.message })) } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true } : {}),
  }
  const at = status ?? body?.status
  if (code && UNREGISTERED_CODES.has(code)) return { ...base, kind: 'unregistered', retryable: false }
  if (code && QUOTA_CODES.has(code))        return { ...base, kind: 'quota', retryable: false }
  // A 402, which would read as billing: the plan is paid, and its open tasks are full.
  if (body?.title && QUOTA_TITLES.has(body.title)) return { ...base, kind: 'quota', retryable: false }
  if (at === 402)                           return { ...base, kind: 'billing', retryable: false }
  // conduit grades every 403 `auth_failed`; this one is the workspace's policy, and the key is good.
  if (at === 403)                           return { ...base, kind: 'forbidden', retryable: false }
  if (at === 404)                           return { ...base, kind: 'gone', retryable: false }
  if (error.kind === 'client_error')        return { ...base, kind: 'refused', retryable: false }
  return base
}
