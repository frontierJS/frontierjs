---
id: pony-express
status: proposed
dated: 2026-10-21
---

# Idea — The pony express: a line from any shell to anyone with `fli`

**Status: PROPOSED.** Dated 2026-10-21. Phases 0 and 1 and steps 2.1 and 2.2 are built; the rest is not. Do not cite
this file as behavior — see `VERIFYING.md`. Claims about the tree were read on
the date above, not run. It grows `IDEAS/haven.md` § Ideas past the plan, *The
pony express*, into a plan of its own.

---

## The ask

A handful of `fli` users — three or four to start — send each other a text from
any shell:

```
fli tell sam "deploy is green"       # waits on the server until sam reads it
fli inbox                            # read; a read letter is gone
fli inbox -f                         # tail, live over the socket
fli tell:invite                      # a one-time code for the next person
fli tell:join <code>                 # walk in with it
$ fli anything                       # one line when mail waits: 2 letters from sam
```

**V1 stands alone.** Haven is still being built, so the first version leans on
none of it: one Cloudflare Worker and one Durable Object, its own key under
`~/.fli/tell/`, plaintext, an invite to join (`FJS-D1392`–`FJS-D1394`). Haven carrying letters, and
sealing them so the host cannot read them, are later phases.

## The claim

For four people the whole server is one object. A Durable Object holds a
SQLite table and the open WebSockets in one place, so `send` writes a row and
pushes it to the recipient's socket in the same call, and the object sleeps
between letters ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing)).
Identity is a key the client already knows how to sign with:
`@frontierjs/toolbelt/signature`'s `generateSigningKeys` and `signRequest` are
Ed25519 over WebCrypto (`signature.js:414`), so the same code verifies in a
Worker with nothing added. A member is a nick and a public key; there is no
password and no account page.

## Prior art

Cited from search results and memory on the date above; the rows marked *docs*
were read, the rest are from memory.

| Shape | Who does it that way | What it gives this plan |
| --- | --- | --- |
| A line to a user, noticed on the next prompt | Unix `write`, `talk`, `biff`, the shell's `MAILCHECK` | the notice line in 2.2, checked on an interval and never per command |
| Identity is a key, chat from a CLI | Keybase (`keybase chat send`), Secure Scuttlebutt | a member is a nick and a key; a new machine is a new key |
| One object per room holding state and sockets | Cloudflare's Durable Objects chat demo, PartyKit | 1.1's whole server *(docs: hibernation keeps an idle socket unbilled)* |
| Seal to a public key, no session | libsodium sealed box, age, HPKE (RFC 9180) base mode | Phase 3's construction |
| Trust the key you first met | OpenSSH `known_hosts`, Signal safety numbers | Phase 4's pin and words |
| A one-shot secret handoff | Magic Wormhole, Bitwarden Send (`fli esend`) | 3.3, a value sealed to a person rather than to a link |

## Rejected

- **Val Town.** One file edited in the browser with SQLite built in, 10 MB
  free ([docs](https://docs.val.town/reference/std/sqlite)) — simpler to stand
  up, but live delivery was not confirmed there and would likely be a poll.
  The runner-up to Q6.
- **ntfy.sh.** No server code at all, but the public server's cache is 12
  hours by default and a topic name is the password
  ([config](https://github.com/binwiederhier/ntfy/blob/fa9d6444f5318c040b803c1a0fd785f6f99e15dc/docs/config.md)),
  so a member away for a day loses mail.
- **Peer to peer** — mDNS on a LAN, a Tailscale overlay, WebRTC. NAT and an
  offline recipient are the hard part, and both ends would have to be online
  at once. `IDEAS/app-peering.md` already puts reachability down as a commodity.
- **Haven first.** It holds identity, a host and a private line already, but
  it is still being built, and V1 would wait on it (Q6).
- **Converting the Ed25519 key to X25519** for sealing, as age does with an
  `ssh-ed25519` key. WebCrypto has no conversion, so it means a curve
  dependency in toolbelt, and a browser member's key is in IndexedDB where a
  conversion cannot reach it. Q2 rules the alternative, a second key.

## What it costs

- **The host reads V1's letters.** Plaintext sits in a Durable Object on the
  owner's Cloudflare account until it is read. Fine between four friends;
  not for a secret, which is why `--env` waits for Phase 3's seal (Q7).
- **A new machine is a new member**, with a new invite, until linking (Q5).
- **An invite code is a password for one use.** Anyone holding it before it is
  spent walks in, so it expires and is spent by the first join.

---

## Plan

### Phase 0 — Groundwork

Goal: the facts V1 rests on are measured, not assumed.
Done when: a throwaway Worker on the free plan answers a signed request verified by toolbelt's `verifyRequest`, and a Durable Object with SQLite storage and a hibernating socket deploys on the same plan.

- [x] 0.1 Probe the free plan: a Durable Object with SQLite storage and the
  WebSocket hibernation API deploys and answers. One Cloudflare page snapshot
  says Durable Objects need the paid plan and the newer pricing page lists a
  free tier, so this settles which is current — the free tier is: 0.2's Worker
  (`new_sqlite_classes` migration) deployed by `bunx wrangler@4 deploy` (4.151)
  to a free-plan account as `*.workers.dev`, and from Bun a signed request
  verified, a one-byte tamper answered `signature does not match`, the Durable
  Object's SQLite counted 1 then 2, and a hibernating socket echoed, then echoed
  again after 20 s idle. The Worker was deleted after.
- [x] 0.2 Probe toolbelt's signature kit bundled into a Worker by wrangler:
  `verifyRequest` passes a request `signRequest` made in Bun — under `wrangler
  dev` (workerd, wrangler 4.145) an Ed25519 request signed in Bun with a query
  verifies and the same request with one byte of body changed answers
  `signature does not match`; the same Worker's Durable Object counted rows in
  its SQLite and echoed over a socket it accepted with `acceptWebSocket`. Local
  only: the free plan is 0.1's question. Bundle 9.7 KiB.
- [x] 0.3 Where the Worker's source lives: `packages/cli/core/tell-worker.js`,
  shipped by the `core/` entry in `files`, importing
  `@frontierjs/toolbelt/signature`, which is already a dependency of the cli.
  `tell:setup` writes the wrangler config to `~/.fli/tell/wrangler.jsonc` with
  `main` the absolute path of the installed worker, so wrangler's `.wrangler/`
  state lands in `~/.fli/tell/` and never inside `node_modules` (a dry-run
  deploy from a config in another directory bundles it). Wrangler is run with
  `bunx wrangler@4`, never a dependency of the cli.

### Phase 1 — V1: the server and the verbs

Goal: four people trade letters from their shells.
Done when: two `HOME`s on one machine run `tell:setup`, `tell:invite`, `tell:join`, `tell`, and `inbox`, against a deployed Worker, and the letter arrives once.

- [x] 1.1 The Worker: one Durable Object holding three tables — members (nick,
  public key), invites (code, by, expires) and letters (from, to, body,
  created). Every route but `join` verifies a `signRequest` signature against a
  member's key. Routes: `POST /send`, `GET /inbox` (returns and deletes,
  `FJS-D1395`), `POST /invite`, `POST /join`, `GET /members`. A rate limit per
  sender, five in ten seconds, `messages.service.ts`'s number in Haven —
  `packages/cli/core/tell-worker.js`, the object `TellPost` bound as `POST`.
  A member names its key in `x-tell-key`; `join` is signed by the key it
  brings, as Haven's login is. A fourth table keeps nonces for twice the
  300 s window, in SQLite because an idle object is evicted inside it. A
  nick is Haven's `Member.nick` rule, a letter is `{ to, text }` of at most
  4000 characters. Driven under `wrangler dev` (4.151) by a throwaway
  script: 27 checks — every route, a replayed join and send, a tampered
  body, a key naming another member, two joins racing one code (one walks
  in), read-once, and the sixth send in ten seconds answering 429.
- [x] 1.2 `fli tell:setup`: makes the owner's key at `~/.fli/tell/key.json`
  (0600, `machineKeys`' shape in Haven's `sign-in.js`), deploys the Worker with
  wrangler, writes the owner's public key as the `OWNER_KEY` var and their
  nick as `OWNER_NICK`, which 1.1 seeds as member one, and writes the
  origin to `~/.fli/config.json` as `tell.api` — `commands/tell/setup.md`,
  helpers in `commands/tell/_module.md`. A var and not a secret: a public key
  hides nothing, and one `wrangler.jsonc` deploys both. The origin is read off
  wrangler's output, then a signed `GET /members` must list the key. Run with
  `HOME` a scratch directory against the real account as `fli-tell-probe12`
  (wrangler 4.151.3): deployed, the owner answered as the one member; a rerun
  redeployed and kept `config.json`'s `haven` key; with the key moved aside the
  run refused naming the key file. The Worker was deleted after.
- [x] 1.3 `fli tell:invite` and `fli tell:join <code>`. The code carries the
  origin (`<origin>#<code>`), so a joiner configures nothing: `join` makes the
  key, sends nick and public key signed with it, and the server spends the
  code. Any member may invite. A code expires in a day (`FJS-D1394`) —
  `commands/tell/invite.md` and `join.md`; `tellMember` and `tellNick` joined
  `_module.md` for 1.4. One post per machine: a `join` naming another origin
  than `tell.api` is refused rather than moved. Run with three scratch `HOME`s
  against the real account as `fli-tell-probe13`: the owner invited, a second
  joined, a rerun of the same line answered *already a member* without spending
  it, a third was refused the spent code, the second member's invite refused a
  taken nick and then took the same code under a free one, and a signed
  `/members` answered all three. The Worker was deleted after.
- [x] 1.4 `fli tell:send <nick> <words>`, alias `tell`, and `fli tell:inbox`,
  alias `inbox`: prints each letter oldest first with its sender and age —
  `commands/tell/send.md` and `inbox.md`, the age by toolbelt's
  `datetime.relative`. Phase 1's exit drive, two scratch `HOME`s against the
  real account as `fli-tell-probe14`: setup, invite, join, then three letters
  ada → bea (one of two lines) printed oldest first and gone on a second
  `inbox`, a reply bea → ada read a minute later as `1 min. ago`, an unknown
  nick answered 404 by name, and the sixth send in ten seconds 429 with the
  five before it delivered. The Worker was deleted after.

### Phase 2 — Live and noticed

Goal: a letter is heard as it arrives, and noticed without asking.
Done when: `inbox -f` prints a letter sent from another `HOME` within a second, and a third `fli` command on the receiver prints the notice line.

- [x] 2.1 `fli tell:inbox -f`: a signed WebSocket to the Durable Object, which
  pushes each letter as `send` writes it and deletes it on the client's ack —
  `GET /follow` in `core/tell-worker.js`, signed at the upgrade like every
  route; the waiting letters go down first, oldest first. A refusal is the
  accepted socket closed `4000 + status` with the reason, since a client sees
  no status on a failed upgrade. A `ping` every 30 s is answered by
  `setWebSocketAutoResponse` without waking the object; a socket that was open
  and drops is reopened, 1 s doubling to 30 s. `tellSign` came out of
  `tellFetch` for the upgrade's headers. Two followers of one member both
  print a letter; the first ack deletes it. Driven under `wrangler dev`
  (4.151) with two scratch `HOME`s, 12 checks: the backlog oldest first, a
  live letter printed before `tell` had exited, a two-line letter, a letter
  after 40 s idle, a plain `inbox` empty after (every letter acked), a raw
  socket that read without acking left its letter for `inbox`, a replayed
  upgrade closed 4401, a non-member refused 403 and exited 1 without
  retrying, 200 acks from another member deleted nothing of bea's, and a
  follower reopened after `wrangler dev` was killed and restarted. Not run
  against the real account: wrangler's login here had expired, and Phase 2's
  exit drive runs there.
- [x] 2.2 The notice line (`FJS-D1398`). Any `fli` command prints `2 letters
  from sam — fli inbox` when mail waits. A network call per command is too
  dear, so the check runs on an interval in the background and the next
  command prints what it found, `MAILCHECK`'s shape. Silent with no
  `~/.fli/tell/key.json` — `core/tell.js`, which also took the key, config
  and signing helpers out of `_module.md` so the startup path and the
  namespace share one copy. The Worker gained `GET /waiting`, letters counted
  by sender and none deleted; the answer is cached in
  `~/.fli/tell/waiting.json`, and a command finding it over 60 s old (bash's
  `MAILCHECK` default) stamps it and starts the check detached. Printed to
  stderr before a registered command runs, at a terminal only, and never
  before `inbox` or a `completion:*` command; `inbox` empties the cache. Driven
  under `wrangler dev` (4.151) with three scratch `HOME`s, 13 checks: the
  first run prints nothing and starts a check that lands 2 from ada, the next
  run prints the line, a run inside the minute starts no check, a piped run
  prints nothing, `inbox` prints the letters with no line and the line is
  gone after, a stale stamp is checked again and finds one letter (singular),
  a `HOME` with no key prints nothing and writes nothing, `completion:generate`
  prints nothing over a cache naming nine letters, and `/waiting` left the
  letter for `inbox`. Not run against the real account, as 2.1; `inbox -f`
  was not re-driven after `tellSign` moved, though the plain verbs above sign
  through it.

### Phase 3 — The seal

Goal: the host stores only what it cannot read.
Done when: a unit spec in toolbelt opens what it sealed and refuses a tampered or a mis-addressed one, and the Durable Object holds only ciphertext after a `tell`.

- [ ] 3.1 `@frontierjs/toolbelt/seal`: `seal(publicKey, bytes)` and
  `open(privateKey, sealed)`, an ephemeral X25519 key, HKDF over both public
  keys, AES-256-GCM — HPKE's base mode in WebCrypto, zero dependencies, so a
  terminal and a browser run one function. `mailbox` is already toolbelt's
  word for an email address, so the kit is not named that. The in-tree
  sibling is `notifications/drivers/webpush.ts`, RFC 8291's ECDH + HKDF +
  AES-GCM sealed to a browser's P-256 key; its curve and `info` strings are
  fixed by the protocol, so it shares no code, but its HKDF is the second
  copy to look at when this lands.
- [ ] 3.2 A sealing key beside the signing key: `key.json` gains an X25519
  pair, published on the member row at join, or by a signed update for a
  member who joined before it. **Needs Q2.**
- [ ] 3.3 `fli tell <nick> --env KEY...`: env values sealed to a person, read
  once, gone. `env:send`'s key picking (`--file`, `-g`) is reused rather than
  copied. Prints why when the recipient has no sealing key yet.

### Phase 4 — Trust

Goal: a host that swaps a key is caught, not trusted.
Done when: a test Worker answering a different key for a pinned nick makes `fli tell` refuse and name both fingerprints.

- [ ] 4.1 Pin on first contact: `~/.fli/tell/peers.json` records each
  correspondent's signing key the first time `tell` or `inbox` meets them, and
  a later mismatch refuses loudly. Pinned BY KEY, the nick only shown, so a
  nick taken over by somebody else is what the pin notices.
- [ ] 4.2 `fli tell:who <nick>`: the key's fingerprint as a few words, to read
  aloud and compare off-band — Signal's safety number at terminal size.
- [ ] 4.3 Linking a second machine. **Needs Q5.**

### Phase 5 — Haven carries it

Goal: a letter and a whisper are one thing to a member standing in Haven.
Done when: a whisper to an offline member arrives as a letter in their `inbox`, and a letter sent from a shell appears as a `(psst: …)` to a recipient in the square.

- [ ] 5.1 The Haven model and service. **Needs Q1.** The Worker's three
  routes move to Haven's API, or the Worker stays and Haven reads it — ruled
  when Haven is hosted (`IDEAS/haven.md` 10.1).
- [ ] 5.2 A whisper (`/w <nick>`) to a member with no presence becomes a letter.
- [ ] 5.3 A letter announced to a member in the square draws as a whisper and
  is deleted as read.
- [ ] 5.4 A post office piece in the square, a door you can walk to.

---

## Open questions

- **Q1 — What a letter is in Haven's schema.**
  - **A** — a `Message` with `toId` and no room: one model, but `roomId` goes
    optional, `body`'s 280 limit and `@@gate`'s locked delete both bend, and
    room retention reaches it.
  - **B** — a model of its own, `Letter`: its own length, its own retention,
    delete by the recipient.
  - **Recommend B** — every rule on `Message` that 5.1 needs is different, and
    a letter is never in a room.
- ~~**Q2 — The sealing key.**~~ **Answered 2026-10-22 (`FJS-D1400`): A — a second, X25519 pair beside the Ed25519 one, published signed.**
  - **A** — a second, X25519 pair beside the Ed25519 one, published signed.
  - **B** — derive X25519 from the Ed25519 key, as age does.
  - **Recommend A** — WebCrypto does it with no dependency, and a browser
    member's IndexedDB key cannot be converted.
- ~~**Q3 — What reading does.**~~ **Answered 2026-10-22 (`FJS-D1395`): A — delete on open: a letter is read once.**
  - **A** — delete on open: a letter is read once.
  - **B** — a read flag: `inbox` shows history.
  - **Recommend A** — the host keeps nothing it does not need, and 3.3's env
    values must be read once anyway; a member who wants a copy keeps the
    printed line.
- ~~**Q4 — The notice line's reach.**~~ **Answered 2026-10-22 (`FJS-D1398`): A — every `fli` command checks on an interval.**
  - **A** — every `fli` command checks on an interval.
  - **B** — only `fli tell:*` commands and a shell prompt hook a member opts into.
  - **Recommend A** — the point is mail you notice without asking; the
    interval bounds the cost, and it stays silent with no key.
- **Q5 — A second machine.**
  - **A** — linking: one machine signs another's key into the same member.
  - **B** — none: a new machine is a new member.
  - **Recommend B for now** — linking waits until somebody asks twice.
- ~~**Q6 — Where V1's server runs.**~~ **Answered 2026-10-22 (`FJS-D1392`): A — one Cloudflare Worker and one Durable Object: SQLite and the live sockets in one object, the free plan, deployed with wrangler.**
  - **A** — one Cloudflare Worker and one Durable Object: SQLite and the live
    sockets in one object, the free plan, deployed with wrangler.
  - **B** — Val Town: one file edited in the browser, SQLite built in, no
    deploy step; live delivery likely a poll.
  - **C** — Haven's API: identity and a host already there, but V1 waits on
    Haven being hosted.
  - **Recommend A** — the only one with live delivery and no wait; B is the
    reopen path if wrangler is the friction.
- ~~**Q7 — Whether V1 seals.**~~ **Answered 2026-10-22 (`FJS-D1393`): A — plaintext V1: requests signed so no sender is faked, text readable on the owner's account; the seal is Phase 3 and changes no route.**
  - **A** — plaintext V1: requests signed so no sender is faked, text readable
    on the owner's account; the seal is Phase 3 and changes no route.
  - **B** — sealed from the first letter: a second key per member and the seal
    kit before anything sends.
  - **Recommend A** — four friends on the owner's own account, and `--env`,
    the one case that needs it, waits for Phase 3.
- ~~**Q8 — How a person joins.**~~ **Answered 2026-10-22 (`FJS-D1394`): B — an invite code: `fli tell:invite` mints a one-use code, `fli tell:join <code>` spends it, and the server keeps a members table.**
  - **A** — the owner adds their key: `fli tell:key` prints it, the owner
    pastes it into the Worker's member list and redeploys.
  - **B** — an invite code: `fli tell:invite` mints a one-use code,
    `fli tell:join <code>` spends it, and the server keeps a members table.
  - **Recommend A** — four people, no table and no expiry to get right.
