# Changes — @frontierjs/caravan

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
`register()` honours every key of `JunctionCaravanConfig` — `db`, `jobsDir`,
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
