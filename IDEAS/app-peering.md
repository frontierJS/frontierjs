---
id: app-peering
status: proposed
dated: 2026-10-16
---

# Idea — app peering: FJS apps that recognize each other's calls

**Status: PROPOSED.** Dated 2026-10-16. Do not cite this file as behavior —
see `VERIFYING.md`. Claims about the tree were grepped, not run; § Where it
stands is the latest read.

## Where it stands (read 2026-11-05)

The boxes below lag the tree. Basecamp's receiving half of Q4 is built:

- **Basecamp hears a peer.** `peerCredential` reads the key id from
  `x-frontier-key`, refuses a key whose account is not `kind: 'peer'` or is
  suspended, and passes the call on as that account, `userType: 'peer'`
  (`packages/basecamp/api/src/core/hooks.ts:666`). The account is bound to
  one workspace (`hooks.ts:99`) and graded by the gate under its key's scopes.
- **The key row holds only the public half** (`ApiKey.publicKey`,
  `FJS-D1604`), entered from "Add a peer" on
  `packages/basecamp/web/src/routes/api-keys/index.mesa`.
- **The dialer is conduit's** (`@frontierjs/conduit/peer`, `FJS-D2068`);
  Workbench wraps it in `packages/workbench/api/src/domain/peer/peer-call.ts`.
- **A peer is enrolled at a role** from a bot's list (`FJS-D2069`), `admin`
  when the enrollment names none; `AppDrill` reads at a viewer's level
  (`FJS-D2070`), so a viewer peer holding `appDrills:read` reads when a copy was
  last proven.

**One Basecamp passing something to another** rides on this door and is not
built. Basecamp B can enroll Basecamp A as a peer today by pasting A's public
key; what is missing is A's side, a dialer for a remote Basecamp shaped like
Workbench's `createPeer`, and Phase 4's consent handshake in place of the
paste. What crosses decides the route:

- **An event or a request** — a signed peer call, graded by B's gate.
- **An app or its data** — never the bytes over the API. The call carries a
  link: A mints a signed download of the archive (`IDEAS/app-archives.md`) and
  B's Outpost restores from it (`POST /volume/restore` takes `url` + `sha256`).
- **A secret** — unruled; it needs its own hearing.
- **A kept answer** — the asker may need to prove what it was told when it
  decided. A signed answer kept as dated evidence states *the owner said X at
  time T* and never answers *is X true now* (Q6).

**A copy of your own data is outside this.** A backup, a Litestream replica and
`read-only-copy.md` hold one owner's bytes for that owner.

---

## Trigger

The question was whether an FJS app reaching Basecamp needs a
`conduit-fjs-basecamp` package. It does not: `FJS-D177` already says *our own
scheme is junction's — there is no counterparty to declare*, and Basecamp fails
`conduit-connectors.md` § The test on its third count, since its cadence is
ours. That answer opened a larger one. **Two FJS apps should recognize each
other's calls with no human copying a secret between them**, inside one fleet
first and across owners later.

The first pair is Basecamp and `fjs-prototypes/chat` (`FJS-D1189`); the
project-management app, `fjs-prototypes/linear`, follows.

**Across owners, the point is one origin.** An owner keeps the only authoritative
copy of a fact and another owner asks for it rather than holding its own. Why that
is worth building, and who tried it first, is `one-origin-across-owners.md`.
Phases 5–10 are that build (`FJS-D2066`).

**A peer** is an FJS app whose calls another FJS app grades as that app — a
principal of its own, not a borrowed person. *Peering* is the relationship
between two of them (`FJS-D1188`).

---

## Two layers, and only one is ours

| Layer | The question it answers | Whose |
| --- | --- | --- |
| **Reachability** — Nebula, Netmaker, NetBird, Tailscale | can machine A open a socket to machine B, privately | a commodity; every one of them is a Go daemon Bun cannot embed |
| **Identity** — who is calling, and what may it do | which principal a call is graded at | **ours** — the gate already answers *what may it do*; *who*, when the caller is an app, is the gap |

**Trust never comes from the network.** A request that arrived over the overlay
is reachable, not permitted. An app that trusted its tunnel would hand the whole
fleet to one compromised node, which is the lesson BeyondCorp was written to
teach. So reachability is Phase 3 and optional, and every phase before it works
over plain HTTPS between public hosts.

---

## What exists, and must not be restated here

| Piece | Where | What it settles |
| --- | --- | --- |
| an API key, owned by a user, with its own scopes | `packages/auth/auth.ts` (`createApiKey`, `revokeApiKey`), `Credential` in `packages/auth/db/auth.lite` | a machine can call an app today — as a person |
| a dialed target holding a credential | conduit's `bearer` · `api_key` · `hmac` (`packages/conduit/src/types.ts`) | the dialing side has a home and a policy |
| a signed call | `signRequest()` / `verifyRequest()`, `@frontierjs/toolbelt/signature` — a `secret` or a `privateKey`, a timestamp and a nonce | no bearer replay; the scheme is ours. Outpost already signs what it reports to Basecamp (`packages/outpost/src/report.js`) |
| a verified credential becoming a principal | `bearerClaim()` / `toDataPrincipal()` (`bridge-index`) | the one owner of that translation (Invariant 4) |
| Basecamp as a fleet's trust root | Outpost enrollment, the pinned certificate of `FJS-D557` | Basecamp already mints an identity at enrollment and pins it |
| an outside caller graded per standing | `mcp()`, `FJS-D258` | the gate as the permission model for a non-person |
| a recorded read | `@@trail(audit, reads: true)`, `packages/litestone/docs/trail.md` | reads can be audited, with `FJS-3708`, `FJS-3783` and `FJS-3784` open against it |
| whether a change is reversible | `packages/litestone/src/release.js` | an unknown change already counts as a contract |
| a person's identity | `@frontierjs/toolbelt/frontier`, `frontier-network.md` | a member's chain; says nothing about the subject of a record |

---

## The nine, answered before any edit

1. **Origin** — a peer's credential lives once, on the app it calls. The dialer
   holds only its secret, as a conduit target. In Phase 2 Basecamp issues both
   halves and keeps neither copy as authority.
2. **Concept** — one noun at most, *Peer*. *Network* is not coined: it is the
   layer this file declines. If Q3 lands on a user that owns a key, the noun is
   not needed at all.
3. **Complexity** — the problem's. Identity across processes is named already —
   SPIFFE's *workload identity*, OAuth's *client credentials* — and this file
   borrows the shape, not the words.
4. **Predictability** — a peer's call is graded like any principal's, by the
   same gate. There is no second permission model.
5. **Derived** — a peer's standing comes from the schema's gate and its grant's
   scopes. Nothing is restated per pair.
6. **Owner** — auth owns the credential, conduit the dialing side, and the
   `bearerClaim` bridge the translation. Nothing new owns anything.
7. **Boundary** — a signed request in, a principal out, at the one bridge.
8. **Failure** — an unknown peer or a bad signature refuses, which is the right
   cost: a guessed identity is a write under somebody else's name. An overlay
   that is down is a transport error, and conduit's policy retries it.
9. **Silence** — what must stay true: an app's call is never graded as a person.
   What fails when it stops: nothing, today — a Basecamp call under a borrowed
   user's key looks correct in every log. Phase 1's audit entry naming the
   actor's kind is the artefact; until then the answer is `none`.

**In tension: batteries vs. smallness.** The overlay is a battery, so it must be
severable — an Outpost option, never a dependency of junction or auth. **Paved
road vs. the workaround**: Phase 0 IS the workaround, run on purpose so its
friction measures the road. **Preservation vs. evolution**: the evolution policy
holds inside one owner's tree and ends at the first peer across owners, where a
service is a published contract (Phase 8, Q8).

**Across owners, three answers widen.** Q1: a record lives once, with its owner,
and a kept answer is evidence and never a source for a current read. Q8: an owner
that is offline answers nothing rather than something stale (Q7), since a stale
fact read as current is the failure this exists to end. Q9: a peer holds no
authoritative copy of another's rows; for revocation Phase 6's drive is the
artefact, and for copying the answer stays partly `none`, because an owner cannot
see inside an asker's box. Past the asker's own schema, that is held by contract
and by law.

**Tier: Assessment.** This file proposes; a ruling for each question lands in
`DECISIONS.md`.

---

## Phases

### Phase 0 — By hand, with what ships

Goal: Basecamp and the chat app talk today with nothing new, so the gap is
measured rather than guessed.
Done when: a Basecamp event lands in a chat channel through a real call, and the
friction it hit is listed under 0.3.

- [x] 0.1 Pick the first message. **A monitor going down** (`FJS-D1190`). It is the one Basecamp event that already reaches a
  `NotificationChannel` (`MonitorChannel` → `fanOutToChannels`); a finished
  deploy reaches people only. The glue is on the dialer: chat stays unchanged,
  so the call is graded by chat's gate like any principal's.
- [x] 0.2 Built 2026-10-16. Basecamp: a `chat` value on `ChannelKind` and its
  row in `domain/notification/delivery.ts` `KINDS`. It sends `POST <config.url>` with
  `{ channelExternalId, message }` and a bearer read from the channel's Secret.
  Chat: a `basecamp` user linked to the Provider's bot account, holding an API
  key. Proof: a scratch probe (not kept) ran chat from a copy on its stand-in
  sink with `CHAT_*` stripped, created the channel through `channels.create`,
  and ran `sweepMonitors` against a 502. The post reached the sink in #general,
  authored by the bot, and landed in chat's mirror. Basecamp `bun run test`
  874/874.
- [x] 0.3 Friction, as seen:
  1. **A scoped key cannot post.** `posts.create states no scope, so a key
     issued with scopes cannot call it` (`FJS-D916`). Narrowing a peer to
     posting needs the RECEIVER to declare `scope:` on its services, so Phase 0
     ran on an unscoped key that carries the `basecamp` user's whole standing.
     That key reads `/api/channels` too.
  2. **The peer's write leaves no audit entry.** Chat's `Post` is not
     `@@trail`ed, so there is no entry to name a person or an app. Phase 1.3's
     done-when needs a trailed model to read.
  3. **A peer of a mirror app needs a Provider identity.** Chat posts as its
     author or not at all (`FJS-D1126`), so the `basecamp` user had to link the
     Provider's bot token. That is a cost of mirror apps, not of peering.
  4. **The account is a person's account.** It registers with an email and a
     password, and it grades VISITOR until the email is verified. Phase 0
     verified it with a system write.
  5. **A bearer replays.** The same request sent again answered 201, a second
     post.
  6. **The key was copied by hand** from chat's `api-keys.create` answer into
     the channel's `secret`. Rotating it is a key minted on chat plus a channel
     patch on Basecamp.
  7. **The channel form has one config slot per kind.** `chat` needs both
     `url` and `channelExternalId`, so the probe created its channel through the
     API. A channel made from the screen saves and then fails at send, naming
     the missing `channelExternalId`.
  8. **The dialer knows the receiver's wire shape.** `channelExternalId` and
     `message` are chat's column names, written into Basecamp's `KINDS`, so
     each new peer app needs another kind.

### Phase 1 — An app is a principal

Goal: a peer's call is graded and audited as that peer.
Done when: chat's audit trail names Basecamp as an app, and a replayed request
is refused.

- [x] 1.1 Hearing on Q3 — **a user that owns a key** (`FJS-D1196`).
- [ ] 1.2 Signed calls: conduit's `hmac` on the dialer; on the receiver,
  `signedRequest({ keyFor })` (`FJS-D475`) resolving to the peer's own account.
- [ ] 1.3 The audit entry carries the actor's kind. Auth half built
  2026-10-17 (`FJS-D1198`): `User.kind` is `user · bot · peer`, the trail
  files it as `actorType`, and only a `user` signs in. Left: chat's `User` takes
  the column (its schema has its own copy of `User`, not the fragment), its
  `basecamp` account is created as `peer`, and its `Post` is `@@trail`ed, or
  nothing records the write (0.3 item 2).

### Phase 2 — Basecamp is the trust root for its fleet

Goal: enrolling an app in Basecamp is the whole of peering it with the rest of
the fleet.
Done when: a new app enrolled in Basecamp reaches chat with no hand-copied
secret, and a rotation started in Basecamp lands on both ends.

- [x] 2.1 Hearing on Q4 — what Basecamp hands out: a shared secret per pair, or a
  keypair per app with peers' public keys distributed, as Nebula's certificate
  authority does. **B, a keypair per app** (`FJS-D1604`).
- [ ] 2.2 Enrollment mints the identity; `FJS-D557` is the precedent.
- [ ] 2.3 Rotation, started from Basecamp.

### Phase 3 — Reachability, optional

Goal: a fleet machine with no public route is still reachable by its peers.
Done when: two Outposts on private addresses carry a peer call between them.

- [ ] 3.1 Hearing — which overlay Outpost installs: NetBird and headscale are
  self-hosted, Tailscale is a vendor, Nebula is the smallest.
- [ ] 3.2 Outpost enrolls its machine into the overlay at fleet enrollment.

### Phase 4 — Across owners

Goal: an app owned by somebody else is peered by consent, not by enrollment.
Done when: two apps on two Basecamps peer through a handshake that an admin on
each side approves.

- [ ] 4.1 Waits for a real pair of apps with different owners, which Q5 names. The shape is a
  consent handshake whose grant becomes a principal: OAuth client credentials,
  Tailscale's sharing between tailnets, Slack Connect.
  - 2026-11-05: the receiving door exists (§ Where it stands). A Basecamp →
    Basecamp pair is a candidate first pair once a reason to pass something
    names what crosses.

### Phase 5 — One fact crosses

Goal: two apps with different owners read one fact without copying it, so the gap
is measured rather than guessed.
Done when: a read crosses between two apps on two Basecamps, and the friction it
hit is listed under 5.2.

- [x] 5.1 The rehearsal, Basecamp → Basecamp, by hand with a pasted key: when an
  app's backup was last verified. The owner's side: one read service with a
  declared `scope:`, on `signedRequest({ keyFor })` with a public key, its model
  under `@@trail(audit, reads: true)`. The asker's side:
  `@frontierjs/conduit/peer`'s `createPeer` (`FJS-D2068`).
  - 2026-11-11, a scratch probe (not kept): one real Basecamp over real HTTP, a
    key enrolled with `appDrills:read`, and a script holding the private half in
    place of the second Basecamp. A hand-signed `GET /app-drills?appId=` answered
    200. Refused: a replay, a query other than the one signed, another service
    (403) and a revoked key (401). Another workspace's app answered an empty list.
  - 2026-11-11, second probe (not kept): two Basecamps in one process, B
    listening on a real port, A enrolled on B at `viewer` with `appDrills:read`
    (`FJS-D2069`, `FJS-D2070`) and dialing through `createPeer(...).read`. The
    drill row came back, B's trail holds a `read` on `AppDrill` with the peer
    as actor, another workspace's app answered an empty page, `apps.get`
    answered 403 (scope) and `appDrills.run` 403 (scope). What A held in the
    test — its private key, B's origin and its key id on B — Basecamp has no row
    for, which is item 7 below and Q14.
- [ ] 5.2 Friction, as seen so far:
  1. **The dialer could not read.** `createPeer.call` always POSTs, so a `find`
     landed as `create` and answered 405. Closed: `createPeer` now has `read`, and
     the probe's read through it answered 200.
  2. **Basecamp had no dialer.** Closed by `FJS-D2068`: it lives in
     `@frontierjs/conduit/peer`, which Basecamp can import. Nothing in Basecamp
     dials yet.
  3. **A scope is a whole service.** `appDrills:read` lists every app's drills in
     the workspace, where the question was about one app.
  4. **The answer is the whole row.** Asked when a backup was verified, the peer
     also receives `report`, `error`, `databases` and `requestedBy`.
  5. ~~A gap in the probe rather than friction: `AppDrill` is `@@trail(audit)`
     without the `reads: true` 5.1 calls for.~~ Closed: the model trails reads,
     and the second probe found the peer's read on the trail.
  6. ~~**The read needs an admin.** `AppDrill` is `@@gate(5.8.8.8)`, and the same
     signed read answered 403 with the peer's role set to `developer` or
     `viewer`.~~ Closed by `FJS-D2069` (enrollment takes a role) and `FJS-D2070`
     (`AppDrill` reads at 2). Item 4 stands: a viewer peer still receives the
     whole row.
  7. **The asker has nowhere to keep what it dials with.** `createPeer` wants
     the asker's private key, the owner's origin and the key id the owner
     issued. Workbench keeps these in its own config; Basecamp has no row or
     Secret for them, so a Basecamp cannot yet dial another from a screen. Q14.
  8. Not friction, but a fact for the asker: `read` of a collection answers the
     page envelope (`{ data, total, limit, offset }`), not the rows.
- [ ] 5.3 The real pair: Kobami asks ELA whether a lead became a customer. Needs
  ELA's owner's agreement. ELA mirrors Service Autopilot, so say whose fact this
  is before building it.
- [ ] 5.4 Friction on the real pair.

### Phase 6 — Refusals hold

Goal: whatever the owner withdraws stops working, and says so.
Done when: a drive shows a revoked key, a suspended peer and a replayed call each
refused, and an offline owner producing an error and no answer.

- [ ] 6.1 Hearing on Q7.
- [ ] 6.2 The drive.
- [ ] 6.3 A refused read leaves a trail entry (`FJS-3708`). A refused cross-owner
  read is the one an auditor most wants.

### Phase 7 — A kept answer is evidence

Goal: an asker can prove what it was told, and cannot mistake that for what is
true now.
Done when: an answer kept by the asker verifies after the owner has rotated its
key, and carries its time.

- [ ] 7.1 Hearing on Q6.
- [ ] 7.2 A signed answer. `signRequest` covers a request; whether it serves a
  response has not been read.
- [ ] 7.3 What a check can catch in the asker's own schema, and a statement of
  what it cannot.

### Phase 8 — A published contract

Goal: an owner can change a service other owners depend on without breaking them.
Done when: a release adding an optional field passes, and a release removing one
from a peered service is refused by name.

- [ ] 8.1 Hearing on Q8.
- [ ] 8.2 A service says it is peered. Needs the spine's Service description (6).
- [ ] 8.3 `release.js` grades a change to a peered service as a contract change.
- [ ] 8.4 A machine-readable contract, which is the spine's Model description (1)
  and waits on `kernel-and-projections.md`.

### Phase 9 — The person can see

Goal: a person sees who read facts about them, across owners, and why.
Done when: one view lists reads from two owners with actor, time and purpose.

- [ ] 9.1 Hearing on Q9.
- [ ] 9.2 A peer call states its purpose, and the trail keeps it.
- [ ] 9.3 Reads are filterable per record (`FJS-3784`) and per tenant (`FJS-3783`).
- [ ] 9.4 The view.

### Phase 10 — A real exchange

Goal: an exchange that law or money already forces runs on this.
Done when: somebody other than this project's owner runs one side in production.

- [ ] 10.1 Hearing on Q10.
- [ ] 10.2 The cross-owner threat model in `THREATS.md`, including mass revocation
  of a trust root.
- [ ] 10.3 The spine entries this used, written as specifications.
- [ ] 10.4 A second implementation passes their vectors, without which no public
  body should depend on this (`specifications.md` § Tensions to carry).

---

## Open questions

- ~~**Q1 — The word.**~~ **Answered 2026-10-16 (`FJS-D1188`): Peer / peering**,
  over *federation*, *trust domain* and *network*.
- ~~**Q2 — Which app is first.**~~ **Answered 2026-10-16 (`FJS-D1189`):
  `fjs-prototypes/chat`**, one message, Basecamp dialing.
- ~~**Q3 — What a peer is, as a row.**~~ **Answered 2026-10-17 (`FJS-D1196`):
  A, a user that owns an API key**, over the recommended B. The hearing record:
  - **What the tree already does.** Outpost → Basecamp is a machine calling an
    FJS app, and it is B: `signedRequest({ keyFor })` (`FJS-D475`) turns a
    signature into `{ userId: 'outpost:<id>', userType: 'service' }` with no
    User row behind it. The actor kind on the audit entry is not a field to
    add: `toDataPrincipal` carries `service` across (`FJS-2514`) and
    `actorTypeOf` files it. A `service` principal is never stamped into a
    User-typed column (`litestone/src/core/stamps.js`), and with no `role` it
    grades CREATOR unless the app's `$levelOf` says otherwise. Outpost's reach
    is a hand-written hook (`outpostScope`), which is the part not to copy.
  - **Prior art.** Chat and collaboration tools use A, or A with a side table:
    a Mattermost bot is a User row with a `Bots` row beside it, a fake
    `@localhost` email and no password (`server/public/model/bot.go`). Discord
    uses `bot: true` on the User object, and GitHub has machine users.
    Infrastructure uses B: Kubernetes `ServiceAccount` (RBAC
    `kind: ServiceAccount`), GCP service accounts, and GitHub Apps, which is
    GitHub's recommended path. Where the two meet, the convergent shape is a
    record the receiver owns, with permissions the receiver declares and the
    kind in the audit entry.
  - **A** — a user that owns an API key (Phase 0 as built; Mattermost, Discord).
    Rows it writes can have an author. It costs a person's account (an email, a
    password, a verification step) and borrows that account's standing. Marking
    it as an app needs a kind on User that does not exist yet.
  - **B** — a principal of its own, minted by the credential door (Outpost's
    shape; Kubernetes, GCP, GitHub Apps). The audit kind already exists, and 1.2's
    signed calls ARE this door. It costs authorship: a peer authors no row, so
    a receiver whose models need an author (chat's `Post` → `Profile`) maps the
    peer to one itself.
  - **Recommend B** — it is the shape the tree already uses for a machine
    calling an app. The two options also fail differently. A fails silently:
    the app's write is filed as a person, which breaks the property § The nine
    q9 holds, and nothing reports it. B fails loudly: a model that needs an
    author refuses the write, or leaves the author null.
- ~~**Q4 — What Basecamp issues.**~~ **Answered 2026-10-28 (`FJS-D1604`): B — a keypair per app. Each app generates its Ed25519 key and keeps the private half; Basecamp records the public half at enrollment and pushes it to every receiver, which stores it on the peer's account. The toolbelt kit already signs and verifies `v1-ed25519` (`packages/toolbelt/src/signature/signature.js:356`), but the door does not yet carry it: `keyFor` answers only `{ secret, session }` (`credentials.ts:44`), so it widens to `{ publicKey }` too. It costs that widening; it buys n keys, a rotation that is one key pushed outward, and receivers that hold nothing able to sign.** A shared secret per pair (n² secrets, simple),
  or a keypair per app with public keys distributed (n keys, Nebula's shape).
  The signature kit signs either way already, so this is a question of
  distribution, not of crypto. Waits for Phase 1.
  - **A** — a shared secret per pair. Basecamp mints one HMAC secret for each
    dialer → receiver pair and writes it to both ends: the dialer's conduit
    `hmac` target, and the peer account's credential on the receiver
    (`FJS-D1196`). It is the shape Outpost → Basecamp uses today
    (`packages/basecamp/api/src/core/hooks.ts:703`), and junction's door takes it
    as is (`packages/junction/src/auth/credentials.ts:44` returns a `secret`).
    It costs n² secrets: rotating one app touches every pair it is in, on both
    ends, and a breached receiver holds a secret that can sign as its dialer.
  - **B** — a keypair per app. Each app generates its Ed25519 key and keeps the
    private half; Basecamp records the public half at enrollment and pushes it
    to every receiver, which stores it on the peer's account. The toolbelt kit
    already signs and verifies `v1-ed25519`
    (`packages/toolbelt/src/signature/signature.js:356`), but the door does not
    yet carry it: `keyFor` answers only `{ secret, session }`
    (`credentials.ts:44`), so it widens to `{ publicKey }` too. It costs that
    widening; it buys n keys, a rotation that is one key pushed outward, and
    receivers that hold nothing able to sign.
  - **Recommend B** — Phase 2's done-when is a rotation started in Basecamp
    landing on both ends, and B makes that one key per app rather than a
    secret per pair; the crypto ships (`signature.js:94`) and the cost is one
    type in junction's door. Nebula's CA and SPIFFE both distribute public
    identities for the same reason.
- ~~**Q5 — The first pair across owners, and the fact.**~~ **Answered 2026-11-11 (`FJS-D2067`): D — C first as a rehearsal, then A: Basecamp → Basecamp on when an app's backup was last verified, keyed on the app's id; then Kobami asks ELA whether a lead became a customer, keyed on an id issued when the site form submits, answering only won, lost or open.**
  - **A** — two apps with different legal owners and a fact about a business or
    a license, where a shared identifier already exists.
  - **B** — a fact about a person, which needs Q9 first.
  - **C** — two apps this project owns, which proves nothing about consent.
  - **D** — C first as a rehearsal, then A: Basecamp → Basecamp on when an app's
    backup was last verified, keyed on the app's id; then Kobami asks ELA whether
    a lead became a customer, keyed on an id issued when the site form submits,
    answering only won, lost or open.
  - **Recommend D** — the rehearsal shakes out the wiring on the only app with a
    receiving door, so the real pair is not debugged in front of an outside
    owner, and the real pair needs one outside person's agreement. Both skip
    matching, the hardest problem in `one-origin-across-owners.md` § Prior art.
- **Q6 — What an asker may keep.**
  - **A** — the signed answer, as dated evidence (X-Road).
  - **B** — nothing beyond a log line that a read happened.
  - **C** — a cached value with an expiry, used for current reads.
  - **Recommend A** — B leaves an institution unable to justify a decision, and C
    is a second origin with a timer on it.
- **Q7 — An owner is offline.**
  - **A** — the read fails, and the asker may show a kept answer labeled with
    its date.
  - **B** — the read falls back to a kept answer automatically.
  - **Recommend A** — B turns an outage into silently stale truth, while A leaves
    the judgment with a person who can see the date.
- **Q8 — The contract rule for a peered service.**
  - **A** — additive only, and a breaking change takes a new name (AT Protocol).
  - **B** — numbered releases that askers migrate between (FHIR).
  - **Recommend A** — FHIR shows what migration between releases costs an
    ecosystem, and A needs no coordination between owners.
- **Q9 — How two owners agree on who a person is.**
  - **A** — an identifier a registrar peer issues (Estonia's personal code, which
    needs a state).
  - **B** — demographic matching (Carequality), which is probabilistic.
  - **C** — the person presents a signed consent at each door (Account
    Aggregator's shape), so the person does the joining.
  - **Recommend C** — it needs no registrar and no guessing, and it makes consent
    the unit. Low confidence: it fails for a person who cannot present anything,
    and it widens the chain from members to the public, which `FJS-D1444` took on
    for members only.
- **Q10 — Where the force comes from.** Waits for Phases 5–6. A domain with an
  exchange already mandated or already paid for, small enough that one sector can
  adopt it, and with a body willing to run a side. Liability, procurement and
  certification are decided here, and they are probably harder than every phase
  above.
- ~~**Q11 — Where the dialer lives.**~~ **Answered 2026-11-11 (`FJS-D2068`): A — `createPeer` moves into `@frontierjs/conduit` and takes a method. Both apps already depend on conduit, which holds the `ed25519` signer. Workbench keeps its own mapping of a refusal to a status.** Blocks 5.1. Basecamp and Workbench import
  nothing from each other, and only Workbench has `createPeer`.
  - **A** — `createPeer` moves into `@frontierjs/conduit` and takes a method.
    Both apps already depend on conduit, which holds the `ed25519` signer.
    Workbench keeps its own mapping of a refusal to a status.
  - **B** — Basecamp gets its own copy for the rehearsal.
  - **C** — no dialer yet: the rehearsal's asker stays a hand-signed script.
  - **Recommend A** — Kobami and ELA need the same dialer, and a copy is a second
    reader of the result envelope (Invariant 4).
- ~~**Q12 — What a peer from another owner is.**~~ **Answered 2026-11-11 (`FJS-D2069`): B — enrollment takes a role from the list a bot takes, and an owner answers a peer through a narrow read declared at that level, returning only the fact. Workbench's preview peer stays `admin`.** Every peer is enrolled `admin`,
  because a preview creates an `Environment`.
  - **A** — every peer stays `admin`, and the key's scopes alone narrow it.
  - **B** — enrollment takes a role from the list a bot takes, and an owner
    answers a peer through a narrow read declared at that level, returning only
    the fact. Workbench's preview peer stays `admin`.
  - **Recommend B** — it also ends the whole-row answer (5.2 item 4), and it needs
    no new noun. A leaves another owner's key at the top grade below owner.
- **Q14 — Where a Basecamp keeps what it dials with.** Blocks Phase 10 and any
  Basecamp-to-Basecamp read from a screen (5.2 item 7). Three facts: this
  Basecamp's own Ed25519 private key, and for each owner it asks, the origin
  and the key id that owner issued.
  - **A** — a `Peer` model in Basecamp: `name`, `url`, `keyId`, per workspace;
    the private key one `Secret` row the workspace holds (`kind: peer`), the
    public half shown on the API keys screen for the other owner to paste.
  - **B** — a conduit target per peer, held in `ConduitTarget` as every other
    provider is, with the private key in the conduit's credential store; the
    screen is the conduits screen.
  - **C** — the Workbench shape: config, outside the database.
  - **Recommend A, narrowed** — `Peer` (`name`, `url`, `keyId`, `secretId`)
    is a per-workspace model beside `ApiKey`. The private key is one `Secret`
    with a new `SecretKind` value `peer` and a `privateKey` data field; the
    public half is derived from it and shown on the API keys screen, never
    stored. The Secret is resolved as every other credential is,
    `createSecretResolver(db)` handed to `createPeer({ privateKey })`.
    B was checked (`decision-rules`, 2026-11-11) and fails: the conduit registry
    is hub-wide, gated `SYSADMIN`, has no `workspaceId`, and already resolves
    its credentials from `Secret`, so B saves nothing and puts tenant data in a
    shared registry. C is the reopen path, at the cost of dialing from a
    screen. Two things the draft must settle: `createPeer` pins one target
    id, so two peers in one process hold only because each call builds its
    own conduit (pin it with a test); and whether the outbound row is named
    `Peer` while the inbound side is an `ApiKey` with `userType: 'peer'`
    (`FJS-D1188`). Not yet drafted as code.
- ~~**Q13 — How a peer below admin reads a fact.**~~ **Answered 2026-11-11 (`FJS-D2070`): A — lower the model's read gate. Access stays in the schema, and every `viewer` in the workspace can then read `report` and `error`.** Blocks 5.1. `FJS-D2069` enrolls
  a peer from another owner at a low role, and `AppDrill` is `@@gate(5.8.8.8)`:
  the signed read answered 403 as `developer` and as `viewer`.
  - **A** — lower the model's read gate. Access stays in the schema, and every
    `viewer` in the workspace can then read `report` and `error`.
  - **B** — a narrow method checks the peer and reads as system. Answers only the
    fact, and puts the access rule in a service, against Invariant 6.
  - **C** — a schema-declared model or column holding only the last verified time,
    readable at `viewer`, written when a drill finishes. Keeps the rule in the
    schema and answers only the fact, at the cost of a stored copy.
  - **Recommend C** — low confidence: not yet drafted as code, and neither
    `decision-rules` nor prior art has been run on it. Draft it first.

---

## Prior art

- **Nebula** — a certificate authority signs each node, and a certificate's
  `groups` drive the firewall: a gate level written in the network layer.
  [slackhq/nebula](https://github.com/slackhq/nebula)
- **Tailscale `tsnet`** — an app joins the tailnet itself and asks it who a peer
  is. [tsnet](https://tailscale.com/kb/1244/tsnet)
- **SPIFFE / SPIRE** — a workload identity issued per service, and federation
  between trust domains. [overview](https://spiffe.io/docs/latest/spiffe-about/overview/)
- **NetBird, Netmaker** — self-hosted WireGuard overlays.
  [netbirdio/netbird](https://github.com/netbirdio/netbird) ·
  [gravitl/netmaker](https://github.com/gravitl/netmaker)
- **BeyondCorp** — Google's case that the network grants reachability and never
  trust.
- **X-Road, Account Aggregator, AT Protocol Lexicons, Carequality, FHIR** — what
  Phases 5–10 lean on, sourced in `one-origin-across-owners.md` § Prior art.
