# @frontierjs/conduit-mattermost

Mattermost over `@frontierjs/conduit`: the connector of the first mirror app
(`IDEAS/mirror-apps.md`). New, sink-only. **Team Edition self-hosted states no
history cap and no user cap** (read off its System Console); `missingSince` on
a mirrored row therefore means Mattermost deleted it, never that it aged out.
Mattermost Cloud Free caps 10k visible messages, 10k push a month and 250
users, and an app on it reads `missingSince` the other way. **Mattermost is
self-hosted, so the target has no default address** and the builder refuses
without one.

## What it covers

| Piece | Where |
| --- | --- |
| targets | `mattermostTargets({ address, ref?, userRef?, id? }) → { service, user, upload }` — `service` is the bot's token (`MATTERMOST_TOKEN`), bearer, for what no person's view holds (a mirror's sync reads as each person, `FJS-D1153`); `user` is `MATTERMOST_USER_TOKEN`, bearer `per_caller`, the human's — the resolver's `getFor(ref, who)` reads the token off the app's `@encrypted` column (`FJS-D1126`); `upload` is the same person's ref with `encoding: 'binary'`, for `POST /files`. No default address: the builder refuses without one |
| bind | `bindMattermost(conduit, targets, { as: 'service' \| 'user' }) → { api, upload }` — WHOSE token a call spends is chosen here, once; every verb takes the bundle and picks its role. `api` is the service or the user target per `as`; `upload` is the upload target under `as: 'user'` and refuses under `as: 'service'`, because a file is posted as its author or not at all |
| verb | `postMessage(mm, { channelExternalId, message, rootExternalId?, props?, pendingPostId? })` — `POST /api/v4/posts` as whoever the bundle `mm` was bound `as` |
| reads | `me`, `listTeams`, `listChannels(mm, user, team, { includeDeleted })` (a person's direct and group channels are listed under every team), `listMembers`, `listProfiles(mm, ids)`, `listPosts(mm, channel, { since \| before \| after, perPage, page })` with each post's `reactions` and `files` off its `metadata`, `postsSince(mm, channel, since)` — every one `replayable`, so conduit replays a lost answer; `since` lists deletions too, as `deletedAt` |
| errors | `translate(error, status?, headers?)` → `MattermostFailure { kind, code, retryable, retryAfterMs }` |
| claim | `mirror` — what `app.conduit.mirror(mattermost.mirror)` binds (`FJS-D1125`): one `MirrorModel` per noun of `IDEAS/mirror-apps.md` § Mattermost nouns marked *mirrored*, each with `parse(remote) → row` keyed `externalId`, and `create` / `update` / `delete` → a request where the noun has a verb |
| keys | `memberKey(channel, user)` · `reactionKey(post, user, emoji)` · `threadKey(user, root)` — composed once, read back by `delete` |
| receive | `mattermostWebhookDialect` (the outgoing webhook → a `webhook` event) · `mattermostCommandDialect` (the slash command → a `command` event) — what `app.conduit.receive({ provider: 'mattermost', path, dialect, credential, apply })` takes (`FJS-D899`); `verifyMattermostToken()` beneath both; `respond(mm, responseUrl, { text, responseType? … })` answers a command through its `response_url` |
| socket | `mattermostSocketTarget({ address, id?, ref? })` — a `broker` target at `/api/v4/websocket`, one per person, dialed with that person's token (`FJS-D1153`) · `mattermostSocketDialect` — the `FrameDialect` `app.conduit.receive({ provider: 'mattermost', target: MATTERMOST_SOCKET_TARGET, dialect, apply })` takes (`FJS-D1127`); `mattermostFraming` beneath it |
| types | Mattermost's own shapes (`Post`, `Channel`, `Team`, `User`, `ChannelMember`, `UserThread`, `Reaction`, `FileInfo`, `PostList`, `OutgoingWebhookPayload`, `SlashCommandPayload`) and the rows (`PostRow` …) |
| sink | `sink.ts`; `/_sink/seed` answers the seeded ids; `POST /api/v4/channels/direct` makes a direct channel; `{ sinceLimit }` lowers `since`'s cap; `POST /api/v4/hooks/outgoing` and `POST /api/v4/commands` register what it delivers, `POST /api/v4/commands/execute` runs a command; `/api/v4/websocket` pushes what the REST writes did, `POST /_sink/socket` pushes a frame by hand |
| drive | `bun run drive` — 49 rows, sink only |

## The claim

| Model | Key | Verbs | Spends |
| --- | --- | --- | --- |
| `Team` | `id` | — | service |
| `Channel` | `id` | create (`open` \| `private`), update (`/patch`), delete | user |
| `ChannelMember` | `channel:user` | create (join), delete (leave) | user |
| `Post` | `id` | create, update (`/patch`), delete | user |
| `Thread` | `user:root` — one user's view; `parse(thread, { profileExternalId })` | — | user |
| `Reaction` | `post:user:emoji` | create, delete | user |
| `Profile` — Mattermost's user, never `User`, which is every auth app's `@@auth` model | `id` | — | service |
| `FileInfo` | `id` — bytes are proxied, `GET /files/{id}`, not built | — | service |

A row's relation columns hold the **Provider's** ids under `<relation>ExternalId`
(`channelExternalId`, `profileExternalId`, `rootExternalId`), and the app relates
on them directly — `channel Channel @relation(fields: [channelExternalId],
references: [externalId])` — so no write waits on a local id. A
Mattermost time is a `Date` and `0` is `null`. A Mattermost code is a word:
`type: 'O'` is `'open'`, `roles` stays the string it is and is never trusted
for standing. Every verb spends the per-user target: a message is posted as
its author, or not at all (rule 3). `direct` and `group` channels are made by
their members and `Channel.create` refuses them by name.

## Idempotency

Mattermost honors no `Idempotency-Key`. A post is collapsed only under the
body's `pending_post_id`, inside the server's 30 s window, so `Post.create`
with the caller's `pendingPostId` is `replayable: true` and conduit replays a
timed-out post; the drive shows one message in the channel after a lost
answer. Without it a lost post is `indeterminate` and nothing lists a post by
what the caller sent — `listPosts({ since })` by author and message is a
guess, not a read. Pass one. Every other write is unkeyed and unreplayable;
every read is replayable.

## Receiving

Mattermost makes two HTTP deliveries to an app and **signs neither**: the
outgoing webhook, fired when a post's first word is one of a hook's trigger
words, and the slash command. Each hook and each command carries its own
static token, in the body as `token` and in `Authorization: Token <t>` (the
command always; the webhook on a recent server). `verifyMattermostToken`
compares every token present constant-time against the credential the app
holds for THAT hook, and a request with none is refused. With several hooks
or commands at one path, the receiver's `credential` is a function of the
delivery choosing the key by `trigger_word` or `command` — never by the
token it is about to check. Mattermost retries neither delivery; the dedupe
key (`post:<post_id>`, `command:<trigger_id>`) is the replay guard a static
token lacks, and a body with no `post_id` or no `trigger_id` is *not an event*.

| Event | Payload | Dedupe |
| --- | --- | --- |
| `webhook` | `postExternalId`, `channelExternalId`, `teamExternalId`, `profileExternalId`, `channelName`, `teamDomain`, `userName`, `triggerWord`, `text`, `fileExternalIds`, `at` | the post's id |
| `command` | `command` (`/roll`), `text` (what followed), `responseUrl`, `triggerId`, `channelExternalId`, `teamExternalId`, `profileExternalId`, `channelName`, `teamDomain`, `userName` | Mattermost's `trigger_id` |

**The answer body is conduit's**, and Mattermost reads a 200 with no `text`
as *nothing to post*, so a reply is a send from inside `apply`: a command
answers with `respond(mm, ev.payload.responseUrl, { text })` — ephemeral by
default, `in_channel` for a post, five messages inside 30 minutes, unkeyed and
unreplayable with nothing that lists what a response URL posted; an outgoing
webhook answers with `postMessage(service, { channelExternalId, message,
rootExternalId: ev.payload.postExternalId })`, the bot's post in the thread.
Configure a command as **POST**: conduit mounts a receiver as `app.post`, and
a command configured as GET reaches no route. A webhook may be form-encoded
or JSON as its `content_type` says; the dialect reads either.

### The socket

The socket is what a mirror lives on: every post, edit and delete pushed as
it happens. It is a `broker` target and conduit holds it — dial, unbounded
reconnect, `health()` under `conduit:<target>` — so this package is only
Mattermost's framing and its events. **Mattermost sends a channel's events to
that channel's members and nobody else** — no admin or bot role widens it
(server `ShouldSendEvent`) — so a mirror that shows people their private and
direct channels holds one socket per person, on that person's token
(`FJS-D1153`), as Mattermost's own clients do. The same post reaches every
member's socket and lands once by its key. The dial carries `Authorization:
Bearer` and the handshake sends `authentication_challenge` with the same
token, since a server reads one or the other; `hello` is the success signal
either way and a `FAIL` reply is the refusal, which never reads as connected.
**Mattermost pushes nothing to a quiet person**, so silence cannot tell an
idle socket from one that died without a close. The framing's `keepalive`
sends the `ping` action every 30 s, which Mattermost answers `{ status: 'OK',
seq_reply, data: { text: 'pong' } }`, and conduit cuts a connection that has
sent nothing for 60 s and redials — whose `opened` starts the backfill.

**Mattermost redelivers nothing.** It acks nothing and has no retry, so a
frame whose `apply` throws is gone from the socket, and so is everything sent
while the connection was down. The REST backfill after the gap is what brings
those rows back — a caravan job queued from the receiver's `opened`, not the
socket. **`since` answers at most 1000 posts and which 1000 is unstated**:
the server takes the LIMIT in a query with no ORDER BY, so a full answer
cannot be paged by its latest time. `postsSince` reads the channel newest
first back to `since` when that happens and returns `truncated: true`, since
an older post edited or deleted inside such a gap is then not in the answer.
A membership has no `since` and is hard-deleted, so a removal made while no
socket was open is found by diffing a person's whole member list.

**`seq` restarts on every connection.** A frame's key is
`socket:<connection_id>:<seq>`, the id `hello` carries; keyed by `seq` alone,
the first post after a redial is a duplicate of the old connection's and is
lost. A frame sent twice on one connection applies once. Frames are handed
over in arrival order, so an edit never lands before its create. A `seq` that
skips ahead on one connection is frames the server dropped without closing:
the framing's `sequence` reads every event's `seq`, the ones `parse` ignores
too, and conduit hands the skip to the receiver's `gap` to start a backfill.

| Event | Payload |
| --- | --- |
| `posted` · `post_edited` · `post_deleted` | `{ post: PostRow }` — the full post, `data.post` decoded from its JSON string |
| `channel_updated` | `{ channel: ChannelRow }` |
| `channel_deleted` | `{ channelExternalId, at }` |
| `user_added` · `user_removed` | `{ channelExternalId, profileExternalId }` — the removed user's own copy names the channel in `data`, everyone else's in `broadcast` |
| `reaction_added` · `reaction_removed` | `{ reaction: ReactionRow }` — `data.reaction` decoded from its JSON string |
| `channel_created` · `direct_added` · `group_added` | `{ channelExternalId }` — a channel the socket's person can now read, with no history in the frame |
| `user_updated` | `{ profile: ProfileRow }` — `data.user` is an object here; another person's copy may blank the email, so the row leaves `email` out |

Every other event (`typing`, `status_change`, `thread_updated`…) is *not an
event* here: counted `ignored`, no receipt written.

## Errors

| Status | body `id` | conduit kind | `MattermostFailure.kind` | retryable |
| --- | --- | --- | --- | --- |
| 400 | `model.*.is_valid.*`, `store.sql_channel.save_channel.exists.app_error` | `client_error` | `refused` | no |
| 401 | `api.context.session_expired.app_error` | `auth_failed` | `auth_failed` | no — the token is dead |
| 403 | `api.context.permissions.app_error` | `auth_failed` | `forbidden` | no — the token is fine, the user is not there |
| 404 | `app.post.get.app_error` | `client_error` | `gone` | no — the sync marks `missingSince` |
| 429 | text, `X-Ratelimit-Reset: <s>`, no `Retry-After` | `rate_limited` | `rate_limited`, `retryAfterMs` from the reset | by the caller |
| 5xx | `api.context.500.app_error` | `server_error` | `server_error` | a read, yes; a write, no |

## Not built, with the reason

- **Socket resume** (`connection_id` and `sequence_number` on the redial, the server replaying its queue) — a reconnect is a new connection and its gap is the backfill's; resume needs the framing to shape the next dial's address, which conduit's broker does not ask of it.
- **Socket events past the table** — `thread_updated`, `added_to_team` and the rest; each joins when its model has a sync that lands it.
- **Incoming webhooks** (`POST /hooks/{id}`, a post with no user token) — the mirror app posts as its humans or as the bot through `/api/v4/posts`, so nothing here needs the unauthenticated door.
- **Interactive messages and dialogs** (`trigger_id` spent on `POST /actions/dialogs/open`) — a `command` event carries the `triggerId`; opening a dialog with it is a verb with no caller yet.
- **Login** (`POST /users/login`, the token in a response header) — the per-user token is a personal access token or a session the app obtained; obtaining it is the app's until a caller shows the shape.
- **File bytes**, **search**, **mark read**, **typing** — proxied verbs with no caller yet.
