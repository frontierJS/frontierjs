---
id: workbench-basecamp-setups
status: proposed
dated: 2026-11-11
---

# Workbench over Basecamps — setups from the laptop

**Status: PROPOSED.** Dated 2026-11-11. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want (owner, 2026-11-11): from `/basecamps/`, set up and trigger the things a
Basecamp needs that only this laptop has the access for — first a one-click B2
backup, then the rest of the list below. It follows `workbench-basecamps.md`,
which built the index and the verbs (back up, restart, create).

**One pattern runs through every phase.** The laptop holds the account-wide
credentials (B2, Cloudflare, DigitalOcean, the ssh keys, each Basecamp's admin
key). A setup uses one of them to make a NARROW credential for one Basecamp,
hands it over through Basecamp's own API, and runs Basecamp's own test of it.
The account-wide credential never leaves the laptop. Where a vendor cannot mint
a narrow one, Q6 decides.

Found the day it was asked: ELA's database could not be copied off chartered,
because chartered has no backup destination and `fli db:download` reads only a
bucket. Phases 1 and 2 close that.

---

## What exists

- **Basecamp's side of B2 is built** (`packages/basecamp/docs/backups.md`).
  `BackupDestination` (workspace-owned, `FJS-D1491`) takes `secret` as
  `<keyId>:<applicationKey>` and lifts it into an `@encrypted` Secret;
  `backupDestinations.test` is a PUT+DELETE probe that also reads the bucket's
  Object Lock (`FJS-D1809`). The hub's own backups ride its App row
  (`FJS-D1606`): `hubConfig.save` takes `backupCron`, `backupDestinationId`
  and `replicaDestinationId`. Each App has `backupCron` and
  `backupDestinationId`, which must be in the App's own workspace.
- **Nothing makes a bucket or a key.** Step 0.9 of `basecamp-safety.md` waits on
  the owner bringing one by hand, and no B2 credential is in
  `~/.config/fli/.env`. `DIGITALOCEAN_TOKEN` and `CLOUDFLARE_TOKEN` are.
- **The key copy has a check.** `hubConfig.attestEscrow` stamps
  `encryptionKeyEscrowedAt` and `encryptionKeyFingerprint` from the box's own
  key; the `hub.key-escrowed` control grades it. Nothing compares it with a
  copy the laptop holds (`basecamp-safety.md` 0.6).
- **Workbench's Basecamp service** (`packages/workbench/api/src/services/basecamps/`)
  has `list`, `backup`, `restart`, `provision`, `reinstall` and `deleteLocal`
  over `packages/cli/core/basecamps.js`. Its index is read-only from the
  screen by `FJS-D1961` (Q5 there), which the owner reopened on 2026-11-11 —
  Q1 here.
- **`fli basecamp:key`** mints an admin key over ssh and files it; its body is
  in the command, not in `core/`.
- **Vendor seams Basecamp already has:** a `providerKey` Secret with
  `providerKind` (`cloudflare`, `digitalocean`, …), `servers.adopt` and
  `servers.setBackups` (`machine-backups.md`), `Server.sshKeyId` graded by
  `ssh.unknown-key` (`box-ssh-keys.md`), `Workspace.pushTopic` for ntfy
  (`phone-ping.md`), and `Server.outpostVersion`.

## Security

Every setup is an admin call made with the entry's `apiKey`, so it needs nothing
`FJS-D1827` did not already grant. What is new is the laptop minting vendor
credentials. A B2 key Workbench makes is limited to one bucket and one prefix
and is named for its Basecamp, so a box that leaks it exposes that Basecamp's
own archives and nothing else. A setup prints a key's id, never its secret,
and no answer from the Workbench API carries one. One cost is new: the
long-running Workbench API process now reads `~/.config/fli/.env`, so the B2
key and the vendor tokens sit in its memory. Creating a Basecamp keeps them in
a separate child process. This is acceptable because that process already
holds every entry's `apiKey` and the ssh path.

## Phases

### Phase 0 — Groundwork

Goal: the vendor answers proved by hand, before any code depends on them.
Done when: each probe below has its answer written under its step.

- [x] 0.1 The owner makes a B2 key that can create buckets and keys
  (`writeBuckets`, `writeKeys`, `listBuckets`) and files it in
  `~/.config/fli/.env` under the names Q4 picks. Owner's.
  **Done 2026-11-11:** key `fli-laptop`, minted from the master key through
  `b2_create_key`, because the console's key form offers no `writeKeys`. It
  carries twelve capabilities, not three: `listBuckets`, `listAllBucketNames`,
  `readBuckets`, `writeBuckets`, `deleteBuckets`, `readBucketRetentions`,
  `writeBucketRetentions`, `listKeys`, `writeKeys`, `deleteKeys`, `listFiles`,
  `deleteFiles`. Cleanup needs the deletes, and Object Lock's default
  retention needs the retention pair. Backblaze documents that `writeKeys`
  mints keys with any capability, so this key is account-wide in effect. A
  leak means deleting `fli-laptop`, not regenerating the master.
- [x] 0.2 Probe B2's native API with that key against a throwaway bucket:
  `b2_create_bucket` with Object Lock on, `b2_create_key` limited by
  `bucketId` and `namePrefix`, then what the narrow key can do — PUT and list
  under its prefix, list another prefix, list another bucket, delete. Delete
  the bucket and key after. The S3 surface Basecamp uses has no key minting,
  so this is B2's own API.
  **Answered 2026-11-11** (API v3, buckets A and B, key on A + `ws-one/` with
  `listBuckets listFiles readFiles writeFiles deleteFiles`):
  - Allowed: create a bucket with Object Lock on (laptop key); set and clear
    a governance default retention on it (laptop key); PUT, list and delete
    under `ws-one/` in A (narrow key).
  - Refused with `401 unauthorized` to the narrow key: PUT or list under
    `ws-two/` in A; list A with no prefix; PUT or list in B; list buckets,
    with no bucket named or naming B; create a key; change A's retention.
  - Every probe bucket and key was deleted afterwards. Not yet probed: whether
    the narrow key can delete a version under retention, which no file had
    here; and whether the same narrow key works over the S3 surface
    Basecamp's backups use. Both belong in 1.x on `yuma-test`.
- [ ] 0.3 Probe whether `CLOUDFLARE_TOKEN` and `DIGITALOCEAN_TOKEN` can mint a
  narrower token through their APIs (Cloudflare: *API Tokens Edit*;
  DigitalOcean: scoped tokens). Q6 turns on the answer.
  **Answered 2026-11-11 for the tokens on this laptop: neither can mint.**
  - Cloudflare: `CLOUDFLARE_TOKEN` is active and sees 20 zones, none of them
    `maverickmade.tech`, and no accounts. Reading its own policies or the
    permission groups is refused with `9109 Unauthorized`. Minting needs a
    separate token from the dashboard's *Create additional tokens* template
    (User, *API Tokens Write*). Cloudflare documents that such a token "can
    create tokens with access to any of a user's resources" and advises
    giving it no other permission, so it is account-wide in effect, as
    `writeKeys` is on B2. Account-owned tokens need *Account API Tokens Edit*
    and a Super Administrator.
  - DigitalOcean: `/v2/tokens` and `/v2/tokens/scopes` answer `403 Forbidden`
    where an unknown path answers `404 not_found`, so the endpoints exist and
    this token's scopes do not reach them. Whether any custom scope grants
    token creation was not confirmed from DigitalOcean's docs.
  - So Q6's fallback (`FJS-D2079`) is the path today on both vendors: the
    owner makes the narrow token in the console and Workbench files it.
    Minting from Workbench would need a second account-wide token on the
    laptop beside the B2 one.
- [x] 0.4 Lift `basecamp:key`'s mint out of the command body into `cli/core`,
  so the command and the screen share one path. Note how `dev` (no Host,
  local) mints without ssh.
  - `core/basecamp-key.js` holds `replLine`, `holders`, `mint` and `keyName`.
    `basecamp:key`, `create`'s first key and `reinstall`'s reads import it.
    It spawns the child asynchronously, so Workbench's server does not freeze
    while Basecamp boots.
  - `dev` passes `{ local: true }`, which runs `fli app:repl` in
    packages/basecamp over the dev database: no ssh, no container, no running
    dev server. `fli basecamp:key --basecamp dev` mints there and files the
    entry's own origin, else `DEV_BASECAMP_ORIGIN` in `core/basecamps.js`
    (Workbench's fallback reads the same constant). Proved 2026-11-11: a key
    was minted on the dev database and its row read back through the core
    module from outside fli.
  - For 4.1: a person with seats in two workspaces (`dev@knight.works` on
    dev) can't be told apart by `--as`, so without a terminal the command
    refuses. The screen picks a holder by row (email and workspace), so
    `mint` takes the whole holder.

### Phase 1 — One-click B2 backups

Goal: one button gives a Basecamp tested off-box backups for the hub and for
its Apps.
Done when: on `yuma-test`, the button leaves a destination whose `test` passed;
the hub's next backup lands in B2; and the probe from 0.2 shows `yuma-test`'s
key cannot list another Basecamp's objects. Then the same on `chartered`,
where one App's backup (ELA's) lands under its own prefix, closes
`basecamp-safety.md` 0.9 there. `yuma-test` has no App but the hub, so the
App half is proved on `chartered` (owner, 2026-11-11).

- [x] 1.1 `cli/core` B2 helpers: create a bucket, mint a narrow key, delete a
  key. Shaped by Q2 and Q3.
  **Built 2026-11-11:** `core/b2.js` (B2's API v3: `authorize`, `findBucket`,
  `createBucket` with Object Lock and the keep-last-version lifecycle rule,
  `b2_update_bucket` for the compliance default, `createKey`, `keysNamed`,
  `deleteKey`). Proved live on `yuma-test`'s first run: both buckets made, the
  archive one locked 7 days, a key minted on its workspace prefix.
- [ ] 1.2 A fli verb first, as every Workbench verb is (Q7 names it): make the bucket and the keys, file
  each as a `BackupDestination` in its workspace, run `test`, then point the
  hub at it through `hubConfig.save` (`backupDestinationId`,
  `replicaDestinationId`, and `backupCron` when it is empty). Re-running it on
  a set-up Basecamp changes nothing.
  **Built 2026-11-11, live proof owed:** `fli basecamp:backups` over
  `core/basecamp-backups.js`, `confirm: human`. Per Q8 the replica is a second,
  unlocked bucket; its destination's prefix is `hub`, key `hub/`: `test`
  probes a hub replica at the prefix root, and Basecamp adds the
  `hub-<installId>` segment itself (`providers/storage/index.ts`). Per Q9 every
  write is a service call in the repl as an owner of the workspace written in,
  so a minted secret is on the box's process list for the seconds that call
  takes. The first live run stopped at `test`: no upload Basecamp or Outpost
  makes sends `Content-MD5`, which a locked bucket requires (`FJS-4218`, fixed
  in the tree, not yet on any box). A destination whose `test` failed is kept
  and tested again by the next run, without minting.
- [ ] 1.3 Apps: list each App with no destination and point the chosen ones at
  their workspace's destination with a nightly `backupCron`. The verb names the
  Apps it would change and changes only the ones passed.
  **Built 2026-11-11 as `--apps <slugs>`; its proof is on `chartered` (1.7).** A
  workspace gets its destination when one of its Apps is named, so naming
  none touches the hub's workspace alone.
- [ ] 1.4 The screen: a **Set up B2 backups** button per row, a confirm listing
  the bucket, the keys and the Apps it will touch, and the outcome line the
  other verbs use. The row's newest backup says whether it is on the box only
  or in B2.
  **Built 2026-11-11, both dialogs driven in Chrome against `yuma-test` up to
  Run, never past it.** `basecamps.backupsPlan` reads the plan (the B2 key from
  fli's global env, holders' emails left out), `setUpB2`/`undoB2` refuse without
  `approved: true` and keep each line the run prints on the outcome. Ticking an
  App does not re-read the plan, so its pointer shows only after the run.
- [ ] 1.5 Undo: remove the destinations and delete their keys; the bucket and its
  archives stay. Behind the same confirm.
  **Built 2026-11-11 as `--undo` and the screen's Undo B2 backups**, not yet run. Basecamp refuses to remove a
  destination archives are recorded in, so that one stays with its key and is
  named: deleting the key would leave its archives out of reach.
- [ ] 1.6 Release `FJS-4218` to `yuma-test` (`fli deploy --server yuma-test` in
  `packages/basecamp`), re-run `fli basecamp:backups yuma-test`, take a hub
  backup, and run 0.2's probe with the workspace key against the replica bucket
  and another prefix. Also answers 0.2's two leftovers: the narrow key over S3,
  and a delete under retention. Owner's go: the tree carries other sessions'
  uncommitted changes.
- [ ] 1.7 `chartered`: an Outpost release carrying `FJS-4218` first (ELA's
  archive is PUT from its machine), then `fli basecamp:backups chartered --apps
  <ela's slug>`; closes `basecamp-safety.md` 0.9. Ask before each.

### Phase 2 — An App's database to this laptop

Goal: copy any App's live database from a Basecamp to the laptop from the page.
Done when: ELA's database is copied from chartered by the page, `PRAGMA
integrity_check` answers `ok` on the copy, and nothing on the box changed
(no new App row, no new environment, no restart).

- [ ] 2.1 Each row lists its Apps (read with the entry's `apiKey`) with **Copy
  latest to this laptop**. With a destination, it fetches the newest archive
  as `fli db:download --take` does.
- [ ] 2.2 Without one, it takes an ssh snapshot: a consistent copy of the App's
  SQLite file read inside its container, streamed to the laptop. It writes
  nothing on the box. This reads production data, so the confirm names the
  App and the box.
- [ ] 2.3 Where the copy lands: the App's checkout's `db/backups/` when Workbench
  knows the checkout, else `WORKBENCH_DIR/copies/<basecamp>/<app>/`.

### Phase 3 — The encryption key copy

Goal: each row says whether the laptop holds a copy of that Basecamp's
`ENCRYPTION_KEY` that matches the box.
Done when: yuma and chartered read **key copy matches** and their
`hub.key-escrowed` control is green. That closes `basecamp-safety.md` 0.6.

- [ ] 3.1 Read the box's key digest over ssh (the digest only) and compare it
  with the copy Q5 keeps: matches, missing or differs.
- [ ] 3.2 **Keep a copy**: copy the key from the box into Q5's store over ssh,
  compare digests, then call `hubConfig.attestEscrow`.

### Phase 4 — The screen writes the index

Goal: the gaps `FJS-D1961` left to a terminal can be closed from the page.
Done when: the `dev` row gets a key from the page and **Back up now** works on
it; a run key minted from the page for `chartered` reaches `appBackups:read`;
Workbench's `basecamps.test.ts` covers each write over a temp index, and a
test asserts `list` never answers `apiKey`, `scopedKey` or `peerKeyId`.

- [ ] 4.1 **Mint key** on a row with none, through 0.4's shared path.
- [ ] 4.2 **Mint run key** (`scopedKey`) with the scopes `db:download` needs.
  This is the key that was too narrow for the ELA copy.
- [ ] 4.3 The writes Q1 allows beyond keys: add, rename and forget an entry.
  This is the form `FJS-D1961` turned down as its option B, so it reverses
  that ruling rather than extending it.

### Phase 5 — A Cloudflare token for a Basecamp's zones

Goal: a Basecamp holds a Cloudflare token for its own zones and no others.
Done when: chartered's `basecamp:reinstall --plan` passes the zone check that
blocks the restore drill (`restore-drill` memory, blocker 1).

- [ ] 5.1 Mint a token limited to the named zones (per 0.3 and Q6) and file it
  as a `providerKey` Secret, `providerKind: cloudflare`.
  - `maverickmade.tech` is not on the laptop's Cloudflare login today, so
    chartered needs that zone's account first. Owner's.
- [ ] 5.2 The row shows which zones its token opens, and **Rotate**.

### Phase 6 — ssh key in, password login off

Goal: every box takes the laptop's key and refuses passwords.
Done when: yuma's posture grades `ssh.unknown-key` and password login green,
and an ssh login with the key alone still works afterwards.

- [ ] 6.1 Install the laptop's public key into `authorized_keys` over the ssh
  that already works, and record it on `Server.sshKeyId`. Waits on
  `box-ssh-keys.md` Q1 and Q2.
- [ ] 6.2 Turn password login off only after a fresh login with
  `PasswordAuthentication=no` and `IdentitiesOnly=yes` succeeds. If it does
  not, change nothing.

### Phase 7 — Phone alerts

Goal: a Basecamp's critical alerts ring the owner's phone.
Done when: stopping a test App on `yuma-test` rings the phone.

- [ ] 7.1 Set the workspace's `pushTopic` from a topic the laptop holds, and send
  one test push. Waits on `phone-ping.md` Q1–Q4.

### Phase 8 — Machine backups at the cloud

Goal: a Basecamp can see and switch its droplet's backups.
Done when: yuma's droplet is adopted and its backup switch agrees with the
DigitalOcean console — the live proof `machine-backups.md` still owes.

- [ ] 8.1 File a DigitalOcean `providerKey` Secret (per 0.3 and Q6), then run
  `servers.adopt` and `servers.setBackups` from the row.

### Phase 9 — Versions and posture on the row

Goal: the list says what needs attention without opening each Basecamp.
Done when: a row behind on Basecamp or Outpost says so and offers the upgrade,
and each row shows its count of failing controls.

- [ ] 9.1 Each row shows its Basecamp version and each machine's
  `outpostVersion` against the newest release, with **Upgrade** over
  `fli basecamp:deploy` and the Outpost install.
- [ ] 9.2 Each row shows its failing controls from `serverPostures`, each
  linking to the Basecamp page.

## Open questions

- ~~**Q1 — How the screen writes the index (reopens `workbench-basecamps.md` Q5, `FJS-D1961`).**~~ **Answered 2026-11-11 (`FJS-D2074`): A — The page calls `core/basecamps.js` writers in-process, as backup and restart already do. Keys are minted over ssh by 0.4's shared path. There is no field to paste a key into.** The owner reopened it on 2026-11-11: the screen may write.
  - **A** — The page calls `core/basecamps.js` writers in-process, as backup and
    restart already do. Keys are minted over ssh by 0.4's shared path. There is
    no field to paste a key into.
  - **B** — A, plus a field to paste a key copied from Basecamp's API keys
    screen.
  - **C** — The page runs the fli commands as a job (`basecamp:key`), as create
    does, so it never imports a writer.
  - **Recommend A** — `core/basecamps.js` stays the one writer (`FJS-D1828`)
    and ssh stays the root (`FJS-D1827`). A pasted key would be overwritten
    by the next mint without saying so. The precedent is next door:
    `startBackup` and `startRestart` call `core` in-process for work that
    takes seconds, and only create and install spawn fli, because they take
    minutes. C would put a mint that takes seconds through a job built for
    one that takes minutes. Ruled, it supersedes `FJS-D1961` in
    `DECISIONS.md`.
- ~~**Q2 — One B2 bucket per Basecamp, or one shared bucket.**~~ **Answered 2026-11-11 (`FJS-D2075`): A — A bucket per Basecamp (`basecamp-<name>`), with Object Lock on.**
  - **A** — A bucket per Basecamp (`basecamp-<name>`), with Object Lock on.
  - **B** — One bucket for the laptop's account, a prefix per Basecamp.
  - **Recommend A** — Object Lock and lifecycle rules are set per bucket, and
    `test` reads the lock per bucket. Dropping a Basecamp's archives is
    dropping its bucket. B2 allows 100 buckets per account.
- ~~**Q3 — Which workspaces get a destination.**~~ **Answered 2026-11-11 (`FJS-D2076`): A — One destination per workspace that has an App, each with its own key limited to its own prefix in the Basecamp's bucket.** A destination belongs to one
  workspace, and an App can use only its own workspace's destination.
  - **A** — One destination per workspace that has an App, each with its own key
    limited to its own prefix in the Basecamp's bucket.
  - **B** — Only the hub's workspace. Apps in other workspaces are left alone.
  - **Recommend A** — ELA's App is in its own workspace, so B leaves out the
    App that started this. A separate key per workspace keeps one tenant's
    archives out of another's reach.
- ~~**Q4 — Where the laptop's B2 key lives.**~~ **Answered 2026-11-11 (`FJS-D2077`): A — `~/.config/fli/.env`, as `B2_KEY_ID` and `B2_APPLICATION_KEY`, beside `DIGITALOCEAN_TOKEN` and `CLOUDFLARE_TOKEN`.**
  - **A** — `~/.config/fli/.env`, as `B2_KEY_ID` and `B2_APPLICATION_KEY`,
    beside `DIGITALOCEAN_TOKEN` and `CLOUDFLARE_TOKEN`.
  - **B** — Vaultwarden, read through `core/vaultwarden.js`.
  - **Recommend A** — that is where the other vendor tokens live, and
    `vaultwarden.js` adds a login on every use.
- ~~**Q5 — Where the laptop keeps each Basecamp's `ENCRYPTION_KEY`.**~~ **Answered 2026-11-11 (`FJS-D2078`): A — `~/.config/fli/keys/<name>.key`, mode `0600`.**
  - **A** — `~/.config/fli/keys/<name>.key`, mode `0600`.
  - **B** — Vaultwarden. `core/vaultwarden.js` is read-only today, so this
    needs writing (encrypting a cipher on the client).
  - **C** — Only compare digests. The owner keeps the copy wherever they like.
  - **Recommend A** — losing the box and the laptop together is the rare case,
    and A can move to B later without changing the screen. C leaves 0.6's
    check with nothing on this laptop to compare against.
- ~~**Q6 — A vendor that cannot mint a narrow credential (per 0.3).**~~ **Answered 2026-11-11 (`FJS-D2079`): A — The owner makes a narrow one in the vendor's console, and Workbench files and tests it.**
  - **A** — The owner makes a narrow one in the vendor's console, and Workbench
    files and tests it.
  - **B** — Workbench hands the Basecamp the laptop's own token.
  - **Recommend A** — B puts an account-wide credential on a box, which is the
    exposure this plan's pattern exists to avoid.
- ~~**Q7 — The fli verb's name (1.2).**~~ **Answered 2026-11-11 (`FJS-D2080`): A, weakly.** It makes a bucket, mints keys, files
  them, runs `test` and points the hub and Apps at the result.
  - **A** — `fli basecamp:backups <name>`: the verb that sets backups up.
  - **B** — `fli basecamp:destination <name>`, after Basecamp's
    `BackupDestination`.
  - **Recommend A, weakly** — B names one of the five things the verb does.
    A sits next to `basecamp:backup` (take a hub backup and bring it here),
    and the two differ by one letter, which is A's cost.
- ~~**Q8 — The archive bucket's lock and the hub's replica (1.2).**~~ **Answered 2026-11-11 (`FJS-D2081`): B — Two buckets now: `basecamp-<name>` locked for archives, `basecamp-<name>-replica` unlocked, the hub's replica key scoped to `hub/`, so the replica lands at `hub/hub-<installId>/`.** A
  compliance-locked bucket cannot hold a replica: `test` refuses one there
  (`FJS-D1809`, `basecamp/docs/backups.md` § 1). The plan pointed
  `backupDestinationId` and `replicaDestinationId` at one destination.
  - **A** — Archives only: `basecamp-<name>` with a 7-day compliance default
    retention; the replica is a later step in a bucket of its own.
  - **B** — Two buckets now: `basecamp-<name>` locked for archives,
    `basecamp-<name>-replica` unlocked, the hub's replica key scoped to
    `hub/`, so the replica lands at `hub/hub-<installId>/`.
  - **C** — One bucket with Object Lock on and no default retention, archives
    and replica together; `hub.bucket-locked` stays red.
  - **Recommend A** — the Done-when names archives, and a replica runs only once
    the hub's box is enrolled, which is more to prove on `yuma-test`.
- ~~**Q9 — How the verb reaches a workspace its key is not bound to (1.2, 1.3).**~~ **Answered 2026-11-11 (`FJS-D2082`): A — Call Basecamp's own services through `deploy:repl` as an owner of each workspace, the way `basecamp:key` mints; `dev` runs it locally.**
  An API key works only in its own workspace (`apiKeyGuard`, `FJS-3869`), so
  the entry's `apiKey` reaches the hub's workspace alone, and ELA's App on
  chartered is in another.
  - **A** — Call Basecamp's own services through `deploy:repl` as an owner of
    each workspace, the way `basecamp:key` mints; `dev` runs it locally.
  - **B** — Mint an admin key per workspace and file each under the entry, then
    use HTTP.
  - **C** — The hub's workspace only; Apps elsewhere are named and skipped.
  - **Recommend A** — ssh is the standing (`FJS-D1827`) and nothing new is
    filed. B adds a per-workspace shape to `basecamps.json`, and C undoes Q3.

## Out of scope

- **Destroy** — still `fli server:destroy` (`FJS-D1829`).
- **Editing a Basecamp's Apps, people or servers** — those stay on Basecamp's
  own pages. A setup here hands over a credential and checks it, and Basecamp
  owns everything after that.
