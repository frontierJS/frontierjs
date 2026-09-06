# Changes — @frontierjs/caravan

## A job records which request asked for it

`actor_id` records WHO and `tenant_id` records WHICH TENANT, both resolved at
dispatch and read back when the job runs. There was no third, so a job queued
inside a request carried no id the request also had: the two halves of one unit
of work appeared in a log with nothing in common and could not be joined.

`correlation_id` is that sibling — the same column shape, the same `addColumn`
migration, and the same rule the other two follow. **Absent is not null**:
`'correlationId' in opts` rather than `??`, so `correlationId: null` is a caller
saying this work belongs to no request (a cron fire, a boot enqueue) and saying
nothing takes whatever the host reports. Junction supplies it as
`app.correlationId()`, the third of `principal()` and `tenant()`.

It is request-wide where the tenant is per-call, and deliberately: a service
that re-resolves a tenant mid-request is still inside one request.

`ctx.correlationId` is what a handler reads.


## 2026-09-04 — the cron grammar moved out, and a schedule that cannot fire is refused

`FJS-767`. The parser took the FIRST operator character it found and split on
that alone, so `1-5,8` became a range 1-5 with the `,8` gone and `1-5/2` became
the same with the `/2` gone — hours nobody asked for, hours they did ask for
skipped, nothing said. It consulted no bound either, so `0 25 * * *`,
`61 * * * *`, `0 0 32 * *`, `-5 * * * *` and `abc * * * *` all registered,
appeared in `registrations()` and in `jobs.snapshot.md`, and ran zero times for
the life of the process — `FJS-327`'s silence one layer down, where the schedule
is not merely unobserved but unmatchable.

The grammar is `@frontierjs/toolbelt/cron` now and is not restated here, because
junction's `app.scheduler` parses the same expressions and the two disagreed
about several of them. What stays is the half that is not the grammar: a named
zone, and the wall-clock walk across a daylight boundary.

`add()` already named the job in a field-count error and now names it in all of
them, which is what makes a bad expression findable once a schedule can live in
any `*.job.ts` file.

## 2026-09-03 — the two endpoints an operator reaches when something is wrong

FJS-698. 220 pass (17 new), typecheck clean.

An audit put 1M terminal jobs plus 1k pending into a jobs.db and asked what the
admin surface costs. Re-measured before anything was touched, and every number
was worse than filed: `stats()` **1009ms** per scrape and per health probe,
`list()` page one **685ms**, the cleanup sweep holding the write lock for
**11 551ms**, and the file still 142.6MB after its million rows were deleted.

**The aggregate's defect was a WHERE clause, not a missing index.** It carried
`status IN ('pending','running','done','failed','cancelled')` — every status
there is — so it selected nothing out and steered SQLite onto the status index
with a temp b-tree for the grouping. Deleting it drops the scrape to **134ms**,
answered from `jobs_poll`, which already leads with `(queue, status)`. The
covering index the finding proposed was measured and refused: it buys 17ms, and
while the filter is there SQLite ignores it and gets slower (1274ms). A status
this build does not know is still excluded, by `aggregateStats`, which is where
that judgement belongs — the SQL was the second place saying it.

**`/health` was paying the whole scan for one number.** Readiness reads
`oldestRunningMs` and nothing else, and that comes from `oldestRunning`, a query
costing 0.0ms. It asks that query now: 1009ms to nothing, on the endpoint
somebody hits *because* the app is already in trouble.

**The list needed a statement change before an index could help.**
`($queue IS NULL OR queue = $queue)` is planned once, before anything is bound,
so SQLite has to allow for the parameter being null and never seeks on the
column it filters. One statement per filter shape now, over three indexes —
`jobs_status_created` replacing `jobs_status`, plus `jobs_queue_created` and
`jobs_created`. Every shape is 0.0–0.4ms, `status=running` with nothing running
included: that one was **385ms even with the index**, and it is the first thing
anybody asks when work has stopped moving.

**The sweep is batched at 10 000 and yields between passes**, taking the longest
lock hold from 11 551ms to **117ms** — during which, before, every dispatch and
every claim in every process waited. Both halves matter: batching without the
yield slices only the lock, since a synchronous loop still holds this process
for the whole sweep. The batch size is measured and is not monotonic — 1 000
gives 550ms and 10.1s total, 50 000 gives 1338ms and 14.4s — so it is a number
to re-measure rather than reason about.

**Two bugs in the fix, both caught by measuring it.** Splitting the list
statement regressed the common case: `queue=mail`, a third of the rows, went
0.1ms → 263ms, because seeking `jobs_poll` on queue and then sorting 333k rows
is worse than walking `jobs_created` and filtering. That is what
`jobs_queue_created` is for. And `PRAGMA auto_vacuum = INCREMENTAL` set *after*
the WAL switch reads back as 2 on that connection and **0 on the next open** —
going from `none` needs a rewrite SQLite will only do on a database with nothing
in it, and it reports success either way, so the reclaim was a silent no-op for
the life of the file. It is set before the mode change now, and a database that
already exists keeps its setting: changing it means a full VACUUM, which takes a
lock and a second copy of the file, and is the operator's call.

**What it costs, priced rather than assumed.** The three list indexes take the
file from 142.6MB to 244.3MB at 1M rows, and a dispatch from 0.095ms to 0.135ms
(10 519/s → 7 416/s) — against a queue whose steady state is single-digit
rows/s, on a table a person reads while an incident is running.

**`PLANNED` in `db.ts` is the one owner of the SQL whose plan must not
regress.** A prepared statement stringifies with its parameters expanded to
their last bound values, so `status = ?` comes back as `status = NULL` and plans
the opposite way — a test cannot read the text off the statement, and a copy of
the string would grade SQLite rather than this module and would keep passing
after the module changed. Every assertion in `tests/scale.test.ts` is a query
plan or a row count and none is a duration.

**Residual, stated.** The aggregate is still linear in the retention window
(134ms at 1M rows) and the hourly sweep pass with nothing to delete costs
~500ms. The cached aggregate the finding also suggested was refused: a TTL below
the scrape interval helps a single scraper not at all, and `stats()` is public
API a test can dispatch against and then assert on.

## 2026-09-02 — the seven things two processes on one jobs.db could not survive

FJS-674, FJS-675, FJS-676, FJS-695, FJS-696, FJS-697, FJS-699. 203 pass (15
new), typecheck clean.

An audit put four processes on one jobs.db and asked what happened. Six of the
seven answers were only reachable from more than one process, and the tests
added for them spawn real `bun` subprocesses for that reason: a cold-start lock,
a unique-key race and a claim by a process with no handler are all things a
single in-process test agrees with itself about.

**The admin surface was remote job execution.** `admin: true` mounts raw
`app.get`/`app.post` routes on the app's own API prefix, so no `@@gate`, no row
policy and no session hook is on the path by construction — and
`POST /jobs/run/{name}` executes any registered handler with the app's own
standing. Measured with `NODE_ENV=production`: a stranger's
`POST /api/jobs/run/nightly-sweep` answered `200 {"ok":true}` with the handler
running as SYSTEM, and `GET /api/jobs` returned every payload in plaintext —
reset tokens, addresses, provider keys. It fails closed now, the way junction's
own `devtools()` in the same repo already did: `admin: { authorize: (ctx) =>
boolean }` is a function handed the transport ctx, so an app composes it with
its own session and gate; `{ secret }` stays as a development shortcut,
compared constant-time and refused in production; and `data` is `[redacted]` in
the list unless the request asks for it with `?data=1`.

**A process that could not run a job destroyed it.** No handler for the name
meant `markFailed`, terminal, `maxAttempts` bypassed — so a web process polling
beside a worker one, or the old replica of a rolling deploy, marked all five of
the worker's jobs `failed "No handler registered"` 400ms before the worker
started. *I cannot do this* and *this cannot be done* are different answers. The
claim now binds the registered names, so a process never claims what it cannot
run, and the release (back to `pending`, the attempt given back, one warn per
name per process) is the backstop for a handler registered between the claim and
the execute.

**A fresh volume was a coin toss.** SQLite invokes no busy handler for a
journal-mode change, so `busyTimeout` cannot cover it: four processes opening a
jobs.db that does not exist yet — first boot of the deployment this package
advertises — threw `database is locked` on **36 of 40** starts. Both the read
and the change are inside a bounded retry, and so is the schema block, which is
the same race one statement later; the mode is asked first because a database
already in WAL needs no lock to say so. Twelve cold starts across three rounds,
zero throws.

**`PRAGMA synchronous` was never set, so every row cost an fsync.** Same code
path, one pragma: FULL inserted 2000 jobs in 5913ms and NORMAL in 136ms — 43×
dispatch, 24× claim, and a `dispatch()` inside an HTTP handler stops blocking
that process's event loop on the disk. NORMAL is the default now, with
`synchronous: 'FULL'` for a deployment that would rather pay it. What it trades
is stated where it is set: WAL+NORMAL loses committed rows on POWER LOSS and not
on a process crash, and a lost claim is a running row whose owner stops
heartbeating, which the lease sweep already recovers by design.

**Throughput was exactly `concurrency / pollInterval`** — 2 jobs a second at the
defaults — because a worker never re-polled when a job finished, so a queue with
capacity free and work queued slept the interval out. `_execute` polls from its
own `finally` and the interval becomes the backstop for work that ARRIVES.
100 empty jobs at a 1s poll and concurrency 2 took 50s and now take under one.

**A timer could take the process down, and an idle queue took a write lock 3
times a second.** `sweepOwners` threw `database is locked` out of a
`setInterval` — an uncaughtException — and the heartbeat it missed on the way
out is exactly what makes another instance reclaim this one's running rows.
Every timer callback catches its own throw now. `_claim` asks a read-only
question before `BEGIN IMMEDIATE`, because an empty poll of every queue was
opening a write transaction with nothing to do: measured at 0 write
transactions across ~90 idle polls, against 3/s before. And `stop()` marks the
workers closed BEFORE closing the database — past `drainTimeout` the handler is
still running, and its completion write used to reject with
`Database has closed` as an unhandled rejection on the ordinary SIGTERM path —
while the hourly cleanup sweep is held and cleared where the heartbeat is, since
a `const` local to `start()` went on firing against that closed handle and a
restart added a second one.

**`dispatch({ unique })` 500'd under the shape it exists for.**
`findByUniqueKey` then insert is check-then-act across processes, and the catch
recovered only a primary-key collision, so three processes racing one key each
surfaced a raw `UNIQUE constraint failed: jobs.unique_key` out of an HTTP
request. The partial index is what decides the race, so the loser asks it who
won; a key freed by the winner going terminal in between is one retried insert.
900 dispatches of one key from three processes: 0 throws, 1 row, and all three
processes were told the same id.

## 2026-08-29 — `busyTimeout` on the jobs database

`createCaravan({ busyTimeout })`, also settable from `junction.config.js`'s
`caravan:` section. Default 5_000 as before; `0` fails immediately.

A jobs database is shared by construction — a second replica, a dispatch from the
API, `fli` — so waiting for another process's write lock is the normal case
rather than the exception. It is configurable because the two callers want
different answers: a worker draining a long batch can afford to wait, an API
dispatching a job cannot, and since `bun:sqlite` is synchronous the number is a
bound on how long ONE call blocks that process's event loop. `FJS-569`,
`FJS-D155`, and `@frontierjs/litestone`'s `docs/concurrency.md`.

## 2026-08-25 — a fixed-time schedule fires once per calendar day, whatever the clock does

188 tests, 0 fail (18 new). Typecheck clean.

The firing path asked one question — *does the current minute match?* — and on
the two days a year when the local clock is not a function of real time it gave
two wrong answers. Measured on `America/New_York` before anything was changed:
`30 2 * * *` fired **zero** times on the spring boundary, because 02:30 never
occurred; `30 1 * * *` fired **twice** on the autumn one, and the two fires were
two dispatch ids, because `occurrenceKey('cron', name, minute)` was built from
the epoch minute and 01:30 EDT and 01:30 EST are different epoch minutes. A job
that charges a card did it twice a year, twice.

**The rule is Vixie cron's, ruled as `FJS-D144`**: a fixed-time schedule fires
once per calendar day; a wildcard schedule follows the new wall clock; a shift
over three hours is a clock correction rather than daylight saving.

**Both boundaries now fall out of one loop rather than being special-cased.** A
fixed-time schedule keeps a mark — the last wall-clock minute it looked at — and
each tick walks FORWARD over the local clock from that mark to now, firing any
minute the expression matches. Spring: the local clock goes 01:59 → 03:00, so
02:00–02:59 is still in the walk and 02:30 fires once, just after the change.
Autumn: the local clock goes 01:59 → 01:00, so the walk is empty until it passes
01:59 again and nothing re-runs. **The mark only ever moves forward, and that is
the whole of the second half** — the first version let it follow the clock down
and the repeated hour was walked a second time, which is the original defect
wearing new code. The test caught it.

**The wildcard carve-out is not a nicety, it is a regression guard.** `30 * * * *`
already fired 25 times on the 25-hour day, which is correct, and compensating it
would have taken one away. Measured before and after.

**A fire is now named by the wall clock it belongs to**, for a fixed-time
schedule — so the identity two processes must agree on is the moment the
schedule asked for rather than the instant it was run at. `index.ts` needed no
change: the number still flows into `occurrenceKey`, and the autumn duplicate
now collapses to one dispatch id the way `FJS-294` intended.

Free with the walk: **a minute missed because the event loop was blocked or the
container was paused is now caught up**, which *does the current minute match*
could not see at all.

`CronScheduler` takes `now`. The behavior above happens on two days a year and
a suite that cannot move the clock can only assert the parser — which is what
this suite did assert, with four green `timeZone` tests sitting above a defect in
the firing path. `nextRuns()` deliberately stays the wall clock's own answer and
is a day out on the spring boundary; two implementations of *when does this fire*
would be worse.

**Two instances over one `jobs.db` are asserted rather than argued.** The
scheduler firing once is half the guarantee; the other half is that two processes
with no leader between them produce one row, which rests on both computing the
same id. The test stalls one instance across the fire — a blocked event loop,
five minutes — and it lands one row under the wall-clock identity and **two**
under the old epoch-minute one, same scenario, only the id construction
different. That also says the old identity was not only a boundary bug: naming a
fire by the minute it was RUN AT rather than the minute it was FOR double-
dispatches on any day an instance falls behind.

`FJS-525` · `tests/cron-dst.test.ts`

## 2026-08-23 — a job records WHICH TENANT, beside who asked

170 tests, 0 fail. Typecheck clean.

`actor_id` crossed the boundary and nothing else did, so a handler under row
tenancy had no legal way to be in a tenant and reached for `asSystem()` — which
drops the gate, the row policies and the audit actor together to relax exactly
one of them (`FJS-384`).

`tenant_id` is a nullable column added the way `actor_id` and `owner_id` were,
so an existing `jobs.db` keeps working and NULL is honest: an app that declares
no tenancy, and work that is the app's own. It is read at dispatch from
`host.tenant()` on the same absent-is-not-null rule the actor follows —
`tenant: null` is work that belongs to no tenant, stated — and handed back
through `runAs(actor, { tenant }, fn)`, so a service call inside the handler
resolves to it without being threaded anything. `ctx.tenantId` is the
informational half, exactly as `ctx.auth` is.

**Storing a tenant is not storing a session.** An id names WHICH ROWS; the
standing that decides what may be done with them is still the principal
re-resolved at run time, so a caller demoted — or removed from the tenant —
between asking and running is graded at what they hold now.


## 2026-08-22 — the config block is read at boot, because that is when it exists

167 tests, 0 fail. Typecheck clean.

The `caravan:` section of `junction.config.js` was read in `register()`.
`configure()` runs `register()` synchronously, and junction does not load that
file until its `load-config` start phase — so what the plugin saw was the config
as it was *before* the file, which is to say without it (`FJS-416`).

Every app configures its queue at module scope, so the whole section was dead:
`admin: true` mounted no routes, a `queues` block set no concurrency, a
`jobsDir` was ignored. It appeared to work because the one app exercising it
hand-loads the config and passes it to `createApp`, which puts `_junction` in
`opts.config` before any plugin registers.

`applyJunctionConfig` and `mountAdminRoutes` are named functions now and both
run in `boot()`. That is late enough for the file to be loaded and early enough
for the routes: `boot-plugins` runs before `service-routes` and before `listen`.

Found by giving `example` the config file it should have had and watching
`/api/jobs` 404 — 22 routes became 28 with the block honored.


## 2026-08-22 — the queue contributes a readiness check

167 tests, 0 fail. Typecheck clean.

Junction grew `app.registerHealthCheck(name, fn)` (`FJS-414`), the sibling of
the metrics seam this package has always used. Caravan is one of the first two
callers.

The check is the one thing the counts cannot show on their own: a queue holding
a stuck job reports `running: 1` for the life of the process, which is exactly
what a queue doing steady work reports. `oldestRunningMs` is what separates
them, and it is graded against the **longest declared `timeout`** — past twice
that, every bounded job should already have been given up on.

Only bounded work is graded. A handler that declared no timeout said it has no
bound, and failing an app's readiness probe on a long job somebody deliberately
left unbounded would take a healthy app out of a load balancer; a queue where
nothing declares a timeout is never unhealthy here.

Nothing is required of an app: the registration is behind a `typeof` probe, so
this package still runs against a host that is not a Junction app at all.

## 2026-08-20 — the two names a job file could not have

167 tests, 2 of them new, 0 fail.

Found by moving basecamp off five hand-registered handlers and onto job files
(`packages/basecamp/CHANGES.md`). Both are about the one rule that makes the
convention safe — *a job is named by its file* — and both are ways that rule was
answering a question it had not been asked.

**A namespaced name could not be a file.** `deployment:run` is the ordinary way
to name a job and a colon is not a legal filename character on Windows, so the
file convention silently excluded the most common naming style: the only file
name the job could have was refused for not matching. `deployment-run.job.ts` is
now accepted for it. The translation is one-way and narrow — a colon becomes a
dash on the way to a file, nothing else is touched, and the NAME keeps its colon
everywhere it is dispatched.

**Two files could claim one name.** The scan is recursive and the name is the
BASENAME, so `jobs/a/cleanup.job.ts` and `jobs/b/cleanup.job.ts` both register
`cleanup` — and the registry is a Map, so the loser stopped existing while every
dispatch to it ran the winner's handler. Refused at load, naming both files.
Nothing here could have been asked about it: `registrations()` would report one
job, correctly, and no count anywhere is wrong.

## 2026-08-18 — a bound on one attempt, and a stall you can see (`FJS-295`)

165 tests, 11 of them new, 0 fail. Typecheck clean.

A handler that never returned held its slot for the life of the process. On a
`concurrency: 1` queue everything behind it stayed `pending` with no error, no
telemetry, and a `running` count that never moved — and `stop()` then waited its
full 30s deadline and abandoned the job mid-flight. Every other failure mode
here was named and retried; this is the one a third-party call actually
produces, a socket that neither answers nor closes.

**Three changes, and they are separate on purpose.**

**`timeout` on a handler, a job file or a queue.** Absent means no bound,
honestly — the same contract every declaration here has, and a default would
kill every legitimately long job in every app that upgraded. A queue-level
default covers the handlers on it, resolved at registration so
`registrations()` reports the bound that will actually be enforced. A timeout is
an **ordinary failure**: it counts as an attempt and retries on the same ladder
as a throw, rather than becoming a fifth status.

**What it cannot do is stop the handler**, and both consequences are handled
rather than left to chance. Nothing in JavaScript cancels a promise, so the
abandoned invocation keeps running and may still be writing while the retry
runs — delivery was already at-least-once (`FJS-D35`), and this widens the
window rather than opening it. Its later rejection would have been unhandled,
which takes the process down; it is caught. Its later *success* is the most
useful thing a person debugging this can be told — *the work you gave up on
finished after 45 minutes* — so it is announced on `console.warn` and emitted as
`caravan.job.orphan`, not swallowed. A handler that never yields is unreachable
from here either way: the timer needs the event loop.

**`oldestRunningMs` on every queue's stats**, because most stalls will be on
jobs nobody thought to bound. `running: 1` for the life of the process is
exactly what a queue doing steady work reports; a count that never moves beside
an age climbing past an hour is not, and no threshold has to be guessed to say
it. Asked of the database, so a job another instance is holding is in the answer
— which is the shape a stall has with two replicas. `null` where nothing is
running, never 0.

**`drainTimeout`**, since a hardcoded 30s is the whole shutdown budget of a
deployment whose SIGTERM grace is shorter.

**Two whitelist bugs fell out of it, both the same shape.** `defineJob` built
its definition from a fixed list of keys, and `autoload` then re-listed a
definition's keys into `handle(name, fn, opts)` — so a `timeout` written in a
job file was accepted, dropped twice, and reported as having no bound. autoload
passes the **definition whole** now (`JobRegistrar.handle(job)`), which removes
the third whitelist rather than adding a key to it. Found by `junction jobs`
printing `**none**` for a job that had just declared 30s — the artefact catching
the defect the day after it was written.

`example`'s `book-courier` is bounded at 30s, which is the case the feature is
for: somebody else's HTTP call, retried, ending in a write that is idempotent by
construction.

## 2026-08-18 — `registrations()`, so the registry has a reader (`FJS-346`)

154 tests, 4 of them new, 0 fail. Typecheck clean.

The handler map was private and `nextRuns()` answers only the scheduled jobs,
off a live clock. So there was no way to ask what this app declared it would
run — which is the question `junction jobs` commits, and the question nothing
could have been asked when every scheduled job in an app stopped firing at the
first restart with every row still reading `scheduled` (`FJS-327`).

`registrations()` answers every registered handler's declaration, name-sorted:
name, queue, cron, timeZone, maxAttempts, retryDelay. Sorted because
registration order would otherwise move a committed file; `retryDelay` copied
because a reader must not be able to mutate the registry. The handler function
is absent — a closure is not part of what an app declared.

## 2026-08-18 — the cron fire id is built by one owner (`FJS-342`)

150 tests, 1 of them new, 0 fail. Typecheck clean.

`cron:${name}:${minute}` interpolated a caller-supplied job name into a string
that becomes the jobs table's primary key, so a job called `report:daily` fired
at minute 5 and a job called `report` fired at `daily:5` were one key — and the
second of the two silently never ran. Through
`@frontierjs/toolbelt/history`'s `occurrenceKey` the name is escaped, and the
output is byte-identical for any name without a `:` in it, so a queue with rows
in it is unaffected.

`@frontierjs/toolbelt` is a dependency now. It is the substrate package and
depends on nothing (`FJS-D26`), so this does not touch the direction of anything.

## 2026-08-18 — two instances on one `jobs.db` (`FJS-294`)

149 tests (8 new), 0 fail. Typecheck clean. `example`: `verify:jobs` 10/10.

A jobs database is trivially opened twice — two replicas behind a load balancer,
a web process beside a worker one, a drive started while the dev server runs —
and this package neither stated single ownership nor coordinated. Both halves
were wrong, in different ways.

**`start()` released the rows another instance was executing.** Crash recovery
set every `running` row back to `pending`, which is right for one process and
catastrophic for two: bringing up a second instance re-ran whatever the first
was midway through, concurrently, and the atomic claim said nothing because the
second claim was legitimate — the row was pending. Rows are now OWNED. Each
instance takes an id, writes it on the rows it claims, and heartbeats into a
`job_owners` table; recovery reclaims only rows whose owner has gone quiet past
`lease`. `markDone`/`markFailed` are guarded on the owner as well as on
`running`, so a reclaimed job's late completion cannot land on the attempt that
replaced it.

**Every instance fired every cron.** The scheduler is in-process and the fire
was a fresh uuid, so one schedule declared in two processes produced two rows a
tick. The fire is now named — `cron:<job>:<epoch-minute>` — which makes the
second instance's dispatch the no-op a stated id already is (`FJS-D35`). No
leader, deliberately: a lease-held leader misses fires whenever the lease is
between owners, where a dedup key cannot.

`heartbeat` (5s) and `lease` (30s) are options, settable from
`junction.config.js` like every other key.

The lease is renewed by a timer, so a handler that BLOCKS the event loop past
`lease` stalls its own heartbeat and has its work reclaimed under it — the same
ground as `FJS-295`, and the same answer: work that does not yield is work this
queue cannot supervise.

*8 tests in `tests/ownership.test.ts`, against a real file database because in
`:memory:` two instances are two databases and the defect is invisible. Mutation
checked: restore the blanket recovery and the cron uuid, and 4 of them fail.*

## 2026-08-17 — `dispatch({ id })`, the idempotency `unique` is not (`FJS-D35`)

141 tests (23 new), 0 fail. Typecheck clean.

Stating an id makes a dispatch idempotent **for all time**: the id is the jobs
table's primary key, so a second dispatch under it queues nothing and answers
that id.

`unique` cannot be this and was never meant to be. It is a lock on work in
flight and frees itself the moment a job is terminal — which is exactly when a
retry is most likely, so a replay under a `unique` key does the work twice. The
primary key is the one thing in the table that lasts.

```ts
await jobs.dispatch('send-email', data, { id: outboxRowId })   // safe to repeat
```

Written for junction's outbox relay, which hands rows across two SQLite files
and therefore cannot make the handoff atomic: it dispatches under the outbox
row's own id, so a crash between the queue insert and the delivery mark replays
into a no-op instead of a second email.

The pre-check is a `getById`, and the primary key is what settles a race — two
processes both read nothing before inserting, so the collision is caught rather
than prevented. `isPrimaryKeyCollision(err)` is how that is told apart from a
real failure; swallowing a `NOT NULL` breach would report a job queued that is
not there. The in-process path never reaches that catch (dispatch reads and
inserts with no await between them), so it is covered directly against a real
SQLite error rather than described.

*23 tests: 7 for the stated id, 16 for the relay end to end — a real Litestone
client, a real Junction app and a real queue, which only exists here.*

## 2026-08-17 — `unschedule(name)`, the counterpart `schedule()` never had (`FJS-D36`)

118 tests (3 new), 0 fail. Typecheck clean.

`CronScheduler` had `add` and no way back. Nothing needed one while every
schedule came from a `*.job.ts` file: that registration is a statement about the
code and lives as long as the process.

A schedule registered from a **database row** does not. The row is deleted, or
stops being a scheduled job, and with no way to drop the registration the timer
went on firing for the rest of the process — dispatching work for a job nobody
could see. Found by basecamp, which is what basecamp is for (`FJS-327`,
`FJS-328`).

```ts
app.jobs.schedule('job:cron:abc', '0 2 * * *', handler)
app.jobs.unschedule('job:cron:abc')   // → true; false if nothing was registered
```

**The handler stays registered.** Only the clock is unbound: a run already
queued under that name still has to find something to execute, and removing the
work along with the schedule would fail it instead.


## 2026-08-16 — two numbers that were not there

115 tests (was 112). Both found by probing the package rather than reading it,
which is also how the two rows filed alongside them were found —
[`FJS-294`](../../ISSUES.md) (two instances on one `jobs.db`) and `FJS-295` (a
handler with no timeout), neither fixed here.

**`stats()` counts `done`.** It never had, so the only numbers reported were the
ones an idle queue reports too: after a successful job the totals read
`{pending: 0, running: 0, failed: 0, cancelled: 0}`, identical to a queue that
has done nothing at all. Junction's `/metrics` reads this source and basecamp's
hub screen renders it, so *is the queue working* had no answer anywhere. It
counts the retention window rather than all time — the cleanup sweep deletes
terminal jobs past `cleanupAfter`, which is what makes it a rate.

**An absent payload is an empty one.** `dispatch('x')` from JavaScript threw
`NOT NULL constraint failed: jobs.data` — a SQLite message naming neither the
job nor the caller, because `JSON.stringify(undefined)` is `undefined` and bound
as NULL. An explicit `null` is left alone: it is a value somebody passed, and it
round-trips.


## 2026-08-16 — a job file declares itself (`FJS-094`, `FJS-090`, `FJS-048`)

112 tests (was 92 — 13 in a new `tests/declaration.test.ts`, 7 added to the
integration file). Typecheck clean. `example`: `verify:jobs` 8/8.

Three rows, one shape: **a job's declaration was split across files.**

**`cron` is a registration option.** `HandlerOptions` grows `cron` and
`timeZone`, so a `*.job.ts` file says WHEN it runs beside what it does and
needs no line in `app.ts`. The schedule is registered in **`handle()`** rather
than in `schedule()`, which is the part that makes it reachable at all —
`handle` is the only call `autoload` makes. `schedule(name, expr, fn)` is now
sugar over `handle(name, fn, { cron: expr })`, so a cron declared in a file and
one declared in a call are the same registration.

Two defects came out of that collapse. A name is a schedule and **not a list of
them**: registering the same name twice used to add a second entry and fire the
job twice a minute. And an unparseable expression is refused naming the JOB —
the expression alone no longer says which file to open.

**The definition is the dispatch handle.** `defineJob` returns a
`JobDefinition<T>`, and `dispatch(bookCourier, { orderId })` reads the name off
it: no call site restates the string, and `data` is typed by the handler that
will receive it rather than `unknown` on both sides. `handle(definition)`
registers one whole. Dispatch-by-name still works — a worker process holding
the handler while a web process dispatches is a real shape, and refusing it
would be worse than the typo it prevents.

**A job in `jobsDir` is named by its file.** `autoload` compares the `defineJob`
name against the file it is in and throws on a mismatch, naming both. That is
the whole of `FJS-090`'s original symptom: `send-email.job.ts` defining
`send-emial` registered a handler no dispatch ever reached, and nothing failed.

**Construction is deferred, so a config file can set anything.** The database
opens on first use, the workers are built in `start()` after autoload, and
`register()` honors every key of `JunctionCaravanConfig` — `db`, `jobsDir`,
`cleanupAfter`, `pollInterval`, `queues`, `admin` — with opts winning. Two more
defects fell out: the merge tested truthiness, so `cleanupAfter: 0` (the way to
turn the sweep off) read as unset from either side; and `stop()` closed the
database while the pool kept the workers holding it, so a restart polled through
a closed handle.

In `example`, `api/jobs/sweep-abandoned.ts` was named `.ts` on purpose to keep
it out of the autoload glob. It is `sweep-abandoned.job.ts` now with its cron in its
own `defineJob` options, the `queue.schedule` line in `app.ts` is gone, and the
two dispatch sites in `orders.service.ts`
import the definitions, which also deleted a hand-written
`ctx.app as { jobs?: … }` cast at each: importing a job file is what puts
Caravan's augmentation of `app.jobs` in that file's program.


## 2026-08-16 — `app.claim` and `registerMetricsSource` (`FJS-D06`)

92/92 tests pass. Typecheck clean.

Junction renamed `app.provide` to `app.claim` and replaced the
`app._metricsProviders` map with `app.registerMetricsSource(name, fn)`.
`CaravanApp` names both new shapes and `register()` calls them.

**Both stay optional, and that is not laziness.** Caravan runs standalone
against a host that is not a Junction app, which is why `CaravanApp` lists the
fields it touches rather than carrying an index signature. What makes the
optionality safe is `tests/junction-integration.test.ts` driving a real app: a
presence check against a fake would pass forever after Junction moved the seam.


## 2026-08-16 — a job runs as whoever asked for it

92 tests (was 81 — 11 new, `tests/job-context.test.ts`). Typecheck clean.

The oldest hazard in this package is gone. A handler had no principal, and no
principal is STRANGER(0), so a job writing back through `app.service('x')` was
refused by the model's own `@@gate`. It was documented rather than fixed, and
every job in every app carried `{ auth: { user: SYSTEM } }` by hand — which
*also* meant work a customer asked for ran with the authority of the shop.

`dispatch()` now records `app.principal()?.userId` in a new `actor_id` column,
and the worker runs the handler inside `app.runAs(actorId, …)`. So a service
call in a handler names no `auth` and inherits one, through the same
AsyncLocalStorage propagation any nested call gets. **The audit trail is where
this shows**: in `example`, the `book-courier` write now names the staff member
who pressed Ship, where it used to say `system` for every background write.

**An id is stored, never a session.** A snapshot would be one line shorter and
would let a caller demoted between asking and running keep the authority they
had when they asked — a captured privilege outliving its own revocation, for as
long as the retry schedule runs. The test that pins this demotes a user between
the dispatch and the run and asserts the *new* standing.

Nobody asked → `createApp({ system })`. A cron fire states `actor: null` rather
than inferring it, so a timer cannot depend on whether an unrelated request
happened to be in scope. An actor that cannot be resolved — deleted user, or a
provider with no `sessionFor` — **fails the job by name**; downgrading to
STRANGER(0) is the bug and upgrading to `system` would be worse.

A handler's argument is now a `JobContext`: the job's own facts plus `app` and
`auth`. `ctx.app` is the other half of the fix — Junction hands `app` to every
plugin's `register()` and Caravan kept it, so an autoloaded `*.job.ts` had no
route to the service layer at all and apps grew a module holding a mutable app
reference. `example/api/app-ref.ts` is deleted.

Standalone Caravan is unchanged in kind: no `runAs`, so the handler is called
directly with `ctx.app` undefined and `ctx.auth.user` null.

Old `jobs.db` files get `actor_id` by `ALTER TABLE` on open. Jobs already queued
have NULL and run as the app, which is the only honest answer — nothing recorded
who asked for them.

## 2026-08-15 — a cancelled job stayed cancelled (FJS-039)

81 tests (was 79 — 2 new). Typecheck clean.

`cancel()` on a RUNNING job set `cancelled`, and then the attempt still in flight
wrote its own outcome over it. `markDone` and `markFailed` were
`WHERE id = $id` with no status guard, so the answer to "what happened to this
job" was whichever write landed last.

The comment beside `cancel` said the worker checked status before marking
done/failed. It never did — a comment describing an intended fix, which is worse
than none, because the next reader stops looking.

Both statements now carry `AND status = 'running'`. The failed half was the
worse of the two: without the guard a cancelled job whose handler then threw was
written back to `pending`, re-claimed, and **ran again** — the new test sees
`running`, not `done`.

The worker reads `changes` off each UPDATE and skips the telemetry event when it
is 0. A `caravan.job.done` for a job that ended up cancelled is the same lie one
layer up, and anything counting completions would have believed it.

Both tests were run against the unguarded statements first and fail there.
`example`: `verify:jobs` 8/8.

## 2026-08-06 — `unique` worked in neither direction, and a cron could not be run

79 tests (was 67 — 12 new). Typecheck clean.

The package's first real application (`example/`'s courier booking) found three
things in an afternoon. None of them had a test, and `unique` had no test at all.

### `unique` is a lock on work IN FLIGHT

The lookup asked for a **pending** job with the key; the column was
`unique_key TEXT UNIQUE`, which says **forever**. The two halves disagreed about
how long a key lasts, and each reading fails differently:

- *pending-only lookup, table-wide constraint* — the second dispatch walked past
  the guard and into the index the moment the first job had finished:
  `500 GeneralError: UNIQUE constraint failed: jobs.unique_key`, out of an
  ordinary HTTP request.
- *any-status lookup* (tried, and wrong) — a key built from a row id
  (`book-courier:4`) matched a job belonging to a **deleted** order whose id
  SQLite had reused. Nothing failed; a courier was simply never booked.

The rule is "only one of these at a time", and it is now enforced where it
cannot drift from the lookup — a partial unique index over live jobs:

```sql
CREATE UNIQUE INDEX jobs_unique_live
  ON jobs(unique_key) WHERE unique_key IS NOT NULL AND status IN ('pending','running');
```

`running` is in the set on purpose: without it a dispatch during execution slips
past the guard and hits the index instead of returning the job already doing the
work. Terminal jobs keep their key for inspection and stop blocking new work.

**A database created before today is migrated on open.** `CREATE TABLE IF NOT
EXISTS` does nothing to an existing table, so an old `jobs.db` would have kept
the constraint against a schema file that no longer explains it. `openDb` reads
`sqlite_master`, and rebuilds the table in one transaction if it finds the old
column. The check is one read and cannot false-positive on the current schema.

`unique` is **not** an idempotency key, and the docs said it was. It will not
stop the same work being done twice on two separate occasions, and a key derived
from a row id must not be treated as one.

### `POST /jobs/run/{name}` — run a registered job now

The admin surface could retry a job and cancel a job but not **start** one, so
the only way to reach a nightly sweep was to wait until 03:00. That makes every
cron handler in every app untestable, and unrunnable during an incident.

```bash
curl -X POST localhost:3000/jobs/run/sweep-abandoned -d '{"days":0}'
# → { "ok": true, "id": "…" }
```

POSTed to a **name**, not an id — an id is a job that already exists. The body
becomes the job's data, so a scheduled handler that reads a parameter can be
given a different one by hand. An unregistered name is a 404 rather than a job
queued for a worker that will never pick it up. Guarded by the same
`admin.secret` as the rest.

`ctx.body` is already parsed by Junction's transport — reading the raw request
here would await a stream nobody is going to write to. Pinned by a test.

### Known gaps this exposed, filed rather than fixed

- **A handler cannot reach the app.** `defineJob('x', async (job) => …)` gets one
  argument; there is no `job.app` and no second parameter, so an autoloaded
  `*.job.ts` cannot call `app.service(…)` — which is what a job in this
  framework mostly wants, because the service layer is where a write gets
  announced. `example/api/app-ref.ts` works around it with a module-level
  back-reference and says so. `FJS-093`.
- **A job file cannot declare its schedule.** `defineJob`'s options are
  `{ queue, maxAttempts, retryDelay }` — no `cron` — so a recurring job is
  half-declared in `jobsDir` and half in the file that calls `schedule()`.
  `FJS-094`.
