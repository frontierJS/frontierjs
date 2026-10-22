---
id: frontier-network
status: proposed
dated: 2026-10-22
---

# Idea — The Frontier network: one nick and one chain for every `fli` surface

**Status: PROPOSED.** Dated 2026-10-22. Nothing here is built beyond what
`IDEAS/pony-express.md` already built. Do not cite this file as behavior — see
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
`IDEAS/pony-express.md` Phase 6 (numbers, the invite allowance, the signed
member row, lineage, the badge, the oath) is already this network in all but
name.

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
| Keybase | A per-device key signed into a chain, every device equal, a paper key that is revocable like any device ([2016 talk](https://openpgp.org/community/email-summit/2016/talk_KeybaseAndPGP_160709.pdf), [sigchain v2](https://book.keybase.io/docs/teams/sigchain)). *Memory:* acquired by Zoom in 2020 and stalled. | Already built as pony-express 4.3–4.7 |
| Lobsters | A public invite tree. An inviter answers for their invitees and can lose access over them ([summary](https://linuxfr.org/users/ploum/journaux/un-service-d-hebergement-lobste-rs.epub), [critique](https://tildes.net/~tildes/1qq/tildes_versus_lobste_rs)). | Lineage (pony-express 6.6) and Q4 |
| Urbit | An identity is a number, and each sponsor issues a fixed count; the scarcity is the anti-spam measure ([Wikipedia](https://en.wikipedia.com/wiki/Urbit)). *Memory:* each number has a pronounceable name (`~sampel-palnet`). | The allowance (6.3), and a spoken name for `#42` read off the PGP word list |
| [Radicle](https://radicle.xyz/guides/user) | The alias is non-unique and changeable, and the Ed25519 key is the identity. | Rejected below: the shape a network takes when it declines a namespace |
| [Bluesky](https://bsky.social/about/blog/4-28-2023-domain-handle-tutorial), [Nostr NIP-05](https://nostr.how/en/get-verified) | The handle is a domain the member proves, by DNS TXT or `/.well-known/`. NIP-05 says it identifies and does not verify. | Phase 5's optional proof |
| [npm](https://docs.npmjs.com/policies/disputes) | Squatting is a written rule: a name held with no real use. It may refuse a valid claim that would risk the supply chain. | The squatting line in the oath (4.2) |
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
   chain against the post's signed member row (pony-express 6.4), so a reader
   needs no call to the post.
8. **Failure** — a taken or reserved nick is refused at `stake` and names why.
   The cost is a retry, and nothing is written.
9. **Silence** — what must stay true: one person is one chain across every
   `fli` surface, and a revoke reaches every reader within the row's age.
   What fails when it stops: none today. 3.2 adds Haven's refusal of a login
   whose key is in no chain, and 3.1 its refusal of a row older than the age.

**Tier:** Assessment. Every question is ruled (`FJS-D1444`–`FJS-D1451`); 0.4 and
2.4 block Phase 3.

## Plan

### Phase 0 — Groundwork

Goal: the questions ruled, and the callers of both key directories known.
Done when: Q1–Q8 are rulings, 0.4 is written, and every reader of
`~/.fli/tell` and `~/.fli/haven` is listed under 0.1.

- [ ] 0.1 List every reader of `~/.fli/tell/` and `~/.fli/haven/key.json`
  with `rg`, including the prototypes `fli ws:surface --also ../fjs-prototypes`
  reaches.
- [x] 0.2 Rule Q1–Q8.
- [ ] 0.3 Move `IDEAS/pony-express.md` Phase 6 here verbatim as Phase 2,
  leaving a one-line pointer under its heading. Its step numbers become 2.x,
  and pony-express keeps mail (Phases 1–3 send and inbox, Phase 5 Haven
  carries letters).
- [ ] 0.4 Write the post into `THREATS.md`, which names no post, chain or
  `tell` today. One row per attacker, each naming what they may do and the
  test that proves it: a thief holding a revoked machine and a stale member
  row (Q7), a stranger squatting or impersonating a nick, and the operator of
  the post itself. Beside it, a § Privacy in this file: what one nick links
  across surfaces, what the public lineage publishes about who invited whom,
  and what a member who leaves can have erased from an append-only chain.

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
  `tell:setup` leaves the user surface as pony-express 6.1 already plans.
  Built: the nick is the first argument, not `--nick`. Driven under `wrangler
  dev` with two scratch `HOME`s, 10 checks: an invite minted, `ada` staked,
  a spent code refused, a letter each way, reading deleted it, and
  `tell:join` an unknown command. Not run against the deployed post.

### Phase 2 — Member numbers

Goal and steps: pony-express Phase 6, moved here by 0.3. Its 6.4 carries
Q7's age (`FJS-D1445`), so 2.4 is the step Phase 3 waits on.

### Phase 3 — Haven reads the chain

Goal: a Haven member is a network member.
Starts when: 0.4 is written and 2.4 is built (`FJS-D1444`). Haven is the first surface with strangers on it,
so this is where the chain becomes an identity provider rather than mail's
address book.
Done when: a scratch `HOME` that staked `ada` walks into a local Haven as
`ada` with no `~/.fli/haven/`, and a key in no chain is refused.

- [ ] 3.1 `POST /haven/login` takes a login signed by a machine in the chain
  plus the signed member row, and the nick comes from the row. A row signed
  longer ago than the age is refused, naming its age (`FJS-D1445`). The
  first-come nick of `FJS-D981` goes.
- [ ] 3.2 Refuse a login whose key is in no chain. `~/.fli/haven/key.json`
  goes.

### Phase 4 — Names

Goal: the namespace has written rules before it has strangers.
Done when: staking a reserved nick is refused naming the reason, and the oath
prints the squatting line.

- [ ] 4.1 A reserved list held by the Worker beside `OWNER_NICK` (Q5).
- [ ] 4.2 The oath (pony-express 6.9) carries an npm-style squatting line.
- [x] 4.3 What a bad invitee costs the inviter — nothing to build: Q4 ruled
  that the public tree (2.6) is the whole of it (`FJS-D1449`).

### Phase 5 — Later

- [ ] 5.1 An optional domain proof, NIP-05 shaped, shown by `frontier:who`
  beside the row and never in place of the nick.
- [ ] 5.2 The nick as a subdomain. Waits on Q3, which is ruled again when
  Frontier Cloud has a first customer (`FJS-D1448`).

---

## Open questions

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
  head moves (pony-express 6.4), and a peer refuses a chain shorter than one it
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
