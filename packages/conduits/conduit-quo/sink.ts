// sink.ts — Quo, standing in for Quo.
//
// Both generations on one listener, as on the real origin: `POST /v1/messages`
// with no version header, and the dated routes refusing any request without
// `Quo-Api-Version: 2026-03-30` the way Quo's 400 does. The raw key in
// `Authorization`, no `Bearer`. A webhook made through `POST /webhooks` gets a
// `whsec_` key minted here, and every delivery to it is signed Standard
// Webhooks with THAT key, so a drive verifies with what the create handed it,
// as an app does; `rotate` swaps it at once. A legacy subscription is an
// option, signed `openphone-signature` in milliseconds with a bare key.
//
// Chaos: `{ lost }`, `{ rateLimit }`, `{ failNext }`, `{ deliverTwice }` (one
// `webhook-id`, as a Quo retry carries), `{ deliverFirst }` (the delivery
// receipt before the send is answered), `{ failDelivery }` (the next send
// ends `failed`, `permanent` — failed with a carrier code — or
// `undelivered`), and `{ refuse: <name> }` for the refusals Quo's spec names.
// `POST /messages/{id}/retry` takes only a `failed` message with no code, as
// Quo's does. Every dated delivery is logged the way `GET /webhooks/{id}/events`
// reads it — its id is the `webhook-id` header, each attempt keeps the
// receiver's answer — and the log is Quo's state, so `reset` keeps it. A
// refused delivery stays `sending` with its next attempt scheduled, as Quo's
// does for about 27 hours; the sink makes no further attempts, and `POST
// /_sink/exhaust` is that schedule running out, turning each one `failed`.
// `POST /webhooks/{id}/events/{deliveryId}/retry` is taken in any state and
// queues one `manual` attempt, signed with the hook's key at that moment and
// a fresh timestamp. `POST /webhooks/{id}/events/test` answers with a sample
// envelope, unwrapped, whose id is the same on every dispatch, and delivers
// it after under a fresh `webhook-id`. `PATCH /webhooks/{id}` changes only
// the fields given and keeps the key; `resourceIds` null or `[]` is read as
// `['*']`, the spec's "clear phone number filtering". A `+44` recipient is international, which a
// workspace without it enabled refuses. `POST /_sink/call` places a call, in
// or out, answered or missed, and `unresolved` marks its participants
// `unavailable`; it is kept as `GET /calls` lists it. A text or a call lands in
// the conversation of its number and its other side, made the first time and
// moved on every one after. Its inbox state is kept beside it, since Quo's
// conversation carries none: whatever arrives makes it unread and open, a send
// moves neither unless it says `setInboxStatus: 'done'`, and the three
// `mark-as-*` routes answer the conversation unchanged, `updatedAt` included.
// `/_sink/seen` shows the state as `inbox`. `POST /_sink/seed` adds rows dated in the past.
// Every list pages by an `after` cursor, and each takes only the bounds its
// spec names: `/messages` `createdAt[gt|lt]` (any other ignored), `/calls`
// `createdAt[gte|lte]` and `/conversations` the same on `createdAt` or
// `updatedAt` (any other a 400), `/contacts` none. `{ forbidAfter: n }`
// answers the list read after the next `n` with a 403. A contact is created,
// patched and deleted; a create or patch that leaves two contacts sharing a
// `source` and `externalId` is the spec's 409, and a second delete a 404.
// Each write that lands delivers `contact.updated` (a create too) or
// `contact.deleted` to every hook that asked, whatever its numbers, with the
// contact's numbers and emails inline. A contact's properties are `GET` (paged,
// `type` filtered) and `POST /contacts/{id}/properties`, and a `POST` is a
// `contact.updated` too, which is our reading of "its fields changed". A
// message or call context names the contacts holding the other side's number,
// `unavailable` on a call whose participants are; `ringing` names none.
// A call placed with `segments` is recorded in that many pieces, with a
// transcript per piece and a summary; a missed one with `voicemail` gets one.
// Each artifact event follows `call.completed`, and the calls answer them on
// `GET /calls[/{id}]?include=summary,voicemail` and
// `/calls/{id}/recordings|transcripts`. Every audio file is served at a signed
// `/_files/` URL that takes no key: one carrying an `Authorization` header is
// refused, as storage refuses a second credential, and `{ expireFiles: true }`
// makes the next fetch the expired URL's 403. `/_sink/seen` lists the files and
// every fetch of one. A task is made in a conversation that exists, and every
// write to it answers `{ taskId, revision }`, moves the revision when it
// changes something, and delivers the event naming the change, filtered by
// the task's number; deleting is a status, so a deleted task is still read.
// The PATCH takes the title and description together, as the spec requires.
// Taking a task out of a conversation it is not in, or from a user it is not
// assigned to, is a 400, our reading. `{ openTasksFull: true }` is the 402 on
// every create and reopen, and `POST /_sink/overdue` runs Quo's overdue check.
// Each of our numbers is a phone number in the workspace, its members the
// three users, with no business hours stored, recording off and no
// disclosure. The list takes `include=restrictions` and refuses
// `businessHours`, which the one-number read takes; the PATCH changes the
// fields named, a schedule's days merged into the stored one (our reading),
// and answers the number with its business hours and no restrictions.
// Members list by user id. `/phone-numbers/available` is matched before the
// one-number route, as a path segment it reads the same. `POST /_sink/seed`
// takes `phoneNumbers`, each with a count of `members` made up for it or the
// `memberIds` of users who exist.
// Three users, Olive the owner among them, and the workspace `ORdev`. A member
// lists without the picture or the times and with a `groupId`; the user list
// orders by id, our reading, since the spec names none. A user's numbers list
// as the number list does, and an unknown user's are `[]`, since the spec
// names no 404 there. `POST /_sink/seed` takes `organization`, its fields
// kept, and `users`.
// One A2P registration at most. A create, or a patch naming the business name,
// type, website or contact name, runs autofill for `AUTOFILL_MS`, and a submit
// inside it is the spec's 409. A submit pays (`payments` in `/_sink/seen`) and
// `{ paymentFails }` is its 402; an expired workspace's create is the 402 the
// spec names. `POST /_sink/a2p` is the carrier's verdict. Our readings: a
// submit of one already submitted and `pending` or `approved` is a 409, a
// `rejected` one may be submitted again, and autofill writes `messaging` from
// the message types and the website.

import { randomBytes } from 'node:crypto'
import { signQuo, signQuoLegacy } from './src/verify.ts'
import { QUO_EVENT_TYPES } from './src/types.ts'

const VERSION = '2026-03-30'
/** The spec's own example of the fixed id every test dispatch carries. */
const TEST_EVENT_ID = '2abcDEFghiJKLmnoPQRstu45'
const TEST_TYPES = new Set<string>(QUO_EVENT_TYPES)
/** Whose key the sink is: the actor of every task write made through it. */
const TASK_ACTOR = 'USowner'
/** How long the sink's autofill runs. */
const AUTOFILL_MS = 60

export const SINK_REFUSALS = {
  unregistered:      { status: 400, code: '0206400', title: 'A2P Registration Not Approved', message: 'Your A2P 10DLC registration is not approved.' },
  dailyCap:          { status: 403, code: '0204403', title: 'A2P 10DLC Daily Message Cap Reached', message: 'The daily message cap for this number is reached.' },
  conversationLimit: { status: 429, code: '0200429', title: 'Daily Conversation Limit Reached', message: 'The daily limit of new conversations is reached.' },
  subscription:      { status: 402, code: '0201402', title: 'Subscription Expired', message: 'The workspace subscription has expired.' },
  notMember:         { status: 403, code: '0202403', title: 'Not Phone Number User', message: 'The user is not a member of this phone number.' },
} as const
export type SinkRefusal = keyof typeof SINK_REFUSALS

export interface QuoSinkOptions {
  port?:    number
  key?:     string
  /** Our numbers: E.164 → `PN…`. */
  numbers?: Record<string, string>
  /** A legacy subscription beside whatever `POST /webhooks` makes. */
  legacy?:  { url: () => string; key: string }
}

interface Hook { id: string; url: string; events: string[]; resourceIds: string[]; label: string | null; status: string; key: string; createdAt: string; updatedAt: string }
interface Call { id: string; direction: 'incoming' | 'outgoing'; ours: string; theirs: string; phoneNumberId: string | null; conversationId: string; createdAt: string; answeredAt: string | null; completedAt: string; unresolved: boolean }
interface RestCall { id: string; phoneNumberId: string | null; actorId: string; direction: 'incoming' | 'outgoing'; status: string; participants: { phoneNumber: string; actorId: string | null }[]; answeredAt: string | null; answeredBy: string | null; initiatedBy: string | null; completedAt: string | null; createdAt: string; updatedAt: string | null; callRoute: string | null; duration: number; forwardedFrom: string | null; forwardedTo: string | null; aiHandled: string | null }
interface Conversation { id: string; phoneNumberId: string | null; name: string | null; participants: string[]; lastActivityId: string | null; lastActivityAt: string | null; mutedUntil: string | null; snoozedUntil: string | null; createdAt: string; updatedAt: string; deletedAt: string | null }
interface Contact { id: string; externalId: string | null; source: string | null; sourceUrl: string | null; firstName: string | null; lastName: string | null; company: string | null; role: string | null; actorId: string; createdAt: string; updatedAt: string }
interface Rec { id: string; status: string; startTime: string; duration: number | null; url: string | null; type: string | null }
interface Transcript { recordingId: string; status: string; startTime: string; createdAt: string; duration: number; dialogue: { content: string; start: number; end: number; identifier: string | null; actorId: string | null }[] }
interface Artifacts { recordings: Rec[]; transcripts: Transcript[]; summary: Record<string, unknown> | null; voicemail: Record<string, unknown> | null }
interface Prop { id: string; type: string; name: string | null; value: unknown; createdAt: string; updatedAt: string }
interface Task { taskId: string; orgId: string; phoneNumberId: string | null; conversationId: string | null; activityId: string | null; phoneNumberGroupId: string | null; title: string; description: string; dueDate: string | null; assignedTo: string | null; assignedBy: string | null; createdBy: string; createdAt: string; status: 'open' | 'completed' | 'deleted'; revision: number }
interface Num { id: string; groupId: string; name: string; phoneNumber: string; formattedNumber: string | null; forward: string | null; portRequestId: string | null; portingStatus: string | null; symbol: string | null; createdAt: string; updatedAt: string
  hours: { enabled: boolean; timezone: string | null; schedule: Record<string, { start: string; end: string } | null> | null }; autoRecord: boolean; callDisclosure: { inbound: string; outbound: string }; members: string[] }
interface User { id: string; email: string; firstName: string | null; lastName: string | null; pictureUrl: string | null; role: 'owner' | 'admin' | 'member'; groupId: string; createdAt: string; updatedAt: string }
interface Msg { id: string; to: string[]; from: string; text: string; phoneNumberId: string | null; conversationId: string; direction: string; userId: string | null; status: string; errorCode?: string | null; createdAt: string; updatedAt: string; media: unknown[] }
interface Reg { id: string; draft: boolean; status: 'pending' | 'approved' | 'rejected' | 'failed'; statusMessages: unknown[]; type: string | null; assignedPnId: string | null; firstSubmittedAt: string | null; createdAt: string; updatedAt: string
  businessInfo: Record<string, unknown> & { address: Record<string, unknown>; personOfContact: Record<string, unknown> }; messaging: { useCase: string | null; personalUse: boolean | null; consent: Record<string, unknown> | null } }
type FailDelivery = 'failed' | 'permanent' | 'undelivered'
interface Attempt { id: string; timestamp: string; status: 'success' | 'failed'; responseStatusCode: number; responseBody: string; responseDurationMs: number; triggerType: 'scheduled' | 'manual'; url: string }
interface Logged { hook: string; raw: string; id: string; eventId: string | null; resourceId: string | null; eventType: string; status: 'pending' | 'sending' | 'success' | 'failed'; nextAttemptAt: string | null; createdAt: string; requestBody: unknown; attempts: Attempt[] }

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const refuse = (status: number, title: string, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  json({ title, message, docs: 'https://quo.com/docs', trace: randomBytes(6).toString('hex'), status, ...extra }, status, headers)
const hex = (n = 8) => randomBytes(n).toString('hex')

export async function startQuoSink(opts: QuoSinkOptions = {}) {
  const KEY = opts.key ?? 'quo_dev_key'
  const numbers = opts.numbers ?? { '+15550001111': 'PNour0001' }
  const [OUR_DEFAULT, OUR_PN] = Object.entries(numbers)[0]!
  const messages: Msg[] = []
  const calls: RestCall[] = []
  const conversations: Conversation[] = []
  const contacts: Contact[] = []
  const tasks: Task[] = []
  const USER_MADE = '2025-05-01T12:00:00.000Z'
  const makeUser = (id: string, over: Partial<User> = {}): User => ({ id, email: `${id.toLowerCase()}@example.com`, firstName: null, lastName: null, pictureUrl: null, role: 'member', groupId: 'GRusers', createdAt: USER_MADE, updatedAt: USER_MADE, ...over })
  const users = new Map<string, User>([
    ['USowner', makeUser('USowner', { email: 'owner@example.com', firstName: 'Olive', lastName: 'Owner', role: 'owner', pictureUrl: 'https://files.quo.test/olive.png' })],
    ['USdev',   makeUser('USdev', { email: 'dev@example.com', firstName: 'Dev', role: 'admin' })],
    ['USamy',   makeUser('USamy', { email: 'amy@example.com', firstName: 'Amy', lastName: 'Ames' })],
  ])
  const userView = (u: User) => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, pictureUrl: u.pictureUrl, role: u.role, createdAt: u.createdAt, updatedAt: u.updatedAt })
  const memberView = (u: User) => ({ id: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName, role: u.role, groupId: u.groupId })
  const org = { id: 'ORdev', name: 'Dev Workspace', subscriptionStatus: 'active', createdAt: '2025-04-01T12:00:00.000Z', updatedAt: '2025-04-01T12:00:00.000Z' }
  const NUMBER_MADE = '2025-06-01T12:00:00.000Z'
  const makeNumber = (id: string, phoneNumber: string, over: Partial<Num> = {}): Num => ({
    id, groupId: `GR${id.slice(2)}`, name: 'Main line', phoneNumber, formattedNumber: phoneNumber.startsWith('+1') ? `(${phoneNumber.slice(2, 5)}) ${phoneNumber.slice(5, 8)}-${phoneNumber.slice(8)}` : null,
    forward: null, portRequestId: null, portingStatus: null, symbol: null, createdAt: NUMBER_MADE, updatedAt: NUMBER_MADE,
    hours: { enabled: false, timezone: null, schedule: null }, autoRecord: false, callDisclosure: { inbound: 'disabled', outbound: 'disabled' }, members: ['USamy', 'USdev', 'USowner'], ...over,
  })
  const phoneNumbers: Num[] = Object.entries(numbers).map(([e164, id]) => makeNumber(id, e164))
  const RESTRICTIONS = { calling: { CA: 'unrestricted', Intl: 'restricted', US: 'unrestricted' }, messaging: { CA: 'unrestricted', Intl: 'restricted', US: 'unrestricted' } }
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
  const numberView = (n: Num, sections: string[]) => ({
    id: n.id, groupId: n.groupId, name: n.name, phoneNumber: n.phoneNumber, formattedNumber: n.formattedNumber, forward: n.forward,
    portRequestId: n.portRequestId, portingStatus: n.portingStatus, symbol: n.symbol, createdAt: n.createdAt, updatedAt: n.updatedAt,
    ...(sections.includes('restrictions') ? { restrictions: RESTRICTIONS } : {}),
    ...(sections.includes('businessHours') ? { businessHours: { enabled: n.hours.enabled, timezone: n.hours.timezone ?? 'America/Los_Angeles', schedule: n.hours.schedule } } : {}),
  })
  const settingsView = (n: Num) => ({ phoneNumberId: n.id, autoRecord: n.autoRecord, callDisclosure: { ...n.callDisclosure } })
  /** Numbers a workspace could take, with what the filters read. */
  const AVAILABLE = [
    { n: '+14155550301', country: 'US', region: 'CA', locality: 'San Francisco' }, { n: '+14155550302', country: 'US', region: 'CA', locality: 'San Francisco' },
    { n: '+14155557300', country: 'US', region: 'CA', locality: 'San Francisco' }, { n: '+12125550303', country: 'US', region: 'NY', locality: 'New York' },
    { n: '+18885550304', country: 'US', region: null, locality: null }, { n: '+18335550305', country: 'US', region: null, locality: null },
    { n: '+16045550306', country: 'CA', region: 'BC', locality: 'Vancouver' },
  ]
  /** By contact id, apart from the contact, because the REST contact carries none of them. */
  const props = new Map<string, Prop[]>()
  const addProp = (contactId: string, p: { type: string; name?: string | null; value: unknown }, at = new Date().toISOString()) => {
    const row: Prop = { id: hex(12), type: p.type, name: p.name ?? null, value: p.value, createdAt: at, updatedAt: at }
    props.set(contactId, [...(props.get(contactId) ?? []), row])
    return row
  }
  const valuesOf = (contactId: string, type: string) => (props.get(contactId) ?? []).filter(p => p.type === type).map(p => ({ value: p.value, type }))
  /** Quo's match of the other side's numbers to the contacts holding them. */
  const lookup = (theirs: string[]) => {
    const ids = contacts.filter(c => valuesOf(c.id, 'phone-number').some(p => theirs.includes(String(p.value)))).map(c => c.id)
    return { ids, lookupStatus: ids.length ? 'matched' : 'none' }
  }
  const hooks = new Map<string, Hook>()
  let hookSeq = 0
  const seen: { method: string; path: string; query: string; version: string | null; auth: string | null; body: string; status: number }[] = []
  const deliveries: Logged[] = []
  /** By call id, apart from the call, because the call list leaves them out unless asked. */
  const artifacts = new Map<string, Artifacts>()
  const files = new Map<string, { bytes: Uint8Array; type: string; sig: string }>()
  const fileHits: { name: string; auth: string | null; version: string | null; status: number }[] = []
  /** A signed URL on the sink's own storage, holding `n` bytes of noise. */
  const store = (type = 'audio/mpeg', n = 4096) => {
    const name = `${hex(8)}.mp3`, sig = hex(16)
    files.set(name, { bytes: new Uint8Array(randomBytes(n)), type, sig })
    return `http://127.0.0.1:${server.port}/_files/${name}?X-Amz-Signature=${sig}`
  }
  const fresh = () => ({ lost: false, expireFiles: false, failNext: false, rateLimit: null as null | { retryAfter: number }, deliverTwice: false, deliverFirst: false, failDelivery: null as null | FailDelivery, refuse: null as null | SinkRefusal, forbidAfter: null as null | number, openTasksFull: false, paymentFails: false, autofilling: false })
  const armed = fresh()
  const hanging: Array<() => void> = []

  let reg: Reg | null = null, payments = 0, autofillRun = 0, autofilling = false
  const A2P_TOP = ['name', 'alternateName', 'businessType', 'companyType', 'industry', 'employeeCount', 'avgDailyCallVolume', 'regionsOfOperation', 'websiteUrl', 'idType', 'idNumber', 'ticker', 'exchange']
  const A2P_NESTED: Record<string, string[]> = { address: ['line1', 'line2', 'city', 'region', 'postalCode', 'country'], personOfContact: ['firstName', 'lastName', 'jobTitle', 'jobPosition', 'email', 'phoneNumber'] }
  const a2pBad = (b: Record<string, unknown> | null, create: boolean) => {
    if (!b) return '/body'
    if (create) for (const k of [...A2P_TOP, 'messageTypes', 'address', 'personOfContact']) if (!(k in b)) return `/body/${k}`
    for (const [part, keys] of Object.entries(A2P_NESTED)) {
      const v = b[part] as Record<string, unknown> | undefined
      if (v === undefined) continue
      if (!v || typeof v !== 'object') return `/body/${part}`
      if (create) for (const k of keys) if (!(k in v)) return `/body/${part}/${k}`
    }
    if ('messageTypes' in b && !(Array.isArray(b.messageTypes) && b.messageTypes.length)) return '/body/messageTypes'
    const contact = b.personOfContact as Record<string, unknown> | undefined
    if (!('messageTypes' in b) && (['name', 'alternateName', 'businessType', 'websiteUrl'].some(k => k in b) || (contact && ('firstName' in contact || 'lastName' in contact)))) return '/body/messageTypes'
    return null
  }
  const einBad = (info: Record<string, unknown>) => info.idType === 'USA: Employer Identification Number (EIN)' && String(info.idNumber ?? '').replace(/\D/g, '').length !== 9
  const autofill = (types: string[]) => {
    const run = ++autofillRun
    autofilling = true
    setTimeout(() => {
      if (run !== autofillRun || !reg) return
      autofilling = false
      reg.messaging = { useCase: types.join(','), personalUse: false, consent: { websiteForm: { enabled: true, url: String(reg.businessInfo.websiteUrl) } } }
    }, AUTOFILL_MS)
  }
  const regView = () => ({ ...reg!, businessInfo: { ...reg!.businessInfo } })

  /** By conversation id, apart from the conversation, because Quo's conversation carries none of it. */
  const inbox = new Map<string, { unread: boolean; status: 'open' | 'done' }>()
  /** The conversation of our number and the other side, made the first time, moved by every activity in it. */
  const converse = (phoneNumberId: string | null, theirs: string[], activityId: string, at: string, incoming: boolean) => {
    const key = [...theirs].sort().join(',')
    let c = conversations.find(x => x.phoneNumberId === phoneNumberId && [...x.participants].sort().join(',') === key)
    if (!c) { c = { id: `CN${hex(4)}`, phoneNumberId, name: null, participants: [...theirs], lastActivityId: null, lastActivityAt: null, mutedUntil: null, snoozedUntil: null, createdAt: at, updatedAt: at, deletedAt: null }; conversations.push(c) }
    c.lastActivityId = activityId; c.lastActivityAt = at; c.updatedAt = at
    // Something arriving is unread and back in the inbox; what we send moves neither.
    if (incoming) inbox.set(c.id, { unread: true, status: 'open' })
    else if (!inbox.has(c.id)) inbox.set(c.id, { unread: false, status: 'open' })
    return c.id
  }
  /** One page, by `after`; the cursor is the last row's id, as Quo's decodes. */
  const page = <T,>(rows: T[], q: URLSearchParams, idOf: (r: T) => string = r => (r as { id: string }).id) => {
    const limit = Number(q.get('limit') ?? 10), after = q.get('after')
    if (!(Number.isInteger(limit) && limit >= 1 && limit <= 50)) return refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path: '/query/limit', message: 'must be 1-50', value: q.get('limit') }] })
    let from = 0
    if (after) {
      const lastId = (() => { try { return JSON.parse(Buffer.from(after, 'base64url').toString()).lastId as string } catch { return null } })()
      const i = lastId ? rows.findIndex(r => idOf(r) === lastId) : -1
      if (i < 0) return refuse(400, 'Bad Request', 'Invalid cursor.', { errors: [{ path: '/query/after', message: 'is invalid', value: after }] })
      from = i + 1
    }
    const slice = rows.slice(from, from + limit)
    return json({ data: slice, nextCursor: from + limit < rows.length ? Buffer.from(JSON.stringify({ lastId: idOf(slice.at(-1)!) })).toString('base64url') : null })
  }
  /** Newest first, ties in the order made, reversed. */
  const newest = <T extends { createdAt: string }>(rows: T[]) => rows.map((r, i) => [r, i] as const).sort(([a, i], [b, j]) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || j - i).map(([r]) => r)
  /** `field[op]` bounds, only the ops named; another op on a known field is the spec's 400. */
  const bounded = (q: URLSearchParams, fields: string[], ops: string[]) => {
    const tests: ((r: Record<string, unknown>) => boolean)[] = []
    for (const [k, v] of q) {
      const m = k.match(/^(\w+)\[(\w+)\]$/)
      if (!m || !fields.includes(m[1]!)) continue
      if (!ops.includes(m[2]!)) return { bad: k }
      const at = Date.parse(v), f = m[1]!, op = m[2]!
      tests.push(r => { const x = Date.parse(String(r[f])); return op === 'gt' ? x > at : op === 'gte' ? x >= at : op === 'lt' ? x < at : x <= at })
    }
    return { keep: (r: object) => tests.every(t => t(r as Record<string, unknown>)) }
  }

  const standard = (type: string, m: Msg) => ({
    id: `EV${hex()}`, apiVersion: VERSION, createdAt: new Date().toISOString(), type,
    data: {
      resource: { id: m.id, direction: m.direction, text: m.text, media: m.media, status: m.status, createdAt: m.createdAt,
        ...(type === 'message.failed' || type === 'message.undelivered' ? { errorCode: m.errorCode ?? null } : {}) },
      context: { orgId: 'ORdev', phoneNumberId: m.phoneNumberId, conversationId: m.conversationId, userId: m.userId,
        contacts: lookup(m.direction === 'incoming' ? [m.from] : m.to), senderIdentifier: m.from, recipientIdentifiers: m.to },
      links: { quo: null },
    },
  })
  const legacyEnvelope = (type: string, m: Msg) => ({
    id: `EV${hex(16)}`, object: 'event', apiVersion: 'v2', createdAt: new Date().toISOString(), type,
    data: { object: { id: m.id, object: 'message', from: m.from, to: m.to.length === 1 ? m.to[0] : m.to, direction: m.direction,
      body: m.text, media: [], status: m.status, createdAt: m.createdAt, userId: m.userId, phoneNumberId: m.phoneNumberId, conversationId: m.conversationId } },
  })

  const post = async (url: string, headers: Record<string, string>, body: string) => {
    const start = Date.now()
    const [status, text] = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
      .then(async r => [r.status, await r.text()] as const, () => [0, ''] as const)
    return { status, text, ms: Date.now() - start }
  }

  /**
   * Every enabled subscription that asked for this event about this number,
   * signed with its own key; the legacy one, when there is one and the event
   * has a legacy body.
   */
  async function deliver(type: string, phoneNumberId: string | null, dated: { id: string; data: { resource: { id?: string; callId?: string } } }, legacy: object | null) {
    const times = armed.deliverTwice ? 2 : 1; armed.deliverTwice = false
    for (const h of hooks.values()) {
      if (h.status !== 'enabled' || !h.events.includes(type)) continue
      // Contact events are workspace-wide: a hook's numbers do not filter them.
      if (!type.startsWith('contact.') && !h.resourceIds.includes('*') && !(phoneNumberId && h.resourceIds.includes(phoneNumberId))) continue
      const d: Logged = { hook: h.id, raw: JSON.stringify(dated), id: `msg_${hex(12)}`, eventId: dated.id, resourceId: dated.data.resource.callId ?? dated.data.resource.id ?? null,
        eventType: type, status: 'pending', nextAttemptAt: null, createdAt: new Date().toISOString(), requestBody: dated, attempts: [] }
      deliveries.push(d)
      for (let i = 0; i < times; i++) await attempt(h, d, 'scheduled')
    }
    if (opts.legacy && legacy) {
      const body = JSON.stringify(legacy)
      for (let i = 0; i < times; i++) await post(opts.legacy.url(), { 'openphone-signature': signQuoLegacy(opts.legacy.key, Date.now(), body) }, body)
    }
  }
  /**
   * One attempt, signed with the key the hook holds NOW and a fresh
   * timestamp, the same `webhook-id` and bytes every time.
   */
  async function attempt(h: Hook, d: Logged, triggerType: Attempt['triggerType']) {
    const ts = Math.floor(Date.now() / 1000), at = new Date().toISOString()
    const r = await post(h.url, { 'webhook-id': d.id, 'webhook-timestamp': String(ts), 'webhook-signature': signQuo(h.key, d.id, ts, d.raw) }, d.raw)
    const ok = r.status >= 200 && r.status < 300
    d.attempts.unshift({ id: `att_${hex(8)}`, timestamp: at, status: ok ? 'success' : 'failed', responseStatusCode: r.status, responseBody: r.text, responseDurationMs: r.ms, triggerType, url: h.url })
    if (ok) { d.status = 'success'; d.nextAttemptAt = null }
    // Standard Webhooks' first retry is 5s out; the sink never makes it. A
    // manual attempt that fails leaves the schedule as it was.
    else if (triggerType === 'scheduled' && d.status !== 'success') { d.status = 'sending'; d.nextAttemptAt = new Date(Date.now() + 5_000).toISOString() }
  }
  // Manual attempts run one at a time, in the order they were asked for.
  let manual = Promise.resolve()

  /**
   * Quo's canonical sample, from the spec's own example: every id a sample,
   * and the envelope id ONE fixed value across every test dispatch. Message
   * and call types get their context; the rest a bare resource.
   */
  const sample = (type: string) => {
    const at = new Date().toISOString(), base = { orgId: 'ORsampleorg000000000000', phoneNumberId: 'PNsamplephonenumber000000000000', conversationId: 'CNsampleconversation000000000000', userId: 'USsampleus', contacts: { ids: ['CTsampleContact01234'], lookupStatus: 'matched' } }
    const id = 'ACsampleactivity0000000000000000', when = '2026-03-30T18:00:00.000Z'
    const data = type.startsWith('message.')
      ? { resource: { id, direction: 'incoming', text: 'Sample message', media: [], status: type.slice('message.'.length), createdAt: when },
          context: { ...base, senderIdentifier: '+15555551234', recipientIdentifiers: ['+15555555678'] } }
      : type.startsWith('call.') && !/(recording|transcript|summary|voicemail)\./.test(type)
      ? { resource: { id, direction: 'incoming', status: 'answered', answeredAt: when, completedAt: when, createdAt: when, updatedAt: when, duration: 42, hasVoicemail: false },
          context: { ...base, phoneNumberType: 'shared', participants: { workspace: ['+15555555678'], external: ['+15555551234'], resolution: 'available' } } }
      : { resource: { id: 'sample' }, context: { orgId: base.orgId } }
    return { id: TEST_EVENT_ID, apiVersion: VERSION, type, createdAt: at, data: { ...data, links: { quo: null } } }
  }
  /** To the hook's URL whatever it subscribes to; logged with no event or resource id, as Quo's log reads a test. */
  async function dispatchTest(h: Hook, ev: ReturnType<typeof sample>) {
    const d: Logged = { hook: h.id, raw: JSON.stringify(ev), id: `msg_${hex(12)}`, eventId: null, resourceId: null,
      eventType: ev.type, status: 'pending', nextAttemptAt: null, createdAt: new Date().toISOString(), requestBody: ev, attempts: [] }
    deliveries.push(d)
    await attempt(h, d, 'scheduled')
  }

  // The fields both contact writes take; anything else in the body is ignored, as the spec forbids none.
  const CONTACT_WRITABLE = ['firstName', 'lastName', 'company', 'role', 'externalId', 'source', 'sourceUrl'] as const
  const contactFieldBad = (b: Record<string, unknown>) => {
    const f = CONTACT_WRITABLE.find(k => k in b && b[k] !== null && typeof b[k] !== 'string')
    if (f) return `/body/${f}`
    const u = b.sourceUrl
    return typeof u === 'string' && !(u.length >= 1 && u.length <= 200 && URL.canParse(u)) ? '/body/sourceUrl' : null
  }
  const assignContact = (c: Contact, b: Record<string, unknown>) => { for (const k of CONTACT_WRITABLE) if (k in b) (c as unknown as Record<string, unknown>)[k] = b[k] }
  /** Another contact with this one's source and external id. */
  const sameSource = (c: Contact) => c.externalId !== null && contacts.some(x => x.id !== c.id && x.externalId === c.externalId && x.source === c.source)
  const conflict = () => refuse(409, 'Conflict', 'Failed to create contact because a contact with the same source and external ID already exists')

  /**
   * A contact as the webhook carries it: no `actorId` and no `sourceUrl`, and
   * its numbers and emails inline. The sink keeps no custom field in the
   * event's shape, so those are empty. No legacy body.
   */
  const deliverContact = (type: string, c: Contact) => {
    const ev = {
      id: `EV${hex()}`, apiVersion: VERSION, createdAt: new Date().toISOString(), type,
      data: {
        resource: { id: c.id, firstName: c.firstName, lastName: c.lastName, company: c.company, role: c.role, location: null, source: c.source, externalId: c.externalId,
          emails: valuesOf(c.id, 'email'), phoneNumbers: valuesOf(c.id, 'phone-number'), customFields: [], createdAt: c.createdAt, updatedAt: c.updatedAt },
        context: { orgId: 'ORdev', userId: c.actorId, sharedWithIds: [] }, links: { quo: null },
      },
    }
    return deliver(type, null, ev, null)
  }
  const deliverMessage = (type: string, m: Msg) => deliver(type, m.phoneNumberId, standard(type, m), legacyEnvelope(type, m))
  /** Where a queued text ends: delivered, or the failure the drive armed. */
  async function settleMessage(m: Msg, fails: FailDelivery | null) {
    m.status = !fails ? 'delivered' : fails === 'undelivered' ? 'undelivered' : 'failed'
    m.errorCode = fails === 'permanent' || fails === 'undelivered' ? '30007' : null
    m.updatedAt = new Date().toISOString()
    await deliverMessage(`message.${m.status}`, m)
  }

  /**
   * A call's events in the order Quo sends them. A dated call context names
   * `participants`, ours and theirs, never a sender; `ringing` carries no
   * `contacts` or `phoneNumberType`, and `missed` no direction. Legacy sends
   * only `ringing` and `completed`, as one `call` object.
   */
  async function placeCall(c: Call, made: { segments: number; voicemail: boolean }) {
    const ctx = (narrow: boolean) => ({
      orgId: 'ORdev', phoneNumberId: c.phoneNumberId, conversationId: c.conversationId, userId: 'USdev',
      ...(narrow ? {} : { phoneNumberType: 'shared', contacts: c.unresolved ? { ids: [], lookupStatus: 'unavailable' } : lookup([c.theirs]) }),
      participants: c.unresolved
        ? { workspace: [], external: [], resolution: 'unavailable' }
        : { workspace: [c.ours], external: [c.theirs], resolution: 'available' },
    })
    const dated = (type: string, resource: object) => ({
      id: `EV${hex()}`, apiVersion: VERSION, createdAt: new Date().toISOString(), type,
      data: { resource: { id: c.id, ...resource }, context: ctx(type === 'call.ringing'), links: { quo: null } },
    })
    const legacy = (type: string, status: string, extra: { media?: object[]; voicemail?: object | null } = {}) => ({
      id: `EV${hex(16)}`, object: 'event', apiVersion: 'v2', createdAt: new Date().toISOString(), type,
      data: { object: { id: c.id, object: 'call', direction: c.direction,
        from: c.direction === 'incoming' ? c.theirs : c.ours, to: c.direction === 'incoming' ? c.ours : c.theirs,
        media: extra.media ?? [], voicemail: extra.voicemail ?? null, status, createdAt: c.createdAt, answeredAt: status === 'completed' ? c.answeredAt : null, completedAt: status === 'completed' ? c.completedAt : null,
        userId: 'USdev', phoneNumberId: c.phoneNumberId, conversationId: c.conversationId } },
    })
    // Summary and transcript are their own legacy objects, on the v3 envelope.
    const legacyOf = (type: string, object: object) => ({ id: `EV${hex(16)}`, object: 'event', apiVersion: 'v3', createdAt: new Date().toISOString(), type, data: { object } })
    const art: Artifacts = { recordings: [], transcripts: [], summary: null, voicemail: null }
    artifacts.set(c.id, art)
    const vmDuration = 18
    if (made.voicemail) art.voicemail = { id: `VM${hex()}`, status: 'completed', duration: vmDuration, recordingUrl: store(), transcript: 'Hi, call me back about the proposal.' }
    const at = { createdAt: c.createdAt, updatedAt: c.completedAt }
    await deliver('call.ringing', c.phoneNumberId, dated('call.ringing', { direction: c.direction, createdAt: c.createdAt, updatedAt: c.createdAt }), legacy('call.ringing', 'ringing'))
    if (c.answeredAt) await deliver('call.answered', c.phoneNumberId, dated('call.answered', { direction: c.direction, answeredAt: c.answeredAt, answeredByUserId: 'USdev', ...at }), null)
    else if (c.direction === 'incoming') await deliver('call.missed', c.phoneNumberId, dated('call.missed', at), null)
    const vm = art.voicemail
    await deliver('call.completed', c.phoneNumberId, dated('call.completed', {
      direction: c.direction, status: c.answeredAt ? 'answered' : 'unanswered', answeredAt: c.answeredAt, completedAt: c.completedAt,
      duration: c.answeredAt ? 55 : null, hasVoicemail: !!vm, ...at,
    }), legacy('call.completed', 'completed', { voicemail: vm && { url: vm.recordingUrl, type: 'audio/mpeg', duration: vm.duration } }))

    if (c.answeredAt && made.segments > 0) {
      // A call paused and resumed: one recording per piece, one transcript per recording.
      const each = Math.floor(55 / made.segments)
      for (let i = 0; i < made.segments; i++) {
        const startTime = new Date(Date.parse(c.answeredAt) + i * each * 1000).toISOString()
        const rec: Rec = { id: `CR${hex(5)}`, status: 'completed', startTime, duration: each, url: store(), type: 'audio/mpeg' }
        art.recordings.push(rec)
        art.transcripts.push({ recordingId: rec.id, status: 'completed', startTime, createdAt: c.completedAt, duration: each, dialogue: [
          { content: `part ${i + 1}, ours`, start: 0, end: 3, identifier: c.ours, actorId: 'USdev' },
          { content: `part ${i + 1}, theirs`, start: 3, end: 7, identifier: c.theirs, actorId: null },
        ] })
      }
      art.summary = { status: 'completed', type: 'human', summary: ['They asked about pricing.'], nextSteps: ['Send the price sheet.'], jobs: null, title: null }
      const artifact = (type: string, resource: { callId: string } & Record<string, unknown>) => ({
        id: `EV${hex()}`, apiVersion: VERSION, createdAt: new Date().toISOString(), type,
        data: { resource, context: ctx(false), links: { quo: null } },
      })
      await deliver('call.recording.completed', c.phoneNumberId, dated('call.recording.completed', {
        direction: c.direction, answeredAt: c.answeredAt, completedAt: c.completedAt, duration: 55, ...at,
        recordings: art.recordings.map(({ status: _s, ...r }) => r),
      }), legacy('call.recording.completed', 'completed', { media: art.recordings.map(r => ({ url: r.url, type: r.type, duration: r.duration })) }))
      // The event's dialogue is the whole call, in the event's own names: `userId`, not `actorId`.
      const dialogue = art.transcripts.flatMap(t => t.dialogue.map(({ actorId, ...l }) => ({ userId: actorId, ...l })))
      await deliver('call.transcript.completed', c.phoneNumberId, artifact('call.transcript.completed', { callId: c.id, createdAt: c.completedAt, duration: 55, processingStatus: 'completed', dialogue }),
        legacyOf('call.transcript.completed', { object: 'callTranscript', callId: c.id, createdAt: c.completedAt, dialogue, duration: 55, status: 'completed' }))
      const sm = art.summary as { summary: string[]; nextSteps: string[] }
      await deliver('call.summary.completed', c.phoneNumberId, artifact('call.summary.completed', { callId: c.id, processingStatus: 'completed', summary: sm.summary, nextSteps: sm.nextSteps,
        fromPhoneNumber: null, handledByAiAgent: false, answeredByUserId: 'USdev', jobs: [] }),
        legacyOf('call.summary.completed', { object: 'callSummary', callId: c.id, status: 'completed', summary: sm.summary, nextSteps: sm.nextSteps }))
    }
    if (vm) {
      // Its own `id` is an activity of its own; `callId` is the call, and the delivery log's resource.
      const now = new Date().toISOString()
      const ev = {
        id: `EV${hex()}`, apiVersion: VERSION, createdAt: now, type: 'call.voicemail.completed',
        data: { resource: { id: `AC${hex()}`, voicemailId: vm.id, callId: c.id, direction: c.direction, duration: vm.duration, from: c.theirs, to: c.ours,
          transcript: vm.transcript, recordingUrl: vm.recordingUrl, createdAt: c.completedAt, updatedAt: now }, context: ctx(false), links: { quo: null } },
      }
      await deliver('call.voicemail.completed', c.phoneNumberId, ev, null)
    }
  }

  /**
   * A task event: the task's id and what changed, and a context naming the
   * actor and the task's links, or on `task.unlinked` the ones it left.
   */
  const deliverTask = (type: string, t: Task, resource: Record<string, unknown> = {}, links: Pick<Task, 'phoneNumberId' | 'conversationId' | 'activityId' | 'phoneNumberGroupId'> = t, actorId = TASK_ACTOR) => {
    const ev = {
      id: `EV${hex()}`, apiVersion: VERSION, createdAt: new Date().toISOString(), type,
      data: { resource: { id: t.taskId, ...resource }, context: { orgId: 'ORdev', actorId, phoneNumberId: links.phoneNumberId, conversationId: links.conversationId, activityId: links.activityId, phoneNumberGroupId: links.phoneNumberGroupId }, links: { quo: null } },
    }
    return deliver(type, links.phoneNumberId, ev, null)
  }
  /** A read leaves a null optional field out, which the spec allows, so a reader that did not fill them sees it. */
  const taskView = (t: Task) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== null))
  const taskAnswer = (t: Task, status = 200) => json({ data: { taskId: t.taskId, revision: t.revision } }, status)
  const tasksFull = () => refuse(402, 'Open Tasks Limit Reached', 'Open tasks limit reached')
  const bodyOf = (text: string) => { try { const b = JSON.parse(text); return b && typeof b === 'object' ? b as Record<string, unknown> : null } catch { return null } }
  const invalid = (path: string) => refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path, message: 'is invalid', schema: {} }] })
  const isTime = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v))

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, deliveries, messages, contacts, tasks, hooks: [...hooks.values()], inbox: Object.fromEntries(inbox), a2p: { registration: reg, payments },
        files: Object.fromEntries([...files].map(([n, f]) => [n, Buffer.from(f.bytes).toString('base64')])), fileHits })
      // Storage, not the API: the signature in the URL is the credential.
      if (path.startsWith('/_files/') && req.method === 'GET') {
        const name = path.slice('/_files/'.length), f = files.get(name)
        const hit = { name, auth: req.headers.get('authorization'), version: req.headers.get('quo-api-version'), status: 0 }
        fileHits.push(hit)
        const xml = (status: number, code: string) => { hit.status = status; return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code></Error>`, { status, headers: { 'content-type': 'application/xml' } }) }
        if (hit.auth) return xml(400, 'InvalidArgument')
        if (!f || url.searchParams.get('X-Amz-Signature') !== f.sig) return xml(403, 'SignatureDoesNotMatch')
        if (armed.expireFiles) { armed.expireFiles = false; return xml(403, 'AccessDenied') }
        hit.status = 200
        return new Response(f.bytes as unknown as BodyInit, { headers: { 'content-type': f.type } })
      }
      if (path === '/_sink/reset') { seen.length = 0; fileHits.length = 0; Object.assign(armed, fresh()); return json({ ok: true }) }
      // Quo's overdue check running: each open task past its due date, the owner as its actor.
      if (path === '/_sink/overdue') {
        for (const t of tasks) if (t.status === 'open' && t.dueDate && Date.parse(t.dueDate) < Date.now()) await deliverTask('task.overdue', t, { dueDate: t.dueDate }, t, t.assignedTo ?? t.createdBy)
        return json({ ok: true })
      }
      if (path === '/_sink/exhaust') { for (const d of deliveries) if (d.status === 'sending') { d.status = 'failed'; d.nextAttemptAt = null } return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      // The carrier's verdict on a submitted registration.
      if (path === '/_sink/a2p' && req.method === 'POST') {
        const verdict = await req.json()
        // `null` takes the registration away, so a drive can create another.
        if (verdict === null) reg = null
        else Object.assign(reg!, verdict, { updatedAt: new Date().toISOString() })
        return json({ ok: true })
      }
      // The drive asks the sink to text our number, as a person would.
      if (path === '/_sink/inbound' && req.method === 'POST') {
        const { from, to, text } = await req.json() as { from: string; to: string; text: string }
        const now = new Date().toISOString()
        const id = `AC${hex()}`
        const m: Msg = { id, to: [to], from, text, phoneNumberId: numbers[to] ?? null, conversationId: converse(numbers[to] ?? null, [from], id, now, true), direction: 'incoming', userId: null, status: 'received', createdAt: now, updatedAt: now, media: [] }
        messages.push(m)
        await deliverMessage('message.received', m)
        return json({ ok: true, id: m.id })
      }

      // A call to or from our number, as a person and Quo's switch would make it.
      if (path === '/_sink/call' && req.method === 'POST') {
        const b = await req.json() as { ours: string; theirs: string; direction: 'incoming' | 'outgoing'; answered: boolean; unresolved?: boolean; segments?: number; voicemail?: boolean }
        const start = Date.now(), iso = (ms: number) => new Date(start + ms).toISOString()
        const c: Call = { id: `AC${hex()}`, direction: b.direction, ours: b.ours, theirs: b.theirs, phoneNumberId: numbers[b.ours] ?? null,
          conversationId: '', createdAt: iso(0), answeredAt: b.answered ? iso(5_000) : null, completedAt: iso(60_000), unresolved: !!b.unresolved }
        c.conversationId = converse(c.phoneNumberId, [c.theirs], c.id, c.completedAt, b.direction === 'incoming')
        calls.push({ id: c.id, phoneNumberId: c.phoneNumberId, actorId: 'USdev', direction: c.direction,
          status: c.answeredAt ? 'completed' : c.direction === 'incoming' ? 'missed' : 'no-answer',
          participants: [{ phoneNumber: c.ours, actorId: 'USdev' }, { phoneNumber: c.theirs, actorId: null }],
          answeredAt: c.answeredAt, answeredBy: c.answeredAt ? 'USdev' : null, initiatedBy: c.direction === 'outgoing' ? 'USdev' : null,
          completedAt: c.completedAt, createdAt: c.createdAt, updatedAt: c.completedAt, callRoute: null, duration: c.answeredAt ? 55 : 0,
          forwardedFrom: null, forwardedTo: null, aiHandled: null })
        await placeCall(c, { segments: b.segments ?? 0, voicemail: !!b.voicemail && !b.answered })
        return json({ ok: true, id: c.id })
      }

      // Rows made before the drive began: each given field kept, the rest filled.
      if (path === '/_sink/seed' && req.method === 'POST') {
        const b = await req.json() as { messages?: Partial<Msg>[]; calls?: Partial<RestCall>[]; conversations?: Partial<Conversation>[]; contacts?: (Partial<Contact> & { properties?: { type: string; name?: string; value: unknown }[] })[]; phoneNumbers?: { id: string; phoneNumber: string; name?: string; members?: number; memberIds?: string[] }[]; organization?: Partial<typeof org>; users?: (Partial<User> & { id: string })[] }
        const at = (x?: string | null) => new Date(x ?? Date.now()).toISOString()
        for (const c of b.conversations ?? []) conversations.push({ id: `CN${hex(4)}`, phoneNumberId: OUR_PN, name: null, participants: [], lastActivityId: null, lastActivityAt: null, mutedUntil: null, snoozedUntil: null, deletedAt: null, ...c, createdAt: at(c.createdAt), updatedAt: at(c.updatedAt ?? c.createdAt) })
        for (const m of b.messages ?? []) messages.push({ id: `AC${hex()}`, to: [OUR_DEFAULT], from: '+14155550100', text: 'seeded', phoneNumberId: OUR_PN, conversationId: `CN${hex(4)}`, direction: 'incoming', userId: null, status: 'received', media: [], ...m, createdAt: at(m.createdAt), updatedAt: at(m.updatedAt ?? m.createdAt) })
        for (const c of b.calls ?? []) calls.push({ id: `AC${hex()}`, phoneNumberId: OUR_PN, actorId: 'USdev', direction: 'incoming', status: 'completed', participants: [{ phoneNumber: OUR_DEFAULT, actorId: 'USdev' }, { phoneNumber: '+14155550100', actorId: null }], answeredAt: null, answeredBy: null, initiatedBy: null, completedAt: null, callRoute: null, duration: 0, forwardedFrom: null, forwardedTo: null, aiHandled: null, ...c, createdAt: at(c.createdAt), updatedAt: c.updatedAt ?? null })
        for (const p of b.phoneNumbers ?? []) {
          const members = p.memberIds ?? Array.from({ length: p.members ?? 0 }, (_, i) => `USm${String(i).padStart(3, '0')}${p.id}`)
          for (const id of members) users.set(id, makeUser(id))
          phoneNumbers.push(makeNumber(p.id, p.phoneNumber, { ...(p.name ? { name: p.name } : {}), members }))
        }
        Object.assign(org, b.organization ?? {})
        for (const u of b.users ?? []) users.set(u.id, makeUser(u.id, u))
        for (const { properties, ...c } of b.contacts ?? []) {
          const made: Contact = { id: hex(12), externalId: null, source: 'public-api', sourceUrl: null, firstName: null, lastName: null, company: null, role: null, actorId: 'USdev', ...c, createdAt: at(c.createdAt), updatedAt: at(c.updatedAt ?? c.createdAt) }
          contacts.push(made)
          for (const p of properties ?? []) addProp(made.id, p, made.createdAt)
        }
        return json({ ok: true })
      }

      const text = req.method === 'GET' ? '' : await req.text()
      const entry = { method: req.method, path, query: url.search, version: req.headers.get('quo-api-version'), auth: req.headers.get('authorization'), body: text, status: 0 }
      seen.push(entry)
      const record = (r: Response) => { entry.status = r.status; return r }

      if (req.headers.get('authorization') !== KEY) return record(refuse(401, 'Unauthorized', 'The API key is missing or invalid.', { code: '0200401' }))
      const v1 = path.startsWith('/v1/')
      if (!v1 && entry.version !== VERSION) return record(refuse(400, 'Bad Request', 'The Quo-Api-Version header is required. Supported values: 2026-03-30.', { errors: [{ path: '/header/quo-api-version', message: 'is required', value: entry.version }] }))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(refuse(429, 'Too Many Requests', 'Rate limit exceeded.', {}, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext)  { armed.failNext = false; return record(refuse(500, 'Unknown', 'Something went wrong.', { code: '0201500' })) }
      if (armed.forbidAfter !== null && req.method === 'GET' && /^\/(messages|calls|conversations|contacts|tasks|phone-numbers|contacts\/[^/]+\/properties|calls\/[^/]+\/(recordings|transcripts)|phone-numbers\/[^/]+\/users|users|users\/[^/]+\/phone-numbers)$/.test(path) && armed.forbidAfter-- === 0) {
        armed.forbidAfter = null
        return record(refuse(403, 'Forbidden', 'You do not have access to this resource.'))
      }

      let answer: Response
      if (v1 && path === '/v1/messages' && req.method === 'POST') {
        const b = JSON.parse(text) as { content?: string; from?: string; to?: string[]; userId?: string; setInboxStatus?: string }
        const bad: { path: string; message: string; value: unknown }[] = []
        if (!b.content || !/\S/.test(b.content) || b.content.length > 1600) bad.push({ path: '/body/content', message: 'must be 1-1600 characters and not blank', value: b.content })
        if (!b.from || !(/^PN/.test(b.from) || /^\+[1-9]\d{1,14}$/.test(b.from))) bad.push({ path: '/body/from', message: 'must be a PN id or E.164', value: b.from })
        if (!Array.isArray(b.to) || !b.to.length || b.to.length > 10 || b.to.some(t => !/^\+[1-9]\d{1,14}$/.test(t))) bad.push({ path: '/body/to', message: 'must be 1-10 E.164 numbers', value: b.to })
        const fromNumber = b.from && b.from.startsWith('PN') ? Object.keys(numbers).find(n => numbers[n] === b.from) : b.from
        if (bad.length) answer = refuse(400, 'Bad Request', `Validation failed for ${bad.length} field${bad.length > 1 ? 's' : ''}.`, { code: '0200400', errors: bad.map(e => ({ ...e, schema: { type: 'string' } })) })
        else if (armed.refuse) { const r = SINK_REFUSALS[armed.refuse]; armed.refuse = null; answer = refuse(r.status, r.title, r.message, { code: r.code }) }
        else if (!fromNumber || !numbers[fromNumber]) answer = refuse(403, 'Not Phone Number User', 'The sender is not a number in this workspace.', { code: '0202403' })
        else if (b.to!.some(t => t.startsWith('+44'))) answer = refuse(403, 'International Messaging Not Allowed', 'International messaging is not enabled for this workspace.', { code: '0203403' })
        else {
          const now = new Date().toISOString()
          const id = `AC${hex()}`
          const m: Msg = { id, to: b.to!, from: fromNumber, text: b.content!, phoneNumberId: numbers[fromNumber], conversationId: converse(numbers[fromNumber]!, b.to!, id, now, false), direction: 'outgoing', userId: b.userId ?? 'USdev', status: 'queued', createdAt: now, updatedAt: now, media: [] }
          messages.push(m)
          if (b.setInboxStatus === 'done') inbox.get(m.conversationId)!.status = 'done'
          // The answer is the snapshot at send time even when the receipt went first.
          const snapshot = JSON.stringify({ data: m })
          const fails = armed.failDelivery; armed.failDelivery = null
          const finish = () => settleMessage(m, fails)
          if (armed.deliverFirst) { armed.deliverFirst = false; await finish() } else setTimeout(finish, 20)
          answer = new Response(snapshot, { status: 202, headers: { 'content-type': 'application/json' } })
        }
      } else if (!v1 && path === '/messages' && req.method === 'GET') {
        // Parsed off the raw search string, so an encoder that drifts is a miss rather than an agreement.
        // A bound the spec does not name is ignored here, as it reads nothing out.
        const q = url.searchParams, toAll = q.get('to[all]'), toOne = q.get('to')
        const want = toAll ? toAll.split(',').sort().join(',') : toOne
        const gt = q.get('createdAt[gt]'), lt = q.get('createdAt[lt]')
        answer = page(newest(messages.filter(m =>
          (!q.get('from') || m.from === q.get('from')) &&
          (!q.get('phoneNumberId') || m.phoneNumberId === q.get('phoneNumberId')) &&
          (!q.get('direction') || m.direction === q.get('direction')) &&
          (!want || [...m.to].sort().join(',') === want) &&
          (!gt || Date.parse(m.createdAt) > Date.parse(gt)) && (!lt || Date.parse(m.createdAt) < Date.parse(lt)))), q)
      } else if (!v1 && path === '/calls' && req.method === 'GET') {
        const q = url.searchParams, b = bounded(q, ['createdAt'], ['gte', 'lte'])
        answer = b.bad ? refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path: `/query/${b.bad}`, message: 'is not allowed', value: q.get(b.bad) }] })
          : page(newest(calls.filter(b.keep!)).map(c => callView(c, q)), q)
      } else if (!v1 && /^\/calls\/[^/]+(\/(recordings|transcripts))?$/.test(path) && req.method === 'GET') {
        const [, , id, part] = path.split('/'), c = calls.find(x => x.id === decodeURIComponent(id!)), art = c && artifacts.get(c.id)
        if (!c) answer = refuse(404, 'Not Found', 'Call not found.')
        else if (part === 'recordings') answer = page(art?.recordings ?? [], url.searchParams)
        else if (part === 'transcripts') answer = page(art?.transcripts ?? [], url.searchParams, t => t.recordingId)
        else answer = json({ data: callView(c, url.searchParams) })
      } else if (!v1 && path === '/conversations' && req.method === 'GET') {
        const q = url.searchParams, b = bounded(q, ['createdAt', 'updatedAt'], ['gte', 'lte'])
        const [field, dir] = (q.get('sort') ?? 'createdAt:desc').split(':')
        if (b.bad) answer = refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path: `/query/${b.bad}`, message: 'is not allowed', value: q.get(b.bad) }] })
        else if (!['createdAt', 'updatedAt'].includes(field!) || !['asc', 'desc'].includes(dir!)) answer = refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path: '/query/sort', message: 'must be createdAt or updatedAt, asc or desc', value: q.get('sort') }] })
        else {
          const k = field as 'createdAt' | 'updatedAt'
          const rows = conversations.filter(b.keep!).map((c, i) => [c, i] as const).sort(([a, i], [c, j]) => (Date.parse(a[k]) - Date.parse(c[k]) || i - j) * (dir === 'asc' ? 1 : -1)).map(([c]) => c)
          answer = page(rows, q)
        }
      } else if (!v1 && path === '/contacts' && req.method === 'GET') {
        answer = page(newest(contacts), url.searchParams)
      } else if (!v1 && path === '/contacts' && req.method === 'POST') {
        const b = (() => { try { return JSON.parse(text) as Record<string, unknown> } catch { return null } })()
        const bad = !b || typeof b.firstName !== 'string' ? '/body/firstName'
          : b.actorId != null && !/^US/.test(String(b.actorId)) ? '/body/actorId'
          : contactFieldBad(b)
        if (bad) answer = refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path: bad, message: 'is invalid', schema: {} }] })
        else {
          const now = new Date().toISOString()
          const c: Contact = { id: hex(12), externalId: null, source: 'public-api', sourceUrl: null, firstName: null, lastName: null, company: null, role: null, actorId: 'USowner', createdAt: now, updatedAt: now }
          assignContact(c, b!)
          if (b!.actorId != null) c.actorId = String(b!.actorId)
          if (sameSource(c)) answer = conflict()
          else { contacts.push(c); await deliverContact('contact.updated', c); answer = json({ data: c }, 201) }
        }
      } else if (!v1 && /^\/contacts\/[^/]+\/properties$/.test(path) && (req.method === 'GET' || req.method === 'POST')) {
        const c = contacts.find(x => x.id === decodeURIComponent(path.split('/')[2]!))
        const b = req.method === 'POST' ? (() => { try { return JSON.parse(text) as Record<string, unknown> } catch { return null } })() : null
        const type = url.searchParams.get('type')
        if (!c) answer = refuse(404, 'Not Found', 'Contact not found.')
        else if (req.method === 'GET') answer = page((props.get(c.id) ?? []).filter(p => !type || p.type === type), url.searchParams)
        else if (!b || typeof b.type !== 'string' || !('value' in b)) answer = refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path: !b || typeof b.type !== 'string' ? '/body/type' : '/body/value', message: 'is required', schema: {} }] })
        else {
          const made = addProp(c.id, { type: b.type, name: b.name as string | null | undefined, value: b.value })
          c.updatedAt = made.createdAt
          await deliverContact('contact.updated', c)
          answer = json({ data: made })
        }
      } else if (!v1 && path === '/webhooks' && req.method === 'POST') {
        const b = JSON.parse(text) as { url: string; events: string[]; resourceIds?: string[]; label?: string; status?: string }
        const now = new Date().toISOString()
        const h: Hook = { id: String(++hookSeq), url: b.url, events: b.events, resourceIds: b.resourceIds ?? ['*'], label: b.label ?? null, status: b.status ?? 'enabled', key: `whsec_${randomBytes(24).toString('base64')}`, createdAt: now, updatedAt: now }
        hooks.set(h.id, h)
        answer = json({ data: { ...view(h), key: h.key } }, 201)
      } else if (!v1 && path === '/webhooks' && req.method === 'GET') {
        answer = json({ data: [...hooks.values()].map(view) })
      } else if (!v1 && path.match(/^\/webhooks\/[^/]+\/events$/) && req.method === 'GET') {
        const hookId = path.split('/')[2]!, q = url.searchParams
        const limit = Number(q.get('limit') ?? 10)
        const types = q.get('eventType[in]')?.split(',') ?? (q.get('eventType') ? [q.get('eventType')!] : null)
        const gt = q.get('createdAt[gt]'), lt = q.get('createdAt[lt]'), after = q.get('after')
        if (!hooks.has(hookId)) answer = refuse(404, 'Not Found', 'Webhook not found.')
        else if (!(limit >= 1 && limit <= 50)) answer = refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path: '/query/limit', message: 'must be 1-50', value: q.get('limit') }] })
        else {
          // Newest first; equal timestamps keep the order they were sent in, reversed.
          const rows = deliveries.filter(d => d.hook === hookId &&
            (!q.get('status') || d.status === q.get('status')) &&
            (!types || types.includes(d.eventType)) &&
            (!q.get('resourceId') || d.resourceId === q.get('resourceId')) &&
            (!gt || Date.parse(d.createdAt) > Date.parse(gt)) &&
            (!lt || Date.parse(d.createdAt) < Date.parse(lt))).reverse()
          const from = after ? rows.findIndex(d => d.id === JSON.parse(Buffer.from(after, 'base64url').toString()).lastId) + 1 : 0
          const page = rows.slice(from, from + limit)
          const more = from + limit < rows.length
          answer = json({ data: page.map(({ hook: _h, raw: _r, requestBody: _b, attempts: _a, ...d }) => d), nextCursor: more ? Buffer.from(JSON.stringify({ lastId: page.at(-1)!.id })).toString('base64url') : null })
        }
      } else if (!v1 && path.match(/^\/webhooks\/[^/]+\/events\/[^/]+$/) && req.method === 'GET') {
        const [, , hookId, , deliveryId] = path.split('/')
        const d = hooks.has(hookId!) ? deliveries.find(x => x.hook === hookId && x.id === decodeURIComponent(deliveryId!)) : undefined
        answer = d ? json({ data: (({ hook: _h, raw: _r, status: _s, nextAttemptAt: _n, ...rest }) => rest)(d) }) : refuse(404, 'Not Found', 'Delivery not found.', { code: '0300404' })
      } else if (!v1 && path.match(/^\/webhooks\/[^/]+\/events\/test$/) && req.method === 'POST') {
        const h = hooks.get(path.split('/')[2]!)
        const b = (() => { try { return JSON.parse(text) as { eventType?: string } } catch { return {} } })()
        if (!h) answer = refuse(404, 'Not Found', `Webhook with ID ${path.split('/')[2]} not found`, { code: '0300404' })
        else if (!b.eventType || !TEST_TYPES.has(b.eventType)) answer = refuse(400, 'Invalid Input Format', 'Invalid input format', { code: '0304400', errors: [{ path: '/body/eventType', message: 'must be an event type', value: b.eventType, schema: { type: 'string' } }] })
        else {
          const ev = sample(b.eventType)
          // Answered with the sample at once; the delivery is made after.
          setTimeout(() => dispatchTest(h, ev), 5)
          answer = json(ev)
        }
      } else if (!v1 && path.match(/^\/webhooks\/[^/]+\/events\/[^/]+\/retry$/) && req.method === 'POST') {
        // Queued and answered at once, in any state; the attempt lands later.
        const [, , hookId, , deliveryId] = path.split('/')
        const h = hooks.get(hookId!), d = h && deliveries.find(x => x.hook === hookId && x.id === decodeURIComponent(deliveryId!))
        if (!h) answer = refuse(404, 'Not Found', `Webhook with ID ${hookId} not found`, { code: '0300404' })
        else if (!d) answer = refuse(404, 'Not Found', 'Delivery not found.', { code: '0300404' })
        else { manual = manual.then(() => new Promise(r => setTimeout(r, 5))).then(() => attempt(h, d, 'manual')); answer = json({}, 202) }
      } else if (!v1 && path === '/phone-numbers' && req.method === 'GET') {
        const q = url.searchParams, sections = (q.get('include') ?? '').split(',').filter(Boolean), e164 = q.get('phoneNumber')
        // The list takes restrictions alone; business hours are the one-number read's.
        answer = sections.some(x => x !== 'restrictions') ? invalid('/query/include')
          : page(phoneNumbers.filter(n => !e164 || n.phoneNumber === e164).map(n => numberView(n, sections)), q)
      } else if (!v1 && path === '/phone-numbers/available' && req.method === 'GET') {
        const q = url.searchParams, limit = Number(q.get('limit') ?? 10), toll = q.get('tollFree'), area = q.get('areaCode')
        if (!(Number.isInteger(limit) && limit >= 1 && limit <= 100)) answer = invalid('/query/limit')
        else if (toll !== null && toll !== 'true' && toll !== 'false') answer = invalid('/query/tollFree')
        else answer = json({ data: { phoneNumbers: AVAILABLE.filter(a =>
          (!area || a.n.startsWith(`+1${area}`)) && (!q.get('contains') || a.n.includes(q.get('contains')!)) &&
          (!q.get('countryCode') || a.country === q.get('countryCode')) && (!q.get('inRegion') || a.region === q.get('inRegion')) &&
          (!q.get('inLocality') || a.locality === q.get('inLocality')) && (toll === null || /^\+18[0-9]{2}/.test(a.n) === (toll === 'true'))).slice(0, limit).map(a => a.n) } })
      } else if (!v1 && /^\/phone-numbers\/[^/]+(\/(settings|users))?$/.test(path)) {
        const [, , id, part] = path.split('/'), n = phoneNumbers.find(x => x.id === decodeURIComponent(id!)), b = bodyOf(text)
        const op = `${req.method} ${part ?? ''}`
        const isWindow = (w: unknown) => w === null || (!!w && typeof w === 'object' && /^([01][0-9]|2[0-3])[0-5][0-9]$/.test(String((w as { start?: unknown }).start)) && /^([01][0-9]|2[0-3])[0-5][0-9]$/.test(String((w as { end?: unknown }).end)))
        const zone = (z: unknown) => { try { return typeof z === 'string' && /^[A-Za-z]/.test(z) && !!new Intl.DateTimeFormat('en-US', { timeZone: z }) } catch { return false } }
        if (!n) answer = refuse(404, 'Not Found', 'Phone number not found.')
        else if (op === 'GET ') {
          const sections = (url.searchParams.get('include') ?? '').split(',').filter(Boolean)
          answer = sections.some(x => x !== 'restrictions' && x !== 'businessHours') ? invalid('/query/include') : json({ data: numberView(n, sections) })
        }
        else if (op === 'PATCH ') {
          const bh = b?.businessHours as Record<string, unknown> | undefined, sched = bh?.schedule as Record<string, unknown> | null | undefined
          const bad = !b || !Object.keys(b).length ? '/body'
            : 'name' in b && !(typeof b.name === 'string' && b.name.length >= 1 && b.name.length <= 500) ? '/body/name'
            : 'businessHours' in b && !(bh && typeof bh === 'object' && Object.keys(bh).length) ? '/body/businessHours'
            : bh && 'enabled' in bh && typeof bh.enabled !== 'boolean' ? '/body/businessHours/enabled'
            : bh && 'timezone' in bh && !zone(bh.timezone) ? '/body/businessHours/timezone'
            : sched !== undefined && sched !== null && !(typeof sched === 'object' && Object.keys(sched).length && Object.entries(sched).every(([d, w]) => DAYS.includes(d) && isWindow(w))) ? '/body/businessHours/schedule' : null
          if (bad) answer = invalid(bad)
          else {
            if (typeof b!.name === 'string') n.name = b!.name
            if (bh) {
              if ('enabled' in bh) n.hours.enabled = bh.enabled as boolean
              if ('timezone' in bh) n.hours.timezone = bh.timezone as string
              // Our reading: a day left out keeps its window; null clears the schedule.
              if (sched === null) n.hours.schedule = null
              else if (sched) n.hours.schedule = { ...(n.hours.schedule ?? Object.fromEntries(DAYS.map(d => [d, null]))), ...sched as Record<string, { start: string; end: string } | null> }
            }
            n.updatedAt = new Date().toISOString()
            answer = json({ data: numberView(n, ['businessHours']) })
          }
        }
        else if (op === 'GET settings') answer = json({ data: settingsView(n) })
        else if (op === 'PATCH settings') {
          const cd = b?.callDisclosure as Record<string, unknown> | undefined, kinds = ['voice', 'audioTone', 'disabled']
          const bad = !b || !Object.keys(b).length ? '/body'
            : 'autoRecord' in b && typeof b.autoRecord !== 'boolean' ? '/body/autoRecord'
            : 'callDisclosure' in b && !(cd && typeof cd === 'object' && Object.keys(cd).length && Object.entries(cd).every(([k, v]) => (k === 'inbound' || k === 'outbound') && kinds.includes(String(v)))) ? '/body/callDisclosure' : null
          if (bad) answer = invalid(bad)
          else {
            if ('autoRecord' in b!) n.autoRecord = b!.autoRecord as boolean
            if (cd) Object.assign(n.callDisclosure, cd)
            answer = json({ data: settingsView(n) })
          }
        }
        else if (op === 'GET users') answer = page([...n.members].sort().map(u => memberView(users.get(u)!)), url.searchParams)
        else answer = refuse(404, 'Not Found', 'No such route.')
      } else if (!v1 && path === '/organization' && req.method === 'GET') {
        answer = json({ data: { ...org } })
      } else if (!v1 && path === '/users' && req.method === 'GET') {
        answer = page([...users.values()].sort((a, b) => a.id < b.id ? -1 : 1).map(userView), url.searchParams)
      } else if (!v1 && /^\/users\/[^/]+(\/phone-numbers)?$/.test(path) && req.method === 'GET') {
        const [, , id, part] = path.split('/'), userId = decodeURIComponent(id!), u = users.get(userId)
        const sections = (url.searchParams.get('include') ?? '').split(',').filter(Boolean)
        if (!/^US/.test(userId)) answer = invalid('/params/userId')
        else if (part) answer = sections.some(x => x !== 'restrictions') ? invalid('/query/include')
          : page(phoneNumbers.filter(n => n.members.includes(userId)).map(n => numberView(n, sections)), url.searchParams)
        else answer = u ? json({ data: userView(u) }) : refuse(404, 'Not Found', 'User not found.')
      } else if (!v1 && path === '/a2p-registration' && req.method === 'GET') {
        answer = reg ? json({ data: regView() }) : refuse(404, 'Not Found', 'The organization has no A2P registration')
      } else if (!v1 && path === '/a2p-registration' && req.method === 'POST') {
        const b = bodyOf(text), bad = a2pBad(b, true)
        if (bad) answer = invalid(bad)
        else if (org.subscriptionStatus === 'expired') answer = refuse(402, 'Subscription Expired', 'This subscription is not able to register for A2P')
        else if (reg) answer = refuse(409, 'Conflict', 'This organization already has an A2P registration')
        else if (einBad(b!)) answer = refuse(422, 'Unprocessable Entity', 'idNumber must contain exactly nine digits for idType USA: Employer Identification Number (EIN)')
        else {
          const now = new Date().toISOString(), { messageTypes, address, personOfContact, ...info } = b!
          reg = { id: `RG${hex(6)}`, draft: true, status: 'pending', statusMessages: [], type: null, assignedPnId: null, firstSubmittedAt: null, createdAt: now, updatedAt: now,
            businessInfo: { ...info, address: { ...address as object }, personOfContact: { ...personOfContact as object } }, messaging: { useCase: null, personalUse: null, consent: null } }
          autofill(messageTypes as string[])
          answer = json({ data: regView() }, 201)
        }
      } else if (!v1 && path === '/a2p-registration' && req.method === 'PATCH') {
        const b = bodyOf(text), bad = a2pBad(b, false)
        if (!reg) answer = refuse(404, 'Not Found', 'The organization has no A2P registration')
        else if (!reg.draft) answer = refuse(409, 'Conflict', 'Registrations cannot be updated unless they are in draft status')
        else if (bad) answer = invalid(bad)
        else {
          const { messageTypes, address, personOfContact, ...info } = b!
          const next = { ...reg.businessInfo, ...info, address: { ...reg.businessInfo.address, ...address as object }, personOfContact: { ...reg.businessInfo.personOfContact, ...personOfContact as object } }
          if (einBad(next)) answer = refuse(422, 'Unprocessable Entity', 'The tax ID number does not match the expected format for the given ID type')
          else {
            reg.businessInfo = next
            reg.updatedAt = new Date().toISOString()
            if (messageTypes) autofill(messageTypes as string[])
            answer = json({ data: regView() })
          }
        }
      } else if (!v1 && path === '/a2p-registration/submit' && req.method === 'POST') {
        const b = bodyOf(text)
        if (!b || typeof b.forbiddenMessageTopicsAcknowledged !== 'boolean') answer = invalid('/body/forbiddenMessageTopicsAcknowledged')
        else if (!b.forbiddenMessageTopicsAcknowledged) answer = refuse(422, 'Unprocessable Entity', 'forbiddenMessageTopicsAcknowledged must be true to submit')
        else if (!reg) answer = refuse(404, 'Not Found', 'The organization has no A2P registration')
        else if (autofilling || armed.autofilling) { armed.autofilling = false; answer = refuse(409, 'Conflict', 'Autofill is still running — try again shortly') }
        else if (!reg.draft && (reg.status === 'pending' || reg.status === 'approved')) answer = refuse(409, 'Conflict', 'The registration has already been submitted')
        else if (armed.paymentFails) { armed.paymentFails = false; answer = refuse(402, 'Payment Failed', 'Payment could not be completed. Check your billing details and any open invoices in the app, then try again.') }
        else {
          payments++
          const now = new Date().toISOString()
          Object.assign(reg, { draft: false, status: 'pending', statusMessages: [], type: reg.type ?? 'standard', firstSubmittedAt: reg.firstSubmittedAt ?? now, updatedAt: now })
          answer = json({ data: regView() })
        }
      } else if (!v1 && path === '/tasks' && req.method === 'GET') {
        answer = page(newest(tasks).map(taskView), url.searchParams, t => String(t.taskId))
      } else if (!v1 && path === '/tasks' && req.method === 'POST') {
        const b = bodyOf(text)
        const bad = !b || typeof b.title !== 'string' ? '/body/title' : typeof b.description !== 'string' ? '/body/description'
          : typeof b.conversationId !== 'string' || !/^CN/.test(b.conversationId) ? '/body/conversationId'
          : 'dueDate' in b && !isTime(b.dueDate) ? '/body/dueDate'
          : 'assignedTo' in b && !/^US/.test(String(b.assignedTo)) ? '/body/assignedTo' : null
        const conv = b && conversations.find(c => c.id === b.conversationId)
        if (bad) answer = invalid(bad)
        else if (!conv) answer = refuse(404, 'Not Found', 'Conversation not found.')
        else if (armed.openTasksFull) answer = tasksFull()
        else {
          const t: Task = { taskId: `TK${hex(16)}`, orgId: 'ORdev', phoneNumberId: conv.phoneNumberId, conversationId: conv.id, activityId: null, phoneNumberGroupId: null,
            title: b!.title as string, description: b!.description as string, dueDate: 'dueDate' in b! ? new Date(b!.dueDate as string).toISOString() : null,
            assignedTo: (b!.assignedTo as string | undefined) ?? null, assignedBy: b!.assignedTo ? TASK_ACTOR : null, createdBy: TASK_ACTOR, createdAt: new Date().toISOString(), status: 'open', revision: 1 }
          tasks.push(t)
          await deliverTask('task.created', t, { title: t.title, description: t.description, dueDate: t.dueDate })
          answer = taskAnswer(t, 201)
        }
      } else if (!v1 && /^\/tasks\/[^/]+(\/(status|conversations|users|due-date))?$/.test(path)) {
        const [, , id, part] = path.split('/'), t = tasks.find(x => x.taskId === decodeURIComponent(id!)), b = bodyOf(text)
        const moved = () => { t!.revision++ }
        const op = `${req.method} ${part ?? ''}`
        if (!t) answer = refuse(404, 'Not Found', 'Task not found.')
        else if (op === 'GET ') answer = json({ data: taskView(t) })
        else if (op === 'PATCH ') {
          // The spec requires both, so the sink refuses one alone.
          if (!b || typeof b.title !== 'string') answer = invalid('/body/title')
          else if (typeof b.description !== 'string') answer = invalid('/body/description')
          else {
            const field = (k: 'title' | 'description') => t[k] === b[k] ? { isUpdated: false } : { isUpdated: true, updatedValue: b[k] }
            const updatedFields = { title: field('title'), description: field('description') }
            t.title = b.title; t.description = b.description; moved()
            await deliverTask('task.updated', t, { updatedFields })
            answer = taskAnswer(t)
          }
        }
        else if (op === 'DELETE ') {
          // A status: the task is still read, `deleted`, and a second delete finds it so.
          if (t.status !== 'deleted') { t.status = 'deleted'; moved(); await deliverTask('task.deleted', t) }
          answer = new Response(null, { status: 204 })
        }
        else if (op === 'PATCH status') {
          const to = b?.status
          if (to !== 'open' && to !== 'completed' && to !== 'deleted') answer = invalid('/body/status')
          else if (to === t.status) answer = taskAnswer(t)
          else if (to === 'open' && armed.openTasksFull) answer = tasksFull()
          else {
            t.status = to; moved()
            await deliverTask(to === 'completed' ? 'task.completed' : to === 'deleted' ? 'task.deleted' : 'task.reopened', t)
            answer = taskAnswer(t)
          }
        }
        else if (op === 'POST conversations' || op === 'DELETE conversations') {
          const cid = b?.conversationId, conv = conversations.find(c => c.id === cid)
          if (typeof cid !== 'string' || !/^CN/.test(cid)) answer = invalid('/body/conversationId')
          else if (req.method === 'POST' && !conv) answer = refuse(404, 'Not Found', 'Conversation not found.')
          else if (req.method === 'POST') {
            if (t.conversationId !== cid) { t.conversationId = cid; t.phoneNumberId = conv!.phoneNumberId; moved(); await deliverTask('task.linked', t) }
            answer = taskAnswer(t)
          }
          // Our reading: taking a task out of a conversation it is not in is refused.
          else if (t.conversationId !== cid) answer = refuse(400, 'Bad Request', 'The task is not linked to this conversation.')
          else {
            const left = { ...t }
            t.conversationId = null; moved()
            await deliverTask('task.unlinked', t, {}, left)
            answer = taskAnswer(t)
          }
        }
        else if (op === 'POST users' || op === 'DELETE users') {
          const uid = b?.userId
          if (typeof uid !== 'string' || !/^US/.test(uid)) answer = invalid('/body/userId')
          else if (req.method === 'POST') {
            if (t.assignedTo !== uid) { t.assignedTo = uid; t.assignedBy = TASK_ACTOR; moved(); await deliverTask('task.assigned', t, { assignedTo: uid }) }
            answer = taskAnswer(t)
          }
          // Our reading, as an unlink's.
          else if (t.assignedTo !== uid) answer = refuse(400, 'Bad Request', 'The task is not assigned to this user.')
          else {
            t.assignedTo = null; t.assignedBy = null; moved()
            await deliverTask('task.unassigned', t, { unassignedFrom: uid })
            answer = taskAnswer(t)
          }
        }
        else if (op === 'PATCH due-date') {
          if (!isTime(b?.dueDate)) answer = invalid('/body/dueDate')
          else {
            t.dueDate = new Date(b!.dueDate as string).toISOString(); moved()
            await deliverTask('task.duedate.updated', t, { updatedDueDate: t.dueDate })
            answer = taskAnswer(t)
          }
        }
        else if (op === 'DELETE due-date') {
          // Our reading: clearing a due date there is none of changes nothing.
          if (t.dueDate !== null) { t.dueDate = null; moved(); await deliverTask('task.duedate.removed', t) }
          answer = taskAnswer(t)
        }
        else answer = refuse(404, 'Not Found', 'No such route.')
      } else {
        const msg = path.match(/^\/messages\/([^/]+)$/)
        const rot = path.match(/^\/webhooks\/([^/]+)\/rotate$/)
        const one = path.match(/^\/webhooks\/([^/]+)$/)
        const retry = path.match(/^\/messages\/([^/]+)\/retry$/)
        const person = path.match(/^\/contacts\/([^/]+)$/)
        const mark = path.match(/^\/conversations\/([^/]+)\/mark-as-(read|done|open)$/)
        const at = person ? contacts.findIndex(x => x.id === decodeURIComponent(person[1]!)) : -1
        if (!v1 && mark && req.method === 'POST') {
          const c = conversations.find(x => x.id === decodeURIComponent(mark[1]!))
          if (!c) answer = refuse(404, 'Not Found', 'Conversation not found.')
          else {
            const state = inbox.get(c.id) ?? { unread: false, status: 'open' as const }
            if (mark[2] === 'read') state.unread = false
            else state.status = mark[2] as 'done' | 'open'
            inbox.set(c.id, state)
            answer = json({ data: c })
          }
        }
        else if (!v1 && person && req.method === 'PATCH') {
          const b = (() => { try { return JSON.parse(text) as Record<string, unknown> } catch { return null } })()
          const bad = !b ? '/body' : contactFieldBad(b)
          if (at < 0) answer = refuse(404, 'Not Found', 'Contact not found.')
          else if (bad) answer = refuse(400, 'Bad Request', 'Validation failed for 1 field.', { errors: [{ path: bad, message: 'is invalid', schema: {} }] })
          else {
            const c = { ...contacts[at]! }
            assignContact(c, b!)
            c.updatedAt = new Date().toISOString()
            if (sameSource(c)) answer = conflict()
            else { contacts[at] = c; await deliverContact('contact.updated', c); answer = json({ data: c }) }
          }
        }
        else if (!v1 && person && req.method === 'DELETE') {
          if (at < 0) answer = refuse(404, 'Not Found', 'Contact not found.')
          else { const [gone] = contacts.splice(at, 1); await deliverContact('contact.deleted', gone!); props.delete(gone!.id); answer = new Response(null, { status: 204 }) }
        }
        else if (!v1 && msg && req.method === 'GET') { const m = messages.find(x => x.id === decodeURIComponent(msg[1])); answer = m ? json({ data: m }) : refuse(404, 'Not Found', 'Message not found.') }
        else if (!v1 && retry && req.method === 'POST') {
          const m = messages.find(x => x.id === decodeURIComponent(retry[1]))
          if (!m) answer = refuse(404, 'Not Found', 'Message not found')
          else if (m.status !== 'failed' || m.errorCode) answer = refuse(422, 'Unprocessable Entity', 'The message has permanently failed and cannot be retried')
          else {
            m.status = 'queued'; m.updatedAt = new Date().toISOString()
            setTimeout(() => settleMessage(m, null), 20)
            answer = json({}, 202)
          }
        }
        else if (!v1 && rot && req.method === 'POST') { const h = hooks.get(rot[1]); if (h) { h.key = `whsec_${randomBytes(24).toString('base64')}`; answer = json({ data: { key: h.key } }) } else answer = refuse(404, 'Not Found', 'Webhook not found.') }
        else if (!v1 && one && req.method === 'GET') { const h = hooks.get(one[1]); answer = h ? json({ data: view(h) }) : refuse(404, 'Not Found', `Webhook with ID ${one[1]} not found`, { code: '0300404' }) }
        else if (!v1 && one && req.method === 'PATCH') {
          const h = hooks.get(one[1])
          const b = (() => { try { return JSON.parse(text) as Record<string, unknown> } catch { return null } })()
          const bad = !b || !Object.keys(b).length ? '/body'
            : 'events' in b && !(Array.isArray(b.events) && b.events.length && b.events.every(e => TEST_TYPES.has(e as string))) ? '/body/events'
            : 'resourceIds' in b && !(b.resourceIds === null || (Array.isArray(b.resourceIds) && (b.resourceIds.every(r => /^PN/.test(String(r))) || (b.resourceIds.length === 1 && b.resourceIds[0] === '*')))) ? '/body/resourceIds'
            : 'status' in b && b.status !== 'enabled' && b.status !== 'disabled' ? '/body/status' : null
          if (!h) answer = refuse(404, 'Not Found', `Webhook with ID ${one[1]} not found`, { code: '0300404' })
          else if (bad) answer = refuse(400, 'Bad Request', 'Validation failed for 1 field.', { code: '0300400', errors: [{ path: bad, message: 'is invalid', schema: {} }] })
          else {
            // Only what is given changes; null, [] and ['*'] all clear the number filter.
            if ('url' in b!) h.url = String(b!.url)
            if ('events' in b!) h.events = b!.events as string[]
            if ('resourceIds' in b!) h.resourceIds = (b!.resourceIds as string[] | null)?.length ? b!.resourceIds as string[] : ['*']
            if ('label' in b!) h.label = b!.label as string | null
            if ('status' in b!) h.status = String(b!.status)
            h.updatedAt = new Date().toISOString()
            answer = json({ data: view(h) })
          }
        }
        else if (!v1 && one && req.method === 'DELETE') answer = hooks.delete(one[1]) ? new Response(null, { status: 204 }) : refuse(404, 'Not Found', 'Webhook not found.')
        else answer = refuse(404, 'Not Found', 'No such route.')
      }
      if (armed.lost) { armed.lost = false; await new Promise<void>(r => hanging.push(r)) }
      return record(answer)
    },
  })
  const view = ({ key: _key, ...h }: Hook) => ({ ...h, orgId: 'ORdev', apiVersion: VERSION })
  /** A section left out unless `include` names it, and a voicemail left out where none was left. */
  const NO_SUMMARY = { status: 'absent', type: null, summary: null, nextSteps: null, jobs: null, title: null }
  const callView = (c: RestCall, q: URLSearchParams) => {
    const include = (q.get('include') ?? '').split(','), art = artifacts.get(c.id)
    return { ...c, ...(include.includes('summary') ? { summary: art?.summary ?? NO_SUMMARY } : {}), ...(include.includes('voicemail') && art?.voicemail ? { voicemail: art.voicemail } : {}) }
  }
  return {
    port: server.port, url: `http://127.0.0.1:${server.port}`, numbers,
    /** The key a webhook signs with now — what the app would have stored from create or rotate. */
    keyOf: (hookId: string) => hooks.get(hookId)?.key,
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) startQuoSink({ port: Number(process.env.QUO_SINK_PORT ?? 0) }).then(s => console.log(`[quo-sink] ${s.url}`))
