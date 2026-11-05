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
// It does NOT pretend to be Stripe's semantics: no card tokens, no 3DS, no
// balance. A reserved amount of 4242 is the decline.

import { createHmac } from 'node:crypto'

export interface StripeSinkOptions {
  port?:         number
  /** What this stand-in accepts as a secret key. */
  key?:          string
  /** What it signs events with. */
  webhookSecret?: string
  /** Where it POSTs events; none means events are recorded and not sent. */
  hookUrl?:      string
  /** Tax: seconds a calculation lives after it is made (90 min at Stripe; a drive sets 1). */
  taxExpiresInSeconds?: number
}

interface Intent {
  id: string; object: 'payment_intent'; amount: number; currency: string
  status: string; client_secret: string; metadata: Record<string, string>; refunded: number
}

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
  const intents = new Map<string, Intent>()
  const calcs   = new Map<string, { madeAt: number; body: Record<string, unknown> }>()
  const txns    = new Map<string, Record<string, unknown>>()
  const TAX_TTL = (opts.taxExpiresInSeconds ?? 5400) * 1000
  const keys    = new Map<string, { body: string; response: { status: number; body: unknown } }>()
  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const events: { id: string; type: string; status: number | null }[] = []
  const armed = { failNext: false, lost: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false }
  const hanging: Array<() => void> = []

  async function deliver(type: string, data: unknown) {
    const evt = { id: id('evt'), type, status: null as number | null }
    const payload = JSON.stringify({ id: evt.id, object: 'event', type, created: Math.floor(Date.now() / 1000), data: { object: data } })
    const t   = Math.floor(Date.now() / 1000)
    const sig = createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex')
    const times = armed.deliverTwice ? 2 : 1
    armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      if (!opts.hookUrl) { events.push({ ...evt }); continue }
      try {
        const res = await fetch(opts.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: payload })
        events.push({ ...evt, status: res.status })
      } catch { events.push({ ...evt, status: null }) }
    }
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url  = new URL(req.url)
      const path = url.pathname

      if (path === '/_sink/seen')  return json({ requests: seen, intents: [...intents.values()], events, transactions: [...txns.values()] })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; Object.assign(armed, { failNext: false, lost: false, rateLimit: null, deliverTwice: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }

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
      const idem = req.headers.get('idempotency-key')
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
          const intent: Intent = { id: id('pi'), object: 'payment_intent', amount, currency: String(form.currency ?? 'usd'), status: 'requires_payment_method', client_secret: id('pi') + '_secret', metadata: (form.metadata ?? {}) as Record<string, string>, refunded: 0 }
          intents.set(intent.id, intent)
          answer = remember(200, intent)
        }
      }

      const confirm = path.match(/^\/v1\/payment_intents\/([^/]+)\/confirm$/)
      if (confirm && req.method === 'POST') {
        const intent = intents.get(confirm[1])
        if (!intent) answer = stripeError('invalid_request_error', 'No such payment_intent', 404)
        else { intent.status = 'succeeded'; await deliver('payment_intent.succeeded', intent); answer = json(intent) }
      }

      if (path === '/v1/refunds' && req.method === 'POST') {
        const intent = intents.get(String(form.payment_intent ?? ''))
        if (!intent) answer = stripeError('invalid_request_error', 'No such payment_intent', 404)
        else {
          const left  = intent.amount - intent.refunded
          const asked = form.amount === undefined ? left : Number(form.amount)
          if (!Number.isInteger(asked) || asked <= 0 || asked > left)
            answer = stripeError('invalid_request_error', `Refund amount (${asked}) is greater than unrefunded amount (${left})`, 400, { code: 'amount_too_large' })
          else {
            intent.refunded += asked
            const refund = { id: id('re'), object: 'refund', amount: asked, currency: intent.currency, payment_intent: intent.id, status: 'succeeded' }
            await deliver('charge.refunded', { ...intent })
            answer = remember(200, refund)
          }
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
