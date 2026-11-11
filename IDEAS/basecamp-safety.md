---
id: basecamp-safety
status: proposed
dated: 2026-11-08
---

# Idea — keep working on Basecamp without endangering the apps it runs

**Status: PROPOSED. Nothing built; Q1–Q5 ruled (`FJS-D2038`–`FJS-D2042`).** Probed against the tree 2026-11-08 by reading
code; nothing was run on a box. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-08): "make sure that i can still work on basecamp and keep the apps
running on it safe."

## What the review found

Stopping, restarting or redeploying Basecamp reads as safe for the apps. The holes are a Basecamp
that comes back holding the wrong data, a rollback over a migrated database, a few destructive
calls with too little in front of them, and backup coverage only the live box can answer.

Sound, so not worth probing again unless the code moves:

- The heartbeat's reply is discarded, so it cannot carry a command (`outpost/src/report.js`).
- An empty hub does nothing until a machine re-enrolls: an unknown server's heartbeat is a 404.
- A crashed app needs nothing from the hub: `--restart unless-stopped`, env set at `docker run`,
  image local, data on a bind mount.
- Caddy routes survive a restart and a reboot through `--resume`. There is no on-demand TLS ask.
- A failed `fli deploy` of Basecamp puts the old container back and writes only its own routes.
- Volume cleanup cannot reach app data, which is bind-mounted. Outpost refuses a held directory.
- `fli deploy` ships `git archive HEAD`, so uncommitted work stays out of production.
- `maySpend` refuses cloud vendor writes outside production.

## Plan

### Phase 0 — Read the live state

Goal: know whether yuma is exposed today, and give every finding a row.
Done when: 0.2–0.6 each have a reading written under them, and anything red has its own step here
or a fix under way.

Steps 0.2–0.6 are on the production box: the owner runs them or approves each one.

- [x] 0.1 File the defects in `ISSUES.md`: one row per open step in Phases 1–4 that fixes a defect
  - `FJS-4109`–`FJS-4118`, for steps 1.1, 2.1, 1.3, 1.4, 1.6, 1.7, 1.8, 3.1, 3.4 and 4.1. Steps 1.5,
    3.2, 3.3 and 4.2 are inferred, and each gets a row once it is confirmed.
  - `FJS-4127`–`FJS-4132`, for steps 1.2, 1.5, 3.2, 3.3, 4.2 and 4.5: the inferred ones as
    "confirm, then fix".
- [x] 0.2 Read `hub.backup-recent` and `hub.key-escrowed` on `/hub/security/`
  - RED, 2026-11-08, `fli basecamp:posture yuma --basecamp yuma`: "No backup has ever finished", no
    copy of `ENCRYPTION_KEY` attested off the box, "The hub sends its archives to no bucket".
  - Droplet backups were off on 2026-11-04 (`IDEAS/machine-backups.md`) and have not been re-read.
- [x] 0.3 Read each live App's backup and replica destination, starting with kapp
  - RED: `app.backup-recent` reads "No app has a scheduled backup or drill" and `backup.replica-lag`
    "No app on this machine replicates". kapp's only copies are the ones its releases leave on yuma.
- [ ] 0.4 Read `/etc/outpost/litestream.yml` on yuma and compare it with the Apps that should replicate
- [ ] 0.5 Run the Basecamp-down drill: `docker stop frontier-basecamp`; my.kobami.com and the static
      sites still answer; `journalctl -u outpost` shows only heartbeat and report warnings;
      `docker start frontier-basecamp`; the Server row reads reachable again
- [ ] 0.6 Compare a digest of the laptop's `ENCRYPTION_KEY` with yuma's, printing digests only
  - Equal keys make step 3.4 urgent: the hub's signing key derives from it (`core/credentials.ts`).
- [x] 0.7 Read the same controls on `chartered`, the second live Basecamp, which runs ELA
  - RED, 2026-11-08: the same four readings as yuma. No hub backup, no attested key, no bucket, no
    app scheduled or replicating.
- [ ] 0.8 Get a copy off each box today: hub archive, `ENCRYPTION_KEY`, and each live App's data
- [ ] 0.9 Turn on standing off-box copies per `packages/basecamp/docs/backups.md`: a B2 destination,
      the hub's schedule and each live App's, then read 0.2 and 0.3 green on both Basecamps

### Phase 1 — Accidents Basecamp can cause on its own

Goal: an unattended sync, a Cleanup or an agent cannot remove what a live app depends on.
Done when: `cd packages/outpost && bun run test && bun run verify:docker` and
`cd packages/basecamp && bun run test && bun run verify:mcp` pass, each new refusal has a test row,
and `fli done` is clear.

- [x] 1.1 Outpost refuses a `/replicate` list that would empty a config holding entries, unless the
      call states `clear: true`
  - `jobs/replicate-sync.job.ts:85` builds `[]` for a machine with no `AppServer` rows, and the
    `online` transition (`api/src/app.ts:1096`) sends it with nobody asking. `replicate.js` accepts
    it and restarts the unit. The apps stay up and stop replicating, with no row left to alert on.
  - An empty list onto an empty config stays legal: that is a re-enrolled machine being filled.
    The refusal extends the rule `replicasFor` already keeps, that a machine is never sent a short list.
- [ ] 1.2 Only a person's change sends `clear`: a pointer cleared, a placement removed, a
      destination changed. The `online` transition and a release never do. A refusal raises a
      finding on the Server naming the entries the hub does not know
  - `clear` is sent (with `FJS-4109`, since 1.1 alone would refuse a person's own). The finding is
    left: a refusal today is only the failed `replicate:sync` job, carrying Outpost's sentence.
  - A person's change dropped by `unique` while a send is still pending loses its `clear`, is refused
    and leaves the old entries replicating until a later person's change. A running send whose list
    goes empty states `clear` itself (`syncReplicas`), so `online` and a release only start without
    it; that is lost if that send throws, because the retry starts from the job's data.
- [x] 1.3 Cleanup honors `keepImages`, per app, in place of `docker image prune -a`
  - `docker.js:2535` takes the value and never reads it, and `maintenance-runs.service.ts:461`
    defaults it to 3, so the screen's promise is false today.
- [x] 1.4 Cleanup leaves a stopped container that either deploy door labelled (`FJS-4112`)
  - `docker.js:2551` keeps only `_replaced`. Basecamp's own stop already removes its container, so
    what this sweep takes is an app stopped by hand.
- [x] 1.5 Drive a rollback whose image Cleanup removed, and make the failure name the cause
  - Inferred from the code, not run: a locally built image has no registry to come back from.
- [x] 1.6 Withhold destroy-class methods from `/mcp` agents, per Q3 (`FJS-4113`)
  - `NOT_FOR_AGENTS` (`domain/api-key/scopes.ts:42`) works per service and holds only `pages`.
    `agentGuard` and `narrowForAgent` own the refusal, so the per-method form extends that one set.
- [x] 1.7 `apps.remove` refuses the hub App, through `isHubApp` as `refuseHubRelease` does
- [x] 1.8 Add a posture control for an App with a data volume and no off-box copy (`FJS-4115`,
      `app.offbox-copy`)
  - `app.backup-recent` answers ok when no App has a schedule (`domain/host/posture.ts:654`), so an
    unprotected App grades clean.

### Phase 2 — Rolling back over a migrated database

Goal: no door starts an older image on a database it cannot serve without saying so.
Done when: a drive releases a non-additive migration, rolls back through each door, and reads the
outcome Q1 and Q2 chose; an additive one rolls back as it does today.

- [x] 2.1 Reproduce it: an older image on a database with a non-additive migration it lacks, with
      `/health` read during the failure (`FJS-4110`)
  - `litestone apply` looks only at pending files (`migrations.js:753`), and an applied record with
    no file is reported by `status()` and refused by nothing at boot. The journal check runs only in
    the deploy preflight; `_steps-rollback/` has none.
  - Boot half reproduced 2026-11-08 against `apply()` with no image: two files applied, the
    `DROP COLUMN` file deleted, and the second `apply` answered `refused: false`,
    `✓ all migrations already applied`, while `SELECT note` failed `no such column`. `/health`
    during the failure is still unread.
- [x] 2.2 Give each migration a class where it is authored, and record it in the journal row at apply
  - An older image cannot classify files it does not hold, so the database has to carry the answer.
    `classifyPivot` (`litestone/src/release.js`) compares two schemas, and `apply` has only SQL
    files, so authoring is the one moment both schemas are in hand. Unread: how `db:migrate` writes
    a file. A hand-written or unstamped migration reads as `unknown`, which counts as a contract.
  - Read 2026-11-08: `createAgainstHistory` writes the file and holds the declared schema, the
    introspected shadow and their `diffResult`, but no `.lite` for "before", so `classifyPivot`
    cannot run there as written. The stamp grades the diff, in `classifyPivot`'s words
    (`expand`, `contract`, `unknown`), and a table test holds the two to the same answers.
    `recordMigration` reads it from the file's header, which covers `apply`, `baseline` and
    `recordReplayed`. The journal needs a nullable `class` column, a NULL reading as `unknown`.
- [x] 2.3 Apply Q1 where a database boots, in Litestone's `apply`, with a stated override
  - `litestone migrate accept <file>` (`FJS-D2043`).
- [x] 2.4 Apply Q2 to the automatic put-back in `06-swap` and `swap.js`
  - A rollback or revert states no pivot and is put back as before, in all three doors: the
    target's migrations are already recorded, so a verdict on it says nothing about whether the
    failed container moved the database, and an image Q1 refused leaves the serving release
    untouched. D2044 says "every stop-first release", so this carve-out is owed a line there.
  - Unproved on a real box: the drive this phase's Done-when names has not run.

### Phase 3 — A hub that dies or returns wrong

Goal: an interrupted operation or a stale hub leaves an app running, or says exactly what to do.
Done when: each step's case has a test that kills or stales the hub at the named point.

- [x] 3.1 Finish an interrupted volume-restoring rollback, per Q4
  - `/stop` removes every container and the route (`deployment-run.job.ts:532`), and `startLive`
    exists only inside the job that died, so the app stays down.
  - Whether a restore began is known only to Outpost and reaches the hub as a reply a dead hub never
    gets (`volume_touched`), so Outpost writes it down durably and the hub reads it at the close.
- [x] 3.2 Confirm, then fix, a release marked `failed` while Outpost finishes it live
  - Confirmed by test: `rebind` queued the last success. It now skips while a release since then
    began a swap and did not succeed; the row stays `failed` and says the machine may have finished.
- [x] 3.3 Confirm, then guard, a stale hub dropping hostnames from Caddy at its next route push
  - Built per `FJS-D2045`. `verify:docker` proves the refusal on a real Caddy, which keeps serving
    the name. A refusal is a failed job until step 1.2's finding exists.
- [x] 3.4 Outside production, refuse an Outpost write to a non-loopback target, under the same
      `ALLOW_CLOUD_SPEND` that opens vendor writes
  - The guard sits on the vendor transport only, so a dev hub holding a restored yuma database and
    yuma's key is a fully authorized second hub.

### Phase 4 — Shipping and recovery, proved

Goal: a bad commit does not reach yuma unchecked, and a dead box has a rehearsed way back.
Done when: a Basecamp deploy obeys the Q5 gate, and a restore from real B2 onto a throwaway box
passes.

- [x] 4.1 Gate `fli deploy` of Basecamp on HEAD being pushed and `.cache/ci-last.txt` green for HEAD, per Q5
- [x] 4.2 Check the pre-migrate copy with `PRAGMA integrity_check`, and keep the first copy of a
      failing run when `PRE_MIGRATE_KEEP` rotates
  - Inferred: a crash loop can rotate out the only clean copy (`domain/backup/pre-migrate.ts`).
  - Built, `FJS-4131`: each copy passes `integrity_check` or the boot stops, and prune keeps the
    oldest copy carrying the failing run's mark.
- [ ] 4.3 Restore from real B2 onto a throwaway box
  - The same proof as `IDEAS/basecamp-reinstall.md` 2.2 and `IDEAS/backups.md` 5.5: one run closes
    all three.
- [ ] 4.4 Write the runbook cases "hub dead, apps up", "yuma dead" and "Outpost dead"
  - Lands as `IDEAS/basecamp-reinstall.md` Phase 4, which is still open.
- [x] 4.5 Re-probe `FJS-3179` and `FJS-D1375`: the code appears to have built what both ask for
  - Built: restore by `backupId` over a pre-signed GET (`FJS-D1521`), the clock is `App.backupCron`
    (`FJS-D1606`). What is left is a screen for a non-hub app's cron, `FJS-4135`.

## Open questions

`decision-rules` ran on these 2026-11-08 and Q1, Q2 and Q4 carry its changes. The prior art Q1
and Q2 were ruled against is § Prior art.

- ~~**Q1 — An older image starting on a database with a non-additive migration it lacks.**~~ **Answered 2026-11-08 (`FJS-D2041`): D — Litestone refuses at boot only when a recorded migration with no file is classed non-additive or unknown (step 2.2).**
  - **A** — `fli deploy:rollback` and the App rollback stop, name the copy taken before the
    migration, and go ahead only with that copy restored or an explicit override.
  - **B** — Litestone refuses at boot whenever a recorded migration has no file.
  - **C** — document it.
  - **D** — Litestone refuses at boot only when a recorded migration with no file is classed
    non-additive or unknown (step 2.2).
  - **Recommend D** — the database boot is the one owner every door passes, a hand-run `docker run`
    included, and it already refuses an edited migration (`FJS-3578`). A leaves that door open. B
    also blocks rollback after an additive migration and an old container's restart during a
    start-first swap, both safe today. Reopen A if authoring cannot stamp the class.
- ~~**Q2 — The automatic put-back after a failed non-additive release.**~~ **Answered 2026-11-08 (`FJS-D2042`): A — restore the copy only when it is exact, otherwise stay down and alert.**
  - **A** — restore the copy only when it is exact, otherwise stay down and alert.
  - **B** — start the old container on the migrated database, as today, and alert.
  - **C** — always stay down and alert.
  - **Recommend A** — one rule, derived from when the copy was taken. Basecamp's pre-migrate copy is
    taken with the old container already stopped, so it is exact; an App's `Back up volume` runs
    while the old container still serves, so it is not. `restoreFailed` already draws the same line.
- ~~**Q3 — Which methods an agent loses.**~~ **Answered 2026-11-08 (`FJS-D2038`): A — `servers.destroy`, `apps.remove`, `volumes.remove`, `volumes.prune`, `servers.discardArchive`, `servers.retireApp`, `maintenanceRuns.run` and `recipes.run`.**
  - **A** — `servers.destroy`, `apps.remove`, `volumes.remove`, `volumes.prune`,
    `servers.discardArchive`, `servers.retireApp`, `maintenanceRuns.run` and `recipes.run`.
  - **B** — only the first four.
  - **C** — keep them, and have an owner approve each call.
  - **Recommend A** — sessions drive Basecamp over `/mcp`, and each of these has a screen for a
    person.
- ~~**Q4 — An interrupted volume-restoring rollback.**~~ **Answered 2026-11-08 (`FJS-D2039`): B — at the interrupted run's close the hub starts the live release again if the restore never began, and otherwise leaves the app stopped and names the copy.**
  - **A** — Outpost keeps the stopped container until the restore finishes.
  - **B** — at the interrupted run's close the hub starts the live release again if the restore
    never began, and otherwise leaves the app stopped and names the copy.
  - **Recommend B** — it is the rule `restoreFailed` already applies, given Outpost's durable record
    of whether the restore began (step 3.1). Under A, `reconcile` would start the kept container on
    a volume a restore had half written.
- ~~**Q5 — How hard the deploy gate is.**~~ **Answered 2026-11-08 (`FJS-D2040`): A — refuse, with a named override that prints what it skipped.**
  - **A** — refuse, with a named override that prints what it skipped.
  - **B** — warn.
  - **Recommend A** — concurrent sessions share this tree and a commit can land between a check and
    a deploy, so the check belongs in the deploy.
- ~~**FJS-D2043 — How does an operator state the override when `apply()` refuses a recorded migration with no file?**~~ **Answered 2026-11-09 (`FJS-D2043`): B — `litestone migrate accept <file>`, a one-shot act on the journal row beside `baseline()`. It sets a separate acceptance column and keeps the class, is refused if the row is absent or the file present, and clears when the file reappears. The refusal prints the command.** Step 2.3 says "with a stated override" and `FJS-D2041` names none. The refusal is at boot, inside the older image, so a flag on a deploy command cannot reach it. The test that is red today: apply two files, delete the `DROP COLUMN` one, apply again, and expect `refused: true`; it answers `✓ all migrations already applied`.
  - **A** — an environment variable naming the exact recorded files, read in `apply()`. It reaches every door with no tool in the image, and it is a second origin that stays set until someone removes it.
  - **B** — `litestone migrate accept <file>`, a one-shot act on the journal row beside `baseline()`. It sets a separate acceptance column and keeps the class, is refused if the row is absent or the file present, and clears when the file reappears. The refusal prints the command.
  - **C** — an `apply(db, dir, { acceptMissing })` option and a CLI flag. Basecamp's `app.ts:140` call and the `db:migrate` script are baked into the image being booted, so neither can pass it.
  - **Recommend B** — the act is on the database, so a restart and a hand-run `docker run` agree, and `baseline` is the same shape; the paper's prior art has Prisma's `migrate resolve` as the nearest. Two costs: `apply()` also runs per tenant (`tenant.js:578`), so the act must walk tenants, and it needs the CLI inside the image. Whether Basecamp's image ships the CLI is unread (its boot calls `apply()` directly, `deploy/Dockerfile:94`); if it does not, take A with exact filenames.
- ~~**FJS-D2044 — What tells the automatic put-back a failed release was non-additive, and how does it find the one exact copy?**~~ **Answered 2026-11-09 (`FJS-D2044`): A — the release's verdict. Run `livePivot` on every stop-first release in both doors, and take `pivot` into `stopFirst`. On `contract` or `unknown`, after a container that started and failed health, stay down: remove the failed container, keep `_replaced` stopped, and throw with `stayedDown`. A verdict never reached (an image with no Litestone CLI or no schema) puts back as today. The copy names its database, and the swap restores only one newer than the moment the old container stopped.** `FJS-D2042` needs both, and neither exists at the swap. A release asked as stop-first computes no verdict: `server.js:228` calls `docker.pivot` only for a start-first request, `chooseSwap` returns early the same way, and only `fli deploy`'s `04c-journal` holds one (`$.config.pivot`, absent with the journal off). The exact copy is `pre-migrate/<stamp>.db` beside the hub's database, and its name does not say which database it copies, which neither swap driver knows.
  - **A** — the release's verdict. Run `livePivot` on every stop-first release in both doors, and take `pivot` into `stopFirst`. On `contract` or `unknown`, after a container that started and failed health, stay down: remove the failed container, keep `_replaced` stopped, and throw with `stayedDown`. A verdict never reached (an image with no Litestone CLI or no schema) puts back as today. The copy names its database, and the swap restores only one newer than the moment the old container stopped.
  - **B** — the journal. After the failure, read the volume's journal with a throwaway run of the new image, and stay down only if this release recorded a `contract` or `unknown` row. It alone tells *migrated* from *failed before migrating*, needs step 2.2's stamp, and costs a container run inside the outage. Restore as in A.
  - **C** — `FJS-D2041` alone. Start the old container as today and let its own boot refuse, then stop it so `--restart unless-stopped` does not loop. No verdict, no restore, and an image built before the stamp boots unguarded. This reopens `FJS-D2042`.
  - **Recommend A** — it reads the verdict both doors already name and needs no new reader during an outage, and `swapFor` already counts `unknown` as a contract. The cost is staying down on a non-additive release that failed before it migrated, and one classifier run per release (`PIVOT_TIMEOUT_MS` is its bound).
- ~~**FJS-D2045 — How does a route push tell a stale hub from a person removing a Domain, so a restored hub cannot drop a hostname it never knew?**~~ **Answered 2026-11-09 (`FJS-D2045`): A — the hub names what it removes. `/route`, `/deploy` and `/static/activate` carry `removing: [...]`, derived by one helper all three doors call from this App's soft-deleted Domains, its soft-deleted DomainRoutes, and any soft-deleted Domain its DomainRoutes point at (`Domain` is plain `@@softDelete`, so a deleted Domain leaves another App's route row live). `DomainRoute` gains `@@softDelete`, with `@@unique([domainId, pathPrefix], where: deletedAt == null)` so a removed prefix can be added again; it is hard-deleted today (`domain-routes.service.ts:102`) and leaves nothing to name. `ingress.route`, and the `unroute` that `/route` calls with nothing left to route, refuse to drop a live host or path route the list does not name, comparing the union of hosts, redirects and path routes (host plus prefix) so a Domain turning into a redirect is no drop. `/deploy` checks beside `heldBy` (`server.js:213`), since it routes only during the swap and a refusal there would land mid-release. A restored hub holds no tombstone for a hostname added after its archive. This is `FJS-4109`'s rule for `/replicate`, as a list because a boolean cannot state a partial drop. It leaves two gaps: a hostname deleted before the archive and re-added after it is still dropped, and a Domain deleted after the archive comes back on the machine. A refusal needs step 1.2's finding, which must offer a person's way to send `removing`, or it surfaces only as a failed job.** Step 3.3's confirmation. `ingress.route` replaces the app's host list whole (`ingress.js:463`), so the two arrive as the same shorter list. Run against an in-memory Caddy on 2026-11-09: route `['old', 'added-since']`, then route `['old']`, and `added-since` is gone where a guard must refuse. No person is needed: a Server entering or leaving `online` runs `pushAppsOn` with `actor: null` (`app.ts:1099`), and `/deploy` and `/static/activate` send the same list.
  - **A** — the hub names what it removes. `/route`, `/deploy` and `/static/activate` carry `removing: [...]`, derived by one helper all three doors call from this App's soft-deleted Domains, its soft-deleted DomainRoutes, and any soft-deleted Domain its DomainRoutes point at (`Domain` is plain `@@softDelete`, so a deleted Domain leaves another App's route row live). `DomainRoute` gains `@@softDelete`, with `@@unique([domainId, pathPrefix], where: deletedAt == null)` so a removed prefix can be added again; it is hard-deleted today (`domain-routes.service.ts:102`) and leaves nothing to name. `ingress.route`, and the `unroute` that `/route` calls with nothing left to route, refuse to drop a live host or path route the list does not name, comparing the union of hosts, redirects and path routes (host plus prefix) so a Domain turning into a redirect is no drop. `/deploy` checks beside `heldBy` (`server.js:213`), since it routes only during the swap and a refusal there would land mid-release. A restored hub holds no tombstone for a hostname added after its archive. This is `FJS-4109`'s rule for `/replicate`, as a list because a boolean cannot state a partial drop. It leaves two gaps: a hostname deleted before the archive and re-added after it is still dropped, and a Domain deleted after the archive comes back on the machine. A refusal needs step 1.2's finding, which must offer a person's way to send `removing`, or it surfaces only as a failed job.
  - **B** — compare-and-set. The hub sends the list it last pushed and Outpost refuses when the live list differs. It also catches the resurrection A leaves. It adds a third list beside Domain rows and Caddy, and a push that applied but never committed on the hub refuses until someone clears it.
  - **C** — a restored hub holds every route push until a person confirms, owned by `hub-restore.ts`. The Litestream and `--from-backup` runbook doors (`docs/backups.md:236,263`) never pass through it, so those restores are unguarded.
  - **D** — a fencing counter on every hub write, refused when older than the highest Outpost has seen. It stops every push from a restored hub, including a release, until the counter is bumped, and that bump is what removes the fence.
  - **E** — a runbook step and no code. The push is automatic, so a step cannot get ahead of it.
  - **Recommend A** — it is the refusal `/replicate` already has, and a stale hub cannot name what it never knew. Confidence 2 of 3: the tombstone derivation and the `/deploy` preflight are neither built nor driven. Take B if a resurrected Domain turns out to matter as much as a dropped one.

## Prior art

For Q1 and Q2, read 2026-11-08 from vendor docs; "secondary" marks a claim not in the docs.

- A recorded migration with no file: Flyway's `validate`, run by every `migrate`, fails one older
  than the newest local file (*missing*) and ignores a newer one (*future*, `ignoreMigrationPatterns`
  defaults to `*:future`). Rails lists it as `NO FILE` in `db:migrate:status` and boots (secondary);
  Django ignores it (secondary); Liquibase's `unexpected-changesets` reports it. None refuses at
  boot by what the migration did, so D is stricter than all of them.
- Classifying a migration: Atlas lint (`destructive` fails CI; `incompatible` and `data_depend` warn
  unless `error = true`) and strong_migrations (`safety_assured` to override) classify at authoring
  time. Neither stores the class with the applied record, so step 2.2's stamp has no precedent.
- An automatic rollback's schema: Kamal, Capistrano, Flyway, Rails and Django leave it alone; Prisma
  refuses further migrations until `migrate resolve`; Atlas `migrate down` refuses a destructive
  reverse plan. No tool restores a data copy automatically, so Q2's A has no precedent, and C is
  the closest to Prisma and Atlas.
- What A's restore discards: a non-additive pivot always swaps stop-first, and stop-first moves the
  route only after the new container answers (`swap.js` `stopFirst`), so no request reaches a
  release that fails health. The restore drops only the new image's own writes: the migration and
  any job it runs at boot.
- For `FJS-D2045`, read 2026-11-09 from search summaries and not vendor source. Kubernetes
  [server-side apply](https://www.kubernetes.io/docs/reference/using-api/server-side-apply/): a
  field the applier omits is removed only when no other manager owns it, which is A's property.
  Client-side `kubectl apply` deletes only what the last apply recorded and keeps what it did not
  ([KubeCon 2017 slides](https://raw.githack.com/mm-k8s-ug/kubecon-slides/master/slides/2017-kubecon-na/kubectl%20apply,%20and%20The%20Dark%20Art%20of%20Declarative%20Object%20Management%20%5BI%5D%20-%20Aaron%20Levy,%20CoreOS%20-%20kubectl%20apply.pdf),
  secondary). That record sits on the live object, so a stale manifest still deletes, which is why
  A's record is the hub's own tombstones. Terraform's
  [`state push`](https://developer.hashicorp.com/terraform/cli/commands/state/push) refuses a lower
  serial or a different lineage, with `-force` to override: D's shape, for many possible writers.

## Outside this plan

- Static Apps go down for seconds on an Outpost restart, because the Outpost process serves them
  (`FJS-D345`).
- Moving an enrolled machine's Outpost version is `FJS-3533` and `FJS-D1650`.
- `hub.ingress-zone` reads red on yuma and chartered: an App served under Basecamp's own domain
  could set a cookie Basecamp receives (`FJS-4160`). It matters once an untrusted App is served
  there.
- `outpost-uninstall --purge` stays: nothing in the hub API can run it, and it asks for a typed
  confirmation at a terminal.
