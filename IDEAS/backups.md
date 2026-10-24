---
id: backups
status: proposed
dated: 2026-10-23
---

# Idea — Backups that leave the box, managed from Basecamp

**Status: PROPOSED. Phase 0 is ruled; nothing is built.** Probed against
the tree 2026-10-23. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-10-23): with Basecamp running, is there a backup of
Basecamp itself, and can Litestream for the apps' databases be managed from
Basecamp? This is the plan for `frontier-cloud.md` step 5.

## What exists (probed 2026-10-23)

- **Basecamp's own** — `backups` + `backup:run`: `VACUUM INTO` of every
  declared database, `audit/` and `jobs.db`, into `backups/` beside the live
  database. Only by hand: `HubConfig.backupEnabled`/`backupCron` are read by
  nothing. `local` only, `s3` refused by name. No prune, no restore, no
  download. Posture's `hub.backup-recent` flags two days with none.
- **An app's** — `app-backups.take` → Outpost `POST /backup` tars
  `fjs-<app>-data` into `OUTPOST_BACKUP_DIR` on that machine (`FJS-D679`,
  `FJS-D965`). By hand only. `apps.restoreVolume` extracts a file already on
  the machine (`FJS-D943`); the URL fetch (D943 A) is not built.
- **Litestream** — ring 0 only: `deploy:setup` installs the pinned build,
  `deploy:status`/`doctor` grade it, `litestone replicate` writes its config
  and `litestone restore` reads it back. Nothing on a fleet machine runs it, and
  Basecamp's own deploy config enables no replica.
- **A fleet `/deploy`** migrates the volume with no copy taken first
  (`deploy-plane.md` § the safeguard table).

## Prior art (researched 2026-10-23)

Every self-hosted platform read puts schedule, destination, retention and the
list of backups in the control plane; continuous replication, where it exists,
sits beside the app. None runs a restore drill.

- **Coolify** — the instance's own database on a cron (default `0 0 * * *`) to
  S3, and the encryption `APP_KEY` is NOT in it and must be kept apart. A failed
  upload keeps the local file and reads *Success (S3 Warning)*. Local and S3
  retention are separate (count, days, GB; default 7). Volume archives are a
  tar, live or with the container stopped, and have no restore button.
  [instance backup](https://coolify.io/docs/core/backup-and-recovery/instance-backup) ·
  [storage-mount backups](https://coolify.io/docs/core/persistent-storage/storage-mounts/backups)
- **Cloudron** — each app separately, data only, restorable, clonable and
  movable on its own. The platform's database is the index: an archive in the
  bucket it has no row for is invisible until imported. S3 lifecycle rules
  corrupt its backups, so its own retention prunes.
  [backups](https://docs.cloudron.io/backups/) · [forum](https://forum.cloudron.io/post/58444)
- **Dokku** — `postgres:backup-auth` stores a credential per service and
  `backup-schedule <cron> <bucket>` installs a cron.
  [dokku-postgres](https://github.com/dokku/dokku-postgres)
- **PocketBase** — cron, a keep-count and an S3 toggle in its admin; restore
  replaces the database and restarts, so take a fresh backup first.
  [PocketHost](https://pockethost.io/docs/backup-restore)
- **Kamal / Railway** — Litestream as an accessory or sidecar beside the app,
  restore on start optional. [kamal-backup](https://rubydoc.info/gems/kamal-backup) ·
  [Railway template](https://railway.com/deploy/pocketbase-custom-s3-backups)
- **Litestream 0.5** — one replica per database; a `dir` + `pattern` +
  `watch: true` entry starts a new database within seconds; Prometheus metrics
  on `addr`; credentials per replica; it writes beside the database
  (`.<db>-litestream`), so the directory must be writable. Restore is per
  database, by URL with `-o`, and there is no restore-all. Nothing documented
  reloads the config live, so a change is a restart.
  [v0.5.0](https://fly.io/blog/litestream-v050-is-here/) ·
  [directory watcher](https://litestream.io/guides/directory-watcher/) ·
  [config](https://litestream.io/reference/config/)

## The target

Every database Basecamp knows of — its own and every placed app's — has a
scheduled snapshot in a bucket and, where it is SQLite, a Litestream replica
seconds behind, both visible per App in Basecamp. An app restores from the
Basecamp screen and a drill proves it on a schedule. Basecamp restores itself
from a terminal, because the process serving the button cannot replace its own
database.

## Plan

### Phase 0 — Rule the shape

Goal: no step after this waits on a question.
Done when: Q1–Q6 are rulings in `DECISIONS.md`, and `conduit-s3` has run
against one real vendor.

- [x] 0.1 Q1: how a fleet machine reaches the bucket — [`FJS-D1485`](../DECISIONS.md#fjs-d1485) **A**: pre-signed per snapshot transfer, a scoped standing key only for Litestream
- [x] 0.2 Q2: where Litestream runs for a fleet app — [`FJS-D1486`](../DECISIONS.md#fjs-d1486) **A**: one host unit per machine, run by Outpost, a key per app
- [x] 0.3 Q3: snapshots or Litestream first — [`FJS-D1487`](../DECISIONS.md#fjs-d1487) **A**: snapshots first
- [x] 0.4 Q4: the storage-destination noun's name — [`FJS-D1488`](../DECISIONS.md#fjs-d1488) **A**: `BackupDestination`, a model replacing the enum
- [x] 0.5 Q5: how basecamp obtains `conduit-s3` — [`FJS-D1490`](../DECISIONS.md#fjs-d1490) **C**: basecamp's own lift over `@frontierjs/toolbelt/sigv4`, the compute-provider pattern
- [x] 0.6 Q6: who owns a `BackupDestination` — [`FJS-D1491`](../DECISIONS.md#fjs-d1491) **B**: workspace-owned; `HubConfig.backupDestinationId` points at one, `SetNull`
- [x] 0.7 Backblaze B2 is `conduit-s3`'s first live vendor (sibling repo). The
      drive already takes a fixture: `FIXTURE_URL=https://s3.<region>.backblazeb2.com
      FIXTURE_REGION=<region> FIXTURE_CREDENTIAL=<keyID>:<applicationKey>
      FIXTURE_BUCKET=<bucket> bun run drive`, against a private bucket and an
      application key restricted to it. A row that passes the sink and fails B2
      is recorded per row in its `PROJECT_STATE.md` — the ones to watch are
      `if-none-match: *` on PUT, the presigned PUT, and whether a bucket-scoped
      key needs `listBuckets`. The 10 GB free tier makes this the standing
      fixture for every later drive, so no docker is waited on.
  - Ran 2026-10-23: 20 rows green, `s3.us-west-000.backblazeb2.com`, bucket
    `frontier-basecamp`, key restricted to the bucket and to the name prefix
    `basecamp-` — which needed a `FIXTURE_PREFIX` knob, since every drive key
    was `drive/…`. One vendor difference: an expired presigned URL is 401 on
    B2, 403 on AWS; the row asserts the refusal, not the number. The old row
    sent a negative expiry, a 400 everywhere, and the sink now says so too.
    Conditional PUT (`if-none-match: *`) is in no row, so still unproved. The
    destination's `prefix` in 1.1 must equal the key's name prefix.

**Done 2026-10-23.** Six rulings (`FJS-D1485`–`D1488`, `D1490`, `D1491`) and
one live vendor. Two things the paper had wrong surfaced on the way: the
sibling connector cannot be linked into the image build, so basecamp lifts
it; and a `Secret` needs a workspace, so the destination has one.

### Phase 1 — Snapshots leave the box

Goal: losing a machine, Basecamp's included, loses no backup.
Done when: a scheduled Basecamp backup and a scheduled app backup each land in
a bucket, retention prunes the oldest, and a failed upload keeps the local file
with a warning — against `conduit-s3`'s sink in `verify:outpost` and
`verify:screens`, and once by hand against a Backblaze B2 bucket following
`packages/basecamp/docs/BACKUPS.md`, with the result in `PROJECT_STATE.md`.

- [x] 1.1 `BackupDestination` (`FJS-D1488`, workspace-owned per `FJS-D1491`) becomes a model:
      `name`, `endpoint` (no bucket in it), `bucket`, `prefix`, `region`,
      `secretId @system` lifted from a `@transient secret` as `channels.service.ts`
      does, `lastTestAt @system`. The credential is one string,
      `<accessKeyId>:<secretAccessKey>` — for B2 the application key's keyID and
      applicationKey, never the master key — because that is what `conduit-s3`'s
      `splitCredential` reads. The enum goes; `Backup.destinationId` and
      `HubConfig.backupDestinationId` are relations, null meaning local; `s3`
      stops being refused and the stale `FJS-153` cite goes with it. Creating or
      patching a row registers its conduit target, `storage:s3:<destinationId>`,
      through `providers/storage/s3.ts` (`FJS-D1490`); `bun run db:types`, a seed row, a
      `BackupDestination.mesa` resource and its form on the hub screen, a
      `VOCABULARY.md` row.
  - Built 2026-10-23: model, `backup-destinations` service (find/get/create/
    patch/remove/restore), `providers/storage/{s3,index}.ts`, boot plugin
    `basecamp-backup-destinations`, seed row, resource, picker + inline form
    on `/hub/settings/`, five tests. Four calls made on the way, none a
    ruling: `SecretKind.backup` is a new enum value (the consumer's noun,
    like `notification`); `Backup.destination` is `onDelete: Restrict` and,
    since the model is `@@softDelete`, `remove` answers 409 while an archive
    names the row — the FK blocks the hard path, the service the soft one; the hub picker lists
    the CURRENT workspace's destinations and shows a foreign id as such; and
    `backups.create` writes the row at system, because a tenant-less `Backup`
    naming a tenant-owned parent fails litestone's hidden-parent check in
    caller context. Found beside it: `channels.patch`'s credential rotation
    never carried `Secret.version`, so every rotation was a 400 — fixed with
    the same shape here. `test` is 1.8; the dev `basecamp.db` predates the
    table and needs `bun run db:reset` (the owner's call) before `fli dev`.
- [x] 1.2 `backup:run` uploads Basecamp's archive. The archive is a directory,
      so the job tars it first (`tar -czf`, the same tool Outpost's `/backup`
      spawns; confirm the API image carries `tar`) and sends ONE `putObject` to
      `<prefix>/basecamp-<stamp>.tar.gz`, which becomes `location`. The
      connector has no multipart and the body is held in memory, so an archive
      larger than RAM or 5 GB (B2's single-PUT cap) is a later step, not a
      silent failure — the job refuses above a stated size. A failed upload
      keeps the local copy, finishes `success` and records the warning in
      `error`, Coolify's *Success (S3 Warning)*.
  - Built 2026-10-23 in `jobs/backup-run.job.ts`: the image's `tar` is GNU
    1.35 (`oven/bun:1.4.4-slim`); `MAX_UPLOAD_BYTES` is 1 GiB, under B2's
    5 GB because the body is one buffer in the API process. Owner, asked
    2026-10-23: the newest archive always stays on disk and the next backup
    replaces it — an uploaded archive's local directory (named by its key,
    `backups/<name>` ↔ `<prefix>/<name>.tar.gz`) goes when a later backup
    finishes; a failed upload's or a local-only one's never does here. The
    tarball is a transfer copy, removed either way. Three rows in
    `backup-run.test.ts` against a `Bun.serve` stand-in through the app's own
    conduit and signer (a signed PUT; the next one replaces the warm copy; a
    403 `AccessDenied` kept local and kept after). The size refusal has no
    row.
- [x] 1.3 `HubConfig.backupCron` is registered in `job-schedule.ts`, the one
      clock, and `BackupKind.scheduled` is what it writes.
  - Built 2026-10-23: `syncBackupSchedule` puts the cron on the clock as
    `hub:backup` while `backupEnabled`, and `hub-config.save` calls it after
    every write; `restoreSchedules` restores it at boot. `save` refuses an
    expression `@frontierjs/toolbelt/cron` cannot parse BEFORE the write, so a
    stored schedule always registers. A fire (`fireBackup`) reads the
    destination from the row at fire time and goes through `queueBackup` in
    `backup-run.job.ts` — now the one door `backups.create` uses too — so a
    fire beside an archive in flight is skipped with a warning, not queued.
    The "nothing registers it yet" copy is gone from both screens and
    `SCREENS.md`. Two rows in `services.test.ts` (on/off/boot restore; a fire
    writes `scheduled` with `requestedBy` null and skips beside one in
    flight). `verify:screens` backups section green; the run stops later at
    the DNS path-route check, which touches nothing here.
- [x] 1.4 Retention: a keep-count and an age, local and remote apart — local
      being a row with no destination or a failed upload; the newest uploaded
      archive's warm copy is 1.2's and not counted. Basecamp
      prunes; the rows are the index, and a rescan lists the prefix so an
      archive with no row is found rather than invisible (Cloudron's gap).
  - Built 2026-10-23. `listObjects` (ListObjectsV2, a continuation token,
    keys unescaped, UTF-8 byte order) landed in the sibling's `conduit-s3`
    with a sink row, green on the B2 fixture too, and is lifted byte for byte
    into `providers/storage/s3.ts`. `HubConfig` carries
    `backupKeep{Local,Remote}{Count,Days}` (count 7, no age by default) and
    the settings screen four fields. `jobs/backup-archives.ts` owns the
    archive once it exists: `pruneBackups` runs after each success, groups
    `local` and `remote:<destination>`, and never takes the newest;
    `deleteArchive` is the one delete — retention's and `backups.remove`'s
    (`FJS-D1494`) — and derives `backups/<name>` from an archive name, never
    the stored path; a remote one goes object first, then row.
    `backups.rescan` (sysadmin) writes `BackupKind.found` rows (`FJS-D1493`)
    for `<prefix>/basecamp-<stamp>.tar.gz` keys no row names; the backups
    screen has a Rescan button and Delete in place of Forget. Four rows in
    `backup-run.test.ts` (count, age, remote delete, rescan), two in
    `services.test.ts` (remove, rescan's gate). `verify:screens`' Delete and
    keep-count checks pass — proved on a copy without the DNS block, since the
    real run still stops there (`FJS-3477`).
  - A B2 bucket keeps every version by default, so a DELETE hides an object
    and the bytes stay billed. The recipe in 1.9 sets the bucket's lifecycle to
    *keep only the last version*, which makes Basecamp's prune final; no
    lifecycle rule of the bucket's own expires an archive Basecamp still lists.
- [x] 1.5 Outpost `/backup` uploads to a pre-signed PUT Basecamp mints per
      archive — the upload step `FJS-D679` left for `s3`. The machine holds no
      standing key for it. The signer is `@frontierjs/toolbelt/sigv4`
      (`FJS-D892`), the one SigV4; litestone's `storage/providers/s3.js` is a
      caller of it, as basecamp is (Invariant 4).
  - Built 2026-10-23. `AppBackupTake.destinationId?` names a destination of
    the app's OWN workspace (a caller-scope read, so another workspace's is
    404 before any machine is asked); absent, the archive stays local. No
    default — `decision-rules` graded the hub's bucket as a default the one
    option that crosses `@@tenant(none)` into a tenant row, and the sibling
    `backups.create` already takes `destinationId?` with none. Reopen as an
    `App.backupDestinationId` column when 1.6's schedule needs a stored one;
    the input stays the override. `take` reads the credential once through
    `createSecretResolver`, mints a three-hour PUT for
    `<prefix>/<appId>-<stamp>.tar.gz` (`providers/storage/s3.ts` `presign`),
    and sends `upload_url` on the wire. Outpost `/backup` streams the finished
    archive to it from its own process (`Bun.file`, so nothing is read into
    memory; the capture container keeps `--network none`), and ANSWERS
    `uploaded` and `upload_error` in the bucket's `Code: Message` — never a
    throw, since the archive exists. `AppBackup.destinationId` is `Restrict`
    like `Backup`'s; a landed upload makes the key `location`, a refused one
    keeps the path with the warning in `error` and `status: success`, as
    `backup:run` does. `backup-destinations` counts both kinds of row for
    `backup_count` and the 409 on `remove`. The local archive stays on the
    machine either way; retention for a machine's directory is not in this
    plan. Four Outpost rows, three `services.test.ts` rows; `verify:docker`
    and `verify:outpost` not run (Docker). Not proved against B2.
- [x] 1.6 A schedule per App, and a snapshot before every fleet `/deploy`.
  - Built 2026-10-23. `App.backupCron` (null is none, as `Job.cronExpression`
    reads; `cronProblem` refuses a bad expression BEFORE the write) and
    `App.backupDestinationId` (`SetNull`, own workspace only — the stored
    pointer 1.5 said to reopen; `AppBackupTake.destinationId` stays the
    override for a person). `syncAppBackupSchedule` puts `app:backup:<id>` on
    the one clock from `create`, `patch`, `remove` and `restore`, and
    `restoreSchedules` re-registers every row at boot; the fire is the
    `app-backup:run` job. `jobs/app-backup-run.job.ts` is the ONE `/backup`
    caller (Invariant 4) — the person's `take`, the schedule and a release's
    `Back up volume` step all take through `takeAppBackup`, which refuses an
    in-flight archive of that app on that machine with a 409 before writing a
    row. `AppBackup.kind` reuses `BackupKind` + `release`, and `deploymentId`
    names the release (`FJS-D1495`). The step is built off the release's
    `configSnapshot.runtime.volumePath`, sits before `Start container`, is
    fatal with no opt-out, and no-ops on a first release (`FJS-D1496`); a stub
    executor passes it saying no backup was taken. No custom UI: the
    schema-driven App form carries both columns. A machine's directory still
    has no retention. One `services.test.ts` row (on the clock, restored,
    off on null and on remove, back on restore), one `inline-app.test.ts` row
    (the step list, create and rollback), `kind` on the manual row, the rival
    destination refused on the app too. `verify:docker` and `verify:outpost`
    not run (Docker). Not proved against B2.
- [x] 1.7 `ENCRYPTION_KEY` escrow: a posture control and a line on the backups
      screen that an archive without its key cannot be read. The key never
      travels with the archive.
  - Built 2026-10-23, ruled `FJS-D1497`. Nothing here can see the copy
    `fli deploy:setup` leaves in the operator's `.env`, so a person attests it:
    `hub-config.attestEscrow` stamps `HubConfig.encryptionKeyEscrowedAt` and
    `encryptionKeyFingerprint` (sha256 of the key in use, from
    `core/db.ts`), both `@system`. `hub.key-escrowed` (high, in process like
    `hub.backup-recent`) fails while none is stamped, while the stamped digest
    is not the live key's, and on the development placeholder, which cannot
    be attested. `/hub/backups/` has an *Encryption key* card reading that
    control — the one grader — with the attest button behind a confirm.
    Found: `/hub/settings/` echoed the whole row on save, a 403 once a
    `@system` column existed; it sends only what changed now. Rows in
    `posture.test.ts`, `services.test.ts`, two `verify:screens` checks on a
    minted key.
- [x] 1.8 `backup-destinations.test`: PUT then DELETE a probe key under the
      prefix, write `lastTestAt`, answer the connector's failure kind
      (`forbidden`, `clock_skew`, `refused`) in the form — so a wrong key fails
      where a person is looking and not at 02:00. A `verify:screens` row against
      the sink.
  - Built 2026-10-23: `test` is `gate: ADMINISTRATOR` like `channels.test`,
    sends through the registered target (`sendFor`), probe key
    `<prefix>/basecamp-probe-<stamp>-<rand>`, both verbs on purpose — a
    write-only key passes a PUT and fails at the first prune. The stamp is
    written only when both answered; a passing test also sets the Secret's
    `isVerified`, which a rotation cleared — and it is the ONE writer of
    `true` for a `backup` Secret: `secrets.verify` refuses that kind by name,
    where it would otherwise have asserted it untested. The refusal is the kind first
    (`forbidden: the probe write failed — the bucket's policy refuses this key
    (AccessDenied) — …`), `explainFailure` in the service. The hub screen runs
    it right after Add and has a *Test bucket* button beside the picker; the
    answer is `#destination-test` under it. `conduit-s3`'s `sink.ts` is lifted
    as `providers/storage/s3-sink.ts` (8125 dev / 7125 test, the same way as
    `cloudflare-sink.ts`) — a SigV4 verifier, so `verify:screens` adds a good
    bucket and a `private/` one and reads *written and deleted* then
    `forbidden … AccessDenied`. Five API tests, one gate-table row.
- [x] 1.9 `packages/basecamp/docs/BACKUPS.md`, the operator's recipe, B2 first:
      a private bucket; an application key restricted to that bucket with read,
      write, list and delete; the region read off the endpoint
      (`s3.us-west-004.backblazeb2.com` → `us-west-004`); lifecycle *keep only
      the last version*; the credential pasted as `keyID:applicationKey`; what
      `location` means per destination; restore by hand — `getObject`, untar,
      `litestone restore`. The free tier (10 GB stored, egress free to three
      times that) is stated with its source, since a daily hub archive is
      megabytes and the whole plan costs nothing until it does not.

### Phase 2 — Litestream on every fleet machine, run by Outpost

Goal: an app's SQLite is seconds behind in a bucket, and Basecamp shows how far.
Done when: an app placed on a stand-in Outpost replicates to MinIO, its lag is on
the App screen, and stopping Litestream turns a posture control red.

- [ ] 2.1 Outpost's install script installs the pinned Litestream
      (`LITESTREAM_PIN`) as its own systemd unit, outside Outpost's sandbox.
- [ ] 2.2 Outpost `POST /replicate { app_id, url, interval, retention }`
      writes the app's entry — `dir:` the volume's mountpoint, `pattern: "*.db"`,
      `watch: true`, the app's own key, `meta-dir` OUTSIDE the volume so the
      `/backup` tar does not carry `.<db>-litestream` — and restarts the unit.
      The whole file is rewritten from Basecamp's list, never patched: Basecamp
      is the origin, the file a projection.
  - How far a key can be scoped is the provider's (from memory: AWS IAM by
    prefix, R2 and Spaces by bucket, Hetzner unverified) — check before 2.2,
    and Q4's noun carries the scope.
- [ ] 2.3 The heartbeat reads Litestream's metrics (`addr`); Basecamp shows
      last sync and lag per App, and posture grades it.
- [ ] 2.4 Basecamp's own box enrolls its database the same way, through its own
      Outpost.

### Phase 3 — Restore and drill from Basecamp

Goal: frontier-cloud step 5's exit — restore an app from the screen, the drill
result beside it.
Done when: a drill restores an app into a scratch volume and passes
`integrity_check` and `litestone restore --verify`, and a real restore brings a
stopped app back to a chosen timestamp, both through Basecamp on a stand-in.

- [ ] 3.1 Outpost `/replica/restore`: refused while a container holds the
      volume (`FJS-D943`); `litestream restore -o` per database, optional
      timestamp.
- [ ] 3.2 A snapshot restores from the bucket: D943 A's fetch, with a pre-signed GET.
- [ ] 3.3 The drill: on a schedule, restore into a scratch volume, verify, record
      the result per App.
- [ ] 3.4 Basecamp's own restore is a runbook (`litestone restore`) in
      `packages/basecamp/docs/`, never a button.

## After this (not in this plan)

Litestream copies `.db` files only; a logger directory is covered by the
snapshot alone (`FJS-1509`'s gap). Litestream's VFS read replicas, when they
ship, could serve the drill without a restore.

## Open questions

- ~~**Q1 — How a fleet machine reaches the bucket.**~~ **Answered 2026-10-23 (`FJS-D1485`): A — Snapshots through a pre-signed PUT/GET Basecamp mints per transfer, so no key stays on the machine; Litestream through a standing key scoped to its own bucket or prefix, the one thing that cannot run on a pre-signed URL.** By analogy with
  `fleet-ingress.md` D6, which refused a standing DNS token on every machine.
  - **A** — Snapshots through a pre-signed PUT/GET Basecamp mints per transfer,
    so no key stays on the machine; Litestream through a standing key scoped to
    its own bucket or prefix, the one thing that cannot run on a pre-signed URL.
  - **B** — One standing scoped key per machine for both.
  - **C** — Basecamp carries the bytes: no key on any machine, but the archive
    crosses the command port (`FJS-D679` refused it) and there is no Litestream
    on a fleet machine.
  - **Recommend A.** It holds D6 for everything but the one consumer that needs
    a key, and a stolen machine reaches only its own replicas. Confidence 2.
- ~~**Q2 — Where Litestream runs for a fleet app.**~~ **Answered 2026-10-23 (`FJS-D1486`): A — One systemd unit per machine, run by Outpost; each app an entry with its own key, scoped to a bucket or a prefix as the provider allows, so an app is revoked or moved alone.**
  - **A** — One systemd unit per machine, run by Outpost; each app an entry with
    its own key, scoped to a bucket or a prefix as the provider allows, so an
    app is revoked or moved alone.
  - **B** — One unit per machine and one key per machine.
  - **C** — A sidecar container per app.
  - **D** — No Litestream on the fleet; snapshots only.
  - **Recommend A.** One process however many client apps a machine holds,
    `deploy-plane.md`'s "on the host", and the same path for Basecamp's own box.
    Per-app keys buy revocation and moves, not isolation: root on a shared box
    reads every volume already, so a client that needs a hard boundary gets its
    own machine. Confidence 2.
- ~~**Q3 — Which first.**~~ **Answered 2026-10-23 (`FJS-D1487`): A — Snapshots off the box first: it reuses `backup:run` and `/backup`, covers non-`.db` files and Basecamp itself, and brings the schedule and the pre-deploy copy.**
  - **A** — Snapshots off the box first: it reuses `backup:run` and `/backup`,
    covers non-`.db` files and Basecamp itself, and brings the schedule and the
    pre-deploy copy.
  - **B** — Litestream first: seconds of loss sooner, the rest uncovered longer.
  - **Recommend A.** The machine-loss gap is total today and A closes it with
    code that exists. Confidence 3.
- ~~**Q4 — The storage destination's noun.**~~ **Answered 2026-10-23 (`FJS-D1488`): A — `BackupDestination`, a model. The enum goes; both columns become relations, a null one meaning local. The credential follows `NotificationChannel`: a bare `secretId`, a `@transient` plaintext the service lifts into a `Secret` row. A Litestream replica is a continuous backup, so it is the same noun.** The record holding endpoint, bucket,
  prefix, region and a `secretId`. The schema has `BackupDestination` as an enum
  of `local`/`s3`, and `Backup.destination` / `HubConfig.backupDestination`
  already use the word.
  - **A** — `BackupDestination`, a model. The enum goes; both columns become
    relations, a null one meaning local. The credential follows
    `NotificationChannel`: a bare `secretId`, a `@transient` plaintext the
    service lifts into a `Secret` row. A Litestream replica is a continuous
    backup, so it is the same noun.
  - **B** — `Destination`, unprefixed. Too loose where deploys and notifications
    also have destinations.
  - **C** — Another word: `StorageTarget` (`Target` is Conduit's, `FJS-D681`),
    `Bucket` (`bucket.bucket`, and rows sharing a bucket differ by prefix),
    `Repository` (collides with `RegistryImage.repository`).
  - **Recommend A.** The fields already say it, `NotificationChannel` is the
    sibling shape, and the precedent agrees: Dokploy's *Destinations*
    ([docs](https://docs.dokploy.com/docs/core/cloud-storage)), Velero's
    `BackupStorageLocation`
    ([docs](https://velero.io/docs/v1.17/api-types/backupstoragelocation)); Coolify's
    *S3 Storage* names the protocol. Reopen as `Destination` if a non-backup
    consumer (`@file` storage) ever wants the same place. Confidence 2.

- ~~**Q5 — How basecamp obtains `conduit-s3`.**~~ **Answered 2026-10-23 (`FJS-D1490`): C — Basecamp's own `providers/storage/s3.ts`, a LIFT of the connector's `signer.ts` and `index.ts` (target builder, put/get/head/delete/list, presign) importing `@frontierjs/toolbelt/sigv4`, the compute pattern. When D1185 flips the swap is an import line.** `FJS-D1185` keeps every
  connector in the sibling workspace, and its body rules a `link:` out: the
  image build packs workspace dependencies only. Basecamp's compute providers
  are its own copies of `conduit-digitalocean` and `conduit-hetzner` for that
  reason.
  - **A** — Publish `@frontierjs/conduit-s3` to npm and depend on it. One
    `bun add`; the first connector shipped from the sibling, at 0.0.1 with one
    live vendor behind it, and a loose peer range silenced by the publish.
  - **B** — Promote `conduit-s3` into `packages/`. It owns a protocol, not a
    vendor (`FJS-D889`), and SigV4 already lives in toolbelt — but it reverses
    D1185 for one package while the owner is not ready to commit the rest.
  - **C** — Basecamp's own `providers/storage/s3.ts`, a LIFT of the connector's
    `signer.ts` and `index.ts` (target builder, put/get/head/delete/list,
    presign) importing `@frontierjs/toolbelt/sigv4`, the compute pattern. When
    D1185 flips the swap is an import line.
  - **Recommend C.** It is the sanctioned copy — `FJS-D1253`'s condition names
    basecamp's `providers/` as a connector's one permitted twin — and a reader
    finds the same shape beside it. No SigV4 is copied, so Invariant 4 holds;
    what is copied is dialect. Reopen as B when the connectors workspace is
    committed. Confidence 2.
- ~~**Q6 — Who owns a `BackupDestination`.**~~ **Answered 2026-10-23 (`FJS-D1491`): B — `BackupDestination` is workspace-owned like `NotificationChannel`, and `HubConfig.backupDestinationId` points at one across the tier, `onDelete: SetNull`. Deleting that workspace drops the hub to `local`, so posture (1.7) grades *hub destination is local* red. Dokploy's destinations are per organization with the server's own backup picking one; Coolify's S3 storages are per team.** `FJS-D1488` lifts the credential
  into a `Secret` row as `NotificationChannel` does, and `Secret.workspaceId`
  is required with `@@unique([workspaceId, name])` on it. `Backup` and
  `HubConfig` are `@@tenant(none)`; nothing in the schema says the destination
  must be.
  - **A** — `Secret.workspaceId` becomes nullable, null meaning the
    installation. One column with two meanings, the unique index stops holding
    under NULL, and `verifyTenantIsolation()` learns an exception.
  - **B** — `BackupDestination` is workspace-owned like `NotificationChannel`,
    and `HubConfig.backupDestinationId` points at one across the tier,
    `onDelete: SetNull`. Deleting that workspace drops the hub to `local`, so
    posture (1.7) grades *hub destination is local* red. Dokploy's destinations
    are per organization with the server's own backup picking one; Coolify's
    S3 storages are per team.
  - **C** — The credential is an `@encrypted` column on the destination row, no
    `Secret`. A second owner of credential material, the move `HubConfig`'s own
    comment refused.
  - **Recommend B.** It is `FJS-1020`'s precedent — a vendor key lives in a
    workspace — with zero existing callers moved, and per-App schedules (1.6)
    land under it without a second shape. Amends D1488 in its tenancy line
    only; the noun, the enum's removal and the `@transient` lift stand.
    Confidence 2.

## See also

`frontier-cloud.md` step 5 · `deploy-plane.md` (the safeguard table) ·
`packages/basecamp/api/src/jobs/backup-run.job.ts` · `packages/outpost/src/docker.js` § backup ·
`packages/litestone/docs/replication.md`
