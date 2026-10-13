// ============================================================
// Conduit — the signers every conduit has installed
//
// A scheme that is a standard rather than one vendor's dialect. Each connector
// that needed HTTP Basic wrote its own, and the copies disagreed: one sent a
// key-only credential with no colon, which RFC 7617 does not parse, and one
// shipped the scheme inside the resolver's answer (`FJS-2233`). The seam stays
// `signed` (`FJS-D891`); only the function moved here.
// ============================================================

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

export const BUILT_IN_SIGNERS: Readonly<Record<string, Signer>> = Object.freeze({ basic })
