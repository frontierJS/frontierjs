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

**41 of 41 views exist.** (6 at the last count; § Phase 14 built those on
2026-08-30 — the graph, the setup checks, DNS, cloud spend, git activity and
observability. Four of the six are a screen with a skeleton where a third
party's numbers would be, which is a different thing from unbuilt: the reason is
on the page, and two of them read it off the adapter's own ping.)

Before that: (12 at the first count on 2026-08-06;
Portal and Activity landed the same day — § Phase 2 — then Networking, Alerts
and Secrets — § Phase 3 — then AppDetail — § Phase 4 — then Channels and Flags
— § Phase 5 — then API keys — § Phase 6 — then Volumes — § Phase 7 — then
Dashboards — § Phase 8 — then Recipes and Disk cleanup — § Phase 9 — then the
four sysadmin screens — § Phase 10, then five more in § Phase 13.)

| Blocked on | Views |
| --- | --- |
| Nothing — models and services existed | 2 ✅ built |
| A **service** over models that already exist | 6 ✅ built |
| **New models** in `db/schema.lite` | 16 ✅ built |
| An **outbound adapter** (a real third party) | 6 ✅ **screen built, adapter not wired** |

**What "built" means for the last row.** The screen exists, it says what is not
connected and why, and where a vendor's numbers would go there is a skeleton
rather than a number. Two of them report the adapter's live state off
`/portal/`'s own ping, so the word on the page changes the day one is wired.
What is still owed is adapters — four conduit targets, and a widened `IGit` and
`IObservability` — and that is API work with no screen in it.

**Phases 11–13 took the whole model-blocked group** — six models, five services,
seed rows and five screens, in that order. **Phase 14 took the six that were
left**: one derived read (`InfraGraphView`), one screen with no model by
decision (`OnboardingView`) and four that need a real third party.
`RegistryView` moved out of the adapter row earlier: it is built against a
MIRROR, which is a decision Phase 12 records.

Eleven distinct views, not twelve: `RegistryView` is in both of the last two
rows, because whether it needs a model or an adapter depends on whether we
mirror a registry or query it. Recounted 2026-08-25 by parsing the mock for
top-level `*View` declarations and checking each unbuilt one against
`web/src/routes/` — none of the eleven has a route. The counts above had drifted
by one view and by one table row.

**No screen is blocked on an API any more.** Phase 10 built the last group whose
blocker was a service; the one row left under *needs a service* is
`InfraGraphView`, which is a derived read across five accessors rather than a
missing endpoint. Everything else needs a model or a real third party.

**And as of 2026-08-25 no screen is blocked on a MODEL either.** Six went into
`db/schema.lite` in one pass — `Blueprint`, `BlueprintParam`, `RegistryImage`,
`Backup`, `HubConfig` and `NotificationPreference` — and the seventh case was
decided the other way: `OnboardingView` gets no model, because every step it
shows is a question the database already answers and a stored `done` is a second
answer that goes stale. So the five model-blocked views now need a service and a
screen, the four adapter views need a real third party, and `InfraGraphView`
needs a derived read. See § Phase 11.

So a rebuild is **mostly Data-realm and API-realm work**. Roughly half the
remaining screens have nothing behind them: when this was written the schema
had 24 models and none of them was an API key, a dashboard, a volume, a
blueprint, a feature flag or a backup. All but two now exist; a blueprint and a
backup still do not. Porting the JSX first would produce
screens reading hardcoded arrays — which is exactly what the mock already is.

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
| `MembersView` | 230 | inside `routes/admin/index.mesa` — members, plus invite / pending / resend / revoke since `FJS-032` |
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

### B. Needs a service — the models exist (6) — **3 built 2026-08-06**

`alerts`, `networks` and `secrets` now exist (§ Phase 3), so `AlertRule`,
`AlertEvent`, `Network`, `ServerNetwork`, `AppNetwork` and `Secret` all have an
API. The three left are the cross-workspace and derived reads.

| View | Lines | Models present | Missing |
| --- | --- | --- | --- |
| `AlertRulesView` + `AlertRuleModal` | 240 + 122 | `AlertRule`, `AlertEvent` | **Built** — `/alerts/`. Still **no evaluator**: nothing measures a threshold, and the screen says so rather than implying otherwise |
| `NetworkingView` | 354 | `Network`, `ServerNetwork`, `AppNetwork` | **Built** — `/networks/`, including attach/detach over the join table |
| `InfraGraphView` | 522 | Server, App, Network, Environment | **Built** — `/infra-graph/`, over a new `infra` service. Four node kinds and four edge kinds, each one a row; the layout is derived in the browser because a position is not a fact about the fleet. See § Phase 14 |
| `SSHKeysView` + `AddKeyModal` | 320 + 104 | `Secret` (`SecretKind.ssh_key`) | **Built** — `/secrets/`, widened past SSH keys to what the model is. `Secret.data` is `@encrypted`, so a read has **no `data` key at all** — proved in the browser and against the database file |
| `WorkspacesView` (sys) | 62 | `Workspace`, `Account` | **Built** — `/hub/workspaces/`. A cross-workspace read through a NEW service that takes no workspace at all: the alternative was `?scope=hub` on nineteen session-scoped services. Suspension is real and bites in `scopeToWorkspace`. See § Phase 10 |
| `UsersView` (sys) | 68 | `User`, `WorkspaceMember`, `Credential` | **Built** — `/hub/users/`, written against `asSystem()` from the start because `User` was `@@gate("8")` then; it reads at USER(4) since `FJS-170` and the screen still goes through `asSystem()`, which is what keeps the hub a hub. Suspend/restore, grant/revoke the hub tier, and bot accounts — all three are `asSystem()` writes, because `isSystemAdmin`, `status` and `kind` are `@allow('write', auth().isSystemAdmin)` at the Data boundary. The mock's Invite button is deliberately absent here — inviting a HUMAN belongs to a workspace and lives on the Members screen (`FJS-032`, closed); Impersonate is `FJS-142`. See § Phase 10 |

### C. Needs new models (16)

None of these exists in `db/schema.lite`.

| View | Lines | New model(s) |
| --- | --- | --- |
| `AppDetailView` | **820** | **Built** — `/apps/[id]/`, four of the mock's seven tabs, with a `Domain` model replacing `App.domain`. The three left out (logs, build, advanced) are named in the screen itself rather than rendered empty. See § Phase 4 |
| `ApiKeysView` + `CreateApiKeyModal` | 185 + 144 | **Built** — `/api-keys/`, over `ApiKey`. The token lives only as an HMAC in an auth `Credential`, so the mock's `reveal` cannot be built; the scope vocabulary is derived from the service registry rather than declared. See § Phase 6 |
| `NotificationChannelsView` + `ChannelModal` | 102 + 84 | **Built** — `/channels/`, over `NotificationChannel` + an `AlertRuleChannel` join. `AlertRule.channels` was a Json array pointing at rows no model declared; the credential lives in a `Secret` and `test` really sends, through conduit. See § Phase 5 |
| `DashboardsView` / `DashboardDetailView` / `AddWidgetModal` | 97 + 91 + 141 | **Built** — `/dashboards/` + `/dashboards/[id]/`, over `Dashboard` + `DashboardWidget`. A widget names a KIND from a declared vocabulary and never carries a query; every card reads through the service that owns its data, with the reader's own session. See § Phase 8 |
| `WorkspaceFlagsView` + 2 modals | 505 + 152 + 71 | **Built** — `/flags/`, over `FeatureFlag` + `FlagOverride`. The mock keyed per-environment state by TIER NAME; an override points at a real `Environment` row. See § Phase 5 |
| `FlagsView` (sys) | 59 | **Built** — `/hub/flags/`, the same models read across every tenant and grouped by the prefix convention in the key. Toggling changes the flag's own default, never an override — a hub screen has no environment in hand. See § Phase 10 |
| `RegistryView` | 112 | **Model built 2026-08-25** — `RegistryImage`, one row per TAG, OBSERVED like `Volume`. That commits to MIRRORING a registry rather than querying it live, which is what makes `inUse` answerable at all: it is a join against this workspace's deployments and a registry API knows nothing about who deployed what. `observedAt` is what keeps the staleness visible. No `RegistryRepo` — a repository is `distinct(repository)` plus a `SUM`, and a stored total is a second answer. Needs a service and a sync |
| `VolumesView` | 120 | **Built** — `/volumes/`, over `Volume`. The first OBSERVED model here: no `create`, a row appears because an outpost reported it, and deleting one asks that outpost to delete the disk before the record is forgotten. See § Phase 7 |
| `DiskCleanupView` | 431 | **Built** — `/cleanup/`, over `DiskUsage` (observed, one row per server) + `CleanupRun` (what a sweep actually freed). A sweep names targets from a list the service owns and never carries a command. See § Phase 9 |
| `BlueprintMarketplaceView` + `BlueprintDeployModal` | 216 + 147 | **Models built 2026-08-25** — `Blueprint` + `BlueprintParam`. Hub-curated, so `@@tenant(none)` and no workspace column: every entry in the mock is third-party software, and a per-workspace copy of the same nine rows is not a marketplace. Params are a CHILD model, not a Json array, because the deploy form is generated from them and they are ordered. Needs a service and the two screens |
| `RecipesView` | 191 | **Built** — `/recipes/`, over `Recipe` + `RecipeRun`. Arbitrary code on a machine, so authoring is admin and every run keeps the script it ran, one row per server. See § Phase 9 |
| `HubBackupView` | 179 | **Model built 2026-08-25** — `Backup`, `@@tenant(none)`, reusing `RunStatus` rather than restating five words. Outcome columns are SYSTEM-write, like every other *Run here. The schedule lives on `HubConfig`, not here: a cron describes the schedule and a `Backup` row is one thing that already happened. Needs a service, a job and the screen |
| `HubSettingsView` | 115 | **Model built 2026-08-25** — `HubConfig`, ONE row keyed by a constant, typed columns rather than key/value (a key/value table is a schema this seed does not describe). The mock's four CREDENTIALS are deliberately absent: they are read at boot before any database, rotating one is a deploy, and `Secret` already models credential material. Needs a service and the screen |
| `SysOverviewView` | 77 | **Built** — `/hub/`, read at request time from the thing that owns each number (Caravan, Conduit, the channel manager, SQLite). One of the mock's tiles does not survive contact with the runtime and says so instead: CPU, which nothing here samples. The event-subscriber count was the other until the bus grew `stats()` (`FJS-143`). See § Phase 10 |
| `OnboardingView` | 427 | **Built** — `/onboarding/`, over `infra.onboarding`. **No model, decided 2026-08-25.** Every one of the mock's six steps is a question the database already answers — does this workspace have a server, an SSH-kind `Secret`, a project, a `Deployment`, a second `WorkspaceMember`. A `done` column would be a second answer that goes stale the moment somebody deletes the thing it recorded. Needs a service method returning the six checks |
| `UserSettingsView` | 318 | **Preferences built 2026-08-25** — `NotificationPreference`, one row per (person, kind) with a column per transport, `@@tenant(none)` and `@@allow('all', userId == auth().id)`. Profile is `User` (`username`, `displayName`, `avatarUrl` all exist), sessions are auth's `Session`, password is `account.changePassword`. **MFA is still nothing** and is `@frontierjs/auth`'s to model, not this app's. Needs a service and the screen |

### D. Needs an outbound adapter (6) — **screens built 2026-08-30, § Phase 14**

Real third parties. These belong behind `@frontierjs/conduit` as declared
targets, not `fetch()` in a service — `example/api/src/providers/mail/mailer.ts` is the pattern.

Four of them now have a screen that says what is not connected, with a skeleton
where the vendor's numbers go. Two are named for the job rather than the vendor,
because whichever provider gains an adapter first is the one that fills them.

| View | Lines | Adapter | Screen |
| --- | --- | --- | --- |
| `CloudflareView` | 220 | Cloudflare zones, DNS, SSL mode | **Built** — `/dns/`. The real half is this app's own `Domain` rows: hostname, primary, certificate status, proxied. The zone's records and its analytics are the skeleton |
| `DigitalOceanView` | 258 | DO droplets, volumes, floating IPs, **spend** | **Built** — `/cloud-spend/`. The real half is the inventory a bill is computed from — machines by provider and region, planned vCPU and RAM, attached disk. There is no DigitalOcean in `providers/index.ts` and no price column anywhere, so the money is the skeleton |
| `GitActivityView` | 304 | Git host — repos, CI status | **Built** — `/git-activity/`, reporting the adapter's own state off `/portal/`. `IGit.listRepos()` answers a name and a clone URL, so even a wired adapter could not fill the table — widening the interface is the work |
| `ObservabilityView` | 24 | A metrics source. The mock reads `LOGS`; nothing here stores or streams metrics | **Built** — `/observability/`, the same portal read. `IObservability` declares `queryLogs` and `queryMetrics` and no service exposes either, deliberately: a read here needs a window, a service and a level, which is a service to design rather than a pass-through to ship |
| Provider half of `ProvisionServerView` | — | Already built as a screen, but provisioning is mocked | — |
| `RegistryView` | 112 | A container registry (also listed in C — which one depends on whether we mirror or query) | **Built** — § Phase 13, against the mirror |

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
3. ~~**`@@gate` — `FJS-007`. Moved to LAST, decided 2026-08-06.**~~ ✅ done
   2026-08-10, after every screen, as decided. The cost of deferring turned out
   to be nothing: the sysadmin Users screen everyone expected to break was
   already written through `asSystem()`, because `User` gates at 8.
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
a spec for *layout and behavior*, and nothing else.

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
  drives an outpost heartbeat and asserts the notice appears **with no reload**.
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
   an outpost break silently by sending `mem`. `db/seed.js` writes no health at
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

The portal service was mounted, and `web/src/resources/Portal.mesa` was consumed
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

- **`servers.heartbeat` is excluded by name.** An outpost checks in on a timer, so
  a fleet of fifty would write six figures of rows a day and bury every human
  action. Deliberately *not* `dispatch = false` — that would also silence the
  channel, and the live status pill is fed by exactly that publish.
- **The result shape differs.** CRUD answers the envelope (`.data`), a custom
  action answers the row. Reading only the first filed every action against
  `subjectId: 'unknown'` — a trail entry that cannot be joined to its subject.

Also: an actor-less write is now `actorType: 'system'`, not the `'user'` default.
The engine, a job and an outpost are not anonymous people.

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

## Phase 3 — services over the models that had none ✅ done 2026-08-06

**`bun run verify` is 125 checks, up from 110**, green twice consecutively.
Three sets of models had sat in `db/schema.lite` with **no API surface at all**;
they now have services, and three mock screens sit on them.

| Service | Models it woke up | Custom methods |
| --- | --- | --- |
| `alerts` | `AlertRule`, `AlertEvent` | `events` · `acknowledge` · `resolve` |
| `networks` | `Network`, `ServerNetwork`, `AppNetwork` | `members` · `attach` · `detach` |
| `secrets` | `Secret` | `verify` |

Screens: `/networks/`, `/alerts/`, `/secrets/`. All three were probed over HTTP
before a line of UI was written — create, the validation refusals, the join, and
the conflict on deleting a populated network.

What the three decided, each written at its call site:

- **A join table is the point of the networks service.** `members` returns the
  join rows with their servers included, so the screen does not fan out one
  request per server; `attach`/`detach` return the NETWORK, not the join row,
  because a client assigning a method's result over the record it renders needs
  that record back (junction `FJS-020`).
- **Deleting a populated network is refused, not cascaded.** The schema would
  cascade; detaching a live server is an operational act, and doing it as a side
  effect of a delete is how a fleet loses routing with nobody deciding to.
- **The alerts service is not an evaluator.** Nothing measures a threshold —
  that belongs with whatever does the measuring, and a rule firing from the
  browser's view of the fleet would be theater. The screen says so in a Callout
  rather than showing an empty history that reads as broken.
- **Acknowledging is not resolving.** Two methods, two roles: authoring a rule
  is admin, acknowledging a firing is anyone carrying the pager.
- **The secrets service contains no redaction code.** `Secret.data` is
  `@encrypted`, so Litestone omits the key at the Data boundary. A service that
  redacted by hand would be a second owner of that rule.

### The gap this phase found

**A vocabulary owned in two places, disagreeing.** `AlertRule.severity` was
`String @default("medium")` in the schema, and the service's own list was
`info | warning | critical` — so **the schema's own default was a value the API
refused**. Nothing had ever exercised it because nothing could reach the model.

Fixed by making the schema the seed it is meant to be: `enum AlertSeverity {
info warning critical }`, `@default(warning)`, migration regenerated. The
service's hand-written check is **deleted** — the column carries a CHECK,
`autoValidate` refuses a bad value before the method runs, and the UI's `<Select>`
builds its options from `alerts.fields.severity.enum`. One declaration, three
consumers. The verify check leaves severity untouched on purpose, so the default
has to arrive from the schema for it to pass.

### And one still open

**`FJS-110` — a kit `<Button disabled={…}>` stopped following its prop** while a
plain `<button>` with the identical expression kept following it. Same block,
same tick, proved side by side in a browser, with a `<span>` next to both showing
the value HAD updated. **Seven isolation probes in mesa's own harness all pass**
— stand-in child, the real `Button.mesa`, inside `{#each}`+`{#if}`, object
each-items with `n.id`, the compound `||`, two component instances, and a
`{...$attributes}` spread after the attribute — so the trigger involves the real
`<Select>` and is not yet named. Worked around by dropping the pick from
`disabled` and refusing an empty pick in the handler, with the reason at the
call site.

## Phase 4 — the App gets a screen ✅ done 2026-08-06

The largest single gap in this file: an App could be created from an
Environment and then never looked at again. `/apps/[id]/` is 4 of the mock's 7
tabs — overview, domains & SSL, config, releases — and the three it leaves out
are named in a comment at the foot of the screen rather than rendered as empty
boxes, because a tab that always says "no data" reads as broken.

**One request feeds the page.** `apps.get` answers the app with its
environment, its domains, where its replicas landed, its last ten releases and
its jobs. The screen asks one question — *what is this app doing* — so it makes
one call rather than five.

### `App.domain` became a model

One nullable string could describe exactly one hostname, with no certificate,
no redirect and no primary — and an apex plus a www is the ordinary case. It is
now `model Domain`, with a `domains` service (`uploadCert` · `makePrimary`).

Two things are deliberately **not** columns on it:

- **The certificate material.** `uploadCert` writes the PEM pair into a
  `Secret` of kind `tls_cert` and keeps only `certSecretId` on the domain.
  `Secret.data` is `@encrypted`, so the private key is written once and never
  read back — absent from the response, absent from the database file. A
  `keyPem` column here would have undone that at the only boundary where it is
  enforceable. Proved both ways: 0 occurrences in the API's answer, 0 in
  `strings db/basecamp.db`.
- **`certStatus`.** Derived from `certExpiresAt` on read, by one exported
  function. A stored status and a stored expiry are two owners of one fact, and
  the stored one is the one that goes stale overnight — a certificate does not
  expire when somebody remembers to run an update.

Service judgements, each written at its call site: the first hostname an app
gets **is** its primary; promoting one demotes the others in the same write;
deleting the primary while siblings exist is **refused**, because which
hostname is primary is a routing decision and making it by deletion is how an
app ends up answering on one nobody chose.

### What it found

**`<Textarea>` silently ignored `oninput`** while `<Input>` and `<Select>` both
honored it — an undeclared prop is just ignored, so the two PEM fields stayed
empty and the service answered `certPem and keyPem are both required` with
nothing on either side explaining why. Fixed in the kit (`FJS-116`).

**A derived field needs its owner imported, not re-derived.** `apps.get`
includes `domains`, and an include returns raw rows — so the first version of
the screen received every hostname with no `cert_status` at all and rendered
each one as "no certificate", including an expired one. `apps.service.ts` now
imports `certStatusOf` from the domains service rather than computing it again.

### Still open

**`AppDetailView`'s other three tabs are data gaps, not UI gaps.** Logs and
log-analysis need an observability adapter; build output and history need a
build record (`Deployment` carries `builtImage` and no log, so a "build
history" tab would be the releases table under another name); advanced —
restart policy, health check, the nginx template — would be `App.config` keys,
and inventing the key names in a screen would make that screen their only
definition.

## Phase 5 — where an alert goes, and what is behind a flag ✅ done 2026-08-08

Two screens from the "needs new models" pile, chosen because each one closed a
hole in something already built rather than opening a new area.

### `/channels/` — the rows `AlertRule.channels` was already pointing at

`AlertRule.channels` was `Json @default("[]")`, an array of ids for rows **no
model declared**. A foreign key with no constraint and no reader: nothing could
tell a live channel id from a typo, and there was no channel to point at in the
first place. It is now `NotificationChannel` plus an `AlertRuleChannel` join,
and attaching is `alerts.attachChannel`. Three data tests pin what the Json
array could not answer — is the id real, does the pair stay unique, does the
link go when the channel does.

Two things are deliberately not columns on the new model:

- **The credential.** A Slack webhook URL and a PagerDuty integration key are
  bearer credentials — anyone holding one can post as the workspace — so
  `create` lifts the material into a `Secret` (`@encrypted`, written once,
  never read back) and the row keeps only the reference. Same ruling as
  Domain's certificate material. What stays in `config` is routing: the channel
  override, the recipient list, the HTTP method. Nothing in it is sensitive,
  which is why the whole column comes back on a read.
- **How many alerts went out today.** The mock shows a per-channel count. A
  counter here would be a second owner of a fact belonging to deliveries that
  do not exist yet. `lastTestAt` and `lastDeliveryAt` are stamps of things that
  actually happened.

**`test` really sends.** It registers the channel as a conduit target and posts
through `app.conduit` — the outbound boundary, not `fetch()` in a service —
with the credential resolved from its Secret at send time by a resolver in
`core/credentials.ts` (conduit's default reads `process.env`, which cannot see
a credential a person typed into a form five seconds ago). Proved against a
local sink: the request arrived, carrying the resolved token as a header, and
the token is absent from the database file, from conduit's registry and from
the API's answer. Email is the one kind that cannot be tested — it needs a
mailer this app has not configured — and it says so rather than pretending.

### `/flags/` — a default, and a real environment overriding it

The mock kept per-environment state in a map keyed by TIER NAME:
`production`, `staging`, `development`. That vocabulary already exists here as
`model Environment`, one row per environment per project — so the string would
have meant every project in the workspace sharing one "production" belonging to
none of them, and no way to say "on in THIS project's staging". `FlagOverride`
points at the real row; the flag carries the default and nothing else about
rollout.

`resolveIn()` is the one definition of what a flag is set to in an environment —
the override if there is one, the flag's own default if not — and it is
exported, so `resolve` (the read an SDK makes) and the screen cannot disagree.
An override wins outright rather than merging field by field: a half-inherited
rollout is a number nobody chose.

Two things it refuses that the schema cannot: variant weights that do not add
to 100, and pinning a variant a flag does not declare. Both are rules ABOUT a
Json column's contents, which SQLite has no way to express.

### What it found

**Five defects, four of them in the framework.**

- **Litestone emitted a JSON Schema `default` of the wrong type** (`FJS-120`).
  `tags String[] @default("[]")` reached the boundary as
  `{"type":"array","default":"[]"}` — a schema whose own default fails its own
  type check. `autoValidate` filled it in and then refused it, so every create
  that OMITTED `tags` 400'd naming a field the caller never sent, while sending
  `tags: []` explicitly worked. The opposite of what a default is for.
- **Raw SQL could not write** (`FJS-118`). Found hard-deleting a row to prove
  the FK cascade fires — the one thing `.remove()` cannot do on a `@@softDelete`
  model. `db.asSystem().sql` is the documented and only escape hatch, and every
  raw write through it had always failed on the readonly connection.
- **Conduit refused a non-JSON response** (`FJS-121`), so a Slack webhook —
  which answers `200 text/plain: ok` — could never succeed. The test delivery
  arrived at the sink and was reported as a `server_error`.
- **A collection-level action was unreachable from the browser** (`FJS-122`).
  Both `servers.feed` and `flags.resolve` are about a whole service and have no
  subject row; the client interpolated the id unconditionally, so the only way
  to reach one was `/{service}/null`.
- **`autoValidate` strips a wire-only field before the method body sees it.**
  Not a defect — it is the documented behavior — but it is silent, and the
  channels service reported "Slack needs a credential" about a request carrying
  exactly that. A field that is not a column has to be captured in a BEFORE
  hook, which is the only place it still exists. Same shape as `ip_address`
  coming back null on the servers service.

And one in the kit: **the toasts are fire-and-forget** (`FJS-119`). Calling the
mock's `toasts.loading(…).update(…)` threw from a click handler, outside the
try, so a failed delivery reported *nothing* — caught by `verify` asserting the
error text, not by any render test, because SSR dispatches no events.

### Still open

**Nothing evaluates a rule and nothing delivers to a channel** (`FJS-123`).
Both halves are real and proven; the thing between them is not. No evaluator
reads a metric, compares it to a rule and writes an `AlertEvent`, and nothing
fans a fired event out to the rule's channels. That needs a metric source,
which is an observability adapter (category D) — and a rule that fires from the
browser's idea of the truth is theater.

**A flag's rollout percentage is stored and never applied** (`FJS-124`). The
bucketing decision has to happen where the user is, per request; computing it
server-side would produce a number an SDK could not reproduce. Today a 10%
rollout behaves as on-or-off.

## Phase 6 — the token this app issues ✅ done 2026-08-09

One screen, `ApiKeysView` + `CreateApiKeyModal`, chosen because it is the last
self-contained item in the "needs new models" pile — no join to an existing
model, no adapter, no metric source.

### `/api-keys/` — the third direction

The two credential models did not cover it between them. A `Credential` is how
a person proves identity **to** Basecamp; a `Secret` is how Basecamp proves
identity **to** a provider; an `ApiKey` is a token Basecamp **issues**. Same
noun in three places, three different directions, and only the third one had no
model.

**The token is nowhere in this app.** `@frontierjs/auth` mints it and holds an
HMAC; `ApiKey` holds the operational half — workspace, owner, scopes, usage,
revocation — plus a hint (`fjs_AbCd…wXyZ`). It is shown once, in the response
to the call that minted it, and a reload loses it.

So **the mock's `reveal` button is not a feature that was skipped.** Building it
would mean storing the token, which is the one thing an API key exists not to
do. A data test asserts against the generated DDL that no column could hold
one, because a `token` column added later would make the promise quietly false
and nothing else here would notice.

**A scope is `<service>:<read|write>`, and the resource half IS the service
name.** No mapping table beside the registry: the vocabulary is derived from
`app.services.list()` at call time, so a service added tomorrow is grantable
tomorrow, and a checkbox cannot offer a scope the guard does not recognize. The
screen fetches it through a collection-level `scopes` action rather than
shipping a copy — which needed `FJS-122`, since there is no subject row.

Two services are off limits to a key entirely: `api-keys` itself, because a key
that can mint keys escalates past its own scopes, and conduit's management
service, which is operational rather than a workspace resource.

**Revoked is a state, not a deletion.** Revoking deletes the credential, so the
token stops working on the next request, and keeps the row so an operator can
still see what was taken away and when. `ApiKey` declares no `@@softDelete`:
revoked and deleted are two states, and a hidden third would make four.

### What it found — three defects, all in @frontierjs/auth

All three were invisible from inside this app and all three failed towards
looking correct. The API-key half of `IAuth` was implemented, unit-tested, and
had never been used end to end.

| | |
| --- | --- |
| `FJS-134` | **An issued key authenticated nothing.** Junction's transport resolves a Bearer token through `verifySession()` and calls `verifyApiKey` nowhere; the native provider never fell through. Every key this screen minted would have been anonymous, and the failure reads as a bad token |
| `FJS-135` | **A key's scopes were dropped on verification.** Stored on the credential, but the session was built from the USER row, so every key carried its owner's full standing. The scope picker would have been decoration |
| `FJS-136` | **`revokeApiKey` revoked nothing here.** It coerced `Number(keyId)`, because auth's own fragment declares `Credential.id Int`; this schema uses uuids, so `NaN` matched no row and threw nothing. Revoke reported success and the key kept working |

A fourth is not a defect in one package but a gap in the seam (`FJS-095`).
`createResource` validates by default, and `ApiKey`'s create schema is
`required: ["workspaceId", "userId", "name", "tokenHint"]` — three of which
only the server can fill. So every create was refused **in the browser**,
naming fields the caller was never meant to send, and the symptom was the
documented one: the button does nothing. The escape today is
`{ validate: false }`, which turns a whole resource off to describe three
columns. Nothing in the schema can say *the system writes this*, which is
`FJS-D22`.

### Still open

**There are no bot accounts.** The mock's security notice tells you to use a
dedicated `bot` user for CI, and this app has no way to create one — `User`
carries a `UserKind` and there is no user-management screen. So a key belongs
to whoever made it and carries their access, which the screen says out loud
rather than implying otherwise. It needs the sysadmin `UsersView` — built in
Phase 10, which closed this.

## Phase 7 — the first thing here that is observed ✅ done 2026-08-10

One screen, `VolumesView`, and a model that had already landed with nothing on
top of it. Chosen because it is the last item in the new-models pile that needs
neither an adapter nor a metric source.

### `/volumes/` — a picture, not a record

Every other model in this app is something a person created and Basecamp then
acts on. A volume is the other direction: Docker made it, an outpost found it,
and the table is Basecamp's picture of what is out there. That one difference
decides the whole shape:

- **No `create`.** A row appears because a machine reported it. The outpost's
  method is `report`, addressing the collection, carrying `server_id` and the
  server's whole set — so a volume missing from a report is a volume that no
  longer exists. It is exempted from `sessionScope` **by name**, the way
  `servers.heartbeat` is, and excluded from the audit trail by name for the
  same reason: an outpost on a timer buries every action a person took.
- **Absence is declared, not implied.** `model:` brings Junction's Litestone
  base, which answers every CRUD verb the service leaves out — `POST /volumes`
  wrote a row until `methods: [...]` said which six exist.
- **Deleting a row is not deleting a volume.** `remove` and `prune` go through
  `app.conduit` to the `outpost:<id>` target a heartbeat registers, and forget the
  row only once the machine confirms. `prune` forgets exactly the names the
  outpost returns, never the ones it was asked about — an outpost that could delete
  three of five leaves the fourth on disk, and forgetting it makes it invisible.
- **Two refusals, both in words.** A mounted volume names the containers holding
  it; a server with no registered outpost keeps its row and says so.
- **No `workspaceId`.** A volume is meaningless without its server, so the scope
  is the join — the same two indexed queries `servers.feed` runs.
- **Bytes, not gigabytes.** The screen decides MB or GB; a rounded number stored
  cannot be un-rounded.

### What it found

**Nothing had ever sent to an outpost, and it could not have.** The conduit target
was registered with the secret inline (`{ type: 'hmac', secret }`) where the
signer reads `ref`, so every call failed `auth_failed` — and the shared secret
sat in the registry in plaintext, which `GET /conduit-targets` returns. It was
also registered only inside the `came_online` branch, so a machine already
online when its outpost first reported a URL was never registered at all.

**`bun run db:seed --force` could not run on a database that had never been
seeded**, and its delete list was missing eleven models.

### Still open

**`FJS-139`** — the screen reloads on push, and after a burst of reports that
reload does not settle: it sits on "Loading…" with no error until some other
call is made. Not worked around here; the last `verify` check reads a fresh
navigation instead, and the live path is proven by its own check above it.

**The mock's per-server disk-usage bars are not built.** They need what the
outpost reports about the filesystem, not about volumes — that is
`DiskCleanupView`'s data, and it acts as well as reports, so it wants the job
queue.

## Phase 8 — a saved view names a kind ✅ done 2026-08-10

Two screens and one modal — `DashboardsView`, `DashboardDetailView`,
`AddWidgetModal` — over two new models. The phase existed to answer one
question, recorded when the inventory was written: **is a widget's data source a
declared vocabulary or a free-form query?**

### It is declared. The ruling is in `DECISIONS.md`

A widget carrying `{ accessor, where }` is a read stored in a row. The row
travels — seeded, copied, opened by everyone in the workspace — and the policy
does not travel with it: `@@gate` and `@@allow` grade a caller against a model,
and neither can say anything about a string. The server would end up running one
person's query at another person's privilege with nothing in the schema able to
see it.

So `enum WidgetKind` is the vocabulary, and it does three jobs from one
declaration: the column's CHECK constraint, `autoValidate`'s answer at the API,
and — because it reaches the browser as a `$def` on the model's JSON Schema, the
same path every other enum takes — the Add-widget picker. What the schema cannot
say (which kinds take a server, which take an app, which config keys each reads)
is one table in `api/src/services/dashboards/kinds.ts`, fetched by the screen
through a collection-level `kinds` action rather than copied into the bundle. A
data test holds the enum and the table together in **both** directions: a kind
in the schema with no entry is placeable and unconfigurable, an entry with no
enum member is a button the column refuses.

**Nothing on the board reads on the board's behalf.** Each card asks the service
that owns its data, with the reader's own session — so a dashboard shows exactly
what its reader could have opened for themselves. The activity card renders *the
trail is readable by admins and owners* for a developer, which is the correct
answer and the one that does not read as a broken widget.

### What that decided about the rest of the shape

- **A subject is a relation, not an id in `config`.** `serverId` and `appId` are
  real foreign keys with `onDelete: SetNull`, so a card whose machine was really
  deleted keeps its place and loses its subject rather than vanishing with the
  machine. Same ruling `AlertRule.channels` got in Phase 5.
- **`config` is knobs, and an unknown key is refused by name.** A widget cannot
  be given `where` even by a caller that skipped the UI — checked in the browser
  suite by asking the API directly.
- **A counter counts.** The mock's `stat-counter` holds a number typed in when
  the widget is added, which is a dashboard displaying whatever it was told. This
  one names a source from a declared list and reads that service's own `total`,
  so a viewer who cannot read servers gets a refusal instead of a fleet size.
- **The pin is the WORKSPACE's.** One boolean on a shared row cannot be
  personal; a per-person pin needs the preferences store `UserSettingsView` is
  waiting on, and the screen says so rather than offering a control that looks
  private.
- **No colour.** The mock stores a hex per board. `@frontierjs/css` styles by
  tone, and a stored colour is one the theme cannot follow. The icon is an
  emoji, which is content.
- **`deploy_feed`'s subject is an App, not a project.** A deployment belongs to
  an app and carries no project id, so the mock's project filter would have been
  a join this read does not do.
- **Reordering rewrites every position.** A move that writes two rows leaves a
  board half-ordered when the second write fails, and two people dragging at once
  produce an order neither chose.

All nine of the mock's widget types ship. Three of them state what they cannot
show, on the card, from the same vocabulary the picker is built from: nothing
here stores a time series, so `server_health` is the last heartbeat rather than a
trend, `service_health` is a live ping with no latency behind it, and
`alert_status` has rules but no evaluator (`FJS-123`).

### What it found

**A custom action that answers `data` plus anything else loses the anything
else** (`FJS-140`). `kinds` returned `{ total, data, statSources, portalServices }`;
`wrapResult` recognized the first two keys as a paginated list and rebuilt the
envelope from those alone, so the browser got nine widget kinds and neither of
the vocabularies needed to configure them — 200, no warning, no error. Answering
three named keys instead makes it a `single`, which unwraps whole.
`volumes.usage` documents the same trap from the other side, which is what makes
this the second phase it has cost.

### Still open

**A widget cannot be sized per breakpoint.** Width is thirds of a row and the
browser wraps them; the mock's `defaultRows` is not modeled at all, because a
card's height here is its content's.

**Nobody can put a board on the home screen.** `isPinned` orders the list and
does nothing else — surfacing a pinned board on `/` is a change to the home
screen, not to this phase.

## Phase 9 — the two ways to act on a machine ✅ done 2026-08-10

`RecipesView` and `DiskCleanupView`, built together because they are a pair and
neither makes sense alone. Both act on a server through its outpost, both queue
through Caravan, and each is the other's argument.

### The ruling — a vocabulary cannot bound a script, so the record does

The obvious move was to apply Phase 8's ruling again: a saved view names a
declared kind, so a saved script should name a declared … something. **It does
not transfer, and why it does not is the phase.**

A stored query is dangerous because it is executed at the Data boundary, where
`@@gate` and `@@allow` grade a CALLER against a MODEL and a string cannot be
graded. A script is not executed at that boundary at all — it is handed to an
outpost and run on a machine, where there is no model, no caller and no grade. It
runs at whatever the outpost has, for everyone, every time. A vocabulary of
allowed scripts buys nothing against that.

So the two screens carry opposite safeguards, and the split is deliberate:

| | `/cleanup/` | `/recipes/` |
| --- | --- | --- |
| Stored | target names from a fixed list | a script |
| Refusal possible | yes — unknown target, by name | no |
| Authoring | developer | **admin or owner** |
| Running | developer | developer |
| The record | what the outpost said it freed | the script AS RUN, per server |

**Authoring and running split on purpose.** Writing the script is the privileged
act; running a vetted one is what somebody on the pager does at 3am. Collapsing
them makes recipes admin-only in practice, which is how people end up pasting
the script into a terminal instead. Ruled in the repo's `DECISIONS.md`.

### `/recipes/` — arbitrary code, and an honest record of it

- **One run row per SERVER.** A fleet run is N executions with N exit codes, and
  a single row has to pick one status for *three succeeded and two failed* —
  which is the answer an operator most needs.
- **A run keeps the script it ran.** `RecipeRun.script` is a copy, not a
  reference: a recipe is editable, so output read against a script that has
  since changed is not evidence of anything. A data test edits a recipe and
  asserts the old run is untouched.
- **A machine with no outpost is refused at the click**, naming the machine,
  rather than queued and failed a minute later where nobody is looking.
- **A non-zero exit is recorded, never retried.** Caravan's retry covers a
  transport failure; retrying `rm -rf` because it exited 1 is how a retry policy
  makes things worse. A timeout is its own state — a script may well have
  finished the work and lost the answer.
- **Nothing is simulated.** The mock streams invented output from a fixed table
  keyed by recipe id; here the output is what the outpost returned, capped at 32 KB
  per stream from the TAIL, because an outpost that cats a log file answers
  megabytes and the end is the part anyone reads.

### `/cleanup/` — the declared half

- **Every number on the screen was measured by Docker.** `DiskUsage` carries
  `docker system df`'s own per-category reclaimable figures. The mock multiplied
  a count by an average — `s.images.dangling * 0.08` — and printed gigabytes
  beside figures that were real, which is worse than no estimate because nothing
  says which is which.
- **The estimate sums by SOURCE, not by target.** Docker reports one reclaimable
  figure for images and both image targets draw on it, so adding them would
  promise twice what a sweep can deliver. The vocabulary declares which figure
  each target draws on, so this is arithmetic rather than a second opinion.
- **Unused volumes are off by default** — the one target here that destroys
  something no registry can hand back, and `/volumes/` is where a person deletes
  one knowing its name.
- **Absence is a state.** A machine whose outpost has never reported says so
  rather than rendering zeroes, which read as "nothing to reclaim".
- **The sweep's answer is a fresh picture.** The outpost has just run
  `docker system df` to work out what it freed, so its response carries a `usage`
  snapshot, written through the same function the report endpoint uses — one
  owner, so the two cannot disagree about which key means what. Volumes it
  removed are forgotten only by name, the rule `volumes.prune` already follows.

### What it found — an enum set has no home in the schema

**`targets ReclaimTarget[]` does not parse** — *array [] is only supported for
Text, Integer, File, or a model name for many-to-many* (`FJS-141`). The parser
is right that SQLite has no array type, but the consequence is that a
set-valued vocabulary cannot be declared in the seed at all: a single-valued
enum gets a CHECK, a `$def` and one declaration feeding column, API and picker,
and the set-valued case gets none of it.

Declaring the enum anyway beside a `String[]` column would be two homes with
nothing joining them — the exact shape that let `AlertRule.severity` default to
a value its own API refused in Phase 3. So the list has one home in
`api/src/services/cleanup/targets.ts`, the API refuses anything outside it by
name, the screen fetches it through a `targets` action, and a data test asserts
the schema declares no competing enum.

**One vocabulary for a run, not three.** `enum JobRunStatus` became
`enum RunStatus`, shared by `JobRun`, `RecipeRun` and `CleanupRun`. Three copies
of the same five words drift apart one value at a time, and the screens then
disagree about what "finished" looks like — a data test names all three models.

### Still open

**Nothing here is scheduled.** The mock has a nightly cron on the cleanup screen
and both screens say why they do not: a sweep or a recipe on a timer is a `Job`
with a cron expression, and a second scheduler on either screen would be a
second owner of when the fleet gets touched.

**The mock's per-server disk BARS are not built.** They need what the outpost
reports about the filesystem — free space on `/` — which is a different reading
from `docker system df` and belongs with the health payload rather than here.

## Phase 10 — the tier above every tenant ✅ done 2026-08-10

`/hub/` + `/hub/workspaces/` + `/hub/users/` + `/hub/flags/` — the last group
whose blocker was an API rather than a model, and the run-up to `FJS-007`.

### The shape — one service that takes no workspace

Nineteen of the twenty services here take `X-Workspace-Id` and refuse without
it, which is the tenancy boundary doing its job. The obvious way to answer a
cross-tenant screen was to widen them with `?scope=hub`, and it is the wrong
one: that puts the decision *may this caller see every tenant* in a query
string, on nineteen services, each of which has to get it right, and the one
that forgets looks exactly like the eighteen that did not.

So `/hub` is one service behind one `requireSystemAdmin` hook, and it takes no
workspace at all — there is nothing for a caller to widen. It reads through
`asSystem()`, which is not a convenience: `User` is the model auth's own
fragment gates at level **8**, one above SYSADMIN, so no caller-scoped client
can read a user list. The gates landed the day after this screen and it needed
no change.

Refusal is **404, not 403** — the hub is not a screen someone is being refused,
it is a surface they have no business knowing exists.

### Suspension, which was a word nothing honored

`User.status` was a free `String` and @frontierjs/auth — which owns the model —
never reads it. A Suspend button written against it would have reported success
and revoked nothing. Making it real took three things and no two of them are
enough:

- **an enum** (`UserStatus`, `WorkspaceStatus`) so the column carries a CHECK
  and the service's copy is held against it by a test in both directions;
- **the front door** — a suspended user cannot sign in, checked AFTER the
  password so the refusal does not disclose which addresses are suspended;
- **the door already open** — a token issued before the suspension stops
  resolving, at an app-level `before: all` hook. Deleting the `Session` rows is
  not enough: an API key is a `Credential` and survives it.

For a workspace the one door is `scopeToWorkspace`, the hook every scoped
service already runs — so it bites in nineteen places by being written in one.
It is **not** deletion: `@@softDelete(cascade)` stamps every child, a status
change stamps nothing.

### Bots — and the API-key gap they close

The Users screen creates `UserKind.bot` accounts and ships without the mock's
Invite button. The asymmetry is the point: a bot has no password credential, so
creating one hands nobody anything, while creating a human here would be an
admin minting an account with a password only they know. Inviting a human is
therefore a different screen and a different mechanism — an offer sent to an
address, accepted with a password the person chooses (`FJS-032`, closed; the
Members screen under § MembersView).

It closes what `api-keys.service.ts` had recorded in its own comment since
Phase 6 — a key was always minted for the caller because nothing else existed to
own one, so CI's key was a person's key. A key may now name a bot, and only a
bot, only in this workspace, and only one that does not outrank you.

Ruled in `DECISIONS.md`, all three.

### What it found

**An app could not get its own User columns onto the session.** auth owns
`model User`, every app extends it, and the only route to `isSystemAdmin` per
request was to wrap `verifySession` and re-read the user — a third query on the
hottest path, forever, for a row auth had just fetched. Closed with
`createLitestoneAuth(db, { sessionFields })`, called from `toContext()`, which
is the one place every issued session is built.

**A `find` that answers one object becomes an EMPTY list in the browser**
(`FJS-144`). `GET /hub` was the overview; the client normalises anything that is
not a list into `list(name, [])`, so the screen received `{ data: [] }` with a
200 and rendered nothing at all. The API was correct throughout — only the
browser could see it. `find` means a list; the overview is an action.

**The typechecker caught a stat that would always have read zero.**
`app.conduit.list()` is async, and `.length` on the promise is `undefined`,
which `?? 0` turns into a confident *no targets registered* on a hub with
twelve. Both answers render.

### Still open

**Impersonation** is offered twice in the mock and built nowhere (`FJS-142`).
The button is not the work: it needs a trail that keeps recording who is really
acting, a way back that cannot be lost with the tab, and a rule for what an
impersonator may not do.

**Hub settings and backups** are the two sysadmin screens left, and both need a
model that does not exist.

**`/metrics` is unauthenticated** — `healthPlugin` was configured with no token,
so the service registry and every action name is world-readable. Not exploited
by anything here and not changed in this phase, because the drives and any
external probe read it; worth a decision rather than a quiet edit.

---

## Phase 11 — the models the last screens needed ✅ done 2026-08-25

Every unbuilt view was blocked on a model, an adapter, or a derived read. This
pass took the first group: **six models, four enums, one deliberate refusal.**

Nothing was invented. Each shape was read out of `docs/mock/BasecampUI.jsx` —
the view AND the data constant behind it — because a model derived from a screen
that was never opened is a guess about what somebody will want.

### What went in

| Model | Tenancy | Gate (R.C.U.D) | The decision in it |
| --- | --- | --- | --- |
| `Blueprint` | `@@tenant(none)` | 1 · 7 · 7 · 7 | A curated catalogue, not a per-workspace one |
| `BlueprintParam` | `@@tenant(none)` | 1 · 7 · 7 · 7 | A child model, not a Json array |
| `RegistryImage` | `workspaceId` | 2 · 8 · 8 · 5 | Mirror a registry, do not query it live |
| `Backup` | `@@tenant(none)` | 7 · 7 · 8 · 7 | The outcome is the machine's, like every *Run |
| `HubConfig` | `@@tenant(none)` | 7 · 7 · 7 · 7 | One typed row, and no credentials in it |
| `NotificationPreference` | `@@tenant(none)` | 1, own row | Per person, not per membership |

### The five arguments worth keeping

**A marketplace is not a tenant's.** Every entry in the mock is third-party
software — n8n, Postgres, Redis, Meilisearch, Plausible. A workspace-scoped
`Blueprint` gives each tenant a private copy of the same nine rows, and the other
option — a nullable `workspaceId` meaning *shared* — is exactly the shape
`FJS-432` is an open question about: a null never equals a claim, so row tenancy
hides precisely the rows meant to be global. `@@tenant(none)` says it plainly. A
workspace authoring its own is a later model or a decided nullable column.

**A blueprint's parameters are a form, so they are rows.** Ordered, individually
validated, and the deploy modal is generated from them. A Json array would put
the shape of a form in a column nothing describes — which is what `AlertRule.channels`
was before it became a real join.

**`RegistryImage` commits to mirroring.** `SCREENS.md` left that open, and the
decision is forced by one column: `inUse` is a join against this workspace's
deployments, and a registry API knows nothing about who deployed what. The cost
is staleness, so `observedAt` is a column rather than an assumption — the screen
can tell *no images* from *no sync*, which is `Volume.lastSeenAt`'s distinction.

**`HubConfig` holds no credentials, and the mock's Settings screen showed four.**
Its auth secret, agent secret, Resend key and Infisical token are all absent, for
three reasons each sufficient on its own: they are read at BOOT, before any
database, so a row would not reach the running process; rotating one is a deploy
rather than a form; and this app already models credential material as `Secret`,
whose `data` is `@encrypted` and unreadable at every level.

**Onboarding gets no model.** All six of the mock's steps are questions the
database already answers — does this workspace have a server, an SSH-kind
`Secret`, a project, a `Deployment`, a second member. A stored `done` is a second
answer to each, and it goes stale the moment somebody deletes what it recorded.
The mock stores them because a mock has no database.

### What it found

**A rule that cannot be isolated is a rule nobody has tested.** `baseUrl` was
written `@trim @url @length(1, 300)` and `verifyConstraints` refused it by name:
every 301-character string that would exercise the length is refused by `@url`
first, so the boundary was never checked and a pass would have been a pass on the
wrong refusal (`FJS-351`). The `@length` came off.

**Four documents disagreed about how many models there are** — 37, 38, 39 in
three of them and 38 in the root map. Corrected to 45 everywhere, along with the
`@@tenant(none)` count, which said *seven* and had been nine since before this
pass.

### Still open

Every one of these is a model with nothing on top of it. **No services, no
resources, no screens, and the seed writes none of these rows** — a `HubConfig`
row does not exist until something creates one, and the catalogue is empty. That
is the next phase and it is deliberately not this one: a service written against
a model nobody has opened a screen onto is two guesses stacked.

`Blueprint` also has no relation to `App`. The mock's deploy modal builds an App
out of a blueprint and forgets which one it came from; a `blueprintId` on `App`
is the honest version and is a schema change nobody has asked for yet.

---

## Phase 12 — services over those models ✅ done 2026-08-25

Five services and one job. Every model from § Phase 11 now has an API; the sixth
case (`OnboardingView`) still has no model by decision, and still has no service,
because the six checks it needs are a read across five accessors and belong with
`InfraGraphView`'s derived read rather than on its own.

| Service | Model | Methods | Takes a workspace? |
| --- | --- | --- | --- |
| `blueprints` | `Blueprint` | find · get · create · patch · remove · categories · setParams | no |
| `registry` | `RegistryImage` | find · get · repositories | **yes** |
| `backups` | `Backup` | find · get · create · remove | no |
| `hub-config` | `HubConfig` | current · save | no |
| `notification-preferences` | `NotificationPreference` | find · save · reset | no |

### Four of the five take no workspace, and the schema is what says so

`tenantClaimGuard` runs app-wide, ahead of anything a service writes, and refuses
a signed-in caller carrying no tenant claim. It exempts a service whose model is
`@@tenant(none)` — `isRowScoped(db, ctx.service)` — so declaring the tenancy in
the seed is what makes these reachable. **A hook could not have done it**, which
is worth stating because the obvious instinct is to reach for one.

That exemption lives in junction, is keyed off this app's schema, and neither
file names the other. The test that would catch it moving is a sysadmin with
**no workspace on the session** reading `/blueprints`.

### What it found

**A closed create schema strips a relation in silence.** `blueprints.create` was
written to take its params inline, the way the mock's export format holds them.
It cannot: litestone's derived create schema is `additionalProperties: false` and
`params` is a relation, so `autoValidate` removes the key before the method runs
— a blueprint with no form and no error. `@transient` is the declared answer and
is unavailable here for one flat reason: the relation already owns the name. So
the payload is refused by name, in a hook that runs AHEAD of the validator, which
is the only place the key is still visible.

**`@version` binds a state change, not just a form.** `blueprints.remove`
withdraws by stamping `deprecatedAt`, and litestone refused it: `revision` is
`@version`, so every update carries the revision it read. Reaching for
`asSystem()` would have dropped the gate, the audit actor and the announcement to
withdraw one row. It reads the row and passes the revision.

**`hub-config.save` requires the version too**, and that is the case `@version`
exists for — two administrators with the settings form open. Refused here by name
rather than by the column, because litestone's sentence explains the column and
this one explains the call.

**A shared digest was being charged twice.** `registry.repositories` sums bytes
per repository, and two tags of one digest is the ordinary case (`v2.14.1` and
`latest`) — the registry stores those layers once. A per-tag sum reports double
what the disk holds, which is exactly the number an operator would use to decide
what to delete.

### Two deliberate absences

**`registry` offers no sync and no delete.** There IS a provider —
`app.providers.registry`, an `IRegistry` — and it is a stub. But the interface
could not fill this table against a real registry either: `listTags(repo)`
answers `string[]`, so `digest`, `sizeBytes` and `pushedAt` would all be
invented. And deleting a mirror row deletes nothing — the tag is still there and
the next sync brings it back — so the button would report a success that did not
happen. Closing both means widening `IRegistry` first.

**`backups` writes `local` only.** `s3` is a declared value with nothing behind
it, and it is refused at `create` rather than queued to fail, because a row that
is going to fail for a reason already known makes the person come back to find
out. The job itself is real: `VACUUM INTO`, which is SQLite's own consistent
online backup — a file copy of a live WAL database silently omits whatever is
still in the `-wal`.

### Seed rows followed the same day

`db/blueprints.js` carries eight applications read out of the mock's own
`BLUEPRINTS` constant — 31 params, all three `ParamGenerator` values — plus a
`HubConfig`, one completed `Backup`, 15 `RegistryImage` rows across the two
workspaces and two `NotificationPreference` rows. Three of those are shaped by
what a screen has to be able to show:

- **Ghost is seeded withdrawn**, so the list has a row to hide and the detail
  page has one to still resolve. 7 offered of 8.
- **The registry mirror seeds a shared digest.** `latest` and the newest version
  tag are one image: 922MB summed per tag against 738MB per digest, which is the
  25% overstatement `repositories` exists to avoid.
- **Two preferences, not fourteen.** A row exists only where somebody has chosen,
  and seeding everybody would erase the *chosen* against *default* distinction
  the screen renders.

`brandColor` is set on one of the eight. The other four the mock coloured took it
from its own theme object, which is a design-system token rather than a vendor's
brand.

### Still open

No screens. `HubConfig.backupCron` is stored and nothing registers a schedule
from it — a schedule that comes from a ROW needs re-registering at boot and
`unschedule` when the row stops being true, which is `job-schedule.ts`'s pattern
and a separate piece of work.

---

## Phase 13 — the five screens ✅ done 2026-08-25

| Route | View | Reads |
| --- | --- | --- |
| `/blueprints/` | `BlueprintMarketplaceView` | `blueprints` — the catalogue, no workspace |
| `/registry/` | `RegistryView` | `registry` — the mirror, workspace-scoped |
| `/hub/backups/` | `HubBackupView` | `backups` + `hub-config` |
| `/hub/settings/` | `HubSettingsView` | `hub-config` — the singleton |
| `/settings/` | `UserSettingsView` | `client.auth.*` + `notification-preferences` |

Plus a drive: **`bun run verify:screens`**, 26 checks in a real browser. It
seeds a database of its own in a temp directory and starts and stops both
servers, so it touches nothing local and never asks anybody to reset a dev
fleet. That is also why it is separate from `verify`, which asserts the
first-run wizard owns an EMPTY app — three of these screens are about rendering
a populated catalogue, and an empty grid looks exactly like a broken query.

### What the drive found, which the build did not

**`Switch` hands `onchange` a boolean; `Input` hands `oninput` an event.** Both
new forms had been written with `e.target.checked` on a Switch, which reads a
property of `undefined`, throws inside the handler and leaves the control
looking dead. The build was green and the screens rendered.

**A row that stays `pending` on screen while the job has already finished it.**
The backup job completes in ~80ms and writes a real archive; the screen showed
`pending` indefinitely. Every other list in this app learns about a change from
the socket, and this one cannot: `announceDataWrites` broadcasts through the
app's channels, the only channel this app has is the WORKSPACE's, and `Backup`
is `@@tenant(none)`. So this screen polls while an archive is in flight, and
says why in the file.

**And a drive that passed for the wrong reason.** The first version of the
backup check polled the history table's TEXT for `success` and a size — which
the SEEDED archive already matched, so it passed before the new row existed and
would have passed with the button disconnected. Rewritten to poll the row COUNT
first and the new row second. It is the same class as the assertion that only
asks `querySelector` for an overlay.

### The arguments each screen carries

**Deploying from a blueprint is not wired, and the screen says so.** The mock's
Deploy button builds an App and forgets which blueprint it came from. Doing it
properly needs a `blueprintId` on `App` and a path that turns the params into an
app's environment; neither is invented. What the detail pane shows instead is
the whole of what such a step would send.

**The registry screen marks aliased tags rather than hiding them.** `latest` and
the newest version tag share a digest, and the repository total charges it once
— so a tag row says *same image as v2.14.1* where the naive screen would show
two sizes that add up to more than the disk holds.

**Neither sync nor delete is offered there**, and the callout gives the reason
rather than leaving a disabled button: `IRegistry.listTags` answers `string[]`,
so a sync would invent a digest, a size and a push time, and deleting a mirror
row deletes nothing.

**Restore is absent from the backups screen.** Restoring means replacing the
database this process is reading from, in place, while it serves — an operator's
job with the process stopped, and the most dangerous control this app could
have. There is no download either: the archive is a path on the machine and
nothing serves it.

**The hub settings screen has none of the mock's four credentials**, and the
copy on the page explains why rather than leaving somebody hunting: they are
read at boot before any database, rotating one is a deploy, and `Secret` already
models credential material.

**Three switches say they are stored and read by nothing yet** — the two-factor
requirement, API-key auth and bot accounts. A switch that changes a column and
no behavior is worth saying out loud rather than leaving to be discovered.

**The notification screen renders *chosen* against *default*.** A row exists
only where somebody has said something, so *defaulted to on* and *turned on* are
different facts, and a reset control only makes sense once the screen can show
the difference.

### Still open

`OnboardingView` — six checks across five accessors, which belongs with
`InfraGraphView`'s derived read rather than on its own.
`HubConfig.backupCron` is still registered by nothing, and both screens that
mention it say so.
The notification rows are stored and **no delivery path consults them**.

---

## Phase 14 — the last six ✅ done 2026-08-30

The six the mock still had and this app did not. They split two ways and the
split is what the phase decided, because it is the difference between a screen
that is missing and a screen whose subject is missing.

| Route | View | Reads |
| --- | --- | --- |
| `/infra-graph/` | `InfraGraphView` | `infra.graph` — servers, apps, networks, domains and the three join tables |
| `/onboarding/` | `OnboardingView` | `infra.onboarding` — six counts |
| `/dns/` | `CloudflareView` | `domains` + `apps` + `portal.get('edge')` · skeleton for the zone |
| `/cloud-spend/` | `DigitalOceanView` | `servers` + `volumes.usage` + `portal.get('cloudSpend')` · skeleton for the money |
| `/git-activity/` | `GitActivityView` | `portal.get('git')` · skeleton for the repositories |
| `/observability/` | `ObservabilityView` | `portal.get('observability')` · skeleton for metrics and logs |

### One service for two reads, over no model

`infra` is the fourth service here that takes no model, after `hub`, `portal`
and the health reads. Both of its methods have the property that made a model
wrong: the answer is assembled from tables the caller can already read, and
storing it would be a second answer that goes stale. `OnboardingView` had that
ruled in § Phase 11; a graph projection is the same argument about edges, since
an `AppServer` row IS the edge.

**What a browser cannot do instead**, which is why this is a service at all:
`apps.find` answers the environment and the domains, but WHERE an app runs is
only on `apps.get` — one request per app — and the onboarding read needs counts
of two models the caller cannot see. One read here is one round trip.

**Three of the six onboarding counts go through `asSystem()`**, and the reason
is not convenience: `Secret` and `Invitation` are `@@gate("5")`, so a developer
asking *does this workspace have an SSH key* got a refusal rather than a zero,
and `WorkspaceMember` reads only the caller's own rows, so *is anybody else
here* was 1 for everyone. What crosses is a count of rows in the workspace the
caller is already in — never a row — on the screen a new viewer opens first.

### The layout is in the browser, and there is no drag

A node position is not a fact about the fleet. Storing one means a column that
is wrong the moment a server is added, and the mock's own answer — drag a node
and keep the coordinates — is a preference with nowhere to live. So the lanes
are derived from the node kinds on every render and the only state the screen
keeps is which kinds are shown and how far it is zoomed. The graph scrolls
inside its own box, which is a scroll a keyboard and a trackpad already know
how to do.

Four kinds of edge, and each is a row: a `Domain` pointing at an app, an
`AppServer` placement, a `ServerNetwork` peering, an `AppNetwork` attachment.
**What is deliberately not drawn** is on the screen rather than in this file:
app-to-app dependency (nothing records it), the internet and the CDN in front of
the fleet (neither is a row), and live traffic (nothing samples it). Those three
were half the mock's picture.

### A screen for a vendor nobody has connected

The four adapter screens are the ones with a judgement in them. A screen that
renders an empty table because nothing answered is indistinguishable from one
whose vendor has nothing to report, so none of them does that:

- **The reason is on the page**, in the same voice the hub overview uses about
  CPU — what is not measured, and what closing it would take.
- **All four ask rather than assert.** Each reads its own adapter's state off
  `/portal/`, which is the read `/admin/adapters/` already makes, so there is one
  answer to *is this wired* and the word on the page changes the day it is. A
  screen that hardcoded "not connected" would pass a test on its own text and be
  wrong later — which two of them did until the `edge` and `cloudSpend`
  providers were declared.
- **Two are named for the job, not the vendor.** The mock drew Cloudflare and
  DigitalOcean; this app has neither in `providers/index.ts` and records a
  `providerKind` of custom or hetzner. `/dns/` and `/cloud-spend/` are the
  screens whichever provider gains an adapter first will fill.
- **Each has a real half.** Hostnames with their certificate status are this
  app's own rows; so is the fleet a bill would be computed from. The skeleton is
  only where the vendor's numbers go.

### The two adapters that had no boundary at all

`IGit` and `IObservability` existed with stubs. `edge` and `cloudSpend` did not
exist in any form, which is why `/dns/` and `/cloud-spend/` first shipped with
their "no adapter" prose written into the page — the one thing the other two
screens were built to avoid.

Both are declared now, with stubs, and the portal reports ten providers in two
groups:

| Provider | Interface | Shape |
| --- | --- | --- |
| `edge` | `IEdge` | `listZones` · `listRecords(zone)` · `analytics(zone, from, to)` |
| `cloudSpend` | `ICloudSpend` | `monthToDate` · `lineItems` · `forServer(providerServerId)` |

Three decisions in that:

- **`hosted` is on the portal entry**, not on the screen. An appliance is
  installed on a machine and pointed at with a URL; a hosted service is an
  account with a token. *Unconfigured* means different work for each, so the
  split is data rather than a heading somebody typed twice.
- **Money is minor units plus a currency**, the same rule `@money` holds at the
  Data boundary and for the same reason: the divisor belongs to the currency,
  and `/ 100` is wrong for the yen by a hundred.
- **`forServer` takes `providerServerId`**, the only key this app and a vendor's
  ledger share. There is no row of ours in their billing.

`IGit` was widened at the same time, because the screen's own callout was the
argument for it: a repository record answers `ci`, `openPullRequests` and
`openIssues`, and `listPullRequests(repo)` is the second call. What is left for
all four is an adapter and a service — not an interface.

**The stubs answer empty, never plausible.** A stub zone would put a hostname on
`/dns/` that this app cannot reach and nobody owns, and zeroed analytics read as
an outage rather than as an absence — so the screens ask whether the adapter is
configured *before* they ask it anything.

### What the drive needed before it could assert any of it

`verify:screens` went from 26 checks to 61, and the fixture is the interesting
part: `db/seed.js` makes servers, apps and placements and no domains or
networks, so two of the graph's four node kinds and the whole of `/dns/` would
have been asserted against an empty list — the exact shape that passes with a
broken query. The drive creates one of each **through the app's own API, from
the page, with the session it is already holding**, so the rows go through the
gate, the row policies and the workspace stamp, which is what decides whether
the screens can read them at all.

The onboarding assertions are written against the ruling rather than the
rendering: the number of `.step.complete` elements must equal the progress
element's value, a seeded server must mark its step done, and no button on the
screen may say *complete*.

### What it found

**Three resources here have no model, and Sierra warned about each on every
boot.** `portal`, `hub` and now `infra` resolve to nothing in `db/schema.lite`,
which is correct and was indistinguishable from a misspelt model name — so the
drive's console check could not pass, and the app that has three of them was
teaching everyone to read past the one warning that means something.
`createResource(name, { model: null })` is the declaration that turns it off:
*this service has no model*, as opposed to *this model was not found*. Shipped
in `packages/sierra/src/junction/resource.js`.

**A `@@gate("5")` on a count is still a refusal.** The onboarding read was
written against the caller's own client and threw for anybody below admin — on
the one screen whose whole audience is somebody who has just arrived.

---

## Related

- `docs/ADAPTERS.md` — the debt § Phase 14 left: what each of the four adapters
  costs to wire, the decisions already made, and what goes red when one is
- `docs/UI_PLAN.md` — how the first screens got built, and what each phase found
- `docs/UI_HANDOFF.md` — the API contract the screens are written against
- `docs/VISION.md` — what Basecamp is meant to be
- `../../ISSUES.md` — `FJS-031`, `FJS-032`, `FJS-085` (`FJS-007`, the missing
  `@@gate`, closed 2026-08-10)
