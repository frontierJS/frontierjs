# Basecamp — UI realm handoff

**Written 2026-08-04 before the UI existed; updated the same day, after it did.**
This is the API contract a session working on `web/` needs. For what the UI
currently *is*, and what building it found, read `UI_PLAN.md`. For the schema
read `../db/README.md`.

> **The UI is built.** Phases 0–6 of `UI_PLAN.md` are done: setup, login,
> workspace switching, Projects → Environments → Apps, deployments with a live
> step timeline, the server fleet, jobs, and an admin zone. `bun run verify`
> drives all of it in a real browser and asserts 90 facts. Read that harness
> (`web/test/verify.mjs`) before changing a screen — it is the fastest
> description of what the UI is supposed to do.

---

## Where things stand

| Realm | State |
|---|---|
| **Data** | Done. 37 models, migration generated from `db/schema.lite`, 49 tests green. |
| **API** | Done. 21 services + 3 engines on Litestone accessors, zero raw SQL, verified over HTTP. |
| **UI** | Built. Sierra SPA over every service; 230 browser checks, 27 of the mock's 41 screens (`SCREENS.md`). |

The mock that used to live in `web/` is at `docs/mock/BasecampUI.jsx` — read it
for information architecture, not for markup.

---

## Start here: run it

```bash
cd packages/basecamp
bun run dev                      # api on :3001  (env.PORT)
```

First run needs a bootstrap — the app has no users until you make one:

```bash
curl -X POST localhost:3001/setup -H 'Content-Type: application/json' -d '{
  "workspace_name": "Acme", "name": "Sam",
  "email": "sam@example.com", "password": "hunter2hunter2"
}'
```

That returns `{ token, user, workspace_id, workspace, account_id }` and is the
only unauthenticated write in the app. `GET /setup/probe` →
`{ workspaces, users, needs_setup }` is what a first-run wizard should poll.

`rm -rf db/basecamp.db* db/audit` resets to first-run.

---

## The API contract

Four things about it will cost you an hour each if you learn them by debugging.

### 1. Nothing is under `/api` — services mount at `/<name>`

```
/workspaces  /projects  /environments  /apps
/servers     /deployments  /jobs  /portal
```

Auth and setup are `/auth/*` and `/setup` — the `/api` prefix they used to
carry was removed 2026-08-04, because it made them the only paths in the app
that had one and disagreed with the browser client's own defaults. Several old
code comments claim `/api/servers`; they are wrong and always 404'd.

The conduit management service is `/conduit-targets`, not `/api/conduit/targets`.

### 2. Every request needs `X-Workspace-Id`

Except `/workspaces` itself, which uses `ctx.id` as the workspace. Without the
header a scoped service returns:

```json
{"name":"BadRequest","message":"workspace_id required — pass X-Workspace-Id header or ?workspace_id= query param"}
```

`GET /auth/workspace` returns the caller's default workspace id — call it
right after login and keep it for the session.

### 3. Custom methods dispatch on a HEADER, not a sub-path

`POST /servers/:id/drain` is a **404**. The call is:

```
POST /servers/:id           X-Service-Method: drain
```

| service | custom methods |
|---|---|
| `servers` | `events` `reboot` `drain` `undrain` `sync` `heartbeat` |
| `environments` | `setVariable` `deleteVariable` |
| `jobs` | `trigger` `cancel` |
| `workspaces` | `members` `addMember` `setMemberRole` `removeMember` |

### 4. Field names are the SCHEMA's, in camelCase

`ipAddress`, not `ip_address`. `appId`, not `service_id`. `environmentId`,
not `environment_id`.

**A wrong key does not error.** `autoValidate` strips unknown fields, so
`{"ip_address": "10.0.1.10"}` creates the server with `ipAddress: null` and
returns 201. If a field mysteriously does not persist, this is why.

`db/schema.lite` is the authoritative field list.

### Custom methods answer with the WHOLE row

Four of them did not, and each broke a caller that did the obvious thing with
the result — `environment = await ...setVariable(...)` lost the environment's
name and rendered `undefined` as a heading, with every data assertion still
passing. The return value is also what the channel publishes, so a projection
without an `id` cannot be matched to the row it describes.

If you add a custom method, return the record.

### The published event is named after the METHOD

A heartbeat arrives as `servers heartbeat`, a drain as `servers drain` — not as
`patched`. Subscribing to `patched` alone hears CRUD and misses every custom
method. The screens subscribe to `'*'` and filter out reads, and that filter is
load-bearing: services publish after `get` too, so a handler that refetched on
any event would refetch in response to its own refetch.

### Auth flow

```
POST /auth/login     {email, password}      → {token, user}
GET  /auth/me        Bearer token           → SessionContext
GET  /auth/workspace Bearer token           → {workspace_id}
POST /auth/logout    Bearer token           → 200
POST /auth/register  {email, password, name}
```

Bearer tokens. `me` and `workspace` are **GET only** — POST 404s.
Everything under a service is 401 without a token; `/health`, `/metrics` and
`/setup/probe` are public.

### Response envelope

Lists come wrapped, single records do not:

```json
{"kind":"list","object":"servers","data":[…]}       // find
{"id":"…","name":"prod-web-01", …}                   // get / create / patch
```

Services that paginate also return `{total, limit, offset, data}`.
Pagination on the wire is `$limit` / `$offset` — the `$` is transport syntax and
never reaches a service.

---

## What to build with

**This is the part most likely to go wrong.** The existing `web/` is React with
inline hex styles. None of that is the stack.

| Use | Not |
|---|---|
| **Sierra** — file-tree routing, Vite build, `createResource` | React, react-router |
| **Mesa** — `.mesa` components, signals | JSX, hooks |
| **`@frontierjs/css`** — semantic classes, a tone + a treatment | inline `style={{}}`, hex colours, **UnoCSS / utility classes** |
| **`@frontierjs/ui`** — 63 prebuilt Mesa components over the css vocabulary | hand-rolling buttons and tables |

Invariant 13 is explicit: `@frontierjs/css` is the styling language, no utility
classes anywhere. `packages/ui` shipped 55 of 63 components in Tailwind-style
classes once and every one of them rendered unstyled. Style with a **tone**
(`danger`) and a **treatment** (`outlined`), never a colour.

Read `packages/sierra/example/` first — it is the working UI-over-Junction
reference and is verified end to end.

### Layout

Invariant 3: `web/` is the Vite root, config in `web/config/vite.config.js`.
Sierra finds the schema at `../db/schema.lite` **because** the UI sits one level
down. Do not flatten that.

---

## The mock: read it, do not port it

`web/BasecampUI.jsx` — 12,557 lines, 93 components, **0 `fetch` calls**,
2,120 inline `style={{…}}` objects, 0 `className`, ~20 hardcoded data arrays.

It is a **design document that happens to compile**. Its value is the
information architecture; its markup and styling are not reusable.

Screens it sketches: `dashboard` `servers` `projects` `deployments` `jobs`
`logs` `network` `secrets` `registry` `flags`, plus a sysadmin zone
(workspaces, users, adapters, audit log, feature flags), a server provisioning
wizard, and a command palette.

Suggested order — follow the data, not the mock's nav:

1. **Login + setup wizard** — the only paths that work with no data.
2. **Workspace switcher** — everything else needs `X-Workspace-Id`.
3. **Projects → Environments → Apps** — the core hierarchy, all three CRUD-complete.
4. **Deployments** — the interesting one: steps stream, engine advances status.
5. **Servers** — richest service (custom methods, JSON columns, agent heartbeat).
6. Jobs, then the sysadmin zone.

---

## Live data

Junction ships channels and the API already publishes to them:
`publishToChannels(workspaceChannel(app))` is an after-hook on every converted
service, and the deployment engine pushes `deployments patched` per step.

Clients join `workspace:<id>` on connect (`core/app.ts` → `channels(...)`).
A deployments view should subscribe rather than poll — the engine emits a step
transition roughly every step, and that is the one screen where it shows.

**Not verified.** The channel wiring exists and the publish calls are in place,
but no client has ever subscribed. Assume it needs debugging, not that it works.

---

## Things that will bite

- **`@frontierjs/ui` has never been opened in a browser.** 63 components compile
  and 25 render cases assert the css vocabulary reaches the DOM. That is not the
  same as looking right.
- **Mesa's scoped styles do not reach into child components.** Use `:global(…)`.
- **`bun install` copies `workspace:*` deps** rather than symlinking in some
  layouts — an edit to Mesa may be invisible until you reinstall. Basecamp's own
  `node_modules/@frontierjs/*` are symlinks today; check before you debug a
  change that "did not take".
- **Headless Chrome delivers almost no rendering lifecycle after load** —
  anything behind `IntersectionObserver` must be set up before it, and
  `requestAnimationFrame` hangs. Pattern:
  `packages/sierra/tests/fixtures/island-site/verify.mjs`.

---

## Open, and deliberately not the UI session's problem

- **Gates.** `db/schema.lite` declares no `@@gate`, which violates Invariant 6.
  Access control is service hooks today. The blocker is a per-workspace
  `getLevel` mapping `WorkspaceMember.role` onto 0–7 — see `../db/README.md`
  §Access control for the intended levels and `example/api/gate.ts` for the
  pattern. **Do not build UI that assumes gate-derived permissions yet**;
  `resource.can()` will answer permissively.
- **Auth.** Deferred by the user to the end. `@frontierjs/auth` is wired and
  works for password login; no OAuth, and `cookieAuth` cannot authenticate
  because Junction reads no cookies. Bearer tokens only.
- **`deployment.engine.ts` uses `type DeploymentRow = any`** pending
  `litestone types` generation.
- **The engines run `asSystem()` wholesale** — correct (no caller to scope to)
  but it means the deployment and job paths bypass row scoping entirely.

---

## Verify, do not trust this document

Everything above was checked by running it on 2026-08-04, but the repo's own
rule applies: `../../../VERIFYING.md`. If a claim here matters to a decision,
re-run it. The API is one `bun run dev` away.
