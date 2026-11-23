---
id: workbench-messages
status: proposed
dated: 2026-11-16
---

# Workbench Messages — the team's Mattermost, read and written from Workbench

**Status: PROPOSED.** Dated 2026-11-16. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want: a Messages screen in Workbench that is a full client of the team's
Mattermost server. The UI is serpgrid's chat, the data is the Mattermost mirror
the chat prototype proved (`IDEAS/mirror-apps.md`), and Workbench hosts both.

---

## What exists

- **serpgrid has the UI and no Mattermost.** `../fjs-prototypes/serpgrid/web/src/`:
  21 components in `components/chat/`, routes under `routes/chat/` (room,
  threads, saved, scheduled, search, activity), `lib/chat.js` (1,355 lines),
  `lib/chat-commands.js`, `lib/link-cards.js`, `lib/typing.js`, `lib/quiet.js`.
  It runs on 15 native models (`Room`, `RoomMember`, `Post`, `PostEdit`,
  `Reaction`, `Draft`, `ChatStatus`, `ChatSection`, `Pin`, `SavedPost`,
  `ThreadFollow`, `LinkPreview`, `ScheduledPost`, `ChatGroup`,
  `ChatGroupMember`), every row an agency's. Its design record is
  `../fjs-prototypes/serpgrid/discovery/chat.md`.
- **The chat prototype has the mirror and a thin UI.** `../fjs-prototypes/chat`:
  8 `@@mirror(key: externalId)` models (`Team`, `Profile`, `Channel`,
  `ChannelMember`, `Post`, `Thread`, `Reaction`, `FileInfo`),
  `api/src/providers/chat/index.ts` (the one file naming the vendor) and
  `sync.ts` (a socket and a backfill per linked person, `FJS-D1153`), the
  `chat` service (`connect`/`disconnect`), `routes/files/` (the byte proxy),
  and one 247-line channel page.
- **The connector is in this tree.** `packages/conduits/conduit-mattermost`:
  the `mirror` claim (writes for `Channel`, `ChannelMember`, `Post`,
  `Reaction`), reads, the socket dialect, and a sink with a 49-row drive.
- **Workbench has the host parts and a different door.** It already runs
  conduit, caravan, one `/ws` channel, the bell and the ntfy push. Its
  principal is `Member` behind one pass-phrase, with no `@frontierjs/auth` and
  no level ladder (`FJS-D1786`); the chat prototype's policies grade on
  `auth().profileExternalId` and level 4.
- **Litestone refuses a relation that crosses databases** (`placeModels` in
  `packages/litestone/src/core/parser.js` says so by name).
- **"Chat" is taken in Workbench.** The nav's *Chats* is the Claude Code chats
  and `workbench.ts` exports a `ChatStatus` type.

## How serpgrid's nouns land

| serpgrid | Here | Backing |
| --- | --- | --- |
| `Room`, a DM | `Channel` (`type` direct/group) | mirror |
| `RoomMember`, unread, mute | `ChannelMember` (`lastViewedAt`, `mentionCount`, `muted`) | mirror |
| `Post`, a reply | `Post` (`rootExternalId`) | mirror |
| `ThreadFollow` | `Thread.isFollowing` | mirror |
| `Reaction` | `Reaction` | mirror |
| `Pin` | `Post.isPinned` | mirror; the pin verb is new in the connector |
| a post's files | `FileInfo` + the byte proxy | mirror |
| people | `Profile` | mirror |
| `Draft` | Mattermost drafts (`AllowSyncedDrafts` on) | Mattermost |
| `SavedPost` | the `flagged_post` preference | Mattermost |
| `ChatStatus`, presence | status and `props.customStatus` | Mattermost |
| typing | the socket's `typing` frame | Mattermost |
| search, activity | post search (a POST; not probed, GETs only) | Mattermost |
| `PostEdit` | `posts/{id}/edit_history` (answered 404 for another person's post; own-post read unproved) | Mattermost |
| `LinkPreview` | the post's `metadata.embeds` | Mattermost |
| `ChatSection` | sidebar categories | Mattermost |
| reminders | `users/{id}/posts/{id}/reminder` (a POST; not probed) | Mattermost |
| `ScheduledPost` | the server answers 400 `license_error` | local, laptop-only |
| `ChatGroup` | the server answers 501 `license_error` | local, laptop-only |
| quiet hours, nudge | local model in `chat.db` | local |
| client rooms, task-from-post | need serpgrid's `Client` and `Task` | dropped; Q7 |

## Open questions

- ~~**Q1 — where the mirror lives.**~~ **Answered 2026-11-16 (`FJS-D2209`): A — inside Workbench, in a dedicated `chat` database of its own file, apart from `workbench.db`; `Member` holds a plain `profileExternalId` column and a local model a plain `memberId`, neither a relation, because Litestone refuses one across databases.**
  - **A** — inside Workbench, in a dedicated `chat` database of its own file, apart from `workbench.db`; `Member` holds a plain `profileExternalId` column and a local model a plain `memberId`, neither a relation, because Litestone refuses one across databases.
  - **B** — Workbench dials the running chat prototype's API.
  - **C** — Workbench opens the prototype's `app.db` as a second database.
  - **Recommend A** — one process, so Resources and the `/ws` tether work directly, and the mirror stays apart from Workbench's own rows.
- ~~**Q2 — the first version's cut.**~~ **Answered 2026-11-16 (`FJS-D2210`): A — full serpgrid parity, less the two features that need serpgrid's `Client` and `Task` (Q7).**
  - **A** — full serpgrid parity, less the two features that need serpgrid's `Client` and `Task` (Q7).
  - **B** — the core only: what the 8 mirror models already hold.
  - **Recommend A** — the owner asked for the whole screen, and Phase 3 lands it one feature at a time.
- ~~**Q3 — writes to the live server.**~~ **Answered 2026-11-16 (`FJS-D2211`): A — a full client: the owner posts for real, every drive runs on the sink, and no agent writes to `chat.kobami.cloud`.**
  - **A** — a full client: the owner posts for real, every drive runs on the sink, and no agent writes to `chat.kobami.cloud`.
  - **B** — read-only first.
  - **Recommend A** — a client that cannot post is not the screen asked for, and the sink carries the proof.
- ~~**Q4 — where the UI code goes.**~~ **Answered 2026-11-16 (`FJS-D2212`): A — copied and ported into `packages/workbench/web/src/components/chat/`; the copy ends at Phase 5, which rules on what moves to `@frontierjs/ui` with serpgrid as the second caller.**
  - **A** — copied and ported into `packages/workbench/web/src/components/chat/`; the copy ends at Phase 5, which rules on what moves to `@frontierjs/ui` with serpgrid as the second caller.
  - **B** — a shared chat UI package with an adapter per backend, designed up front.
  - **Recommend A** — the two backends' nouns differ, and which components are generic is only visible after one port.
- ~~**Q5 — what backs a feature the mirror lacks.**~~ **Answered 2026-11-16 (`FJS-D2213`): A — Mattermost's own API where Team Edition has one, a local model in `chat.db` otherwise; the screen marks a local-only feature as laptop-only.**
  - **A** — Mattermost's own API where Team Edition has one, a local model in `chat.db` otherwise; the screen marks a local-only feature as laptop-only.
  - **B** — every extra is a local model.
  - **Recommend A** — the phone and the real clients then agree on drafts, saved posts and status.
- ~~**Q6 — the name.**~~ **Answered 2026-11-16 (`FJS-D2214`): A — the screen is *Messages* at `/messages/`; the database, provider folder, component folder and notification names stay `chat`, the prototype's and the connector's noun, which no Workbench page shows.**
  - **A** — the screen is *Messages* at `/messages/`; the database, provider folder, component folder and notification names stay `chat`, the prototype's and the connector's noun, which no Workbench page shows.
  - **B** — *Chat*, beside the Claude Code *Chats*.
  - **Recommend A** — the nav cannot carry two entries a letter apart.
- ~~**Q7 — task-from-post.**~~ **Answered 2026-11-16 (`FJS-D2215`): A — gone.** serpgrid's `WorkDialog` turns a post into a `Task`.
  The owner's "yes to all" did not pick a side of this either/or.
  - **A** — gone.
  - **B** — a Workbench version: a post becomes an `ISSUES.md` row or opens a Claude Code chat on a pin, quoting the post.
  - **Recommend A** — B is a second feature with its own design, and nothing in Phases 0–4 depends on it.
- ~~**Q8 — task-from-post, reopened for Basecamp.**~~ **Answered 2026-11-18 (`FJS-D2262`): A — a post becomes a Basecamp to-do in a project and list picked at the time, the post's permalink in its notes.** The owner picked Phase 6's
  three features on 2026-11-17, and one is a post turned into a to-do.
  - **A** — a post becomes a Basecamp to-do in a project and list picked at the time, the post's permalink in its notes.
  - **B** — stays gone, as `FJS-D2215` ruled.
  - **Recommend A** — the team's work lives in Basecamp, a target neither of Q7's options named.
- ~~**Q9 — when a catch-up recap runs.**~~ **Answered 2026-11-18 (`FJS-D2263`): A — on demand: a button per channel or thread on the catch-up feed, and nothing is sent until it is pressed.** A recap sends teammates' posts, DMs
  included, to Claude.
  - **A** — on demand: a button per channel or thread on the catch-up feed, and nothing is sent until it is pressed.
  - **B** — also a scheduled morning digest of overnight unreads, pushed through ntfy.
  - **Recommend A** — the member chooses each time what leaves the machine, and a digest can follow once recaps prove worth reading.
- ~~**Q10 — how Workbench reaches Basecamp.**~~ **Answered 2026-11-18 (`FJS-D2264`): A — `conduit-37signals`, through `app.conduit.send()`.**
  - **A** — `conduit-37signals`, through `app.conduit.send()`.
  - **B** — a shell-out to the `basecamp` CLI the owner is already signed into.
  - **Recommend A** — a drive runs it on the connector's sink, as every Messages verb was proved; its live grant is the 37signals plan's 5.2, which Intake waits on too.
- ~~**Q11 — whose 37signals grant Workbench sends a to-do on.**~~ **Answered 2026-11-23 (`FJS-D2341`): A — Workbench's own: one more authorization-code exchange through the OAuth app Intake uses, refreshed by `basecampTokenResolver`.** 6.5 reads a fixed
  `BC3_TOKEN`, and a Basecamp access token expires in about two weeks, so the
  live feature needs a refresh token.
  - **A** — Workbench's own: one more authorization-code exchange through the
    OAuth app Intake uses, refreshed by `basecampTokenResolver`.
  - **B** — through Intake: a route on Intake's deployed `api/` makes the to-do
    on Intake's grant, and Workbench signs in to Intake.
  - **C** — a copy of Intake's refresh token.
  - **Recommend A** — if Basecamp rotates refresh tokens (unmeasured,
    `conduit-37signals` 4.1), two holders of one token log each other out, so C
    breaks the 37signals plan's 5.1 ruling (each app's grant is its own); B adds
    a cross-app route and fails whenever Intake is down.

---

### Phase 0 — What the server answers

Goal: know which backing each extra gets before any model is written.
Done when: the table above has no "decided by 0.1" row.

- [x] 0.1 Read-only probe of the live server: version, edition, and whether
  drafts, saved posts (preferences), scheduled posts, sidebar categories,
  custom status, edit history, post search, user groups and post reminders
  answer for a member's token. GETs only.
  *Probed 2026-11-16: Mattermost 11.5.1, Team Edition, unlicensed, collapsed
  threads always on.*
- [x] 0.2 Fill the Backing column per feature from 0.1 under Q5.
- [x] 0.2a Write 0.1's result into `packages/conduits/conduit-mattermost/README.md`
  and make the sink refuse each endpoint Team Edition lacks, so a feature
  cannot go green on the sink and fail live.
- [x] 0.3 Read `discovery/chat.md` for behaviors the UI relies on that the
  mirror states differently (unread counts, mark-unread, who may post).
  Three differ, and the screen follows the server on each. **Unread** is
  serpgrid's watermark (`lastReadAt`, counted in JS, a thread sharing its
  room's); here it is the server's stored counts on `ChannelMember`, and a
  thread carries its own on `Thread`. **Mark unread** moved a watermark;
  here it is a server call, and on a reply it marks the thread. **Posting**
  in an unjoined public room joined it; here the server refuses, so Browse
  joins first.

### Phase 1 — The mirror in Workbench

Goal: Workbench holds a linked member's Mattermost, live, in `chat.db`.
Done when: a drive on the sink links a member, backfills, lands a socket
frame, forwards a post, and a second member reads none of the first's private
channels.

- [x] 1.1 `database chat` and the 8 mirror models with `@@db(chat)`; policies
  as the prototype has them, graded at Workbench's member level; initial
  migration under `db/migrations/chat/`.
- [x] 1.2 `Member.chatToken @secret`, `profileExternalId @system`,
  `chatSyncedAt @system`; `profileExternalId` projected onto the principal
  (`api/src/principal.ts`).
- [x] 1.3 `api/src/providers/chat/` (index + sync) moved from the prototype,
  `app.conduit.mirror(...)` bound, `CHAT_URL`/`CHAT_TOKEN` in `core/env.ts`,
  the sink as the default address in dev.
- [x] 1.4 Services for the 8 models, the `chat` service, the file proxy
  routes, the backfill job; `/ws` carries the chat channels beside
  notifications.
- [x] 1.5 The link card (paste a token, Connect, Disconnect) on `/laptop/`.
- [x] 1.6 The drive, on the sink.

### Phase 2 — The core screen

Goal: read and write a channel, a DM and a thread from `/messages/`.
Done when: a browser drive on the sink posts, replies, reacts, edits,
deletes, pins, uploads a file and sees another person's post arrive unread.

- [x] 2.1 Resources `Channel`, `ChannelMember`, `Post`, `Thread`, `Reaction`,
  `Profile`, `FileInfo`; nav entry *Messages*.
- [x] 2.2 `lib/chat.js` ported onto the mirror nouns — the one place the
  renames land (`roomId` → `channelExternalId`, `body` → `message`, user id →
  `profileExternalId`); agency and client code cut.
- [x] 2.3 Sidebar, room header, post list and item, composer, post editor.
- [x] 2.4 Thread pane, the threads route, follow and unfollow.
- [x] 2.5 Reactions, mentions, files, new channel and new DM dialogs.
- [x] 2.6 Unread, mark read and unread, mute; pin and unpin (connector verb).
- [x] 2.7 The browser drive.

### Phase 3 — The extras

Goal: every remaining serpgrid chat feature works, each on the backing 0.2
named.
Done when: the Phase 2 drive, extended one row per feature, is green.

A Mattermost-backed step is a connector verb, a mirror model where rows are
kept, a sync frame and the ported screen. A local step is a model in `chat.db`
and the ported screen.

- [x] 3.1 Drafts
- [x] 3.2 Saved posts and the saved route
- [x] 3.3 Status, custom status, presence
- [x] 3.4 Typing — shown, not sent. The broker socket stays receive-only, and sending is conduit-mattermost's `publishTyping` over REST (`FJS-D2303`).
- [x] 3.5 Search and the search route
- [x] 3.6 Activity (mentions and replies)
- [x] 3.7 Edit history
- [x] 3.8 Link previews
- [x] 3.9 Sidebar sections
- [x] 3.10 Scheduled posts and the scheduled route — local, sent only while Workbench runs.
- [x] 3.11 Reminders
- [x] 3.12 Groups — local; a handle is expanded to names at send.
- [x] 3.13 Quiet hours and nudge — the schedule is kept (`QuietSchedule`) and read by nothing until 4.1; nudge is dropped, the server has no such thing.
- [x] 3.14 Slash commands (`lib/chat-commands.js`)

### Phase 4 — Workbench wiring

Goal: a mention or a DM reaches the owner when the tab is closed.
Done when: a sink post naming the member raises a bell row and an ntfy push.

- [x] 4.1 `ChatMention` and `ChatDm` notifications through the bell and push. Only the owner gets the phone push; a quiet schedule holds the push and keeps the bell row.
- [x] 4.2 Unread total on the nav entry and the tray. The nav entry carries it; the tray is a fixed menu with no counts, so none is drawn there.
- [x] 4.3 The desktop shell builds and opens `/messages/`. The tray entry compiles (`cargo check`); the window was not opened.

### Phase 5 — What belongs in the UI package

Goal: the owner rules on which chat components become `@frontierjs/ui`.
Done when: a list of candidates, each with what it would need to lose to be
generic, is in front of the owner; moves follow the ruling.

- [ ] 5.1 Grade every file in `components/chat/` against what `@frontierjs/ui`
  already has. First candidates: `ReactionPicker`, `MentionList`,
  `CommandList`, `FileCard`, `WhenDialog`, `PostEditor`.
- [ ] 5.2 Move what is ruled in, with serpgrid's copy as the second caller.

### Phase 6 — What Mattermost cannot do

Goal: three views neither Slack's base plan nor Team Edition has, built on the
mirror Workbench already holds.
Done when: `verify:messages`, extended one row per step, is green on the sink,
and `conduit-37signals`'s sink receives a to-do made from a post.

None of this needs the server's help: 6.1 and 6.3 are queries over `Post`,
`Thread` and `ChannelMember`, and 6.2 is a local model like scheduled posts.

- [x] 6.1 Waiting on me — `/messages/waiting/`. *Built 2026-11-18 as `chat.waiting`
  (`api/src/domain/chat/waiting.ts`), "for me" by the bell's own `noticeKind`; a
  30-day window, a muted room is not waiting, and a later post by anyone in a
  DM counts as the answer.* Every DM post and mention of
  the member with no later post by the member in that channel (in that
  thread, for a reply), oldest first. Beside it, waiting on others: the
  member's last post in a DM or thread that nobody has answered since.
- [x] 6.2 Nudge if no reply — *Built 2026-11-18: `FollowUp` + `chat-followup` job,
  bell row keyed `followup:<id>`; `followUps` joined `CHAT_CHANNELS` so a second
  window sees it live.* On the member's own post, *Remind me if nobody
  replies* with `WhenDialog`'s times. A local `FollowUp` in `chat.db`; a job
  raises a bell row at the time (pushed under the 4.1 rules) unless a reply
  landed first, which clears it. Laptop-only, like scheduled posts.
- [x] 6.3 Catch-up — `/messages/catch-up/`. *Built 2026-11-18 as `chat.catchUp`
  (`api/src/domain/chat/catchup.ts`); a passed group is read through `chat.view`
  or `readThread` and stays on screen marked Read until Refresh.* Every unread post across channels
  and followed threads in one feed, grouped by channel, oldest first; passing
  a group marks it read through the existing mark-read.
- [x] 6.4 Recap on demand (Q9) — *Built 2026-11-18 as `chat.recap`: posts on stdin,
  `--tools ''`, newest 60 posts / 12,000 characters, $0.25 cap; flags run once
  against the real CLI on made-up text.* a *Summarize* button per group: one `claude
  -p` with no tools over the group's posts since `lastViewedAt`, shown inline
  and not stored. The drive runs it against a stub.
- [x] 6.5 Post → Basecamp to-do (Q8, Q10) — *Built 2026-11-18 on the sink:
  `chat.makeTodo` through `api/src/providers/bc3/` (off unless
  `BC3_ACCOUNT_ID` + `BC3_TOKEN`, `FJS-D2265`), notes = `permalinkOf` alone.* a post menu entry: project and
  list picked, a title prefilled from the post's first line and editable, the
  permalink as the notes, sent through `conduit-37signals`. What crosses is
  exactly what the dialog shows, because a DM's text in a client-visible
  project cannot be taken back; the drive makes a to-do from a DM post and
  asserts the notes hold the permalink alone. No local record of the link in
  v1, so a post can be turned into a to-do twice.
- [ ] 6.6 Live — after 6.7 and 6.8, the owner signs Workbench in to Basecamp
  and makes the first real to-do from a post, onto the Intake list. The
  owner's. Done when the to-do is in Basecamp with the permalink alone as its
  notes, and the first refresh records whether Basecamp rotated the refresh
  token. This also closes Intake's PLAN 4.2 (`fjs-prototypes/intake`).
- [ ] 6.7 A grant of Workbench's own (Q11, `FJS-D2341`) — the fixed `BC3_TOKEN`
  is replaced by a refresh token in a grant store of Workbench's, minted by
  `basecampTokenResolver`, so a to-do still sends after the two-week access
  token expires. One authorization-code exchange through the OAuth app Intake
  uses (`conduit-37signals` 5.2), started from a *Connect Basecamp* card on
  `/laptop/` beside the Mattermost link card. Never a copy of Intake's or the
  CLI's token. Check first which redirect URI that OAuth app allows. A lost
  grant is a typed `auth_failed` that the dialog shows, with the card offering
  to connect again. The drive runs the exchange and a refresh on the sink.
- [ ] 6.8 The dialog opens on the last place used — the to-do dialog opens on
  the project and list the member picked last, stored as bare ids per member,
  so the first pick of the Intake list sticks. The names are still read live
  from Basecamp, and a stored id Basecamp no longer answers falls back to the
  picker. No configured list id. The drive makes two to-dos and asserts the
  second opens on the first's list, then deletes the list on the sink and
  asserts the picker.
