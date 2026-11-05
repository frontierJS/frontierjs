// src/peer.ts -- this machine's key pair as a peer (`FJS-D1604`), and the door
// that shows its public half.
//
// The pair is minted on first use into `~/.config/workbench/peer.json`, beside
// `push.json`, since there is no row to hold it. The public half is what an
// administrator pastes into Basecamp's "Add a peer" form; the id that form
// answers is the `peerKeyId` of the Basecamp's entry in `basecamps.json`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { generateSigningKeys } from '@frontierjs/toolbelt/signature'
import type { TransportContext } from '@frontierjs/junction'

export interface PeerKeys {
  publicKey:  string
  privateKey: string
}

/** A test points this elsewhere so it never writes the developer's own file. */
export const peerFile = () => process.env.WORKBENCH_PEER_FILE || join(homedir(), '.config', 'workbench', 'peer.json')

const B64URL = /^[A-Za-z0-9_-]+$/

/**
 * The pair, minted when the file is absent. A file that is present but
 * unreadable is refused rather than minted over: a fresh pair is a key
 * Basecamp has never seen, and every preview would fail as a bad signature.
 */
export async function peerKeys (file = peerFile()): Promise<PeerKeys> {
  if (existsSync(file)) {
    let kept: Partial<PeerKeys> | null = null
    try { kept = JSON.parse(readFileSync(file, 'utf8')) } catch { /* refused below */ }
    if (typeof kept?.publicKey === 'string' && B64URL.test(kept.publicKey) && typeof kept.privateKey === 'string' && B64URL.test(kept.privateKey))
      return { publicKey: kept.publicKey, privateKey: kept.privateKey }
    throw new Error(`${file} is not a key pair -- move it aside and a new one is minted, then enroll the new public key in Basecamp again`)
  }
  const keys = await generateSigningKeys()
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 })
  return keys
}

export const PEER_PATH = '/door/peer'

/** GET /door/peer -- the public key, the Basecamp it is for, and whether it is enrolled. */
export function peerRoute (opts: { basecampUrl: string, keyId: string | null }) {
  return async (ctx: TransportContext): Promise<Response> => {
    if (!ctx.user) return ctx.json({ message: 'Not signed in.' }, 401)
    const { publicKey } = await peerKeys()
    return ctx.json({ publicKey, basecampUrl: opts.basecampUrl, keyId: opts.keyId }, 200)
  }
}
