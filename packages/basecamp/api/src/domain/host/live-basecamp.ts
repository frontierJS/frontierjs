// api/src/domain/host/live-basecamp.ts — does a Basecamp answer at this address?
//
// host-record.ts asks before it moves Basecamp's own A record. Every install
// marks that record with the same bare fleet mark, so the mark cannot tell a
// rerun moving its own record from a second Basecamp taking the first one's
// name (FJS-4078). A live answer at the old address can.

const PROBE_PATH = '/setup/probe'

/** One request for `/setup/probe` at `origin`, under `host`. A box's Caddy picks a
 *  certificate by SNI and a route by Host, and a bare address carries neither.
 *  The certificate is not checked: the address is not the name it was issued to.
 *  `accept` matters too, since Caddy hands anything asking for a page the SPA. */
async function probe(origin: string, host: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${origin}${PROBE_PATH}`, {
      headers:  { host, accept: 'application/json' },
      redirect: 'manual',
      signal:   AbortSignal.timeout(timeoutMs),
      tls:      { serverName: host, rejectUnauthorized: false },
    } as RequestInit)
    if (res.status !== 200) return false
    const body = await res.json() as Record<string, unknown>
    return typeof body?.needs_setup === 'boolean' && typeof body?.workspaces === 'number'
  } catch {
    return false
  }
}

/**
 * Whether `ip` answers as a Basecamp for `host`. No answer is `false`, so a box
 * that is gone never holds its name hostage. A `proxied` record is asked through
 * its name as well, since an origin firewalled to Cloudflare's ranges answers
 * nothing at its own address.
 */
export async function answersAsBasecamp(
  ip: string, host: string,
  { port = 443, timeoutMs = 5000, proxied = false }: { port?: number; timeoutMs?: number; proxied?: boolean } = {},
): Promise<boolean> {
  return await probe(`https://${ip}:${port}`, host, timeoutMs)
    || (proxied && await probe(`https://${host}:${port}`, host, timeoutMs))
}
