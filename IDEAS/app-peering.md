---
id: app-peering
status: proposed
dated: 2026-10-16
---

# Idea — app peering: FJS apps that recognize each other's calls

**Status: PROPOSED.** Dated 2026-10-16. Nothing in § Phases is built. Do not
cite this file as behavior — see `VERIFYING.md`. Claims about the tree were
grepped on the date above, not run.

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
| an outside caller graded per standing | `mcpPlugin()`, `FJS-D258` | the gate as the permission model for a non-person |

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
friction measures the road.

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
  row in `core/delivery.ts` `KINDS`. It sends `POST <config.url>` with
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

- [ ] 2.1 Hearing on Q4 — what Basecamp hands out: a shared secret per pair, or a
  keypair per app with peers' public keys distributed, as Nebula's certificate
  authority does.
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

- [ ] 4.1 Waits for a real pair of apps with different owners. The shape is a
  consent handshake whose grant becomes a principal: OAuth client credentials,
  Tailscale's sharing between tailnets, Slack Connect.

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
- **Q4 — What Basecamp issues.** A shared secret per pair (n² secrets, simple),
  or a keypair per app with public keys distributed (n keys, Nebula's shape).
  The signature kit signs either way already, so this is a question of
  distribution, not of crypto. Waits for Phase 1.

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
