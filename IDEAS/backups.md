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
Done when: Q1–Q4 are rulings in `DECISIONS.md`.

- [x] 0.1 Q1: how a fleet machine reaches the bucket — [`FJS-D1485`](../DECISIONS.md#fjs-d1485) **A**: pre-signed per snapshot transfer, a scoped standing key only for Litestream
- [x] 0.2 Q2: where Litestream runs for a fleet app — [`FJS-D1486`](../DECISIONS.md#fjs-d1486) **A**: one host unit per machine, run by Outpost, a key per app
- [x] 0.3 Q3: snapshots or Litestream first — [`FJS-D1487`](../DECISIONS.md#fjs-d1487) **A**: snapshots first
- [x] 0.4 Q4: the storage-destination noun's name — [`FJS-D1488`](../DECISIONS.md#fjs-d1488) **A**: `BackupDestination`, a model replacing the enum

### Phase 1 — Snapshots leave the box

Goal: losing a machine, Basecamp's included, loses no backup.
Done when: a scheduled Basecamp backup and a scheduled app backup each land in
a bucket on a stand-in (MinIO), retention prunes the oldest, and a failed upload
keeps the local file with a warning — in `verify:outpost` and `verify:screens`.

- [ ] 1.1 `BackupDestination` (`FJS-D1488`) becomes a model: endpoint, bucket,
      prefix, region and a `secretId` lifted from a `@transient` plaintext, as
      `NotificationChannel` does. The enum goes; `Backup.destination` and
      `HubConfig.backupDestination` become relations, null meaning local. `s3`
      stops being refused. A `VOCABULARY.md` row.
- [ ] 1.2 `backup:run` uploads Basecamp's archive. A failed upload keeps the
      local copy and records the warning.
- [ ] 1.3 `HubConfig.backupCron` is registered in `job-schedule.ts`, the one
      clock, and `BackupKind.scheduled` is what it writes.
- [ ] 1.4 Retention: a keep-count and an age, local and remote apart. Basecamp
      prunes; the rows are the index, and a rescan lists the prefix so an
      archive with no row is found rather than invisible (Cloudron's gap).
- [ ] 1.5 Outpost `/backup` uploads to a pre-signed PUT Basecamp mints per
      archive — the upload step `FJS-D679` left for `s3`. The machine holds no
      standing key for it. The signer is litestone's `src/storage/sigv4.js`,
      not a second one (Invariant 4).
- [ ] 1.6 A schedule per App, and a snapshot before every fleet `/deploy`.
- [ ] 1.7 `ENCRYPTION_KEY` escrow: a posture control and a line on the backups
      screen that an archive without its key cannot be read. The key never
      travels with the archive.

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

## See also

`frontier-cloud.md` step 5 · `deploy-plane.md` (the safeguard table) ·
`packages/basecamp/api/src/jobs/backup-run.job.ts` · `packages/outpost/src/docker.js` § backup ·
`packages/litestone/docs/replication.md`
