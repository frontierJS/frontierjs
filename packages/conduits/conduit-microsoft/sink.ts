// sink.ts — a stand-in for Microsoft's login and Graph mail, on a real socket (CONTRACT C10).
//
// Nothing here or in a test reaches Microsoft: graphUrl and loginUrl
// have no default, and tests and drives point them here. It serves the calls
// the mailbox sync makes and the ones Graph makes back at the app:
//
//   login     GET  /{tenant}/oauth2/v2.0/authorize   consent → a code on redirect_uri, or access_denied
//             POST /{tenant}/oauth2/v2.0/token       authorization_code, refresh_token. The refresh token
//                                                    ROTATES on every use and the spent one is dead; a
//                                                    revoked grant answers `invalid_grant`.
//   graph     GET  /v1.0/me
//             GET  /v1.0/me/mailFolders/{wellKnown|id}, GET /v1.0/me/mailFolders?$filter=displayName eq '…',
//             POST /v1.0/me/mailFolders
//             GET  /v1.0/me/messages?$filter=conversationId eq '…'   ($select, $expand=attachments(…), $top, nextLink)
//             GET  /v1.0/me/messages/{id}, …/attachments/{id}/$value
//             GET  /v1.0/me/mailFolders/{f}/messages/delta          the receivedDateTime filter is baked into the
//                                                                    token; `@removed` tombstones; 410 once reset
//             POST/PATCH/DELETE/GET /v1.0/subscriptions              the validationToken handshake on create
//   writes    POST /v1.0/me/messages                          a new draft (custom `x-` headers only here)
//             POST /v1.0/me/messages/{id}/createReply|createReplyAll|createForward   a draft in the thread
//             PATCH /v1.0/me/messages/{id}                    isRead on any message; body, subject and
//                                                             recipients on a draft; never the headers
//             POST /v1.0/me/messages/{id}/send                the draft becomes a sent item under a NEW id
//                                                             (as Graph re-issues a sent draft's id),
//                                                             keeping its Message-Id and headers
//             POST /v1.0/me/messages/{id}/move                to a folder id or a well-known name
//             GET  /v1.0/me/messages?$filter=internetMessageId eq '…', GET /v1.0/me/mailFolders/{f}/messages
//   back      POST notificationUrl            batched change notifications carrying clientState
//             POST lifecycleNotificationUrl   reauthorizationRequired · subscriptionRemoved · missed
//
// The ids are Graph's two kinds. A message's REST id changes when it MOVES
// folder; its immutable id, its internetMessageId and its conversationId do
// not. A request carrying `Prefer: IdType="ImmutableId"` is answered in
// immutable ids, any other in REST ids — as Graph does — and either kind is
// accepted as input.
//
// Knobs a test turns: notifications off, duplicate deliveries, a lapsed
// subscription, a lifecycle event, a revoked grant, expired access tokens,
// a 401 / 429 / anything on the next matching call, every delta token
// made stale (410), and a write that is MADE and whose answer is then lost
// (dropNext: the write happens, the caller gets a 504). Every mailbox write —
// made, refused or dropped — is recorded in writes(), which reset() keeps:
// what a test counts "exactly once" and "nothing at all" by.
//
// Chosen, not measured: the error bodies' wording, the page size (10), the
// token formats, and the batching window.
//
//   bun run sink     serve on SINK_PORT (default 8794)

import { randomUUID } from 'node:crypto'

export const CLIENT_ID = 'standin-graph-client'
export const CLIENT_SECRET = 'standin-graph-secret'
export const MAILBOX = 'office@kobami.test'
export const TENANT_ID = '00000000-0000-4000-8000-00000000e1a0'
const WELL_KNOWN = ['inbox', 'sentitems', 'deleteditems', 'drafts', 'archive'] as const
const PAGE = 10
const MAX_SUBSCRIPTION_MINUTES = 4230

export interface Address { name?: string; address: string }

export interface StandInAttachment { id: string; name: string; contentType: string; isInline?: boolean; bytes: Uint8Array }

/** A message as the stand-in holds it. */
export interface StandInMessage {
  immutableId: string
  restId: string
  folderId: string
  internetMessageId: string
  conversationId: string
  subject: string
  html: string
  /** The plain-text alternative a MIME send carried (/me/sendMail); Graph shows only the HTML. */
  text?: string
  /** What this message added to its thread — Graph's `uniqueBody`. */
  unique: string
  from: Address
  to: Address[]
  cc: Address[]
  replyTo: Address[]
  receivedDateTime: string
  sentDateTime: string
  isRead: boolean
  isDraft: boolean
  attachments: StandInAttachment[]
  headers: { name: string; value: string }[]
  createdDateTime: string
}

export interface DeliverInput {
  from: string | Address
  to?: (string | Address)[]
  cc?: (string | Address)[]
  replyTo?: (string | Address)[]
  subject?: string
  html?: string
  /** The plain-text alternative, as a MIME send carries it. */
  text?: string
  /** What the message adds to the thread; defaults to the whole body. */
  unique?: string
  /** A conversation the message joins; a new one when absent. */
  conversationId?: string
  internetMessageId?: string
  folder?: string
  isRead?: boolean
  isDraft?: boolean
  receivedAt?: Date | string
  attachments?: { id?: string; name: string; contentType?: string; isInline?: boolean; bytes?: Uint8Array | string }[]
  // A loader's knobs (db/move/inbox-replay.ts replays stored rows): the
  // message's immutable id, its internet headers and its sent time, as the
  // stored row has them. Absent, the id is minted, the headers are the
  // stand-in's one, and the message was sent when it was received.
  /** The immutable id to hold it under (unique in the mailbox). */
  id?: string
  headers?: { name: string; value: string }[]
  sentAt?: Date | string
}

export type Received = {
  method: string
  path: string
  query: Record<string, string>
  status: number
  /** Whose token it was, by mailbox; null for none or a dead one. */
  mailbox: string | null
  /** The Prefer header, which says which kind of id is answered. */
  prefer: string | null
  body?: unknown
  /** The write was made and its answer dropped (dropNext): the caller saw a 504. */
  dropped?: true
}

export type Delivery = {
  kind: 'validation' | 'change' | 'lifecycle'
  url: string
  status: number
  /** The notifications in the POST; 0 for a validation. */
  count: number
  subscriptionId: string | null
  /** Set when notifications were off and nothing was sent. */
  dropped?: true
}

interface Subscription {
  id: string
  mailbox: string
  resource: string
  changeType: string
  notificationUrl: string
  lifecycleNotificationUrl: string | null
  clientState: string | null
  expirationDateTime: string
  removed: boolean
}

interface Change { seq: number; folderId: string; immutableId: string; restId: string }

interface Mailbox {
  address: string
  userId: string
  displayName: string
  folders: Map<string, { id: string; displayName: string; wellKnown: string | null }>
  messages: Map<string, StandInMessage>
  changes: Change[]
  seq: number
  /** Delta tokens issued before this generation answer 410. */
  epoch: number
  refreshes: number
  revoked: string | null
  /** The one live refresh token of each grant (a grant is one consent). */
  grants: Map<string, string>
}

interface Fail { method?: string; path?: RegExp; status: number; retryAfter?: number; body?: unknown; times: number }
interface Drop { method?: string; path?: RegExp; times: number }

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const unb64 = <T>(s: string): T | null => {
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}
const addr = (a: string | Address): Address => (typeof a === 'string' ? { address: a } : a)
const recipient = (a: Address) => ({ emailAddress: { name: a.name ?? a.address, address: a.address } })
const graphError = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status })
const token = (prefix: string) => `${prefix}.${randomUUID().replace(/-/g, '')}`

export function startMicrosoftSink(options: { port?: number; mailboxes?: string[]; accessTokenTtl?: number; batchMs?: number } = {}) {
  const mailboxes = new Map<string, Mailbox>()
  const accessTokens = new Map<string, { mailbox: string; expiresAt: number }>()
  const codes = new Map<string, { mailbox: string; redirectUri: string; scope: string }>()
  const subscriptions = new Map<string, Subscription>()
  const skipTokens = new Map<string, { items: unknown[]; deltaToken: string | null; nextLinkBase: string }>()
  const received: Received[] = []
  const writeLog: Received[] = []
  const deliveries: Delivery[] = []
  const fails: Fail[] = []
  const drops: Drop[] = []
  const pending = new Map<string, unknown[]>()
  const inflight = new Set<Promise<unknown>>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const knobs = {
    /** Off: a change notifies nobody (the backstop's case). */
    notifications: true,
    /** Each batch is POSTed this many times — at-least-once delivery. */
    duplicates: 1,
    /** Who consents at /authorize, and whether they do. */
    signedIn: options.mailboxes?.[0] ?? MAILBOX,
    consent: 'allow' as 'allow' | 'deny',
    /** Seconds an access token lives. */
    accessTokenTtl: options.accessTokenTtl ?? 3600,
    /** The window a mailbox's changes are batched over before one POST. */
    batchMs: options.batchMs ?? 15,
    /** Tamper with the clientState of the next N change notifications. */
    forgeClientState: 0,
    /** Hold each token answer this long AFTER the refresh token rotated — a slow refresh another process races. */
    tokenDelayMs: 0,
    /** Hold each delta answer this long AFTER it was read — a round still running when the next change lands. */
    deltaDelayMs: 0,
  }

  const open = (address: string): Mailbox => {
    let m = mailboxes.get(address)
    if (m) return m
    const folders = new Map<string, { id: string; displayName: string; wellKnown: string | null }>()
    for (const wk of WELL_KNOWN) {
      const id = `AQMk${randomUUID().replace(/-/g, '')}`
      folders.set(id, { id, displayName: { inbox: 'Inbox', sentitems: 'Sent Items', deleteditems: 'Deleted Items', drafts: 'Drafts', archive: 'Archive' }[wk], wellKnown: wk })
    }
    m = { address, userId: randomUUID(), displayName: address.split('@')[0], folders, messages: new Map(), changes: [], seq: 0, epoch: 1, refreshes: 0, revoked: null, grants: new Map() }
    mailboxes.set(address, m)
    return m
  }
  for (const a of options.mailboxes ?? [MAILBOX]) open(a)

  /** Every sent item in every mailbox, newest first. */
  const sentMail = () => {
    const out: { mailbox: string; id: string; subject: string; to: string[]; replyTo: string[]; sentDateTime: string; html: string; text: string | null; headers: { name: string; value: string }[] }[] = []
    for (const m of mailboxes.values()) {
      const sent = [...m.folders.values()].find((f) => f.wellKnown === 'sentitems')?.id
      for (const msg of m.messages.values()) {
        if (msg.folderId !== sent || msg.isDraft) continue
        out.push({ mailbox: m.address, id: msg.immutableId, subject: msg.subject, to: msg.to.map((a) => a.address), replyTo: msg.replyTo.map((a) => a.address), sentDateTime: msg.sentDateTime, html: msg.html, text: msg.text ?? null, headers: msg.headers })
      }
    }
    return out.sort((a, b) => b.sentDateTime.localeCompare(a.sentDateTime))
  }

  const folderId = (m: Mailbox, key: string): string | null => {
    if (m.folders.has(key)) return key
    for (const f of m.folders.values()) if (f.wellKnown === key.toLowerCase()) return f.id
    return null
  }

  const findMessage = (m: Mailbox, id: string) => {
    for (const msg of m.messages.values()) if (msg.immutableId === id || msg.restId === id) return msg
    return null
  }

  const restIdFor = (msg: { immutableId: string }, folder: string) => `AAMk${b64({ i: msg.immutableId, f: folder, n: randomUUID().slice(0, 6) })}`

  // ─── Change notifications ─────────────────────────────────────────────────

  const post = (url: string, body: unknown, kind: Delivery['kind'], subscriptionId: string | null, count: number) => {
    const p = fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (res) => { await res.text(); deliveries.push({ kind, url, status: res.status, count, subscriptionId }) })
      .catch(() => { deliveries.push({ kind, url, status: 0, count, subscriptionId }) })
    inflight.add(p)
    p.finally(() => inflight.delete(p))
    return p
  }

  const flush = () => {
    timer = null
    for (const [subId, value] of pending) {
      pending.delete(subId)
      const sub = subscriptions.get(subId)
      if (!sub) continue
      for (let i = 0; i < Math.max(1, knobs.duplicates); i++) post(sub.notificationUrl, { value }, 'change', subId, value.length)
    }
  }

  const live = (s: Subscription) => !s.removed && new Date(s.expirationDateTime).getTime() > Date.now()

  const changed = (m: Mailbox, msg: StandInMessage, changeType: 'created' | 'updated' | 'deleted') => {
    for (const sub of subscriptions.values()) {
      if (sub.mailbox !== m.address || !live(sub)) continue
      if (!knobs.notifications) {
        deliveries.push({ kind: 'change', url: sub.notificationUrl, status: 0, count: 1, subscriptionId: sub.id, dropped: true })
        continue
      }
      const forged = knobs.forgeClientState > 0
      if (forged) knobs.forgeClientState--
      const list = pending.get(sub.id) ?? []
      list.push({
        subscriptionId: sub.id,
        subscriptionExpirationDateTime: sub.expirationDateTime,
        changeType,
        resource: `Users/${m.userId}/Messages/${msg.restId}`,
        resourceData: { '@odata.type': '#Microsoft.Graph.Message', '@odata.id': `Users/${m.userId}/Messages/${msg.restId}`, id: msg.restId },
        clientState: forged ? 'forged-client-state' : sub.clientState,
        tenantId: TENANT_ID,
      })
      pending.set(sub.id, list)
    }
    if (pending.size && !timer) timer = setTimeout(flush, knobs.batchMs)
  }

  const log = (m: Mailbox, msg: StandInMessage, folder = msg.folderId, restId = msg.restId) => {
    m.seq++
    m.changes.push({ seq: m.seq, folderId: folder, immutableId: msg.immutableId, restId })
  }

  // ─── Rendering a message ──────────────────────────────────────────────────

  const render = (msg: StandInMessage, immutable: boolean, select: string[] | null, expand: string | null) => {
    const full: Record<string, unknown> = {
      id: immutable ? msg.immutableId : msg.restId,
      conversationId: msg.conversationId,
      internetMessageId: msg.internetMessageId,
      internetMessageHeaders: msg.headers,
      subject: msg.subject,
      body: { contentType: 'html', content: msg.html },
      uniqueBody: { contentType: 'html', content: msg.unique },
      bodyPreview: msg.unique.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 255),
      from: recipient(msg.from),
      sender: recipient(msg.from),
      toRecipients: msg.to.map(recipient),
      ccRecipients: msg.cc.map(recipient),
      replyTo: msg.replyTo.map(recipient),
      receivedDateTime: msg.receivedDateTime,
      sentDateTime: msg.sentDateTime,
      createdDateTime: msg.createdDateTime,
      isRead: msg.isRead,
      isDraft: msg.isDraft,
      hasAttachments: msg.attachments.some((a) => !a.isInline),
      webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(msg.restId)}`,
      parentFolderId: msg.folderId,
    }
    const out: Record<string, unknown> = { '@odata.etag': `W/"${msg.immutableId.slice(-6)}"` }
    if (select) {
      for (const k of new Set(['id', ...select])) if (k in full) out[k] = full[k]
    } else Object.assign(out, full)
    if (expand?.startsWith('attachments')) {
      const inner = /\$select=([^)]+)/.exec(expand)?.[1]?.split(',').map((s) => s.trim())
      out.attachments = msg.attachments.map((a) => {
        const whole: Record<string, unknown> = {
          '@odata.type': '#microsoft.graph.fileAttachment', id: a.id, name: a.name, contentType: a.contentType, size: a.bytes.byteLength, isInline: !!a.isInline,
          contentBytes: Buffer.from(a.bytes).toString('base64'),
        }
        if (!inner) return whole
        const picked: Record<string, unknown> = {}
        for (const k of inner) if (k in whole) picked[k] = whole[k]
        return picked
      })
    }
    return out
  }

  // ─── The server ───────────────────────────────────────────────────────────

  const server = Bun.serve({
    port: options.port ?? 0,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url)
      const path = decodeURIComponent(url.pathname)
      const query: Record<string, string> = {}
      for (const [k, v] of url.searchParams) query[k] = v
      const prefer = req.headers.get('prefer')
      const immutable = /IdType\s*=\s*"?ImmutableId"?/i.test(prefer ?? '')
      let mailbox: string | null = null
      let body: unknown

      if (path === '/__received') return Response.json(received)
      // CONTRACT C10: the control endpoints a drive out of process reaches.
      if (path === '/_sink/seen') return Response.json(received)
      if (req.method === 'POST' && path === '/_sink/reset') { api.reset(); return Response.json({ ok: true }) }
      if (req.method === 'POST' && path === '/_sink/arm') {
        const what = (await req.json()) as Record<string, any>
        const match = (m: { method?: string; path?: string }) => ({ method: m.method, path: m.path ? new RegExp(m.path) : undefined })
        if (what.failNext) api.failNext(match(what.failNext), what.failNext.status, what.failNext)
        if (what.dropNext) api.dropNext(match(what.dropNext), what.dropNext.times)
        if (what.expireAccessTokens) api.expireAccessTokens()
        if (what.expireDeltaTokens) api.expireDeltaTokens()
        if (what.revoke) api.revoke()
        if (what.lapse) api.lapse()
        if (what.knobs) Object.assign(knobs, what.knobs)
        return Response.json({ ok: true })
      }
      // What the app sent, to read as its recipient would (PLAN ruling 144):
      // a drive opens a survey email here and clicks a rating.
      if (path === '/__sent.json') return Response.json(sentMail())
      if (path === '/__sent') return new Response(sentPage(sentMail()), { headers: { 'content-type': 'text/html; charset=utf-8' } })
      if (req.method === 'POST' && path === '/__deliver') {
        const input = (await req.json()) as DeliverInput & { mailbox?: string }
        return Response.json(api.mailbox(input.mailbox ?? MAILBOX).deliver(input))
      }

      const answer = (res: Response) => {
        const entry: Received = { method: req.method, path, query, status: res.status, mailbox, prefer, ...(body !== undefined ? { body } : {}) }
        // A write made, and its answer lost on the way back.
        const di = res.status < 400 ? drops.findIndex((d) => (!d.method || d.method === req.method) && (!d.path || d.path.test(path))) : -1
        if (di >= 0) {
          if (--drops[di].times <= 0) drops.splice(di, 1)
          entry.dropped = true
        }
        received.push(entry)
        // A write to a mailbox — made, refused or dropped — kept past reset().
        if (req.method !== 'GET' && path.startsWith('/v1.0/me/')) writeLog.push(entry)
        if (entry.dropped) return graphError(504, 'GatewayTimeout', 'The answer was lost (stand-in dropNext).')
        return res
      }

      const ctype = req.headers.get('content-type') ?? ''
      if (req.method !== 'GET' && req.method !== 'DELETE') {
        const text = await req.text()
        // A MIME send (/me/sendMail) is base64 text/plain: kept as the string it is.
        body = ctype.includes('json') ? (text ? JSON.parse(text) : null) : ctype.startsWith('text/plain') ? text : Object.fromEntries(new URLSearchParams(text))
      }

      // A failure a test scripted for the next matching call.
      const fi = fails.findIndex((f) => (!f.method || f.method === req.method) && (!f.path || f.path.test(path)))
      if (fi >= 0) {
        const f = fails[fi]
        if (--f.times <= 0) fails.splice(fi, 1)
        const headers: Record<string, string> = f.retryAfter !== undefined ? { 'retry-after': String(f.retryAfter) } : {}
        const code = f.status === 429 ? 'ApplicationThrottled' : f.status === 401 ? 'InvalidAuthenticationToken' : 'ErrorInternalServerError'
        return answer(Response.json(f.body ?? { error: { code, message: `Scripted ${f.status}` } }, { status: f.status, headers }))
      }

      // ── login ──
      const login = /^\/([^/]+)\/oauth2\/v2\.0\/(authorize|token)$/.exec(path)
      if (login) {
        if (login[2] === 'authorize' && req.method === 'GET') {
          const redirect = query.redirect_uri
          if (!redirect || query.client_id !== CLIENT_ID || query.response_type !== 'code') return answer(new Response('AADSTS900144: bad request', { status: 400 }))
          const back = new URL(redirect)
          if (query.state !== undefined) back.searchParams.set('state', query.state)
          if (knobs.consent === 'deny') {
            back.searchParams.set('error', 'access_denied')
            back.searchParams.set('error_description', 'AADSTS65004: User declined to consent to access the app.')
          } else {
            const code = token('code')
            codes.set(code, { mailbox: knobs.signedIn, redirectUri: redirect, scope: query.scope ?? '' })
            back.searchParams.set('code', code)
          }
          return answer(new Response(null, { status: 302, headers: { location: back.toString() } }))
        }
        if (login[2] === 'token' && req.method === 'POST') {
          const form = body as Record<string, string>
          const bad = (error: string, description: string, status = 400) => answer(Response.json({ error, error_description: description, error_codes: [70000] }, { status }))
          if (form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET) return bad('invalid_client', 'AADSTS7000215: Invalid client secret provided.', 401)
          let m: Mailbox
          let grant: string
          if (form.grant_type === 'authorization_code') {
            const held = codes.get(form.code)
            codes.delete(form.code)
            if (!held || held.redirectUri !== form.redirect_uri) return bad('invalid_grant', 'AADSTS70008: The provided authorization code or refresh token has expired due to inactivity.')
            m = open(held.mailbox)
            m.revoked = null
            grant = randomUUID()
          } else if (form.grant_type === 'refresh_token') {
            const found = [...mailboxes.values()].flatMap((mb) => [...mb.grants].map(([g, rt]) => ({ mb, g, rt }))).find((x) => x.rt === form.refresh_token)
            const owner = [...mailboxes.values()].find((mb) => mb.revoked && form.refresh_token?.startsWith(`rt.${mb.address}.`))
            if (owner) return bad('invalid_grant', owner.revoked!)
            if (!found) return bad('invalid_grant', 'AADSTS70000: The provided grant is invalid or malformed — the refresh token was already redeemed.')
            m = found.mb
            grant = found.g
            m.refreshes++
          } else return bad('unsupported_grant_type', `AADSTS70003: ${form.grant_type}`)
          mailbox = m.address
          const access = token(`at.${m.address}`)
          const refresh = `rt.${m.address}.${randomUUID().replace(/-/g, '')}`
          m.grants.set(grant, refresh)
          accessTokens.set(access, { mailbox: m.address, expiresAt: Date.now() + knobs.accessTokenTtl * 1000 })
          // The rotation has happened; the answer is slow to arrive.
          if (knobs.tokenDelayMs) await Bun.sleep(knobs.tokenDelayMs)
          return answer(Response.json({ token_type: 'Bearer', scope: form.scope ?? 'Mail.ReadWrite Mail.Send User.Read', expires_in: knobs.accessTokenTtl, ext_expires_in: knobs.accessTokenTtl, access_token: access, refresh_token: refresh }))
        }
      }

      if (!path.startsWith('/v1.0/')) return answer(graphError(404, 'NotFound', `No route ${path}`))
      const route = path.slice('/v1.0'.length)

      // ── graph: who is calling ──
      const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
      const held = accessTokens.get(bearer)
      if (!held) return answer(graphError(401, 'InvalidAuthenticationToken', 'IDX14100: JWT is not well formed.'))
      const m = open(held.mailbox)
      if (m.revoked || held.expiresAt <= Date.now()) return answer(graphError(401, 'InvalidAuthenticationToken', 'Lifetime validation failed, the token is expired.'))
      mailbox = m.address

      const select = query.$select ? query.$select.split(',').map((s) => s.trim()) : null

      if (route === '/me' && req.method === 'GET') {
        return answer(Response.json({ id: m.userId, mail: m.address, userPrincipalName: m.address, displayName: m.displayName }))
      }

      // ── folders ──
      if (route === '/me/mailFolders' && req.method === 'GET') {
        const want = /^displayName eq '(.*)'$/.exec(query.$filter ?? '')?.[1]?.replace(/''/g, "'")
        const value = [...m.folders.values()].filter((f) => want === undefined || f.displayName === want).map((f) => ({ id: f.id, displayName: f.displayName }))
        return answer(Response.json({ value }))
      }
      if (route === '/me/mailFolders' && req.method === 'POST') {
        const name = (body as { displayName?: string })?.displayName
        if (!name) return answer(graphError(400, 'ErrorInvalidRequest', 'displayName is required'))
        return answer(Response.json(api.mailbox(m.address).createFolder(name), { status: 201 }))
      }
      const folderOne = /^\/me\/mailFolders\/([^/]+)$/.exec(route)
      if (folderOne && req.method === 'GET') {
        const id = folderId(m, folderOne[1])
        if (!id) return answer(graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'))
        const f = m.folders.get(id)!
        return answer(Response.json({ id: f.id, displayName: f.displayName }))
      }

      // ── delta ──
      const delta = /^\/me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(route)
      if (delta && req.method === 'GET') {
        if (query.$skiptoken) {
          const page = skipTokens.get(query.$skiptoken)
          if (!page) return answer(graphError(410, 'SyncStateNotFound', 'The sync state generation is not found.'))
          skipTokens.delete(query.$skiptoken)
          return answer(Response.json(pageOf(page.items, page.deltaToken, page.nextLinkBase)))
        }
        const fid = folderId(m, delta[1])
        if (!fid) return answer(graphError(404, 'ErrorItemNotFound', 'The specified folder was not found.'))
        let since: string | null = null
        let from = 0
        if (query.$deltatoken) {
          const t = unb64<{ f: string; s: string | null; q: number; e: number; mb: string }>(query.$deltatoken)
          if (!t || t.mb !== m.address || t.f !== fid) return answer(graphError(400, 'ErrorInvalidSyncStateData', 'The sync state is not valid.'))
          if (t.e !== m.epoch) return answer(graphError(410, 'SyncStateNotFound', 'The sync state generation is not found. Resync required.'))
          since = t.s
          from = t.q
        } else if (query.$filter) {
          const f = /^receivedDateTime ge (\S+)$/.exec(query.$filter)
          if (!f || Number.isNaN(Date.parse(f[1]))) return answer(graphError(400, 'ErrorInvalidUrlQueryFilter', 'The query filter contains one or more invalid nodes.'))
          since = new Date(f[1]).toISOString()
        }
        const inWindow = (msg: StandInMessage) => !since || msg.receivedDateTime >= since
        const items: unknown[] = []
        if (!query.$deltatoken) {
          for (const msg of m.messages.values()) if (msg.folderId === fid && inWindow(msg)) items.push(render(msg, immutable, select, null))
        } else {
          const seen = new Map<string, Change>()
          for (const c of m.changes) if (c.seq > from && c.folderId === fid) seen.set(c.immutableId, c)
          for (const c of seen.values()) {
            const msg = m.messages.get(c.immutableId)
            if (msg && msg.folderId === fid) {
              if (inWindow(msg)) items.push(render(msg, immutable, select, null))
            } else items.push({ id: immutable ? c.immutableId : c.restId, '@removed': { reason: msg ? 'changed' : 'deleted' } })
          }
        }
        const deltaToken = b64({ f: fid, s: since, q: m.seq, e: m.epoch, mb: m.address })
        const base = `${api.graphUrl}/me/mailFolders/${encodeURIComponent(delta[1])}/messages/delta`
        const page = pageOf(items, deltaToken, base)
        if (knobs.deltaDelayMs) await Bun.sleep(knobs.deltaDelayMs)
        return answer(Response.json(page))
      }

      // ── messages ──
      if (route === '/me/messages' && req.method === 'GET') {
        if (query.$orderby) return answer(graphError(400, 'InefficientFilter', 'The restriction or sort order is too complex for this operation.'))
        const want = /^conversationId eq '((?:[^']|'')*)'$/.exec(query.$filter ?? '')?.[1]?.replace(/''/g, "'")
        const mid = /^internetMessageId eq '((?:[^']|'')*)'$/.exec(query.$filter ?? '')?.[1]?.replace(/''/g, "'")
        if (query.$filter && want === undefined && mid === undefined) return answer(graphError(400, 'ErrorInvalidUrlQueryFilter', 'The query filter contains one or more invalid nodes.'))
        const all = [...m.messages.values()].filter((msg) => (want === undefined || msg.conversationId === want) && (mid === undefined || msg.internetMessageId === mid))
        const top = Math.min(Number(query.$top ?? PAGE) || PAGE, 1000)
        const skip = Number(query.$skip ?? 0) || 0
        const value = all.slice(skip, skip + top).map((msg) => render(msg, immutable, select, query.$expand ?? null))
        const out: Record<string, unknown> = { value }
        if (skip + top < all.length) {
          const next = new URL(`${api.graphUrl}/me/messages`)
          for (const [k, v] of Object.entries(query)) next.searchParams.set(k, v)
          next.searchParams.set('$skip', String(skip + top))
          out['@odata.nextLink'] = next.toString()
        }
        return answer(Response.json(out))
      }
      const value = /^\/me\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/.exec(route)
      if (value && req.method === 'GET') {
        const msg = findMessage(m, value[1])
        const att = msg?.attachments.find((a) => a.id === value[2])
        if (!att) return answer(graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'))
        return answer(new Response(att.bytes as unknown as BodyInit, { headers: { 'content-type': att.contentType } }))
      }
      const one = /^\/me\/messages\/([^/]+)$/.exec(route)
      if (one && req.method === 'GET') {
        const msg = findMessage(m, one[1])
        if (!msg) return answer(graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'))
        return answer(Response.json(render(msg, immutable, select, query.$expand ?? null)))
      }
      // ── a folder's messages ──
      const inFolder = /^\/me\/mailFolders\/([^/]+)\/messages$/.exec(route)
      if (inFolder && req.method === 'GET') {
        const fid = folderId(m, inFolder[1])
        if (!fid) return answer(graphError(404, 'ErrorItemNotFound', 'The specified folder was not found.'))
        const top = Math.min(Number(query.$top ?? PAGE) || PAGE, 1000)
        return answer(Response.json({ value: [...m.messages.values()].filter((msg) => msg.folderId === fid).slice(0, top).map((msg) => render(msg, immutable, select, null)) }))
      }

      // ── writes (S6) ──
      const json = (body ?? {}) as Record<string, any>
      const recipients = (list: unknown): Address[] =>
        Array.isArray(list) ? list.map((r: any) => ({ name: r?.emailAddress?.name, address: String(r?.emailAddress?.address ?? '') })).filter((a) => a.address.includes('@')) : []
      const badHeaders = (list: unknown) => Array.isArray(list) && list.some((h: any) => !/^x-/i.test(String(h?.name ?? '')))

      if (route === '/me/messages' && req.method === 'POST') {
        if (badHeaders(json.internetMessageHeaders)) return answer(graphError(400, 'InvalidInternetMessageHeader', 'The internet message header name should start with \'x-\' or \'X-\'.'))
        const msg = api.mailbox(m.address).draft({
          subject: json.subject ?? '', html: json.body?.content ?? '', to: recipients(json.toRecipients), cc: recipients(json.ccRecipients),
          headers: (json.internetMessageHeaders ?? []).map((h: any) => ({ name: String(h.name), value: String(h.value ?? '') })),
        })
        return answer(Response.json(render(msg, immutable, null, null), { status: 201 }))
      }
      const verb = /^\/me\/messages\/([^/]+)\/(createReply|createReplyAll|createForward|send|move)$/.exec(route)
      if (verb && req.method === 'POST') {
        const msg = findMessage(m, verb[1])
        if (!msg) return answer(graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'))
        const handle = api.mailbox(m.address)
        if (verb[2] === 'send') {
          if (!msg.isDraft) return answer(graphError(400, 'ErrorInvalidRequest', 'Only a draft can be sent.'))
          if (!msg.to.length && !msg.cc.length) return answer(graphError(400, 'ErrorInvalidRecipients', 'At least one recipient is not valid.'))
          handle.send(msg.immutableId)
          return answer(new Response(null, { status: 202 }))
        }
        if (verb[2] === 'move') {
          const to = folderId(m, String(json.destinationId ?? ''))
          if (!to) return answer(graphError(400, 'ErrorInvalidIdMalformed', 'Id is malformed.'))
          const moved = handle.move(msg.immutableId, to)
          return answer(Response.json(render(moved, immutable, null, null), { status: 201 }))
        }
        // Chosen, not measured: custom headers on a createReply-type draft are refused, as Graph documents them on create only.
        if (badHeaders(json.message?.internetMessageHeaders) || json.message?.internetMessageHeaders) {
          return answer(graphError(400, 'ErrorInvalidRequest', 'internetMessageHeaders can be set only when a message is created.'))
        }
        const forwardTo = recipients(json.toRecipients ?? json.message?.toRecipients)
        if (verb[2] === 'createForward' && !forwardTo.length) return answer(graphError(400, 'ErrorInvalidRecipients', 'Specify toRecipients for a forward.'))
        const draft = handle.answer(msg.immutableId, verb[2] as 'createReply' | 'createReplyAll' | 'createForward', forwardTo)
        return answer(Response.json(render(draft, immutable, null, null), { status: 201 }))
      }
      if (one && req.method === 'PATCH') {
        const msg = findMessage(m, one[1])
        if (!msg) return answer(graphError(404, 'ErrorItemNotFound', 'The specified object was not found in the store.'))
        if ('internetMessageHeaders' in json) return answer(graphError(400, 'ErrorInvalidRequest', 'internetMessageHeaders can be set only when a message is created.'))
        const content = ['body', 'subject', 'toRecipients', 'ccRecipients'].filter((k) => k in json)
        if (content.length && !msg.isDraft) return answer(graphError(400, 'ErrorInvalidRequest', `${content.join(', ')} can be updated only on a draft.`))
        if (json.body) { msg.html = String(json.body.content ?? ''); msg.unique = msg.html }
        if ('subject' in json) msg.subject = String(json.subject ?? '')
        if ('toRecipients' in json) msg.to = recipients(json.toRecipients)
        if ('ccRecipients' in json) msg.cc = recipients(json.ccRecipients)
        if ('isRead' in json) msg.isRead = !!json.isRead
        log(m, msg)
        changed(m, msg, 'updated')
        return answer(Response.json(render(msg, immutable, null, null)))
      }

      // Graph's MIME send: the whole message, base64, as text/plain; 202 and
      // nothing back, the sent copy in Sent Items (saveToSentItems' default).
      if (route === '/me/sendMail' && req.method === 'POST' && typeof body === 'string') {
        const mime = parseMime(body)
        if (!mime) return answer(graphError(400, 'ErrorMimeContentInvalidBase64String', 'Invalid base64 string for MIME content.'))
        if (!mime.to.length && !mime.cc.length) return answer(graphError(400, 'ErrorInvalidRecipients', 'At least one recipient is not valid.'))
        api.mailbox(m.address).deliver({
          folder: 'sentitems', isRead: true, from: { name: m.displayName, address: m.address },
          to: mime.to, cc: mime.cc, replyTo: mime.replyTo, subject: mime.subject, html: mime.html ?? '', text: mime.text ?? undefined,
          headers: mime.headers, ...(mime.messageId ? { internetMessageId: mime.messageId } : {}),
        })
        return answer(new Response(null, { status: 202 }))
      }

      if (route.startsWith('/me/messages') || route.startsWith('/me/sendMail') || /^\/me\/mailFolders\/[^/]+\/messages/.test(route)) {
        return answer(graphError(405, 'ErrorInvalidRequest', `The stand-in does not serve this mailbox write: ${req.method} ${route}`))
      }

      // ── subscriptions ──
      if (route === '/subscriptions' && req.method === 'GET') {
        return answer(Response.json({ value: [...subscriptions.values()].filter((s) => s.mailbox === m.address && !s.removed).map(subOut) }))
      }
      if (route === '/subscriptions' && req.method === 'POST') {
        const s = body as Partial<Subscription> & { expirationDateTime?: string }
        if (!s?.notificationUrl || !s.resource || !s.changeType || !s.expirationDateTime) return answer(graphError(400, 'InvalidRequest', 'notificationUrl, resource, changeType and expirationDateTime are required.'))
        const until = Date.parse(s.expirationDateTime)
        if (Number.isNaN(until) || until <= Date.now() || until > Date.now() + MAX_SUBSCRIPTION_MINUTES * 60_000 + 60_000) {
          return answer(graphError(400, 'InvalidRequest', `Subscription expiration can only be ${MAX_SUBSCRIPTION_MINUTES} minutes in the future.`))
        }
        if (s.resource !== 'me/messages' && !/^me\/mailFolders\('[^']+'\)\/messages$/.test(s.resource)) return answer(graphError(400, 'InvalidRequest', `Unsupported resource ${s.resource}`))
        for (const target of [s.notificationUrl, s.lifecycleNotificationUrl].filter(Boolean) as string[]) {
          const ok = await validate(target)
          if (!ok) return answer(graphError(400, 'InvalidRequest', 'Subscription validation request failed. Notification endpoint must respond with 200 OK to validation request.'))
        }
        const sub: Subscription = {
          id: randomUUID(), mailbox: m.address, resource: s.resource, changeType: s.changeType, notificationUrl: s.notificationUrl,
          lifecycleNotificationUrl: s.lifecycleNotificationUrl ?? null, clientState: s.clientState ?? null,
          expirationDateTime: new Date(until).toISOString(), removed: false,
        }
        subscriptions.set(sub.id, sub)
        return answer(Response.json(subOut(sub), { status: 201 }))
      }
      const subOne = /^\/subscriptions\/([^/]+)$/.exec(route)
      if (subOne) {
        const sub = subscriptions.get(subOne[1])
        if (!sub || sub.mailbox !== m.address || !live(sub)) return answer(graphError(404, 'ResourceNotFound', `The object was not found. Subscription ${subOne[1]}`))
        if (req.method === 'PATCH') {
          const until = Date.parse((body as { expirationDateTime?: string })?.expirationDateTime ?? '')
          if (Number.isNaN(until) || until > Date.now() + MAX_SUBSCRIPTION_MINUTES * 60_000 + 60_000) return answer(graphError(400, 'InvalidRequest', 'Bad expirationDateTime.'))
          sub.expirationDateTime = new Date(until).toISOString()
          return answer(Response.json(subOut(sub)))
        }
        if (req.method === 'DELETE') {
          sub.removed = true
          return answer(new Response(null, { status: 204 }))
        }
        if (req.method === 'GET') return answer(Response.json(subOut(sub)))
      }

      return answer(graphError(404, 'NotFound', `No route ${req.method} ${route}`))
    },
  })

  const subOut = (s: Subscription) => ({
    id: s.id, resource: s.resource, changeType: s.changeType, clientState: s.clientState, notificationUrl: s.notificationUrl,
    lifecycleNotificationUrl: s.lifecycleNotificationUrl, expirationDateTime: s.expirationDateTime, applicationId: CLIENT_ID,
  })

  const pageOf = (items: unknown[], deltaToken: string | null, base: string) => {
    if (items.length <= PAGE) return { value: items, '@odata.deltaLink': `${base}?$deltatoken=${deltaToken}` }
    const skip = randomUUID()
    skipTokens.set(skip, { items: items.slice(PAGE), deltaToken, nextLinkBase: base })
    return { value: items.slice(0, PAGE), '@odata.nextLink': `${base}?$skiptoken=${skip}` }
  }

  /** Graph's handshake: POST ?validationToken=…, and the endpoint must echo it, 200, text/plain. */
  async function validate(target: string): Promise<boolean> {
    const challenge = `Validation: Testing client application reachability for subscription Request-Id: ${randomUUID()}`
    const u = new URL(target)
    u.searchParams.set('validationToken', challenge)
    try {
      const res = await fetch(u, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, signal: AbortSignal.timeout(10_000) })
      const text = await res.text()
      const ok = res.status === 200 && text === challenge && (res.headers.get('content-type') ?? '').startsWith('text/plain')
      deliveries.push({ kind: 'validation', url: target, status: res.status, count: 0, subscriptionId: null })
      return ok
    } catch {
      deliveries.push({ kind: 'validation', url: target, status: 0, count: 0, subscriptionId: null })
      return false
    }
  }

  const api = {
    url: `http://localhost:${server.port}`,
    /** GRAPH_URL. */
    graphUrl: `http://localhost:${server.port}/v1.0`,
    /** loginUrl — the tenant's authority. */
    loginUrl: `http://localhost:${server.port}/organizations`,
    received,
    deliveries,
    knobs,

    mailbox(address = MAILBOX) {
      const m = open(address)
      const handle = {
        address: m.address,
        userId: m.userId,
        /** A folder's id, by well-known name, id or display name. */
        folder(key: string): string {
          const id = folderId(m, key) ?? [...m.folders.values()].find((f) => f.displayName === key)?.id
          if (!id) throw new Error(`standin: no folder ${key} in ${m.address}`)
          return id
        },
        createFolder(displayName: string) {
          const id = `AQMk${randomUUID().replace(/-/g, '')}`
          m.folders.set(id, { id, displayName, wellKnown: null })
          return { id, displayName }
        },
        /** New mail arrives (or, with `folder: 'sentitems'`, is sent). */
        deliver(input: DeliverInput): StandInMessage {
          const folder = handle.folder(input.folder ?? 'inbox')
          const at = input.receivedAt ? new Date(input.receivedAt).toISOString() : new Date().toISOString()
          const immutableId = input.id ?? `AAkALg${randomUUID().replace(/-/g, '')}`
          if (m.messages.has(immutableId)) throw new Error(`standin: ${m.address} already holds message ${immutableId}`)
          const html = input.html ?? `<html><body><p>${input.subject ?? ''}</p></body></html>`
          const msg: StandInMessage = {
            immutableId, restId: '', folderId: folder,
            internetMessageId: input.internetMessageId ?? `<${randomUUID()}@standin.outlook.test>`,
            conversationId: input.conversationId ?? `AAQk${randomUUID().replace(/-/g, '')}`,
            subject: input.subject ?? '', html, unique: input.unique ?? html, ...(input.text !== undefined ? { text: input.text } : {}),
            from: addr(input.from), to: (input.to ?? [m.address]).map(addr), cc: (input.cc ?? []).map(addr), replyTo: (input.replyTo ?? []).map(addr),
            receivedDateTime: at, sentDateTime: input.sentAt ? new Date(input.sentAt).toISOString() : at, isRead: input.isRead ?? false, isDraft: input.isDraft ?? false,
            attachments: (input.attachments ?? []).map((a) => ({
              id: a.id ?? `AAMkAtt${randomUUID().replace(/-/g, '').slice(0, 16)}`, name: a.name, contentType: a.contentType ?? 'application/octet-stream', isInline: a.isInline,
              bytes: typeof a.bytes === 'string' ? new TextEncoder().encode(a.bytes) : (a.bytes ?? new Uint8Array([1, 2, 3])),
            })),
            headers: input.headers ?? [{ name: 'X-MS-Exchange-Organization-AuthAs', value: 'Anonymous' }],
            createdDateTime: at,
          }
          msg.restId = restIdFor(msg, folder)
          m.messages.set(immutableId, msg)
          log(m, msg)
          changed(m, msg, 'created')
          return msg
        },
        /** A draft made by the API (POST /me/messages): in Drafts, in a new conversation. */
        draft(input: { subject: string; html: string; to: Address[]; cc: Address[]; headers: { name: string; value: string }[]; conversationId?: string }): StandInMessage {
          const folder = handle.folder('drafts')
          const at = new Date().toISOString()
          const msg: StandInMessage = {
            immutableId: `AAkALg${randomUUID().replace(/-/g, '')}`, restId: '', folderId: folder,
            internetMessageId: `<${randomUUID()}@standin.outlook.test>`,
            conversationId: input.conversationId ?? `AAQk${randomUUID().replace(/-/g, '')}`,
            subject: input.subject, html: input.html, unique: input.html,
            from: { name: m.displayName, address: m.address }, to: input.to, cc: input.cc, replyTo: [],
            receivedDateTime: at, sentDateTime: at, createdDateTime: at, isRead: true, isDraft: true, attachments: [],
            headers: input.headers,
          }
          msg.restId = restIdFor(msg, folder)
          m.messages.set(msg.immutableId, msg)
          log(m, msg)
          return msg
        },
        /** createReply / createReplyAll / createForward: a draft in the original's conversation, the original quoted. */
        answer(id: string, kind: 'createReply' | 'createReplyAll' | 'createForward', forwardTo: Address[] = []): StandInMessage {
          const orig = findMessage(m, id)
          if (!orig) throw new Error(`standin: no message ${id}`)
          const me = m.address.toLowerCase()
          const notMe = (list: Address[]) => list.filter((a) => a.address.toLowerCase() !== me)
          const sender = orig.replyTo.length ? orig.replyTo : [orig.from]
          const to = kind === 'createForward' ? forwardTo : kind === 'createReply' ? sender : notMe([...sender, ...orig.to])
          const prefix = kind === 'createForward' ? 'FW: ' : 'RE: '
          const draft = handle.draft({
            subject: `${prefix}${orig.subject}`, html: `<hr><div class="quoted">${orig.html}</div>`, to, cc: kind === 'createReplyAll' ? notMe(orig.cc) : [],
            headers: [], conversationId: orig.conversationId,
          })
          if (kind === 'createForward') draft.attachments = orig.attachments.map((a) => ({ ...a, id: `AAMkAtt${randomUUID().replace(/-/g, '').slice(0, 16)}` }))
          return draft
        },
        /** The draft is sent: a sent item under a NEW id, its Message-Id, thread and headers kept; the draft is gone. */
        send(id: string): StandInMessage {
          const draft = findMessage(m, id)
          if (!draft) throw new Error(`standin: no message ${id}`)
          log(m, draft)
          m.messages.delete(draft.immutableId)
          const folder = handle.folder('sentitems')
          const at = new Date().toISOString()
          const sent: StandInMessage = { ...draft, immutableId: `AAkALg${randomUUID().replace(/-/g, '')}`, folderId: folder, isDraft: false, sentDateTime: at, receivedDateTime: at }
          sent.restId = restIdFor(sent, folder)
          m.messages.set(sent.immutableId, sent)
          log(m, sent)
          changed(m, sent, 'created')
          return sent
        },
        /** A person moves it in Outlook: a new REST id, the same immutable id. */
        move(id: string, folderKey: string) {
          const msg = findMessage(m, id)
          if (!msg) throw new Error(`standin: no message ${id}`)
          const to = handle.folder(folderKey)
          log(m, msg, msg.folderId, msg.restId)
          msg.folderId = to
          msg.restId = restIdFor(msg, to)
          log(m, msg)
          changed(m, msg, 'updated')
          return msg
        },
        markRead(id: string, read = true) {
          const msg = findMessage(m, id)
          if (!msg) throw new Error(`standin: no message ${id}`)
          msg.isRead = read
          log(m, msg)
          changed(m, msg, 'updated')
          return msg
        },
        /** Deleted for good — emptied from Deleted Items. */
        destroy(id: string) {
          const msg = findMessage(m, id)
          if (!msg) throw new Error(`standin: no message ${id}`)
          m.messages.delete(msg.immutableId)
          log(m, msg)
          changed(m, msg, 'deleted')
        },
        message(id: string) { return findMessage(m, id) },
        messages() { return [...m.messages.values()] },
        get refreshes() { return m.refreshes },
      }
      return handle
    },

    /** Who consents at /authorize. */
    signIn(address: string) { open(address); knobs.signedIn = address },
    /** The grant is revoked at Microsoft's end: every refresh is invalid_grant, every token 401. */
    revoke(address = MAILBOX, description = 'AADSTS50173: The provided grant has expired due to it being revoked, a fresh auth token is needed.') {
      open(address).revoked = description
    },
    /** Every access token issued so far is expired; the next call with one answers 401. */
    expireAccessTokens(address?: string) {
      for (const v of accessTokens.values()) if (!address || v.mailbox === address) v.expiresAt = 0
    },
    /** Every delta token issued so far answers 410 (Exchange dropped the sync state). */
    expireDeltaTokens(address = MAILBOX) { open(address).epoch++ },
    /** The next `times` calls matching answer `status` (a 401, a 429 with Retry-After, a 503…). */
    failNext(match: { method?: string; path?: RegExp }, status: number, opts: { times?: number; retryAfter?: number; body?: unknown } = {}) {
      fails.push({ ...match, status, retryAfter: opts.retryAfter, body: opts.body, times: opts.times ?? 1 })
    },
    /**
     * The next `times` writes matching are MADE, and their answer is lost: the
     * caller sees a 504 GatewayTimeout, as a dropped connection would leave it
     * not knowing. What a retry must not repeat.
     */
    dropNext(match: { method?: string; path?: RegExp }, times = 1) {
      drops.push({ ...match, times })
    },
    /** The subscription stops notifying and is gone (PATCH answers 404), as one that lapsed. */
    lapse(id?: string) {
      for (const s of subscriptions.values()) if (!id || s.id === id) s.removed = true
    },
    /** A lifecycle event for a subscription, POSTed to its lifecycle URL. subscriptionRemoved also removes it. */
    async lifecycle(event: 'reauthorizationRequired' | 'subscriptionRemoved' | 'missed', id?: string, clientState?: string) {
      const sub = id ? subscriptions.get(id) : [...subscriptions.values()].find((s) => !s.removed)
      if (!sub?.lifecycleNotificationUrl) throw new Error('standin: no subscription with a lifecycle URL')
      if (event === 'subscriptionRemoved') sub.removed = true
      await post(sub.lifecycleNotificationUrl, {
        value: [{ subscriptionId: sub.id, subscriptionExpirationDateTime: sub.expirationDateTime, tenantId: TENANT_ID, clientState: clientState ?? sub.clientState, lifecycleEvent: event }],
      }, 'lifecycle', sub.id, 1)
    },
    subscriptions() { return [...subscriptions.values()] },
    /** Every batched notification delivered and answered. */
    async settle() {
      if (timer) { clearTimeout(timer); flush() }
      while (inflight.size) await Promise.all([...inflight])
    },
    /** Every mailbox write asked of it since it started — made, refused or dropped. reset() keeps them. */
    writes() { return [...writeLog] },
    reset() {
      received.length = 0
      deliveries.length = 0
      fails.length = 0
      drops.length = 0
      knobs.notifications = true
      knobs.duplicates = 1
      knobs.consent = 'allow'
      knobs.forgeClientState = 0
      knobs.tokenDelayMs = 0
      knobs.deltaDelayMs = 0
    },
    stop: () => { if (timer) clearTimeout(timer); server.stop(true) },
  }
  return api
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

/** The sent mail as a page: each email's body in a sandboxed frame, its links opening a new tab. */
function sentPage(mail: { mailbox: string; subject: string; to: string[]; replyTo: string[]; sentDateTime: string; html: string; text: string | null }[]): string {
  const items = mail.map((m) => `<article><h2>${esc(m.subject)}</h2><p>${esc(m.sentDateTime)} · from ${esc(m.mailbox)} to ${esc(m.to.join(', '))}${m.replyTo.length ? ` · reply-to ${esc(m.replyTo.join(', '))}` : ''}</p><iframe sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(`<base target="_blank">${m.html}`)}"></iframe>${m.text !== null ? `<details><summary>Text part</summary><pre>${esc(m.text)}</pre></details>` : ''}</article>`)
  return `<!doctype html><meta charset="utf-8"><title>Sent mail — Graph stand-in</title><style>body{font:14px system-ui;margin:16px;max-width:900px}article{border-top:1px solid #ccc;padding:8px 0}h2{font-size:16px;margin:0}p{color:#555;margin:4px 0}iframe{width:100%;height:420px;border:1px solid #ddd}pre{white-space:pre-wrap;background:#f6f6f6;padding:8px}</style><h1>Sent mail (${mail.length})</h1>${items.join('') || '<p>Nothing sent yet.</p>'}`
}

// ─── A MIME send, read as a receiver would ─────────────────────────────────
// Enough of RFC 5322/2045/2047 for what junction's toMime writes: folded
// headers, encoded-word subjects, quoted-printable or base64 parts, one level
// of multipart. Anything it cannot read is refused, as Graph refuses it.

type ParsedMime = { subject: string; to: Address[]; cc: Address[]; replyTo: Address[]; messageId: string | null; html: string | null; text: string | null; headers: { name: string; value: string }[] }

function headersOf(block: string): { name: string; value: string }[] {
  return block.replace(/\r\n[ \t]+/g, ' ').split('\r\n').filter(Boolean).map((line) => {
    const i = line.indexOf(':')
    return { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }
  })
}
const headerValue = (hs: { name: string; value: string }[], name: string) => hs.find((h) => h.name.toLowerCase() === name)?.value ?? null
const words = (v: string) => v.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_, enc: string, data: string) =>
  enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'))
const addresses = (v: string | null): Address[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const m = /^(.*)<([^>]+)>$/.exec(s)
  return m ? { name: words(m[1].trim().replace(/^"|"$/g, '')) || undefined, address: m[2].trim() } : { address: s }
})
function decodePart(hs: { name: string; value: string }[], body: string): string {
  const cte = (headerValue(hs, 'content-transfer-encoding') ?? '').toLowerCase()
  if (cte === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  if (cte === 'quoted-printable') {
    const bytes = body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    return Buffer.from(bytes, 'latin1').toString('utf8')
  }
  return body
}

export function parseMime(base64: string): ParsedMime | null {
  const raw = Buffer.from(base64.trim(), 'base64').toString('latin1')
  const split = raw.indexOf('\r\n\r\n')
  if (split < 0) return null
  const hs = headersOf(raw.slice(0, split))
  if (!headerValue(hs, 'from') && !headerValue(hs, 'to')) return null
  const body = raw.slice(split + 4)
  let html: string | null = null
  let text: string | null = null
  const ctype = headerValue(hs, 'content-type') ?? 'text/plain'
  const boundary = /boundary="([^"]+)"/i.exec(ctype)?.[1]
  const take = (partHeaders: { name: string; value: string }[], partBody: string) => {
    const t = (headerValue(partHeaders, 'content-type') ?? 'text/plain').toLowerCase()
    // As a mail client shows it: lines, not the wire's CRLF.
    if (t.startsWith('text/html')) html = decodePart(partHeaders, partBody).replace(/\r\n/g, '\n')
    else if (t.startsWith('text/plain')) text = decodePart(partHeaders, partBody).replace(/\r\n/g, '\n')
  }
  if (boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break
      const p = part.replace(/^\r\n/, '')
      const at = p.indexOf('\r\n\r\n')
      if (at < 0) continue
      take(headersOf(p.slice(0, at)), p.slice(at + 4).replace(/\r\n$/, ''))
    }
  } else take(hs, body)
  return {
    subject: words(headerValue(hs, 'subject') ?? ''),
    to: addresses(headerValue(hs, 'to')), cc: addresses(headerValue(hs, 'cc')), replyTo: addresses(headerValue(hs, 'reply-to')),
    messageId: headerValue(hs, 'message-id'),
    html, text,
    headers: hs.filter((h) => /^x-/i.test(h.name)),
  }
}

if (import.meta.main) {
  const sink = startMicrosoftSink({ port: Number(process.env.MICROSOFT_SINK_PORT ?? 0) })
  const box = sink.mailbox()
  box.deliver({ from: { name: 'Pat Customer', address: 'pat@example.test' }, subject: 'Lawn looks great', html: '<p>Thanks for the mow!</p>' })
  console.log(`Microsoft sink on ${sink.url}`)
  console.log(`  graphUrl=${sink.graphUrl} loginUrl=${sink.url} clientId=${CLIENT_ID} clientSecret=${CLIENT_SECRET}`)
  console.log(`  consents as ${MAILBOX}; POST /__deliver { from, subject, html } delivers mail; GET /_sink/seen lists what it was asked; GET /__sent shows what was sent`)
}
