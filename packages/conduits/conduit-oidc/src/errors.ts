// src/errors.ts — conduit's error → the app's, read off RFC 6749 §5.2.
//
// Conduit classifies by status and an OAuth refusal is almost always a 400, so
// `client_error` covers the two answers an app must tell apart: `invalid_grant`
// (the refresh token is dead — the ROW is lost and the user signs in again,
// FJS-D795) and `invalid_request` (our request was wrong and a second try is a
// second refusal). The body's `error` field is the real answer and conduit
// keeps the body on `raw`. One reader: nothing else in the package touches
// `raw` or `meta.status`.

import type { ConduitError } from '@frontierjs/conduit'
import type { OAuthErrorBody } from './types.ts'

export type OidcFailureKind =
  | 'grant_lost'    // invalid_grant: the refresh token or code is dead; re-authenticate
  | 'refused'       // invalid_request, unsupported_grant_type, invalid_scope, unauthorized_client
  | 'auth_failed'   // invalid_client: OUR credential, forgotten and reminted by conduit
  | 'forbidden'     // insufficient_scope on a resource (RFC 6750): the token is right, the policy says no
  | 'token_invalid' // invalid_token on userinfo (RFC 6750): the access token is expired or revoked
  | ConduitError['kind']

export interface OidcFailure {
  kind:          OidcFailureKind
  message:       string
  retryable:     boolean
  /** The provider's `error` value, where it gave one. */
  code?:         string
  description?:  string
  retryAfterMs?: number
  /** The request went out and nobody knows whether it was applied — a lost refresh under rotation is the case. */
  indeterminate?: boolean
}

export function parseBody(raw: unknown): OAuthErrorBody | null {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' ? v as OAuthErrorBody : null
  } catch { return null }
}

/** RFC 6750 §3: a resource server's refusal rides `WWW-Authenticate: Bearer error="…"`. */
export function parseBearerChallenge(header: string | undefined): OAuthErrorBody | null {
  if (!header || !/^Bearer\b/i.test(header)) return null
  const out: OAuthErrorBody = {}
  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) {
    if (m[1] === 'error') out.error = m[2]
    if (m[1] === 'error_description') out.error_description = m[2]
  }
  return out.error ? out : null
}

const BY_CODE: Record<string, OidcFailureKind> = {
  invalid_grant:           'grant_lost',
  invalid_client:          'auth_failed',
  invalid_request:         'refused',
  unsupported_grant_type:  'refused',
  invalid_scope:           'refused',
  unauthorized_client:     'refused',
  invalid_token:           'token_invalid',
  insufficient_scope:      'forbidden',
  temporarily_unavailable: 'server_error',
}

export function translate(error: ConduitError, headers?: Record<string, string>): OidcFailure {
  const base: OidcFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(error.indeterminate ? { indeterminate: true } : {}),
  }
  const body = parseBody(error.raw) ?? parseBearerChallenge(headers?.['www-authenticate'])
  if (!body?.error) return base
  // A 429 keeps its kind whatever the body says: the status carries
  // Retry-After and the body is whatever the provider felt like.
  const kind = base.kind === 'rate_limited' ? base.kind : (BY_CODE[body.error] ?? base.kind)
  return {
    ...base,
    kind,
    code:      body.error,
    message:   body.error_description ? `${body.error}: ${body.error_description}` : body.error,
    // Whether a 5xx may be sent again is conduit's call — it knows whether the
    // POST was replayable and sets indeterminate — so only a DOMAIN kind
    // decides for itself, and every one of those is a no.
    retryable: kind === base.kind ? base.retryable : false,
    ...(body.error_description ? { description: body.error_description } : {}),
  }
}
