// sink.ts — Mailgun, standing in for Mailgun.
//
// Basic `api:<key>`, form-encoded sends under `/v3/{domain}/messages`, a 400
// `{ message }` refusal in Mailgun's own wording, and `/v3/{domain}/events`
// listing what was accepted. The inbound half: `POST /_sink/inbound` makes the
// sink write a raw RFC 5322 message the way a sender's mail client does —
// encoded words in the headers, quoted-printable text, base64 parts — and
// forward it to the hook URL as a route whose URL ends in `mime` does: a
// multipart form carrying the envelope, `body-mime`, and a signature over
// `timestamp + token` under the signing key. A second delivery is re-signed
// with a NEW token, which is what Mailgun's retry does.
// Chaos: `{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ deliverTwice }`.

import { createHmac, randomBytes } from 'node:crypto'

export interface MailgunSinkOptions { port?: number; key?: string; signingKey?: string; hookUrl?: string }
export interface InboundSpec {
  from: string; fromName?: string; to: string; subject?: string; text?: string
  /** `null` writes no Message-ID header at all. */
  messageId?: string | null; inReplyTo?: string
  attachments?: { name: string; type: string; base64: string; cid?: string }[]
}

const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (message: string, status = 400, headers: Record<string, string> = {}) => json({ message }, status, headers)
let n = 0
const msgId = (domain: string) => `<${Date.now().toString(36)}.${(++n).toString(36)}@${domain}>`

/** RFC 2047 B-encoding for a header value that is not ASCII. */
const word = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`

/** Quoted-printable, line by line; a line break stays a line break. */
function qp(s: string): string {
  return s.split('\n').map(line => {
    let out = ''
    for (const b of Buffer.from(line.replace(/\r$/, ''), 'utf8'))
      out += (b >= 33 && b <= 126 && b !== 61) || b === 32 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`
    return out
  }).join('\r\n')
}

/** The message as a sender's mail client writes it. */
export function rawMime(m: InboundSpec, domain: string): string {
  const text = m.text ?? ''
  const body = /^[\x00-\x7f]*$/.test(text)
    ? ['Content-Type: text/plain; charset=utf-8', '', text]
    : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', qp(text)]
  const parts = m.attachments?.length ? multipart(body, m.attachments) : body
  return [
    `From: ${m.fromName ? `${word(m.fromName)} <${m.from}>` : m.from}`,
    `To: ${m.to}`,
    `Subject: ${word(m.subject ?? '')}`,
    ...(m.messageId === null ? [] : [`Message-ID: ${m.messageId ?? msgId(domain)}`]),
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    ...parts,
  ].join('\r\n')
}

/** multipart/mixed: the text part, then each file in base64, its name RFC 2231-encoded; a `cid` makes it an inline part. */
function multipart(body: string[], files: NonNullable<InboundSpec['attachments']>): string[] {
  const b = `b${randomBytes(8).toString('hex')}`
  return [
    `Content-Type: multipart/mixed; boundary="${b}"`,
    '',
    `--${b}`, ...body,
    ...files.flatMap(f => [
      `--${b}`,
      `Content-Type: ${f.type}`,
      `Content-Disposition: ${f.cid ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      ...(f.cid ? [`Content-ID: <${f.cid}>`] : []),
      'Content-Transfer-Encoding: base64',
      '',
      f.base64,
    ]),
    `--${b}--`,
    '',
  ]
}

export function startMailgunSink(opts: MailgunSinkOptions = {}) {
  const KEY     = opts.key ?? 'key-mailgun-dev'
  const SIGNING = opts.signingKey ?? 'whsec-mailgun-dev'
  const BASIC   = `Basic ${Buffer.from(`api:${KEY}`).toString('base64')}`
  const sent: { id: string; domain: string; to: string; tag: string | null; variables: Record<string, string> }[] = []
  const seen: { path: string; headers: Record<string, string>; body: string; status: number }[] = []
  const events: { type: string; status: number | null }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false }
  const hanging: Array<() => void> = []

  async function forward(spec: InboundSpec): Promise<string> {
    const times = armed.deliverTwice ? 2 : 1; armed.deliverTwice = false
    const raw = rawMime(spec, spec.from.split('@')[1] ?? 'example.org')
    for (let i = 0; i < times; i++) {
      if (!opts.hookUrl) { events.push({ type: 'Inbound', status: null }); continue }
      const timestamp = String(Math.floor(Date.now() / 1000)), token = randomBytes(25).toString('hex')
      const signature = createHmac('sha256', SIGNING).update(timestamp + token).digest('hex')
      const form = new FormData()
      const fields = { recipient: spec.to, sender: spec.from, from: spec.fromName ? `${spec.fromName} <${spec.from}>` : spec.from, subject: spec.subject ?? '', timestamp, token, signature, 'body-mime': raw }
      for (const [k, v] of Object.entries(fields)) form.set(k, v)
      try { const res = await fetch(opts.hookUrl, { method: 'POST', body: form }); events.push({ type: 'Inbound', status: res.status }) }
      catch { events.push({ type: 'Inbound', status: null }) }
    }
    return raw
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, sent, events })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; sent.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      if (path === '/_sink/inbound' && req.method === 'POST') return json({ ok: true, raw: await forward(await req.json() as InboundSpec) })
      const text = await req.text()
      const entry = { path, headers: Object.fromEntries(req.headers), body: text, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      if (req.headers.get('authorization') !== BASIC) return record(new Response('Forbidden', { status: 401 }))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(refuse('Too many requests', 429, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(refuse('Internal server error', 500)) }
      const messages = path.match(/^\/v3\/([^/]+)\/messages$/), eventsAt = path.match(/^\/v3\/([^/]+)\/events$/)
      if (messages && req.method === 'POST') {
        const domain = decodeURIComponent(messages[1])
        if (domain === 'nobody.example') return record(refuse(`Domain not found: ${domain}`, 404))
        const p = new URLSearchParams(text)
        const from = p.get('from'), to = p.get('to')
        if (!from) return record(refuse("'from' parameter is missing"))
        if (!to)   return record(refuse("'to' parameter is missing"))
        if (!/^[^@\s,]+@[^@\s,]+$/.test(to.split(',')[0].trim().replace(/^.*<|>$/g, ''))) return record(refuse("'to' parameter is not a valid address. please check documentation"))
        if (!p.get('text') && !p.get('html')) return record(refuse("Need at least one of 'text' or 'html' parameters specified"))
        const variables: Record<string, string> = {}
        for (const [k, v] of p) if (k.startsWith('v:')) variables[k.slice(2)] = v
        const row = { id: msgId(domain), domain, to, tag: p.get('o:tag'), variables }; sent.push(row)
        return record(json({ id: row.id, message: 'Queued. Thank you.' }))
      }
      if (eventsAt && req.method === 'GET') {
        const domain = decodeURIComponent(eventsAt[1])
        const items = sent
          .filter(s => s.domain === domain)
          .filter(s => [...url.searchParams].every(([k, v]) => k === 'event' ? v === 'accepted' : k === 'limit' || (k === 'tags' ? s.tag === v : s.variables[k] === v)))
          .map(s => ({ id: randomBytes(8).toString('base64url'), event: 'accepted', timestamp: Date.now() / 1000, recipient: s.to, tags: s.tag ? [s.tag] : [], 'user-variables': s.variables, message: { headers: { 'message-id': s.id.replace(/^<|>$/g, '') } } }))
        return record(json({ items, paging: {} }))
      }
      return record(refuse(`No route for ${req.method} ${path}`, 404))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, key: KEY, signingKey: SIGNING, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) console.log(`[mailgun-sink] ${startMailgunSink({ port: Number(process.env.MAILGUN_SINK_PORT ?? 0), hookUrl: process.env.MAILGUN_HOOK_URL }).url}`)
