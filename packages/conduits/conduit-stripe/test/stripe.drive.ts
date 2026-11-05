// test/stripe.drive.ts — the connector through a real conduit against the sink.
//
// Run: `bun run drive`. Starts and stops its own sink and its own webhook
// receiver on ephemeral ports. No fixture: no conforming Stripe exists to run.
//
// The negative control is the feature: the same connector against a target
// with `encoding` removed must be REFUSED by the sink naming the content-type,
// or every assertion about the form body is about something else.

import { createHmac } from 'node:crypto'
import { createConduit, createStaticResolver } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startStripeSink } from '../sink.ts'
import { stripeTarget, bindSend, createPaymentIntent, createRefund, verifyStripeSignature, tax } from '../src/index.ts'

const { got, t } = results()
const KEY = 'sk_test_dev', HOOK_SECRET = 'whsec_dev'

// ── the receiving end: a raw route running the pure verifier ─────────────
const received: string[] = []
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text()
    const v = verifyStripeSignature({ rawBody: raw, header: req.headers.get('stripe-signature'), secret: HOOK_SECRET, now: Math.floor(Date.now() / 1000) })
    if (!v.ok) return Response.json({ error: 'invalid signature' }, { status: 401 })
    // Redelivery is ordinary; the id is the dedupe and the answer is 200 either way.
    if (!received.some(r => r.endsWith(':' + v.event.id))) received.push(`${v.event.type}:${v.event.id}`)
    return Response.json({ received: true, id: v.event.id, type: v.event.type })
  },
})

const sink = startStripeSink({ key: KEY, webhookSecret: HOOK_SECRET, hookUrl: `http://127.0.0.1:${receiver.port}/webhooks/stripe`, taxExpiresInSeconds: 1 })
const ctl  = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ STRIPE_SECRET_KEY: KEY }), ...DRIVE_RESILIENCE })
await conduit.register(stripeTarget({ address: sink.url }))
const send = bindSend(conduit)

try {
  // ── outbound: the shape on the wire ────────────────────────────────────
  const made = await createPaymentIntent(send, { amountMinor: 1250, currency: 'USD', reference: 'ORD-1' })
  const first = (await ctl.seen<never>() as unknown as { requests: { headers: Record<string, string>; body: string }[] }).requests[0]
  t('create.succeeds', { ok: !made.error, amount: made.intent?.amount, currency: made.intent?.currency, metadata: made.intent?.metadata?.order_reference,
    versionOnWire: first.headers['stripe-version'], bodyIsForm: first.body.includes('automatic_payment_methods%5Benabled%5D=true') })

  // ── negative control ───────────────────────────────────────────────────
  const bare = createConduit({ credentials: createStaticResolver({ STRIPE_SECRET_KEY: KEY }) })
  const { encoding: _e, ...jsonTarget } = stripeTarget({ address: sink.url })
  await bare.register(jsonTarget)
  const wrong = await createPaymentIntent(bindSend(bare), { amountMinor: 100, currency: 'usd', reference: 'NEG' })
  t('withoutFormEncoding.isRefused', { failed: !!wrong.error, kind: wrong.error?.kind, namesTheCause: (wrong.error?.message ?? '').includes('x-www-form-urlencoded') })

  // ── domain answers ─────────────────────────────────────────────────────
  const declined = await createPaymentIntent(send, { amountMinor: 4242, currency: 'usd', reference: 'ORD-2' })
  t('decline.isDomainAnswer', { kind: declined.error?.kind, code: declined.error?.code, retryable: declined.error?.retryable })

  await ctl.arm({ failNext: true })
  const flaky = await createPaymentIntent(send, { amountMinor: 500, currency: 'usd', reference: 'ORD-3' })
  // `replayable: true` lets conduit retry the 500 itself, so the caller sees success.
  t('apiError.isRetriedByConduit', { ok: !flaky.error, attempts: (await seenCount()) })

  let threw = ''
  try { await createPaymentIntent(send, { amountMinor: 12.4, currency: 'usd', reference: 'x' }) } catch (e) { threw = (e as Error).message }
  t('majorUnits.refusedBeforeSending', { threw: /minor units/.test(threw) })

  // ── chaos: a 429 with Retry-After is honored, not backed off blindly ───
  await ctl.reset()
  await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const t0 = Date.now()
  const limited = await createPaymentIntent(send, { amountMinor: 700, currency: 'usd', reference: 'ORD-4' })
  t('rateLimited.waitsRetryAfter', { ok: !limited.error, waitedAtLeast: Date.now() - t0 >= 1000, attempts: await seenCount() })

  // ── chaos: a lost response on an UNKEYED write is indeterminate ────────
  await ctl.reset()
  await ctl.arm({ lost: true })
  const lost = await createRefund(send, { paymentIntentId: made.intent!.id, amountMinor: 100, key: 'ORD-1:lost' }).catch(e => ({ error: { kind: String(e) } }))
  // Keyed, so conduit DID replay and the sink answered the remembered response.
  t('lostResponse.keyedRefundIsReplayed', { ok: !('error' in lost && lost.error), attempts: await seenCount() })
  await ctl.arm({ lost: true })
  const lostIntent = await createPaymentIntent(send, { amountMinor: 900, currency: 'usd', reference: 'ORD-5' })
  // Unkeyed but `replayable`: an intent moves no money, so conduit replays it too.
  t('lostResponse.replayableIntentIsReplayed', { ok: !lostIntent.error })

  // ── idempotency: the key is on the wire under Stripe's name ────────────
  await ctl.reset()
  const r1 = await createRefund(send, { paymentIntentId: made.intent!.id, amountMinor: 250, key: 'ORD-1:r1' })
  const r2 = await createRefund(send, { paymentIntentId: made.intent!.id, amountMinor: 250, key: 'ORD-1:r1' })
  const r3 = await createRefund(send, { paymentIntentId: made.intent!.id, amountMinor: 251, key: 'ORD-1:r1' })
  t('refund.keyCollapsesAndConflicts', { sameId: r1.refund?.id === r2.refund?.id, conflict: r3.error?.kind, headerName: (await ctl.seen() as unknown as { requests: { headers: Record<string, string> }[] }).requests[0].headers['idempotency-key'] })
  const over = await createRefund(send, { paymentIntentId: made.intent!.id, amountMinor: 99999, key: 'ORD-1:r2' })
  t('refund.overdrawnIsRefused', { kind: over.error?.kind, saysHowMuch: (over.error?.message ?? '').includes('greater than unrefunded') })

  // ── inbound: real signed events over a real socket, delivered twice ────
  await ctl.arm({ deliverTwice: true })
  await fetch(`${sink.url}/v1/payment_intents/${made.intent!.id}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` } })
  const { events } = await ctl.seen() as unknown as { events: { type: string; status: number | null }[] }
  const succeeded = events.filter(e => e.type === 'payment_intent.succeeded')
  t('webhook.duplicateDeliveryAcceptedOnce', { deliveries: succeeded.length, answered: succeeded.map(e => e.status), processed: received.filter(r => r.startsWith('payment_intent.succeeded:')).length })

  // ── the refusals, against the pure function with the clock moved ───────
  const body = JSON.stringify({ id: 'evt_x', object: 'event', type: 'payment_intent.succeeded', created: 1, data: { object: {} } })
  const now  = 1_700_000_000
  const sig  = (ts: number, secret = HOOK_SECRET) => createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
  const v = (header: string | null, at = now) => verifyStripeSignature({ rawBody: body, header, secret: HOOK_SECRET, now: at })
  t('verify.forged',      v(`t=${now},v1=${sig(now, 'whsec_wrong')}`).ok)
  t('verify.swappedBody', verifyStripeSignature({ rawBody: body + ' ', header: `t=${now},v1=${sig(now)}`, secret: HOOK_SECRET, now }).ok)
  t('verify.movedClock',  { past: v(`t=${now - 400},v1=${sig(now - 400)}`).ok, future: v(`t=${now + 400},v1=${sig(now + 400)}`).ok, edge: v(`t=${now - 300},v1=${sig(now - 300)}`).ok })
  t('verify.unsigned',    v(null).ok)
  t('verify.rotation',    v(`t=${now},v1=${sig(now, 'whsec_old')},v1=${sig(now)}`).ok)

  // ── Stripe Tax: the same listener, the same key ────────────────────────
  const lines = [{ amountMinor: 10_000, reference: 'L1', taxCode: 'txcd_10000000' }, { amountMinor: 2_500, reference: 'L2', quantity: 2 }]
  const us = { address: { line1: '1 Market St', city: 'San Francisco', state: 'CA', postal_code: '94105', country: 'US' }, address_source: 'shipping' as const }
  const taxSeen = () => ctl.seen() as unknown as Promise<{ requests: unknown[]; transactions: unknown[] }>
  const calc = await tax.createCalculation(send, { currency: 'USD', lineItems: lines, customer: us, shippingCostMinor: 500 })
  const c = calc.calculation!
  t('tax.calculation.statesTheTaxAndRecordsIt', { ok: !calc.error, total: c.amount_total, tax: c.tax_amount_exclusive, rate: c.tax_breakdown[0].tax_rate_details.percentage_decimal, lines: c.line_items?.data.map(l => l.amount_tax), expiresSoon: tax.isExpired(c, c.expires_at), notYet: tax.isExpired(c, c.expires_at - 1) })

  await ctl.reset()
  const tx1 = await tax.createTransaction(send, { calculationId: c.id, reference: 'ORD-1', key: 'ORD-1:tax' })
  const tx2 = await tax.createTransaction(send, { calculationId: c.id, reference: 'ORD-1', key: 'ORD-1:tax' })
  const tx3 = await tax.createTransaction(send, { calculationId: c.id, reference: 'ORD-1-other', key: 'ORD-1:tax' })
  t('tax.transaction.keyCollapsesAndConflicts', { sameId: tx1.transaction?.id === tx2.transaction?.id, conflict: tx3.error?.kind, filed: (await taxSeen()).transactions.length })

  await ctl.reset(); await ctl.arm({ lost: true })
  const taxLost = await tax.createTransaction(send, { calculationId: c.id, reference: 'ORD-1b', key: 'ORD-1b:tax' })
  t('tax.transaction.lostResponseReplayedUnderKey', { ok: !taxLost.error, attempts: (await taxSeen()).requests.length, filed: (await taxSeen()).transactions.length })

  await new Promise(r => setTimeout(r, 1100))
  const late = await tax.createTransaction(send, { calculationId: c.id, reference: 'ORD-2', key: 'ORD-2:tax' })
  t('tax.transaction.expiredCalculationIsExpired', { kind: late.error?.kind, code: late.error?.code, expiredByClock: tax.isExpired(c, Math.floor(Date.now() / 1000) + 1) })

  const rev = await tax.createReversal(send, { originalTransactionId: tx1.transaction!.id, reference: 'ORD-1:refund', key: 'ORD-1:rev' })
  t('tax.reversal.pointsAtOriginal', { type: rev.transaction?.type, original: rev.transaction?.reversal?.original_transaction === tx1.transaction?.id })

  const de = await tax.createCalculation(send, { currency: 'EUR', lineItems: lines, customer: { address: { country: 'DE' }, address_source: 'billing' } })
  const b2b = await tax.createCalculation(send, { currency: 'EUR', lineItems: lines, customer: { address: { country: 'DE' }, address_source: 'billing', tax_ids: [{ type: 'eu_vat', value: 'DE123456789' }] } })
  t('tax.vat.b2cChargedB2bReverseCharge', { b2c: de.calculation?.tax_amount_exclusive, b2b: b2b.calculation?.tax_amount_exclusive, reason: b2b.calculation?.tax_breakdown[0].taxability_reason })
  t('tax.vat.badIdIsDomainAnswer', { kind: (await tax.createCalculation(send, { currency: 'EUR', lineItems: lines, customer: { address: { country: 'DE' }, address_source: 'billing', tax_ids: [{ type: 'eu_vat', value: 'nope' }] } })).error?.kind })
  t('tax.address.unresolvableIsDomainAnswer', { kind: (await tax.createCalculation(send, { currency: 'USD', lineItems: lines, customer: { address: { country: 'US', state: 'CA' }, address_source: 'shipping' } })).error?.kind })

  let taxThrew = ''
  try { await tax.createCalculation(send, { currency: 'USD', lineItems: [{ amountMinor: 12.5, reference: 'x' }], customer: us }) } catch (e) { taxThrew = (e as Error).message }
  t('tax.majorUnits.refusedBeforeSending', /minor units/.test(taxThrew))

  await ctl.reset(); await ctl.arm({ rateLimit: { retryAfter: 1 } })
  const taxT0 = Date.now(); const rl = await tax.createCalculation(send, { currency: 'USD', lineItems: lines, customer: us })
  t('tax.rateLimited.calculationReplayedAfterWait', { ok: !rl.error, waited: Date.now() - taxT0 >= 1000, attempts: (await taxSeen()).requests.length })
} catch (e) {
  console.error('\nThe drive taxThrew:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); receiver.stop(true); await conduit.destroy()
}

async function seenCount() { return (await ctl.seen() as unknown as { requests: unknown[] }).requests.length }

process.exit(report(got, {
  'create.succeeds':                      { ok: true, amount: 1250, currency: 'usd', metadata: 'ORD-1', versionOnWire: '2024-06-20', bodyIsForm: true },
  'withoutFormEncoding.isRefused':        { failed: true, kind: 'refused', namesTheCause: true },
  'decline.isDomainAnswer':               { kind: 'declined', code: 'generic_decline', retryable: false },
  'apiError.isRetriedByConduit':          { ok: true, attempts: 5 },
  'majorUnits.refusedBeforeSending':      { threw: true },
  'rateLimited.waitsRetryAfter':          { ok: true, waitedAtLeast: true, attempts: 2 },
  'lostResponse.keyedRefundIsReplayed':   { ok: true, attempts: 2 },
  'lostResponse.replayableIntentIsReplayed': { ok: true },
  'refund.keyCollapsesAndConflicts':      { sameId: true, conflict: 'idempotency_conflict', headerName: 'ORD-1:r1' },
  'refund.overdrawnIsRefused':            { kind: 'refused', saysHowMuch: true },
  'webhook.duplicateDeliveryAcceptedOnce': { deliveries: 2, answered: [200, 200], processed: 1 },
  'verify.forged':      false,
  'verify.swappedBody': false,
  'verify.movedClock':  { past: false, future: false, edge: true },
  'verify.unsigned':    false,
  'verify.rotation':    true,
  'tax.calculation.statesTheTaxAndRecordsIt':      { ok: true, total: 16_588, tax: 1_088, rate: '7.25', lines: [725, 363], expiresSoon: true, notYet: false },
  'tax.transaction.keyCollapsesAndConflicts':      { sameId: true, conflict: 'idempotency_conflict', filed: 1 },
  'tax.transaction.lostResponseReplayedUnderKey':  { ok: true, attempts: 2, filed: 2 },
  'tax.transaction.expiredCalculationIsExpired':   { kind: 'expired', code: 'resource_missing', expiredByClock: true },
  'tax.reversal.pointsAtOriginal':                 { type: 'reversal', original: true },
  'tax.vat.b2cChargedB2bReverseCharge':            { b2c: 2_850, b2b: 0, reason: 'reverse_charge' },
  'tax.vat.badIdIsDomainAnswer':                   { kind: 'tax_id_invalid' },
  'tax.address.unresolvableIsDomainAnswer':        { kind: 'address_unresolvable' },
  'tax.majorUnits.refusedBeforeSending':           true,
  'tax.rateLimited.calculationReplayedAfterWait':  { ok: true, waited: true, attempts: 2 },
}))
