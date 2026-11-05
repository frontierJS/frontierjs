// @frontierjs/conduit-easypost — EasyPost over conduit.
//
// EasyPost over Shippo (PLAN.md § 17b): Basic with the key as the username
// (conduit's built-in `basic` signer sends a colon-less key as `key:`), a two-step shipment → buy that keeps the quote apart from the
// irreversible spend, and a webhook that CAN be signed. One connector over
// many carriers is the same leverage as S3 over many stores.
//
// ─── Three rules ─────────────────────────────────────────────────────────
// Verification CHANGES THE ADDRESS YOU PRINT: `verifyAddress` answers both
// the address asked for and the one the carrier will deliver to, and the
// label is bought against the second. A BUY is spend with no idempotency
// header at EasyPost, so a lost response is `indeterminate` and `buy()`
// reads the shipment back before anybody retries: a `postage_label` on it
// means the money moved. Money crosses as minor units plus currency; EasyPost
// sends a rate as a decimal STRING with its own `currency`.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { minorUnits, roundMinor } from '@frontierjs/toolbelt/units'

export const EASYPOST_TARGET  = 'provider:easypost'
export const EASYPOST_ADDRESS = 'https://api.easypost.com'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target = EASYPOST_TARGET): Send {
  return req => conduit.send({ target, ...req })
}

export function easypostTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? EASYPOST_TARGET, kind: 'provider', protocol: 'http', address: opts.address ?? EASYPOST_ADDRESS,
    auth: { type: 'signed', signer: 'basic', ref: opts.ref ?? 'EASYPOST_API_KEY' }, registered_at: Date.now(), last_seen_at: null,
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────────

export interface Address { name?: string; company?: string; street1: string; street2?: string; city: string; state: string; zip: string; country: string; phone?: string; email?: string }
export interface EpAddress extends Address { id: string; object: 'Address'; verifications?: { delivery?: { success: boolean; errors: { code: string; message: string; field?: string }[] } } }
export interface Parcel { length?: number; width?: number; height?: number; weight: number }
export interface CustomsItem { description: string; quantity: number; value: number; weight: number; hs_tariff_number?: string; origin_country: string }
export interface CustomsInfo { contents_type: 'merchandise' | 'gift' | 'documents' | 'sample' | 'other'; customs_items: CustomsItem[]; customs_certify?: boolean; customs_signer?: string }
export interface Rate { id: string; carrier: string; service: string; rate: string; currency: string; delivery_days: number | null }
/** A rate as the app keeps it: minor units plus currency. */
export interface Quote { rateId: string; carrier: string; service: string; amount: number; currency: string; deliveryDays: number | null }
export interface Shipment { id: string; object: 'Shipment'; status: string; to_address: EpAddress; from_address: EpAddress; rates: Rate[]; selected_rate: Rate | null; postage_label: { id: string; label_url: string } | null; tracking_code: string | null; tracker?: { id: string } | null; refund_status: string | null }
export interface Tracker { id: string; object: 'Tracker'; tracking_code: string; carrier: string; status: string; est_delivery_date: string | null; tracking_details: { status: string; message: string; datetime: string }[] }
export interface EpErrorBody { error?: { code: string; message: string; errors?: { field: string; message: string }[] } }
export interface EpEvent { id: string; object: 'Event'; description: string; result: Tracker | Shipment | Record<string, unknown>; created_at: string }

// ─── Errors ──────────────────────────────────────────────────────────────

export type EasyPostFailureKind = 'address_unresolvable' | 'no_rates' | 'payment_required' | 'customs_required' | 'refused' | EasyPostIndeterminate | ConduitError['kind']
type EasyPostIndeterminate = 'indeterminate'
export interface EasyPostFailure { kind: EasyPostFailureKind; code?: string; message: string; retryable: boolean; retryAfterMs?: number; details?: { field: string; message: string }[] }

export function translate(error: ConduitError, status?: number): EasyPostFailure {
  let body: EpErrorBody | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as EpErrorBody) } catch { /* not JSON */ }
  const e = body?.error
  const base: EasyPostFailure = { kind: error.kind, message: e?.message ?? error.message, retryable: error.retryable,
    ...(e?.code ? { code: e.code } : {}), ...(e?.errors?.length ? { details: e.errors } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (status === 402 || e?.code === 'PAYMENT_REQUIRED' || e?.code?.startsWith('BALANCE'))   return { ...base, kind: 'payment_required', retryable: false }
  if (error.kind !== 'client_error') return base
  if (e?.code?.startsWith('ADDRESS.VERIFY'))  return { ...base, kind: 'address_unresolvable', retryable: false }
  if (e?.code === 'SHIPMENT.RATE.ERROR' || e?.code === 'SHIPMENT.NO_RATES') return { ...base, kind: 'no_rates', retryable: false }
  if (e?.code?.startsWith('CUSTOMS'))         return { ...base, kind: 'customs_required', retryable: false }
  return { ...base, kind: 'refused', retryable: false }
}
const fail = (r: { error: ConduitError; meta: { status?: number } }) => translate(r.error, r.meta.status)

/** `"7.33"` + `"USD"` → 733. An unparseable rate is null and the quote is dropped. */
export function toQuote(r: Rate): Quote | null {
  const n = Number(r.rate)
  if (!Number.isFinite(n) || !r.currency) return null
  return { rateId: r.id, carrier: r.carrier, service: r.service, amount: roundMinor(n * 10 ** minorUnits(r.currency)), currency: r.currency, deliveryDays: r.delivery_days }
}

// ─── Calls ───────────────────────────────────────────────────────────────

/** Replayable: creating an address record moves nothing. Answers what was
 *  ASKED and what the carrier will DELIVER to, which may differ. */
export async function verifyAddress(send: Send, asked: Address): Promise<{ asked: Address; verified?: EpAddress; error?: EasyPostFailure }> {
  const r = await send<EpAddress>({ method: 'POST', path: '/v2/addresses', body: { address: asked, verify: ['delivery'] }, replayable: true })
  if (r.error) return { asked, error: fail(r) }
  const v = r.data.verifications?.delivery
  if (v && !v.success) return { asked, error: { kind: 'address_unresolvable', code: 'ADDRESS.VERIFY.FAILURE', message: v.errors.map(e => e.message).join('; '), retryable: false, details: v.errors.map(e => ({ field: e.field ?? '', message: e.message })) } }
  return { asked, verified: r.data }
}

/** Replayable: a shipment is a quote until it is bought. Customs is refused
 *  HERE when the parcel crosses a border and none was given. */
export async function createShipment(send: Send, req: { to: EpAddress | Address; from: EpAddress | Address; parcel: Parcel; customs?: CustomsInfo; reference?: string }): Promise<{ shipment?: Shipment; quotes?: Quote[]; error?: EasyPostFailure }> {
  if (req.to.country !== req.from.country && !req.customs) return { error: { kind: 'customs_required', message: `a parcel from ${req.from.country} to ${req.to.country} needs customs_info`, retryable: false } }
  const r = await send<Shipment>({ method: 'POST', path: '/v2/shipments', replayable: true, body: { shipment: {
    // The VERIFIED address object is sent whole, so the label is printed against the carrier's spelling.
    to_address: req.to, from_address: req.from, parcel: req.parcel,
    ...(req.customs ? { customs_info: req.customs } : {}), ...(req.reference ? { reference: req.reference } : {}) } } })
  if (r.error) return { error: fail(r) }
  const quotes = r.data.rates.map(toQuote).filter((q): q is Quote => q !== null)
  if (!quotes.length) return { shipment: r.data, quotes, error: { kind: 'no_rates', message: 'no carrier returned a rate for this parcel', retryable: false } }
  return { shipment: r.data, quotes }
}

export const getShipment = async (send: Send, id: string): Promise<{ shipment?: Shipment; error?: EasyPostFailure }> => {
  const r = await send<Shipment>({ method: 'GET', path: `/v2/shipments/${encodeURIComponent(id)}` })
  return r.error ? { error: fail(r) } : { shipment: r.data }
}

/**
 * Buy the label: irreversible spend, no idempotency header at EasyPost. On a
 * lost response the shipment is READ BACK — a `postage_label` on it means the
 * purchase went through and that label is answered; none means nothing was
 * spent and the error is handed back. Never retried blind.
 */
export async function buyLabel(send: Send, req: { shipmentId: string; rateId: string; insuranceMinor?: number; currency?: string }): Promise<{ shipment?: Shipment; recovered?: true; error?: EasyPostFailure }> {
  const body: Record<string, unknown> = { rate: { id: req.rateId } }
  if (req.insuranceMinor !== undefined) {
    if (!Number.isInteger(req.insuranceMinor) || !req.currency) throw new TypeError('easypost: insurance is an integer in minor units with a currency')
    body.insurance = (req.insuranceMinor / 10 ** minorUnits(req.currency)).toFixed(minorUnits(req.currency))
  }
  const r = await send<Shipment>({ method: 'POST', path: `/v2/shipments/${encodeURIComponent(req.shipmentId)}/buy`, body })
  if (!r.error) return { shipment: r.data }
  const f = fail(r)
  if (r.error.indeterminate) {
    const back = await getShipment(send, req.shipmentId)
    if (back.shipment?.postage_label) return { shipment: back.shipment, recovered: true }
    return { error: { ...f, kind: back.shipment ? f.kind : 'indeterminate', retryable: Boolean(back.shipment) } }
  }
  return { error: f }
}

/** A refund request; the carrier answers later on the shipment's `refund_status`. Keyed by the shipment: idempotent at EasyPost. */
export async function refundLabel(send: Send, shipmentId: string): Promise<{ shipment?: Shipment; error?: EasyPostFailure }> {
  const r = await send<Shipment>({ method: 'POST', path: `/v2/shipments/${encodeURIComponent(shipmentId)}/refund`, replayable: true })
  return r.error ? { error: fail(r) } : { shipment: r.data }
}

export async function createTracker(send: Send, req: { trackingCode: string; carrier?: string }): Promise<{ tracker?: Tracker; error?: EasyPostFailure }> {
  const r = await send<Tracker>({ method: 'POST', path: '/v2/trackers', body: { tracker: { tracking_code: req.trackingCode, ...(req.carrier ? { carrier: req.carrier } : {}) } }, replayable: true })
  return r.error ? { error: fail(r) } : { tracker: r.data }
}

// ─── Inbound ─────────────────────────────────────────────────────────────

export type Verified = { ok: true; event: EpEvent } | { ok: false; reason: string }

/** `X-Hmac-Signature: hmac-sha256-hex=<hex>` over the raw body with the
 *  webhook secret. No timestamp in the scheme: replay is the app's event-id dedupe. */
export function verifyEasyPostSignature(opts: { rawBody: string; header: string | null | undefined; secret: string | undefined }): Verified {
  if (!opts.secret) return { ok: false, reason: 'no webhook secret is configured on this side' }
  if (!opts.header) return { ok: false, reason: 'no X-Hmac-Signature header' }
  const m = opts.header.match(/^hmac-sha256-hex=([0-9a-f]{64})$/)
  if (!m) return { ok: false, reason: 'signature header is malformed' }
  const want = Buffer.from(createHmac('sha256', opts.secret).update(opts.rawBody).digest('hex')), have = Buffer.from(m[1])
  if (have.length !== want.length || !timingSafeEqual(have, want)) return { ok: false, reason: 'signature does not match' }
  try {
    const event = JSON.parse(opts.rawBody) as EpEvent
    if (event?.object !== 'Event' || typeof event.id !== 'string') return { ok: false, reason: 'body is not an EasyPost event' }
    return { ok: true, event }
  } catch { return { ok: false, reason: 'body is not JSON' } }
}
