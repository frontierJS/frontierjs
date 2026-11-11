// ============================================================
// Conduit — another FrontierJS app dialed as this app's peer key
//
// One target signed with `ed25519` (`FJS-D1188`, `FJS-D1604`), and the answer
// unwrapped or thrown as a refusal: the one place a dialer reads a peer's result
// envelope (Invariant 4). A subpath, so a conduit with no peers never loads it.
//
// The target carries `X-Frontier-Key`, since the signature names no key. `call` names
// its `X-Service-Method`, which the door's verifier reads into the signature.
// ============================================================

import { unwrapResult } from '@frontierjs/junction/envelope'
import { createConduit } from './conduit.ts'

/** The header that names the caller's key; the signature carries no key id. */
export const PEER_KEY_HEADER = 'X-Frontier-Key'

const TARGET = 'provider:peer'
const REF    = 'PEER_PRIVATE_KEY'

/** A peer's refusal, in its own sentence. `peerStatus` is null when nothing answered. */
export class PeerRefusal extends Error {
  readonly peerStatus: number | null
  constructor (message: string, peerStatus: number | null) {
    super(message)
    this.name       = 'PeerRefusal'
    this.peerStatus = peerStatus
  }
}

function sentenceOf (raw: unknown, fallback: string): string {
  let a: { message?: unknown, error?: { message?: unknown } } | null = null
  try { a = typeof raw === 'string' ? JSON.parse(raw) : raw as typeof a } catch { /* a non-JSON answer keeps the fallback */ }
  const m = a?.message ?? a?.error?.message
  return typeof m === 'string' && m.trim() ? m.trim() : fallback
}

export interface Peer {
  /** A POST naming its service method. */
  call: <T = unknown>(path: string, serviceMethod: string, body: unknown) => Promise<T>
  /** A GET; `path` carries its query, which the signature covers. */
  read: <T = unknown>(path: string) => Promise<T>
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

  async function send<T> (req: { method: 'GET' | 'POST', path: string, headers?: Record<string, string>, body?: unknown }): Promise<T> {
    await ready
    const r = await conduit.send({ target: TARGET, ...req })
    if (!r.error) return unwrapResult(r.data) as T
    const peerStatus = r.meta.status ?? null
    if (peerStatus === null) throw new PeerRefusal(`${opts.url} did not answer: ${r.error.message}`, null)
    throw new PeerRefusal(sentenceOf(r.error.raw, `${opts.url} answered ${peerStatus}`), peerStatus)
  }

  return {
    call: (path, serviceMethod, body) => send({ method: 'POST', path, headers: { 'X-Service-Method': serviceMethod }, body: body ?? {} }),
    read: (path) => send({ method: 'GET', path }),
  }
}
