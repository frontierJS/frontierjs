// src/credentials.ts — WebRTC telephony credentials: one SIP identity per device.

import type { ConduitError } from '@frontierjs/conduit'
import { translate, type TelnyxFailure } from './errors.ts'
import type { Send } from './index.ts'

export interface TelnyxCredential {
  id:           string
  sip_username: string
  record_type:  'telephony_credential'
}

/** What a ring leg dials: a device's credential's SIP identity. */
export const sipUri = (sipUsername: string) => `sip:${sipUsername}@sip.telnyx.com`

/**
 * Make a SIP identity for one device on the credential connection. Not
 * replayable: Telnyx documents no idempotency for it, and a doubled
 * credential is an orphan at the carrier that nothing here points at.
 */
export async function createCredential(send: Send, req: { connectionId: string; name: string }): Promise<{ credential?: TelnyxCredential; error?: TelnyxFailure }> {
  const result = await send<{ data: TelnyxCredential }>({
    method: 'POST',
    path:   '/v2/telephony_credentials',
    body:   { connection_id: req.connectionId, name: req.name },
  })
  if (result.error) return { error: translate(result.error) }
  return { credential: result.data?.data }
}

export async function deleteCredential(send: Send, credentialId: string): Promise<{ ok: boolean; error?: TelnyxFailure }> {
  const result = await send({ method: 'DELETE', path: `/v2/telephony_credentials/${encodeURIComponent(credentialId)}` })
  if (result.error) return { ok: false, error: translate(result.error) }
  return { ok: true }
}

/**
 * A JWT the browser SDK logs in with, valid 24h. The one call that goes around
 * conduit: Telnyx answers it as a bare JWT with NO content-type, and conduit
 * refuses an untyped body that is not JSON (`invalid_response`, the body cut
 * to 512 bytes, shorter than the token). The request has no way to ask for the
 * text, so the app hands over the address and the key it resolved for this
 * account, and the failure is built through `translate` like any other.
 */
export async function credentialToken(req: {
  address:      string
  key:          string
  credentialId: string
  fetch?:       typeof fetch
}): Promise<{ token?: string; error?: TelnyxFailure }> {
  const fail = (kind: ConduitError['kind'], message: string, retryable: boolean, raw?: unknown) =>
    ({ error: translate({ kind, target: 'provider:telnyx', protocol: 'http', message, retryable, raw } satisfies ConduitError) })
  let res: Response
  try {
    res = await (req.fetch ?? fetch)(`${req.address}/v2/telephony_credentials/${encodeURIComponent(req.credentialId)}/token`, {
      method:   'POST',
      headers:  { authorization: `Bearer ${req.key}`, 'content-type': 'application/json' },
      body:     '{}',
      redirect: 'manual',
      signal:   AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return fail('connection_failed', (err as Error).message, true)
  }
  const text = await res.text()
  if (res.status >= 300 && res.status < 400) return fail('redirected', `HTTP ${res.status}`, false)
  if (!res.ok) {
    const kind = res.status === 401 || res.status === 403 ? 'auth_failed' : res.status === 429 ? 'rate_limited' : res.status >= 500 ? 'server_error' : 'client_error'
    return fail(kind, `HTTP ${res.status}`, res.status >= 500 || res.status === 429, text)
  }
  return { token: text.trim() }
}
