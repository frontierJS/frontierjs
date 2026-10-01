# Adapters — what is declared, what is stubbed, and what wiring one costs

**Status: EVERY BOUNDARY IS DECLARED. ONE IS WIRED — `edge`, reading.** Dated
2026-08-30. This is the pick-up doc for the work `docs/SCREENS.md` § Phase 14
left: four screens exist, each says which adapter is not connected, and each is
waiting on the same two things — an adapter and a service.

Read it before writing either. Most of what follows is a decision already made
with a reason, and the reasons are the part worth not relitigating.

---

## The ten

`api/src/providers/index.ts` builds nine of them; `api/src/basecamp.types.ts`
declares them; `services/portal/` reports all ten. `edge` is a workspace account
read by `services/edge/`; the other nine are a Stub.

| Provider | Interface | Kind | A screen is waiting | Config key |
| --- | --- | --- | --- | --- |
| `secrets` | `ISecrets` | appliance (Infisical) | — | `providers.secrets.url` |
| `flags` | `IFlags` | appliance (Unleash) | — | `providers.flags.url` |
| `search` | `ISearch` | appliance (Typesense) | — | `providers.search.url` |
| `registry` | `IRegistry` | appliance (Zot) | `/registry/` reads the MIRROR, not this | `providers.registry.url` |
| `git` | `IGit` | appliance (Forgejo) | **`/git-activity/`** | `providers.git.url` |
| `observability` | `IObservability` | appliance (Grafana) | **`/observability/`** | `providers.observability.grafana_url` |
| `networking` | `INetworking` | appliance (NetBird) | — | `providers.networking.url` |
| `integrations` | `IIntegrations` | appliance (Nango) | — | `providers.integrations.nango_url` |
| `edge` | `IEdge` | **hosted** | **`/dns/`** | a workspace's Cloudflare account — a `provider_key` Secret (`FJS-D558`) |
| `cloudSpend` | `ICloudSpend` | **hosted** | **`/cloud-spend/`** | `providers.cloud_spend.api_token` |

**`hosted` is a field on the portal entry, not a heading on a screen.** An
appliance is installed on a machine and pointed at with a URL; a hosted service
is an account somebody opens and a token this app holds. *Unconfigured* means
different work for each, which is the whole reason the split is data —
`/admin/adapters/` renders two groups off it and cannot disagree with the
service about which is which.

---

## The four with a screen waiting

Each is the same shape of work: **a connector, then a service, then the screen
stops rendering skeletons.** The screens are done and none of them needs
touching except to render what arrives.

### `edge` — a workspace account, behind `/dns/`

Not in `app.providers`: a Cloudflare token is a `provider_key` Secret, registered
like a compute account (`FJS-D558`), and `services/edge/` reads through it.

```
edge.zones                         → each account, with its zones or the vendor's error
edge.records(accountId, zoneId)    → the zone's records, and drift: missing · conflicts · orphans · stale
edge.sync(domainId)                → the App's ingress record, then the Domain's CNAME to it (ADMINISTRATOR)
```

**What the adapter adds is the other side of a `Domain` row** — the zone's own
records — and the value of the screen is the two disagreeing. `records` marks a
serving record (A, AAAA, CNAME) with the `domainId` whose hostname it answers, and
lists as `missing` a `Domain` inside the zone with no serving record: a hostname
this app intends to serve that resolves nowhere.

**Read at `Domain`'s read gate, not `Secret`'s.** The account lookup is
`asSystem()` confined to the workspace, selecting no `data`; at a developer's
standing a scoped read of `Secret` is refused, and `/dns/` would say no account
exists. Analytics is a GraphQL endpoint at Cloudflare, a step of its own.

**`records` is the plan and `sync` the apply.** A Domain is a CNAME to its App's
INGRESS RECORD, `<appId>.<ingress zone>`, holding an A per machine the App runs
on — `running` and `online` (`servingAddresses`, `FJS-D561`). The ingress zone is
`Workspace.ingressAccountId` + `ingressZoneId`, set through `workspaces.patch`
(no screen yet). `sync` refuses with a 409 before writing anything when there is
no ingress zone, the App runs nowhere, no connected zone holds the hostname, the
Domain redirects (`FJS-1615`), or an unmarked A/AAAA/CNAME sits at the name.

**Nobody has to press it.** The `domain:dns` job runs `edge.syncStep` on every
`Domain` create, patch, remove and restore, and for each of an App's Domains
when a release lands. A deleted Domain's CNAME is removed, only where it
carries that Domain's mark. The *not yet* refusals are skipped rather than
failed, so a workspace with no edge account writes Domains without a failed job
for each. A machine entering or leaving `online` pushes each App on it, with
no release (`FJS-1614`); an App left on no online machine keeps its record
where it last ran, named `down` in drift (`FJS-D567`). `adopt` is not built.

**The connector writes.** `appendRecords` · `setRecords` ·
`deleteRecords` (`FJS-D562`), each one batch that applies whole. Every record
written carries a mark, the caller's `RecordMark` spelled by the connector
(`basecamp:domain:<id>` in Cloudflare's `comment`), and a set or delete naming a
(name, type) set that holds an unmarked record is refused before anything is sent
(`FJS-D560`).

### `cloudSpend` — `ICloudSpend`, behind `/cloud-spend/`

```
monthToDate()                      → SpendPeriod
lineItems()                        → SpendLine[]
forServer(providerServerId)        → SpendLine | null
```

**Money crosses as minor units plus a currency, never a float and never a
symbol.** Same rule `@money` holds at the Data boundary, for the same reason:
the divisor belongs to the currency, and `/ 100` is wrong for the yen by a
hundred and for the dinar by ten (`@frontierjs/toolbelt/units`).

**`forServer` takes `providerServerId`** — the column this app already records —
because that is the only key this app and a vendor's ledger share. There is no
row of ours in their billing, so any other join is invented.

**Creating a machine is not on this list and must not join it** — `provider:<kind>`
is already the seam a service sends through, so a compute interface here would be a
second owner of *talk to a vendor*. The plan is `docs/PROVISIONING.md`.

`ProviderKind` is `custom | hetzner` today. A vendor with an adapter should be a
member of that enum: the column emits a table CHECK, so a value outside the set
is refused by a migration, a seed and `asSystem()` alike.

### `git` — `IGit`, behind `/git-activity/`

The interface was widened on 2026-08-30 and now carries what the screen renders:

```
listRepos()                        → GitRepo[]   (ci, openPullRequests, openIssues)
listPullRequests(repo)             → GitPullRequest[]
```

`ci` is a **verdict**, not a status string — `unknown` is what a host with no CI
answers, and it is not `pending`. Forgejo is the intended vendor; the three
counts are three separate calls at every host that has them, which is why they
are on the record rather than fetched per row by a screen.

### `observability` — `IObservability`, behind `/observability/`

`queryLogs` and `queryMetrics` have existed for as long as the interface has.
**The missing piece here is not the adapter, it is the service**, and that is a
design question rather than a wiring one: a read needs a window, a service name
and a level, and a service that passes a query string through hands every caller
a pass-through to whatever the adapter is pointed at. Design the read before
writing the connector.

---

## Decisions already made

Do not spend the argument again.

- **A connector is a `@frontierjs/conduit` target, never a `fetch()` in a
  service.** `example/api/src/providers/stripe/index.ts` is the worked example, and
  `example`'s `verify:stripe` is what proves the boundary is generic rather than
  agreeing with itself.
- **The token is a `Secret`**, like every other machine credential here. The
  target carries the ref (`secret:<id>` or `env:<NAME>`) and never the material —
  `api/src/core/credentials.ts` is the one resolver, and a target holding the
  material writes it into the registry, which `GET /conduit-targets` returns.
- **Two screens are named for the job, not the vendor.** `/dns/` and
  `/cloud-spend/`, where the mock drew Cloudflare and DigitalOcean. Whichever
  provider gains an adapter first fills them, and a screen called Cloudflare
  could only ever hold one.
- **A stub answers empty, never plausible.** A stub zone would put a hostname on
  `/dns/` that this app cannot reach and nobody owns; zeroed analytics read as an
  outage rather than as an absence. The screens ask whether the adapter is
  configured *before* they ask it anything, which is what makes the empty answer
  unreachable rather than merely unused.
- **No service until there is an adapter.** A service returning stub emptiness
  makes a screen render an empty table, and an empty table is indistinguishable
  from a vendor with nothing to report — the exact failure the skeletons exist to
  avoid.
- **The screen asks the portal for its own adapter's state.** Four screens do
  this and none of them hardcodes a status, so the words change the day one is
  wired rather than the day somebody remembers to edit them.

---

## What wiring one will break, and that is correct

`web/test/verify-screens.mjs` asserts `unconfigured` for four adapters, because
that is the truth in a test environment that sets no provider variables. `edge`
is asserted both ways: `unconfigured` on the seed, then `healthy` once the drive
connects an account at the Cloudflare sink it starts. **If you
wire an adapter and the drive goes red, read the assertion before the code:**

| Check | Screen |
| --- | --- |
| `the edge adapter reports its real state` | `/dns/` |
| `with the spend adapter reporting its real state` | `/cloud-spend/` |
| `git activity reports the adapter's real state` | `/git-activity/` |
| `observability reports the adapter's real state` | `/observability/` |

The right fix is to decide what the drive should assert with a connector present
— almost certainly a fake vendor on a port of its own, the way `verify:stripe`
and `verify:pay` do it — not to loosen the check to *any status*.

Two more that will move:

- `eight self-hosted appliances` / `and two hosted services` on
  `/admin/adapters/`, if the provider list grows.
- `check-baseline.json`'s `detail-read-dead` is **6**, and all six are
  `portal.get()` over no model. A fifth screen reporting an adapter makes it 7;
  a screen that starts watching a real row does not belong in that number at all.

---

## Traps

- **`portal.get(id)` pings; `portal.find()` does not.** The four screens use
  `get` deliberately — reporting an adapter is the point — and each one catches
  the failure so a slow or throwing ping cannot take the app's own rows down with
  it. Keep that `.catch()`.
- **`PORTAL_SERVICE_IDS` is read by the dashboards service.** A `service_health`
  widget stores a portal id, and it is validated against this list rather than a
  second copy. Adding a provider widens what a widget may point at — which is
  right, and worth knowing.
- **A hosted provider has no `url` and no `ui_port`.** Its config key is a token,
  so `entry.url` reads null even once it is wired; `/admin/adapters/` shows
  *credential set / not set* for those rather than a URL.
- **`isStub()` decides `configured` by the class name starting with `Stub`.** A
  real adapter class must therefore not be called `StubCloudflare` in a hurry.

---

## Related

- `docs/SCREENS.md` § Phase 14 — the screens, and why four of them are a
  statement about a third party
- `IDEAS/conduit-connectors.md` — which connectors the FRAMEWORK should maintain
  and in which order, `FJS-D153`; an app's own `core/` file is the alternative
  and is the right answer for most of them
- `IDEAS/third-party-credentials.md` — the credential leg, which is the half
  conduit does not have yet: a per-caller secret with an expiry, resolved at send
  time
