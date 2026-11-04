---
id: zero-downtime-deploy
status: proposed
dated: 2026-11-03
---

# Zero-downtime deploy — start the new container first when the old one can keep serving

**Status: PROPOSED.** Dated 2026-11-03. Nothing here is built. Do not cite this
file as describing behavior — see `VERIFYING.md`.

The want (owner, 2026-11-03): app hosting as robust as CapRover and its peers.
Probing the box against that bar found one clear gap. **Every release has a
window of 502s**, because Outpost stops the old container before it starts the
new one. Kamal, Dokku and CapRover start the new container, wait for it to
answer, move traffic over, and only then stop the old one.

The order is deliberate, not an oversight. The new entrypoint migrates the
database before it serves, and stopping first keeps the old release from
writing while that runs. **So this paper is about migrations, not the proxy.**
Litestone already has the test that decides when overlapping two releases is
safe: `livePivot`, the N-1 verdict from `IDEAS/release-transitions.md`
§ *Pivot is N-1 compatibility*. An **expand** release can overlap. A
**contract** or **unknown** release keeps today's stop-first swap. No new noun.

---

## What exists (probed 2026-11-03)

| Piece | Where | What it does today |
| --- | --- | --- |
| The swap | [docker.js:564](../packages/outpost/src/docker.js#L564), `setAside` and `deploy` | Renames the live container `<name>_replaced`, **stops it** (`docker stop -t 10`), then runs the new one. Comment: *Stopped BEFORE the new one starts: a SQLite file takes one writer, and the new entrypoint opens it to migrate.* |
| Rollback | [docker.js:615](../packages/outpost/src/docker.js#L615) `putBack` | A new container that fails to start or to answer is removed, and the `_replaced` one is renamed back and started. Depth one. |
| Health | [docker.js:183](../packages/outpost/src/docker.js#L183) `HEALTH` | `config.healthCheck` path polled 10 × 3 s. With no path: still running, unrestarted, 5 s later. |
| Migrate on boot | [dockerfile-template.ts:70](../packages/basecamp/api/src/domain/release/dockerfile-template.ts#L70), [scaffold/app.js:106](../packages/cli/core/scaffold/app.js#L106) | `bun run db:migrate && bun api/index.ts`. The migration runs inside the new container, before it listens. |
| The route | [server.js:175](../packages/outpost/src/server.js#L175) `POST /deploy`, `ingress.js` | Caddy route `fjs-<app>` PATCHed to `127.0.0.1:<App.port>` **before** the swap. Old and new share one host port, so the route never moves. |
| Host port | [host-port.ts](../packages/basecamp/api/src/domain/release/host-port.ts) | One port per App from 10000 up, held on `App.port`. Two containers of one App cannot both publish it. |
| The N-1 verdict | [litestone release.js:288](../packages/litestone/src/release.js#L288) `livePivot(before, after)` | `unchanged` / `expand` / `unknown` / `contract`. *Unknown counts as a contract, because a wrong "reversible" is the only answer that costs anything.* |
| Verdict on a deploy | [cli core/release.js](../packages/cli/core/release.js) journal | `fli deploy` records `pivot=` per release. **Basecamp's deploy computes no verdict.** |
| Jobs | [caravan worker.ts](../packages/caravan/src/worker.ts) `_claim` | Claims rows with a lease per instance. Two containers running workers is a supported shape. |
| Live updates | [channels.ts:2191](../packages/junction/src/transport/channels.ts#L2191) | A database that announces `inProcess` reaches no socket in another process. Declaring `announce crossProcess` fixes that. |
| The SSH path | `packages/cli/commands/deploy/_steps-docker/06-swap.md` `swapContainer` | `fli deploy` keeps the same `_replaced` handle in its own copy of the swap. |

## Prior art (read from each tool's source, 2026-11-03)

| | Kamal | Dokku | CapRover | Coolify |
| --- | --- | --- | --- | --- |
| Order | New container, proxy switches once it is healthy, then old stops | New, checks, proxy switch, SIGTERM old, stop after a wait | Swarm `UpdateConfig.Order`: **`stop-first` for any app with a mount**, `start-first` otherwise | New beside old, health check, wait for the proxy, stop old |
| New container's address | Container id plus port on the shared `kamal` Docker network | Random host port via `-p`, IP from `network-get-ipaddr` | Swarm replaces tasks behind the service | Proxy labels on both containers |
| Health default | `GET /up` every 1 s, 30 s deploy timeout | No checks: wait 10 s, confirm still running | Swarm's container-running check (inferred) | App's settings; none means healthy at once |
| Drain | `drain_timeout` 30 s for in-flight requests; **WebSockets cut at drain start** | `wait-to-retire` 60 s, then `stop -t 30` | Swarm's own | A configured sleep, then `docker stop` |
| Failure | New stopped, old never touched; `kamal rollback <version>`, 5 containers kept | New killed by an EXIT trap, old keeps serving | Swarm's failure handling (not read) | Old left running (inferred from call order) |
| Database during overlap | `pre-app-boot` hook runs while old serves; no migration guidance | `release` / `predeploy` run migrations **while the old container serves** | Mounts force stop-first, so two containers never share a file | Falls back to stop-first for host-mapped ports and fixed names |

Sources: `basecamp/kamal-proxy` `internal/server/{target,service,router,load_balancer}.go`;
`basecamp/kamal` `lib/kamal/cli/app/boot.rb`, `configuration/docs/proxy.yml`;
`dokku/dokku` `plugins/scheduler-docker-local/bin/scheduler-deploy-process-container`,
`docs/deployment/zero-downtime-deploys.md`, `docs/advanced-usage/deployment-tasks.md`;
`caprover/caprover` `src/docker/DockerApi.ts` `updateService`;
`coollabsio/coolify` `app/Jobs/ApplicationDeploymentJob.php` `rolling_update`, `health_check`.

**What the field says to this paper.** CapRover is the one that couples
overlap to data, and it chooses never to overlap an app with a volume. Every
SQLite app on CapRover takes the window. Coolify falls back the same way for
host-mapped ports, which is this paper's `exposesPort` rule. Dokku overlaps a
migration with the old release and leaves compatibility to the app. Nobody asks
the schema whether the overlap is safe. That question is the one Litestone can
answer here and the field cannot.

### SQLite hosts in particular

| | Old serves while new starts? | Migrations during the overlap |
| --- | --- | --- |
| Fly, volume Machine | No. Updated in place, down while it restarts. Docs forbid bluegreen and canary with volumes; flyctl's `validation.go` refuses only canary | `release_command` runs in a temporary Machine with **no volume**, so it cannot migrate a volume's SQLite file |
| Rails 8 + Kamal | Yes, on a shared named volume | `bin/docker-entrypoint` runs `db:prepare` in the new container while the old serves; WAL, `immediate` transactions, `timeout: 5000`. Nothing on compatibility |
| ONCE / Campfire | Yes: `deployWithVolume` starts the new container on the same volume, removes it if kamal-proxy refuses it, then removes the old ones | `db:prepare` at boot; its WAL checkpoint lock is a file inside the container, so it does not coordinate across the overlap (inferred) |
| LiteFS | Across nodes, by a Consul lease handoff | Not addressed. Fly says LiteFS is pre-1.0 and unsupported |
| Litestream | "Litestream acts as just another process" | Not addressed. "Do not have multiple applications replicating concurrently" |

Sources: `docs.fly.io/reference/configuration`, `docs.fly.io/volumes/overview`,
`superfly/flyctl` `internal/appconfig/validation.go` and
`internal/command/deploy/machines_deploymachinesapp.go`; `rails/rails`
`railties/.../docker-entrypoint.tt` and `activerecord/.../sqlite3_adapter.rb`;
`basecamp/once` `internal/docker/application.go`; `basecamp/once-campfire`
`config/database.yml`; `superfly/litefs` `docs/ARCHITECTURE.md`;
`litestream.io/tips`. PocketBase, Turso and Durable Objects give no deploy
guidance that applies here.

**The split.** Fly takes the window for any SQLite file on a volume. Rails and
ONCE overlap on the shared file and rely on WAL plus a 5 s busy timeout, which
is what our probes measured. Neither checks whether the old code survives the
migration. Our Litestream is one host service per box, so the "one replicator"
rule already holds through an overlap.

---

## The proposal

**A release's swap follows its pivot verdict.**

- **expand or unchanged → start-first.** Run the new container on a second
  address. When it is healthy, move the Caddy route to it. Stop the old one
  with a drain timeout and keep it as `_replaced`, as today.
- **contract or unknown → stop-first.** Today's swap, unchanged. The release
  record says why it took the window: *this deploy is the pivot*.
- **A port published past Caddy (`exposesPort`, not loopback) → stop-first.**
  That port is the address callers dial, and only one container can hold it.

What start-first gets for free: **a failure before the route moves touches
nothing live.** Rollback stops being "rename and restart the old one, then hope
it boots" and becomes "remove the new one". `putBack` is still needed for a
failure after the switch and for the stop-first path.

### What two releases share during the overlap

- **The database file.** SQLite supports two processes on one bind-mounted
  file in WAL mode: one writer at a time, readers unblocked. The migration
  holds the write lock for its length, and the old release's writes wait on
  Litestone's 5 s `busy_timeout`. Measured in 0.2: a 283 ms migration stalled
  nothing visible, and a 3.35 s one stalled writes but failed none. **A
  migration longer than 5 s would fail the old release's writes with
  `SQLITE_BUSY`** while its reads keep serving. Stop-first would fail
  everything for that length plus boot.
- **Jobs.** Caravan's lease claim already serializes them. Cron uses a
  per-minute unique key, so one fire runs once even with two schedulers
  (`FJS-3871` is about a slow run, not a double fire).
- **Live updates.** An app on `announce inProcess` drops cross-container
  broadcasts for the overlap. Sockets on the old container close at its stop
  and the client reconnects to the new one. Seconds of staleness, no lost data.
- **Litestream.** It replicates the WAL, whichever process writes it. In 0.2
  the pinned 0.5.17 replicated straight through a start-first swap, and the
  restore matched the live database row for row, column for column.

---

## Open questions

- **Q1 — The new container's address while the old one holds `App.port`.** Ruled `FJS-D1837`: **B**.
  - **A** — A port pair: the App owns a second allocated port, and releases
    alternate between them. Moves the allocator, `portHolders` and every
    existing App.
  - **B** — Docker chooses: start-first publishes `127.0.0.1::<containerPort>`
    and the route follows `published()`, which already treats the daemon as
    the truth for the live port. Dokku's shape.
  - **C** — A Docker network, Caddy dialing the container's IP. Kamal's shape,
    but Kamal's proxy is itself a container on that network and our Caddy is a
    host service.
  - **Recommend B** — nothing moves: `App.port`, the allocator and the
    firewall's `exposesPort` set keep their meaning, and an ephemeral port sits
    above `HOST_PORT_BASE`. Reopen as A if a firewall rule ever needs the port
    known ahead.
- **Q2 — Where the verdict is computed.** Ruled `FJS-D1838`: **A**. The "before" side is the schema the
  live container migrated to, taken from the last *deployed* release, never
  "the previous commit": a failed or skipped release is not what the database
  holds.
  - **A** — Outpost, beside the build. After `build`, run the new image's own
    `litestone release --from=<old schema> --json`, with the old schema copied
    out of the live container. Outpost gains no framework dependency: the
    classifier is the app's copy of Litestone, inside the app's image.
  - **B** — Basecamp, before `/deploy`. Basecamp does not hold the source, so
    it needs both schemas fetched from the repository first.
  - **Recommend A** — the checkout and both images are already on the machine,
    and `litestone release --json` is the classifier's existing command.
- **Q3 — Drain.** Ruled `FJS-D1839`: **one stop grace per App, Junction's budgets derived inside it**. Kamal drains 30 s; Dokku waits 60 s and then stops with
  `-t 30`. 0.4 found Junction's own budgets are 5 s (HTTP drain, plugin
  shutdown) inside a 15 s whole-shutdown limit, all under Docker's `-t 10`.
  With start-first the old container gets no new traffic once the route
  moves, so its drain is only in-flight work.
  - Lean: one number, the container's stop grace, that Junction's budgets are
    derived to fit inside, rather than three settings that do not know about
    each other (`FJS-3944`).
- **Q4 — `fli deploy` over SSH.** Ruled `FJS-D1840`: **both paths, one owner**. `swapContainer` is a second owner of the
  swap. Lean: start-first does not ship on one path only, so Phase 3 gates the
  plan's done, and 3.1 makes the two swaps one.
- **Q5 — Opt out.** Ruled `FJS-D1847`: **the App opts in, off by default** (against the lean). Lean was: nothing until two apps ask (`PHILOSOPHY.md`, the
  paved road over the workaround), the verdict the only switch. The verdict
  reads only the schema, so a change in what a value means passes as an
  expand; stop-first stays the default and the verdict still has the last word.
- ~~**FJS-D1841 — How does an App's one stop grace reach the container and Junction: where the number lives, its env var, and the formula for the three budgets?**~~ **Answered 2026-11-04 (`FJS-D1841`): A — the release's runtime config holds the grace beside `logs` (`runtimeFor`, `deployment-run.job.ts:354`; `deploy.*.logs` on the `fli deploy` path). Outpost passes it once as `docker run --stop-timeout N -e FRONTIER_STOP_GRACE=N`, and every `docker stop -t` and `STOP_GRACE_S` goes. Junction's config resolution (where `FRONTIER_PORT_BE` is read) derives the three budgets, for example whole = N − 1 s and drain ≤ whole / 3 with the plugins taking the rest. An explicit budget that does not fit is refused at boot. With no env var (`fli dev`) Docker's 10 s is assumed.** `FJS-D1839` ruled the relation but not the
  carrier (`FJS-3954`). Today Outpost's `STOP_GRACE_S = 10`
  (`docker.js:207`, used at `:641` and `:714`) and `_module.md:654`'s
  `docker stop -t 10` know nothing of Junction's fixed `http.drainTimeout` 5 s
  (`app.ts:1853`), `shutdown.pluginTimeout` 5 s (`app.ts:1105`) and
  `shutdown.timeout` 15 s. The 15 s is already past the 10 s grace, and
  Caravan's 30 s drain is cut at 5 s. The red test asserts that a container
  started with grace N gives Junction a whole-shutdown budget below N and a
  plugin budget that a 30 s grace lets Caravan's drain finish in. Today it
  gets 15 s and 5 s whatever N is.
  - **A** — the release's runtime config holds the grace beside `logs`
    (`runtimeFor`, `deployment-run.job.ts:354`; `deploy.*.logs` on the
    `fli deploy` path). Outpost passes it once as
    `docker run --stop-timeout N -e FRONTIER_STOP_GRACE=N`, and every
    `docker stop -t` and `STOP_GRACE_S` goes. Junction's config resolution
    (where `FRONTIER_PORT_BE` is read) derives the three budgets, for example
    whole = N − 1 s and drain ≤ whole / 3 with the plugins taking the rest. An
    explicit budget that does not fit is refused at boot. With no env var
    (`fli dev`) Docker's 10 s is assumed.
  - **B** — the app's own Junction config holds `shutdown.grace`. The
    Dockerfile template writes it as an image label, and Outpost inspects the
    image for `docker stop -t`. That gives two origins: a hand-written
    Dockerfile drops the label silently, and changing the grace means a
    rebuild.
  - **C** — one framework default for every App (e.g. 30 s), with Junction
    deriving from it and a per-App override later. Every stop-first release
    waits it out, which is the option `FJS-D1839` was picked over.
  - **Recommend A** — it is the `logs` and `FRONTIER_TRUST_PROXY` shape
    already on both deploy paths, and the container carries its own grace, so
    an operator's `docker stop` or a daemon shutdown waits the same number.
    The margin, the drain share and the default grace (above 15 s) are the
    build's to choose.

## What must stay true

- Start-first runs only for `expand` or `unchanged`, and never for an App
  whose port is published past Caddy. **Outpost refuses `swap: 'start-first'`
  with `exposes_port`** itself, so a caller cannot send the combination.
- `swap: 'start-first'` is a request, never a command (`FJS-D1846`): Outpost
  runs it only on the release's own verdict, and answers the swap that ran.
- An absent `swap`, an `unknown` verdict and a classifier that fails to run
  each mean stop-first. Outpost's `swapFor` test pins `unknown → stop-first`.
- An App overlaps only when its owner turned the setting on (`FJS-D1847`).

---

## Phase 0 — Measure the gap and probe the overlap

Goal: the 502 window is a number, and two releases on one database are known to work.
Done when: 0.1–0.6 have their findings written under them and Q1–Q3 are ruled.

The probe kit is `~/fjs-zdd-probe/` (outside the repo): a Litestone 1.1.13 app
in two versions, v2 an expand (new nullable column, new table, an index on
`body`), migrating on boot. Load is 4 sequential callers, about 130 requests a
second, each timed out at 2 s.

- [x] 0.1 Measure today's window
  - Run on a laptop through Outpost's own `createDocker().deploy`, not yet on
    yuma (that is 0.5). With 4M rows: **961 of 4,181 requests failed over
    6.1 s** (793 resets from Docker's port proxy while the new container
    migrated, 168 refused). With an empty table: 232 failed over 1.2 s.
  - The first failure came 10.8 s after the deploy began, because the old
    container ignored SIGTERM and served until SIGKILL. That is `FJS-3943`, and
    it is in every release today.
- [x] 0.2 Two containers, one bind-mounted WAL database
  - v1 under load while v2 migrates on the same file. With 300k rows the
    migration took 283 ms. Zero errors on either side. With 4M rows it took
    3.35 s: v1's server logged no error, but 4 writes waited past the client's
    2 s timeout. v1's prepared statements survived the schema change.
  - The Litestone verdict for v1 → v2, from inside v2's image:
    `litestone release --from=<v1 schema> --json` answered `expand`. Q2's A works.
  - Litestream 0.5.17 (the pin in `litestone/src/tools/replicate.js`)
    replicating through the swap logged no errors. The restore matched live:
    300,873 rows, the new column, the new table and index. A 0.3.x binary
    replicates nothing at all (STRICT tables), which `fli deploy` already
    refuses as too old.
- [x] 0.3 The route moving under load
  - Caddy 2.10.2, route PATCHed from v1's port to v2's while the load ran,
    v1 stopped 1 s later. **0 of 868 requests failed** (300k rows), and 0 of 873
    with Litestream replicating.
- [x] 0.4 Junction on SIGTERM
  - `stop()` marks draining (readiness 503), closes WebSockets with 1012 at
    once, and keeps the listener open for up to `http.drainTimeout` (5 s). A
    3 s in-flight request finished with 200 and the process exited right
    after it. A NEW request during the drain is served, not refused, so the
    proxy has to move traffic itself.
  - A 12 s request got no response at +5.5 s, exit 0. A Caravan job running at
    SIGTERM was abandoned at `shutdown.pluginTimeout` (5 s), exit 0. Filed as
    `FJS-3944`. Bun's `idleTimeout` (10 s) also resets any request that sends
    no bytes for 10 s, with or without SIGTERM.
- [ ] 0.5 The yuma number, by hand
  - 0.1's loop against a real App on yuma while Basecamp releases it. The
    release is the owner's to run.
- [x] 0.6 `FJS-3943`: `exec` before the last command in both deploy templates
  - Start-first's drain and stop-first's rollback both assume the app hears
    SIGTERM.
  - Both templates now end `&& exec bun …`. `docker stop` of the new CMD shape
    took 0.29 s with exit 0 and the handler ran; the old shape took 10.3 s,
    exit 137. An app generated earlier still has the old CMD, and
    `fli deploy:doctor` warns on it.

## Phase 1 — Start-first swap in Outpost

Goal: `docker.deploy` can start the new container before it stops the old one.
Done when: `cd packages/outpost && bun run test` is green with tests for both swaps and each failure point.

- [x] 1.1 The second address, as Q1 rules
  - The new container runs as `<name>_next` with `-p 127.0.0.1::<containerPort>`. `published()` now reads `NetworkSettings.Ports` first, because the requested binding has no host port, and falls back to `HostConfig.PortBindings` for a stopped container. `containersOf` reports `next`, and `live` never names a `_next`.
- [x] 1.2 `deploy({ swap: 'start-first' })`: run new → `untilHealthy` → route to new → stop old with drain → remove it
  - `server.js`'s `/deploy` PATCHes the route before the swap and re-routes in its error handler. Start-first moves the route after health, so this step changes that sequence too, not only `docker.deploy`.
  - Built as `overlap()` in `docker.js`; `/deploy` hands it `route(port)`. Once the route has moved, the old container is renamed `_replaced`, the new one takes the slug name, and then the old one is stopped with `-t 10` (`STOP_GRACE_S`, D1839) and removed. That last step is the same as stop-first's cleanup after health. Renaming before the stop means an Outpost that dies mid-drain leaves the routed container live.
  - The step said to keep the old container as `_replaced`. It is removed instead: once the route has moved there is nothing to put back, and stop-first removes it at the same point.
- [x] 1.3 Failure before the route moves removes the new container and leaves the old one untouched
  - Covers three failures: docker refusing the run, a release that is not healthy, and Caddy refusing the route. On a route failure the route is also pointed back at the old port, in case a write landed before the error. A leftover `_next` is removed before either swap starts, because it holds the database open.
- [x] 1.4 `stop-first` stays the default when `swap` is absent, so nothing changes until Phase 2 sends it
  - The answer carries `swap`, which is what 2.3 records.
- [x] 1.5 Outpost refuses `swap: 'start-first'` with `exposes_port`
  - `checkSwap` also refuses start-first for an app with no hostname or path, since a port Docker picks is no address. It refuses an unknown `swap` too. `/deploy` asks it before the build.

**Done 2026-11-03.** `bun run test` passes 369 tests: 7 new start-first cases, the route ordering checked against a fake Caddy. `bun run verify:docker` passes 66, with 8 `startFirst.*` assertions against real Docker and Caddy. A curl loop through Caddy across the swap saw only 200s. A sick release left the old container serving. A stop-first release afterward took the App's own port back. Under `FJS-D1840`, start-first must not ship on one path only, and Outpost's `docker.deploy` is the module 3.1 makes the one owner. So 2.2, the first caller to send `swap`, waits on 3.1.

## Phase 2 — The verdict picks the swap

Goal: a Basecamp release overlaps when it is an expand, and says why when it is not.
Done when: a Basecamp release of an expand runs start-first and a contract runs stop-first, each visible on the Deployment row.

- [x] 2.1 The verdict computed where Q2 rules; `unknown` and a classifier failure mapped to stop-first, pinned by a test
  - Outpost's `/deploy` asks `docker.pivot` after the build when the caller sent `swap: 'start-first'`, and `swapFor` maps the verdict (`FJS-D1846`). The answer carries `swap` (what ran), `pivot` (the verdict, `null` when none was reached) and `swap_reason`.
  - The "before" side is the live image's `db/`, carried into the new image's `litestone release --from=/fjs-before/schema.lite --json` by a Docker volume filled on `docker create`, one per call and removed after. A host directory was tried first: `docker cp` to it failed on a snap docker under `~/.cache`. The classifier runs with `--network none`, so an image without the CLI fails fast rather than downloading it.
  - Stop-first with a reason: a contract, an unknown (with the baseline's note), a classifier that did not run, a live image that would not create, an App with nothing live. An app whose Litestone config names a schema other than `db/schema.lite` reads as unknown, so it is stop-first.
  - `bun run test` passes 373 (4 new). `bun run verify:docker` passes 69, 3 new: whoami's binary on `oven/bun:1.4.4-slim` with this workspace's Litestone, built in the drive at v1 and v2. v1 → v2 overlapped as `expand`, v2 → v1 swapped stop-first as `contract`, and no `fjs-before-*` volume was left. The probe images from 0.2 gave `expand`, `contract` and `unchanged` the same way.
- [x] 2.2 `/deploy` carries `swap` for an App whose owner turned start-first on (`FJS-D1847`): an App setting, off by default, on the App's settings screen. An `exposesPort` App is always stop-first
  - Waited on 3.1 (`FJS-D1840`), which is done: this is the step that ships start-first.
  - Built (`FJS-D1882`): `App.swap DeploySwap @default(stopFirst) @label("Swap order")`, migration `app_swap`, snapshots regenerated. `startBody` reads it off the live App, rollbacks included, and sends `start-first` only where Outpost's `checkSwap` would accept it (a published port, a host or path route, no `hasExposedPort`); otherwise `stop-first`. The edit drawer offers the column through the App's default form; the Config tab's Runtime card shows a Swap order fact with the expand-only hint. `db/test/schema.test.ts` names `swap` exempt from the runtime columns.
  - `bun run test` in basecamp: 1205 pass, 1 fail (an MCP gate case past 5 s under load; 146 pass with it, `rollback.test.ts` and `db/test` at a 60 s timeout). Five new cases in `rollback.test.ts`. `bun run verify:build` 9/9. `verify:screens` 332/332 on `API_PORT=7920 UI_PORT=7921` (both default slots held by long-lived servers), with the Config fact and the edit form's swap order checked.
- [x] 2.3 The Deployment row records the swap that ran and, for stop-first, the reason
  - `Deployment.swap` (`DeploySwap { startFirst stopFirst }`) and `swapReason`, both `@system`, in the initial migration since the 2026-11-04 squash. The deploy step reads `/deploy`'s `swap` and `swap_reason` (`swapOf` in `jobs/deployment-run.job.ts`) and `recordStep` writes them with the digest. A reply that names no swap, such as the stub's, writes neither rather than guessing stop-first. Until 2.2 sends `swap`, a real release records `stopFirst` with no reason.
  - The deployment screen shows a Swap fact under Build, the reason beside a stop-first.
  - `bun run test` in basecamp: 1162 pass, 2 fail. The two that failed (`audit-gate-parity-matrix`, `push`) ran past 5 s under the full run's load and pass alone (63/63). Two new cases in `rollback.test.ts`: a contract rollback records `stopFirst` with its reason; an overlap records no reason; a reply without `swap` records nothing. `bun run verify:build` 9/9. The screen with a swap set has not been seen in a browser.

## Phase 3 — `fli deploy` over SSH

Goal: both deploy paths take the same swap for the same release.
Done when: `swapContainer` runs start-first from the same verdict Outpost computes, under the same rules (`FJS-D1884`). This phase gates the plan's done (Q4).

- [x] 3.1 One owner of the swap for `swapContainer` and `docker.deploy` (`FJS-D1840`)
  - Done 2026-11-04 (`FJS-D1866`): `outpost/src/swap.js` `createSwap` + `runFlags`, driven by `docker.deploy` and by the cli's `swapContainer` over `core/swap.js`'s ssh runner; 06-swap/07-health and revert's 03-swap/04-health merged; one table in `outpost/test/fixtures/swap-cases.js`. outpost `bun run test` 398 pass, `verify:docker` 69, cli `bun run test` 4309 pass.
- [x] 3.2 Start-first in `fli deploy`
  - Built (`FJS-D1884`): `deploy.swap: 'startFirst'` asks; `livePivot` and `swapFor` now live in `outpost/src/swap.js`, and `swapContainer` runs the classifier on the target over ssh, then `createSwap.startFirst` with Caddy's routes moved by `routeMover`. Any swap that moves the live port re-points the routes, and `07b-edge`, `deploy:setup`, `deploy:status` and the pause verify read the port off the daemon (`livePort`). `06-swap` prints the swap and records `{ swap, swapReason, pivot }` as its journal output.
  - Proof: outpost `bun run test` 398 pass, `verify:docker` 69. cli `test/deploy-helpers.test.js` 94 pass, 8 of them new start-first cases (the shared table's three over the ssh runner and a fake Caddy, plus contract, no classifier, no route, not asked, misspelled). The full cli `bun run test` ran 4315 pass and 5 fail. Three pass alone; the other two time out at 5 s alone too, in `register-atlas` and `repo-work`, which read the root registers. No real box has run a cli start-first yet; that is 4.1.

## Phase 4 — Prove it on a real box

Goal: zero failed requests across an expand release on yuma.
Done when: 0.1's loop shows no non-2xx across an expand release, and a contract release prints its stop-first reason.

- [ ] 4.1 Re-run 0.1 against an expand release and a contract release; record both
