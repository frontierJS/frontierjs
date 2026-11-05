// src/errors.ts — Slack's `ok: false` → the app's answer.
//
// The Web API answers HTTP 200 for almost every failure and puts the verdict
// in `error`: a missing channel, a revoked token and a message that is too
// long all arrive as a 200 conduit would hand back as success. Every call
// passes `okEnvelope`, which refuses `ok: false` so it lands as
// `invalid_response` with the body on `raw` (C4), and this is the one reader
// of `raw` (C3). The incoming webhook speaks a second dialect: plain text,
// graded by status, `no_service` on a 404 meaning the webhook is deleted.

import type { ConduitError, ResponseValidator } from '@frontierjs/conduit'
import type { SlackEnvelope } from './types.ts'

export type SlackFailureKind =
  | 'refused'   // the request was wrong for this workspace: no such channel, bot not a member, bad blocks
  | 'too_long'  // the text is over Slack's limit; shorten rather than retry
  | 'gone'      // the webhook was deleted at Slack; the app's row is dead
  | ConduitError['kind']

export interface SlackFailure {
  kind:          SlackFailureKind
  message:       string
  retryable:     boolean
  /** Slack's own word — `channel_not_found`, `no_service`. */
  code?:         string
  retryAfterMs?: number
}

export const okEnvelope: ResponseValidator<SlackEnvelope> = {
  validate(data) {
    const e = data as SlackEnvelope | null
    if (!e || typeof e !== 'object' || typeof e.ok !== 'boolean') return { ok: false, errors: ['not a Slack envelope'] }
    if (e.ok !== true) return { ok: false, errors: [e.error ?? 'ok was false'] }
    return { ok: true, value: e }
  },
}

const REFUSED     = new Set(['channel_not_found', 'not_in_channel', 'invalid_blocks', 'invalid_blocks_format', 'is_archived', 'invalid_payload', 'no_text', 'invalid_arguments', 'channel_is_archived', 'user_not_found'])
const AUTH_FAILED = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'not_authed', 'token_expired', 'missing_scope', 'invalid_token', 'action_prohibited'])
const SERVER      = new Set(['fatal_error', 'internal_error', 'service_unavailable'])
const GONE        = new Set(['no_service', 'no_team', 'team_disabled', 'channel_is_archived'])

/** Slack's word out of either dialect: JSON `{ error }` or the webhook's bare text. */
export function codeOf(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'object') return (raw as SlackEnvelope).error
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  if (!text) return undefined
  try { return (JSON.parse(text) as SlackEnvelope).error } catch { return /^[a-z_]+$/.test(text) ? text : undefined }
}

export function translate(error: ConduitError, status?: number): SlackFailure {
  const code = codeOf(error.raw)
  const base: SlackFailure = {
    kind:      error.kind,
    message:   code ? `Slack: ${code}` : error.message,
    retryable: error.retryable,
    ...(code ? { code } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
  }
  if (status === 410) return { ...base, kind: 'gone', retryable: false }
  if (!code) return base
  if (code === 'msg_too_long')    return { ...base, kind: 'too_long', retryable: false }
  if (code === 'ratelimited')     return { ...base, kind: 'rate_limited', retryable: true }
  if (GONE.has(code) && status === 404) return { ...base, kind: 'gone', retryable: false }
  if (SERVER.has(code))           return { ...base, kind: 'server_error', retryable: true }
  if (AUTH_FAILED.has(code))      return { ...base, kind: 'auth_failed', retryable: false }
  if (REFUSED.has(code))          return { ...base, kind: 'refused', retryable: false }
  // A 2xx that failed and a 4xx are both Slack refusing THIS request; a kind
  // conduit already decided on the status (a 5xx, a timeout) stands.
  if (error.kind === 'invalid_response' || error.kind === 'client_error') return { ...base, kind: 'refused', retryable: false }
  return base
}
