// src/domain/peer/peer-call.ts -- one signed call to another FrontierJS app as
// this machine's peer key (`FJS-D1188`, `FJS-D1604`): signed, sent, and the
// answer unwrapped or turned into a thrown refusal.
//
// The one place Workbench signs a request and the one place it reads a peer's
// result envelope (Invariant 4). It signs with toolbelt's `signRequest` rather
// than conduit's `ed25519` signer: that signer leaves `serviceMethod` out of the
// canonical string, and junction's verifier reads `X-Service-Method` into it,
// so every custom-method call it signed would be refused as a bad signature.

import { signRequest } from '@frontierjs/toolbelt/signature'
import { unwrapResult } from '@frontierjs/junction/envelope'

/** The header that names the caller's key; the signature carries no key id. */
export const PEER_KEY_HEADER = 'X-Fjs-Key'

export interface PeerCall {
  /** The peer's API origin, `http://127.0.0.1:8120`. */
  url:           string
  keyId:         string
  privateKey:    string
  path:          string
  serviceMethod: string
  body:          unknown
}

/**
 * A peer's refusal, in its own sentence. `status` is what Workbench answers its
 * own caller: a peer's 401/403 is about this machine's key, not the signed-in
 * member, so it never reaches the page as a 401 that would sign them out.
 */
export class PeerRefusal extends Error {
  readonly status:     number
  readonly peerStatus: number | null
  constructor (message: string, status: number, peerStatus: number | null) {
    super(message)
    this.name       = 'PeerRefusal'
    this.status     = status
    this.peerStatus = peerStatus
  }
}

const statusFor = (peer: number) => peer === 401 || peer === 403 ? 502 : peer >= 400 && peer < 500 ? 409 : 502

function sentenceOf (answer: unknown, fallback: string): string {
  const a = answer as { message?: unknown, error?: { message?: unknown } } | null
  const m = a?.message ?? a?.error?.message
  return typeof m === 'string' && m.trim() ? m.trim() : fallback
}

export async function peerCall<T = unknown> (call: PeerCall, fetcher: typeof fetch = fetch): Promise<T> {
  // The bytes signed are the bytes sent: the verifier hashes the raw body.
  const body    = JSON.stringify(call.body ?? {})
  const signed  = await signRequest({
    privateKey: call.privateKey, method: 'POST', path: call.path, serviceMethod: call.serviceMethod, body,
    timestamp: Math.floor(Date.now() / 1000), nonce: crypto.randomUUID(),
  }) as Record<string, string>
  const headers = {
    ...signed,
    [PEER_KEY_HEADER]:  call.keyId,
    'X-Service-Method': call.serviceMethod,
    'Content-Type':     'application/json',
    Accept:             'application/json',
  }

  const target = new URL(call.path, call.url).toString()
  let res: Response
  try { res = await fetcher(target, { method: 'POST', headers, body }) }
  catch (e) { throw new PeerRefusal(`${call.url} did not answer: ${(e as Error).message}`, 502, null) }

  let answer: unknown = null
  try { answer = await res.json() } catch { /* a non-JSON answer is refused below by its status */ }
  if (!res.ok) throw new PeerRefusal(sentenceOf(answer, `${call.url} answered ${res.status}`), statusFor(res.status), res.status)
  return unwrapResult(answer) as T
}
