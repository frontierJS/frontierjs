// sink.ts — Stripe, standing in for Stripe.
//
// A dev listener that speaks the real thing's shape: form-encoded requests, a
// bearer secret key, Stripe-shaped JSON back, an honored `Idempotency-Key`, and
// webhooks signed the way Stripe signs them. A SEPARATE LISTENER rather than an
// in-process fake: the form encoding is the feature, and a fake that took a
// JavaScript object would never put bytes on a wire. The form parser is written
// by hand rather than imported from conduit's encoder in reverse — a decoder
// built from the encoder agrees with it by construction.
//
// It owns the chaos (FJS-D890): `/_sink/arm` takes `{ failNext }` for one
// `api_error`, `{ lost }` for a request that is applied and never answered,
// `{ rateLimit: { retryAfter } }` for one 429, and `{ deliverTwice }` for a
// duplicated event. `/_sink/seen` is what arrived, `/_sink/reset` clears it.
//
// Stripe Tax rides the same listener. Rates are the sink's: a US state charges
// `state`-named percentages; an EU country charges VAT unless the customer
// carries an `eu_vat` tax id, which is reverse charge (zero,
// `taxability_reason: 'reverse_charge'`); a country of `XX` or an empty US
// postal code is `customer_tax_location_invalid`; a tax id that fails its
// format is `tax_id_invalid`. A transaction from an expired or unknown
// calculation is `resource_missing`.
//
// Connect: `POST /v1/accounts` makes an account with every requirement due,
// `POST /v1/account_links` a link to it, and `/_sink/onboard/<acct>` stands in
// for the owner finishing hosted onboarding (it clears the requirements and
// sends `account.updated`). A request carrying `Stripe-Account` acts on that
// account: its intents, refunds and idempotency keys are that account's, and
// its events carry `account` and are signed with the Connect secret.
// `/_sink/checkout/<cs>/complete` stands in for a customer paying a session,
// by the session's first payment method or `?method=`; it makes the session's
// PaymentIntent on the session's account, so a paid session refunds through
// `/v1/refunds` like any intent, and sends `payment_intent.succeeded` beside
// the session's event as Stripe does. A `us_bank_account` debit completes `unpaid`
// with the intent `processing`, and `/settle` or `/fail` on it sends
// `async_payment_succeeded` or `async_payment_failed` with the intent's
// `succeeded` or `payment_failed`, as the bank answers days later at Stripe.
//
// Authorization: an intent or session made with `capture_method=manual`
// confirms or completes into `requires_capture` with an uncaptured charge
// (`charge.succeeded` and `payment_intent.amount_capturable_updated`; the
// session is `paid` and names its intent). `POST …/capture` takes all or
// `amount_to_capture` of it and releases the rest (`charge.captured`, then
// `payment_intent.succeeded`); `POST …/cancel` releases it
// (`payment_intent.canceled`). Capturing more than is capturable is
// `amount_too_large`; capturing or cancelling an intent in the wrong status
// is `payment_intent_unexpected_state`. A held session offering
// `us_bank_account` is refused at creation, as a bank debit cannot be held.
//
// Disputes: `/_sink/charge/<pi>/dispute` opens one on a captured charge
// (`charge.dispute.created`, then `charge.dispute.funds_withdrawn`);
// `/_sink/dispute/<du>/respond` submits evidence (`charge.dispute.updated`,
// `under_review`); `/_sink/dispute/<du>/won` or `/lost` closes it
// (`charge.dispute.closed`, and `funds_reinstated` after a win). `?reason=`
// and `?amount=` shape the opening; the defaults are `fraudulent` and the
// captured amount.
//
// A succeeding intent makes one charge, sends `charge.succeeded` naming its
// balance transaction by id, and `GET /v1/balance_transactions/<txn>` reads it
// on the account the charge was made on. The fees are the sink's: a card 2.9%
// + 30, a bank debit 0.8% capped at 500.
//
// It does NOT pretend to be Stripe's semantics: no card tokens, no 3DS, no
// payouts, no refund's own balance transaction. A reserved amount of 4242 is
// the decline.

import { createHmac } from 'node:crypto'

export interface StripeSinkOptions {
  port?:         number
  /** What this stand-in accepts as a secret key. */
  key?:          string
  /** What it signs events with. */
  webhookSecret?: string
  /** Where it POSTs events; none means events are recorded and not sent. */
  hookUrl?:      string
  /** What it signs a connected account's events with — the platform's Connect endpoint secret. */
  connectWebhookSecret?: string
  /** Where a connected account's events go; defaults to `hookUrl`. */
  connectHookUrl?: string
  /** Tax: seconds a calculation lives after it is made (90 min at Stripe; a drive sets 1). */
  taxExpiresInSeconds?: number
}

interface Intent {
  id: string; object: 'payment_intent'; amount: number; currency: string
  status: string; client_secret: string; metadata: Record<string, string>; refunded: number
  account: string | null; latest_charge?: string | null
  capture_method: 'automatic' | 'manual'; amount_capturable: number; amount_received: number
  canceled_at?: number | null; cancellation_reason?: string | null
}

const CANCELABLE = ['requires_payment_method', 'requires_capture', 'requires_confirmation', 'requires_action', 'processing']

const DUE = ['business_profile.mcc', 'business_profile.url', 'business_type', 'external_account', 'representative.first_name', 'tos_acceptance.date']

/** `a[b]=1&c[0][d]=2` → `{ a: { b: '1' }, c: [ { d: '2' } ] }`. Values stay strings. */
export function parseForm(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const pair of text.split('&')) {
    if (!pair) continue
    const eq  = pair.indexOf('=')
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' ')
    const val = eq === -1 ? '' : decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '))
    const path = [key.replace(/\[.*$/, ''), ...[...key.matchAll(/\[([^\]]*)\]/g)].map(m => m[1])]
    let node: Record<string, unknown> = root
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i], next = path[i + 1]
      if (node[seg] === undefined) node[seg] = /^\d+$/.test(next) ? [] : {}
      node = node[seg] as Record<string, unknown>
    }
    node[path[path.length - 1]] = val
  }
  return root
}

const TAX_RATES: Record<string, { pct: number; type: string }> = { 'US:CA': { pct: 7.25, type: 'sales_tax' }, 'US:NY': { pct: 8, type: 'sales_tax' }, 'US:OR': { pct: 0, type: 'sales_tax' }, DE: { pct: 19, type: 'vat' }, FR: { pct: 20, type: 'vat' }, GB: { pct: 20, type: 'vat' } }

let counter = 0
const id = (prefix: string) => `${prefix}_${(++counter).toString().padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const stripeError = (type: string, message: string, status: number, extra: Record<string, string> = {}) =>
  json({ error: { type, message, ...extra } }, status)

export function startStripeSink(opts: StripeSinkOptions = {}) {
  const KEY     = opts.key ?? 'sk_test_dev'
  const SECRET  = opts.webhookSecret ?? 'whsec_dev'
  const CONNECT_SECRET = opts.connectWebhookSecret ?? 'whsec_connect_dev'
  const intents = new Map<string, Intent>()
  const accounts = new Map<string, Record<string, any>>()
  const sessions = new Map<string, Record<string, any>>()
  const charges  = new Map<string, Record<string, any>>()   // by payment intent
  const disputes = new Map<string, Record<string, any>>()
  const balances = new Map<string, { account: string | null; body: Record<string, unknown> }>()
  const calcs   = new Map<string, { madeAt: number; body: Record<string, unknown> }>()
  const txns    = new Map<string, Record<string, unknown>>()
  const TAX_TTL = (opts.taxExpiresInSeconds ?? 5400) * 1000
  const keys    = new Map<string, { body: string; response: { status: number; body: unknown } }>()
  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const events: { id: string; type: string; status: number | null }[] = []
  const armed = { failNext: false, lost: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false }
  const hanging: Array<() => void> = []

  async function deliver(type: string, data: unknown, account: string | null = null) {
    const evt = { id: id('evt'), type, status: null as number | null, account }
    const payload = JSON.stringify({ id: evt.id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object: data }, ...(account ? { account } : {}) })
    const t   = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', account ? CONNECT_SECRET : SECRET).update(`${t}.${payload}`).digest('hex')
    const hookUrl = account ? opts.connectHookUrl ?? opts.hookUrl : opts.hookUrl
    const times = armed.deliverTwice ? 2 : 1
    armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      if (!hookUrl) { events.push({ ...evt }); continue }
      try {
        const res = await fetch(hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: payload })
        events.push({ ...evt, status: res.status })
      } catch { events.push({ ...evt, status: null }) }
    }
  }

  // An authorized charge has no balance transaction yet: money enters the balance at capture, and only what was captured.
  function charge(intent: Intent, method: string) {
    const held = intent.capture_method === 'manual'
    const ch: Record<string, any> = { id: id('ch'), object: 'charge', amount: intent.amount, amount_refunded: 0, currency: intent.currency, payment_intent: intent.id, refunded: false,
      captured: !held, amount_captured: held ? 0 : intent.amount, disputed: false, balance_transaction: null, metadata: intent.metadata, _method: method }
    charges.set(intent.id, ch)
    intent.latest_charge = ch.id
    if (held) Object.assign(intent, { status: 'requires_capture', amount_capturable: intent.amount })
    else settle(intent, ch, intent.amount)
    return shownCharge(ch)
  }

  function settle(intent: Intent, ch: Record<string, any>, amount: number) {
    const method = ch._method
    const fee = method === 'us_bank_account' ? Math.min(500, Math.round(amount * 0.008)) : Math.round(amount * 0.029) + 30
    const now = Math.floor(Date.now() / 1000), txn = id('txn')
    balances.set(txn, { account: intent.account, body: { id: txn, object: 'balance_transaction', amount, fee, net: amount - fee, currency: intent.currency, status: 'pending', type: 'charge',
      source: ch.id, available_on: now + 2 * 86_400, created: now, fee_details: [{ amount: fee, currency: intent.currency, type: 'stripe_fee', description: 'Stripe processing fees' }] } })
    Object.assign(ch, { captured: true, amount_captured: amount, amount_refunded: intent.amount - amount, balance_transaction: txn })
    Object.assign(intent, { status: 'succeeded', amount_capturable: 0, amount_received: amount })
  }

  const shownCharge = (ch: Record<string, any>) => { const { _method, ...shown } = ch; return shown }
  const newIntent = (fields: Pick<Intent, 'amount' | 'currency' | 'status' | 'metadata' | 'account'> & { capture_method?: 'automatic' | 'manual' }): Intent =>
    ({ id: id('pi'), object: 'payment_intent', client_secret: id('pi') + '_secret', refunded: 0, capture_method: 'automatic', amount_capturable: 0, amount_received: 0, ...fields })

  // A paid charge's dispute: Stripe withdraws the disputed amount the moment it opens, and returns it only on a win.
  async function disputeStep(path: string, url: URL): Promise<Response | null> {
    const open = path.match(/^\/_sink\/charge\/([^/]+)\/dispute$/)
    if (open) {
      const intent = intents.get(open[1]), ch = charges.get(open[1])
      if (!intent || !ch || !ch.captured) return json({ error: 'only a captured charge can be disputed' }, 409)
      if (ch.disputed) return json({ error: 'the charge is already disputed' }, 409)
      const now = Math.floor(Date.now() / 1000), amount = Number(url.searchParams.get('amount') ?? ch.amount_captured)
      const du = { id: id('du'), object: 'dispute', amount, currency: ch.currency, charge: ch.id, payment_intent: intent.id, reason: url.searchParams.get('reason') ?? 'fraudulent',
        status: 'needs_response', created: now, is_charge_refundable: false, evidence_details: { due_by: now + 7 * 86_400, has_evidence: false, past_due: false, submission_count: 0 },
        balance_transactions: [{ id: id('txn'), object: 'balance_transaction', amount: -amount, fee: 1500, net: -amount - 1500, currency: ch.currency, status: 'available', type: 'adjustment', source: null, available_on: now, created: now, fee_details: [{ amount: 1500, currency: ch.currency, type: 'stripe_fee', description: 'Dispute fee' }] }],
        metadata: {}, _account: intent.account }
      ch.disputed = true
      disputes.set(du.id, du)
      const { _account, ...shown } = du
      await deliver('charge.dispute.created', shown, _account)
      await deliver('charge.dispute.funds_withdrawn', shown, _account)
      return json(shown)
    }
    const step = path.match(/^\/_sink\/dispute\/([^/]+)\/(respond|won|lost)$/)
    if (!step) return null
    const du = disputes.get(step[1])
    if (!du) return json({ error: 'no such dispute' }, 404)
    if (['won', 'lost', 'warning_closed'].includes(du.status)) return json({ error: `the dispute is already ${du.status}` }, 409)
    if (step[2] === 'respond') Object.assign(du, { status: 'under_review', evidence_details: { ...du.evidence_details, has_evidence: true, submission_count: du.evidence_details.submission_count + 1 } })
    else du.status = step[2]
    if (step[2] === 'won') { const now = Math.floor(Date.now() / 1000); du.balance_transactions.push({ id: id('txn'), object: 'balance_transaction', amount: du.amount, fee: 0, net: du.amount, currency: du.currency, status: 'available', type: 'adjustment', source: null, available_on: now, created: now, fee_details: [] }) }
    const { _account, ...shown } = du
    await deliver(step[2] === 'respond' ? 'charge.dispute.updated' : 'charge.dispute.closed', shown, _account)
    if (step[2] === 'won') await deliver('charge.dispute.funds_reinstated', shown, _account)
    return json(shown)
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url  = new URL(req.url)
      const path = url.pathname

      if (path === '/_sink/seen')  return json({ requests: seen, intents: [...intents.values()], events, transactions: [...txns.values()] })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; Object.assign(armed, { failNext: false, lost: false, rateLimit: null, deliverTwice: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }
      const onboard = path.match(/^\/_sink\/onboard\/([^/]+)$/)
      if (onboard) {
        const a = accounts.get(onboard[1])
        if (!a) return json({ error: 'no such account' }, 404)
        Object.assign(a, { details_submitted: true, charges_enabled: true, payouts_enabled: true, requirements: { currently_due: [], eventually_due: [], past_due: [], disabled_reason: null } })
        await deliver('account.updated', a, a.id)
        return json(a)
      }
      const disputed = await disputeStep(path, url)
      if (disputed) return disputed
      const paying = path.match(/^\/_sink\/checkout\/([^/]+)\/(complete|settle|fail)$/)
      if (paying) {
        const cs = sessions.get(paying[1])
        if (!cs) return json({ error: 'no such session' }, 404)
        const step = paying[2]
        let paidBy: Record<string, any> | null = null
        if (step === 'complete') {
          const method = url.searchParams.get('method') ?? cs.payment_method_types[0]
          if (!cs.payment_method_types.includes(method)) return json({ error: `the session does not offer ${method}` }, 400)
          if (cs.status === 'complete') return json({ error: 'the session is already complete' }, 409)
          const ach = method === 'us_bank_account'
          const intent = newIntent({ amount: cs.amount_total, currency: String(cs.currency ?? 'usd'), status: ach ? 'processing' : 'succeeded', metadata: cs._piMetadata, account: cs._account, capture_method: cs._captureMethod })
          intents.set(intent.id, intent)
          if (!ach) paidBy = charge(intent, method)
          Object.assign(cs, { status: 'complete', payment_status: ach ? 'unpaid' : 'paid', url: null, payment_intent: intent.id, _method: method })
        } else {
          if (cs.status !== 'complete' || cs._method !== 'us_bank_account' || cs.payment_status !== 'unpaid') return json({ error: 'only a completed bank debit still pending settles or fails' }, 409)
          const intent = intents.get(cs.payment_intent)!
          if (step === 'settle') { cs.payment_status = 'paid'; paidBy = charge(intent, 'us_bank_account') }
          else { cs._method = null; intent.status = 'requires_payment_method' }
        }
        const { _account, _method, _piMetadata, _captureMethod, ...shown } = cs
        const sessionIntent = intents.get(cs.payment_intent)!
        const held = sessionIntent.status === 'requires_capture'
        if (paidBy) await deliver(held ? 'payment_intent.amount_capturable_updated' : 'payment_intent.succeeded', sessionIntent, _account)
        if (step === 'fail') await deliver('payment_intent.payment_failed', sessionIntent, _account)
        if (paidBy) await deliver('charge.succeeded', paidBy, _account)
        await deliver(step === 'complete' ? 'checkout.session.completed' : `checkout.session.async_payment_${step === 'settle' ? 'succeeded' : 'failed'}`, shown, _account)
        return json(shown)
      }

      const text = req.method === 'POST' ? await req.text() : ''
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: text, at: Date.now() })

      if (req.headers.get('authorization') !== `Bearer ${KEY}`)
        return stripeError('invalid_request_error', 'Invalid API Key provided', 401, { code: 'api_key_invalid' })

      // A body that exists under the wrong content-type is refused by name: this
      // is what catches conduit sending JSON under a form target (FJS-556).
      const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim()
      if (text && ct !== 'application/x-www-form-urlencoded')
        return stripeError('invalid_request_error', `Stripe wants application/x-www-form-urlencoded, got '${ct || '(none)'}'`, 400, { code: 'content_type' })

      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null
        return stripeError('rate_limit_error', 'Too many requests', 429) && json({ error: { type: 'rate_limit_error', message: 'Too many requests' } }, 429, { 'retry-after': String(retryAfter) }) }
      if (armed.failNext) { armed.failNext = false; return stripeError('api_error', 'An unexpected error occurred', 500) }

      // Idempotency: Stripe answers the FIRST response again for the same key
      // and payload, and refuses the same key over a different payload.
      // A key is scoped to the account the request acts on, as Stripe scopes it.
      const acting = req.headers.get('stripe-account')
      const idem = req.headers.get('idempotency-key') ? `${acting ?? ''}:${req.headers.get('idempotency-key')}` : null
      if (idem && keys.has(idem)) {
        const prior = keys.get(idem)!
        if (prior.body !== text) return stripeError('idempotency_error', `Keys for idempotent requests can only be used with the same parameters they were first used with. Key: ${idem}`, 400)
        return json(prior.response.body, prior.response.status)
      }
      const remember = (status: number, body: unknown) => { if (idem) keys.set(idem, { body: text, response: { status, body } }); return json(body, status) }

      const form = parseForm(text)
      let answer: Response | null = null

      if (path === '/v1/payment_intents' && req.method === 'POST') {
        const amount = Number(form.amount)
        if (!Number.isInteger(amount) || amount <= 0) answer = stripeError('invalid_request_error', 'Invalid integer: amount', 400, { code: 'parameter_invalid_integer' })
        else if (amount === 4242) answer = stripeError('card_error', 'Your card was declined.', 402, { code: 'card_declined', decline_code: 'generic_decline' })
        else {
          const intent = newIntent({ amount, currency: String(form.currency ?? 'usd'), status: 'requires_payment_method', metadata: (form.metadata ?? {}) as Record<string, string>, account: acting, capture_method: form.capture_method === 'manual' ? 'manual' : 'automatic' })
          intents.set(intent.id, intent)
          answer = remember(200, intent)
        }
      }

      const confirm = path.match(/^\/v1\/payment_intents\/([^/]+)\/confirm$/)
      if (confirm && req.method === 'POST') {
        const intent = intents.get(confirm[1])
        if (!intent || intent.account !== acting) answer = stripeError('invalid_request_error', 'No such payment_intent', 404)
        else {
          const ch = charge(intent, 'card')
          await deliver(intent.status === 'requires_capture' ? 'payment_intent.amount_capturable_updated' : 'payment_intent.succeeded', intent, intent.account)
          await deliver('charge.succeeded', ch, intent.account)
          answer = json(intent)
        }
      }

      const capture = path.match(/^\/v1\/payment_intents\/([^/]+)\/capture$/)
      if (capture && req.method === 'POST') {
        const intent = intents.get(capture[1])
        const asked = form.amount_to_capture === undefined ? intent?.amount_capturable ?? 0 : Number(form.amount_to_capture)
        if (!intent || intent.account !== acting) answer = stripeError('invalid_request_error', `No such payment_intent: '${capture[1]}'`, 404, { code: 'resource_missing' })
        else if (intent.status !== 'requires_capture')
          answer = stripeError('invalid_request_error', `This PaymentIntent could not be captured because it has a status of ${intent.status}. Only a PaymentIntent with one of the following statuses may be captured: requires_capture.`, 400, { code: 'payment_intent_unexpected_state' })
        else if (!Number.isInteger(asked) || asked <= 0 || asked > intent.amount_capturable)
          answer = stripeError('invalid_request_error', `The amount to capture (${asked}) is greater than the amount capturable (${intent.amount_capturable})`, 400, { code: 'amount_too_large' })
        else {
          const ch = charges.get(intent.id)!
          settle(intent, ch, asked)
          await deliver('charge.captured', shownCharge(ch), intent.account)
          await deliver('payment_intent.succeeded', intent, intent.account)
          answer = remember(200, intent)
        }
      }

      const cancel = path.match(/^\/v1\/payment_intents\/([^/]+)\/cancel$/)
      if (cancel && req.method === 'POST') {
        const intent = intents.get(cancel[1])
        if (!intent || intent.account !== acting) answer = stripeError('invalid_request_error', `No such payment_intent: '${cancel[1]}'`, 404, { code: 'resource_missing' })
        else if (!CANCELABLE.includes(intent.status))
          answer = stripeError('invalid_request_error', `You cannot cancel this PaymentIntent because it has a status of ${intent.status}. Only a PaymentIntent with one of the following statuses may be canceled: ${CANCELABLE.join(', ')}.`, 400, { code: 'payment_intent_unexpected_state' })
        else {
          const ch = charges.get(intent.id)
          if (ch && !ch.captured) Object.assign(ch, { amount_refunded: ch.amount, refunded: true })
          Object.assign(intent, { status: 'canceled', amount_capturable: 0, canceled_at: Math.floor(Date.now() / 1000), cancellation_reason: form.cancellation_reason ?? null })
          await deliver('payment_intent.canceled', intent, intent.account)
          answer = remember(200, intent)
        }
      }

      const oneIntent = path.match(/^\/v1\/payment_intents\/([^/]+)$/)
      if (oneIntent && req.method === 'GET') {
        // A direct charge's intent lives on the connected account: asked for from anywhere else it does not exist.
        const intent = intents.get(oneIntent[1])
        answer = intent && intent.account === acting ? json(intent) : stripeError('invalid_request_error', `No such payment_intent: '${oneIntent[1]}'`, 404, { code: 'resource_missing' })
      }

      if (path === '/v1/refunds' && req.method === 'POST') {
        // A direct charge lives on the connected account: asked for from anywhere else it does not exist.
        const intent = intents.get(String(form.payment_intent ?? ''))
        if (!intent || intent.account !== acting) answer = stripeError('invalid_request_error', `No such payment_intent: '${form.payment_intent}'`, 404, { code: 'resource_missing' })
        else {
          // A partial capture released the rest; only what was captured can come back.
          const received = intent.capture_method === 'manual' ? intent.amount_received : intent.amount
          const left  = received - intent.refunded
          const asked = form.amount === undefined ? left : Number(form.amount)
          if (!Number.isInteger(asked) || asked <= 0 || asked > left)
            answer = stripeError('invalid_request_error', `Refund amount (${asked}) is greater than unrefunded amount (${left})`, 400, { code: 'amount_too_large' })
          else {
            intent.refunded += asked
            const refund = { id: id('re'), object: 'refund', amount: asked, currency: intent.currency, payment_intent: intent.id, status: 'succeeded' }
            // The charge the intent succeeded with, so an app keying on the charge id finds it again.
            const ch = Object.assign(charges.get(intent.id) ?? { id: id('ch'), object: 'charge', amount: intent.amount, currency: intent.currency, payment_intent: intent.id, balance_transaction: null, metadata: intent.metadata },
              { amount_refunded: intent.amount - received + intent.refunded, refunded: intent.refunded === received })
            await deliver('charge.refunded', shownCharge(ch), intent.account)
            answer = remember(200, refund)
          }
        }
      }

      if (path === '/v1/accounts' && req.method === 'POST') {
        if (acting) answer = stripeError('invalid_request_error', 'A connected account cannot create accounts', 400)
        else if (!form.country) answer = stripeError('invalid_request_error', 'Missing required param: country', 400, { code: 'parameter_missing' })
        else {
          const a = { id: id('acct'), object: 'account', country: String(form.country), email: form.email ?? null, business_type: form.business_type ?? null, charges_enabled: false, payouts_enabled: false, details_submitted: false,
            controller: form.controller ?? {}, metadata: form.metadata ?? {}, requirements: { currently_due: [...DUE], eventually_due: [...DUE], past_due: [], disabled_reason: 'requirements.past_due' } }
          accounts.set(a.id, a)
          answer = remember(200, a)
        }
      }

      const oneAccount = path.match(/^\/v1\/accounts\/([^/]+)$/)
      if (oneAccount && req.method === 'GET') {
        const a = accounts.get(oneAccount[1])
        answer = a ? json(a) : stripeError('invalid_request_error', `No such account: '${oneAccount[1]}'`, 404, { code: 'resource_missing' })
      }

      const oneBalance = path.match(/^\/v1\/balance_transactions\/([^/]+)$/)
      if (oneBalance && req.method === 'GET') {
        // A direct charge's balance transaction lives on the connected account: asked for from anywhere else it does not exist.
        const b = balances.get(oneBalance[1])
        answer = b && b.account === acting ? json(b.body) : stripeError('invalid_request_error', `No such balance transaction: '${oneBalance[1]}'`, 404, { code: 'resource_missing' })
      }

      if (path === '/v1/account_links' && req.method === 'POST') {
        const a = accounts.get(String(form.account ?? ''))
        if (!a) answer = stripeError('invalid_request_error', `No such account: '${form.account}'`, 404, { code: 'resource_missing' })
        else if (form.type !== 'account_onboarding' && form.type !== 'account_update') answer = stripeError('invalid_request_error', 'Invalid type', 400)
        else if (!form.refresh_url || !form.return_url) answer = stripeError('invalid_request_error', 'Missing required param: refresh_url or return_url', 400, { code: 'parameter_missing' })
        else { const now = Math.floor(Date.now() / 1000); answer = json({ object: 'account_link', created: now, expires_at: now + 300, url: `https://connect.stripe.com/setup/s/${a.id}/${id('link')}` }) }
      }

      if (path === '/v1/checkout/sessions' && req.method === 'POST') {
        const f = form as Record<string, any>
        const items = Object.values(f.line_items ?? {}) as Record<string, any>[]
        const held = f.payment_intent_data?.capture_method === 'manual'
        const methods = Object.values(f.payment_method_types ?? { 0: 'card' }) as string[]
        if (f.mode !== 'payment') answer = stripeError('invalid_request_error', 'The sink speaks mode=payment only', 400)
        else if (held && methods.includes('us_bank_account')) answer = stripeError('invalid_request_error', 'The payment method `us_bank_account` does not support manual capture', 400)
        else if (!items.length || !f.success_url) answer = stripeError('invalid_request_error', 'Missing required param: line_items or success_url', 400, { code: 'parameter_missing' })
        else {
          const total = items.reduce((t, li) => t + Number(li.price_data?.unit_amount) * Number(li.quantity ?? 1), 0)
          const cs = { id: id('cs_test'), object: 'checkout.session', mode: 'payment', status: 'open', payment_status: 'unpaid', amount_total: total, currency: items[0].price_data?.currency ?? null,
            customer: null, customer_email: f.customer_email ?? null, client_reference_id: f.client_reference_id ?? null, payment_intent: null,
            payment_method_types: methods, metadata: f.metadata ?? {}, expires_at: Number(f.expires_at ?? Math.floor(Date.now() / 1000) + 86_400), url: '', _account: acting, _piMetadata: f.payment_intent_data?.metadata ?? {},
            _captureMethod: held ? 'manual' as const : 'automatic' as const }
          cs.url = `https://checkout.stripe.com/c/pay/${cs.id}`
          sessions.set(cs.id, cs)
          const { _account: _a, _piMetadata: _m, _captureMethod: _c, ...shown } = cs
          answer = remember(200, shown)
        }
      }

      if (path === '/v1/tax/calculations' && req.method === 'POST') {
        const f = form as Record<string, any>
        const addr = f.customer_details?.address ?? {}, country = String(addr.country ?? ''), state = String(addr.state ?? '')
        const ids: { type: string; value: string }[] = Object.values(f.customer_details?.tax_ids ?? {})
        const badId = ids.find(t => t.type === 'eu_vat' && !/^[A-Z]{2}[A-Z0-9]{8,12}$/.test(t.value))
        const rate = country === 'US' ? (addr.postal_code ? TAX_RATES[`US:${state}`] : undefined) : TAX_RATES[country]
        if (badId) answer = stripeError('invalid_request_error', `The tax ID '${badId.value}' is not valid`, 400, { code: 'tax_id_invalid' })
        else if (!rate) answer = stripeError('invalid_request_error', 'We could not determine the customer\u2019s tax location based on the provided customer address.', 400, { code: 'customer_tax_location_invalid' })
        else {
          const reverse = rate.type === 'vat' && ids.some(t => t.type === 'eu_vat')
          const lines = Object.values(f.line_items ?? {}) as Record<string, string>[]
          const items = lines.map(l => { const amount = Number(l.amount) * Number(l.quantity ?? 1); const tax = reverse ? 0 : Math.round(amount * rate.pct / 100); return { id: id('tax_li'), amount, amount_tax: tax, reference: l.reference, tax_code: l.tax_code ?? 'txcd_99999999', tax_breakdown: [{ taxability_reason: reverse ? 'reverse_charge' : rate.pct === 0 ? 'not_collecting' : 'standard_rated', amount: tax }] } })
          const taxTotal = items.reduce((s, i) => s + i.amount_tax, 0), subtotal = items.reduce((s, i) => s + i.amount, 0) + Number(f.shipping_cost?.amount ?? 0)
          const calc = { id: id('taxcalc'), object: 'tax.calculation', currency: f.currency, amount_total: subtotal + taxTotal, tax_amount_exclusive: taxTotal, tax_amount_inclusive: 0, expires_at: Math.floor((Date.now() + TAX_TTL) / 1000), line_items: { data: items },
            tax_breakdown: [{ amount: taxTotal, taxability_reason: reverse ? 'reverse_charge' : 'standard_rated', tax_rate_details: { percentage_decimal: rate.pct.toFixed(2), tax_type: rate.type, country, ...(state ? { state } : {}) } }] }
          calcs.set(calc.id, { madeAt: Date.now(), body: calc })
          answer = json(calc)
        }
      }

      if (path === '/v1/tax/transactions/create_from_calculation' && req.method === 'POST') {
        const f = form as Record<string, any>
        const c = calcs.get(String(f.calculation ?? ''))
        if (!c || Date.now() - c.madeAt >= TAX_TTL) answer = stripeError('invalid_request_error', `No such tax calculation: '${f.calculation}'`, 404, { code: 'resource_missing' })
        else {
          const tx = { id: id('tax'), object: 'tax.transaction', type: 'transaction', reference: f.reference, currency: (c.body as any).currency, created: Math.floor(Date.now() / 1000), calculation: c.body.id }
          txns.set(tx.id, tx)
          answer = remember(200, tx)
        }
      }

      if (path === '/v1/tax/transactions/create_reversal' && req.method === 'POST') {
        const f = form as Record<string, any>
        const orig = txns.get(String(f.original_transaction ?? ''))
        if (!orig) answer = stripeError('invalid_request_error', `No such tax transaction: '${f.original_transaction}'`, 404, { code: 'resource_missing' })
        else {
          const tx = { id: id('tax'), object: 'tax.transaction', type: 'reversal', reference: f.reference, currency: orig.currency, created: Math.floor(Date.now() / 1000), reversal: { original_transaction: orig.id } }
          txns.set(tx.id, tx)
          answer = remember(200, tx)
        }
      }

      if (!answer) return stripeError('invalid_request_error', `Unrecognized request URL: ${req.method} ${path}`, 404)

      // A lost response: the write is APPLIED and the answer never leaves. The
      // caller sees a timeout with the money possibly moved, which is the
      // `indeterminate` case and the reason an unkeyed POST is never replayed.
      if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)); }
      return answer
    },
  })

  return {
    port: server.port,
    url:  `http://127.0.0.1:${server.port}`,
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) {
  const s = startStripeSink({ port: Number(process.env.STRIPE_SINK_PORT ?? 0), hookUrl: process.env.STRIPE_HOOK_URL })
  console.log(`[stripe-sink] ${s.url}`)
}
