// sink.ts — Gmail, standing in for Gmail.
//
// A dev listener speaking the REST shape under `/gmail/v1/users/me`: a bearer
// token names a mailbox, resources carry Google's int64-as-string fields, a
// history log with a window, a watch with a seven-day expiry, and Google's
// error envelope with the `reason` that tells four 403s apart. `messages.send`
// decodes `raw` and PARSES THE MIME BY HAND — folded headers, RFC 2047 words,
// multipart boundaries, base64 parts — so a drift in `buildMime` is a refusal
// here rather than an agreement: raw non-ASCII bytes in a header are refused
// naming the header, a missing Message-ID is refused, a reply whose Subject
// differs forks the thread exactly as Gmail does, silently.
//
// `gmailSinkHandler(state)` is exported beside `startGmailSink` so one Google
// stand-in can mount these paths beside its OAuth and Business Profile ones
// on one port; the handler answers null for a path that is not its own.
//
// It owns the chaos (FJS-D890), armed at `/_sink/arm`: `lost` (applied, never
// answered), `rateLimit: { status: 429 | 403, retryAfter?, limit? }`,
// `failNext` (500 backendError), `staleHistory` (next history.list is 404),
// `deliverTwice` (the next push twice), `expireWatch` (the watch is gone and
// history still answers — the silent death), `revoke` (every call 401 until
// reset), `quota` (403 dailyLimitExceeded), `forbidScope` (403
// insufficientPermissions with the ErrorInfo detail), `signIn` (a 200 HTML
// page), `enforceUnits` (the 6,000-units-a-minute bucket answers 403 past it).
// `/_sink/mail` delivers INTO a mailbox and POSTs a Pub/Sub push to
// `opts.hookUrl` with a bearer this sink signs (RS256; the key is published at
// `/oauth2/v3/certs`). `/_sink/seen` is what arrived, recorded on arrival, and
// the units each request cost. `/_sink/reset` keeps the mailboxes.
//
// It does NOT pretend to be Gmail's search: `q` understands `newer_than:`,
// `older_than:`, `from:`, `to:`, `subject:`, `rfc822msgid:`, `in:`, `label:`,
// `is:` and bare words over subject and body, and nothing else.

import { generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto'
import type { GmailLabel, GmailMessage, GmailPart, GmailProfile, HistoryRecord } from './src/types.ts'

// ─── Options and state ────────────────────────────────────────────────────

export interface SinkSeedAttachment { filename: string; mimeType: string; bytes?: string; inline?: boolean }

export interface SinkSeedMessage {
  from:         string
  to:           string
  cc?:          string
  subject:      string
  text?:        string
  html?:        string
  /** The parent's Message-Id header: this message lands in its thread. */
  inReplyTo?:   string
  messageId?:   string
  labelIds?:    string[]
  /** ISO string or epoch ms. */
  date?:        string | number
  attachments?: SinkSeedAttachment[]
}

export interface SinkMailbox { token: string; emailAddress: string; messages?: SinkSeedMessage[] }

export interface GmailSinkOptions {
  port?:          number
  mailboxes?:     SinkMailbox[]
  /** Where a push goes; none means pushes are recorded and not sent. */
  hookUrl?:       string
  /** The service account the push subscription publishes as. */
  publisher?:     string
  /** How many history records a mailbox keeps; older watermarks answer 404. */
  historyWindow?: number
}

export interface PushOptions {
  emailAddress?: string
  historyId?:    string | number
  /** Write `historyId` as a JSON number, as an older publisher did. */
  numeric?:      boolean
  /** Signed with a key the certs endpoint never published; its own kid. */
  rogue?:        boolean
  /** Signed with the unpublished key under the PUBLISHED kid. */
  forged?:       boolean
  kid?:          string
  iss?:          string
  aud?:          string
  email?:        string
  exp?:          number
  /** Send an envelope that is not one. */
  malformed?:    boolean
  times?:        number
}

export interface SeenRequest {
  method:  string
  path:    string
  query:   string
  headers: Record<string, string>
  body:    string
  at:      number
  units:   number
  /** The MIME a send carried, as parsed by hand. */
  sent?:   { rawHeaders: string[]; headers: Record<string, string>; threadId: string | null; forked: boolean; parts: string[] }
}

export interface SeenPush { messageId: string; status: number | null; historyId: string; emailAddress: string }

export interface Mailbox {
  token:        string
  emailAddress: string
  historyId:    bigint
  messages:     Map<string, GmailMessage>
  threads:      Map<string, string[]>
  history:      HistoryRecord[]
  watch:        { topicName: string; labelIds: string[]; expiration: string } | null
  labels:       GmailLabel[]
  attachments:  Map<string, { bytes: Buffer; filename: string; mimeType: string }>
}

interface Armed {
  lost:         boolean
  rateLimit:    null | { status?: 429 | 403; retryAfter?: number; limit?: 'sending' | 'bandwidth' | 'concurrency' }
  failNext:     boolean
  staleHistory: boolean
  deliverTwice: boolean
  expireWatch:  boolean
  revoke:       boolean
  quota:        boolean
  forbidScope:  boolean
  signIn:       boolean
  enforceUnits: boolean
}

const ARMED_OFF: Armed = { lost: false, rateLimit: null, failNext: false, staleHistory: false, deliverTwice: false, expireWatch: false, revoke: false, quota: false, forbidScope: false, signIn: false, enforceUnits: false }

export interface GmailSinkState {
  // Mailbox is internal; it rides here so a host that mounts the handler can read it.
  opts:       GmailSinkOptions
  mailboxes:  Map<string, Mailbox>
  seen:       SeenRequest[]
  pushes:     SeenPush[]
  units:      Record<string, number>
  armed:      Armed
  hanging:    Array<() => void>
  publisher:  string
  pushToken(o: PushOptions): string
  rotateKeys(): void
  deliver(input: SinkSeedMessage & { mailbox?: string; push?: PushOptions }): Promise<{ id: string; threadId: string; historyId: string; pushes: SeenPush[] }>
  /** Appends one history record, bumps the watermark, trims to the window. */
  record(box: Mailbox, entry: Omit<HistoryRecord, 'id'>): void
  push(o: PushOptions): Promise<SeenPush[]>
  reset(): void
}

/** Google's unit costs per method. */
export const UNITS = {
  profile: 1, 'messages.list': 5, 'messages.get': 20, 'messages.send': 100, 'messages.modify': 5, 'messages.trash': 20, 'messages.untrash': 5,
  'attachments.get': 20, 'threads.get': 40, 'threads.list': 10, 'history.list': 2, watch: 100, stop: 50, 'labels.list': 1,
} as const
export const UNITS_PER_MINUTE = 6_000
export const WATCH_TTL_MS     = 7 * 24 * 60 * 60 * 1000
const DEFAULT_PUBLISHER = 'gmail-push@sink-dev.iam.gserviceaccount.com'
const SYSTEM_LABELS: GmailLabel[] = ['INBOX', 'SENT', 'UNREAD', 'STARRED', 'IMPORTANT', 'TRASH', 'SPAM', 'DRAFT', 'CATEGORY_PERSONAL'].map(id => ({ id, name: id, type: 'system' }))

// ─── Helpers ──────────────────────────────────────────────────────────────

let counter = 0
const hexId = () => (0x18f0000000000000n + BigInt(++counter) * 7919n).toString(16)
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers } })

const STATUS_WORD: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 429: 'RESOURCE_EXHAUSTED', 500: 'INTERNAL', 503: 'UNAVAILABLE' }

/** Google's envelope: `reason` under `errors[]`, the gRPC word under `status`. */
function googleError(code: number, reason: string | null, message: string, extra: { details?: unknown[]; headers?: Record<string, string>; status?: string } = {}) {
  return json({ error: {
    code, message,
    ...(reason ? { errors: [{ message, domain: 'global', reason }] } : {}),
    status: extra.status ?? STATUS_WORD[code] ?? 'UNKNOWN',
    ...(extra.details ? { details: extra.details } : {}),
  } }, code, { ...(code === 401 ? { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' } : {}), ...(extra.headers ?? {}) })
}

const snippetOf = (text: string) => text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
const stripRe   = (s: string) => s.replace(/^(\s*(re|aw|sv|antw)\s*:\s*)+/i, '').trim().toLowerCase()
const header    = (m: GmailMessage, name: string) => m.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value

// ─── MIME, parsed by hand ─────────────────────────────────────────────────

export interface ParsedMime {
  headers:    Record<string, string>
  rawHeaders: string[]
  parts:      Array<{ mimeType: string; body: string; filename?: string }>
}

function decodeWords(v: string): string {
  return v
    .replace(/(=\?[^?]+\?[BQbq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (_, cs: string, enc: string, txt: string) => {
      const bytes = enc.toUpperCase() === 'B'
        ? Buffer.from(txt, 'base64')
        : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1')
      return new TextDecoder(cs.toLowerCase()).decode(bytes)
    })
}

function splitHeadBody(text: string): [string, string] {
  const i = text.search(/\r?\n\r?\n/)
  if (i === -1) return [text, '']
  const sep = text.slice(i).match(/^\r?\n\r?\n/)![0]
  return [text.slice(0, i), text.slice(i + sep.length)]
}

function unfold(head: string): string[] {
  const lines: string[] = []
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += ' ' + line.trim()
    else if (line) lines.push(line)
  }
  return lines
}

function decodeTransfer(body: string, cte: string | undefined, charset = 'utf-8'): string {
  const enc = (cte ?? '7bit').trim().toLowerCase()
  if (enc === 'base64') return new TextDecoder(charset).decode(Buffer.from(body.replace(/\s+/g, ''), 'base64'))
  if (enc === 'quoted-printable') return new TextDecoder(charset).decode(Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1'))
  return body
}

const param = (ct: string, name: string) => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(ct)?.slice(1).find(Boolean)

/** Throws with the HEADER's name on raw non-ASCII bytes or a bare CR/LF; every other fault is the caller's to grade. */
export function parseMime(text: string): ParsedMime {
  const [head, body] = splitHeadBody(text)
  const rawHeaders = unfold(head)
  const headers: Record<string, string> = {}
  for (const line of rawHeaders) {
    const m = /^([!-9;-~]+):\s*(.*)$/.exec(line)
    if (!m) throw new Error(`a header line is not 'Name: value': '${line.slice(0, 40)}'`)
    // eslint-disable-next-line no-control-regex
    if (/[^\x09\x20-\x7e]/.test(m[2])) throw new Error(`header '${m[1]}' carries raw non-ASCII bytes; an RFC 2047 encoded-word is required`)
    headers[m[1]] = decodeWords(m[2])
  }
  const ct = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? 'text/plain'
  const cte = Object.entries(headers).find(([k]) => k.toLowerCase() === 'content-transfer-encoding')?.[1]
  const type = ct.split(';')[0].trim().toLowerCase()
  const parts: ParsedMime['parts'] = []
  if (type.startsWith('multipart/')) {
    const boundary = param(ct, 'boundary')
    if (!boundary) throw new Error('multipart with no boundary')
    const chunks = body.split(new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?(?:\\r?\\n|$)`))
    for (const chunk of chunks.slice(1)) {
      if (!chunk.trim()) continue
      const inner = parseMime(chunk)
      const cd = Object.entries(inner.headers).find(([k]) => k.toLowerCase() === 'content-disposition')?.[1]
      const filename = cd ? param(cd, 'filename') : undefined
      parts.push(...(inner.parts.length ? inner.parts : [{ mimeType: 'text/plain', body: '', ...(filename ? { filename } : {}) }]).map(p => filename && !p.filename ? { ...p, filename } : p))
    }
  } else {
    parts.push({ mimeType: type, body: decodeTransfer(body, cte, param(ct, 'charset') ?? 'utf-8') })
  }
  return { headers, rawHeaders, parts }
}

// ─── The state ────────────────────────────────────────────────────────────

const part = (partId: string, mimeType: string, text: string, filename = ''): GmailPart => ({
  partId, mimeType, filename,
  headers: [{ name: 'Content-Type', value: `${mimeType}; charset="UTF-8"` }, { name: 'Content-Transfer-Encoding', value: 'base64' }],
  body: { size: Buffer.byteLength(text), data: b64url(text) },
})

export function createGmailSinkState(opts: GmailSinkOptions = {}): GmailSinkState {
  const mailboxes = new Map<string, Mailbox>()
  const seen: SeenRequest[] = []
  const pushes: SeenPush[] = []
  const units: Record<string, number> = {}
  const armed: Armed = { ...ARMED_OFF }
  const hanging: Array<() => void> = []
  const window = opts.historyWindow ?? 1_000
  const PUBLISHER = opts.publisher ?? DEFAULT_PUBLISHER

  // 2048 bits, as Google's are. `rogue` is a key nobody published.
  const newKey = () => { const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }); return { kid: randomBytes(10).toString('hex'), ...pair } }
  let signing = newKey()
  const rogue  = newKey()
  const jwkOf  = (k: { kid: string; publicKey: KeyObject }) => ({ ...(k.publicKey.export({ format: 'jwk' }) as object), kid: k.kid, alg: 'RS256', use: 'sig' })

  function pushToken(o: PushOptions): string {
    const key = o.rogue || o.forged ? rogue : signing
    const now = Math.floor(Date.now() / 1000)
    const head = { alg: 'RS256', kid: o.kid ?? (o.forged ? signing.kid : key.kid), typ: 'JWT' }
    const claims = {
      iss: o.iss ?? 'https://accounts.google.com', aud: o.aud ?? opts.hookUrl ?? 'https://app.test/push', azp: '104000000000000000001',
      sub: '104000000000000000001', email: o.email ?? PUBLISHER, email_verified: true, iat: now, exp: o.exp ?? now + 3600,
    }
    const data = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(claims))}`
    return `${data}.${b64url(cryptoSign('sha256', Buffer.from(data), key.privateKey))}`
  }

  const byEmail = (email: string) => [...mailboxes.values()].find(m => m.emailAddress.toLowerCase() === email.toLowerCase())

  function record(box: Mailbox, entry: Omit<HistoryRecord, 'id'>) {
    box.historyId += 1n
    box.history.push({ id: box.historyId.toString(), ...entry })
    if (box.history.length > window) box.history.splice(0, box.history.length - window)
  }

  function addMessage(box: Mailbox, seed: SinkSeedMessage, labelIds: string[], threadId?: string): GmailMessage {
    const id   = hexId()
    const when = seed.date === undefined ? Date.now() : typeof seed.date === 'number' ? seed.date : Date.parse(seed.date)
    const parent = seed.inReplyTo ? [...box.messages.values()].find(m => header(m, 'message-id') === seed.inReplyTo) : undefined
    const tid  = threadId ?? parent?.threadId ?? id
    const messageId = seed.messageId ?? `<${randomBytes(8).toString('hex')}@${seed.from.split('@')[1] ?? 'mail.test'}>`
    const refs = parent ? [header(parent, 'references'), header(parent, 'message-id')].filter(Boolean).join(' ') : undefined
    const headers = [
      { name: 'Delivered-To', value: box.emailAddress },
      { name: 'From',    value: seed.from },
      { name: 'To',      value: seed.to },
      ...(seed.cc ? [{ name: 'Cc', value: seed.cc }] : []),
      { name: 'Subject', value: seed.subject },
      // Inbound mail spells the header as the SENDER did; the app's lookup must not depend on the case.
      { name: labelIds.includes('SENT') ? 'Message-ID' : 'Message-Id', value: messageId },
      { name: 'Date',    value: new Date(when).toUTCString() },
      ...(seed.inReplyTo ? [{ name: 'In-Reply-To', value: seed.inReplyTo }, { name: 'References', value: refs || seed.inReplyTo }] : []),
      { name: 'MIME-Version', value: '1.0' },
    ]
    const text = seed.text ?? '', html = seed.html
    const parts: GmailPart[] = []
    if (html && seed.text !== undefined) parts.push(part('0', 'text/plain', text), part('1', 'text/html', html))
    else if (html) parts.push(part('0', 'text/html', html))
    else parts.push(part('0', 'text/plain', text))
    for (const [i, a] of (seed.attachments ?? []).entries()) {
      const attachmentId = `ANGjdJ_${randomBytes(12).toString('hex')}`
      const bytes = Buffer.from(a.bytes ?? `${a.filename} bytes`)
      box.attachments.set(attachmentId, { bytes, filename: a.filename, mimeType: a.mimeType })
      parts.push({ partId: String(parts.length + i), mimeType: a.mimeType, filename: a.filename,
        headers: [{ name: 'Content-Type', value: `${a.mimeType}; name="${a.filename}"` }, { name: 'Content-Disposition', value: `attachment; filename="${a.filename}"` }, ...(a.inline ? [{ name: 'Content-ID', value: `<${attachmentId}>` }] : [])],
        body: { size: bytes.length, attachmentId } })
    }
    const mixed = (seed.attachments?.length ?? 0) > 0
    const alt = parts.filter(p => !p.filename)
    const payload: GmailPart = mixed
      ? { partId: '', mimeType: 'multipart/mixed', filename: '', headers: [...headers, { name: 'Content-Type', value: 'multipart/mixed; boundary="m"' }], body: { size: 0 },
          parts: [alt.length > 1 ? { partId: '0', mimeType: 'multipart/alternative', filename: '', headers: [{ name: 'Content-Type', value: 'multipart/alternative; boundary="a"' }], body: { size: 0 }, parts: alt } : alt[0], ...parts.filter(p => p.filename)] }
      : alt.length > 1
        ? { partId: '', mimeType: 'multipart/alternative', filename: '', headers: [...headers, { name: 'Content-Type', value: 'multipart/alternative; boundary="a"' }], body: { size: 0 }, parts: alt }
        : { ...alt[0], partId: '', headers: [...headers, ...(alt[0].headers ?? [])] }
    const msg: GmailMessage = { id, threadId: tid, labelIds: [...labelIds], snippet: snippetOf(text || html || ''), historyId: '', internalDate: String(when), payload, sizeEstimate: Buffer.byteLength(text) + Buffer.byteLength(html ?? '') + 600 }
    box.messages.set(id, msg)
    box.threads.set(tid, [...(box.threads.get(tid) ?? []), id])
    record(box, { messages: [{ id, threadId: tid }], messagesAdded: [{ message: { id, threadId: tid, labelIds: [...labelIds] } }] })
    msg.historyId = box.historyId.toString()
    return msg
  }

  for (const seed of opts.mailboxes ?? []) {
    const box: Mailbox = { token: seed.token, emailAddress: seed.emailAddress, historyId: 1_000_000n, messages: new Map(), threads: new Map(), history: [], watch: null, labels: [...SYSTEM_LABELS], attachments: new Map() }
    mailboxes.set(seed.token, box)
    for (const m of seed.messages ?? []) {
      const outbound = m.from.toLowerCase() === seed.emailAddress.toLowerCase()
      addMessage(box, m, m.labelIds ?? (outbound ? ['SENT'] : ['INBOX', 'UNREAD']))
    }
  }

  async function post(envelope: unknown, o: PushOptions, meta: { messageId: string; historyId: string; emailAddress: string }): Promise<SeenPush> {
    const entry: SeenPush = { ...meta, status: null }
    if (!opts.hookUrl) { pushes.push(entry); return entry }
    try {
      const res = await fetch(opts.hookUrl, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${pushToken({ ...o, aud: o.aud ?? opts.hookUrl })}` }, body: JSON.stringify(envelope) })
      entry.status = res.status
    } catch { entry.status = null }
    pushes.push(entry)
    return entry
  }

  async function push(o: PushOptions): Promise<SeenPush[]> {
    const emailAddress = o.emailAddress ?? [...mailboxes.values()][0]?.emailAddress ?? 'nobody@sink.test'
    const historyId = o.historyId ?? byEmail(emailAddress)?.historyId.toString() ?? '1'
    const data = o.numeric ? { emailAddress, historyId: Number(historyId) } : { emailAddress, historyId: String(historyId) }
    const messageId = String(1_000_000_000 + ++counter)
    const at = new Date().toISOString()
    const envelope = o.malformed
      ? { message: { data: b64url('not json'), messageId, message_id: messageId }, subscription: 'projects/sink/subscriptions/gmail' }
      : { message: { data: b64url(JSON.stringify(data)), messageId, message_id: messageId, publishTime: at, publish_time: at, attributes: {} }, subscription: 'projects/sink/subscriptions/gmail' }
    const times = o.times ?? (armed.deliverTwice ? 2 : 1)
    armed.deliverTwice = false
    const out: SeenPush[] = []
    for (let i = 0; i < times; i++) out.push(await post(envelope, o, { messageId, historyId: String(historyId), emailAddress }))
    return out
  }

  async function deliver(input: SinkSeedMessage & { mailbox?: string; push?: PushOptions }) {
    const box = (input.mailbox && (mailboxes.get(input.mailbox) ?? byEmail(input.mailbox))) ?? byEmail(input.to)
    if (!box) throw new Error(`no mailbox for '${input.mailbox ?? input.to}'`)
    const msg = addMessage(box, input, input.labelIds ?? ['INBOX', 'UNREAD'])
    const delivered = box.watch || !opts.hookUrl ? await push({ ...input.push, emailAddress: box.emailAddress, historyId: box.historyId.toString() }) : []
    return { id: msg.id, threadId: msg.threadId, historyId: box.historyId.toString(), pushes: delivered }
  }

  return {
    opts, mailboxes, seen, pushes, units, armed, hanging, publisher: PUBLISHER,
    pushToken, record,
    rotateKeys() { signing = newKey() },
    deliver, push,
    reset() {
      seen.length = 0; pushes.length = 0
      for (const k of Object.keys(units)) delete units[k]
      Object.assign(armed, ARMED_OFF)
      for (const r of hanging.splice(0)) r()
    },
    // The certs endpoint reads the live key through the closure.
    get jwks() { return { keys: [jwkOf(signing)] } },
  } as GmailSinkState & { jwks: { keys: unknown[] } }
}

// ─── Search ───────────────────────────────────────────────────────────────

function matches(m: GmailMessage, q: string, includeSpamTrash: boolean): boolean {
  const labels = m.labelIds ?? []
  const tokens = q.match(/"[^"]*"|\S+/g) ?? []
  let wantsTrash = includeSpamTrash
  const text = () => Buffer.from(m.payload ? flat(m.payload).map(p => p.body?.data ?? '').join('') : '', 'base64url').toString('utf8')
  for (const raw of tokens) {
    const tok = raw.replace(/^"|"$/g, '')
    const i = tok.indexOf(':')
    const key = i === -1 ? '' : tok.slice(0, i).toLowerCase()
    const val = i === -1 ? tok : tok.slice(i + 1).replace(/^"|"$/g, '')
    const when = Number(m.internalDate)
    const span = (v: string) => { const mm = /^(\d+)([dmy])$/.exec(v); if (!mm) return NaN; const n = Number(mm[1]); return n * (mm[2] === 'd' ? 1 : mm[2] === 'm' ? 30 : 365) * 86_400_000 }
    switch (key) {
      case 'newer_than':  if (!(when >= Date.now() - span(val))) return false; break
      case 'older_than':  if (!(when <  Date.now() - span(val))) return false; break
      case 'from':        if (!(header(m, 'from') ?? '').toLowerCase().includes(val.toLowerCase())) return false; break
      case 'to':          if (!`${header(m, 'to') ?? ''} ${header(m, 'cc') ?? ''}`.toLowerCase().includes(val.toLowerCase())) return false; break
      case 'subject':     if (!(header(m, 'subject') ?? '').toLowerCase().includes(val.toLowerCase())) return false; break
      case 'rfc822msgid': if ((header(m, 'message-id') ?? '').replace(/^<|>$/g, '') !== val.replace(/^<|>$/g, '')) return false; break
      case 'in':
        if (val === 'anywhere') { wantsTrash = true; break }
        if (val === 'trash' || val === 'spam') wantsTrash = true
        if (!labels.includes(val.toUpperCase())) return false; break
      case 'label':       if (!labels.includes(val.toUpperCase()) && !labels.includes(val)) return false; break
      case 'is':
        if (val === 'unread' && !labels.includes('UNREAD')) return false
        if (val === 'read'   &&  labels.includes('UNREAD')) return false
        if (val === 'starred' && !labels.includes('STARRED')) return false
        break
      default: {
        const hay = `${header(m, 'subject') ?? ''} ${text()}`.toLowerCase()
        if (!hay.includes(val.toLowerCase())) return false
      }
    }
  }
  if (!wantsTrash && (labels.includes('TRASH') || labels.includes('SPAM'))) return false
  return true
}

function flat(p: GmailPart): GmailPart[] { return [p, ...(p.parts ?? []).flatMap(flat)] }

function formatted(m: GmailMessage, format: string, metadataHeaders: string[]): GmailMessage {
  if (format === 'minimal') { const { payload: _p, ...rest } = m; return rest }
  if (format === 'metadata') {
    const want = metadataHeaders.map(h => h.toLowerCase())
    const headers = (m.payload?.headers ?? []).filter(h => !want.length || want.includes(h.name.toLowerCase()))
    return { ...m, payload: { partId: '', mimeType: m.payload?.mimeType ?? 'text/plain', filename: '', headers, body: { size: 0 } } }
  }
  return m
}

// ─── The handler ──────────────────────────────────────────────────────────

/** Answers the sink's paths; null for anything else, so a host can mount it beside other Google paths. */
export function gmailSinkHandler(state: GmailSinkState): (req: Request) => Promise<Response | null> {
  const { mailboxes, seen, pushes, units, armed, hanging } = state

  return async function handle(req) {
    const url  = new URL(req.url)
    const path = url.pathname

    // ── controls ───────────────────────────────────────────────────────────
    if (path === '/_sink/seen')  return json({ requests: seen, pushes, units, mailboxes: [...mailboxes.values()].map(b => ({ emailAddress: b.emailAddress, historyId: b.historyId.toString(), watch: b.watch, messages: b.messages.size })) })
    if (path === '/_sink/reset') { state.reset(); return json({ ok: true }) }
    if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }
    if (path === '/_sink/rotate') { state.rotateKeys(); return json({ ok: true }) }
    if (path === '/_sink/mail' && req.method === 'POST') {
      try { return json(await state.deliver(await req.json())) } catch (e) { return json({ error: (e as Error).message }, 400) }
    }
    if (path === '/_sink/push' && req.method === 'POST') return json({ pushes: await state.push(await req.json()) })
    if (path === '/_sink/push-token' && req.method === 'POST') return json({ token: state.pushToken(await req.json()) })
    if (path === '/oauth2/v3/certs') return json((state as GmailSinkState & { jwks: unknown }).jwks, 200, { 'cache-control': 'public, max-age=3600' })

    const m = /^\/gmail\/v1\/users\/(?:me|[^/]+)(\/.*)?$/.exec(path)
    if (!m) return null
    const rest = m[1] ?? ''
    const text = req.method === 'POST' ? await req.text() : ''
    const entry: SeenRequest = { method: req.method, path, query: url.search, headers: Object.fromEntries(req.headers), body: text, at: Date.now(), units: 0 }
    seen.push(entry)

    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const box = mailboxes.get(bearer)
    if (armed.revoke || !box)
      return googleError(401, 'authError', 'Invalid Credentials', { status: 'UNAUTHENTICATED' })

    if (armed.forbidScope) {
      armed.forbidScope = false
      return googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', {
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com', metadata: { method: 'caribou.api.proto.MailboxService.GetProfile', service: 'gmail.googleapis.com' } }],
      })
    }
    if (armed.quota) { armed.quota = false; return googleError(403, 'dailyLimitExceeded', 'Daily Limit Exceeded. The quota will be reset at midnight Pacific Time (PT).') }
    if (armed.rateLimit) {
      const { status = 429, retryAfter, limit } = armed.rateLimit
      armed.rateLimit = null
      const headers = retryAfter !== undefined ? { 'retry-after': String(retryAfter) } : {}
      if (status === 403) return googleError(403, 'userRateLimitExceeded', 'User-rate limit exceeded.  Retry after ' + new Date(Date.now() + 1000).toISOString(), { headers })
      const message = limit === 'sending' ? 'Too many requests: User-rate limit exceeded (Mail sending)' : limit === 'concurrency' ? 'Too many concurrent requests for user' : 'User-rate limit exceeded'
      return googleError(429, null, message, { headers })
    }
    if (armed.failNext) { armed.failNext = false; return googleError(500, 'backendError', 'Backend Error') }
    if (armed.signIn) { armed.signIn = false; return new Response('<!doctype html><html><head><title>Sign in - Google Accounts</title></head><body>Sign in</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) }

    const spend = (method: keyof typeof UNITS) => {
      const cost = UNITS[method]
      entry.units = cost
      const key = box.token
      units[key] = (units[key] ?? 0) + cost
      return armed.enforceUnits && units[key] > UNITS_PER_MINUTE
    }
    const limited = () => googleError(403, 'userRateLimitExceeded', 'User-rate limit exceeded.  Retry after ' + new Date(Date.now() + 1000).toISOString())
    const notFound = () => googleError(404, 'notFound', 'Requested entity was not found.')
    const bad = (message: string) => googleError(400, 'invalidArgument', message)
    const body = () => { try { return JSON.parse(text || '{}') as Record<string, unknown> } catch { return null } }

    let answer: Response | null = null

    if (rest === '/profile' && req.method === 'GET') {
      if (spend('profile')) return limited()
      const profile: GmailProfile = { emailAddress: box.emailAddress, messagesTotal: box.messages.size, threadsTotal: box.threads.size, historyId: box.historyId.toString() }
      answer = json(profile)
    }

    else if (rest === '/messages' && req.method === 'GET') {
      if (spend('messages.list')) return limited()
      const q = url.searchParams.get('q') ?? ''
      const labelIds = url.searchParams.getAll('labelIds')
      const max = Math.min(Number(url.searchParams.get('maxResults') ?? 100) || 100, 500)
      const start = Number(url.searchParams.get('pageToken') ?? 0) || 0
      const all = [...box.messages.values()]
        .filter(x => matches(x, q, url.searchParams.get('includeSpamTrash') === 'true'))
        .filter(x => labelIds.every(l => x.labelIds?.includes(l)))
        .sort((a, b) => Number(b.internalDate) - Number(a.internalDate))
      const page = all.slice(start, start + max).map(x => ({ id: x.id, threadId: x.threadId }))
      answer = json({ ...(page.length ? { messages: page } : {}), resultSizeEstimate: all.length, ...(start + max < all.length ? { nextPageToken: String(start + max) } : {}) })
    }

    else if (rest === '/messages/send' && req.method === 'POST') {
      if (spend('messages.send')) return limited()
      const b = body()
      if (!b || typeof b.raw !== 'string') return bad("Invalid value for 'raw'")
      let parsed: ParsedMime
      try { parsed = parseMime(Buffer.from(b.raw, 'base64url').toString('utf8')) } catch (e) { return bad(`Invalid raw message: ${(e as Error).message}`) }
      const h = (n: string) => Object.entries(parsed.headers).find(([k]) => k.toLowerCase() === n)?.[1]
      if (!h('message-id')) return bad('Invalid raw message: no Message-ID header')
      if (!h('to')?.includes('@')) return bad('Invalid To header')
      const wanted = typeof b.threadId === 'string' ? b.threadId : null
      let threadId = hexId(), forked = false
      if (wanted) {
        const ids = box.threads.get(wanted)
        if (!ids) return notFound()
        const root = box.messages.get(ids[0])!
        if (stripRe(header(root, 'subject') ?? '') === stripRe(h('subject') ?? '')) threadId = wanted
        else forked = true
      }
      const html = parsed.parts.find(p => p.mimeType === 'text/html')?.body
      const txt  = parsed.parts.find(p => p.mimeType === 'text/plain')?.body
      const msg = addMessageFromWire(box, { from: h('from') ?? box.emailAddress, to: h('to')!, cc: h('cc'), subject: h('subject') ?? '', html, text: txt, messageId: h('message-id')!, inReplyTo: h('in-reply-to'), references: h('references') }, threadId)
      entry.sent = { rawHeaders: parsed.rawHeaders, headers: parsed.headers, threadId: wanted, forked, parts: parsed.parts.map(p => p.mimeType) }
      answer = json({ id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds })
    }

    else if (/^\/messages\/[^/]+$/.test(rest) && req.method === 'GET') {
      if (spend('messages.get')) return limited()
      const msg = box.messages.get(rest.slice('/messages/'.length))
      answer = msg ? json(formatted(msg, url.searchParams.get('format') ?? 'full', url.searchParams.getAll('metadataHeaders'))) : notFound()
    }

    else if (/^\/messages\/[^/]+\/(modify|trash|untrash)$/.test(rest) && req.method === 'POST') {
      const [, id, op] = /^\/messages\/([^/]+)\/(modify|trash|untrash)$/.exec(rest)!
      if (spend(op === 'modify' ? 'messages.modify' : op === 'trash' ? 'messages.trash' : 'messages.untrash')) return limited()
      const msg = box.messages.get(id)
      if (!msg) answer = notFound()
      else {
        const b = body() ?? {}
        const add    = op === 'trash' ? ['TRASH'] : op === 'untrash' ? [] : ((b.addLabelIds as string[] | undefined) ?? [])
        const remove = op === 'untrash' ? ['TRASH'] : op === 'trash' ? ['INBOX'] : ((b.removeLabelIds as string[] | undefined) ?? [])
        const unknown = [...add, ...remove].find(l => !box.labels.some(x => x.id === l))
        if (unknown) return bad(`Invalid label: ${unknown}`)
        const before = new Set(msg.labelIds ?? [])
        const after  = new Set([...before].filter(l => !remove.includes(l)).concat(add))
        msg.labelIds = [...after]
        const added   = [...after].filter(l => !before.has(l)), removed = [...before].filter(l => !after.has(l))
        const ref = { message: { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds } }
        if (added.length)   state.record(box, { messages: [{ id: msg.id, threadId: msg.threadId }], labelsAdded:   [{ ...ref, labelIds: added }] })
        if (removed.length) state.record(box, { messages: [{ id: msg.id, threadId: msg.threadId }], labelsRemoved: [{ ...ref, labelIds: removed }] })
        msg.historyId = box.historyId.toString()
        answer = json(formatted(msg, 'minimal', []))
      }
    }

    else if (/^\/messages\/[^/]+\/attachments\/[^/]+$/.test(rest) && req.method === 'GET') {
      if (spend('attachments.get')) return limited()
      const [, mid, aid] = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(rest)!
      const a = box.messages.has(mid) ? box.attachments.get(decodeURIComponent(aid)) : undefined
      answer = a ? json({ size: a.bytes.length, data: a.bytes.toString('base64url') }) : notFound()
    }

    else if (/^\/threads\/[^/]+$/.test(rest) && req.method === 'GET') {
      if (spend('threads.get')) return limited()
      const ids = box.threads.get(rest.slice('/threads/'.length))
      answer = ids
        ? json({ id: rest.slice('/threads/'.length), historyId: box.historyId.toString(), messages: ids.map(id => formatted(box.messages.get(id)!, url.searchParams.get('format') ?? 'full', url.searchParams.getAll('metadataHeaders'))) })
        : notFound()
    }

    else if (rest === '/history' && req.method === 'GET') {
      if (spend('history.list')) return limited()
      const start = url.searchParams.get('startHistoryId')
      if (!start || !/^\d+$/.test(start)) return bad('Invalid startHistoryId')
      const oldest = box.history[0] ? BigInt(box.history[0].id) : box.historyId + 1n
      // Gmail's window: an id older than the first record it still holds is a 404.
      if (armed.staleHistory || (BigInt(start) < oldest - 1n && box.history.length >= (state.opts.historyWindow ?? 1_000))) {
        armed.staleHistory = false
        return notFound()
      }
      if (BigInt(start) > box.historyId) return notFound()
      const types = url.searchParams.getAll('historyTypes')
      const max = Math.min(Number(url.searchParams.get('maxResults') ?? 100) || 100, 500)
      const offset = Number(url.searchParams.get('pageToken') ?? 0) || 0
      const all = box.history.filter(h => BigInt(h.id) > BigInt(start)).map(h => {
        if (!types.length) return h
        const keep: HistoryRecord = { id: h.id, messages: h.messages }
        if (types.includes('messageAdded')   && h.messagesAdded)   keep.messagesAdded   = h.messagesAdded
        if (types.includes('messageDeleted') && h.messagesDeleted) keep.messagesDeleted = h.messagesDeleted
        if (types.includes('labelAdded')     && h.labelsAdded)     keep.labelsAdded     = h.labelsAdded
        if (types.includes('labelRemoved')   && h.labelsRemoved)   keep.labelsRemoved   = h.labelsRemoved
        return keep
      }).filter(h => h.messagesAdded || h.messagesDeleted || h.labelsAdded || h.labelsRemoved)
      const page = all.slice(offset, offset + max)
      answer = json({ ...(page.length ? { history: page } : {}), historyId: box.historyId.toString(), ...(offset + max < all.length ? { nextPageToken: String(offset + max) } : {}) })
    }

    else if (rest === '/watch' && req.method === 'POST') {
      if (spend('watch')) return limited()
      const b = body()
      if (!b || typeof b.topicName !== 'string' || !b.topicName) return bad('topicName must be specified')
      if ('labelFilterAction' in b) return bad('labelFilterAction is deprecated; use labelFilterBehavior')
      const expiration = String(Date.now() + WATCH_TTL_MS)
      box.watch = { topicName: b.topicName, labelIds: (b.labelIds as string[] | undefined) ?? ['INBOX'], expiration }
      answer = json({ historyId: box.historyId.toString(), expiration })
    }

    else if (rest === '/stop' && req.method === 'POST') {
      if (spend('stop')) return limited()
      box.watch = null
      answer = new Response(null, { status: 204 })
    }

    else if (rest === '/labels' && req.method === 'GET') {
      if (spend('labels.list')) return limited()
      answer = json({ labels: box.labels })
    }

    if (!answer) return notFound()
    if (armed.expireWatch) { armed.expireWatch = false; box.watch = null }

    // A lost answer: applied, never answered. The caller times out with the
    // send possibly landed, which is the `indeterminate` case.
    if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
    return answer
  }

  /** A sent message as Gmail stores it: `SENT`, the headers as sent, its parts. */
  function addMessageFromWire(box: Mailbox, w: { from: string; to: string; cc?: string; subject: string; html?: string; text?: string; messageId: string; inReplyTo?: string; references?: string }, threadId: string): GmailMessage {
    const id = hexId(), when = Date.now()
    const headers = [
      { name: 'From', value: w.from }, { name: 'To', value: w.to }, ...(w.cc ? [{ name: 'Cc', value: w.cc }] : []),
      { name: 'Subject', value: w.subject }, { name: 'Message-ID', value: w.messageId }, { name: 'Date', value: new Date(when).toUTCString() },
      ...(w.inReplyTo ? [{ name: 'In-Reply-To', value: w.inReplyTo }, { name: 'References', value: w.references ?? w.inReplyTo }] : []),
      { name: 'MIME-Version', value: '1.0' },
    ]
    const alt: GmailPart[] = []
    if (w.text !== undefined) alt.push(part('0', 'text/plain', w.text))
    if (w.html !== undefined) alt.push(part(String(alt.length), 'text/html', w.html))
    if (!alt.length) alt.push(part('0', 'text/plain', ''))
    const payload: GmailPart = alt.length > 1
      ? { partId: '', mimeType: 'multipart/alternative', filename: '', headers: [...headers, { name: 'Content-Type', value: 'multipart/alternative; boundary="a"' }], body: { size: 0 }, parts: alt }
      : { ...alt[0], partId: '', headers: [...headers, ...(alt[0].headers ?? [])] }
    const msg: GmailMessage = { id, threadId, labelIds: ['SENT'], snippet: snippetOf(w.text ?? w.html ?? ''), historyId: '', internalDate: String(when), payload, sizeEstimate: 600 }
    box.messages.set(id, msg)
    box.threads.set(threadId, [...(box.threads.get(threadId) ?? []), id])
    state.record(box, { messages: [{ id, threadId }], messagesAdded: [{ message: { id, threadId, labelIds: ['SENT'] } }] })
    msg.historyId = box.historyId.toString()
    return msg
  }
}

// ─── The listener ─────────────────────────────────────────────────────────

export function startGmailSink(opts: GmailSinkOptions = {}) {
  const state  = createGmailSinkState(opts)
  const handle = gmailSinkHandler(state)
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) { return (await handle(req)) ?? json({ error: { code: 404, message: 'Not Found', status: 'NOT_FOUND' } }, 404) },
  })
  return {
    port:  server.port,
    url:   `http://127.0.0.1:${server.port}`,
    state,
    stop() { for (const r of state.hanging.splice(0)) r(); server.stop(true) },
  }
}

if (import.meta.main) {
  const s = startGmailSink({ port: Number(process.env.GMAIL_SINK_PORT ?? 0), hookUrl: process.env.GMAIL_HOOK_URL, mailboxes: [{ token: 'ya29.dev', emailAddress: 'dev@sink.test' }] })
  console.log(`[gmail-sink] ${s.url}`)
}
