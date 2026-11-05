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
| drive | `bun run drive` — 41 rows, sink only; no conforming Gmail exists |

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
