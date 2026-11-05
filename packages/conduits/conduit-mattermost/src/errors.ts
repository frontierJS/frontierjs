// src/errors.ts — Mattermost's refusal → the app's answer. The one reader of
// `error.raw`, the status and the response headers (C3).
//
// Mattermost refuses with `{ id, message, status_code }` on every status, and
// the status carries what the kind cannot: conduit grades a 403 `auth_failed`
// beside a 401, but a 403 here is the POLICY's answer — not a member of that
// channel, not allowed to create a public channel — and reminting the token
// changes nothing, so it is `forbidden`. A 404 is `gone`: the post was deleted
// under us, which a sync treats as `missingSince` and never as a malformed
// request. A 429 arrives with no `Retry-After`; the wait is `X-Ratelimit-Reset`,
// in seconds, which conduit does not read and this does.

import type { ConduitError } from '@frontierjs/conduit'
import type { MattermostErrorBody } from './types.ts'

export type MattermostFailureKind =
  | 'refused'    // this request was wrong: no channel, empty message, a bad id, a name taken
  | 'forbidden'  // the token is good and the answer is no; the user is not where the request says
  | 'gone'       // the row no longer exists at Mattermost
  | ConduitError['kind']

export interface MattermostFailure {
  kind:          MattermostFailureKind
  message:       string
  retryable:     boolean
  /** Mattermost's own word — `api.post.create_post.channel_root_id.app_error`. */
  code?:         string
  retryAfterMs?: number
}

export function bodyOf(raw: unknown): MattermostErrorBody | null {
  if (raw && typeof raw === 'object') return raw as MattermostErrorBody
  if (typeof raw !== 'string') return null
  try { const b = JSON.parse(raw); return b && typeof b === 'object' ? b as MattermostErrorBody : null } catch { return null }
}

export function translate(error: ConduitError, status?: number, headers?: Record<string, string>): MattermostFailure {
  const body = bodyOf(error.raw)
  const code = body?.id
  const reset = headers?.['x-ratelimit-reset']
  const retryAfterMs = error.retry_after_ms ?? (reset !== undefined && Number.isFinite(Number(reset)) ? Number(reset) * 1000 : undefined)
  const base: MattermostFailure = {
    kind:      error.kind,
    message:   body?.message ?? error.message,
    retryable: error.retryable,
    ...(code ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  }
  if (status === 403 || (error.kind === 'auth_failed' && status === 403)) return { ...base, kind: 'forbidden', retryable: false }
  if (status === 404) return { ...base, kind: 'gone', retryable: false }
  if (status === 429) return { ...base, kind: 'rate_limited', retryable: true }
  if (error.kind === 'client_error') return { ...base, kind: 'refused', retryable: false }
  return base
}
