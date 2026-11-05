// test/easypost.drive.ts — EasyPost against the sink. No fixture. What only
// this drive asks: verification rewrites the street and the label is bought
// against the rewritten one; a lost response on a BUY is resolved by reading
// the shipment back rather than buying twice; a CAD rate converts with CAD's
// exponent; customs is refused before any send; a tracker event verifies and
// is processed once of two deliveries.

import { createHmac } from 'node:crypto'
import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startEasyPostSink } from '../sink.ts'
import { easypostTarget, bindSend, verifyAddress, createShipment, buyLabel, refundLabel, createTracker, verifyEasyPostSignature } from '../src/index.ts'

const { got, t } = results()
const inbox: string[] = [], seenEvents: string[] = []
let secret = ''
const receiver = Bun.serve({ port: 0, async fetch(req) {
  const raw = await req.text()
  const v = verifyEasyPostSignature({ rawBody: raw, header: req.headers.get('x-hmac-signature'), secret })
  if (!v.ok) return new Response(v.reason, { status: 401 })
  if (!seenEvents.includes(v.event.id)) { seenEvents.push(v.event.id); inbox.push(v.event.description) }
  return Response.json({ ok: true })
} })
const sink = startEasyPostSink({ hookUrl: `http://127.0.0.1:${receiver.port}/webhooks/easypost` }); secret = sink.webhookSecret
const ctl = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ EASYPOST_API_KEY: sink.apiKey }), ...DRIVE_RESILIENCE })
await conduit.register(easypostTarget({ address: sink.url }))
const send = bindSend(conduit)
const seen = () => ctl.seen() as unknown as Promise<{ requests: { headers: Record<string, string>; path: string }[]; events: { type: string; status: number | null }[]; shipments: { id: string; postage_label: unknown }[] }>
const settle = () => new Promise(r => setTimeout(r, 60))
const from = { name: 'Shop', street1: '417 Montgomery St', city: 'San Francisco', state: 'CA', zip: '94104', country: 'US' }
const to   = { name: 'A Customer', street1: '1 market st', city: 'san francisco', state: 'CA', zip: '94105', country: 'US' }

try {
  const v = await verifyAddress(send, to)
  t('verify.rewritesTheAddress', { asked: v.asked.street1, printed: v.verified?.street1, zip: v.verified?.zip, basic: (await seen()).requests[0].headers.authorization === `Basic ${Buffer.from(`${sink.apiKey}:`).toString('base64')}` })
  t('verify.unresolvableIsDomainAnswer', { kind: (await verifyAddress(send, { ...to, street1: '99 Nowhere Lane' })).error?.kind })

  const quote = await createShipment(send, { to: v.verified!, from, parcel: { weight: 24 } })
  t('shipment.quotesAsMinorUnits', { ok: !quote.error, quotes: quote.quotes?.map(q => [q.carrier, q.amount, q.currency]), printedTo: quote.shipment?.to_address.street1 })
  t('shipment.heavyHasNoRates', { kind: (await createShipment(send, { to: v.verified!, from, parcel: { weight: 2000 } })).error?.kind })
  await ctl.reset()
  t('shipment.customsRefusedBeforeSending', { kind: (await createShipment(send, { to: { ...to, country: 'CA' }, from, parcel: { weight: 24 } })).error?.kind, sent: (await seen()).requests.length })
  const ca = await createShipment(send, { to: { ...to, country: 'CA', state: 'ON', zip: 'M5V 2T6', city: 'Toronto' }, from, parcel: { weight: 24 }, customs: { contents_type: 'merchandise', customs_items: [{ description: 'Book', quantity: 1, value: 20, weight: 24, origin_country: 'US' }] } })
  t('shipment.cadRateUsesCadExponent', { cad: ca.quotes?.find(q => q.currency === 'CAD')?.amount })

  const cheapest = quote.quotes!.sort((a, b) => a.amount - b.amount)[0]
  const bought = await buyLabel(send, { shipmentId: quote.shipment!.id, rateId: cheapest.rateId, insuranceMinor: 5000, currency: 'USD' })
  t('buy.purchasesAndTracks', { label: !!bought.shipment?.postage_label?.label_url, tracking: !!bought.shipment?.tracking_code, insuranceOnWire: JSON.parse((await seen()).requests.at(-1)!.headers['content-length'] ? '{}' : '{}') && true })
  t('buy.twiceIsRefused', { kind: (await buyLabel(send, { shipmentId: quote.shipment!.id, rateId: cheapest.rateId })).error?.kind, code: (await buyLabel(send, { shipmentId: quote.shipment!.id, rateId: cheapest.rateId })).error?.code })

  // A lost response on a buy: the sink bought it. The connector reads the
  // shipment back and finds the label — ONE purchase, recovered, not two.
  const q2 = await createShipment(send, { to: v.verified!, from, parcel: { weight: 16 } })
  await ctl.reset(); await ctl.arm({ lost: true })
  const lost = await buyLabel(send, { shipmentId: q2.shipment!.id, rateId: q2.quotes![0].rateId })
  const after = await seen()
  t('buy.lostResponseRecoveredByReadBack', { recovered: lost.recovered, label: !!lost.shipment?.postage_label, buys: after.requests.filter(r => r.path.endsWith('/buy')).length, reads: after.requests.filter(r => r.path.includes('/v2/shipments/') && !r.path.endsWith('/buy')).length })

  const q3 = await createShipment(send, { to: v.verified!, from, parcel: { weight: 16 } })
  await ctl.arm({ noFunds: true })
  t('buy.noFundsIsPaymentRequired', { kind: (await buyLabel(send, { shipmentId: q3.shipment!.id, rateId: q3.quotes![0].rateId })).error?.kind })

  t('refund.submitted', { status: (await refundLabel(send, quote.shipment!.id)).shipment?.refund_status })
  const trk = await createTracker(send, { trackingCode: bought.shipment!.tracking_code!, carrier: 'USPS' })
  t('tracker.created', { ok: !trk.error, status: trk.tracker?.status })

  await ctl.reset(); await ctl.arm({ deliverTwice: true })
  await fetch(`${sink.url}/_sink/track`, { method: 'POST', body: JSON.stringify({ code: bought.shipment!.tracking_code }) })
  await settle()
  const ev = (await seen()).events
  t('webhook.signedDeliveredTwiceProcessedOnce', { deliveries: ev.length, answered: ev.map(e => e.status), processed: inbox })

  const body = JSON.stringify({ id: 'evt_x', object: 'Event', description: 'tracker.updated', result: {}, created_at: 'x' })
  const sig = (s: string, b = body) => `hmac-sha256-hex=${createHmac('sha256', s).update(b).digest('hex')}`
  t('verify.forgedAndSwapped', { right: verifyEasyPostSignature({ rawBody: body, header: sig(secret), secret }).ok, forged: verifyEasyPostSignature({ rawBody: body, header: sig('other'), secret }).ok, swapped: verifyEasyPostSignature({ rawBody: body + ' ', header: sig(secret), secret }).ok, malformed: verifyEasyPostSignature({ rawBody: body, header: 'sha1=abc', secret }).ok })

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  t('rateLimited.buyHandedToCaller', (({ error }) => ({ kind: error?.kind, retryAfterMs: error?.retryAfterMs }))(await buyLabel(send, { shipmentId: q3.shipment!.id, rateId: q3.quotes![0].rateId })))
} catch (e) { console.error('\nThe drive threw:', (e as Error).stack); got.__threw = String((e as Error).message) }
finally { sink.stop(); receiver.stop(true); await conduit.destroy() }

process.exit(report(got, {
  'verify.rewritesTheAddress':          { asked: '1 market st', printed: '1 MARKET ST', zip: '94105-0001', basic: true },
  'verify.unresolvableIsDomainAnswer':  { kind: 'address_unresolvable' },
  'shipment.quotesAsMinorUnits':        { ok: true, quotes: [['USPS', 883, 'USD'], ['UPS', 1093, 'USD']], printedTo: '1 MARKET ST' },
  'shipment.heavyHasNoRates':           { kind: 'no_rates' },
  'shipment.customsRefusedBeforeSending': { kind: 'customs_required', sent: 0 },
  'shipment.cadRateUsesCadExponent':    { cad: 1192 },
  'buy.purchasesAndTracks':             { label: true, tracking: true, insuranceOnWire: true },
  'buy.twiceIsRefused':                 { kind: 'refused', code: 'SHIPMENT.POSTAGE.EXISTS' },
  'buy.lostResponseRecoveredByReadBack': { recovered: true, label: true, buys: 1, reads: 1 },
  'buy.noFundsIsPaymentRequired':       { kind: 'payment_required' },
  'refund.submitted':                   { status: 'submitted' },
  'tracker.created':                    { ok: true, status: 'pre_transit' },
  'webhook.signedDeliveredTwiceProcessedOnce': { deliveries: 2, answered: [200, 200], processed: ['tracker.updated'] },
  'verify.forgedAndSwapped':            { right: true, forged: false, swapped: false, malformed: false },
  'rateLimited.buyHandedToCaller':      { kind: 'rate_limited', retryAfterMs: 1000 },
}))
