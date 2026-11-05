// sink.ts — Resend, standing in for Resend.
//
// Bearer key, JSON in, `{ id }` out, and Svix-signed webhooks for bounces and
// complaints. The chaos it owns: `{ lost }` applies the send and never
// answers (a retry is a SECOND email — the sink counts them), `{ rateLimit }`
// one 429 with `Retry-After`, `{ quota }` the daily 429, `{ failNext }` a 500,
// `{ deliverTwice }` a duplicated event, `{ rotatedSecret }` signs the next
// event with two secrets. An address under `bounce.example` bounces.

import { createHmac } from 'node:crypto'

export interface ResendSinkOptions { port?: number; key?: string; webhookSecret?: string; oldSecret?: string; hookUrl?: string }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const fail = (name: string, message: string, status: number, headers: Record<string, string> = {}) =>
  json({ statusCode: status, name, message }, status, headers)

let counter = 0
const id = (p: string) => `${p}-${(++counter).toString().padStart(4, '0')}`

export function startResendSink(opts: ResendSinkOptions = {}) {
  const KEY = opts.key ?? 're_dev', SECRET = opts.webhookSecret ?? `whsec_${Buffer.from('dev-secret').toString('base64')}`
  const OLD = opts.oldSecret ?? `whsec_${Buffer.from('old-secret').toString('base64')}`
  const sent: { id: string; to: string[]; subject: string; attachments: unknown[] }[] = []
  const seen: { method: string; path: string; headers: Record<string, string>; body: string }[] = []
  const events: { id: string; type: string; status: number | null }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, quota: false, deliverTwice: false, rotatedSecret: false }
  const hanging: Array<() => void> = []

  const sign = (secret: string, svixId: string, ts: number, body: string) =>
    `v1,${createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${svixId}.${ts}.${body}`).digest('base64')}`

  async function deliver(type: string, data: Record<string, unknown>) {
    const svixId = id('msg')
    const body   = JSON.stringify({ type, created_at: new Date().toISOString(), data })
    const ts     = Math.floor(Date.now() / 1000)
    const sigs   = armed.rotatedSecret ? `${sign(OLD, svixId, ts, body)} ${sign(SECRET, svixId, ts, body)}` : sign(SECRET, svixId, ts, body)
    const times  = armed.deliverTwice ? 2 : 1
    armed.rotatedSecret = false; armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      if (!opts.hookUrl) { events.push({ id: svixId, type, status: null }); continue }
      try {
        const res = await fetch(opts.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': svixId, 'svix-timestamp': String(ts), 'svix-signature': sigs }, body })
        events.push({ id: svixId, type, status: res.status })
      } catch { events.push({ id: svixId, type, status: null }) }
    }
  }

  async function accept(email: Record<string, unknown>): Promise<{ id: string } | Response> {
    const to = Array.isArray(email.to) ? email.to as string[] : []
    if (!to.length || !email.from || !email.subject) return fail('validation_error', 'Missing `to`, `from` or `subject` field.', 422)
    if (!email.html && !email.text) return fail('validation_error', 'Missing `html` or `text` field.', 422)
    const row = { id: id('email'), to, subject: String(email.subject), attachments: Array.isArray(email.attachments) ? email.attachments : [] }
    sent.push(row)
    if (to.some(a => a.endsWith('@bounce.example')))
      await deliver('email.bounced', { email_id: row.id, to, from: email.from, subject: email.subject, bounce: { type: 'Permanent', subType: 'General', message: 'The recipient address does not exist' } })
    return { id: row.id }
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, sent, events })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; sent.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, quota: false, deliverTwice: false, rotatedSecret: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }

      const text = req.method === 'POST' ? await req.text() : ''
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: text })
      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return fail('validation_error', 'API key is invalid', 401)
      if ((req.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/json') return fail('invalid_parameter', 'Content-Type must be application/json', 415)
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return fail('rate_limit_exceeded', 'Too many requests. You can only make 2 requests per second.', 429, { 'retry-after': String(retryAfter) }) }
      if (armed.quota)     { armed.quota = false; return fail('daily_quota_exceeded', 'You have reached your daily email sending quota.', 429) }
      if (armed.failNext)  { armed.failNext = false; return fail('internal_server_error', 'Something went wrong', 500) }

      let body: unknown
      try { body = JSON.parse(text) } catch { return fail('invalid_parameter', 'body is not JSON', 400) }
      let answer: Response
      if (path === '/emails' && req.method === 'POST') {
        const r = await accept(body as Record<string, unknown>)
        answer = r instanceof Response ? r : json(r)
      } else if (path === '/emails/batch' && req.method === 'POST') {
        const out: { id: string }[] = []
        for (const e of body as Record<string, unknown>[]) { const r = await accept(e); if (r instanceof Response) return r; out.push(r) }
        answer = json({ data: out })
      } else return fail('not_found', `No route for ${req.method} ${path}`, 404)

      if (armed.lost) { armed.lost = false; await new Promise<void>(r => hanging.push(r)) }
      return answer
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, secret: SECRET, oldSecret: OLD, stop() { for (const r of hanging) r(); server.stop(true) } }
}

if (import.meta.main) console.log(`[resend-sink] ${startResendSink({ port: Number(process.env.RESEND_SINK_PORT ?? 0), hookUrl: process.env.RESEND_HOOK_URL }).url}`)
