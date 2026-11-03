# Basecamp core review — 2026-11-02

Read-only. Five reviewers (deploy, Outpost, auth/trust, monitoring/alerting, backups).
Workbench wing excluded. Paths: `basecamp/…` = packages/basecamp/api/src unless rooted;
`outpost/…` = packages/outpost/src. Filed 2026-11-02 as FJS-3842–FJS-3902 (D3+O4 and D8+O3 share a row; A9 is by design and not filed).
✔ = re-read by the main thread; R = reproduced by a run; T = traced by a reviewer; P = plausible, needs a run.

## Deploy pipeline

| # | Sev | Finding | Where | Conf |
|---|-----|---------|-------|------|
| D1 · [FJS-3842](../../../ISSUES.md#fjs-3842) | HIGH | `git fetch … origin <branch>` has no `--`; app-source accepts any branch/repo string → `--upload-pack=…` runs on the host as Outpost; a local-path repo reads another App's clone | outpost/docker.js:783, basecamp/domain/release/app-source.ts:143-152 | ✔ P |
| D2 · [FJS-3848](../../../ISSUES.md#fjs-3848) | HIGH | Cancel only writes `cancelled`; the job never re-checks, and `finishRun` returning `cancelled` is ignored → container still swaps, DNS moves, DeploySuccess sent | services/deployments/deployments.service.ts:299-311, jobs/deployment-run.job.ts:276-289, domain/release/release-record.ts:98-102 | ✔ T |
| D3 · [FJS-3849](../../../ISSUES.md#fjs-3849) | HIGH | Two releases of one App run at once: no in-flight check on `create`, no unique dispatch key, `deployments` queue concurrency 3, no per-app lock in Outpost | deployments.service.ts:203-246, api/config/junction.config.js:50, outpost/docker.js:516-534 | T |
| D4 · [FJS-3850](../../../ISSUES.md#fjs-3850) | HIGH | Crash mid-deploy replays the whole release: caravan reclaims `running`→`pending` ignoring max_attempts; `startRelease` accepts `building` | caravan/src/db.ts:889-897, release-record.ts:48 | T |
| D5 · [FJS-3851](../../../ISSUES.md#fjs-3851) | HIGH | Multi-placement App released to the first reachable machine only; others keep serving old version | providers/executor.ts:216-219, deployment-run.job.ts:283 | T — owner call |
| D6 · [FJS-3861](../../../ISSUES.md#fjs-3861) | MED | No reaper for `pending`/`building` releases; a stuck one blocks `rebind` forever; `queueRelease` writes are non-atomic | deployments.service.ts:137-154, 268 | T |
| D7 · [FJS-3852](../../../ISSUES.md#fjs-3852) | MED | Post-success work (`markRunning`, `toZones`, `syncReplicasOn`) inside the failure try → `failDeploy` on a success row throws, no notification, placement never marked | deployment-run.job.ts:283-289 | ✔ T |
| D8 · [FJS-3853](../../../ISSUES.md#fjs-3853) | MED | Basecamp's Health check step runs after Outpost already removed the old container → a failure has nothing to roll back to | outpost/docker.js:937, deployment-run.job.ts:428-441 | T |
| D9 · [FJS-3862](../../../ISSUES.md#fjs-3862) | MED | Rollback doesn't check `target.appId === being.appId` or that `being` is latest; `previousDeploymentId` writable on create → can ship another App's configSnapshot (secrets decrypted) | deployments.service.ts:135, 363-380, domain/release/variables.ts:60-69 | T/P |
| D10 · [FJS-3863](../../../ISSUES.md#fjs-3863) | MED | `patch` lets a USER rewrite `builtImage`, `commitSha`, `branch`, timings — should be `@system` | deployments.service.ts:282-294, db/schema.lite:2290-2306 | T |
| D11 · [FJS-3864](../../../ISSUES.md#fjs-3864) | MED | Rollback runs the old image on a volume the newer image migrated forward | deployments.service.ts:427-433 | P — owner call |
| D12 · [FJS-3882](../../../ISSUES.md#fjs-3882) | LOW | Rollback not atomic (withdraw, then create replacement) | deployments.service.ts:401-440 | T |
| D13 · [FJS-3883](../../../ISSUES.md#fjs-3883) | LOW | `/static/activate` uses conduit's 10s default timeout | deployment-run.job.ts:508-519 | P |
| D14 · [FJS-3884](../../../ISSUES.md#fjs-3884) | LOW | `allocatePort` read-then-write, no unique constraint | domain/release/host-port.ts | P |

## Outpost

| # | Sev | Finding | Where | Conf |
|---|-----|---------|-------|------|
| O1 · [FJS-3843](../../../ISSUES.md#fjs-3843) | HIGH | `_headers` `*` → `.*` regex: catastrophic backtracking (40-char path = 35s). Static origin shares the event loop with the command port → one anonymous GET freezes heartbeats and deploys | outpost/serve.js:55-61, 78; index.js:46-48 | ✔ R |
| O2 · [FJS-3844](../../../ISSUES.md#fjs-3844) | HIGH | `holdersOf` ignores docker's exit code → daemon hiccup = "no holders" → `rm -rf` of a live app's data dir; `volumes()` reports everything `in_use:false` | outpost/docker.js:1583-1598, 1620, 1640 | ✔ T |
| O3 · [FJS-3853](../../../ISSUES.md#fjs-3853) | MED-HIGH | No healthCheck → first attempt checks `State.Running` once, no sleep; container dying 2s later reads healthy and `_replaced` is `rm -f`'d | outpost/docker.js:466, 480-483, 927-931 | T |
| O4 · [FJS-3849](../../../ISSUES.md#fjs-3849) | MED | No per-app lock: concurrent `/deploy` can delete the other's new container and report success with the wrong digest; same for `/stop`, `/volume/restore`, `/replica/restore` | outpost/server.js:163-215, docker.js:912-931 | T/P |
| O5 · [FJS-3854](../../../ISSUES.md#fjs-3854) | MED | `docker container prune -f` removes `_replaced` containers, including one inside a deploy's health window | outpost/docker.js:1695-1697 | ✔ T |
| O6 · [FJS-3865](../../../ISSUES.md#fjs-3865) | MED | SIGTERM exits immediately, no drain; no startup reconcile → a kill mid-swap leaves the app stopped until a redeploy | outpost/index.js:51-55, 64-70 | T |
| O7 · [FJS-3866](../../../ISSUES.md#fjs-3866) | MED | No `maxRequestBodySize`; well-formed forged headers make the server buffer the whole body (Bun default ~128 MB); command port open to all | outpost/server.js:410-413, index.js:30-38 | T — remainder of FJS-1861 |
| O8 · [FJS-3867](../../../ISSUES.md#fjs-3867) | MED | Heartbeat `fetch` has no timeout; a Basecamp that accepts TCP and hangs stops every heartbeat | outpost/report.js:43-60, 113-117 | P |
| O9 · [FJS-3868](../../../ISSUES.md#fjs-3868) | LOW-MED | App env passed as `-e KEY=value` in argv → secrets visible in /proc/*/cmdline | outpost/docker.js:885 | T |
| O10 · [FJS-3885](../../../ISSUES.md#fjs-3885) | LOW | Analytics reads + gunzips whole log files before the line cap | outpost/analytics.js:186-188 | T |
| O11 · [FJS-3886](../../../ISSUES.md#fjs-3886) | LOW | `/route` swallows `checkAppId`'s throw; static branches validate nothing; app-id prefix matching (`fjs-a-path-` matches `a-path-0`) | outpost/server.js:243-320, ingress.js:290-323 | T |
| O12 · [FJS-3887](../../../ISSUES.md#fjs-3887) | LOW | Failed static write leaves `sha256:<d>.partial.*` listed as a release | outpost/static.js:200, 249-258 | T |
| O13 · [FJS-3888](../../../ISSUES.md#fjs-3888) | LOW | `stop()` answers `stopped:false` on rm failure, route removed anyway | outpost/docker.js:1002-1005 | T |
| O14 · [FJS-3889](../../../ISSUES.md#fjs-3889) | LOW | `/health-check` port unvalidated (`80@other` → userinfo → another host) | outpost/docker.js:467-471 | T |
| O15 · [FJS-3890](../../../ISSUES.md#fjs-3890) | LOW | Nonce store in memory; restart allows replay inside 300s (needs pinned-TLS break) | outpost/server.js:81 | T |

## Auth and trust

| # | Sev | Finding | Where | Conf |
|---|-----|---------|-------|------|
| A1 · [FJS-3845](../../../ISSUES.md#fjs-3845) | HIGH | `Server.providerKind/providerId/providerServerId` (and `sshKeyId`) are caller-writable → a member in workspace A points a Server at B's provider Secret + droplet id → `sync` reads with B's token; admin `destroy` deletes B's droplet | db/schema.lite:1362-1364, services/servers/servers.service.ts:269-290, 455-468, 749-790, providers/compute/index.ts:322, services/server-postures/server-postures.service.ts:56-59 | ✔ T |
| A2 · [FJS-3869](../../../ISSUES.md#fjs-3869) | MED | API key's workspace binding skipped on `workspaces/<id>`: a key minted in A, held by B's owner, can patch/remove/setMemberRole on B (no escalation beyond the person, but breaks key scoping) | core/hooks.ts:86, 91, domain/api-key/scopes.ts:145-147 | T |
| A3 · [FJS-3870](../../../ISSUES.md#fjs-3870) | MED | Invited email can be registered by anyone who knows it, without the token → invitee locked out; attacker may link SSO/TOTP | core/session-auth.ts:169-175, services/invitations/invitations.service.ts:315-317 | P |
| A4 · [FJS-3860](../../../ISSUES.md#fjs-3860) | MED | Outside production: unauthenticated `DELETE /setup` wipes accounts; `HOST` defaults `0.0.0.0`; placeholder `ENCRYPTION_KEY` allowed → derivable hub signing key → anyone signs commands to enrolled Outposts. Image is safe (NODE_ENV=production) | app.ts:884-899, core/env.ts, core/db.ts:94, core/credentials.ts | ✔ T |
| A5 · [FJS-3891](../../../ISSUES.md#fjs-3891) | LOW | Destroyed/removed Server keeps `outpostPublicKey`; heartbeats still accepted | app.ts:966, core/hooks.ts:597 | P |
| A6 · [FJS-3892](../../../ISSUES.md#fjs-3892) | LOW | `/ws/stream` refuses only `apiKey`; peer scopes and suspended-workspace check not applied | plugins/machine-stream.ts | P |
| A7 · [FJS-3893](../../../ISSUES.md#fjs-3893) | LOW | `variables.reveal` under an Idempotency-Key caches plaintext 24h | services/variables/variables.service.ts:66-70 | P — owner call (recommend refuse the header) |
| A8 · [FJS-3894](../../../ISSUES.md#fjs-3894) | LOW | Git push dedupe on unsigned `X-GitHub-Delivery` → replay redeploys same commit | plugins/git-push.ts | P |
| A9 | LOW | Two concurrent `/setup` POSTs can both create SYSADMINs; first to reach an unclaimed box claims it | app.ts:826-866 | by design |

## Monitoring and alerting

| # | Sev | Finding | Where | Conf |
|---|-----|---------|-------|------|
| M1 · [FJS-3855](../../../ISSUES.md#fjs-3855) | HIGH | All monitoring crons share the `default` queue (concurrency 2) with `site:preview` (timeout 91 min) and `site:ask` → two previews stop all probing/alerting; monitoring crons have no timeout | api/config/junction.config.js:49, jobs/site-preview.job.ts:29, jobs.snapshot.md | ✔ T |
| M2 · [FJS-3856](../../../ISSUES.md#fjs-3856) | HIGH | `lastDeliveryAt` stamp writes with `version` on an `@version` model → stale write throws when two monitors share a channel in one sweep → later channels skipped; in alert-evaluate the whole rule loop aborts and the retry re-notifies no one | domain/notification/delivery.ts:255-258, jobs/alert-evaluate.job.ts:86 | ✔ T |
| M3 · [FJS-3857](../../../ISSUES.md#fjs-3857) | HIGH | Channel delivery: one attempt, no retry, only `console.error`; failure recorded nowhere; `email` channel always fails "needs a mailer" | delivery.ts:155, 168-171, 250 | T |
| M4 · [FJS-3858](../../../ISSUES.md#fjs-3858) | HIGH | State moves before notify: a throw after `transition`/`loseContact` leaves the row `down`/`unreachable` with nobody told, permanently; no per-item catch in server-reachability | jobs/monitor-sweep.job.ts:113-158, jobs/server-reachability.job.ts:53-77 | T |
| M5 · [FJS-3871](../../../ISSUES.md#fjs-3871) | MED-HIGH | Cron unique key is per-minute, so a slow sweep overlaps the next → duplicate probes and duplicate resend pages | caravan/src/index.ts:720-735, monitor-sweep.job.ts:113-118 | T |
| M6 · [FJS-3872](../../../ISSUES.md#fjs-3872) | MED | After a Basecamp outage >120s, the first sweep marks the whole fleet unreachable and notifies everyone; no `ServerReachable` recovery kind | jobs/server-reachability.job.ts:37, domain/notification/kinds.ts | T |
| M7 · [FJS-3873](../../../ISSUES.md#fjs-3873) | MED | Basecamp's own DNS/egress failure = every monitor down; `gradePublicUrl` DNS step not bounded by the abort signal | monitor-sweep.job.ts:194, 222-228 | T/P |
| M8 · [FJS-3874](../../../ISSUES.md#fjs-3874) | MED | Alerts stuck firing: deactivating a rule, a `missing` series, deleting a rule (cascade, no PagerDuty resolve), pausing/deleting a down monitor | jobs/alert-evaluate.job.ts:80, 92, services/alert-rules/alert-rules.service.ts:125-131 | T |
| M9 · [FJS-3875](../../../ISSUES.md#fjs-3875) | MED | No hysteresis/cooldown on rules → flapping gauge re-fires every crossing | domain/alert/alerting.ts:294 | T |
| M10 · [FJS-3876](../../../ISSUES.md#fjs-3876) | MED | Posture compares to prior value; true→unknown→false never fires PostureFailed; ingest writes before notify | domain/host/posture.ts:625, services/server-postures/server-postures.service.ts:92 | T |
| M11 · [FJS-3877](../../../ISSUES.md#fjs-3877) | MED | Unbounded tables: MonitorCheck (~1,440/day/monitor), MonitorEvent, ServerEvent, resolved Alert, Notification | jobs/retention.job.ts, db/schema.lite:169 | T |
| M12 · [FJS-3878](../../../ISSUES.md#fjs-3878) | MED | `resume` keeps old `failStreak` → first blip pages with no retries | db/schema.lite:3040 | T |
| M13 · [FJS-3895](../../../ISSUES.md#fjs-3895) | LOW-MED | Missing/stale series only `console.warn`; `ServerUnreachable` never reaches NotificationChannels (PagerDuty/Slack) | alert-evaluate.job.ts:169-176 | T |
| M14 · [FJS-3896](../../../ISSUES.md#fjs-3896) | LOW-MED | No dead-man switch for Basecamp itself / the queue (related FJS-3108) | — | P |
| M15 · [FJS-3897](../../../ISSUES.md#fjs-3897) | LOW | No certificate-expiry warning in monitor-sweep | monitor-sweep.job.ts:196 | T |
| M16 · [FJS-3898](../../../ISSUES.md#fjs-3898) | LOW | job-run retries a non-idempotent command 3×; finishRun throw re-executes; `notifyPeople` lookups outside its try | jobs/job-run.job.ts, domain/notification/notify.ts:410-416 | P |

## Backups and recovery

| # | Sev | Finding | Where | Conf |
|---|-----|---------|-------|------|
| B1 · [FJS-3846](../../../ISSUES.md#fjs-3846) | HIGH | Upload failure (bad key, >1 GB cap) still finishes `status:'success'`; `lastBackupAt` and `hub.backup-recent` grade it green → backups silently stay on the box that dies | jobs/backup-run.job.ts:65, 193-199, domain/host/host-machine.ts:241-247, domain/host/posture.ts:457-463 | ✔ T |
| B2 · [FJS-3847](../../../ISSUES.md#fjs-3847) | HIGH | Retention protects only the global newest; with uploads failing and `backupKeepRemoteDays` set, every remote copy ages out and is deleted | domain/backup/backup-archives.ts:156-168 | ✔ T |
| B3 · [FJS-3859](../../../ISSUES.md#fjs-3859) | HIGH | Hub row written `running` before the snapshot, so every archive holds itself as `running`; `queueBackup` has no staleness window → a restored hub (or one that crashed mid-backup) never backs up again | jobs/backup-run.job.ts:166, 272-275, domain/job/job-schedule.ts:141 | ✔ T |
| B4 · [FJS-3879](../../../ISSUES.md#fjs-3879) | MED | App backups/drills have no staleness or failure alert; busy apps can fail capture every time (exit 4 after 5 tries) | jobs/app-backup-run.job.ts:197-214, jobs/app-drill-run.job.ts:104-117, outpost/docker.js:277-290 | T (FJS-3179 related) |
| B5 · [FJS-3880](../../../ISSUES.md#fjs-3880) | MED | Two hubs on one bucket/prefix adopt and then prune each other's archives; hub replica path is fixed `basecamp` → Litestream generations collide | domain/backup/backup-archives.ts:186-228, jobs/replicate-sync.job.ts:168 | T |
| B6 · [FJS-3881](../../../ISSUES.md#fjs-3881) | MED | Hub backups never verified: no integrity_check, no post-upload size/hash, sha256 not on the row, no hub restore drill | jobs/backup-run.job.ts:101-110 | T |
| B7 · [FJS-3899](../../../ISSUES.md#fjs-3899) | LOW-MED | 1 GB upload held in memory twice | jobs/backup-run.job.ts:143 | P |
| B8 · [FJS-3900](../../../ISSUES.md#fjs-3900) | LOW | `jobsDatabasePath` replaces the first `.db` anywhere in the path | core/db.ts:73-75 | T |
| B9 · [FJS-3901](../../../ISSUES.md#fjs-3901) | LOW | Crash between restore and rename leaves a restored hub reporting "refused" | domain/backup/hub-restore.ts:243-266 | T |
| B10 · [FJS-3902](../../../ISSUES.md#fjs-3902) | LOW | `discard` can delete the only good archive; `AppBackup` cascades on Server delete | services/hub-backups/hub-backups.service.ts:104-111, db/schema.lite:2162 | T |

## Solid already — leave alone

- **Deploy:** one owner (executor) decides who runs a release; stub refused in production; digest-only identity; release reads its own snapshot; secrets by id, decrypted at send.
- **Outpost:** argv everywhere, no shell; realpath-checked file paths; restores/backups in `--network none` containers with sha256 checks; write-then-rename for config; serialized ingress; Ed25519 signatures, constant-time compare; log caps; 333 tests pass.
- **Auth:** enrollment token hashed, single-use, 15 min, uniform refusals; per-machine Ed25519 with DB nonces and machine-on-wire = machine-routed check; peer door; `refuseGrantAboveOwn`; suspension at three doors; login rate limit; HMAC links; `secretId` @system on channels and destinations; exact CORS list.
- **Monitoring:** pure grading split from the state machine; retries/N-of-M; pinned-address redirect grading; from-state-narrowed transitions; "only `recovered` resolves"; posture `unknown` never reads clean.
- **Backups:** `$backup`/`VACUUM INTO`, never a live file copy; Outpost's before/after capture check; manifest sha256 + key fingerprint + migration-history refusal before any live file is touched; key escrow graded; restore refused under the wrong key; zip-slip refused; pre-signed expiring URLs to machines.

## Not reviewed

environments/, domain-routes/, volumes/ services in depth; dockerfile-template.ts, live-check.ts; posture parsers; Caddy ACME renewal; MCP four-role drive; provision-host/enroll-host/bearer-send/sso-env/capabilities; OAuth flow; caravan lease internals; cron timezone; `/health` coverage of the queue; whether conduit logs the `/deploy` body (it carries decrypted secrets).
