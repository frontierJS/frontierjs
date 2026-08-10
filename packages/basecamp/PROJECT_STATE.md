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
| **Data** (`db/`) | **Real.** `schema.lite` is the seed — 37 models, 21 enums, 0 errors / 0 warnings; the migration is generated from it and verified against a fresh database. **All 37 declare `@@gate`** (2026-08-10), graded per WORKSPACE by `api/src/core/gate.ts`. **One declares `@@allow`** — `Server`, the first of the row-level tenancy the other 36 still keep in service where-clauses |
| **API** (`api/`) | **Real.** **21 services** + 3 engines on Litestone accessors, zero raw SQL. Twenty are workspace-scoped; `hub` is the one that is not — it takes no workspace at all and sits behind `requireSystemAdmin` |
| **UI** (`web/`) | **Real.** Sierra SPA over every service — 39 route files, driven end to end in a browser by `bun run verify`, and the BUILT output probed by `bun run verify:build` |

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

## Three sets of models finally have an API (2026-08-06)

Phase 3 of the rebuild. `AlertRule`+`AlertEvent`, `Network`+`ServerNetwork`+
`AppNetwork` and `Secret` had all been in `db/schema.lite` since the Data realm
was rebuilt **with no API surface at all**. They now have `alerts`, `networks`
and `secrets`, and three mock screens sit on them: `/alerts/`, `/networks/`,
`/secrets/`. **`bun run verify` is 125 checks**, green twice consecutively.
Full write-up in `docs/SCREENS.md` § Phase 3.

Each service was probed over HTTP before any UI existed — create, the refusals,
the join, and the 409 on deleting a populated network — and the secret was
proved absent from both the API response and `strings db/basecamp.db`.

**What it found: a vocabulary owned in two places, disagreeing.**
`AlertRule.severity` was `String @default("medium")` while the service accepted
only `info | warning | critical` — so **the schema's own default was a value the
API refused**, unnoticed because nothing could reach the model. Now
`enum AlertSeverity { info warning critical }` with `@default(warning)`, the
migration regenerated, the service's hand-written list **deleted**, and the UI's
`<Select>` fed from `alerts.fields.severity.enum`. One declaration, three
consumers — which is the whole claim the framework makes.

Still open from the phase: **`FJS-110`**, a kit `<Button disabled={…}>` that
stopped following its prop while a plain `<button>` with the identical
expression kept following it. Seven isolation probes in mesa's own harness all
pass, so the trigger is not yet named. Worked around at the call site.

## The App has a screen (2026-08-06)

Phase 4, and the largest single gap in `docs/SCREENS.md` closed: an App could be
created from an Environment and then never looked at again. `/apps/[id]/` is 4
of the mock's 7 tabs — overview, domains & SSL, config, releases — and the other
three are named in the screen as data gaps rather than rendered empty. One
request feeds the page: `apps.get` answers the app with its environment, its
domains, its placement, its last ten releases and its jobs.

**`App.domain` became `model Domain`** with a `domains` service
(`uploadCert` · `makePrimary`). One nullable string could hold exactly one
hostname with no certificate, no redirect and no primary. Two things are
deliberately not columns on the new model:

- **The certificate material.** `uploadCert` writes the PEM pair into a `Secret`
  of kind `tls_cert` and keeps only the reference. `Secret.data` is
  `@encrypted`, so the private key is written once and never read back — proved
  0 occurrences in the API's answer and 0 in `strings db/basecamp.db`.
- **`certStatus`** — derived from `certExpiresAt` by one exported function. A
  stored status and a stored expiry are two owners of one fact.

Two things it found: **`<Textarea>` silently ignored `oninput`** while `<Input>`
and `<Select>` honoured it, so the PEM fields stayed empty and the service
refused the upload with nothing explaining why (`FJS-116`, fixed in the kit).
And **a derived field needs its owner imported** — `apps.get` includes `domains`,
an include returns raw rows, and the screen rendered every hostname as "no
certificate" until `apps.service.ts` imported `certStatusOf` instead of
recomputing it.

## Where an alert goes, and what is behind a flag (2026-08-08)

Phase 5 of the rebuild — two screens from the "needs new models" pile, each one
chosen because it closed a hole in something already built. `bun run verify` is
**156 checks**. Full write-up in `docs/SCREENS.md` § Phase 5.

- **`/channels/`** — `NotificationChannel` is the model `AlertRule.channels` was
  already pointing at. That column was `Json @default("[]")`, an array of ids
  for rows **no model declared**: a foreign key with no constraint and no
  reader. It is now `AlertRuleChannel`, a real join, with three data tests over
  what the Json array could not answer. The credential is not on the row — a
  Slack webhook URL is a bearer credential, so it goes into a `Secret`
  (`@encrypted`) and only the reference is kept, the same ruling as Domain's
  certificate material. **`test` really sends**, through `app.conduit` with the
  credential resolved from its Secret at send time; proved against a local sink,
  and the token proved absent from the database file, conduit's registry and the
  API's answer.
- **`/flags/`** — `FeatureFlag` + `FlagOverride`. The mock keyed per-environment
  state by TIER NAME, a vocabulary that already exists here as `model
  Environment`; the string would have meant every project sharing one
  "production" belonging to none of them. An override points at the real row,
  and `resolveIn()` is the one definition of what a flag is set to in an
  environment — exported, so `flags.resolve` and the screen cannot disagree.

**Two gaps closed on the way**, both of which had been open since the trail and
the fleet were built:

- **`FJS-104`** — `servers.feed`, the fleet's whole event stream in one request.
  Server events were per-server only, so `/activity/` covered `AuditEvent`
  alone — what PEOPLE did — while most of what happens here is what the machines
  did. Both sources now merge by time.
- **`FJS-085`** — `bun run verify:build`. `verify` drives the DEV server, where
  Vite injects nothing, so the one artefact that reaches a user was the one
  artefact nothing tested. It cost this app a blank page once. Two layers:
  comments stripped from `dist/index.html` before requiring the tags to survive
  (a regex over the raw file passes on exactly the broken output), then the page
  loaded in a real browser and required to render, to have fetched its own JS
  and CSS, and to log nothing.

### What building it found — five defects, four of them framework

- **Litestone emitted a JSON Schema `default` of the wrong type** (`FJS-120`).
  `tags String[] @default("[]")` reached the boundary as
  `{"type":"array","default":"[]"}`, so `autoValidate` filled in the default and
  then refused it: every create that OMITTED the field 400'd naming a field the
  caller never sent, while sending it explicitly worked.
- **Raw SQL could not write** (`FJS-118`) — `_runRawSql` always used the
  readonly connection, so `db.asSystem().sql`, the only escape hatch on a schema
  with access rules, had never been able to run a write.
- **Conduit refused any non-JSON response** (`FJS-121`), so a Slack webhook —
  `200 text/plain: ok` — could never succeed.
- **A collection-level action was unreachable from the browser** (`FJS-122`).
  Both `servers.feed` and `flags.resolve` are about a whole service; the client
  interpolated an id unconditionally.
- **`autoValidate` strips a wire-only field before the method body runs.** Not a
  defect — documented behaviour — but silent: the channels service reported
  "Slack needs a credential" about a request carrying exactly that. A field that
  is not a column has to be captured in a BEFORE hook.

Still open from the phase: **nothing evaluates a rule and nothing delivers to a
channel** (`FJS-123`) — both halves are real, the thing between them needs a
metric source — and **a flag's rollout percentage is stored and never applied**
(`FJS-124`), because the bucketing decision belongs where the user is.

## The token this app issues (2026-08-09)

Phase 6 — `/api-keys/`, the last self-contained screen in the "needs new models"
pile. Full write-up in `docs/SCREENS.md` § Phase 6.

**`ApiKey` is the third direction.** A `Credential` is how a person proves
identity *to* Basecamp; a `Secret` is how Basecamp proves identity *to* a
provider; an `ApiKey` is a token Basecamp *issues*. The same noun in three
places, three different directions, and only the third had no model.

The token is nowhere in this app: `@frontierjs/auth` mints it and holds an HMAC
in a `Credential`, and `ApiKey` holds the operational half — workspace, owner,
scopes, usage, revocation — plus a hint. It is shown once and a reload loses it,
so the mock's `reveal` button cannot be built without storing the token, which
is the one thing an API key exists not to do. A data test asserts against the
generated DDL that no column could hold one.

**A scope is `<service>:<read|write>`, derived from the service registry rather
than declared** — no mapping table to drift, and a service added tomorrow is
grantable tomorrow. Two are off limits to a key at all: `api-keys` itself (a key
that can mint keys escalates past its own scopes) and conduit's management
service. Enforcement is an app-level before hook, because a key scoped on
sixteen services and unscoped on the seventeenth is not scoped.

### What building it found — three defects, all in @frontierjs/auth

The API-key half of `IAuth` was implemented, unit-tested, and had never been
used end to end. Every one of the three fails towards looking correct.

- **An issued key authenticated nothing** (`FJS-134`). Junction's transport
  resolves a Bearer token through `verifySession()` and calls `verifyApiKey`
  nowhere; the native provider never fell through. `createApiKey()` returned a
  token that was anonymous on every request, and the symptom is *bad token*
  rather than *missing code path*.
- **A key's scopes were dropped on verification** (`FJS-135`). Stored on the
  credential, but the session was built from the USER row, so every key carried
  its owner's full standing and the scope picker would have been decoration.
- **`revokeApiKey` revoked nothing here** (`FJS-136`). It coerced
  `Number(keyId)` because auth's own fragment declares `Credential.id Int`; this
  schema uses uuids, so `NaN` matched no row and threw nothing. Revoke reported
  success and the key kept working.

And one gap in the seam rather than in a package (`FJS-095`): **a required
column that only the server can fill cannot be created from the browser.**
`createResource` validates by default and `ApiKey`'s create schema is
`required: ["workspaceId", "userId", "name", "tokenHint"]`, three of them
server-written — so every create was refused before the request was made, with
the documented symptom that the button does nothing. `{ validate: false }` is
the only escape today, which turns a whole resource off to describe three
columns. Nothing in the schema can say *the system writes this* — `FJS-D22`.

Still open from the phase: **there are no bot accounts.** The mock tells you to
use a dedicated `bot` user for CI and this app cannot create one, so a key
belongs to whoever made it and carries their access. The screen says so rather
than implying otherwise; it needs the sysadmin `UsersView`.

## A saved view names a kind (2026-08-10)

Phase 8 — `/dashboards/` and `/dashboards/[id]/`, over `Dashboard` and
`DashboardWidget`. Full write-up in `docs/SCREENS.md` § Phase 8; the ruling is
in the repo's `DECISIONS.md`.

The phase existed to settle one question: **is a widget's data source a declared
vocabulary or a free-form query?** It is declared.

A widget holding `{ accessor, where }` is a read stored in a row. The row
travels — seeded, copied, opened by everyone in the workspace — and the policy
does not travel with it, because `@@gate` and `@@allow` grade a caller against a
model and neither can say anything about a string. The server would run one
person's query at another person's privilege with nothing in the schema able to
see it.

So `enum WidgetKind` is the vocabulary, and one declaration does three jobs: the
column's CHECK constraint, `autoValidate`'s answer at the API, and the
Add-widget picker — which reads it as a `$def` on the model's JSON Schema, the
path every other enum here already takes, so the list cannot offer a kind the
write would refuse. What the schema cannot express — which kinds take a server,
which take an app, which config keys each reads — is one table in
`api/src/services/dashboards/kinds.ts`, fetched through a collection-level
`kinds` action rather than copied into the bundle, and a data test holds the two
lists together in both directions.

**Nothing on a board reads on the board's behalf.** Each card calls the service
that owns its data with the reader's own session, so a dashboard shows exactly
what its reader could have opened for themselves; the activity card tells a
developer the trail is admin-only instead of rendering empty. The cost of the
ruling is stated rather than hidden: adding a widget kind is a migration.

All nine of the mock's widget types ship, and three say what they cannot show
from the same vocabulary the picker is built from — nothing here stores a time
series, so `server_health` is the last heartbeat rather than a trend,
`service_health` is a live ping with no latency, and `alert_status` has rules
but no evaluator (`FJS-123`).

### What building it found

**A custom action that answers `data` plus anything else loses the anything
else** (`FJS-140`). `kinds` returned `{ total, data, statSources, portalServices }`
and `wrapResult` rebuilt the envelope from the first two keys alone, so the
picker got nine widget kinds and neither of the vocabularies needed to configure
them — 200, no warning, no error. Three named keys instead makes it a `single`,
which unwraps whole. `volumes.usage` documents the same trap from the other
side.

### Still open

**Nobody can put a board on the home screen.** `isPinned` orders the list and
does nothing else, and it is the WORKSPACE's pin rather than the reader's — a
per-person pin needs the preferences store `UserSettingsView` is waiting on. The
screen says so rather than offering a control that looks private.

## The two ways to act on a machine (2026-08-10)

Phase 9 — `/recipes/` and `/cleanup/`, over `Recipe` + `RecipeRun` and
`DiskUsage` + `CleanupRun`. Full write-up in `docs/SCREENS.md` § Phase 9; the
ruling is in the repo's `DECISIONS.md`.

They were built together because each is the other's argument. **A vocabulary
cannot bound a script, so the record does.** Yesterday's saved-view ruling does
not transfer: a stored query is dangerous because it is executed at the Data
boundary, where `@@gate` and `@@allow` grade a caller against a model and a
string cannot be graded. A script is handed to an agent and run on a machine —
no model, no caller, no grade, at whatever privilege the agent has. A vocabulary
of allowed scripts buys nothing against that.

So the safeguards are opposite. A cleanup stores target NAMES from a fixed list
and refuses anything else by name; a recipe stores code, **authoring it is
admin-or-owner and running it is developer**, because writing the script is the
privileged act and running a vetted one is what somebody on the pager does at
3am. Collapsing those makes recipes admin-only in practice, which is how people
end up pasting the script into a terminal instead.

- **One run row per SERVER**, and each keeps the script it ran. A fleet run is N
  executions with N exit codes; a recipe is editable, and output read against a
  script that has since changed is not evidence.
- **Neither screen executes anything.** Both queue on Caravan's new `fleet`
  queue, and `api/src/engine/fleet.engine.ts` asks the agent through
  `app.conduit` — one file for both, because the shape is one shape and only the
  safeguards differ. A non-zero exit is recorded and never retried; a timeout is
  its own state.
- **Every number on the cleanup screen was measured by Docker.** `DiskUsage`
  carries `docker system df`'s own reclaimable figures per category, the
  estimate sums by source rather than by target (both image targets draw on one
  figure), and a machine that has never reported says so rather than rendering
  zeroes. Unused volumes are off by default — the one target no registry can
  undo.
- **Nothing is stored twice.** `DiskUsage` counts no volumes (`Volume` owns
  per-disk sizes) and stamps no last-cleanup (`CleanupRun` owns when a sweep
  ran). A sweep's answer carries the agent's fresh `usage` snapshot, written
  through the same function the report endpoint uses.

### What building it found

**A set-valued vocabulary has no home in the schema** (`FJS-141`).
`targets ReclaimTarget[]` does not parse — *array [] is only supported for Text,
Integer, File, or a model name for many-to-many* — so a declared enum beside a
`String[]` column would be two homes with nothing joining them, exactly the
shape that let `AlertRule.severity` default to a value its own API refused. The
list has one home in `api/src/services/cleanup/targets.ts`, and a data test
asserts the schema declares no competing enum.

**`stampWorkspace` on a resource is not optional bookkeeping.** `Recipe.mesa`
shipped without it, on the reasoning that the service stamps `workspaceId`
itself — but browser-side validation runs first, so every save was refused in
the form with *workspace is required*, naming a field the form does not show.
Only the browser drive can see this; the API was correct throughout.

Also: `enum JobRunStatus` became `enum RunStatus`, shared by `JobRun`,
`RecipeRun` and `CleanupRun`, with a data test naming all three.

### Still open

**Nothing here is scheduled**, and both screens say why: a sweep or a recipe on
a timer is a `Job` with a cron expression, and a second scheduler on either
screen would be a second owner of when the fleet gets touched. The mock's
per-server disk BARS are also not built — they need free space on `/`, which is
a different reading from `docker system df`.

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


*Steps 1–2 are tracked as **`FJS-032`** (no invitation flow) and **`FJS-031`**
(publishes on reads) in `../../ISSUES.md`.*

**`@@gate` landed 2026-08-10 and closed `FJS-007`** — deferred to last, as
decided 2026-08-06, and it cost nothing to defer: the admin zone everyone
expected to break was already written through `asSystem()` because `User` is
`@@gate("8")`. All 37 models declare a level; the ladder is per WORKSPACE
(`api/src/core/gate.ts`), which is the part `example/api/gate.ts` could not
supply.

**`@@allow` started the same day, on one model.** `Server` declares
`@@allow('all', workspaceId == auth().workspaceId)`, graded off the workspace
`applyStanding()` puts on the principal — the first *which rows* answer this app
keeps in the schema rather than in a service where-clause. Proven by five tests
in `db/test/schema.test.ts` that run with no service and no hook, which is the
only arrangement where the policy is the thing acting. Declaring it found two
Litestone defects sitting under the gate work as well: an `include:` enforced
nothing the model it reached declared (`FJS-150`), and a post-update denial did
not roll back on a model with a Json column (`FJS-151`).

1. **Declare `@@allow` on the other 36.** One at a time, with `bun run verify`
   between them. The line is never the work: **a policy filters where a gate
   refuses**, so a read that legitimately crosses a workspace and is not
   `asSystem()` starts matching nothing, with no error — an empty screen. The
   three engines, the hub and the agent endpoints are already `asSystem()`, and
   that audit is what has to precede each declaration.
3. **An invitation flow.** `/auth/register` creates a user with no account and
   no workspace, so every scoped request 400s and they cannot create a workspace
   either. `addMember` needs an existing user id. Today the setup wizard is the
   only way in.
4. **Narrow channel publishing to mutations.** Every service publishes after
   every method, reads included, so a `GET` broadcasts the row to everyone
   connected to the workspace. Noise rather than a leak, but the wrong default.
5. **`litestone types`** — 77 of this package's typecheck diagnostics are the
   untyped-accessor class and would go with generated types.
6. **Build the remaining 16 screens** — `FJS-101`, phased in `docs/SCREENS.md`
   §What the order should be. Phases 1–8 are **done**: shell chrome; Portal and
   Activity; services over `AlertRule`/`Network`/`Secret`; `AppDetailView`;
   Channels and Flags; `ApiKey`; `Volume` — the first screen over a model nobody
   here authors; then `Dashboard` + `DashboardWidget`, where a widget names a
   declared kind and never carries a query.

   Phase 9 is **done**: `RecipesView` and `DiskCleanupView`, the two ways this
   app acts on a machine, both queued through Caravan's `fleet` queue.

   **Phase 10 is the sysadmin tier — `WorkspacesView`, `UsersView`, `FlagsView`
   (hub scope) and `SysOverviewView`.** Done. It was the last group whose
   blocker was an API rather than a model, and it was written against
   `asSystem()` throughout because `User` is `@@gate("8")`, which even SYSADMIN
   does not pass — so when the gates landed the day after, it needed no change.

   **Two things ruled before it starts** (2026-08-10, written up in
   `../../HANDOFF.md` § Next): a sysadmin is a COLUMN — `isSystemAdmin Boolean
   @default(false)` on `User`, not auth's `role` and not an env allowlist — and
   the phase covers the four screens plus **bot accounts** (`UserKind.bot`,
   which closes Phase 6's "a key belongs to whoever made it"). Invitations stay
   `FJS-032`: they need a token model, mail through conduit and a signed-out
   acceptance route. `Blueprint` and `Backup` are
   the last two models with no screen; adapters (D) stay last — they need real
   credentials and cost real money.

## Verification

| | |
|---|---|
| `bun run test` | 45 data-layer tests — schema, gates, encryption, auth compatibility, the alert-delivery join, what an API key's table may not contain, where a volume's tenancy comes from, that the widget vocabulary is one list rather than two, and that a recipe run keeps the script it ran while the reclaim vocabulary has exactly one home |
| `bun run verify` | **230** browser checks across all three realms, incl. an a11y pass on every screen |
| `bun run verify:build` | the PRODUCTION build — the tags survive comment-stripping, and the page comes up in a real browser |
| `bun run db:check` | fails if the migration has drifted from `db/schema.lite` |
| `bun run typecheck` | 77 diagnostics, all the untyped-accessor class (`litestone types` pending) |

Nothing in this file was established by reading. The data claims were verified
against a live database, the API claims over HTTP, and the UI claims by driving
a real browser.
