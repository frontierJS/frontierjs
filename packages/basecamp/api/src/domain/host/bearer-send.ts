// api/src/domain/host/bearer-send.ts — an AccountSend over a plain fetch, for the scripts
// `fli basecamp:create` runs from a laptop.
//
// Not conduit: conduit's send needs a registered target, and those scripts
// boot no app to hold a registry. The vendor's envelope stays the connector's
// to read, so the body is handed back whole on a refusal.

import type { AccountSend } from '../../providers/compute/index.ts'

export function bearerSend(address: string, token: string): AccountSend {
  return async ({ method, path, body }) => {
    let res: Response
    try {
      res = await fetch(address + path, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body:    body === undefined ? undefined : JSON.stringify(body),
        signal:  AbortSignal.timeout(30_000),
      })
    } catch (e) {
      return { data: null, error: { kind: 'unreachable', message: (e as Error).message } }
    }
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (res.ok) return { data, status: res.status }
    const said = data as { message?: string; errors?: { message?: string }[] } | null
    return { data, status: res.status,
             error: { kind: res.status >= 500 ? 'server_error' : 'client_error',
                      message: said?.message ?? said?.errors?.[0]?.message } }
  }
}
