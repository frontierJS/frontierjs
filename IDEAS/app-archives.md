---
id: app-archives
status: proposed
dated: 2026-10-31
---

# Idea — An app's data, out of Basecamp and back in by a file

**Status: PROPOSED.** Probed against the tree 2026-10-31. Do not cite this file
as behavior — see `VERIFYING.md`. Follows `IDEAS/backups.md`, which brought
archives off the box and restore from a bucket; this plan is the file a
person holds.

## What exists (probed 2026-10-31)

- **The hub's archive downloads.** `backups.download`
  (`api/src/services/backups/backups.service.ts`) answers a bucket
  archive with `mintDownload`'s pre-signed GET and a local one with
  `mintArchiveUrl`'s five-minute signed link (`plugins/backup-archive.ts`);
  `/hub/backups/` has the button. Hub archives are `AppBackup` rows on the
  hub App (`FJS-D1606`), so the method already reads the row an app's
  archive is.
- **An app's archive does not download.** `appBackups` offers `find`,
  `get`, `take` and `rescan`. `components/AppBackups.mesa` offers Take now,
  Rescan bucket and Restore, and Restore only where the archive is in a bucket
  with a sha256 (`restorable`).
- **A machine-kept archive cannot leave by a URL.** No bytes cross the
  command port (`jobs/app-backup-run.job.ts` header, `FJS-D1485`). An
  archive with no destination is a path on that machine and nothing else.
- **The machine restores from a URL.** Outpost `POST /volume/restore` takes
  `url` and `sha256`; Phase 3 of the backups plan feeds it a pre-signed GET.
- **Basecamp already receives an uploaded archive.** `/setup` streams the
  body to disk by `receiveUpload` (`api/src/app.ts`).
- **fli pulls a db by ssh only.** `fli db:download` and `fli db:import` scp
  from `PROD_SERVER`/`PROD_SERVER_PATH`; no `fli basecamp:*` command reads
  an archive. `fli basecamp:live` shows the env pair a Basecamp call uses:
  `BASECAMP_API_KEY` and `BASECAMP_APP_ID`.

## Plan

### Phase 0 — Read what a download hands over

Goal: know the file before a button offers it.
Done when: one bucket archive of an FJS app is fetched by its pre-signed GET
and its listing recorded under 0.1.

- [ ] 0.1 Take an archive of `example` to the MinIO destination the backups
      drives use, fetch it by `mintDownload`'s URL, and record the name the
      browser saves it as (the hub comment says both halves answer as an
      attachment; a bucket GET needs `response-content-disposition` for that)
      and the tar's top entries (`db/*.db` and no `-wal`, given the retake).

### Phase 1 — Download in Basecamp

Goal: an operator downloads any bucket archive of their app from its page.
Done when: `services.test.ts` grades `appBackups.download` (gate, scope,
refusals) and `verify-screens.mjs` clicks Download on an app's archive;
`fli done` is clean.

- [ ] 1.1 `appBackups.download`, gate `ADMINISTRATOR` like `take`: the row
      read in the caller's scope, the hub App's rows refused as `find`
      refuses them, a machine-kept archive refused by name ("kept on
      <machine> — give the app a backup destination to download its
      archives"). The bucket half of `backups.download` moves into
      `domain/backup/backup-archives.ts` and both methods call it (one owner).
      Who minted is logged, as the hub's is. Rows beside the hub download
      test.
- [ ] 1.2 A Download button in `AppBackups.mesa` under the same predicate as
      Restore, `location.assign(url)` as `/hub/backups/` does; the line under
      the table says a kept archive downloads once it is in a bucket.

### Phase 2 — fli pulls an app's data through Basecamp

Goal: `fli` takes and fetches an app's archive without ssh to the box.
Done when: the new verb fetches `example`'s latest archive into
`db/backups/<stamp>/` against the dev Basecamp, and Q1's ruling is built.

- [ ] 2.1 `fli basecamp:backup [--app] [--take] [--out]`: the newest
      successful bucket archive of `BASECAMP_APP_ID`, or one taken first with
      `--take` and waited on, fetched and unpacked under `db/backups/<stamp>/`.
      Which key scope a custom method needs (`appBackups:read` or `:write`)
      is found here.
- [ ] 2.2 `fli db:download` and `fli db:import` per Q1.

### Phase 3 — Import an archive into an app

Goal: an archive from a laptop becomes a restorable row on the app.
Done when: an archive downloaded in Phase 1 is uploaded to a second app,
restored onto its machine by the existing Restore, and the drive reads back a
row it wrote before the download.

- [ ] 3.1 The upload route: the body streamed by `receiveUpload` into the
      app's bucket at `keyUnder(dest, '<appId>-<stamp>.tar.gz')`, its sha256
      taken on the way, then an `AppBackup` row the way `rescan` writes a
      found one. `BackupKind` gains `upload` (a schema change; snapshots
      regenerate). Shape per Q2 and Q3.
- [ ] 3.2 An Upload control in `AppBackups.mesa`; the row it makes offers
      Restore like any other.
- [ ] 3.3 The round trip in `verify-screens.mjs`.

## After this (not in this plan)

Sending a machine-kept archive to a bucket after the fact (a second PUT the
machine makes on request), which would make every archive downloadable.

## Open questions

- **Q1 — `fli db:download` and `fli db:import` once Basecamp can answer.**
  **A** — go through Basecamp when `BASECAMP_APP_ID` is set, ssh otherwise.
  **B** — Basecamp only; the ssh path goes. **C** — unchanged;
  `basecamp:backup` is the only Basecamp path. **Recommend A** — ELA and
  maid.tech run on hosts Basecamp does not manage, so B strands them, and C
  leaves two verbs for one act.
- **Q2 — An import into an app with no backup destination.** **A** — refused:
  the upload lands in the app's bucket, and Restore stays the one restore
  path. **B** — kept on the hub's disk and handed to the machine by a signed
  link (the `backup-archive` route's shape). **Recommend A** — B adds a second
  place an archive lives and a second link Restore has to know.
- **Q3 — What an import accepts.** **A** — the archive only, a `tar.gz` of the
  volume as Phase 1 hands it out. **B** — also a bare `.db`, wrapped into an
  archive on the way in. **Recommend A** — the archive is the file
  (`FJS-D1561`'s answer for the hub); a bare `.db` loses whatever else is on
  the volume.

## See also

- `IDEAS/backups.md` — archives off the box, restore and drills.
- `FJS-D1485` (pre-signed transfers), `FJS-D1561` (the archive is the file),
  `FJS-D1606` (hub archives are `AppBackup` rows).
