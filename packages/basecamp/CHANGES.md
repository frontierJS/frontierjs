# Basecamp — changes

Newest first. What changed and why; the current state is `PROJECT_STATE.md`.

## 2026-08-04 — the UI realm

`web/` went from a 12,557-line React mock that had never made a request to a
Sierra SPA over every service. Phases and what each found: `docs/UI_PLAN.md`.

- **Screens.** Setup wizard, login and a navigation guard; workspace switcher;
  Projects → Environments → Apps with environment variables; deployments with a
  live step timeline; the server fleet (drain/undrain/reboot/sync, event trail,
  agent heartbeat); jobs with run history; an admin zone (members, audit trail,
  appliance adapters).
- **`bun run verify`** — drives all of it in a real browser over CDP and asserts
  **90 facts**, including an accessibility pass on all ten screens. `--reset`
  starts from an empty database. Checks that wait on something arriving poll
  rather than sleep, after a fixed sleep produced one 89/90 run.
- **`bun run db:seed`** — an example fleet: 4 users, 2 workspaces, 9 servers, 80
  deployments with steps, 30 jobs with runs, secrets, audit events. Idempotent;
  `--force` re-seeds.
- **`/audit`** — a new read-only service over `AuditEvent`, admin/owner only.
- **`database main`** is now declared in `db/schema.lite`, so the schema decides
  the database file and `DATABASE_URL` steers that declaration.
- Scripts regrouped: `dev` (both servers, after a port preflight), `api`, `web`,
  `stop`, `build`/`build:*`, `db:*`, `verify`.
- `VISION.md` moved to `docs/` per the root doc convention.

### Fixed in the framework, found by building this

- **Junction dropped the workspace on the WebSocket.** The browser client routes
  CRUD over the socket once one is open and the frame carried no
  `X-Workspace-Id`; the server only sees the upgrade request's headers, so a
  per-call value could not arrive. Client now sends `meta.workspaceId` and the
  channels transport merges that one key onto `ctx.client.headers`.
- **Channels had never delivered anything.** The connection joined
  `workspace:${session.workspace_id}` — the field is `workspaceId`, and auth
  never populates it — and both engines called `channel.publish()`, which does
  not exist (`publish()` is on the manager; a channel has `send()`). Their own
  guards made it a silent no-op.
- **`POST /workspaces` was unreachable**: `autoValidate` demanded `accountId`
  and `ownerId`, which `create()` takes from the session on purpose.

### Fixed here

- **The audit trail was writable.** `createService({ model })` grants the full
  CRUD set, so declaring only `find()` left create/patch/remove answered by the
  base service — an admin could forge a row, verified. Now 405.
- **Four custom methods answered a partial row** — `setVariable`, the deployment
  engine's projection, `heartbeat`, `jobs.trigger` — each breaking a caller that
  assigned the result over the record it was rendering. All return the record.
- **The agent heartbeat published to nothing**: `workspaceChannel` reads
  `ctx.locals.workspaceId`, which `sessionScope` sets, and heartbeat is exempt
  from it. It now stamps the workspace from the server row.
- **The job engine published nothing**, so a triggered job wrote its `JobRun`
  and told nobody.
- **Tests were opening the development database.** They passed
  `createClient({ db: <tmpdir> })`, which a `database` declaration silently
  overrides; they steer `DATABASE_URL` now.

## 2026-08-03 → 2026-08-04 — Data and API realms

Rebuilt from "cannot start" to an app that boots and serves. `db/schema.lite` is
the seed (24 models, 15 enums); the migration is generated from it. All services
moved onto Litestone accessors — **zero raw SQL in `api/src`** — with identity on
`@frontierjs/auth`'s schema fragments. The `/api` prefix was removed from auth
and setup so every path in the app agrees. Detail in `PROJECT_STATE.md`.
