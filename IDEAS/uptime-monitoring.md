---
id: uptime-monitoring
status: proposed
dated: 2026-09-29
---

# Idea — Uptime monitoring: Basecamp watches the URL, not only the machine

**Status: IDEA.** Probed against the tree 2026-09-29 (`VERIFYING.md`). Open item:
[`FJS-1557`](../ISSUES.md#fjs-1557).

Prompted by the owner's own practice: Kobami runs
[Uptime Kuma](https://github.com/louislam/uptime-kuma) beside Basecamp,
with 93 monitors (89 up, 4 paused) over Maid.Tech and Kobami client sites, one
notification target (*Maid.Tech Alerts*) and tags per client. Basecamp should
replace it. What that takes is below, and most of it already exists.

---

## What exists (probed)

| Piece | Where | Reused as |
| --- | --- | --- |
| Machine liveness: `lastHeartbeatAt`, sweep to `unreachable`, `server_unreachable` notification | `basecamp/api/src/jobs/server-reachability.job.ts` | **the shape of the probe job**: a cron, `@@transitions`-guarded state change, an event row, `notifyPeople` after the move |
| Threshold alerting over a metric series, with `no-data` ≠ resolved | `jobs/alert-evaluate.job.ts`, `metricsPlugin` (`FJS-956`) | latency alerts, unchanged — a probe writes `monitor.latencyMs{monitorId}` |
| Delivery: `NotificationChannel` (`slack pagerduty email webhook`) + per-person `NotificationPreference` | schema + `services/notification-preferences/kinds.ts` | down/up delivery, via a `MonitorChannel` join shaped like `AlertRuleChannel` |
| A one-shot app health probe | Outpost `POST /health-check`, called once by `deployment-run.job.ts:278` | nothing: that path is for deciding whether a deploy succeeded, and it asks from inside the box |
| `service_health` widget | `services/dashboards/kinds.ts` | superseded for URLs by an `uptime` widget |

**What is absent:** a scheduled probe of any URL, any stored probe result, an
uptime percentage, and any *down → up* state for a thing that is not a
`Server`.

---

## Scope: the parts of Kuma that were in use

This is read off the screenshots of the live install, not Kuma's feature list:

- **HTTP(s) monitor**: URL, method, headers, body, auth (none/basic/bearer)
- interval (120s), retries before down (2), retry interval, resend-while-down (0 = off)
- accepted status codes (`200-299`), max redirects, ignore TLS errors, **upside-down** (invert)
- certificate expiry notification
- tags (*Maid.Tech Client*, *Kobami Client*), pause
- a heartbeat bar per monitor, the Up/Down/Unknown/Pause counts, and the recent-events table (`200 - OK`, `Request failed with status code 502`)
- **a public status page, in use**: `uptime.kobami.cloud/status/sites-<48 random chars>`,
  titled *Kobami*, one group *Sites* with 79 distinct monitors (Kuma's API repeats
  them, 1174 rows), a description line pointing at cloudflarestatus.com, no
  tags, no incidents, no maintenance. The random slug makes it an **unlisted link**
  shared with clients, not a directory entry.

**Out of scope for phase 1:** Kuma's other monitor types (ping, DNS, docker,
push, keyword, game servers), proxies, maintenance windows, and multi-region
vantage points.

---

## Design

### Schema (basecamp `db/schema.lite`)

```
enum MonitorKind   { http tcp }
enum MonitorStatus { pending up down paused }
enum HttpMethod    { GET HEAD POST PUT PATCH DELETE }

model Monitor {
  id, workspaceId, workspace
  name            String  @trim @length(1, 200)
  kind            MonitorKind @default(http)
  // Optional: a monitor ABOUT an app. It is what lets the app page show its
  // uptime and a deploy mute its own monitor. Most of Kuma's 93 have no App row.
  appId           String?
  url             String  @trim @length(1, 2048)
  method          HttpMethod @default(GET)
  headers         Json    @default("{}")
  body            String?
  authSecretId    String?            // the NotificationChannel.secretId pattern
  auth            String? @transient // lifted into a Secret by the service
  intervalSec     Int     @default(120) @gte(60) @lte(86400)
  retries         Int     @default(2) @gte(0) @lte(10)
  retryIntervalSec Int    @default(120) @gte(60)
  timeoutMs       Int     @default(10000) @gte(1000) @lte(60000)
  acceptedStatus  String  @default("200-299")   // parsed by one owner, see below
  maxRedirects    Int     @default(10) @gte(0) @lte(20)
  ignoreTls       Boolean @default(false)
  invert          Boolean @default(false)
  certExpiryDays  Int?                          // null = no cert warning
  resendEvery     Int     @default(0) @gte(0)
  tags            Json    @default([])
  status          MonitorStatus @default(pending) @system
  failStreak      Int     @default(0) @system
  lastCheckedAt   DateTime? @system
  nextCheckAt     DateTime? @system
  lastLatencyMs   Int?    @system
  @@transitions(status, …)   // pending→up|down, up⇄down, *→paused, paused→pending
  @@gate(...)                // the workspace's operator standing, as AlertRule
}

model MonitorCheck {          // one per probe; the heartbeat bar
  id, monitorId, at DateTime, ok Boolean, statusCode Int?, latencyMs Int?, message String
  @@index([monitorId, at])
}

model MonitorEvent {          // one per STATE CHANGE: the incidents table
  id, monitorId, at, from MonitorStatus, to MonitorStatus, message String
}

model MonitorChannel { monitorId, channelId }   // AlertRuleChannel's shape
```

`MonitorCheck` is raw and short-lived, like `MetricPoint`: kept 48h and rolled
into `MonitorHour { monitorId, hour, checks, fails, latencyAvg }` for the 30-
and 90-day uptime %. The existing `retention.job.ts` does the prune.

**Tags stay (owner, 2026-09-29).** A tag is a label on a monitor, not a
workspace: `tags Json @default([])`, filterable on the list screen. The importer
carries Kuma's `monitor_tag` over by name.

### The probe: `jobs/monitor-sweep.job.ts`

- Cron `* * * * *`, the reachability job's shape. It picks
  `status != paused AND nextCheckAt <= now` across workspaces via `asSystem()`,
  bounded concurrency (~16), with a per-probe `AbortSignal.timeout(timeoutMs)`.
- **The grader is pure and exported**, `gradeProbe(monitor, response|error) → {ok, message}`,
  with no DB and no clock, as `core/alerting.ts` already is. It owns status-range
  parsing (`200-299,301`), invert and redirects. It is the one owner of *is this a
  failure* (Invariant 4) and it is where the unit tests go.
- **State machine**: `ok` resets `failStreak` and moves `down → up`. A failure
  increments the streak and moves to `down` only past `retries`, and while it
  retries, `nextCheckAt` uses `retryIntervalSec`. The move goes through
  `transition` for the same race reason reachability gives. Then a `MonitorEvent`,
  then delivery.
- Writes `monitor.latencyMs{monitorId}` to the metric store, so an `AlertRule`
  on *latency > 2s for 5 minutes* works with no new code.
- **Cert expiry**: the probe reads the peer certificate's `valid_to` (a
  `node:tls` connect on https; Bun's `fetch` does not expose it). It warns once
  per threshold crossing, recorded on a `MonitorEvent`.
- **Vantage**: the probe runs from the Basecamp API process. That is an outside
  view, which is the point, and it is what Kuma was. A probe from an Outpost (for
  private targets) is a later `vantage` column, not phase 1.
- **A deploy mutes its app's monitor.** `deployment-run` pauses it for the
  rollout and puts it back to `pending`. Otherwise every deploy pages.

### Delivery

Two new kinds in `notification-preferences/kinds.ts`, `monitor_down` and
`monitor_up`. The same two-addressee split as `alert-evaluate`: the monitor's
channels page the workspace, and members get a `Notification` they can mute.
`resendEvery > 0` re-sends while down.

### UI (`web/`)

- `src/resources/Monitor.mesa` with its default form. The Kuma edit screen maps
  field for field: General / Advanced / HTTP Options / Auth / Notifications.
- `routes/monitors/index.mesa`: the Up/Down/Pending/Paused counts, a list with the
  heartbeat bar (the last 50 `MonitorCheck`s), and the recent `MonitorEvent`s.
- `routes/monitors/[id]/index.mesa`: a latency chart from `MonitorHour`, 24h / 30d /
  90d uptime %, and cert expiry.
- The App detail page shows its monitor's bar.
- `WidgetKind.uptime` (a migration, as the enum comment says it costs).

### Import from Kuma: `fli` script or a Basecamp setup step

Kuma is SQLite (`data/kuma.db`). Its `monitor` table maps almost 1:1:
`url, method, interval, maxretries, retry_interval, accepted_statuscodes_json,
max_redirects, ignore_tls, upside_down, expiry_notification, resend_interval,
active`, plus `monitor_tag → tag` and `monitor_notification → notification`.
Import once, run both side by side for a week, and compare the down events
before Kuma is turned off.

---

## Phases

1. **Probe + state + delivery.** The schema, `monitor-sweep`, the pure grader
   with tests, the two notification kinds, and the list and edit screens.
   *Proves:* a monitor on a URL that returns 502 goes down after N retries and
   the channel gets one message, then one on recovery.
2. **History.** `MonitorHour`, uptime %, the detail chart, the widget, the App
   link and deploy muting.
3. **Kuma import**, then cert expiry.
4. **Status pages: required, since one is live.** `StatusPage { workspaceId, title,
   description, slug @unique, isPublished }` + `StatusPageMonitor { statusPageId,
   monitorId, group, position }`. It is served at an unauthenticated route that
   reads ONLY the page's projection: monitor name, current status, the last 90
   daily bars. Never the URL, headers or messages, because a probe URL can carry
   a token. That is the first no-login page in Basecamp, so the projection is a
   service method with its own gate level rather than a filtered `Monitor` read
   (Invariant 6). The slug is minted random (the capability-URL shape the live
   link already has). The importer carries the existing slug over, so the link
   clients hold keeps working once DNS moves. Incidents and a custom domain come
   later.

## Why not Orion

Orion (`FJS-D269`) is a workspace's own automation, run as a member. Paging is
the fleet watching itself. It must not depend on a half-ported engine or on a
member's standing, which is the argument `alert-evaluate` makes for being a job.
Orion is the right place for a *reaction*: a flow triggered by `monitor_down`
that restarts the app or posts to chat. That wants a `monitor.down` event
announced onto the bus, which phase 1 should emit anyway.

## Settled with the owner (2026-09-29)

- **Tags** are kept as monitor labels, not mapped to workspaces.
- **Interval floor 60s.** One minute cron, one sweep. The importer raises any lower Kuma interval to 60.
- **Status pages** are in scope: one is live (phase 4).
