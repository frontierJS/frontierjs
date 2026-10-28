---
id: frontier-files
status: proposed
dated: 2026-10-27
---

# Idea — Files through the Frontier post: a member uploads, anyone with the link downloads

**Status: PROPOSED.** Dated 2026-10-27. Phases 1 and 2 are built
(uncommitted) and `test:post-files` drives both; Phase 0's bucket exists and
Phase 3.1 deployed them 2026-10-28. Do not cite this file as
behavior — see `VERIFYING.md`. Cloudflare's limits were read from its
docs on the date above, not measured. Q1–Q4 ruled `FJS-D1563`–`FJS-D1566`.

Sibling of `frontier-network.md`, which is over the 32 KB plan size and owns
the post this rides on (`packages/cli/core/tell-worker.js`).

---

## The ask

The owner, 2026-10-27: a member uploads a file to the post and gets a link, and
the person they give it to downloads it. **24 MiB at most**, and **free**.

## The claim

- **The size fits in every free store.** 24 MiB is under the Worker's 100 MB
  request body on the Free plan
  ([Workers limits](https://developers.cloudflare.com/workers/platform/limits)),
  so there is no presigned URL, no multipart upload and no S3 credential. The
  whole file fits in memory, so it is encrypted in one go with WebCrypto's
  AES-GCM, with no chunked stream to get wrong.
- **The bytes are an R2 object, keyed by the file's id** (`FJS-D1563`).
  Downloading from R2 costs nothing, and the free tier covers 10 GB-month of
  storage, 1M writes and 10M reads a month
  ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)). R2 needs a
  card on the account, and usage past the free tier is billed.
- **Free because of a budget the post enforces.** The post refuses an upload
  that would take the live bytes past `FILE_BUDGET`, which is set well under
  10 GB, so the bill cannot move while the budget holds.
- **The post owns every file's state, and R2 holds only bytes.** The size,
  expiry, downloads left and put-token hash are one row on `TellPost`, and
  its alarm removes the object and the row after the last download or at
  expiry. An R2 lifecycle rule is the backstop.
- **The post holds only ciphertext.** The key rides in the link after `#`,
  which a browser never sends, so the post sees neither the content nor the
  file name. This matches the sealed letters (`FJS-D1400`) and Q10's ruling
  that the owner's view never shows a body (`FJS-D1461`).
- **A member recipient needs no new delivery.** `--to <nick>` sends the link
  as a letter, and a member with a sealing key gets it sealed, key included.
- **The guard against abuse is who uploads, not how much.** Only members
  upload: joining is invite-only (`FJS-D1415`), every request is signed by a
  chain, and the invite tree is public (`FJS-D1449`). Short expiry and an
  owner delete do the rest. The size cap does not help here, because a
  malware dropper fits in under 1 MB.

## Prior art

- **Firefox Send** (Mozilla, 2017–2020): encrypted in the browser, key in the
  fragment, expiring links. It was suspended in July 2020 and closed in
  September after it became a host for malware payloads and spear-phishing:
  the files could not be scanned, and uploads were anonymous
  ([ITPro](https://itpro.com/security/357155/mozilla-shuts-down-firefox-send-due-to-malware-abuse),
  [TechRadar](https://www.techradar.com/news/mozilla-suspends-firefox-send-service-following-malware-abuse)).
  We take its shape and close the anonymous-upload gap with the chain.
- *Memory:* magic-wormhole and croc, which pass files between two machines
  that are both online. The post stores the file instead, so the recipient
  need not be online when it is sent. Both send a folder as one archive,
  which 4.3 takes.
- **uqr** (unjs) and **Nayuki's QR Code generator**, which uqr ports: the
  encoder 4.2 follows, byte mode at level M only.

## Rejected

- **A Durable Object per file.** Free with no card on the Workers Free plan
  (5 GB of SQLite storage per account,
  [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing)),
  but a row holds 2 MB, so a full file is 12 chunk rows. That is chunking code,
  plus an unmeasured risk against Free's 10 ms CPU per request. The owner took
  R2 (`FJS-D1563`). Reopen it if the card has to come off the account.
- **Workers KV.** Free and with no card, and it has expiry built in, but 1 GB
  holds about 42 full files and the free plan allows 1,000 writes a day
  ([KV pricing](https://developers.cloudflare.com/kv/platform/pricing)).
  *Memory:* a new key can take up to about 60 s to reach other regions, so a
  fresh link can 404 for the recipient.
- **Chunks in the post's own object.** That is one object, and every upload
  would queue behind every letter, login and `/follow` socket.

## Plan

### Phase 0 — Groundwork

Goal: the questions are ruled, the account can hold a bucket, and the threat
model names the routes.
Done when: Q1–Q4 are answered, the bucket exists with its lifecycle rule, and
`THREATS.md` has the file row.

- [x] 0.1 Read which Workers plan the post's account is on and whether R2 is
  enabled. Enabling R2 and adding the card are the owner's to do.
  - 2026-10-28: R2 is not enabled. `wrangler r2 bucket list` on account
    `fbd7b9af…` answers code 10042 ("enable R2 through the Cloudflare
    Dashboard"). The Workers plan is not read yet.
  - 2026-10-28: the owner enabled R2; `wrangler r2 bucket list` answers
    with no error. The Workers plan is still unread — no step turns on it.
- [x] 0.2 Create the `frontier-files` bucket with a lifecycle rule that
  deletes any object older than 8 days, one day past the 7-day maximum. This
  is an outward action on the account, so it needs the owner's go.
  - 2026-10-28: created. Rule `expire-8d` expires objects after 8 days and
    aborts incomplete multipart uploads after 1; `wrangler r2 bucket
    lifecycle list frontier-files` shows it beside R2's default 7-day abort.
- [x] 0.3 Rule Q1–Q4 — `FJS-D1563`–`FJS-D1566`.
- [x] 0.4 Add the file routes to `THREATS.md` beside B18: what a member can
  upload, what a stranger holding a link can do, and what the post can read.
  - Built as B23 (a member uploading) and B24 (a stranger holding a link),
    appended because the numbers are citation keys. What the post can read
    stays B19's until Phase 2 seals the bytes; B24's *Open* says so.

### Phase 1 — The store

Goal: the post takes a member's file and gives it back to anyone holding its id.
Done when: a drive on `wrangler dev`, with local R2, puts 24 MiB and fetches it
back byte for byte. The fetch after the last download is refused (404 once
the sweep has run, 410 inside it).
`FILE_MAX` + 1 byte, an upload past `FILE_BUDGET`, an expired id and an unsigned
`POST /file` are each refused by name. And no object or row is left after the
last download's sweep or after expiry.

- [x] 1.1 A `files` table on `TellPost` (id, nick, size, created, expires,
  downloadsLeft, tokenHash, put), and `POST /file`, signed, with `{ size,
  expires, downloads }`. It checks the allowance (`FJS-D1565`) and
  `FILE_BUDGET` against `SUM(size)` over the rows still held, writes the row,
  and returns `{ id, putToken }`. `MAX_FILE`, `FILE_BUDGET` and the allowance
  are constants beside `SEND_MAX`.
  - Built with three changes. The ask is `{ size, seconds, downloads }`,
    since `expires` is an absolute time everywhere else on the post (an
    invite answers one). `put` became `state` (`asked`, `putting`, `held`)
    plus `sweepAt`, the row's next deadline, which is what the alarm reads.
    A row deleted after its last download takes its count with it, so the
    10-a-day count is its own `uploads` table. `FILE_MAX` is 24 MiB plus
    1 KiB for the IV, the tag and the sealed name, so a full 24 MiB file
    fits once encrypted; `FILE_BUDGET` is 5 GiB; a member holds
    `10 × FILE_MAX`, so the tenth full file is not refused by its envelope.
    An ask holds budget from the moment it is answered and is swept if not
    put within `PUT_SECONDS` (600), so asks cannot hoard the budget.- [x] 1.2 `PUT /file/<id>` with the token: the Worker asks the post to spend
  the token, which it does once and returns the declared size. The Worker
  refuses a `Content-Length` other than that size, then streams the body into
  `env.FILES.put(id, …)`. The Worker's default export handles `/file/<id>…`
  itself and sends every other path to the post as now. The post's `fetch`
  reads every body as text, and a 24 MiB binary body must not pass through it.
- [x] 1.3 `GET /file/<id>/bytes`: the post takes one download off atomically
  (410 at none left or past expiry), and the Worker streams the R2 object.
  The post's alarm runs at the earliest of a row's expiry and a few minutes
  after its last download, so the last stream finishes before the sweep. It
  deletes the object and then the row (`FJS-D1565`: cleaned up after the last
  download or at expiry).
  - Built so that the last download's stream, when it ends, tells the
    object (`drained`), and the object deletes the object and the row then;
    the alarm at `DRAIN_SECONDS` (600) is only the backstop for a Worker
    that died mid-stream.
- [x] 1.4 `DELETE /file/<id>`, signed by the uploader or the owner, is the
  kill switch: the post deletes the object and the row at once. It is listed
  as one of Phase 6's owner actions (6.6).
- [x] 1.5 `fli ws:post`'s wrangler config gains
  `r2_buckets: [{ binding: 'FILES', bucket_name: 'frontier-files' }]`.
  - Built, so the next `ws:post` fails until 0.2's bucket exists: a deploy
    naming a bucket the account lacks is refused by wrangler.
- [x] 1.6 `test:post-files` (`packages/cli`) is the Done-when drive, on
  5508 (`docs/PORTS.md`), 23 checks green on 2026-10-27. It signs as the
  owner, so the member allowance (10 a day, `FILES_HELD`) is not driven: a
  member needs an invite and a chain, and no drive builds one yet.

### Phase 2 — The client

Goal: a file goes from a member's machine to anyone, by `fli` or by a browser.
Done when: the drive sends a file with `fli`, then fetches it both with `fli`
and in Chrome from the printed link, and both copies match the original's
sha256; and the bytes the object holds contain neither the plaintext nor the
file name.

- [x] 2.1 The upload verb (Q4) encrypts the file with its name and type
  inside, asks, puts, and prints
  `https://network.frontierjs.com/file/<id>#<key>` with its limits beside it
  (`1 download, expires in 24 h`): a link that dies after one use surprises
  the person who forwards it. `--to <nick>` sends the link as a letter.
  - The plaintext cap is `FILE_MAX` minus the seal's envelope, read from
    one place (or off the post's 413, as `test:post-files` reads it), never
    a second 24 MiB written here.
  - Built as `commands/tell/upload.md`. The seal is `sealFile`/`openFile`
    in `@frontierjs/toolbelt/frontier`, the module every end of the network
    reads, and `FILE_MAX` moved there beside `FILE_PLAIN_MAX`; the Worker
    imports it. `--downloads` and `--hours` carry no default or range: a flag
    left out is left out of the ask, so the post owns the numbers, and the
    limits line is printed from its answer (`fileLimits`). `--to` meets the
    recipient before the upload and refuses one with no sealing key, as
    `--env` does; the meeting moved into `_module.md` (`meetForLetter`),
    which `tell:send` calls too. Not driven: `--to`, which needs a second
    member, the gap 1.6 names.
- [x] 2.2 The download verb fetches the link, decrypts it, and writes the
  file under its own name. A file that fails the GCM tag is refused rather
  than written.
  - Built as `commands/tell/download.md`. The sealed name's last path
    segment only, and `name (1).ext` beside a file already there, since the
    download is spent. The Worker answers `x-downloads-left` with the bytes,
    so both clients say what is left.
- [x] 2.3 `GET /file/<id>` serves a small page that reads the key from
  `location.hash`, fetches `/bytes`, decrypts, and offers the file to save,
  with the same limits line. The page loads no script from anywhere else.
  - Built with a `peek` step for the limits line, and the fetch waits for
    the Download button, so a chat app's link preview spends nothing. The
    page's script inlines `openFile`'s source, so the page and the cli read
    with one function; CSP pins script and style by hash. The key is read at
    the click, since a fragment pasted onto an open page reloads nothing.
- [x] 2.4 Write the verbs, limits and expiry into the cli README's § The
  Frontier network. The `tell` module's line (`_module.md`) says "letters
  between members", and a file's recipient may not be a member, so it changes
  too.
  - README § The Frontier network › Files. `test:post-files` is 35 checks,
    green on 2026-10-27, Chrome included.
- [x] 2.5 Deflate before sealing, kept only when smaller; the cap counts the
  original bytes and `openFile` refuses an inflate past it (`FJS-D1574`).
  - 2026-10-28: built; `test:post-files` 35 green, Chrome included. The
    bomb and an unknown encoding were probed by hand, not by a row. The live
    post's page predates it until the next `ws:post`.

### Phase 3 — Live

Goal: one real file reaches someone who is not a member.
Done when: the owner sends a file to a non-member, and that person opens it
from the link in a browser.

- [x] 3.1 Redeploy with `fli ws:post`. Like every redeploy, this needs the
  owner's explicit go.
  - 2026-10-28: deployed, version `ae881820`, with `FILES` bound to
    `frontier-files`. A 300 KB `tell:upload` came back through
    `tell:download` with the same sha256, the page answered 200, and the
    spent link answered 404. The browser half of *Done when* is the owner's.

### Phase 4 — Everyday sending

Goal: a link is traceable to its sender at a glance, reaches a phone from the
screen, and takes a pipe or a folder as easily as a file.
Done when: `test:post-files` drives each, and the owner scans a `--qr` code
with a phone.

- [x] 4.1 The file's page shows the sender's crest, and nothing else of them
  (owner's call: no number, nick or inviter). `peek` answers the uploader's
  root, `crestSvg` draws without a label, and `tell:upload` publishes the
  chain as every other `tell` verb does, so a member who has only uploaded
  still has a crest.
- [x] 4.2 `--qr` prints the link as a QR code, black on white whatever the
  terminal's theme. `core/qr.js` has no dependency (owner's call); it matched
  the `qrcode` package bit for bit, mask included, on 14 texts from v1 to v40,
  and jsQR decoded 28. Level L and a two-module margin (owner's call, after
  the first scan read as too big): a post link is 41 columns by 21 lines.
- [ ] 4.2.1 The owner scans one from a phone.
- [x] 4.3 A folder goes as `<folder>.zip` (`core/zip.js`, stored, since the seal
  deflates; symlinks left out), and `-` reads stdin up to the cap, named by
  `--name`.
- [ ] 4.4 Redeploy with `fli ws:post` so the live page shows the crest. This
  needs the owner's go.

---

## Open questions

- ~~**Q1 — What "free" means.**~~ **Answered 2026-10-28 (`FJS-D1563`): B — a card on file is fine: R2, with the post's byte budget holding usage inside R2's free tier.**
  - **A** — no card on the account: a Durable Object per file, where every
    limit fails closed.
  - **B** — a card on file is fine: R2, with the post's byte budget holding
    usage inside R2's free tier.
  - **C** — KV: no card, but 1 GB and the replication lag.
  - **Recommend A** (confidence 2) — A cannot bill whatever goes wrong, and
    24 MiB fits its rows. B is simpler to code and becomes the reopen path if
    the cap ever rises.
- ~~**Q2 — Whether every file is encrypted.**~~ **Answered 2026-10-28 (`FJS-D1564`): A — always: the key goes in the fragment and the post holds only ciphertext.**
  - **A** — always: the key goes in the fragment and the post holds only
    ciphertext.
  - **B** — plain: the owner can open a reported file and judge it, and the
    page needs no decrypting script.
  - **C** — the uploader chooses.
  - **Recommend A** (confidence 2) — it is what the sealed letters already
    promise. Send failed because its uploads were anonymous, which the chain
    closes; it did not fail because of the encryption.
- ~~**Q3 — Expiry, downloads and allowance.**~~ **Answered 2026-10-28 (`FJS-D1565`): A — expires in 24 h by default and 7 days at most; 1 download by default and 10 at most; 10 files a day and 240 MiB in flight per member, with the owner uncapped. All are constants, as the invite allowance is (`FJS-D1466`).**
  - **A** — expires in 24 h by default and 7 days at most; 1 download by
    default and 10 at most; 10 files a day and 240 MiB in flight per member,
    with the owner uncapped. All are constants, as the invite allowance is
    (`FJS-D1466`).
  - **B** — 7 days and unlimited downloads by default; a budget only for the
    whole post.
  - **Recommend A** (confidence 1) — a link that dies after it is used leaks
    least if it is forwarded. The numbers are a starting guess.
- ~~**Q4 — The verbs.**~~ **Answered 2026-10-28 (`FJS-D1566`): A — `fli tell:upload <path> [--to <nick>]` and `fli tell:download <link>`, under `tell:` with the mail. *ffsend*, a Firefox Send client, uses the same pair.** `tell:send --file` is not open: `--file` (`-f`) there
  already means the env file to read (`commands/tell/send.md`). `fetch` is
  not open either: `fetch:` is a namespace (`fetch:image`, `fetch:json`), and
  `tellFetch` is the post's HTTP helper in `core/tell.js`.
  - **A** — `fli tell:upload <path> [--to <nick>]` and
    `fli tell:download <link>`, under `tell:` with the mail. *ffsend*, a
    Firefox Send client, uses the same pair.
  - **B** — `fli frontier:upload` / `frontier:download`.
  - **Recommend A** (confidence 1) — a file is mail, and `frontier:` is
    identity. Both verbs sit on one axis, where `tell:file` would have mixed a
    noun with a verb.
