// ─── the socket's credential on the handshake ────────────────────────────────
//
// A browser WebSocket cannot set Authorization, and a credential in the URL is
// one every console, proxy and access log records (`FJS-D486`). So the client
// offers two subprotocols, `fjs` and `fjs.bearer.<token>`, and the server reads
// the second and selects the first. Both halves read these names from here.
//
// Nothing here imports anything, so the browser client can.

/** The subprotocol the server selects. A browser fails the socket unless one of the offered values is echoed. */
export const WS_PROTOCOL = 'fjs'

/** The subprotocol entry that carries the credential, followed by the token itself. */
export const WS_BEARER = 'fjs.bearer.'

/**
 * A value a subprotocol may carry — RFC 7230's `token`. A credential outside
 * it would be mangled or refused by the browser before the server saw it.
 */
export const WS_TOKEN_SAFE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** The credential in a `Sec-WebSocket-Protocol` value, or null. */
export function bearerFromProtocols(header: string | undefined): string | null {
  if (!header) return null
  for (const raw of header.split(',')) {
    const p = raw.trim()
    if (p.startsWith(WS_BEARER) && p.length > WS_BEARER.length) return p.slice(WS_BEARER.length)
  }
  return null
}

/** The same value with the credential entry removed, or undefined when nothing else was offered. */
export function withoutBearer(header: string | undefined): string | undefined {
  if (!header) return header
  const rest = header.split(',').map(p => p.trim()).filter(p => p && !p.startsWith(WS_BEARER))
  return rest.length ? rest.join(', ') : undefined
}
