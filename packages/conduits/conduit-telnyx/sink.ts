// sink.ts — Telnyx, standing in for Telnyx.
//
// A listener speaking the real thing's shape: a bearer key, `{ data }` and
// `{ errors }` bodies, Call Control's per-call action paths with `command_id`
// dedupe, and webhooks signed Ed25519 over `"<ts>|<body>"` with a key this
// sink holds — generated at start, or derived from `seed` so every restart
// signs with the same one. A drive reads `publicKey` off the handle, as an app
// reads it off the portal.
//
// Texts: a number ending `…0000` has texted STOP and one ending `…9999` is not
// a number; `MAGIC_FAIL` is undeliverable, `MAGIC_BLOCKED` is blocked and
// `MAGIC_UNOWNED` as a `from` is a number the account does not hold. The
// exact numbers win over the suffixes.
//
// Knobs. The vendor's documented misbehavior, reproducible: `duplicate`
// delivers every event twice, `shuffle` delivers a message's receipts in
// reverse. Armed over `POST /_sink/arm` for the next request: `{ lost }` (the
// answer never comes back), `{ rateLimit: { retryAfter } }`, `{ failNext }`,
// `{ deliverTwice }`, `{ finalizeFirst }` (the receipt sent BEFORE the send is
// answered, the order the two-column rule exists for). `POST /_sink/inbound`
// makes it text the app; `GET /_sink/seen` is what it saw.
//
// It does not pretend to be a phone network. A call is a scripted caller who
// presses `digits` when asked.
//
// It plays the DEVICES too. A leg dialled to `sip:<user>@sip.telnyx.com` rings
// until somebody calls `answer` or `decline` on it — a test, or a dev screen
// standing in for the browser SDK — or until its `timeout_secs` runs out.
// Bridged legs hang up together (Telnyx's default after an unbridge), a
// recording is saved and the caller hangs up, and `deviceCall` is a browser
// placing a call on the credential connection, which Telnyx PARKS.
//
// It plays the MEDIA STREAM. `streaming_start` makes it dial the `stream_url`
// as a WebSocket client, the way Telnyx does, and speak the documented frames:
// `connected`, `start`, then a 20ms `media` frame of the caller every 20ms in
// real time, from `callerScript` (speech is a tone, quiet is silence). The
// app's `media` is queued and "played" at real time, a `mark` comes back when
// playback reaches it, and `clear` empties the queue and drops the marks in
// it. A frame it does not know is answered with an `error` frame (100002,
// stream_error), and the stream goes on, as Telnyx's did. The leg ending sends
// `stop` and closes the socket. Telnyx's close carried no code (1005); Bun's
// client sends 1000 for a bare `close()`, and the app reads neither, since the
// `stop` came first. A socket that never opens is `streaming.failed`; one the
// app closes is `streaming.stopped`.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { decodeClientState } from './src/calls.ts'
import { BYTES_PER_MS, FRAME_MS, silence, toneAudio } from './src/stream.ts'

/** A destination that always fails delivery, for the failed-receipt path. */
export const MAGIC_FAIL = '+15550000000'

/** A destination Telnyx refuses up front: it texted STOP to us. */
export const MAGIC_BLOCKED = '+15550000001'

/** A `from` the account does not hold. Telnyx refuses it before reading the
 *  `to` or the text (Phase 6: `400 10004`, every probe). */
export const MAGIC_UNOWNED = '+15550000002'

/** The exact numbers above beat the `…0000` / `…9999` suffix rules. */
const SPECIAL = new Set([MAGIC_FAIL, MAGIC_BLOCKED])

export interface TelnyxSinkOptions {
  port?:      number
  /** Where the app listens; a getter when the app binds after the sink does. None: events are counted and go nowhere. */
  hookUrl?:   string | (() => string)
  /** The bearer key, or every key the sink accepts — one per account for a per-caller target. */
  key?:       string | string[]
  /** A fixed Ed25519 seed (up to 32 bytes of text): the same signing key every restart. None: a fresh key. */
  seed?:      string
  /** The Call Control connection an inbound call arrives on. */
  callControlConnection?: string
  /** The credential connection a browser's parked call arrives on. */
  credentialConnection?:  string
  duplicate?: boolean
  shuffle?:   boolean
  /** What the scripted caller presses at a menu. */
  digits?:    string
  /** Deliver a text's receipts BEFORE answering the send — the race where the
   *  receipt names a message id the app has not written yet. */
  receiptsFirst?: boolean
  /** Send the text and deliver its receipts, then answer the send with a 500 —
   *  a response lost on the way back. The receipts name an id no row will
   *  ever hold. */
  loseResponse?: boolean
  /** Place this many dials, then answer each with a 500 — a dial's response
   *  lost on the way back. The leg exists and rings; a replay under the same
   *  command_id is answered with the lost answer, as Telnyx does. */
  loseDialResponse?: number
  /** Hold a device leg's `call.initiated` back this many ms, so an answer that
   *  comes quickly is delivered BEFORE the leg's own initiation. */
  lateInitiated?: number
  /** What the caller does on a media stream, in order. `say` is speech (a
   *  tone), `quiet` silence, `hangup` ends the leg. After the last segment the
   *  caller is silent until the leg ends. */
  callerScript?: CallerStep[]
  /** `unreachable`: the stream's socket cannot be opened (`streaming.failed`).
   *  `silent`: `streaming_start` is accepted and no socket ever comes. */
  streamMode?: 'unreachable' | 'silent'
  /** Network jitter: hold the stream's frames, `start` included, and deliver
   *  them this many at a time, so frames arrive in bunches as they do over a
   *  real network rather than one every 20ms. */
  burstFrames?: number
}

export type CallerStep = { say: number } | { quiet: number } | { hangup: true }

/** Waits through the greeting, says two things, then waits for the agent to hang up. */
export const DEFAULT_CALLER: CallerStep[] = [{ quiet: 900 }, { say: 500 }, { quiet: 1000 }, { say: 500 }, { quiet: 4000 }]

/** One media stream, as the sink's carrier sees it. */
export interface SinkStream {
  leg:     string
  url:     string
  opened:  boolean
  /** Every frame the app sent that the sink understood, in order. */
  fromApp: Array<{ event: string; [k: string]: unknown }>
  /** Every frame the app sent that is not Telnyx's: the sink answered each with an error. */
  junk:    string[]
  /** Marks played back to the app, in order. */
  echoed:  string[]
  clears:  number
  /** Ms of the app's audio played into the call. */
  playedMs: number
  /** Caller frames sent. */
  sent:    number
  close?:  { code: number; reason: string }
}

/** One leg, as the sink's network sees it. */
interface Leg {
  from: string; to: string; session: string; leg: string; direction: 'inbound' | 'outbound'
  connectionId: string; clientState?: string
  alive: boolean; answered: boolean; partner?: string
  /** A device leg: the SIP user it rings. */
  sip?: string
}

export interface TelnyxSink {
  url:       string
  port:      number
  /** The base64 public key the webhooks verify under, as the portal shows it. */
  publicKey: string
  stop():    void
  /** Every request the app made, in order: the body parsed and raw, the bearer it carried and the status answered (0 until answered). */
  log:     Array<{ method: string; path: string; body: any; raw: string; bearer: string | null; status: number }>
  /** Every webhook delivered, with the app's status. */
  sent:    Array<{ type: string; id: string; status: number }>
  /** Resolves when no webhook is pending — a test's settle point. */
  idle():  Promise<void>
  /** Someone texts one of our numbers. */
  inboundText(from: string, to: string, text: string): Promise<void>
  /** Someone calls one of our numbers. */
  inboundCall(from: string, to: string): Promise<string>
  /** The legs ringing a device now, oldest first. */
  ringing(sipUsername?: string): string[]
  /** A device picks up. False when the leg is not ringing any more. */
  answer(callControlId: string): Promise<boolean>
  /** A device turns the call down. */
  decline(callControlId: string): Promise<boolean>
  /** The party on this leg hangs up. */
  hangup(callControlId: string): Promise<void>
  /** A browser places a call through the credential connection, which parks it. */
  deviceCall(req: { callerNumber: string; to: string; clientState?: string }): Promise<string>
  /** Every leg, by call_control_id. */
  legs: Map<string, Leg>
  /** Credentials made, by id. */
  credentials: Map<string, { sip_username: string; connection_id: string }>
  /** Media streams, by the call_control_id they were started on. */
  streams: Map<string, SinkStream>
  /** The stream's socket drops mid-call: closed with no `stop`, the leg still up. */
  dropStream(callControlId: string): void
}

/** A fixed key pair from a seed, so every restart signs the same. NOT a secret. */
function keyPairFromSeed(seed: string): { privateKey: KeyObject; publicKey: KeyObject } {
  const bytes = Buffer.alloc(32)
  Buffer.from(seed, 'utf8').copy(bytes)
  // PKCS#8 wrapper for a raw Ed25519 seed: the fixed 16-byte prefix, then the 32.
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), bytes]), format: 'der', type: 'pkcs8' })
  return { privateKey, publicKey: createPublicKey(privateKey) }
}

export function startTelnyxSink(opts: TelnyxSinkOptions = {}): TelnyxSink {
  const { privateKey, publicKey: publicKeyObject } = opts.seed ? keyPairFromSeed(opts.seed) : generateKeyPairSync('ed25519')
  const publicKey = Buffer.from((publicKeyObject.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('base64')
  const keys = new Set([opts.key ?? 'KEY_dev'].flat())
  const CALL_CONTROL = opts.callControlConnection ?? 'dev-call-control'
  const CREDENTIALS  = opts.credentialConnection ?? 'dev-credentials'
  const hook = () => typeof opts.hookUrl === 'function' ? opts.hookUrl() : opts.hookUrl
  const messages = new Map<string, Record<string, unknown>>()
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false, finalizeFirst: false }
  const hanging: Array<() => void> = []
  const log: TelnyxSink['log'] = []
  const sent: TelnyxSink['sent'] = []
  const commands = new Map<string, number>()
  const dials = new Map<string, { at: number; status: number; body: unknown }>()
  const calls = new Map<string, Leg>()
  const credentials = new Map<string, { sip_username: string; connection_id: string }>()
  const recordings = new Set<string>()
  // Telnyx pre-signs a recording's link for ten minutes; each one minted here
  // differs, so a test can tell a fresh link from a stored one.
  let signed = 0
  const recordingUrl = (recId: string) => `${sinkUrl}/recordings/${recId}.mp3?X-Amz-Expires=600&X-Amz-Signature=${++signed}`
  const streams = new Map<string, SinkStream>()
  const stopStream = new Map<string, (why: 'hangup' | 'stop') => void>()
  /** A leg's playback, with the timer that ends a single pass; a loop has none. */
  const playing = new Map<string, ReturnType<typeof setTimeout> | undefined>()
  /** What waits for that pass to end: a recording asked for during it. */
  const afterPlayback = new Map<string, () => void>()
  const dropStream = new Map<string, () => void>()
  let pending = 0
  let waiters: Array<() => void> = []

  const settle = () => { if (pending === 0) { for (const w of waiters) w(); waiters = [] } }

  /** Ends a leg's playback, if one is playing; a pass cut short gives back its pending. */
  function stopPlayback(id: string): boolean {
    if (!playing.has(id)) return false
    const pass = playing.get(id)
    playing.delete(id)
    afterPlayback.get(id)?.(); afterPlayback.delete(id)
    if (pass) { clearTimeout(pass); pending--; settle() }
    return true
  }

  /** `to` is where this one event goes when the message named its own `webhook_url`. */
  async function deliver(type: string, payload: Record<string, unknown>, delayMs = 10, to = hook()) {
    pending++
    const id = randomUUID()
    const body = JSON.stringify({
      data: { record_type: 'event', id, event_type: type, occurred_at: new Date().toISOString(), payload },
      meta: { attempt: 1, delivered_to: to ?? '' },
    })
    const times = opts.duplicate || armed.deliverTwice ? 2 : 1
    armed.deliverTwice = false
    const post = async () => {
      const ts = String(Math.floor(Date.now() / 1000))
      const res = to ? await fetch(to, {
        method:  'POST',
        headers: {
          'content-type':             'application/json',
          'telnyx-timestamp':         ts,
          'telnyx-signature-ed25519': sign(null, Buffer.from(`${ts}|${body}`, 'utf8'), privateKey).toString('base64'),
        },
        body,
      }).catch(() => null) : null
      sent.push({ type, id, status: res?.status ?? 0 })
      await res?.text()
      return res?.status ?? 0
    }
    try {
      await Bun.sleep(delayMs)
      for (let i = 0; i < times; i++) {
        // Telnyx retries a 5xx (and 408, 429). Three more tries, quickly: the
        // real backoff is minutes, which no drive can wait out.
        for (let attempt = 0; attempt < 4; attempt++) {
          const status = await post()
          if (status < 500 && status !== 408 && status !== 429) break
          await Bun.sleep(40 * (attempt + 1))
        }
      }
    } finally {
      pending--
      settle()
    }
  }

  const fail = (status: number, code: string, title: string, detail?: string) =>
    Response.json({ errors: [{ code, title, ...(detail ? { detail } : {}) }] }, { status })

  const callPayload = (id: string, extra: Record<string, unknown> = {}) => {
    const c = calls.get(id)!
    return {
      call_control_id: id, call_leg_id: c.leg, call_session_id: c.session, connection_id: c.connectionId,
      from: c.from, to: c.to, direction: c.direction === 'inbound' ? 'incoming' : 'outgoing',
      ...(c.clientState ? { client_state: c.clientState } : {}), ...extra,
    }
  }

  const open = (id: string, leg: Omit<Leg, 'leg' | 'alive' | 'answered'>) =>
    calls.set(id, { ...leg, leg: randomUUID(), alive: true, answered: false })

  /** A leg ends, and a leg bridged to it follows — Telnyx hangs up the other
   *  side after an unbridge unless told to park it. */
  function end(id: string, cause: string, delayMs = 10) {
    const c = calls.get(id)
    if (!c?.alive) return
    c.alive = false
    stopStream.get(id)?.('hangup')
    void deliver('call.hangup', callPayload(id, { hangup_cause: cause, state: 'hangup' }), delayMs)
    const other = c.partner ? calls.get(c.partner) : undefined
    if (other?.alive) end(c.partner!, 'normal_clearing', delayMs + 10)
  }

  async function answerLeg(id: string) {
    const c = calls.get(id)
    if (!c?.alive || c.answered) return false
    c.answered = true
    await deliver('call.answered', callPayload(id, { state: 'answered' }), 0)
    return true
  }

  /**
   * Dial the app's socket as Telnyx would, and play the caller into it. The
   * clock is one 20ms tick for both directions: a caller frame goes out, and
   * 20ms of the app's queued audio is "played".
   */
  function openStream(id: string, body: Record<string, any>) {
    const c = calls.get(id)!
    const st: SinkStream = { leg: id, url: String(body.stream_url), opened: false, fromApp: [], junk: [], echoed: [], clears: 0, playedMs: 0, sent: 0 }
    streams.set(id, st)
    const streamId = randomUUID()
    const script = [...(opts.callerScript ?? DEFAULT_CALLER)]
    let queuedMs = 0
    let marks: Array<{ at: number; name: string }> = []
    let seq = 0
    let tick: ReturnType<typeof setInterval> | undefined
    let ws: WebSocket
    const failed = (reason: string) => void deliver('streaming.failed', { call_control_id: id, call_session_id: c.session, stream_url: st.url, failure_reason: reason })
    if (opts.streamMode === 'unreachable') { failed('connection_failed'); return }
    if (opts.streamMode === 'silent') return
    try { ws = new WebSocket(st.url) } catch { failed('connection_failed'); return }
    const burst = opts.burstFrames ?? 0
    let held: string[] = []
    const flush = () => { for (const h of held) ws.send(h); held = [] }
    const frame = (f: Record<string, unknown>) => {
      if (ws.readyState !== WebSocket.OPEN) return
      const out = JSON.stringify({ ...f, sequence_number: String(++seq), stream_id: streamId })
      if (burst > 1 && f.event !== 'stop') { held.push(out); if (held.length >= burst) flush(); return }
      flush(); ws.send(out)
    }

    let at = 0                                          // ms into the caller's script
    const step = () => {
      // The caller.
      let t = at; let chunk: Uint8Array | null = null
      for (const s of script) {
        const len = 'say' in s ? s.say : 'quiet' in s ? s.quiet : 0
        if ('hangup' in s) { end(id, 'normal_clearing', 0); return }   // every step before it is over
        if (t < len) { chunk = 'say' in s ? toneAudio(FRAME_MS, 220) : silence(FRAME_MS); break }
        t -= len
      }
      chunk ??= silence(FRAME_MS)
      frame({ event: 'media', media: { track: 'inbound', chunk: String(st.sent + 1), timestamp: String(at), payload: Buffer.from(chunk).toString('base64') } })
      st.sent++
      at += FRAME_MS
      // The app's audio, played.
      const played = Math.min(FRAME_MS, queuedMs)
      queuedMs -= played
      st.playedMs += played
      const due = marks.filter(m => m.at <= st.playedMs)
      marks = marks.filter(m => m.at > st.playedMs)
      for (const m of due) { st.echoed.push(m.name); frame({ event: 'mark', mark: { name: m.name } }) }
    }

    ws.onopen = () => {
      st.opened = true
      void deliver('streaming.started', { call_control_id: id, call_session_id: c.session, stream_url: st.url })
      ws.send(JSON.stringify({ event: 'connected', version: '1.0.0' }))
      frame({ event: 'start', start: {
        user_id: 'sink-user', call_control_id: id, call_session_id: c.session, from: c.from, to: c.to,
        ...(c.clientState ? { client_state: c.clientState } : {}),
        media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
      } })
      tick = setInterval(step, FRAME_MS)
    }
    ws.onmessage = (m) => {
      const raw = String(m.data)
      let f: any = null
      try { f = JSON.parse(raw) } catch {}
      if (!f || !['media', 'mark', 'clear'].includes(f.event)) {
        st.junk.push(raw)
        frame({ event: 'error', payload: { code: 100002, title: 'stream_error', detail: 'An unknown error occurred on the stream' } })
        return
      }
      st.fromApp.push(f)
      if (f.event === 'media') queuedMs += Buffer.from(String(f.media?.payload ?? ''), 'base64').length / BYTES_PER_MS
      if (f.event === 'mark')  marks.push({ at: st.playedMs + queuedMs, name: String(f.mark?.name) })
      if (f.event === 'clear') { queuedMs = 0; marks = []; st.clears++ }
    }
    ws.onclose = (e) => {
      clearInterval(tick)
      stopStream.delete(id)
      dropStream.delete(id)
      st.close = { code: e.code, reason: e.reason }
      if (!st.opened) failed('connection_failed')
      else void deliver('streaming.stopped', { call_control_id: id, call_session_id: c.session, stream_url: st.url })
    }
    dropStream.set(id, () => { clearInterval(tick); ws.close(4000, 'lost') })
    stopStream.set(id, () => {
      clearInterval(tick)
      frame({ event: 'stop', stop: { user_id: 'sink-user', call_control_id: id } })
      ws.close()
    })
  }

  let sinkUrl = ''
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)

      // ── The drive's own doors ──
      if (url.pathname === '/_sink/seen') return Response.json({
        requests: log.map(r => ({ method: r.method, path: r.path, body: r.raw, status: r.status })),
        events:   sent.map(e => ({ id: e.id, type: e.type, status: e.status || null })),
        messages: [...messages.values()],
      })
      if (url.pathname === '/_sink/reset') {
        log.length = 0; sent.length = 0
        Object.assign(armed, { lost: false, failNext: false, rateLimit: null, deliverTwice: false, finalizeFirst: false })
        return Response.json({ ok: true })
      }
      if (url.pathname === '/_sink/arm') { Object.assign(armed, await req.json()); return Response.json({ ok: true }) }
      if (url.pathname === '/_sink/inbound' && req.method === 'POST') {
        const b = await req.json() as { from: string; to: string; text: string }
        await handle.inboundText(b.from, b.to, b.text)
        return Response.json({ ok: true })
      }

      const text = await req.text()
      let body: any = {}
      try { body = text ? JSON.parse(text) : {} } catch { return fail(400, '10015', 'Bad Request', 'body is not JSON') }
      const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? null
      const entry = { method: req.method, path: url.pathname, body, raw: text, bearer, status: 0 }
      log.push(entry)
      const answer = await route(req, url, body, bearer)
      entry.status = answer.status
      return answer
    },
  })

  async function route(req: Request, url: URL, body: any, bearer: string | null): Promise<Response> {
    if (!bearer || !keys.has(bearer)) return fail(401, '10009', 'Authentication failed')
    if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return Response.json({ errors: [{ code: '10011', title: 'Too many requests' }] }, { status: 429, headers: { 'retry-after': String(retryAfter) } }) }
    if (armed.failNext)  { armed.failNext = false; return fail(500, '10007', 'Unexpected error') }
    const answer = await dispatch(req, url, body)
    if (armed.lost) { armed.lost = false; await new Promise<void>(r => hanging.push(r)) }
    return answer
  }

  async function dispatch(req: Request, url: URL, body: any): Promise<Response> {
    // ── POST /v2/messages ──
    if (req.method === 'POST' && url.pathname === '/v2/messages') {
      if (body.from === MAGIC_UNOWNED) return fail(400, '10004', 'Missing required parameter', 'Invalid source number.')
      const to = String(body.to ?? '')
      if (!/^\+[1-9]\d{6,14}$/.test(to) || to.endsWith('9999')) return fail(422, '40310', 'Invalid \'to\' address', `'${to}' is not a valid E.164 number`)
      if (!body.text && !body.media_urls?.length) return fail(422, '40005', 'Message body is empty')
      if (to === MAGIC_BLOCKED || (to.endsWith('0000') && !SPECIAL.has(to))) return fail(422, '40300', 'Blocked due to STOP message', 'the recipient has opted out')

      const id = randomUUID()
      const msg = {
        id, record_type: 'message', direction: 'outbound', type: body.media_urls?.length ? 'MMS' : 'SMS', text: body.text,
        from: { phone_number: body.from }, to: [{ phone_number: to, status: 'queued' }], sent_at: null as string | null, completed_at: null as string | null,
      }
      messages.set(id, msg)
      const receipt = (status: string) => ({ ...msg, to: [{ phone_number: to, status }], ...(status === 'sent' ? { sent_at: new Date().toISOString() } : { completed_at: new Date().toISOString() }) })
      const final = receipt(to === MAGIC_FAIL ? 'delivery_failed' : 'delivered')
      const order: Array<[string, unknown]> = [['message.sent', receipt('sent')], ['message.finalized', final]]
      if (opts.shuffle) order.reverse()
      // The send's answer is the snapshot at send time, even when the
      // receipts went out first: that is the order a real carrier produces.
      const snapshot = { data: JSON.parse(JSON.stringify(msg)) }
      const first = opts.receiptsFirst || opts.loseResponse || armed.finalizeFirst
      armed.finalizeFirst = false
      const run = (async () => { for (const [t, p] of order) { await deliver(t, p as any, first ? 0 : 10, body.webhook_url ?? hook()); if (t === 'message.finalized') { msg.to[0].status = final.to[0].status; msg.completed_at = final.completed_at } } })()
      if (first) await run
      if (opts.loseResponse) return fail(500, '10007', 'Unexpected error')
      return Response.json(snapshot)
    }

    // ── Telephony credentials ──
    if (req.method === 'POST' && url.pathname === '/v2/telephony_credentials') {
      if (!body.connection_id) return fail(422, '10015', 'connection_id is required')
      const id = randomUUID()
      const sip_username = `gencred${randomUUID().replace(/-/g, '').slice(0, 20)}`
      credentials.set(id, { sip_username, connection_id: body.connection_id })
      return Response.json({ data: { id, sip_username, sip_password: randomUUID(), name: body.name ?? null, record_type: 'telephony_credential' } }, { status: 201 })
    }
    const cred = url.pathname.match(/^\/v2\/telephony_credentials\/([^/]+)(\/token)?$/)
    if (cred) {
      const id = decodeURIComponent(cred[1])
      if (!credentials.has(id)) return fail(404, '10005', 'Resource not found')
      if (req.method === 'POST' && cred[2]) {
        // A JWT in shape only: three base64url parts, the middle naming the credential.
        const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
        const jwt = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ sub: id, exp: Math.floor(Date.now() / 1000) + 86_400 })}.sink`
        // Telnyx sends this body with NO content-type (seen 2026-10-07). Bun.serve
        // stamps text/plain on a string body even after headers.delete(); a
        // stream body is the one it leaves untyped.
        const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(jwt)); c.close() } })
        return new Response(body, { status: 201 })
      }
      if (req.method === 'DELETE' && !cred[2]) { credentials.delete(id); return Response.json({ data: { id } }) }
    }

    // ── GET /v2/recordings/:id ──
    const rec = url.pathname.match(/^\/v2\/recordings\/([^/]+)$/)
    if (req.method === 'GET' && rec) {
      const recId = decodeURIComponent(rec[1])
      if (!recordings.has(recId)) return fail(404, '10005', 'Resource not found')
      return Response.json({ data: { id: recId, record_type: 'recording', status: 'completed', download_urls: { mp3: recordingUrl(recId) } } })
    }

    // ── POST /v2/calls ──
    if (req.method === 'POST' && url.pathname === '/v2/calls') {
      // Telnyx's dedupe on a dial: a command_id seen in the last 60s places
      // nothing and is answered with the FIRST dial's answer, its
      // call_control_id included (measured 2026-10-07 on a refused dial and a
      // placed one; the placed one's replay is a 202). Kept as Telnyx made
      // it, so a response this sink loses is the one the replay returns.
      const key = body.command_id ? String(body.command_id) : undefined
      const seen = key ? dials.get(key) : undefined
      if (seen && Date.now() - seen.at < 60_000) return Response.json(seen.body, { status: seen.status === 200 ? 202 : seen.status })
      const answered = (status: number, payload: unknown) => {
        if (key) dials.set(key, { at: Date.now(), status, body: payload })
        return Response.json(payload, { status })
      }
      const id = `v3:${randomUUID()}`
      const linked = body.link_to ? calls.get(body.link_to) : undefined
      const session = linked?.session ?? randomUUID()
      const sip = String(body.to ?? '').match(/^sip:([^@]+)@sip\.telnyx\.com$/)?.[1]
      if (sip && ![...credentials.values()].some(c => c.sip_username === sip)) {
        return answered(422, { errors: [{ code: '10005', title: 'No such SIP user', detail: body.to }] })
      }
      open(id, { from: body.from, to: body.to, session, direction: 'outbound', connectionId: body.connection_id, clientState: body.client_state, sip })
      const data = { call_control_id: id, call_leg_id: calls.get(id)!.leg, call_session_id: session, record_type: 'call' }
      if (sip) {
        // A device: it rings until it is answered, declined, or Telnyx's own
        // timeout runs out. Nothing here answers it.
        void deliver('call.initiated', callPayload(id, { state: 'bridging' }), opts.lateInitiated ?? 10)
        const secs = Number(body.timeout_secs ?? 30)
        setTimeout(() => { const c = calls.get(id); if (c?.alive && !c.answered) end(id, 'timeout', 0) }, secs * 1000).unref?.()
      } else {
        void deliver('call.initiated', callPayload(id, { state: 'bridging' }))
        setTimeout(() => void answerLeg(id), 30)
      }
      const placed = answered(200, { data })
      if (opts.loseDialResponse) { opts.loseDialResponse--; return fail(500, '10007', 'Unexpected error') }
      return placed
    }

    // ── POST /v2/calls/:id/actions/:action ──
    const m = url.pathname.match(/^\/v2\/calls\/([^/]+)\/actions\/([a-z_]+)$/)
    if (req.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]); const action = m[2]
      if (!calls.get(id)?.alive) return fail(422, '90018', 'Call has already ended')

      // Telnyx's dedupe: a command_id seen in the last 60s is accepted and
      // does nothing. The 200 is the point — a replay must look like success.
      if (body.command_id) {
        const seen = commands.get(body.command_id)
        if (seen && Date.now() - seen < 60_000) return Response.json({ data: { result: 'ok' } })
        commands.set(body.command_id, Date.now())
      }

      const cs = body.client_state
      // A command's client_state is echoed on the events it causes, and on
      // the leg's events after that.
      if (cs) calls.get(id)!.clientState = cs
      switch (action) {
        case 'answer':
          calls.get(id)!.answered = true
          void deliver('call.answered', callPayload(id, { client_state: cs }))
          break
        case 'bridge': {
          const other = calls.get(body.call_control_id)
          if (!other?.alive) return fail(422, '90018', 'Call has already ended', `the other leg, ${body.call_control_id}`)
          if (!other.answered || !calls.get(id)!.answered) return fail(422, '90034', 'Both legs must be answered to bridge')
          calls.get(id)!.partner = body.call_control_id
          other.partner = id
          void deliver('call.bridged', callPayload(id, { client_state: cs }))
          void deliver('call.bridged', callPayload(body.call_control_id))
          break
        }
        case 'record_start': {
          // The caller leaves a message and hangs up. Telnyx holds the
          // recording behind a playback still playing (Phase 6).
          const record = () => {
            if (!calls.get(id)?.alive) return
            const recId = randomUUID()
            recordings.add(recId)
            void deliver('call.recording.saved', callPayload(id, {
              recording_id: recId, channels: body.channels ?? 'single',
              recording_urls: { mp3: recordingUrl(recId) },
            }), 30)
            setTimeout(() => end(id, 'normal_clearing', 0), 60)
          }
          if (playing.get(id)) afterPlayback.set(id, record)
          else record()
          break
        }
        case 'speak':
          void deliver('call.speak.ended', callPayload(id, { client_state: cs, status: 'completed' }))
          break
        case 'gather_using_speak':
          void deliver('call.gather.ended', callPayload(id, { client_state: cs, digits: opts.digits ?? '1', status: 'valid' }), 30)
          break
        case 'transfer':
          void deliver('call.bridged', callPayload(id, { client_state: cs, to: body.to }))
          end(id, 'normal_clearing', 40)
          break
        case 'hangup':
          end(id, 'normal_clearing')
          break
        case 'streaming_start':
          if (!body.stream_url) return fail(422, '10015', 'stream_url is required')
          openStream(id, body)
          break
        case 'streaming_stop':
          stopStream.get(id)?.('stop')
          break
        case 'playback_start': {
          if (!body.audio_url && !body.media_name && !body.playback_content) return fail(422, '10015', 'audio_url, media_name or playback_content is required')
          // As the carrier does (Phase 6): a stray `ended` before it plays —
          // the looped ringback's said `file_not_found`, the greeting's came
          // `completed` between two `started`. A single pass then ends
          // `completed`; a loop runs until stopped, and a stop ends it
          // `completed` too.
          stopPlayback(id)
          if (body.loop === 'infinity') {
            void deliver('call.playback.ended', callPayload(id, { status: 'file_not_found', status_detail: '' }), 5)
            void deliver('call.playback.started', callPayload(id), 15)
            playing.set(id, undefined)
            break
          }
          void deliver('call.playback.started', callPayload(id), 5)
          void deliver('call.playback.ended', callPayload(id, { status: 'completed', status_detail: '' }), 10)
          void deliver('call.playback.started', callPayload(id), 15)
          pending++                                   // idle() waits out the pass
          playing.set(id, setTimeout(() => {
            playing.delete(id)
            if (calls.get(id)?.alive) void deliver('call.playback.ended', callPayload(id, { status: 'completed', status_detail: '' }))
            afterPlayback.get(id)?.(); afterPlayback.delete(id)
            pending--; settle()
          }, 40))
          break
        }
        case 'playback_stop':
          if (stopPlayback(id)) void deliver('call.playback.ended', callPayload(id, { status: 'completed', status_detail: '' }))
          break
        default:
          return fail(422, '10015', `Unknown action ${action}`)
      }
      // Not read here, decoded so a malformed state from the app is visible
      // in the sink's log rather than silently echoed.
      if (cs && !decodeClientState(cs)) log.push({ method: 'NOTE', path: 'client_state did not decode', body: cs, raw: cs, bearer: null, status: 0 })
      return Response.json({ data: { result: 'ok' } })
    }

    // ── GET /v2/messages/:id ──
    const msgPath = url.pathname.match(/^\/v2\/messages\/([^/]+)$/)
    if (req.method === 'GET' && msgPath) {
      const msg = messages.get(decodeURIComponent(msgPath[1]))
      return msg ? Response.json({ data: msg }) : fail(404, '10005', 'Resource not found')
    }

    return fail(404, '10005', 'Resource not found', url.pathname)
  }

  // Bound late: a recording's URL reads it, and the port is not known until
  // the server is up.
  sinkUrl = `http://127.0.0.1:${server.port}`

  const handle: TelnyxSink = {
    url: sinkUrl,
    port: server.port!,
    publicKey,
    stop: () => { for (const r of hanging) r(); server.stop(true) },
    log,
    sent,
    idle: () => new Promise<void>((resolve) => {
      // Two ticks: a webhook the app answers may itself issue a command that
      // schedules the next one, so "nothing pending" has to hold across a turn.
      const check = () => setTimeout(() => pending === 0 ? resolve() : waiters.push(check), 60)
      check()
    }),
    async inboundText(from, to, text) {
      await deliver('message.received', {
        id: randomUUID(), record_type: 'message', direction: 'inbound', text,
        from: { phone_number: from }, to: [{ phone_number: to, status: 'webhook_delivered' }],
      }, 0)
    },
    async inboundCall(from, to) {
      const id = `v3:${randomUUID()}`
      open(id, { from, to, session: randomUUID(), direction: 'inbound', connectionId: CALL_CONTROL })
      await deliver('call.initiated', callPayload(id, { state: 'parked' }), 0)
      return id
    },
    ringing(sipUsername) {
      return [...calls.entries()].filter(([, c]) => c.sip && c.alive && !c.answered && (!sipUsername || c.sip === sipUsername)).map(([id]) => id)
    },
    answer: answerLeg,
    async decline(id) {
      const c = calls.get(id)
      if (!c?.alive || c.answered) return false
      end(id, 'call_rejected', 0)
      return true
    },
    async hangup(id) { end(id, 'normal_clearing', 0) },
    async deviceCall({ callerNumber, to, clientState }) {
      // Telnyx's documented shape for a parked WebRTC call: `from` is the
      // callerNumber the SDK was given, and nothing names the credential.
      const id = `v3:${randomUUID()}`
      open(id, { from: callerNumber, to, session: randomUUID(), direction: 'outbound', connectionId: CREDENTIALS, clientState })
      await deliver('call.initiated', callPayload(id, { state: 'parked' }), 0)
      return id
    },
    legs: calls,
    credentials,
    streams,
    dropStream: (id) => dropStream.get(id)?.(),
  }
  return handle
}

if (import.meta.main) {
  const sink = startTelnyxSink({ port: Number(process.env.TELNYX_SINK_PORT ?? 0), hookUrl: process.env.TELNYX_HOOK_URL })
  console.log(`[telnyx-sink] ${sink.url} publicKey=${sink.publicKey}`)
}
