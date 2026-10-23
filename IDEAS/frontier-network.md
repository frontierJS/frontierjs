---
id: frontier-network
status: proposed
dated: 2026-10-22
---

# Idea — The Frontier network: one nick and one chain for every `fli` surface

**Status: PROPOSED.** Dated 2026-10-22. Nothing here is built beyond what
`fli tell` already built. Do not cite this file as behavior — see
`VERIFYING.md`. Claims about the tree were read on the date above, not run.

---

## The ask

A person stakes a nick once and every `fli` surface knows them by it:

```
fli frontier:stake jordan <code>     # the first door: key, chain, nick
fli frontier:invite                  # a code for the next person
fli frontier:link | revoke | paper   # machines in the chain
fli frontier:who jordan              # or #42: the signed row and the words
fli frontier:lineage                 # the invite tree

fli tell sam "deploy is green"       # mail: one consumer of the identity
fli haven                            # Haven: another, with no key of its own
```

## The claim

**Most of this is already built under the wrong noun.** `fli tell:` holds two
jobs. Identity is `setup`, `join`, `invite`, `link`, `revoke`, `paper`, `who`
and the chain in `packages/cli/core/tell-chain.js`. Mail is `send` and `inbox`.
Phase 2 (numbers, the invite allowance, the signed member row, lineage, the
badge), which began as the pony-express paper's Phase 6, is already
this network in all but name.

**What is not built is the one identity.** A person on this tree today holds
two:

- `~/.fli/tell/key.json` plus the chain: a member of the post.
- `~/.fli/haven/key.json` (`packages/haven/web/src/lib/session/sign-in.js:18`):
  a member of Haven, whose nick is taken first-come by the first login
  (`packages/haven/api/src/login.ts`, `FJS-D981`).

These are two keys and two nicks, and nothing says they are the same person.
The network makes the chain the one identity and turns tell, Haven and later
app peering (`FJS-D1196`, a user owns a key) into readers of it.

## Prior art

Read from search results on the date above. Rows marked *memory* were not
checked.

| Who | What they do | What it gives this plan |
| --- | --- | --- |
| [pico.sh](https://pico.sh/getting-started) | `ssh pico.sh`, pick a username, done. The key is the account and the username becomes the service subdomains. One key belongs to one account ([FAQ](https://pico.sh/faq)). Recovery is an API token kept somewhere safe. | `frontier:stake` as one command, and the nick as a subdomain (Q3) |
| [Charm Cloud](https://charm.sh/cloud) | `charm link` joins machines to one account. A CLI-first backend, self-hostable, with SQLite, keys and data in one directory ([man](https://man.archlinux.org/man/charm.1.en)). *Memory:* Cloud was wound down. | The post stays self-hostable even with one official instance (`FJS-D1414`) |
| Keybase | A per-device key signed into a chain, every device equal, a paper key that is revocable like any device ([2016 talk](https://openpgp.org/community/email-summit/2016/talk_KeybaseAndPGP_160709.pdf), [sigchain v2](https://book.keybase.io/docs/teams/sigchain)). *Memory:* acquired by Zoom in 2020 and stalled. | Already built as `core/frontier-chain.js` (`FJS-D1416`–`FJS-D1421`) |
| Lobsters | A public invite tree. An inviter answers for their invitees and can lose access over them ([summary](https://linuxfr.org/users/ploum/journaux/un-service-d-hebergement-lobste-rs.epub), [critique](https://tildes.net/~tildes/1qq/tildes_versus_lobste_rs)). | Lineage (2.6) and Q4 |
| Urbit | An identity is a number, and each sponsor issues a fixed count; the scarcity is the anti-spam measure ([Wikipedia](https://en.wikipedia.com/wiki/Urbit)). *Memory:* each number has a pronounceable name (`~sampel-palnet`). | The allowance (6.3), and a spoken name for `#42` read off the PGP word list |
| [Radicle](https://radicle.xyz/guides/user) | The alias is non-unique and changeable, and the Ed25519 key is the identity. | Rejected below: the shape a network takes when it declines a namespace |
| [Bluesky](https://bsky.social/about/blog/4-28-2023-domain-handle-tutorial), [Nostr NIP-05](https://nostr.how/en/get-verified) | The handle is a domain the member proves, by DNS TXT or `/.well-known/`. NIP-05 says it identifies and does not verify. | Phase 5's optional proof |
| [npm](https://docs.npmjs.com/policies/disputes) | Squatting is a written rule: a name held with no real use. It may refuse a valid claim that would risk the supply chain. | The squatting line (4.2) |
| [ENS](https://docs.ens.domains/ensv2/eth-registrar) | A yearly fee by name length. Its own forum finds squatting [cheaper than owning](https://discuss.ens.domains/t/ens-is-losing-money-with-the-current-model-heres-how-to-fix-it/14337). | Rejected below |

**The problem has a name.** [Zooko's triangle](https://newsletter.squishy.computer/p/cheating-zookos-triangle):
a namespace gets two of human-meaningful, decentralized and secure. The post
takes meaningful and secure and admits the post as the center. Every link is
signed by a machine in the chain (`FJS-D1421`), so the center can refuse a nick
or hide a member but cannot forge one.

## Rejected

- **The handle is a domain** (Bluesky, NIP-05). It ends disputes, but most
  `fli` users own no domain worth proving, and the first door would become DNS.
  Kept as an optional proof in Phase 5.
- **A non-unique alias** (Radicle). `fli tell sam` needs `sam` to mean one
  person.
- **A fee per name** (ENS). It prices squatting rather than ending it, and it
  puts money in front of the first door.
- **Petnames only**, each member naming the others locally. *Memory:* Secure
  Scuttlebutt's shape. It suits a network with no center, and this one has the
  post.

## The nine

Answered before the first edit, for the proposal as a whole.

1. **Origin** — one fewer. The chain stays the only origin of who a member is,
   and Haven's own key, the second origin, goes (Phase 3).
2. **Concept** — no new code noun. *Member*, *chain*, *machine* and *post*
   are pony-express's, and Haven's *Member* becomes the same one. *Frontier
   network* is the product's name for the post's members. *Stake* is a verb
   (Q1).
3. **Complexity** — the problem's own. Zooko's triangle names it, and the
   prior-art rows are its three corners.
4. **Predictability** — up. One nick on every surface, where today two
   surfaces can disagree.
5. **Derived** — the number, the lineage and the words are read off rows and
   the chain root. Nothing about a member is typed twice.
6. **Owner** — the existing ones: `tell-chain.js` (renamed in 1.1) and the
   Worker. Haven's login becomes a reader of the chain, not a second owner.
7. **Boundary** — Haven's login verifies a login signed by a machine in the
   chain against the post's signed member row (2.4), so a reader
   needs no call to the post.
8. **Failure** — a taken or reserved nick is refused at `stake` and names why.
   The cost is a retry, and nothing is written.
9. **Silence** — what must stay true: one person is one chain across every
   `fli` surface, and a revoke reaches every reader within the row's age.
   What fails when it stops: none today. 3.2 adds Haven's refusal of a login
   whose key is in no chain, and 3.1 its refusal of a row older than the age.

**Tier:** Assessment. Every question is ruled (`FJS-D1444`–`FJS-D1451`); 0.4 and
2.4 block Phase 3.

## Privacy

What a member gives up by joining, written before strangers join. The
attackers are `THREATS.md` B17–B19; this is what holds when none of them acts.

- **One nick links every surface.** The nick never changes (`FJS-D1451`), and
  after Phase 3 the same chain signs a letter, a Haven login and anything
  later. So everything a member does under the network is one identity to
  anyone who reads two surfaces. A member who wants two identities stakes
  twice, and each one costs an invite.
- **The lineage is public.** Who invited whom is readable by any member, and
  after 2.6 and 2.7 by anyone with the nick or the number (`FJS-D1449`). With
  `joined` and `fliVersion` on the signed row (2.4), it dates each member and
  places them in a social graph they did not draw.
- **The operator sees more than the lineage** (B19): who writes to whom, when
  and how much, every member's machine count, and, after 6.2, when each was
  last seen. Phase 6 shows the owner that and nothing more.
- **Leaving erases almost nothing.** A letter is deleted when it is read
  (`FJS-D1395`), and a sealed one was never readable by the post. The rest
  stays: the chain is append-only, and a peer that pinned it refuses a shorter
  one, so the post cannot drop links without every pin reading it as tampering
  (`FJS-D1421`). The member row and its number stay, and a number is never
  reused (2.2). The nick stays taken. No verb removes a member today, and what
  one would erase (the nick, the row, the lineage edge) is not ruled.

## Plan

### Phase 0 — Groundwork

Goal: the questions ruled, and the callers of both key directories known.
Done when: Q1–Q8 are rulings, 0.4 is written, and every reader of
`~/.fli/tell` and `~/.fli/haven` is listed under 0.1.

- [x] 0.1 List every reader of `~/.fli/tell/` and `~/.fli/haven/key.json`
  with `rg`. The prototypes are skipped: none of them holds either key
  (owner, 2026-10-22).
  Found: **`~/.fli/tell/` has no code reader.** Its one owner is
  `packages/cli/core/tell.js:20`, now `~/.fli/frontier/`, and nothing reads
  `config.json`'s old `tell` key; the path survives only in prose here. **`~/.fli/haven/key.json` has one owner,**
  `packages/haven/web/src/lib/session/sign-in.js:18` (`KEY_FILE`,
  `machineKeys()`), and these consumers, which 3.2 moves or deletes:
  - `packages/cli/commands/haven/walk.md:198`, which imports `KEY_FILE` and
    prints it on a first run, plus its prose at `:35`.
  - `packages/haven/web/test/verify-explore.mjs:165`, which asserts the first
    `fli haven` wrote the key there.
  - The browser twin `sign-in.browser.js`, which keeps its pair in IndexedDB
    (`haven` / `keys` / `machine`) and is checked by `verify-browser.mjs:256`.
    3.2 has to give that one a chain too, or the browser is refused.
  - Prose: `IDEAS/haven.md:216`, `IDEAS/study.md:347`.
  The other files under `~/.fli/haven/` (seen, workers, errand, study,
  taskmaster, menu, snoozed, `<version>/`) are client state, not identity,
  and stay.
- [x] 0.2 Rule Q1–Q8.
- [x] 0.3 Move the pony-express paper's Phase 6 here verbatim as Phase 2,
  leaving a one-line pointer under its heading. Its step numbers become 2.x,
  and pony-express keeps mail (Phases 1–3 send and inbox, Phase 5 Haven
  carries letters).
  Built: pony-express then sent its Phase 5 to `IDEAS/haven.md` Phase 22 and
  the paper was deleted (owner, 2026-10-22; last committed at `364f38d9`).
- [x] 0.4 Write the post into `THREATS.md`, which names no post, chain or
  `tell` today. One row per attacker, each naming what they may do and the
  test that proves it: a thief holding a revoked machine and a stale member
  row (Q7), a stranger squatting or impersonating a nick, and the operator of
  the post itself. Beside it, a § Privacy in this file: what one nick links
  across surfaces, what the public lineage publishes about who invited whom,
  and what a member who leaves can have erased from an append-only chain.
  Built: `THREATS.md` B17–B19, proved by
  `packages/cli/test/frontier-chain.test.js` (the chain refusals, and the pins
  graded in a child under a temp `HOME`) and `seal.spec.js`; § Privacy above.
  The row age (2.4), reserved nicks (4.1) and Haven reading the chain (Phase
  3) are each row's *Open*.

### Phase 1 — The rename

Goal: identity lives under `frontier:` and mail under `tell`.
Done when: pony-express's 4.7 drive passes with every verb respelled, and
`fli tell:join` is an unknown command.

- [x] 1.1 `tell:{join,invite,link,revoke,paper,who}` become `frontier:*`, and
  `tell-chain.js` becomes `frontier-chain.js`. `tell` keeps `send` and
  `inbox`. A rename is a rename: no alias.
  Built: `commands/frontier/`, and the member helpers that sat in
  `commands/tell/_module.md` moved to `core/frontier-member.js` so both
  namespaces import one copy. The wire (`x-tell-key`, `tellFetch`, the
  Worker's routes and signed labels) keeps its spelling, so a deployed post
  needs no change to serve the new verbs.
- [x] 1.2 `~/.fli/tell/` becomes `~/.fli/frontier/`. The live members' keys
  move by hand with `mv`, and no code reads the old path.
  Built: `config.json`'s `tell` key became `frontier` with it. The owner's
  machine moved by hand on 2026-10-22.
- [x] 1.3 `frontier:stake <nick> <code>` replaces `tell:join`.
  `tell:setup` leaves the user surface as 2.1 already plans.
  Built: the nick is the first argument, not `--nick`, and asked for at a
  terminal when only the invite is given, since the line `invite` prints
  carries none. Driven under `wrangler
  dev` with two scratch `HOME`s, 10 checks: an invite minted, `ada` staked,
  a spent code refused, a letter each way, reading deleted it, and
  `tell:join` an unknown command. Not run against the deployed post.

### Phase 2 — Member numbers

Goal: an early `fli` user holds a number that says when they joined and who vouched for them, and can prove it.
Done when: three scratch `HOME`s staked in turn against the project's deployed post hold #1, #2 and #3 in signed rows that verify against the post's key with the network off, and a forged row is refused by `frontier:who`.

Moved from the pony-express paper's Phase 6 by 0.3, its 6.x now 2.x and its
verbs spelled as Phase 1 renamed them. 2.4 carries Q7's age (`FJS-D1445`), so
it is the step Phase 3 waits on. Nothing here is handed out until
the chain, linking and revoking are built (`FJS-D1409`), which they are.

- [x] 2.1 The project's post, the only one (`FJS-D1413`, `FJS-D1414`): its
  origin is built into `fli`, `frontier:stake <nick> <code>` takes a bare
  code, and `tell:setup` leaves the user surface to become how the
  maintainers deploy it. Joining stays by invite until a point not yet named
  (`FJS-D1415`), which is ruled as its own question when it is near.
  Built: `POST_ORIGIN` in `core/tell.js`, `https://network.frontierjs.com`
  (owner, 2026-10-22), and `FLI_FRONTIER_POST` stands a `wrangler dev` post
  in for a drive. `frontier.api` is gone from `config.json`: `frontier.nick`
  is what says a machine is a member, so a member staked on `workers.dev`
  moves with no edit. `invite` prints `fli frontier:stake <code>`, and `link`
  and `paper` on a new machine take no origin. `tell:setup` became `ws:post`,
  which deploys the custom domain with `workers_dev` off (owner, 2026-10-22).
  Driven under `wrangler dev` with three scratch `HOME`s, 18 checks: a bare
  code staked, a URL-shaped one and a spent one refused, a letter each way,
  a paper key walking a new machine in, `ws:post --dry`. Unknown commands
  exit 0, so `tell:setup` being gone is read off its output (`FJS-3466`).
- [x] 2.2 A number per member: `members` gains `number INTEGER UNIQUE` and
  `invitedBy`, set inside `join` as one past the highest number. The object
  takes one request at a time, so two joins cannot draw one number. A number
  is never reused — a member who leaves keeps it and the row stays. The owner
  is #1. Today `join` drops the inviter: `invites.byNick` is read and never
  copied to the member.
  Built: the columns are added by `ALTER` with a unique index beside them,
  since SQLite cannot add a UNIQUE column. A member from before numbers draws
  one at startup, owner first and then by `joined`, with `invitedBy` left
  blank. `GET /members` answers both, ordered by number, and `stake` prints
  `You are #3 ada …`. Driven under `wrangler dev`, 9 checks: a post on the
  HEAD worker with the owner and one member, restarted on the new one, holds
  #1 and #2; two joins after it draw #3 and #4 with their inviters; a restart
  moves no number; a refused join draws none. The live post's `jordan`
  becomes #1 at the next `fli ws:post`.
- [x] 2.3 An invite allowance: each member mints a fixed count of codes, three
  to start. A low number then means somebody vouched for it, and numbers
  cannot be farmed (`FJS-D1466`).
  Built: `INVITE_ALLOWANCE` beside `INVITE_SECONDS` in `core/tell-worker.js`,
  not a var, since `ws:post` writes the config from code on every run. Joins
  vouched for plus live codes are counted, so an unspent code gives its seat
  back when it expires; the owner is uncounted. `invite` prints what is left.
  Driven under `wrangler dev`, 10 checks: the owner mints a fourth, a member
  counts 2, 1, last and is refused at a fourth, a join keeps the seat, a code
  minted before the cap still spends. Expiry is not driven: a day.
- [x] 2.4 The signed member row: at join the post signs `{ number, nick,
  root, head, joined, invitedBy, fliVersion, signed }` with a key of its own,
  countersigning the chain's head (`FJS-D1421`) and signed again as the head
  moves, and `stake` writes it to `~/.fli/frontier/member.json`. It proves the
  number with no call to the server, which is what Haven reads in 2.8.
  `fliVersion` makes *joined before 1.0* a fact read off the row rather than a
  badge handed out. A reader refuses a row whose `signed` is more than a day
  old, one value held beside the row's verifier, and a member's machine
  fetches a fresh row before its copy is that old, so a revoke reaches every
  reader within a day (`FJS-D1445`).
  Built: the object makes its own Ed25519 pair on first use and keeps it in
  a `post` table (`FJS-D1467`); `signRow` and `readRow` sit in
  `core/frontier-chain.js` beside the chain, with `ROW_AGE`, so the Worker and
  every reader share one message. The row is signed when asked, never stored:
  in the join's answer and on `GET /row[?nick=]`, so it always names the head
  the post holds. `stake` sends `fliVersion` and pins `frontier.postKey`; the
  background check behind the notice line fetches a fresh row at half the age
  and when this machine's chain is ahead of the row's head. A member with no
  published chain gets no row, and the owner and members from before 2.4 have
  a null `fliVersion`. Driven under `wrangler dev`, 19 checks: the row verifies
  offline under the pinned key; a forged number or inviter, a row past a day,
  one signed by another key and one under another post key are refused; a
  `fliVersion` that could carry a line is refused with the code unspent; a
  paper key moves the head and the check re-signs; a restart keeps the key.
- [x] 2.5 `fli frontier:who` takes a nick or a number and
  prints the signed row beside the fingerprint words: `#0042 sam · joined
  2026-10-21 · pre-1.0 · via #0007`. One verb for *who is this*, not two.
  Built: `42` and `#42` read a number through `GET /row?number=`, and the
  row is graded against the pinned post key, held to the nick or number
  asked for, and bound to the chain just verified (`rowBindsChain`: its root,
  a head the chain holds) before anything prints; a refusal exits 1 with no
  number shown. The inviter prints as the nick the row signs, `via sam`, not
  `#0007`: the row carries no inviter number, and a second row fetched for it
  buys a number `who sam` already shows. `pre-1.0` is a `0.` `fliVersion`;
  a null one prints nothing. With no nick, `member.json` is graded the same
  way and fetched fresh when stale. With the post down, a nick reads its pin
  with no row and a number is refused. Driven under `wrangler dev` through a
  proxy that tampers with answers, 20 checks: `who bea`, `who 2`, `who #3`
  print the row and words; a forged number, a row re-signed under another
  key, another member's genuine row, and a chain swapped under the nick are
  each refused; the owner prints `#0001` with no inviter or version; a
  forged `member.json` is not shown and an old one is fetched fresh.
- [x] 2.6 `fli frontier:lineage [nick]`: the invite tree read from `invitedBy`.
  Built: from `GET /members`, no Worker change; the list is unsigned, which
  costs nothing against the post, since the post signs every row (B17).
  `lineageLines` in `core/frontier-member.js` draws it, each level by number,
  and with a nick or number keeps only the line up to the root and everyone
  under; each line reads as `who` prints, without the `via`, which is the
  line above. Driven under `wrangler dev`, 15 checks: five members in two
  branches drawn whole, `lineage cara` and `lineage #5` cut to their lines,
  an unknown nick or number refused, an inviter loop a lying post invents
  drawn once and stopped, `--dry` and a post down.
- [x] 2.7 `GET /badge/<number>.svg` from the Worker, for a README: the
  member's crest (2.10) beside `#0042 sam` (owner, 2026-10-22).
  Built: the one route nobody signs, since a README's reader has no key; it
  says what `GET /members` tells any member (`FJS-D1449`). `crestSvg` in
  `core/crest.js` draws it, 24px tall, and `memberNumber` moved to
  `frontier-chain.js` so the Worker writes the number as the cli does. A day
  of cache, since nothing on a badge changes but a redrawn crest; a CSP of
  `default-src 'none'`, since an SVG opened alone is a document on the post's
  origin. A member with no chain yet is a 409, as `GET /row` is. Driven under
  `wrangler dev`, 17 checks: bea's badge byte for byte against the root her
  own key makes, the owner refused before a verb publishes the chain and
  drawn after, an unknown number, a nick, another extension and a POST
  refused, every other route still signed, and Chrome parsing it and drawing
  two as `<img>` at 24px tall. `frontier:invite` publishes the chain too, since
  an owner who only invites otherwise kept a 409 badge; driven 6 checks, the
  badge 409 before the first invite and the owner's crest after it.
- [ ] 2.8 In Haven, the number is a nameplate on a member's figure, and
  `IDEAS/haven.md` 22.4's post office carries the members as a board.
  **Needs haven Phase 22.**
- [x] 2.9 ~~The oath: `frontier:stake` prints one line to accept before the
  code is spent.~~ Withdrawn (owner, 2026-10-22, `FJS-D1475`): `stake` asks
  nothing to accept, and the squatting line it was to carry is a written rule
  instead (4.2).
- [x] 2.10 The crest: a member's mark, drawn from the chain root as the
  eight words are (owner, 2026-10-22). It is the words as a picture, so it
  is stored nowhere and is the same on every machine. It is for recognition,
  not proof: people compare a picture fast but unevenly under attack
  ([Tan et al., CHI 2017](https://users.ece.cmu.edu/~lbauer/papers/2017/chi2017-fingerprints-author.pdf)),
  so the words stay the check. The shape is borrowed: a mirrored 5×5 grid
  from a hash ([GitHub identicons](https://github.blog/2013-08-14-identicons),
  after Perrig and Song's 1999 hash visualization) and a mark per identity
  ([Urbit sigils](https://github.com/urbit/sigil-js)). One pure module beside
  `pgp-words.js`, read by the Worker (2.7's SVG) and the cli (`frontier:who`
  draws it in colored half-blocks). A fixed root-to-grid vector is its test,
  because moving the algorithm redraws every member's crest. The root draws
  the field. The number and nick are written on the frame (a scroll reading
  `#0042 sam`), and they are not in the hash, because a crest that changed
  with them would no longer match the words.
  Built: `core/crest.js` reads the 64 bits the words read — two bytes for
  the 15 cells, then a metal, a color and which is the field, so the rule of
  tincture always holds. Four colors, not five: sable vanishes on a dark
  terminal. `frontier:who` draws it beside the label and words, `██` per cell,
  the field shaded `░░` with color off. The badge (2.7) writes the number and
  nick on its frame. The fixed root-to-grid test is owed until the
  drawing is settled.

### Phase 3 — Haven reads the chain

Goal: a Haven member is a network member.
Starts when: 0.4 is written and 2.4 is built (`FJS-D1444`). Haven is the first surface with strangers on it,
so this is where the chain becomes an identity provider rather than mail's
address book.
Done when: a scratch `HOME` that staked `ada` walks into a local Haven as
`ada` with no `~/.fli/haven/`, and a key in no chain is refused.

- [x] 3.1 `POST /haven/login` takes a login signed by a machine in the chain
  plus the signed member row, and the nick comes from the row. A row signed
  longer ago than the age is refused, naming its age (`FJS-D1445`). The
  first-come nick of `FJS-D981` goes.
  Built 2026-10-22 (`FJS-D1476`): the body is `{ publicKey, links, row }`,
  read offline against `HAVEN_POST_KEY`, and `Member.root` is the chain root.
  The chain code is `@frontierjs/toolbelt/frontier`. The key login, with its
  first-come nick, stays until 3.2, because the browser and agents use it.
  Driven: a scratch HOME staked as `ada` walks in as `ada` with no
  `~/.fli/haven/`, and a 30-hour row is refused, naming its age.
- [x] 3.2 Refuse a login whose key is in no chain. `~/.fli/haven/key.json`
  goes.
  Built 2026-10-23 (`FJS-D1477`): a login with no `links` is a 401 naming
  `fli frontier:stake` and `frontier:link`, and `fli haven` refuses before
  signing on a machine with no `frontier.nick`; `--nick` goes. A browser
  holds no key: `fli haven --browser` signs in on the terminal and opens the
  page with `#session=<token>`, which the page takes into the Junction
  client's `tokenStorage` and wipes from the address. Test havens pin a test
  post (`POST_KEY`), and a drive's `fli haven` walks from `stakedHome()`.
  The agents are left out until their way in is ruled ([FJS-3471](../ISSUES.md#fjs-3471)).
  Driven: `verify:explore` (a second chain's row naming `ana` is 409, a HOME
  in no chain is refused, no `~/.fli/haven/key.json`), `verify:browser` (Bea
  walks in on a handed session, the address is clean, a reload is the same
  member), `verify:fresh` (a staked machine with no checkout, twice, one
  member).

### Phase 4 — Names

Goal: the namespace has written rules before it has strangers.
Done when: staking a reserved nick is refused naming the reason, and the
squatting line is written where a member reads the network's rules.

- [ ] 4.1 A reserved list held by the Worker beside `OWNER_NICK` (Q5).
- [ ] 4.2 An npm-style squatting line, a written rule in the cli README's
  Frontier section that no verb prints (`FJS-D1475`).
- [x] 4.3 What a bad invitee costs the inviter — nothing to build: Q4 ruled
  that the public tree (2.6) is the whole of it (`FJS-D1449`).

### Phase 5 — Later

- [ ] 5.1 An optional domain proof, NIP-05 shaped, shown by `frontier:who`
  beside the row and never in place of the nick.
- [ ] 5.2 The nick as a subdomain. Waits on Q3, which is ruled again when
  Frontier Cloud has a first customer (`FJS-D1448`).
- [x] 5.3 The post served from a `frontierjs.com` host rather than
  `fli-tell.knightworks.workers.dev`: a custom domain on the same Worker,
  owner's ask 2026-10-22. Land it before strangers join.
  Built with 2.1: `network.frontierjs.com`, deployed by `fli ws:post` with
  `workers_dev` off, and no member's config names the origin. Deployed
  2026-10-22: `frontier:who` and `tell:inbox` answer from the new host and
  the `workers.dev` address answers 404.
- [ ] 5.4 A network a member runs. `network.frontierjs.com` stays the
  default, and a member whose primary id is there can stand up their own
  post at their own host (owner's ask 2026-10-22, not designed yet). Until
  it is designed, nothing built may close it off:
  - The identity is the chain root, never the post. A nick and a number are
    per post, so `#0042 sam` means "on this post", and a nick from another
    post is written with its host (`sam@net.example.com`) where one could be
    mistaken for the other.
  - `POST_ORIGIN` is a default, not the only origin. No code compares an
    origin to it to decide what a peer is, and when a member belongs to a
    second post their config names which post each membership is on.
  - The owner of a post is that post's member one (`FJS-D1460`), so a
    second post has its own owner with the same powers, and none over the
    default network.
  - A post's owner may choose to connect it to other posts, so a member of
    one can reach, mail or be read by a member of another (owner's ask
    2026-10-22). It is opt-in per post, and nothing connects by default. It
    stays open because a chain root verifies on any post, so a connected post
    checks a stranger's chain itself rather than trusting the post that
    vouched for them. Prior art to read first: Matrix federation and
    ActivityPub's per-instance block and allow lists.

### Phase 6 — The owner's view

Goal: the owner sees the whole post from `fli` without opening Cloudflare.
Holding the Cloudflare account already gives full access to the object's
storage, so this phase adds a reading and grants no power (Q9–Q11).
Done when: `fli frontier:post` run as the owner prints the five panels below
and run as any other member is refused, and `fli gui`'s `:post` pane draws
the same JSON.

- [ ] 6.1 `GET /post`, signed and answered only to the owner's machines. It
  returns the members (number, nick, joined, invited by, machine count,
  sealed or plain, chain length, last seen), the open invites (inviter, time
  left), the waiting mail per recipient (count, oldest, bytes, sealed or
  plain, never a body: Q10), the pending `asks` and `rekeys`, and the health
  figures (open `/follow` sockets, `nonces` rows, storage bytes). *Invited by*
  is blank until 2.2 stores it.
- [ ] 6.2 `members.lastSeen`, written on every signed request. Nothing records
  when a member last used the post today.
- [ ] 6.3 `fli frontier:post` prints the reading as panels, and `--json`
  prints it as is. It is the one reader (`FJS-D223`).
- [ ] 6.4 A `:post` pane in the console that spawns `--json`, the same way
  `:map` reads `project:map`.
- [ ] 6.5 Refused signatures counted per day on the object, and shown as a
  health figure. Probing is the one attack the owner can see from here.
- [ ] 6.6 Owner actions, added only when one is first needed: withdraw an
  invite, reserve a nick (4.1), hide a member. Each writes a row to an
  `actions` log that the view prints.

---

## Open questions

- ~~**Q9 — Who holds superuser on the post.**~~ **Answered 2026-10-23 (`FJS-D1460`): A — the owner only: member one (`OWNER_KEY`/`OWNER_NICK`), with no role table. *Mastodon's* Owner role bypasses every permission check ([roles](https://docs.joinmastodon.org/admin/roles/)), and its Admin, Moderator and custom roles serve a staff of several.** Holding the Cloudflare account
  already gives full access to the object's storage. A role in the post adds
  a view and a record of what was done, not power.
  - **A** — the owner only: member one (`OWNER_KEY`/`OWNER_NICK`), with no
    role table. *Mastodon's* Owner role bypasses every permission check
    ([roles](https://docs.joinmastodon.org/admin/roles/)), and its Admin,
    Moderator and custom roles serve a staff of several.
  - **B** — Owner and Moderator roles now, Mastodon's current shape.
  - **C** — no role: the owner reads the object's storage from Cloudflare,
    and nothing is built.
  - **Recommend A** (confidence 3) — four members leave nobody to give a
    Moderator role to, and B reopens when a second person needs one.
- ~~**Q10 — Whether the owner's view shows letter text.**~~ **Answered 2026-10-23 (`FJS-D1461`): A — never: count, oldest, bytes, and sealed or plain. *Synapse's* admin API lists rooms and whether each is encrypted, and returns encrypted content still encrypted ([rooms](https://github.com/dklimpel/synapse_archive/blob/119b137cfa72e5e24c700eb5c5c060e62728597d/docs/admin_api/rooms.md), [FAQ](https://git.sharpetronics.com/sharpetronics/synapse/raw/branch/develop/docs/usage/administration/admin_faq.md)).** V1's plain letters
  are readable by the post.
  - **A** — never: count, oldest, bytes, and sealed or plain. *Synapse's*
    admin API lists rooms and whether each is encrypted, and returns encrypted
    content still encrypted ([rooms](https://github.com/dklimpel/synapse_archive/blob/119b137cfa72e5e24c700eb5c5c060e62728597d/docs/admin_api/rooms.md),
    [FAQ](https://git.sharpetronics.com/sharpetronics/synapse/raw/branch/develop/docs/usage/administration/admin_faq.md)).
  - **B** — show plain bodies, for debugging V1.
  - **Recommend A** (confidence 3) — sealed letters cannot be opened anyway,
    so A treats both kinds the same, and B reads mail the members never
    agreed to have read.
- ~~**Q11 — Where the view lives.**~~ **Answered 2026-10-23 (`FJS-D1462`): A — `fli frontier:post` with `--json` as the one reader, and a `:post` pane in `fli gui` that draws it (`project:map` and `:map`).**
  - **A** — `fli frontier:post` with `--json` as the one reader, and a
    `:post` pane in `fli gui` that draws it (`project:map` and `:map`).
  - **B** — the command only.
  - **C** — an `/admin` page on the Worker: a second login, at a URL a
    stranger can find.
  - **Recommend A** (confidence 2) — one reader with two presentations is
    `FJS-D223`, and the pane costs one spawn.

- ~~**Q1 — The verb for the first door.**~~ **Answered 2026-10-22 (`FJS-D1446`): A — `stake`: "stake a claim" is the frontier idiom, and the word is free in `VOCABULARY.md`.**
  - **A** — `stake`: "stake a claim" is the frontier idiom, and the word is
    free in `VOCABULARY.md`.
  - **B** — `claim`: the colloquial word. But *Claim* is blessed as a fact a
    principal carries for one call (`auth().<claim>`, `bearerClaim`), and
    Invariant 5 already turned it down once for that reason.
  - **C** — `join`: today's spelling, but it reads as joining a group rather
    than taking a name.
  - **Recommend A** (confidence 3) — B gives one word two meanings, and C
    loses the nick from the verb.
- ~~**Q2 — The namespace.**~~ **Answered 2026-10-22 (`FJS-D1447`): A — `frontier:`, matching the product name.**
  - **A** — `frontier:`, matching the product name.
  - **B** — a short one, `me:` or `id:`.
  - **C** — top-level verbs: `fli stake`, `fli who`.
  - **Recommend A** (confidence 2) — it groups seven verbs where C scatters
    them. The repetition (`fli` already means frontier) is the price, the
    same as `gh auth`.
- ~~**Q3 — Whether a network member is the Frontier Cloud account.**~~ **Answered 2026-10-22 (`FJS-D1448`): C — not yet: ruled when Cloud has a first customer, with nothing here shut that would close A.**
  - **A** — yes: one account, and the nick is the subdomain (pico.sh).
  - **B** — no: Cloud has accounts of its own.
  - **C** — not yet: ruled when Cloud has a first customer, with nothing here
    shut that would close A.
  - **Recommend C** (confidence 2) — no Cloud product exists (`IDEAS/frontier-cloud.md`)
    to take a precedent from, and C moves no callers.
- ~~**Q4 — What a bad invitee costs the inviter.**~~ **Answered 2026-10-22 (`FJS-D1449`): A — nothing: the tree is public, and that alone is the accountability.**
  - **A** — nothing: the tree is public, and that alone is the accountability.
  - **B** — the inviter's unspent allowance is withdrawn.
  - **C** — the Lobsters rule: the inviter can lose access.
  - **Recommend A** (confidence 2) — at three to four members there is no
    moderation load to answer, and B reopens as the stricter path.
- ~~**Q5 — Nick uniqueness and reserved names.**~~ **Answered 2026-10-22 (`FJS-D1450`): A — unique on the post, first-come behind an invite, plus a reserved list and the squatting line.**
  - **A** — unique on the post, first-come behind an invite, plus a reserved
    list and the squatting line.
  - **B** — the handle is a domain.
  - **C** — a non-unique alias.
  - **Recommend A** (confidence 3) — see § Rejected for B and C.
- ~~**Q6 — Whether a nick can change.**~~ **Answered 2026-10-22 (`FJS-D1451`): A — never. The nick is the name, and the number never changes either.**
  - **A** — never. The nick is the name, and the number never changes either.
  - **B** — renamable, with the old nick held back for a period.
  - **Recommend A** (confidence 2) — pins are by chain root, so B is safe
    cryptographically, but every letter, lineage row and Haven nameplate would
    then need to follow a rename. B reopens when someone asks for it.
- ~~**Q7 — How fresh a member row must be.**~~ **Answered 2026-10-22 (`FJS-D1445`): A — the post stamps the row with when it was signed, and a reader refuses a row older than a set age. A member's machine fetches a fresh row before it goes stale, so a revoke reaches every reader within that age. *Memory:* OCSP stapling (the holder brings a fresh signed proof) and short-lived certificates.**
  The row is signed again as the
  head moves (2.4), and a peer refuses a chain shorter than one it
  has seen (`FJS-D1421`). A reader that has never seen the newer head has
  nothing to refuse, so a thief holding a revoked machine and the row from
  before the revoke walks into a surface that is meeting them for the first
  time.
  - **A** — the post stamps the row with when it was signed, and a reader
    refuses a row older than a set age. A member's machine fetches a fresh
    row before it goes stale, so a revoke reaches every reader within that
    age. *Memory:* OCSP stapling (the holder brings a fresh signed proof) and
    short-lived certificates.
  - **B** — the reader asks the post at every login. A revoke is immediate,
    and the post becomes a dependency of every surface staying up.
  - **C** — as built: no age, and a reader catches a revoke only once it has
    seen a later head.
  - **Recommend A** (confidence 2) — it keeps 6.4's no-call-to-the-post
    reading, and the age is a cost dial: a stolen key's reach is bounded by
    it (*strictness follows cost*). B is the reopen path once a surface holds
    something a day's window would lose.
- ~~**Q8 — Whether the network is an identity layer of its own.**~~ **Answered 2026-10-22 (`FJS-D1444`): A — one layer, owned: the chain is the one identity, and 0.4 and Q7 are written before any surface with strangers reads it (Phase 3).**
  Once mail,
  Haven, peering and Cloud read one chain, the post is an identity provider
  and owes what one owes: revocation that reaches every reader, a threat model,
  linkability, erasure, recovery and a dispute policy.
  - **A** — one layer, owned: the chain is the one identity, and 0.4 and Q7
    are written before any surface with strangers reads it (Phase 3).
  - **B** — a layer per surface: each keeps its own key and nick, and a member
    links them only by choice. A stolen key reaches one surface, and every
    concern above is answered once per surface.
  - **C** — borrow the root: the identity is held elsewhere (GitHub's
    published SSH keys, or OIDC), and the post maps a nick to it. Recovery,
    second factors and abuse become the other party's, and the first door
    goes through it.
  - **Recommend A** (confidence 2) — B does not remove the concerns, it
    doubles them: Haven's first-come nick (`FJS-D981`) already carries
    impersonation, squatting and recovery of its own. C is the reopen path if
    the post's operator load outgrows one owner.
