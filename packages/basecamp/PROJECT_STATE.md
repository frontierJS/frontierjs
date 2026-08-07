# Basecamp — project state

Last reviewed by running: **2026-08-04**.

> **Picking up this app?** `docs/UI_HANDOFF.md` is the API contract;
> `docs/UI_PLAN.md` is what building the UI found. Run `bun run verify` before
> changing anything — it drives all three realms in a real browser.

Basecamp is an **FJS application, not a library** — fleet operations: provision
servers, ship releases, install appliances. It is the largest thing FrontierJS
has ever been used to build, which is why its divergences matter more than the
usual drift note: **every one of them is evidence about the framework.**

`docs/VISION.md` describes what Basecamp is meant to be and says so at the top.
This file describes what it currently does.

## Snapshot

| Realm | State |
| --- | --- |
| **Data** (`db/`) | **Real.** `schema.lite` is the seed — 24 models, 15 enums, 0 errors / 0 warnings; the migration is generated from it and verified against a fresh database |
| **API** (`api/`) | **Real.** 9 services + 2 engines on Litestone accessors, zero raw SQL |
| **UI** (`web/`) | **Real.** Sierra SPA over every service — 19 route files, driven end to end in a browser by `bun run verify` (**110 checks**) |

## How to run it

```bash
bun run dev          # API on :3001, UI on :5274
bun run db:seed      # an example fleet to look at
bun run verify       # drive the whole thing in a browser (add --reset)
```

Sign in as `sam@example.com` / `hunter2hunter2` after seeding, or use the setup
wizard on an empty database.

**Historical note.** Until 2026-08-04 this file opened with "It cannot start":
there was no `package.json` anywhere under `packages/basecamp`, so the
`packages/*` workspace glob skipped the directory entirely and the first import
died on `Cannot find module '@frontierjs/junction'`. That, the two dead paths in
`app.ts`, and the hand-rolled HMAC auth are all gone. Kept here because the
failure mode — a directory invisible to the workspace glob — is one this repo
has had more than once.

## API realm — vertical slice landed 2026-08-04

The app **boots and serves**. `bun run dev`, then `POST /setup` → login →
`POST /servers`. Verified over HTTP end to end, not by reading.

Wired:

- `api/src/core/db.ts` — the Litestone client, THE Data boundary. `createApp({ db })`
  installs `withLitestoneDb`, so every service gets a caller-scoped client on
  `ctx.locals.db`.
- `@frontierjs/auth` replaces the hand-rolled HMAC `IAuth`. `basecamp-auth.ts`
  is **deleted** — it read `password_hash` off `user`, a column that moved to
  `Credential`. Auth mounts `/auth/*`; the password is now a bcrypt hash in
  a `Credential` row, and `user` has no `password_hash` column at all.
- `POST /setup` runs in ONE transaction (account + user + workspace +
  membership). The old version opened with three unconditional `DELETE`s to
  clean up after its own partial failures.
- All 8 services + both engines on accessors with `createService({ model })`,
  zero raw SQL. `core/hooks.ts` and `core/resource.ts` likewise.
- `ENCRYPTION_KEY` in `core/env.ts`, required — `createClient()` throws without it.
- **Layout**: `app.ts`, `db.ts`, `env.ts`, `hooks.ts` live in `api/src/core/`.
  Note the root `README.md` §Project Structure puts `app.ts` at `src/` root with
  only env/db/auth/hooks under `core/` — Basecamp keeps all four together.

Both audit trails confirmed live: row-level `@@log(audit)` captured 12 writes
(including `credential create`), and the application `AuditEvent` trail recorded
`servers.create` / `servers.remove` with the actor. **The password never appears
in the audit log** — the redaction fix, in a real app.

### Four things the slice found

1. **A SERVICE context has no `ctx.params`** — confirmed at runtime, not by
   reading types: `'params' in ctx` is `false` and the key list is
   `$raw app auth client data directives dispatch error id locals method model
   query result route service statusCode transport type`. Every Basecamp
   service read `ctx.params.user.user_id` (snake) and `ctx.params.headers` —
   both `undefined`, so **the workspace role checks silently passed for
   everyone**. Headers are `ctx.client.headers`; per-call scratch is
   `ctx.locals`.

   The confusion is Junction's, not Basecamp's: a **TransportContext** *does*
   have `params` (raw routes use `ctx.params.id`, as Junction's own webhooks
   plugin does), and Junction's comments claim it for service contexts too —
   `core/app.ts:218` shows `app.service('users').get(id, ctx.params)` and
   `core/litestone.ts:11` says the query tap is "cached on ctx.params" when the
   code writes `ctx.locals`. Stale Feathers idioms; worth fixing upstream.
2. **`before: { all: [...] }` really does mean all.** `servers.heartbeat`
   carried a comment claiming exemption from `authenticate` while sitting behind
   it, so the agent could never check in — every heartbeat 401'd. `sessionScope`
   in `hooks.ts` now takes an explicit `except` list.
3. **`$limit`/`$offset` never reach a service.** They are transport syntax
   parsed onto `ctx.directives`; `getPagination` read `ctx.query.$limit` and
   `ctx.$raw.query.$limit`, neither of which exists.
4. **The wire contract is the schema's field names.** `autoValidate` strips
   unknown keys, so `ip_address` silently vanishes and the column comes back
   null. Send `ipAddress`.

### All 8 services and both engines converted (2026-08-04)

*(The ninth, `/audit`, arrived with the UI — the admin zone needed a trail to read.)*

**Zero raw SQL remains in `api/src`.** Verified over HTTP end to end on a clean
database: setup → login → workspace → project → environment → app → env
variable → job → deployment, with the deployment engine running through Caravan
and completing all six steps, setting the app to `running`, and the job engine
recording JobRuns.

`core/resource.ts` holds what the seven workspace-scoped services share
(`findScoped`, `getScoped`, `stampWorkspace`, `narrowPatch`, `removeScoped`).
The workspace clause lives there rather than in each service because omitting
it is a tenancy leak, not a style slip.

Three bugs fixed on the way through:

- **`workspaces` enforced nothing.** `requireWorkspaceRole` reads
  `ctx.locals.workspaceId`, which only `requireWorkspace()` sets — and that
  service has no `X-Workspace-Id` header because the workspace *is* `ctx.id`.
  The hook hit its `if (!userId || !workspaceId) return` guard every time, so
  any authenticated user could rename or delete any workspace, or promote
  themselves inside it. `stampSelfAsWorkspace` fixes it.
- **`setMemberRole` could demote the last owner**, leaving a workspace nobody
  could administer. Now refused.
- **`EnvironmentTier` had 3 values; the service offered 5.** `preview` and
  `test` would have been rejected by the schema's CHECK constraint. Schema
  widened — the service was the older evidence.

Also: `env.PORT`/`env.HOST` were declared and never read, so the app ignored
them and took junction's default (3000). Now passed into `createApp`.

## The Data realm is the good half — read `db/README.md` before touching it

Rebuilt 2026-08-03. `db/schema.lite` parses clean, and
`db/migrations/001_initial_schema.sql` is **generated** from it by
`bun db/generate.js` (`--check` fails CI on drift — never hand-edit the SQL).
Verified by applying to a fresh database: 24 tables, 79 indexes, 13 triggers,
`foreign_key_check` clean, every table `STRICT`, then driven through a real
`createClient` + `GatePlugin`.

Load-bearing decisions, all documented in `db/README.md`:

- **Identity is `@frontierjs/auth`'s.** `User` / `Credential` / `Session` /
  `Verification` come from `authSchemaFragments()`, so those four model names
  are load-bearing — renaming one breaks the auth package. Everything Basecamp
  adds to `User` is nullable or defaulted on purpose, because
  `auth.createUser()` writes only `{ email, name, role }`.
- **Two forced renames.** `model service` → **`App`** (the API realm owns the
  noun *Service*; `docs/VISION.md` §Vocabulary forbids the overload by name) and
  `model credential` → **`Secret`** (auth owns `Credential` and the
  `db.credential` accessor — a Credential is how a *person* proves identity to
  Basecamp, a Secret is how *Basecamp* proves identity to a machine).
- **Gates are declared in the schema, not in hooks.** `User` is `@@gate("8")`,
  so **even SYSADMIN(7) cannot read it — any member list must go through
  `asSystem()`**. `AuditEvent` update/delete are `LOCKED`, which `asSystem()`
  does **not** pass. `Secret.data` is `@encrypted`, so an ADMIN listing secrets
  gets a row with no `data` key at all. Proved by planting an SSH key through
  the real client: 0 occurrences in `strings bc.db`, 0 in the audit log.
- **The audit logger is on** for all 16 non-event models, credentials and
  sessions included. Safe only because Litestone redacts protected fields in the
  log as of 2026-08-03 — **Basecamp requires a Litestone from that date or
  later**; on an older one those models leak plaintext into the JSONL.

## Why the generated SQL broke the old services

Kept because it is the clearest example in this repo of the schema being the
seed. Litestone emits columns **verbatim camelCase** (`workspaceId`, not
`workspace_id`) and `DateTime` as **ISO-8601 TEXT**, not the `INTEGER` epoch-ms
the hand-written tables used — so regenerating the migration made every raw SQL
query in the app wrong at once, loudly, instead of letting the two drift apart
quietly. All eight services were rewritten onto accessors as a result; the
superseded SQL is at `db/legacy-sql/` and nothing reads it.

The wire contract inherits this: **field names are the schema's, in camelCase**.
`ip_address` does not error — `autoValidate` strips it, the write succeeds, and
the column comes back null.

## The UI (2026-08-04)

`web/` is a Sierra SPA over every service: first-run setup, login, a navigation
guard, the workspace switcher, Projects → Environments → Apps, deployments with
a live step timeline, the server fleet (drain/reboot/sync, event trail, agent
heartbeats), jobs with run history, and an admin zone (members, audit trail,
adapters). `bun run verify --reset` drives all of it in a real browser and
asserts **90 facts**, including an accessibility pass on every screen.
`docs/UI_PLAN.md` has the phases and what each one found.

Three framework-level defects surfaced by building it, all fixed:

1. **Junction dropped the workspace on the WebSocket.** The client routes CRUD
   over the socket once connected, and the frame carried no `X-Workspace-Id`;
   the server only ever sees the upgrade request's headers. Any header-scoped
   app worked until it went live. Client now sends `meta.workspaceId` and
   `transport/channels.ts` merges that one key onto `ctx.client.headers`.
2. **`POST /workspaces` was unreachable** — `autoValidate` demanded the two
   columns `create()` takes from the session. Stamped in a `before/create` hook,
   which runs ahead of the derived validation.
3. **Mesa cannot see reads made inside an imported module** (RULE 44/45), so a
   `currentWorkspace()` helper rendered once and never updated.

## The look — `theme-basecamp` (2026-08-06)

The prototype's palette is now a theme in `@frontierjs/css`
(`src/themes/basecamp.css`), and `web/index.html` wears it as one class on the
body. Nothing in `web/src` changed: a palette is tokens, and tokens are the
design system's job, which is what keeps it one class to swap back.

What the port found: **the prototype's neutrals failed WCAG AA and nobody had
measured** — its `sec` at 3.24:1 and `muted` at 1.53:1 as body text, across
2,761 inline `style={{}}` objects. Both are lifted by uniform linear-RGB
scaling, so the hue is exact and only the luminance moves, and they are targeted
at 7:1 and 4.6:1 rather than both at the AA floor so the three-step ink ramp
survives. The theme is in the `THEMES` array of three css specs, so it is held
to the same bar as the other six: **208 passing**, up from 205.

### ⚠ The production build was a blank page, and had been

Found by screenshotting the build, which nothing here had done. `web/index.html`
opened with a comment containing the literal text ``a theme go on <body>``, and
**Vite injects the built `<script>` and `<link>` at the first textual match for
the body tag without skipping comments** — so both tags landed *inside the
comment*. The build succeeded, `dist/index.html` looked right, and the page
loaded no JavaScript and no CSS: white screen, empty console.

It is the same trap CLAUDE.md records against `example/web/index.html`, fixed
there on 2026-08-04 and never checked for here.

**`bun run verify` cannot see this.** All 90 checks drive the *dev* server,
where Vite injects nothing — so the one thing that would ship to a user was the
one thing nothing tested. That gap is still open: verify should also build and
probe `dist/`, which would have caught it on the first run.

## Shell chrome (2026-08-06) — the first phase of the rebuild

The mock's attention system and ⌘K, over real rows. `bun run verify` is **98
checks**, up from 90; eight of them drive this. Details and what it found are in
`docs/SCREENS.md` § Phase 1.

- **`src/notices.js` is the one definition of "needs attention"** — a leaf
  module with no imports that takes rows and `now` and returns notices, so it
  runs in plain node and the shell's `NoticeBar` and the home screen's
  `ActionQueue` cannot disagree.
- **The shell subscribes, it does not poll.** A resource store is a module
  singleton fed by the WebSocket: servers/deployments/jobs load once per
  *workspace*, and an agent reporting 95% CPU reaches the notice bar with
  nothing asking again. That is the shape of the check — a heartbeat over HTTP,
  a notice on screen, **no reload**.
- **The shell is now `@frontierjs/ui` throughout**, and `<Toaster>` has a first
  caller: a server transition is confirmed where the operator is looking.

Two defects on the way through. `web/config/vite.config.js` never aliased
`@frontierjs/ui` to the workspace source — it worked only because of a
hand-made symlink a reinstall would remove. And in Mesa, **`prop=""` on a
component compiled to `prop={true}`**: `<Select placeholder="">` rendered an
`<option>` reading `true`, which surfaced here as a third workspace in the
switcher. Fixed in mesa with 2 tests — `FJS-102`, closed.

## Portal, Activity, and the trail that recorded half of what happened (2026-08-06)

Phase 2 of the rebuild — the two mock screens whose data already existed.
`bun run verify` is **110 checks**, up from 98. Full write-up in
`docs/SCREENS.md` § Phase 2.

- **`/portal/` + `/portal/[id]/`.** The portal service was mounted and only
  `admin/adapters` read it. The split between the two screens is the service's
  own: `find()` declares (wired or stub, pings nothing), `get(id)` measures (a
  live ping through the adapter). Adapters asks *is this wired*; Portal asks
  *does it answer right now*, and the detail route pings on open.
- **`/activity/`.** The audit trail as a narrative — actor ids resolved to
  names, subjects linked to their own screens, kinds built from what happened.

**The gap it had to close first: the application trail recorded CRUD only.**
`basecampAuditLog` ran on `create`/`patch`/`remove`, so a server being
**drained** was recorded nowhere — nor deploy, cancel or trigger, which is most
of what an operator does. It now runs as `after: { all }` and decides what
counts the way Junction decides what to announce: everything but `find`/`get`,
and `ctx.dispatch = false` opts out. `servers.heartbeat` is excluded **by name**
— an agent on a timer would bury every human action, and `dispatch = false`
would have silenced the channel the live status pill depends on. Two more:
a custom action answers the row rather than the envelope, so reading only
`.data` filed every action against `subjectId: 'unknown'`; and an actor-less
write is now `actorType: 'system'` rather than the `'user'` default.

**Gating is deliberately deferred until every screen is built** — see the
ordered next steps. `/activity/` is the one screen already written against it:
the trail is admin/owner, and it renders the refusal rather than an empty table.

## The old UI mock, for reference

`docs/mock/BasecampUI.jsx` is one **12,557-line** file: `import { useState } from
"react"`, 93 components, **0 `fetch` calls**, ~20 hardcoded mock-data arrays,
2,120 inline `style={{…}}` objects and 0 `className`s against a private hex
palette. No Mesa, no Sierra, no `@frontierjs/css`.

It is a design prototype sitting next to an API it has never spoken to.

**`docs/SCREENS.md` is the inventory** (2026-08-06): the mock has **41 `*View`
components and 13 modals**, and `web/src/routes/` has 17 route files covering
**12 of the 41**. The other 29 are grouped there by what actually blocks them —
2 need nothing, 6 need a service over models that already exist (`AlertRule`,
`Network`, `Secret` are dead weight in the schema today), 15 need new models, 6
need a real outbound adapter. **The rebuild is mostly Data- and API-realm work**;
porting the JSX first would only produce more screens reading hardcoded arrays.

## Ordered next steps


*Steps 1–3 are tracked as **`FJS-007`** (no `@@gate`), **`FJS-032`** (no
invitation flow) and **`FJS-031`** (publishes on reads) in `../../ISSUES.md`.*

**Sequencing, decided 2026-08-06: gating goes LAST, after every screen.** It
would be in the way while the app is still being built, and this is a long way
from live. The cost is known and accepted — screens written before it will need
revisiting, the sysadmin Users screen most of all, since `User` is meant to be
`@@gate("8")` and even SYSADMIN does not pass. Screens flag it as they land.

1. **Declare `@@gate` in the schema.** *(Deferred to last — see above.)*
   Access control is service hooks today,
   which is weaker than the schema-declared version and the outstanding gap
   against repo Invariant 6. The blocker is a per-workspace `getLevel` mapping
   `WorkspaceMember.role` onto the 0–7 scale; intended levels are in
   `db/README.md` §Access control and the pattern is `example/api/gate.ts`.
   Expect the admin zone to break first — `User` is meant to be `@@gate("8")`,
   which even SYSADMIN does not pass, so a member list will need `asSystem()`.
2. **An invitation flow.** `/auth/register` creates a user with no account and
   no workspace, so every scoped request 400s and they cannot create a workspace
   either. `addMember` needs an existing user id. Today the setup wizard is the
   only way in.
3. **Narrow channel publishing to mutations.** Every service publishes after
   every method, reads included, so a `GET` broadcasts the row to everyone
   connected to the workspace. Noise rather than a leak, but the wrong default.
4. **`litestone types`** — 78 of this package's typecheck diagnostics are the
   untyped-accessor class and would go with generated types.
5. **Build the remaining 27 screens** — `FJS-101`, phased in `docs/SCREENS.md`
   §What the order should be. Phase 1 (shell chrome) and Phase 2 (Portal,
   Activity) are **done**. Next is the phase that is API-realm work rather than
   UI: **services over models that already exist** — `AlertRule`+`AlertEvent`,
   `Network`+`ServerNetwork`+`AppNetwork`, and `Secret`, three sets of models
   currently carrying no API surface at all. Then `AppDetailView`, the largest
   single gap: an App has no detail screen.

## Verification

| | |
|---|---|
| `bun run test` | 19 data-layer tests — schema, gates, encryption, auth compatibility |
| `bun run verify` | **110** browser checks across all three realms, incl. an a11y pass on every screen |
| `bun run db:check` | fails if the migration has drifted from `db/schema.lite` |
| `bun run typecheck` | 78 diagnostics, all the untyped-accessor class (`litestone types` pending) |

Nothing in this file was established by reading. The data claims were verified
against a live database, the API claims over HTTP, and the UI claims by driving
a real browser.
