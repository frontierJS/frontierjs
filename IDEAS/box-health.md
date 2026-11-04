---
id: box-health
status: proposed
dated: 2026-11-03
---

# Idea — the bottom two layers of a box reach Basecamp

**Status: PROPOSED. Q1/Q3/Q5 ruled `FJS-D1858`–`D1860`; Q2/Q4/Q6–Q12 open; Phases 1–3 built and proven 2026-11-04 (committed in `4635ac29c`); 0.1 is the owner's ssh, Q9–Q12 before Phase 3 is called finished.**
Probed against the tree 2026-11-03. Do not cite this file as behavior — see `VERIFYING.md`.

**The ask** (owner, 2026-11-03): of the six layers a box has — container runtime, Caddy, data
files, data safety, systemd, glue — Basecamp hears nothing about the bottom two. A container
that crashes after its deploy stays `running` on the App screen; a failed firewall or Caddy unit
shows nowhere; a reboot is not recorded. Outpost already reads all of it, and prints it only when
someone runs `fli outpost:status` over ssh.

**Words.** A *reading* is what the box reports and Basecamp stores as a snapshot with a
`checked_at` (`Server.health`, `Server.replication` are readings). A *control* is the posture
grader's verdict over a reading (`domain/host/posture.ts`; `backup.replica-lag` is a control over
the `replication` reading). A reading the box could not take is `null` and grades **unknown**,
never healthy and never restored — the rule `posture.ts` and `alerting.ts` already hold.

## What exists (probed 2026-11-03)

- **Outpost reads both layers.** `inspector.units()` (`docker.js:2050`) asks `systemctl show` for
  the five units — `outpost`, `caddy-api`, `basecamp-litestream`, `basecamp-firewall`, `docker` —
  and `inspector.containers()` (`docker.js:2062`) lists every `fjs.app`-labeled container with
  `state` and `status`. Both are read only by `readStatus()` (`status.js:97`), the ssh command.
- **The swap already owns the crash-loop fact.** `docker.js:583` reads `State.Running`,
  `StartedAt` and `RestartCount` to decide a new container settled, because `--restart
  unless-stopped` hides a crash loop as `running` (`FJS-3853`). Nothing reports the same three
  fields after the swap.
- **The heartbeat** (`report.js:84`) carries `outpost_version`, `outpost_url`, `health`,
  `deploy_keys` and `replication`, every 30 s. Posture rides its own report every 6 h, disk and
  volumes every 5 min.
- **Basecamp's receiver** (`servers.service.ts:1152–1200`) writes the readings onto `Server` in
  one update, keeps `health` through `app.metrics.record()`, and files `cameOnline` on the status
  edge. `ServerEventKind` has `cameOnline unreachable` for the machine and
  `postureFailed postureRestored` for a control moving — no kind for a container or a unit.
- **`App.status` has one writer today**: the deploy job and `apps.service.ts` move it. It is a
  deploy-lifecycle word (`deploying`, `running`, `error`), not an observation.
- **A `Monitor` is a row an operator creates** (`monitors.service.ts:80`); `appId` is optional
  and `url` is a free copy. The sweep, checks, uptime days and channels all hang off the row.
- **Nothing names a reboot.** `rebootRequested` is a person's ask; no event says the box came
  back up, and `vitals.js` reads no boot id.

## The proposal

Two readings ride the heartbeat, one grader grades them, and the edges become events.

```
heartbeat: {
  …,
  runtime: {
    boot_id:    string | null,        // /proc/sys/kernel/random/boot_id
    containers: [{ app_id, name, image, state, status,
                   restart_count, started_at, oom_killed, exit_code,
                   replaced }] | null,    // null when `docker ps` failed
    units:      [{ unit, load, active, sub, since }] | null,
  }
}
```

- **`Server.runtime Json?`** holds it with `checked_at`, beside `health` and `replication`.
- **Two controls in `posture.ts`**: `runtime.containers` (every live placement's container is
  running and has not restarted since the last reading) and `runtime.units` (every supervised
  unit is `active`). Both `high`, both `unknown` on a null reading.
- **Five `ServerEventKind` members**: `containerCrashLooping containerRecovered unitFailed
  unitRestored rebooted`. Fired on the edge between two readings; a null reading on either side
  fires nothing. `rebooted` is the `boot_id` changing; `rebootRequested` stays the person's ask.
- **`App.status` is untouched.** The App screen shows the observed container beside it, read off
  `Server.runtime` for the App's placements.
- **An App with a hostname gets a Monitor without anyone creating one** — Phase 3, shape per Q3.

**Prior art.** Dokku and CapRover show `docker ps` state per app on demand and alert on nothing;
Coolify polls container status every minute and files a notification on a state change
([Coolify docs, Notifications](https://coolify.io/docs/knowledge-base/notifications)). Kamal
leaves it to the operator. Uptime Kuma's Docker monitor type grades `running` only
([Uptime Kuma, Docker monitor](https://github.com/louislam/uptime-kuma/wiki/How-to-Monitor-Docker-Containers)),
which is the gap `FJS-3853` found. None of them reads systemd.

## Open questions

1. ~~**Q1 — Which report carries the readings?**~~ **Answered 2026-11-04 (`FJS-D1858`): A — both on the heartbeat, graded by `posture.ts` like `replication`.**
   - **A** — both on the heartbeat, graded by `posture.ts` like `replication`.
   - **B** — units on the 6 h posture report, containers on the heartbeat.
   - **C** — a fourth report on its own clock.
   - **Recommend A** — a stopped Caddy or firewall unit is an outage, and 6 h is the wrong clock
     for one; `systemctl show` over five units is one process, the same cost `replication`
     already pays each beat. The grader stays one owner either way; A moves one object between
     two posts if it is wrong.
2. **Q2 — What is a crash loop?**
   - **A** — `restart_count` rose since the last reading, or the live container is not `running`.
   - **B** — A, plus a minimum of two restarts inside the beat so a single OOM kill files
     `containerRecovered` rather than `containerCrashLooping`.
   - **Recommend A** — one restart of a production container is already news, and the message
     carries the count.
3. ~~**Q3 — The automatic Monitor's shape?**~~ **Answered 2026-11-04 (`FJS-D1859`): A — a Monitor row the system owns: `appId` set, a `@system isManaged`, `url` regenerated from the App's primary Domain on every Domain write, not editable.**
   - **A** — a Monitor row the system owns: `appId` set, a `@system isManaged`, `url` regenerated
     from the App's primary Domain on every Domain write, not editable.
   - **B** — no row: the sweep probes App hostnames directly and records onto the App.
   - **C** — stay opt-in; the Routes card already grades the hostname's certificate.
   - **Recommend A** — the sweep, checks, uptime days and channels all hang off the Monitor row
     and B would build them twice; `isManaged` keeps the url from being a stale copy, which is
     the `decision-rules` objection to a plain row.
4. **Q4 — Is a `_replaced` container's state graded?**
   - **A** — no: it is a swap's set-aside and a stopped one is correct.
   - **B** — yes, as a lower-severity "swap unfinished" control.
   - **Recommend A** — and the reading carries `replaced: true` so B stays available.
5. ~~**Q5 — Can the control see a restart?**~~ **Answered 2026-11-04 (`FJS-D1860`): A — the receiver stamps each stored container with `restartsSinceLast` (camelCase: it is Basecamp's field, not the wire's) before storing, and the control reads it with a hold window so a single restart does not blink red for one beat.** The grader reads one stored reading and Q2 A's "rose
   since the last reading" needs two, so as built `runtime.containers` fails only on a live
   container that is not `running` or a live placement with no container; the rise is caught by
   the edge event alone.
   - **A** — the receiver stamps each stored container with `restartsSinceLast` (camelCase: it is
     Basecamp's field, not the wire's) before storing, and the control reads it with a hold
     window so a single restart does not blink red for one beat.
   - **B** — the control reads recent `containerCrashLooping` events.
   - **C** — stay state-only.
   - **Recommend A** — the control and the event then agree on what a restart is, and the hold
     window is the one place the two differ.
6. **Q6 — Which App kinds expect a container?** The build grades and files only
   `container worker database daemon` (`LONG_RUNNING_KINDS` in `domain/host/runtime.ts`).
   - **A** — keep: a `static`, `cron` or `function` App with no container is correct.
   - **B** — add `function` and `cron`.
   - **Recommend A** — a cron container exits between runs by design.
7. **Q7 — Recovered after a restart?** A container that restarted and is still `running` files
   `containerCrashLooping` on each rise and never `containerRecovered`; recovered fires only on a
   not-running → running move. Matching is by container name, and a lower count under the same
   name (a swap) is not a restart.
   - **A** — keep.
   - **B** — file `containerRecovered` after N quiet beats.
   - **Recommend A** — Q5 A's hold window is what B would add.
8. **Q8 — Units the box lacks?** A unit with `load: not-found` is not graded, since
   `basecamp-litestream` and `basecamp-firewall` need not exist on every box; any `active` other
   than `active`, `activating` included, fails and files `unitFailed`.
   - **A** — keep.
   - **B** — grade `not-found` as a failure on a box whose install should have made it.
   - **Recommend A** — until the install records which units it made.
9. **Q9 — The managed url's path?** `App.healthCheck` is a path asked of the container's
   published port, and 3.1 reuses it as the public url's path.
   - **A** — keep: the health path is what the App says is worth probing.
   - **B** — always `/`: the internal health path may be unrouted or unauthenticated-only.
   - **Recommend B** — the public probe is about the hostname answering, and a health path
     behind Caddy is not promised to be the one Outpost probes.
10. **Q10 — A Domain on a port other than 443?** `Domain.port` is ignored and the url is
    always `https://<hostname>/`.
    - **A** — keep.
    - **B** — write `:<port>` into the url when it is not 443.
    - **Recommend B** — the row exists to probe the address people open.
11. **Q11 — A hostname change keeps the row's grade.** `status`, `failStreak` and the uptime days
    survive a rewrite of `url`.
    - **A** — keep: the row is about the App, and its history is the App's.
    - **B** — move the row to `pending` on a url change, so the new address earns its own grade.
    - **Recommend B** — a `down` carried onto a new hostname pages for an address nobody probed.
12. **Q12 — A soft-deleted App hard-deletes its managed Monitor** with its checks, events and
    channel links; restoring the App makes a fresh row.
    - **A** — keep.
    - **B** — pause the managed row on App remove and resume it on restore, keeping history.
    - **Recommend B** — soft delete exists so a restore brings everything back.


## Plan

### Phase 0 — Read the real answers

Goal: the readings' shapes are recorded from a real box.
Done when: 0.1's output is recorded under it.

- [ ] 0.1 On yuma over ssh: `docker inspect --format '{{.RestartCount}} {{.State.OOMKilled}}
      {{.State.StartedAt}} {{.State.ExitCode}}'` on every `fjs.app` container, `systemctl show
      --property=Id,LoadState,ActiveState,SubState` on the five units, and
      `cat /proc/sys/kernel/random/boot_id`. Record one line each. Owner's ssh.

### Phase 1 — Outpost reports the two layers

Goal: every heartbeat carries `runtime` as § The proposal shapes it.
Done when: `packages/outpost` `bun run test` is green with a test that a failing `docker ps`
yields `containers: null` and the beat still posts; `bun run verify:docker` green.

- [x] 1.1 `inspector.runtime()` in `docker.js`: `containers()`'s list joined with one
      `docker inspect` over the ids for `restart_count`, `started_at`, `oom_killed`, `exit_code`;
      `replaced` from the `_replaced` name suffix. `null` when `docker ps` fails; an inspect
      that fails leaves the four fields `null` on that row.
- [x] 1.2 `boot_id` read in `vitals.js` or beside `units()`, `null` when the file is unreadable.
- [x] 1.3 `report.js` `heartbeat()` sends `runtime: { boot_id, containers, units }`; `status.js`
      reads the same `runtime()` so the ssh command and the heartbeat agree.
- [x] 1.4 Tests in `test/outpost.test.js`: the payload shape, the two null cases, and that the
      `docker inspect` call is one process for N containers.

**Done 2026-11-04.** One `docker inspect` format (`STATE_FORMAT`) now serves both the swap's
settle check and the reading, so `FJS-3853`'s parser has one owner. `started_at` is Docker's
nanosecond RFC3339 string; a never-started container's zero time reads `null`. Containers are
inspected by name. `bun run test` 380 pass; `verify:docker` 69/69 in the main tree.

### Phase 2 — Basecamp stores, grades and files

Goal: a dead container or unit reads red on the Server screen inside one heartbeat, and the edge
is an event.
Done when: `packages/basecamp` `bun run test` green with the grader tests named in 2.2 and 2.3;
`bun run verify:outpost` green with the sink sending a `runtime` reading.

- [x] 2.1 `Server.runtime Json?` in `schema.lite` with a migration; the receiver writes it with
      `checked_at` only when the beat carries it, as `replication` is written.
- [x] 2.2 `runtime.containers` and `runtime.units` controls in `posture.ts`, graded over
      `Server.runtime` and the Server's live `AppServer` rows. Tests: null reading → unknown;
      a `_replaced` container exited → ok (Q4 A); a live container `restarting` → fail naming
      the app; a unit `failed` → fail naming the unit.
- [x] 2.3 The five `ServerEventKind` members and the edge detection in the receiver, comparing
      the stored reading to the incoming one before the update. Tests in
      `test/server-events.test.ts`: null on either side fires nothing; a rise in `restart_count`
      files `containerCrashLooping` once, not every beat; `boot_id` change files `rebooted`.
- [x] 2.4 `verify-outpost.mjs`'s sink sends a `runtime` reading and the drive asserts the
      Server row holds it.
  - The drive spawns a real Outpost rather than a sink, so the checks read what that Outpost
    sends: the row holds `runtime.checked_at` with the three parts present, and after the
    container release the next beat lists the App's container `running`.
- [x] 2.5 The App screen shows the observed container (state, restarts, since) beside
      `App.status`, read off its placements' `Server.runtime`; the Server screen's posture card
      shows the two controls with no new card.
  - A badge per placement on the Placement card: `Container: running · 0 restarts · since 2h`,
    muted `no reading yet` on a null reading, warning `not on the box` on an empty one; shown
    only for the kinds `LONG_RUNNING_KINDS` names. The posture card already renders every
    control the service returns, so the two new ones needed no change.

- [x] 2.6 `FJS-D1860`: the receiver stamps each stored container with `restartsSinceLast` (the
      rise against the stored reading, `null` when either side could not count) before the
      update; `runtime.containers` fails on a stamp above zero inside a hold window of
      `RUNTIME_RESTART_HOLD_MS` after `checked_at`, so one restart reads red for more than one
      beat and the control agrees with the event. Tests beside 2.2's.
  - Two stamps, `restartsSinceLast` and `restartedAt`; a quiet beat carries both forward, a
    lower count under the same name is a swap and stamps zero, no prior stamps `null`. Hold is
    `RUNTIME_RESTART_HOLD_MS`, 10 min. `posture.test.ts` + `server-events.test.ts` 68 pass;
    the package typecheck is clean on the files touched.

**Done 2026-11-04.** `bun run test` 1176 pass; `verify:outpost` 59/59 with the three runtime
checks; `verify:build` 9/9. `verify:screens` was not run — port 8020 was held by another
session's server, and a drive refuses a port that already answers. The grader is state-only
until Q5 is ruled: a restart that leaves the container running is an event, not a red control.

### Phase 3 — Outside-in without opting in

Goal: every App with a primary Domain is probed from Basecamp.
Done when: a new Domain on an App yields a Monitor the sweep runs, and removing the Domain
removes the Monitor, under `bun run test`.

- [x] 3.1 Per Q3's ruling: the managed Monitor's columns, the Domain hook that upserts and
      regenerates its `url`, and the refusal to edit a managed row's `url`.
  - `Monitor.isManaged @system` + `@@index([appId, isManaged])`, migration
    `20261104073222_managed_monitor.sql`. One owner, `domain/monitor/managed.ts`:
    `syncManagedMonitor` keeps one row per App (create, or rewrite `url` and set `nextCheckAt`
    now), and removes it — after resolving a down monitor — when the App or its last primary
    Domain goes. Called from `domains.service.ts` (create, patch, remove, restore, makePrimary)
    and `apps.service.ts` (remove, restore, patch of `healthCheck`); no after-hook pipeline
    exists to hang it on. `monitors.service.ts` refuses a person's change of `url`, `appId` or
    `isManaged` and a person's remove of a managed row, by name; pause and rename go through.
    `update` (PUT) now runs `patch`'s body — the same hole on domains is `FJS-3989`.
- [x] 3.2 The App screen's uptime card reads the managed Monitor when one exists.
  - The screen had no monitor reference and the web app has no Monitor screen, so the card
    (`#app-uptime`) carries no link; the tone map lives in the route file because no
    `resources/Monitor.mesa` exists. The managed row's `name` is the App's at creation and is
    not resynced.

**Done 2026-11-04.** `bun run test` 1188 pass with one timing failure, the gate-parity matrix
case at the 5 s timeout under a load of 21–25 (`FJS-3992`: a HEAD worktree passed the same case
3 of 3 under the same load, and no step touched the finds it makes). `verify:outpost` 59/59,
`verify:build` 9/9, `fli done` 0 unfinished. Q9–Q12 came out of the build and are the owner's
before this phase is finished; `FJS-3989` is the Domain PUT bypass it found.

## See also

`IDEAS/alerting.md` (who is paged when a control fails), `IDEAS/deploy-posture.md` (the posture
report's own plan), `IDEAS/box-top.md` (`fli top`, the live view of the same readings),
`packages/outpost/CLAUDE.md` § What bites here.
