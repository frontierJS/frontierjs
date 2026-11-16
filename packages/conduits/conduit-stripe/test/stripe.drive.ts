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
import { startStripeSink, parseForm } from '../sink.ts'
import { stripeTarget, bindSend, createPaymentIntent, createRefund, verifyStripeSignature, stripeDialect, stripeObject, tax,
  createConnectedAccount, createAccountLink, retrieveAccountStatus, accountStatus, createCheckoutSession, retrieveBalanceTransaction, type StripeAccountStatus, type StripeCharge } from '../src/index.ts'

const { got, t } = results()
const KEY = 'sk_test_dev', HOOK_SECRET = 'whsec_dev', CONNECT_SECRET = 'whsec_connect_dev'

// ── the receiving end: the dialect through conduit's own order (FJS-D899) ─
// The route stands in for the plugin's: it hands the delivery to `accept()`,
// so the sink's redelivery is deduped by a receipt and not by this file.
const received: string[] = []
const receiver = Bun.serve({
  port: 0,
  async fetch(req) {
    const raw = await req.text(), url = new URL(req.url)
    const r = await conduit.accept(url.pathname, { method: req.method, path: url.pathname, query: url.search, route: {}, headers: Object.fromEntries(req.headers), rawBody: raw, body: JSON.parse(raw) }, Math.floor(Date.now() / 1000))
    return Response.json(r.body, { status: r.status })
  },
})

const sink = startStripeSink({ key: KEY, webhookSecret: HOOK_SECRET, hookUrl: `http://127.0.0.1:${receiver.port}/webhooks/stripe`, taxExpiresInSeconds: 1,
  connectWebhookSecret: CONNECT_SECRET, connectHookUrl: `http://127.0.0.1:${receiver.port}/webhooks/stripe-connect` })
const ctl  = control(sink.url)
const conduit = createConduit({ credentials: createStaticResolver({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: HOOK_SECRET, STRIPE_CONNECT_WEBHOOK_SECRET: CONNECT_SECRET }), ...DRIVE_RESILIENCE })
await conduit.register(stripeTarget({ address: sink.url }))
conduit.receive({
  provider: 'stripe', path: '/webhooks/stripe', dialect: stripeDialect, credential: 'STRIPE_WEBHOOK_SECRET',
  apply(ev) { received.push(`${ev.type}:${ev.id}`); return 'applied' },
})
// The Connect endpoint: a second endpoint at Stripe with its own secret, so a second Receiver under its own provider.
const connectReceived: string[] = []
let lastStatus: StripeAccountStatus | null = null, completedFor = ''
const chargesSucceeded: StripeCharge[] = []
conduit.receive({
  provider: 'stripe-connect', path: '/webhooks/stripe-connect', dialect: stripeDialect, credential: 'STRIPE_CONNECT_WEBHOOK_SECRET',
  apply(ev) {
    connectReceived.push(`${ev.account}:${ev.type}`)
    const a = stripeObject(ev, 'account.updated'); if (a) lastStatus = accountStatus(a)
    const cs = stripeObject(ev, 'checkout.session.completed'); if (cs) completedFor = `${ev.account}:${cs.client_reference_id}`
    const ch = stripeObject(ev, 'charge.succeeded'); if (ch) chargesSucceeded.push(ch)
    return 'applied'
  },
})
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
  let nanThrew = false
  try { verifyStripeSignature({ rawBody: body, header: `t=${now - 9999},v1=${sig(now - 9999)}`, secret: HOOK_SECRET, now, toleranceSeconds: Number(undefined) }) } catch { nanThrew = true }
  t('verify.unsetToleranceThrows', nanThrew)

  // A forged delivery at the dialect's route is one 401 and applies nothing; a body that is not an event is ignored.
  const at = (header: string, raw = body) => conduit.accept('/webhooks/stripe', { method: 'POST', path: '/webhooks/stripe', query: '', route: {}, headers: { 'stripe-signature': header }, rawBody: raw, body: JSON.parse(raw) }, now)
  const before = received.length
  const forged = await at(`t=${now},v1=${sig(now, 'whsec_wrong')}`)
  const notEvent = JSON.stringify({ object: 'balance' })
  const ignored = await at(`t=${now},v1=${createHmac('sha256', HOOK_SECRET).update(`${now}.${notEvent}`).digest('hex')}`, notEvent)
  t('dialect.refusesAndIgnores', { forged: forged.status, ignored: ignored.result, applied: received.length - before })

  const paid = { type: 'invoice.paid', payload: { id: 'evt_i', object: 'event' as const, type: 'invoice.paid', created: 1, data: { object: { id: 'in_1', object: 'invoice', status: 'paid', amount_paid: 900, currency: 'usd', customer: 'cus_1' } } } }
  t('dialect.objectNarrowsByType', { invoice: stripeObject(paid, 'invoice.paid')?.amount_paid, other: stripeObject(paid, 'checkout.session.completed') })

  // ── Connect (FJS-D2200): the club's own account, direct charges, no platform fee ─
  await ctl.reset()
  type Seen = { requests: { method: string; path: string; headers: Record<string, string>; body: string }[]; intents: Record<string, any>[] }
  const seenNow = () => ctl.seen() as unknown as Promise<Seen>
  const asked = { country: 'us', email: 'treasurer@club.test', businessType: 'company' as const, metadata: { club: 'C1' }, key: 'club:C1:account' }
  const acct = await createConnectedAccount(send, asked)
  const again = await createConnectedAccount(send, asked)
  const acctReq = (await seenNow()).requests.find(r => r.path === '/v1/accounts')!
  const wire = parseForm(acctReq.body) as Record<string, any>
  let noKey = ''
  try { await createConnectedAccount(send, { country: 'US', key: '' }) } catch (e) { noKey = (e as Error).message }
  t('connect.account.standardLike', { ok: !acct.error, sameAccountOnRetry: acct.account?.id === again.account?.id, losses: wire.controller?.losses?.payments, fees: wire.controller?.fees?.payer,
    requirements: wire.controller?.requirement_collection, dashboard: wire.controller?.stripe_dashboard?.type, noType: !('type' in wire), country: wire.country, key: acctReq.headers['idempotency-key'], unkeyedThrows: /idempotency key/.test(noKey) })

  const club = acct.account!.id
  const link = await createAccountLink(send, { account: club, refreshUrl: 'https://club.test/onboard/refresh', returnUrl: 'https://club.test/onboard/done' })
  const linkReq = (await seenNow()).requests.find(r => r.path === '/v1/account_links')!
  t('connect.link.hostedOnboarding', { url: !!link.link?.url.startsWith('https://connect.stripe.com/'), type: parseForm(linkReq.body).type, onPlatform: !('stripe-account' in linkReq.headers) })

  const unboarded = await retrieveAccountStatus(send, club)
  await fetch(`${sink.url}/_sink/onboard/${club}`, { method: 'POST' })
  const after = await retrieveAccountStatus(send, club)
  t('connect.status.beforeAndAfterOnboarding', { before: { charges: unboarded.status?.chargesEnabled, due: unboarded.status!.currentlyDue.length > 0 },
    after: { charges: after.status?.chargesEnabled, payouts: after.status?.payoutsEnabled, details: after.status?.detailsSubmitted, due: after.status?.currentlyDue }, fromEvent: (lastStatus as StripeAccountStatus | null)?.chargesEnabled })

  const pi = await createPaymentIntent(send, { amountMinor: 2000, currency: 'usd', reference: 'TIX-1', account: club })
  await fetch(`${sink.url}/v1/payment_intents/${pi.intent!.id}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'stripe-account': club } })
  const elsewhere = await createRefund(send, { paymentIntentId: pi.intent!.id, amountMinor: 500, key: 'TIX-1:r0' })
  const refunded  = await createRefund(send, { paymentIntentId: pi.intent!.id, amountMinor: 500, account: club, key: 'TIX-1:r1' })
  const piReq = (await seenNow()).requests.find(r => r.path === '/v1/payment_intents')!
  t('connect.directCharge.onTheClubsAccount', { header: piReq.headers['stripe-account'] === club, refundElsewhereNotFound: elsewhere.error?.kind, refunded: refunded.refund?.amount,
    events: connectReceived.filter(r => r.startsWith(club + ':')).map(r => r.split(':')[1]) })

  let badAcct = ''
  try { await createPaymentIntent(send, { amountMinor: 100, currency: 'usd', reference: 'x', account: '' }) } catch (e) { badAcct = (e as Error).message }
  t('connect.emptyAccountRefusedBeforeSending', /acct_/.test(badAcct))

  const cs = await createCheckoutSession(send, { account: club, currency: 'USD', lineItems: [{ name: 'Spring dinner', amountMinor: 3500, quantity: 2 }], successUrl: 'https://club.test/paid',
    cancelUrl: 'https://club.test/cart', clientReferenceId: 'signup_9', metadata: { event: 'E1' }, paymentMethodTypes: ['card', 'us_bank_account'], expiresAt: new Date(Date.now() + 45 * 60_000) })
  const csSeen = (await seenNow()).requests.find(r => r.path === '/v1/checkout/sessions')!
  const csWire = parseForm(csSeen.body) as Record<string, any>
  const paidCs = await fetch(`${sink.url}/_sink/checkout/${cs.session!.id}/complete`, { method: 'POST' }).then(r => r.json() as Promise<Record<string, any>>)
  t('connect.checkout.hostedOnTheClubsAccount', { header: csSeen.headers['stripe-account'] === club, url: !!cs.session?.url?.startsWith('https://checkout.stripe.com/'), total: cs.session?.amount_total,
    ach: Object.values(csWire.payment_method_types ?? {}), piMetadata: csWire.payment_intent_data?.metadata?.event, completedFor: completedFor === `${club}:signup_9`,
    expiresIn45: Math.abs(Number(csWire.expires_at) - (Date.now() / 1000 + 45 * 60)) < 60 && cs.session?.expires_at === Number(csWire.expires_at),
    tooSoonRefused: await createCheckoutSession(send, { currency: 'usd', lineItems: [{ name: 'x', amountMinor: 100 }], successUrl: 'https://x.test', expiresAt: new Date(Date.now() + 60_000) }).then(() => false, e => e instanceof TypeError) })

  // A paid session names the intent that took the money, and that intent refunds on the club's account.
  const csIntent = (await seenNow()).intents.find((i: Record<string, any>) => i.id === paidCs.payment_intent)
  const csRefund = await createRefund(send, { paymentIntentId: String(paidCs.payment_intent), amountMinor: 2000, account: club, key: 'signup_9:r1' })
  t('connect.checkout.paidSessionRefunds', { intent: [csIntent?.status, csIntent?.amount, csIntent?.account === club, csIntent?.metadata?.event], refunded: csRefund.refund?.amount ?? csRefund.error?.kind })

  // A bank debit completes unpaid and settles or fails days later, each its own event.
  const sinkPost = (path: string) => fetch(`${sink.url}${path}`, { method: 'POST' }).then(async r => ({ status: r.status, body: await r.json() as Record<string, any> }))
  const achSession = async (ref: string) => (await createCheckoutSession(send, { account: club, currency: 'usd', lineItems: [{ name: 'Dues', amountMinor: 5000 }], successUrl: 'https://club.test/paid', clientReferenceId: ref, paymentMethodTypes: ['us_bank_account'] })).session!.id
  const achEvents = () => connectReceived.filter(r => r.startsWith(club + ':checkout.session.')).map(r => r.split(':checkout.session.')[1])
  const settling = await achSession('dues_1'), failing = await achSession('dues_2')
  const eventsBefore = achEvents().length
  const pending = await sinkPost(`/_sink/checkout/${settling}/complete`)
  const settledEarly = await sinkPost(`/_sink/checkout/${failing}/settle`)
  await sinkPost(`/_sink/checkout/${failing}/complete`)
  const settled = await sinkPost(`/_sink/checkout/${settling}/settle`)
  const failed  = await sinkPost(`/_sink/checkout/${failing}/fail`)
  const twice   = await sinkPost(`/_sink/checkout/${settling}/settle`)
  t('connect.checkout.achSettlesOrFailsLater', { pending: [pending.body.status, pending.body.payment_status], settled: settled.body.payment_status, failed: failed.body.payment_status,
    notYetComplete: settledEarly.status, settledTwice: twice.status, events: achEvents().slice(eventsBefore) })

  // The type refuses a platform fee at compile time; a cast gets past the type, so the runtime refuses it too.
  // @ts-expect-error -- no platform-fee key on a charge's input (FJS-D2200)
  const _noFeeOnIntent: Parameters<typeof createPaymentIntent>[1] = { amountMinor: 1, currency: 'usd', reference: 'x', application_fee_amount: 1 }
  // @ts-expect-error -- nor on a checkout session's
  const _noFeeOnSession: Parameters<typeof createCheckoutSession>[1] = { currency: 'usd', lineItems: [], successUrl: 'x', transfer_data: { destination: 'acct_x' } }
  void _noFeeOnIntent; void _noFeeOnSession
  let feeRefusals = 0
  for (const attempt of [
    () => createPaymentIntent(send, { amountMinor: 100, currency: 'usd', reference: 'x', account: club, application_fee_amount: 10 } as never),
    () => createCheckoutSession(send, { account: club, currency: 'usd', lineItems: [{ name: 'x', amountMinor: 100 }], successUrl: 'https://x.test', transfer_data: { destination: 'acct_x' } } as never),
    () => createCheckoutSession(send, { account: club, currency: 'usd', lineItems: [{ name: 'x', amountMinor: 100 }], successUrl: 'https://x.test', application_fee_percent: 5 } as never),
  ]) { try { await attempt() } catch (e) { if (/FJS-D2200/.test((e as Error).message)) feeRefusals++ } }
  const onClub = (await seenNow()).requests.filter(r => r.headers['stripe-account'])
  t('connect.noPlatformFee', { refusedBeforeSending: feeRefusals, bodiesOnTheClub: onClub.length, carryingAFeeKey: onClub.filter(r => /application_fee|transfer_data/.test(decodeURIComponent(r.body))).length })

  // Stripe's fee is on the charge's balance transaction, which lives on the account the charge was made on.
  const feePi = await createPaymentIntent(send, { amountMinor: 2000, currency: 'usd', reference: 'TIX-2', account: club })
  await fetch(`${sink.url}/v1/payment_intents/${feePi.intent!.id}/confirm`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'stripe-account': club } })
  const feeCharge = chargesSucceeded.find(c => c.payment_intent === feePi.intent?.id)
  const txnOf = (c?: StripeCharge) => String(c?.balance_transaction ?? '')
  const bt = await retrieveBalanceTransaction(send, { id: txnOf(feeCharge), account: club })
  const btElsewhere = await retrieveBalanceTransaction(send, { id: txnOf(feeCharge) })
  const achBt = await retrieveBalanceTransaction(send, { id: txnOf(chargesSucceeded.find(c => c.payment_intent === settled.body.payment_intent)), account: club })
  let badTxnThrows = false
  try { await retrieveBalanceTransaction(send, { id: '../accounts/' + club, account: club }) } catch (e) { badTxnThrows = e instanceof TypeError }
  t('connect.balance.feeOnTheCharge', { fee: bt.balanceTransaction?.fee, net: bt.balanceTransaction?.net, amount: bt.balanceTransaction?.amount, ofThisCharge: !!feeCharge && bt.balanceTransaction?.source === feeCharge.id,
    elsewhere: btElsewhere.error?.kind, achFee: achBt.balanceTransaction?.fee, badIdThrows: badTxnThrows })

  const cBody = JSON.stringify({ id: 'evt_c', object: 'event', type: 'account.updated', created: 1, account: 'acct_club1', data: { object: {} } })
  const cHeader = `t=${now},v1=${createHmac('sha256', CONNECT_SECRET).update(`${now}.${cBody}`).digest('hex')}`
  const withConnect  = verifyStripeSignature({ rawBody: cBody, header: cHeader, secret: CONNECT_SECRET, now })
  const withPlatform = verifyStripeSignature({ rawBody: cBody, header: cHeader, secret: HOOK_SECRET, now })
  const platformEvent = v(`t=${now},v1=${sig(now)}`)
  const crossed = await conduit.accept('/webhooks/stripe', { method: 'POST', path: '/webhooks/stripe', query: '', route: {}, headers: { 'stripe-signature': cHeader }, rawBody: cBody, body: JSON.parse(cBody) }, now)
  t('connect.webhook.connectSecretAndAccount', { ok: withConnect.ok, account: withConnect.ok ? withConnect.account : 'unverified', platformSecretRefuses: withPlatform.ok,
    platformEventAccount: platformEvent.ok ? platformEvent.account : 'unverified', crossedEndpoints: crossed.status })

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
  'verify.unsetToleranceThrows': true,
  'dialect.refusesAndIgnores':   { forged: 401, ignored: 'ignored', applied: 0 },
  'dialect.objectNarrowsByType': { invoice: 900, other: null },
  'connect.account.standardLike':            { ok: true, sameAccountOnRetry: true, losses: 'stripe', fees: 'account', requirements: 'stripe', dashboard: 'full', noType: true, country: 'US', key: 'club:C1:account', unkeyedThrows: true },
  'connect.link.hostedOnboarding':           { url: true, type: 'account_onboarding', onPlatform: true },
  'connect.status.beforeAndAfterOnboarding': { before: { charges: false, due: true }, after: { charges: true, payouts: true, details: true, due: [] }, fromEvent: true },
  'connect.directCharge.onTheClubsAccount':  { header: true, refundElsewhereNotFound: 'refused', refunded: 500, events: ['account.updated', 'payment_intent.succeeded', 'charge.succeeded', 'charge.refunded'] },
  'connect.emptyAccountRefusedBeforeSending': true,
  'connect.checkout.hostedOnTheClubsAccount': { header: true, url: true, total: 7000, ach: ['card', 'us_bank_account'], piMetadata: 'E1', completedFor: true, expiresIn45: true, tooSoonRefused: true },
  'connect.checkout.paidSessionRefunds':     { intent: ['succeeded', 7000, true, 'E1'], refunded: 2000 },
  'connect.checkout.achSettlesOrFailsLater': { pending: ['complete', 'unpaid'], settled: 'paid', failed: 'unpaid', notYetComplete: 409, settledTwice: 409,
    events: ['completed', 'completed', 'async_payment_succeeded', 'async_payment_failed'] },
  'connect.noPlatformFee':                  { refusedBeforeSending: 3, bodiesOnTheClub: 7, carryingAFeeKey: 0 },
  'connect.balance.feeOnTheCharge':         { fee: 88, net: 1912, amount: 2000, ofThisCharge: true, elsewhere: 'refused', achFee: 40, badIdThrows: true },
  'connect.webhook.connectSecretAndAccount': { ok: true, account: 'acct_club1', platformSecretRefuses: false, platformEventAccount: null, crossedEndpoints: 401 },
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
