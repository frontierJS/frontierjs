// Stripe Tax over the Stripe target: a module of conduit-stripe, exported as `tax`.
// It adds the three tax calls and their rules; the target, the form encoding
// and the key are stripe's.
//
// ─── The rule ────────────────────────────────────────────────────────────
// A calculation is RECORDED at the moment of sale and a transaction is created
// FROM IT at capture. Nothing recomputes, because a filing is made against what
// was charged (`verify:money`'s copy-at-sale rule). A calculation expires 90
// minutes after it is made; past that the answer is `expired` and the caller
// recalculates -- never silently.
//
// `create_from_calculation` and `create_reversal` are irreversible spend in
// the filing sense, so both REQUIRE an idempotency key, as a refund does.

import type { ConduitError } from '@frontierjs/conduit'
import { translate as stripeTranslate, type StripeFailure } from './errors.ts'
import type { Send } from './index.ts'

export interface TaxLineItemInput { amountMinor: number; reference: string; taxCode?: string; quantity?: number; taxBehavior?: 'inclusive' | 'exclusive' }
export interface TaxAddress { line1?: string; city?: string; state?: string; postal_code?: string; country: string }
export interface TaxCustomerDetails { address: TaxAddress; address_source: 'billing' | 'shipping'; tax_ids?: { type: string; value: string }[]; taxability_override?: 'none' | 'customer_exempt' | 'reverse_charge' }

export interface TaxCalculation {
  id: string; object: 'tax.calculation'; amount_total: number; tax_amount_exclusive: number; tax_amount_inclusive: number; currency: string
  expires_at: number
  line_items?: { data: { id: string; amount: number; amount_tax: number; reference: string; tax_code: string; tax_breakdown?: { taxability_reason: string; amount: number }[] }[] }
  tax_breakdown: { amount: number; taxability_reason: string; tax_rate_details: { percentage_decimal: string; tax_type: string; country: string; state?: string } }[]
}
export interface TaxTransaction { id: string; object: 'tax.transaction'; type: 'transaction' | 'reversal'; reference: string; currency: string; created: number; reversal?: { original_transaction: string } }

export type TaxFailureKind = 'address_unresolvable' | 'expired' | 'tax_id_invalid' | StripeFailure['kind']
export interface TaxFailure extends Omit<StripeFailure, 'kind'> { kind: TaxFailureKind }

/** Stripe's translate first, then the three codes that are Tax's own. */
export function translate(error: ConduitError): TaxFailure {
  const f = stripeTranslate(error) as TaxFailure
  if (f.code === 'customer_tax_location_invalid') return { ...f, kind: 'address_unresolvable', retryable: false }
  if (f.code === 'tax_id_invalid')                 return { ...f, kind: 'tax_id_invalid', retryable: false }
  if (f.code === 'resource_missing' && /calculation/i.test(f.message)) return { ...f, kind: 'expired', retryable: false }
  return f
}

const assertMinor = (n: number, what: string) => { if (!Number.isInteger(n)) throw new TypeError(`tax: ${what} must be an integer in minor units, got ${n}`) }

/** Replayable and unkeyed: a calculation moves nothing and costs nothing to repeat. */
export async function createCalculation(send: Send, req: { currency: string; lineItems: TaxLineItemInput[]; customer: TaxCustomerDetails; shippingCostMinor?: number }): Promise<{ calculation?: TaxCalculation; error?: TaxFailure }> {
  if (!req.lineItems.length) throw new TypeError('tax: a calculation needs at least one line item')
  for (const l of req.lineItems) assertMinor(l.amountMinor, `line ${l.reference}`)
  if (req.shippingCostMinor !== undefined) assertMinor(req.shippingCostMinor, 'shippingCostMinor')
  const r = await send<TaxCalculation>({
    method: 'POST', path: '/v1/tax/calculations', replayable: true,
    body: {
      currency: req.currency.toLowerCase(),
      line_items: req.lineItems.map(l => ({ amount: l.amountMinor, reference: l.reference, quantity: l.quantity ?? 1, ...(l.taxCode ? { tax_code: l.taxCode } : {}), tax_behavior: l.taxBehavior ?? 'exclusive' })),
      customer_details: req.customer,
      ...(req.shippingCostMinor !== undefined ? { shipping_cost: { amount: req.shippingCostMinor } } : {}),
      expand: ['line_items'],
    },
  })
  if (r.error) return { error: translate(r.error) }
  return { calculation: r.data }
}

/** Has this calculation expired, by the clock the caller holds? */
export const isExpired = (c: TaxCalculation, nowSeconds: number) => nowSeconds >= c.expires_at

export async function createTransaction(send: Send, req: { calculationId: string; reference: string; key: string }): Promise<{ transaction?: TaxTransaction; error?: TaxFailure }> {
  if (!req.key) throw new TypeError('tax: creating a transaction needs an idempotency key')
  const r = await send<TaxTransaction>({ method: 'POST', path: '/v1/tax/transactions/create_from_calculation', body: { calculation: req.calculationId, reference: req.reference }, idempotency_key: req.key })
  if (r.error) return { error: translate(r.error) }
  return { transaction: r.data }
}

export async function createReversal(send: Send, req: { originalTransactionId: string; reference: string; mode?: 'full' | 'partial'; key: string }): Promise<{ transaction?: TaxTransaction; error?: TaxFailure }> {
  if (!req.key) throw new TypeError('tax: a reversal needs an idempotency key')
  const r = await send<TaxTransaction>({ method: 'POST', path: '/v1/tax/transactions/create_reversal', body: { original_transaction: req.originalTransactionId, reference: req.reference, mode: req.mode ?? 'full' }, idempotency_key: req.key })
  if (r.error) return { error: translate(r.error) }
  return { transaction: r.data }
}
