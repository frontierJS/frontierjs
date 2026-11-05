// @frontierjs/conduit-gmail — Gmail over conduit: read, watch, send.
//
// The DIALECT only: the target, the calls under `/gmail/v1/users/me`, the
// error table, the MIME builder, the message parser, the push envelope. The
// sync ENGINE — the watermark row, threading to a contact, when to re-arm the
// watch — is the app's, since mail as data is a cursor and a cursor is out of
// conduit. Every call takes `send` (CONTRACT C2) and the builder installs
// nothing; the credential is a USER's OAuth access token carrying a Gmail
// scope, minted by the app's resolver or conduit-oidc's leg three, never here.
//
// ─── What is refused before the send (C9) ───────────────────────────────
// A header with a line break, a `to` with no `@`, a reply whose Subject is
// not the parent's: `buildMime` throws. A raw message past 25 MB, a reply
// with In-Reply-To and no `threadId` (how mid-thread replies fork), a `watch`
// with no topic, a `maxResults` past 500: the call throws, zero attempts.
//
// ─── Not built ──────────────────────────────────────────────────────────
// The batch endpoint (`POST /batch/gmail/v1`, multipart/mixed: conduit has
// one `encoding` per target); the upload path (attachments); drafts; label
// creation; settings; the `gmail.metadata` scope.

import type { ConduitRequest, ConduitResult, ResponseValidator, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type GmailFailure } from './errors.ts'
import { MAX_RAW_BYTES, messageIdOf, toRaw } from './mime.ts'
import type {
  AttachmentAnswer, GmailMessage, GmailProfile, GmailThread, HistoryPage, HistoryType, LabelList, MessageList, SendAnswer, WatchAnswer,
} from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './mime.ts'
export * from './parse.ts'
export * from './history.ts'
export * from './push.ts'

export const GMAIL_TARGET  = 'provider:gmail'
export const GMAIL_ADDRESS = 'https://gmail.googleapis.com'
/** RESTRICTED at Google: read, modify, send. `gmail.send` alone is only sensitive, and cannot read. */
export const GMAIL_SCOPE   = 'https://www.googleapis.com/auth/gmail.modify'
export const BASE          = '/gmail/v1/users/me'
export const MAX_LIST      = 500
export const WATCH_TTL_MS  = 7 * 24 * 60 * 60 * 1000

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>

export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: TargetDescriptor | string = GMAIL_TARGET): Send {
  const id = typeof target === 'string' ? target : target.id
  return req => conduit.send({ target: id, ...req })
}

export interface GmailTargetOptions {
  /** The resolver's ref for the user's access token. */
  ref?:       string
  address?:   string
  id?:        string
  /** The token belongs to whoever the send is for; the resolver must have `getFor`. */
  perCaller?: boolean
}

/** One host, one target; Google's shape for resilience, as the app's other Google targets. */
export function gmailTarget(opts: GmailTargetOptions = {}): TargetDescriptor {
  return {
    id:            opts.id ?? GMAIL_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       opts.address ?? GMAIL_ADDRESS,
    encoding:      'json',
    auth:          { type: 'bearer', ref: opts.ref ?? 'GOOGLE_GRANT', ...(opts.perCaller ? { per_caller: true as const } : {}) },
    resilience:    { timeout_ms: 15_000, retry_limit: 2 },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── Validation (C4) ──────────────────────────────────────────────────────

/** A 2xx that is not an object, carries the error envelope, or lacks the shape's keys is `invalid_response`. */
const shape = <T>(name: string, ...required: string[]): ResponseValidator<T> => ({
  validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: [`gmail: ${name} expected a JSON object`] }
    if ('error' in data) return { ok: false, errors: [`gmail: ${name} answered Google's error envelope under a 2xx`] }
    const missing = required.filter(k => !(k in data))
    if (missing.length) return { ok: false, errors: [`gmail: ${name} lacks ${missing.join(', ')}`] }
    return { ok: true, value: data as T }
  },
})

export const profileValidator    = shape<GmailProfile>('profile', 'emailAddress', 'historyId')
export const listValidator       = shape<MessageList>('messages.list')
export const messageValidator    = shape<GmailMessage>('message', 'id', 'threadId')
export const threadValidator     = shape<GmailThread>('thread', 'id', 'messages')
export const historyValidator    = shape<HistoryPage>('history', 'historyId')
export const watchValidator      = shape<WatchAnswer>('watch', 'historyId', 'expiration')
export const sendValidator       = shape<SendAnswer>('send', 'id', 'threadId')
export const labelsValidator     = shape<LabelList>('labels')
export const attachmentValidator = shape<AttachmentAnswer>('attachment', 'data')

type Answer<K extends string, T> = { [P in K]?: T } & { error?: GmailFailure }

const fail = (result: { error: NonNullable<ConduitResult<unknown>['error']>; meta: { status?: number; headers?: Record<string, string> } }) =>
  translate(result.error, result.meta.status, result.meta.headers)

// ─── Reads ────────────────────────────────────────────────────────────────

/** `GET /profile`: the address and the current `historyId`, 1 unit. The watermark without walking anything. */
export async function getProfile(send: Send): Promise<Answer<'profile', GmailProfile>> {
  const r = await send<GmailProfile>({ method: 'GET', path: `${BASE}/profile`, validate: profileValidator })
  return r.error ? { error: fail(r) } : { profile: r.data }
}

export interface ListMessagesOptions { q?: string; labelIds?: string[]; pageToken?: string; maxResults?: number; includeSpamTrash?: boolean }

/** `GET /messages`: ids and thread ids only, 5 units. Discovery, never ingestion. */
export async function listMessages(send: Send, opts: ListMessagesOptions = {}): Promise<Answer<'list', MessageList>> {
  const max = opts.maxResults ?? MAX_LIST
  if (!Number.isInteger(max) || max < 1 || max > MAX_LIST) throw new TypeError(`gmail: maxResults must be 1..${MAX_LIST}, got ${max}`)
  const r = await send<MessageList>({
    method: 'GET',
    path:   `${BASE}/messages`,
    query:  {
      maxResults: max,
      ...(opts.q         ? { q: opts.q } : {}),
      ...(opts.labelIds  ? { labelIds: opts.labelIds } : {}),
      ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
      ...(opts.includeSpamTrash ? { includeSpamTrash: true } : {}),
    },
    validate: listValidator,
  })
  return r.error ? { error: fail(r) } : { list: r.data }
}

export type MessageFormat = 'full' | 'metadata' | 'minimal'

/** `GET /messages/{id}`, 20 units. `metadata` with `metadataHeaders` is the cheap first pass over a thread. */
export async function getMessage(send: Send, id: string, opts: { format?: MessageFormat; metadataHeaders?: string[] } = {}): Promise<Answer<'message', GmailMessage>> {
  assertId(id, 'message')
  const r = await send<GmailMessage>({
    method:   'GET',
    path:     `${BASE}/messages/${id}`,
    query:    { format: opts.format ?? 'full', ...(opts.metadataHeaders ? { metadataHeaders: opts.metadataHeaders } : {}) },
    validate: messageValidator,
  })
  return r.error ? { error: fail(r) } : { message: r.data }
}

/** `GET /threads/{id}`, 40 units: every message, so no message is a false root. */
export async function getThread(send: Send, id: string, opts: { format?: MessageFormat; metadataHeaders?: string[] } = {}): Promise<Answer<'thread', GmailThread>> {
  assertId(id, 'thread')
  const r = await send<GmailThread>({
    method:   'GET',
    path:     `${BASE}/threads/${id}`,
    query:    { format: opts.format ?? 'full', ...(opts.metadataHeaders ? { metadataHeaders: opts.metadataHeaders } : {}) },
    validate: threadValidator,
  })
  return r.error ? { error: fail(r) } : { thread: r.data }
}

export interface ListHistoryOptions { startHistoryId: string; historyTypes?: readonly HistoryType[]; labelId?: string; pageToken?: string; maxResults?: number }

/**
 * `GET /history`, 2 units. A 404 is the ONE place a status means more than
 * `gone`: the watermark aged out of Gmail's window, so it is `history_gap`
 * and the app full-syncs by query. An empty `history` is an answer.
 */
export async function listHistory(send: Send, opts: ListHistoryOptions): Promise<Answer<'page', HistoryPage>> {
  if (!/^\d+$/.test(opts.startHistoryId)) throw new TypeError(`gmail: '${opts.startHistoryId}' is not a history id`)
  const r = await send<HistoryPage>({
    method: 'GET',
    path:   `${BASE}/history`,
    query:  {
      startHistoryId: opts.startHistoryId,
      ...(opts.historyTypes ? { historyTypes: [...opts.historyTypes] } : {}),
      ...(opts.labelId    ? { labelId: opts.labelId } : {}),
      ...(opts.pageToken  ? { pageToken: opts.pageToken } : {}),
      ...(opts.maxResults ? { maxResults: opts.maxResults } : {}),
    },
    validate: historyValidator,
  })
  if (!r.error) return { page: r.data }
  const failure = fail(r)
  return { error: failure.kind === 'gone' ? { ...failure, kind: 'history_gap' } : failure }
}

/** `GET /labels`, 1 unit. */
export async function listLabels(send: Send): Promise<Answer<'labels', LabelList>> {
  const r = await send<LabelList>({ method: 'GET', path: `${BASE}/labels`, validate: labelsValidator })
  return r.error ? { error: fail(r) } : { labels: r.data }
}

/** `GET /messages/{m}/attachments/{a}`, 20 units. Bytes are base64url in `data`; nothing here keeps them. */
export async function getAttachment(send: Send, messageId: string, attachmentId: string): Promise<Answer<'attachment', AttachmentAnswer>> {
  assertId(messageId, 'message')
  if (!attachmentId) throw new TypeError('gmail: an attachment id is required')
  const r = await send<AttachmentAnswer>({ method: 'GET', path: `${BASE}/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`, validate: attachmentValidator })
  return r.error ? { error: fail(r) } : { attachment: r.data }
}

/**
 * The C6 read: Gmail indexes the Message-ID header, so the id minted before
 * a send says whether a lost send landed. `null` means it did not.
 */
export async function findByMessageId(send: Send, messageId: string): Promise<Answer<'found', Pick<GmailMessage, 'id' | 'threadId'> | null>> {
  const bare = messageId.replace(/^<|>$/g, '')
  if (!bare.includes('@')) throw new TypeError(`gmail: '${messageId}' is not a Message-ID`)
  const r = await listMessages(send, { q: `rfc822msgid:${bare}`, maxResults: 1 })
  if (r.error) return { error: r.error }
  return { found: r.list!.messages?.[0] ?? null }
}

// ─── Writes ───────────────────────────────────────────────────────────────

export interface WatchOptions { topicName: string; labelIds?: string[]; labelFilterBehavior?: 'include' | 'exclude' }

/**
 * `POST /watch`, 100 units, after `POST /stop` so the new watch replaces the
 * old rather than stacking. `replayable: true`: a watch is a state, and
 * setting it twice is the same state. `expiration` is seven days out, and the
 * watch dies silently then — renewing daily is the app's job.
 */
export async function watch(send: Send, opts: WatchOptions): Promise<Answer<'watch', WatchAnswer>> {
  if (!opts.topicName || !/^projects\/[^/]+\/topics\/[^/]+$/.test(opts.topicName))
    throw new TypeError(`gmail: watch needs a topicName like projects/{project}/topics/{topic}, got '${opts.topicName ?? ''}'`)
  const stopped = await stop(send)
  if (stopped.error && stopped.error.kind !== 'gone') return { error: stopped.error }
  const r = await send<WatchAnswer>({
    method:     'POST',
    path:       `${BASE}/watch`,
    body:       { topicName: opts.topicName, labelIds: opts.labelIds ?? ['INBOX'], labelFilterBehavior: opts.labelFilterBehavior ?? 'include' },
    validate:   watchValidator,
    replayable: true,
  })
  return r.error ? { error: fail(r) } : { watch: r.data }
}

/** `POST /stop`, 50 units; answers no body. Stopping twice is the same state. */
export async function stop(send: Send): Promise<{ ok?: true; error?: GmailFailure }> {
  const r = await send<null>({ method: 'POST', path: `${BASE}/stop`, replayable: true })
  return r.error ? { error: fail(r) } : { ok: true }
}

export interface SendMessageInput {
  /** The RFC 2822 message from `buildMime`; `raw` is made here. */
  mime:      string
  /** The parent's THREAD id for a reply — never its message id. */
  threadId?: string
}

/**
 * `POST /messages/send`, 100 units. Unkeyed and unreplayable: Gmail collapses
 * nothing, so a 429 comes back after one attempt with the wait, and a lost
 * answer is `indeterminate`. The Message-ID is read off the MIME BEFORE the
 * send and returned on every outcome: `findByMessageId` is the read that
 * says whether a lost send landed (C6).
 */
export async function sendMessage(send: Send, input: SendMessageInput): Promise<{ messageId: string; raw: string; sent?: SendAnswer; error?: GmailFailure }> {
  const messageId = messageIdOf(input.mime)
  if (!messageId) throw new TypeError('gmail: the message has no Message-ID; buildMime() puts one on')
  if (/^In-Reply-To:/im.test(input.mime.split(/\r?\n\r?\n/, 1)[0]) && !input.threadId)
    throw new TypeError('gmail: a reply needs the parent\'s threadId, or Gmail starts a new thread')
  const raw = toRaw(input.mime)
  if (Buffer.byteLength(input.mime) > MAX_RAW_BYTES) throw new TypeError(`gmail: the message is ${Buffer.byteLength(input.mime)} bytes; the send limit is ${MAX_RAW_BYTES}`)
  const r = await send<SendAnswer>({
    method:   'POST',
    path:     `${BASE}/messages/send`,
    body:     { raw, ...(input.threadId ? { threadId: input.threadId } : {}) },
    validate: sendValidator,
  })
  return r.error ? { messageId, raw, error: fail(r) } : { messageId, raw, sent: r.data }
}

/** `POST /messages/{id}/modify`, 5 units. Read is `remove: ['UNREAD']`; starred is `STARRED`. A label set twice is the same set. */
export async function modifyMessage(send: Send, id: string, labels: { add?: string[]; remove?: string[] }): Promise<Answer<'message', GmailMessage>> {
  assertId(id, 'message')
  if (!labels.add?.length && !labels.remove?.length) throw new TypeError('gmail: modify needs a label to add or remove')
  const r = await send<GmailMessage>({
    method:     'POST',
    path:       `${BASE}/messages/${id}/modify`,
    body:       { ...(labels.add?.length ? { addLabelIds: labels.add } : {}), ...(labels.remove?.length ? { removeLabelIds: labels.remove } : {}) },
    validate:   messageValidator,
    replayable: true,
  })
  return r.error ? { error: fail(r) } : { message: r.data }
}

/** `POST /messages/{id}/trash`, 20 units. Soft: Gmail purges trash after 30 days. */
export async function trashMessage(send: Send, id: string): Promise<Answer<'message', GmailMessage>> {
  assertId(id, 'message')
  const r = await send<GmailMessage>({ method: 'POST', path: `${BASE}/messages/${id}/trash`, validate: messageValidator, replayable: true })
  return r.error ? { error: fail(r) } : { message: r.data }
}

/** `POST /messages/{id}/untrash`, 5 units. */
export async function untrashMessage(send: Send, id: string): Promise<Answer<'message', GmailMessage>> {
  assertId(id, 'message')
  const r = await send<GmailMessage>({ method: 'POST', path: `${BASE}/messages/${id}/untrash`, validate: messageValidator, replayable: true })
  return r.error ? { error: fail(r) } : { message: r.data }
}

function assertId(id: string, what: string): void {
  if (!id || !/^[\w-]+$/.test(id)) throw new TypeError(`gmail: '${id}' is not a ${what} id`)
}
