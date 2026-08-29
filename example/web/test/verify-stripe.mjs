/**
 * verify:stripe — a REAL vendor's connection, both directions.
 *
 * Run: `bun run verify:stripe`. It starts and stops everything itself, on the
 * TEST port row (7110 api, 7114 stripe), so it does not need — or disturb — a
 * dev server. **bun, not node**: it imports the app and the connector, because
 * a conduit target is a server-side thing and there is no HTTP endpoint that
 * would exercise `createPaymentIntent` from outside.
 *
 * What is actually being asked here is not "does Stripe work" — the sink is a
 * stand-in and can be made to answer anything. It is whether the CONDUIT
 * BOUNDARY is generic: `psp.ts` speaks this project's own conventions and was
 * designed alongside conduit, so it could agree with conduit by accident.
 * Stripe disagrees with it in every way a connector can — form-encoded bodies
 * against JSON, a bearer key against an HMAC, and a webhook signature scheme of
 * its own — and each of those is an assertion below (`FJS-D153`).
 *
 * ─── Traps ────────────────────────────────────────────────────────────────
 *
 * The sink REFUSES a wrong content-type rather than parsing whatever arrives,
 * and that refusal is the point: conduit could only ever send JSON until
 * `FJS-556`, and a sink that shrugged would have passed against the bug. The
 * negative control below removes `encoding: 'form'` from the target and asserts
 * the refusal, because an assertion that cannot fail proves nothing.
 *
 * The sink's form parser is written by hand rather than importing conduit's
 * encoder in reverse — a decoder built from the encoder agrees with it by
 * construction, and the question is whether an independent reader gets the
 * structure back.
 */

import { createHmac } from 'node:crypto'

const API_PORT    = 7110
const SINK_PORT   = 7114
const API         = `http://localhost:${API_PORT}`
const SINK        = `http://localhost:${SINK_PORT}`
const WEBHOOK     = `${API}/api/webhooks/stripe`
const SECRET_KEY  = 'sk_test_dev'
const HOOK_SECRET = 'whsec_dev'

// Set before importing the app: app.ts reads API_PORT at module scope, and the
// sink reads its own two at import time as well.
process.env.API_PORT         = String(API_PORT)
process.env.STRIPE_SINK_PORT = String(SINK_PORT)
process.env.STRIPE_URL       = SINK
process.env.STRIPE_HOOK_URL  = WEBHOOK
process.env.STRIPE_SECRET_KEY     = SECRET_KEY
process.env.STRIPE_WEBHOOK_SECRET = HOOK_SECRET
// The app's other sinks would take the dev row's ports off a running server.
process.env.MAIL_SINK_URL = 'http://localhost:9/unused'
process.env.PSP_URL       = 'http://localhost:9/unused'

const { default: app }       = await import('../../api/src/app.ts')
const { startStripeSink }    = await import('../../api/src/core/stripe-sink.ts')
const stripe                 = await import('../../api/src/core/stripe.ts')

const got = {}
const t = (key, value) => { got[key] = value }

const sink = startStripeSink()
await app.start()

const sig = (t, body, secret = HOOK_SECRET) =>
  createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')

const postHook = (header, body) => fetch(WEBHOOK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(header ? { 'Stripe-Signature': header } : {}) },
  body,
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))

try {
  // ── outbound: the shape on the wire ─────────────────────────────────────
  const made = await stripe.createPaymentIntent(app, {
    amountMinor: 1250, currency: 'USD', reference: 'ORD-STRIPE-1',
  })
  t('create.succeeds', {
    ok:       !made.error,
    amount:   made.intent?.amount,
    // Lowercased by the connector. Stripe refuses 'USD' and the caller should
    // not have to know that.
    currency: made.intent?.currency,
    // The nested key arrived and came back, which is the whole of what form
    // encoding bought: `metadata[order_reference]=…` is a shape JSON could not
    // have expressed to this API.
    metadata: made.intent?.metadata?.order_reference,
  })

  // ── the negative control ────────────────────────────────────────────────
  // The same connector against a target with `encoding` removed — conduit as it
  // was before FJS-556. If this ALSO succeeded, every assertion above would be
  // about something other than the encoding.
  const { createConduit, createStaticResolver } = await import('@frontierjs/conduit')
  const bare = createConduit({ credentials: createStaticResolver({ STRIPE_SECRET_KEY: SECRET_KEY }) })
  const { encoding, ...jsonTarget } = stripe.stripeTarget()
  await bare.register(jsonTarget)
  const wrong = await stripe.createPaymentIntent({ conduit: bare }, {
    amountMinor: 100, currency: 'usd', reference: 'ORD-STRIPE-NEG',
  })
  t('withoutFormEncoding.isRefused', {
    failed:        !!wrong.error,
    namesTheCause: (wrong.error?.message ?? '').includes('x-www-form-urlencoded'),
  })

  // ── a decline is a domain answer, not an outage ─────────────────────────
  const declined = await stripe.createPaymentIntent(app, {
    amountMinor: 4242, currency: 'usd', reference: 'ORD-STRIPE-2',
  })
  t('decline.isNotRetryable', {
    kind:      declined.error?.kind,
    code:      declined.error?.code,
    // The half conduit cannot answer: it classifies by STATUS, and a card
    // decline is a 402 that arrives as `server_error`. Stripe puts the real
    // answer in the body and the connector translates it.
    retryable: declined.error?.retryable,
  })

  // ── an api_error IS retryable ───────────────────────────────────────────
  await fetch(`${SINK}/fail-next`, { method: 'POST' })
  const flaky = await stripe.createPaymentIntent(app, {
    amountMinor: 500, currency: 'usd', reference: 'ORD-STRIPE-3',
  })
  t('apiError.isRetryable', { type: flaky.error?.type, retryable: flaky.error?.retryable })

  // ── a major-unit amount never reaches the wire ──────────────────────────
  // 12.40 would charge twelve pence. Refused before any request, which is why
  // it throws rather than returning an error value.
  let threw = null
  try { await stripe.createPaymentIntent(app, { amountMinor: 12.4, currency: 'usd', reference: 'x' }) }
  catch (e) { threw = e.message }
  const before = await (await fetch(`${SINK}/intents`)).json()
  t('majorUnits.refusedBeforeSending', {
    threw:   /minor units/.test(threw ?? ''),
    // Nothing was sent. ONE intent exists at this point — the 1250 create; the
    // 4242 was declined and the 500 hit the armed api_error, and neither stores
    // anything. A wrong number here reads as "the float was sent".
    intents: before.length,
  })

  // ── refunds: partial, tracked, and the key on the wire ──────────────────
  const id = made.intent.id
  const part = await stripe.createRefund(app, { paymentIntentId: id, amountMinor: 250, key: 'ORD-STRIPE-1:r1' })
  const over = await stripe.createRefund(app, { paymentIntentId: id, amountMinor: 99999, key: 'ORD-STRIPE-1:r2' })
  t('refund.partialThenOverdrawn', {
    first:      part.refund?.amount,
    refused:    !!over.error,
    // Stripe's own sentence rather than a copy this app holds.
    saysHowMuch: (over.error?.message ?? '').includes('greater than unrefunded'),
  })

  // ── inbound: a real signed event, over a real socket ────────────────────
  // Confirming at the sink makes it sign and POST to the app. Nothing here
  // forges anything — the bytes and the signature are the sink's.
  const confirm = await fetch(`${SINK}/v1/payment_intents/${id}/confirm`, {
    method: 'POST', headers: { authorization: `Bearer ${SECRET_KEY}` },
  })
  const events = await (await fetch(`${SINK}/events`)).json()
  const succeeded = events.find(e => e.type === 'payment_intent.succeeded')
  t('webhook.realEventIsAccepted', {
    confirmed: confirm.status,
    // What the APP answered the sink. 200 is the only thing that stops Stripe
    // retrying, so this is the assertion and not the sink's own status code.
    answered:  succeeded?.status ?? null,
  })

  // ── the refusals ────────────────────────────────────────────────────────
  const body = JSON.stringify({ id: 'evt_x', object: 'event', type: 'payment_intent.succeeded' })
  const now  = Math.floor(Date.now() / 1000)

  t('webhook.forgedIsRefused',   await postHook(`t=${now},v1=${sig(now, body, 'whsec_wrong')}`, body))
  // A real signature over a DIFFERENT body — the swap a signature exists to
  // catch, and the one a bearer token could never catch.
  t('webhook.swappedBodyIsRefused', await postHook(
    `t=${now},v1=${sig(now, body)}`,
    JSON.stringify({ id: 'evt_x', object: 'event', type: 'charge.refunded' })))
  t('webhook.staleIsRefused',    await postHook(`t=${now - 400},v1=${sig(now - 400, body)}`, body))
  t('webhook.unsignedIsRefused', await postHook(null, body))

  // ── secret rotation ─────────────────────────────────────────────────────
  // Stripe sends every configured secret's signature in one header while an
  // endpoint secret is being rolled. Reading only the first `v1=` refuses half
  // the events for the length of a rotation, which presents as flapping.
  t('webhook.rotationIsAccepted', await postHook(
    `t=${now},v1=${sig(now, body, 'whsec_old')},v1=${sig(now, body)}`, body))

} catch (e) {
  console.error('\nThe drive threw:', e.stack ?? e.message)
  got.__threw = String(e.message)
} finally {
  await app.stop()
  sink.stop()
}

const expected = {
  'create.succeeds':                 { ok: true, amount: 1250, currency: 'usd', metadata: 'ORD-STRIPE-1' },
  'withoutFormEncoding.isRefused':   { failed: true, namesTheCause: true },
  'decline.isNotRetryable':          { kind: 'declined', code: 'card_declined', retryable: false },
  'apiError.isRetryable':            { type: 'api_error', retryable: true },
  'majorUnits.refusedBeforeSending': { threw: true, intents: 1 },
  'refund.partialThenOverdrawn':     { first: 250, refused: true, saysHowMuch: true },
  'webhook.realEventIsAccepted':     { confirmed: 200, answered: 200 },
  'webhook.forgedIsRefused':         { status: 401, body: { error: 'invalid signature' } },
  'webhook.swappedBodyIsRefused':    { status: 401, body: { error: 'invalid signature' } },
  'webhook.staleIsRefused':          { status: 401, body: { error: 'invalid signature' } },
  'webhook.unsignedIsRefused':       { status: 401, body: { error: 'invalid signature' } },
  'webhook.rotationIsAccepted':      { status: 200, body: { received: true, id: 'evt_x', type: 'payment_intent.succeeded' } },
}

let failed = 0
for (const [key, want] of Object.entries(expected)) {
  const have = got[key]
  const ok = JSON.stringify(have) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${key}`)
  if (!ok) {
    console.log(`         want ${JSON.stringify(want)}`)
    console.log(`         have ${JSON.stringify(have)}`)
  }
}
console.log(failed ? `\n${failed} assertion(s) failed` : `\nall ${Object.keys(expected).length} assertions passed`)
process.exit(failed ? 1 : 0)
