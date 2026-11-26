---
id: google-calendar
status: proposed
dated: 2026-11-26
---

# Google Calendar for a host — read their busy time, write their bookings

**Status: PROPOSED.** Dated 2026-11-26. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The calendly prototype (`fjs-prototypes/calendly`, stressor) offers slots from
its own `AvailabilityRule`s and `Booking`s only. A host whose dentist
appointment is in Google Calendar gets booked over it, and a booking never
shows up in their calendar except as the `.ics` mail. Its `PLAN.md` Phase 7
names this as the one piece left out, by `IDEAS/stressors.md`'s own rule. This
plan builds it as framework work with calendly as the first caller.

## What exists, and what is missing

| Need | Owner today | State |
| --- | --- | --- |
| "Connect Google" button → consent → callback → store tokens on a row | `@frontierjs/auth` `purpose: 'grant'`, `app.oauth.beginGrant`, `onGrant` (`FJS-D1313`) | Built and unit-tested. **No app calls `beginGrant` yet**; no real provider has answered it |
| Refresh the access token, fail closed on `invalid_grant` | `conduit-oidc` `oidcTokenResolver` + `GrantStore` | Built; sink + panva fixture. No real Google refresh yet |
| Google's error envelope (`reason` strings, the four 403s) | `conduit-gmail` `translate` | Built for Gmail; Calendar speaks the same envelope |
| Calendar API calls (free/busy, events, calendar list, watch) | — | **Missing** |
| A Calendar sink + drive | — | **Missing** |
| Slots minus the host's Google busy time; a booking written to their calendar | calendly | **Missing** |
| Push channels + sync tokens (a mirrored calendar) | — | Missing; Phase 5, only if Phase 3 measures a need |

Where it goes is ruled: `FJS-D1917` keeps `conduit-gmail` as the package for
the USER's delegated Google grant and says *calendar and drive join it as
modules if they ride the same token*. So the connector is
`@frontierjs/conduit-gmail/calendar` (Q1 asks whether to rename the package now
that it holds more than mail). `conduit-google` stays the project-credential
products (Maps, FCM). **This departs from the ruling's letter**: calendar does
not ride the *same* token as mail, since its grant is separate (next paragraph).
It keeps the ruling's sense, which is one package per kind of credential, here
the user's delegated grant. Q1's ruling records that.

**One grant per purpose, not per Google account.** The calendar grant asks for
calendar scopes only. `gmail.modify` is a *restricted* scope (Google's security
assessment); the calendar scopes are *sensitive* (app verification, no
assessment). A host who connects a calendar is never asked for their mail.

## The design in one paragraph

Read busy time **live** with `freeBusy.query` when the public page asks for
slots, cached a short while per host, and re-check it inside `book()` before the
insert. Write a booking to the host's calendar **after** the commit, as a job,
with an event id derived from the booking id, so a retry or a lost answer can
never make two events. The overlap between two Bookings stays litestone's
`@@exclude` (`FJS-D474`); a Google busy range is a second, softer check, because
no database constraint can see another system's calendar: between the re-check
and the insert, the host can add a Google event, and nothing closes that window.
Because the event id is derived, it is never stored. Mirroring the
calendar (push channels + sync tokens) is Phase 5 and runs only if the live read
turns out too slow or too costly to call.

---

### Phase 0 — Facts and a credential

Goal: Google's behavior checked against its docs and one real token answering.
Done when: 0.3's two curl calls answer with a real host's busy range and a
created-then-deleted event.

- [x] 0.1 Check Google's facts against developers.google.com and write them in
      the connector's README the way `conduit-gmail` did: the narrowest scopes
      (`calendar.freebusy`, `calendar.events` vs the newer granular
      `calendar.events.owned` / `calendar.calendarlist.readonly`), the
      `freeBusy` limits (calendars per call, longest range), the client-supplied
      event `id` rules (base32hex, 5–1024 chars, 409 on a reused id), the
      `reason` strings Calendar adds, `410` on a dead `syncToken`, and that a
      project in *Testing* status gets refresh tokens that die after 7 days.
- [ ] 0.2 **Owner:** a Google Cloud project with the Calendar API on, an OAuth
      client (web, redirect URI = auth's grant callback on the dev port), the
      consent screen in Testing with the host's address as a test user. → Q5
- [ ] 0.3 Mint a token by hand (OAuth Playground or a one-off script) and curl
      `POST /calendar/v3/freeBusy` and `POST /calendar/v3/calendars/primary/events`
      with a client `id`, then `DELETE` it. Record the real answers as the
      sink's fixtures.

### Phase 1 — The Calendar module

Goal: `@frontierjs/conduit-gmail/calendar` speaks Calendar, proved against a sink.
Done when: `cd packages/conduits/conduit-gmail && bun run drive` passes with
the new `calendar.` rows, including a negative control per refusal.

- [x] 1.1 Target and calls: `calendarTarget({ ref })` (bearer, per caller, JSON),
      `CALENDAR_SCOPES`, `listCalendars`, `freeBusy({ timeMin, timeMax, items })`,
      `insertEvent({ calendarId, id, … })`, `getEvent`, `patchEvent`,
      `deleteEvent`. `insertEvent` and `deleteEvent` are `replayable: true`
      because the id makes them so. `./calendar` is the package's first module
      subpath (it exports `.` and `./sink` today).
- [x] 1.2 Errors: lift the Google-envelope half of `translate` so mail and
      calendar share it; add `conflict` (409 on a reused event id = it already
      landed) and `sync_reset` (410).
- [x] 1.3 Pure helpers: `eventIdFor(bookingId)` (a hash written in base32hex),
      `busyRanges(freeBusyAnswer)` that merges overlapping ranges and reports a
      calendar Google could not read (`errors[]` per calendar) instead of
      treating it as free.
- [x] 1.4 Sink: `/calendar/v3/*` mounted beside `/gmail/v1/*` in the existing
      Google stand-in, with chaos for `lost`, `revoke`, `rateLimit`,
      `forbidScope` and a calendar that answers `notFound` inside a 200.
- [x] 1.5 Drive rows, README, `PROJECT_STATE.md` (what stays unverified).

### Phase 2 — Connect a calendar in calendly

Goal: a host clicks Connect, consents at Google, and lands back with a stored grant.
Done when: a calendly test drives `beginGrant` → the sink's OIDC provider →
`onGrant` → a `CalendarConnection` row, and a revoked grant marks the row lost.

- [x] 2.1 Schema: `CalendarConnection` (host, provider, account address,
      refresh token `@encrypted`, `busyCalendarIds`, `writeCalendarId`,
      `status`, `lostAt`), gated to the host. Before drawing it, read how
      `conduit-microsoft`'s `GrantStore` and ELA's Gmail grant hold their rows.
      `Booking` gains nothing; the event id is `eventIdFor(booking.id)`.
- [x] 2.2 A `google-calendar` grant provider in auth (`purpose: 'grant'`,
      calendar scopes, `access_type=offline` + `prompt=consent` so Google
      sends a refresh token) whose `onGrant` writes the row as the system.
- [x] 2.3 A `GrantStore` over that row for `oidcTokenResolver`; `onLost` sets
      `status: lost` and sends the host a notification.
- [x] 2.4 The host's settings screen: Connect, Disconnect (revokes at Google),
      pick which calendars count as busy and which one gets bookings.
- [x] 2.5 File what the first real `beginGrant` caller finds in `ISSUES.md`.

### Phase 3 — Busy time removes slots

Goal: a slot that overlaps the host's Google busy time is never offered or booked.
Done when: calendly's tests show `slotsFor`/`daysWithSlots` dropping a
sink-busy hour, `book()` refusing it with `NotBookable('overlap')`, and the
lost-grant and outage cases behaving as Q3 rules.

- [x] 3.1 `slotsFor` and `daysWithSlots` subtract `busyRanges` beside the local
      `busyFrom`/`busyUntil` read in `domain/scheduling/book.ts`, padded by the
      event type's buffers.
- [x] 3.2 A per-host cache of the busy read (short TTL, keyed by range) so the
      public page does not call Google once per visitor.
- [x] 3.3 `book()` re-reads free/busy for the one slot, uncached, before the insert.
- [x] 3.4 Lost grant or Google down (`FJS-D2404`, fail open): slots and
      `book()` fall back to local bookings after a short timeout, so a slow
      Google never stalls the public page; the host gets a notification and a
      banner naming the calendar, once per outage rather than per visitor.
- [x] 3.5 Measure: the latency of a month's `daysWithSlots` with Google in the
      path. That number decides Phase 5.
  - Measured 2026-11-26 against the sink (`api/test/google-busy.test.ts`
    prints it): 38 ms with no connection, 46 ms cold and 33 ms warm with the
    sink answering at once, 377 ms cold behind a 300 ms round trip, 2,573 ms
    when Google hangs (the 2,500 ms deadline). One round trip per host per
    range per minute; a warm cache costs nothing. **Phase 5 is not called
    for** on these numbers. A real Google round trip is unmeasured until 4.4.

### Phase 4 — Bookings land in the host's calendar

Goal: book, cancel and rebook each leave exactly one correct event.
Done when: calendly's tests over the sink show one event after a lost answer
and a retry, none after a cancel, and the moved time after a rebook.

- [x] 4.1 A job after commit: `insertEvent` with `eventIdFor(booking.id)`,
      `sendUpdates` as Q4 rules.
- [x] 4.2 Cancel (the host's screen, the invitee's manage link, the inbound
      webhook) deletes the event, and a 404 or 410 counts as done; rebook
      deletes the old and inserts the new.
- [x] 4.3 A lost answer is settled by `getEvent(id)`; a 409 on retry counts as landed.
- [ ] 4.4 **Owner:** the live walk — connect a real calendar, block an hour in
      Google, see it vanish from the booking page, book a slot, see it appear in
      Google, cancel, see it go.

### Phase 5 — Mirror instead of asking (only if 3.5 says so)

Goal: slots read local rows, kept fresh by Google's push.
Done when: written only if 3.5's measurement calls for it.

- [ ] 5.1 `events.watch` channels with a per-channel token, renewal before
      expiry (a cron), `channels.stop` on disconnect; `events.list` with
      `syncToken`, a full resync on 410.
- [ ] 5.2 A `CalendarBusy` table the slot read joins instead of calling Google.

### Later, not planned

Microsoft 365 calendars through `conduit-microsoft` (Graph `getSchedule` and
events; the grant and subscription keeper already exist there). Several
connected calendars per host. Apple iCloud (CalDAV, no OAuth).

---

## Open questions

- ~~**Q1 — The package name.**~~ **Answered 2026-11-26 (`FJS-D2402`): A — a module inside `conduit-gmail`, as ruled.** `FJS-D1917` puts calendar in `conduit-gmail`.
  - **A** — a module inside `conduit-gmail`, as ruled.
  - **B** — rename the package (for example `conduit-google-account`) as
    calendar lands, moving every caller.
  - **Recommend A** — the ruling anticipated exactly this, and a rename can
    ride with the next Google module (Drive) if the name starts to mislead.
- ~~**Q2 — Live read or mirror.**~~ **Answered 2026-11-26 (`FJS-D2403`): A — `freeBusy` at request time, cached briefly.**
  - **A** — `freeBusy` at request time, cached briefly.
  - **B** — mirror via push + sync tokens from the start.
  - **Recommend A** — no webhook endpoint, channel renewal or sync cursor to
    own; Phase 5 keeps B if it is measured to be needed.
- ~~**Q3 — When Google cannot be read**~~ **Answered 2026-11-26 (`FJS-D2404`): B — fail open: offer slots from local bookings only, and tell the host.** (grant lost, outage, rate limit).
  - **A** — fail closed: offer no slots for that host; the page says the
    calendar could not be read, never an empty "no times available".
  - **B** — fail open: offer slots from local bookings only, and tell the host.
  - **Recommend A** — booking a client over the host's existing appointment
    costs more than a booking page that is blank for an hour.
- ~~**Q4 — Who invites the invitee.**~~ **Answered 2026-11-26 (`FJS-D2405`): A — calendly's mail and `.ics` stay the only invite; the Google event lists the invitee with `sendUpdates: 'none'` on create, move and cancel.** Calendly itself offers both, per event
  type: a *calendar invitation* the host's connected calendar sends (the
  invitee is a guest on the event and sees later changes; Calendly calls it
  the most common), or an *email confirmation* from Calendly with a static
  `.ics` ([help](https://calendly.com/help/calendly-scheduling-notifications)).
  This app already owns the second: the confirmation mail and an `.ics` whose
  CANCEL carries the same UID.
  - **A** — calendly's mail and `.ics` stay the only invite; the Google event
    lists the invitee with `sendUpdates: 'none'` on create, move and cancel.
  - **B** — Google sends the invite (`sendUpdates: 'all'`) whenever the host
    has a calendar connected, and calendly's mail drops its `.ics`; a host
    with none keeps today's mail.
  - **C** — a per-event-type choice between A and B, as Calendly has.
  - **Recommend A** — the booking row stays the one origin and the
    notification pipeline the one owner of telling the invitee (Invariant 4).
    Under B a grant lost before the 4.1 job runs leaves the invitee with no
    invite at all. B's live updates come from A too, since the `.ics` keeps its
    UID and bumps SEQUENCE on a move. Calendly's habit argues for C, not B, so
    C is the reopen path if a real host asks for Google-native invites.
- **Q5 — Whose Google Cloud project.** A new one for scheduling, or an existing
  client's (ELA's already holds a Gmail OAuth client). Owner's call; it decides
  whose name the consent screen shows and whose verification it rides.
- **Q6 — A grant provider in a bearer-session app.** `auth({ oauth })` throws
  at boot unless `cookieAuth: true` (`packages/auth/plugin.ts`, tested in
  `test/oauth-routes.test.ts`), because a sign-in callback can only hand back a
  session as a cookie. A `purpose: 'grant'` provider signs nobody in, and
  `app.oauth.beginGrant` is installed inside that same block, so calendly
  (`cookieAuth: false`) cannot reach it. Found 2026-11-26 by Phase 2, the
  first real caller.
  - **A** — auth applies the cookie check only when a sign-in provider is
    configured; a grant-only `{ oauth }` mounts the callback and `beginGrant`
    under Bearer sessions.
  - **B** — keep the guard; a bearer app runs the grant on its own two raw
    routes over `auth.oauthBegin` / `oauthCallback` / `oauthGrant`. Calendly
    is built this way today, as the interim.
  - **C** — calendly moves to `cookieAuth: true`.
  - **Recommend A** — the guard's stated reason does not hold for a grant, and
    B makes every bearer app copy the plugin's state-cookie and callback
    handling, which is the one-owner seam `FJS-D1313` drew. Until ruled,
    `beginGrant` itself stays unproven by a real caller.
- **Q7 — The host changes the write calendar after bookings exist.** The event
  job writes, moves and deletes in the connection's CURRENT `writeCalendarId`,
  so a booking written to the old calendar keeps its event there after a
  cancel, and nothing says so. Found 2026-11-26 by Phase 4.
  - **A** — document it.
  - **B** — a nullable `Booking.googleCalendarId` the job sets on create and
    reads for move and delete.
  - **C** — Settings warns when the write calendar changes.
  - **Recommend B** — which calendar an event went to is a fact about the
    past, and `writeCalendarId` is config that changes, so it cannot stand in
    for it. The event id is already derived (`eventIdFor`); the calendar is the
    one piece that cannot be. C leaves the silent miss in place. Proof: book,
    change the write calendar, cancel, and the old event is gone.
- **Q8 — The reschedule slot list hides the booking's own time.** `slotsFor`
  and `daysWithSlots` count the booking being moved as busy, locally and now
  as its own Google event, while `rebook` subtracts it. An invitee cannot pick
  a time overlapping the one they hold. Found 2026-11-26 by Phase 4.
  - **A** — leave it.
  - **B** — an optional `moving: bookingId` on `slotsFor` and `daysWithSlots`,
    through the one subtraction `rebook` already owns.
  - **Recommend B** — the cost of A is a hidden slot, not lost data, but B is
    one helper called twice. Google busy comes back as ranges, not event ids,
    so B subtracts by time range and would also uncover a second Google event
    at exactly that time; the booking-time re-check still refuses it.
- **Q9 — An event write can be lost between commit and dispatch.** The three
  dispatches in `bookings.service.ts` sit in `$.afterCommit`, which is
  at-most-once; a crash there loses that Google write for good.
  `docs/CONSISTENCY.md` puts a third-party call in `ctx.enqueue` (`FJS-D35`),
  and calendly has no Outbox model. Found 2026-11-26 by Phase 4.
  - **A** — accept it for the prototype and say so.
  - **B** — `fli outbox:install`, one migration, and the three dispatches move
    to `ctx.enqueue`.
  - **C** — a reconcile cron that re-syncs bookings whose event is missing.
  - **Recommend B** — the outbox relay already owns durable effects, and C is
    a second owner plus new missing-event state. The job is idempotent (job id
    per booking and status, event id from the booking id), so at-least-once is
    safe. Do it before Q7 so the job changes land once.
