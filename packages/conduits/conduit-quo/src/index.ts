// @frontierjs/conduit-quo — Quo (formerly OpenPhone) over conduit.
//
// Quo is TWO API generations on one origin, and neither covers what the other
// does. The dated API (`Quo-Api-Version: 2026-03-30`, required on every
// request, no default) has reads, webhook management and the Standard
// Webhooks signature, and no way to send a text. Sending is `POST
// /v1/messages`, where the version lives in the path. So the builder returns
// two descriptors sharing one key, and every call here picks its own: a
// caller who chose would choose wrong the first time the dated API grows a
// send and v1 does not go away. A third, `files`, reaches the signed URL of a
// recording, voicemail or media file, which carries its own credential and
// sits on a storage host, so the key never goes there.
//
// Extracted from `fjs-prototypes/quo/api/src/providers/quo/` (receiving), with
// sending and webhook management written from Quo's two OpenAPI specs.
//
// `sent` and `delivered` are two columns, as on every carrier: the send
// answers `queued`, `message.delivered` arrives later, and it can arrive
// before the send's own answer does.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { translate, type QuoFailure } from './errors.ts'
import { messageModel, callModel, conversationModel, contactModel, recordingModel, taskModel, phoneNumberModel, userModel, organizationModel, parseTranscript, taskFromRead, taskPath, phoneNumberPath, userPath, settingsRow, isoOf, type MessageRow, type CallRow, type ConversationRow, type ContactRow, type RecordingRow, type TaskRow, type CallTranscript, type PhoneNumberRow, type PhoneNumberSettingsRow, type UserRow, type OrganizationRow } from './mirror.ts'
import type { EventRow } from './verify.ts'
import { QUO_EVENT_TYPES, QUO_TARGET, type QuoCall, type QuoContact, type QuoContactProperty, type QuoConversation, type QuoDelivery, type QuoDeliveryDetail, type QuoDeliveryStatus, type QuoEnvelope, type QuoEventType, type QuoMessage, type QuoOrganization, type QuoPhoneNumber, type QuoPhoneNumberMember, type QuoPhoneNumberSettings, type QuoCallDisclosure, type QuoRecording, type QuoTask, type QuoTranscript, type QuoUser, type QuoWebhook } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './verify.ts'
export * from './mirror.ts'
export * from './a2p.ts'

export const QUO_ADDRESS     = 'https://api.quo.com'
export const QUO_API_VERSION = '2026-03-30'

/** Quo's own limits on a send, refused here before a round trip (C9). */
export const QUO_MAX_TEXT       = 1600
export const QUO_MAX_RECIPIENTS = 10

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
/** One Send per generation, and one for files. Every call below takes this and picks. */
export interface QuoSend { v1: Send; dated: Send; files: Send }

export interface QuoTargets { v1: TargetDescriptor; dated: TargetDescriptor; files: TargetDescriptor }

/**
 * `id` is the dated target's; v1's is `<id>:v1` and the files target's
 * `<id>:files`. One set per WORKSPACE when the key is a tenant's
 * (`provider:quo:<orgId>`), since a Quo key carries admin reach over exactly
 * one workspace.
 *
 * The files target is addressed by each request, carries no credential, and
 * reaches public https alone; `fileDestinations` opens it to a test sink on
 * localhost and nothing else. It answers a file up to conduit's 10 MiB
 * `max_response_bytes`, about twenty minutes of a call: a workspace that
 * records longer calls sets `resilience.max_response_bytes` on it.
 */
export function quoTargets(opts: { ref?: string; address?: string; id?: string; fileDestinations?: { allowHttp?: boolean; allowPrivate?: boolean } } = {}): QuoTargets {
  const id = opts.id ?? QUO_TARGET
  const base = {
    kind: 'provider', protocol: 'http', address: opts.address ?? QUO_ADDRESS,
    // The raw key, no `Bearer`: Quo reads the header whole.
    auth: { type: 'api_key', ref: opts.ref ?? 'QUO_API_KEY', header: 'Authorization' },
    registered_at: Date.now(), last_seen_at: null,
  } as const
  return {
    v1:    { ...base, id: `${id}:v1` },
    dated: { ...base, id, headers: { 'Quo-Api-Version': QUO_API_VERSION } },
    files: {
      id: `${id}:files`, kind: 'provider', protocol: 'http', address: '', address_from: 'request', auth: { type: 'none' },
      ...(opts.fileDestinations ? { destinations: opts.fileDestinations } : {}),
      registered_at: Date.now(), last_seen_at: null,
    },
  }
}

export function bindQuo(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: QuoTargets | { v1: { id: string }; dated: { id: string }; files: { id: string } } = quoTargets()): QuoSend {
  return {
    v1:    req => conduit.send({ target: targets.v1.id, ...req }),
    dated: req => conduit.send({ target: targets.dated.id, ...req }),
    files: req => conduit.send({ target: targets.files.id, ...req }),
  }
}

const failed = (r: ConduitResult<unknown>): QuoFailure => translate(r.error!, r.meta?.status)

/**
 * E.164 or nothing: `(415) 555-0100` with a default country becomes
 * `+14155550100`, and anything that does not end as `+` and 8–15 digits is
 * refused here. `defaultCountry` is a calling code (`'1'`), never guessed.
 * The third copy beside telnyx's and twilio's, by PLAN Q9's ruling (A).
 */
export function toE164(input: string, defaultCountry?: string): string {
  const digits = input.trim().replace(/[^\d+]/g, '')
  let out: string
  if (digits.startsWith('+')) out = '+' + digits.slice(1).replace(/\D/g, '')
  else if (digits.startsWith('00')) out = '+' + digits.slice(2)
  else if (defaultCountry) out = `+${defaultCountry}${digits.replace(/^0+/, '')}`
  else throw new TypeError(`quo: '${input}' has no country code and no default was given`)
  if (!/^\+[1-9]\d{7,14}$/.test(out)) throw new TypeError(`quo: '${input}' is not an E.164 number`)
  return out
}

/** What a send was, kept by the caller on every outcome, so `findSent` can answer whether it landed. */
export interface SendAttempt {
  /** As sent: E.164, or the `PN…` id of our number. */
  from:  string
  to:    string[]
  text:  string
  /** ISO, our clock, taken before the send left. */
  at:    string
}

/**
 * One text, from our number (E.164 or its `PN…` id) to 1–10 people.
 *
 * Unkeyed and unreplayable (C5): v1 collapses nothing and takes no
 * idempotency key, so a timeout comes back `indeterminate` after ONE attempt
 * and `findSent(quo, attempt)` is the read that says whether it landed. A 429
 * comes back with `retryAfterMs` for the caller to honor; conduit replays
 * none of it, because a replayed send is a second text to a person.
 */
export async function sendMessage(quo: QuoSend, req: {
  from:            string
  to:              string | string[]
  text:            string
  /** The Quo user it is sent as; must be a member of `from`. Default: the number's owner. */
  userId?:         string
  /** `done` files the conversation out of the inbox; default leaves it open. */
  setInboxStatus?: 'done'
  defaultCountry?: string
}): Promise<{ message?: QuoMessage; error?: QuoFailure; attempt: SendAttempt }> {
  const from = req.from.startsWith('PN') ? req.from : toE164(req.from, req.defaultCountry)
  const to = [req.to].flat().map(n => toE164(n, req.defaultCountry))
  if (!to.length || to.length > QUO_MAX_RECIPIENTS) throw new TypeError(`quo: a text goes to 1–${QUO_MAX_RECIPIENTS} recipients, not ${to.length}`)
  if (!/\S/.test(req.text ?? '')) throw new TypeError('quo: a text needs non-blank content')
  if (req.text.length > QUO_MAX_TEXT) throw new TypeError(`quo: a text is at most ${QUO_MAX_TEXT} characters, this is ${req.text.length}`)
  const attempt: SendAttempt = { from, to, text: req.text, at: new Date().toISOString() }
  const r = await quo.v1<{ data: QuoMessage }>({ method: 'POST', path: '/v1/messages', body: {
    content: req.text, from, to,
    ...(req.userId ? { userId: req.userId } : {}),
    ...(req.setInboxStatus ? { setInboxStatus: req.setInboxStatus } : {}),
  } })
  if (r.error) return { error: failed(r), attempt }
  return { message: r.data.data, attempt }
}

/**
 * The read that resolves a lost send (C6). Quo stores no key, so this lists
 * our outgoing messages to exactly those recipients since a little before the
 * attempt, and keeps the newest whose text matches. The window opens
 * `skewSeconds` early because the attempt's time is our clock and `createdAt`
 * is Quo's; an IDENTICAL text to the same people inside that window is
 * indistinguishable from this one, which is the cost of a vendor with no key.
 */
export async function findSent(quo: QuoSend, attempt: SendAttempt, opts: { skewSeconds?: number } = {}): Promise<{ message?: QuoMessage | null; error?: QuoFailure }> {
  const since = new Date(Date.parse(attempt.at) - (opts.skewSeconds ?? 120) * 1000).toISOString()
  const r = await quo.dated<{ data: QuoMessage[]; nextCursor: string | null }>({ method: 'GET', path: '/messages', query: {
    ...(attempt.from.startsWith('PN') ? { phoneNumberId: attempt.from } : { from: attempt.from }),
    // A bare `to` is one recipient; several is the exact set, order-free.
    ...(attempt.to.length === 1 ? { to: attempt.to[0] } : { 'to[all]': attempt.to.join(',') }),
    direction: 'outgoing', 'createdAt[gt]': since, limit: 50,
  } })
  if (r.error) return { error: failed(r) }
  return { message: r.data.data.find(m => m.text === attempt.text) ?? null }
}

/** One message by its `AC…` id. Idempotent; conduit replays it. */
export async function getMessage(quo: QuoSend, id: string): Promise<{ message?: QuoMessage; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoMessage }>({ method: 'GET', path: `/messages/${encodeURIComponent(id)}` })
  if (r.error) return { error: failed(r) }
  return { message: r.data.data }
}

/**
 * A `failed` text sent again, under the same `AC…` id; the outcome arrives
 * later as `message.delivered` or `message.failed`. Only a failed message
 * with no `errorCode` can be retried: a permanent failure or an
 * `undelivered` one is Quo's 422, which comes back `refused`.
 *
 * Not replayed. Once the first retry is accepted the message is no longer
 * `failed`, so a replay would be refused and report a retry that worked as
 * one that did not. A lost answer comes back `indeterminate`, and
 * `getMessage` is the read that says whether it was taken.
 */
export async function retryMessage(quo: QuoSend, id: string): Promise<{ error?: QuoFailure }> {
  if (!/^AC/.test(id)) throw new TypeError(`quo: '${id}' is not a message id (AC…)`)
  const r = await quo.dated({ method: 'POST', path: `/messages/${encodeURIComponent(id)}/retry` })
  return r.error ? { error: failed(r) } : {}
}

// ─── Webhooks ──────────────────────────────────────────────────────────────

const hookPath = (id: string) => {
  if (!/^[0-9]+$/.test(id)) throw new TypeError(`quo: '${id}' is not a dated webhook id (digits)`)
  return `/webhooks/${id}`
}

/**
 * A dated subscription, pinned to `QUO_API_VERSION` for its whole life. The
 * signing key comes back HERE and nowhere else — the list never shows it —
 * so the caller stores it before doing anything else (C12: the row is the
 * app's). Unkeyed; a lost answer is resolved by `listWebhooks` matched on
 * `url` and `label`, and the key of a webhook found that way is gone, so the
 * caller rotates it.
 */
export async function createWebhook(quo: QuoSend, req: {
  url:          string
  events:       QuoEventType[]
  /** `PN…` ids, or omitted for every number. `contact.*` events ignore it. */
  resourceIds?: string[]
  label?:       string
  status?:      'enabled' | 'disabled'
}): Promise<{ webhook?: QuoWebhook; key?: string; error?: QuoFailure }> {
  if (!req.events.length) throw new TypeError('quo: a webhook needs at least one event')
  const r = await quo.dated<{ data: QuoWebhook & { key: string } }>({ method: 'POST', path: '/webhooks', body: {
    url: req.url, events: req.events,
    ...(req.resourceIds ? { resourceIds: req.resourceIds } : {}),
    ...(req.label ? { label: req.label } : {}),
    ...(req.status ? { status: req.status } : {}),
  } })
  if (r.error) return { error: failed(r) }
  const { key, ...webhook } = r.data.data
  return { webhook, key }
}

/** Every webhook in the workspace, legacy ones included (they carry no `apiVersion` of ours). */
export async function listWebhooks(quo: QuoSend): Promise<{ webhooks?: QuoWebhook[]; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoWebhook[] }>({ method: 'GET', path: '/webhooks' })
  if (r.error) return { error: failed(r) }
  return { webhooks: r.data.data }
}

/** One webhook by its id; like the list, it never shows the key. Idempotent; conduit replays it. */
export async function getWebhook(quo: QuoSend, id: string): Promise<{ webhook?: QuoWebhook; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoWebhook }>({ method: 'GET', path: hookPath(id) })
  if (r.error) return { error: failed(r) }
  return { webhook: r.data.data }
}

/**
 * Only the fields given change, and the key stays. A field set to `undefined`
 * is not sent; `label: null` is, and clears it. `events` REPLACES the list, so
 * adding one event means sending every event the hook keeps. `resourceIds`
 * `null`, `[]` and `['*']` all mean every number: an empty list is not "no
 * numbers", and a hook that should hear nothing is `status: 'disabled'`.
 * Replayed: every field is set to a value, so a second PATCH changes nothing.
 */
export async function updateWebhook(quo: QuoSend, id: string, changes: {
  url?:         string
  events?:      QuoEventType[]
  resourceIds?: string[] | null
  label?:       string | null
  status?:      'enabled' | 'disabled'
}): Promise<{ webhook?: QuoWebhook; error?: QuoFailure }> {
  const path = hookPath(id)
  const body = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined))
  if (!Object.keys(body).length) throw new TypeError('quo: a webhook update needs at least one field')
  if (changes.events) {
    if (!changes.events.length) throw new TypeError('quo: a webhook needs at least one event; disable it to hear nothing')
    const unknown = changes.events.filter(e => !(QUO_EVENT_TYPES as readonly string[]).includes(e))
    if (unknown.length) throw new TypeError(`quo: ${unknown.map(e => `'${e}'`).join(', ')} is not an event type`)
  }
  const r = await quo.dated<{ data: QuoWebhook }>({ method: 'PATCH', path, body, replayable: true })
  if (r.error) return { error: failed(r) }
  return { webhook: r.data.data }
}

/** A new `whsec_` key, effective at once: a delivery signed with the old one fails verify from here on. */
export async function rotateWebhookKey(quo: QuoSend, id: string): Promise<{ key?: string; error?: QuoFailure }> {
  const r = await quo.dated<{ data: { key: string } }>({ method: 'POST', path: `/webhooks/${encodeURIComponent(id)}/rotate` })
  if (r.error) return { error: failed(r) }
  return { key: r.data.data.key }
}

/** Gone after; a second delete is `gone`, which the caller reads as done. */
export async function deleteWebhook(quo: QuoSend, id: string): Promise<{ error?: QuoFailure }> {
  const r = await quo.dated({ method: 'DELETE', path: `/webhooks/${encodeURIComponent(id)}` })
  return r.error ? { error: failed(r) } : {}
}

// ─── Delivery log ──────────────────────────────────────────────────────────

/** Quo's ceiling on one page of any list. */
export const QUO_MAX_PAGE = 50

const webhookPath = (id: string) => `${hookPath(id)}/events`

/**
 * One page of a webhook's deliveries, newest first; pass `nextCursor` back as
 * `after` for the next. `status: 'failed'` is what Quo gave up on — a
 * delivery still `sending` is Quo's to retry, and `healDeliveries` reads both. `resourceId` finds every
 * delivery about one message or call, but matches nothing made before
 * 2026-09-01. `createdAt` bounds are exclusive. Idempotent; conduit replays it.
 */
export async function listDeliveries(quo: QuoSend, webhookId: string, req: {
  status?:     QuoDeliveryStatus
  eventType?:  QuoEventType | QuoEventType[]
  resourceId?: string
  createdAt?:  { gt?: string; lt?: string }
  after?:      string
  limit?:      number
} = {}): Promise<{ deliveries?: QuoDelivery[]; nextCursor?: string | null; error?: QuoFailure }> {
  const path = webhookPath(webhookId)
  if (req.limit !== undefined && !(Number.isInteger(req.limit) && req.limit >= 1 && req.limit <= QUO_MAX_PAGE)) throw new TypeError(`quo: a delivery page is 1–${QUO_MAX_PAGE}, not ${req.limit}`)
  const types = req.eventType === undefined ? [] : [req.eventType].flat()
  const r = await quo.dated<{ data: QuoDelivery[]; nextCursor: string | null }>({ method: 'GET', path, query: {
    ...(req.status ? { status: req.status } : {}),
    // One is bare; several is `[in]`, comma-joined.
    ...(types.length === 1 ? { eventType: types[0] } : types.length ? { 'eventType[in]': types.join(',') } : {}),
    ...(req.resourceId ? { resourceId: req.resourceId } : {}),
    ...(req.createdAt?.gt ? { 'createdAt[gt]': req.createdAt.gt } : {}),
    ...(req.createdAt?.lt ? { 'createdAt[lt]': req.createdAt.lt } : {}),
    ...(req.after ? { after: req.after } : {}),
    ...(req.limit ? { limit: req.limit } : {}),
  } })
  if (r.error) return { error: failed(r) }
  return { deliveries: r.data.data, nextCursor: r.data.nextCursor }
}

/**
 * One delivery by its `webhook-id`, with the body Quo sent and each attempt
 * newest first: what the receiver answered and whether a person or Quo's
 * schedule made it. Idempotent; conduit replays it.
 */
export async function getDelivery(quo: QuoSend, webhookId: string, deliveryId: string): Promise<{ delivery?: QuoDeliveryDetail; error?: QuoFailure }> {
  const path = webhookPath(webhookId)
  if (!deliveryId) throw new TypeError('quo: a delivery id is the webhook-id header, and this one is empty')
  const r = await quo.dated<{ data: QuoDeliveryDetail }>({ method: 'GET', path: `${path}/${encodeURIComponent(deliveryId)}` })
  if (r.error) return { error: failed(r) }
  return { delivery: r.data.data }
}

/**
 * One more attempt at a delivery, in whatever state it is; Quo makes it
 * later, and `getDelivery` shows it as a `manual` attempt. It carries the
 * same `webhook-id`, so a receiver that already applied it answers
 * `duplicate`, which is why this one IS replayed: a second attempt is
 * harmless where a lost retry is a delivery nobody heals.
 */
export async function retryDelivery(quo: QuoSend, webhookId: string, deliveryId: string): Promise<{ error?: QuoFailure }> {
  const path = webhookPath(webhookId)
  if (!deliveryId) throw new TypeError('quo: a delivery id is the webhook-id header, and this one is empty')
  const r = await quo.dated({ method: 'POST', path: `${path}/${encodeURIComponent(deliveryId)}/retry`, replayable: true })
  return r.error ? { error: failed(r) } : {}
}

/**
 * Every delivery since `since` (exclusive) that the receiver has not taken,
 * retried oldest first so events land in the order they happened. That is
 * `failed` AND `sending`: a refused delivery stays `sending` for the ~27
 * hours Quo retries it, so a healer reading only `failed` heals a day late.
 * Pages to the end. A listing failure stops before any retry; a retry
 * failure is reported beside the rest.
 */
export async function healDeliveries(quo: QuoSend, webhookId: string, req: { since: string }): Promise<{ retried: string[]; unretried: { id: string; error: QuoFailure }[]; error?: QuoFailure }> {
  const owed: QuoDelivery[] = []
  for (const status of ['sending', 'failed'] as const) {
    const newestFirst: QuoDelivery[] = []
    let after: string | undefined
    do {
      const page = await listDeliveries(quo, webhookId, { status, createdAt: { gt: req.since }, limit: QUO_MAX_PAGE, ...(after ? { after } : {}) })
      if (page.error) return { retried: [], unretried: [], error: page.error }
      newestFirst.push(...page.deliveries!)
      after = page.nextCursor ?? undefined
    } while (after)
    owed.push(...newestFirst.reverse())
  }
  // Stable, so deliveries sharing a millisecond keep the list's order; a
  // `sending` and a `failed` one sharing it have none, and `sending` goes first.
  owed.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  const retried: string[] = [], unretried: { id: string; error: QuoFailure }[] = []
  for (const d of owed) {
    const r = await retryDelivery(quo, webhookId, d.id)
    if (r.error) unretried.push({ id: d.id, error: r.error })
    else retried.push(d.id)
  }
  return { retried, unretried }
}

/**
 * Quo's canonical sample of `eventType`, sent to the hook's URL so the
 * receiver can be proved before live traffic; the answer is that sample, and
 * the delivery lands later. Its envelope `id` is ONE fixed sample id shared by
 * every test dispatch, so a receiver deduping on it applies the first test and
 * swallows the rest; each dispatch has its own `webhook-id`, which is what
 * `quoDialect` keys on. Its ids are samples too (`ACsample…`, `ORsample…`), so
 * a receiver that writes rows writes a sample row. Replayed: a second test is
 * another sample, harmless.
 */
export async function sendTestEvent(quo: QuoSend, webhookId: string, eventType: QuoEventType): Promise<{ event?: QuoEnvelope; error?: QuoFailure }> {
  const path = webhookPath(webhookId)
  if (!(QUO_EVENT_TYPES as readonly string[]).includes(eventType)) throw new TypeError(`quo: '${eventType}' is not an event type Quo can send a test of`)
  // The one dated answer with no `data` wrapper: the body IS the envelope.
  const r = await quo.dated<QuoEnvelope>({ method: 'POST', path: `${path}/test`, body: { eventType }, replayable: true })
  if (r.error) return { error: failed(r) }
  return { event: r.data }
}

// ─── Inbox state ───────────────────────────────────────────────────────────

/**
 * What the app can set and never read back. A conversation's unread mark and
 * whether it is open or done are on no conversation Quo answers with, and no
 * event reports them, so a change made in Quo's own app reaches the mirror
 * nowhere. An app that shows the state keeps it as its own column, written
 * when one of these succeeds; the row each answers with is the conversation
 * as the list reads it.
 *
 * Read is the unread mark, and done and open are the inbox, out and back.
 * Replayed, since each sets a state and
 * a second one changes nothing; two marks to one conversation in flight at
 * once can land in either order, so a caller sends them one at a time.
 */
async function markConversation(quo: QuoSend, conversationId: string, state: 'read' | 'done' | 'open'): Promise<{ row?: ConversationRow; error?: QuoFailure }> {
  if (typeof conversationId !== 'string' || !/^CN./.test(conversationId)) throw new TypeError(`quo: '${conversationId}' is not a conversation id (CN…)`)
  const r = await quo.dated<{ data: QuoConversation }>({ method: 'POST', path: `/conversations/${encodeURIComponent(conversationId)}/mark-as-${state}`, replayable: true })
  if (r.error) return { error: failed(r) }
  return { row: conversationModel.parse(r.data?.data) ?? undefined }
}

/** Clears the unread mark, without a reply; it stays in the inbox or out of it. */
export const markRead = (quo: QuoSend, conversationId: string) => markConversation(quo, conversationId, 'read')
/** Out of the inbox, without a reply. What `sendMessage`'s `setInboxStatus: 'done'` does with one. */
export const markDone = (quo: QuoSend, conversationId: string) => markConversation(quo, conversationId, 'done')
/** Back into the inbox, without a reply. */
export const markOpen = (quo: QuoSend, conversationId: string) => markConversation(quo, conversationId, 'open')

// ─── Backfill — the reads that fill the mirror ─────────────────────────────

/** Pages one backfill pass reads before it stops `truncated`: 1000 rows. */
export const QUO_BACKFILL_PAGES = 20

/**
 * One pass's rows, in the order Quo listed them. `truncated` is a pass that stopped
 * at its page count with more left, and `after` resumes it; a failure keeps
 * what was read and the `after` that resumes at the page that failed.
 */
export interface Backfill<Row> {
  rows:       Row[]
  truncated:  boolean
  after:      string | null
  error?:     QuoFailure
}

const instant = (since: string) => {
  const ms = Date.parse(since)
  if (Number.isNaN(ms)) throw new TypeError(`quo: '${since}' is not a time`)
  return ms
}

/** Pages to the end or to `pages`. Every page is a GET, which conduit replays. */
async function backfill<Raw, Row>(quo: QuoSend, path: string, query: Record<string, string>, parse: (raw: Raw) => Row | null, opts: { after?: string; pages?: number }): Promise<Backfill<Row>> {
  const pages = opts.pages ?? QUO_BACKFILL_PAGES
  if (!(Number.isInteger(pages) && pages >= 1)) throw new TypeError(`quo: a backfill reads at least one page, not ${pages}`)
  const rows: Row[] = []
  let after = opts.after ?? null
  for (let n = 0; n < pages; n++) {
    const r = await quo.dated<{ data: Raw[]; nextCursor: string | null }>({ method: 'GET', path, query: { ...query, limit: QUO_MAX_PAGE, ...(after ? { after } : {}) } })
    if (r.error) return { rows, truncated: false, after, error: failed(r) }
    for (const raw of Array.isArray(r.data?.data) ? r.data.data : []) {
      const row = parse(raw)
      if (row) rows.push(row)
    }
    after = r.data.nextCursor || null
    if (!after) return { rows, truncated: false, after: null }
  }
  return { rows, truncated: true, after }
}

/**
 * Every message created at or after `since`, newest first; no `since` is all of
 * history. `since` is inclusive, because a row read twice is an upsert and a
 * row missed is gone, and Quo's message bound is exclusive only, so it is sent
 * a millisecond early. The next pass's `since` is when this one BEGAN.
 *
 * Quo filters messages by `createdAt` alone: a status that changes later
 * (`delivered`, `failed`) on a message older than `since` is not here, and
 * reaches the mirror by webhook or `getMessage`.
 */
export async function backfillMessages(quo: QuoSend, req: { since?: string; after?: string; pages?: number } = {}): Promise<Backfill<MessageRow>> {
  const query: Record<string, string> = req.since ? { 'createdAt[gt]': new Date(instant(req.since) - 1).toISOString() } : {}
  return backfill<QuoMessage, MessageRow>(quo, '/messages', query, m => messageModel.parse(m), req)
}

/**
 * Every call created at or after `since`, newest first, group calls
 * included. Quo's call bound is `gte`, inclusive as sent. Like a message, a
 * call is filtered by `createdAt` alone, so a call that began before `since`
 * and ended after it keeps the row an earlier pass wrote.
 */
export async function backfillCalls(quo: QuoSend, req: { since?: string; after?: string; pages?: number } = {}): Promise<Backfill<CallRow>> {
  const query: Record<string, string> = { ...(req.since ? { 'createdAt[gte]': new Date(instant(req.since)).toISOString() } : {}), include: CALL_SECTIONS }
  return backfill<QuoCall, CallRow>(quo, '/calls', query, withSections, req)
}

// ─── Call artifacts ────────────────────────────────────────────────────────

/** A call read leaves its summary and voicemail out unless it asks for them. */
const CALL_SECTIONS = 'summary,voicemail'

/**
 * Parsed as read with `include`, where a missing `voicemail` means none was
 * left: `null` columns, not absent ones, so a voicemail a row held is not kept
 * on a call the read says has none.
 */
const withSections = (c: QuoCall) => callModel.parse(c && typeof c === 'object' ? { ...c, voicemail: c.voicemail ?? null } as QuoCall : c)

const callPath = (id: string) => {
  if (typeof id !== 'string' || !/^AC./.test(id)) throw new TypeError(`quo: '${id}' is not a call id (AC…)`)
  return `/calls/${encodeURIComponent(id)}`
}

/** One call, with its summary and voicemail. Idempotent; conduit replays it. */
export async function getCall(quo: QuoSend, callId: string): Promise<{ row?: CallRow; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoCall }>({ method: 'GET', path: callPath(callId), query: { include: CALL_SECTIONS } })
  if (r.error) return { error: failed(r) }
  return { row: withSections(r.data?.data) ?? undefined }
}

/**
 * Every recorded segment of a call, oldest first, each with a fresh signed
 * URL: the read to make when a URL from an event or an earlier read no longer
 * answers. A failure keeps the segments already read, since each is its own row.
 */
export async function getCallRecordings(quo: QuoSend, callId: string): Promise<{ rows: RecordingRow[]; error?: QuoFailure }> {
  const read = await backfill<QuoRecording, RecordingRow>(quo, `${callPath(callId)}/recordings`, {}, x => recordingModel.parse(x && { ...x, callId }), { pages: Number.MAX_SAFE_INTEGER })
  return { rows: read.rows, ...(read.error ? { error: read.error } : {}) }
}

/** Each segment's transcript, oldest first. All or nothing, since they are read as one dialogue. */
export async function getCallTranscripts(quo: QuoSend, callId: string): Promise<{ transcripts?: CallTranscript[]; error?: QuoFailure }> {
  const read = await backfill<QuoTranscript, CallTranscript>(quo, `${callPath(callId)}/transcripts`, {}, x => parseTranscript(x && { ...x, callId }), { pages: Number.MAX_SAFE_INTEGER })
  return read.error ? { error: read.error } : { transcripts: read.rows }
}

/**
 * The bytes behind a signed URL Quo handed out: a recording's `url`, a
 * voicemail's, a message's media. Quo says to keep the file rather than the
 * URL, because the URL stops answering. Sent through the files target, so no
 * key goes with it; storage refuses a request that carries a second credential.
 * A URL that no longer answers (403, 404 or 410) is `gone`, and the read that
 * handed it out hands out a fresh one. Idempotent; conduit replays it.
 */
export async function fileBytes(quo: QuoSend, url: string): Promise<{ bytes?: Uint8Array; type?: string; error?: QuoFailure }> {
  if (typeof url !== 'string' || !URL.canParse(url)) throw new TypeError(`quo: '${url}' is not a file URL`)
  const r = await quo.files<Uint8Array>({ method: 'GET', address: url })
  if (r.error) {
    const status = r.meta?.status
    if (status === 403 || status === 404 || status === 410) return { error: { kind: 'gone', message: `the file URL answered ${status}; read its call again for a fresh one`, retryable: false } }
    return { error: failed(r) }
  }
  if (!(r.data instanceof Uint8Array)) return { error: { kind: 'invalid_response', message: 'Quo answered a file with something that is not bytes', retryable: false } }
  return { bytes: r.data, type: r.meta.headers?.['content-type'] ?? 'application/octet-stream' }
}

/**
 * Every conversation CHANGED at or after `since`, oldest change first: a
 * conversation older than the gap whose activity landed in it is the one a
 * backfill exists for, and `createdAt` would miss it. Ascending, because a
 * conversation that changes while being paged moves to the end, where the
 * pass reads it again, and rows applied in order leave its later version.
 */
export async function backfillConversations(quo: QuoSend, req: { since?: string; after?: string; pages?: number } = {}): Promise<Backfill<ConversationRow>> {
  const query = { ...(req.since ? { 'updatedAt[gte]': new Date(instant(req.since)).toISOString() } : {}), sort: 'updatedAt:asc' }
  return backfill<QuoConversation, ConversationRow>(quo, '/conversations', query, c => conversationModel.parse(c), req)
}

/**
 * Every contact. Quo's contact list takes no time bound, so every pass is the
 * whole book, and a contact absent from a pass read from the first page to
 * the last was deleted. A contact's numbers and emails are a read per contact,
 * `getContactProperties`, which this does not make.
 */
export async function backfillContacts(quo: QuoSend, req: { after?: string; pages?: number } = {}): Promise<Backfill<ContactRow>> {
  return backfill<QuoContact, ContactRow>(quo, '/contacts', {}, c => contactModel.parse(c), req)
}

/** What `getContactProperties` fills: the key and the two lists, nothing the contact list wrote. */
export type ContactPropertiesRow = Pick<ContactRow, 'externalId'> & Required<Pick<ContactRow, 'phoneNumbers' | 'emails'>>

/**
 * A contact's phone numbers and emails, read from its properties to the last
 * page, as the part of its row they fill. The contact list carries neither,
 * so a backfill makes this read once per contact, on a key limited to 10
 * requests a second; a contact event carries both and needs none. One read of
 * every type rather than one per type, so a contact is usually one request.
 * Custom fields are read and not kept.
 *
 * All or nothing: a list from some of the pages would clear what the others
 * hold, so a failure on any page answers no row. Idempotent; conduit replays it.
 */
export async function getContactProperties(quo: QuoSend, contactId: string): Promise<{ row?: ContactPropertiesRow; error?: QuoFailure }> {
  if (typeof contactId !== 'string' || !contactId) throw new TypeError('quo: a contact is named by its Quo id, and this one is empty')
  const read = await backfill<QuoContactProperty, QuoContactProperty>(quo, `/contacts/${encodeURIComponent(contactId)}/properties`, {}, p => p && typeof p === 'object' ? p : null, { pages: Number.MAX_SAFE_INTEGER })
  if (read.error) return { error: read.error }
  const of = (type: string) => read.rows.filter(p => p.type === type && typeof p.value === 'string' && p.value !== '').map(p => p.value as string)
  return { row: { externalId: contactId, phoneNumbers: of('phone-number'), emails: of('email') } }
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

/** One task, every column. A 404 is `gone`. Idempotent; conduit replays it. */
export async function getTask(quo: QuoSend, taskId: string): Promise<{ row?: TaskRow; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoTask }>({ method: 'GET', path: taskPath(taskId) })
  if (r.error) return { error: failed(r) }
  return { row: taskFromRead(r.data?.data) ?? undefined }
}

/**
 * Every task, `deleted` ones included, since deleting is a status. Quo's task
 * list takes no time bound and no order, so every pass is the whole book, as
 * the contacts'. Each row is whole: a field the read leaves out is `null`.
 */
export async function backfillTasks(quo: QuoSend, req: { after?: string; pages?: number } = {}): Promise<Backfill<TaskRow>> {
  return backfill<QuoTask, TaskRow>(quo, '/tasks', {}, taskFromRead, req)
}

/**
 * One task write: Quo answers `{ taskId, revision }`, and the row is that and
 * what the write set. A PUT or PATCH sets a value, so it is replayed. A DELETE
 * is replayed whatever the call says (conduit replays every one), and the
 * replay of one that landed finds nothing left to take away: Quo's 400 or 404
 * after a replay is the write done, without its revision.
 */
async function taskWrite(quo: QuoSend, taskId: string, method: 'POST' | 'PATCH' | 'DELETE', sub: string, body: Record<string, unknown> | undefined, set: Record<string, unknown>): Promise<{ row?: EventRow<TaskRow>; error?: QuoFailure }> {
  const r = await quo.dated<{ data: { taskId: string; revision: number } }>({ method, path: `${taskPath(taskId)}${sub}`, ...(body ? { body } : {}), ...(method === 'DELETE' ? {} : { replayable: true }) })
  if (r.error) {
    const status = r.meta?.status
    if (method === 'DELETE' && (r.meta?.replays ?? 0) > 0 && (status === 400 || status === 404)) return { row: taskModel.parse({ ...set, taskId }) ?? undefined }
    return { error: failed(r) }
  }
  return { row: taskModel.parse({ ...set, taskId, revision: r.data?.data?.revision }) ?? undefined }
}

const TASK_STATUSES = new Set(['open', 'completed', 'deleted'])
const userOf = (userId: string) => {
  if (typeof userId !== 'string' || !/^US./.test(userId)) throw new TypeError(`quo: '${userId}' is not a user id (US…)`)
  return userId
}
const conversationOf = (conversationId: string) => {
  if (typeof conversationId !== 'string' || !/^CN./.test(conversationId)) throw new TypeError(`quo: '${conversationId}' is not a conversation id (CN…)`)
  return conversationId
}

/**
 * Open, completed or deleted. Reopening a task past the workspace's open-task
 * limit is `quota`, as a create is.
 */
export async function setTaskStatus(quo: QuoSend, taskId: string, status: 'open' | 'completed' | 'deleted') {
  if (!TASK_STATUSES.has(status)) throw new TypeError(`quo: '${status}' is not a task status (open, completed, deleted)`)
  return taskWrite(quo, taskId, 'PATCH', '/status', { status }, { status })
}

/** The task filed in a conversation. The number it is on is the `task.linked` event's to say. */
export async function linkTask(quo: QuoSend, taskId: string, conversationId: string) {
  return taskWrite(quo, taskId, 'POST', '/conversations', { conversationId: conversationOf(conversationId) }, { conversationId })
}

/** The task taken out of the conversation named, which must be the one it is in. */
export async function unlinkTask(quo: QuoSend, taskId: string, conversationId: string) {
  return taskWrite(quo, taskId, 'DELETE', '/conversations', { conversationId: conversationOf(conversationId) }, { conversationId: null })
}

/** One assignee, replacing any; who assigned it is the `task.assigned` event's to say. */
export async function assignTask(quo: QuoSend, taskId: string, userId: string) {
  return taskWrite(quo, taskId, 'POST', '/users', { userId: userOf(userId) }, { assignedTo: userId })
}

/** The assignee named, which must be the one assigned. */
export async function unassignTask(quo: QuoSend, taskId: string, userId: string) {
  return taskWrite(quo, taskId, 'DELETE', '/users', { userId: userOf(userId) }, { assignedTo: null })
}

/** A due date, or `null` to clear it, which is a DELETE of its own. */
export async function setTaskDueDate(quo: QuoSend, taskId: string, dueDate: Date | string | null) {
  if (dueDate === null) return taskWrite(quo, taskId, 'DELETE', '/due-date', undefined, { dueDate: null })
  const iso = isoOf(dueDate, 'a due date')
  return taskWrite(quo, taskId, 'PATCH', '/due-date', { dueDate: iso }, { dueDate: iso })
}

// ─── Phone numbers ─────────────────────────────────────────────────────────

/** A number's read always asks for both: the list cannot carry business hours. */
const NUMBER_SECTIONS = 'restrictions,businessHours'

/**
 * One number, with its restrictions and business hours: every column but its
 * settings and members, which are reads of their own. Idempotent; conduit replays it.
 */
export async function getPhoneNumber(quo: QuoSend, phoneNumberId: string): Promise<{ row?: PhoneNumberRow; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoPhoneNumber }>({ method: 'GET', path: phoneNumberPath(phoneNumberId), query: { include: NUMBER_SECTIONS } })
  if (r.error) return { error: failed(r) }
  return { row: phoneNumberModel.parse(r.data?.data) ?? undefined }
}

/**
 * Every number in the workspace, with its restrictions. The list takes no
 * time bound and refuses `businessHours`, so every pass is the whole book and
 * its rows leave business hours absent; a number absent from a pass read to
 * the last page was released.
 */
export async function backfillPhoneNumbers(quo: QuoSend, req: { after?: string; pages?: number } = {}): Promise<Backfill<PhoneNumberRow>> {
  return backfill<QuoPhoneNumber, PhoneNumberRow>(quo, '/phone-numbers', { include: 'restrictions' }, p => phoneNumberModel.parse(p), req)
}

/** Whether calls are recorded and how each side is told. Idempotent; conduit replays it. */
export async function getPhoneNumberSettings(quo: QuoSend, phoneNumberId: string): Promise<{ row?: PhoneNumberSettingsRow; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoPhoneNumberSettings }>({ method: 'GET', path: `${phoneNumberPath(phoneNumberId)}/settings` })
  if (r.error) return { error: failed(r) }
  return { row: settingsRow(r.data?.data) ?? undefined }
}

const DISCLOSURES = new Set(['voice', 'audioTone', 'disabled'])

/**
 * Only the settings named change, and one side of `callDisclosure` may go
 * alone; the answer is every setting. Replayed, since it sets values.
 */
export async function updatePhoneNumberSettings(quo: QuoSend, phoneNumberId: string, changes: {
  autoRecord?:     boolean
  callDisclosure?: { inbound?: QuoCallDisclosure; outbound?: QuoCallDisclosure }
}): Promise<{ row?: PhoneNumberSettingsRow; error?: QuoFailure }> {
  const path = `${phoneNumberPath(phoneNumberId)}/settings`
  const body: Record<string, unknown> = {}
  if (changes.autoRecord !== undefined) {
    if (typeof changes.autoRecord !== 'boolean') throw new TypeError('quo: autoRecord is true or false')
    body.autoRecord = changes.autoRecord
  }
  if (changes.callDisclosure !== undefined) {
    const d = Object.fromEntries(Object.entries(changes.callDisclosure ?? {}).filter(([, v]) => v !== undefined))
    for (const [side, v] of Object.entries(d)) {
      if (side !== 'inbound' && side !== 'outbound') throw new TypeError(`quo: '${side}' is not a side of callDisclosure (inbound, outbound)`)
      if (!DISCLOSURES.has(v as string)) throw new TypeError(`quo: '${String(v)}' is not a call disclosure (voice, audioTone, disabled)`)
    }
    if (!Object.keys(d).length) throw new TypeError('quo: callDisclosure names inbound or outbound')
    body.callDisclosure = d
  }
  if (!Object.keys(body).length) throw new TypeError('quo: a settings update names autoRecord or callDisclosure')
  const r = await quo.dated<{ data: QuoPhoneNumberSettings }>({ method: 'PATCH', path, body, replayable: true })
  if (r.error) return { error: failed(r) }
  return { row: settingsRow(r.data?.data) ?? undefined }
}

/**
 * Every user assigned to the number, read to the last page, as the part of
 * its row they fill, and each member as a `User` row without the picture or
 * the times, which the member read does not carry. All or nothing, as a
 * contact's properties: a list from some of the pages would clear the rest on
 * upsert. Idempotent; conduit replays it.
 */
export async function getPhoneNumberMembers(quo: QuoSend, phoneNumberId: string): Promise<{ row?: Pick<PhoneNumberRow, 'externalId'> & Required<Pick<PhoneNumberRow, 'memberExternalIds'>>; users?: UserRow[]; error?: QuoFailure }> {
  const read = await backfill<QuoPhoneNumberMember, UserRow>(quo, `${phoneNumberPath(phoneNumberId)}/users`, {}, u => userModel.parse(u), { pages: Number.MAX_SAFE_INTEGER })
  if (read.error) return { error: read.error }
  return { row: { externalId: phoneNumberId, memberExternalIds: read.rows.map(u => u.externalId) }, users: read.rows }
}

/** Quo's ceiling on one read of the available numbers, which is not paged. */
export const QUO_MAX_AVAILABLE = 100

/**
 * Numbers Quo could give the workspace, E.164, filtered as Quo's names say.
 * Only a look: the API buys none, and a number listed here is bought in
 * Quo's app or not at all. Idempotent; conduit replays it.
 */
export async function availablePhoneNumbers(quo: QuoSend, req: {
  areaCode?:    string
  contains?:    string
  countryCode?: string
  inLocality?:  string
  inRegion?:    string
  tollFree?:    boolean
  limit?:       number
} = {}): Promise<{ numbers?: string[]; error?: QuoFailure }> {
  if (req.limit !== undefined && !(Number.isInteger(req.limit) && req.limit >= 1 && req.limit <= QUO_MAX_AVAILABLE)) throw new TypeError(`quo: a read of available numbers is 1–${QUO_MAX_AVAILABLE}, not ${req.limit}`)
  if (req.tollFree !== undefined && typeof req.tollFree !== 'boolean') throw new TypeError('quo: tollFree is true or false')
  const query: Record<string, string | number> = {}
  for (const k of ['areaCode', 'contains', 'countryCode', 'inLocality', 'inRegion'] as const) {
    const v = req[k]
    if (v === undefined) continue
    if (typeof v !== 'string' || !v) throw new TypeError(`quo: ${k} is a non-empty string`)
    query[k] = v
  }
  if (req.tollFree !== undefined) query.tollFree = String(req.tollFree)
  if (req.limit !== undefined) query.limit = req.limit
  const r = await quo.dated<{ data: { phoneNumbers: string[] } }>({ method: 'GET', path: '/phone-numbers/available', query })
  if (r.error) return { error: failed(r) }
  const list = r.data?.data?.phoneNumbers
  return { numbers: Array.isArray(list) ? list.filter((n): n is string => typeof n === 'string') : [] }
}

// ─── Users and the organization ────────────────────────────────────────────

/** One user, every column. A 404 is `gone`. Idempotent; conduit replays it. */
export async function getUser(quo: QuoSend, userId: string): Promise<{ row?: UserRow; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoUser }>({ method: 'GET', path: userPath(userId) })
  if (r.error) return { error: failed(r) }
  return { row: userModel.parse(r.data?.data) ?? undefined }
}

/**
 * Every user in the workspace. No event reports a user and the list takes no
 * time bound, so every pass is the whole book, and a user absent from a pass
 * read to the last page was removed.
 */
export async function backfillUsers(quo: QuoSend, req: { after?: string; pages?: number } = {}): Promise<Backfill<UserRow>> {
  return backfill<QuoUser, UserRow>(quo, '/users', {}, u => userModel.parse(u), req)
}

/**
 * The numbers the user is a member of, each a `PhoneNumber` row as the
 * number list reads it, with its restrictions. The membership lands nowhere:
 * a number's `memberExternalIds` is every member, which a read of one user
 * cannot say. Each row is its own, so a failure keeps the rows read before
 * it, as `getCallRecordings`; the list is then not the user's every number.
 * Quo names no 404 here, so `[]` does not say the user exists.
 */
export async function getUserPhoneNumbers(quo: QuoSend, userId: string): Promise<{ rows: PhoneNumberRow[]; error?: QuoFailure }> {
  const read = await backfill<QuoPhoneNumber, PhoneNumberRow>(quo, `${userPath(userId)}/phone-numbers`, { include: 'restrictions' }, p => phoneNumberModel.parse(p), { pages: Number.MAX_SAFE_INTEGER })
  return { rows: read.rows, ...(read.error ? { error: read.error } : {}) }
}

/**
 * The workspace the key belongs to. No event reports it; `subscriptionStatus`
 * read as `expired` is the state in which a send is `billing`, so an app can
 * say so before it sends. Idempotent; conduit replays it.
 */
export async function getOrganization(quo: QuoSend): Promise<{ row?: OrganizationRow; error?: QuoFailure }> {
  const r = await quo.dated<{ data: QuoOrganization }>({ method: 'GET', path: '/organization' })
  if (r.error) return { error: failed(r) }
  return { row: organizationModel.parse(r.data?.data) ?? undefined }
}
