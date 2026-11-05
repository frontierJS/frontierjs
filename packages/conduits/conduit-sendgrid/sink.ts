// sink.ts — SendGrid, standing in for SendGrid.
//
// Bearer over JSON; a 202 with NO body and the id in `X-Message-Id`; refusals
// as `{ errors: [{ message, field, help }] }`; `sandbox_mode` answering 200
// with no id and still refusing a bad sender; event webhooks as a JSON ARRAY
// signed ECDSA P-256 over `timestamp + body` with a key this listener
// generates at start — `publicKey` on the handle is the base64 SPKI the
// settings page shows. Domains: `whitelabel/domains` hands back three CNAMEs
// and `validate` answers `valid: false` until `dnsAfter` polls have passed.
// Chaos: `{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ deliverTwice }`.

import { createSign, generateKeyPairSync } from 'node:crypto'

export interface SendgridSinkOptions { port?: number; key?: string; hookUrl?: string; /** validate calls before a domain reads valid */ dnsAfter?: number }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (status: number, message: string, field: string | null = null, headers: Record<string, string> = {}) =>
  json({ errors: [{ message, field, help: null }] }, status, headers)

let counter = 0
const id = (p: string) => `${p}-${(++counter).toString().padStart(4, '0')}`

export async function startSendgridSink(opts: SendgridSinkOptions = {}) {
  const KEY = opts.key ?? 'SG.dev'
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const publicKey = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const seen: { method: string; path: string; body: string; status: number }[] = []
  const events: { type: string; status: number | null }[] = []
  const domains = new Map<number, Record<string, unknown> & { validations: number }>()
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false }
  const hanging: Array<() => void> = []
  let domainSeq = 1000

  async function deliver(batch: Record<string, unknown>[], to = opts.hookUrl) {
    const body = JSON.stringify(batch)
    const ts   = String(Math.floor(Date.now() / 1000))
    const signer = createSign('sha256'); signer.update(ts + body)
    const sig  = signer.sign({ key: pair.privateKey, dsaEncoding: 'der' }).toString('base64')
    const times = armed.deliverTwice ? 2 : 1; armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      if (!to) { events.push({ type: String(batch[0]?.event), status: null }); continue }
      try {
        const res = await fetch(to, { method: 'POST', headers: { 'content-type': 'application/json', 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': ts }, body })
        events.push({ type: String(batch[0]?.event), status: res.status })
      } catch { events.push({ type: String(batch[0]?.event), status: null }) }
    }
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, events, domains: [...domains.values()] })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }

      const text = req.method === 'POST' ? await req.text() : ''
      const entry = { method: req.method, path, body: text, status: 0 }; seen.push(entry)
      const record = (r: Response) => { entry.status = r.status; return r }

      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return record(refuse(401, 'The provided authorization grant is invalid, expired, or revoked'))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(refuse(429, 'too many requests', null, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext)  { armed.failNext = false; return record(refuse(500, 'internal error')) }

      let answer: Response
      if (path === '/v3/mail/send' && req.method === 'POST') {
        const b = JSON.parse(text) as { from?: { email?: string }; reply_to?: { email?: string }; personalizations?: { to?: { email: string }[] }[]; custom_args?: Record<string, string>; mail_settings?: { sandbox_mode?: { enable?: boolean } } }
        const sandbox = b.mail_settings?.sandbox_mode?.enable === true
        if (!b.from?.email?.includes('@'))            answer = refuse(400, 'The from email does not contain a valid address.', 'from.email')
        else if (b.reply_to && !b.reply_to.email)      answer = refuse(400, 'The reply_to email does not contain a valid address.', 'reply_to.email')
        else if (b.from.email.endsWith('@unverified.test')) answer = refuse(403, 'The from address does not match a verified Sender Identity.', 'from')
        else if (sandbox)                              answer = new Response(null, { status: 200 })
        else {
          const mid = id('msg')
          const to  = b.personalizations?.[0]?.to?.[0]?.email ?? ''
          const base = { email: to, sg_message_id: `${mid}.filter0001`, ...(b.custom_args ?? {}) }
          const at = Math.floor(Date.now() / 1000)
          // Processed and delivered arrive in one batch, as SendGrid batches them.
          setTimeout(() => deliver([{ ...base, event: 'processed', timestamp: at, sg_event_id: id('evt') }, { ...base, event: 'delivered', timestamp: at + 1, sg_event_id: id('evt'), response: '250 OK' }]), 20)
          answer = new Response(null, { status: 202, headers: { 'x-message-id': mid } })
        }
      } else if (path === '/v3/whitelabel/domains' && req.method === 'POST') {
        const b = JSON.parse(text) as { domain: string; subdomain?: string; default?: boolean }
        if ([...domains.values()].some(d => d.domain === b.domain)) answer = refuse(400, 'The domain name is already authenticated on this account.', 'domain')
        else {
          const did = ++domainSeq, sub = b.subdomain ?? 'mail'
          const d = { id: did, domain: b.domain, subdomain: sub, valid: false, default: b.default ?? false, validations: 0, dns: {
            mail_cname: { valid: false, type: 'cname', host: `${sub}.${b.domain}`, data: `u${did}.wl.sendgrid.net` },
            dkim1:      { valid: false, type: 'cname', host: `s1._domainkey.${b.domain}`, data: `s1.domainkey.u${did}.wl.sendgrid.net` },
            dkim2:      { valid: false, type: 'cname', host: `s2._domainkey.${b.domain}`, data: `s2.domainkey.u${did}.wl.sendgrid.net` },
          } }
          domains.set(did, d)
          answer = json(strip(d), 201)
        }
      } else if (path === '/v3/whitelabel/domains' && req.method === 'GET') {
        answer = json([...domains.values()].map(strip))
      } else {
        const m = path.match(/^\/v3\/whitelabel\/domains\/(\d+)(\/validate)?$/)
        const d = m ? domains.get(Number(m[1])) : undefined
        if (!m)                                     answer = refuse(404, 'resource not found')
        else if (!d)                                answer = refuse(404, 'The domain could not be found.')
        else if (m[2] && req.method === 'POST') {
          d.validations++
          if (d.validations >= (opts.dnsAfter ?? 2)) { d.valid = true; for (const r of Object.values(d.dns as Record<string, { valid: boolean }>)) r.valid = true }
          answer = json({ id: d.id, valid: d.valid, validation_results: {} })
        }
        else if (req.method === 'GET')              answer = json(strip(d))
        else if (req.method === 'DELETE')           { domains.delete(d.id as number); answer = new Response(null, { status: 204 }) }
        else                                        answer = refuse(405, 'method not allowed')
      }
      if (armed.lost) { armed.lost = false; await new Promise<void>(r => hanging.push(r)) }
      return record(answer)
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, publicKey, stop() { for (const r of hanging) r(); server.stop(true) } }
}

const strip = ({ validations: _v, ...d }: Record<string, unknown>) => d

if (import.meta.main) startSendgridSink({ port: Number(process.env.SENDGRID_SINK_PORT ?? 0), hookUrl: process.env.SENDGRID_HOOK_URL }).then(s => console.log(`[sendgrid-sink] ${s.url} publicKey=${s.publicKey}`))
