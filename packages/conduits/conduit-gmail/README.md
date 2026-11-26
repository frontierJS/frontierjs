# @frontierjs/conduit-gmail

Gmail over `@frontierjs/conduit`: read, watch, send. The DIALECT only — the
target, the calls under `/gmail/v1/users/me`, the error table, the MIME
builder, the message parser, the push envelope and its bearer, the sink. The
sync ENGINE (the history watermark, the rows, threading to a contact, when to
re-arm the watch) is the app's: mail as data is a cursor, and a cursor is out
of conduit. Ported from ELA's `mime.js`, `google.sync.js`, `google.history.js`,
`google.pubsub.js` and `google.gmail.js` without googleapis, OAuth, Feathers or
Prisma.

**Google's facts (`reason` strings, unit costs, the per-minute quota, the
watch expiry, the push shape, the threading rule) were checked against
developers.google.com.** The sink encodes that reading. No real
Gmail was called; see `PROJECT_STATE.md` for what stays unverified.

## What it covers

| Piece | Where |
| --- | --- |
| target | `gmailTarget({ ref = 'GOOGLE_GRANT', address?, id?, perCaller? })` — bearer, `json`, `timeout_ms 15_000`, `retry_limit 2`. One host, one target. `GMAIL_SCOPE` is `gmail.modify` (restricted) |
| reads | `getProfile`, `listMessages`, `listThreadIds` (DISTINCT thread ids), `getMessage` (`full` · `metadata` + `metadataHeaders` · `minimal`), `getThread`, `listHistory`, `walkHistory`, `listLabels`, `getAttachment`, `findByMessageId` |
| writes | `watch` (stops first), `stop`, `sendMessage({ mime, threadId? })`, `modifyMessage`, `trashMessage`, `untrashMessage` |
| pure | `buildMime`, `toRaw`, `mintMessageId`, `replyHeaders`, `headerOf`, `subjectsThread`, `parseMessage`, `bodyOf`, `attachmentsOf`, `addressesOf`, `advanceHistoryId`, `backfillQuery`, `decodePushEnvelope`, `verifyPushBearer`, `pushVerifier` |
| errors | `translate(error, status?, headers?) → GmailFailure` — the table below |
| sink | `sink.ts`: `startGmailSink(opts)` on `port: 0`, and `gmailSinkHandler(state)` so one Google stand-in mounts `/gmail/v1/*` beside its other paths |
| calendar | `@frontierjs/conduit-gmail/calendar` — see § Calendar |
| drive | `bun run drive` — 41 Gmail rows then 42 `calendar.` and `oauth.` rows, sink only; no conforming Gmail or Calendar exists |

`send` is `bindSend(conduit)`: the connector never holds an app. The
credential is a USER's OAuth access token with a Gmail scope, minted by the
app's own grant resolver or conduit-oidc's `oidcTokenResolver`; nothing here
mints one.

## The rules the drive proves

- **Discovery by query, ingestion by thread.** `listMessages({ q })` answers
  messages, so a thread begun three weeks ago with a reply yesterday yields
  only the reply, and the app would store it as a root (a false root).
  `listThreadIds` collapses the list to DISTINCT thread ids; `getThread`
  fetches each whole; `parseMessage` then sorts by `sentAt`, oldest first.
- **`internalDate` wins over the Date header**, which is the sender's clock.
- **Headers keep the sender's case** (`Message-Id` and `Message-ID` both
  occur) and `headerOf()` is the case-folded lookup; the send path reads the
  parent's `Message-Id` and `References` back off that map.
- **The threading contract.** `threadId` is the parent's THREAD id, never its
  message id (Gmail reuses the root's message id as the thread id, which hides
  the bug until a mid-thread reply). `replyHeaders(parent)` gives In-Reply-To
  = the parent's OWN Message-Id and References = its chain + its Message-Id.
  A reply whose Subject differs from the parent's forks the thread at Gmail
  with no error, so `buildMime` refuses it when `parentSubject` is given.
- **The Message-ID is minted before the send** (`mintMessageId(domain)`),
  and `sendMessage` returns it on every outcome. Gmail indexes the header, so
  `findByMessageId(send, id)` (`q: rfc822msgid:…`) says whether a send whose
  answer was lost landed — the C6 read.
- **The watermark moves forward only**, compared as BigInt
  (`advanceHistoryId`); a push out of order never regresses it. A 404 from
  `history.list` is `history_gap`: the id aged out of Gmail's window, and the
  app re-syncs by query (`backfillQuery(days)`).
- **The watch dies silently at seven days.** `watch` answers `expiration`
  (epoch ms as a string) and stops first so a re-arm replaces rather than
  stacks. Renewing daily is the app's cron; the sink's `expireWatch` shows
  that history still answers after it dies, which is the trap.
- **The push carries no mail**, only `{ emailAddress, historyId }`;
  `historyId` arrives as a string today and arrived as a number once, and
  `decodePushEnvelope` answers a string either way. It is at-least-once and
  out of order: the receiver dedupes by Pub/Sub `messageId` and acks garbage,
  because a redelivery cannot fix bad JSON.

## Errors

Google's envelope is `{ error: { code, message, status, errors: [{ reason }],
details: [{ reason }] } }`. `translate` reads `details[].reason`, then
`errors[].reason`, then the HTTP status.

| Google | HTTP | conduit kind | `GmailFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| `authError` "Invalid Credentials" | 401 | `auth_failed` | `auth_failed` — conduit forgets the token, the resolver refreshes, one replay | once, by conduit |
| `insufficientPermissions` / `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, `domainPolicy`, `forbidden` | 403 | `auth_failed` | **`forbidden`**, `scopeMissing: true` for the scope case — the policy's, not the key's; the credential is KEPT | no |
| `dailyLimitExceeded`, `quotaExceeded` | 403 | `auth_failed` | **`quota`** — not now, not never | no |
| `userRateLimitExceeded`, `rateLimitExceeded` | 403 | `auth_failed` | **`rate_limited`**, `limit: 'units'`, `retryAfterMs` 1000 (Google sends no `Retry-After`) — conduit does NOT retry a 403, so the caller waits | by the caller |
| no `reason`; "User-rate limit exceeded (Mail sending)" · "(bandwidth)" · "Too many concurrent requests" | 429 | `rate_limited` | `rate_limited`, `limit` read off the text | a GET by conduit; a send by the caller |
| `notFound` on `history.list` | 404 | `client_error` | **`history_gap`** | no |
| `notFound` elsewhere | 404 | `client_error` | `gone` | no |
| `invalidArgument`, `badRequest`, `failedPrecondition` | 400 | `client_error` | `refused` | no |
| `backendError`, `internalError` | 500 | `server_error` | `server_error`; a send also carries `indeterminate` when the answer was lost | a GET by conduit; a send never |
| a sign-in page or the envelope under a 200 | 200 | `invalid_response` | `invalid_response` | no |

Four refusals spell 403 and conduit grades every one `auth_failed`; the
`reason` is the only thing that tells them apart, which is the C3 amendment
this package wrote.

## Idempotency (C5, C6)

`sendMessage` is unkeyed and unreplayable: Gmail collapses nothing, a 429
comes back after one attempt with the wait, a lost answer is `indeterminate`,
and `findByMessageId` resolves it. `watch`, `stop`, `modifyMessage`,
`trashMessage` and `untrashMessage` are `replayable: true`: each moves the
mailbox to a state, and twice is the same state. Every GET is conduit's own.

## The push's bearer

Pub/Sub signs the push with an OIDC token for the subscription's service
account. `verifyPushBearer(jwt, { jwks, audience, publisher?, now })` runs
conduit-oidc's signature primitives (RS256/ES256 only, `none` and HS* refused
by name, unknown `kid` reported) under this profile's claims: `iss` is
Google's, `aud` is the hook URL, `email` is the pinned publisher with
`email_verified`, `exp`/`iat` with skew. `pushVerifier(cached, certsUrl)`
refetches Google's certs ONCE on an unknown kid. It is not `verifyIdToken`
because a real push token carries `azp` = the service account's id, which
that verifier refuses as not-the-audience (see `PROJECT_STATE.md`).

## Chaos the sink owns

`/_sink/arm` with `{ lost }`, `{ rateLimit: { status: 429 | 403, retryAfter?,
limit? } }`, `{ failNext }`, `{ staleHistory }`, `{ deliverTwice }`,
`{ expireWatch }`, `{ revoke }`, `{ quota }`, `{ forbidScope }`, `{ signIn }`,
`{ enforceUnits }` (the 6,000-units-a-minute bucket, per token). `/_sink/mail`
delivers into a mailbox and pushes to `hookUrl` when the mailbox is watched;
`/_sink/push` sends a bare push with a bent bearer (`rogue`, `forged`,
`numeric`, `malformed`, `email`, `exp`); `/_sink/rotate` rotates the signing
key; `/oauth2/v3/certs` publishes it. `/_sink/seen` is what arrived with the
units each request cost; the parsed MIME of a send is on its request.

The sink parses the sent MIME by hand (folded headers, RFC 2047 words,
boundaries, base64 parts): raw non-ASCII bytes in a header are refused naming
the header, a missing Message-ID is refused, a reply whose Subject differs
forks silently as Gmail does. The drive's negative control is a message built
with the encoder removed.

## Calendar

`import { … } from '@frontierjs/conduit-gmail/calendar'` — a host's busy time
read, a booking written. It is a module beside the mail dialect, not a second
package: the same Google grant, the same error envelope, the same stand-in.
`./calendar` is not re-exported from `.`.

| Piece | Where |
| --- | --- |
| target | `calendarTarget({ ref = 'GOOGLE_CALENDAR_GRANT', address?, id?, perCaller? })` on `https://www.googleapis.com`, base `/calendar/v3`; `bindCalendarSend(conduit)` is `bindSend` over `CALENDAR_TARGET` |
| calls | `listCalendars`, `freeBusy({ timeMin, timeMax, items, timeZone? })`, `insertEvent`, `getEvent`, `patchEvent`, `deleteEvent`; each answers `{ <thing> } \| { error: CalendarFailure }`, and each takes a trailing `{ timeoutMs?, signal? }`: `timeoutMs` caps each attempt, `signal` ends the whole call, retries included (a request cannot lower the target's `retry_limit`) |
| pure | `eventIdFor(bookingId, generation?)`, `busyRanges(answer, requested?)` |
| errors | `translateCalendar` shares `translate`'s reader of `error.raw`; adds `conflict` and `sync_reset` |
| sink | `startGmailSink({ calendar: { accounts: [{ token, email, scopes?, calendars?, events? }] } })` serves `/calendar/v3/*` beside `/gmail/v1/*`; with `oauth` it is also Google's OAuth (`sink-oauth.ts`): `/o/oauth2/v2/auth` consents at once as `login_hint` or the first account, `/o/oauth2/token` (code with PKCE S256; refresh; a refresh token only for `access_type=offline`, never rotated), `/o/oauth2/revoke`, `/o/oauth2/userinfo`, and `POST /_sink/oauth/revoke {email}` for the user revoking at Google. `OAUTH_CLIENT_ID`/`OAUTH_CLIENT_SECRET` are exported from `./sink` |

**Scopes: three, one per method, the narrowest each accepts.**
`CALENDAR_SCOPES` is `calendar.freebusy` (freeBusy.query),
`calendar.events.owned` (events insert, get, patch, delete on calendars the
user owns) and `calendar.calendarlist.readonly` (calendarList.list). They are
three because no narrow scope covers two methods: freeBusy.query does not
accept any `calendar.events*` scope, and `calendar.events.owned` cannot list
calendars. The broad `calendar` scope would be one, and is refused here as
more than the app asks for. Whether Google classes the three as sensitive or
restricted shows only on the Cloud Console consent screen.

**The event id is the idempotency key.** `events.insert` takes the caller's
`id` (5-1024 characters of `a-v` and `0-9`), so `insertEvent` and
`deleteEvent` are `replayable: true` and conduit repeats them after a lost
answer. The replay of an insert lands on a 409, which is `conflict`: THE FIRST
ONE LANDED, and `getEvent` reads it back. A caller that sees `conflict` on an
insert it just sent has succeeded, and one that sees it on a rebook has a
taken id. `eventIdFor(bookingId)` derives the id (SHA-256 in base32hex, 32
characters, namespaced `fjs:booking`); Google keeps a deleted event's id as a
cancelled tombstone, so a rebook is `eventIdFor(bookingId, 'r2')`.
`deleteEvent` treats `gone` (404, or 410 `deleted`) as done and answers
`{ deleted: true, already: true }`; a wrong `calendarId` is also a 404 and
reads the same.

**Busy time is read, not assumed.** `freeBusy` answers 200 for a calendar it
could not read, with `errors[]` and no `busy`. `busyRanges` merges every
calendar's ranges (start inclusive, end exclusive, epoch ms; overlapping and
touching ranges join) and lists each such calendar in `unreadable` with
Google's own `reason` instead of counting it free. Pass the requested ids as
the second argument and one the answer lacks is `missing`.

Facts, **checked against developers.google.com on 2026-11-26**:

- The envelope is `{ error: { code, message, errors: [{ domain, reason, message }] } }`.
  Reasons: 401 `authError`; 403 `userRateLimitExceeded`, `rateLimitExceeded`,
  `quotaExceeded`, `forbiddenForNonOrganizer`; 404 `notFound`; 409
  `duplicate`; 410 `fullSyncRequired`, `updatedMinTooLongAgo`, `deleted`; 412
  `conditionNotMet`; 429 `rateLimitExceeded`; 500 `backendError`; 400
  `timeRangeEmpty`, the only documented 400 reason.
- `rateLimitExceeded` arrives as 403 OR 429; `userRateLimitExceeded` and
  `quotaExceeded` only as 403. Quota is 10,000 requests a minute per project
  and 600 a minute per user.
- **`quotaExceeded` is `quota` here, and Gmail's table says the same, but the
  two guides word it differently.** Gmail's means the day's units are spent;
  Calendar's guide documents the 403 as "Calendar usage limits exceeded",
  which may clear in a minute. The status cannot tell them apart, so it stays
  `quota` and is never retried; an app that wants to wait it out decides that
  itself.
- freeBusy: `items` carries `calendarExpansionMax` at 50 and
  `groupExpansionMax` at 100. **The true per-call ceiling is not documented**,
  so 50 is the floor `freeBusy` refuses past; the longest range is not
  documented either. Per-calendar reasons are `groupTooBig`,
  `tooManyCalendarsRequested`, `notFound`, `internalError`, and Google says
  more may be added.
- calendarList: `maxResults` defaults to 100, at most 250; `minAccessRole` is
  `freeBusyReader`, `reader`, `writer` or `owner`.
- `sendUpdates` is `all`, `externalOnly` or `none`. Google's default is not
  stated clearly, so every write sends `none` unless told otherwise.
- `access_type=offline` returns a refresh token, only on first authorization
  unless consent is re-prompted. A project in Testing status issues refresh
  tokens that expire in seven days. Revoke is `POST
  https://oauth2.googleapis.com/revoke`, form-encoded `token`.

**Unverified: the sink assumes these and no real token has been tried** (plan
step 0.3): the 204 on delete; that re-inserting a deleted id answers 409
(a third-party report); that `GET` of a deleted event is 200 with `status:
'cancelled'`; the `sendUpdates` default; the per-call ceiling on `items` and
the longest range; the sensitive or restricted class of the three scopes; the
403 `reason` for a missing scope (the sink uses Gmail's `details[].reason`
spelling); that a patch of a cancelled event is a 410.

Refused before the send (zero attempts, a `TypeError`): an event id that is
not 5-1024 characters of `a-v0-9`; `timeMin` not before `timeMax` or either
not RFC 3339; an empty `items`; more than 50 `items`; `maxResults` past 250;
an empty patch. Not built: incremental sync (`syncToken`, so `sync_reset` is
named and unused), watch channels, recurring and all-day events, attendee
responses, the batch endpoint.

The sink enforces what Google does so a drift in the client is a refusal: the
bearer's scopes against the method (its table is written out again, not
imported), the id alphabet (400), a reused id including a deleted one (409),
DELETE 204 then 410 then 404, `timeRangeEmpty`, an unknown calendar inside a
200. It counts an event as busy unless it is cancelled or `transparency:
'transparent'`, clipped to the range and unmerged. Chaos is the same
`/_sink/arm` — `lost`, `revoke`, `rateLimit` (403 or 429, `rateLimitExceeded`),
`forbidScope`, `failNext` — plus `{ freeBusyNotFound: ['id'] }`, the next
freeBusy answering `notFound` for those calendars inside its 200, and two that
last until disarmed or reset: `{ delay: ms }` (every Calendar answer waits
first) and `{ outage: { status: 500 | 503 | 429 } }` (every Calendar call
answers that, on every retry).
`GET /_sink/calendar` lists every account's calendars and events;
`POST /_sink/calendar/event` `{ token, calendarId?, start, end, summary?,
transparency?, status? }` adds one mid-test; `state.calendar.addEvent` does it
in process. `/_sink/seen` carries calendar requests too.

## Refused before the send (C9)

A header value with a line break (injection; refused, never stripped); a `to`
with no `@`; a reply whose Subject is not the parent's; a Message-ID that is
not one; a raw message past 25 MB (Google no longer prints the limit; this is
the floor); a reply with In-Reply-To and no `threadId`; a `watch` with no
`projects/…/topics/…` name; `maxResults` past 500.

## Not built

The batch endpoint (`POST /batch/gmail/v1`, multipart/mixed — conduit has one
`encoding` per target); the upload path and attachments on send; drafts;
label creation; settings; the `gmail.metadata` scope. `buildMime` is RFC, not
vendor: its promotion to a toolbelt kit is named here and not done.

## Traps

- **A 403 is not the credential's.** Conduit grades it `auth_failed` and does
  not replay it; `translate` reads `reason`. Only a 401 forgets the token.
- **A 401 is replayed once only when the resolver has `invalidate`.** The
  static resolver lacks it; the drive brings its own.
- **`rateLimit: { status: 403 }` is never retried by conduit.** The connector
  hands the wait over as `retryAfterMs`.
- **`/_sink/reset` keeps the mailboxes** and releases a held `lost` answer.
