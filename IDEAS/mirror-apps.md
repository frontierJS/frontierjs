---
id: mirror-apps
status: proposed
dated: 2026-10-16
---

# Idea — a mirror app: an FJS app whose truth lives in a Provider, on purpose

**Status: PROPOSED.** Dated 2026-10-16. Nothing in § Phases is built. Do not
cite this file as behavior — see `VERIFYING.md`. Claims about the tree were
grepped on the date above, not run.

---

## Trigger

A chat app is wanted and the phone surface is not ready, so a Mattermost runs
beside the app: its native mobile app for phones, FJS surfaces for the desktop
and the terminal, one truth between them that FJS does not own. The same shape
is already live once — ELA mirrors Service Autopilot and will keep doing so
(`conversion-ela.md` § 2) — and was asked once with a made-up source (Transit,
`stressors.md` #21). Three sites is a word waiting to be coined
(`doc-hygiene` § The four cuts), and this file coins it.

**A mirror app** is an app whose system of record is a Provider. It keeps a
`db/schema.lite`, services, gates and surfaces like any app; what differs is
that some models are declared `@@mirror` (`FJS-D843`) and the Provider's
nouns are known to exactly one package, its connector. Whether the mirror is
a bridge (Mattermost, until the phone surface exists) or permanent (ELA, where
the CRM stays the CRM) is a fact about the app, recorded in its `CLAUDE.md`,
and never argued from here — the same standing `PHILOSOPHY.md` § IV gives
*preservation vs. evolution*.

---

## What exists, and must not be restated here

| Piece | Where | What it settles |
| --- | --- | --- |
| **Provider** — a third party declared once, both ends | `VOCABULARY.md`, `FJS-D06`, `FJS-D681` | the noun; not *integration*, *adapter*, *wrapper* |
| send | `app.conduit.send()`, `FJS-D177` | how a call leaves |
| receive | `app.conduit.receive()` + `Dialect`, `FJS-D899` | how a delivery arrives: verify · parse · dedupeKey |
| `@@mirror(key: externalId)` | `FJS-D843` | a mirrored model is a declaration; the key named once; mirrored columns `@system`, a caller's write refused by construction; `missingSince` derived. **`absent:` waits for a second caller** |
| where a connector lives | `FJS-D153`, `conduit-connectors.md` | its own package, promoted on the second caller; prototype in `../conduit-connectors/` |
| the first instance | `conversion-ela.md` § Decisions owed, `stressors.md` #24 | poll-only, seven mirrored tables, raw payloads kept |
| a Provider's schema as something to READ | `reference-library.md` (Mattermost is in its pg_dump route) | the other use of the same project, not this one |

So the Data half and the Integrations half are ruled, and one instance runs.
What is missing is the sentence that says they are one shape, and the seams
below that neither ruling reached.

---

## The shape

1. **A model a surface LISTS is mirrored; a verb that acts once is proxied.**
   Channels, posts and members land in litestone under `@@mirror`; *post a
   message* is a custom method that calls `conduit.send()` and lets the sync
   bring the row back. The mirror is what buys the perks — offline reads,
   own search, own gates over theirs, and an exit that is half done because
   the rows are already in `.lite`. Without it the app is a skin.
2. **A surface never learns a Provider noun.** The service is `chat.post`,
   not `mattermost.post`; the resource is `Post`, not `MattermostPost`. The
   rule `IMail` adapters already follow, applied to every service a mirror
   app exposes. One `rg` for the vendor's name outside its connector should
   answer empty.
3. **Who authors a write decides whose credential it spends.** A human's
   message is posted as that human, so the app holds a per-user Provider
   credential (`@encrypted`); a sync is a machine and spends one service
   credential. Mattermost Team Edition has no SSO, which forces the first
   case and is why it is the right test.
4. **A Provider's commercial terms are a Data fact.** A history cap means
   the mirror's window is the Provider's and not the app's, and a row that
   leaves it is `missingSince`, never deleted. That is `FJS-D843`'s
   `absent:` with a second shape — Mattermost's cap, ELA's window, Transit's
   cursor.
5. **The exit is a drive, or the claim is prose.** Remove the connector:
   the app boots, every surface lists, `@@mirror` comes off and `externalId`
   stays as an ordinary column.

---

## The nine (`PHILOSOPHY.md` § V), answered before the first edit

1. **Origin** — none new. Each mechanism has its ruling above; this file
   adds the composition and five rules, and holds them until a ruling does.
2. **Concept budget** — one compound of a blessed word: *mirror app* over
   `@@mirror`. Q4 needed no second: the socket is a `broker` target
   (`FJS-D1127`).
3. **Complexity** — the problem's: two systems hold one truth. The field has
   named both halves — Evans's *anti-corruption layer* is the connector,
   Fowler's *strangler fig* is the exit.
4. **Predictability** — a mirror app is an app; knowing one predicts the
   next, because the only differences are `@@mirror` on some models and one
   package that knows the vendor.
5. **Derived** — the mirrored models could be derived from the Provider's
   own OpenAPI instead of hand-written (Q7). The rules above are stated, not
   derived, and that is why they are candidates for a ruling rather than a
   map.
6. **Owner** — every owner exists: the connector for the vendor's nouns,
   `@@mirror` for the key, `receive()` for a delivery, the connector's claim
   under `app.conduit.mirror()` for a verb (`FJS-D1125`), and conduit's
   broker transport for the socket the app holds open (`FJS-D1127`) — the
   one the paper first read as unowned.
7. **Boundary** — typed: a connector exports functions over
   `ConduitRequest`; a mirrored column refuses a caller's write by
   construction; a service's name is the app's.
8. **Failure** — a Provider's cap silently truncates history, so the mirror
   warns by `missingSince` and never deletes; a write to a mirrored column
   is refused, since the sync would overwrite it in silence otherwise.
9. **Silence** — what must stay true: the app runs without its connector.
   What fails when it stops: **none today**; Phase 4 makes it a drive.

**Adjudications in tension.** *Batteries vs. smallness* — the connector is
severable, one seam, removable without surgery, which Phase 4 proves.
*Familiarity vs. precision* — the ecosystem says *integration* and *wrapper*;
the Provider row already refuses both, and this file follows it. *Paved road
vs. the workaround* — the road is an app that owns its schema; a mirror app is
the road for the case where it cannot, written down so the case is counted
rather than worked around per app. No other row is in tension.

**Tier.** Assessment. Each Q below was a Register question and is ruled
(`FJS-D1124`–`FJS-D1130`); the five rules become a map sentence in the
connector's `CLAUDE.md` with Phase 2.

---

## Open questions

- ~~**Q1 — Mirror or proxy, per model: is rule 1 the rule?**~~ **Answered 2026-10-16 (`FJS-D1124`): A — as written: listed is mirrored, one-shot is proxied.**
  - **A** — as written: listed is mirrored, one-shot is proxied.
  - **B** — mirror everything the Provider emits; the app is an event log of the Provider.
  - **C** — mirror nothing; every service is a proxy and litestone holds only the app's own rows.
  - **Recommend A** — B pays for rows no surface reads; C is the skin rule 1 refuses, and forfeits the exit.
- ~~**Q2 — A write to a Provider-owned field: refuse and go through a verb, or declare write-through?**~~ **Answered 2026-10-16 (`FJS-D1125`): C — refused at the column as `FJS-D843` rules, and the verbs DERIVED: the connector exports a claim naming the models it feeds (`Post`, `Channel`…) with `create`/`update`/`delete` to a `ConduitRequest` and `parse` from the Provider's response to a row; the app binds it in wiring, `app.conduit.mirror(mattermost.mirror)`, the way a Receiver names its `provider` in app code (`FJS-D899`); junction's default service on a claimed model forwards through it, applies the response row, and the socket's event dedupes by key. The schema stays `@@mirror(key: externalId)` with no Provider named, so rule 2's `rg` holds. Boot refuses by name a claim on a model the schema lacks, on a model not `@@mirror`, or a second claim on one model. An unclaimed mirror is A.**
  - **A** — `FJS-D843` as ruled and nothing more: refused at the column; the app hand-writes a custom method per verb that sends, and the sync brings the row back.
  - **B** — `@@mirror(key, writes: provider)`: a patch to a mirrored column is forwarded to the Provider by the connector.
  - **C** — refused at the column as `FJS-D843` rules, and the verbs DERIVED: the connector exports a claim naming the models it feeds (`Post`, `Channel`…) with `create`/`update`/`delete` to a `ConduitRequest` and `parse` from the Provider's response to a row; the app binds it in wiring, `app.conduit.mirror(mattermost.mirror)`, the way a Receiver names its `provider` in app code (`FJS-D899`); junction's default service on a claimed model forwards through it, applies the response row, and the socket's event dedupes by key. The schema stays `@@mirror(key: externalId)` with no Provider named, so rule 2's `rg` holds. Boot refuses by name a claim on a model the schema lacks, on a model not `@@mirror`, or a second claim on one model. An unclaimed mirror is A.
  - **Recommend C** — a verb has an owner either way; A restates one shape eight models times three verbs per app, which is the hand-kept copy `FJS-D843` itself refused; B makes a column write a network call, which no sibling column does (§ V 4). C keeps the vendor out of `db/schema.lite` — a `provider:` argument there was priced and refused for breaking rule 2's grep.
- ~~**Q3 — Per-user credential: where does it live and what standing does it confer?**~~ **Answered 2026-10-16 (`FJS-D1126`): A — a row on the `@@auth` user, `@encrypted`, holding the Provider token; standing is the app's own gate; the Provider's role is a mirrored column, read and never trusted.**
  - **A** — a row on the `@@auth` user, `@encrypted`, holding the Provider token; standing is the app's own gate; the Provider's role is a mirrored column, read and never trusted.
  - **B** — the Provider's role maps to the app's standing (Provider admin → app admin).
  - **Recommend A** — Invariant 6 says access is declared in the schema; B lets a third party's role table grade the app.
- ~~**Q4 — The third ingress: a subscription the app dials and holds open (Mattermost's WebSocket). Whose is it?**~~ **Answered 2026-10-16 (`FJS-D1127`): A — a Target of kind `broker` (`FJS-D235`). The paper first refused this as *where we publish*; `transports/broker.ts` says the opposite — *dial out, then receive; nothing is sent over it* — and already owns the dial, an unbounded reconnect, `health()` for readiness and a handler per frame. What it lacks is Mattermost's framing: it reads `{id, type: 'message', body}` and acks, where Mattermost sends `authentication_challenge` after open and then `{event, data, broadcast, seq}` with no ack. So the connector supplies the frame codec and the post-open handshake, and each frame reaches `conduit.accept()` → Dialect → Receiver `apply` → litestone as system.**
  - **A** — a Target of kind `broker` (`FJS-D235`). The paper first refused this as *where we publish*; `transports/broker.ts` says the opposite — *dial out, then receive; nothing is sent over it* — and already owns the dial, an unbounded reconnect, `health()` for readiness and a handler per frame. What it lacks is Mattermost's framing: it reads `{id, type: 'message', body}` and acks, where Mattermost sends `authentication_challenge` after open and then `{event, data, broadcast, seq}` with no ack. So the connector supplies the frame codec and the post-open handshake, and each frame reaches `conduit.accept()` → Dialect → Receiver `apply` → litestone as system.
  - **B** — a Receiver with a transport other than HTTP: the app dials, the Dialect still verifies and parses each frame. The dial loop would have no owner, and would re-grow what `broker.ts` has.
  - **C** — a long-running job (`app.jobs`) holds the socket and hands each frame to `conduit.receive()`. 0.4 proved caravan can — but it is a second place holding a socket open, beside the one conduit already keeps.
  - **Recommend A** — one owner for every socket the app holds open, and caravan appears only where a one-shot belongs: the REST backfill after a reconnect gap, dispatched `unique`.
- ~~**Q5 — Is the exit a drive?**~~ **Answered 2026-10-16 (`FJS-D1128`): A — `verify:mirror-exit` in `DRIVES.md`: connector removed, app boots, each surface lists.**
  - **A** — `verify:mirror-exit` in `DRIVES.md`: connector removed, app boots, each surface lists.
  - **B** — a sentence in the connector's README.
  - **Recommend A** — § V 9 permits `none` and this is the one claim the whole file rests on.
- ~~**Q6 — A Provider's caps (Mattermost Cloud Free: 10k visible messages, 10k push a month, 250 users; Team Edition self-hosted: none, read off the System Console 2026-10-16): README, or a field the code reads?**~~ **Answered 2026-10-16 (`FJS-D1129`): A — the connector's README, first paragraph, the way postmark's says *signs nothing*.**
  - **A** — the connector's README, first paragraph, the way postmark's says *signs nothing*.
  - **B** — `TargetDescriptor.limits`, read by the sync to size its window.
  - **Recommend A**, and B when a second connector needs the code to read one.
- ~~**Q7 — Derive the mirrored models from the Provider's OpenAPI?**~~ **Answered 2026-10-16 (`FJS-D1130`): A — hand-write them, as ELA did.**
  - **A** — hand-write them, as ELA did.
  - **B** — a `litestone import` reader for OpenAPI emitting `.lite` with `@@mirror` on each model, the way `reference-library.md`'s readers emit from a dump.
  - **Recommend A** now, B on the second Provider that ships a spec.

---

## Phases

### Phase 0 — Groundwork

Goal: know which nouns a chat surface lists, from a running Mattermost.
Done when: a table of Mattermost nouns marked *mirrored* or *proxied* under rule 1, and the connector's limits paragraph drafted.

- [x] 0.1 Read `conversion-ela.md` § Decisions owed and `FJS-D843`; note ELA's answer to each Q above where it has one
  - ELA answers Q2 only, by `FJS-D843` (A as ruled). Its owed #2 *mirror or own* is Q1 asked of SA tables and is still open there; #1, #3, #4, #5 (tenancy, raw payloads, sti columns, money) have no Q here. ELA has one service credential and polls, so Q3 and Q4 are new ground.
- [x] 0.2 Boot Mattermost Team Edition from the CapRover one-click on a dev slot; confirm the edition's history and user caps against its own admin console, not a blog
  - Running already; owner read the System Console 2026-10-16: no history cap, no user cap. Rule 4's limits paragraph, drafted for the connector README: *Team Edition self-hosted states no history cap and no user cap; `missingSince` therefore means the Provider deleted the row, never that it aged out.*
- [x] 0.3 Dump its OpenAPI and list the nouns a channel view, a thread view and a member list need
  - Read from `api/v4/source/*.yaml` in the Mattermost repo (59 files; the published `api.mattermost.com` is a Docusaurus page, not the spec). The table is § Mattermost nouns below.
- [x] 0.4 Check whether `app.jobs` can hold a job open indefinitely (Q4 C)
  - Ran: a handler awaiting `ctx.signal` with no `timeout` held `running` at attempt 1 under one owner for 3× the lease, since an awaiting handler leaves the event loop free to heartbeat; three siblings completed beside it on the default queue (concurrency 2, one slot free); `stop()` aborted it through `ctx.signal` at `drainTimeout`. **Trap for 2.3:** after the drain the row is `done`, so a stated `id` would never dial again (root `CLAUDE.md` § Packages, caravan row) — the boot dispatch uses `unique`, which frees on terminal. **Superseded for the socket** by `FJS-D1127` — conduit's broker transport holds it; the probe stands for the one-shot REST backfill, which is the job.

#### Mattermost nouns

Rule 1 applied to the v4 spec. *Mirrored* is a `@@mirror` model; *proxied* is a custom method over `conduit.send()`; *ignored* is admin, cloud, LDAP, SAML, plugins and the other 50 path roots a chat surface never lists.

| Noun | Spec schema | Fed by | Read from | Kind |
| --- | --- | --- | --- | --- |
| Team | `Team` | `users/{id}/teams`, WS `update_team` | channel list header | mirrored |
| Channel | `Channel` | `users/{id}/teams/{id}/channels`, WS `channel_created/updated/deleted` | channel view | mirrored |
| ChannelMember | `ChannelMember` | `channels/{id}/members`, WS `user_added/removed`, `channel_member_updated` | member list | mirrored |
| Post | `Post` | `channels/{id}/posts` (page by `before`/`after`), WS `posted/post_edited/post_deleted` | channel view, thread view | mirrored |
| Thread | `UserThread` | `users/{id}/teams/{id}/threads`, WS `thread_updated` | thread view | mirrored, per user |
| Reaction | `Reaction` | `posts/{id}/reactions`, WS `reaction_added/removed` | post | mirrored |
| User | `User` | `users?in_channel=`, WS `user_updated`, `new_user` | member list, post author | mirrored |
| FileInfo | `FileInfo` | `posts/{id}/files/info` | post | mirrored, bytes proxied via `files/{id}` |
| post a message | — | `POST posts` | — | proxied, per-user credential (rule 3) |
| edit, delete, pin, react | — | `PUT/DELETE posts/{id}`, `posts/{id}/pin`, `POST reactions` | — | proxied |
| mark read | — | `channels/members/{id}/mark_read`, `threads/{id}/read` | — | proxied |
| typing | — | WS `typing` both ways | — | proxied, never stored |
| presence | `Status` | WS `status_change` | member list | proxied, live only |
| search | — | `posts/search`, `channels/search` | — | own search over the mirror (rule 1); the Provider's is the fallback for the uncached window |
| Draft | `Draft` | `users/{id}/teams/{id}/drafts` | — | own row, never mirrored — the app's draft is the app's |

The socket: `websocket`, one connection per credential, `authentication_challenge` with the user's token then `hello`; each frame is `{event, data, broadcast, seq}`. Every mirrored noun above has a WS event, so the sync is the socket and the REST list is the backfill.

### Phase 1 — Rulings

Goal: Q1–Q7 answered or explicitly waiting.
Done when: each Q names an `FJS-D` or says what it waits for.

- [x] 1.1 File Q1–Q7 for `fli decisions`; Q2 and Q3 lean on rulings already made and may close by citation
  - `fli decisions` reads this file's § Open questions directly, so filing was writing them; each shows with its recommendation.
- [x] 1.2 Q1–Q7 ruled through the question tool, `FJS-D1124`–`FJS-D1130`
  - Q2 and Q4 were re-asked with options the hearing produced: Q2's first pick wanted a default that *just works*, which became the claim (C); a `provider:` argument in the schema and a `createApp({ db, mirrors })` site were each priced and refused in `FJS-D1125`. Q4's A was rejected on a premise `broker.ts` contradicts, found by reading the file.

### Phase 2 — The connector

Goal: `conduit-mattermost` as a prototype in `../conduit-connectors/`, and the three framework seams the rulings name.
Done when: its drive is green against its sink, and a claimed model's `create` lands on the sink and returns the row.

- [x] 2.1 `mattermostTarget()`, `bindSend()`, `postMessage()`, `translate()` — the postmark shape — and the `mirror` export: the claim per model of § Mattermost nouns, `create`/`update`/`delete` to a `ConduitRequest` and `parse` from the response to a row (`FJS-D1125`)
  - `../conduit-connectors/packages/conduit-mattermost`, drive 18 rows green on its sink. Two targets, one per credential (oidc's shape): the service token, and `mattermostUserTarget()` as `per_caller` so a human verb spends the token `getFor(ref, who)` reads off the `@encrypted` column — every verb in the claim spends that one. Mattermost has no default address and the builder refuses without one. `pending_post_id` is the only key and it is the caller's, in the BODY: with it `Post.create` is `replayable` and conduit replays a lost post to one message; without it the post is `indeterminate`. **Three seams 2.4 confirms:** `MirrorClaim`/`MirrorModel` are declared in the connector until conduit owns them; `parse(remote, scope?)` carries what the response lacks and the request had (a thread's user, since `UserThread` is one user's view); relation columns are `<relation>ExternalId` holding the Provider's ids, and resolving them to the app's foreign keys is the sync's through the related model's key. Contract amendments C1, C3, C5 in the workspace's `CONTRACT.md`.
- [x] 2.2 Dialect for the outgoing webhook and the slash command token; a sink that replays Mattermost's envelope
  - `src/receive.ts`: `mattermostWebhookDialect` → a `webhook` event, `mattermostCommandDialect` → a `command` event, one `verifyMattermostToken` beneath both (every token present — body `token`, `Authorization: Token` — compared constant-time; the dedupe key, `post_id` / `trigger_id`, is the replay guard a static token lacks), `respond()` to a command's `response_url`. The sink registers hooks and commands at the real paths and fires them from `POST /posts` and `POST /commands/execute`, form or JSON, token in body and header; drive 29 rows. **Two calls made here, the nine answered after the build (late, `decision-rules`), for 2.4 and later:** (a) conduit's answer body stays conduit's — a reply is a send from `apply` (`respond()`, or `postMessage()` as the bot in the thread), so `Outcome` was not widened to carry a body; (b) with several hooks at one path the receiver's `credential` chooses the key by `trigger_word` / `command`, never by the token. Unverified against a real server: whether the outgoing webhook carries the `Authorization: Token` header (the docs show it for commands only; either source verifies).
- [x] 2.3 The socket as a `broker` target (`FJS-D1127`): `transports/broker.ts` takes a frame codec and a post-open handshake from the descriptor in place of its `{id, type, body}` constant and ack; the connector supplies Mattermost's (`authentication_challenge`, then `{event, data, broadcast, seq}`); each frame reaches `accept()` and a Receiver whose `dedupeKey` is the `seq`
  - **Two corrections to this step's text, found building it.** *From the descriptor* could not hold: a descriptor is stored as JSON and a function does not survive the store. The owner picked, through the question tool, **a Receiver that names a `target` in place of a `path`** (over a `framing` name on the descriptor installed like `signers`, and over a third `subscribe()` argument with the app restating the receipt order): `receive({ provider, target, dialect, owner?, apply })` subscribes the broker and runs each frame through `accept()`'s order from parse on (`acceptFrame`, sharing `land()` with `accept`), the junction plugin mounts no route for it, and `path`, `credential` and a dialect `verify` are refused by name. The connector's `FrameDialect` is `{ framing, parse, dedupeKey }`; `BrokerFraming` is `{ handshake?, decode, ack? }` in conduit's `types.ts`, the default being conduit's own envelope. *The `seq`* could not hold either: Mattermost's `seq` restarts per connection, so the key is `socket:<connection_id>:<seq>`, the id `hello` carries — keyed by `seq` alone, the drive's negative control loses the first post after a redial as a duplicate. Built beside: frames are handed over in arrival order through one chain per connection (the concurrent handoff landed an edit before its create and applied a doubled frame twice — both negative controls fail rows), `BrokerHealth.dropped` counts frames over the cap or unreadable, and the handshake gets the secret the dial spent. `../conduit-connectors/packages/conduit-mattermost/src/socket.ts`, drive 40 rows; `junction-integration.test.ts` § *a receiver that names a broker target* holds the no-route claim (forged POSTs 404; fails when the plugin mounts one). Conduit's suite 483 pass. The structural pick was heard before the build; the four sub-calls (connection in the key, serial handoff, `dropped`, the spent secret) had the nine answered after it — late, named here — and each passes: every one is `FJS-D1127`'s own text made concrete (*the dedupe key from the frame*, *dropped and counted*, *the handshake from the credential*) with no new noun beyond the two types the pick needed, `FrameDialect` and `BrokerReceiver`, and each has a failing row or case behind it. Unverified against a real server: whether the upgrade reads `Authorization: Bearer` (the framing sends both and waits for `hello`). Not built: resume (`connection_id` + `sequence_number` on the redial) — a reconnect's gap is the backfill's.
- [x] 2.4 junction: `app.conduit.mirror(claim)` in conduit's junction plugin — the claim table, the boot refusals by name, and the default service's forward on a claimed model (`FJS-D1125`)
  - Two structural picks were the owner's, through the question tool, before the build. **Where the forward enters:** junction's generated `create`/`update`/`patch`/`remove` ask `app.conduit.mirrored(accessor)` at call time — one member on junction's `AppConduit`, which conduit's `IConduit` must stay assignable to — over a generic `app.forwardWrites(model, fn)` slot (a second registry and noun for one caller) and over conduit wrapping built services at boot (it could not tell a written verb from the generated one). **`@@mirror` before 2.5:** the parser refused it as an unknown attribute, so this step took 2.5's parse half — `@@mirror(key: <field>)` parses, the key must be one `String`/`Int`, required and `@unique`, catalog row `model:mirror` (docs owed with 2.5), and `db.$mirrorKey(accessor)` answers it on every flavor — over reordering 2.5 first or deferring the not-`@@mirror` refusal.
  - Built: `packages/conduit/src/mirror.ts` (`MirrorClaim`/`MirrorModel` now conduit's, `assertClaim`, `createMirrors` — the verb → `send` → `parse` half), `IConduit.mirror`/`mirrored`/`claimed`, the plugin's boot check, and `mirrorClaimFor` in `junction/src/core/litestone.ts` for the Data half. `junction-integration.test.ts` § *a claimed mirror model* and § *boot refuses a claim the schema does not back* (11 cases, the patch case carrying an app-local `starred`) against a real litestone client and a recorder Provider; the connector drive's `mirror.forward*` rows (43 rows) against the sink. Negative controls: a forward over the unwrapped `send` fails 3 cases (no `who`, so `auth_failed`); the row validator left in front of the claim's input fails 1 (a `pendingId` is no column, refused 400); no boot check fails 3.
  - **Calls made inside the picks, the nine answered after the build (late, `decision-rules`):** (a) the forward runs only for a verb the claim exports — otherwise the generated verb runs as on any model, which is `FJS-D1125`'s *an unclaimed mirror is A* per verb; (b) the row lands by `$mirrorKey` as the system and is re-read as the caller, since the Provider already took the write as that caller and the socket's echo then matches the row; (c) a bulk write is refused by name, one Provider call per row; (d) a delete answering no row removes the local row, one answering a row lands it; (e) a Provider failure crosses as an `Error` carrying `status` (4xx → 422 with 404/409/410 kept, refused credential 403, 429, 504, 502/503), so junction's one mapper names the class (Invariant 4); (f) the claim's `key` is checked equal to `@@mirror(key:)` at boot, which makes the claim's restatement of the key graded; (g) a column the caller named that the Provider's answer did not fill is written through the caller's client — found by the late nine, where § V 8 and 9 failed: the first build sent `{ message, starred }` to the Provider and dropped `starred` with a 2xx (negative control fails 1 case). No noun beyond the types the ruling named; each has a case or a row behind it. **Found:** relations need no Provider-id resolution — litestone joins `@relation(fields: [channelExternalId], references: [externalId])` against `externalId @unique` (probed), so 2.1's *the sync resolves them* is moot. **Not built:** a claim whose `parse` omits a column the Provider owns gets that column written locally by (g) until 2.5 makes it `@system` and refuses it; a forward passes no `scope`, which only `Thread` reads and no verb writes.
- [x] 2.5 litestone derives what `@@mirror(key:)` implies as `FJS-D843` rules — the per-column attributes, `missingSince` and the write refusal; the parse, the key's refusals and `$mirrorKey` landed with 2.4
  - Three structural picks were the owner's, through the question tool, before the build: **`@local`** names the app's own columns, and every other stored column but the `@id` is derived `@system` (`FJS-D1142`, over a `local:` argument and over hand-written `@system`); **no gate is derived** (`FJS-D1143`, amending `FJS-D843`), because the key's `@system` already refuses a caller's create and a derived 8 would refuse every claimed one; **the key's `@unique` is derived unless a `@@unique` names it** (`FJS-D1144`), so ELA's per-account key adopts as written and 2.4's *mark it @unique* refusal is gone. `expandMirror` in `packages/litestone/src/core/parser.js` writes the attributes as ordinary ones (`generated: 'mirror'`), so the write path, the JSON Schema and the snapshots have nothing to learn; `missingSince DateTime? @system` is added and a declared one refused. `advise` skips a mirror for `@@transitions` and for *required `@system` with no filler*. Docs: `docs/modeling.md` § *Is this row the app's, or a Provider's?* (its fences run). Junction's forward now writes the declared `@local` columns rather than 2.4's *named and not in the answer*, and leaves the key out of the upsert's update half, since `@immutable` holds under `asSystem()` (negative control fails the patch case). **Not built:** `absent:` (still waits for a second caller); the sync that stamps `missingSince` is Phase 3.3.

### Phase 3 — The mirror app

Goal: a chat app in `fjs-prototypes/` whose phone is Mattermost's app.
Done when: a message posted from the phone appears in `fli dev:tui`, and one typed in the terminal appears on the phone, each as its human.

- [x] 3.1 `db/schema.lite` with `@@mirror` on the Phase 0 table's mirrored rows; per-user credential row per Q3
  - `fjs-prototypes/chat` (`fli new chat --source local --auth --with conduit,caravan`), its own repo, uncommitted. The eight claimed models are mirrored, with policies over the `externalId` relations: a channel is read if it is open or the caller is a member, and a post, member or reaction is read through `check()` its parent; a thread is its profile's own, and so is a file not yet posted (written `postExternalId != null && check(post)`, `FJS-3130`'s shape). The credential is `User.chatToken @secret` (auth's own precedent for a Provider token, so no read returns it) and `User.profileExternalId @system`, projected onto the session for `auth().profileExternalId`. **Two owner picks, through the question tool:** the connector's claim keys Mattermost's user `Profile` and not `User`, which is every auth app's `@@auth` model (`FJS-D1152`; the auth half filed as `FJS-3146`); and **`@@mirror` emits no foreign key on a Provider-keyed relation** (`FJS-D1151`), found when the schema refused a post whose author had not synced. Built in litestone's `expandMirror` and DDL. Also fixed: a direct channel's `team_id: ''` now parses to `null`, and advise no longer suggests a trait over the derived `missingSince`. Proof: a scratch probe of 30 rows against the app's schema, covering every claimed model's parse landing as the system, each policy for two profiles, the token's ciphertext and the out-of-order arrival; litestone 7593 pass; conduit 493; connector drive 43; app `bun run check` green but for `FJS-3088`. **Not built:** `@@softDelete` on the Provider's `deletedAt`, whose meaning is the sync's to decide in 3.3; `Draft`, which no 3.x service needs yet.
- [x] 3.2 `chat.*` services; no vendor noun outside the connector, checked by `rg`
  - `fjs-prototypes/chat`, uncommitted, with `conduit-mattermost` linked in (`bun link` in the connector, `link:` in the app). One model service per mirrored model (`teams`, `profiles`, `channels`, `channel-members`, `posts`, `threads`, `reactions`, `file-infos`), each a bare `createService({ model, channel })`: the claimed verbs forward, the rest are refused at the column. The `chat` service is the account's link and has no model: `connect({ token })` keeps the token only after the Provider has answered `/users/me` with it (written, asked, put back on a refusal, since the per-caller resolver reads the column), refuses a profile another account holds (409), and lands the Profile; `disconnect` clears both columns. **The vendor's name is one folder:** `api/src/providers/chat/index.ts` registers the two targets (`CHAT_TOKEN` from env, `CHAT_USER_TOKEN` per caller off `User.chatToken`), binds the claim, starts the dev sink when no `CHAT_URL` is set, and exports `profileOfCaller` so a service imports no connector; `rg -il` outside it and the dependency manifests answers empty. Proof: a scratch probe of 33 rows booting the app over HTTP against the sink, with the mirror seeded as 3.3's sync will seed it (each person's teams, channels and members landed as the system): connect's four refusals, no read returns the token, create, edit, pin, react, unreact and delete forwarded as the caller and listed back, the private channel unread by bob, an unconnected or disconnected caller's post refused 403 with nothing sent; app `bun run check` green but for `FJS-3088`. **Found, filed, owner chose to fix later:** `FJS-3147` — the forward sends before the app's `@@allow` create/update/delete grades the caller (3 probe rows fail on it: the sink, not the app, refused); `FJS-3148` — a create whose read turns on a row the sync has not landed answers 204 (a new private channel, until its membership lands). Also met: `FJS-3073`, a `junction.config.js` `apiPrefix` reaches no route, so the app serves at `/posts`. **Not built:** mark-read, typing and presence, which no service needs before 3.4; the socket receiver, which is the sync's (3.3). **The nine, answered after the build (late, `decision-rules`):** all pass but 6 — `connect` lands the Profile by its own upsert, a third landing site beside junction's `landMirrored` and the sync, so 3.3's landing owns it and `connect` calls it; and 9 records `none` — nothing but a hand-run `rg` keeps the vendor's name inside `providers/chat/`.
- [ ] 3.3 The REST backfill as a one-shot `unique` job on boot and after a reconnect gap, and `missingSince` under the history cap
  - Carried from 3.2: the socket receiver (`mattermostSocketDialect`) lands with the backfill, one landing function for both, and `chat.connect`'s Profile upsert moves onto it.
- [ ] 3.3a `FJS-3147`: a claimed mirror's forward grades the caller's `@@allow` create, update and delete before it sends — owner's call 2026-10-16, after 3.2, before any surface writes
- [ ] 3.4 One sierra surface and the terminal surface over the same resources

### Phase 4 — The exit

Goal: the claim in rule 5 is gradable.
Done when: `verify:mirror-exit` is in `DRIVES.md` and green, and `absent:` has its second caller.

- [ ] 4.1 The drive: connector removed, app boots, each surface lists
- [ ] 4.2 File the `absent:` ruling `FJS-D843` waits for, with ELA's window and Mattermost's cap as the two shapes

---

## See also

- `conversion-ela.md` — the first mirror app, permanent
- `conduit-connectors.md` — which connectors FJS maintains, and the promotion rule
- `inbound-integrations.md` — receiving, two owners
- `reference-library.md` — the same Providers as schemas to read
- `app-cli.md` — the terminal as a client of an app, which a mirror app's TUI is
- `stressors.md` #41 — Mattermost, the test case
