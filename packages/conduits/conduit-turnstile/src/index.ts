// @frontierjs/conduit-turnstile — Cloudflare Turnstile's siteverify over conduit.
//
// One POST, which nearly fails the test for a maintained connector. What
// makes it one: the token is single-use, must be verified server-side with
// the caller's IP, and a form that skips the check is spam within a day. The
// secret travels IN THE BODY, which is the `signed` seam's secret-in-body
// case (`signers.test.ts`'s `inBody`): the signer appends it to the form
// conduit serialized, so the bytes signed are the bytes sent.
//
// Turnstile answers HTTP 200 for every outcome and puts the verdict in
// `success` + `error-codes`, so every call carries a `validate` that refuses a
// false `success` (CONTRACT C4) and the kind is read off the codes.

import type { ConduitError, ConduitRequest, ConduitResult, ResponseValidator, Signer, TargetDescriptor } from '@frontierjs/conduit'

export const TURNSTILE_TARGET  = 'provider:turnstile'
export const TURNSTILE_ADDRESS = 'https://challenges.cloudflare.com'
export const SIGNER_NAME       = 'turnstile-secret-in-body'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = TURNSTILE_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

/** Appends `secret=` to the serialized form. A JSON body is a string too, so
 *  the check is the content-type conduit set: a target declared without
 *  `encoding: 'form'` is refused rather than guessed, because the secret must
 *  never land inside a JSON string. */
export const turnstileSigner: Signer = ({ secret, body, headers }) => {
  if (typeof body !== 'string' || !(headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded'))
    throw new Error('turnstile: the target must declare encoding: form')
  return { body: `${body}${body ? '&' : ''}secret=${encodeURIComponent(secret)}` }
}
export const signers = { [SIGNER_NAME]: turnstileSigner }

export function turnstileTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? TURNSTILE_TARGET, kind: 'provider', protocol: 'http',
    address: opts.address ?? TURNSTILE_ADDRESS, encoding: 'form',
    auth: { type: 'signed', signer: SIGNER_NAME, ref: opts.ref ?? 'TURNSTILE_SECRET' },
    registered_at: Date.now(), last_seen_at: null,
  }
}

export interface SiteverifyResult {
  success:         boolean
  'error-codes':   string[]
  challenge_ts?:   string
  hostname?:       string
  action?:         string
  cdata?:          string
}

export type TurnstileFailureKind = 'spent' | 'refused' | 'misconfigured' | ConduitError['kind']
export interface TurnstileFailure { kind: TurnstileFailureKind; codes: string[]; message: string; retryable: boolean; retryAfterMs?: number }

/** A false `success` is a failure even though the status is 200. */
export const verdict: ResponseValidator<SiteverifyResult> = {
  validate(data) {
    const r = data as SiteverifyResult | null
    if (!r || typeof r !== 'object' || typeof r.success !== 'boolean') return { ok: false, errors: ['not a siteverify answer'] }
    if (!r.success) return { ok: false, errors: r['error-codes']?.length ? r['error-codes'] : ['success was false'] }
    return { ok: true, value: r }
  },
}

export function translate(error: ConduitError): TurnstileFailure {
  let codes: string[] = []
  try { const b = (typeof error.raw === 'string' ? JSON.parse(error.raw) : error.raw) as SiteverifyResult | null; codes = b?.['error-codes'] ?? [] } catch { /* not JSON */ }
  const base: TurnstileFailure = { kind: error.kind, codes, message: codes.length ? codes.join(', ') : error.message, retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (error.kind !== 'invalid_response') return base
  if (codes.includes('timeout-or-duplicate'))                                   return { ...base, kind: 'spent', retryable: false }
  if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) return { ...base, kind: 'misconfigured', retryable: false }
  if (codes.includes('internal-error'))                                         return { ...base, kind: 'server_error', retryable: true }
  return { ...base, kind: 'refused', retryable: false }
}

/**
 * Verify a token. `remoteip` is the visitor's address and should always be
 * sent. `idempotencyKey` is Turnstile's own: the same token may be re-verified
 * under the same key, which is what makes a lost response safe to retry —
 * without it a retry is `timeout-or-duplicate`, since the token is spent.
 */
export async function siteverify(send: Send, req: { token: string; remoteip?: string; idempotencyKey?: string; expectedHostname?: string; expectedAction?: string }): Promise<{ result?: SiteverifyResult; error?: TurnstileFailure }> {
  if (!req.token || req.token.length > 2048) return { error: { kind: 'refused', codes: ['invalid-input-response'], message: 'token is missing or too long', retryable: false } }
  const r = await send<SiteverifyResult>({
    method: 'POST', path: '/turnstile/v0/siteverify', validate: verdict,
    body: { response: req.token, ...(req.remoteip ? { remoteip: req.remoteip } : {}), ...(req.idempotencyKey ? { idempotency_key: req.idempotencyKey } : {}) },
    // Turnstile's key makes the SAME request answer the same: safe to replay.
    ...(req.idempotencyKey ? { replayable: true } : {}),
  })
  if (r.error) return { error: translate(r.error) }
  // A token minted for another site or another action verifies at Cloudflare
  // and must not here: the check is the app's declaration, made before use.
  if (req.expectedHostname && r.data.hostname !== req.expectedHostname) return { error: { kind: 'refused', codes: ['hostname-mismatch'], message: `token was issued for ${r.data.hostname}`, retryable: false } }
  if (req.expectedAction && r.data.action !== req.expectedAction)       return { error: { kind: 'refused', codes: ['action-mismatch'], message: `token was issued for action ${r.data.action}`, retryable: false } }
  return { result: r.data }
}
