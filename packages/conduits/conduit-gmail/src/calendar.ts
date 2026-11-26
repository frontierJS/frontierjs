// @frontierjs/conduit-gmail/calendar — Google Calendar over conduit: read a
// host's busy time, write a booking.
//
// A module beside the mail dialect rather than a package of its own: it rides
// the same Google grant, the same error envelope (`translateCalendar` shares
// `src/errors.ts`'s reader) and the same stand-in server. It is NOT re-exported
// from `.`; an app that books imports `@frontierjs/conduit-gmail/calendar`.
// Every call takes `send` (CONTRACT C2) from `bindCalendarSend`; the
// credential is a USER's OAuth access token minted by the app's resolver.
//
// ─── Idempotency is the event id (C5, C6) ───────────────────────────────
// `events.insert` takes a client-supplied id, so a replay is harmless and
// conduit may repeat a POST whose answer was lost. The replay then lands on a
// 409, which is `conflict`: for an insert it means the id ALREADY LANDED, and
// `getEvent` reads it back. Google keeps a deleted event's id as a cancelled
// tombstone, so a rebook derives a fresh id with `eventIdFor(booking, 'r2')`.
//
// ─── What is refused before the send (C9) ───────────────────────────────
// An event id that is not 5-1024 characters of a-v and 0-9, a range whose
// start is not before its end, an empty `items`, more than 50 `items`, a
// `maxResults` past 250: the call throws a TypeError, zero attempts.
//
// ─── Not built ──────────────────────────────────────────────────────────
// Incremental sync (`syncToken`), watch channels, recurring events, all-day
// events (`start.date`), attendee responses, Meet links, the batch endpoint.

import { createHash } from 'node:crypto'
import type { ConduitResult, ResponseValidator, TargetDescriptor } from '@frontierjs/conduit'
import { translateCalendar, type CalendarFailure } from './errors.ts'
import { bindSend, type Send } from './index.ts'

export const CALENDAR_TARGET  = 'provider:google-calendar'
export const CALENDAR_ADDRESS = 'https://www.googleapis.com'
export const CALENDAR_BASE    = '/calendar/v3'

/** Calendar's per-call ceiling on `items` is not documented; `calendarExpansionMax` is, at 50. */
export const MAX_FREEBUSY_ITEMS = 50
export const MAX_CALENDAR_LIST  = 250

/**
 * The narrowest scope each method accepts, one each. None is the broad
 * `calendar` scope: freeBusy.query does not accept `calendar.events*` at
 * all, so reading availability and writing a booking are two scopes.
 */
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const

export type { CalendarFailure, CalendarFailureKind } from './errors.ts'

export function bindCalendarSend(conduit: Parameters<typeof bindSend>[0], target: TargetDescriptor | string = CALENDAR_TARGET): Send {
  return bindSend(conduit, target)
}

export interface CalendarTargetOptions {
  /** The resolver's ref for the user's access token. */
  ref?:       string
  address?:   string
  id?:        string
  /** The token belongs to whoever the send is for; the resolver must have `getFor`. */
  perCaller?: boolean
}

/** One host, one target; the same shape as `gmailTarget` over a different origin and grant. */
export function calendarTarget(opts: CalendarTargetOptions = {}): TargetDescriptor {
  return {
    id:            opts.id ?? CALENDAR_TARGET,
    kind:          'provider',
    protocol:      'http',
    address:       opts.address ?? CALENDAR_ADDRESS,
    encoding:      'json',
    auth:          { type: 'bearer', ref: opts.ref ?? 'GOOGLE_CALENDAR_GRANT', ...(opts.perCaller ? { per_caller: true as const } : {}) },
    resilience:    { timeout_ms: 15_000, retry_limit: 2 },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

// ─── Wire shapes ──────────────────────────────────────────────────────────

export type AccessRole = 'freeBusyReader' | 'reader' | 'writer' | 'owner'

export interface CalendarListEntry {
  id:               string
  summary:          string
  summaryOverride?: string
  primary?:         boolean
  accessRole:       AccessRole
  selected?:        boolean
  backgroundColor?: string
  timeZone?:        string
}

export interface CalendarList {
  kind?:          string
  etag?:          string
  nextPageToken?: string
  items:          CalendarListEntry[]
}

/** RFC 3339. `timeZone` names the zone of a `dateTime` that carries no offset. */
export interface EventTime { dateTime: string; timeZone?: string }

export interface EventAttendee { email: string; displayName?: string }

export type SendUpdates = 'all' | 'externalOnly' | 'none'

export interface CalendarEvent {
  kind?:         string
  id:            string
  status?:       'confirmed' | 'tentative' | 'cancelled'
  summary?:      string
  description?:  string
  location?:     string
  start?:        EventTime
  end?:          EventTime
  attendees?:    EventAttendee[]
  transparency?: 'opaque' | 'transparent'
  iCalUID?:      string
  htmlLink?:     string
  etag?:         string
}

/** One calendar's answer. `errors` with no `busy` means Google could NOT read it, which is not the same as free. */
export interface FreeBusyCalendar {
  busy?:   Array<{ start: string; end: string }>
  errors?: Array<{ domain?: string; reason?: string }>
}

export interface FreeBusyAnswer {
  kind?:     string
  timeMin:   string
  timeMax:   string
  calendars: Record<string, FreeBusyCalendar>
}

// ─── Validation (C4) ──────────────────────────────────────────────────────

/** A 2xx that is not an object, carries the error envelope, or lacks the shape's keys is `invalid_response`. */
const shape = <T>(name: string, ...required: string[]): ResponseValidator<T> => ({
  validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: [`calendar: ${name} expected a JSON object`] }
    if ('error' in data) return { ok: false, errors: [`calendar: ${name} answered Google's error envelope under a 2xx`] }
    const missing = required.filter(k => !(k in data))
    if (missing.length) return { ok: false, errors: [`calendar: ${name} lacks ${missing.join(', ')}`] }
    return { ok: true, value: data as T }
  },
})

export const calendarListValidator = shape<CalendarList>('calendarList', 'items')
export const freeBusyValidator     = shape<FreeBusyAnswer>('freeBusy', 'calendars')
export const eventValidator        = shape<CalendarEvent>('event', 'id')

type Answer<K extends string, T> = { [P in K]?: T } & { error?: CalendarFailure }

/**
 * The caller's patience for one call. A caller racing its own deadline without
 * these leaves the call running behind it: the target's 15 s per attempt, three
 * attempts. `timeoutMs` caps each attempt and is not counted by the breaker;
 * `signal` ends the whole call, retries included. A request cannot lower the
 * target's `retry_limit`, so `signal` is the bound on the call as a whole.
 */
export interface CallOptions { timeoutMs?: number; signal?: AbortSignal }

const patience = (opts: CallOptions) => ({
  ...(opts.timeoutMs !== undefined ? { timeout_ms: opts.timeoutMs } : {}),
  ...(opts.signal ? { signal: opts.signal } : {}),
})

const fail = (result: { error: NonNullable<ConduitResult<unknown>['error']>; meta: { status?: number; headers?: Record<string, string> } }) =>
  translateCalendar(result.error, result.meta.status, result.meta.headers)

// ─── Reads ────────────────────────────────────────────────────────────────

export interface ListCalendarsOptions { pageToken?: string; maxResults?: number; minAccessRole?: AccessRole }

/** `GET /users/me/calendarList`: which calendars the grant can see. `maxResults` defaults to 100 at Google. */
export async function listCalendars(send: Send, opts: ListCalendarsOptions = {}, call: CallOptions = {}): Promise<Answer<'calendars', CalendarList>> {
  const max = opts.maxResults
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > MAX_CALENDAR_LIST))
    throw new TypeError(`calendar: maxResults must be 1..${MAX_CALENDAR_LIST}, got ${max}`)
  const r = await send<CalendarList>({
    method: 'GET',
    path:   `${CALENDAR_BASE}/users/me/calendarList`,
    query:  {
      ...(max !== undefined       ? { maxResults: max } : {}),
      ...(opts.pageToken          ? { pageToken: opts.pageToken } : {}),
      ...(opts.minAccessRole      ? { minAccessRole: opts.minAccessRole } : {}),
    },
    validate: calendarListValidator,
    ...patience(call),
  })
  return r.error ? { error: fail(r) } : { calendars: r.data }
}

export interface FreeBusyInput { timeMin: string; timeMax: string; items: Array<{ id: string }>; timeZone?: string }

/**
 * `POST /freeBusy`. A read through a POST, so `replayable: true`: asking
 * twice changes nothing. A 200 can hold a calendar that Google could not
 * read; `busyRanges` is the reader that does not count it as free.
 */
export async function freeBusy(send: Send, input: FreeBusyInput, opts: CallOptions = {}): Promise<Answer<'freeBusy', FreeBusyAnswer>> {
  const min = Date.parse(input.timeMin), max = Date.parse(input.timeMax)
  if (Number.isNaN(min) || Number.isNaN(max)) throw new TypeError(`calendar: timeMin and timeMax must be RFC 3339, got '${input.timeMin}' and '${input.timeMax}'`)
  if (min >= max) throw new TypeError(`calendar: timeMin must be before timeMax, got '${input.timeMin}' and '${input.timeMax}'`)
  if (!input.items.length) throw new TypeError('calendar: freeBusy needs at least one calendar in items')
  if (input.items.length > MAX_FREEBUSY_ITEMS)
    throw new TypeError(`calendar: ${input.items.length} items; Google documents calendarExpansionMax at ${MAX_FREEBUSY_ITEMS}`)
  const r = await send<FreeBusyAnswer>({
    method:     'POST',
    path:       `${CALENDAR_BASE}/freeBusy`,
    body:       { timeMin: input.timeMin, timeMax: input.timeMax, ...(input.timeZone ? { timeZone: input.timeZone } : {}), items: input.items.map(i => ({ id: i.id })) },
    validate:   freeBusyValidator,
    replayable: true,
    ...patience(opts),
  })
  return r.error ? { error: fail(r) } : { freeBusy: r.data }
}

/**
 * `GET /calendars/{c}/events/{e}`. A deleted event answers as `status:
 * 'cancelled'` rather than a 404 (unverified), so a caller settling a lost
 * insert reads `status` before it believes the booking exists.
 */
export async function getEvent(send: Send, input: { calendarId: string; eventId: string }, opts: CallOptions = {}): Promise<Answer<'event', CalendarEvent>> {
  const r = await send<CalendarEvent>({ method: 'GET', path: eventPath(input.calendarId, input.eventId), validate: eventValidator, ...patience(opts) })
  return r.error ? { error: fail(r) } : { event: r.data }
}

// ─── Writes ───────────────────────────────────────────────────────────────

export interface InsertEventInput {
  calendarId:   string
  /** From `eventIdFor`: 5-1024 characters of a-v and 0-9. It is what makes the insert replayable. */
  id:           string
  summary:      string
  description?: string
  location?:    string
  start:        EventTime
  end:          EventTime
  attendees?:   EventAttendee[]
  sendUpdates?: SendUpdates
}

/**
 * `POST /calendars/{c}/events`. `replayable: true` because the id is the
 * caller's: a replay after a lost answer is a 409, `conflict`, which says the
 * first one landed. `sendUpdates` is always sent; Google's default is not
 * stated clearly enough to lean on.
 */
export async function insertEvent(send: Send, input: InsertEventInput, opts: CallOptions = {}): Promise<Answer<'event', CalendarEvent>> {
  assertEventId(input.id)
  const r = await send<CalendarEvent>({
    method:     'POST',
    path:       eventsPath(input.calendarId),
    query:      { sendUpdates: input.sendUpdates ?? 'none' },
    body:       {
      id:      input.id,
      summary: input.summary,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.location    !== undefined ? { location: input.location } : {}),
      start:   input.start,
      end:     input.end,
      ...(input.attendees?.length ? { attendees: input.attendees } : {}),
    },
    validate:   eventValidator,
    replayable: true,
    ...patience(opts),
  })
  return r.error ? { error: fail(r) } : { event: r.data }
}

export type EventPatch = Partial<Pick<CalendarEvent, 'summary' | 'description' | 'location' | 'start' | 'end' | 'attendees' | 'status' | 'transparency'>>

/** `PATCH /calendars/{c}/events/{e}`: only the fields given change. Not replayable here; a rerun is the caller's call. */
export async function patchEvent(send: Send, input: { calendarId: string; eventId: string; patch: EventPatch; sendUpdates?: SendUpdates }, opts: CallOptions = {}): Promise<Answer<'event', CalendarEvent>> {
  if (!Object.keys(input.patch).length) throw new TypeError('calendar: patchEvent needs at least one field in patch')
  const r = await send<CalendarEvent>({
    method:   'PATCH',
    path:     eventPath(input.calendarId, input.eventId),
    query:    { sendUpdates: input.sendUpdates ?? 'none' },
    body:     input.patch,
    validate: eventValidator,
    ...patience(opts),
  })
  return r.error ? { error: fail(r) } : { event: r.data }
}

/**
 * `DELETE /calendars/{c}/events/{e}`: 204 with no body. `replayable: true`:
 * a second delete is a 410 or a 404, and both are `gone`, which here is the
 * outcome the caller asked for, so it answers `already: true` rather than an
 * error. A wrong `calendarId` is also a 404, so it reads the same.
 */
export async function deleteEvent(send: Send, input: { calendarId: string; eventId: string; sendUpdates?: SendUpdates }, opts: CallOptions = {}): Promise<{ deleted?: true; already?: true; error?: CalendarFailure }> {
  const r = await send<null>({
    method:     'DELETE',
    path:       eventPath(input.calendarId, input.eventId),
    query:      { sendUpdates: input.sendUpdates ?? 'none' },
    replayable: true,
    ...patience(opts),
  })
  if (!r.error) return { deleted: true }
  const failure = fail(r)
  return failure.kind === 'gone' ? { deleted: true, already: true } : { error: failure }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

const BASE32HEX = '0123456789abcdefghijklmnopqrstuv'
const EVENT_ID_LENGTH = 32

/**
 * A booking's event id: SHA-256 written in base32hex (Google's alphabet,
 * a-v and 0-9), cut to 32 characters, which is 160 bits. The same booking
 * always derives the same id, so a replayed insert is a 409 and not a second
 * event. Google keeps a deleted event's id as a tombstone, so a rebook names
 * a `generation` (`'r2'`) and gets a fresh id from the same booking.
 */
export function eventIdFor(bookingId: string, generation?: string): string {
  if (!bookingId) throw new TypeError('calendar: eventIdFor needs a booking id')
  const digest = createHash('sha256').update(JSON.stringify(['fjs:booking', bookingId, generation ?? ''])).digest()
  let out = '', bits = 0, acc = 0
  for (const byte of digest) {
    acc = (acc << 8) | byte; bits += 8
    while (bits >= 5 && out.length < EVENT_ID_LENGTH) { out += BASE32HEX[(acc >> (bits - 5)) & 31]; bits -= 5 }
    acc &= (1 << bits) - 1
    if (out.length >= EVENT_ID_LENGTH) break
  }
  return out
}

export interface BusyRange { start: number; end: number }
export interface UnreadableCalendar { calendarId: string; reason: string }

/**
 * Every calendar's busy time as one sorted list of epoch-ms ranges, start
 * inclusive and end exclusive, overlapping and touching ranges merged. A
 * calendar Google could not read (`errors[]`, or an unparseable range, or one
 * named in `requested` that the answer lacks) is reported in `unreadable` and
 * never counted as free: the caller decides whether to offer the slot.
 * `reason` is Google's own word; it says more may be added.
 */
export function busyRanges(answer: Pick<FreeBusyAnswer, 'calendars'>, requested: readonly string[] = []): { busy: BusyRange[]; unreadable: UnreadableCalendar[] } {
  const raw: BusyRange[] = [], unreadable: UnreadableCalendar[] = []
  for (const [calendarId, cal] of Object.entries(answer.calendars ?? {})) {
    if (cal.errors?.length) unreadable.push({ calendarId, reason: cal.errors.find(e => e.reason)?.reason ?? 'unknown' })
    for (const b of cal.busy ?? []) {
      const start = Date.parse(b.start), end = Date.parse(b.end)
      if (Number.isNaN(start) || Number.isNaN(end)) { unreadable.push({ calendarId, reason: 'invalidRange' }); continue }
      if (end > start) raw.push({ start, end })
    }
  }
  for (const calendarId of requested) if (!(calendarId in (answer.calendars ?? {}))) unreadable.push({ calendarId, reason: 'missing' })
  raw.sort((a, b) => a.start - b.start || a.end - b.end)
  const busy: BusyRange[] = []
  for (const r of raw) {
    const last = busy[busy.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else busy.push({ ...r })
  }
  return { busy, unreadable }
}

// ─── Paths ────────────────────────────────────────────────────────────────

function assertEventId(id: string): void {
  if (!/^[a-v0-9]{5,1024}$/.test(id)) throw new TypeError(`calendar: '${id}' is not an event id; Google takes 5-1024 characters of a-v and 0-9`)
}

function eventsPath(calendarId: string): string {
  if (!calendarId) throw new TypeError('calendar: a calendarId is required')
  return `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events`
}

function eventPath(calendarId: string, eventId: string): string {
  if (!eventId) throw new TypeError('calendar: an eventId is required')
  return `${eventsPath(calendarId)}/${encodeURIComponent(eventId)}`
}
