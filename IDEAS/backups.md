---
id: backups
status: proposed
dated: 2026-10-23
---

# Idea — Backups that leave the box, managed from Basecamp

**Status: PROPOSED. Phases 0–3 are built but 3.4; Phase 4 was added
2026-10-27 and nothing of it is built.** Probed against the tree 2026-10-23. Do not cite this file as behavior — see `VERIFYING.md`.

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
  on `addr`, which count local WAL syncs and cannot measure bucket lag (2.3);
  credentials per replica; it writes beside the database
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
  - Ran 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).

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
  - Built 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 1.2 `backup:run` uploads Basecamp's archive. The archive is a directory,
      so the job tars it first (`tar -czf`, the same tool Outpost's `/backup`
      spawns; confirm the API image carries `tar`) and sends ONE `putObject` to
      `<prefix>/basecamp-<stamp>.tar.gz`, which becomes `location`. The
      connector has no multipart and the body is held in memory, so an archive
      larger than RAM or 5 GB (B2's single-PUT cap) is a later step, not a
      silent failure — the job refuses above a stated size. A failed upload
      keeps the local copy, finishes `success` and records the warning in
      `error`, Coolify's *Success (S3 Warning)*.
  - Built 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 1.3 `HubConfig.backupCron` is registered in `job-schedule.ts`, the one
      clock, and `BackupKind.scheduled` is what it writes.
  - Built 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 1.4 Retention: a keep-count and an age, local and remote apart — local
      being a row with no destination or a failed upload; the newest uploaded
      archive's warm copy is 1.2's and not counted. Basecamp
      prunes; the rows are the index, and a rescan lists the prefix so an
      archive with no row is found rather than invisible (Cloudron's gap).
  - Built 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 1.5 Outpost `/backup` uploads to a pre-signed PUT Basecamp mints per
      archive — the upload step `FJS-D679` left for `s3`. The machine holds no
      standing key for it. The signer is `@frontierjs/toolbelt/sigv4`
      (`FJS-D892`), the one SigV4; litestone's `storage/providers/s3.js` is a
      caller of it, as basecamp is (Invariant 4).
  - Built 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 1.6 A schedule per App, and a snapshot before every fleet `/deploy`.
  - Built 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 1.7 `ENCRYPTION_KEY` escrow: a posture control and a line on the backups
      screen that an archive without its key cannot be read. The key never
      travels with the archive.
  - Built 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 1.8 `backup-destinations.test`: PUT then DELETE a probe key under the
      prefix, write `lastTestAt`, answer the connector's failure kind
      (`forbidden`, `clock_skew`, `refused`) in the form — so a wrong key fails
      where a person is looking and not at 02:00. A `verify:screens` row against
      the sink.
  - Built 2026-10-23; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
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
Done when: an app placed on a stand-in Outpost replicates to a stand-in bucket
(SeaweedFS, the pin `verify:replicate` uses — MinIO's free edition is archived),
its lag is on the App screen, and stopping Litestream turns a posture control red.

- [x] 2.1 Outpost's install script installs the pinned Litestream
      (`LITESTREAM_PIN`) as its own systemd unit, outside Outpost's sandbox.
  - Built 2026-10-24; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 2.2 Outpost `POST /replicate { replicas: [{ app_id, bucket, path,
      endpoint, region, access_key_id, secret_access_key }] }` writes every
      app's entry — `dir:` the volume's mountpoint, `pattern: "*.db"`,
      `watch: true`, the app's own key, `meta-dir` OUTSIDE the volume so the
      `/backup` tar does not carry `.<db>-litestream` — and restarts the unit.
      The whole file is rewritten from Basecamp's list, never patched: Basecamp
      is the origin, the file a projection.
  - Built 2026-10-24; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 2.3 The heartbeat reads Litestream's control socket (`/list`); Basecamp
      shows last sync and lag per App, and posture grades it.
  - Built 2026-10-24; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 2.4 Basecamp's own box enrolls its database the same way, through its own
      Outpost.
  - Built 2026-10-24; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).

### Phase 3 — Restore and drill from Basecamp

Goal: frontier-cloud step 5's exit — restore an app from the screen, the drill
result beside it.
Done when: a drill restores an app into a scratch volume and passes
`integrity_check` and `litestone restore --verify`, and a real restore brings a
stopped app back to a chosen timestamp, both through Basecamp on a stand-in.

- [x] 3.1 Outpost `/replica/restore`: refused while a container holds the
      volume (`FJS-D943`); `litestream restore -o` per database, optional
      timestamp.
  - Built 2026-10-25; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
  - Open: `replicaOf` reads a soft-deleted destination as none, so an app whose
    destination was removed cannot be restored from what is still in the
    bucket, which is when a restore is most wanted. The `*.db` name test is
    written twice, `replicaDatabases` and Outpost's `DB_NAME`.
- [x] 3.2 A snapshot restores from the bucket: D943 A's fetch, with a pre-signed GET.
  - Built 2026-10-25; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [x] 3.3 The drill: on a schedule, restore into a scratch volume, verify, record
      the result per App.
  - Built 2026-10-25; the record moved to [`docs/plan-done.md`](../docs/plan-done.md#ideasbackupsmd).
- [ ] 3.4 Basecamp's own restore is a runbook (`litestone restore`) in
      `packages/basecamp/docs/`, never a button.
      Amended 2026-10-27 by Phase 4: the runbook stays and is rewritten in
      4.6; `/setup` gets a stage-then-restart restore (4.4), which keeps the
      reason behind "never a button" — the serving process replaces nothing.

### Phase 4 — The hub comes back from a file

Goal: a fresh box with Basecamp installed and the old `ENCRYPTION_KEY` becomes
the old hub again from one downloaded archive or straight from the bucket,
through `/setup`, and every App with a replica is then offered its restore.
Done when: on a scratch box with no account, `/setup` lists the hub's newest
archive from its destination and takes an uploaded one, restores it across a
restart, and the apps screen names each App with a replica as *found, restore?*;
the drive is `verify:hub-restore`, a new `DRIVES.md` row.

**The ask** (owner, 2026-10-27): "a master settings backup that downloads the
whole config, so you import it and reinstall everything from a file; an app
whose Litestream replica is in S3 is detected and you are asked to restore."
The nine were run on a config-only export (Q8): the archive already IS that
file, every row under the one key, so what is missing is the download, the
import at `/setup` and the found-replica prompt. A restore cannot be performed
by the process it replaces (§ The target), so the button STAGES and the next
boot restores.

- [x] 4.1 `plan-size`: this file is 48 KB against the 32 KB cap (`FJS-1562`).
      Phases 1–3's found-records move verbatim to
      `docs/plan-done.md` with a one-line stub under each step.
  - Done 2026-10-27: 54 KB to 24 KB. Sixteen step records (0.7–3.3) and Q1–Q7's
    bodies moved; each question keeps its answered line here. The root
    `docs/plan-done.md`, not basecamp's, because that is where
    `server-posture.md`'s went. 3.1's *Open* bullet stays: it is unfiled work.
- [x] 4.2 Download. `backups.download` (gate 7): a local archive streams from the
      path, a remote one answers a pre-signed GET minted by `mintDownload`
      (3.2's). A *Download* button on `/hub/backups/`; the "no download"
      sentences in that screen's comment and `BACKUPS.md` § 5 go.
  - Done 2026-10-27. `backups.download` answers `{ url, name }`; either URL
    yields `basecamp-<stamp>.tar.gz`. A browser download is a navigation, and
    a navigation carries no bearer (the cookie is on only with a sign-in
    provider), so the local URL carries its own credential:
    `/backup-archive/{id}?expires=&sig=`, HMAC'd with a per-process key and
    good for five minutes. `plugins/backup-archive.ts` streams `tar -cz` of
    the directory; `/backup-archive/` joined `NAVIGATED_API_PATHS`.
    Proved by `services.test.ts`, `verify:screens` (Chrome saves the file and
    `tar -tzf` lists its `.db` files) and `verify:caddy`. `verify:build` was not
    run: it insists on 8120, which a dev server held. `verify:sso` fails one
    check whether or not this change is applied (`FJS-3562`).
- [x] 4.3 A `manifest.json` in the archive directory, written by `backup:run`:
      basecamp version, `encryptionKeyFingerprint`, every other file with its
      bytes and sha256. `litestone restore --from-backup` ignores it; `/setup`
      reads it to refuse a wrong-key, damaged or wrong-schema archive BEFORE a
      file is replaced.
  - Done 2026-10-27. `domain/backup/archive-manifest.ts`: `writeManifest`
    (last thing `archiveAll` writes) and `archiveRefusals(dir,
    { migrationsRoot })`, one sentence per reason, for 4.4 to call on the
    staged directory. The plan's *schema hash* and `baseUrl` were dropped
    (`decision-rules`, assessment tier): a hash of `schema.lite` refuses a
    restore whose pending migrations would apply, and both are already in the
    staged files. The schema half is litestone's `status()` over each staged
    `<name>.db` with a `db/migrations/<name>/`: `orphaned` (archive newer) and
    `modified` (a migration rewritten in place, which pre-alpha
    `initial_schema.sql` is) refuse, `pending` passes to boot. Boot's
    `apply()` looks at neither, so nothing else catches them. Proved by seven
    rows in `backup-run.test.ts`, each on a copy of a real archive.
- [x] 4.4 The `/setup` restore path. The wizard's first screen gains *Restore a
      hub*: a bucket form (endpoint, bucket, prefix, key — the
      `BackupDestination` shape, prefilled from `HUB_RESTORE_*` env for a
      headless box, since no row exists yet) that lists `basecamp-*.tar.gz` by
      3.1's listing, or a file upload. `POST /setup/restore` fetches, checks
      sha256 and the manifest, unpacks into `db/restore-staged/` and asks for a
      restart. `core/db.ts` at boot: a staged directory and no `Account` row
      means `litestone restore --from-backup=<staged> --force` before the
      databases open, then the directory is renamed `restore-done-<stamp>/`; a
      staged directory beside an existing account is refused by name and left
      in place. One owner of the file swap, and a live hub is never overwritten.
      `GET /setup/probe` answers `restore: 'staged' | 'done' | null` so the
      wizard can say what happened.
  - Done 2026-10-27. `domain/backup/hub-restore.ts`; the wizard's *Restore a
    hub* tab lists the bucket or takes a file. Five departures, graded by
    `decision-rules` (assessment + map tier, after the build):
    the bucket is reached over pre-signed URLs, because no `Secret` row exists
    for a conduit target to name; the swap runs from `app.ts` before
    `openSqlite`, because that and not `core/db.ts` is where a database first
    opens; the Account check is a raw read of a file no client holds yet (the
    *Zero raw SQL* map line in basecamp's `CLAUDE.md` and `docs/hazards.md`
    now names that exception, which `backup-run` and the manifest already
    took), and it fails CLOSED: only a missing file or table is "no hub",
    because the step it guards is `--force`; both doors ask the same
    question, an `Account` row; the probe also answers `refused`/`failed` with
    `restore_message`, so a swap that did not happen is on the screen and not
    only in the log; and "checks sha256" is the manifest's per-file sha256
    (4.3), since a fresh box holds no row that records the tarball's.
    `POST /setup/restore` is `{ body: 'stream' }`: JSON names an archive
    in the bucket, `application/gzip` is the file itself, capped at
    `MAX_UPLOAD_BYTES`. Bun refuses a declared length over 128 MB first
    (`FJS-3090`), so a larger archive comes from the bucket.
    `HUB_RESTORE_{ENDPOINT,REGION,BUCKET,PREFIX,KEY}` prefill the form, and the
    key is only reported as set. Found: `jobs.db` is NOT restored by
    `litestone restore --from-backup` because no schema names it, and
    `BACKUPS.md` § 7 said it was; that sentence was corrected.
    Proved by six rows in `backup-run.test.ts` (stage, swap with the real CLI,
    refused beside an account, refused beside an unreadable file,
    junk/wrong-top/symlink/damaged refused, and
    bucket list+fetch over a stand-in), plus a scratch two-boot drive, 14/14:
    hub A backs up and downloads, fresh hub B takes the upload (202 staged),
    restarts, answers `done`, A's user signs in, `/setup/restore` is then
    409, and a different key is refused with nothing staged. Not driven: the
    bucket path through the route, and the tab in a browser (4.8's drive).
    Not done (`decision-rules` optional): a pre-signed `Send` adapter so
    `listObjects`/`translate` run unchanged; the listing loop and the error
    line are written again in `hub-restore.ts`, and an adapter would have to
    forge conduit's result and error shapes.
    Open: `restore-done-*/` stays beside the database. Under `db/` in a dev
    tree, `litestone backup`'s layout sweep would carry it into later backups.
- [x] 4.5 Found replicas and archives. The first boot after a restore runs a
      reconcile: every App with `replicaDestinationId` whose credential
      decrypts is listed at its destination (3.1's listing); a replica there
      makes a `Notification` and a card on the app — *replica found, last sync
      <t>, restore onto <server>?* — that calls `apps.restoreReplica`. A
      server whose Outpost still heartbeats to the same `baseUrl` needs
      nothing; one that does not shows its re-enroll step first. The hub's own
      `replicaDestinationId` is listed too and names the runbook, because the
      hub cannot replace itself while serving. App-level rescan arrives here:
      `<prefix>/<appId>-*` to `found` `AppBackup` rows, the hub-only rescan
      generalized.
  - Done 2026-10-27. The owner ruled three questions first: the finding is
    two `@system` App columns, `replicaFoundAt` and `replicaSyncedAt` (not
    derived on read, not a `FoundReplica` model); the card shows only for an
    app not alive, hidden while a placement's heartbeat reads it inside
    `REPLICA_MAX_LAG_MS`; and the app-archive rescan moved to 4.9.
    `domain/backup/found-replicas.ts` (`reconcileFound`) runs in
    `jobs/restore-reconcile.job.ts`, which `app.ts` queues once when
    `restoreStaged` answered `done`, so boot never waits on a bucket. Per App,
    `replicaDatabases` names the databases and the newest object under the
    path is the last sync. Graded by `decision-rules` after the build (late;
    all five departures hold): the hub's replica takes the same two columns
    on `HubConfig`, and `/hub/backups/` names the runbook; one `ReplicaFound`
    notification per workspace lists its apps (new `NotificationKind`,
    subject `Workspace`), and an app already found is not told again, so a
    retried job does not page twice; the card offers *Restore onto <server>*
    per placement on an `online` machine and *re-enroll it first* (the server
    screen issues the enrollment) for any other; `apps.dismissFound`
    (administrator) and `hubConfig.dismissFound` clear it, as does a
    `restoreReplica` that lands. `dismiss` clears and keeps no who/when,
    unlike an alert's `acknowledge` (`docs/hazards.md`).
    Proved by one row in `services.test.ts` over a bucket stand-in: an empty
    replica is not found, a found one records the newest LTX time, the
    workspace is told, a developer's dismiss is refused, and dismiss and a
    stub restore both clear. Unenforced until 4.8's drive: the boot dispatch,
    the card hiding while the app is alive, and the hub half of
    `reconcileFound`; neither card has been seen in a browser.
- [ ] 4.6 3.4's runbook, rewritten around 4.4: `BACKUPS.md` § 7 becomes
      "download it, or point `/setup` at the bucket", and the terminal recipe
      stays for a box whose `/setup` cannot be reached. Closes 3.4.
      `/hub/backups/`'s *Replica found* card (4.5) points at § 7, so it also
      gains the recipe for restoring the hub from its own Litestream replica
      when that is newer than the archive.
- [ ] 4.7 `litestone rekey <new>` over the client's `$rotateKey`, for the hub
      restored with a key that has leaked. Q9 ruled A (`FJS-D1556`).
- [ ] 4.8 `verify:hub-restore`: a scratch hub, an archive from a real
      `backup:run` into SeaweedFS, `/setup` restore across a restart, and one
      App with a real replica shown as found. Row in `DRIVES.md`.
- [ ] 4.9 App-archive rescan, moved out of 4.5 by the owner:
      `<prefix>/<appId>-*.tar.gz` to `found` `AppBackup` rows. Open: a listing
      carries no sha256 and `restoreVolume` refuses a row without one, and
      `AppBackup.serverId` is required while the key names no machine.

## After this (not in this plan)

Litestream copies `.db` files only; a logger directory is covered by the
snapshot alone (`FJS-1509`'s gap). Litestream's VFS read replicas, when they
ship, could serve the drill without a restore.

## Open questions

- ~~**Q1 — How a fleet machine reaches the bucket.**~~ **Answered 2026-10-23 (`FJS-D1485`): A — Snapshots through a pre-signed PUT/GET Basecamp mints per transfer, so no key stays on the machine; Litestream through a standing key scoped to its own bucket or prefix, the one thing that cannot run on a pre-signed URL.** By analogy with
- ~~**Q2 — Where Litestream runs for a fleet app.**~~ **Answered 2026-10-23 (`FJS-D1486`): A — One systemd unit per machine, run by Outpost; each app an entry with its own key, scoped to a bucket or a prefix as the provider allows, so an app is revoked or moved alone.**
- ~~**Q3 — Which first.**~~ **Answered 2026-10-23 (`FJS-D1487`): A — Snapshots off the box first: it reuses `backup:run` and `/backup`, covers non-`.db` files and Basecamp itself, and brings the schedule and the pre-deploy copy.**
- ~~**Q4 — The storage destination's noun.**~~ **Answered 2026-10-23 (`FJS-D1488`): A — `BackupDestination`, a model. The enum goes; both columns become relations, a null one meaning local. The credential follows `NotificationChannel`: a bare `secretId`, a `@transient` plaintext the service lifts into a `Secret` row. A Litestream replica is a continuous backup, so it is the same noun.** The record holding endpoint, bucket,

- ~~**Q5 — How basecamp obtains `conduit-s3`.**~~ **Answered 2026-10-23 (`FJS-D1490`): C — Basecamp's own `providers/storage/s3.ts`, a LIFT of the connector's `signer.ts` and `index.ts` (target builder, put/get/head/delete/list, presign) importing `@frontierjs/toolbelt/sigv4`, the compute pattern. When D1185 flips the swap is an import line.** `FJS-D1185` keeps every
- ~~**Q6 — Who owns a `BackupDestination`.**~~ **Answered 2026-10-23 (`FJS-D1491`): B — `BackupDestination` is workspace-owned like `NotificationChannel`, and `HubConfig.backupDestinationId` points at one across the tier, `onDelete: SetNull`. Deleting that workspace drops the hub to `local`, so posture (1.7) grades *hub destination is local* red. Dokploy's destinations are per organization with the server's own backup picking one; Coolify's S3 storages are per team.** `FJS-D1488` lifts the credential

- ~~**Q7 — Where an app's Litestream key comes from.**~~ **Answered 2026-10-24 (`FJS-D1505`): A — `App.replicaDestinationId`, `@unique`, points at a `BackupDestination` the operator made with a key for that app alone. The replica path is `<prefix>/<appId>`. `BACKUPS.md` gets a recipe per vendor, and 1.8's probe adds a PUT outside the prefix that must be refused, where the vendor scopes by prefix. Snapshots keep `backupDestinationId`, whose key never leaves Basecamp.** `FJS-D1486` rules a

- ~~**Q8 — The shape of "the file you reinstall from".**~~ **Answered 2026-10-27 (`FJS-D1555`): A — The archive is the file: downloaded from `/hub/backups/`, imported at `/setup` across a restart, a manifest refusing the wrong one. One key, one origin.**
  - **A** — The archive is the file: download it, import it at `/setup`, a
    manifest to refuse the wrong one. One key, one origin, no second format.
  - **B** — A config-only JSON export — the declarative tables, ids kept,
    secrets in one blob under a passphrase — imported at `/setup`. Readable and
    key-independent, and the nine fail it on 1 (a third origin the rows then
    compete with), 5 (derived from the archive), 6 (a second writer beside six
    services) and 8 (`Secret.data` on a laptop under a typed passphrase, and a
    wrong passphrase is the secrets gone).
  - **C** — A, plus a read-only derived export (`hub.snapshot`-shaped) for
    reading and diffing, never imported.
  - **Recommend A**, and C the day someone asks to diff two hubs. Confidence 3.
- ~~**Q9 — A hub restored under a key that must change.**~~ **Answered 2026-10-27 (`FJS-D1556`): A — `litestone rekey` over `$rotateKey` after the restore; step 4.7 stands.**
  - **A** — `litestone rekey` over `$rotateKey` after the restore (4.7): the
    archive stays single-key and the key still turns.
  - **B** — Not built: escrow is the answer, and a lost key is lost data.
  - **Recommend A.** `$rotateKey` exists; the CLI is the small half, and it is
    the one thing B's config export offered that A did not. Confidence 2.

## See also

`frontier-cloud.md` step 5 · `deploy-plane.md` (the safeguard table) ·
`packages/basecamp/api/src/jobs/backup-run.job.ts` · `packages/outpost/src/docker.js` § backup ·
`packages/litestone/docs/replication.md`
