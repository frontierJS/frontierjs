---
id: conduit-37signals
status: partial
dated: 2026-10-16
---

# Idea — `conduit-37signals`: Basecamp over conduit, built in halves

**Status: PARTIAL.** Dated 2026-10-16. The ticked boxes in § Phases are built,
against the sink only; the rest are not. Do not cite this file as behavior —
see `VERIFYING.md`. The API facts below were read
from 37signals' docs on the date above, not measured; Phase 0 measures them.

---

## Trigger

Kobami's Basecamp work — the daily check, the analytics check, support, the
marketing request — runs today through the `basecamp` CLI (v0.13.2, a Go
binary) as Jordan, from a Claude session. That stays: an agent at a terminal is
what the CLI is for. **An FJS app that reaches Basecamp at runtime cannot shell
out to it**: the token is one person's, on one machine, in
the system keyring; a shell-out skips `app.conduit.send()` (`FJS-D899`) and
with it resilience, receipts and `translate()`; and an exit code is not a
typed failure.

`conduit-mattermost` is the reference and the warning. It built four halves
— send, receive, socket, mirror claim — for about 2,200 lines, because
`mirror-apps.md` Phase 2 needed all four. Phase 1 ruled all four halves in
(`FJS-D1181`–`FJS-D1184`), so this plan builds them in order — send, feed,
person's credential, mirror claim — each on the one before it.

---

## What exists, and must not be restated here

| Piece | Where | What it settles |
| --- | --- | --- |
| Basecamp argued as a connector | `conduit-connectors.md` § Basecamp (2026-09-02) | **not FJS-maintained** — a vertical, test one fails; the facts table (URL per account, User-Agent required, 50 req / 10 s, `Link` paging, geared page sizes, ETag → 304, webhooks unsigned); the five transport gaps it found, all fixed (`FJS-648`–`FJS-652`); the inbound design for an unsigned hook |
| The contract | `../conduit-connectors/CONTRACT.md` | C1–C13 and every amendment; this connector is graded against it |
| The shape to copy | `../conduit-connectors/packages/conduit-mattermost/` | `src/{index,errors,types}.ts`, `sink.ts`, `test/*.drive.ts`, two targets one per credential, `translate()` reading status and headers |
| A credential minted through its own target | `FJS-D933`, conduit-oidc, conduit-push | a refresh is a send through an `auth: none` target; a failed mint is `MintError` |
| A credential's expiry | `FJS-D1075` | the resolver answers `{ value, expires_at }`; `withCache` refreshes once per key |
| A socket the app dials | `FJS-D1127`, `conduit-mattermost/src/socket.ts` | a `FrameDialect` on a `broker` target, a Receiver naming `target` |

---

## What changed since the 2026-09-02 argument

Read from `basecamp/bc3-api` (now pointing at `basecamp/bc-api`) on 2026-10-16:

- **Agents.** *"An agent authenticates with its own client-credentials token
  and acts as itself, with `personable_type` `Agent`."* It reaches only the
  projects it was added to; outside its endpoint set it gets `403` with an
  empty body; a project it is not on is `404`. A process credential with no
  refresh dance, which is the server's case exactly. The Launchpad page saying
  `client_credentials` is unsupported is true of Launchpad only: 0.2 found a
  second authorization server, `app.basecamp.com`, that advertises it. **0.1 measured it for Kobami: the account declined the agent
  connection — Basecamp has not enabled agents for it** (`FJS-D1182`, amended).
- **The event feed.** `GET /{account}/events.json`: thin pointers (`id`,
  `kind`, `action`, `bucket_id`, `recording_id`, `performed_by_id`…), oldest
  first, up to 100, an opaque `position` to resume from (persist it only after
  the page is applied). Changing filters is `409`; below the epoch is `410`
  with a `resume` URL. A poll only serves events older than about 30 s, and the
  feed *"is not an audit log, and not guaranteed delivery."*
  `exclude_performers=self` is the loop guard. Agents may poll it.
- **The live stream.** `POST /{account}/events/stream_ticket.json` mints a
  WebSocket ticket (about 2 minutes, one per connection) for `EventsChannel`.
  Each message is a wake-up only: *"live event ids never advance your durable
  position."*
- **Webhooks are now "legacy per-project".** Still unsigned, up to 10 attempts
  then the hook is deactivated, and `recent_deliveries` is the only record.

So the inbound half the 2026-09-02 text designed (secret path, dedupe on
`payload.id`, re-read) has a better road: one account-wide cursor in place of
a hook per project.

---

## Mattermost → 37signals

| Mattermost piece | Lines | Here | Why it differs |
| --- | --- | --- | --- |
| `mattermostTarget({ address })`, which refuses with no address | — | `basecampTargets({ accountId, userAgent }) → { api, token }`: `api` at `https://3.basecampapi.com/<accountId>` with `User-Agent` on the descriptor, `token` at `app.basecamp.com/oauth/tokens` (`auth: none`, named as `fcmTokenTarget` is; 0.2) | not self-hosted; one target per ACCOUNT (C1); two origins from one builder is google-maps' C1 amendment; a missing UA is a `400` |
| `mattermostUserTarget`, `per_caller` | — | Phase 4 (`FJS-D1182`) | `api` already spends Jordan's token; a `per_caller` target is only needed for a verb another person must author |
| `translate`: 403 `forbidden`, 404 `gone`, `X-Ratelimit-Reset` | 54 | 403 empty body `forbidden`; 404 `gone`, as in five connectors already; 404 with `Reason: Account Inactive` is `inactive`; 429 keeps conduit's `Retry-After`; 507 `capacity` (Hetzner's word) | `gone` here means *gone to this principal* — deleted, trashed or never visible, one 404 for all three — and the README says so, because a future mirror must not read *hidden* as *deleted* |
| `pending_post_id`, the caller's key in the body | — | **no key anywhere** — the docs name none | every create is unkeyed and unreplayable, and C6 names the read that resolves a lost one |
| `listPosts` paged by id | in 177 | `walk(send, path)` follows `Link rel="next"` and never builds a page URL | the docs forbid building one; sizes are geared (15, 30, 50, 100); `projects.json` sends `rel="next"` past its last page (0.3) |
| receive: outgoing webhook + slash command | 195 | Phase 3: `pollEvents` over the feed | webhooks are legacy, unsigned and per project |
| socket, `authentication_challenge` | 139 | Phase 3.4: the stream ticket, ActionCable framing, a wake-up that triggers a poll | the frame carries nothing durable |
| mirror claim, eight models | 261 | Phase 6: `Project`, `Todo`, `Message`, `Comment` (`FJS-D1184`) | four nouns, for the Kobami app 5.1 names as their lister |
| sink / drive | 458 / 560 | sink / drive, sized to the halves built | — |

---

## Open questions

- ~~**Q1 — Scope and name.**~~ **Answered 2026-10-16 (`FJS-D1181`): `@frontierjs/conduit-37signals`, in `../conduit-connectors/packages/` like its 21 siblings; promotion is the later call they all wait on. The `@kobami/` row in `conduit-connectors.md` is struck.**
  - **A** — `@kobami/conduit-37signals`, prototyped in `../conduit-connectors/`, never promoted into `packages/`.
  - **B** — `@frontierjs/conduit-37signals`, which reopens the 2026-09-02 verdict.
  - **Recommend A** — the verdict still holds (project management is a vertical); the `conduit-connectors.md` row already names a Kobami scope, and *37signals* over *basecamp* keeps it clear of `packages/basecamp`. An identifier cannot start with a digit, so the builder is `basecampTargets()`, and the C1 amendment names this connector.
- ~~**Q2 — Whose credential does the app spend?**~~ **Answered 2026-10-16 (`FJS-D1182`): C — both, two targets: the Agent's on `api`, a person's on a `per_caller` target (stored per `FJS-D1126`). The Agent half still waits on 0.1.** **Amended 2026-10-16: 0.1 found no agents on Kobami's account, so `api` spends Jordan's own token — picked over a bot user and over waiting.**
  - **A** — an Agent's client-credentials token: it acts as itself, only on the projects it was added to.
  - **B** — a person's Launchpad OAuth token (Jordan's), refreshed every 14 days.
  - **C** — both, two targets, Mattermost's shape.
  - **Recommend A, with C's second target as Phase 4** — A is a process credential and fits C1 exactly; a person's token is only owed to a verb that must appear as its author. A depends on 0.1's measurement.
- ~~**Q3 — How does Basecamp reach the app?**~~ **Answered 2026-10-16 (`FJS-D1183`): A then B — poll the feed, then the live stream as a wake-up. Webhooks refused.**
  - **A** — poll the event feed (a job every 60 s, `position` persisted after apply).
  - **B** — A plus the live stream as a wake-up.
  - **C** — legacy per-project webhooks.
  - **Recommend A, then B** — one cursor for the whole account; B only cuts latency and A stays the source of truth either way. C is refused: unsigned, a hook per project to install and reconcile, and the docs call it legacy.
- ~~**Q4 — A mirror claim?**~~ **Answered 2026-10-16 (`FJS-D1184`): B — claim `Project`, `Todo`, `Message`, `Comment`, because a Kobami app will list them (rule 1 holds); 5.1 names that app, and if it names none the ruling reopens.**
  - **A** — none: send plus the feed, and the app stores what it chooses.
  - **B** — claim `Project`, `Todo`, `Message`, `Comment` (`FJS-D1125`).
  - **Recommend A** — `mirror-apps.md` rule 1: a mirror is earned by a surface that LISTS the noun, and no app does yet. B is Mattermost's 261 lines without a reader.

---

## Phases

### Phase 0 — Groundwork

Goal: real shapes and the credential answer measured, not read.
Done when: 0.1 has an answer (it does — no agents), scrubbed fixtures are on disk, and the nouns table is filled.

- [x] 0.1 **Declined 2026-10-16: Kobami's account cannot use agents yet; no Agent credential exists. `FJS-D1182` amended to Jordan's own token on `api`.** Was: measure the agent credential: add an Agent to one Kobami project (owner's step), then ask Launchpad for a client-credentials token. Record what `authorization.json` answers for it, its lifetime, and which endpoints answer `403`.
- [x] 0.2 **Done 2026-10-16: 16 bodies, scrubbed, staged in `../conduit-connectors/fixtures/37signals/` (its README lists each request); raw dumps stayed in the scratchpad.** Bodies are `curl`'s with the CLI's token, not the CLI's output. What they changed:
  - **The CLI's token is not a Launchpad token.** `basecamp auth status` says `oauth_type: bc5`, a 1-hour lifetime, refreshable; `launchpad.37signals.com/authorization.json` answers it `401` (*"checksum failed"*). `3.basecampapi.com/.well-known/oauth-protected-resource` names two authorization servers, `app.basecamp.com` first, and `app.basecamp.com`'s metadata offers `refresh_token`, `client_credentials`, `device_code`, token exchange, PKCE, dynamic registration, revocation and introspection, scopes `full` `read` `mcp` `offline_access`. So 2.6 refreshes at `app.basecamp.com`, and the target is `token`, not `launchpad` (`FJS-D1182`, amended again)
  - **`authorization.json` answers on the API host**, `3.basecampapi.com/authorization.json`, with `identity`, `accounts`, `scope` and `expires_at`
  - **The feed's `since` is an event id, `0` or `now` — never a time.** A date is `400` `{ reason: "invalid_position" }`. No cursor enters at the present with `events: []` and a `position`; `since=0` replays to Kobami's epoch, 2026-09-16. An event carries `event_type` (`chat.line.created`) and `creator_id` beside `kind`
  - **A `404` has a body**, `{"status":404,"error":"Not Found"}`; only an Agent's `403` is documented empty
  - Was: capture shapes with the CLI as the reference, not the transport — `basecamp api get` for `authorization.json`, a project, a todolist and a todo, a message, a comment, a chat line, a page of `events.json`, a known `404`. **Kobami's account is client data:** scrub names, emails and content before anything lands in `test/fixtures/`, and keep the raw dumps in the scratchpad.
- [x] 0.3 **Done 2026-10-16: 14 header captures, scrubbed, in `../conduit-connectors/fixtures/37signals/headers.json`.** What they changed:
  - **`projects.json`'s `Link` never ends.** Pages run 15, 30, 50, 2 (97 = `X-Total-Count`), and pages 5–9 are `[]` with `rel="next"` to the page after. A walk that waits for `Link` to go missing never stops, so 2.2's `walk()` stops on an empty page, and 2.5's sink keeps sending `Link` past the end
  - **The feed's `Link` does end.** `since=0` walked 29 pages of 100 to a tail of 54 with no `Link` and no `next`. `Link`, the body's `next` and the page after it use `?position=` (a signed token); the body's `position` equals `X-Feed-Position`
  - **Caught up is one position.** The tail's position equals the no-cursor head's and `since=now`'s, so entering at the present and walking from `0` land on the same cursor. `?position={tail}` answers `events: []` with the head's `ETag`, and `If-None-Match` on it is a `304`, so an idle poll is cheap
  - **`since={id}` is exclusive**: it starts after that event. A bad `position` is `400` `invalid_position`, and its message says to resume with `since=<id>` or `since=now`
  - **`ETag` is weak (`W/"…"`) everywhere.** A `304` repeats `ETag`, `Link`, `X-Total-Count` and `X-Feed-Position` with no body. The same tag without `W/` is a `200`
  - **The rate limit is a header**: `X-Ratelimit: {"name":"API","period":10,"limit":50,"remaining":49,"until":…}`, on every answer including `304` and `400`. The `429` itself was not provoked
  - **No `User-Agent` is `400` `text/plain`**: *"Provide a User-Agent header in the following format: My App (https://example.com/myapp)"*. An empty header is the same. A UA without a URL, `conduit-37signals-probe (fixture capture)`, passed
  - Was: read headers with `curl` and `basecamp auth token`, GET only: `Link`, `X-Total-Count`, `ETag` and a `304` on `If-None-Match`, `X-Feed-Position`, and what a request with no `User-Agent` answers.
- [x] 0.4 **Done 2026-10-16: the table below, from 0.2's bodies and the feed's type catalog (`sections/event_feed.md`, read the same day).** Its columns are Mattermost's (`mirror-apps.md` § Mattermost nouns), with *mirrored* and *proxied* in `FJS-D1124`'s sense, and the feed moved into *Fed by* rather than becoming a third kind. What it changed:
  - **The feed has no `project.*` type.** `FJS-D1184` claims `Project`, but no event ever names one, so a `Project` row is kept by walking `projects.json` again. That walk is cheap because its `ETag` answers `304`. A new project shows up on the next walk and nowhere sooner. 6.2 is amended
  - **No noun has a trash, archive, delete or uncomplete type.** A reopened to-do stays `completed` in a mirror, and a trashed recording keeps its row, until a later event on it causes a re-read or a complete read of its scope runs (`FJS-D1180`). The scope walk is the only floor, and how often it runs is how stale a row can get. 6.2 is amended
  - **A project's dock can list two `todoset` entries.** On page 1, 12 of 15 projects have a second one with `enabled: false`. So "found by `name`" means `name` together with `enabled`; 2.2 is amended
  - **`completion_url` and `subtasks_url` have no bucket in them** (`/{account}/todos/{id}/completion.json`), while every other URL in the bodies does. `completeTodo` follows the body's `completion_url` instead of building a path, as `walk()` follows `Link`. Whether the bucketed path from the docs also answers is unmeasured, because 0.2 and 0.3 only sent GETs
  - Was: the nouns table below: for each noun, the verb, the read, and *proxied* or *feed*.

#### 37signals nouns

*Mirrored* means a `@@mirror` model claimed in Phase 6 (`FJS-D1184`). *Proxied* means a call over `conduit.send()` with no row behind it. *Fed by* names the feed's `event_type`s (3.1), or a re-walk where the catalog has none. Verbs follow the docs. 0.x sent only GETs, so no verb has been measured. The paths are below `/{account}`.

| Noun | Verb | Read | Fed by | Kind |
| --- | --- | --- | --- | --- |
| Project | — | `walk(projects.json)`, `projects/{id}.json` | **none**: a re-walk of `projects.json` with `ETag` | mirrored |
| Todo | `createTodo` → `POST buckets/{b}/todolists/{l}/todos.json`; `completeTodo` → `POST` the body's `completion_url` | `buckets/{b}/todos/{id}.json` | `todo.created`, `.completed`, `.moved`, `.content_changed`, `.description_changed`, `.scheduled`, `.rescheduled`, `.unscheduled`, `.assignment_changed`. **None** for uncomplete or trash | mirrored |
| Message | `postMessage` → `POST buckets/{b}/message_boards/{m}/messages.json` | `buckets/{b}/messages/{id}.json` | `message.created`, `.content_changed`, `.subject_changed`. None for trash | mirrored |
| Comment | `comment` → `POST` the parent's `comments_url` (`buckets/{b}/recordings/{id}/comments.json`) | `buckets/{b}/comments/{id}.json` | `comment.created`, `.content_changed`. None for trash | mirrored |
| Todolist | — | `buckets/{b}/todosets/{s}/todolists.json` (the dock's `todoset` with `enabled: true`), `todolists/{id}.json` | none | proxied: the container `createTodo` names |
| Chat line | `chatLine` → `POST buckets/{b}/chats/{c}/lines.json` | `buckets/{b}/chats/{c}/lines/{id}.json` | `chat.line.created` (rich text and upload lines; pings ride it too) | proxied: not claimed (`FJS-D1184`) |
| Person | — | `my/profile.json` (`me`), a project's `people` | none | proxied; `Profile` if 6.1 claims it (`FJS-D1152`) |
| Boost | — | — | `boost.created`, whose `recording_id` is the recording that was boosted | ignored: a boost event re-reads that recording, and a removed boost emits nothing |

The feed's catalog also serves `card.*` and `question.*`, which this plan leaves out. A `types` filter in 3.1 names only the types above, so a type added to the catalog later never shifts the held position (`409`).

### Phase 1 — Rulings

Goal: Q1–Q4 answered.
Done when: each Q names an `FJS-D`.

- [x] 1.1 Q1–Q4 through the question tool, then written into `DECISIONS.md` — `FJS-D1181`–`FJS-D1184`

### Phase 2 — Send

Goal: the connector's send half, against a sink.
Done when: `bun run drive` is green on the sink with a negative control, and the read rows parse 0.2's fixtures.

- [x] 2.1 **Done 2026-10-16: the package in `../conduit-connectors/packages/conduit-37signals/`, a sink serving the fixtures, and an 11-row drive, green; `C1 — 37signals` in `CONTRACT.md`.** What it changed:
  - **Bun never sends an absent `User-Agent`.** It fills one in as `Bun/1.4.2`, and Basecamp answers that 200 (measured); only an EMPTY header gets the `400`. So a target that dropped its UA runs, as an app Basecamp cannot name, and the builder's refusal is the only guard. 2.5's negative control sends an empty header
  - **The account rides the address** (`https://3.basecampapi.com/<id>`), so a call's path starts after it. A `Link` URL carries the account too; 2.2's `walk()` follows it whole rather than joining it to the address
  - The drive's `fixtures.scrubbed` row fails on any email that is not `person-N@example.com` and any account that is not `999`, so a later capture cannot land unscrubbed
  - Was: scaffold (`./scaffold.sh 37signals …`) and move 0.2's fixtures into `test/fixtures/`. `basecampTargets()`, `bindSend()`, `translate()`, with the table above as its mapping
- [x] 2.2 **Done 2026-10-16: `walk`, `me`, `projects`, `project`, `recording`, `todolists`, and 15 drive rows (26 in all), green; the five load-bearing ones each fail under a mutation of the code they guard.** What it changed:
  - **`buckets/{b}/recordings/{id}.json` answers only the envelope** (measured, GETs only): it has no `completed`, `content`, `description`, `assignees`, `due_on` or `completion_url`, and its `url` is the typed read, chat lines included. So `recording(send, bucket, id, { type })` is the typed read, one request, and with no `type` it reads the envelope and then follows its `url`, two requests. 3.3 passes the type that `event_type`'s noun names; a boost's recording, whose type no event names, goes through the envelope
  - **One tag cannot stand for a list.** A page's `ETag` covers that page, and a renamed project on page 3 leaves page 1's tag alone. So `walk()` takes `etags`, one per page, and is `unchanged` only when every page answers `304`; the first page that does not restarts the walk plainly, because a `304` has no body to keep
  - **The 304 answer is `unchanged: true`**, S3's spelling, not `notModified`
  - `walk()` follows a `Link` URL whole, as the request's `address`, and conduit refuses one on a foreign origin before the token leaves. A `Link` that returns to a page already walked is `invalid_response`. A project with the To-dos tool off answers `rows: []`
  - Was: reads: `walk()`, `me`, `projects`, `recording(bucket, id)`, the todo list. `etag` in, `{ notModified: true }` out; the cache stays the app's (C12). `walk()` stops on an empty page, never on a missing `Link` (0.3). The todoset is the dock entry with `name: "todoset"` and `enabled: true`: a project can carry a second one that is disabled (0.4)
- [x] 2.3 **Done 2026-10-16: `createTodo`, `completeTodo`, `postMessage`, `comment`, `chatLine` and `findCreated`, with 10 drive rows (36 in all), green. Each of the seven load-bearing rows goes red under its own break in the code.** What it changed:
  - **The resolving read is the parent's list, not the feed** (owner's pick, 2026-10-16). The feed's docs say a poll serves only events older than about 30 s, that the feed is *"not guaranteed delivery"*, and that *"workflows that need completeness must corroborate against the canonical resource APIs"*. A feed mark would also cost one request on every write. So each create returns its `attempt` (type, bucket, parent, `startedAt`, the text it matches on) on every outcome. `findCreated(send, attempt)` reads the list the create posted to (one path for both) and keeps rows by this principal, created since the attempt (minus 2 minutes of clock skew), whose text matches. List orders were measured with GETs: chat lines come newest first, comments oldest first, to-dos in position order. Messages are newest first by the docs' default. A newest-first read stops at the first page that reaches back before the attempt
  - **It is a match, not a key.** Two identical rows by the same person in that window are both found. A to-do completed since the attempt has left its list's default read and is not found
  - **Rich text comes back wrapped in `<div>`** (0.2's bodies), so the match compares text, never markup. **Unmeasured:** how real Basecamp rewrites posted HTML, because no write has reached the account
  - **`completeTodo` is replayable**: a completion is a state, so it is the one verb conduit resends after a lost answer. The old step text said every verb was unreplayable, which was wrong for this one. Uncompleting is not built
  - **A message without `status: active` is a draft** (`messages.md`), one nobody is told about, so `postMessage` always sends `status: active`
  - **A rich-text field takes `{ html }`, and a bare string is refused**, which leaves 2.4 to add `{ text }` without renaming anything
  - Was: Verbs: `createTodo`, `completeTodo`, `postMessage`, `comment`, `chatLine`. Each unkeyed and unreplayable, each naming the read that resolves a lost answer (C6) — the feed filtered by `performers` and `types` since the event id before the write. The drive proves a write applied under a lost answer is found by that read
- [x] 2.4 **Done 2026-10-16: every rich-text body is `{ text }` or `{ html }`, exactly one, and 4 drive rows (40 in all), green. Each of the six breaks tried turns a row red.** What it changed:
  - **`{ text }` is escaped by the connector**: `& < > " '` become entities and each line break a `<br>`, which is `rich_text.md`'s minimum for writing. `{ html }` goes as the caller built it. A bare string, both keys, or neither is a `TypeError` before the send (C9)
  - **A chat line takes `RichText` too and always sends `content_type: text/html`**, where 2.3 sent a bare plain string. `campfires.md` makes a line plain text unless it says `text/html`, and no read has measured how a plain line is stored. Every line in 0.2's feed is `Chat::Lines::RichText`. So all four bodies have one shape, and a lost line is matched as a comment is
  - **A match strips tags before it decodes entities**, the reverse of the plain-text recipe in `rich_text.md`. Decoding first turns an escaped `&lt;x&gt;` back into a tag and strips the writer's text with it
  - **A plain field is compared as written.** A to-do's `content` and a message's `subject` are not rich text, so `findCreated` folds only their whitespace. 2.3 stripped tags from them too, which made `Fix <div>` match `Fix`
  - **Unmeasured** still: what real Basecamp stores for an escaped body. `plain()` decodes either form, `&#39;` or `'`, so the match holds either way
  - Was: Rich text is HTML: a verb takes `text` (escaped by the connector) or `html` (the caller's), never a bare string whose `<` Basecamp would parse (C9). Confirm against `sections/rich_text.md` first
- [x] 2.5 **Done 2026-10-16: the sink takes `rateLimit: { retryAfter }`, `failNext`, `forbidden`, `inactive` and `/_sink/hide`, and 6 drive rows (44 in all; the old `translate.429KeepsRetryAfter` folded into `rate.aCreateIsRefusedNotLost`, which asserts the same three fields), green. Each of eight breaks tried, four in `translate`, one in the create, three in the sink, turns a row red. No connector code changed.** What it changed:
  - **A 429 and a 500 on a create are opposite answers.** A 429 is refused and never applied: `rate_limited`, `retryable`, `retryAfterMs`, one POST and not `indeterminate`, so the caller sends again after the wait. A 500 may have landed: `server_error`, `indeterminate`, one POST, and `findCreated` says which (`[]` in the sink, which applies no refusal). Both are conduit's ladder (`declineReplay`); the rows hold the connector to it. A read is resent on both, after `Retry-After` when there is one (measured at ≥ 1 s against `retryAfter: 1`)
  - **`Account Inactive` is account-wide**, so the sink answers it on every path until reset, not once. A read, a walk and a create are each one request, each `inactive`, none retried, and the create is not `indeterminate`
  - **A hidden row answers the 404 a missing id does, byte for byte**, and drops off its list. The bc-api README's 404 is *"a deleted item or insufficient permissions"*, and that is all `gone` claims now. **A trashed recording is unmeasured**: `recordings.md` lists `status=trashed` as a filter, so it may read `200` with `status: trashed`. The package's `CLAUDE.md`, README and `translate`'s header said trashed answered 404 too, an unverified claim, now removed. 6.2's re-read handles a `200` whose `status` is `trashed` as well as a 404
  - **An empty list answers `[]`, not a 404.** The sink 404'd a list nothing had been made on, so `findCreated` after a refused create on an untouched parent came back `gone` instead of `[]`
  - **Unmeasured:** the bodies of a 429 and a 500 (the sink uses the 404's `{ status, error }` shape) and `Account Inactive` itself, all the docs' words
  - Was: Sink and drive: `rateLimit` with `Retry-After`, `failNext`, a hidden `404`, an empty `403`, `Account Inactive`. The geared `Link` walk, `X-Ratelimit` on every answer and `304` on an `ETag` landed in 2.1–2.2, and `lost` in 2.3. Negative control: a target with an empty `User-Agent` gets the `400` (an absent one goes out as Bun's, 2.1)
- [x] 2.6 **Done 2026-10-16, sink only (owner's scope): `basecampTokenResolver(send, { clientId, grants })`, the sink's `/oauth/tokens`, and 6 drive rows (50 in all), green. Each of seven breaks tried turns its row red: no `withCache`, `expires_in` ignored, `onLost` dropped, rotation dropped, a refusal answered `null`, the refresh made replayable, no `client_id`.** What it changed:
  - **The resolver is the mint and nothing else.** Wrapped in `withCache({ ttl_ms: Infinity })` it is held until Basecamp's `expires_in` (`FJS-D1075`), and two sends across an expiry share one refresh, whether the clock found it or a `401` did. Nothing is hand-built beside the cache: `conduit-oidc` predates `FJS-D1075` and hand-builds the expiry and the in-flight map; this does not
  - **The grant store is `conduit-oidc`'s spelling**, `GrantStore { refreshTokenFor, onRotated?, onLost? }`, declared again here rather than imported, so one connector does not depend on another for an interface. `onLost` hears `invalid_grant`; the app stops answering the grant, and the next send fails closed with no request
  - **A refresh is sent once, as `conduit-oidc`'s is.** If Basecamp rotates, a lost answer has already burned the old token, and resending it would turn a live grant into `invalid_grant`. The cost is conduit's honest grade: a 500 at the token endpoint is `indeterminate`, so the `api` send is `auth_failed, retryable: false` though the grant is kept and the next send refreshes. A 429 there stays `retryable` with its `Retry-After`. If 4.1 measures that Basecamp does not rotate, the refresh becomes replayable and a 500 becomes worth retrying (`FJS-2722`)
  - **A rotated refresh token reaches the app before the access token is answered**, so a caller that crashes with the access token does not leave the app holding a burned one
  - **`authorization.json` is not the fallback.** An answer with no `expires_in` is a plain string, held until a `401` forgets it, which costs one refused send an hour and no second request per refresh
  - **Unmeasured:** whether Basecamp rotates, the words of its refusal (the sink's are RFC 6749's), and whether a refresh needs `client_id` (it is sent, as RFC 6749 asks of a public client). A live refresh waits for 4.1, and with it the question of whose OAuth client refreshes: the connector's own, registered at `app.basecamp.com` with one device-code consent, or the CLI's from the keyring, which logs the CLI out if refresh tokens rotate
  - Was: `api`'s token: Jordan's `app.basecamp.com` token stored as `FJS-D1126` rules, refreshed through the `token` target (`auth: none`, `FJS-D933`), `expires_at` from the token answer or `authorization.json` (`FJS-D1075`). It lives an hour, so a refresh is routine, not rare. The drive proves two sends in flight across an expiry make one refresh, and a refused refresh is `auth_failed`, not a retry loop.

### Phase 3 — The feed

Goal: every account event reaches the app once, and nothing acts on a pointer it has not re-read.
Done when: the drive proves resume from `position`, `409` re-entry by `since`, `410` re-entry by `resume`, dedupe by event id (a replayed page dispatches nothing new, `FJS-D1354`), and a re-read before apply.

- [x] 3.1 **Done 2026-10-20, sink only: `pollEvents(send, { since | position | url, types?, buckets? })` → `{ events, position, next? }` or `{ error }`, `FEED_TYPES`, the sink's `events.json`, and 8 drive rows (58 in all), green. Each of nine breaks tried turns a row red: `exclude_performers=self` added, no default types, the 409 code dropped, `resume` dropped, a `next` rebuilt instead of followed, `next` dropped, a time accepted as `since`, and the sink's 409 removed. The nine were answered before the code.** What it changed:
  - **A poll is one page.** The docs say to store `position` only after the page is applied, so the caller loops: apply, store, and follow `next` with `{ url: next }` until it is gone. A walk inside the connector would hand back a position for pages the caller never applied
  - **`url` is the third way in**, and it is followed whole, as `walk()` follows `Link`. A page's `next` and a 410's `resume` both come from Basecamp and already carry their filters, so `types` and `buckets` are not added to either. 0.3's headers show `next` carries a different token from the body's `position` (it holds the walk's frozen head), so resuming from `position` would be a different walk, not the same one continued
  - **`FEED_TYPES` is sent when a poll names no types**: 0.4's sixteen. Without a `types` filter the feed serves its whole catalog, which grows on the deploy that adds a type. Changing the list changes the filter set, so each held position answers `filters_changed` once
  - **Re-entry is the caller's**, as Gmail's `history_gap` resync is. A refusal is `refused` with a `code`: `invalid_position` (Basecamp's `reason`) and `filters_changed` (409) re-enter by `since` from the last event applied, `before_epoch` (410) by the failure's `resume`, and `invalid_filter` is the filters, which no cursor fixes. A 409 or 410 body has no `reason`, so `translate` names the code by status. Reading all 71 sections of bc-api on 2026-10-20 found no other endpoint that answers 409 or 410
  - **A poll states where it enters.** With no cursor Basecamp enters at the present without saying so, so the connector refuses a poll that names none and asks for `{ since: 'now' }`. A time as `since`, a negative id, two cursors, an empty `types`, a type with a comma and a 101st bucket are each a `TypeError` before the send (C9)
  - **No `ETag` on a poll.** An idle poll's `304` saves a body of about 180 bytes. Whether a `304` still costs a request against the 50 per 10 s is unmeasured, so it was left out; the reopen path is `walk()`'s `etag` spelling
  - **Unmeasured:** the 409 and 410 bodies beyond the fields the docs name, whether Basecamp's `next` repeats the filters (0.3 walked without any), and any filtered poll against the account. The sink's tokens are its own, bound to the docs' `srv2` digest
  - Was: `pollEvents(send, { position | since, types?, buckets? })` → `{ events, position, next }`, WITHOUT `exclude_performers=self`: under Jordan's token `self` is Jordan, and excluding it would drop Jordan's own activity (`FJS-D1182`, amended). An echo of the app's own write is a no-op because 3.3 applies the recording's current state; a flow that acts on events skips the recordings the app created, kept as a ledger of its own write ids
- [x] 3.2 **Done 2026-10-20, a reading step (`FJS-D1354`, amends `FJS-D1183`): a page does not enter through `receive()`. The poll job dispatches each event as `dispatch({ id: '37signals:event:<id>' })`, then stores `position`.** What it changed:
  - **`receive()` takes only what is pushed.** Its two ingresses are a route (`accept()` over a `Delivery`) and a held socket (`acceptFrame()` over a broker frame). A page is a batch, and `FJS-D899` keeps batches out until a second app asks. Neither existing puller asks: ELA's Service Autopilot syncs are caravan jobs over `send()`, and conduit-gmail's history pull is the app's own sync code, with only the push going through `receive()`
  - **`position` advances once the page is queued, not once it is applied.** Caravan's primary key on the job id is the dedupe by event id the Done-when names, the same shape as the outbox relay (`FJS-D35`) and a broker handler (`FJS-D235`). A permanently failing event goes dead in caravan, where it can be re-run, and does not stall the account's cursor
  - **Dedupe lasts for caravan's `cleanupAfter`** (7 days by default), not for all time. That is enough: a replay only follows a crash between the dispatches and the store, and 3.3 lands current state, so an older replay is harmless. Caravan's `CLAUDE.md` and the root Packages row say *for all time*, and `src/index.ts`'s cleanup sweep deletes terminal jobs, so those two lines overstate it
  - Was: check whether `app.conduit.receive()` takes one (ELA polls Service Autopilot); otherwise the feed is a read and the app's caravan job runs apply and then persists `position`
- [ ] 3.3 The re-read, in the apply job 3.2 dispatches to: an event is a pointer, so apply fetches the recording first. A `404` there is `gone` and the event is dropped, not retried
- [ ] 3.4 After 3.3 (`FJS-D1183`): `stream_ticket` → a `broker` target, ActionCable framing (`welcome`, `confirm_subscription`, `ping`) as a `FrameDialect`, and each frame wakes 3.1. A fresh ticket per dial

### Phase 4 — A person's credential

Goal: a verb authored as a person other than Jordan, spending that person's token.
Done when: a `per_caller` send spends the caller's token, refreshed by 2.6's mint.

- [ ] 4.1 A `per_caller` `api` target over 2.6's refresh, one token per caller as `FJS-D1126` rules

### Phase 5 — The first caller

Goal: one Kobami flow off the CLI and onto the connector.
Done when: that flow runs end to end against the real account, and the CLI still serves the Claude sessions.

- [ ] 5.1 Pick the flow with the owner, and name the Kobami app that lists `Project`, `Todo`, `Message` and `Comment` (`FJS-D1184`); wire the flow through `app.conduit.send()` and run it against the account

### Phase 6 — The mirror claim

Goal: the four nouns mirrored in the app 5.1 named, kept current by the feed where the catalog covers them and by a scope walk where it does not (0.4).
Done when: the drive proves a claimed write forwards and its row returns, a feed event updates a row after a re-read, a `404` alone deletes nothing, and a to-do reopened with no event is corrected by the next scope walk.

- [ ] 6.1 The claim: `Project`, `Todo`, `Message`, `Comment` with `create`/`update`/`delete` to a `ConduitRequest` and `parse` to a row (`FJS-D1125`), the models hand-written in the app (`FJS-D1130`); Basecamp's person, if claimed, is `Profile` (`FJS-D1152`)
- [ ] 6.2 The sync rides Phase 3: an event re-reads its recording and applies the row; a `404` is `gone` to this principal and drops a row only under a complete read of its scope (`FJS-D1180`). The feed is not the whole sync (0.4). `Project` has no event type, so its rows come from a re-walk of `projects.json`. No noun has an event for uncomplete or trash, so a scheduled walk of each claimed scope is the floor, and its cadence is the longest a row can stay stale. The connector's README limits paragraph says so, so that a reader of the mirror does not take a quiet feed to mean nothing changed

---

## The nine (`PHILOSOPHY.md` § V) — answered late, after the first draft

Two moved the draft: a coined `unseen` became `gone` (2 concept, 4 predictability — five connectors already spell a 404 that way), and `basecampTarget` + `launchpadTarget` became one `basecampTargets()` (4, google-maps' C1 amendment). 6 owner: inbound is `app.conduit.receive()`'s, so 3.2 asks whether a poll fits it before anything is built beside it; a refresh is `FJS-D933`'s. 7 boundary: 2.4's `text`/`html` split means a caller need not know Basecamp parses HTML. 9 silence: *a lost write is never re-posted* and *a hidden 404 is never a deletion* fail drive rows (C11); *nothing in `packages/` imports it before promotion* has no artefact — `none`. Adjudication: *batteries vs. smallness*, deferred to promotion (`FJS-D1181`). Tier: Register for the rulings (`FJS-D1181`–`FJS-D1184`), Assessment for the rest.

2.3's nine were answered BEFORE its code. They moved the resolving read from the feed to the parent's list (5 derived: the list is the path the create posted to; 9 silence: the feed's own docs say its silence is not proof). What they left as `none` is how real Basecamp rewrites posted HTML, which is unmeasured until a write reaches the account. No adjudication is in tension. Tier: Assessment for the plan, Map for the package docs.

## Not planned

Webhooks (`FJS-D1183`) · attachment upload (a raw binary
body, which `FJS-651` made possible) · the inbox, which only agents may poll · an Agent credential, until Basecamp enables agents for Kobami's account (`FJS-D1182`, amended) ·
any 37signals product but Basecamp.

## See also

- `conduit-connectors.md` § Basecamp — the 2026-09-02 argument this builds on
- `mirror-apps.md` — the Mattermost plan; Phase 2 is this plan's shape
- [bc-api README](https://github.com/basecamp/bc3-api/blob/master/README.md) · [event feed](https://github.com/basecamp/bc-api/blob/master/sections/event_feed.md) · [webhooks](https://github.com/basecamp/bc3-api/blob/master/sections/webhooks.md) · [Launchpad auth](https://github.com/basecamp/api/blob/master/sections/authentication.md) · [bc-api auth](https://github.com/basecamp/bc-api/blob/master/sections/authentication.md) · `app.basecamp.com/.well-known/oauth-authorization-server`
