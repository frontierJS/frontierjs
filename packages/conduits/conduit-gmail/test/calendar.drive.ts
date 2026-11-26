// test/calendar.drive.ts — the Calendar module through a real conduit against the sink.
//
// Run: `bun run drive` (it runs gmail.drive.ts first). Starts its own sink on
// an ephemeral port; no fixture, because no conforming Calendar exists to run.
//
// Every refusal has a control: a local refusal is read off the sink's `seen`
// list as zero attempts and is paired with a near-miss that DOES go out; a
// scope refusal is paired with the same token succeeding at the method it
// holds; the busy filter is paired with an opaque event added mid-test that
// does count. Two rows are findings: a lost insert is replayed by conduit
// (the id makes it replayable) and comes back as `conflict`, which for an
// insert means the first one landed; and Calendar's 403 `quotaExceeded` stays
// `quota` although Google's guide words it "usage limits exceeded".

import { createConduit, type CredentialResolver, type ConduitError } from '@frontierjs/conduit'
import { results, report, control, DRIVE_RESILIENCE } from '../../lib/drive.ts'
import { startGmailSink, type SeenRequest } from '../sink.ts'
import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET } from '../sink-oauth.ts'
import { createHash } from 'node:crypto'
import { translate } from '../src/index.ts'
import {
  calendarTarget, bindCalendarSend, listCalendars, freeBusy, insertEvent, getEvent, patchEvent, deleteEvent, eventIdFor, busyRanges,
  CALENDAR_SCOPES, type FreeBusyAnswer,
} from '../src/calendar.ts'
import { translateCalendar } from '../src/errors.ts'

const { got, t } = results()
const HOST = 'ya29.host', FREEBUSY_ONLY = 'ya29.freebusy-only', EVENTS_ONLY = 'ya29.events-only'
const PRIMARY = 'host@kobami.test', TEAM = 'team@group.calendar.google.com', HOLIDAYS = 'holidays@group.v.calendar.google.com'
const DAY = Date.UTC(2026, 11, 1)
const at = (h: number) => DAY + h * 3_600_000
const hoursOf = (r: { start: number; end: number }) => [(r.start - DAY) / 3_600_000, (r.end - DAY) / 3_600_000]
const RANGE = { timeMin: new Date(at(0)).toISOString(), timeMax: new Date(at(24)).toISOString() }
const slot = (h: number) => ({ start: { dateTime: new Date(at(h)).toISOString() }, end: { dateTime: new Date(at(h + 1)).toISOString() } })
const A = 'https://www.googleapis.com/auth/'

const sink = startGmailSink({ calendar: { accounts: [
  { token: HOST, email: PRIMARY,
    calendars: [{ id: PRIMARY, primary: true, summary: 'Host', timeZone: 'America/Los_Angeles' }, { id: TEAM, summary: 'Team', accessRole: 'writer' }, { id: HOLIDAYS, summary: 'Holidays', accessRole: 'reader' }],
    events: [
      { id: 'seedaaaa1', calendarId: PRIMARY, start: at(10), end: at(11) },
      { id: 'seedaaaa2', calendarId: PRIMARY, start: at(10.5), end: at(12) },
      { id: 'seedaaaa3', calendarId: PRIMARY, start: at(12), end: at(13) },
      { id: 'seedaaaa4', calendarId: PRIMARY, start: at(15), end: at(16), transparency: 'transparent' },
      { id: 'seedaaaa5', calendarId: PRIMARY, start: at(17), end: at(18), status: 'cancelled' },
      { id: 'seedaaaa6', calendarId: TEAM, start: at(14), end: at(15) },
    ] },
  { token: FREEBUSY_ONLY, email: 'fb@kobami.test', scopes: [A + 'calendar.freebusy'] },
  { token: EVENTS_ONLY, email: 'ev@kobami.test', scopes: [A + 'calendar.events.owned'] },
] } })
const ctl = control(sink.url)

// A resolver with `invalidate`, so a 401 is forgotten and replayed once; the count says whether a 403 kept the credential.
let invalidations = 0
const grantFor = (token: string): CredentialResolver => ({ async get(ref) { return ref === 'GOOGLE_CALENDAR_GRANT' ? token : null }, invalidate() { invalidations++ } })
const conduits = [HOST, FREEBUSY_ONLY, EVENTS_ONLY].map(token => createConduit({ credentials: grantFor(token), ...DRIVE_RESILIENCE }))
// The target's own timeout wins over the conduit's, so a lost answer is cut at 800 ms and replayed.
await Promise.all(conduits.map(c => c.register({ ...calendarTarget({ address: sink.url }), resilience: { timeout_ms: 800, retry_limit: 2 } })))
const [send, sendFb, sendEv] = conduits.map(c => bindCalendarSend(c))

type Seen = { requests: SeenRequest[] }
const seen     = () => ctl.seen<never>() as unknown as Promise<Seen>
const requests = async () => (await seen()).requests
const attempts = async () => (await requests()).length
type Store = { accounts: Array<{ email: string; events: Record<string, Array<{ id: string; status: string; summary: string }>> }> }
const store    = () => fetch(`${sink.url}/_sink/calendar`).then(r => r.json()) as Promise<Store>
const eventsNamed = async (id: string) => (await store()).accounts.flatMap(a => Object.values(a.events).flat()).filter(e => e.id === id)
const raw = (token: string, method: string, path: string, body?: unknown) =>
  fetch(`${sink.url}/calendar/v3${path}`, { method, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
const threw = async (fn: () => Promise<unknown>) => { try { await fn(); return false } catch (e) { return e instanceof TypeError } }
const fbOf = (r: Awaited<ReturnType<typeof freeBusy>>) => busyRanges(r.freeBusy!, [])
const failure = (status: number, reason: string, kind: ConduitError['kind'] = 'client_error'): ConduitError =>
  ({ kind, target: 't', protocol: 'http', message: 'x', retryable: false, raw: JSON.stringify({ error: { code: status, message: 'm', errors: [{ domain: 'global', reason }] } }) })

try {
  // ── calendars ────────────────────────────────────────────────────────────
  await ctl.reset()
  const list = await listCalendars(send)
  t('calendar.list.answersEveryCalendar', { ids: list.calendars?.items.map(c => c.id), primary: list.calendars?.items.find(c => c.primary)?.id, ok: !list.error })
  const page1 = await listCalendars(send, { maxResults: 2 })
  const page2 = await listCalendars(send, { maxResults: 2, pageToken: page1.calendars?.nextPageToken })
  const writers = await listCalendars(send, { minAccessRole: 'writer' })
  t('calendar.list.pagesAndFiltersByRole', { first: page1.calendars?.items.length, hasNext: !!page1.calendars?.nextPageToken, second: page2.calendars?.items.length, lastHasNext: !!page2.calendars?.nextPageToken, writers: writers.calendars?.items.map(c => c.id) })
  await ctl.reset()
  const refusedMax = await Promise.all([0, 251, 1.5].map(n => threw(() => listCalendars(send, { maxResults: n }))))
  const refusedAttempts = await attempts()
  const atCeiling = await listCalendars(send, { maxResults: 250 })
  t('calendar.list.maxResultsPastCeilingRefusedBeforeSend', { threw: refusedMax, attempts: refusedAttempts, ceilingItselfGoesOut: !atCeiling.error, afterwards: await attempts() })

  // ── busy time ────────────────────────────────────────────────────────────
  await ctl.reset()
  const busy = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }, { id: TEAM }] })
  const merged = fbOf(busy)
  const bw = (await requests()).at(-1)!
  t('calendar.freeBusy.mergesOverlapAndTouchingAcrossCalendars', { busy: merged.busy.map(hoursOf), unreadable: merged.unreadable, bodyItems: JSON.parse(bw.body).items, scopeFree: !busy.error })
  t('calendar.freeBusy.transparentAndCancelledAreNotBusy', await (async () => {
    const before = fbOf(await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })).busy.map(hoursOf)
    await fetch(`${sink.url}/_sink/calendar/event`, { method: 'POST', body: JSON.stringify({ token: HOST, calendarId: PRIMARY, start: at(15), end: at(16), summary: 'Walk-in' }) })
    const after = fbOf(await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })).busy.map(hoursOf)
    return { before, after }
  })())
  const half = fbOf(await freeBusy(send, { timeMin: new Date(at(11)).toISOString(), timeMax: new Date(at(11.5)).toISOString(), items: [{ id: PRIMARY }] }))
  t('calendar.freeBusy.clipsToTheRange', { busy: half.busy.map(hoursOf) })

  const gone = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }, { id: 'nobody@nowhere.test' }] })
  const goneRead = busyRanges(gone.freeBusy!, [PRIMARY, 'nobody@nowhere.test'])
  await ctl.arm({ freeBusyNotFound: [PRIMARY] })
  const hidden = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })
  const hiddenRead = busyRanges(hidden.freeBusy!, [PRIMARY])
  t('calendar.freeBusy.unreadableCalendarIsReportedNotFree', {
    http200: !gone.error, unknown: goneRead.unreadable, othersStillRead: goneRead.busy.length > 0,
    seededButUnreadable: hiddenRead.unreadable, busyWhenUnreadable: hiddenRead.busy.length,
  })

  const answer = (calendars: FreeBusyAnswer['calendars']) => ({ calendars })
  const iso = (h: number) => new Date(at(h)).toISOString()
  const pure = busyRanges(answer({
    a: { busy: [{ start: iso(9), end: iso(10) }, { start: iso(3), end: iso(5) }] },
    b: { busy: [{ start: iso(5), end: iso(6) }, { start: iso(9.5), end: iso(9.75) }, { start: iso(20), end: iso(20) }] },
    c: { errors: [{ domain: 'global', reason: 'groupTooBig' }] },
    d: { errors: [{ domain: 'global', reason: 'aReasonGoogleAddsLater' }], busy: [{ start: iso(1), end: iso(2) }] },
    e: { busy: [{ start: 'not a date', end: iso(2) }] },
  }), ['a', 'b', 'c', 'd', 'e', 'f'])
  t('calendar.busyRanges.sortsMergesAndNeverCallsUnreadableFree', {
    busy: pure.busy.map(hoursOf), unreadable: pure.unreadable,
    gapStaysOpen: pure.busy.every(r => r.end <= at(6) || r.start >= at(9)),
  })

  await ctl.reset()
  const raws = await Promise.all([
    raw(HOST, 'POST', '/freeBusy', { timeMin: iso(5), timeMax: iso(5), items: [{ id: PRIMARY }] }).then(async r => [r.status, (await r.json()).error.errors[0].reason]),
    raw(HOST, 'POST', '/freeBusy', { timeMin: iso(6), timeMax: iso(5), items: [{ id: PRIMARY }] }).then(async r => [r.status, (await r.json()).error.errors[0].reason]),
    raw(HOST, 'POST', '/freeBusy', { ...RANGE, items: Array.from({ length: 51 }, () => ({ id: PRIMARY })) }).then(async r => [r.status, Object.values((await r.json()).calendars as FreeBusyAnswer['calendars']).map(c => c.errors?.[0].reason)[0]]),
    raw(HOST, 'POST', '/freeBusy', { ...RANGE, items: Array.from({ length: 50 }, () => ({ id: PRIMARY })) }).then(async r => [r.status, 'busy' in (Object.values((await r.json()).calendars)[0] as object)]),
  ])
  t('calendar.sink.refusesWhatGoogleRefuses', { equalRange: raws[0], reversedRange: raws[1], fiftyOne: raws[2], fiftyIsFine: raws[3] })

  await ctl.reset()
  const refusals = await Promise.all([
    threw(() => freeBusy(send, { timeMin: iso(5), timeMax: iso(5), items: [{ id: PRIMARY }] })),
    threw(() => freeBusy(send, { timeMin: iso(6), timeMax: iso(5), items: [{ id: PRIMARY }] })),
    threw(() => freeBusy(send, { timeMin: 'tomorrow', timeMax: iso(5), items: [{ id: PRIMARY }] })),
    threw(() => freeBusy(send, { ...RANGE, items: [] })),
    threw(() => freeBusy(send, { ...RANGE, items: Array.from({ length: 51 }, (_, i) => ({ id: `c${i}` })) })),
  ])
  const beforeControl = await attempts()
  const fifty = await freeBusy(send, { ...RANGE, items: Array.from({ length: 50 }, (_, i) => ({ id: i ? `c${i}` : PRIMARY })) })
  t('calendar.freeBusy.refusedBeforeSend', { threw: refusals, attempts: beforeControl, fiftyGoesOut: !fifty.error, afterwards: await attempts() })

  // ── event ids ────────────────────────────────────────────────────────────
  const a = eventIdFor('booking-1'), b = eventIdFor('booking-2'), r2 = eventIdFor('booking-1', 'r2'), r3 = eventIdFor('booking-1', 'r3')
  t('calendar.eventIdFor.deterministicValidAndDistinct', {
    same: a === eventIdFor('booking-1'), alphabet: /^[a-v0-9]{32}$/.test(a), distinctBooking: a !== b, distinctGeneration: new Set([a, r2, r3]).size,
    generationAlphabet: /^[a-v0-9]{32}$/.test(r2), emptyRefused: await threw(async () => eventIdFor('')),
  })

  // ── insert ───────────────────────────────────────────────────────────────
  await ctl.reset()
  const id1 = eventIdFor('booking-1')
  const made = await insertEvent(send, { calendarId: PRIMARY, id: id1, summary: 'Consult', description: 'Intro call', location: 'Zoom', ...slot(8), attendees: [{ email: 'guest@example.test' }] })
  const wire = (await requests()).at(-1)!
  const wireBody = JSON.parse(wire.body)
  t('calendar.insert.landsWithSendUpdatesNoneOnTheWire', {
    ok: !made.error, id: made.event?.id === id1, status: made.event?.status, sendUpdates: new URL(`http://x${wire.path}${wire.query}`).searchParams.get('sendUpdates'),
    idOnWire: wireBody.id === id1, pathEncoded: wire.path.includes('/calendars/host%40kobami.test/events'), attendees: made.event?.attendees?.length, one: (await eventsNamed(id1)).length,
  })
  const viaPrimary = await insertEvent(send, { calendarId: 'primary', id: eventIdFor('booking-3'), summary: 'Alias', ...slot(9), sendUpdates: 'all' })
  const aliasWire = (await requests()).at(-1)!
  t('calendar.insert.primaryAliasAndExplicitSendUpdates', { ok: !viaPrimary.error, sendUpdates: aliasWire.query, onPrimary: (await eventsNamed(eventIdFor('booking-3'))).length })
  const gotBack = await getEvent(send, { calendarId: PRIMARY, eventId: id1 })
  t('calendar.getEvent.readsWhatWasInserted', { summary: gotBack.event?.summary, location: gotBack.event?.location, status: gotBack.event?.status })

  await ctl.reset()
  const bad = await Promise.all(['ABCDE12345', 'abcd', 'wxyz1', 'a'.repeat(1025), 'abc-de', ''].map(id => threw(() => insertEvent(send, { calendarId: PRIMARY, id, summary: 'x', ...slot(1) }))))
  const badAttempts = await attempts()
  const five = await insertEvent(send, { calendarId: PRIMARY, id: 'abcde', summary: 'x', ...slot(1) })
  const longest = await insertEvent(send, { calendarId: PRIMARY, id: 'a'.repeat(1024), summary: 'x', ...slot(2) })
  t('calendar.insert.badEventIdRefusedBeforeSend', { threw: bad, attempts: badAttempts, fiveCharsGoOut: !five.error, longestGoesOut: !longest.error })
  const raw400 = await raw(HOST, 'POST', `/calendars/${encodeURIComponent(PRIMARY)}/events`, { id: 'BAD-ID', summary: 'x', ...slot(3) })
  t('calendar.sink.refusesABadEventId', { status: raw400.status, reason: (await raw400.json()).error.errors[0].reason })

  const again = await insertEvent(send, { calendarId: PRIMARY, id: id1, summary: 'Consult again', ...slot(8) })
  t('calendar.insert.reusedIdIsConflictNotRetried', { kind: again.error?.kind, retryable: again.error?.retryable, reason: again.error?.reason, still: (await eventsNamed(id1)).map(e => e.summary) })

  // ── a lost answer ────────────────────────────────────────────────────────
  await ctl.reset()
  const idLost = eventIdFor('booking-lost')
  await ctl.arm({ lost: true })
  const lost = await insertEvent(send, { calendarId: PRIMARY, id: idLost, summary: 'Lost answer', ...slot(5) })
  const lostAttempts = await attempts()
  await ctl.reset()
  t('calendar.insert.lostAnswerIsReplayedToConflictAndOneEventExists', { kind: lost.error?.kind, attempts: lostAttempts, events: (await eventsNamed(idLost)).length })
  const settled = await getEvent(send, { calendarId: PRIMARY, eventId: idLost })
  t('calendar.getEvent.settlesALostInsert', { found: !!settled.event, status: settled.event?.status, summary: settled.event?.summary })

  // ── delete, patch ────────────────────────────────────────────────────────
  await ctl.reset()
  const idDel = eventIdFor('booking-del')
  await insertEvent(send, { calendarId: PRIMARY, id: idDel, summary: 'Cancel me', ...slot(6) })
  await ctl.reset()
  const del1 = await deleteEvent(send, { calendarId: PRIMARY, eventId: idDel })
  const del1Wire = (await requests()).at(-1)!
  const del2 = await deleteEvent(send, { calendarId: PRIMARY, eventId: idDel })
  t('calendar.delete.secondDeleteIsAlreadyGoneNotAnError', { first: del1, second: del2, sendUpdates: del1Wire.query })
  const tomb = await getEvent(send, { calendarId: PRIMARY, eventId: idDel })
  t('calendar.getEvent.deletedStaysAsCancelledTombstone', { status: tomb.event?.status, error: tomb.error?.kind })

  const idWire = eventIdFor('booking-wire')
  await insertEvent(send, { calendarId: PRIMARY, id: idWire, summary: 'Wire', ...slot(7) })
  const w1 = await raw(HOST, 'DELETE', `/calendars/${encodeURIComponent(PRIMARY)}/events/${idWire}`)
  const w1Body = await w1.text()
  const w2 = await raw(HOST, 'DELETE', `/calendars/${encodeURIComponent(PRIMARY)}/events/${idWire}`)
  const w2Reason = (await w2.json()).error.errors[0].reason
  const w3 = await raw(HOST, 'DELETE', `/calendars/${encodeURIComponent(PRIMARY)}/events/neverexisted`)
  t('calendar.sink.deleteWireShapes', { firstStatus: w1.status, firstBody: w1Body, secondStatus: w2.status, secondReason: w2Reason, neverStatus: w3.status })

  const never = await getEvent(send, { calendarId: PRIMARY, eventId: 'neverexisted' })
  const neverDel = await deleteEvent(send, { calendarId: PRIMARY, eventId: 'neverexisted' })
  t('calendar.neverExisted.is404Gone', { get: never.error?.kind, getRetryable: never.error?.retryable, delete: neverDel })

  const sameId = await insertEvent(send, { calendarId: PRIMARY, id: idDel, summary: 'Rebooked', ...slot(6) })
  const fresh = await insertEvent(send, { calendarId: PRIMARY, id: eventIdFor('booking-del', 'r2'), summary: 'Rebooked', ...slot(6) })
  t('calendar.insert.deletedIdStaysTakenFreshGenerationLands', { sameId: sameId.error?.kind, fresh: !fresh.error, freshId: fresh.event?.id === eventIdFor('booking-del', 'r2') })

  const idDelLost = eventIdFor('booking-del-lost')
  await insertEvent(send, { calendarId: PRIMARY, id: idDelLost, summary: 'Lost delete', ...slot(4) })
  await ctl.reset()
  await ctl.arm({ lost: true })
  const delLost = await deleteEvent(send, { calendarId: PRIMARY, eventId: idDelLost })
  const delLostAttempts = await attempts()
  await ctl.reset()
  t('calendar.delete.lostAnswerReplayedIsAlreadyGone', { answer: delLost, attempts: delLostAttempts, status: (await eventsNamed(idDelLost)).map(e => e.status) })

  await ctl.reset()
  const patched = await patchEvent(send, { calendarId: PRIMARY, eventId: id1, patch: { summary: 'Moved', ...{ start: slot(13).start, end: slot(13).end } } })
  const patchWire = (await requests()).at(-1)!
  t('calendar.patch.changesOnlyTheFieldsGiven', { summary: patched.event?.summary, location: patched.event?.location, start: patched.event?.start?.dateTime === slot(13).start.dateTime, sendUpdates: patchWire.query, method: patchWire.method })
  const patchGone = await patchEvent(send, { calendarId: PRIMARY, eventId: idDel, patch: { summary: 'Too late' } })
  await ctl.reset()
  t('calendar.patch.deletedEventIsGoneAndEmptyPatchRefusedBeforeSend', { gone: patchGone.error?.kind, emptyThrew: await threw(() => patchEvent(send, { calendarId: PRIMARY, eventId: id1, patch: {} })), attempts: await attempts() })

  // ── the credential and its limits ────────────────────────────────────────
  await ctl.reset()
  const kept = invalidations
  await ctl.arm({ forbidScope: true })
  const scope = await patchEvent(send, { calendarId: PRIMARY, eventId: id1, patch: { summary: 'x' } })
  t('calendar.forbidScope.isForbiddenWithScopeMissing', { kind: scope.error?.kind, scopeMissing: scope.error?.scopeMissing, reason: scope.error?.reason, credentialKept: invalidations === kept, attempts: await attempts() })

  await ctl.reset()
  const noFreeBusy = await freeBusy(sendEv, { ...RANGE, items: [{ id: 'ev@kobami.test' }] })
  const noInsert = await insertEvent(sendFb, { calendarId: 'primary', id: eventIdFor('nope'), summary: 'x', ...slot(1) })
  const evCan = await insertEvent(sendEv, { calendarId: 'primary', id: eventIdFor('events-scope'), summary: 'x', ...slot(1) })
  const fbCan = await freeBusy(sendFb, { ...RANGE, items: [{ id: 'primary' }] })
  const noList = await listCalendars(sendFb)
  t('calendar.scope.aTokenWithoutTheMethodsScopeIsRefused', {
    freeBusyWithEventsScope: [noFreeBusy.error?.kind, noFreeBusy.error?.scopeMissing, noFreeBusy.error?.reason],
    insertWithFreeBusyScope: [noInsert.error?.kind, noInsert.error?.scopeMissing],
    listWithFreeBusyScope:   [noList.error?.kind, noList.error?.scopeMissing],
    eventsScopeInserts: !evCan.error, freeBusyScopeReads: !fbCan.error, nothingStored: (await eventsNamed(eventIdFor('nope'))).length,
    threeScopes: CALENDAR_SCOPES.length,
  })

  await ctl.reset()
  await ctl.arm({ rateLimit: { status: 429 } })
  const r429 = await patchEvent(send, { calendarId: PRIMARY, eventId: id1, patch: { summary: 'y' } })
  const r429Attempts = await attempts()
  await ctl.reset()
  await ctl.arm({ rateLimit: { status: 403 } })
  const r403 = await patchEvent(send, { calendarId: PRIMARY, eventId: id1, patch: { summary: 'z' } })
  t('calendar.rateLimitExceeded.is429OrA403AndBothAreRateLimited', {
    as429: [r429.error?.kind, r429.error?.reason, r429.error?.retryable, r429.error?.retryAfterMs, r429Attempts],
    as403: [r403.error?.kind, r403.error?.reason, r403.error?.retryable, r403.error?.retryAfterMs, await attempts()], credentialKept: invalidations === kept,
  })
  await ctl.reset()
  await ctl.arm({ rateLimit: { status: 429 } })
  const paced = await listCalendars(send)
  t('calendar.rateLimit.getIsRetriedByConduit', { ok: !paced.error, attempts: await attempts() })

  await ctl.reset()
  await ctl.arm({ revoke: true })
  const revoked = await listCalendars(send)
  t('calendar.revoked.isAuthFailedOnce', { kind: revoked.error?.kind, attempts: await attempts(), invalidated: invalidations - kept })
  await ctl.reset()

  // ── a slow Calendar and a down one, each lasting until disarmed ──────────
  await ctl.arm({ delay: 300 })
  const slowFrom = Date.now()
  const slow = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })
  const slowMs = Date.now() - slowFrom
  await ctl.arm({ delay: 0 })
  const quickFrom = Date.now()
  await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })
  t('calendar.delay.everyAnswerWaitsUntilDisarmed', { answered: !slow.error, waited: slowMs >= 300, quickAfter: Date.now() - quickFrom < 300 })
  await ctl.reset()
  // A caller racing its own deadline: without these the call runs on behind it
  // for the target's 800 ms per attempt, three attempts. A request cannot lower
  // the retry count, so `timeoutMs` alone still pays the backoff between
  // attempts; `signal` is the bound on the whole call.
  await ctl.arm({ delay: 5_000 })
  const hungFrom = Date.now()
  const perAttempt = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] }, { timeoutMs: 100 })
  const perAttemptMs = Date.now() - hungFrom
  const hungAttempts = await attempts()
  const cutFrom = Date.now()
  const cut = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] }, { signal: AbortSignal.timeout(150) })
  const cutMs = Date.now() - cutFrom
  await ctl.reset()
  t('calendar.callOptions.aHungSinkAnswersWithinTheCallersBound', {
    perAttempt: perAttempt.error?.kind, attempts: hungAttempts, underThreeTargetAttempts: perAttemptMs < 3 * 800,
    whole: cut.error?.kind, wholeWithin: cutMs < 400,
  })
  await ctl.arm({ outage: { status: 503 } })
  const down = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })
  const downAttempts = await attempts()
  const stillDown = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })
  await ctl.arm({ outage: { status: 429 } })
  const limited = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })
  await ctl.arm({ outage: null })
  const up = await freeBusy(send, { ...RANGE, items: [{ id: PRIMARY }] })
  t('calendar.outage.everyAttemptFailsUntilDisarmed', { down: down.error?.kind, attempts: downAttempts, stillDown: stillDown.error?.kind, limited: limited.error?.kind, upAfter: !up.error })
  await ctl.reset()

  // ── the error table, over the status and the reason ──────────────────────
  const k = (status: number, reason: string, kind?: ConduitError['kind']) => { const f = translateCalendar(failure(status, reason, kind), status); return [f.kind, f.retryable, ...(f.scopeMissing ? ['scopeMissing'] : [])] }
  t('calendar.errors.statusAndReasonTable', {
    duplicate:          k(409, 'duplicate'),
    fullSyncRequired:   k(410, 'fullSyncRequired'),
    updatedMinTooLong:  k(410, 'updatedMinTooLongAgo'),
    deleted:            k(410, 'deleted'),
    unknown410:         k(410, 'somethingNew'),
    notFound:           k(404, 'notFound', 'client_error'),
    nonOrganizer:       k(403, 'forbiddenForNonOrganizer', 'auth_failed'),
    userRate403:        k(403, 'userRateLimitExceeded', 'auth_failed'),
    rate403:            k(403, 'rateLimitExceeded', 'auth_failed'),
    rate429:            k(429, 'rateLimitExceeded', 'rate_limited'),
    quotaExceeded:      k(403, 'quotaExceeded', 'auth_failed'),
    timeRangeEmpty:     k(400, 'timeRangeEmpty'),
  })
  const mail409 = translate(failure(409, 'duplicate'), 409), mail410 = translate(failure(410, 'deleted'), 410)
  t('calendar.errors.mailKeepsItsOwnReading', { mail409: mail409.kind, mail410: mail410.kind, mail404: translate(failure(404, 'notFound'), 404).kind, mailQuota: translate(failure(403, 'quotaExceeded', 'auth_failed'), 403).kind })

  // ── the OAuth stand-in: Connect, refresh and revoke on the same listener ──
  await fetch(`${sink.url}/_sink/reset`)
  const REDIRECT = 'http://127.0.0.1:1/api/auth/oauth/google-calendar/callback'
  const VERIFIER = 'v'.repeat(43)
  const challenge = createHash('sha256').update(VERIFIER).digest('base64url')
  const authorize = async (extra: Record<string, string>) => {
    const q = new URLSearchParams({ client_id: OAUTH_CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: ['openid', 'email', ...CALENDAR_SCOPES].join(' '), state: 'st', code_challenge: challenge, code_challenge_method: 'S256', login_hint: PRIMARY, ...extra })
    const r = await fetch(`${sink.url}/o/oauth2/v2/auth?${q}`, { redirect: 'manual' })
    const back = new URL(r.headers.get('location') ?? 'http://x/')
    return { status: r.status, code: back.searchParams.get('code') ?? '', state: back.searchParams.get('state'), lands: back.pathname.endsWith('/callback') }
  }
  const token = async (form: Record<string, string>, basic = false) => {
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    if (basic) headers.authorization = `Basic ${btoa(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`)}`
    const body = new URLSearchParams(basic ? form : { client_id: OAUTH_CLIENT_ID, client_secret: OAUTH_CLIENT_SECRET, ...form })
    const r = await fetch(`${sink.url}/o/oauth2/token`, { method: 'POST', headers, body })
    return { status: r.status, body: await r.json() as Record<string, string> }
  }
  const calendarsWith = async (bearer: string) => (await fetch(`${sink.url}/calendar/v3/users/me/calendarList`, { headers: { authorization: `Bearer ${bearer}` } })).status
  const userinfoWith  = async (bearer: string) => (await fetch(`${sink.url}/o/oauth2/userinfo`, { headers: { authorization: `Bearer ${bearer}` } }))

  const off = await authorize({ access_type: 'offline', prompt: 'consent' })
  const offTokens = await token({ grant_type: 'authorization_code', code: off.code, redirect_uri: REDIRECT, code_verifier: VERIFIER })
  const me = await (await userinfoWith(offTokens.body.access_token)).json() as { email: string; email_verified: boolean }
  const replay = await token({ grant_type: 'authorization_code', code: off.code, redirect_uri: REDIRECT, code_verifier: VERIFIER })
  t('oauth.code.offlineGetsARefreshTokenWhoseAccessTokenReadsCalendars', {
    redirect: off.status, state: off.state, lands: off.lands, status: offTokens.status, refresh: !!offTokens.body.refresh_token, type: offTokens.body.token_type,
    calendars: await calendarsWith(offTokens.body.access_token), email: me.email, verified: me.email_verified, codeSpent: replay.body.error,
  })

  const on = await authorize({})
  const onTokens = await token({ grant_type: 'authorization_code', code: on.code, redirect_uri: REDIRECT, code_verifier: VERIFIER })
  const wrongV = await authorize({ access_type: 'offline' })
  const badVerifier = await token({ grant_type: 'authorization_code', code: wrongV.code, redirect_uri: REDIRECT, code_verifier: 'w'.repeat(43) })
  const badClient = await token({ grant_type: 'authorization_code', code: 'x', redirect_uri: REDIRECT, code_verifier: VERIFIER, client_secret: 'wrong' })
  t('oauth.code.onlineHasNoRefreshTokenAndAWrongVerifierOrSecretIsRefused', { refresh: 'refresh_token' in onTokens.body, verifier: badVerifier.body.error, client: [badClient.status, badClient.body.error] })

  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: offTokens.body.refresh_token }, true)
  t('oauth.refresh.basicAuthMintsAFreshTokenAndNeverRotates', { status: refreshed.status, fresh: refreshed.body.access_token !== offTokens.body.access_token, rotated: 'refresh_token' in refreshed.body, calendars: await calendarsWith(refreshed.body.access_token) })

  const userRevoked = await (await fetch(`${sink.url}/_sink/oauth/revoke`, { method: 'POST', body: JSON.stringify({ email: PRIMARY }) })).json() as { revoked: number }
  const dead = await token({ grant_type: 'refresh_token', refresh_token: offTokens.body.refresh_token })
  t('oauth.revoke.byTheUserKillsTheGrantAndEveryTokenItMinted', { revoked: userRevoked.revoked, refresh: [dead.status, dead.body.error], calendars: await calendarsWith(refreshed.body.access_token), userinfo: (await userinfoWith(refreshed.body.access_token)).status, seededStillWorks: await calendarsWith(HOST) })

  const reconnect = await authorize({ access_type: 'offline', prompt: 'consent' })
  const reTokens = await token({ grant_type: 'authorization_code', code: reconnect.code, redirect_uri: REDIRECT, code_verifier: VERIFIER })
  const revokeOnce = async () => { const r = await fetch(`${sink.url}/o/oauth2/revoke`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: reTokens.body.refresh_token }) }); return [r.status, (await r.json() as { error?: string }).error ?? null] }
  const first = await revokeOnce(), second = await revokeOnce()
  t('oauth.revoke.endpointTakesTheRefreshTokenOnce', { first, second, calendars: await calendarsWith(reTokens.body.access_token), seen: (await seen()).requests.filter(r => r.path === '/o/oauth2/revoke').length })
} catch (e) {
  console.error('\nThe drive threw:', (e as Error).stack)
  got.__threw = String((e as Error).message)
} finally {
  sink.stop(); await Promise.all(conduits.map(c => c.destroy()))
}

process.exit(report(got, {
  'calendar.list.answersEveryCalendar':                              { ids: ['host@kobami.test', 'team@group.calendar.google.com', 'holidays@group.v.calendar.google.com'], primary: 'host@kobami.test', ok: true },
  'calendar.list.pagesAndFiltersByRole':                             { first: 2, hasNext: true, second: 1, lastHasNext: false, writers: ['host@kobami.test', 'team@group.calendar.google.com'] },
  'calendar.list.maxResultsPastCeilingRefusedBeforeSend':            { threw: [true, true, true], attempts: 0, ceilingItselfGoesOut: true, afterwards: 1 },
  'calendar.freeBusy.mergesOverlapAndTouchingAcrossCalendars':       { busy: [[10, 13], [14, 15]], unreadable: [], bodyItems: [{ id: 'host@kobami.test' }, { id: 'team@group.calendar.google.com' }], scopeFree: true },
  'calendar.freeBusy.transparentAndCancelledAreNotBusy':             { before: [[10, 13]], after: [[10, 13], [15, 16]] },
  'calendar.freeBusy.clipsToTheRange':                               { busy: [[11, 11.5]] },
  'calendar.freeBusy.unreadableCalendarIsReportedNotFree':           { http200: true, unknown: [{ calendarId: 'nobody@nowhere.test', reason: 'notFound' }], othersStillRead: true, seededButUnreadable: [{ calendarId: 'host@kobami.test', reason: 'notFound' }], busyWhenUnreadable: 0 },
  'calendar.busyRanges.sortsMergesAndNeverCallsUnreadableFree':      { busy: [[1, 2], [3, 6], [9, 10]], unreadable: [{ calendarId: 'c', reason: 'groupTooBig' }, { calendarId: 'd', reason: 'aReasonGoogleAddsLater' }, { calendarId: 'e', reason: 'invalidRange' }, { calendarId: 'f', reason: 'missing' }], gapStaysOpen: true },
  'calendar.sink.refusesWhatGoogleRefuses':                          { equalRange: [400, 'timeRangeEmpty'], reversedRange: [400, 'timeRangeEmpty'], fiftyOne: [200, 'tooManyCalendarsRequested'], fiftyIsFine: [200, true] },
  'calendar.freeBusy.refusedBeforeSend':                             { threw: [true, true, true, true, true], attempts: 0, fiftyGoesOut: true, afterwards: 1 },
  'calendar.eventIdFor.deterministicValidAndDistinct':               { same: true, alphabet: true, distinctBooking: true, distinctGeneration: 3, generationAlphabet: true, emptyRefused: true },
  'calendar.insert.landsWithSendUpdatesNoneOnTheWire':               { ok: true, id: true, status: 'confirmed', sendUpdates: 'none', idOnWire: true, pathEncoded: true, attendees: 1, one: 1 },
  'calendar.insert.primaryAliasAndExplicitSendUpdates':              { ok: true, sendUpdates: '?sendUpdates=all', onPrimary: 1 },
  'calendar.getEvent.readsWhatWasInserted':                          { summary: 'Consult', location: 'Zoom', status: 'confirmed' },
  'calendar.insert.badEventIdRefusedBeforeSend':                     { threw: [true, true, true, true, true, true], attempts: 0, fiveCharsGoOut: true, longestGoesOut: true },
  'calendar.sink.refusesABadEventId':                                { status: 400, reason: 'invalid' },
  'calendar.insert.reusedIdIsConflictNotRetried':                    { kind: 'conflict', retryable: false, reason: 'duplicate', still: ['Consult'] },
  'calendar.insert.lostAnswerIsReplayedToConflictAndOneEventExists': { kind: 'conflict', attempts: 2, events: 1 },
  'calendar.getEvent.settlesALostInsert':                            { found: true, status: 'confirmed', summary: 'Lost answer' },
  'calendar.delete.secondDeleteIsAlreadyGoneNotAnError':             { first: { deleted: true }, second: { deleted: true, already: true }, sendUpdates: '?sendUpdates=none' },
  'calendar.getEvent.deletedStaysAsCancelledTombstone':              { status: 'cancelled' },
  'calendar.sink.deleteWireShapes':                                  { firstStatus: 204, firstBody: '', secondStatus: 410, secondReason: 'deleted', neverStatus: 404 },
  'calendar.neverExisted.is404Gone':                                 { get: 'gone', getRetryable: false, delete: { deleted: true, already: true } },
  'calendar.insert.deletedIdStaysTakenFreshGenerationLands':         { sameId: 'conflict', fresh: true, freshId: true },
  'calendar.delete.lostAnswerReplayedIsAlreadyGone':                 { answer: { deleted: true, already: true }, attempts: 2, status: ['cancelled'] },
  'calendar.patch.changesOnlyTheFieldsGiven':                        { summary: 'Moved', location: 'Zoom', start: true, sendUpdates: '?sendUpdates=none', method: 'PATCH' },
  'calendar.patch.deletedEventIsGoneAndEmptyPatchRefusedBeforeSend': { gone: 'gone', emptyThrew: true, attempts: 0 },
  'calendar.forbidScope.isForbiddenWithScopeMissing':                { kind: 'forbidden', scopeMissing: true, reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', credentialKept: true, attempts: 1 },
  'calendar.scope.aTokenWithoutTheMethodsScopeIsRefused':            { freeBusyWithEventsScope: ['forbidden', true, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'], insertWithFreeBusyScope: ['forbidden', true], listWithFreeBusyScope: ['forbidden', true], eventsScopeInserts: true, freeBusyScopeReads: true, nothingStored: 0, threeScopes: 3 },
  'calendar.rateLimitExceeded.is429OrA403AndBothAreRateLimited':     { as429: ['rate_limited', 'rateLimitExceeded', true, 1000, 1], as403: ['rate_limited', 'rateLimitExceeded', true, 1000, 1], credentialKept: true },
  'calendar.rateLimit.getIsRetriedByConduit':                        { ok: true, attempts: 2 },
  'calendar.revoked.isAuthFailedOnce':                               { kind: 'auth_failed', attempts: 2, invalidated: 1 },
  'calendar.delay.everyAnswerWaitsUntilDisarmed':                    { answered: true, waited: true, quickAfter: true },
  'calendar.callOptions.aHungSinkAnswersWithinTheCallersBound':      { perAttempt: 'timeout', attempts: 3, underThreeTargetAttempts: true, whole: 'aborted', wholeWithin: true },
  'calendar.outage.everyAttemptFailsUntilDisarmed':                  { down: 'server_error', attempts: 3, stillDown: 'server_error', limited: 'rate_limited', upAfter: true },
  'calendar.errors.statusAndReasonTable':                            { duplicate: ['conflict', false], fullSyncRequired: ['sync_reset', false], updatedMinTooLong: ['sync_reset', false], deleted: ['gone', false], unknown410: ['refused', false], notFound: ['gone', false], nonOrganizer: ['forbidden', false], userRate403: ['rate_limited', true], rate403: ['rate_limited', true], rate429: ['rate_limited', true], quotaExceeded: ['quota', false], timeRangeEmpty: ['refused', false] },
  'calendar.errors.mailKeepsItsOwnReading':                          { mail409: 'refused', mail410: 'refused', mail404: 'gone', mailQuota: 'quota' },
  'oauth.code.offlineGetsARefreshTokenWhoseAccessTokenReadsCalendars':   { redirect: 302, state: 'st', lands: true, status: 200, refresh: true, type: 'Bearer', calendars: 200, email: 'host@kobami.test', verified: true, codeSpent: 'invalid_grant' },
  'oauth.code.onlineHasNoRefreshTokenAndAWrongVerifierOrSecretIsRefused': { refresh: false, verifier: 'invalid_grant', client: [401, 'invalid_client'] },
  'oauth.refresh.basicAuthMintsAFreshTokenAndNeverRotates':             { status: 200, fresh: true, rotated: false, calendars: 200 },
  'oauth.revoke.byTheUserKillsTheGrantAndEveryTokenItMinted':           { revoked: 2, refresh: [400, 'invalid_grant'], calendars: 401, userinfo: 401, seededStillWorks: 200 },
  'oauth.revoke.endpointTakesTheRefreshTokenOnce':                      { first: [200, null], second: [400, 'invalid_token'], calendars: 401, seen: 2 },
}))
