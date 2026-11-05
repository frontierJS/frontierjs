// sink.ts — Telnyx, standing in for Telnyx.
//
// Bearer over JSON, `{ data: message }` envelopes, `{ errors: [...] }` refusals,
// and webhooks signed Ed25519 over `"<ts>|<body>"` with a key this listener
// generates at start — the drive reads `publicKey` off the handle, as an app
// reads it off the portal. A number ending `…0000` has texted STOP; one ending
// `…9999` is not a number. Chaos: `{ lost }`, `{ rateLimit }`, `{ failNext }`,
// `{ deliverTwice }`, `{ finalizeFirst }` — the delivery receipt sent BEFORE
// the send is answered, which is the order the two-column rule exists for.

export interface TelnyxSinkOptions { port?: number; key?: string; hookUrl?: string }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (code: string, title: string, status: number, detail?: string, headers: Record<string, string> = {}) =>
  json({ errors: [{ code, title, ...(detail ? { detail } : {}) }] }, status, headers)

let counter = 0
const id = (p: string) => `${p}-${(++counter).toString().padStart(4, '0')}`

export async function startTelnyxSink(opts: TelnyxSinkOptions = {}) {
  const KEY = opts.key ?? 'KEY_dev'
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64')
  const messages = new Map<string, Record<string, unknown>>()
  const seen: { method: string; path: string; body: string; status: number }[] = []
  const events: { id: string; type: string; status: number | null }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false, finalizeFirst: false }
  const hanging: Array<() => void> = []

  async function deliver(type: string, payload: Record<string, unknown>, to = opts.hookUrl) {
    const body = JSON.stringify({ data: { event_type: type, id: id('evt'), occurred_at: new Date().toISOString(), payload }, meta: { attempt: 1, delivered_to: to ?? '' } })
    const ts   = String(Math.floor(Date.now() / 1000))
    const sig  = Buffer.from(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(`${ts}|${body}`))).toString('base64')
    const times = armed.deliverTwice ? 2 : 1; armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      if (!to) { events.push({ id: 'local', type, status: null }); continue }
      try {
        const res = await fetch(to, { method: 'POST', headers: { 'content-type': 'application/json', 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts }, body })
        events.push({ id: 'sent', type, status: res.status })
      } catch { events.push({ id: 'sent', type, status: null }) }
    }
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, events, messages: [...messages.values()] })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false, finalizeFirst: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      // The drive asks the sink to text the app, as a person would.
      if (path === '/_sink/inbound' && req.method === 'POST') {
        const { from, to, text } = await req.json() as { from: string; to: string; text: string }
        await deliver('message.received', { id: id('msg'), record_type: 'message', direction: 'inbound', type: 'SMS', from: { phone_number: from }, to: [{ phone_number: to, status: 'webhook_delivered' }], text })
        return json({ ok: true })
      }

      const text = req.method === 'POST' ? await req.text() : ''
      const entry = { method: req.method, path, body: text, status: 0 }; seen.push(entry)
      const record = (r: Response) => { entry.status = r.status; return r }

      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return record(refuse('10009', 'Authentication failed', 401))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(refuse('10011', 'Too many requests', 429, undefined, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext)  { armed.failNext = false; return record(refuse('10007', 'Unexpected error', 500)) }

      let answer: Response
      if (path === '/v2/messages' && req.method === 'POST') {
        const b = JSON.parse(text) as { from: string; to: string; text?: string; webhook_url?: string }
        if (!/^\+[1-9]\d{7,14}$/.test(b.to)) answer = refuse('40310', 'Invalid phone number', 422, `'${b.to}' is not a valid E.164 number`)
        else if (b.to.endsWith('9999'))       answer = refuse('40310', 'Invalid phone number', 422, 'the number is not routable')
        else if (b.to.endsWith('0000'))       answer = refuse('40300', 'Blocked due to STOP message', 422, 'the recipient has opted out')
        else {
          const msg = { id: id('msg'), record_type: 'message', direction: 'outbound', type: 'SMS', from: { phone_number: b.from }, to: [{ phone_number: b.to, status: 'queued' }], text: b.text, sent_at: null, completed_at: null }
          messages.set(msg.id, msg)
          // The send's answer is the snapshot at send time, even when the
          // receipt went out first: that is the order a real carrier produces.
          const snapshot = JSON.stringify({ data: msg })
          const finalize = async () => { msg.to[0].status = 'delivered'; msg.completed_at = new Date().toISOString(); await deliver('message.finalized', msg, b.webhook_url ?? opts.hookUrl) }
          if (armed.finalizeFirst) { armed.finalizeFirst = false; await finalize() } else setTimeout(finalize, 20)
          answer = new Response(snapshot, { status: 200, headers: { 'content-type': 'application/json' } })
        }
      } else {
        const m = path.match(/^\/v2\/messages\/([^/]+)$/)
        if (m && req.method === 'GET') { const msg = messages.get(decodeURIComponent(m[1])); answer = msg ? json({ data: msg }) : refuse('10005', 'Resource not found', 404) }
        else answer = refuse('10005', 'Resource not found', 404)
      }
      if (armed.lost) { armed.lost = false; await new Promise<void>(r => hanging.push(r)) }
      return record(answer)
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, publicKey, stop() { for (const r of hanging) r(); server.stop(true) } }
}

if (import.meta.main) startTelnyxSink({ port: Number(process.env.TELNYX_SINK_PORT ?? 0), hookUrl: process.env.TELNYX_HOOK_URL }).then(s => console.log(`[telnyx-sink] ${s.url} publicKey=${s.publicKey}`))
