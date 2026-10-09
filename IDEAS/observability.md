---
id: observability
status: shipped
dated: 2026-10-08
---

# Idea — observability: four streams that already exist, and the one id that should join them

**Ruled 2026-10-08 as `FJS-D660`: A is built**, with the inbound-trust question answered by format rather than by proxy position. B and the renames below are still open.

Dated 2026-10-08. Written for wave 5 of the
vocabulary atlas ("papers before nouns"): the nouns for this region come from
here. Every claim marked *measured* was produced by running a probe against
`packages/junction` on this date; the rest is cited `file:line`. Do not cite
this file as describing behavior — see `VERIFYING.md`.

It is the umbrella over four siblings and replaces none of them:
[`logbook.md`](logbook.md) (the log line and the trail — phases 0–3 shipped),
[`lantern.md`](lantern.md) (the span tree and *why was this refused*),
[`alerting.md`](alerting.md) (a reading crossed a line; something threw) and
`overview.md` 2.4b `beacon` (traffic). Each of those owns one stream. **None of
them owns the join**, and the join is the gap this paper is about.

---

## 1. What exists (measured, not read off a status file)

| Stream | Owner | State |
| --- | --- | --- |
| **Log** — what the process says | `junction/src/core/logger.ts:139` `createLogger`; `$.log` is `callLogger`, `context.ts:829` | Leveled, `child(ns, bound)`, writers. *Measured*: a `$.log.info` inside `p.find` writes `ns:"p.find"` and binds `correlationId` |
| **Trail** — what the Data boundary records | litestone `@@log(audit)`, `core/audit-log.js:66` (`correlationId` column, indexed `:85`) | Stamped per write by junction's `installLogContext`, `core/litestone.ts:3973` — correlationId, source, origin, ip, tenant, actor |
| **Metric** — a number about the process | `app.registerMetricsSource(name, fn)`, `core/app.ts:513/1452`; `GET /metrics`, `transport/health.ts` (JSON, Prometheus text by `Accept`, `:367`) | Pulled per request. The `metrics` plugin (`plugins/metrics/index.ts`) keeps readings — `counter`/`gauge`, labels, minute rollup (`FJS-956`). Sources today: outbox, backfills, commitments, metricsStore |
| **Health** — may traffic be sent here | `app.registerHealthCheck(name, fn)`, `core/app.ts:526/1456`; `GET /health` 200/503 | A plugin declares the check for the resource it owns (outbox does, `plugins/outbox/index.ts:173`) |
| **Telemetry events** — the in-process stream | `app.telemetry.emit/on`; `junction.call.start/.end`, `junction.hook`, `litestone.query`, `junction.ws.*` (`core/service.ts:620/750`, `transport/channels.ts:1282`) | Zero-cost when nobody listens. One reader: `devtools()` (`plugins/devtools/index.ts:190`), its own port, a 200-entry ring |
| **Trace** — the W3C context | `RequestMeta.traceparent/tracestate`, `core/context.ts:435` | Carried verbatim, parsed nowhere in junction (`FJS-D459`). Conduit is the only reader: continues an upstream trace, else derives a trace id from correlationId |
| **Correlation** | `correlationId()` plugin, `transport/middleware.ts:445` (`ctx.requestId`); `RequestMeta.correlationId` (`core/app.ts:909`) | Reaches the log line, the trail row, the caravan job row (`caravan/src/types.ts:92`) and MCP's job await (`mcp/src/plugin.ts:206`) |

**Junction emits nothing outward.** No exporter, no span id minted, no OTLP —
`context.ts:431` says so: "junction traces nothing itself."

## 2. The gap, as a failure a real app hits

A request arrives from a load balancer or a browser SDK carrying
`traceparent: 00-4bf92f35…4736-00f067aa…-01` and no `x-request-id`. The
service logs, writes a row, and calls Stripe through conduit. *Measured* today:

- the `$.log` line carries `correlationId: "67ef4a5e-42a5-…"` — a fresh UUID;
- the trail row carries the same UUID (it reads the same `requestMeta()`);
- the outbound Stripe call carries trace `4bf92f35…4736` (conduit continues the
  upstream trace — `conduit/junction-integration.test.ts:447`);
- the inbound trace id appears on **no** log line and **no** trail row.

So an operator holding the trace id from the vendor's dashboard cannot find the
log line, and one holding the log line cannot find the trace. Two ids for one
request, and nothing reports that they disagree — § V's ninth question, answered
*none*. With no upstream header the two coincide only because conduit derives
its trace id from the correlationId (`FJS-D459`); the agreement is an accident
of one reader, not a property of the request.

The second failure is shallower and older: four streams, four readers.
`/metrics` and `/health` are pull endpoints, telemetry events reach only
devtools' ring, logs reach stdout, the trail reaches JSONL or a table. An app
that already runs Grafana/Honeycomb/Datadog has no way in short of writing a
`LogWriter`, a `telemetry.on` listener and a scraper — three adapters for one
destination.

## 3. Options

**A — One id, everywhere: the trace id IS the correlation id.**
When a request states `traceparent`, its trace id (32 hex) becomes
`correlationId`; with none, junction mints a W3C-shaped id and keeps it as
both. `traceparent` stays carried verbatim for the span half (`FJS-D459` holds:
the parse is of the trace-id field alone, done once, in the owner that already
assigns `correlationId`, `core/app.ts:909`). Every existing consumer — `$.log`,
the trail, caravan, MCP, conduit — is unchanged and starts agreeing.
*Spelling*: no new API; `requestMeta().correlationId` is the trace id.
*Cost*: S — one assignment, one test that drives the scenario in § 2 and asserts
log line, trail row and outbound header share an id.
*Refuses*: spans, export, sampling. Answers *find everything about this
request*, not *where did the time go*.

**B — A, plus one outward door: `telemetry({ export })`.**
One plugin is the only translator from the four streams to the outside, in
OTLP/JSON over `fetch` (no SDK dependency — `FJS-D26`'s budget): log entries via
a writer, `junction.call.*`/`junction.hook`/`litestone.query` as spans (lantern
phase 1's tree, parented by the inbound `traceparent`), metric sources as
gauges on the metrics plugin's existing scrape clock. Health stays a pull
endpoint — a load balancer asks; nothing should push it.
*Spelling*: `app.configure(telemetry({ endpoint, headers, sample }))`, or
`telemetry: { endpoint }` in `junction.config.js` beside `devtools`.
*Cost*: M. *Refuses*: storing or viewing anything in-app (that is lantern
phase 3/4); the trail never exports — it is a record, not telemetry, and
Invariant 7's redaction would become a second owner the moment it left.

**C — A native observe store and viewer.**
Lantern's store, logbook's reader and the metrics store merged into one
`observe` database with a Studio-like viewer. *Cost*: L, and it duplicates three
papers' phases under a new name. *Refuses*: nothing — which is its defect: it
competes with every vendor and wins against none of them on the parity half.

**Recommend A now, B second — why.** A is the defect: two ids for one request,
measured, with a one-line owner. It needs no noun and no option (§ V 2, 3), it
is derived rather than restated (§ V 5), and it turns a silent disagreement into
a test (§ V 9). B is the battery that makes the existing streams leave the
process; it is the paved road against the workaround (§ IV) — three hand-written
adapters per app otherwise. C fails § V 2 and *batteries vs. smallness*; the
position this framework can take is lantern's *why was this refused*, not a
fourth metrics UI. Tier: Assessment until A lands; A's ruling then goes to the
Register.

## 4. The trail is not the log

Stated once here because every umbrella paper blurs it. **The trail** is a
record the Data boundary owes — retained by declaration (`retention 90d`),
redacted by declaration, backed up with the database, read by Actor and row.
**The log** is what the process says, disposable, capped, shipped to stdout or a
writer. They share the correlation id and nothing else: no export of the trail
(B refuses it), no audit semantics on a log line, no log level on a trail row.
`@@log(audit)` spelling the trail with the word *log* is itself a collision
(below).

## 5. Nouns coined, and every collision

| Noun | Sense here | Collides with | Proposal |
| --- | --- | --- | --- |
| **Signal** | OpenTelemetry's word for *one kind of telemetry* (logs, metrics, traces) | **Mesa's Signal** — blessed, UI, `FJS-D44`, "never crosses a Boundary". Also `AbortSignal` (conduit, outpost) and process signals (`outpost/src/index.js:51`) | **Refuse it.** This paper says *stream*, and only in prose. A UI noun that "never crosses a Boundary" cannot also name the thing whose whole job is crossing one. An OTLP field named `signal` stays inside the exporter |
| **Trace** | the W3C trace id of one request, = correlationId under A | lantern's "trace" (the span tree, a viewer artifact); `traceparent` (the header) | Trace = the id and everything stamped with it; the tree is *spans*. Under A, propose renaming `correlationId` → `traceId` in one change (no alias) — **owner question** |
| **Span** | one timed unit inside a trace (B) | toolbelt `datetime` "span" (a constant-offset interval, `datetime.d.ts:63`) and `match` span | Different realms, no shared reader; accept, note in VOCABULARY |
| **Telemetry** | the in-process event stream `app.telemetry` | blessed **Event** (what Junction announces on a Channel) — `junction.call.end` is called an event and is not one | Keep *telemetry* as the stream's name; call its items *telemetry records*, never events |
| **Trail** | the audit trail | `@@log(audit)` and the `logger` database driver spell it *log*; Actor (`FJS-D633`) already says "the audit trail" | Trail is the noun; whether `@@log` becomes `@@trail` is an owner question |
| **Check** (health) | `registerHealthCheck` | `fli check` (arch-test surface, `FJS-D133`); uptime-monitoring's external probe | Rename candidate: *readiness* — `registerReadiness(name, fn)`; `/health` stays the route |
| **Metric / Reading** | a named number / one timestamped value of it | basecamp's `AlertRule`/`AlertEvent` (an Event again) | Reading for the value (alerting.md already uses it); AlertEvent is basecamp's, app-local |
| **Snapshot** | the trail's `before`/`after` | blessed **Snapshot** (committed `*.snapshot.*` file) | Already live in Invariant 7's wording; flag for wave 5, do not fix here |
| `requestId` | `ctx.requestId`, `middleware.ts:455` | correlationId (same value, second spelling — logbook noted it) | Folded by A's rename |

## 6. Open questions for the owner

- ~~**A's rename**~~ **Answered 2026-10-09 (`FJS-D661`): kept; an adopted `x-request-id` is not a trace id, so `traceId` would be false there.** `correlationId` → `traceId` across junction, litestone's trail
  column, caravan's `correlation_id`, MCP and conduit in one change — or keep
  `correlationId` as the name and only change its value?
- ~~**Inbound trust**~~ **Answered 2026-10-09 (`FJS-D660`): adopt when well-formed.** A public endpoint adopting a caller's trace id lets a
  client choose the id its trail rows are filed under. Adopt always, adopt only
  behind a configured proxy, or adopt into `traceparent` but mint our own
  correlationId and record the link?
- ~~**`x-request-id` vs `traceparent`**~~ **Answered 2026-10-09 (`FJS-D660`): `traceparent` wins.** Which wins when both arrive and disagree?
- ~~**Is B a junction plugin or its own package?**~~ **Answered 2026-10-09 (`FJS-D662`): a junction plugin, `otlp()`.** Junction is Bun-only and
  already owns `/metrics`; a package would be the first observability battery
  outside it.
- ~~**Health → readiness rename**~~ **Answered 2026-10-09 (`FJS-D661`): renamed to `registerReadiness`.** Worth the churn, or is the `fli check`
  collision tolerable because the two never share a reader?
- ~~**`@@log(audit)` → `@@trail`?**~~ **Answered 2026-10-09 (`FJS-D661`): renamed, with `@trail`, `driver trail` and `db.auditTrail`.** The seed is where the word is first met.
