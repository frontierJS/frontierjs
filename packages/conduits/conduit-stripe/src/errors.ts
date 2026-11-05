// src/errors.ts — conduit's error → the shop's.
//
// Conduit classifies by STATUS, which is right for a transport and wrong for a
// payment: a card decline is a 402 that arrives as `client_error`, which says
// nothing about whose fault it is or whether to try again. Stripe puts the real
// answer in the body and conduit keeps that body on `error.raw`, so this is a
// translation and not a guess. One owner: nothing else reads `raw`.

import type { ConduitError } from '@frontierjs/conduit'
import type { StripeErrorBody } from './types.ts'

export type StripeFailureKind =
  | 'declined'               // card_error: the customer's problem, never retried
  | 'refused'                // invalid_request_error: our request was wrong
  | 'idempotency_conflict'   // the key was reused with a different payload
  | ConduitError['kind']     // anything the transport already named

export interface StripeFailure {
  kind:      StripeFailureKind
  message:   string
  retryable: boolean
  /** Stripe's own machine-readable code, where it gave one — `card_declined`. */
  code?:     string
  /** Stripe's category — `card_error`, `invalid_request_error`, `api_error`. */
  type?:     string
  /** How long the vendor asked us to wait, where it said. */
  retryAfterMs?: number
}

export function parseBody(raw: unknown): StripeErrorBody | null {
  try { return typeof raw === 'string' ? JSON.parse(raw) : (raw as StripeErrorBody) } catch { return null }
}

export function translate(error: ConduitError): StripeFailure {
  const base: StripeFailure = {
    kind:      error.kind,
    message:   error.message,
    retryable: error.retryable,
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
  }
  const e = parseBody(error.raw)?.error
  if (!e) return base

  const kind: StripeFailureKind =
    e.type === 'card_error'                 ? 'declined'
    : e.type === 'idempotency_error'        ? 'idempotency_conflict'
    : e.type === 'invalid_request_error'    ? 'refused'
    : base.kind

  return {
    ...base,
    kind,
    message:   e.message ?? base.message,
    // Stripe's own advice: only api_error and a rate limit are worth a second try.
    retryable: e.type === 'api_error' || e.type === 'rate_limit_error' ? true : kind === base.kind ? base.retryable : false,
    ...(e.code         ? { code: e.code } : {}),
    ...(e.decline_code ? { code: e.decline_code } : {}),
    ...(e.type         ? { type: e.type } : {}),
  }
}
