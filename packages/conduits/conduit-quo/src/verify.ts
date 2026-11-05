// src/verify.ts — is this really Quo?
//
// Two generations, chosen per SUBSCRIPTION when it is created and never
// changed after: a webhook made through `POST /webhooks` with the version
// header signs Standard Webhooks, one made in the app or on `/v1/webhooks`
// signs the legacy header. Quo migrates nothing, so an app that has both
// receives both, and a verifier for one refuses every delivery of the other.
//
//   standard  `webhook-id`, `webhook-timestamp` (SECONDS), `webhook-signature:
//             v1,<b64> v1,<b64>`; HMAC-SHA256 over "<id>.<ts>.<raw>" under the
//             base64 after `whsec_`. Envelope `data.resource` + `data.context`.
//   legacy    `openphone-signature: hmac;1;<MILLISECONDS>;<b64>`; HMAC-SHA256
//             over "<ms>.<raw>" under the bare base64 key. Envelope `data.object`.
//
// Both over the RAW bytes. Quo's legacy prose says to strip whitespace from
// the JSON and its Node sample re-serializes; they agree with the raw bytes
// only because Quo sends compact JSON, and a literal strip would rewrite every
// text that contains a space.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Delivery, Dialect } from '@frontierjs/conduit'
import type { QuoCall, QuoContact, QuoEnvelope, QuoEvent, QuoEventPayload, QuoLegacyEnvelope, QuoMessage } from './types.ts'
import { callModel, contactModel, messageModel, parseTranscript, recordingModel, taskModel, type CallRow, type ContactRow, type MessageRow, type RecordingRow } from './mirror.ts'

/** Quo's own advice for both generations: "a few minutes". */
export const QUO_TOLERANCE_SECONDS = 300

export type QuoScheme = 'standard' | 'legacy'
export type Verified<E> = { ok: true; envelope: E } | { ok: false; reason: string }

const keyBytes = (secret: string) => Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
const hmac = (secret: string, signed: string) => createHmac('sha256', keyBytes(secret)).update(signed, 'utf8').digest('base64')

/** Length first, so a mismatch in length is no oracle: a digest's length is public. */
function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function envelopeOf<E>(rawBody: string, has: (b: any) => boolean): Verified<E> {
  try {
    const b = JSON.parse(rawBody)
    return b && typeof b.id === 'string' && typeof b.type === 'string' && has(b)
      ? { ok: true, envelope: b as E }
      : { ok: false, reason: 'body is not a Quo event of this generation' }
  } catch { return { ok: false, reason: 'body is not JSON' } }
}

export function verifyQuoSignature(opts: {
  rawBody:           string
  headers:           { 'webhook-id'?: string | null; 'webhook-timestamp'?: string | null; 'webhook-signature'?: string | null }
  /** `whsec_…`, exactly as `createWebhook` or `rotateWebhookKey` returned it. */
  secret:            string | undefined
  /** Seconds. */
  now:               number
  toleranceSeconds?: number
}): Verified<QuoEnvelope> {
  const { rawBody, headers, secret, now, toleranceSeconds = QUO_TOLERANCE_SECONDS } = opts
  if (!secret) return { ok: false, reason: 'no signing key is configured for this webhook' }
  const id = headers['webhook-id'], ts = headers['webhook-timestamp'], sigs = headers['webhook-signature']
  if (!id || !ts || !sigs) return { ok: false, reason: 'webhook-id, webhook-timestamp or webhook-signature is missing' }
  const seconds = Number(ts)
  if (!Number.isInteger(seconds)) return { ok: false, reason: 'timestamp is not a whole number of seconds' }
  const skew = Math.abs(now - seconds)
  if (skew > toleranceSeconds) return { ok: false, reason: `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s` }
  const want = hmac(secret, `${id}.${ts}.${rawBody}`)
  // Several entries is the SENDER mid-rotation; any one matching is enough.
  const hit = sigs.split(' ').some((entry) => {
    const [version, sig] = entry.trim().split(',', 2)
    return version === 'v1' && !!sig && same(sig, want)
  })
  if (!hit) return { ok: false, reason: 'signature does not match' }
  return envelopeOf<QuoEnvelope>(rawBody, b => !!b.data?.resource)
}

export function verifyQuoLegacySignature(opts: {
  rawBody:           string
  header:            string | null | undefined
  /** The bare base64 key from the webhook's "Reveal signing secret". */
  secret:            string | undefined
  /** Seconds, like every other verifier here; the header's milliseconds are converted, not the clock. */
  now:               number
  toleranceSeconds?: number
}): Verified<QuoLegacyEnvelope> {
  const { rawBody, header, secret, now, toleranceSeconds = QUO_TOLERANCE_SECONDS } = opts
  if (!secret) return { ok: false, reason: 'no signing key is configured for this webhook' }
  if (!header) return { ok: false, reason: 'openphone-signature is missing' }
  // Quo reserves commas for several signatures in a later version.
  const entries = header.split(',').map(e => e.trim().split(';')).filter(([s, v, ts, sig]) => s === 'hmac' && v === '1' && ts && sig)
  if (!entries.length) return { ok: false, reason: 'openphone-signature is not hmac;1;<ms>;<sig>' }
  let why = 'signature does not match'
  for (const [, , ts, sig] of entries) {
    const ms = Number(ts)
    if (!Number.isInteger(ms)) { why = 'timestamp is not a whole number of milliseconds'; continue }
    const skew = Math.round(Math.abs(now - ms / 1000))
    if (skew > toleranceSeconds) { why = `timestamp is ${skew}s out, tolerance is ${toleranceSeconds}s`; continue }
    if (same(sig, hmac(secret, `${ts}.${rawBody}`))) return envelopeOf<QuoLegacyEnvelope>(rawBody, b => !!b.data?.object)
  }
  return { ok: false, reason: why }
}

/** The sink's half, and a test's: sign the way a dated subscription does. */
export function signQuo(secret: string, id: string, seconds: number, rawBody: string): string {
  return `v1,${hmac(secret, `${id}.${seconds}.${rawBody}`)}`
}

/** The sink's half, and a test's: sign the way a legacy subscription does. */
export function signQuoLegacy(secret: string, ms: number, rawBody: string): string {
  return `hmac;1;${ms};${hmac(secret, `${ms}.${rawBody}`)}`
}

// ─── The two envelopes, as rows ──────────────────────────────────────────
//
// An event's row passes through its model's `parse`, the same one a read and a
// verb's answer use, so a sync and a webhook cannot disagree on a row's shape.
// A webhook resource is PARTIAL — `call.missed` names the call and two times —
// so the row holds only the columns whose field the event carries: a column it
// filled with `null` would clear what a read wrote (Invariant 9).

/** A row as one event carries it: the key, and the columns the event names. */
export type EventRow<R> = Partial<R> & { externalId: string }

const list = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]
const orNull = (v: unknown) => (v == null || v === '' ? null : String(v))

/** Keeps `externalId` and each column whose field (the key here) is in `fields`. */
function carried<R extends object>(row: R | null, fields: object, columns: Record<string, keyof R>): EventRow<R> | null {
  if (!row) return null
  const keep = new Set<PropertyKey>(['externalId', ...Object.entries(columns).filter(([f]) => f in fields).map(([, c]) => c)])
  return Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k))) as EventRow<R>
}

/** Where each message field lands; `senderIdentifier` and the rest are the dated context's names. */
const MESSAGE_COLUMNS: Record<string, keyof MessageRow> = {
  direction: 'direction', status: 'status', text: 'text', body: 'text', media: 'media', createdAt: 'createdAt', updatedAt: 'updatedAt',
  from: 'from', senderIdentifier: 'from', to: 'to', recipientIdentifiers: 'to',
  phoneNumberId: 'phoneNumberExternalId', conversationId: 'conversationExternalId', userId: 'userExternalId',
}

/**
 * Where each call field lands. `participants` is not among them: the webhook
 * marks ours and theirs (`external`), the row lists every party with its user,
 * and the one cannot be written as the other.
 */
const CALL_COLUMNS: Record<string, keyof CallRow> = {
  direction: 'direction', status: 'status', duration: 'duration', answeredByUserId: 'answeredByExternalId',
  forwardedFrom: 'forwardedFrom', forwardedTo: 'forwardedTo',
  answeredAt: 'answeredAt', completedAt: 'completedAt', createdAt: 'createdAt', updatedAt: 'updatedAt', phoneNumberId: 'phoneNumberExternalId',
}

/** `externalId` here is Quo's field, the source system's id, which the row calls `sourceId`. */
const CONTACT_COLUMNS: Record<string, keyof ContactRow> = {
  firstName: 'firstName', lastName: 'lastName', company: 'company', role: 'role',
  externalId: 'sourceId', source: 'source', sourceUrl: 'sourceUrl', actorId: 'actorExternalId', createdAt: 'createdAt', updatedAt: 'updatedAt',
  phoneNumbers: 'phoneNumbers', emails: 'emails',
}

/**
 * The voicemail event's fields. Its `duration` is the voicemail's, not the
 * call's, and its own `id` is neither the call's nor the voicemail's.
 */
const VOICEMAIL_COLUMNS: Record<string, keyof CallRow> = {
  voicemailId: 'voicemailExternalId', duration: 'voicemailDuration', transcript: 'voicemailTranscript', recordingUrl: 'voicemailUrl',
}

/** The summary event's fields; it has no `type` or `title`, which the read's summary does. */
const SUMMARY_COLUMNS: Record<string, keyof CallRow> = {
  processingStatus: 'summaryStatus', summary: 'summary', nextSteps: 'nextSteps', jobs: 'summaryJobs', answeredByUserId: 'answeredByExternalId',
}

/** A recording as the event carries it: no `status`. */
const RECORDING_COLUMNS: Record<string, keyof RecordingRow> = { callId: 'callExternalId', duration: 'duration', startTime: 'startTime', type: 'type', url: 'url' }

/**
 * The dated events whose `resource.id` is the call. The artifact events name
 * it as `callId` instead, and `call.voicemail.completed`'s own `id` is an
 * activity of its own, so a row from those keyed on `id` is the wrong row.
 */
const CALL_LIFECYCLE = new Set(['call.ringing', 'call.menu.selected', 'call.answered', 'call.completed', 'call.forwarded', 'call.missed', 'call.recording.completed'])

/** What an event carries beside its row. */
type Beside = Pick<QuoEventPayload, 'errorCode' | 'external' | 'conversationExternalId' | 'contactExternalIds' | 'recordings' | 'transcript'>
const NOTHING_BESIDE: Beside = { errorCode: null, external: null, conversationExternalId: null, contactExternalIds: null, recordings: null, transcript: null }

/**
 * What each task event says of its task, in Quo's field names. Most name the
 * id alone and the type is the change, so a status here is the type's: each
 * of the four names one value of the read's `status`. The context's links are
 * the task's on `created` and `linked` only: on `unlinked` they are what it
 * was taken out of.
 */
function taskFields(type: string, r: Record<string, any>, c: Record<string, any>): Record<string, unknown> | null {
  const links = { conversationId: c.conversationId, phoneNumberId: c.phoneNumberId, activityId: c.activityId, phoneNumberGroupId: c.phoneNumberGroupId }
  const changed = (f: { isUpdated?: boolean; updatedValue?: unknown } | undefined) => !!f?.isUpdated && 'updatedValue' in f
  switch (type) {
    case 'task.created':         return { title: r.title, description: r.description, dueDate: r.dueDate, status: 'open', createdBy: c.actorId, ...links }
    case 'task.updated':         return {
      ...(changed(r.updatedFields?.title) ? { title: r.updatedFields.title.updatedValue } : {}),
      ...(changed(r.updatedFields?.description) ? { description: r.updatedFields.description.updatedValue } : {}),
    }
    case 'task.completed':       return { status: 'completed' }
    case 'task.reopened':        return { status: 'open' }
    case 'task.deleted':         return { status: 'deleted' }
    case 'task.assigned':        return { assignedTo: r.assignedTo, assignedBy: c.actorId }
    case 'task.unassigned':      return { assignedTo: null }
    case 'task.overdue':         return { dueDate: r.dueDate }
    case 'task.linked':          return links
    case 'task.unlinked':        return { conversationId: null }
    case 'task.duedate.updated': return { dueDate: r.updatedDueDate }
    case 'task.duedate.removed': return { dueDate: null }
  }
  return null
}

/** A call event's context: the other side, the conversation, and Quo's contact match. */
const callContext = (c: Record<string, any>) => ({
  // `unavailable` is unknown, not nobody, so it is null rather than `[]`.
  external: c.participants?.resolution === 'unavailable' ? null : list(c.participants?.external),
  conversationExternalId: orNull(c.conversationId), contactExternalIds: matched(c),
})

/** A row keyed on the call an artifact names, holding only the columns `fields` names. */
const artifactRow = (callId: unknown, section: object, fields: object, columns: Record<string, keyof CallRow>) =>
  carried(callModel.parse({ id: callId, participants: [], ...section } as unknown as QuoCall), fields, columns)

/** Quo's own match of the other side's number. `unavailable` is unknown, not none, so it is null rather than `[]`. */
const matched = (c: Record<string, any>): string[] | null =>
  c.contacts && c.contacts.lookupStatus !== 'unavailable' && Array.isArray(c.contacts.ids) ? list(c.contacts.ids) : null

function standardRows(e: QuoEnvelope): Pick<QuoEventPayload, 'message' | 'call' | 'contact' | 'task'> & Beside {
  const type = String(e.type), r = e.data?.resource ?? {}, c = e.data?.context ?? {}
  const none = { message: null, call: null, contact: null, task: null, ...NOTHING_BESIDE }
  if (typeof r.id !== 'string' && typeof r.callId !== 'string') return none
  if (type.startsWith('message.')) {
    // The context's `userId` is not marked as the sender, and a read says null on an incoming message, so it lands nowhere.
    const fields = { ...r, senderIdentifier: c.senderIdentifier, recipientIdentifiers: c.recipientIdentifiers, phoneNumberId: c.phoneNumberId, conversationId: c.conversationId }
    const message = carried(messageModel.parse({ ...r, from: c.senderIdentifier, to: list(c.recipientIdentifiers), phoneNumberId: c.phoneNumberId, conversationId: c.conversationId } as QuoMessage), fields, MESSAGE_COLUMNS)
    const external = r.direction === 'incoming' ? list(c.senderIdentifier) : list(c.recipientIdentifiers)
    return { ...none, message, errorCode: orNull(r.errorCode), external, conversationExternalId: orNull(c.conversationId), contactExternalIds: matched(c) }
  }
  if (CALL_LIFECYCLE.has(type)) {
    // `menu.selected`, `forwarded` and `missed` carry no direction; Quo sends them for incoming calls only.
    const fields = { ...r, direction: r.direction ?? 'incoming', phoneNumberId: c.phoneNumberId }
    const call = carried(callModel.parse({ ...fields, answeredBy: r.answeredByUserId, participants: [] } as unknown as QuoCall), fields, CALL_COLUMNS)
    const recordings = type === 'call.recording.completed'
      ? (Array.isArray(r.recordings) ? r.recordings : []).map((x: Record<string, unknown>) => carried(recordingModel.parse({ ...x, callId: r.id } as never), { ...x, callId: r.id }, RECORDING_COLUMNS)).filter((x: unknown): x is EventRow<RecordingRow> => !!x)
      : null
    return { ...none, call, recordings, ...callContext(c) }
  }
  if (type === 'call.voicemail.completed') {
    const voicemail = { id: r.voicemailId, duration: r.duration, transcript: r.transcript, recordingUrl: r.recordingUrl }
    return { ...none, call: artifactRow(r.callId, { voicemail }, r, VOICEMAIL_COLUMNS), ...callContext(c) }
  }
  if (type === 'call.summary.completed') {
    const summary = { status: r.processingStatus, summary: r.summary, nextSteps: r.nextSteps, jobs: r.jobs }
    return { ...none, call: artifactRow(r.callId, { summary, answeredBy: r.answeredByUserId }, r, SUMMARY_COLUMNS), ...callContext(c) }
  }
  if (type === 'call.transcript.completed') return { ...none, transcript: parseTranscript(r), ...callContext(c) }
  if (type === 'contact.updated' || type === 'contact.deleted')
    return { ...none, contact: carried(contactModel.parse(r as QuoContact), r, CONTACT_COLUMNS) }
  const task = taskFields(type, r, c)
  if (task) return { ...none, task: taskModel.parse({ ...task, taskId: r.id }), conversationExternalId: orNull(c.conversationId) }
  return none
}

function legacyRows(e: QuoLegacyEnvelope): Pick<QuoEventPayload, 'message' | 'call' | 'contact' | 'task'> & Beside {
  const o = e.data?.object ?? {}
  const none = { message: null, call: null, contact: null, task: null, ...NOTHING_BESIDE }
  if (typeof o.id !== 'string' && typeof o.callId !== 'string') return none
  const external = o.direction === 'incoming' ? list(o.from) : list(o.to)
  if (o.object === 'message') {
    const message = carried(messageModel.parse({ ...o, text: o.body, to: list(o.to) } as QuoMessage), o, MESSAGE_COLUMNS)
    return { ...none, message, external, conversationExternalId: orNull(o.conversationId) }
  }
  if (o.object === 'call') {
    // A legacy call's `userId` is not marked as the actor or the answerer, so it lands in neither.
    const call = carried(callModel.parse({ ...o, participants: [] } as unknown as QuoCall), o, CALL_COLUMNS)
    // A legacy voicemail is `{ url, type, duration }` with no id or status, and `null` on every event
    // before the one that has it, so only one that is there is carried; a `null` would clear it.
    const vm = o.voicemail && typeof o.voicemail === 'object' ? o.voicemail : null
    const voicemail = vm && artifactRow(o.id, { voicemail: { recordingUrl: vm.url, duration: vm.duration } }, { recordingUrl: 1, duration: 1 }, { recordingUrl: 'voicemailUrl', duration: 'voicemailDuration' })
    return { ...none, call: call && { ...call, ...voicemail }, external, conversationExternalId: orNull(o.conversationId) }
  }
  if (o.object === 'callSummary')
    return { ...none, call: artifactRow(o.callId, { summary: { status: o.status, summary: o.summary, nextSteps: o.nextSteps } }, { status: 1, summary: 1, nextSteps: 1 }, { status: 'summaryStatus', summary: 'summary', nextSteps: 'nextSteps' }) }
  if (o.object === 'callTranscript') return { ...none, transcript: parseTranscript(o) }
  return none
}

/**
 * One event out of either envelope. A message, a call and a contact become
 * rows, so an app that has both subscriptions writes one row shape; every
 * event also keeps its `data` for the app to read.
 */
export function parseQuoEvent(envelope: QuoEnvelope | QuoLegacyEnvelope, scheme: QuoScheme): QuoEvent {
  const rows = scheme === 'standard' ? standardRows(envelope as QuoEnvelope) : legacyRows(envelope as QuoLegacyEnvelope)
  return {
    id: envelope.id, type: envelope.type,
    payload: { occurredAt: String(envelope.createdAt ?? ''), apiVersion: String(envelope.apiVersion ?? ''), ...rows, data: envelope.data },
  }
}

/**
 * Quo's test dispatch (`sendTestEvent`): a canonical sample whose every id is
 * one, the workspace's included. It proves the endpoint verifies, and it has
 * no row to write, so the Dialect hands conduit nothing and conduit answers it
 * `ignored`. The spec marks a test no other way.
 */
export const QUO_SAMPLE_ORG = 'ORsampleorg'
const isSample = (e: QuoEnvelope) => String(e.data?.context?.orgId ?? '').startsWith(QUO_SAMPLE_ORG)

// ─── Dialects for `app.conduit.receive()` ──────────────────────────────────

const header = (d: Delivery, name: string) => d.headers[name] ?? null

/** A dated subscription. One delivery is its `webhook-id`, stable across Quo's retries and distinct per subscription. */
export const quoDialect: Dialect<string, QuoEvent> = {
  verify(d, secret, { now }) {
    const v = verifyQuoSignature({ rawBody: d.rawBody, headers: { 'webhook-id': header(d, 'webhook-id'), 'webhook-timestamp': header(d, 'webhook-timestamp'), 'webhook-signature': header(d, 'webhook-signature') }, secret, now })
    return v.ok ? { ok: true } : { ok: false, reason: v.reason }
  },
  parse(d) {
    const v = envelopeOf<QuoEnvelope>(d.rawBody, b => !!b.data?.resource)
    return v.ok && !isSample(v.envelope) ? parseQuoEvent(v.envelope, 'standard') : null
  },
  dedupeKey: d => d.headers['webhook-id'],
}

/**
 * A legacy subscription. It sends no delivery id, so the envelope's id names
 * the delivery; that a legacy retry repeats it is the assumption the
 * prototype's sink was written to, unverified against Quo.
 */
export const quoLegacyDialect: Dialect<string, QuoEvent> = {
  verify(d, secret, { now }) {
    const v = verifyQuoLegacySignature({ rawBody: d.rawBody, header: header(d, 'openphone-signature'), secret, now })
    return v.ok ? { ok: true } : { ok: false, reason: v.reason }
  },
  parse(d) {
    const v = envelopeOf<QuoLegacyEnvelope>(d.rawBody, b => !!b.data?.object)
    return v.ok ? parseQuoEvent(v.envelope, 'legacy') : null
  },
  dedupeKey: (_d, ev) => ev.id,
}
