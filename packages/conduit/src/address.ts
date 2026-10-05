// src/address.ts — what an observer is shown of a request: a per-send address
// for a target declared `address_from: 'request'` (`FJS-1667`) as its origin
// only, and credential-named fields redacted.

import { redactSecrets } from '@frontierjs/toolbelt/redact'
import type { ConduitRequest } from './types.ts'

/** Where a request-addressed send goes, as observers and the breaker see it. */
export function originOf(address: string): string {
  try { return new URL(address).origin } catch { return '(not a URL)' }
}

/**
 * The request as observers receive it. A per-send address is the origin only,
 * since its path is often the credential (a Slack webhook URL is). Body,
 * headers and query go through the logger's name walk, because an observer's
 * usual job is to write them to a log. That is a floor: a secret under `note`
 * survives it. The caller's own request is never touched.
 */
export function observedRequest(req: ConduitRequest): ConduitRequest {
  const seen: ConduitRequest = { ...req }
  if (req.address !== undefined) seen.address = originOf(req.address)
  if (req.body    !== undefined) seen.body    = redactSecrets(req.body)
  if (req.headers !== undefined) seen.headers = redactSecrets(req.headers) as ConduitRequest['headers']
  if (req.query   !== undefined) seen.query   = redactSecrets(req.query) as ConduitRequest['query']
  return seen
}
