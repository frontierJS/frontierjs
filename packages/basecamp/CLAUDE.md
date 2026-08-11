# basecamp — package map

**An FJS application, not a library.** A fleet-operations app, and the largest
dogfooding surface in the repo — building it is how framework defects get found.
All three realms are real.

```
bun run dev          # preflights both ports, then API + web together
bun run test         # bun — the db tests
bun run verify       # 270 checks in a real browser; starts and stops both servers
bun run verify:build # builds, then probes the PRODUCTION output (FJS-085)
bun run db:seed      # an example fleet
bun run db:reset     # stops the servers, deletes the databases
```

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
- **`Server` is the one model whose tenancy is in the schema.** `@@allow('all',
  workspaceId == auth().workspaceId)`, graded off the same principal — the other
  36 are still the `workspaceId` in a service where-clause plus
  `scopeToWorkspace`. Adding the next one is an audit before it is a line: **a
  policy filters where a gate refuses**, so any read crossing a workspace that
  is not `asSystem()` starts matching nothing, quietly. The engines, the hub and
  the agent endpoints already are; a new one is the thing to check. `db/README.md`
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
- **`autoValidate` deletes every key the model does not declare, and user hooks
  run BEFORE it.** So a wire-only field — one that is not a column, like the
  plaintext `secret` a channel is created with — has to be taken off `ctx.data`
  in a BEFORE hook, because by the time a method body runs it is gone. Silent:
  the channels service reported *Slack needs a credential — send it as `secret`*
  about a request that carried exactly that. Same shape as `ip_address` on the
  servers service, where the write succeeds and the column comes back null.
- **`ctx.params` does not exist in a service context.** This app's services read
  `ctx.params.user.user_id` and `ctx.params.headers` throughout — every one
  `undefined`, so role checks silently passed for everyone. Fixing an occurrence
  means moving to `ctx.auth` / `ctx.client.headers` / `ctx.route`.
- **`before: { all: [...] }` hits every method**, agent endpoints included.
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
  ever sent to an agent, so neither half showed for two phases.
- **`bun run db:seed` is the only thing here that writes every model, and no
  suite runs it.** It had been broken for two phases when that was noticed:
  Phase 3 turned `severity` into an enum and left the seed writing `'high'`,
  Phase 5 replaced `AlertRule.channels` with a join and left the seed writing
  the dead column. `--force` could not run at all on a database that had never
  been seeded, and its delete list had drifted eleven models behind the schema —
  so a `--force` left those rows in place. Neither shows up in `verify`, which
  drives screens rather than the seeder. Run it after any schema change, and add
  the model to the `--force` list when you add one.
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
- **The audit trail must cover custom actions.** It recorded `create`/`patch`/
  `remove` only, so drain, deploy, cancel and trigger were in no trail at all. It
  now runs on `all` minus reads, with `servers.heartbeat` excluded by name.
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
