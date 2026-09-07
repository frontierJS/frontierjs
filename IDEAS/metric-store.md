---
id: metric-store
status: partial
dated: 2026-09-06
---

# Idea — A metric store: the time dimension nothing here has

**Status: PROPOSED.** Dated 2026-09-06. Probed against the tree rather than
recalled; every claim about what exists names the file it was read from.

`FJS-123` has been open since 2026-08-08 saying nothing evaluates an alert rule.
That reading was right and incomplete: **the evaluator is not blocked on effort,
it is blocked on there being nothing to evaluate.** A rule reading *CPU above 80%
for five minutes* needs a window, and no window exists anywhere in this repo.

---

## What is already true

The production half is built and is better than its reputation. Six sources
register into one `/metrics` through `registerMetricsSource`
(`packages/junction/src/core/app.ts`) — conduit, caravan's jobs, backfills, the
outbox, litestone and the app itself — with `registerHealthCheck` beside it. An
outpost heartbeat writes `Server.health`, `dockerState` and `actualSpecs`.
Basecamp models the whole alert chain with real gates and a service that really
delivers: `AlertRule` → `AlertRuleChannel` → `NotificationChannel` →
`AlertEvent`.

**What none of it keeps is a second reading.** `packages/basecamp/db/schema.lite`
says so about itself — *nothing here stores a time series, so a heartbeat's CPU
is the last reading rather than a line* — and the schema enforces that sentence
structurally: `DiskUsage` carries `@@unique([serverId])`, one row per server, so
yesterday's reading is not stale, it is gone.

So four things are missing and they are one chain. There is no time dimension;
therefore no threshold can be evaluated; therefore `AlertEvent` is written by
nothing; therefore three widget kinds say *no trend* on their own cards. One
missing owner holds five built things shut.

---

## The standard to follow

**The data model is [OpenMetrics 1.0](https://prometheus.io/docs/specs/om/open_metrics_spec/)**
and it should be adopted verbatim rather than approximated: a metric is
`name{labels} → (timestamp, value)` carrying a type drawn from a closed set.
The name is a dotted path whose every segment is camelCase, which is not a
choice so much as an observation: the flattener walks the collector's own
object and those keys already are `memoryMb` and `heapUsedMb`, so any other
convention would be a second spelling of every name in the store.
Taking the ecosystem's words here is not a familiarity concession, because these
words do not half-fit — a counter and a gauge differ in exactly the way this
design has to care about. The payoff is that `/metrics` already speaks it, so an
external scraper can read an FJS app and an FJS app can read any exporter.

**The storage shape is a narrow table behind a series id**, which is what
Prometheus does internally and what every SQL treatment of the problem converges
on. SQLite is not the weak link: with an integer epoch key it carries this
volume without partitioning, and the shape only matters past a hundred million
rows — which this will not see, and which is the reason not to build a TSDB.

**The retention shape is RRDtool's**: fine grain for a short window, rolled up
coarse for a long one, so storage is bounded by design rather than by somebody
remembering to prune.

---

## The design

### Two models, and the split is the whole thing

```
model MetricSeries {
  id          Int          @id @default(autoincrement())
  name        String                        // "process.memoryMb" — camelCase segments
  labels      Json         @default("{}")
  labelsKey   String       @unique          // canonical hash of name + labels
  type        MetricType
  unit        String?
  lastSeenAt  DateTime
}

model MetricPoint {
  seriesId    Int
  at          Int          @big             // epoch ms
  value       Float
  series      MetricSeries @relation(fields: [seriesId], references: [id])
  @@id([seriesId, at])
}
```

**Labels are stored once per series and never per point.** A million readings of
`cpu{server=abc}` cost one label row, and that single decision is the difference
between SQLite being comfortable here and SQLite being the wrong tool.

`@@id([seriesId, at])` does three jobs at once. It is the range-query index, it
is the natural key, and it makes a re-scrape a no-op instead of a duplicate —
which matters because the scrape is a cron and a cron fires twice eventually.

### A series is minted, never declared

No developer writes a `MetricSeries` row. The scrape reads `/metrics`, hashes
`name` plus `labels`, and upserts. This is the difference between the schema
carrying a list of metrics — which would go stale the first time a plugin added
one — and the schema carrying the *shape* of a metric, which cannot.

### Tenancy is on the series and nowhere else

`MetricPoint` has no tenant column. Its policy is a one-hop relation to
`MetricSeries`, which is exactly what `FJS-499` built and measured: a hop trades
a copy for a join, and the EXPLAIN assertion that the parent is reached by its
key already exists. Access declared once, at the Data boundary, which is what
Invariant 6 requires the moment a human reads a metric on a scoped dashboard.

This is also why the store is litestone models rather than a private database
in caravan's style. Caravan gets away with `jobs.db` because a job is not a
per-tenant user-facing read. A metric is.

### Two tiers, and the third is earned rather than assumed

Raw at one-minute resolution for 48 hours, folded to hourly rows kept for
thirteen months. A five-minute tier is what gets added when a dashboard proves
it needs one, and not before.

Fixed tiers also sidestep the read-side unknown: **litestone has no time
bucketing in its aggregate surface**, and with tiers it never needs one — the
bucketing happens once, in the rollup job, in JavaScript, and every read is a
plain range scan on whichever tier answers.

### The store declares no retention, deliberately

`database` blocks take `retention`, and it is per-database
(`packages/litestone/src/core/client.js`, the registry is keyed by database
name). Using it here would be wrong twice over: the two tiers want different
windows, and a declared sweep deletes on a clock rather than on whether the
rolled row committed. **Raw points may only be deleted after the hourly row that
covers them exists.** That ordering is the job's, and it cannot be delegated to
a policy that knows nothing about the fold.

---

## Three traps, ranked by what they cost to get wrong later

**Counter resets, and the design got the TIMING of this wrong.** Store the
cumulative value and apply Prometheus's rule — on a drop, the new value is
itself the increase; storing deltas cannot survive a missed scrape. What this
document first said was *detect the reset at read*, and that is not possible
here: **a reset is visible only as a drop between two adjacent raw points, and
the fold is the last moment those exist.** Once the hour is written and the raw
pruned, the drop is gone and no reader can ever recover the figure. So the
increase is computed at FOLD time and stored — `MetricHour.increase`, null for a
gauge — which inverts the usual arrangement where the aggregate is cheap and the
detail is kept.

**Histograms have to be decided before the first row.** A p99 cannot be
recovered from averaged samples. Percentiles need bucketed cumulative counters
stored from the beginning, so *are latency percentiles in scope* is a question
this design has to answer now — retrofitting is not a migration, it is
data that was never written.

**Cardinality is unbounded unless something bounds it.** `labelsKey @unique`
deduplicates but does not refuse, so a caller minting a series per request id
fills the disk quietly. A cap belongs in the write path, refusing by name.

---

## What makes it visible when it is wrong

Three ways this fails in silence, and the artefact against each. They are the
design's real content, because a metric store that lies is worse than none.

**A rollup that drops points just looks like a smoother graph.** The fold
asserts that the summed raw window equals the rolled row before any raw point is
deleted.

**A cardinality explosion looks like nothing until the disk fills.** The series
count is itself published through `registerMetricsSource`, so the store reports
on itself through the same seam it is fed by.

**A scrape that stopped looks exactly like a healthy flat line.** This is the
one that would have been missed: the fix is Prometheus's `up` — a synthetic
metric written by the scraper itself, one per target, so *no data* and *no
change* stop being the same picture. `MetricSeries.lastSeenAt` is the column
that makes staleness answerable without a scan.

---

## What it unblocks

`AlertRule.condition` becomes evaluable · the evaluator (`FJS-123`) becomes
writable · the alert fan-out finally has something to fan · three widget kinds
stop declaring their own blindness on the card · `DiskUsage` can answer *we
cleaned the fleet last Tuesday*, which its own comment says is the question a
filling disk asks.

---

## Cost, stated plainly

Three nouns — `MetricSeries`, `MetricPoint`, `MetricType` — and they retire
none. That is the honest price, and it is paid in an application's schema rather
than in the framework's grammar. **No `@@rollup` keyword, and no new driver.**
A metric store that added a word to the `.lite` language would stop being a
battery and become part of the core, which the standing adjudication on
batteries forbids: it must be severable, and deleting these models plus one job
must leave nothing behind.

The rollup tier restates four columns of `MetricPoint`, and nothing in litestone
can derive one table's shape from another's. That restatement is the cost of
refusing the keyword, and it is the cheaper of the two.

---

## What building it in `example` found

Three things the design got wrong, all found by running it rather than reading it.

**`asSystem()` is level 8, and 9 is locked to the ORM entirely.** The models were
first written `@@gate("5.9.9.9")` on the reasoning that every write is the
scrape's and no caller should reach them. That gate locks out the rollup's own
prune: 9 means *unreachable through the ORM by anything*, which is right for a
ledger entry that must never be restated and exactly wrong for a store whose
whole design is that it gets pruned. `5.8.8.8` is the honest spelling of
system-only.

**A second declared `database` does not survive `strategy database` tenancy**
(`FJS-958`). The declared path produced no file — the tables were created inside
the tenant's own database, because a non-shared database is redirected per
tenant — and then every write to a model on it deadlocked with `database is
locked`, while reads answered normally. Measured against a control in one
process on a fresh tenant: a `@@db(main)` write succeeds and both `upsert` and
plain `create` on the second database fail. So the three models sit on `main`
here, which costs the write isolation the separate file existed for.

**A registrar with no reader is half a seam.** `registerMetricsSource` had no
counterpart: the only ways out of `_metricsSources` were an HTTP round trip to
this process's own port or a reach into a private map. `collectMetrics` and
`renderPrometheus` are now exported from junction, which is what makes an
in-process scrape possible at all.

The fold and its guard hold as designed, measured: two hours of sixty points
each fold with count, sum, min and max preserved, and only the hour past the
48-hour raw window is pruned while the recent hour is folded and kept.

---

## The drive, and what it measures

`example`: `verify:metrics` — bun, no server, no browser, no seed; it makes its
own tenant and drops it. Thirty-two assertions.

**Every row is paired with the wrong answer somebody writes first**, because
nothing in this store fails loudly: a fold that loses a point draws a smoother
graph, and a scrape that stopped is the same flat line as a value that is not
moving. A drive that only checked the correct value would pass against the naive
implementation too.

**The pair that does the work is not the obvious one.** Clamping each delta at
zero — the patch everybody reaches for after seeing a negative rate — gives the
CORRECT answer whenever a counter resets to exactly 0, because the dropped delta
was going to be discarded anyway. The two implementations diverge only when the
counter is scraped after it has already climbed off zero, so that is the case
the drive turns on. Measured against stubs: naive `last − first` reds 6 rows,
the per-delta clamp 2, `isStale` always-fresh 2, and a rate answering 0 over no
elapsed time 1 — the last of which found a dead row, since `counterRate([])`
returns early and never reaches the span guard it was written to grade.

---

## Where it should be proven

`example`, because it is the kitchen sink and already has caravan, a retention
job on a schedule, and a drive per feature area. Basecamp is the consumer that
wants it, but `example` is where a framework change gets found — and the two
assertions that need a real run are the fold preserving totals and a counter
surviving a reset, neither of which a unit test over a fixture can stage
honestly.

---

## Where it lives, which was the second thing this got wrong

It was first written into `example`'s own schema, with a note that basecamp is
where it is actually needed. That note was the design error: two apps needing
one model is not a note, it is a package fragment, and copying it would have
been the *two spellings of one fact* this repo files issues about.

**Junction ships it** — `db/metrics.lite`, imported by both apps exactly as
`outbox.lite` and `auth/schema.lite` already are. Junction owns the seam either
way: `registerMetricsSource` collects, `collectMetrics` reads, and the models
are where that reading is kept. The pure half moved with it (`core/metrics.ts`),
because an app that has the models and not the reset rule writes its own.

**And the jobs became a plugin.** Two `*.job.ts` files per app is the same
duplication one layer up, so `metricsPlugin()` owns both clocks, following the
outbox relay next door. It claims `app.metrics` — `scrapeNow`, `rollupNow`,
`stats` — because both passes are things an operator asks for by hand, and
because that is what lets a drive exercise the SHIPPED pass instead of a copy of
it.

`main` is not a compromise either, which this document also had wrong:
[`FJS-D35`](../DECISIONS.md#fjs-d35) already ruled that a second `database`
block is a second connection outside the transaction manager, which is why the
outbox lives in main. The metric models follow it for the same reason, and
`FJS-958` is the narrower finding that tenancy makes the second connection point
at the *same file*.

---

## Still open

**The evaluator is written** (`FJS-123`, closed 2026-09-07):
`basecamp/api/src/jobs/alert-evaluate.job.ts`, on the scrape's own interval,
reading the raw tier. Two things it settled that this document had left open.

`AlertRule.condition` is not read as a document at all — it stopped being one.
Three writers were spelling the blob three ways, so it became
`operator`/`threshold`/`forMinutes` as columns ([`FJS-D227`](../DECISIONS.md#fjs-d227)),
which is the same move `channels` and `severity` had already made on that model.

And the reason the store keeps `up` earns itself here: the evaluator needed a
*has this stopped* rule, and `up < 1` is one — so there is no fifth operator
that ignores its own threshold, and no staleness concept anywhere but in the
data.

**Histograms remain the decision that cannot be deferred much longer.** Nothing
writes one, the enum carries the value, and a percentile cannot be recovered
from anything stored here — so the day a latency threshold is wanted, every row
already written is the wrong shape.

`FJS-958` still holds the store on `main`, which costs the write isolation a
separate file was for.
