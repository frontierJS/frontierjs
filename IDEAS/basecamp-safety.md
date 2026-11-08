---
id: basecamp-safety
status: proposed
dated: 2026-11-08
---

# Idea — keep working on Basecamp without endangering the apps it runs

**Status: PROPOSED. Nothing built, Q1–Q5 open.** Probed against the tree 2026-11-08 by reading
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

- [ ] 1.1 Outpost refuses a `/replicate` list that would empty a config holding entries, unless the
      call states `clear: true`
  - `jobs/replicate-sync.job.ts:85` builds `[]` for a machine with no `AppServer` rows, and the
    `online` transition (`api/src/app.ts:1096`) sends it with nobody asking. `replicate.js` accepts
    it and restarts the unit. The apps stay up and stop replicating, with no row left to alert on.
  - An empty list onto an empty config stays legal: that is a re-enrolled machine being filled.
    The refusal extends the rule `replicasFor` already keeps, that a machine is never sent a short list.
- [ ] 1.2 Only a person's change sends `clear`: a pointer cleared, a placement removed, a
      destination changed. The `online` transition and a release never do. A refusal raises a
      finding on the Server naming the entries the hub does not know
- [ ] 1.3 Cleanup honors `keepImages`, per app, in place of `docker image prune -a`
  - `docker.js:2535` takes the value and never reads it, and `maintenance-runs.service.ts:461`
    defaults it to 3, so the screen's promise is false today.
- [ ] 1.4 Cleanup leaves a stopped container that either deploy door labelled
  - `docker.js:2551` keeps only `_replaced`. Basecamp's own stop already removes its container, so
    what this sweep takes is an app stopped by hand.
- [ ] 1.5 Drive a rollback whose image Cleanup removed, and make the failure name the cause
  - Inferred from the code, not run: a locally built image has no registry to come back from.
- [ ] 1.6 Withhold destroy-class methods from `/mcp` agents, per Q3
  - `NOT_FOR_AGENTS` (`domain/api-key/scopes.ts:42`) works per service and holds only `pages`.
    `agentGuard` and `narrowForAgent` own the refusal, so the per-method form extends that one set.
- [ ] 1.7 `apps.remove` refuses the hub App, through `isHubApp` as `refuseHubRelease` does
- [ ] 1.8 Add a posture control for an App with a data volume and no off-box copy
  - `app.backup-recent` answers ok when no App has a schedule (`domain/host/posture.ts:654`), so an
    unprotected App grades clean.

### Phase 2 — Rolling back over a migrated database

Goal: no door starts an older image on a database it cannot serve without saying so.
Done when: a drive releases a non-additive migration, rolls back through each door, and reads the
outcome Q1 and Q2 chose; an additive one rolls back as it does today.

- [ ] 2.1 Reproduce it: an older image on a database with a non-additive migration it lacks, with
      `/health` read during the failure
  - `litestone apply` looks only at pending files (`migrations.js:753`), and an applied record with
    no file is reported by `status()` and refused by nothing at boot. The journal check runs only in
    the deploy preflight; `_steps-rollback/` has none.
- [ ] 2.2 Give each migration a class where it is authored, and record it in the journal row at apply
  - An older image cannot classify files it does not hold, so the database has to carry the answer.
    `classifyPivot` (`litestone/src/release.js`) compares two schemas, and `apply` has only SQL
    files, so authoring is the one moment both schemas are in hand. Unread: how `db:migrate` writes
    a file. A hand-written or unstamped migration reads as `unknown`, which counts as a contract.
- [ ] 2.3 Apply Q1 where a database boots, in Litestone's `apply`, with a stated override
- [ ] 2.4 Apply Q2 to the automatic put-back in `06-swap` and `swap.js`

### Phase 3 — A hub that dies or returns wrong

Goal: an interrupted operation or a stale hub leaves an app running, or says exactly what to do.
Done when: each step's case has a test that kills or stales the hub at the named point.

- [ ] 3.1 Finish an interrupted volume-restoring rollback, per Q4
  - `/stop` removes every container and the route (`deployment-run.job.ts:532`), and `startLive`
    exists only inside the job that died, so the app stays down.
  - Whether a restore began is known only to Outpost and reaches the hub as a reply a dead hub never
    gets (`volume_touched`), so Outpost writes it down durably and the hub reads it at the close.
- [ ] 3.2 Confirm, then fix, a release marked `failed` while Outpost finishes it live
  - Traced to `release-record.ts:62`; that a later `rebind` starts the older image is inferred.
- [ ] 3.3 Confirm, then guard, a stale hub dropping hostnames from Caddy at its next route push
  - Traced to `/route`; the host-list replacement inside `ingress.route` is unread.
- [ ] 3.4 Outside production, refuse an Outpost write to a non-loopback target, under the same
      `ALLOW_CLOUD_SPEND` that opens vendor writes
  - The guard sits on the vendor transport only, so a dev hub holding a restored yuma database and
    yuma's key is a fully authorized second hub.

### Phase 4 — Shipping and recovery, proved

Goal: a bad commit does not reach yuma unchecked, and a dead box has a rehearsed way back.
Done when: a Basecamp deploy obeys the Q5 gate, and a restore from real B2 onto a throwaway box
passes.

- [ ] 4.1 Gate `fli deploy` of Basecamp on HEAD being pushed and `.cache/ci-last.txt` green for HEAD, per Q5
- [ ] 4.2 Check the pre-migrate copy with `PRAGMA integrity_check`, and keep the first copy of a
      failing run when `PRE_MIGRATE_KEEP` rotates
  - Inferred: a crash loop can rotate out the only clean copy (`domain/backup/pre-migrate.ts`).
- [ ] 4.3 Restore from real B2 onto a throwaway box
  - The same proof as `IDEAS/basecamp-reinstall.md` 2.2 and `IDEAS/backups.md` 5.5: one run closes
    all three.
- [ ] 4.4 Write the runbook cases "hub dead, apps up", "yuma dead" and "Outpost dead"
  - Lands as `IDEAS/basecamp-reinstall.md` Phase 4, which is still open.
- [ ] 4.5 Re-probe `FJS-3179` and `FJS-D1375`: the code appears to have built what both ask for

## Open questions

`decision-rules` ran on these 2026-11-08 and Q1, Q2 and Q4 carry its changes. Prior art for Q1 and
Q2 is still owed before either is ruled.

- **Q1 — An older image starting on a database with a non-additive migration it lacks.**
  **A** — `fli deploy:rollback` and the App rollback stop, name the copy taken before the migration,
  and go ahead only with that copy restored or an explicit override. **B** — Litestone refuses at
  boot whenever a recorded migration has no file. **C** — document it. **D** — Litestone refuses at
  boot only when a recorded migration with no file is classed non-additive or unknown (step 2.2).
  **Recommend D** — the database boot is the one owner every door passes, a hand-run `docker run`
  included, and it already refuses an edited migration (`FJS-3578`). A leaves that door open. B also
  blocks rollback after an additive migration and an old container's restart during a start-first
  swap, both safe today. Reopen A if authoring cannot stamp the class.
- **Q2 — The automatic put-back after a failed non-additive release.**
  **A** — restore the copy only when it is exact, otherwise stay down and alert. **B** — start the
  old container on the migrated database, as today, and alert. **C** — always stay down and alert.
  **Recommend A** — one rule, derived from when the copy was taken. Basecamp's pre-migrate copy is
  taken with the old container already stopped, so it is exact; an App's `Back up volume` runs while
  the old container still serves, so it is not. `restoreFailed` already draws the same line.
- **Q3 — Which methods an agent loses.** **A** — `servers.destroy`, `apps.remove`, `volumes.remove`,
  `volumes.prune`, `servers.discardArchive`, `servers.retireApp`, `maintenanceRuns.run` and
  `recipes.run`. **B** — only the first four. **C** — keep them, and have an owner approve each call.
  **Recommend A** — sessions drive Basecamp over `/mcp`, and each of these has a screen for a person.
- **Q4 — An interrupted volume-restoring rollback.** **A** — Outpost keeps the stopped container
  until the restore finishes. **B** — at the interrupted run's close the hub starts the live release
  again if the restore never began, and otherwise leaves the app stopped and names the copy.
  **Recommend B** — it is the rule `restoreFailed` already applies, given Outpost's durable record
  of whether the restore began (step 3.1). Under A, `reconcile` would start the kept container on a
  volume a restore had half written.
- **Q5 — How hard the deploy gate is.** **A** — refuse, with a named override that prints what it
  skipped. **B** — warn. **Recommend A** — concurrent sessions share this tree and a commit can land
  between a check and a deploy, so the check belongs in the deploy.

## Outside this plan

- Static Apps go down for seconds on an Outpost restart, because the Outpost process serves them
  (`FJS-D345`).
- Moving an enrolled machine's Outpost version is `FJS-3533` and `FJS-D1650`.
- `outpost-uninstall --purge` stays: nothing in the hub API can run it, and it asks for a typed
  confirmation at a terminal.
