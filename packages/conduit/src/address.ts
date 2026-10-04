// src/address.ts — a send's own address, for a target declared
// `address_from: 'request'` (`FJS-1667`): how observers and the breaker see it.

import type { ConduitRequest } from './types.ts'

/** Where a request-addressed send goes, as observers and the breaker see it. */
export function originOf(address: string): string {
  try { return new URL(address).origin } catch { return '(not a URL)' }
}

/**
 * The request as observers receive it: a per-send address is the origin
 * only, since its path is often the credential (a Slack webhook URL is).
 */
export function observedRequest(req: ConduitRequest): ConduitRequest {
  return req.address === undefined ? req : { ...req, address: originOf(req.address) }
}
