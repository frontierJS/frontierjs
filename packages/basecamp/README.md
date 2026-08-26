# Basecamp

**Developer command central for the FJS World.** Provision servers, ship
releases, install the self-hosted infrastructure your applications depend on,
and see what is running where.

Basecamp is an **FJS application, not a library** — it is the largest thing
FrontierJS has been used to build, and it is built entirely in FrontierJS:
Litestone for data, Junction for services, Sierra + Mesa for the UI. That is
deliberate. If operating a fleet cannot be expressed cleanly in FrontierJS, that
is a finding about FrontierJS.

> **Alpha, and honest about it.** All three realms work and are verified by
> running them — `bun run verify` drives the UI in a real browser. What is
> missing is listed under [Known gaps](#known-gaps), and gates are the big one.

---

## Quick start

```bash
cd packages/basecamp
bun run dev          # API on :8120 and the UI on :8020
```

`bun run api` and `bun run web` start them separately. `dev` refuses to start if
either port is already taken, because a stale server keeps the OLD database open
— including one that has been deleted — and then answers every request from it.

The database is created and migrated on first boot. There are no users yet, so
bootstrap one — this is the only unauthenticated write in the app:

```bash
curl -X POST localhost:8120/setup \
  -H 'Content-Type: application/json' \
  -d '{"workspace_name":"Acme","name":"Sam","email":"sam@example.com","password":"hunter2hunter2"}'
```

That returns a `token`, the `user`, and a `workspace_id`. Then:

```bash
TOKEN=…   WS=…

# every scoped call needs the workspace header
curl localhost:8120/projects \
  -H "Authorization: Bearer $TOKEN" -H "X-Workspace-Id: $WS"
```

`GET /setup/probe` → `{ workspaces, users, needs_setup }` is what the first-run
wizard polls. To start over: `bun run db:reset` (it stops the servers first, for
the reason above).

Or do all of this in the browser at <http://localhost:8020> — the wizard, login
and sign-out are built.

**Or skip the empty app entirely:**

```bash
bun run db:seed      # 4 users, 2 workspaces, a fleet with history
```

Then sign in as `sam@example.com` (or kim@ / remy@ / jo@) with `hunter2hunter2`.
Seeding is idempotent — a second run does nothing; `--force` starts over.

### Scripts

| | |
|---|---|
| `fli dev` | both servers, after the port and database preflights |
| `bun run dev` | both servers, no preflight |
| `bun run api` | API with `--watch`, :8120 |
| `bun run web` | UI dev server, :8020 — proxies the API paths to :8120 |
| `bun run stop` | kill whatever the last run left behind |
| `bun run start` | API, no watch |
| `bun run build` | `db:check` then the UI production build into `web/dist/` |
| `bun run preview` | serve that build |
| `bun run test` | schema + data-layer suite — 92 tests across 3 files |
| `bun run verify` | drive the UI in a real browser — add `--reset` for an empty database |
| `bun run typecheck` | package-local diagnostics |
| `bun run db:ddl` | regenerate the migration from `db/schema.lite` |
| `bun run db:check` | fail if the migration is stale — wire into CI |
| `bun run db:tables` | dump the live schema out of SQLite |
| `bun run db:seed` | example fleet — 4 users, 2 workspaces, servers, deployments, jobs, audit trail. `--force` re-seeds |
| `bun run db:reset` | stop the servers and delete the database, jobs queue and audit trail |

### Configuration

Everything is environment variables, declared and validated in
`api/src/core/env.ts`. Two matter on day one:

| var | default | |
|---|---|---|
| `PORT` | `8120` | |
| `DATABASE_URL` | `./db/basecamp.db` | CWD-relative — start from the package root. The path is declared in `db/schema.lite` as `database main { path env("DATABASE_URL", …) }`, so the schema is what decides it and this variable steers that declaration |
| `ENCRYPTION_KEY` | dev placeholder | 64 hex chars — `Secret.data` is encrypted at rest |

```bash
openssl rand -hex 32
```

**The dev default is public — it is in this repo.** `NODE_ENV=production`
refuses to boot on it: `core/db.ts` rejects the placeholder `ENCRYPTION_KEY`.
That matters because encrypting SSH private keys with a published key is *worse*
than not encrypting them — the column reads as protected while being trivially
readable.
A malformed key (not 64 hex chars) is rejected in any environment.

---

## Layout

An FJS app is three directories at the root, one per realm, orbiting a shared
schema:

```
basecamp/
  db/                        ← Data realm — Litestone
    schema.lite              ← the seed. everything derives from this
    migrations/              ← GENERATED. never hand-edited
    test/
  api/                       ← API realm — Junction
    src/
      core/                  ← app, db client, env, hooks, resource helpers
      services/              ← one directory per service
      jobs/                  ← one *.job.ts per job — autoloaded by Caravan
      providers/             ← who the app speaks to: the 8 self-hosted
                               appliances, plus executor and outpost
  web/                       ← UI realm — Sierra + Mesa
    config/                  ← sierra.config.js + vite.config.js
    src/
      routes/                ← file-tree routing (.mesa)
      resources/             ← one .mesa per service (invariant 18)
```

**`db/schema.lite` is the single source of truth.** The SQL in `db/migrations/`
is generated from it; editing that SQL by hand is how the two drift apart, and
`bun run db:check` exists to catch exactly that.

---

## State

| Realm | | |
|---|---|---|
| **Data** | ✅ Done | 45 models, 26 enums, `database main` declared. **Every model declares a `@@gate`**, and tenancy is one declared block — `tenancy { strategy row  column workspaceId  claim workspaceId }`, with fourteen `@@tenant(none)` declared and fourteen scoped through a parent by inference, so **34 models carry a row policy**. Migration generated and verified against a fresh database. |
| **API** | ✅ Done | 27 services + 5 job files on Litestone accessors, zero raw SQL. Auth via `@frontierjs/auth`. `/hub/` is the cross-workspace tier — a separate service behind one `requireSystemAdmin` hook. Verified over HTTP end to end. |
| **UI** | ✅ Built | Sierra SPA covering every service: setup, login, guard, workspace switcher, Projects → Environments → Apps, deployments with a live step timeline, the server fleet (drain/reboot/sync, event trail, outpost heartbeats), jobs with run history, and an admin zone (members, audit trail, adapters). `bun run verify` drives all of it in a real browser — **90 checks**, including an accessibility pass on every screen. `docs/UI_PLAN.md` has what building it found. |

What works today, checked by running it: first-run setup, password login,
workspaces and membership, projects → environments → apps, environment
variables, servers (including outpost heartbeat and drain/undrain), jobs, and
deployments — where the job runs through Caravan and advances a release
step by step.

### Access control

**Declared in the schema, per Invariant 6** — all 45 models carry a `@@gate`, and
the ladder is per WORKSPACE rather than per app. `api/src/core/gate.ts` maps
`WorkspaceMember.role` onto the gate ladder:

| Standing | Level | |
|---|---|---|
| authenticated, no membership | VISITOR (1) | reads `Workspace` only |
| `viewer` · `billing` | READER (2) | reads the workspace |
| `developer` | USER (4) | the day job |
| `admin` | ADMINISTRATOR (5) | servers, secrets, keys |
| `owner` | OWNER (6) | |
| `isSystemAdmin` | SYSADMIN (7) | the hub tier, above any membership |

`createApp({ principal: membershipClaim(…) })` resolves it once per request
**onto the principal**, not onto the client — Junction re-derives its scoped
client from `ctx.auth.user`, so a standing set on the client alone is dropped.
An unknown role grades VISITOR rather than defaulting upward: an enum value
added to the schema and forgotten here must lose access, not gain it.

The same read answers *which tenant*, which is why it is one seam and not two.
The fourteen models with no `workspaceId` of their own are scoped through a
parent, and that is INFERRED rather than declared — litestone walks the
belongs-to relations and reports the fourteen by name in a standing warning.
`@@tenant(via: rel)` exists and is the wrong answer for seven of them: a model
with two scoped parents gets one deny per parent and they are AND'd, so naming
one relation drops the other. `Workspace`, `WorkspaceMember` (standing is read
from it), `AuditEvent` (nullable workspace) and the five auth models declare
`@@tenant(none)` by name.

### Known gaps

- **Auth is password-only.** No OAuth. Bearer tokens; `cookieAuth` exists in
  `@frontierjs/auth` and this app has not turned it on.
- **The appliance providers are stubs** until their env vars are set — Infisical,
  Unleash, Typesense, Zot, Forgejo, Grafana/Loki, NetBird, Nango.

---

## Where to read next

| | |
|---|---|
| `docs/UI_HANDOFF.md` | **Building the UI? Start here.** API contract, what to build with, what not to port from the mock |
| `docs/UI_PLAN.md` | The phased UI build, with the checkpoint each phase met and what it found |
| `CHANGES.md` | History, newest first |
| `db/README.md` | The Data realm: conventions, identity, encryption, the audit trail, intended gates |
| `PROJECT_STATE.md` | Current state in detail, and what each pass found |
| `docs/VISION.md` | What Basecamp is *for*. Aspirational and says so at the top |

---

## Two things that will bite

**Custom methods dispatch on a header, not a sub-path.** `POST /servers/:id/drain`
is a 404. It is `POST /servers/:id` with `X-Service-Method: drain`.

**Nothing is under `/api`.** Services are `/{service}`, auth is `/auth/*`, setup
is `/setup`. The prefix auth and setup used to carry was removed 2026-08-04 —
it made them the only prefixed paths in the app and broke the browser client's
`needsSetup()`, which asks for `` `${apiPrefix}/setup/probe` ``.

**The wire contract is the schema's field names, in camelCase.** `ipAddress`,
not `ip_address`. A wrong key does not error — validation strips it, the write
succeeds, and the column comes back `null`.

---

*Part of [FrontierJS](../../README.md). Alpha — nothing here is published.*
