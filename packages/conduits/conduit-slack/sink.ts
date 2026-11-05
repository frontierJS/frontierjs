// sink.ts — Slack, standing in for Slack.
//
// A dev listener that speaks both dialects on one port: `/api/chat.postMessage`
// with a bearer bot token answering HTTP 200 whether it worked or not, and
// `/services/T000/B000/<token>` incoming webhooks answering `text/plain`. It
// is a SEPARATE LISTENER so the 200-that-fails travels a real wire and meets
// conduit's status grading, which is what the `validate` row is about. The
// JSON is parsed by hand and the charset is checked, as Slack checks it.
//
// Chaos under `/_sink/arm`: `{ lost }` applies and never answers, `{ rateLimit:
// { retryAfter } }` is one 429 with `Retry-After` and `ok: false, ratelimited`,
// `{ failNext }` is one 200 `fatal_error`, `{ deliverTwice }` sends the next
// event again under `X-Slack-Retry-Num: 1`. The vendor's own refusals are by
// channel name: `#missing` is `channel_not_found`, `#locked` is `not_in_channel`,
// text over 4000 characters is `msg_too_long`.
//
// `POST /_sink/event { type, event, challenge? }` signs a body the way Slack
// does and POSTs it to `hookUrl`, so the drive's receiver meets a real request.

import { createHmac } from 'node:crypto'

export interface SlackSinkOptions {
  port?:          number
  /** What this stand-in accepts as the bot token. */
  token?:         string
  /** The last path segment of the one live webhook. */
  webhookToken?:  string
  /** What it signs events with. */
  signingSecret?: string
  /** Where it POSTs events; none means events are recorded and not sent. */
  hookUrl?:       string
}

export const MSG_LIMIT = 4000

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
const text = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } })
const notOk = (error: string, status = 200, headers: Record<string, string> = {}) => json({ ok: false, error }, status, headers)

let counter = 0
const ts = () => `${Math.floor(Date.now() / 1000)}.${(++counter).toString().padStart(6, '0')}`

export function startSlackSink(opts: SlackSinkOptions = {}) {
  const TOKEN   = opts.token ?? 'xoxb-dev'
  const HOOK    = opts.webhookToken ?? 'live'
  const SECRET  = opts.signingSecret ?? 'signing_dev'
  const seen: { method: string; path: string; headers: Record<string, string>; body: string; at: number }[] = []
  const messages: { channel: string; ts: string; text?: string; blocks?: unknown; thread_ts?: string; via: 'api' | 'webhook' }[] = []
  const events: { id: string; type: string; retry: number | null; status: number | null }[] = []
  const armed = { failNext: false, lost: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false }
  const hanging: Array<() => void> = []
  const disarm = () => Object.assign(armed, { failNext: false, lost: false, rateLimit: null, deliverTwice: false })

  async function deliver(body: Record<string, unknown>) {
    const id   = typeof body.event_id === 'string' ? body.event_id : `Ev${(++counter).toString(36).toUpperCase().padStart(8, '0')}`
    const type = String(body.type ?? 'event_callback')
    const payload = JSON.stringify(type === 'url_verification' ? { type, token: 'verify', ...body } : { type, team_id: 'T000', api_app_id: 'A000', event_time: Math.floor(Date.now() / 1000), ...body, event_id: id })
    const times = armed.deliverTwice ? 2 : 1
    armed.deliverTwice = false
    for (let i = 0; i < times; i++) {
      const retry = i === 0 ? null : i
      if (!opts.hookUrl) { events.push({ id, type, retry, status: null }); continue }
      const t   = String(Math.floor(Date.now() / 1000))
      const sig = 'v0=' + createHmac('sha256', SECRET).update(`v0:${t}:${payload}`).digest('hex')
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': t }
      if (retry !== null) { headers['x-slack-retry-num'] = String(retry); headers['x-slack-retry-reason'] = 'http_timeout' }
      try {
        const res = await fetch(opts.hookUrl, { method: 'POST', headers, body: payload })
        events.push({ id, type, retry, status: res.status, ...(type === 'url_verification' ? { echoed: await res.text() } : {}) } as never)
      } catch { events.push({ id, type, retry, status: null }) }
    }
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const path = new URL(req.url).pathname

      if (path === '/_sink/seen')  return json({ requests: seen, messages, events })
      if (path === '/_sink/reset') { seen.length = 0; events.length = 0; disarm(); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }
      if (path === '/_sink/event') { await deliver(await req.json() as Record<string, unknown>); return json({ ok: true, events }) }

      const raw = req.method === 'POST' ? await req.text() : ''
      seen.push({ method: req.method, path, headers: Object.fromEntries(req.headers), body: raw, at: Date.now() })

      let answer: Response
      const ct = (req.headers.get('content-type') ?? '').split(';')[0].trim()
      let body: Record<string, unknown> | null = null
      if (ct === 'application/json') { try { body = JSON.parse(raw) } catch { body = null } }

      if (armed.rateLimit) {
        const { retryAfter } = armed.rateLimit; armed.rateLimit = null
        answer = notOk('ratelimited', 429, { 'retry-after': String(retryAfter) })
      } else if (path === '/api/chat.postMessage') {
        answer = postMessage(req, body, ct)
      } else if (path.startsWith('/services/')) {
        answer = webhook(path, body, ct)
      } else {
        answer = notOk('unknown_method', 404)
      }

      // A lost response: the message is POSTED and the answer never leaves.
      // Slack collapses nothing, so a replay here is a second message, which is
      // why the connector hands `indeterminate` to the caller instead.
      if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
      return answer
    },
  })

  function postMessage(req: Request, body: Record<string, unknown> | null, ct: string): Response {
    if (req.headers.get('authorization') !== `Bearer ${TOKEN}`) return notOk('invalid_auth')
    if (armed.failNext) { armed.failNext = false; return notOk('fatal_error') }
    if (!body) return notOk(ct === 'application/json' ? 'invalid_json' : 'invalid_form_data')
    const channel = String(body.channel ?? '')
    if (!channel)                                   return notOk('channel_not_found')
    if (channel === '#missing')                     return notOk('channel_not_found')
    if (channel === '#locked')                      return notOk('not_in_channel')
    if (body.blocks !== undefined && !Array.isArray(body.blocks)) return notOk('invalid_blocks')
    const txt = body.text === undefined ? undefined : String(body.text)
    if (txt === undefined && !(body.blocks as unknown[] | undefined)?.length) return notOk('no_text')
    if (txt !== undefined && txt.length > MSG_LIMIT) return notOk('msg_too_long')
    const message = { channel, ts: ts(), ...(txt !== undefined ? { text: txt } : {}), ...(body.blocks ? { blocks: body.blocks } : {}), ...(body.thread_ts ? { thread_ts: String(body.thread_ts) } : {}), via: 'api' as const }
    messages.push(message)
    return json({ ok: true, channel, ts: message.ts, message: { text: txt, blocks: body.blocks, ts: message.ts, thread_ts: message.thread_ts } })
  }

  function webhook(path: string, body: Record<string, unknown> | null, ct: string): Response {
    const m = path.match(/^\/services\/T000\/B000\/([^/]+)$/)
    if (!m) return text('no_service', 404)
    if (m[1] === 'deleted') return text('no_service', 404)
    if (m[1] !== HOOK) return text('invalid_token', 403)
    if (ct !== 'application/json' || !body) return text('invalid_payload', 400)
    if (!body.text && !(body.blocks as unknown[] | undefined)?.length) return text('invalid_payload', 400)
    if (body.text !== undefined && String(body.text).length > MSG_LIMIT) return text('msg_too_long', 400)
    messages.push({ channel: '#webhook', ts: ts(), text: body.text === undefined ? undefined : String(body.text), blocks: body.blocks, via: 'webhook' })
    return text('ok')
  }

  return {
    port: server.port,
    url:  `http://127.0.0.1:${server.port}`,
    webhookUrl:        `http://127.0.0.1:${server.port}/services/T000/B000/${HOOK}`,
    deletedWebhookUrl: `http://127.0.0.1:${server.port}/services/T000/B000/deleted`,
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) {
  const s = startSlackSink({ port: Number(process.env.SLACK_SINK_PORT ?? 0), hookUrl: process.env.SLACK_HOOK_URL })
  console.log(`[slack-sink] ${s.url}  webhook ${s.webhookUrl}`)
}
