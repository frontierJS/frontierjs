---
id: traffic-analysis
status: proposed
dated: 2026-08-31
---

# Idea — `beacon`: who is hitting this app, and how

**Status: IDEA.** Probed against the tree 2026-08-31 (`VERIFYING.md`). One
precondition shipped with it — [`FJS-622`](../ISSUES.md#fjs-622) — because the
gap it names made every option here impossible rather than merely unbuilt.

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
buffer is the whole retention, and [`FJS-616`](../ISSUES.md#fjs-616) is the
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

> `log-analysis` — nothing STORES a log line, so there is nothing to analyse.

---

## The precondition, which was broken

The nginx vhost `fli deploy:setup` writes declared **no `access_log` at all**, so
every app fell through to the machine-wide default. Two apps on one box wrote
into one file with nothing in a line saying which served the request.

That is not a missing feature, it is a working config with an invisible
consequence — `nginx -t` is green, the site serves, and the only symptom is that
the file cannot be read back. Filed and fixed as
[`FJS-622`](../ISSUES.md#fjs-622): a path per app, under `/var/log/nginx/` and
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
arguments, and emits HTML **or `--json`**. That last point matters more than
CapRover's design suggests.

---

## Where we should depart from CapRover

**Not an iframe of generated HTML.** GoAccess's report is built out of log lines,
and a log line is full of caller-controlled text — user agents, referrers,
request paths. GoAccess escapes it; trusting a C binary's escaping inside an
admin console that holds fleet credentials is a bet with no upside, and a
sandboxed iframe is a mitigation for a problem we can simply not have.

`goaccess --json` answers the same numbers as data. Parse it, ship it as a
service result, render it with `@frontierjs/ui`. That buys theming, the dark
mode switch, `.dense`, the vocabulary — and the numbers arrive somewhere a
service can gate them, which an iframe of bytes cannot be.

The cost is a renderer for panels GoAccess already draws. That is the trade and
it is worth taking once; it is not worth taking twice, which is the argument for
one component rather than a screen per panel.

**The topology differs and it changes the unit.** CapRover owns one Swarm nginx
and every app is a route inside it, so one GoAccess run over one log set covers
the fleet. FJS writes a **vhost per app**, on machines basecamp reaches through
the Outpost. So the unit is a report per app per machine, the binary has to exist
on each target, and *the fleet's traffic* is a sum somebody has to compute rather
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

### Phase 1 — the report exists (S)

`goaccess --json` on the target, run through the Outpost, parsed here.

- An Outpost route — `POST /analytics`, signed like every other route but
  `GET /health`, taking an app id and a window. It runs GoAccess over that app's
  own access log and answers parsed JSON. **Not `/exec`**: that runs an arbitrary
  command and this is a named capability with a bounded answer.
- The binary is a **precondition, reported rather than assumed** — a missing
  GoAccess must answer *not installed* by name. `fli deploy:doctor` already
  checks a tool list on the target and is where that belongs.
- Retention is nginx's, not ours: the logrotate rule bounds the window, so the
  deepest history available is whatever `rotate` is set to. Say so on the screen
  rather than implying more.

### Phase 2 — a screen that is not an iframe (S/M)

A basecamp panel on the app detail — the `log-analysis` tab the mock has and the
comment declines to build, now buildable.

- One `apps.analytics()` custom method, shaped like `logs()`, degrading the same
  way when no executor resolves.
- Rendered from the parsed numbers with the kit. The panels worth having first
  are the ones an operator acts on: status mix, top paths, bandwidth, unique
  visitors, and **4xx/5xx by path**, which is the one that turns into a ticket.
- Snapshot plus catch-up, per CapRover's own conclusion. No real-time.

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

---

## What this owes the repo's own conventions

- **The Outpost route is signed** — every route but `GET /health` is, and an
  analytics read names an app and a window, which is enough to enumerate the
  fleet.
- **A report is not a row.** Nothing here belongs in the schema: GoAccess owns
  the aggregation and the log file is the source. Storing a parsed report would
  make it a cache with a staleness question and no way to answer it.
- **Degrade by name.** The three near-misses above all answer *nothing* where
  they mean *not wired*, and `resource.options()`'s `error` field is the settled
  shape for the difference. An app with no GoAccess must say so.
- **No product analytics by accident.** *Unique visitors* is GoAccess counting
  IPs and must be labelled as that. The moment a design reaches for a cookie or a
  first-party script it has become a different feature with a consent story, and
  that is a decision, not a phase.

---

## Open questions

- **Does the fleet get a sum?** Per-app is what the topology gives cheaply.
  *Total traffic across the fleet* means fanning out to every machine and adding
  up, which is a different call with a different failure mode (one machine down
  = a wrong number, not an error). Probably a later row; certainly not phase 1.
- **`site/` and `widgets/` are surfaces with their own origins** and the vhost
  writes one log per app, not per surface. A storefront's traffic and its
  console's traffic land in one file. Splitting them is another `access_log`
  line inside a `location` block and it is not obviously wanted.
- **Where the window comes from.** GoAccess parses whole files; asking for *last
  7 days* means either it re-parses each time or we keep its persisted database.
  CapRover chose the second and it is why they have a catch-up report at all.
- **Does `IObservability` absorb this or sit beside it?** The interface already
  declares `queryLogs`. Answering GoAccess through it would make one adapter mean
  two unrelated things; a separate `IAnalytics` is cleaner and is one more
  interface nobody implements.

---

## See also

- `IDEAS/logbook.md` — the sibling that shipped, and where the correlation id and
  the audit trail come from
- `IDEAS/lantern.md` — the third sibling: spans, and explaining a refusal
- `IDEAS/operational-edge.md` — the surrounding argument about what happens
  between *written* and *running observably in production*
- `packages/basecamp/docs/SCREENS.md` § D — the adapter tiers, and the mock's own
  `log-analysis` entry
- `packages/cli/commands/deploy/_steps-setup/05-nginx.md` — the vhost this all
  reads from
