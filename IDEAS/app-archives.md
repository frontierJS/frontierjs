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

- [x] 0.1 Take an archive of `example` to the SeaweedFS destination the
      backups drives use, fetch it by `mintDownload`'s URL, and record the
      name the browser saves it as and the tar's top entries.
      **Recorded 2026-10-31** (scratch probe: Outpost's own `backup()` over
      example's three databases with a WAL writer open, uploaded by
      basecamp's `presign` PUT to `chrislusf/seaweedfs:4.48`, fetched by its
      GET):
      - The GET is 200 `application/gzip` with **no `Content-Disposition`**,
        and its sha256 matches the capture's. A browser saves it under the
        URL's last segment, `<appId>-<stamp>.tar.gz` — the app's id, not its
        slug. The hub comment's "both halves answer as an attachment" holds
        for the local link only.
      - `response-content-disposition` signed into the GET's query comes back
        as the header (`attachment; filename="…"`), so 1.1 can name the file.
      - The tar is flat: `./`, `./shop.db`, `./shop.db-wal`, `./shop.db-shm`,
        `./jobs.db`, `./shops-registry.db`. No `db/` directory, and the
        `-wal` is in it beside its database — the retake keeps the tar
        consistent, it does not checkpoint.
      - The capture container writes the archive as root under umask 077, so
        an Outpost that is not root cannot read it to upload (EACCES). A box's
        Outpost is root; a drive running one as a user must run the capture
        as itself.

### Phase 1 — Download in Basecamp

Goal: an operator downloads any bucket archive of their app from its page.
Done when: `services.test.ts` grades `appBackups.download` (gate, scope,
refusals) and `verify-screens.mjs` clicks Download on an app's archive;
`fli done` is clean.

- [x] 1.1 `appBackups.download`, gate `ADMINISTRATOR` like `take`: the row
      read in the caller's scope, the hub App's rows refused as `find`
      refuses them, a machine-kept archive refused by name ("kept on
      <machine> — give the app a backup destination to download its
      archives"). The bucket half of `backups.download` moves into
      `domain/backup/backup-archives.ts` and both methods call it (one owner).
      Who minted is logged, as the hub's is. The shared helper signs
      `response-content-disposition` with the `name` the method answers
      (`<slug>-<stamp>.tar.gz` here, `basecamp-<stamp>.tar.gz` for the hub),
      because a bucket GET carries no disposition and the key's own name is
      the app id (0.1); quotes and CR/LF are stripped from the slug. Rows
      beside the hub download test assert the minted URL carries it.
- [x] 1.2 A Download button in `AppBackups.mesa` for a row `isRemote`
      admits (success, a destination, no `error`), `location.assign(url)` as
      `/hub/backups/` does; the line under the table says a kept archive
      downloads once it is in a bucket. Restore's `restorable` there omits
      `!b.error`, so it offers Restore on a kept archive the server refuses;
      the same predicate fixes both.

### Phase 2 — fli pulls an app's data through Basecamp

Goal: `fli` takes and fetches an app's archive without ssh to the box.
Done when: the new verb fetches `example`'s latest archive into
`db/backups/<stamp>/` against the dev Basecamp, and Q1's ruling is built.

- [x] 2.1 `fli basecamp:backup [--app] [--take] [--out]`: the newest
      successful bucket archive of `BASECAMP_APP_ID`, or one taken first with
      `--take` and waited on, fetched and unpacked under `db/backups/<stamp>/`.
      Which key scope a custom method needs (`appBackups:read` or `:write`)
      is found here.
      **Built 2026-10-31** (`pullAppArchive` in `packages/cli/core/basecamp.js`).
      The fetch needs `appBackups:read` (`download` is a declared read);
      `--take` needs `appBackups:write` and `apps:read`, which picks the
      machine Back up now picks. `take` answers once the machine has, so the
      wait is the call. The fetch checks the row's sha256 and refuses a tar
      with any entry below its top.
- [x] 2.2 `fli db:download` and `fli db:import` per `FJS-D1717`: with
      `BASECAMP_APP_ID` set, print `BASECAMP_APP_ID <id> detected — pulling
      through Basecamp`, fetch by 2.1's helper, and for `db:import` put the
      archive's db in place as `development.db`; otherwise print that ssh is
      used and run today's steps. The ELA-only lines in `db:import`
      (`pausedAt`, `attom.db`, `ss.db`) stay on the ssh path.
      **Built 2026-10-31.** An archive holds the app's named databases, not
      one `production.db` (0.1), so `db:import` puts each in place under its
      own name with its `-wal`, and only `production.db` lands as
      `development.db`. `--dev` is refused with the id set, as `fli deploy`
      refuses its target flags.
      **Proved 2026-10-31** against a scratch Basecamp on 7120 seeded by
      `db/seed.js`, because the dev db holds no workspace. A tar of
      `example/db`'s databases was put in SeaweedFS under a seeded App's key
      and found by `rescan`. All three verbs fetched it with an
      `appBackups:read` key, and `db:import`'s `shop.db` matched example's
      byte for byte. Refusals proved: a tampered object, an App with no
      archive, and `--take` on the stub executor. A `--take` on a real
      Outpost is not proved, and no standing test grades `placeArchive`; one
      is owed the next time the area is touched.

### Phase 3 — Import an archive into an app

Goal: an archive from a laptop becomes a restorable row on the app.
Done when: an archive downloaded in Phase 1 is uploaded to a second app,
restored onto its machine by the existing Restore, and the drive reads back a
row it wrote before the download.

- [x] 3.1 The upload route: the body streamed by `receiveUpload` into the
      app's bucket at `keyUnder(dest, '<appId>-<stamp>.tar.gz')`, its sha256
      taken on the way, then an `AppBackup` row of kind `found`, the way
      `rescan` writes one, with `requestedBy` saying who uploaded. The kind is
      reused, so there is no schema change. A bare `.db` is wrapped into the
      same `tar.gz` first (`FJS-D1719`), keyed `<appId>-<stamp>.db.tar.gz`
      (`FJS-D1724`). Before the row is written, a tar that lists no top-level
      `./*.db` (the shape 0.1 recorded), or a `.db` that does not open as
      SQLite, is refused, because otherwise a garbage file reads as
      restorable. That refusal gets a row in `services.test.ts`. The check is
      not keyed to the app id: Phase 3 restores app A's archive onto app B on
      purpose. An app with no destination is refused (`FJS-D1718`). Check
      that `rescan` dedupes by `location`, or the next rescan writes the
      upload twice.
      **Built 2026-10-31** (`FJS-D1732`). `appBackups.upload` grades the
      caller and signs a link; `PUT /app-archive-upload/{appId}`
      (`plugins/app-archive-upload.ts`) streams the body and hands it to
      `importAppArchive` (`domain/backup/app-archive-import.ts`), which PUTs
      by `mintPut` from a scratch file beside the database. Every entry must
      be a top-level plain file; a bare upload needs a `.db` name. Rescan
      dedupes by `location` within the destination, and now mints a row for a
      `.db.tar.gz` key too, which it skipped before. A request is capped at
      128 MB by Bun, below `MAX_UPLOAD_BYTES` (`FJS-3090`), the same ceiling
      `/setup/restore` has.
- [ ] 3.1b A `.db.tar.gz` restores per file (`FJS-D1724`). `/volume/restore`'s
      overwrite empties `/data`, which would delete the volume's other
      databases. Outpost's `restore` takes one more option, so its url door's
      fetch and sha256 check stay the only ones: the tar extracts into a temp
      dir inside the same throwaway container and a `FILES_SCRIPT` taking
      its source dir replaces that file and its `-wal`/`-shm`. Basecamp picks
      the option from the key's `.db.tar.gz`. A row in Outpost's docker test:
      a wrapped `.db` restored onto a volume holding two other databases and
      an uploads file leaves the others, and the target's `-wal`/`-shm` are
      gone.
- [ ] 3.2 An Upload control in `AppBackups.mesa` taking `.tar.gz` or `.db`;
      the row it makes offers Restore like any other, and a wrapped `.db`'s
      confirmation says it replaces that database only.
- [ ] 3.3 The round trip in `verify-screens.mjs`.

## After this (not in this plan)

Sending a machine-kept archive to a bucket after the fact (a second PUT the
machine makes on request), which would make every archive downloadable.

## Open questions

- ~~**Q1 — `fli db:download` and `fli db:import` once Basecamp can answer.**~~
  **Answered 2026-10-31 (`FJS-D1717`): A — through Basecamp when
  `BASECAMP_APP_ID` is set, over ssh otherwise, and each prints that the id
  was detected and which path it takes. With the id set and no bucket
  archive, refused by name; no quiet fall back to ssh.**
- ~~**Q2 — An import into an app with no backup destination.**~~
  **Answered 2026-10-31 (`FJS-D1718`): A — refused; an upload lands only in
  the app's bucket, and the refusal names the fix.**
- ~~**Q3 — What an import accepts.**~~ **Answered 2026-10-31 (`FJS-D1719`):
  B — the archive or a bare `.db`, wrapped into an archive on the way in.
  Restoring a bare `.db` replaces that database only, and the confirmation
  says so.**

## See also

- `IDEAS/backups.md` — archives off the box, restore and drills.
- `FJS-D1485` (pre-signed transfers), `FJS-D1561` (the archive is the file),
  `FJS-D1606` (hub archives are `AppBackup` rows).
