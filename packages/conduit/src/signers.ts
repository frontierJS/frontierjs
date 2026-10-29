// ============================================================
// Conduit — the signers every conduit has installed
//
// A scheme that is a standard rather than one vendor's dialect. Each connector
// that needed HTTP Basic wrote its own, and the copies disagreed: one sent a
// key-only credential with no colon, which RFC 7617 does not parse, and one
// shipped the scheme inside the resolver's answer (`FJS-2233`). The seam stays
// `signed` (`FJS-D891`); only the function moved here.
// ============================================================

import { signRequest } from '@frontierjs/toolbelt/signature'
import type { Signer } from './types.ts'

// RFC 7617: `user-id ":" password`, UTF-8, base64. A credential with no colon
// is a key-only login (an API key as the user, password empty), which still
// needs the colon on the wire. The halves are NOT form-encoded first — that is
// OAuth's client authentication (RFC 6749 §2.3.1), a different scheme with its
// own signer, and encoding here breaks a password holding `%`.
export const basic: Signer = ({ secret }) => {
  const pair = secret.includes(':') ? secret : `${secret}:`
  return { headers: { authorization: `Basic ${Buffer.from(pair, 'utf8').toString('base64')}` } }
}

// FrontierJS's own scheme under a key pair: the ref resolves to a
// `generateSigningKeys` private key, and the receiver holds only the public
// half, so nothing it stores can sign as this side (`FJS-D1604`). The canonical
// string is `hmac`'s, from the same kit, so one `verifyRequest` reads both.
// `params.header_prefix` is `hmac`'s `header_prefix`.
export const ed25519: Signer = async ({ secret, method, path, query, body, params }) => ({
  headers: await signRequest({
    privateKey: secret,
    method, path, query,
    body:       body ?? '',
    prefix:     params.header_prefix ?? 'X-Fjs',
    timestamp:  Math.floor(Date.now() / 1000),
    nonce:      crypto.randomUUID(),
  }),
})

export const BUILT_IN_SIGNERS: Readonly<Record<string, Signer>> = Object.freeze({ basic, ed25519 })
