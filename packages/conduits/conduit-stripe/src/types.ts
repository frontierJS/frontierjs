// src/types.ts — Stripe's shapes, for the calls this connector makes.

export interface PaymentIntent {
  id:             string
  object:         'payment_intent'
  amount:         number          // minor units
  currency:       string
  status:         string          // requires_payment_method | succeeded | …
  client_secret?: string
  metadata?:      Record<string, string>
}

export interface StripeRefund {
  id:             string
  object:         'refund'
  amount:         number
  currency:       string
  payment_intent: string
  status:         string
}

export interface StripeEvent<T = unknown> {
  id:      string
  object:  'event'
  type:    string
  created: number                 // unix seconds
  data:    { object: T }
}

/** Stripe's error body. `type` is the category, `code` the machine-readable reason. */
export interface StripeErrorBody {
  error?: { type?: string; code?: string; decline_code?: string; message?: string }
}
