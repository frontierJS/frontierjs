// sink.ts — Postmark, standing in for Postmark.
//
// `X-Postmark-Server-Token`, JSON, PascalCase; a 422 `{ ErrorCode, Message }`
// refusal; a batch answering per-message codes on a 200; and the inbound
// half: `POST /_sink/inbound` makes the sink deliver a parsed message to the
// hook URL with the URL's Basic credential (as Postmark does), and an address
// under `@bounce.example` produces a `Bounce` webhook with `Inactive: true`.
// Chaos: `{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ deliverTwice }`.

export interface PostmarkSinkOptions { port?: number; token?: string; hookUrl?: string; bounceHookUrl?: string }
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (ErrorCode: number, Message: string, status = 422, headers: Record<string, string> = {}) => json({ ErrorCode, Message }, status, headers)
let n = 0
const guid = () => `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`

export function startPostmarkSink(opts: PostmarkSinkOptions = {}) {
  const TOKEN = opts.token ?? 'pm-server-token-dev'
  const sent: { MessageID: string; To: string }[] = []
  const seen: { path: string; headers: Record<string, string>; body: string; status: number }[] = []
  const events: { type: string; status: number | null }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false }
  const hanging: Array<() => void> = []

  async function deliver(url: string | undefined, type: string, payload: unknown) {
    const times = armed.deliverTwice ? 2 : 1; armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      if (!url) { events.push({ type, status: null }); continue }
      // Postmark reads the Basic credential OUT OF THE URL and sends it as a header.
      const u = new URL(url)
      const auth: Record<string, string> = u.username ? { authorization: `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}` } : {}
      u.username = ''; u.password = ''
      try { const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify(payload) }); events.push({ type, status: res.status }) }
      catch { events.push({ type, status: null }) }
    }
  }

  function accept(e: Record<string, string>): { MessageID: string } | { ErrorCode: number; Message: string } {
    if (!e.From || !e.To || !e.Subject) return { ErrorCode: 300, Message: "Zero recipients specified or 'From' address is missing." }
    if (!/^[^@\s,]+@[^@\s,]+$/.test(e.To.split(',')[0].trim().replace(/^.*<|>$/g, ''))) return { ErrorCode: 300, Message: `Invalid 'To' address: '${e.To}'.` }
    if (e.To.includes('@inactive.example')) return { ErrorCode: 406, Message: 'You tried to send to a recipient that has been marked as inactive.' }
    if (!e.HtmlBody && !e.TextBody) return { ErrorCode: 300, Message: 'Provide either email TextBody or HtmlBody or both.' }
    const row = { MessageID: guid(), To: e.To }; sent.push(row)
    if (e.To.includes('@bounce.example')) void deliver(opts.bounceHookUrl ?? opts.hookUrl, 'Bounce', { RecordType: 'Bounce', ID: n, Type: 'HardBounce', TypeCode: 1, Email: e.To, MessageID: row.MessageID, Description: 'The server was unable to deliver your message', Inactive: true })
    return row
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, sent, events })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; sent.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false }); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      if (path === '/_sink/inbound' && req.method === 'POST') {
        const m = await req.json() as Record<string, string>
        await deliver(opts.hookUrl, 'Inbound', { MessageID: guid(), From: m.from, FromName: m.fromName ?? '', FromFull: { Email: m.from, Name: m.fromName ?? '' }, To: m.to, OriginalRecipient: m.to, Subject: m.subject, Date: new Date().toUTCString(), TextBody: m.text, MailboxHash: m.hash ?? '', Headers: m.messageId ? [{ Name: 'Message-ID', Value: m.messageId }] : [], Attachments: [] })
        return json({ ok: true })
      }
      const text = await req.text()
      const entry = { path, headers: Object.fromEntries(req.headers), body: text, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      if (req.headers.get('x-postmark-server-token') !== TOKEN) return record(refuse(10, 'No Account or Server API tokens were supplied, or the tokens were invalid.', 401))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(refuse(429, 'Rate limit exceeded', 429, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(json({ ErrorCode: 0, Message: 'Internal error' }, 500)) }
      let body: unknown
      try { body = JSON.parse(text) } catch { return record(refuse(300, 'Invalid JSON', 422)) }
      if (path === '/email' && req.method === 'POST') {
        const r = accept(body as Record<string, string>)
        return record('MessageID' in r ? json({ To: (body as Record<string, string>).To, SubmittedAt: new Date().toISOString(), MessageID: r.MessageID, ErrorCode: 0, Message: 'OK' }) : refuse(r.ErrorCode, r.Message))
      }
      if (path === '/email/batch' && req.method === 'POST') {
        const out = (body as Record<string, string>[]).map(e => { const r = accept(e); return 'MessageID' in r ? { To: e.To, SubmittedAt: new Date().toISOString(), MessageID: r.MessageID, ErrorCode: 0, Message: 'OK' } : { To: e.To, ErrorCode: r.ErrorCode, Message: r.Message } })
        return record(json(out))
      }
      return record(refuse(0, `No route for ${req.method} ${path}`, 404))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, token: TOKEN, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) console.log(`[postmark-sink] ${startPostmarkSink({ port: Number(process.env.POSTMARK_SINK_PORT ?? 0), hookUrl: process.env.POSTMARK_HOOK_URL }).url}`)
