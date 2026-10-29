# basecamp — package map

**An FJS application, not a library.** A fleet-operations app, and the largest
dogfooding surface in the repo — building it is how framework defects get found.
All three realms are real.

```
fli dev              # preflights the ports and the database, then runs `dev`
bun run dev          # API + web together, no preflight
bun run test         # bun — the db tests
bun run verify       # browser checks across all three realms; starts and stops both servers
bun run verify:build # builds, then probes the PRODUCTION output (FJS-085)
bun run db:types     # regenerate db/schema.d.ts — the client's types
bun run db:seed      # an example fleet
bun run verify:screens # the Phase 13 and 14 screens + the audit window,
                       # in a browser, on a database it seeds in a temp directory
API_PORT=7120 UI_PORT=7020 bun run verify:screens  # …beside a dev server on
                       # 8120/8020; verify:provision takes the same two
bun run db:reset     # stops the servers, deletes the databases
bun run dev:outpost  # after `dev`: this laptop enrolled as a fleet machine, a
                     # real Outpost on 8180/8181, waits until it is ONLINE
bun run verify:sso   # provider sign-in in a browser, against an OIDC stand-in;
                     # a navigation to /auth/oauth/* must reach the API, not the shell
bun run verify:caddy   # the image's Caddyfile run by caddy:2 (docker) over a stub API:
                       # /auth/oauth/* as a document reaches the API, other pages get the shell
bun run verify:outpost # the launcher + API + Outpost as processes, no browser
bun run verify:hub-restore # a hub backed up to SeaweedFS, restored at /setup across a
                           # restart, its replicas found; docker + Chrome + litestream 0.5
bun run verify:mcp     # /mcp at four roles over a real MCP client, no browser
bun run cli servers status   # the app on a command line — login --api-key - first
bun run verify:cli     # that program as a process against a real /mcp, no browser
bun run build:cli      # …compiled: cli/dist/bcamp (fli cli:build; --target for others)
bun run build:desktop  # desktop/: web/ bundled into a Tauri shell, at
                       # desktop/shell/target/debug/basecamp-desktop; needs `bun run api`
bun run verify:desktop # that shell, signed in and scanning, on 7120 — rebuild after
fli desktop:run        # build it, start the API if nothing answers on 8120, open the window
fli desktop:install    # add it to the app launcher; a click opens it through desktop:run
                       # (--release: the release shell, after fli desktop:run --release)
DEVTOOLS=1 bun run api   # …and junction's console on 5503 beside it
bun run image        # build the container image from the WORKING TREE
bun run image:up     # …and bring the stack up on 8020  · image:down stops it
```

**Devtools is opt-in and there is one of it.** `DEVTOOLS=1` puts junction's
devtools on **5503**, and `fli gui`'s `:live` draws it (`--devtools-port` when
`DEVTOOLS_PORT` moved it) — the live call feed, `/metrics` with conduit's and
caravan's own sections, readiness, and the job queue with its six queues,
every handler's schedule, and retry / cancel / run-now. It is the only screen
that can see the queue at all: `/jobs` in the SPA is basecamp's own `Job`
model, which is a fleet noun and not the thing running it.

The API banner states it either way (`devtools=…` / `devtools=disabled`), so
there is no guessing whether it came up.

It is off by default rather than on in development because 5503 is a GLOBAL
port (`packages/cli/core/ports.js` § the tooling block) — one console at a time,
so running basecamp's and `example`'s together is a collision rather than two
consoles. Safe to leave wired: the plugin refuses to bind under
`NODE_ENV=production` with no auth gate.

**The image packs the workspace into its own build context.** Nine
`workspace:*` deps that a Docker build can resolve no more than `link:`
(`FJS-241`), so the packing and the manifest rewrite (`overrides` included, or
sierra installs mesa from npm and the image runs two trees) are done by **`fli`'s
own `packages/cli/core/vendor.js`** — the same module `fli deploy:vendor` runs
over a client app, imported by path rather than through `node_modules`, where a
`bun install` copy would be whatever the last install saw. `deploy/build.mjs`
calls it, hands it the script pruning this image wants, and generates
the Caddy config from `web/config/api-paths.js`. Two containers: the API is an
image, the SPA is static files behind a proxy — one process serving both would
need an `apiPrefix`, because `GET /{service}` matches almost any single-segment
path and `/apps/` in a browser would answer JSON.
`ENCRYPTION_KEY` is required and has no default there;
**losing the encryption key loses every `@encrypted` column in that volume.**

**An interrupted `verify` cleans up after itself** — SIGINT/SIGTERM/SIGHUP and
an uncaught throw all kill the API, the Vite and the Chrome it started, and
remove its scratch directory.

`verify` runs the API on a database of its own in a temp directory —
`DATABASE_URL`, the jobs queue beside it, `AUDIT_PATH`, `SITES_DIR` and
`WORKBENCH_DIR` all point there — so `db/` is never opened. It needs both ports
free: API **8120**, web **8020**. That web port is the same one
`example/` uses — they cannot serve at once, and only this side is strict about
it (`strictPort`, plus `fli dev`'s port preflight, which reads the surfaces
that exist and derives their ports from `packages/cli/core/ports.js`).

---


---

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `db/schema.lite` (every model declares `@@gate`) · `db/schema.d.ts` is generated and committed — the client's types · `db/migrations/main/` · `db/seed.js`.
- `api/index.ts` starts; `api/src/app.ts` builds the app and never starts it — `createApp({ principal: membershipClaim(…) })` is where the per-workspace level is resolved · `api/src/core/gate.ts` is the ladder.
- `api/src/core/` sets up what the framework ships (`FJS-D625`): `db`, `env`, `gate`, `capabilities`, `hooks`, `session-auth`, `mailer`, `credentials` (both conduit ref forms), `channels`, `resource`. Domain logic goes in `api/src/domain/<area>/` (`FJS-3518` emptied `core/` of it): `domain/release/` (`app-source.ts` the one reader of `App.source`, `dockerfile-template.ts` the two seeds an App's Dockerfile starts from, `runtime.ts` how a container starts, `host-port.ts` which host ports a machine's Apps hold, `variables.ts` what a container's environment is, `release-record.ts` a release's run), `domain/site/` (an owner's drafts), `domain/workbench/` (Claude Code chats per pinned checkout), `domain/notification/` (`notify.ts` does this person want it, `delivery.ts` how a NotificationChannel is reached, `kinds.ts` the NotificationKind list), `domain/alert/` (`alerting.ts`, the pure breach evaluator), `domain/host/` (`posture.ts`, `reachability.ts`, `server-metrics.ts`, `host-machine.ts`: a fleet machine's grade, contact, readings and Basecamp's own box; `traffic.ts`, an app route's traffic as the Outpost's `/analytics` counted it, and each empty answer by name; `components.ts`, where each stack component's advisories are published; and the operator scripts `fli` runs by path, `enroll-host.ts`, `provision-host.ts`, `host-record.ts` over `bearer-send.ts`), `domain/monitor/` (`probe.ts`, a Monitor's grade), `domain/local/` (`local-ssh.ts`, `local-git.ts`: the operator's own machine read as a source, behind `localMachineRefusal`), `domain/register/` (`registers.ts`), `domain/api-key/` (`scopes.ts`), `domain/job/` (`job-schedule.ts`, the one clock), `domain/cleanup/` (`disk-report.ts`), `domain/backup/` (`backup-archives.ts`, `archive-manifest.ts`, `hub-restore.ts`, `found-replicas.ts`).
- `api/src/services/` one folder per service · `jobs/*.job.ts` autoloaded by caravan · `notifications/` one file per kind, the FILE NAME is the type · `providers/` is who the app speaks to (`compute/`, `edge/`, `source/`, `outpost.ts`, `executor.ts`) · `plugins/`.
- `web/src/` — `App.mesa`, `routes/`, `components/` (`NoRecord.mesa` ends every detail screen), `resources/` (one Resource per file) · `web/config/api-paths.js` is DERIVED from `app.snapshot.md` · `web/test/verify.mjs` + `verify-build.mjs` are the drives.
- `cli/` is `bcamp` — `src/routes/<service>/<method>.js` hand-written, everything else is `/mcp`'s tool list · `deploy/build.mjs` builds the image · `docs/` is the depth (`SCREENS`, `ADAPTERS`, `PROVISIONING`, `VISION`).

## What bites here

The dozen that bite most; the full catalog is `docs/hazards.md`, read it before
touching a gate, tenancy, a deploy, a channel or a notification.

- **A level is per WORKSPACE, and it rides on the principal** — `sessionGateLevel()` is not used here; `membershipClaim` in `app.ts` reads the `WorkspaceMember` row once per request (`FJS-D113`).
- **`Server`, `Environment` and `Variable` are graded on TWO axes** — the gate and the workspace, and a hook grades neither.
- **`narrowPatch(data)` takes no list: which columns a patch drops is the schema's** (`FJS-D1243`); thirteen models declare `@version`, and a service-side write must carry it.
- **`db/schema.d.ts` is generated, committed, and the only place the client is typed** — `bun run db:types` after a schema change, or the SPA lies.
- **Tenancy is DECLARED, one block at the top of the schema**, and the crossing is asserted by `verifyTenantIsolation()`; `asSystem()` has to survive a transaction.
- **A session carries three columns auth knows nothing about**, and `suspended` has two doors — login and the session read — and both are needed.
- **`autoValidate` deletes every key the model does not declare**, `ctx.params` does not exist in Junction at all, and `before: { all: [...] }` hits every method, outpost endpoints included.
- **Leaving a method out does not remove it** — `createService({ model })` brings the whole CRUD set; refuse it by name.
- **A conduit target carries a REF, not a credential** (`secret:<id>` / `env:<NAME>`, `core/credentials.ts`).
- **`API_PATHS` is DERIVED from `app.snapshot.md` — do not add a path to it**, and the three API snapshots are at the PACKAGE ROOT here.
- **Nothing in the browser names the workspace** — it is the header, and a model whose required columns are server-written cannot be created from the form.
- **A deploy resolves an EXECUTOR before it does anything**; a release that names a digest uploads and builds nothing; a tag is not an identity, a digest is.
- **A service DECLARES its channel and runs no announce hook**; a connection carries no workspace, so `channels({ claims })` says which one it hears.
- **Only `recovered` resolves an alert**, and a rule's condition is COLUMNS with one delivery owner (`domain/notification/delivery.ts`).
- **Zero raw SQL against the live data, on purpose** — `db.asSystem().sql` is the only bypass and it enforces nothing; the backup domain's reads of files no client holds are the one exception.

---

## Proving a change

`bun run test` + `bun run verify`, and `bun run verify:build` for anything that
could change what the built page loads. A framework change that touches services,
auth or channels should be run here *as well as* in `example/` — the two apps
fail differently.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
access.snapshot.md account-mail.ts accounts.ts ADAPTERS.md alert-evaluate.job.ts alerting.ts 
ApiKey.mesa api-paths.js App.mesa app.snapshot.md app-source.ts app.ts automations.ts 
bearer-send.ts build.mjs capabilities.ts cli.config.js credentials.ts db.ts delivery.ts 
dependencies.ts dockerfile-template.ts domain-dns.job.ts executor.ts gate.ts generate.js hooks.ts host-record.ts index.ts 
job-run.job.ts job-schedule.ts kinds.ts litestone.config.js local-git.ts local-ssh.ts machine-stream.ts mailer.ts 
main.js monitor-sweep.job.ts NoRecord.mesa notices.js notify.ts outpost-dev.ts outpost-run.ts 
outpost.ts package.json probe.ts provision-host.ts PROVISIONING.md push.ts README.md 
registers.ts release-record.ts runtime.ts schema.d.ts schema.lite scopes.ts SCREENS.md seed.js 
server-metrics.ts session-auth.ts session.js site-ask.ts site-checkout.ts site-photo.ts 
site-preview.ts site-publish.ts Terminal.mesa variables.ts VISION.md workbench-branch.ts 
workbench-check.ts workbench-diff.ts workbench-preview.ts workbench-run.ts workbench-shell.ts workbench-terminal.ts 
workbench.ts -->
