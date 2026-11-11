// src/domain/peer/peer-call.ts -- conduit's peer dialer, with its refusals given
// the status Workbench answers its own caller.

import { createPeer as dial, PeerRefusal as Refused, type Peer } from '@frontierjs/conduit/peer'

export type { Peer }

/**
 * `status` is what Workbench answers its own caller: a peer's 401/403 is about
 * this machine's key, not the signed-in member, so it never reaches the page as
 * a 401 that would sign them out.
 */
export class PeerRefusal extends Refused {
  readonly status: number
  constructor (message: string, status: number, peerStatus: number | null) {
    super(message, peerStatus)
    this.status = status
  }
}

const statusFor = (peer: number | null) => peer !== null && peer >= 400 && peer < 500 && peer !== 401 && peer !== 403 ? 409 : 502

export function createPeer (opts: Parameters<typeof dial>[0]): Peer {
  const peer = dial(opts)
  const graded = <T>(answer: Promise<T>): Promise<T> => answer.catch((e: unknown) => {
    throw e instanceof Refused ? new PeerRefusal(e.message, statusFor(e.peerStatus), e.peerStatus) : e
  })
  return {
    call: (path, serviceMethod, body) => graded(peer.call(path, serviceMethod, body)),
    read: (path) => graded(peer.read(path)),
  }
}
