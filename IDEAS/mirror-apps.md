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

- [ ] 2.1 `mattermostTarget()`, `bindSend()`, `postMessage()`, `translate()` — the postmark shape — and the `mirror` export: the claim per model of § Mattermost nouns, `create`/`update`/`delete` to a `ConduitRequest` and `parse` from the response to a row (`FJS-D1125`)
- [ ] 2.2 Dialect for the outgoing webhook and the slash command token; a sink that replays Mattermost's envelope
- [ ] 2.3 The socket as a `broker` target (`FJS-D1127`): `transports/broker.ts` takes a frame codec and a post-open handshake from the descriptor in place of its `{id, type, body}` constant and ack; the connector supplies Mattermost's (`authentication_challenge`, then `{event, data, broadcast, seq}`); each frame reaches `accept()` and a Receiver whose `dedupeKey` is the `seq`
- [ ] 2.4 junction: `app.conduit.mirror(claim)` in conduit's junction plugin — the claim table, the boot refusals by name, and the default service's forward on a claimed model (`FJS-D1125`)
- [ ] 2.5 litestone parses `@@mirror(key:)` as `FJS-D843` rules — today a ruling only; nothing in `parser.js` reads it — deriving the per-column attributes, `missingSince` and the write refusal

### Phase 3 — The mirror app

Goal: a chat app in `fjs-prototypes/` whose phone is Mattermost's app.
Done when: a message posted from the phone appears in `fli dev:tui`, and one typed in the terminal appears on the phone, each as its human.

- [ ] 3.1 `db/schema.lite` with `@@mirror` on the Phase 0 table's mirrored rows; per-user credential row per Q3
- [ ] 3.2 `chat.*` services; no vendor noun outside the connector, checked by `rg`
- [ ] 3.3 The REST backfill as a one-shot `unique` job on boot and after a reconnect gap, and `missingSince` under the history cap
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
