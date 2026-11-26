// sink-calendar.ts — Google Calendar, standing in for Calendar.
//
// Mounted by `sink.ts` beside `/gmail/v1/*`, so one listener, one bearer
// table's worth of chaos and one `seen` list serve both. A bearer token names
// an account; the account's token carries SCOPES, and each method accepts the
// scopes Google's reference lists for it, so a client that asks for the wrong
// one is refused here rather than agreed with. The table below is written out
// again on purpose: importing `CALENDAR_SCOPES` from the client would make a
// drift in it agree with itself.
//
// What it enforces: the event id alphabet and length (400), a reused id
// (409 `duplicate`) INCLUDING a deleted event's, kept as a cancelled
// tombstone; DELETE answers 204 with no body, a second delete 410 `deleted`,
// an id that never existed 404; GET of a deleted event is 200 with
// `status: 'cancelled'`; freeBusy `timeMin >= timeMax` is 400
// `timeRangeEmpty`, an unknown calendar inside a freeBusy is a 200 with that
// calendar's `errors[]` and no `busy`, and more than 50 items answers
// `tooManyCalendarsRequested` for every calendar. freeBusy counts events that
// are neither cancelled nor `transparency: 'transparent'`, clipped to the
// range, one range per event: merging is the client's job.
//
// Chaos is the Gmail sink's, armed at `/_sink/arm` (FJS-D890): `lost` (the
// write is applied, the answer never arrives), `revoke` (401 `authError`),
// `rateLimit: { status: 429 | 403 }` (`rateLimitExceeded` either way),
// `forbidScope`, `failNext` (500 `backendError`), and `freeBusyNotFound:
// ['id']` (the next freeBusy answers `notFound` for those calendars inside
// its 200). Two last until disarmed or reset: `delay: ms` (every Calendar
// answer waits that long first; reset releases a waiting one) and `outage:
// { status: 500 | 503 | 429 }` (every Calendar call answers that, so a
// retrying client sees the outage on every attempt). Unverified against a real token: the 204 on delete, the 409 on a
// deleted id, what GET answers for a deleted event, and the 403 `reason`
// Calendar gives for a missing scope (the Gmail sink's spelling is used).
//
// Controls: `GET /_sink/calendar` is every account's calendars and events;
// `POST /_sink/calendar/event` adds one mid-test: `{ token, calendarId?,
// start, end, summary?, transparency?, status?, id? }`.

import type { Armed, SeenRequest } from './sink.ts'

// ─── Options and state ────────────────────────────────────────────────────

export interface SinkSeedCalendar {
  id:          string
  summary?:    string
  primary?:    boolean
  accessRole?: 'freeBusyReader' | 'reader' | 'writer' | 'owner'
  timeZone?:   string
}

export interface SinkSeedEvent {
  id?:           string
  /** Defaults to the account's primary calendar. */
  calendarId?:   string
  summary?:      string
  /** ISO string or epoch ms. */
  start:         string | number
  end:           string | number
  status?:       'confirmed' | 'tentative' | 'cancelled'
  transparency?: 'opaque' | 'transparent'
}

export interface SinkCalendarAccount {
  token:      string
  email:      string
  /** Defaults to the three scopes the client asks for. */
  scopes?:    string[]
  /** Defaults to one primary calendar whose id is the email. */
  calendars?: SinkSeedCalendar[]
  events?:    SinkSeedEvent[]
}

export interface CalendarSinkOptions { accounts?: SinkCalendarAccount[] }

interface StoredEvent {
  kind: 'calendar#event'; id: string; status: string; summary: string; description?: string; location?: string
  start: { dateTime: string; timeZone?: string }; end: { dateTime: string; timeZone?: string }
  attendees?: Array<{ email: string; displayName?: string }>; transparency?: string
  iCalUID: string; htmlLink: string; etag: string; created: string; updated: string
}

interface Account {
  token:     string
  email:     string
  scopes:    string[]
  calendars: Map<string, Required<SinkSeedCalendar>>
  events:    Map<string, Map<string, StoredEvent>>
}

/** What `sink.ts` hands over: its own list, chaos and response helpers, so this file imports nothing at run time. */
export interface CalendarHost {
  seen:    SeenRequest[]
  armed:   Armed
  hanging: Array<() => void>
  json(body: unknown, status?: number, headers?: Record<string, string>): Response
}

export interface CalendarSinkState {
  accounts: Map<string, Account>
  /** An access token sink-oauth.ts minted → the token its account is keyed on. */
  aliases:  Map<string, string>
  /** Adds an event to an account's calendar, as a booking made outside the app would. */
  addEvent(token: string, seed: SinkSeedEvent): StoredEvent
  handle(req: Request): Promise<Response | null>
}

// ─── What each method accepts ─────────────────────────────────────────────

const A = 'https://www.googleapis.com/auth/'
const WRITE = [A + 'calendar', A + 'calendar.events', A + 'calendar.events.owned', A + 'calendar.app.created']
const ACCEPTS = {
  'freeBusy.query':    [A + 'calendar.freebusy', A + 'calendar.events.freebusy', A + 'calendar.readonly', A + 'calendar'],
  'events.insert':     WRITE,
  'events.patch':      WRITE,
  'events.delete':     WRITE,
  'events.get':        [...WRITE, A + 'calendar.readonly', A + 'calendar.events.readonly', A + 'calendar.events.owned.readonly'],
  'calendarList.list': [A + 'calendar.readonly', A + 'calendar', A + 'calendar.calendarlist', A + 'calendar.calendarlist.readonly'],
} as const

const DEFAULT_SCOPES = [A + 'calendar.freebusy', A + 'calendar.events.owned', A + 'calendar.calendarlist.readonly']
const EVENT_ID = /^[a-v0-9]{5,1024}$/
const SEND_UPDATES = new Set(['all', 'externalOnly', 'none'])
const ROLES = ['freeBusyReader', 'reader', 'writer', 'owner']
const FREEBUSY_ITEMS_MAX = 50
const LIST_MAX = 250

let counter = 0
const iso = (v: string | number) => typeof v === 'number' ? new Date(v).toISOString() : v

// ─── The state and the handler ────────────────────────────────────────────

export function createCalendarSink(host: CalendarHost, opts: CalendarSinkOptions = {}): CalendarSinkState {
  const { seen, armed, hanging, json } = host
  const accounts = new Map<string, Account>()
  const aliases  = new Map<string, string>()

  /** Calendar's envelope: `errors[]` carries the `reason`; there is no gRPC `status` word. */
  const err = (code: number, reason: string, message: string, extra: { details?: unknown[]; headers?: Record<string, string> } = {}) =>
    json({ error: { code, message, errors: [{ message, domain: 'global', reason }], ...(extra.details ? { details: extra.details } : {}) } }, code, {
      ...(code === 401 ? { 'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"' } : {}),
      ...(extra.headers ?? {}),
    })
  const notFound = () => err(404, 'notFound', 'Not Found')
  const invalid  = (message: string) => err(400, 'invalid', message)

  function addEvent(token: string, seed: SinkSeedEvent): StoredEvent {
    const acct = accounts.get(token)
    if (!acct) throw new Error(`calendar sink: no account holds token '${token}'`)
    const calendarId = resolve(acct, seed.calendarId ?? 'primary')
    if (!calendarId) throw new Error(`calendar sink: ${acct.email} has no calendar '${seed.calendarId}'`)
    const id = seed.id ?? `seed${(++counter).toString(32).padStart(5, '0')}`
    const now = new Date().toISOString()
    const ev: StoredEvent = {
      kind: 'calendar#event', id, status: seed.status ?? 'confirmed', summary: seed.summary ?? 'Busy',
      start: { dateTime: iso(seed.start) }, end: { dateTime: iso(seed.end) },
      ...(seed.transparency ? { transparency: seed.transparency } : {}),
      iCalUID: `${id}@google.com`, htmlLink: `https://www.google.com/calendar/event?eid=${id}`, etag: `"${counter}"`, created: now, updated: now,
    }
    acct.events.get(calendarId)!.set(id, ev)
    return ev
  }

  for (const a of opts.accounts ?? []) {
    const cals = a.calendars?.length ? a.calendars : [{ id: a.email, primary: true }]
    const acct: Account = {
      token: a.token, email: a.email, scopes: a.scopes ?? DEFAULT_SCOPES,
      calendars: new Map(cals.map(c => [c.id, { id: c.id, summary: c.summary ?? c.id, primary: c.primary ?? false, accessRole: c.accessRole ?? 'owner', timeZone: c.timeZone ?? 'UTC' }])),
      events: new Map(cals.map(c => [c.id, new Map()])),
    }
    accounts.set(a.token, acct)
    for (const e of a.events ?? []) addEvent(a.token, e)
  }

  /** `primary` and the account's email both name the primary calendar. */
  function resolve(acct: Account, id: string): string | null {
    if (acct.calendars.has(id)) return id
    if (id === 'primary' || id === acct.email) return [...acct.calendars.values()].find(c => c.primary)?.id ?? null
    return null
  }

  async function handle(req: Request): Promise<Response | null> {
    const url  = new URL(req.url)
    const path = url.pathname

    // ── controls ───────────────────────────────────────────────────────────
    if (path === '/_sink/calendar' && req.method === 'GET')
      return json({ accounts: [...accounts.values()].map(a => ({ email: a.email, scopes: a.scopes, calendars: [...a.calendars.values()], events: Object.fromEntries([...a.events].map(([c, m]) => [c, [...m.values()]])) })) })
    if (path === '/_sink/calendar/event' && req.method === 'POST') {
      try {
        const body = await req.json() as SinkSeedEvent & { token: string }
        return json(addEvent(body.token, body))
      } catch (e) { return json({ error: (e as Error).message }, 400) }
    }

    const m = /^\/calendar\/v3(\/.*)$/.exec(path)
    if (!m) return null
    const rest = m[1]
    const text = req.method === 'POST' || req.method === 'PATCH' ? await req.text() : ''
    seen.push({ method: req.method, path, query: url.search, headers: Object.fromEntries(req.headers), body: text, at: Date.now(), units: 0 })
    if (armed.delay > 0) await new Promise<void>(resolveWait => {
      const release = () => { clearTimeout(timer); resolveWait() }
      const timer = setTimeout(() => { hanging.splice(hanging.indexOf(release) >>> 0, 1); resolveWait() }, armed.delay)
      hanging.push(release)
    })

    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const acct = accounts.get(bearer) ?? accounts.get(aliases.get(bearer) ?? '')
    if (armed.revoke || !acct) return err(401, 'authError', 'Invalid Credentials')

    if (armed.forbidScope) {
      armed.forbidScope = false
      return err(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', {
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com', metadata: { service: 'calendar-json.googleapis.com' } }],
      })
    }
    if (armed.rateLimit) {
      const { status = 429 } = armed.rateLimit
      armed.rateLimit = null
      return status === 403
        ? err(403, 'rateLimitExceeded', 'Rate Limit Exceeded')
        : err(429, 'rateLimitExceeded', 'Rate Limit Exceeded')
    }
    if (armed.failNext) { armed.failNext = false; return err(500, 'backendError', 'Backend Error') }
    if (armed.outage) return armed.outage.status === 429
      ? err(429, 'rateLimitExceeded', 'Rate Limit Exceeded')
      : err(armed.outage.status, 'backendError', 'Backend Error')

    let json_: Record<string, unknown> | null = {}
    if (text) { try { json_ = JSON.parse(text) } catch { json_ = null } }
    const wants = (method: keyof typeof ACCEPTS) => ACCEPTS[method].some(s => acct.scopes.includes(s))
    const scopeRefused = (method: string) => err(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', {
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com', metadata: { method: `calendar.${method}`, service: 'calendar-json.googleapis.com' } }],
    })

    let answer: Response | null = null

    // ── calendarList ───────────────────────────────────────────────────────
    if (rest === '/users/me/calendarList' && req.method === 'GET') {
      if (!wants('calendarList.list')) return scopeRefused('calendarList.list')
      const max = url.searchParams.has('maxResults') ? Number(url.searchParams.get('maxResults')) : 100
      if (!Number.isInteger(max) || max < 1 || max > LIST_MAX) return invalid('Invalid value for: maxResults')
      const role = url.searchParams.get('minAccessRole')
      if (role && !ROLES.includes(role)) return invalid('Invalid value for: minAccessRole')
      const offset = Number(url.searchParams.get('pageToken') ?? 0)
      const all = [...acct.calendars.values()].filter(c => !role || ROLES.indexOf(c.accessRole) >= ROLES.indexOf(role))
      const page = all.slice(offset, offset + max)
      answer = json({
        kind: 'calendar#calendarList', etag: `"${all.length}"`,
        ...(offset + max < all.length ? { nextPageToken: String(offset + max) } : {}),
        items: page.map(c => ({ kind: 'calendar#calendarListEntry', id: c.id, summary: c.summary, ...(c.primary ? { primary: true } : {}), accessRole: c.accessRole, selected: true, timeZone: c.timeZone })),
      })
    }

    // ── freeBusy ───────────────────────────────────────────────────────────
    else if (rest === '/freeBusy' && req.method === 'POST') {
      if (!wants('freeBusy.query')) return scopeRefused('freeBusy.query')
      const b = json_ as { timeMin?: string; timeMax?: string; items?: Array<{ id?: string }> } | null
      if (!b || !Array.isArray(b.items)) return invalid('Invalid request body')
      const min = Date.parse(b.timeMin ?? ''), max = Date.parse(b.timeMax ?? '')
      if (Number.isNaN(min) || Number.isNaN(max)) return invalid('Invalid value for: timeMin or timeMax')
      if (min >= max) return err(400, 'timeRangeEmpty', 'The specified time range is empty.')
      const unreadable = new Set(Array.isArray(armed.freeBusyNotFound) ? armed.freeBusyNotFound : [])
      armed.freeBusyNotFound = []
      const tooMany = b.items.length > FREEBUSY_ITEMS_MAX
      const calendars: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: Array<{ domain: string; reason: string }> }> = {}
      for (const item of b.items) {
        const id = item.id ?? ''
        const cal = resolve(acct, id)
        if (tooMany) calendars[id] = { errors: [{ domain: 'global', reason: 'tooManyCalendarsRequested' }] }
        else if (!cal || unreadable.has(id)) calendars[id] = { errors: [{ domain: 'global', reason: 'notFound' }] }
        else calendars[id] = { busy: [...acct.events.get(cal)!.values()]
          .filter(e => e.status !== 'cancelled' && e.transparency !== 'transparent')
          .map(e => ({ start: Math.max(Date.parse(e.start.dateTime), min), end: Math.min(Date.parse(e.end.dateTime), max) }))
          .filter(r => r.end > r.start)
          .sort((x, y) => x.start - y.start)
          .map(r => ({ start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() })) }
      }
      answer = json({ kind: 'calendar#freeBusy', timeMin: b.timeMin, timeMax: b.timeMax, calendars })
    }

    // ── events ─────────────────────────────────────────────────────────────
    else if (/^\/calendars\/[^/]+\/events(\/[^/]+)?$/.test(rest)) {
      const parts = rest.split('/')
      const calendarId = resolve(acct, decodeURIComponent(parts[2]))
      const eventId = parts[4] === undefined ? null : decodeURIComponent(parts[4])
      const sendUpdates = url.searchParams.get('sendUpdates')
      if (sendUpdates !== null && !SEND_UPDATES.has(sendUpdates)) return invalid('Invalid value for: sendUpdates')

      if (req.method === 'POST' && eventId === null) {
        if (!wants('events.insert')) return scopeRefused('events.insert')
        if (!calendarId) return notFound()
        const b = json_ as { id?: string; summary?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string }; [k: string]: unknown } | null
        if (!b) return invalid('Invalid request body')
        if (b.id !== undefined && !EVENT_ID.test(b.id)) return invalid('Invalid resource id value.')
        const startMs = Date.parse(b.start?.dateTime ?? ''), endMs = Date.parse(b.end?.dateTime ?? '')
        if (Number.isNaN(startMs) || Number.isNaN(endMs)) return invalid('Missing start or end time.')
        if (startMs >= endMs) return err(400, 'timeRangeEmpty', 'The specified time range is empty.')
        const store = acct.events.get(calendarId)!
        if (b.id !== undefined && store.has(b.id)) return err(409, 'duplicate', 'The requested identifier already exists.')
        const ev = addEvent(acct.token, {
          id: b.id, calendarId, summary: b.summary ?? '', start: b.start!.dateTime!, end: b.end!.dateTime!,
          ...(b.transparency === 'transparent' ? { transparency: 'transparent' as const } : {}),
        })
        for (const k of ['description', 'location', 'attendees'] as const) if (b[k] !== undefined) (ev as unknown as Record<string, unknown>)[k] = b[k]
        if (b.start?.timeZone) ev.start.timeZone = b.start.timeZone
        if (b.end?.timeZone) ev.end.timeZone = b.end.timeZone
        answer = json(ev)
      }

      else if (eventId !== null && req.method === 'GET') {
        if (!wants('events.get')) return scopeRefused('events.get')
        const ev = calendarId ? acct.events.get(calendarId)!.get(eventId) : undefined
        if (!ev) return notFound()
        answer = json(ev)
      }

      else if (eventId !== null && req.method === 'PATCH') {
        if (!wants('events.patch')) return scopeRefused('events.patch')
        const ev = calendarId ? acct.events.get(calendarId)!.get(eventId) : undefined
        if (!ev) return notFound()
        if (ev.status === 'cancelled') return err(410, 'deleted', 'Resource has been deleted')
        if (!json_) return invalid('Invalid request body')
        Object.assign(ev, json_, { id: ev.id, updated: new Date().toISOString(), etag: `"${++counter}"` })
        answer = json(ev)
      }

      else if (eventId !== null && req.method === 'DELETE') {
        if (!wants('events.delete')) return scopeRefused('events.delete')
        const ev = calendarId ? acct.events.get(calendarId)!.get(eventId) : undefined
        if (!ev) return notFound()
        if (ev.status === 'cancelled') return err(410, 'deleted', 'Resource has been deleted')
        ev.status = 'cancelled'
        ev.updated = new Date().toISOString()
        answer = new Response(null, { status: 204 })
      }
    }

    if (!answer) return notFound()

    // A lost answer: applied, never answered. The caller times out with the
    // write possibly landed, which is the `indeterminate` case.
    if (armed.lost) { armed.lost = false; await new Promise<void>(resolveHang => hanging.push(resolveHang)) }
    return answer
  }

  return { accounts, aliases, addEvent, handle }
}
