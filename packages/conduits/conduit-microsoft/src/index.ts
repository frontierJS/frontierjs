// @frontierjs/conduit-microsoft — Microsoft's identity platform and Graph mail
// over conduit (FJS-D889; FJS-D1463 moved this out of ELA, where it ran live on
// one mailbox from 2026-07-22).
//
// The builder returns three descriptors and installs nothing (FJS-D890, C1);
// `bindMicrosoft` turns them into one Send per role, every call takes that
// bundle and picks its own role (C1, the bundle; C2), so the connector runs in
// a drive with no junction present.
//
// ─── Three targets, because conduit has one credential per target (FJS-2729) ──
//   graph       GET/POST/PATCH on /v1.0, JSON, the user's access token (per_caller, FJS-D848)
//   graph-mime  POST /me/sendMail with a base64 MIME body, `binary` encoding, same token, no retry
//   graph-login POST /oauth2/v2.0/token, form-encoded, no credential on the target: the
//               client id and secret ride in the form, as the identity platform reads them
//
// ─── The grant names the row ──────────────────────────────────────────────
// An account can connect several mailboxes, so a send on `graph` carries
// `who.grant` — the app's id for the stored grant — and the resolver in
// resolver.ts answers that row's access token. Under junction the plugin fills
// `tenant` and `principal` and the caller states only `grant`; a drive states
// all three.
//
// ─── Two ids for one message ──────────────────────────────────────────────
// A message's REST id changes when it moves folder; its immutable id does
// not. `Prefer: IdType="ImmutableId"` on every call makes Graph answer the
// immutable one, and a notification's `resourceData.id` is still the REST id
// (`resourceIdOf` in receive.ts), which a GET answers under the immutable one.
//
// ─── What stays the app's (C12) ───────────────────────────────────────────
// Mapping a message to a row, which folders a sync walks, when a thread is
// re-matched by Message-Id, what a write back means, and the raw routes the
// handshake and the OAuth redirect need.

import type { ConduitRequest, ConduitResult, CredentialCaller, ResponseValidator, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type MicrosoftFailure } from './errors.ts'
import type { Address, AttachmentMeta, DeltaPage, GraphMessage, GraphUser, MailFolder, Page, TokenSet } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './resolver.ts'
export * from './subscriptions.ts'
export * from './receive.ts'

export const GRAPH_URL      = 'https://graph.microsoft.com/v1.0'
export const LOGIN_URL      = 'https://login.microsoftonline.com'
export const DEFAULT_TENANT = 'organizations'
export const SCOPES         = ['offline_access', 'openid', 'profile', 'email', 'User.Read', 'Mail.ReadWrite', 'Mail.Send']
export const PREFER_IMMUTABLE = 'IdType="ImmutableId"'

/** The fields a sync reads off a message; `body` and `uniqueBody` are the big two. */
export const MESSAGE_SELECT = [
  'id', 'conversationId', 'internetMessageId', 'internetMessageHeaders', 'subject', 'body', 'uniqueBody',
  'from', 'sender', 'toRecipients', 'ccRecipients', 'replyTo', 'receivedDateTime', 'sentDateTime',
  'isRead', 'isDraft', 'hasAttachments', 'webLink', 'parentFolderId',
].join(',')

/** Metadata only: without the inner $select Graph inlines every file, base64'd. */
export const ATTACHMENT_EXPAND = 'attachments($select=id,name,size,contentType,isInline)'

export const FOLDERS = { inbox: 'inbox', sent: 'sentitems', drafts: 'drafts', deleted: 'deleteditems', archive: 'archive' } as const

// ─── send ─────────────────────────────────────────────────────────────────

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

/**
 * One Send per role, and graph's address, which a nextLink or deltaLink is
 * read against. Every call takes this and picks its own role, so no call can
 * be handed the mime or login target in place of graph (C1, the bundle).
 */
export interface MicrosoftSend { graph: Send; mime: Send; login: Send; graphAddress: string }

export interface BindOptions {
  /** Whose grant a `graph`/`mime` send spends. Under junction `tenant`/`principal` come off the call; a drive states them. */
  who?:   CredentialCaller
  grant?: string
}

type Bindable = MicrosoftTargets | { graph: { id: string; address: string }; mime: { id: string }; login: { id: string } }

export function bindMicrosoft(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: Bindable, opts: BindOptions = {}): MicrosoftSend {
  // The login target carries no credential: who/grant ride only the two that spend a grant.
  const caller = { ...(opts.who ? { who: opts.who } : {}), ...(opts.grant ? { grant: opts.grant } : {}) }
  return {
    graph: req => conduit.send({ target: targets.graph.id, ...caller, ...req }),
    mime:  req => conduit.send({ target: targets.mime.id, ...caller, ...req }),
    login: req => conduit.send({ target: targets.login.id, ...req }),
    graphAddress: targets.graph.address,
  }
}

// ─── targets ──────────────────────────────────────────────────────────────

export interface MicrosoftTargetOptions {
  /** The per-caller ref the resolver answers an access token under. */
  grantRef:  string
  /** A short name: `provider:<name>:graph`, `…:mime`, `…:login`. */
  name?:     string
  /** Graph's base INCLUDING the version, `https://graph.microsoft.com/v1.0`; a sink's `graphUrl` in a drive. */
  graphUrl?: string
  /** The identity platform's origin; the tenant goes on the path. */
  loginUrl?: string
  /** `organizations`, `common`, `consumers`, or a tenant id. */
  tenant?:   string
}

export interface MicrosoftTargets { graph: TargetDescriptor; mime: TargetDescriptor; login: TargetDescriptor }

export function microsoftTargets(opts: MicrosoftTargetOptions): MicrosoftTargets {
  const name   = opts.name ?? 'microsoft'
  const graph  = (opts.graphUrl ?? GRAPH_URL).replace(/\/$/, '')
  const login  = `${(opts.loginUrl ?? LOGIN_URL).replace(/\/$/, '')}/${opts.tenant ?? DEFAULT_TENANT}`
  const bearer = { type: 'bearer' as const, ref: opts.grantRef, per_caller: true as const }
  const now    = Date.now()
  return {
    graph: {
      id: `provider:${name}:graph`, kind: 'provider', protocol: 'http', address: graph, auth: bearer,
      headers:    { prefer: PREFER_IMMUTABLE },
      resilience: { timeout_ms: 30_000, retry_limit: 2 },
      registered_at: now, last_seen_at: null,
    },
    mime: {
      id: `provider:${name}:mime`, kind: 'provider', protocol: 'http', address: graph, auth: bearer,
      encoding:   'binary',
      headers:    { prefer: PREFER_IMMUTABLE, 'content-type': 'text/plain' },
      // A send is a write Graph gives no idempotency key for: a replay mails twice (C5, C6).
      resilience: { timeout_ms: 30_000, retry_limit: 0 },
      registered_at: now, last_seen_at: null,
    },
    login: {
      id: `provider:${name}:login`, kind: 'provider', protocol: 'http', address: login, auth: { type: 'none' },
      encoding:   'form',
      // A refresh ROTATES: a replay after a lost answer spends a token the first attempt already burned.
      resilience: { timeout_ms: 15_000, retry_limit: 0 },
      registered_at: now, last_seen_at: null,
    },
  }
}

// ─── answers ──────────────────────────────────────────────────────────────

export type Answer<K extends string, T> = { [P in K]?: T } & { error?: MicrosoftFailure }

const answer = <K extends string, T>(key: K, r: ConduitResult<unknown>, pick: (d: unknown) => T = d => d as T): Answer<K, T> =>
  r.error ? { error: translate(r.error, r.meta.status, (r.error.raw as { headers?: Record<string, string> } | undefined)?.headers) } as Answer<K, T>
          : { [key]: pick(r.data) } as Answer<K, T>

/** A local refusal, before anything is sent (C9). */
const refused = (message: string): MicrosoftFailure => ({ kind: 'refused', message, retryable: false })

/** A 2xx with none of these fields is a failure, whatever the status (C4). */
const having = <T>(...fields: string[]): ResponseValidator<T> => ({
  validate(data) {
    if (data === null || typeof data !== 'object') return { ok: false, errors: ['not an object'] }
    const missing = fields.filter(f => !(f in (data as object)))
    return missing.length ? { ok: false, errors: missing.map(f => `missing ${f}`) } : { ok: true, value: data as T }
  },
})

const PAGE = having<Page<unknown>>('value')

/** Graph's `@odata.nextLink`/`@odata.deltaLink` as a request on OUR target; a link off the graph origin is refused by name. */
export function linkToRequest(link: string, base: string): { path: string; query: Record<string, string> } | null {
  let u: URL, b: URL
  try { u = new URL(link); b = new URL(base) } catch { return null }
  if (u.origin !== b.origin || !u.pathname.startsWith(b.pathname)) return null
  const query: Record<string, string> = {}
  for (const [k, v] of u.searchParams) query[k] = v
  return { path: u.pathname.slice(b.pathname.length), query }
}

const followLink = <T>(ms: MicrosoftSend, link: string, call: string): Promise<Answer<'page', T>> => {
  const req = linkToRequest(link, ms.graphAddress)
  if (!req) return Promise.resolve({ error: refused(`${call}: the link ${new URL(link).origin} is not on the graph target; refused unsent.`) })
  return ms.graph<T>({ method: 'GET', path: req.path, query: req.query, validate: PAGE }).then(r => answer('page', r))
}

// ─── identity ─────────────────────────────────────────────────────────────

export function me(ms: MicrosoftSend) {
  return ms.graph<GraphUser>({ method: 'GET', path: '/me', validate: having('id') }).then(r => answer('user', r))
}

// ─── folders ──────────────────────────────────────────────────────────────

export function listFolders(ms: MicrosoftSend, opts: { displayName?: string } = {}) {
  const query = opts.displayName !== undefined ? { $filter: `displayName eq '${opts.displayName.replace(/'/g, "''")}'` } : undefined
  return ms.graph<Page<MailFolder>>({ method: 'GET', path: '/me/mailFolders', ...(query ? { query } : {}), validate: PAGE }).then(r => answer('folders', r, d => (d as Page<MailFolder>).value ?? []))
}

/** By id or well-known name (`inbox`, `sentitems`). */
export function folder(ms: MicrosoftSend, idOrWellKnown: string) {
  return ms.graph<MailFolder>({ method: 'GET', path: `/me/mailFolders/${encodeURIComponent(idOrWellKnown)}`, validate: having('id') }).then(r => answer('folder', r))
}

export function createFolder(ms: MicrosoftSend, displayName: string) {
  return ms.graph<MailFolder>({ method: 'POST', path: '/me/mailFolders', body: { displayName }, validate: having('id') }).then(r => answer('folder', r))
}

// ─── delta ────────────────────────────────────────────────────────────────

export interface DeltaStartOptions {
  /** The first round carries `receivedDateTime ge <since>`; Graph bakes it into every later token. */
  since?:  Date | string
  /** Narrow what each item carries; a sync asks for ids and fetches the conversation. */
  select?: string
}

/** The first page of a folder's first round. Every later page and round goes through `deltaNext`. */
export function deltaStart(ms: MicrosoftSend, folderId: string, opts: DeltaStartOptions = {}) {
  const query: Record<string, string> = {}
  if (opts.since !== undefined) query.$filter = `receivedDateTime ge ${typeof opts.since === 'string' ? opts.since : opts.since.toISOString()}`
  if (opts.select) query.$select = opts.select
  return ms.graph<DeltaPage>({ method: 'GET', path: `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta`, query, validate: PAGE }).then(r => answer('page', r))
}

/** A `@odata.nextLink` (same round) or `@odata.deltaLink` (the next round). A 410 is `sync_reset`: start the folder over. */
export const deltaNext = (ms: MicrosoftSend, link: string): Promise<Answer<'page', DeltaPage>> => followLink<DeltaPage>(ms, link, 'deltaNext')

export interface DeltaRound { items: GraphMessage[]; removed: string[]; deltaLink: string; pages: number }

/** One whole round: from a start page or a deltaLink through every nextLink to the deltaLink. */
export async function walkDelta(ms: MicrosoftSend, from: { folderId: string } & DeltaStartOptions | { deltaLink: string }): Promise<Answer<'round', DeltaRound>> {
  let r = 'deltaLink' in from ? await deltaNext(ms, from.deltaLink) : await deltaStart(ms, from.folderId, from)
  const items: GraphMessage[] = [], removed: string[] = []
  let pages = 0
  for (;;) {
    if (r.error) return { error: r.error }
    const page = r.page!
    pages++
    for (const it of page.value ?? []) ('@removed' in it && it['@removed']) ? removed.push(it.id) : items.push(it)
    if (page['@odata.deltaLink']) return { round: { items, removed, deltaLink: page['@odata.deltaLink'], pages } }
    if (!page['@odata.nextLink']) return { error: refused('walkDelta: a delta page carried neither nextLink nor deltaLink') }
    r = await deltaNext(ms, page['@odata.nextLink'])
  }
}

// ─── messages ─────────────────────────────────────────────────────────────

export interface ConversationOptions { select?: string; expand?: string; top?: number }

/** Every message of a conversation, all pages, with attachment METADATA. */
export async function conversation(ms: MicrosoftSend, conversationId: string, opts: ConversationOptions = {}): Promise<Answer<'messages', GraphMessage[]>> {
  const query = {
    $filter: `conversationId eq '${conversationId.replace(/'/g, "''")}'`,
    $select: opts.select ?? MESSAGE_SELECT,
    $expand: opts.expand ?? ATTACHMENT_EXPAND,
    $top:    String(opts.top ?? 50),
  }
  let r = answer('page', await ms.graph<Page<GraphMessage>>({ method: 'GET', path: '/me/messages', query, validate: PAGE }))
  const messages: GraphMessage[] = []
  for (;;) {
    if (r.error) return { error: r.error }
    messages.push(...(r.page!.value ?? []))
    const next = r.page!['@odata.nextLink']
    if (!next) return { messages }
    r = await followLink<Page<GraphMessage>>(ms, next, 'conversation')
  }
}

export function message(ms: MicrosoftSend, id: string, opts: { select?: string; expand?: string } = {}) {
  const query = { $select: opts.select ?? MESSAGE_SELECT, $expand: opts.expand ?? ATTACHMENT_EXPAND }
  return ms.graph<GraphMessage>({ method: 'GET', path: `/me/messages/${encodeURIComponent(id)}`, query, validate: having('id') }).then(r => answer('message', r))
}

/** The bytes, on demand; a sync never pulls them. Conduit hands a non-text content type over as bytes (FJS-D585). */
export function attachmentBytes(ms: MicrosoftSend, messageId: string, attachmentId: string) {
  return ms.graph<Uint8Array | string>({ method: 'GET', path: `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value` })
    .then(r => answer('bytes', r, d => typeof d === 'string' ? new TextEncoder().encode(d) : d as Uint8Array))
}

export function attachments(ms: MicrosoftSend, messageId: string) {
  return ms.graph<Page<AttachmentMeta>>({ method: 'GET', path: `/me/messages/${encodeURIComponent(messageId)}/attachments`, query: { $select: 'id,name,size,contentType,isInline' }, validate: PAGE })
    .then(r => answer('attachments', r, d => (d as Page<AttachmentMeta>).value ?? []))
}

export function findByInternetMessageId(ms: MicrosoftSend, internetMessageId: string) {
  const query = { $filter: `internetMessageId eq '${internetMessageId.replace(/'/g, "''")}'`, $select: MESSAGE_SELECT, $top: '1' }
  return ms.graph<Page<GraphMessage>>({ method: 'GET', path: '/me/messages', query, validate: PAGE }).then(r => answer('message', r, d => (d as Page<GraphMessage>).value?.[0] ?? null))
}

// ─── writes ───────────────────────────────────────────────────────────────

const recipient = (a: Address) => ({ emailAddress: { ...(a.name ? { name: a.name } : {}), address: a.address } })

export interface DraftInput {
  subject?:  string
  html?:     string
  text?:     string
  to?:       Address[]
  cc?:       Address[]
  bcc?:      Address[]
  replyTo?:  Address[]
  /** Custom headers; Graph accepts them on a NEW draft only, and only names beginning `x-`. */
  headers?:  { name: string; value: string }[]
}

function draftBody(input: DraftInput): Record<string, unknown> | MicrosoftFailure {
  const bad = input.headers?.find(h => !/^x-/i.test(h.name))
  if (bad) return refused(`createDraft: Graph accepts custom headers named x-*, and '${bad.name}' is not; refused unsent.`)
  const body: Record<string, unknown> = {}
  if (input.subject !== undefined) body.subject = input.subject
  if (input.html !== undefined) body.body = { contentType: 'html', content: input.html }
  else if (input.text !== undefined) body.body = { contentType: 'text', content: input.text }
  if (input.to) body.toRecipients = input.to.map(recipient)
  if (input.cc) body.ccRecipients = input.cc.map(recipient)
  if (input.bcc) body.bccRecipients = input.bcc.map(recipient)
  if (input.replyTo) body.replyTo = input.replyTo.map(recipient)
  if (input.headers?.length) body.internetMessageHeaders = input.headers
  return body
}

/** A new draft in Drafts. Send it with `sendDraft`. */
export function createDraft(ms: MicrosoftSend, input: DraftInput) {
  const body = draftBody(input)
  if ('kind' in body) return Promise.resolve({ error: body as MicrosoftFailure } as Answer<'draft', GraphMessage>)
  return ms.graph<GraphMessage>({ method: 'POST', path: '/me/messages', body, validate: having('id') }).then(r => answer('draft', r))
}

export type ReplyKind = 'reply' | 'replyAll' | 'forward'

/** A draft in the thread, quoting the original as Outlook does; headers cannot be set on it. */
export function createReply(ms: MicrosoftSend, messageId: string, kind: ReplyKind, input: Omit<DraftInput, 'headers'> = {}) {
  const verb = { reply: 'createReply', replyAll: 'createReplyAll', forward: 'createForward' }[kind]
  const message = draftBody(input) as Record<string, unknown>
  return ms.graph<GraphMessage>({ method: 'POST', path: `/me/messages/${encodeURIComponent(messageId)}/${verb}`, body: Object.keys(message).length ? { message } : {}, validate: having('id') })
    .then(r => answer('draft', r))
}

/** `isRead` on any message; body, subject and recipients on a draft. Never the headers. */
export function patchMessage(ms: MicrosoftSend, messageId: string, patch: Partial<Pick<GraphMessage, 'isRead' | 'subject'>> & Omit<DraftInput, 'headers' | 'subject'>) {
  const { isRead, ...rest } = patch
  const body = { ...(draftBody(rest) as Record<string, unknown>), ...(isRead !== undefined ? { isRead } : {}) }
  return ms.graph<GraphMessage>({ method: 'PATCH', path: `/me/messages/${encodeURIComponent(messageId)}`, body, validate: having('id') }).then(r => answer('message', r))
}

/**
 * The draft becomes a sent item under a NEW id. Graph answers 202 with no
 * body, so the answer is `sent: true`. A lost answer is indeterminate: the
 * resolving read is `findByInternetMessageId` with the draft's Message-Id (C6).
 */
export function sendDraft(ms: MicrosoftSend, draftId: string) {
  return ms.graph<null>({ method: 'POST', path: `/me/messages/${encodeURIComponent(draftId)}/send` }).then(r => answer('sent', r, () => true as const))
}

/** To a folder id or well-known name. The REST id changes; the immutable id does not. */
export function moveMessage(ms: MicrosoftSend, messageId: string, destinationId: string) {
  return ms.graph<GraphMessage>({ method: 'POST', path: `/me/messages/${encodeURIComponent(messageId)}/move`, body: { destinationId }, validate: having('id') }).then(r => answer('message', r))
}

/**
 * A whole MIME message, as junction's `toMime` writes one, through the `mime`
 * target: Graph wants the base64 as a text/plain body. Lost answer: resolving
 * read is `findByInternetMessageId` with the MIME's Message-Id.
 */
export function sendMime(ms: MicrosoftSend, mimeBase64: string) {
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(mimeBase64)) return Promise.resolve({ error: refused('sendMime: the body is not base64; refused unsent.') } as Answer<'sent', true>)
  return ms.mime<null>({ method: 'POST', path: '/me/sendMail', body: new TextEncoder().encode(mimeBase64), headers: { 'content-type': 'text/plain' } }).then(r => answer('sent', r, () => true as const))
}

// ─── login ────────────────────────────────────────────────────────────────

export interface ClientCredentials { clientId: string; clientSecret: string }

export interface AuthorizeInput extends Pick<ClientCredentials, 'clientId'> {
  redirectUri: string
  /** The app's own CSRF token; comes back on the redirect. */
  state:       string
  scopes?:     string[]
  loginUrl?:   string
  tenant?:     string
  /** Microsoft's `prompt`: `select_account` lets a person pick a second mailbox. */
  prompt?:     'login' | 'consent' | 'select_account' | 'none'
  loginHint?:  string
}

/** Where to send the browser. Pure. */
export function authorizeUrl(input: AuthorizeInput): string {
  const u = new URL(`${(input.loginUrl ?? LOGIN_URL).replace(/\/$/, '')}/${input.tenant ?? DEFAULT_TENANT}/oauth2/v2.0/authorize`)
  u.searchParams.set('client_id', input.clientId)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('redirect_uri', input.redirectUri)
  u.searchParams.set('response_mode', 'query')
  u.searchParams.set('scope', (input.scopes ?? SCOPES).join(' '))
  u.searchParams.set('state', input.state)
  if (input.prompt) u.searchParams.set('prompt', input.prompt)
  if (input.loginHint) u.searchParams.set('login_hint', input.loginHint)
  return u.toString()
}

const TOKENS = having<TokenSet>('access_token')

/** The redirect's `code` for a token set. The `refresh_token` in it is the grant the app stores. */
export function exchangeCode(ms: MicrosoftSend, creds: ClientCredentials, input: { code: string; redirectUri: string; scopes?: string[] }) {
  const body = { client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri, scope: (input.scopes ?? SCOPES).join(' ') }
  return ms.login<TokenSet>({ method: 'POST', path: '/oauth2/v2.0/token', body, validate: TOKENS }).then(r => answer('tokens', r))
}

/**
 * A new access token, and a NEW refresh token: Microsoft rotates on every use
 * and the spent one is dead, so the caller writes `tokens.refresh_token` back
 * before it does anything else. `grant_lost` is the refusal that says the
 * person must sign in again.
 */
export function refreshGrant(ms: MicrosoftSend, creds: ClientCredentials, input: { refreshToken: string; scopes?: string[] }) {
  const body = { client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'refresh_token', refresh_token: input.refreshToken, scope: (input.scopes ?? SCOPES).join(' ') }
  return ms.login<TokenSet>({ method: 'POST', path: '/oauth2/v2.0/token', body, validate: TOKENS }).then(r => answer('tokens', r))
}

// ─── reading a message, pure ──────────────────────────────────────────────

export const addressOf = (r: { emailAddress?: { name?: string | null; address?: string | null } | null } | null | undefined): Address | null =>
  r?.emailAddress?.address ? { address: r.emailAddress.address.toLowerCase(), ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}) } : null

export const addressesOf = (rs: Parameters<typeof addressOf>[0][] | null | undefined): Address[] =>
  (rs ?? []).map(addressOf).filter((a): a is Address => a !== null)

export const headerOf = (m: Pick<GraphMessage, 'internetMessageHeaders'>, name: string): string | undefined =>
  m.internetMessageHeaders?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value
