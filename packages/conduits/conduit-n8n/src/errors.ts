// C3 — the one reader of `error.raw` and `meta.status`. The public API answers
// `{ message }`; the webhook listener answers `{ code, message, hint }`. Both
// are read here and nowhere else.

import type { ConduitError } from '@frontierjs/conduit'

export type N8nFailureKind =
  | 'refused'         // 400: the API read the request and said no
  | 'not_found'       // 404 on a workflow, execution or credential id
  | 'not_registered'  // 404 on a webhook path: no ACTIVE workflow listens there
  | 'no_trigger'      // activate refused: the workflow has no trigger, poller or webhook node
  | 'unpublishing'    // 409 right after a deactivate: the webhooks are still being torn down; a moment later it goes through
  | 'forbidden'       // 403: the key is good and may not do this (an API key scope, a license)
  | 'conflict'        // 409: a tag name taken, a stop on a run that ended, a retry of a run that succeeded
  | ConduitError['kind']

export interface N8nFailure {
  kind:          N8nFailureKind
  message:       string
  retryable:     boolean
  /** The request left and n8n may have applied it; C6 names the read that says. */
  indeterminate?: boolean
  retryAfterMs?: number
  hint?:         string
}

const read = (raw: unknown): { message?: string; hint?: string; code?: number } | null => {
  if (raw == null) return null
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return { message: raw } } }
  return raw as { message?: string }
}

export function translate(error: ConduitError, status?: number): N8nFailure {
  const body = read(error.raw)
  const base: N8nFailure = {
    kind: error.kind, message: body?.message ?? error.message, retryable: error.retryable,
    ...(error.indeterminate ? { indeterminate: true } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(body?.hint ? { hint: body.hint } : {}),
  }
  // Conduit reads 401 and 403 both as `auth_failed`; only 401 means the key
  // is bad and should be forgotten. 403 is the key's scope or the license.
  if (error.kind === 'auth_failed' && status === 403) return { ...base, kind: 'forbidden', retryable: false }
  if (error.kind !== 'client_error') return base
  const message = body?.message ?? ''
  if (status === 404) return { ...base, kind: /not registered/i.test(message) ? 'not_registered' : 'not_found', retryable: false }
  if (/no node to start|at least one trigger/i.test(message)) return { ...base, kind: 'no_trigger', retryable: false }
  // Neither refused forever nor safe to hammer: n8n says "try again in a few
  // moments" and names no wait, so the connector names one.
  if (/still being unpublished/i.test(message)) return { ...base, kind: 'unpublishing', retryable: true, retryAfterMs: 1000 }
  if (status === 409) return { ...base, kind: 'conflict', retryable: false }
  return { ...base, kind: 'refused', retryable: false }
}
