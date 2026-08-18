# basecamp — package map

**An FJS application, not a library.** A fleet-operations app, and the largest
dogfooding surface in the repo — building it is how framework defects get found.
All three realms are real.

```
bun run dev          # preflights both ports, then API + web together
bun run test         # bun — the db tests
bun run verify       # 271 checks in a real browser; starts and stops both servers
bun run verify:build # builds, then probes the PRODUCTION output (FJS-085)
bun run db:types     # regenerate db/schema.d.ts — the client's types
bun run db:seed      # an example fleet
bun run db:reset     # stops the servers, deletes the databases
bun run image        # build the container image from the WORKING TREE
bun run image:up     # …and bring the stack up on 8020  · image:down stops it
```

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
`ENCRYPTION_KEY` and `AUTH_SECRET` are required and have no defaults there;
**losing the encryption key loses every `@encrypted` column in that volume.**

**An interrupted `verify` cleans up after itself** — SIGINT/SIGTERM/SIGHUP and
an uncaught throw all kill the API, the Vite and the Chrome it started. Before
that they were orphaned, and the next run either tripped its own port check or
talked to an API holding a database `--reset` had already deleted.

`verify` needs an **empty** database (`bun run verify --reset` does it for you)
and both ports free: API **8120**, web **8020**. That web port is the same one
`example/` uses — they cannot serve at once, and only this side is strict about
it (`strictPort` + `scripts/preflight.mjs`).

---

## Layout

```
db/       schema.lite (37 models, 21 enums) · generate.js · migrations/ · seed.js ·
          litestone.config.js · test/ · README.md (the depth doc)
api/src/  index.ts · services/ (21) · engine/ (3, on accessors) · core/ · infra/
          core/credentials.ts owns both conduit ref forms — `secret:<id>` and
          `env:<NAME>`; a target carries the ref, never the material
          core/session-auth.ts projects this app's OWN User columns onto the
          session and owns both doors suspension is refused at
          engine/fleet.engine.ts is both ways this app acts on a MACHINE —
          `recipe:run` and `cleanup:run`, one shape, opposite safeguards
          services/hub/ is the ONLY service that takes no workspace
web/src/  App.mesa · main.js · session.js · notices.js (one leaf definition the
          shell and the home screen share) · routes/ · components/ ·
          resources/ (PascalCase singular, one Resource per file — Invariant 19)
web/test/ verify.mjs · verify-build.mjs + preview.mjs (the built output)
docs/     SCREENS.md — the mock inventory, 31 of 41 screens built, the rest
          grouped by what blocks them (FJS-153). No screen is blocked on an
          API any more — the 10 left need a model or a real third party
          UI_PLAN.md · UI_HANDOFF.md · VISION.md · mock/
```

---

## What bites here

- **A level is per WORKSPACE, and it rides on the principal.** All 37 models
  declare `@@gate`; `api/src/core/gate.ts` is the ladder (viewer/billing 2,
  developer 4, admin 5, owner 6, `isSystemAdmin` 7, authenticated-but-not-a-member
  1). The level comes from the `WorkspaceMember` row for the workspace the
  request is FOR, which is why `sessionGateLevel()` is not used here — it grades
  standing that travels with the user and would answer the same in every
  workspace. `applyStanding()` (`core/hooks.ts`) resolves it once per request,
  puts `memberRole` on **a fresh copy of the principal** and re-scopes
  `ctx.locals.db` from it. Three traps in that one sentence: it must be the
  principal, because junction's `getTable()` re-derives its own scoped client
  from `ctx.auth.user`; it must be a copy, because the WS session object is
  shared across every frame on the socket and frozen; and it must re-resolve
  when the workspace changes mid-request, which the workspaces service does
  (it addresses `ctx.id`, not the header). The role hooks stay — a gate refuses
  with a level, a person needs the sentence.
- **Ten models declare `@version`, and a service-side write of a row must carry
  the version it read.** The rule for which ten is in `db/schema.lite`'s header:
  a row a PERSON edits, never one a machine also writes on its own schedule —
  `@version` is per row and not per column, so a heartbeat or an engine moving
  `status` would refuse an edit for a change nobody made. Three consequences
  here. A method that fetches a row and then writes it (`makePrimary`,
  `uploadCert`, `verify`, `demoteSiblings`, `saveVariables`) states
  `version: row.version` — a real compare-and-swap, not a formality. An empty
  patch is `changesNothing(patch)` and not `!Object.keys(patch).length`, because
  the version rides on every one and would otherwise turn an untouched form into
  a write that bumps it. And a screen holding a DRAFT pins the version in the
  draft: `createResource` fills one in from what the store holds, the store is
  live, and a push moves the remembered version while the draft sits still —
  which erases the other person's write with the guard in place and nothing
  said. `<Form record={row}>` is already right; the hand-rolled editors are not
  unless they carry it.
- **`User` reads and updates at USER(4), and the level is not what makes that
  safe.** A gate is per MODEL, so 4 on update is *any signed-in caller rewrites
  any person's row*. `@@allow('update', id == auth().id)` narrows it to their
  own, and `@allow('write', auth().isSystemAdmin)` on `isSystemAdmin`, `status`
  and `kind` keeps the three columns `basecampGateLevel()` grades on out of the
  caller's reach — a column the caller can write is not a column a level can be
  graded from. Both are bypassed by `asSystem()`, which is every legitimate
  write here (`/setup`, the hub). **`@guarded` would not have done it**: it is a
  read-side lock, the write lands and the answer comes back with the column
  missing, which reads exactly like a refusal (`FJS-248`). This is the shape `@frontierjs/auth`'s own fragment now ships (`DECISIONS.md` § Access control); what differs here is the standing, deliberately — auth writes the policy against `auth().isAdmin`, this app has no app-wide admin (a level is per WORKSPACE) and its hub reads through `asSystem()`, so the row policy is self-only with no admin exception and the guarded columns are the three its own resolver grades on.
- **`db/schema.d.ts` is generated, committed, and the only place the client is
  typed.** `bun run db:types` writes it (`audience=system` — the API reads
  `Secret.data`, which is `@encrypted`, through `asSystem()`), `api/src/core/db.ts`
  casts once, and nothing downstream casts at all. `bun run test` fails if the
  file is not what the schema generates right now, which is the half that makes a
  committed generated file safe. **A hand-written row interface is the thing this
  replaces**: `job.engine.ts` carried `JobRow` in snake_case with `service_id` on
  it — three renames stale, describing no row that has ever existed, while the
  code around it read the right camelCase names.
- **15 models keep their tenancy in the schema** —
  `@@allow('all', workspaceId == auth().workspaceId)`, graded off the same
  principal. Every model carrying a `workspaceId` except two: `WorkspaceMember`
  (what standing is READ from, before there is a workspace on the principal to
  compare against) and `AuditEvent` (nullable workspace — a hub action belongs to
  none, and a null comparison would hide the rows the trail exists for). The
  other 22 carry no `workspaceId` of their own — a `DeploymentStep`, a `JobRun`,
  a `Volume` — so the next move there is `check(parent)`, not a restated column.
  `Deployment`/`Job`/`Domain`
  brought a shape the hierarchy did not have — a read filtered on `appId` alone
  (an app's recent releases, a hostname's siblings), safe before only because the
  app had been fetched scoped first. Adding the next one is an audit before it is a line: **a
  policy filters where a gate refuses**, so any read crossing a workspace that
  is not `asSystem()` starts matching nothing, quietly. The engines, the hub and
  the outpost endpoints already are; a new one is the thing to check. `db/README.md`
  § Access control is the depth, `db/test/schema.test.ts` runs it with no
  service in the picture.
- **`asSystem()` is what a system path needs, and a transaction used to lose
  it.** `db.asSystem().$transaction(tx => …)` handed the callback the ROOT
  client until 2026-08-10, so `POST /setup` — four models in one transaction —
  failed with *"Account.create" requires SYSTEM access (use asSystem())* about a
  call that was using it. Fixed in litestone (`FJS-149`); the mirror image,
  `$setAuth(u).$transaction`, silently ran with `auth()` null.
- **A session carries three columns auth knows nothing about.** `isSystemAdmin`,
  `status` and `kind` are Basecamp's additions to auth's `User`, and they reach
  `ctx.auth.user` through `sessionFields` (`core/session-auth.ts`), which auth
  calls from `toContext()` with the row already in hand. Read them off the
  session; **do not re-read the user to get one** — that is a third query on the
  hottest path in the app, which is the thing the seam exists to avoid.
- **`suspended` has two doors and both are needed.** Login refuses (after the
  password check, so the refusal does not disclose which addresses are suspended
  accounts), and an app-level `before: all` hook refuses a token issued
  earlier. Deleting the `Session` rows does NOT cover it — an API key is a
  `Credential` and survives that. A suspended workspace is refused in
  `scopeToWorkspace`, the one hook every scoped service already runs. Neither is
  a delete: `@@softDelete(cascade)` stamps every child, a status change stamps
  nothing.
- **A `find` that answers one object reaches the browser as an EMPTY list.** The
  Junction client normalises anything that is not a list — or `{ total, data:
  [] }` — into `list(name, [])`: 200, no warning, and the screen then renders
  nothing while the API is answering correctly. `GET /hub` was written this way
  and could only be seen in a browser. **`find` means a list**; a service
  answering one thing uses a named action (`FJS-144`). Same family as the
  `{ data, total, …extra }` trap below, from the other end.
- **`autoValidate` deletes every key the model does not declare — unless the
  schema declares it `@transient`.** The plaintext `secret` a channel is created
  with is not a column and now says so (`FJS-D23`): it is validated with the
  model's own rules and lifted onto **`ctx.transients`**, so `create` and `patch`
  read `ctx.transients.secret` and the write carries columns only. An UNDECLARED
  wire-only key is still deleted in silence, which is the whole reason to declare
  one — the channels service used to report *Slack needs a credential — send it
  as `secret`* about a request that carried exactly that. Same shape as
  `ip_address` on the servers service, where the write succeeds and the column
  comes back null.
- **`ctx.params` does not exist in Junction at all** — on either context, since
  `FJS-D03`. This app's services read `ctx.params.user.user_id` and
  `ctx.params.headers` throughout, every one `undefined`, so role checks silently
  passed for everyone. Fixing an occurrence means `ctx.auth.user` /
  `ctx.client.headers` / `ctx.route` — and `ctx.route` is the answer on a raw
  route too, which is what changed: the word used to mean path captures there and
  nothing here, and that asymmetry is what kept the idiom arriving.
- **`before: { all: [...] }` hits every method**, outpost endpoints included.
- **Leaving a method out does not remove it.** `createService({ model })` brings
  Junction's Litestone base, which answers every CRUD verb the service does not
  declare — with validation, so a well-formed payload is written. `POST /volumes`
  answered **201** and created a row for a disk that does not exist, on a service
  whose whole point is that nobody authors one. `methods: ['find', …]` is the
  allow-list that makes an absence real; it also throws at construction on a
  name the service does not have.
- **A conduit target carries a REF, not a credential.** `auth: { type: 'hmac',
  secret }` type-checks through a cast and cannot work: the signer reads `ref`,
  so every send fails `auth_failed` naming credential `undefined` — and the
  material is written into the registry, which `GET /conduit-targets` returns.
  `core/credentials.ts` resolves `secret:<id>` and `env:<NAME>`. Nothing had
  ever sent to an outpost, so neither half showed for two phases.
- **`bun run db:seed` is the only thing here that writes every model, and `db/test/seed.test.ts` now runs it** — as a process, in a throwaway cwd, including `--force`. It had rotted twice before anything asked: Phase 3
  turned `severity` into an enum and left the seed writing `'high'`, Phase 5
  replaced `AlertRule.channels` with a join and left it writing the dead column,
  and the `--force` delete list was eleven models behind. Run it after any schema
  change, and add the model to the `--force` list when you add one.
- **Migrations are per DATABASE — `db/migrations/main/`** — and both the boot
  path and the seeder apply them with litestone's `apply()`, never junction's
  `dbClient.migrate(dir)`, which globs one level and reports success for a
  directory it cannot read. That is how a fresh boot came up with no tables and
  said nothing (`FJS-193`'s family).
- **Only `find` is built into a list envelope; an action is handed back whole.**
  It used to be shape alone — any `{ data, total }` was rebuilt as a paginated
  list from `total`/`limit`/`offset`/`data`/`errors` and every sibling key was
  dropped with a 200 and no warning, whatever method produced it.
  `dashboards.kinds` shipped nine widget kinds and neither of the vocabularies
  needed to configure them, so the picker offered widgets it could not fill in
  (`FJS-140`, closed 2026-08-10). An action answering rows now keeps everything
  it sends, and a `find` that answers anything but a list throws rather than
  guessing. NAMED keys and no `data` is still the clearest shape for an action
  that answers more than one thing — `volumes.usage`, `cleanup.targets`.
- **`web/config/vite.config.js`'s `API_PATHS` is a hand-kept copy of the service
  registry, and it has gone stale three times** — `audit`, `channels`, `flags`
  and `api-keys` were each missing for a phase or more. Nothing fails loudly:
  the Junction client is configured with the API's own origin and never uses the
  proxy. What breaks is anything fetching a relative URL from the page — which
  is every check in `web/test/verify.mjs` — and it breaks as a **404 from Vite**
  rather than a refusal from the API, so it reads as a missing route. Add the
  path when you add the service.
- **A resource over a workspace-scoped model needs `stampWorkspace` in its own
  before/create, even though the service stamps `workspaceId` anyway.**
  Browser-side validation runs FIRST, and `workspaceId` is required on every
  create schema here — so a resource without the hook refuses every save in the
  form with *workspace is required*, naming a field no form shows. `Recipe.mesa`
  shipped without it and only the browser drive could see it; the API was
  correct throughout. `web/src/session.js` owns the hook, once.
- **A model whose required columns are server-written cannot be created from the
  browser.** `createResource` validates by default, so `ApiKey` — `required:
  ["workspaceId","userId","name","tokenHint"]`, three of four server-side — was
  refused before the request was made, naming fields the caller was never meant
  to send. The symptom is the button doing nothing. `{ validate: false }` is the
  only escape today (`FJS-095`, ruling `FJS-D22`).
- **The audit trail must cover custom methods.** It recorded `create`/`patch`/
  `remove` only, so drain, deploy, cancel and trigger were in no trail at all. It
  now runs on `all` minus reads, with `servers.heartbeat` excluded by name.
- **A scheduled Job's clock is Caravan's, and `engine/job-schedule.ts` is the one
  place a row is bound to it.** `app.scheduler` is junction's in-process timer —
  no persistence, no retry, no principal — and this app used it to fire
  `app.jobs.dispatch(…)`, which is a clock with none of the queue's durability
  while looking like it has one (`FJS-D36`). Two defects came out of it and both
  needed a restart or an edit to see: registration happened only in `create()`,
  so **the first deploy stopped every scheduled job in the app** while the rows
  still said `scheduled` (`FJS-327`), and `patch()` validated a new expression
  without touching the clock, so **an edit was accepted and the old schedule
  kept firing** (`FJS-328`). `syncSchedule(app, row)` is the whole rule and it
  reads the UPDATED row, because `kind` and `status` change a schedule as surely
  as the expression does; `restoreSchedules()` rebuilds the clock at boot.
- **Zero raw SQL, on purpose** — everything goes through accessors, which is what
  keeps policies enforceable. `db.asSystem().sql` is the only bypass and it
  enforces nothing.
- **No invitation flow yet.** Setup → login → guard is the whole entry path.
- Building this found three Junction bugs that no unit test could: the WebSocket
  dropped `X-Workspace-Id`, channels never delivered (wrong session field, and
  `channel.publish()` does not exist), and `POST /workspaces` was unreachable.

## Proving a change

`bun run test` + `bun run verify`, and `bun run verify:build` for anything that
could change what the built page loads. A framework change that touches services,
auth or channels should be run here *as well as* in `example/` — the two apps
fail differently.
