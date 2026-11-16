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
  id:       string
  object:   'event'
  type:     string
  created:  number                // unix seconds
  data:     { object: T }
  /** The connected account the event happened on. Present only on a Connect endpoint's deliveries. */
  account?: string
}

/**
 * What `checkout.session.completed` carries. `client_reference_id` is the one
 * field a Checkout link can carry from the app that made it, so it is how a
 * payment finds its signup; `customer` is null for a guest checkout.
 */
export interface StripeCheckoutSession {
  id:                   string
  object:               'checkout.session'
  mode:                 'payment' | 'subscription' | 'setup'
  status:               'open' | 'complete' | 'expired'
  payment_status:       'paid' | 'unpaid' | 'no_payment_required'
  amount_total:         number | null   // minor units
  currency:             string | null
  customer:             string | null
  customer_email?:      string | null
  client_reference_id:  string | null
  subscription?:        string | null
  payment_intent?:      string | null
  /** Unix seconds; the page takes no payment after it and `checkout.session.expired` follows. */
  expires_at?:          number
  /** The hosted page; null once the session is complete or expired. */
  url?:                 string | null
  metadata?:            Record<string, string>
}

/** What `invoice.paid` carries — every renewal of a subscription is one. */
export interface StripeInvoice {
  id:             string
  object:         'invoice'
  status:         string          // draft | open | paid | uncollectible | void
  amount_paid:    number          // minor units
  currency:       string
  customer:       string
  subscription?:  string | null
  billing_reason?: string         // subscription_create | subscription_cycle | manual | …
  metadata?:      Record<string, string>
}

/** What `charge.succeeded`, `charge.updated` and `charge.refunded` carry. `amount_refunded` is the running total, not this refund. */
export interface StripeCharge {
  id:              string
  object:          'charge'
  amount:          number          // minor units
  amount_refunded: number
  currency:        string
  payment_intent:  string | null
  refunded:        boolean         // true once the whole amount is back
  /**
   * An id unless the request expanded it; null until Stripe attaches it, which
   * is often after `charge.succeeded`, announced by `charge.updated`.
   */
  balance_transaction?: string | StripeBalanceTransaction | null
  metadata?:       Record<string, string>
}

/**
 * Money moving through an account's balance. On a charge, `fee` is what Stripe
 * kept and `net` is `amount - fee`, all in minor units; `fee` is the only
 * place Stripe states its fee on a charge.
 */
export interface StripeBalanceTransaction {
  id:            string
  object:        'balance_transaction'
  amount:        number
  fee:           number
  net:           number
  currency:      string
  status:        'available' | 'pending'
  type:          string            // charge | payment | refund | payout | …
  /** The charge, refund or payout that moved the money. */
  source:        string | null
  available_on:  number            // unix seconds
  created:       number
  fee_details:   { amount: number; currency: string; type: string; description: string | null }[]
}

/** A v1 connected account, as far as onboarding needs it. */
export interface StripeAccount {
  id:                string
  object:            'account'
  country:           string
  email:             string | null
  business_type:     string | null
  charges_enabled:   boolean
  payouts_enabled:   boolean
  details_submitted: boolean
  controller?: {
    losses?:                 { payments: 'stripe' | 'application' }
    fees?:                   { payer: 'account' | 'application' | 'application_custom' | 'application_express' }
    requirement_collection?: 'stripe' | 'application'
    stripe_dashboard?:       { type: 'full' | 'express' | 'none' }
  }
  requirements?: {
    currently_due:   string[]
    eventually_due:  string[]
    past_due:        string[]
    disabled_reason: string | null
  }
  metadata?: Record<string, string>
}

/** A single-use URL into Stripe's hosted onboarding; it expires in minutes. */
export interface StripeAccountLink {
  object:     'account_link'
  url:        string
  created:    number
  expires_at: number
}

/**
 * Whether a connected account can take money yet, read off a `StripeAccount`.
 * `currentlyDue` empty and `chargesEnabled` true is a club that can sell.
 */
export interface StripeAccountStatus {
  id:               string
  chargesEnabled:   boolean
  payoutsEnabled:   boolean
  detailsSubmitted: boolean
  /** Due now; charges or payouts stop at `pastDue`. Send the owner back through an account link while either is non-empty. */
  currentlyDue:     string[]
  pastDue:          string[]
  eventuallyDue:    string[]
  disabledReason:   string | null
}

/** The objects this connector types, by the event that carries them. Any other type is `StripeEvent<unknown>`. */
export interface StripeEventObjects {
  'account.updated':            StripeAccount
  'checkout.session.completed': StripeCheckoutSession
  'invoice.paid':               StripeInvoice
  'payment_intent.succeeded':   PaymentIntent
  'charge.succeeded':           StripeCharge
  'charge.updated':             StripeCharge
  'charge.refunded':            StripeCharge
}

/** Stripe's error body. `type` is the category, `code` the machine-readable reason. */
export interface StripeErrorBody {
  error?: { type?: string; code?: string; decline_code?: string; message?: string }
}
