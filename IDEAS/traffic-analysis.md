---
id: traffic-analysis
status: proposed
dated: 2026-08-31
---

# Idea — `beacon`: who is hitting this app, and how

**Status: IDEA.** Probed against the tree 2026-08-31 (`VERIFYING.md`). One
precondition shipped with it — [`FJS-622`](../ISSUES_ARCHIVE.md#fjs-622) — because the
gap it names made every option here impossible rather than merely unbuilt.
**GoAccess dropped 2026-10-28 ([`FJS-D1621`](../DECISIONS.md#fjs-d1621))**: the
edge is Caddy and its access log is JSON, so the Outpost counts it in JS.

Prompted by CapRover's GoAccess integration (`caprover-frontend#167`), which is
the shape of the thing a fleet operator asks for and does not have here.

The third of the observability family and the shallowest. `lantern.md` asks
*why was this caller refused* and owns the span tree. `logbook.md` asks *what
did the process say* and *what did the write record*, and shipped. This one asks
the question that comes before either and is answered by neither: **what traffic
is this app taking.**

---

## Two questions people call one

**Traffic** is *how many requests, from where, to what, answering what status.*
The audience is an operator, the unit is a request, and nothing about the
application is needed to answer it — the reverse proxy already saw everything.
That is what GoAccess does and it is what CapRover shipped.

**Product analytics** is *how many people, doing what, converting how often.* The
audience is the business, the unit is a person, and the reverse proxy is a bad
place to answer it — a session is not an IP and a page view is not a GET. That is
Plausible, Umami, Matomo, and **it is out of scope here**, permanently: it needs
a consent story, a retention story and an identity story that none of the three
belong to a fleet console.

The rest of this record is the first question only. Where the second is mentioned
it is to say what a design must not accidentally become.

---

## What is already here

Three things sound like an answer. None is one.

**The `logs` tab** — shipped 2026-08-31 with `logbook` phase 3.
`apps.logs()` → a signed Outpost `POST /logs` → `docker logs --tail`, clamped at
5,000 lines. It is a **tail**, and it stores nothing: the container's own ring
buffer is the whole retention, and [`FJS-616`](../ISSUES_ARCHIVE.md#fjs-616) is the
reason there is a buffer at all rather than an unbounded file. Useful for *what
is it saying right now*, useless for *how much traffic did Tuesday take*.

**`/observability/`** — a screen and an unimplemented interface. `IObservability`
declares `pushMetric`, `queryLogs` and `queryMetrics`, Grafana is the intended
adapter, and **no service exposes any of them.** The screen reports that off the
portal's own ping rather than keeping a second opinion. Its source comment is
right about why it stops there: putting `queryLogs` behind a CRUD service hands
every caller a pass-through to whatever the adapter points at, and what belongs
there is a read *with a shape* — a window, a service, a level.

**`EdgeAnalytics`** — the nearest thing conceptually, and a stub.
`IEdge.analytics(zone, from, to)` answers four scalars
(`requests · cached · bandwidthBytes · threats`) for the `/dns/` screen, behind
`stubWarn('Edge', …)`. It is also the *CDN's* count and not the machine's, so it
cannot see a request the edge served from cache and cannot see one that never
went through the edge at all.

And the app-detail screen has been naming the gap out loud the whole time:

> `log-analysis` — nothing STORES a log line, so there is nothing to analyze.

---

## The precondition, which was broken

The nginx vhost `fli deploy:setup` writes declared **no `access_log` at all**, so
every app fell through to the machine-wide default. Two apps on one box wrote
into one file with nothing in a line saying which served the request.

That is not a missing feature, it is a working config with an invisible
consequence — `nginx -t` is green, the site serves, and the only symptom is that
the file cannot be read back. Filed and fixed as
[`FJS-622`](../ISSUES_ARCHIVE.md#fjs-622): a path per app, under `/var/log/nginx/` and
ending `.log`, which is the glob the packaged logrotate rule already bounds.

**Everything below depends on it**, which is why it went in ahead of the design
rather than as phase 1 of it.

---

## Prior art, and what the field concluded

**CapRover** (`caprover-frontend#167`) — nginx access logs, GoAccess, static HTML
reports fetched through an authenticated endpoint and shown in an **iframe
modal**. Configurable rotation, snapshot reports on a schedule (monthly by
default) plus more frequent *catch-up* reports covering everything since the last
rotation, and a manual refresh. Its own discussion is the most useful part:

> Real-time reports would require hosting separate websocket servers per
> app/domain, which seems wasteful

That conclusion transfers unchanged. GoAccess's real-time mode is a WebSocket
server per report; a fleet console wants N reports; the snapshot-plus-catch-up
compromise is the right one and we should not rediscover it.

**Coolify · Dokploy · Dokku** — container logs and, at most, per-app metrics.
None ships traffic analysis; Coolify's is a long-standing request. So this is
`stakes` rather than `parity`: it is not that the field does it better, it is
that CapRover does it and nobody else does it at all.

**Grafana Loki / Elastic** — the tier above. Ship the lines somewhere and query
them. Correct at scale and wrong here: it is a second system to run, and the
whole premise of this tree is a machine with SQLite on it.

**GoAccess itself** — one C binary, no daemon, reads `combined` with no
arguments, and emits HTML or `--json`. Its value is the parse of a text log
format, and Caddy's JSON lines need none — so it is not used here
([`FJS-D1621`](../DECISIONS.md#fjs-d1621)).

---

## Where we should depart from CapRover

**Not an iframe of generated HTML.** GoAccess's report is built out of log lines,
and a log line is full of caller-controlled text — user agents, referrers,
request paths. GoAccess escapes it; trusting a C binary's escaping inside an
admin console that holds fleet credentials is a bet with no upside, and a
sandboxed iframe is a mitigation for a problem we can simply not have.

The Outpost counts the lines itself and answers the numbers as data; ship them
as a service result, render them with `@frontierjs/ui`. That buys theming, the dark
mode switch, `.dense`, the vocabulary — and the numbers arrive somewhere a
service can gate them, which an iframe of bytes cannot be.

The cost is a renderer for panels GoAccess would have drawn. That is the trade and
it is worth taking once; it is not worth taking twice, which is the argument for
one component rather than a screen per panel.

**The topology differs and it changes the unit.** CapRover owns one Swarm nginx
and every app is a route inside it, so one GoAccess run over one log set covers
the fleet. FJS writes a **Caddy route per app**, on machines basecamp reaches
through the Outpost. So the unit is a report per app per machine, and *the fleet's traffic* is a sum somebody has to compute rather
than a file somebody can read.

---

## What FJS can answer that GoAccess cannot

nginx sees `POST /api/` and `200`. It does not know what that was.

Junction already knows. `requestLogger` is bound to `app.logger.child('http')`
and carries the correlation id; one layer in, `$.log` knows the **service and
method** (`orders.pay`), the principal and the tenant — and since `logbook`
phase 1 the audit row carries that same correlation id, so a request joins to the
writes it made.

So there are two different products here and they are routinely confused:

| | nginx + GoAccess | junction's own request log |
| --- | --- | --- |
| Unit | a URL | a service call |
| Sees | path, status, bytes, agent, referrer | that, plus who, which tenant, how long, what it wrote |
| Sees cached/static hits | yes | no — never reaches the app |
| Sees a WS frame | as one upgrade, for ever | as each call |
| Needs on the target | a binary | nothing |
| Effort | S | L, and it needs a store |
| Edge | `stakes` | `edge` |

**Neither subsumes the other.** GoAccess tells you a scanner is hammering
`/wp-login.php` — traffic the app never saw and has no opinion about. The
junction one tells you `orders.pay` got slow for one tenant, which nginx cannot
distinguish from `orders.find`.

The second one is the interesting half and it is blocked on the same question
`logbook` phase 4 was parked behind: **where does a request log land.** stdout is
where it goes today, and stdout is not queryable.

---

## The plan

Phases 1 and 2 are independent of 3. Do not start 3 to get 1.

**Working this plan.** One step per turn: take the first open box (`fli plan
IDEAS/traffic-analysis.md`), build it, run the package's own suite (`cd
packages/outpost && bun run test`, `cd packages/basecamp && bun run test`),
tick the box, run `fli done`, and stop with what landed and what is next. A box
that says **Ask first** is an owner question through `AskUserQuestion` before
any code. The owner commits; a step lands uncommitted.

### Phase 1 — the report exists (S)

The Outpost reads the app's Caddy JSON access log and counts it in JS
([`FJS-D1621`](../DECISIONS.md#fjs-d1621)). Nothing to install on the target.

- [x] 1.1 An Outpost route — `POST /analytics`, signed like every other route
  but `GET /health`, taking a route id and a window. It reads
  `accessLogPath(id)` (`/var/log/caddy/<id>.access.log`, plus Caddy's rolled
  files), keeps lines whose `ts` falls in the window (`FJS-D764`), and groups by
  `request.host` (`FJS-D763`). **Not `/exec`**: that runs an arbitrary command
  and this is a named capability with a bounded answer.
- [x] 1.2 The panels: status mix, top paths (`request.uri`), bandwidth
  (`size`), distinct client IPs (`request.client_ip`, never `remote_ip` — behind
  a proxied Cloudflare zone that is the edge's address), 4xx/5xx by path, and
  duration by path.
- [x] 1.3 Bounds and refusals: the id is checked against the route-id shape
  before it becomes a path; each panel answers its top 20; a read parses at
  most 100,000 lines, newest first, and says so (`truncated`, `oldest`) — the
  owner's pick over `/logs`' 5,000, which is minutes of a busy app. A missing
  log answers *no access log* by name; a window with no lines is an empty report.
  Routes are `fjs-<app>` (Outpost) or `fli-<app>[-api][-http]` (`fli deploy`) —
  the caller names the route, the reader adds no prefix.
- [x] 1.4 A test over a captured real Caddy line, so a renamed field fails
  red rather than drawing zeros.
- Retention is Caddy's roll, not ours, so the deepest history is whatever the
  roll keeps. Say so on the screen rather than implying more.

### Phase 2 — a screen that is not an iframe (S/M)

A basecamp panel on the app detail — the `log-analysis` tab the mock has and the
comment declines to build, now buildable.

- [x] 2.1 `apps.analytics()` in `packages/basecamp/api/src/services/apps/apps.service.ts`,
  beside `logs()` and shaped like it: resolves the executor, calls
  `/analytics` with the app's route id and a window, and degrades the same way
  when no executor resolves. *No access log* and *Outpost too old for
  `/analytics`* each reach the caller by name, not as an empty report.
- [x] 2.2 The `log-analysis` tab on `packages/basecamp/web/src/routes/apps/[id]/index.mesa`,
  replacing the comment that declines it. Drawn with the kit from 1.2's panels;
  **4xx/5xx by path** first, since it is the one that turns into a ticket.
  *Distinct client IPs* is labeled as that, never *visitors*.
- [x] 2.3 A window picker (24 hours, 7 days, everything the roll keeps) and a
  refresh button, with the roll's depth stated on the tab. No real-time and no
  snapshot-plus-catch-up: `FJS-D764` re-parses per request, so a refresh is the
  catch-up.
- [ ] 2.4 Proved in a real browser (`drive-browser`) against a dev basecamp
  whose Outpost reads a canned Caddy log: every panel draws, an app with no log
  says so. A throwaway probe; no drive kept.

### Phase 3 — the app's own view (L, and blocked)

Junction's request log as a queryable thing, per the table above.

Blocked on `logbook` phase 4's neighbourhood — a store for request-scoped lines.
Worth noting that `@@log` naming a SQLite model (shipped, phase 2) is most of the
mechanism: a request summary is a row, and the same window, gate and replication
story applies. What it is **not** is the audit trail — a read makes no write, and
the trail must not grow a row per GET.

**Do not start this to get traffic numbers.** Start it when the question is *which
service call is expensive for which tenant*, which is a different question with a
different audience.

- [ ] 3.1 **Ask first:** start Phase 3 now, or close the plan at Phase 2? If
  started, where a request summary lands — a `@@log`-named SQLite model per app
  (the plan's lean), stdout only, or Phase 3 struck. Blocked by the owner.
- [ ] 3.2 A request summary row per service call — service, method, principal,
  tenant, duration, status, correlation id — written by junction's request
  logger into 3.1's store. Not the audit trail: a read writes no audit row.
- [ ] 3.3 A read with a shape over it (window, service, tenant) and a basecamp
  panel: slowest service calls by tenant, joined to the audit trail by
  correlation id.

---

## What this owes the repo's own conventions

- **The Outpost route is signed** — every route but `GET /health` is, and an
  analytics read names an app and a window, which is enough to enumerate the
  fleet.
- **A report is not a row.** Nothing here belongs in the schema: the Outpost
  counts on each read and the log file is the source. Storing a parsed report would
  make it a cache with a staleness question and no way to answer it.
- **Degrade by name.** The three near-misses above all answer *nothing* where
  they mean *not wired*, and `resource.options()`'s `error` field is the settled
  shape for the difference. An app with no access log must say so.
- **No product analytics by accident.** *Unique visitors* is a count of distinct
  client IPs and must be labeled as that. The moment a design reaches for a cookie or a
  first-party script it has become a different feature with a consent story, and
  that is a decision, not a phase.

---

## Open questions

- ~~**Does the fleet get a sum?**~~ **Answered 2026-10-09 (`FJS-D762`): A — no fleet sum: the report is per app per machine, which is what the topology gives.** Per-app is what the topology gives cheaply.
  *Total traffic across the fleet* means fanning out to every machine and adding
  up, which is a different call with a different failure mode (one machine down
  = a wrong number, not an error). Probably a later row; certainly not phase 1.
  - **A** — no fleet sum: the report is per app per machine, which is what the topology gives.
  - **B** — a fleet total in basecamp that fans out to every machine and says how many answered (*3 of 4 machines*) rather than presenting a partial sum as the whole.
  - **C** — the fleet number from the edge, `IEdge.analytics()`.
  - **Recommend A** — then B once an operator asks for the total. A has no failure mode the per-app report does not already have; B's only honest form names the machines that did not answer, which is a design of its own. C counts the CDN, not the machines, and is a stub.
- ~~**`site/` and `widgets/` are surfaces with their own origins**~~ **Answered 2026-10-09 (`FJS-D763`): A — one log per route, as `packages/cli/core/edge.js` writes it, split at report time by the `request.host` every Caddy JSON line carries.** and the vhost
  writes one log per app, not per surface. A storefront's traffic and its
  console's traffic land in one file. Splitting them is another `access_log`
  line inside a `location` block and it is not obviously wanted.
  - **A** — one log per route, as `packages/cli/core/edge.js` writes it, split at report time by the `request.host` every Caddy JSON line carries.
  - **B** — a route and an access log per surface origin, the way `api` already gets `fli-<app>-api`.
  - **C** — no split: one report per app, surfaces mixed.
  - **Recommend A** — the hostname is already in every line, so the split derives at read time and a file per surface would restate it. The edge is Caddy now (`FJS-D598`), so the `access_log` and `location` mechanics this question was written against are gone either way.
- ~~**Where the window comes from.**~~ **Answered 2026-10-09 (`FJS-D764`): A — re-parse on each request, filtering lines by their timestamp to the window; the deepest history is whatever Caddy's roll keeps.** GoAccess parses whole files; asking for *last
  7 days* means either it re-parses each time or we keep its persisted database.
  CapRover chose the second and it is why they have a catch-up report at all.
  - **A** — re-parse on each request, filtering lines by their timestamp to the window; the deepest history is whatever Caddy's roll keeps.
  - **B** — GoAccess's persisted database on the target, restored and extended on each run.
  - **Recommend A** — then B once a re-parse is measured too slow. The paper's own *a report is not a row* is the reason: a persisted database is a parsed report kept between runs, a cache with a staleness question and nothing to answer it.
- ~~**Does `IObservability` absorb this or sit beside it?**~~ **Answered 2026-10-09 (`FJS-D765`): C — no interface: an Outpost capability read through `apps.analytics()`, the shape `apps.logs()` already has.** The interface already
  declares `queryLogs`. Answering GoAccess through it would make one adapter mean
  two unrelated things; a separate `IAnalytics` is cleaner and is one more
  interface nobody implements.
  - **A** — through `IObservability`, adding an analytics read to it.
  - **B** — a separate `IAnalytics` provider interface.
  - **C** — no interface: an Outpost capability read through `apps.analytics()`, the shape `apps.logs()` already has.
  - **Recommend C** — the plan's own phase 1 and 2 already describe C. A provider interface in basecamp is for a third party it speaks to, and GoAccess on the target reached through the Outpost is not one; `apps.logs()` is the owner that exists, and C adds no interface nobody implements.

---

## See also

- `IDEAS/shipped/logbook.md` — the sibling that shipped, and where the correlation id and
  the audit trail come from
- `IDEAS/lantern.md` — the third sibling: spans, and explaining a refusal
- `IDEAS/operational-edge.md` — the surrounding argument about what happens
  between *written* and *running observably in production*
- `packages/basecamp/docs/SCREENS.md` § D — the adapter tiers, and the mock's own
  `log-analysis` entry
- `packages/cli/commands/deploy/_steps-setup/05-nginx.md` — the vhost this all
  reads from
