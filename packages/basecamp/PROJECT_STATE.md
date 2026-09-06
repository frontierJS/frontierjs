# Basecamp — project state

Last reviewed by running: **2026-08-24**.

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
| **Data** (`db/`) | **Real.** `schema.lite` is the seed — 45 models, 26 enums, 0 errors and one standing warning; the migration is generated from it and verified against a fresh database. **All 45 declare `@@gate`**, graded per WORKSPACE by `api/src/core/gate.ts`. **Three carry a declared state machine** — `Server`, `Deployment` and `Job`, 19 gated transitions — so a status move is a compare-and-swap with its own authority level rather than a from-list in a service file. Row scoping is the declared `tenancy { }` block rather than hand-written allows: **fourteen `@@tenant(none)`** by name, **seventeen** scoped by their own `workspaceId`, and **fourteen through a parent** — inferred, not declared, and reported as that one warning. `@@tenant(via: rel)` is the wrong answer for seven of the fourteen: two scoped parents get one deny each and they are AND'd, so naming one drops the other |
| **API** (`api/`) | **Real.** **27 services** + 5 job files on Litestone accessors, zero raw SQL. Twenty-two are workspace-scoped; **five are not** and each says so in the schema rather than in a hook — `hub` (over no model), plus `blueprints`, `hub-config`, `backups` and `notification-preferences`, whose models are `@@tenant(none)`, which is what makes junction's `tenantClaimGuard` exempt them. Four sit behind `requireSystemAdmin`; `blueprints` reads at VISITOR(1), because browsing the catalogue is what a person with no workspace yet is doing |
| **UI** (`web/`) | **Real.** Sierra SPA over every service — 40 route files, driven end to end in a browser by `bun run verify`, and the BUILT output probed by `bun run verify:build` |

## How to run it

```bash
bun run dev          # API on :8120, UI on :8020
bun run db:seed      # an example fleet to look at
bun run verify:screens # blueprints · registry · backups · hub settings · your settings
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
- **Layout**: the canonical one (`FJS-D128`). `api/index.ts` starts the app;
  `api/src/app.ts` builds one and never starts it, which is what lets
  `junction surface` and `junction jobs` import it; `db.ts`, `env.ts`,
  `hooks.ts` and the rest of the infrastructure stay in `api/src/core/`.
  Basecamp used to keep `app.ts` in `core/` with the entry at `src/index.ts`,
  recorded here as a deliberate departure — the ruling overturned it.

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

   The confusion was Junction's, not Basecamp's: a **TransportContext** used to
   have `params` for path captures while a ServiceContext had none, and
   Junction's own comments claimed it for service contexts too. **Fixed upstream
   2026-08-15 (`FJS-D03`)**: `params` is gone from both, path captures are
   `ctx.route` on either, and the stale comments are rewritten. The word was
   removed rather than moved, because keeping it is what kept the Feathers idiom
   arriving.
2. **`before: { all: [...] }` really does mean all.** `servers.heartbeat`
   carried a comment claiming exemption from `authenticate` while sitting behind
   it, so the outpost could never check in — every heartbeat 401'd. `sessionScope`
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
(`findScoped`, `getScoped`, `deriveSlug`, `narrowPatch`, `removeScoped`). The
workspace clause is not among them: it is declared once in `db/schema.lite` and
compiled into every query, which is the version of *omitting it is a tenancy
leak* that a service cannot get wrong.

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
`db/migrations/main/20260801000000_initial_schema.sql` is **generated** from it by
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
- **Gates are declared in the schema, not in hooks.** `User` reads at USER(4)
  since auth moved its fragment (`FJS-170`); the member lists still go through
  `asSystem()` because they were written when it was SYSTEM(8), and **what keeps
  4 safe is a row policy and three field write policies rather than the level**
  — see `db/README.md`. `AuditEvent` update/delete are `LOCKED`, which
  `asSystem()` does **not** pass. `Secret.data` is `@encrypted`, so an ADMIN listing secrets
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
a live step timeline, the server fleet (drain/reboot/sync, event trail, outpost
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
  *workspace*, and an outpost reporting 95% CPU reaches the notice bar with
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
— an outpost on a timer would bury every human action, and `dispatch = false`
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
and `<Select>` honored it, so the PEM fields stayed empty and the service
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
  defect — documented behavior — but silent: the channels service reported
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
string cannot be graded. A script is handed to an outpost and run on a machine —
no model, no caller, no grade, at whatever privilege the outpost has. A vocabulary
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
  queue, and `api/src/engine/fleet.engine.ts` asks the outpost through
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
  ran). A sweep's answer carries the outpost's fresh `usage` snapshot, written
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

## What holds `User` at USER(4) (2026-08-14)

`FJS-170` moved auth's own fragment from `@@gate("8")` to `"4.4.4.5"` so that an
app can list its own people, and this app's hand copy moved with it. The level
alone was not enough here, and the gap was open for three days:

**a gate is per MODEL, so update at 4 was every signed-in caller writing every
other person's row — `isSystemAdmin` included.** Measured against the app's own
resolver rather than reasoned about: a `developer` listed every user in the
database, rewrote another user's row, and set `isSystemAdmin: true` on their own,
which `basecampGateLevel()` grades SYSADMIN(7). No route reached it — there is no
`users` service and every User write in `api/src` goes through `asSystem()` — so
it was a hole in the schema rather than a live one, which is the only reason it
is a paragraph here and not an incident.

Two declarations close it, neither of them a level:

- **`@@allow('update', id == auth().id)`** — whose row. A policy filters, so the
  cross-row write answers `null` rather than throwing; the test reads the other
  row back through `asSystem()`, because the return value cannot prove it.
- **`@allow('write', auth().isSystemAdmin)` on `isSystemAdmin`, `status` and
  `kind`** — which columns. These are exactly what the resolver reads: the tier
  itself, the status that grades `suspended` STRANGER, and the kind an API key's
  owner must be. **A column the caller can write is not a column a level can be
  graded from.**

`asSystem()` passes both, so `/setup` still makes the first administrator and
`/hub/users/` still grants the tier, suspends and creates bots — 271/271 in the
browser, unchanged.

**`@guarded` was the wrong tool and looked like the right one.** It is a
read-side lock: with it on `isSystemAdmin` the write still landed and the answer
came back with the column absent, which reads as a refusal. `litestone`'s own
`docs/schema.md` says *excluded from all operations unless `asSystem()`*, and
`@encrypted` implies it while `Secret.data` is plainly written by an admin, so
the sentence is wrong rather than the behavior — `FJS-248`.

## It runs in a container (2026-08-14)

`bun run image:up` builds an image from the working tree and brings up the
stack; `bun run image:down` stops it. Same URL as `bun run dev` — 8020 — so
containerised and not are the same address, deliberately.

**The image carries the tree.** Nine `workspace:*` dependencies that a Docker
build resolves no better than the `link:` specs `fli new --source local` writes
(`FJS-241`). Both halves belong to `fli`'s `core/vendor.js`, which
`deploy/build.mjs` calls: every publishable package packed into the build context
and the manifest rewritten to `file:` those tarballs, `overrides` included —
without that last part sierra installs mesa from npm and the image runs two trees
at once, which is not guaranteed to be loud. `fli deploy:vendor` is the same
module over a client app, so a scaffolded app and this one are packed one way.

Two containers. The API is an image; the SPA is static files behind Caddy, whose
config is generated from `web/config/api-paths.js` — the same paths the Vite dev
proxy reads, and no longer a list at all: it is parsed out of
`surface.snapshot.md`, so both proxies are derived from what the app actually
mounts rather than from an array that had gone stale six times. Both have to make
the same call: `/projects` is a service AND a page, and only `Accept` tells them
apart. The image copies the snapshot, because the SPA build runs inside it.

**Packaging it found four framework defects and none of them were in this app.**
All the same shape — *a path predicate that is true in the workspace for a
different reason than it is true in an install* — and all invisible here, because
an app in this repo resolves the framework out of `packages/`:

| | |
| --- | --- |
| sierra | the Mesa plugin's node_modules allowance named `@frontierjs/sierra` alone, so the ui kit's 64 `.mesa` components and email-kit's 22 reached rolldown untransformed |
| sierra | `id.includes('_module')` decided *is this a layout* — and **`node_modules` contains `_module`** |
| ui | `"./stores/*": "./stores/*.js"` mapped `stores/toastStore.js` to `stores/toastStore.js.js` |
| basecamp | the `@frontierjs/ui` alias pointed at `../../../ui` unconditionally, a path that exists only in the workspace |

What it is NOT yet: a thing that can deploy an app. See the next section.

## A second human can get in (2026-08-19)

The setup wizard was the only door for a human. `workspaces.addMember` takes a
`userId`, and the one route that makes one — `/auth/register` — leaves them with
no account row and no workspace, so every scoped request 400s afterwards.

`model Invitation` is an offer of membership to an **email address**, which is
what carries the workspace and the role across the gap where there is no user to
hang them on. The row IS the pending state: accepting writes the
`WorkspaceMember` with `invitedBy` and `invitedAt` carried forward and deletes
the invitation, revoking deletes it, and `@@log(audit)` is what survives either
way. Those three columns had been declared since the schema was written and
nothing had ever written one.

`preview` and `accept` are this app's **only unauthenticated service methods**,
exempt from `sessionScope` because the population they serve is not a member yet
and may not exist yet. The `@guarded` token is the credential — no scoped
read can answer it, so the link is shown once, the shape an issued API key
already had — and everything a token cannot decide (unknown, expired, workspace
gone, workspace suspended) is decided in one function, because none of the hooks
that normally decide it are running.

An address that already has an account has to be signed in as that account.
Taking a password here instead would be a second login door with none of the
first one's rate limiting, and an oracle when it refuses; `/login/` grew a
same-origin `?next=` so the link brings them back.

**Mail is `IMail` over `app.conduit`** (`api/src/core/mailer.ts`): the provider
is a declared target with a credential ref rather than a key in a closure, and
`app.mail` is absent where nothing is configured. That last part is the design —
a fleet console that cannot mail is ordinary; a screen that looks like it sent
something is not. The invitation issues a working link either way and says which
happened.

Driven in a real browser against a real mail sink on 8121, 21 checks: the link
shown once, the mail that actually left the process carrying it, a resend that
kills the old link, the wrong account told so, a stranger with no account
accepting and landing inside the app, and the accepted link dead afterwards.

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

### The Outpost — what stands between this and deploying an app

**A deploy in Basecamp today reports six green steps and does nothing.** The
deployment engine speaks a complete protocol over Conduit to `outpost:<server-id>`
— `POST /pull`, `/deploy`, `/stop`, `/health-check`, `/exec` — the `Server` model
carries `outpostVersion` and `lastHeartbeatAt`, `heartbeat` is written and
HMAC-authenticated at the transport, `App.source` is already
`{ kind: 'git', repo, branch }`, and **nothing implements the other end.** With
no outpost resolved, `runStep` returns early and the caller marks the step
`success`:

```ts
if (!outpostTarget) {
  // No outpost — log only, don't fail (supports local/stub mode)
  log.debug(`step skipped — no outpost`, { step: step.name })
  return
}
```

So the App goes to `running`, the release goes to `success` in 23ms, and the
screen is telling the truth about a pipeline that ran no commands. Eight checks
in `web/test/verify.mjs` currently assert that `success` — they are proving the
step pipeline and the socket push, both real, against a deploy that does nothing.

The order, decided 2026-08-14:

1. **Make the stub loud.** A deploy with no outpost records `skipped` and
   finishes `failed`, not `success`. Everything below depends on being able to
   trust a green, and the drive's eight checks move to a real outpost with it.
2. **`packages/outpost`** — a Bun service implementing the five endpoints
   against the local Docker daemon, heartbeating in over HMAC. V1 runs
   **co-resident with Basecamp** on `/var/run/docker.sock` (the CapRover shape);
   a second machine is then just another `Server` row, and the architecture does
   not change to get there.
3. **Build from `source`.** Clone the git ref, `docker build`, run — the same
   thing `fli deploy` does on a server today. `IDEAS/deploy-plane.md` argues for
   build-once-promote-a-digest instead, and it is right; it needs a registry,
   which V1 does not.
4. **Deploy `example/` through it.** The end-to-end proof, and the first time
   anything in this repo has been deployed by something in this repo.

*Steps below are tracked as **`FJS-032`** (no invitation flow) and **`FJS-031`**
(publishes on reads) in `../../ISSUES.md`.*

**`@@gate` landed 2026-08-10 and closed `FJS-007`** — deferred to last, as
decided 2026-08-06, and it cost nothing to defer: the admin zone everyone
expected to break was already written through `asSystem()` because `User` was
`@@gate("8")` at the time. All 45 models declare a level; the ladder is per WORKSPACE
(`api/src/core/gate.ts`), which is the part `example/api/src/core/gate.ts` could not
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

**Fourteen more followed, in four batches** — the hierarchy (`Project`,
`Environment`, `App`), then what a person does to an app (`Deployment`, `Job`,
`Domain`), then the six the workspace owns outright (`Network`, `Recipe`,
`FeatureFlag`, `NotificationChannel`, `AlertRule`, `Dashboard`), then the
credential pair (`Secret`, `ApiKey`). **15 of 37, which is every model carrying a
`workspaceId` except two**: `WorkspaceMember` is what standing is read from,
before there is a workspace on the principal to compare it against, and
`AuditEvent`'s workspace is nullable because a hub action belongs to none.

Each batch turned up something the previous one could not. The second: those
services read on **`appId` alone** in several places (an app's recent releases, a
hostname's siblings), correct until then only because the app had been fetched
scoped a few lines earlier. The fourth: `Secret` is the only model with both a
protected field and a row policy, and Litestone's `verifyFieldProtection` could
not seed a row for one — it forced the policy's value into a foreign key without
creating the parent, so the whole model reported as unchecked. Fixed in
Litestone the same day.

Every batch is four tests over one table of shapes, an HTTP probe across two
workspaces owned by one person, then the browser drive — a wrong policy is an
empty screen, and nothing below a browser can see one.

**What is left is a different declaration.** The 22 without a `workspaceId`
column — `DeploymentStep`, `JobRun`, `RecipeRun`, `Volume`, `FlagOverride`,
`AlertRuleChannel`, `DashboardWidget`, `AppServer` and the rest — reach their
tenant through a parent, so they want `check(parent)` rather than a column
restated on the child. Worth proving once on the simplest (`DeploymentStep`)
before the rest follow.

1. **`check(parent)` on the other 22.** Every model that can carry a
   `workspaceId` now declares one; what is left reaches its tenant through a
   parent. Prove the delegation once on `DeploymentStep`, then a batch at a time,
   with `bun run verify`
   between them. The line is never the work: **a policy filters where a gate
   refuses**, so a read that legitimately crosses a workspace and is not
   `asSystem()` starts matching nothing, with no error — an empty screen. The
   three engines, the hub and the outpost endpoints are already `asSystem()`, and
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
6. **Build the remaining 16 screens** — `FJS-153`, phased in `docs/SCREENS.md`
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
   `asSystem()` throughout because `User` was `@@gate("8")`, which even SYSADMIN
   does not pass — so when the gates landed the day after, it needed no change,
   and when auth moved the level to 4 it needed none either.

   **Two things ruled before it starts** (2026-08-10, written up in
   `../../HANDOFF.md` § Next): a sysadmin is a COLUMN — `isSystemAdmin Boolean
   @default(false)` on `User`, not auth's `role` and not an env allowlist — and
   the phase covers the four screens plus **bot accounts** (`UserKind.bot`,
   which closes Phase 6's "a key belongs to whoever made it"). Invitations stay
   `FJS-032`: they need a token model, mail through conduit and a signed-out
   acceptance route. `Blueprint` and `Backup` are
   the last two models with no screen; adapters (D) stay last — they need real
   credentials and cost real money.

### Adapters — four screens, each waiting on one (2026-08-30)

**Every boundary is declared and nothing is behind any of them.** `IEdge` and
`ICloudSpend` were added and `IGit` was widened on 2026-08-30, so all ten
providers now have an interface, a stub and a portal entry — and `/dns/`,
`/cloud-spend/`, `/git-activity/` and `/observability/` each report their own
adapter's state off that portal rather than hardcoding it.

What is left per adapter is the same two steps: a `@frontierjs/conduit` target
with its token as a `Secret`, then a service in front of it. **No service before
an adapter** — one returning stub emptiness makes the screen render an empty
table, which is indistinguishable from a vendor with nothing to report and is the
exact failure those skeletons exist to avoid.

`docs/ADAPTERS.md` is the pick-up doc: the ten, what each of the four costs, the
decisions already made (money in minor units, `forServer` keyed on
`providerServerId`, the job-not-vendor naming, stubs that answer empty) and the
four drive assertions that go red the day one is wired — which is correct, and
the fix is a fake vendor on a port of its own, the way `verify:stripe` does it.

## Verification

| | |
|---|---|
| `bun run test` | **211 tests** across 7 files — the data layer (schema, gates, who may write the columns the gate is graded from, encryption, auth compatibility) and the API tier through `@frontierjs/testing`, which is where the standing rules are graded: schema, gates, who may write the columns the gate is graded from, encryption, auth compatibility, the alert-delivery join, what an API key's table may not contain, where a volume's tenancy comes from, that the widget vocabulary is one list rather than two, and that a recipe run keeps the script it ran while the reclaim vocabulary has exactly one home |
| `bun run verify` | **302** browser checks across all three realms, incl. an a11y pass on every screen |
| `bun run verify:build` | the PRODUCTION build — the tags survive comment-stripping, and the page comes up in a real browser |
| `bun run verify:screens` | **66** browser checks on a database it seeds in a temp directory — the Phase 13 and 14 screens, the audit window, and the adapter states `/admin/adapters/` reports |
| `bun run db:check` | fails if the migration has drifted from `db/schema.lite` |
| `bun run typecheck` | 15 diagnostics, at the committed baseline. Was 63 until `db/schema.d.ts` landed — two thirds of the count was rows read out of an untyped Proxy |
| `bun run db:types` | regenerates `db/schema.d.ts` from the schema (`audience=system`). `bun run test` fails if the committed file is stale |
| `bun run db:seed --force` | the only thing here that writes every model — and `db/test/seed.test.ts` runs the script itself, from a throwaway directory, so it cannot rot unnoticed again |

Nothing in this file was established by reading. The data claims were verified
against a live database, the API claims over HTTP, and the UI claims by driving
a real browser.
