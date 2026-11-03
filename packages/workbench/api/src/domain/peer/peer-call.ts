// src/domain/peer/peer-call.ts -- another FrontierJS app dialed as this
// machine's peer key (`FJS-D1188`, `FJS-D1604`): one conduit target signed with
// conduit's `ed25519`, and the answer unwrapped or turned into a thrown refusal.
//
// The one place Workbench reads a peer's result envelope (Invariant 4). The
// target carries `X-Fjs-Key`, since the signature names no key; each call names
// its `X-Service-Method`, which the door's verifier reads into the signature.

import { createConduit } from '@frontierjs/conduit'
import { unwrapResult } from '@frontierjs/junction/envelope'

/** The header that names the caller's key; the signature carries no key id. */
export const PEER_KEY_HEADER = 'X-Fjs-Key'

const TARGET = 'provider:peer'
const REF    = 'PEER_PRIVATE_KEY'

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

function sentenceOf (raw: unknown, fallback: string): string {
  let a: { message?: unknown, error?: { message?: unknown } } | null = null
  try { a = typeof raw === 'string' ? JSON.parse(raw) : raw as typeof a } catch { /* a non-JSON answer keeps the fallback */ }
  const m = a?.message ?? a?.error?.message
  return typeof m === 'string' && m.trim() ? m.trim() : fallback
}

export interface Peer {
  call: <T = unknown>(path: string, serviceMethod: string, body: unknown) => Promise<T>
}

/** `url` is the peer's API origin, `http://127.0.0.1:8120`. */
export function createPeer (opts: { url: string, keyId: string, privateKey: () => Promise<string> }): Peer {
  const conduit = createConduit({ credentials: { get: () => opts.privateKey() } })
  const ready   = conduit.register({
    id:            TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       opts.url,
    auth:          { type: 'signed', ref: REF, signer: 'ed25519' },
    headers:       { [PEER_KEY_HEADER]: opts.keyId },
    registered_at: Date.now(),
    last_seen_at:  null,
  })

  async function call<T> (path: string, serviceMethod: string, body: unknown): Promise<T> {
    await ready
    const r = await conduit.send({ target: TARGET, method: 'POST', path, headers: { 'X-Service-Method': serviceMethod }, body: body ?? {} })
    if (!r.error) return unwrapResult(r.data) as T
    const peerStatus = r.meta.status ?? null
    if (peerStatus === null) throw new PeerRefusal(`${opts.url} did not answer: ${r.error.message}`, 502, null)
    throw new PeerRefusal(sentenceOf(r.error.raw, `${opts.url} answered ${peerStatus}`), statusFor(peerStatus), peerStatus)
  }

  return { call }
}
