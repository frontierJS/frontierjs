# Basecamp — changes

Newest first. What changed and why; the current state is `PROJECT_STATE.md`.

## 2026-08-13 — the process a server runs is an Outpost, not an agent

`FJS-D29`. The word had two meanings in this repo already — the resident fleet
process here, and the MCP caller `IDEAS/agent-surface.md` proposes — in a codebase
whose `UserKind` enum has an `ai` member. The rule that settles it and the next one:
**infrastructure takes place nouns, AI takes personified nouns.**

Renamed: `Server.outpostVersion` / `outpostUrl` (migration regenerated from the seed
with `bun db/generate.js`, never hand-edited), the Conduit target `outpost:<server-id>`
and its `kind`, the snake_case heartbeat payload `outpost_version` / `outpost_url`,
`OUTPOST_SECRET`, `outpostFor()` in `fleet.engine.ts`, `outpostTarget` in
`deployment.engine.ts`, and the prose throughout the schema, services, screens and
the drive.

**Three of those are wire contracts, which is why this happened now rather than
later.** Basecamp's half of the protocol is written — both engines dispatch through
Conduit and `servers.service.ts` registers the target on heartbeat — and the machine's
half does not exist. The caller existed and the callee did not, so this was a
find-and-replace instead of a compatibility window.

`@frontierjs/conduit` moved with it: its `TargetKind` union carried an `'agent'`
member, and `testing.ts` derives the kind from the id prefix, so a target id that no
longer started with `agent:` would have graded as the wrong kind.

`bun run verify --reset` 271/271, which covers the heartbeat, the Conduit dispatch
and the *"No outpost is registered"* refusal. `bun run test` 65/66 — the one failure
is `FJS-177`, unrelated and already allowed in CI.

Not renamed: `userAgent` (an HTTP header), `db/legacy-sql/002_server_agent.sql` (it is
history and `db/README.md` explains it never worked), and the entries above this one.

## 2026-08-13 — the hub prints the subscriber count it used to apologise for

`IEventBus` grew `stats()` in Junction (`FJS-143`), so the hub's badge shows
`N event subscribers` instead of *has listeners / idle*, and the "Not shown
here" card drops the paragraph explaining why the number could not exist. CPU is
the one figure left on that card, and it still says so rather than printing
something derived from a single reading.

The drive's assertion changed with it: it used to check the screen contained the
words *cannot produce*, which is a check that passes hardest exactly when the
gap is never closed. It now asserts the number is there and rendered.
`verify` 271/271 (`--reset`).

## 2026-08-10 — the first `@@allow`, and what it found under it

`Server` declares row-level tenancy in the schema:

```
@@allow('all', workspaceId == auth().workspaceId)
```

One model of 37, deliberately. The declaration itself is a line — the work is
the audit that has to come before it, because **a policy filters where a gate
refuses**: any read that legitimately crosses a workspace and is not
`asSystem()` stops matching, with no error and a 200. Here that audit came out
clean, which is the only reason this was a one-line change: the three engines
each open with `app.data.asSystem()` and say why, the hub reads through
`asSystem()` because `User` is gated above SYSADMIN, and the outpost's heartbeat
does too. `workspaceId` reaches `auth()` the way `memberRole` does —
`applyStanding()` puts both on the principal for the workspace being addressed.

Five tests in `db/test/schema.test.ts` run it with **no service and no hook**,
which is the only way to tell a policy from the where-clause the service was
already writing: a caller reads one workspace's servers with no `where` at all,
naming another workspace's row by id answers null, and creating or moving a
server into another workspace is refused.

**Two Litestone defects were in the way, and neither was visible from here.**

`include:` applied **no** access rule of the model it reached — not `@@allow`,
not `@@gate`, not `@guarded` (`FJS-150`). So the declaration would have held on
`/servers/` and leaked one join away, and the `@@gate` work of the previous
session had the same hole underneath it the whole time.

And a post-update denial did not roll back on a model with a Json column
(`FJS-151`) — which `Server` is, four times over. *Move this server into another
workspace* is exactly what post-update refuses, and the revert threw a SQLite
binding error on its way out: the caller saw a `TypeError` about bindings, and
the write the policy had just refused stayed in the database.

`verify` 270/270, 61 data tests (was 56).

## 2026-08-10 — the gate, and why it could not be `example`'s four lines

All 37 models declare `@@gate`. `FJS-007` had been open since Phase 1 and
deferred on purpose until every screen existed; what it was actually blocked on
was never the resolver.

`sessionGateLevel()` grades standing that travels with the user —
`isAdmin`/`isOwner`/`isSystemAdmin`, the lifecycle stamps. None of that can say
*admin of THIS workspace*, and here the same person is `owner` in one workspace
and `viewer` in the next. Graded from their user row they would be USER(4)
everywhere, including workspaces they are not in.

So the level is resolved per request from the `WorkspaceMember` row for the
workspace being addressed: viewer/billing READER(2), developer USER(4), admin
ADMINISTRATOR(5), owner OWNER(6), `isSystemAdmin` SYSADMIN(7) above any
membership, and an authenticated caller with no membership VISITOR(1) — which
reads `Workspace` and nothing else, because that is the screen a fresh login
needs before it can name a workspace at all.

`applyStanding()` (`core/hooks.ts`) does it once and replaces the two membership
queries the hooks were each making. Three things it has to get right, each of
which was a way to ship a gate that does nothing:

- **It puts `memberRole` on the PRINCIPAL, not on the client.** Junction's
  `getTable()` re-derives its own scoped copy from `ctx.auth.user`, so a
  standing that lives only on `ctx.locals.db` is dropped the moment a service
  touches a model.
- **A fresh object, never a mutation.** Over WebSocket the session is resolved
  once at upgrade and shared by every frame — and the internal-call path freezes
  it — so mutating would either throw or leak one call's role into the next.
- **It re-resolves when the workspace changes mid-request.** The workspaces
  service addresses `ctx.id`, not the header; without this an admin of the
  workspace on screen carried level 5 into a patch of any other workspace they
  could name.

The levels are not a design drawn on paper: they are the `requireWorkspaceRole`
calls the services were already making, moved to the one place that also covers
an engine calling a service in-process, a custom action nobody wired a hook
onto, and a where-clause built by hand. The hooks stay — a gate refuses with a
level, a person needs the sentence.

Two departures from the levels `db/README.md` had recorded since Phase 1, both
because a path reads what it needs: `Recipe` reads at 4 rather than 5 (running
one is a developer's act, and running it means reading the script), and the
machine-written models read at 2 rather than being SYSTEM throughout (a person's
action writes the `ServerEvent` beside it; only the engine's updates are 8).
`AuditEvent` is `"5.8.9.9"` — LOCKED on update and delete, which `asSystem()`
does not pass either, so `db:seed --force` no longer clears the table and lets
the workspace FK cascade do it instead.

`runSeeder` also ran on the root client, which grades STRANGER(0). The seed's
own header said everything runs as system; that was the one line that did not.

**Proven by refusal.** The drive signs in as the setup user, who is
`isSystemAdmin` and clears every gate in the schema, so 262 green checks proved
only that the app still works. Eight new checks ask the same API as a second
human: a viewer reads the fleet and creates nothing, a developer writes projects
and is still refused `GET /secrets` **with the level named in the message** —
the check that fails if `memberRole` never reaches the principal, since no hook
refuses that read. Plus 8 tests at the Data boundary against the app's own
resolver. `verify` 270/270, `bun run test` 56.

It found a framework defect on the first request: `db.asSystem().$transaction()`
handed its callback the ROOT client, so `POST /setup` failed with *"Account.create"
requires SYSTEM access (use asSystem())* about a call that was using it
(`FJS-149`, fixed in litestone).

## 2026-08-10 — the drive stopped stepping around the thing it found

`verify.mjs` § 13c-ter is the only reproduction of `FJS-139` — a reload driven
from a channel subscriber that does not settle — and it had an
`await goto('/volumes/')` immediately before the check that would have caught it.
The check therefore passed against a fresh navigation whether or not the live
reload ever settled: the test that found the defect was also the reason it could
not be observed again.

The goto is gone. That check now reads whatever the push-driven reload produced,
and `bun run verify --reset` passes **262/262 three runs consecutively** in that
state, so FJS-139 is closed as not reproducible. Which change stopped it is not
known — the register says so rather than crediting the nearest fix. What makes
closing it acceptable is that the live path is now asserted: if it comes back,
the drive fails on it instead of navigating past it.

The same run is what proves this app against three junction changes landed the
same day — `find` must answer a list, an action's answer is no longer rebuilt as
a list, and a dropped WebSocket frame is now held and re-sent. Roughly fifteen
services here answer `{ total, limit, offset, data }` from a custom action and so
now arrive unwrapped; every consumer reads `.data`, and 262/262 says so in a
browser rather than in a grep.

## 2026-08-10 — the tier above every tenant

Phase 10: `/hub/`, `/hub/workspaces/`, `/hub/users/`, `/hub/flags/` — the last
group of screens whose blocker was an API rather than a model, and the run-up to
`FJS-007`. 21 services, 37 models, 31 of 41 screens. Details in
`docs/SCREENS.md` § Phase 10; three rulings in the repo's `DECISIONS.md`.

**A tier above every tenant is a separate service.** Nineteen of the twenty
services here take `X-Workspace-Id` and refuse without it. Widening them with
`?scope=hub` would have put the tenancy decision in a query string on nineteen
services, each of which has to get it right. `/hub` takes no workspace at all,
sits behind one `requireSystemAdmin` hook, and reads through `asSystem()` —
which is not a convenience: `User` is gated at level 8 by auth's own schema
fragment, one above SYSADMIN, so once `FJS-007` lands no caller-scoped client
can read a user list. Those reads are already written the way they will still
have to be. Refusal is 404, not 403.

**The privileged bit is `User.isSystemAdmin`, and the name is load-bearing.** Not
auth's `role`, which defaults to `"user"` and which nothing here reads — that
would be one column with two owners. The name is the one `sessionGateLevel()`
already grades SYSADMIN(7) on, so the column filling these screens today is the
column `@@gate` will read tomorrow. `/setup` grants the first one, because it is
the only place a system administrator is created rather than granted.

**Suspension was a word nothing honoured.** `User.status` had been a free
`String` since the schema was written and @frontierjs/auth never reads it, so a
Suspend button would have reported success and revoked nothing. Three things
make it real and no two are enough: an enum, so the column carries a CHECK and
the service's copy is held against it by a test in both directions; the front
door, checked AFTER the password so it does not disclose which addresses are
suspended; and the door already open — a token issued before the suspension
stops resolving, because deleting the `Session` rows misses an API key, which is
a `Credential`. For a workspace the one door is `scopeToWorkspace`, so it bites
in nineteen places by being written in one. Suspension is not deletion:
`@@softDelete(cascade)` stamps every child, a status change stamps nothing.

**Bot accounts, and the API-key gap they close.** The Users screen creates
`UserKind.bot` users and ships without the mock's Invite button. A bot has no
password credential, so creating one hands nobody anything; creating a human
here would be an admin minting an account with a password only they know
(`FJS-032`). Its address is at `bots.invalid` — RFC 2606 reserves the TLD, so it
resolves nowhere and can never be mailed. It may not own a workspace and may not
hold the hub tier. This closes what `api-keys.service.ts` had recorded in its own
comment since Phase 6: a key was always minted for the caller, so CI's key was a
person's key. A key may now name a bot — only a bot, only in this workspace, and
only one that does not outrank you.

### What building it found

- **An app could not get its own User columns onto the session.** auth owns
  `model User`, every app extends it, and the only route to `isSystemAdmin` per
  request was to wrap `verifySession` and re-read the user — a third query on
  the hottest path in the app, forever, for a row auth had just fetched. Closed
  in @frontierjs/auth with `createLitestoneAuth(db, { sessionFields })`, called
  from `toContext()`, the one place every issued session is built, so it covers
  login, `verifySession`, an API key and `createUser` alike. Spread last, so an
  app that states a field wins.
- **A `find` that answers one object becomes an EMPTY list in the browser**
  (`FJS-144`). `GET /hub` was the overview; the client normalises anything that
  is not a list into `list(name, [])`, so the screen received `{ data: [] }`
  with a 200 and rendered nothing at all. The API was correct throughout — only
  the browser could see it. `find` means a list; the overview is an action now.
  Same class as `FJS-140`, from the other end.
- **The typechecker caught a stat that would always have read zero.**
  `app.conduit.list()` is async, and `.length` on the promise is `undefined`,
  which `?? 0` turns into a confident *no targets registered* on a hub with
  twelve. Both answers render, so nothing in a browser could have found it.
- **The in-process event bus cannot be counted** (`FJS-143`). `IEventBus`
  answers `hasListeners()` and nothing else — no subscriber count, no list of
  subscribed names. The mock's "Event subscribers" tile does not exist; the
  overview shows the true half and says which.
- **A fifth stale dev server, again.** An `example` API five hours old held
  :3610 and would have answered the auth regression run with pre-change code.

## 2026-08-10 — the two ways to act on a machine

Phase 9: `/recipes/` and `/cleanup/`, over four new models — `Recipe`,
`RecipeRun`, `DiskUsage`, `CleanupRun`. 20 services, 37 models. Details in
`docs/SCREENS.md` § Phase 9; the ruling is in the repo's `DECISIONS.md`.

**A vocabulary cannot bound a script, so the record does.** The obvious move was
to apply yesterday's saved-view ruling again, and it does not transfer: a stored
query is dangerous because it is executed at the Data boundary, where `@@gate`
and `@@allow` grade a caller against a model; a script is handed to an outpost and
run on a machine, where there is no model and no grade at all. So the two
screens carry opposite safeguards. A cleanup stores target NAMES from a fixed
list and refuses anything else by name; a recipe stores code, authoring it is
admin-or-owner, running it is developer, and every run keeps the script it ran.

**Authoring and running split on purpose.** Writing the script is the privileged
act; running a vetted one is what somebody on the pager does at 3am. Collapsing
them makes recipes admin-only in practice, which is how people end up pasting
the script into a terminal instead.

**One run row per SERVER**, because a fleet run is N executions with N exit
codes and a single row must pick one status for *three succeeded and two
failed*. Neither screen executes anything: both queue on Caravan's new `fleet`
queue and `api/src/engine/fleet.engine.ts` asks the outpost through `app.conduit`
— one file for both, because the shape is one shape (resolve the outpost, send,
record, push) and only the safeguards differ.

**Every number on the cleanup screen was measured by Docker.** `DiskUsage`
carries `docker system df`'s own per-category reclaimable figures; the mock
multiplied a count by an average and printed gigabytes next to figures that were
real. The estimate sums by SOURCE rather than by target, since both image
targets draw on one reclaimable figure and adding them would promise twice what
a sweep can deliver. A machine that has never reported says so instead of
rendering zeroes, and unused volumes — the one target no registry can undo — are
off by default.

`DiskUsage` counts no volumes and stamps no last-cleanup: `Volume` owns per-disk
sizes and `CleanupRun` owns when a sweep ran. A sweep's answer carries a fresh
`usage` snapshot from the outpost that just measured it, written through the same
function the report endpoint uses, and volumes it removed are forgotten only by
the names it confirms — the rule `volumes.prune` already follows.

### What building it found

- **A set-valued vocabulary has no home in the schema** (`FJS-141`).
  `targets ReclaimTarget[]` does not parse — *array [] is only supported for
  Text, Integer, File, or a model name for many-to-many* — so a declared enum
  beside a `String[]` column would be two homes with nothing joining them, the
  shape that let `AlertRule.severity` default to a value its own API refused.
  One home in `api/src/services/cleanup/targets.ts`; a data test asserts the
  schema declares no competing enum.
- **`stampWorkspace` is not optional bookkeeping on a resource.** `Recipe.mesa`
  shipped without it because the service stamps `workspaceId` itself — but
  browser-side validation runs first, so every save was refused in the form with
  *workspace is required*, a field the form does not show. Caught by the browser
  drive on its first run, which is the only place it is visible.
- **`enum JobRunStatus` became `enum RunStatus`**, shared by `JobRun`,
  `RecipeRun` and `CleanupRun`. Three copies of the same five words drift apart
  one value at a time; a data test names all three models.

Not built, and said on both screens: a schedule. A sweep or a recipe on a timer
is a `Job` with a cron expression, and a second scheduler on either screen would
be a second owner of when the fleet gets touched.

## 2026-08-10 — a saved view names a kind

Phase 8: `/dashboards/` + `/dashboards/[id]/`, over two new models, `Dashboard`
and `DashboardWidget`. 18 services, 33 models. Details in `docs/SCREENS.md`
§ Phase 8; the ruling is in the repo's `DECISIONS.md`.

**A widget names a declared KIND. It never stores a query.** A widget carrying
`{ accessor, where }` is a read in a row, and a row travels while a policy does
not — `@@gate` and `@@allow` grade a caller against a model, never against a
string, so the server would run one person's query at another person's
privilege. `enum WidgetKind` is the vocabulary instead, and one declaration does
three jobs: the column's CHECK, the API's validation, and the Add-widget picker,
which reads it as a `$def` on the model's JSON Schema the way every other enum
already reaches the browser.

**Nothing on a board reads on the board's behalf.** Each card calls the service
that owns its data with the reader's own session, so a dashboard shows exactly
what its reader could have opened for themselves — and the activity card tells a
developer the trail is admin-only rather than rendering empty.

**What the schema cannot say lives in one file.** Which kinds take a server,
which take an app, which config keys each reads, and the sentence a thin card
prints — `api/src/services/dashboards/kinds.ts`, fetched by the screen through a
collection-level `kinds` action rather than copied into the bundle. A data test
holds the enum and that table together in both directions.

All nine of the mock's widget types ship. Three say what they cannot show:
nothing here stores a time series, so `server_health` is the last heartbeat
rather than a trend, `service_health` is a live ping with no latency, and
`alert_status` has rules but no evaluator (`FJS-123`). The mock's counter holds
a number typed in when the widget is added; this one names a source from a
declared list and reads that service's own `total`.

A widget's subject is a real relation (`serverId`, `appId`) with
`onDelete: SetNull`, so a card whose machine was really deleted keeps its place
and loses its subject. `config` is knobs, and an unknown key is refused by name.
The pin is the workspace's, not the reader's, and says so. No colour column —
`@frontierjs/css` styles by tone, and a stored hex is one the theme cannot
follow.

### What building it found

- **A custom action that answers `data` plus anything else loses the anything
  else** (`FJS-140`). `kinds` returned `{ total, data, statSources,
  portalServices }`; `wrapResult` read the first two keys as a paginated list
  and rebuilt the envelope from those alone, so the picker received nine kinds
  and neither vocabulary needed to configure them — 200, no warning. Three named
  keys instead makes it a `single`, which unwraps whole. `volumes.usage`
  documents the same trap from the other side.

`bun run test` 39 · `bun run verify` **207** · `bun run verify:build` 8 ·
typecheck unchanged at 77.

## 2026-08-10 — the first thing here that is observed

Phase 7: `/volumes/`, over the `Volume` model that had landed with no service,
no screen and no seed data. 17 services. Details in `docs/SCREENS.md` § Phase 7.

**A volume is OBSERVED, not declared.** Every other model in this app is
something a person created and Basecamp then acts on. A volume exists because
Docker made it and an outpost found it, so the service has no `create` — a row
appears because a machine reported it, through `report`, which replaces that
server's whole set and is exempted from `sessionScope` by name the way
`servers.heartbeat` is.

**Deleting a row is not deleting a volume.** `remove` and `prune` ask the
outpost, through `app.conduit`, at the `outpost:<id>` target a heartbeat registers,
and forget the row only once the machine says the disk is gone — `prune`
forgets exactly the names the outpost confirms, never the ones it asked about. A
server whose outpost has never checked in refuses in words and keeps the row: the
alternative leaves the disk full and the fleet's picture wrong in the one
direction nothing can detect. A mounted volume refuses too, naming the
containers.

**No `workspaceId` on the model**, so the scope is the join through its server
— the same two indexed queries `servers.feed` runs. Sizes are bytes; the screen
decides MB or GB.

### What building it found

- **Nothing had ever sent to an outpost, and it could not have.**
  `servers.heartbeat` registered the conduit target with
  `auth: { type: 'hmac', secret }`, but conduit's hmac signer reads **`ref`** —
  so every outbound call to an outpost failed `auth_failed` naming credential
  `undefined`, and the shared secret was written into the registry in plaintext
  where `GET /conduit-targets` hands it back. Both halves gone: the target
  carries `env:OUTPOST_SECRET` and `createSecretResolver` resolves an `env:` ref
  through `core/env.ts`, so an undeclared name fails closed. The literal it used
  to sign with was not the app's `OUTPOST_SECRET` either.
- **The outpost was only registered on a status transition**, inside the
  `came_online` branch, while the comment beside it claimed "first heartbeat /
  IP change". A machine already online when its outpost first reports a URL never
  transitioned, so it was never registered. Registration is keyed on the URL now.
- **Omitting a method does not remove it.** With `model:` set, Junction's
  Litestone base answers every CRUD verb the service leaves out — validated, so
  `POST /volumes` answered **201** and wrote a row no disk corresponded to.
  `methods:` is the allow-list that makes an absence real, and Junction's own
  docs say so.
- **`bun run db:seed --force` could not run on a fresh database.** SQLite
  resolves a table at prepare time, so the `DELETE FROM "_litestone_seeds"`
  threw `no such table` before anything was reseeded — which is every database
  `verify --reset` leaves behind. The delete list had also drifted: eleven
  models were missing from it, so a `--force` left their rows behind.
- **`FJS-139`** — a service call issued from a channel subscriber can hang until
  some other call is made. Open, not worked around here.

## 2026-08-09 — the token this app issues

Phase 6: `/api-keys/`, and the third direction of "proving identity" that the
two credential models did not cover between them. A `Credential` is how a
person proves identity **to** Basecamp; a `Secret` is how Basecamp proves
identity **to** a provider; an `ApiKey` is a token Basecamp **issues**. 30
models. Details in `docs/SCREENS.md` § Phase 6.

**The token is nowhere in this app.** `@frontierjs/auth` mints it and keeps an
HMAC of it in a `Credential`; `ApiKey` owns the operational half — workspace,
scopes, usage, revocation — and stores a hint (`fjs_AbCd…wXyZ`) and nothing
else. So the mock's `reveal` button is not a feature that was skipped. Building
it would mean storing the token, which is the one thing an API key exists not
to do, and a db test asserts against the generated DDL that no column could
hold one.

**A scope is `<service>:<read|write>`, and the resource half IS the service
name.** No mapping table: the vocabulary is derived from the service registry
at call time, so a service added tomorrow is grantable tomorrow, and a checkbox
can never offer a scope the guard does not recognise. The screen fetches it
from a collection-level `scopes` action rather than shipping a copy. Two
services are off limits to a key at all — `api-keys` itself, because a key that
can mint keys escalates past its own scopes, and conduit's management service.

**Revoked is a state, not a deletion.** Revoking deletes the credential — the
token stops working on the next request — and keeps the row, so an operator can
still see what was taken away and when. There is no `@@softDelete` on the
model: revoked and deleted are two states, and a third hidden one would make
four out of two.

**Usage is attributed per key**, in an app-level after hook, and only counts
what the key was allowed to do. `lastUsedAt` + `totalUses` + a day-stamped
counter (`usageDate` / `usesOnDate`), so "uses today" rolls over by comparison
rather than by a scheduled job. One write per authenticated key request, which
is what last-used costs.

### What building it found — three defects, all in @frontierjs/auth

None were visible from inside this app, and all three failed in the direction
that looks like success. Full write-ups in `../../ISSUES.md`:

- **`FJS-134` — an issued key authenticated nothing.** Junction's transport
  resolves a Bearer token through `verifySession()` and calls `verifyApiKey`
  nowhere, and the native provider never fell through. Every key this screen
  minted would have been anonymous.
- **`FJS-135` — a key's scopes were dropped on verification.** Stored on the
  credential, built from the user row, so every key carried its owner's full
  standing. The scope picker would have been decoration.
- **`FJS-136` — `revokeApiKey` revoked nothing here.** It coerced
  `Number(keyId)` because auth's own fragment declares an `Int` id; this schema
  uses uuids, so it matched no row and threw nothing. Revoke would have
  reported success and the key would have kept working.

The pattern is the one this app keeps producing: a feature that is fully
implemented, fully unit-tested, and has never been used end to end.

### And `bun run db:seed` had been broken for two phases

Nothing runs it, so nothing noticed. Two breaks, each left by the phase that
made the schema change:

- `severity: 'high'` on every seeded `AlertRule`. `AlertSeverity` became an enum
  in Phase 3 (`info warning critical`) precisely because the vocabulary had been
  owned twice — and the seed was the third owner, refused by the CHECK
  constraint the migration generates.
- `channels: ['email']` on the same factory, a column Phase 5 replaced with the
  `AlertRuleChannel` join. `table alert_rule has no column named channels`.

Both fixed, and the seed now issues three API keys per workspace — one revoked —
each with a REAL credential from auth, because a key row pointing at no
credential is refused by `apiKeyGuard` and would have seeded the failure path.
The plaintext is dropped on the floor: nothing can read it back, which is the
property, and a seed that printed one would teach the opposite.

**`db:seed` belongs in whatever proves a schema change.** It is the only thing
here that writes every model, and it is the one path `verify` does not take.

## 2026-08-08 — where an alert goes, and what is behind a flag

Phase 5 of the rebuild: `/channels/` and `/flags/`, two screens from the "needs
new models" pile, each chosen because it closed a hole in something already
built. `bun run verify` is **156 checks**; `bun run verify:build` is new.
Details in `docs/SCREENS.md` § Phase 5.

**`NotificationChannel` is the model `AlertRule.channels` was already pointing
at.** That column was `Json @default("[]")` — an array of ids for rows no model
declared, a foreign key with no constraint and no reader. It is now
`AlertRuleChannel`, a real join, and attaching is `alerts.attachChannel`. The
credential is not on the row: a Slack webhook URL is a bearer credential, so it
goes into a `Secret` (`@encrypted`) and only the reference is kept. **`test`
really sends** — through `app.conduit`, with the credential resolved from its
Secret at send time by `core/credentials.ts`, because conduit's default resolver
reads `process.env` and cannot see something a person typed into a form five
seconds ago.

**`FeatureFlag` + `FlagOverride`.** The mock keyed per-environment state by tier
name; that vocabulary already exists as `model Environment`, so an override
points at the real row. `resolveIn()` is the one definition of what a flag is
set to in an environment, exported so `flags.resolve` and the screen cannot
disagree.

**Two gaps closed**: `servers.feed` (`FJS-104`) puts the fleet's own events in
`/activity/` beside the human trail, and `bun run verify:build` (`FJS-085`)
probes the production build, which nothing here had ever done — it cost this app
a blank page once.

**Resource files are now PascalCase singular, one per file** — `App.mesa`, not
`apps.mesa`; 13 renamed, 36 call sites. Repo Invariant 19, ruled 2026-08-08.

Five defects found, four in the framework: a JSON Schema `default` emitted with
the wrong type (`FJS-120`), raw SQL unable to write (`FJS-118`), conduit
refusing a non-JSON response (`FJS-121`), a collection-level action unreachable
from the browser (`FJS-122`), and the kit's toasts having no updatable handle
(`FJS-119`). Still open: nothing evaluates a rule (`FJS-123`), and a rollout
percentage is stored but never applied (`FJS-124`).


## 2026-08-06 — a missing record still needs a heading

134 checks (was 133). The app detail screen rendered its error alert and
**nothing else** when its record was gone — no `<h1>`, so a screen reader landed
on a document with no heading at all and the only statement of what had happened
was styled as a decoration. Reached in the ordinary way: deleting a project
cascades to its apps, and any bookmark or back button then lands there. It now
has an `{:else}` branch with a heading and a way back.

Found by adding the dynamic route to `verify`'s a11y loop, which runs *after* the
deletion checks. Every static screen had passed that audit for days; the branch
that only exists when something is missing had never been audited at all.

## 2026-08-04 — the UI realm

`web/` went from a 12,557-line React mock that had never made a request to a
Sierra SPA over every service. Phases and what each found: `docs/UI_PLAN.md`.

- **Screens.** Setup wizard, login and a navigation guard; workspace switcher;
  Projects → Environments → Apps with environment variables; deployments with a
  live step timeline; the server fleet (drain/undrain/reboot/sync, event trail,
  outpost heartbeat); jobs with run history; an admin zone (members, audit trail,
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
- **The outpost heartbeat published to nothing**: `workspaceChannel` reads
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
