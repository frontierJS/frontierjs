# Basecamp — UI realm build plan

**Written 2026-08-04.** Phased plan for building `web/` on Sierra + Mesa +
`@frontierjs/css`. Companion to `UI_HANDOFF.md` — the handoff is the API
contract, this is the order of work and the checkpoint after each phase.

Grounded in code, not prose: `packages/sierra/example/` (the working
UI-over-Junction reference) and `packages/junction/src/client/index.ts` were read
before this was written, and the API was booted to confirm its live shape.

## Confirmed by running, 2026-08-04

```
GET /setup/probe → {"workspaces":0,"users":0,"needs_setup":true}
GET /health      → status ok, database ok
boot             → 27 routes, 9 services, 25 models / 15 enums, gated 0/25
```

`web/` contains exactly one file: the 12,557-line React mock.

---

## Two findings that shaped this plan

### 1. The `/api` prefix is gone — fixed in the API, 2026-08-04

The client GETs `` `${apiPrefix}/setup/probe` `` (`junction/src/client/index.ts`
~829). Basecamp needs `apiPrefix: ''` because services mount at `/servers` — so
that resolved to `/setup/probe` while the API served `/api/setup/probe`, and the
404 was swallowed by the method's own `catch`, which returns `false`. A first-run
wizard built on `needsSetup()` would never have appeared.

Rather than alias the path, the prefix was dropped: auth is `/auth/*` and setup
is `/setup`, so every path in the app now agrees with every other and with the
client's defaults. Verified end to end — setup, login, `/auth/me`,
`/auth/workspace`, project create and list, 401 unauthenticated.

### 2. The client already handles workspace scoping and custom methods

No hand-rolled `fetch` is needed for either:

- `workspaceId` option / `setWorkspace(id)` → sends `X-Workspace-Id` on every
  request (`index.ts` ~527, ~423).
- Custom methods dispatch through `X-Service-Method` (`index.ts` ~321).

---

## Phases

### Phase 0 — Foundation ✅ done 2026-08-04

No screens. Make the workspace see a UI realm at all.

- Add deps: `@frontierjs/sierra`, `mesa`, `css`, `ui`, plus `vite` as a
  dev-dep. `bun install`.
- `web/` skeleton per Invariant 3 — `web/` is the Vite root, config in
  `web/config/`, because Sierra finds the schema at `../db/schema.lite`:

  ```
  web/
    index.html
    config/{vite,sierra,routes}.config.js
    src/{main.js, App.mesa, routes/, resources/}
    public/
  ```

- `sierra.config.js`: `target: 'spa'`, `junction: { apiPrefix: '',
  authPrefix: '/auth', tokenKey }` — both the client's own defaults now that the
  API carries no prefix. Vite proxies to `:3001`.
- Move `BasecampUI.jsx` out of the Vite root to `docs/mock/` — reference, never
  ported.

**Checkpoint — met.** `bun run web` on :5274, screenshot taken in headless
Chrome: the shell renders in `@frontierjs/css` vocabulary, Sierra reports
`schema: 24 model(s)` from `../db/schema.lite`, and the page reads **39 defs**
registered in the browser, `/health` → `ok` and `/setup/probe` → live counts,
both through the proxy. `bun run web:build` produces a client bundle and a
sitemap.

The header reads **offline** and that is correct, not a bug: Sierra opens the
WebSocket only when a stored token exists (`sierra/src/junction/index.js` ~310),
and nothing has logged in yet. The `/ws` proxy itself answers `101`.

#### What Phase 0 found: no prefix means a page path and an API path collide

`GET /projects` is now both the projects service and, in Phase 3, the projects
page. Client-side navigation never notices — the router does not touch the
network — but a hard load or a refresh of `/projects/` goes to Vite, and a plain
proxy rule answers it with JSON.

`web/config/vite.config.js` discriminates on `Accept`: a browser navigation asks
for `text/html` and is handed the SPA shell, everything else is proxied.
Verified both ways — `curl -H 'Accept: text/html' :5274/projects/` returns the
shell, `curl -H 'Accept: application/json' :5274/projects` returns `401`.

It works, and it is worth knowing it is load-bearing. If it turns fragile, the
durable fix is to give the API an `apiPrefix: '/api'` and match it in
`sierra.config.js` — one proxy rule, no ambiguity.

### Phase 1 — Setup wizard + login ✅ done 2026-08-04

The only paths that work with zero data.

- Probe → wizard → `POST /setup` (a raw route, not a resource) → token.
- `client.authenticate()` → `GET /auth/workspace` → `setWorkspace()`.
- `session.js` holding user / workspace / level — plain object behind a
  `watchProxy`, the same contract as `sierra/example/web/src/session.js`
  (assigning the object directly notifies nobody, Mesa RULE 45).
- Route guard, logout.

**Checkpoint — met.** Driven in a real browser over CDP against a database
reset to empty, **21/21 checks**: the wizard owns the app while no account
exists (`/` and `/login/` both redirect to `/setup/`), setup lands on home with
the email, workspace id and token in place and the WebSocket **live**, `/setup/`
becomes unreachable afterwards, sign-out clears the token and returns to
`/login/`, a wrong password reports "Wrong email or password" without leaving
the page, a correct one lands home, and a reload keeps the session. No uncaught
page errors.

Files: `web/src/session.js` (state + the four transitions), the guard in
`web/src/App.mesa`, `web/src/routes/{login,setup}/index.mesa`, sign-out in
`_module.mesa`.

Two things worth keeping:

- **The guard must be registered in component setup.** Sierra defers its boot
  navigation by one microtask precisely so guards registered during mount are in
  place before the first route commits (`sierra/src/router/index.js` ~262).
  Register it later and client-side navigation is guarded while a direct load or
  refresh of the same URL is not.
- **Setup outranks auth in the guard order.** With no account there is nobody to
  log in as, and `/auth/login` would answer 401 forever.

### Phase 2 — Shell + workspace switcher ✅ done 2026-08-04

Everything downstream 400s without `X-Workspace-Id`.

- `_module.mesa` layout: nav, header, workspace picker off the `workspaces`
  resource.
- `src/resources/*.mesa` declaring all 8 services then in existence — `audit`
  joined them in Phase 6. `.mesa` with a
  `<script module>` and no markup — Invariant 18.

**Checkpoint — met.** `bun run verify --reset`, **26/26**: the switcher lists
both workspaces, the first shows its one project and only its own row,
switching re-scopes the list with no reload, the heading follows, and the choice
survives a reload.

Three defects, each invisible until a browser drove it:

- **The workspace vanished the moment the WebSocket connected.** Junction's
  browser client routes CRUD over the socket once one is up
  (`client/index.ts` ~188), and the frame carried no `X-Workspace-Id` — the
  server sees only the UPGRADE request's headers, which cannot vary per call.
  So every scoped call answered `workspace_id required`, pointing at the app
  rather than at the transport that dropped the scope. **Fixed in Junction**:
  the client sends `meta.workspaceId`, and `transport/channels.ts` merges that
  ONE key onto `ctx.client.headers`. Only the workspace rides there — identity
  stays with the connection, established at upgrade, because a frame that could
  set arbitrary headers could set `Authorization`. Pinned by three tests in
  `junction/tests/client-transport.test.ts`.
- **`POST /workspaces` was unreachable.** `autoValidate` requires `accountId`
  and `ownerId`, which `create()` deliberately takes from the session — a client
  that could name them could create a workspace inside another tenant. User
  hooks run BEFORE the derived validation (junction `core/service.ts` ~688), so
  a `before/create` hook now stamps both.
- **The heading never followed the switch.** `currentWorkspace()` read the
  session inside `session.js`, where no component proxy is watching, so Mesa saw
  no dependency (RULE 44/45). Deriving it in the component with `$:` fixed it —
  the data had been re-scoping correctly the whole time.

And one of mine: `adoptWorkspace()` writes the remembered id, so adopting the
server default before reading it overwrote the value being restored. The switch
persisted and then undid itself on the next load.

### Phase 3 — Projects → Environments → Apps ✅ done 2026-08-04

The core hierarchy. All three are CRUD-complete server-side.

- Routes and forms with `coerce` / `validate` / `blankToNull`.
- Environment variables through the `setVariable` / `deleteVariable` custom
  methods.

**Checkpoint — met.** `bun run verify --reset`, **43/43**. Everything is driven
the way a person drives it — navigate, fill, click; nothing in this section
calls the API directly. Create a project (slug derives from the name until
edited), rename it in place, add a Production environment from the tier picker,
open it, set a variable, mask one, remove one, reload to prove persistence, then
delete the project and watch it leave the list.

Screens: `routes/projects/{index,create}.mesa`, `routes/projects/[id]/index.mesa`,
`routes/environments/[id]/index.mesa`, plus nav in `_module.mesa` — added only
now, because a link to a route that does not exist is worse than no link.

Two findings:

- **The schema requires `workspaceId`; the server stamps it.** So the
  schema-derived client validation refused every create with `workspace is
  required` before a request was sent, naming a field the person cannot see.
  Resource before-hooks run BEFORE validation for exactly this case (sierra
  `src/junction/resource.js` ~429), so `stampWorkspace` in `session.js` puts it
  on the record once, for all six scoped resources. The service overwrites
  whatever arrives — this is bookkeeping, not authority.
- **`setVariable` answered a partial row** (`{id, variables}`) where every other
  method on the service answers the whole record. A page doing the obvious
  thing — `environment = await ...setVariable(...)` — lost name and tier and
  rendered **"undefined"** as its heading, with every variable assertion still
  passing. Found by looking at a screenshot, not by a check. Fixed in the
  service, and the harness now asserts the heading after the write.

### Phase 4 — Deployments + live updates ✅ done 2026-08-04

The interesting one, and the only screen where channels show.

- List, detail with a step timeline, trigger a deploy.
- Subscribe to `workspace:<id>` rather than polling.

**It did need debugging — it had never worked.** Two independent faults, each
silent, and either alone was enough to deliver nothing:

1. **Nobody was in the channel.** The connection joined
   `workspace:${session.workspace_id}` — but the field is `workspaceId`
   (SessionContext, `junction/src/auth/types.ts`), so the `if` never fired. The
   same stale snake_case idiom that made every service read
   `ctx.params.user.user_id`. Spelling it correctly would not have helped
   either: `@frontierjs/auth` issues the session and knows nothing about
   workspaces, so nothing populates it. A connection now joins every workspace
   its user is a member of, resolved by query — which also handles the case a
   single join could never handle, someone switching workspace mid-session.
2. **The engine published into a method that does not exist.** It called
   `channel.publish()`; a Channel's method is `send(event, data)` — `publish()`
   is on the MANAGER. Its own guard, `if (!ch?.publish) return`, made that a
   silent no-op on every step of every release.

The engine also pushed a five-field projection. It now sends the whole row, for
the same reason `setVariable` does: a client that assigns the payload over the
record it is rendering loses every field the projection omits.

**Checkpoint — met.** `bun run verify --reset`, **52/52**. A release is started
from the environment screen and the page is never reloaded after that: the step
list appears, the status reaches `success`, `6 / 6 complete`, and the harness
asserts the browser actually received pushes on the socket (`window.__pushes`)
rather than inferring it from the final state — which a re-fetch could fake.

Also added: creating an App. Phase 3 covered Projects and Environments but left
Apps read-only, so there was no way to reach a deploy button from an empty
database.

**Design note.** The step timeline uses `.feed`, not `.steps`. Both are in the
design system and only one fits: `.steps` is a wizard — a horizontal indicator
of where you are in a flow you are driving — and it draws its connector line
straight through the labels when used for anything else. A deployment is a
chronological stream that happens to you. Caught by looking at a screenshot.

### Phase 5 — Servers ✅ done 2026-08-04

The richest service.

- Custom methods `events` / `reboot` / `drain` / `undrain` / `sync`, JSON
  columns, agent heartbeat, provisioning wizard.

**Checkpoint — met.** `bun run verify --reset`, **67/67**. Import a server, watch
an agent heartbeat bring it online **with no reload**, drain it, cancel the
drain, and be refused when removing it while online — the service's words, shown
rather than pre-empted.

Screens: `routes/servers/{index,create}.mesa`, `routes/servers/[id]/index.mesa`.

Three findings, all about the same seam — what a client is actually told:

- **The agent heartbeat published to nothing.** `workspaceChannel` reads
  `ctx.locals.workspaceId`, which `sessionScope` sets — and heartbeat is
  deliberately exempt from it, because an agent carries no session and no
  workspace header. So the one update in this app that arrives without a person
  clicking was the one nobody could see. The server row knows its own workspace;
  heartbeat now stamps `ctx.locals.workspaceId` from it, which is the right
  answer regardless of who called.
- **Heartbeat answered `{ ok, server_id, status }`.** A subscriber merging that
  into the row it renders cannot even find the row — there is no `id`. It now
  returns the whole record, like `setVariable` and the deployment engine before
  it. That is three for three: **a partial row is indistinguishable from a full
  one until it breaks.**
- **A published event is named after the METHOD.** A heartbeat arrives as
  `servers heartbeat`, a drain as `servers drain` — not `patched`. Subscribing
  to `patched` hears CRUD and misses every custom method, which is most of what
  this service does. The pages subscribe to `'*'` and filter out reads — that
  filter is load-bearing, because the service publishes after `get` too, so a
  handler that refetched on any event would refetch in response to its own
  refetch.

And one shape trap: **a custom method returning a list comes back wrapped** —
`{ kind: 'list', object: 'servers', data: [...] }` — because the envelope is
applied by method shape, not by name. `find()` unwraps it; `action()` does not.
Assigning it straight to an array renders "No events recorded" over a full
trail.

**Known, not fixed:** this service publishes after EVERY method, reads included,
so a `GET` broadcasts the row to every connected client in the workspace. It is
noise rather than a leak — they can already read it — but it is the wrong
default and worth narrowing to mutations.

### Phase 6 — Jobs + the sysadmin zone ✅ done 2026-08-04

Users, audit log, adapters, feature flags.

The API boots reporting `gated 0/25` — no `@@gate` is live today, so member and
user lists work without `asSystem()`. When gates land (not this work), `User
@@gate("8")` bites this zone first: even SYSADMIN(7) cannot read that model.

**Checkpoint — met.** `bun run verify --reset`, **80/80**. Jobs list and detail
with run history and `trigger`; an admin zone at `/admin/` with members (role
changes, removal, and no way to remove yourself), the audit trail, and the eight
appliance adapters.

**A new service.** The audit trail had no API at all, so `api/src/services/audit/`
is a read-only service over `AuditEvent`, admin/owner only.

Three findings:

- **`createService({ model })` gives you the full CRUD set for free**, which is
  the right default everywhere except an append-only resource. Declaring only
  `find()` left create/patch/remove answered by the BASE service — an admin
  could POST a row into the audit trail, and did: a forged `forged.event` landed
  with a real id. The service now answers 405 to all three. A trail anyone can
  write to answers no question worth asking.
- **The job engine published nothing.** Its sibling pushes on every deployment
  step; this one wrote the JobRun to the database and told nobody, so a job run
  from the UI showed no new history until the page was reloaded. It now sends
  `jobs patched` on start, success and failure — through `channel.send()`, the
  method that exists.
- **`jobs.trigger` answered `{ id, queued: true }`** — the fourth partial row,
  after `setVariable`, the deployment engine's projection and the server
  heartbeat. Now `{ ...job, queued: true }`.

**Design note.** The admin sub-nav uses `.navlink`, not `.tabs`. `.tabs` here is
a real ARIA tab widget — `role="tab"`, `aria-selected`, roving tabindex, panels
it controls. This is navigation between routes that each have their own URL, so
it is links with `aria-current="page"`, exactly as the topbar does it. Borrowing
the tab classes would have announced a widget that does not exist.

**The seeder now writes audit events.** Seeding goes through the Litestone
client rather than the services, so the `basecampAuditLog` hook never fires and
a seeded database had a full fleet with an empty trail — which reads as a broken
screen rather than as "nothing has come through the API yet".

### Phase 7 — Verify harness + docs ✅ done 2026-08-04

**Checkpoint — met.** `bun run verify --reset`, **90/90**.

The harness landed in Phase 1 rather than here and grew with each phase, which
turned out to be the point: it caught regressions in the phase that introduced
them instead of at the end. It drives Chrome over CDP directly — no Playwright,
no `chromium-cli` — because the one thing needed beyond `--dump-dom` was the
ability to click, and a WebSocket to the debugger is about forty lines.

**Accessibility.** An audit runs on all ten screens as part of the harness:
every form control has an accessible name, every `th` has a `scope`, exactly one
`h1` per page with no skipped levels, no control without text, a `<main>`
landmark and a skip link. It found one real gap — **no skip link anywhere**,
which meant a keyboard user tabbed through the nav, the workspace switcher and
sign-out on every navigation before reaching the content. The design system's
frame documents it as part of the shell anatomy; it was simply missing.

**States.** Every list screen has a loading, empty and error state, and the empty
states say what to do next rather than just "no results" — several point at
`bun run db:seed`.

**Flakiness, found and removed.** One run reported 89/90 and the failing line was
lost to a `tail`, which is its own lesson. The cause was a class of check rather
than a specific one: anything waiting on something to ARRIVE — a channel push, a
job run landing on Caravan's thread — slept a guessed number of milliseconds. A
fixed sleep is a bet. Those now poll through `waitFor(expression, predicate)`,
which turns "wait long enough" into "wait until true, or fail reporting what it
actually was". Three consecutive clean runs since.

**Docs.** `README.md`, `PROJECT_STATE.md`, `UI_HANDOFF.md` and this file updated;
the session and the two framework-level findings are in the root `HANDOFF.md`,
and the Junction ones in `packages/junction/PROJECT_STATE.md` §Open.

---

## Decisions taken

| | |
|---|---|
| **Target** | SPA. An ops dashboard behind auth gains nothing from prerender |
| **Components** | `@frontierjs/ui` — never opened in a browser, so expect to fix it on the way. That is the dogfooding value |
| **The mock** | Reference only, moved out of the Vite root. Not ported |
| **Gates** | No permission UI. `resource.can()` answers permissively while the schema declares no `@@gate` |
| **Auth** | Bearer tokens only. No OAuth; cookies cannot work because Junction reads none |

---

## Order rationale

The order follows the data, not the mock's navigation. Each phase can only be
exercised once the one before it exists: nothing is reachable without a session,
nothing is scoped without a workspace, and the hierarchy has to exist before a
deployment has anything to deploy.
