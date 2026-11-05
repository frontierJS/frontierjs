// src/mirror.ts — the mirror claim (`FJS-D1125`): how a Quo object becomes a
// row of the app's mirrored model, and the writes the app may forward. Of the
// nine, the API writes only contacts, tasks and a number's name and hours,
// so those three have verbs.
//
// A row's relation columns hold QUO's ids under `<relation>ExternalId`, named
// for Quo's own field (`userId` → `userExternalId`, `actorId` →
// `actorExternalId`), because the app's foreign keys do not exist until the
// sync has written the related row. A time is a `Date`, and an absent value is
// `null` whether Quo sent `null` or `''`, so a row has one spelling of empty.
//
// `parse` takes the REST object, which is what a backfill read and a verb's
// answer carry, and a contact event's resource, which is the REST contact
// with its numbers and emails inline. A message or call event's resource is a
// different shape (a call's context has no `participants` list), mapped in
// `verify.ts`.

import type { MirrorClaim, MirrorModel, ResponseValidator } from '@frontierjs/conduit'
import { QUO_TARGET, type QuoBusinessHours, type QuoCall, type QuoCallDisclosure, type QuoContact, type QuoConversation, type QuoMessage, type QuoOrganization, type QuoPhoneNumber, type QuoPhoneNumberMember, type QuoPhoneNumberSettings, type QuoRecording, type QuoRole, type QuoUser, type QuoRestrictions, type QuoSummaryJob, type QuoTask, type QuoTranscript, type QuoWeekday, type QuoWindow } from './types.ts'
import type { EventRow } from './verify.ts'

// ─── Rows ────────────────────────────────────────────────────

const orNull = (v: unknown): string | null => typeof v === 'string' && v !== '' ? v : null
const at = (v: unknown): Date | null => {
  const s = orNull(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []
const values = (v: { value?: unknown }[]): string[] => v.map(x => orNull(x?.value)).filter((x): x is string => x !== null)
const idOf = (v: unknown, prefix: string): v is string => typeof v === 'string' && v.startsWith(prefix) && v.length > prefix.length
const seconds = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null
/** A list with nothing in it is `null`, the one spelling of empty: Quo sends `jobs: []` on an event and `null` on a read. */
const listOrNull = <T>(v: T[] | null | undefined): T[] | null => Array.isArray(v) && v.length ? v : null

export interface MessageRow {
  externalId: string
  conversationExternalId: string | null; phoneNumberExternalId: string | null; userExternalId: string | null
  direction: 'incoming' | 'outgoing'; status: string
  from: string | null; to: string[]
  /** Null on a message of media alone. */
  text: string | null
  /** Quo says to download a file rather than keep its URL, because the URL does not last: `fileBytes`. */
  media: { url: string; type: string | null }[]
  createdAt: Date | null; updatedAt: Date | null
}
export interface CallRow {
  externalId: string
  phoneNumberExternalId: string | null; actorExternalId: string | null
  answeredByExternalId: string | null; initiatedByExternalId: string | null
  direction: 'incoming' | 'outgoing'; status: string | null
  /**
   * As Quo lists them, ours included. No `from` and `to`: which number is ours
   * is not marked when nobody answered, and a group call has more than two.
   */
  participants: { phoneNumber: string; actorExternalId: string | null }[]
  /** Seconds. */
  duration: number | null
  callRoute: string | null; forwardedFrom: string | null; forwardedTo: string | null; aiHandled: string | null
  answeredAt: Date | null; completedAt: Date | null; createdAt: Date | null; updatedAt: Date | null
  /**
   * ABSENT, not `null`, on a row from a call read without `include=voicemail`
   * (the call list's default), which says nothing of one; `null` when the read
   * asked and none was left. `voicemailUrl` is signed and does not last.
   */
  voicemailExternalId?: string | null; voicemailStatus?: string | null; voicemailDuration?: number | null
  voicemailTranscript?: string | null; voicemailUrl?: string | null
  /** ABSENT on a row from a call read without `include=summary`, as the voicemail's. */
  summaryStatus?: string | null; summaryType?: string | null
  summary?: string[] | null; nextSteps?: string[] | null; summaryTitle?: string | null; summaryJobs?: QuoSummaryJob[] | null
}
/** One recorded segment of a call; a call paused and resumed has several. */
export interface RecordingRow {
  externalId: string
  callExternalId: string
  status: string | null
  startTime: Date | null
  /** Seconds. */
  duration: number | null
  /** Signed, and does not last: download it with `fileBytes`, and read the recordings again for a fresh one. */
  url: string | null; type: string | null
}
/**
 * A call's dialogue: one per segment from `getCallTranscripts`, or the whole
 * call from `call.transcript.completed`, which names no recording. Not a
 * mirrored model, because the event's cannot be keyed on a segment.
 */
export interface CallTranscript {
  callExternalId: string
  /** The read's alone. */
  recordingExternalId?: string
  status: string | null
  /** The read's alone: when its segment began. */
  startTime?: Date | null
  createdAt: Date | null
  duration: number | null
  /** Each line's times are seconds into its own recording. The event calls the speaker `userId`, the read `actorId`. */
  dialogue: { actorExternalId: string | null; identifier: string | null; content: string; start: number | null; end: number | null }[] | null
}
export interface ConversationRow {
  externalId: string
  phoneNumberExternalId: string | null
  /** The newest message or call in it. */
  lastActivityExternalId: string | null
  name: string | null
  /** The other side's numbers, ours excluded. */
  participants: string[]
  lastActivityAt: Date | null; mutedUntil: Date | null; snoozedUntil: Date | null
  createdAt: Date | null; updatedAt: Date | null; deletedAt: Date | null
}
export interface ContactRow {
  externalId: string
  actorExternalId: string | null
  /**
   * Quo's own `externalId`: what the contact's source system calls it, stated
   * by whoever made it. Renamed, because a row's `externalId` is Quo's id.
   */
  sourceId: string | null; source: string | null; sourceUrl: string | null
  firstName: string | null; lastName: string | null; company: string | null; role: string | null
  /**
   * As Quo holds them, in its order, which is how an app matches a number at
   * ring time (`call.ringing` carries no contact ids). ABSENT, not `[]`, on a
   * row from the REST contact, which carries neither list: an upsert of it
   * leaves what an event or `getContactProperties` wrote.
   */
  phoneNumbers?: string[]; emails?: string[]
  createdAt: Date | null; updatedAt: Date | null
}

/**
 * A task's columns. A row from a write's answer or an event holds some of
 * them (`EventRow<TaskRow>`): every task write answers `{ taskId, revision }`
 * alone, so a column it did not set is left out rather than cleared.
 */
export interface TaskRow {
  externalId: string
  /** Quo files a task in a conversation; unlinking it leaves `null`. */
  conversationExternalId: string | null; phoneNumberExternalId: string | null
  activityExternalId: string | null; phoneNumberGroupExternalId: string | null
  title: string | null; description: string | null
  status: string
  dueDate: Date | null
  assignedToExternalId: string | null; assignedByExternalId: string | null; createdByExternalId: string | null
  createdAt: Date | null
  /** Quo's, moved by every write: a row holding a lower one is older. No event carries it. */
  revision: number | null
}

/** A task as the app makes one, in the row's names. */
export interface NewTask {
  title: string
  /** Required by Quo; `''` is a task with none. */
  description: string
  /** `CN…`; Quo files every task in a conversation. */
  conversationExternalId: string
  dueDate?: Date | string | null
  /** A `US…` user. */
  assignedToExternalId?: string | null
}
/** Quo's task PATCH takes the two together; every other column has its own call. */
export interface TaskPatch { title: string; description: string }

/**
 * A number in the workspace. No event reports one, so a row moves only when
 * it is read: a name changed in Quo's app reaches the mirror on the next
 * `backfillPhoneNumbers`. Four groups of columns are ABSENT unless the read
 * that made the row carried them, so an upsert leaves what another read wrote:
 * `restrictions` (the list and `getPhoneNumber`, never the update's answer),
 * `businessHours` (`getPhoneNumber` and the update, never the list),
 * `autoRecord` and `callDisclosure` (`getPhoneNumberSettings`), and
 * `memberExternalIds` (`getPhoneNumberMembers`).
 */
export interface PhoneNumberRow {
  externalId: string
  groupExternalId: string | null
  name: string | null
  /** E.164; the `from` a text names when it does not name this row's id. */
  phoneNumber: string | null; formattedNumber: string | null
  /** Where incoming calls go, or `null` for none. Set in Quo's app; the API cannot. */
  forward: string | null
  portRequestExternalId: string | null; portingStatus: string | null
  symbol: string | null
  createdAt: Date | null; updatedAt: Date | null
  restrictions?: QuoRestrictions
  businessHours?: QuoBusinessHours
  autoRecord?: boolean
  callDisclosure?: { inbound: QuoCallDisclosure; outbound: QuoCallDisclosure }
  /** Every `US…` user assigned to the number, ordered by id. */
  memberExternalIds?: string[]
}

/**
 * What the number's update takes: a name, and business hours, each part of
 * which is left as stored when left out. `schedule: null` clears every window;
 * a day left out of a schedule keeps its window (our reading of "only the
 * fields in the request change"), and a day `null` has none.
 */
export interface PhoneNumberPatch {
  name?: string
  businessHours?: { enabled?: boolean; timezone?: string; schedule?: Partial<Record<QuoWeekday, QuoWindow | null>> | null }
}

/** What `getPhoneNumberSettings` and its update fill. */
export type PhoneNumberSettingsRow = Pick<PhoneNumberRow, 'externalId'> & Required<Pick<PhoneNumberRow, 'autoRecord' | 'callDisclosure'>>

/**
 * A user of the workspace, the row a `userExternalId`, `actorExternalId` or
 * assignee names. No event reports one, so a row moves when it is read. A
 * number's member read lists a user without the picture or the times, so
 * those three are ABSENT on a row from `getPhoneNumberMembers`, and an upsert
 * keeps what `getUser` or `backfillUsers` wrote. A `SYU…` system actor is no
 * user and has no row.
 */
export interface UserRow {
  externalId: string
  email: string | null
  firstName: string | null; lastName: string | null
  role: QuoRole | null
  pictureUrl?: string | null
  createdAt?: Date | null; updatedAt?: Date | null
}

/** The workspace the key belongs to; one row. */
export interface OrganizationRow {
  externalId: string
  name: string | null
  /** `expired` is a lapsed billing period, in which every send is `billing`. */
  subscriptionStatus: 'active' | 'expired' | null
  createdAt: Date | null; updatedAt: Date | null
}

/** A contact as the app makes one, in the row's names. */
export interface NewContact {
  firstName: string
  lastName?: string | null; company?: string | null; role?: string | null
  /**
   * With `source`, unique in the workspace: a second create naming the pair
   * is Quo's 409, never a second contact. Quo's own default source is
   * `public-api`.
   */
  sourceId?: string | null; source?: string | null
  /** A URI, 1–200 characters. */
  sourceUrl?: string | null
  /** The `US…` user the creation is attributed to; default the org owner. */
  actorExternalId?: string | null
}
/** `null` clears; a field left out or `undefined` is not sent. Quo's PATCH takes no actor. */
export type ContactPatch = Partial<Omit<NewContact, 'firstName' | 'actorExternalId'>> & { firstName?: string | null }

// ─── The verbs ───────────────────────────────────────────────

// conduit's forward hands `parse` the answer as it came, and a dated answer is
// `{ data }`: without this the contact parses to null and the write is a 502.
const unwrapped: ResponseValidator = {
  validate: d => d && typeof d === 'object' && 'data' in d && (d as { data: unknown }).data
    ? { ok: true, value: (d as { data: unknown }).data }
    : { ok: false, errors: ['a dated answer is { data }, and this has none'] },
}

/** Row name → Quo's. `sourceId` is Quo's `externalId` (see `ContactRow`). */
const CONTACT_FIELDS = { firstName: 'firstName', lastName: 'lastName', company: 'company', role: 'role', sourceId: 'externalId', source: 'source', sourceUrl: 'sourceUrl' } as const

// A key outside the map is ignored rather than refused: junction hands a patch
// over whole, and a `@local` column in it is the app's to write, not Quo's.
function contactBody(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const [ours, theirs] of Object.entries(CONTACT_FIELDS)) {
    const v = input[ours]
    if (v === undefined) continue
    if (v !== null && typeof v !== 'string') throw new TypeError(`quo: a contact's ${ours} is a string or null`)
    body[theirs] = v
  }
  const url = body.sourceUrl
  if (typeof url === 'string' && !(url.length >= 1 && url.length <= 200 && URL.canParse(url))) throw new TypeError('quo: a contact\'s sourceUrl is a URI of 1–200 characters')
  return body
}

const contactPath = (key: string) => {
  if (typeof key !== 'string' || !key) throw new TypeError('quo: a contact is named by its Quo id, and this one is empty')
  return `/contacts/${encodeURIComponent(key)}`
}

// ─── The claim ───────────────────────────────────────────────

// A message and a call share the `AC…` id space, so the id cannot tell them
// apart: a message has `to`, a call has `participants`.
export const messageModel: MirrorModel<MessageRow, QuoMessage> = {
  key: 'externalId', target: QUO_TARGET,
  parse(m) {
    if (!m || !idOf(m.id, 'AC') || !Array.isArray(m.to)) return null
    return {
      externalId: m.id,
      conversationExternalId: orNull(m.conversationId), phoneNumberExternalId: orNull(m.phoneNumberId), userExternalId: orNull(m.userId),
      direction: m.direction, status: m.status,
      from: orNull(m.from), to: strings(m.to), text: orNull(m.text),
      media: (m.media ?? []).filter(x => orNull(x?.url)).map(x => ({ url: x.url, type: orNull(x.type) })),
      createdAt: at(m.createdAt), updatedAt: at(m.updatedAt),
    }
  },
}

export const callModel: MirrorModel<CallRow, QuoCall> = {
  key: 'externalId', target: QUO_TARGET,
  parse(c) {
    if (!c || !idOf(c.id, 'AC') || !Array.isArray(c.participants)) return null
    return {
      externalId: c.id,
      phoneNumberExternalId: orNull(c.phoneNumberId), actorExternalId: orNull(c.actorId),
      answeredByExternalId: orNull(c.answeredBy), initiatedByExternalId: orNull(c.initiatedBy),
      direction: c.direction, status: orNull(c.status),
      participants: c.participants.filter(p => orNull(p?.phoneNumber)).map(p => ({ phoneNumber: p.phoneNumber, actorExternalId: orNull(p.actorId) })),
      duration: typeof c.duration === 'number' ? c.duration : null,
      callRoute: orNull(c.callRoute), forwardedFrom: orNull(c.forwardedFrom), forwardedTo: orNull(c.forwardedTo), aiHandled: orNull(c.aiHandled),
      answeredAt: at(c.answeredAt), completedAt: at(c.completedAt), createdAt: at(c.createdAt), updatedAt: at(c.updatedAt),
      ...('voicemail' in c ? {
        voicemailExternalId: orNull(c.voicemail?.id), voicemailStatus: orNull(c.voicemail?.status), voicemailDuration: seconds(c.voicemail?.duration),
        voicemailTranscript: orNull(c.voicemail?.transcript), voicemailUrl: orNull(c.voicemail?.recordingUrl),
      } : {}),
      ...('summary' in c ? {
        summaryStatus: orNull(c.summary?.status), summaryType: orNull(c.summary?.type),
        summary: listOrNull(strings(c.summary?.summary)), nextSteps: listOrNull(strings(c.summary?.nextSteps)),
        summaryTitle: orNull(c.summary?.title), summaryJobs: listOrNull(c.summary?.jobs),
      } : {}),
    }
  },
}

/** A REST recording names no call, so the read that listed it hands `callId` in beside it. */
export const recordingModel: MirrorModel<RecordingRow, QuoRecording & { callId: string }> = {
  key: 'externalId', target: QUO_TARGET,
  parse(r) {
    // The spec's REST pattern is `CR…` and its event example `RE…`, so the id is checked for presence alone.
    if (!r || !orNull(r.id) || !idOf(r.callId, 'AC')) return null
    return {
      externalId: r.id, callExternalId: r.callId,
      status: orNull(r.status), startTime: at(r.startTime), duration: seconds(r.duration),
      url: orNull(r.url), type: orNull(r.type),
    }
  },
}

/** A transcript from the read (`QuoTranscript`) or the event, with the call it belongs to. */
export function parseTranscript(t: (Partial<QuoTranscript> | Record<string, any>) & { callId?: unknown } | null | undefined): CallTranscript | null {
  if (!t || !idOf(t.callId, 'AC')) return null
  const lines = Array.isArray(t.dialogue) ? t.dialogue as Record<string, unknown>[] : null
  return {
    callExternalId: t.callId,
    ...(orNull(t.recordingId) ? { recordingExternalId: t.recordingId as string } : {}),
    status: orNull(t.status ?? (t as Record<string, unknown>).processingStatus),
    ...('startTime' in t ? { startTime: at(t.startTime) } : {}),
    createdAt: at(t.createdAt), duration: seconds(t.duration),
    dialogue: lines && lines.filter(l => typeof l?.content === 'string').map(l => ({
      actorExternalId: orNull(l.actorId ?? l.userId), identifier: orNull(l.identifier),
      content: l.content as string, start: seconds(l.start), end: seconds(l.end),
    })),
  }
}

export const conversationModel: MirrorModel<ConversationRow, QuoConversation> = {
  key: 'externalId', target: QUO_TARGET,
  parse(c) {
    if (!c || !idOf(c.id, 'CN')) return null
    return {
      externalId: c.id,
      phoneNumberExternalId: orNull(c.phoneNumberId), lastActivityExternalId: orNull(c.lastActivityId),
      name: orNull(c.name), participants: strings(c.participants),
      lastActivityAt: at(c.lastActivityAt), mutedUntil: at(c.mutedUntil), snoozedUntil: at(c.snoozedUntil),
      createdAt: at(c.createdAt), updatedAt: at(c.updatedAt), deletedAt: at(c.deletedAt),
    }
  },
}

// A contact's id has no prefix (the spec's pattern is any string; its example
// is 24 hex digits), so only its presence is checked.
//
// Create is not replayed: after one that landed, a replay is a second contact,
// or with a `sourceId` a 409 reporting the success as a conflict. A lost
// answer is `indeterminate`, and a retry naming the same `sourceId` and
// `source` is the 409 that says it landed. Update is replayed, as every field
// is set to a value. Delete is replayed by conduit (the method is
// idempotent), and Quo answers the replay of one that landed 404.
export const contactModel: MirrorModel<ContactRow, QuoContact, NewContact, ContactPatch> = {
  key: 'externalId', target: QUO_TARGET,
  parse(c) {
    if (!c || !orNull(c.id)) return null
    return {
      externalId: c.id, actorExternalId: orNull(c.actorId),
      sourceId: orNull(c.externalId), source: orNull(c.source), sourceUrl: orNull(c.sourceUrl),
      firstName: orNull(c.firstName), lastName: orNull(c.lastName), company: orNull(c.company), role: orNull(c.role),
      ...(Array.isArray(c.phoneNumbers) ? { phoneNumbers: values(c.phoneNumbers) } : {}),
      ...(Array.isArray(c.emails) ? { emails: values(c.emails) } : {}),
      createdAt: at(c.createdAt), updatedAt: at(c.updatedAt),
    }
  },
  create(input) {
    if (typeof input?.firstName !== 'string') throw new TypeError('quo: a contact is created with a firstName')
    const body = contactBody(input as unknown as Record<string, unknown>)
    const actor = input.actorExternalId
    if (actor !== undefined && actor !== null) {
      if (!idOf(actor, 'US')) throw new TypeError(`quo: '${actor}' is not a user id (US…)`)
      body.actorId = actor
    }
    return { method: 'POST', path: '/contacts', body, validate: unwrapped }
  },
  update(key, patch) {
    return { method: 'PATCH', path: contactPath(key), body: contactBody((patch ?? {}) as Record<string, unknown>), replayable: true, validate: unwrapped }
  },
  delete(key) { return { method: 'DELETE', path: contactPath(key) } },
}

// ─── Tasks ───────────────────────────────────────────────────

/** Quo's field → the row's column. `parse` keeps a column only where its field is present. */
const TASK_FIELDS: Record<string, [keyof TaskRow, (v: unknown) => unknown]> = {
  conversationId: ['conversationExternalId', orNull], phoneNumberId: ['phoneNumberExternalId', orNull],
  activityId: ['activityExternalId', orNull], phoneNumberGroupId: ['phoneNumberGroupExternalId', orNull],
  title: ['title', orNull], description: ['description', orNull], status: ['status', orNull], dueDate: ['dueDate', at],
  assignedTo: ['assignedToExternalId', orNull], assignedBy: ['assignedByExternalId', orNull], createdBy: ['createdByExternalId', orNull],
  createdAt: ['createdAt', at], revision: ['revision', v => Number.isInteger(v) ? v : null],
}

/** The fields a read may leave out; on a read, left out is `null`. */
const TASK_OPTIONAL = ['phoneNumberId', 'conversationId', 'activityId', 'phoneNumberGroupId', 'title', 'description', 'dueDate', 'assignedTo', 'assignedBy']

/** A task as a read answers it: every column, a field the read left out as `null`. */
export const taskFromRead = (t: QuoTask | null | undefined) =>
  t && typeof t === 'object' ? taskModel.parse({ ...Object.fromEntries(TASK_OPTIONAL.map(f => [f, null])), ...t }) as TaskRow | null : null

export const taskPath = (key: string) => {
  if (!idOf(key, 'TK')) throw new TypeError(`quo: '${key}' is not a task id (TK…)`)
  return `/tasks/${encodeURIComponent(key)}`
}

/** A time Quo takes, from a `Date` or anything `Date` reads. */
export const isoOf = (v: Date | string, what: string) => {
  const d = v instanceof Date ? v : new Date(v)
  if (Number.isNaN(d.getTime())) throw new TypeError(`quo: ${what} '${String(v)}' is not a time`)
  return d.toISOString()
}

/** A task write's answer, `{ data: { taskId, revision } }`, with what the write set beside it. */
const answered = (set: Record<string, unknown>): ResponseValidator => ({
  validate: d => {
    const a = d && typeof d === 'object' ? (d as { data?: { taskId?: unknown; revision?: unknown } }).data : null
    return a && idOf(a.taskId, 'TK') ? { ok: true, value: { ...set, taskId: a.taskId, revision: a.revision } } : { ok: false, errors: ['a task write answers { data: { taskId, revision } }, and this has none'] }
  },
})

/** A column the PATCH cannot write, and the call that writes it. */
const TASK_CALLS: Record<string, string> = {
  status: 'setTaskStatus', dueDate: 'setTaskDueDate', assignedToExternalId: 'assignTask or unassignTask', conversationExternalId: 'linkTask or unlinkTask',
  phoneNumberExternalId: 'linkTask', activityExternalId: 'linkTask', phoneNumberGroupExternalId: 'linkTask',
  assignedByExternalId: 'none; Quo sets it', createdByExternalId: 'none; Quo sets it', createdAt: 'none; Quo sets it', revision: 'none; Quo sets it',
}

// Create is not replayed: Quo takes no key, so a replay of one that landed is
// a second task, and `backfillTasks` is the read that finds a lost one. Update
// is replayed, as it sets both fields. Delete is a status, not a removal: Quo
// keeps the task `deleted`, so the row stays and says so.
export const taskModel: MirrorModel<EventRow<TaskRow>, Partial<QuoTask>, NewTask, TaskPatch> = {
  key: 'externalId', target: QUO_TARGET,
  parse(t) {
    if (!t || !idOf(t.taskId, 'TK')) return null
    const row: Record<string, unknown> = { externalId: t.taskId }
    for (const [field, [column, read]] of Object.entries(TASK_FIELDS)) if (field in t) row[column] = read((t as Record<string, unknown>)[field])
    return row as EventRow<TaskRow>
  },
  create(input) {
    if (typeof input?.title !== 'string' || typeof input.description !== 'string') throw new TypeError('quo: a task is created with a title and a description, both strings')
    if (!idOf(input.conversationExternalId, 'CN')) throw new TypeError(`quo: '${input.conversationExternalId}' is not a conversation id (CN…); Quo files every task in one`)
    const assignee = input.assignedToExternalId
    if (assignee != null && !idOf(assignee, 'US')) throw new TypeError(`quo: '${assignee}' is not a user id (US…)`)
    const body: Record<string, unknown> = { title: input.title, description: input.description, conversationId: input.conversationExternalId }
    if (input.dueDate != null) body.dueDate = isoOf(input.dueDate, 'a due date')
    if (assignee != null) body.assignedTo = assignee
    // A new task is open, and its due date is what was sent; who made it and its number are the event's to say.
    const set = { ...body, status: 'open', dueDate: body.dueDate ?? null }
    return { method: 'POST', path: '/tasks', body, validate: answered(set) }
  },
  // Quo's spec requires both fields, so both always go: one alone may be refused.
  update(key, patch) {
    const p = (patch ?? {}) as unknown as Record<string, unknown>
    for (const k of Object.keys(p)) if (k in TASK_CALLS) throw new TypeError(`quo: a task's ${k} is not Quo's PATCH to write; its call is ${TASK_CALLS[k]}`)
    if (typeof p.title !== 'string' || typeof p.description !== 'string') throw new TypeError('quo: Quo\'s task PATCH takes the title and the description together, both strings')
    const body = { title: p.title, description: p.description }
    return { method: 'PATCH', path: taskPath(key), body, replayable: true, validate: answered(body) }
  },
  delete(key) {
    return { method: 'DELETE', path: taskPath(key), validate: { validate: () => ({ ok: true, value: { taskId: key, status: 'deleted' } }) } }
  },
}

// ─── Phone numbers ───────────────────────────────────────────

export const phoneNumberPath = (key: string) => {
  // `/phone-numbers/available` is a route of its own, so an id that is not one
  // reads the available numbers and answers no row rather than a 404.
  if (!idOf(key, 'PN')) throw new TypeError(`quo: '${key}' is not a phone number id (PN…)`)
  return `/phone-numbers/${encodeURIComponent(key)}`
}

const WEEKDAYS: readonly QuoWeekday[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const HHMM = /^([01][0-9]|2[0-3])[0-5][0-9]$/

/** IANA, which Quo reads `schedule` in; `Intl` also takes an offset, which is not one. */
const isTimezone = (v: unknown) => {
  if (typeof v !== 'string' || !/^[A-Za-z]/.test(v)) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true } catch { return false }
}

/** A column the number's PATCH cannot write, and what does. */
const PHONE_NUMBER_CALLS: Record<string, string> = {
  autoRecord: 'updatePhoneNumberSettings', callDisclosure: 'updatePhoneNumberSettings',
  memberExternalIds: 'none; members are assigned in Quo\'s app',
  ...Object.fromEntries(['externalId', 'groupExternalId', 'phoneNumber', 'formattedNumber', 'forward', 'portRequestExternalId', 'portingStatus', 'symbol', 'restrictions', 'createdAt', 'updatedAt']
    .map(k => [k, 'none; the API does not write it'])),
}

function businessHoursBody(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new TypeError('quo: a number\'s businessHours is an object of enabled, timezone and schedule')
  const b = v as Record<string, unknown>, out: Record<string, unknown> = {}
  for (const k of Object.keys(b)) if (!['enabled', 'timezone', 'schedule'].includes(k)) throw new TypeError(`quo: '${k}' is not part of a number's businessHours (enabled, timezone, schedule)`)
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') throw new TypeError('quo: businessHours.enabled is true or false')
    out.enabled = b.enabled
  }
  if (b.timezone !== undefined) {
    if (!isTimezone(b.timezone)) throw new TypeError(`quo: '${String(b.timezone)}' is not an IANA timezone`)
    out.timezone = b.timezone
  }
  if (b.schedule === null) out.schedule = null
  else if (b.schedule !== undefined) {
    const s = b.schedule as Record<string, unknown>
    if (typeof s !== 'object' || Array.isArray(s)) throw new TypeError('quo: a schedule is an object of weekdays, or null to clear it')
    const days: Record<string, unknown> = {}
    for (const [day, w] of Object.entries(s)) {
      if (!(WEEKDAYS as readonly string[]).includes(day)) throw new TypeError(`quo: '${day}' is not a weekday (monday…sunday)`)
      if (w === undefined) continue
      if (w !== null && !(typeof w === 'object' && HHMM.test(String((w as QuoWindow).start)) && HHMM.test(String((w as QuoWindow).end))))
        throw new TypeError(`quo: ${day}'s window is { start, end } in 24-hour HHMM, or null for none`)
      days[day] = w === null ? null : { start: (w as QuoWindow).start, end: (w as QuoWindow).end }
    }
    if (!Object.keys(days).length) throw new TypeError('quo: a schedule names at least one weekday; null clears it')
    out.schedule = days
  }
  if (!Object.keys(out).length) throw new TypeError('quo: businessHours names at least one of enabled, timezone and schedule')
  return out
}

// No create and no delete: a number is bought and released in Quo's app. The
// update is replayed, since it sets values, and answers the whole number with
// its business hours, so the row it lands is the read's but `restrictions`.
export const phoneNumberModel: MirrorModel<PhoneNumberRow, QuoPhoneNumber, never, PhoneNumberPatch> = {
  key: 'externalId', target: QUO_TARGET,
  parse(p) {
    if (!p || !idOf(p.id, 'PN')) return null
    return {
      externalId: p.id, groupExternalId: orNull(p.groupId),
      name: orNull(p.name), phoneNumber: orNull(p.phoneNumber), formattedNumber: orNull(p.formattedNumber), forward: orNull(p.forward),
      portRequestExternalId: orNull(p.portRequestId), portingStatus: orNull(p.portingStatus), symbol: orNull(p.symbol),
      createdAt: at(p.createdAt), updatedAt: at(p.updatedAt),
      ...(p.restrictions && typeof p.restrictions === 'object' ? { restrictions: p.restrictions } : {}),
      ...(p.businessHours && typeof p.businessHours === 'object' ? { businessHours: p.businessHours } : {}),
    }
  },
  // A key outside the two is ignored, as Contact's, for a `@local` column; one
  // the API writes elsewhere, or not at all, is refused naming which.
  update(key, patch) {
    const p = (patch ?? {}) as Record<string, unknown>, body: Record<string, unknown> = {}
    for (const k of Object.keys(p)) if (k in PHONE_NUMBER_CALLS && p[k] !== undefined) throw new TypeError(`quo: a number's ${k} is not its PATCH to write; its call is ${PHONE_NUMBER_CALLS[k]}`)
    if (p.name !== undefined) {
      if (typeof p.name !== 'string' || p.name.length < 1 || p.name.length > 500) throw new TypeError('quo: a number\'s name is 1–500 characters, and cannot be cleared')
      body.name = p.name
    }
    if (p.businessHours !== undefined) body.businessHours = businessHoursBody(p.businessHours)
    if (!Object.keys(body).length) throw new TypeError('quo: a number\'s update names its name or its businessHours')
    return { method: 'PATCH', path: phoneNumberPath(key), body, replayable: true, validate: unwrapped }
  },
}

/** A settings answer as the part of the number's row it fills. */
export const settingsRow = (s: QuoPhoneNumberSettings | null | undefined): PhoneNumberSettingsRow | null =>
  s && idOf(s.phoneNumberId, 'PN') && typeof s.autoRecord === 'boolean' && s.callDisclosure
    ? { externalId: s.phoneNumberId, autoRecord: s.autoRecord, callDisclosure: { inbound: s.callDisclosure.inbound, outbound: s.callDisclosure.outbound } }
    : null

// ─── Users and the organization ──────────────────────────────

export const userPath = (key: string) => {
  if (!idOf(key, 'US')) throw new TypeError(`quo: '${key}' is not a user id (US…)`)
  return `/users/${encodeURIComponent(key)}`
}

// No verbs: a user is invited and removed in Quo's app. A number's member
// carries no picture and no times, so a column the object does not name is
// left out rather than `null`, which would clear what a user read wrote.
export const userModel: MirrorModel<UserRow, QuoUser | QuoPhoneNumberMember> = {
  key: 'externalId', target: QUO_TARGET,
  parse(u) {
    if (!u || !idOf(u.id, 'US')) return null
    return {
      externalId: u.id, email: orNull(u.email), firstName: orNull(u.firstName), lastName: orNull(u.lastName), role: orNull(u.role) as QuoRole | null,
      ...('pictureUrl' in u ? { pictureUrl: orNull(u.pictureUrl) } : {}),
      ...('createdAt' in u ? { createdAt: at(u.createdAt) } : {}),
      ...('updatedAt' in u ? { updatedAt: at(u.updatedAt) } : {}),
    }
  },
}

export const organizationModel: MirrorModel<OrganizationRow, QuoOrganization> = {
  key: 'externalId', target: QUO_TARGET,
  parse(o) {
    if (!o || !idOf(o.id, 'OR')) return null
    return {
      externalId: o.id, name: orNull(o.name), subscriptionStatus: orNull(o.subscriptionStatus) as OrganizationRow['subscriptionStatus'],
      createdAt: at(o.createdAt), updatedAt: at(o.updatedAt),
    }
  },
}

/** What `app.conduit.mirror(quo.mirror)` binds. */
export const mirror: MirrorClaim = {
  provider: 'quo',
  models:   { Message: messageModel, Conversation: conversationModel, Contact: contactModel, Call: callModel, Recording: recordingModel, Task: taskModel, PhoneNumber: phoneNumberModel, User: userModel, Organization: organizationModel },
}
