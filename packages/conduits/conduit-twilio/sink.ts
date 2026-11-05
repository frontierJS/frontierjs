// sink.ts — Twilio, standing in for Twilio.
//
// Basic auth checked against `AccountSid:AuthToken`, form bodies (a JSON body
// is refused with Twilio's 400), snake_case JSON back, `{ code, message }`
// refusals. `…0000` has texted STOP (21610), `…9999` is not a mobile (21211),
// `…8888` is a 10DLC refusal (30034). A send with `StatusCallback` POSTs a
// signed status update there. Chaos: `{ lost }`, `{ rateLimit }`,
// `{ failNext }`, `{ deliverTwice }`; `POST /_sink/inbound` texts the app.

import { createHmac } from 'node:crypto'

export interface TwilioSinkOptions { port?: number; accountSid?: string; authToken?: string }
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (code: number, message: string, status: number, headers: Record<string, string> = {}) => json({ code, message, more_info: `https://www.twilio.com/docs/errors/${code}`, status }, status, headers)
let n = 0
const sid = (p: string) => `${p}${(++n).toString(16).padStart(32, '0')}`

export function startTwilioSink(opts: TwilioSinkOptions = {}) {
  const SID = opts.accountSid ?? 'ACdev00000000000000000000000000000', TOKEN = opts.authToken ?? 'authtoken-dev'
  const messages = new Map<string, Record<string, unknown>>()
  const seen: { path: string; headers: Record<string, string>; body: string; status: number }[] = []
  const events: { type: string; status: number | null }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false }
  const hanging: Array<() => void> = []

  async function post(url: string, params: Record<string, string>, type: string) {
    const body = new URLSearchParams(params).toString()
    const sig  = createHmac('sha1', TOKEN).update(url + Object.keys(params).sort().map(k => k + params[k]).join('')).digest('base64')
    const times = armed.deliverTwice ? 2 : 1; armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      try { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body }); events.push({ type, status: r.status }) }
      catch { events.push({ type, status: null }) }
    }
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, events, messages: [...messages.values()] })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      if (path === '/_sink/inbound' && req.method === 'POST') {
        const m = await req.json() as { url: string; from: string; to: string; body: string }
        await post(m.url, { MessageSid: sid('SM'), AccountSid: SID, From: m.from, To: m.to, Body: m.body, NumMedia: '0' }, 'inbound')
        return json({ ok: true })
      }
      const text = await req.text()
      const entry = { path, headers: Object.fromEntries(req.headers), body: text, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      if (req.headers.get('authorization') !== `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`) return record(refuse(20003, 'Authenticate', 401))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(refuse(20429, 'Too Many Requests', 429, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(refuse(20500, 'Internal Server Error', 500)) }
      const acct = path.match(/^\/2010-04-01\/Accounts\/([^/]+)\/Messages(?:\/([^/]+))?\.json$/)
      if (!acct) return record(refuse(20404, `The requested resource ${path} was not found`, 404))
      if (acct[1] !== SID) return record(refuse(20404, 'The requested resource was not found', 404))
      if (acct[2]) { const m = messages.get(acct[2]); return record(m ? json(m) : refuse(20404, 'Message not found', 404)) }
      if (req.method !== 'POST') return record(refuse(20404, 'not found', 404))
      if ((req.headers.get('content-type') ?? '').split(';')[0] !== 'application/x-www-form-urlencoded') return record(refuse(20001, 'Content-Type must be application/x-www-form-urlencoded', 400))
      const f = new URLSearchParams(text)
      const to = f.get('To') ?? ''
      if (!/^\+[1-9]\d{7,14}$/.test(to) || to.endsWith('9999')) return record(refuse(21211, `The 'To' number ${to} is not a valid phone number.`, 400))
      if (to.endsWith('0000')) return record(refuse(21610, 'Attempt to send to unsubscribed recipient', 400))
      if (to.endsWith('8888')) return record(refuse(30034, 'US A2P 10DLC - Message from an Unregistered Number', 400))
      if (!f.get('Body') && !f.get('MediaUrl')) return record(refuse(21602, "Message body is required.", 400))
      const msg = { sid: sid('SM'), account_sid: SID, from: f.get('From'), to, body: f.get('Body') ?? '', status: 'queued', error_code: null, error_message: null, date_sent: null, num_segments: '1' }
      messages.set(msg.sid, msg)
      const cb = f.get('StatusCallback')
      if (cb) setTimeout(() => { msg.status = 'delivered'; void post(cb, { MessageSid: msg.sid, MessageStatus: 'delivered', AccountSid: SID, From: msg.from ?? '', To: to }, 'status') }, 20)
      return record(json(msg, 201))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, accountSid: SID, authToken: TOKEN, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) console.log(`[twilio-sink] ${startTwilioSink({ port: Number(process.env.TWILIO_SINK_PORT ?? 0) }).url}`)
