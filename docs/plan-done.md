# Plans — finished-phase record

What a finished phase found, and the questions it answered, moved here verbatim so
each plan stays under 32 KB (`plan-size`, `FJS-1562`). Step and `Q` numbers resolve
against the plan named in each heading.

## IDEAS/server-posture.md

### Phase 2 — Basecamp's own host

2.2 detail:

  - The paths are written into `/etc/basecamp/outpost.env` after the install AND
    on a box enrolled before, since an enrolled box never reruns `install.sh`.
  - The real-box half of *Done when* waits on `@frontierjs/outpost` 0.1.3 being
    published and `OUTPOST_VERSION` in `enrollment.ts` moving to it: until then a
    host runs 0.1.2, which reads no `host_files`, and the two file controls stay
    `unknown`.

Answered questions:

- ~~**Q7 — How does the host's readings leave the box?**~~ **Answered 2026-10-12 (`FJS-D925`): A — The Outpost, installed by `fli deploy` with its command listener off, reporting over loopback.**
  - **A** — The Outpost, installed by `fli deploy` with its command listener off,
    reporting over loopback.
  - **B** — A full Outpost, enrolled as an ordinary server row with a hub flag.
  - **C** — Bind-mount `/etc`, `/proc` and `docker.sock` into the API container and
    read in process.
  - **Recommend A** — one implementation of the readings and nothing listening. B puts
    a signed command port on the box that holds the fleet's command key, and a server
    row invites the deploy and drain this record refuses on the host. C gives the
    control plane's own container root on its host to read a config file.
- ~~**FJS-D944 — What does the report-only host Outpost sign its posture report with?**~~ **Answered 2026-10-15 (`FJS-D944`): B — Derived from `ENCRYPTION_KEY` as an HMAC over a fixed label: `fli deploy` writes only the derived value into the host Outpost's config, and the API derives the same value at boot. There is no new variable to generate, lose or rotate.**
  `report.js` signs every POST with `config.secret`, and `outpostCredential`
  (`api/src/core/hooks.ts`) finds the key through `outpostSecretFor(serverId)` —
  `Server.outpostSecretId`, with *no second key that also works*. The host has no
  `Server` row (`FJS-D925`), so a host report today is refused 401 whatever it signs
  with. Whichever is picked, `keyFor` admits the host key for `posture.report` with
  no `server_id` alone, as a principal carrying no workspace, and a test refuses
  the same signature on `servers.heartbeat`.
  - **A** — A host key of its own, `HOST_REPORT_SECRET`, generated once beside
    `ENCRYPTION_KEY` in the stack's `.env` by `deploy/build.mjs` and `fli deploy`,
    and written into the host Outpost's config.
  - **B** — Derived from `ENCRYPTION_KEY` as an HMAC over a fixed label: `fli deploy`
    writes only the derived value into the host Outpost's config, and the API derives
    the same value at boot. There is no new variable to generate, lose or rotate.
  - **C** — The fleet's own enrollment: a hub method mints a `Secret` and the host
    Outpost exchanges a one-time token for it, with the row named on the hub's
    config. This is the same door every machine uses. It needs a system admin's
    session at install time, though, and a fresh box has no admin yet.
  - **Recommend B** — the key is derived, not restated, so it has one origin and
    nothing new to back up. `ENCRYPTION_KEY` already cannot rotate without
    orphaning every `@encrypted` column, and the HMAC is one-way, so the Outpost's
    config never holds anything that decrypts a `Secret`.

- ~~**FJS-D1023 — How does `fli deploy` know to install the report-only host Outpost, and what does it install from?**~~ **Answered 2026-10-16 (`FJS-D1023`): A — A deploy config key the app states, `deploy.hostOutpost: true` in basecamp's `frontier.config.js`. `deploy:setup` installs the Outpost from the pushed checkout's `packages/outpost` (it is in the build context already) as `outpost-host.service`, sandboxed like the fleet unit, and writes the key it derives from the server's `.env.production`, the loopback API URL and the two paths fli itself laid out (the deploy root's env file and the `/db` volume's host directory).**
  Step 2.2. Everything on the Basecamp side of it is built: the Outpost runs
  report-only when `OUTPOST_HOST_KEY` is set (with `BASECAMP_URL`,
  `OUTPOST_HOST_DB_PATH`, `OUTPOST_HOST_ENV_PATH`), the API verifies a
  `posture.report` naming no machine against `hostReportKey(ENCRYPTION_KEY)`
  (`api/src/core/hooks.ts`, label `basecamp.host-posture.v1`), and
  `/hub/security/` reads the rows. But `fli deploy` is the generic app deployer
  and nothing in an app's config says *this app is a control plane, put a host
  Outpost beside it*, and a deploy target has bun but no `node_modules`
  (`packages/cli/CLAUDE.md`). Whichever is picked, fli derives the key with the
  same label, so the label moves to one owner both import (toolbelt) in the same
  change.
  - **A** — A deploy config key the app states, `deploy.hostOutpost: true` in
    basecamp's `frontier.config.js`. `deploy:setup` installs the Outpost from the
    pushed checkout's `packages/outpost` (it is in the build context already) as
    `outpost-host.service`, sandboxed like the fleet unit, and writes the key it
    derives from the server's `.env.production`, the loopback API URL and the two
    paths fli itself laid out (the deploy root's env file and the `/db` volume's
    host directory).
  - **B** — No fli option: basecamp ships its own extra step file under `deploy/`,
    and `fli deploy` gains a generic *the app's own steps* hook that runs it. The
    knowledge stays in the app that needs it, at the cost of a second step
    mechanism in fli.
  - **C** — The fleet install script (`providers/compute/enrollment.ts`
    `installScript()`) grows a report-only mode, and `fli deploy` pipes it to the
    box. One installer for every Outpost, but fli would fetch an install script
    from the app it is installing, before that app is up.
  - **Recommend A** — fli already owns the layout both paths come from and holds
    the `.env.production` the key derives from, so it is the one place that can
    state all three without a copy; one boolean in the one app that wants it.

- ~~**FJS-D1241 — Now that `fli deploy` enrolls Basecamp's host as a fleet machine, does it still install the second, report-only host Outpost?**~~ **Answered 2026-10-18 (`FJS-D1241`): B — Fold the host readings into the fleet Outpost. `08b-outpost` passes `OUTPOST_HOST_DB_PATH`/`OUTPOST_HOST_ENV_PATH` into the `basecamp-host` install, and `/hub/security/` grades the `basecamp-host` row (`HOST_SLUG`) with the `hub.*` controls. Report-only mode, `hostReportKey`, the `outpost-host` principal and the nullable `serverId` are deleted. One reader per box, but the hub tier's reading depends on a workspace's Server row and goes dark under `--no-outpost`. `FJS-D924`/`FJS-D925`/`FJS-D944` are struck in part.**
  Step 2.2 again. `FJS-D1023` was ruled on the premise that no Outpost runs on
  the host. A day later `FJS-D1191`/`FJS-D1202` made `deploy.outpost: true`
  install the full fleet Outpost there by default (`outpost.service`, Server row
  `basecamp-host`, `08b-outpost`). Built as ruled, one box runs two Outposts that
  both read its sshd, ruleset and pending updates. That gives two
  `ServerPosture` rows for one machine, one on a workspace's `/security/` and one
  on `/hub/security/`, and nothing compares them (§ V questions 1, 5, 6 and 9).
  Nothing clashes in the plumbing: the units, state and listeners are separate,
  since report-only opens no port.
  - **A** — Build `FJS-D1023` as written, beside the fleet Outpost. A new
    `deploy.hostOutpost` key and a `_steps-setup` step install
    `outpost-host.service` with `hostReportKey` (its label moving to toolbelt so
    fli derives the same value). The hub tier keeps its own reading, which stays
    true under `--no-outpost` and in a workspace-free install, where
    `enroll-host.ts` answers `skip`. The cost is a duplicated reading.
  - **B** — Fold the host readings into the fleet Outpost. `08b-outpost` passes
    `OUTPOST_HOST_DB_PATH`/`OUTPOST_HOST_ENV_PATH` into the `basecamp-host`
    install, and `/hub/security/` grades the `basecamp-host` row (`HOST_SLUG`)
    with the `hub.*` controls. Report-only mode, `hostReportKey`, the
    `outpost-host` principal and the nullable `serverId` are deleted. One reader
    per box, but the hub tier's reading depends on a workspace's Server row and
    goes dark under `--no-outpost`. `FJS-D924`/`FJS-D925`/`FJS-D944` are struck
    in part.
  - **C** — Keep report-only mode only for `--no-outpost`. `08b-outpost`
    installs the report-only unit when it skips the fleet enrollment, and
    `/hub/security/` reads whichever exists. There is always exactly one reader,
    at the price of two paths to keep correct.
  - **Recommend B** — `FJS-D1191` already put an Outpost on the key's box with
    its listener on, which was `FJS-D925`'s whole reason for report-only. One
    reader per box is § V's ninth answer, and the hub screen grading
    `basecamp-host` derives rather than restates.

## IDEAS/backups.md

### Phase 0 — Rule the shape

0.7 detail:

  - Ran 2026-10-23: 20 rows green, `s3.us-west-000.backblazeb2.com`, bucket
    `frontier-basecamp`, key restricted to the bucket and to the name prefix
    `basecamp-` — which needed a `FIXTURE_PREFIX` knob, since every drive key
    was `drive/…`. One vendor difference: an expired presigned URL is 401 on
    B2, 403 on AWS; the row asserts the refusal, not the number. The old row
    sent a negative expiry, a 400 everywhere, and the sink now says so too.
    Conditional PUT (`if-none-match: *`) is in no row, so still unproved. The
    destination's `prefix` in 1.1 must equal the key's name prefix.

### Phase 1 — Snapshots leave the box

1.1 detail:

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

1.2 detail:

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

1.3 detail:

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

1.4 detail:

  - Built 2026-10-23. `listObjects` (ListObjectsV2, a continuation token,
    keys unescaped, UTF-8 byte order) landed in the sibling's `conduit-s3`
    with a sink row, green on the B2 fixture too, and is lifted byte for byte
    into `providers/storage/s3.ts`. `HubConfig` carries
    `backupKeep{Local,Remote}{Count,Days}` (count 7, no age by default) and
    the settings screen four fields. `domain/backup/backup-archives.ts` owns the
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

1.5 detail:

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

1.6 detail:

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

1.7 detail:

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

1.8 detail:

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

### Phase 2 — Litestream on every fleet machine, run by Outpost

2.1 detail:

  - Built 2026-10-24. The pin and its checksum-verified installer moved to
    `@frontierjs/litestone/replicate` (`LITESTREAM_PIN`, `litestreamInstall`),
    beside the floor, so `deploy:setup` and the fleet install are one build —
    cli now depends on litestone. `basecamp-litestream.service` reads
    `/etc/basecamp/litestream.yml`, written `dbs: []` once and never over the
    Outpost's; 0.5.17 runs on an empty list (probed), so the unit is enabled at
    install. Sandboxed like the Outpost — `ProtectSystem=strict`, writes only
    `/var/lib/docker/volumes` and `StateDirectory=litestream`, where 2.2's
    `meta-dir` goes. Uninstall stops it; purge removes the binary. A running
    unit on an empty list looks healthy until 2.3 grades lag. The real download
    and checksum ran here; not yet run on a box under systemd.

2.2 detail:

  - Built 2026-10-24. `interval` and `retention` left the wire: retention is
    top-level in 0.5, so per file and not per app, and no column holds an
    interval; litestone's defaults stand. The YAML is litestone's `buildYaml`,
    which gained `meta-dir` and a field-wise S3 replica (every value quoted;
    `force-path-style`), so Outpost now depends on litestone — **litestone must
    publish before Outpost**, which installs from npm. A volume not yet made is
    answered in `skipped`; a list already in force with the unit active is not
    restarted, since every release resends it. Basecamp: `App.replicaDestinationId
    @unique` (`FJS-D1505`), and `jobs/replicate-sync.job.ts` is the one sender —
    the machine's whole list, refused whole when one key cannot be read, one in
    flight per machine and re-read after sending. Sent on the pointer set,
    delete/restore (cascades too), place/unplace, a release succeeding, a
    destination patched/removed/restored, and a machine back `online`. Proved
    against SeaweedFS with 0.5.17: replicated under `apps/<id>/`, meta outside
    the volume, restored 4 rows. **Restore by `-config` cannot find a `dir:`
    database** ("database not found in config"); restore by URL with
    `LITESTREAM_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` works — 3.1 restores that
    way. Not yet run on a box under systemd.
  - How far a key can be scoped (researched 2026-10-24). Litestream's own
    minimum is `s3:ListBucket` + `GetBucketLocation` on the bucket and
    `Put`/`Get`/`DeleteObject` on its objects, narrowable to a path; delete
    can go only when `retention` is off
    ([guide](https://litestream.io/guides/s3/)).
    - **B2 — prefix.** `b2_create_key` takes `bucketIds` and `namePrefix`;
      minting needs `writeKeys`
      ([b2_create_key](https://www.backblaze.com/apidocs/b2-create-key)).
    - **AWS / MinIO — prefix.** `ListBucket` on the bucket with an
      `s3:prefix` condition, object actions on `bucket/prefix/*`
      ([AWS](https://repost.aws/knowledge-center/s3-folder-user-access) ·
      [MinIO](https://min.io/docs/minio/linux/administration/identity-access-management/policy-based-access-control.html)).
    - **R2 — bucket** for a standing token (*Bucket Item Read/Write*, made
      through the API); prefix only on temporary credentials, at most 7 days
      ([tokens](https://developers.cloudflare.com/r2/api/tokens/) ·
      [temp credentials](https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/)).
    - **Spaces — bucket**, *Read* or *Read/Write/Delete*; keys cannot be made
      by API or CLI
      ([manage access](https://docs.digitalocean.com/products/spaces/how-to/manage-access/)).
    - **Hetzner — project** by default; a bucket policy allowlists a key
      (`p<project>:<key>`) on one bucket, with no prefix example and keys made
      in the Console only
      ([S3 credentials](https://docs.hetzner.com/storage/object-storage/faq/s3-credentials)).
    - Precedent for minting: `fly storage create` makes a Tigris bucket and
      sets its keys as that app's secrets
      ([Fly](https://fly.io/docs/reference/tigris/)).
    So a per-app key is a prefix at B2, AWS and MinIO and a bucket at R2,
    Spaces and Hetzner, and two of the six cannot mint one. Q7 is `FJS-D1505` **A**.

2.3 detail:

  - Built 2026-10-24. Probed first against Litestream 0.5.17 and a SeaweedFS
    bucket: the `addr` metrics cannot answer it. `litestream_sync_count` counts
    local WAL syncs and kept rising with the bucket stopped, and
    `replica_operation_total` carries no db label. The control socket's
    `GET /list` answers each database's `last_sync_at`, which ticks about once
    a second while healthy and stops when the bucket stops.
  - The wire. `buildYaml` takes `socket` (litestone); Outpost writes it into
    every `/replicate` config and the install's seed, under the unit's
    `RuntimeDirectory=litestream`. `replicator.status()` reads `/list` over
    the unix socket with a 3s timeout, rolls databases up per app by their
    volume path (oldest sync wins), and never throws: no socket, a refusal or
    a timeout is `{error}`. Every heartbeat carries it as `replication`.
  - Stored on `Server.replication`, stamped `checked_at`, not on App: both are
    `@@trail(audit)`, and a column per app would be a trailed write per app
    every 30s. `apps.get` hands each placement `replicaLag()`; the App screen's
    Placement card draws it as a badge.
  - `backup.replica-lag` (group `backup`, high) is graded on READ off that
    reading, like `hub.backup-recent` and `hub.key-escrowed`, so a stopped unit is red within one
    beat rather than at the next six-hourly report, and an old posture report
    does not grey it. Over 5 min behind, never synced, or absent from the
    reading fails by app slug; a Litestream error fails; no reading, or one
    older than 5 min, is unknown.
  - Limits. One bucket unreachable at unit start hangs `/list` for the whole
    machine, so every app on it reads red: it fails toward lag, never toward a
    clean answer. An app placed but never released has no volume and reads
    *not replicating here*. Not yet run on a box under systemd.
  - The Phase 2 exit, driven 2026-10-24 from a scratch script (not committed):
    the real replicator and reporter with `run` standing in for docker and
    systemctl, a real Litestream 0.5.17 child, SeaweedFS 4.47, Basecamp in a
    test env. Unknown before a heartbeat; objects under `apps/<id>/`;
    `apps.get` 1s behind and the control green; Litestream killed, the next
    heartbeat red with *not running*. A paused bucket froze `last_sync_at`
    while `/list` still answered, so it reads red at 5 min, not at once. The
    App screen's badge was compiled, not seen in a browser.

2.4 detail:

    Built 2026-10-24, uncommitted. `HubConfig.replicaDestinationId` (`@unique`,
    SetNull) picks the destination on `/hub/settings/`; `/replicate` takes
    `{ replicas, host? }` and the Outpost points `host` at
    `OUTPOST_HOST_DB_PATH`, read back from `/list` as `host`. Only the
    `basecamp-host` row in the destination's OWN workspace is sent it — the slug
    is per-workspace and reserved nowhere, so a tenant could name a machine that
    and receive the hub's key; `posture.host()` has the same gap unguarded,
    FJS-3488. A destination holds one replica (FJS-D1505): an app's is refused to
    the hub and the hub's to an app, 409. The pointers are written at system
    after the scoped save, alone: HubConfig naming a tenant-owned destination
    fails the hidden-parent check otherwise, which `backupDestinationId` through
    `save` already did before this step, and a whole-row system write would lift
    `@system` too. `backup.replica-lag` on the host grades *Basecamp's own
    database* beside the apps. `fli deploy` writes
    `basecamp-litestream.service.d/host.conf` (`ReadWritePaths=<dbDir>`, and
    `ProtectHome=read-only` for a /home or /root one) in the same script as the
    `OUTPOST_HOST_*` lines; the uninstall removes it; preflight warns when a
    second Litestream (the operator's `litestone replicate`) is on the same
    database. That script was run twice against a fake root (written, then
    unchanged); nothing ran under systemd, and whether `ReadWritePaths` lifts
    `ProtectHome=read-only` is the systemd docs' claim, not measured.

### Phase 3 — Restore and drill from Basecamp

3.1 detail:

  - Built 2026-10-25. Probed first against Litestream 0.5.17: `restore -config`
    answers *database not found in config* for a file inside a `dir:` target,
    so each database is restored by its URL,
    `s3://<bucket>/<path>/<file>?endpoint=…&region=…&force-path-style=true`,
    the key in `LITESTREAM_*` env. Litestream cannot list a replica, so
    `apps.restoreReplica { serverId, at?, overwrite? }` (gate 5) lists
    `<path>/` with a delimiter (`listObjects` grew `delimiter` and `prefixes`)
    and names the `*.db` files; the body carries the same entry `/replicate`
    sends, so the machine holds no key it did not have.
  - Outpost: `replicator.stage` restores each into its own directory under
    `OUTPOST_REPLICA_STAGE_DIR`. The argv, the clamp of an `at` past the
    replica's last write to the latest, and the error pick are litestone's
    (`restoreArgs`, `lastWriteArgs`/`parseLastWrite`, `restoreError`, split out
    of `restoreFile` so a caller spawning with a key in its environment runs
    the same ones); one failing database fails the call with the volume
    untouched.
    `docker.restoreFiles` copies them in a no-network busybox, replacing each
    `.db` and its own `-wal`/`-shm` and keeping every other file, owned as the
    volume is. Unlike `/volume/restore`, overwrite does not empty the volume:
    a replica carries no uploads.
  - Probed: a running Litestream drops a database whose file is replaced
    (`ensure wal exists: disk I/O error`) and never registers the new one, so
    later writes reach no bucket. The route restarts the unit when it is
    active (`replication: restarted | not running | restart failed`); after a
    restart the restored file is snapshotted as the next txid, and a latest
    restore reads the restored rows plus the writes after them.
  - Proved: outpost suite 245/0 (7 new); a scratch drive through the signed
    route on the real daemon, Litestream 0.5.17 and SeaweedFS 4.48 — refused
    without overwrite and while held, a missing database fails in
    Litestream's words with the volume untouched, an instant restores that
    instant's rows with `integrity_check` ok, an instant past the last write
    is the latest, the stale `-wal` gone, the upload and the uid kept.
    Basecamp 991/0, typecheck 7, example `verify:replicate` 33/33 after the
    litestone split. Not driven: `restoreReplica` through Basecamp against a
    bucket (the Phase 3 exit), nothing under systemd.

3.2 detail:

      Built 2026-10-25, ruled `FJS-D1521` (amends D943 A: http(s) to any address, `sha256` required). `/volume/restore { url, sha256 }` fetches into the restore dir, checks the digest before `tar`, extracts through the one path, removes the copy. `/backup` answers `sha256`, computed by busybox `sha256sum` in the capture container: the archive is root's 0600, and a non-root Outpost could not read it back. `AppBackup.sha256` records it. `apps.restoreVolume` takes `backupId` or `path`, exactly one; `backupSource` refuses a failed backup, one whose upload never landed (its `location` is a machine path under the backup dir), and one with no digest. `mintDownload` beside `mintUpload` in `app-backup-run.job.ts`.
      Proof: outpost 250/0 (5 url-restore cases, the capture script's digest), basecamp 992/0, typecheck 7 = baseline. Drive (scratchpad `drive-32.ts`) against real Docker and SeaweedFS on 18391 is 10/10. It covers: a real capture's digest equals the archive; a pre-signed PUT, then a pre-signed GET restore into `fjs-drv-data`; a wrong digest refused with the volume untouched; overwrite refused without the flag; a held volume refused; the fetched copy gone.
      Not driven: the PUT from Outpost itself, because the drive is not root as the unit is. The stand-in runs with no S3 auth, so the signature was carried but never checked. Through Basecamp's executor end to end is the Phase 3 exit drive.

3.3 detail:

      Built 2026-10-25, ruled `FJS-D1524` (verify on the machine, in the app's live release image) and `FJS-D1525` (an `AppDrill` model). Outpost `POST /replica/drill` stages the replica with `replicator.stage`, then `docker.verifyCopy` runs `bun x litestone restore --verify-only=/fjs-drill --json` in the release image with `--network none`, the release env by name and `--without-key` when it has no `ENCRYPTION_KEY`, and unstages either way. `--verify-only=<dir>` is new in litestone: `--verify`'s checks over files in place, each database under its own file name, left in place, with `--url`/`--at`/`--from-backup`/`--verify`/`--force` refused beside it. Basecamp: `AppDrill` (`DrillKind { manual scheduled }`), `appDrills` `find`/`get`/`run` (gate 5), `App.drillCron` on the clock beside `backupCron` (`syncAppDrillSchedule`, restored at boot), `jobs/app-drill-run.job.ts` the one asker. Refused before a row with no replica destination or no successful release; a stub executor or a missing report is a `failed` row. Seeded with one passed drill.
      Proof: outpost 254/0, litestone 7953/0 plus the `--verify-only` smoke case, basecamp 994/0, typecheck 7 = baseline. Drive (scratchpad `drive-33.ts`) is 8/8: real Litestream 0.5.17 replicating into SeaweedFS on 18391, staged by the real replicator, and an image holding the litestone CLI and the schema run under real Docker. A good replica is verified with every row read; a row the schema refuses is `verified: false` naming it; an image with no CLI is "did not run"; the stage directory is gone each time.
      Not driven: `appDrills.run` through Basecamp's executor to a live Outpost (the Phase 3 exit), and a real app's release image, which has to ship the litestone CLI reachable offline. Only top-level `*.db` files are staged, so a tenant database under a subdirectory is not drilled.

Answered questions:

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
- ~~**Q7 — Where an app's Litestream key comes from.**~~ **Answered 2026-10-24 (`FJS-D1505`): A — `App.replicaDestinationId`, `@unique`, points at a `BackupDestination` the operator made with a key for that app alone. The replica path is `<prefix>/<appId>`. `BACKUPS.md` gets a recipe per vendor, and 1.8's probe adds a PUT outside the prefix that must be refused, where the vendor scopes by prefix. Snapshots keep `backupDestinationId`, whose key never leaves Basecamp.** `FJS-D1486` rules a
  key per app; nothing says who makes it. The research is under 2.2.
  - **A** — `App.replicaDestinationId`, `@unique`, points at a
    `BackupDestination` the operator made with a key for that app alone. The
    replica path is `<prefix>/<appId>`. `BACKUPS.md` gets a recipe per vendor,
    and 1.8's probe adds a PUT outside the prefix that must be refused, where
    the vendor scopes by prefix. Snapshots keep `backupDestinationId`, whose
    key never leaves Basecamp.
  - **B** — Basecamp mints a key per app through the vendor's key API (B2
    `b2_create_key`, then R2 and AWS) and keeps it as a Secret on the App.
    It needs a `writeKeys` key in Basecamp, close to a master key, and still
    falls back to A at Spaces and Hetzner.
  - **C** — The replica reuses the app's `backupDestinationId` key. That puts a
    workspace key on every machine, which breaks D1486's revoke-alone and
    D1485's stolen-machine bound.
  - **Recommend A.** No new owner and no new noun. A leaked key reaches one
    app's replica, which is what D1485 promises, and it works at all six
    vendors. Reopen as B when operators keep getting the scope wrong.
    Confidence 2.
