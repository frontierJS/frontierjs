// sink.ts — EasyPost, standing in for EasyPost.
//
// Basic with the key as username, JSON, `{ error: { code, message, errors } }`
// refusals. Verification REWRITES the street (`1 market st` → `1 MARKET ST`,
// a zip gets its +4); a street containing `nowhere` fails verification. Rates
// come as decimal strings with a currency; a parcel over 70 lb gets no rates;
// a CAD rate appears for a Canadian destination. A buy is remembered on the
// shipment (so a read-back after a lost response finds the label); a second
// buy is refused as already purchased. `POST /_sink/track` makes the sink
// deliver a signed `tracker.updated` event. Chaos: `{ lost }`, `{ rateLimit }`,
// `{ failNext }`, `{ deliverTwice }`, `{ noFunds }` (402 on the next buy).

import { createHmac } from 'node:crypto'

export interface EpSinkOptions { port?: number; apiKey?: string; webhookSecret?: string; hookUrl?: string }
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (code: string, message: string, status: number, errors: { field: string; message: string }[] = [], headers: Record<string, string> = {}) => json({ error: { code, message, errors } }, status, headers)
let n = 0
const id = (p: string) => `${p}_${(++n).toString(16).padStart(8, '0')}`

export function startEasyPostSink(opts: EpSinkOptions = {}) {
  const KEY = opts.apiKey ?? 'EZAKdevkey', SECRET = opts.webhookSecret ?? 'ep-webhook-secret'
  const shipments = new Map<string, Record<string, any>>()
  const seen: { path: string; headers: Record<string, string>; body: string; status: number }[] = []
  const events: { type: string; status: number | null }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false, noFunds: false }
  const hanging: Array<() => void> = []

  async function deliver(description: string, result: unknown) {
    const body = JSON.stringify({ id: id('evt'), object: 'Event', description, result, created_at: new Date().toISOString() })
    const sig  = `hmac-sha256-hex=${createHmac('sha256', SECRET).update(body).digest('hex')}`
    const times = armed.deliverTwice ? 2 : 1; armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      if (!opts.hookUrl) { events.push({ type: description, status: null }); continue }
      try { const r = await fetch(opts.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hmac-signature': sig }, body }); events.push({ type: description, status: r.status }) }
      catch { events.push({ type: description, status: null }) }
    }
  }

  function verifyAddr(a: Record<string, string>) {
    const street = String(a.street1 ?? '')
    if (/nowhere/i.test(street)) return { ...a, id: id('adr'), object: 'Address', verifications: { delivery: { success: false, errors: [{ code: 'E.ADDRESS.NOT_FOUND', message: 'Address not found', field: 'address' }] } } }
    return { ...a, id: id('adr'), object: 'Address', street1: street.toUpperCase().replace(/\bST\b\.?/, 'ST'), city: String(a.city ?? '').toUpperCase(), zip: /^\d{5}$/.test(a.zip ?? '') ? `${a.zip}-0001` : a.zip, verifications: { delivery: { success: true, errors: [] } } }
  }
  const ratesFor = (to: Record<string, string>, parcel: Record<string, number>) => {
    if ((parcel.weight ?? 0) > 70 * 16) return []
    const base = 7.33 + (parcel.weight ?? 0) / 16
    const rates = [
      { id: id('rate'), object: 'Rate', carrier: 'USPS', service: 'Priority', rate: base.toFixed(2), currency: 'USD', delivery_days: 2 },
      { id: id('rate'), object: 'Rate', carrier: 'UPS',  service: 'Ground',   rate: (base + 2.1).toFixed(2), currency: 'USD', delivery_days: 4 },
    ]
    if (to.country === 'CA') rates.push({ id: id('rate'), object: 'Rate', carrier: 'CanadaPost', service: 'Expedited', rate: (base * 1.35).toFixed(2), currency: 'CAD', delivery_days: 5 })
    return rates
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, events, shipments: [...shipments.values()] })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false, noFunds: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      if (path === '/_sink/track' && req.method === 'POST') { const { code } = await req.json() as { code: string }; await deliver('tracker.updated', { id: id('trk'), object: 'Tracker', tracking_code: code, carrier: 'USPS', status: 'in_transit', est_delivery_date: null, tracking_details: [{ status: 'in_transit', message: 'Arrived at facility', datetime: new Date().toISOString() }] }); return json({ ok: true }) }
      const text = await req.text()
      const entry = { path, headers: Object.fromEntries(req.headers), body: text, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      if (req.headers.get('authorization') !== `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`) return record(refuse('UNAUTHORIZED', 'Invalid API key', 401))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(refuse('RATE_LIMITED', 'Too many requests', 429, [], { 'retry-after': String(retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(refuse('INTERNAL_SERVER_ERROR', 'Unexpected', 500)) }
      const body = text ? JSON.parse(text) : {}

      if (path === '/v2/addresses' && req.method === 'POST') return record(json(verifyAddr(body.address ?? {}), 201))
      if (path === '/v2/shipments' && req.method === 'POST') {
        const s = body.shipment ?? {}
        const to = s.to_address?.id ? { ...s.to_address, country: s.to_address.country ?? 'US' } : verifyAddr(s.to_address ?? {})
        const from = s.from_address?.id ? s.from_address : verifyAddr(s.from_address ?? {})
        if ((to.country ?? 'US') !== (from.country ?? 'US') && !s.customs_info) return record(refuse('SHIPMENT.CUSTOMS_INFO.REQUIRED', 'customs_info is required for international shipments', 422))
        const rates = ratesFor(to, s.parcel ?? {})
        const row = { id: id('shp'), object: 'Shipment', status: 'unknown', reference: s.reference ?? null, to_address: to, from_address: from, parcel: s.parcel, rates, selected_rate: null, postage_label: null, tracking_code: null, tracker: null, refund_status: null }
        shipments.set(row.id, row)
        return record(json(row, 201))
      }
      const one = path.match(/^\/v2\/shipments\/([^/]+)(?:\/(buy|refund))?$/)
      if (one) {
        const s = shipments.get(decodeURIComponent(one[1]))
        if (!s) return record(refuse('NOT_FOUND', 'The requested resource could not be found.', 404))
        if (!one[2]) return record(json(s))
        if (one[2] === 'buy') {
          if (s.postage_label) return record(refuse('SHIPMENT.POSTAGE.EXISTS', 'This shipment has already been purchased.', 422))
          const rate = s.rates.find((r: { id: string }) => r.id === body.rate?.id)
          if (!rate) return record(refuse('SHIPMENT.RATE.NOT_FOUND', 'The requested rate was not found on this shipment.', 422))
          if (armed.noFunds) { armed.noFunds = false; return record(refuse('PAYMENT_REQUIRED', 'Insufficient funds. Add a payment method or funds to your wallet.', 402)) }
          s.selected_rate = rate; s.postage_label = { id: id('pl'), label_url: `https://labels.example/${s.id}.png` }; s.tracking_code = `9400${(++n).toString().padStart(18, '0')}`; s.status = 'purchased'
          return record(json(s))
        }
        s.refund_status = 'submitted'
        return record(json(s))
      }
      if (path === '/v2/trackers' && req.method === 'POST') return record(json({ id: id('trk'), object: 'Tracker', tracking_code: body.tracker?.tracking_code, carrier: body.tracker?.carrier ?? 'USPS', status: 'pre_transit', est_delivery_date: null, tracking_details: [] }, 201))
      return record(refuse('NOT_FOUND', `no route for ${req.method} ${path}`, 404))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, apiKey: KEY, webhookSecret: SECRET, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) console.log(`[easypost-sink] ${startEasyPostSink({ port: Number(process.env.EASYPOST_SINK_PORT ?? 0), hookUrl: process.env.EASYPOST_HOOK_URL }).url}`)
