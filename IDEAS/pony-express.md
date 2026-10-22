---
id: pony-express
status: proposed
dated: 2026-10-21
---

# Idea — The pony express: a line from any shell to anyone with `fli`

**Status: PROPOSED.** Dated 2026-10-21. Phases 0 to 3 and steps 4.1 to 4.6 are built; the rest is not. Do not cite
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
| A low number as standing | ICQ's UIN, Hacker News and GitHub user ids, Discord's Early Supporter badge | 6.2's number, read off the record and never bought |
| Invite-only growth | Gmail's 2004 invites, Bluesky's 2023 invite codes | 6.3's allowance and 6.6's tree |

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
- **A second machine is linked, not joined** (`FJS-D1410`): one machine signs
  another's key into the same member, and that second key is also the backup.
- **An invite code is a password for one use.** Anyone holding it before it is
  spent walks in, so it expires and is spent by the first join.
- **A member number is tied to a member, not a key** (`FJS-D1409`), so a lost
  key loses the number only when no linked machine is left to sign a new one.
- **The numbers publish the growth rate.** The newest member's badge says how
  many have joined.

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

- [x] 3.1 `@frontierjs/toolbelt/seal`: `seal(publicKey, bytes)` and
  `open(privateKey, sealed)`, an ephemeral X25519 key, HKDF over both public
  keys, AES-256-GCM — HPKE's base mode in WebCrypto, zero dependencies, so a
  terminal and a browser run one function. `mailbox` is already toolbelt's
  word for an email address, so the kit is not named that. The in-tree
  sibling is `notifications/drivers/webpush.ts`, RFC 8291's ECDH + HKDF +
  AES-GCM sealed to a browser's P-256 key; its curve and `info` strings are
  fixed by the protocol, so it shares no code, but its HKDF is the second
  copy to look at when this lands.
  Built: `seal`, `open` (null for anything that does not open) and
  `generateSealingKeys`, sealed value `v1.` + base64url(enc ‖ ciphertext),
  `info` `frontierjs/seal v1`. `test/specs/seal.spec.js` covers the round
  trip, a flipped byte, another member's key, a cut and a foreign version,
  under bun and node; `@hpke/core` opened what it sealed and it opened
  `@hpke/core`'s, both runtimes, from a scratch check not committed. The
  webpush HKDF stays its own: node's `hkdfSync` there, RFC 8291's labels.
- [x] 3.2 A sealing key beside the signing key: `key.json` gains an X25519
  pair, published on the member row at join, or by a signed update for a
  member who joined before it. Q2 ruled a second pair (`FJS-D1400`).
  Built: `key.json` holds `sealing` beside the signing pair, and a key file
  without one gains it on the next verb. `members.sealKey`; `join` requires
  and echoes it; `POST /seal-key` is the signed update, sent by setup for the
  owner and by the first `tell` or `inbox` after the seal for anyone else,
  cached as `tell.sealKey` once the post confirms. The members and letters
  tables gain their columns in place, so a post deployed before the seal keeps
  its members, against the usual no-upgrade-step rule: the alternative was
  every member joining again.
- [x] 3.3 Every `tell` is sealed to a recipient who has a sealing key; to one
  without, a plain letter goes as V1's plaintext and says so (`FJS-D1402`).
  `fli tell <nick> --env KEY...` is the same path, read once, gone, and is
  refused to a recipient with no sealing key. `env:send`'s key picking
  (`--file`, `-g`) is reused rather than copied.
  Built: the sender reads the recipient's key off `GET /members` and seals
  JSON, `{ text }` or `{ env, source, count }`; the post stores `{ sealed }`
  opaque and refuses a plaintext letter to a member with a key (409), so
  ciphertext is enforced there and not trusted to the sender. `inbox` and
  `-f` open each letter, mark a plain one, and print the env lines under
  `env from .env`. The picking is `pickEnv` in `core/global-env.js`, which
  `env:send` now calls. A command's own booleans now never take a value
  (`core/bootstrap.js` reads argv again once the command is known), which
  `--env KEY` needed and which also fixes `env:send`'s own `-g KEY` example.
  Driven under `wrangler dev` (4.151) with three scratch `HOME`s, 25 checks:
  the pre-seal Worker with a member who joined it, then this one over the
  same storage — the old letter kept and marked plain, each member's key
  published on their first verb, the stored body `v1.` with no plaintext in
  it, a raw plaintext send refused 409, `--env` refused to a member with no
  key and nothing stored, an env letter opened backlog-first then a live
  letter in order under `-f`, every letter acked. Not run against the real
  account. A sealed letter does not prove its sender: the post stamps `from`,
  and a lying host could seal anything to a public key; that is Phase 4's.

### Phase 4 — Trust

Goal: a host that swaps a key is caught, not trusted.
Done when: a test Worker answering a different key for a pinned nick makes `fli tell` refuse and name both fingerprints.

- [x] 4.1 Pin on first contact: `~/.fli/tell/peers.json` records each
  correspondent's signing key the first time `tell` or `inbox` meets them, and
  a later mismatch refuses loudly. Pinned BY KEY, the nick only shown, so a
  nick taken over by somebody else is what the pin notices.
  Built: `pinPeer` in `core/tell.js`, a pin `{ nick, sealKey, since }` under
  the signing key, a fingerprint the first 64 bits of the key's SHA-256 in four
  groups. `tell` grades the roster's answer for the recipient and refuses, with
  both fingerprints and nothing sent, on another key under a pinned nick, a
  pinned key under another nick, another sealing key, or none where one was
  pinned, since withholding it would turn the letter plain. The pin covers the
  sealing key as well as the signing key, because the sealing key is the one a
  lying host would swap. `inbox` meets a sender
  through the letter: a sealed letter is now `{ body, key, sig }` inside the
  seal, signed over a purpose line, the recipient's signing key and the body
  (`signMessage`/`verifyMessage`, new in `@frontierjs/toolbelt/signature`), so
  the post cannot write one and a letter re-sealed to a third member does not
  verify there. A letter unsigned, failing its signature, or signed by a key
  not pinned to its `from` is withheld, named, and the run exits 1. A
  plain letter carries no key and is graded by nothing, as before.
  Driven under `wrangler dev` with three scratch `HOME`s and a test Worker
  wrapping `TellPost` to lie in `GET /members` and leave letters it wrote, 22
  checks: pins made once on each side, every refusal above with both
  fingerprints and the letter count unmoved, forged letters (unsigned, signed by
  another key, re-sealed from another member) withheld under `inbox` and under
  `-f` beside an honest one, and a pins file that is not JSON refused and left
  alone. Not run against the real account.
- [x] 4.2 `fli tell:who <nick>`: the key's fingerprint as a few words, to read
  aloud and compare off-band — Signal's safety number at terminal size.
  Built: `safetyWords` in `core/tell.js`, the first 64 bits of a SHA-256 over
  a purpose line, the signing key and the sealing key, as eight words of the
  PGP word list (`core/pgp-words.js`, Juola and Zimmermann 1995, public domain),
  which alternates two- and three-syllable words so a skipped one is heard.
  The sealing key is in the digest because the post serves it unsigned: words
  over the signing key alone would match at first contact while letters went to
  a key the host holds. `who` with no nick, or your own, reads this machine's
  keys and touches nothing; `who <nick>` grades the roster through `pinPeer`,
  so it pins on first sight and refuses a mismatch with both fingerprints and
  no words, exactly as `tell` does; with the post down it reads the pin and
  says so. The list lives in the cli while it has one caller; a browser
  member (6.8) is what moves it to toolbelt.
  Driven under `wrangler dev` with three scratch `HOME`s and 4.1's lying test
  Worker, 20 checks: a member's own words and another machine's reading of them
  agree, a sealing key swapped at first contact reads different words while the
  signing fingerprint still matches, a swapped signing or sealing key against a
  pin is refused with no words printed and the pin untouched, an unknown nick
  and `--dry`, and the post down with and without a pin. Not run against the
  real account.
- [x] 4.3 The member chain (`FJS-D1416`, `FJS-D1421`): a member is a chain
  of links, each signed by a machine, from a first link whose hash is the
  member's root; the sealing key is signed into it. The post stores chains
  and a client refuses a chain shorter than one it pinned. A member who
  joined before this is a chain of one. The post's countersign of the head
  moved to 6.4, which is where the post gets a key to sign with.
  Built: `core/tell-chain.js`, read by the Worker and the cli both — a link
  `{ seq, prev, kind, by, machine, sealKey, sig }` signed over a purpose line
  and the fields in a fixed order, a link's hash its message and signature,
  `readChain` folding the links into `{ root, seq, head, hashes, machines,
  sealKey }` or the first one that fails, and `extendsSeen` the rollback and
  fork test both ends run. The root link is made from `key.json` alone, so it
  is never stored apart from the key. The post gained `links` and `machines`
  stores and `GET /chain?nick=` / `POST /chain`; a request's key is looked up
  among machines, `join` carries `{ chain }` and is signed by the root's
  machine, and `POST /seal-key` is gone, since the sealing key reaches the
  post inside the root. A member from before chains, the owner included,
  keeps its row and publishes a root naming the key it came in with on its
  first verb, cached as `tell.root`; until then it has no sealing key, and an
  unsigned one an older post held is dropped. A pin is keyed by root and holds
  the seq, head, machines and sealing key last seen. `tell` seals to the
  chain's sealing key, a letter's signature binds the recipient's root
  (`letter v2`), and `inbox` withholds a letter whose machine is in no chain
  the pin carries forward. Driven under `wrangler dev` (4.151): the Worker at
  HEAD with a member joined and a letter left, then this one over the same
  storage behind a wrapper that lies on request, four scratch `HOME`s, 41
  checks — the kept members chained on their first verb and the old letter
  printed plain, sealed letters both ways with the chain pinned on each side,
  a join, a rerun and a taken nick, the post refusing a chain rooted at
  another member's machine, a swapped sealing key, an unknown kind, a broken
  `prev` and a mis-signed join; the client refusing another root, a swapped
  sealing key and no chain for a pinned member, with nothing delivered; a pin
  edited longer and forked refused and left as written; a restamped `from`
  withheld; `inbox -f`; and `who` with the post down. Not run against the
  real account.
- [x] 4.4 4.2's words are redone over the chain root, so a linked machine
  reads the same eight words (`FJS-D1416`).
  Built with 4.3: `safetyWords(root)` reads the root's first 64 bits, and a
  member's fingerprint in every refusal is the same 64 bits in hex
  (`rootPrint`). The sealing key leaves the digest because it is signed into
  the root, so a swap is a chain that fails to verify. `who` prints the
  machine count beside the words.
- [x] 4.5 `fli tell:link`: the new machine prints eight PGP words, any linked
  machine types them, and both sign the link (`FJS-D1410`, `FJS-D1417`,
  `FJS-D1418`). It is also how a lost key is replaced (`FJS-D1409`).
  Built: a `link` kind in `core/tell-chain.js`, `{ by, machine }` signed by
  `by`, a machine already in the chain, and countersigned (`rsig`) by
  `machine`. One verb, two sides: `fli tell:link <origin>` on the new machine
  makes its key, asks at the post with a fresh sealing key and prints
  `askCode` — 64 bits of a hash over both its keys — as eight words;
  `fli tell:link <words>` on a linked machine reads the ask, hashes the keys
  the post answered against the words, signs the next link and seals the
  member's sealing pair to the asker. The asker, asking again, gets the offer,
  checks the chain verifies with it in and the sealed pair is the one the
  chain signed, countersigns and publishes; only then does it write the
  member's sealing pair into `key.json`, the chain to `chain.json` and the post
  to its config, and it prints the member's words to read against the other
  machine. The post's four routes run over one `asks` row: `POST /link/ask`
  and `POST /link/accept` signed by the asker, `GET /link/ask` and
  `POST /link/offer` by a member; an ask lasts ten minutes, 64 at a time. A
  linked machine is not the root, so `chain.json` is this member's chain as
  last seen; `syncChain` reads the post's against it before a link and in
  `who`, refusing one cut short or forked. Driven under `wrangler dev` (4.151)
  behind a wrapper that lies on request, seven scratch `HOME`s, 56
  checks: a second machine linked from the first and a third from the second,
  the eight words the same on all three and on a peer, the peer's pin carried
  forward, letters both ways through a linked machine; words swapped, unknown,
  or an origin typed on a linked machine; the post refusing an ask from a
  member's machine, an offer off the head or signed by another machine, a
  second offer, an accept without the countersign or not ending on the offer;
  the client refusing a swapped asker, a swapped sealing pair, a swapped link
  and its own chain cut short, keeping nothing. Not run against the real
  account.
- [x] 4.6 `fli tell:revoke <machine>`: any linked machine signs the revoke and
  rotates the sealing key (`FJS-D1419`); a sealed letter carries its sender's
  head, so a hidden revoke shows (`FJS-D1421`).
  Built: a `revoke` kind in `core/tell-chain.js`, `{ by, machine, sealKey }`
  signed by any machine in the chain, taking `machine` out and naming the
  member's new sealing key; `readChain` refuses one that keeps the old key,
  takes out the last machine or one not in the chain, and a `link` naming a
  machine once revoked. The new pair reaches the machines left through each
  one's box key — its own X25519 pair in `key.json`, never copied off it, held
  at the post as a claim the machine signed (`POST /box`, `GET /boxes`) and
  published on any verb, a join and a link (Keybase's per-device encryption
  key under its per-user key). `tell:revoke <fingerprint>` verifies each claim
  against its machine, seals the pair to it, and publishes the chain with
  `rekeys`; `syncChain` on any other machine fetches its copy (`GET /rekey`),
  checks it is the key the chain signed and keeps the old pair as `retired`,
  for letters sealed to it. The post drops the revoked machine, its box and
  rekey, and closes its socket. `tell:who` lists the machines by fingerprint.
  A sealed letter is now `letter v3`, signing the sender's seq and head;
  `inbox` reads a head past the pin against the post's chain, and withholds a
  letter written at a link the post does not serve, one off a fork, and one
  signed by a machine revoked since. A machine whose box the post does not hold
  is named at the revoke and cannot open what is sealed after it.
  Driven under `wrangler dev` (4.151) behind a wrapper that lies on request,
  six scratch `HOME`s, 49 checks: three machines with their box claims, ada3
  revoked by ada2 (not the root), its open `inbox -f` closed and every request
  after refused; the root picking up the rotated key, and refusing a pair the
  post sealed to its box itself; a letter sealed to the old key opened with
  the retired pair; a peer's pin moved to the revoke, and ada3's earlier letter
  withheld as revoked; the revoke hidden from a new peer and shown by the next
  letter's head; a fourth machine linked after the revoke; a box claim the post
  swapped left unsealed-to and named; the post refusing rekeys for a machine
  out of the chain, a box claim signed by another machine; `readChain`'s five
  revoke refusals; `--dry`. Not run against the real account.
- [ ] 4.7 `fli tell:paper`: an opt-in printed key that is one more machine in
  the chain, the post holding nothing (`FJS-D1420`).

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

### Phase 6 — Member numbers

Goal: an early `fli` user holds a number that says when they joined and who vouched for them, and can prove it.
Done when: three scratch `HOME`s joined in turn against the project's deployed post hold #1, #2 and #3 in signed rows that verify against the post's key with the network off, and a forged row is refused by `tell:who`.

Nothing here is handed out until 4.3–4.5 are built (`FJS-D1409`).

- [ ] 6.1 The project's post, the only one (`FJS-D1413`, `FJS-D1414`): its
  origin is built into `fli`, `tell:join <code>` takes a bare code, and
  `tell:setup` leaves the user surface to become how the maintainers deploy
  it. Joining stays by invite until a point not yet named (`FJS-D1415`),
  which is ruled as its own question when it is near.
- [ ] 6.2 A number per member: `members` gains `number INTEGER UNIQUE` and
  `invitedBy`, set inside `join` as one past the highest number. The object
  takes one request at a time, so two joins cannot draw one number. A number
  is never reused — a member who leaves keeps it and the row stays. The owner
  is #1. Today `join` drops the inviter: `invites.byNick` is read and never
  copied to the member.
- [ ] 6.3 An invite allowance: each member mints a fixed count of codes, three
  to start, held as a var beside `OWNER_NICK`. A low number then means
  somebody vouched for it, and numbers cannot be farmed. `invite` is
  unbounded today (1.3).
- [ ] 6.4 The signed member row: at join the post signs `{ number, nick,
  root, head, joined, invitedBy, fliVersion }` with a key of its own,
  countersigning the chain's head (`FJS-D1421`) and signed again as the head
  moves, and `join` writes it to `~/.fli/tell/member.json`. It proves the number with no
  call to the server, which is what Haven reads in 6.8. `fliVersion` makes
  *joined before 1.0* a fact read off the row rather than a badge handed out.
- [ ] 6.5 4.2's `fli tell:who` takes a nick or a number and prints the signed
  row beside the fingerprint words: `#0042 sam · joined 2026-10-21 · pre-1.0
  · via #0007`. One verb for *who is this*, not two.
- [ ] 6.6 `fli tell:lineage [nick]`: the invite tree read from `invitedBy`.
- [ ] 6.7 `GET /badge/<number>.svg` from the Worker, for a README.
- [ ] 6.8 In Haven, the number is a nameplate on a member's figure, and 5.4's
  post office carries the members as a board. **Needs Phase 5.**
- [ ] 6.9 The oath: `tell:join` prints one line to accept before the code is
  spent — where a code of conduct is read once. From memory, not checked: the
  historical Pony Express ran April 1860 to October 1861 with about 80 riders
  on the trail at a time, and each swore an oath.

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
- ~~**Q5 — A second machine.**~~ **Answered 2026-10-22 (`FJS-D1410`): A — linking: one machine signs another's key into the same member.**
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
- ~~**Q9 — Where the numbers live.**~~ **Answered 2026-10-22 (`FJS-D1413`): A — on the project's post: a number is the member row's number there, and a member of it is on no other post (1.3's one post per machine).**
  - **A** — on the project's post: a number is the member row's number there,
    and a member of it is on no other post (1.3's one post per machine).
  - **B** — a registry apart from the mail: `fli tell:claim` signs with the
    tell key to a list the project runs, and mail stays on any post.
  - **Recommend A** (confidence 2) — one table and no new noun; the one-post
    rule bites only once private posts are common, and B is the reopen path.
- ~~**Q10 — What a lost key does to a number.**~~ **Answered 2026-10-22 (`FJS-D1409`): A — linking (Q5's A) before numbers go out: a second machine signed into the same member is also the backup.**
  - **A** — linking (Q5's A) before numbers go out: a second machine signed
    into the same member is also the backup.
  - **B** — a recovery code printed at join, which the post trades once for a
    new key under the same number.
  - **C** — nothing: a lost key is a lost number, and the member starts again.
  - **Recommend A** (confidence 2) — it answers Q5 too, and a recovery code is
    a password the member must keep somewhere, which the keys exist to avoid.
    This reverses Q5's *B for now*, since a number is what makes a second
    machine worth asking for.
- ~~**Q11 — What the seal covers.**~~ **Answered 2026-10-22 (`FJS-D1402`): A — every letter, once the recipient has a sealing key.**
  - **A** — every letter, once the recipient has a sealing key; plaintext with
    a note to one without, `--env` refused.
  - **B** — only `--env`; reword Phase 3's done-when.
  - **C** — every letter, and a `tell` to a member with no sealing key is
    refused.
  - **Recommend A** — the done-when already says only ciphertext, and the
    cost is the same.
- ~~**Q12 — How many posts there are.**~~ **Answered 2026-10-22 (`FJS-D1414`): A — one: the project's post, its origin built into `fli`; `tell:setup` becomes how the maintainers deploy it, and `tell:join` takes a bare code.**
  - **A** — one: the project's post, its origin built into `fli`;
    `tell:setup` becomes how the maintainers deploy it, and `tell:join` takes
    a bare code.
  - **B** — one by default, and `tell:setup` stays for anyone who wants a
    private post whose numbers count for nothing outside it.
  - **C** — many, federated: posts relay to each other and a nick holds
    across them.
  - **Recommend A** — one network is the ask, and a private post is two kinds
    of post to explain and test; B is the reopen path when somebody asks.
- ~~**Q13 — Who may join the one post.**~~ **Answered 2026-10-22 (`FJS-D1415`): C — by invite until a stated point, then anyone; the point is a question of its own.**
  - **A** — by invite only, with 6.3's allowance.
  - **B** — anyone: `tell:join` with no code.
  - **C** — by invite until a stated point, then anyone; the point is a
    question of its own.
  - **Recommend A** — a number means somebody vouched for it only while
    joining needs a voucher, and an open door is a spam door.
- ~~**Q14 — What the fingerprint words cover once a member has several machines.**~~ **Answered 2026-10-22 (`FJS-D1416`): C — the member's chain root: the hash of its first link, every later machine and the sealing key signed into the chain (Keybase's sigchain, Matrix's master key, iMessage Contact Key Verification).**
  - **A** — one member key copied to every machine (Signal's linked devices,
    SSB fusion identity): 4.2 stands, but a stolen copy cannot be removed
    without new words for everyone.
  - **B** — the set of device keys (WhatsApp's security code): any link or
    revoke changes the words and every peer checks again.
  - **C** — the member's chain root: the hash of its first link, every later
    machine and the sealing key signed into the chain (Keybase's sigchain,
    Matrix's master key, iMessage Contact Key Verification).
  - **Recommend C** (confidence 3) — words fixed across a device change, and
    only a reset or a forged chain warns; 4.2's digest is redone over the root.
- ~~**Q15 — Which machines may link a new one.**~~ **Answered 2026-10-22 (`FJS-D1417`): A — any machine already in the member's chain (Keybase device provisioning, SSB fusion identity, Matrix's self-signing key).**
  - **A** — any machine already in the member's chain (Keybase device
    provisioning, SSB fusion identity, Matrix's self-signing key).
  - **B** — the first machine only (Signal's and WhatsApp's primary device).
  - **Recommend A** (confidence 3) — with the first machine lost, B leaves the
    backup unable to link the next one, which is the case `FJS-D1409` exists for.
- ~~**Q16 — How a link is approved.**~~ **Answered 2026-10-22 (`FJS-D1418`): A — the new machine prints eight PGP words, they are typed on a machine already linked, and both sign the link (Keybase's `reverse_sig`, WhatsApp's account and device signatures).**
  - **A** — the new machine prints eight PGP words, they are typed on a
    machine already linked, and both sign the link (Keybase's `reverse_sig`,
    WhatsApp's account and device signatures).
  - **B** — a QR code the old machine scans (Signal's linked devices).
  - **C** — short words shown on both and confirmed as matching (Matrix SAS).
  - **Recommend A** (confidence 2) — a terminal has no camera and SSH has no
    second channel; typing works in both, and two signatures mean neither
    machine is added without the other.
- ~~**Q17 — How a lost or stolen machine is removed.**~~ **Answered 2026-10-22 (`FJS-D1419`): A — any linked machine signs a revoke into the chain and rotates the member's sealing key (Keybase device revocation and per-user key).**
  - **A** — any linked machine signs a revoke into the chain and rotates the
    member's sealing key (Keybase device revocation and per-user key).
  - **B** — A, with machines ranked by link order and a higher one able to
    undo a lower one's revoke for 72 hours (did:plc rotation keys).
  - **C** — the machine list expires and is re-signed, and a lost machine
    falls off (WhatsApp's signed device list, 35 days).
  - **Recommend A** (confidence 2) — the race B settles is a thief beating the
    owner to the revoke, rare among invited members; B is the reopen path.
- ~~**Q18 — Whether there is a paper key.**~~ **Answered 2026-10-22 (`FJS-D1420`): A — opt-in: a printed key that is one more machine in the chain, able to link and revoke, and nothing held by the post (Keybase's paper key).**
  - **A** — opt-in: a printed key that is one more machine in the chain, able
    to link and revoke, and nothing held by the post (Keybase's paper key).
  - **B** — none: a second machine is the only backup (Signal).
  - **C** — A, printed at every join.
  - **Recommend A** (confidence 2) — the post holds nothing, so it is not the
    recovery code `FJS-D1409` turned down; C makes every member keep a sheet.
- ~~**Q19 — How a peer knows the post did not forge or hide a member's machines.**~~ **Answered 2026-10-22 (`FJS-D1421`): A — every link signed by a machine, so the post can write none; the post countersigns the chain's head into 6.4's member row, a peer refuses a chain shorter than one it has seen, and every sealed letter carries its sender's head (Keybase's sigchain; WhatsApp's in-chat device consistency).**
  - **A** — every link signed by a machine, so the post can write none; the
    post countersigns the chain's head into 6.4's member row, a peer refuses
    a chain shorter than one it has seen, and every sealed letter carries its
    sender's head (Keybase's sigchain; WhatsApp's in-chat device consistency).
  - **B** — A, plus a public append-only log of every chain (WhatsApp key
    transparency, iMessage Contact Key Verification, the did:plc audit log).
  - **C** — the post serves the list and is believed.
  - **Recommend A** (confidence 2) — B's log is a second service to run and
    audit for a network of invited members, and A's rollback refusal catches
    the hidden revoke B would; B is the reopen path.
