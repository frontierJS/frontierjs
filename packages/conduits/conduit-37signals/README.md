# @frontierjs/conduit-37signals — Basecamp

Basecamp over `@frontierjs/conduit`, for an app that reaches Basecamp at
runtime rather than through the `basecamp` CLI. New, sink-only, built in
halves by `frontierjs/IDEAS/conduit-37signals.md`: send first, then the event
feed, a person's credential, the mirror claim. **Every create is unkeyed** —
Basecamp names no idempotency key — so a lost answer is resolved by a read,
never by sending again.

## What it covers

| Piece | Where |
| --- | --- |
| targets | `basecampTargets({ accountId, userAgent, ref? })` → `{ api, person, token, stream }`. `api` is `https://3.basecampapi.com/<accountId>`, bearer `BASECAMP_TOKEN`, the `User-Agent` on the descriptor; `person` is `api` again under its own id, bearer `BASECAMP_PERSON_TOKEN` with `per_caller: true`, for a verb that must appear as its author: each send spends the token of the person in the call (4.1); `token` is `https://app.basecamp.com`, `auth: none`, form-encoded, for the refresh (2.6); `stream` is the `broker` target `broker:37signals`, with no address and `auth: none`, because its dialect mints both (3.4). The builder refuses without a `User-Agent` or a numeric account |
| bind | `bindBasecamp(conduit, targets?, { as?, who? })` → `{ api, token, as }`, one Send per role; every call below takes this bundle (`bc`) and picks its own role, reads and verbs `api`, the refresh `token`. `as: 'api'` (the default) binds `api` to the process's token; `as: 'person'` binds it to the `person` target, so every call on the bundle spends the caller's own grant. Whose credential is chosen once, here, never per call. `targets` defaults to the constant ids |
| token | `basecampTokenResolver(bc, { clientId, grants })`, refreshing through `bc.token`: a `CredentialResolver` whose `get()` posts `grant_type=refresh_token` and answers `{ value, expires_at }` from Basecamp's `expires_in`. Wrap it in `withCache({ ttl_ms: Infinity })` and register it for `api`'s ref: the cache holds the token to its expiry and shares one refresh among sends that find it expired, and a `401` forgets it and replays once. `grants` is `conduit-oidc`'s `GrantStore` — `refreshTokenFor(ref)`, `onRotated?(ref, next, previous)`, `onLost?(ref, failure)` on `invalid_grant`. `grantsFor(who)` answers the same store for one caller, read off their row (`FJS-D1126`), and gives the resolver the `getFor` a `person` target needs; give `grants`, `grantsFor` or both. Register the one wrapped resolver for both refs: the cache keys a caller's token on the caller |
| errors | `translate(error, status?, headers?)` → `BasecampFailure { kind, code?, retryable, retryAfterMs?, resume? }`: 403 `forbidden`, 404 `gone`, 404 with `Reason: Account Inactive` `inactive`, 429 `rate_limited` with conduit's `Retry-After`, 507 `capacity`, the feed's 409 `refused` / `filters_changed` and 410 `refused` / `before_epoch` with its `resume` URL, any other 4xx `refused` with the body's `reason` as `code` |
| reads | `walk(bc, path, { etags? })` follows `Link rel="next"` to an empty page → `{ rows, etags }` or `{ unchanged: true }` when every page answers `304`. `me`, `project(id)` → `{ row, etag }`; `projects` and `todolists(project)` walk. `recording(bc, bucket, id, { type?, etag? })`: with `type` (`Todo`, `Todolist`, `Message`, `Comment`) the typed read; without, the envelope and then its `url` |
| verbs | `createTodo(bc, { bucket, todolist, content, description?, assigneeIds?, dueOn?, startsOn?, notify? })`, `postMessage(bc, { bucket, board, subject, content?, categoryId? })` (always `status: active`; without it Basecamp makes a draft), `comment(bc, { bucket, recording, content })`, `chatLine(bc, { bucket, chat, content })` → `{ row?, attempt, error? }`. A rich-text field (a to-do's `description`, a message's, a comment's or a line's `content`) is `{ text }`, escaped with each line break a `<br>`, or `{ html }`, your markup; a bare string, or both, is refused. A line always goes as `text/html`, so it is rich text like a comment. `completeTodo(bc, todo)` posts the to-do's `completion_url` → `{ ok }` |
| feed | `pollEvents(bc, { since \| position \| url, types?, buckets? })` → `{ events, position, next? }`: ONE page of `events.json`, oldest first. Enter with `{ since: 'now' }`, `{ since: 0 }` (everything back to the epoch) or `{ since: <event id> }`; resume with a stored `{ position }`; follow a page's `next`, or a refusal's `resume`, with `{ url }`, which carries its own filters. `types` defaults to `FEED_TYPES`, the types this connector reads (the plan's nouns table). A poll that names no cursor, a time as `since`, an empty `types` or a 101st bucket throws before the send |
| apply | `eventJobId(event)` → `'37signals:event:<id>'`, the id the poll job dispatches each event under, so a replayed page queues nothing new. `reread(bc, event)` → `{ row }` or `{ error }`: the recording the event points at, as it is now — the typed read for `todo.*`, `message.*` and `comment.*`, the envelope and its `url` for a chat line or a boost (whose `recording_id` is what was boosted). `gone` is the apply job's drop |
| stream | `basecampStreamDialect(bc, { types?, buckets? })`, `bc` bound `as: 'api'` (a `person` bundle is refused: a dial runs outside any call, so there is no caller whose grant it could spend), for `app.conduit.receive({ provider: '37signals', target: BASECAMP_STREAM_TARGET, dialect, apply })`. Each dial mints a ticket (`POST /events/stream_ticket.json`) and dials the URL it answers whole; the handshake waits for `welcome`, subscribes ONCE to `EventsChannel` with the poll's filters (`FEED_TYPES` by default) and is believed only on `confirm_subscription`. The server's 3 s ping is the keepalive, listened to and never answered (`FJS-D1356`). Each frame is a `StreamEvent`, `type: 'event'` with the feed's pointer as `payload`, its receipt keyed by `eventJobId` |
| lost creates | `findCreated(bc, attempt)` → `{ found }`: the parent's list, read for rows this principal created since the attempt whose text is the attempt's. `[]` means it did not land |
| sink | `sink.ts`: account `999`, a `User-Agent` or Basecamp's `400`, `X-Ratelimit` on every answer, a weak `ETag` and its `304` on every read, 0.2's fixtures pointed at the sink's origin; `projects.json` in geared pages (15, 30, 50, 100) whose `Link` never ends; the envelope read; the four creates landing on their parent's list (lines and messages newest first, comments oldest first), rich text wrapped in `<div>` (a line only when it says `text/html`), the completion; an empty list is `[]`. `/_sink/arm` takes `{ rateLimit: { retryAfter } }` (a 429, `X-Ratelimit` at `remaining: 0`), `{ failNext: true }` (a 500), `{ forbidden: true }` (an empty 403), `{ inactive: true }` (`Reason: Account Inactive` on every path until reset), `{ lost: true }` (applied, never answered) or `{ answer: { status, body?, headers?, times? } }`; no refusal applies the request. `POST /oauth/tokens` mints an access token for the sink's refresh token, good for `tokenLife` seconds; `/_sink/arm` also takes `{ expire }` (every minted token answers 401), `{ refuseRefresh }` (`400 invalid_grant` until reset), `{ rotate }` (a new refresh token each time, the old one burned), `{ revoke: <refresh token> }` (that grant alone answers `invalid_grant`) and `{ tokenLife }`; the sink's `people` option adds a grant per person, refresh token to person id, so a token minted from it answers that id on `my/profile.json` and is the creator of what it creates, and an armed answer is spent on the token path too. `/_sink/hide` `{ id }` makes a created row answer the 404 a missing id does and drops it from its list; `/_sink/seed` `{ path, rows }`, `/_sink/project` to change one row. `GET /events.json` serves 0.2's replay: position tokens bound to the docs' `srv2` filter digest (other filters answer 409), a walk's `next` with its frozen head, `invalid_position` and `invalid_filter` 400s; `/_sink/arm` takes `{ feedPage }` and `{ epoch }` (a cursor below it is 410 with `resume`), and `/_sink/events` `{ events }` appends. `POST /events/stream_ticket.json` mints a ticket for `/cable/999`, good for `ticketLife` seconds; the socket speaks ActionCable (`welcome`, a `ping` every `beatMs`, one confirmed subscribe, `reject_subscription`, `disconnect`), `/_sink/events` pushes to it unless `live: false` (`duplicate: true` sends each frame twice), and `/_sink/arm` takes `{ ticketLife, beatMs, hangUp }` |
| drive | `bun run drive` — 72 rows |

## Limits

`gone` means gone **to this principal**: a deleted recording and a project
the token was never on answer the same 404. What a trashed recording answers
is unmeasured; it may read `200` with `status: trashed`. An `etag` is the
caller's to keep with the body it tagged, and a list's tags are one per page —
pass back all of them or the walk cannot answer `unchanged`.

**A create is sent once.** Basecamp stores no idempotency key, so conduit
never resends one, and a lost answer comes back `indeterminate` with the
`attempt` beside it. Hand that to `findCreated` before creating again. A 500 is `indeterminate`
too, since Basecamp may have applied it; a 429 is not, because a refused
request was never applied, and it comes back `retryable` with `retryAfterMs`
for the caller to send again. Reads are resent on both, after `Retry-After`. It is a
match, not a key: two identical comments from the same person within the
window are both found, and a to-do completed since the attempt has left its
list and is not. It matches on text, because Basecamp rewrites rich text (a
`<div>` around the body at least). How else real Basecamp rewrites posted HTML
is unmeasured. `completeTodo` is the one verb resent after a lost answer,
because completing twice is the same state.

**A refresh is sent once.** If Basecamp rotates refresh tokens (unmeasured), a
lost answer has already burned the old one, so a 500 at the token endpoint is
`auth_failed, retryable: false` on the `api` send — the grant is kept and the
next send refreshes. A 429 there is `retryable`. A live refresh has never run:
the drive is the sink's.

**A poll is one page, and the cursor is yours.** Store `position` only after
each event on the page is applied, or queued under its own id (a caravan
`dispatch({ id: eventJobId(event) })`, `FJS-D1354`), or a crash loses
that page. The feed promises no delivery
and serves nothing younger than about 30 s; an event is a pointer, so the apply job
starts with `reread(bc, event)` and applies what that answers, never the
event; a `gone` there is dropped, not retried, and any other failure is the
job's to retry. A refused cursor says how to come back:
`invalid_position` and `filters_changed` by `{ since: <last event applied> }`,
`before_epoch` by `{ url: error.resume }`. Changing `types` or `buckets`
answers `filters_changed` on every held position once. There is no
`exclude_performers=self`: under a person's token it would drop that person's
own activity.

**The stream is a pointer sooner, never a cursor.** A poll serves an event
only once it is about 30 s old, so a frame that only woke the poll would find
nothing new. Dispatch the frame's event as its apply job, under
`eventJobId(event)`: the poll names the same id about 30 s later and caravan
runs it once, whichever lane came first. Only the poll stores `position`, and
it is what repairs a frame the socket dropped, so keep polling. A rejected
subscription is thrown from the handshake and conduit redials it, a ticket
per backoff step; the filters are checked before the first dial, so that loop
means Basecamp's catalog moved. Whether the cable wants a `User-Agent` on the
upgrade is unmeasured (conduit sends none on a dial), and so is every frame
beyond the docs' examples.

The claim is not built yet; the plan's boxes say when.
