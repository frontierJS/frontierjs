# Screen inventory — the mock, against what exists

**Written 2026-08-06**, by counting the mock and the tree, not by memory.

`docs/mock/BasecampUI.jsx` is 12,557 lines: **41 `*View` components, 13
modals/wizards** and a shell (sidebar, top bar, command palette, notice bar,
action queue, toasts). `web/src/routes/` is **20 route files**. Until now no
document said which of the 41 exist and which do not — `UI_PLAN.md` recorded one
decision ("the mock: reference only, not ported") and PROJECT_STATE described the
mock only by line count. This file is that missing list.

**What this was built from.** The component list and the data constant each view
reads were extracted from the mock; the models from `db/schema.lite`; the
services from `api/src/services/`. The *content* of each unbuilt view was not
read line by line, so the "needs" column is the shape of the data, not a
specification. Sizes are the mock's own line counts — a rough cost, no more.

---

## The headline

**14 of 41 views exist. 27 do not.** (12 at the first count on 2026-08-06;
Portal and Activity landed the same day — § Phase 2.) And the 27 are not blocked
on UI work:

| Blocked on | Views |
| --- | --- |
| Nothing — models and services existed | 2 ✅ built |
| A **service** over models that already exist | 6 |
| **New models** in `db/schema.lite` | 15 |
| An **outbound adapter** (a real third party) | 6 |

So a rebuild is **mostly Data-realm and API-realm work**. Roughly half the
remaining screens have nothing behind them: the schema has 24 models and none of
them is an API key, a dashboard, a volume, a blueprint, a feature flag or a
backup. Porting the JSX first would produce screens reading hardcoded arrays —
which is exactly what the mock already is.

---

## Built — 14 views, 20 routes

*(Portal and Activity are in § Phase 2; the table below is the original build-out.)*

| Mock view | Lines | Route |
| --- | --- | --- |
| `BasecampView` | 311 | `routes/index.mesa` |
| `ProjectsView` | 46 | `routes/projects/index.mesa` |
| `CreateProjectWizard` | 258 | `routes/projects/create.mesa` |
| `ProjectDetailView` | 137 | `routes/projects/[id]/index.mesa` |
| `DeploymentsView` | 65 | `routes/deployments/index.mesa` |
| `DeploymentDetailView` | 308 | `routes/deployments/[id]/index.mesa` |
| `ServersView` | 358 | `routes/servers/index.mesa` |
| `ProvisionServerView` | 843 | `routes/servers/create.mesa` |
| `ServerDetailView` | 491 | `routes/servers/[id]/index.mesa` |
| `JobsView` | 111 | `routes/jobs/index.mesa` |
| `AuditLogView` | 61 | `routes/admin/audit/index.mesa` |
| `AdaptersView` | 65 | `routes/admin/adapters/index.mesa` |
| `MembersView` (partial) | 230 | inside `routes/admin/index.mesa` |
| `CreateAppModal` | 137 | inside `routes/environments/[id]/index.mesa` |

Three built routes have **no mock counterpart** and were designed here:
`routes/login/`, `routes/setup/` (the mock is always signed in), and
`routes/jobs/[id]/` (the mock shows run history inline).

`routes/environments/[id]/` is likewise ours — the mock folds environments into
`ProjectDetailView` and `AppDetailView`.

---

## Not built — 27 views

### A. Ready to build — the data is already there (2) ✅ both built 2026-08-06

| View | Lines | Backed by |
| --- | --- | --- |
| `PortalView` | 417 | **Built** — `/portal/` + `/portal/[id]/`. Metrics, sparklines and incidents are not backed and were not faked |
| `ActivityFeedView` | 122 | **Built** — `/activity/`, over `AuditEvent`. It was *not* free: the audit hook recorded CRUD only, so no custom action was in the trail at all. See § Phase 2 |

### B. Needs a service — the models exist (6)

| View | Lines | Models present | Missing |
| --- | --- | --- | --- |
| `AlertRulesView` + `AlertRuleModal` | 240 + 122 | `AlertRule`, `AlertEvent` | No `alerts` service, no evaluator. Both models are dead in the API |
| `NetworkingView` | 354 | `Network`, `ServerNetwork`, `AppNetwork` | No `networks` service. Three models, zero API surface |
| `InfraGraphView` | 522 | Server, App, Network, Environment | No graph projection endpoint; it is a derived read across five accessors |
| `SSHKeysView` + `AddKeyModal` | 320 + 104 | `Secret` (`SecretKind.ssh_key`) | No `secrets` service. Note `Secret.data` is `@encrypted` — a list returns rows with **no `data` key at all**, which is the correct shape for this screen |
| `WorkspacesView` (sys) | 62 | `Workspace`, `Account` | A cross-workspace read. `workspaces` service is session-scoped by design |
| `UsersView` (sys) | 68 | `User`, `WorkspaceMember`, `Credential` | **`User` is `@@gate("8")`** — even SYSADMIN(7) cannot read it. Any member list must go through `asSystem()`. This is the screen `FJS-007` will break first |

### C. Needs new models (15)

None of these exists in `db/schema.lite`.

| View | Lines | New model(s) |
| --- | --- | --- |
| `AppDetailView` | **820** | Domain / certificate. `App.domain` is one nullable string; the mock has a domains+SSL tab with per-domain cert status, an nginx template and an upload path (`UploadCertModal`, 370 lines). `AppType` and env vars partly exist — env vars are `Environment.variables` Json, which no screen edits |
| `ApiKeysView` + `CreateApiKeyModal` | 185 + 144 | `ApiKey` + a scope vocabulary. `Secret` is credentials Basecamp presents outward, not tokens it issues |
| `NotificationChannelsView` + `ChannelModal` | 102 + 84 | `NotificationChannel`. `AlertRule.channels` is a Json array pointing at rows that do not exist |
| `DashboardsView` / `DashboardDetailView` / `AddWidgetModal` | 97 + 91 + 141 | `Dashboard`, `DashboardWidget` |
| `WorkspaceFlagsView` + 2 modals | 505 + 152 + 71 | `FeatureFlag`, `FlagOverride` (per environment) |
| `FlagsView` (sys) | 59 | Same models, hub scope |
| `RegistryView` | 112 | `RegistryImage` — or an adapter read, if the registry is the source of truth |
| `VolumesView` | 120 | `Volume` |
| `DiskCleanupView` | 431 | Reclaim candidates — a report, but it acts (deletes), so it needs a job and a record of what was reclaimed |
| `BlueprintMarketplaceView` + `BlueprintDeployModal` | 216 + 147 | `Blueprint` |
| `RecipesView` | 191 | `Recipe`, `RecipeRun`. Runs commands against servers — closest existing thing is `Job` |
| `HubBackupView` | 179 | `Backup` |
| `HubSettingsView` | 115 | Hub-level settings store |
| `SysOverviewView` | 77 | Hub health rollup. Derivable, but from counts nothing currently exposes |
| `OnboardingView` | 427 | Onboarding progress. Derivable from what exists, if it is checks rather than rows |
| `UserSettingsView` | 318 | Mostly `User` + `Session` (both exist) — but preferences, MFA and the API-token half do not |

### D. Needs an outbound adapter (6)

Real third parties. These belong behind `@frontierjs/conduit` as declared
targets, not `fetch()` in a service — `example/api/mailer.ts` is the pattern.

| View | Lines | Adapter |
| --- | --- | --- |
| `CloudflareView` | 220 | Cloudflare zones, DNS, SSL mode |
| `DigitalOceanView` | 258 | DO droplets, volumes, floating IPs, **spend** |
| `GitActivityView` | 304 | Git host — repos, CI status |
| `ObservabilityView` | 24 | A metrics source. The mock reads `LOGS`; nothing here stores or streams metrics |
| Provider half of `ProvisionServerView` | — | Already built as a screen, but provisioning is mocked |
| `RegistryView` | 112 | A container registry (also listed in C — which one depends on whether we mirror or query) |

### E. Shell chrome, not screens (5) ✅ built 2026-08-06 — § Phase 1

Was: present in the mock, absent from `web/src/routes/_module.mesa`:
`CommandPalette` (⌘K, 80 lines), `NoticeBar` (23), `ActionQueue` (62),
`ToastStack` (111), `ConfirmAction` (15).

`@frontierjs/ui` already carries the components for four of these, and
`example/` drives its ⌘K screen in a browser — so this is wiring, not new UI.

---

## What the order should be

The mock's navigation is not the build order — the same rule as `UI_PLAN.md`:
follow the data. Suggested phases, each one shippable:

1. ~~**Shell chrome (E).**~~ ✅ done — § Phase 1.
2. ~~**The two free screens (A).**~~ ✅ done — § Phase 2. The activity feed was
   not free: the audit trail recorded no custom actions at all.
3. **`@@gate` — `FJS-007`. Moved to LAST, decided 2026-08-06.** It would be in
   the way while the app is still being assembled, and this is a long way from
   live. The cost is accepted: screens built before it need revisiting, the
   sysadmin Users screen most of all. Each screen flags it as it lands.
4. **Services over existing models (B).** ← **next** Alerts, networks, secrets. Three sets
   of models are currently dead weight in the schema — this is the highest
   value-per-line work in the app, and it is API-realm.
5. **`AppDetailView` (820 lines).** The single largest gap, and the one a user
   would notice first: apps have no detail screen at all.
6. **New models (C), in dependency order.** Flags and API keys are
   self-contained; dashboards and blueprints are bigger; disk cleanup and
   recipes *act on servers* and want the job queue.
7. **Adapters (D), last.** They need real credentials and cost real money.

**Do not port the JSX.** It is 2,120 inline `style={{}}` objects against a
private hex palette; the palette is already `theme-basecamp` in
`@frontierjs/css` and the components are already `@frontierjs/ui`. The mock is
a spec for *layout and behaviour*, and nothing else.

---

## Phase 1 — shell chrome ✅ done 2026-08-06

The five pieces of chrome the mock has and `web/` did not. **`bun run verify`
is 98 checks, up from 90**; eight of them drive this.

| Mock | Built as |
| --- | --- |
| `CommandPalette` | `@frontierjs/ui`'s, wired in `routes/_module.mesa` |
| `ToastStack` | `<Toaster>`, one per app, first caller is the server transitions |
| `NoticeBar` | `components/NoticeBar.mesa` — the condensed view, in the shell |
| `ActionQueue` | `components/ActionQueue.mesa` — the full view, on the home screen |
| `computeNotices()` | `src/notices.js` |

Three things this settled, all of them convention rather than feature:

- **`src/notices.js` is a leaf module.** No imports, no client, no resource: it
  takes rows and `now` and returns notices. So it runs in plain node, the shell
  and the home screen cannot disagree about what needs attention, and the
  thresholds are readable in one place. Same reason `field-rules.js` is written
  that way.
- **The shell subscribes; it does not poll.** A resource store is a module
  singleton fed by the WebSocket, so the shell loads servers/deployments/jobs
  once per *workspace* and a server reporting pressure reaches the notice bar
  with nothing asking again. The home screen's queue subscribes to the same
  stores and issues no request of its own. The verify check that pins this
  drives an agent heartbeat and asserts the notice appears **with no reload**.
- **The whole shell is `@frontierjs/ui`.** It was raw `.badge` / `.pill` /
  `.btn` / `.field` classes; the vocabulary is the same, but the components are
  where the accessible name, the tone mapping and the form seam already live.

### Gaps found while building it

1. **`@frontierjs/ui` was not aliased in `web/config/vite.config.js`.** The
   example aliases it to the workspace source and excludes it from
   `optimizeDeps`; basecamp did neither and worked only because of a hand-made
   symlink under `node_modules` that a reinstall would remove. Fixed.
2. **A Mesa defect — `prop=""` compiled to `prop={true}`.** `<Select
   placeholder="">` is how the kit documents "suppress the placeholder"; it
   rendered an `<option>` whose visible text was the word `true`, which showed
   up as a third workspace in the switcher. Fixed in mesa, 2 tests,
   [`FJS-102`](../../../ISSUES.md) closed.
3. **`Server.health` has no declared shape.** It is `Json?` in the schema and
   `Record<string, unknown>` in `HeartbeatData`. The pressure rules read
   `health.cpu` and `health.memory` because that is what `verify.mjs` posts and
   what `servers/[id]` renders — a de-facto contract that both types would let
   an agent break silently by sending `mem`. `db/seed.js` writes no health at
   all, so a seeded fleet raises no pressure notices.
4. **Four of the mock's notice categories have no data**: certificates (no
   Domain model), alerts (`AlertRule`/`AlertEvent` have no service), disk
   cleanup (no model), and app-level notices. Listed at the foot of
   `src/notices.js` so the next person does not re-derive them.
5. **The mock's sidebar is not the shell's nav.** The mock has 33 nav entries in
   five groups (Daily / Weekly / Manage / Providers / System); the shell links
   the six routes that exist. That gap closes as the screens do, not before —
   a link to a route that does not exist is worse than no link.

## Phase 2 — the two screens whose data already existed ✅ done 2026-08-06

**`bun run verify` is 110 checks, up from 98.** Gating (`FJS-007`) is
deliberately deferred to *after* all screens — it would be in the way while the
app is still being built, and this is a long way from live. Every screen that
will need revisiting when it lands is flagged below.

### `/portal/` + `/portal/[id]/` — the appliances, measured

The portal service was mounted, and `web/src/resources/portal.mesa` was consumed
by exactly one route. It now has its own screen, and the split with
`/admin/adapters/` is the service's own: **`find()` declares (wired or stub, no
ping), `get(id)` measures (a live ping through the adapter)**. Adapters answers
"is this wired"; Portal answers "does it answer right now". The detail route
pings on open, so what is on screen was true a moment ago.

### `/activity/` — the trail as a narrative

Same rows as `/admin/audit/`, a different question: actor ids resolved to names,
subjects linked to their own screens, and a kind filter built from what actually
happened rather than a declared list. The mock carries both for the same reason
(`ActivityFeedView` vs `AuditLogView`). **When gating lands this screen changes**
— it reads the trail, which is admin/owner, and it already renders the refusal
rather than an empty table.

### The gap that had to be closed first

**The application audit trail recorded CRUD only.** `basecampAuditLog` ran on
`create` / `patch` / `remove`, so a server being **drained** — the operator verb,
and most of what anyone actually does here — was recorded nowhere. Deploy,
cancel, trigger and every other custom action, likewise. The trail read as
complete and was not, which is worse than not having one.

It now runs as `after: { all }` and decides what counts the same way Junction
decides what to announce on a channel: everything except `find`/`get`, and a
read-shaped action opts out with `ctx.dispatch = false`. Two things fell out:

- **`servers.heartbeat` is excluded by name.** An agent checks in on a timer, so
  a fleet of fifty would write six figures of rows a day and bury every human
  action. Deliberately *not* `dispatch = false` — that would also silence the
  channel, and the live status pill is fed by exactly that publish.
- **The result shape differs.** CRUD answers the envelope (`.data`), a custom
  action answers the row. Reading only the first filed every action against
  `subjectId: 'unknown'` — a trail entry that cannot be joined to its subject.

Also: an actor-less write is now `actorType: 'system'`, not the `'user'` default.
The engine, a job and an agent are not anonymous people.

### Gaps found, not closed

1. **`AuditEvent` has no `metadata`.** The trail records *that* a server was
   drained, never *from what to what*. `diff Json?` exists and nothing writes it.
2. **No workspace-wide `ServerEvent` read.** Server events are reachable only
   through `servers.events` per server, so the feed cannot include them without
   N requests. The mock's activity feed is full of them.
3. **Actor names cost a second request.** `AuditEvent.actorId` is an id, and
   resolving it means `workspaces.members`. Fine for one workspace; it is the
   shape that will not survive a hub-wide feed.
4. **Portal has no metrics, sparklines or incidents.** The mock's `PortalView`
   has all three; the service answers status/url/adapter/configured. Metrics
   need an observability adapter (`docs/SCREENS.md` § D).

## Related

- `docs/UI_PLAN.md` — how the built 17 got built, and what each phase found
- `docs/UI_HANDOFF.md` — the API contract the screens are written against
- `docs/VISION.md` — what Basecamp is meant to be
- `../../ISSUES.md` — `FJS-007` (no `@@gate`), `FJS-031`, `FJS-032`, `FJS-085`
