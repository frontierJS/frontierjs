# caravan — package map

**The deferred-work realm.** A SQLite-backed job queue plus cron, surfaced as
`app.jobs`. `bun run test` (bun).

---

## Layout

```
src/
  index.ts     createCaravan() — the public surface, queue + admin routes
  db.ts        the jobs database: schema, claim/complete/fail, migration on open
  worker.ts    the worker loop
  cron.ts      recurring declarations
  types.ts     job/queue types
  autoload.ts  handler discovery
```

---

## What bites here

- **A job file is named by its file, and a mismatch throws at load.**
  `send-email.job.ts` is `send-email`; a `defineJob` naming anything else is
  refused rather than registered, because a handler answering to `send-emial`
  while every dispatch says `send-email` is a job that silently never runs. A
  name that cannot be a filename belongs on a `handle()` call outside `jobsDir`.
- **`cron` is a `handle()` option, not a `schedule()` feature.** A registration
  carrying one is a recurring job, which is what lets a `*.job.ts` file declare
  its own schedule — `handle` is the only call autoload makes. `schedule()` is
  sugar over it. **A name is one schedule**: registering it twice replaces,
  where two entries used to fire the job twice a minute.
- **`unschedule(name)` is only for a schedule that came from a ROW.** A
  `*.job.ts` file's schedule is a statement about the code and lives as long as
  the process, which is why `add` had no counterpart for so long. One registered
  from a database row stops being true when the row does, and with no way back
  the timer kept firing for a job nobody could see (`FJS-D36`). It unbinds the
  CLOCK only — the handler stays, because a run already queued under that name
  has to find something to execute.
- **A running row is OWNED, and only an owner's silence releases it.** One
  jobs.db is opened by as many processes as the deployment has, so recovery
  cannot mean *set every `running` row back to `pending`* — that is a second
  instance re-running whatever the first is midway through, with the atomic
  claim saying nothing because the second claim is legitimate (`FJS-294`). Each
  instance takes an id, stamps it on what it claims, and heartbeats into
  `job_owners`; the sweep reclaims rows whose owner has gone quiet past `lease`
  (30s, `heartbeat` 5s). A completion is guarded on the owner too, so a
  reclaimed job's late `markDone` lands nowhere. **The lease is a timer**: a
  handler that blocks the event loop past it stalls its own heartbeat and has
  its work taken — same ground as `FJS-295`.
- **A cron fire is named by its minute, and that is what makes it fire once.**
  `cron:<job>:<minute>` is the dispatch id, so every instance fires its
  own schedule and all but the first are the no-op a stated id already is. There
  is no leader on purpose — a lease-held leader misses fires whenever the lease
  is between owners. The assumption instead is that two clocks agree to within a
  minute, which cron already makes. **Which minute depends on the expression**:
  a wildcard schedule is named by the epoch minute, a fixed-time one by the WALL
  CLOCK minute, because on the autumn boundary one wall clock is two instants and
  the epoch minute names one daily fire twice (`FJS-525`).
- **A fixed-time schedule is WALKED, a wildcard one is SAMPLED, and the split is
  `FJS-D144`.** `_tickFixed` keeps the last wall-clock minute it looked at and
  walks forward over the local clock to now, firing every minute the expression
  matches; `_tickWildcard` asks whether the clock says this now. Both boundary
  behaviors come out of the walk rather than out of a rule about either — the
  local clock going 01:59 → 03:00 leaves the skipped hour in it, and going
  01:59 → 01:00 leaves it empty — and a minute missed to a blocked event loop is
  caught up for free. **The mark only ever moves forward**: letting it follow the
  clock down walks the repeated hour twice, which is the defect wearing new code.
  A jump over three hours in either direction is a clock correction and replays
  nothing. Do not compensate a wildcard schedule: `30 * * * *` fires 25 times on
  a 25-hour day, which is correct, and compensating it removes one.
- **`nextRuns()` is the wall clock's own answer and is a day out on the spring
  boundary**, for a schedule `_tickFixed` will run just after the gap. Reporting,
  not firing. Deliberately not a second implementation of the walk.
- **`CronScheduler` takes `now`.** The behavior above happens on two days a
  year, and a suite that cannot move the clock can only assert the parser — which
  is exactly what this suite asserted while `FJS-525` sat in the firing path
  under four green `timeZone` tests.
- **The database opens on first use and the workers are built by `start()`.**
  Nothing reads an option until it is needed, which is what makes every key of
  the `caravan` section of `junction.config.js` settable. The cost: a dispatch
  before `app.configure(…)` opens the queue at the DEFAULT path and a configured
  one can no longer apply — `register()` warns by path. `stop()` closes that
  database and the pool forgets its workers, so a restart builds both again.
  **It opens WAL + `synchronous = NORMAL`**, and both are held against a
  concurrent cold start: N processes reaching a jobs.db that does not exist yet
  is the advertised deployment on its likeliest morning, and SQLite invokes no
  busy handler for a journal-mode change, so `busyTimeout` covers neither that
  nor the schema block — each is a bounded retry, and the mode is READ first
  because a database already in WAL needs no lock to say so. NORMAL is 43×
  dispatch throughput and loses committed rows only on power loss; a lost claim
  is a running row whose owner stops heartbeating, which the lease sweep already
  recovers. `synchronous: 'FULL'` pays the fsync back.
- **`stop()` marks the workers closed BEFORE it closes the database, and the
  hourly sweep is cleared with the heartbeat.** Past `drainTimeout` a handler is
  still running, and its `markDone` used to reject with `Database has closed` as
  an unhandled rejection — on the ordinary SIGTERM path. A completion write
  after the handle is gone no-ops instead; the row waits for the lease, which is
  the only thing that can decide it. The cleanup timer was a `const` local to
  `start()` and could not be cleared, so it went on firing against that closed
  handle and a restart added a second one.
- **A process claims only names it has a handler for, and a claim it cannot run
  is RELEASED.** *I cannot do this* and *this cannot be done* are different
  answers: a no-handler claim used to be a terminal failure with no attempt
  left, so a web process polling beside a worker one — or the old replica of a
  rolling deploy — destroyed the worker's work in silence. The claim binds the
  registered names, and the release (back to `pending`, the attempt given back,
  one warn per name per process) is the backstop for a handler registered
  between the claim and the execute.
- **A finished job claims the next one, and the interval is the backstop.**
  Throughput was exactly `concurrency / pollInterval` — 2 jobs a second at the
  defaults, sleeping a whole interval with capacity free and work queued. The
  poll also asks a read-only question before `BEGIN IMMEDIATE`, because an empty
  poll of every queue used to open a write transaction: 3 a second per replica
  on one shared file, contention nothing had asked for.
- **Every timer callback catches its own throw.** `sweepOwners` threw
  `database is locked` out of a `setInterval`, which is an uncaughtException and
  a dead process — and the heartbeat it missed on the way out is what makes
  another instance reclaim this one's running rows. A missed sweep is nothing.
- **The admin routes are refused in production without an `authorize`.** They
  are raw routes, so no gate, no row policy and no session hook is on the path
  by construction, and `POST /jobs/run/{name}` executes any registered handler
  with the app's own standing while `GET /jobs` hands over every payload. Mounted
  unauthenticated on the public prefix that is remote job execution, so it fails
  closed the way junction's `devtools()` does: `admin: { authorize: (ctx) =>
  boolean }` composes with the app's own session and gate, `{ secret }` is a
  development shortcut compared constant-time and refused in production, and
  `data` is `[redacted]` in the list unless the request asks with `?data=1`.
- **`unique` is a lock on work IN FLIGHT, not an idempotency key.** Once a job is
  terminal the key is free and the same work can be queued again later. A key
  built from a row id is not idempotent either — SQLite reuses ids, so
  `book-courier:4` names two different orders months apart.
- **`dispatch({ id })` IS the idempotency key, and it is the primary key.** A
  stated id makes the dispatch a no-op for all time: the work is already queued
  or already done. For a caller holding a durable id and retrying a handoff it
  cannot confirm — junction's outbox relay crosses two SQLite files, so the
  queue insert and the delivery mark cannot be one transaction, and it dispatches
  under the outbox row's id so the replay costs nothing (`FJS-D35`). Only state
  an id unique to the work itself: anything reused names a job that already ran,
  and the dispatch is silently dropped. The catch on the insert is the
  CROSS-PROCESS path — in one process there is no await between the read and the
  write, so nothing can interleave. **`unique` has the same catch now**: the
  partial index is what decides a race two processes both read nothing before,
  and the loser asks it who won rather than surfacing
  `UNIQUE constraint failed: jobs.unique_key` as a 500 out of an HTTP request —
  under exactly the shape the option exists to make safe. A key freed by the
  winner going terminal in between is one retried insert.
- **A handler takes ONE argument and it is a `JobContext`** — the job's facts
  plus `app` and `auth`. Both used to be missing, and each cost every app a
  workaround. There was no route from an autoloaded `*.job.ts` to
  `app.service(…)`, so apps grew a module holding a mutable app reference; and a
  job had no principal, and no principal is STRANGER(0), so every job carried a
  hand-written `{ auth: { user: SYSTEM } }`.
- **A job runs as whoever dispatched it, re-resolved.** `dispatch()` records
  `app.principal()?.userId` in the `actor_id` column; the worker calls
  `app.runAs(actorId, …)`, which rebuilds the principal through
  `IAuth.sessionFor` and opens the scope the handler runs in. So a service call
  in a handler names no `auth` and inherits one — and the audit trail names the
  person who asked, where it used to say `system` for every background write.
  **An id, not a session**: a caller demoted between asking and running is
  graded at what they hold now, where a replayed snapshot is a privilege that
  outlives its own revocation.
- **Nobody asked → the app's own `createApp({ system })`.** A cron fire states
  `actor: null` rather than inferring it, so a timer never depends on whether
  some unrelated request was in scope. `dispatch({ actor })` is the override in
  both directions; absent is not null, tested with `in`.
- **A job also records WHICH TENANT, and it is a second column because it is a
  second fact.** `tenant_id` beside `actor_id`, read at dispatch from
  `host.tenant()` and handed back through `runAs(actor, { tenant }, fn)`, so a
  service call in the handler resolves to the tenant that asked for the work
  without being threaded anything. Same absent-is-not-null rule as the actor:
  `tenant: null` is work that belongs to no tenant, stated. NULL is the honest
  and common value — an app that declares no tenancy, a cron fire, boot. Before
  it, a handler under row tenancy had no legal way to be IN a tenant and reached
  for `asSystem()`, which drops the gate, the row policies and the audit actor
  together to relax one of them (`FJS-384`).
  **Storing a tenant is not storing a session**: an id names WHICH ROWS, and the
  standing that decides what may be done with them is still re-resolved from
  `actor_id` at run time — so a caller who left the tenant in between is refused.
- **An actor that cannot be resolved FAILS the job by name.** A deleted user, or
  a provider with no `sessionFor`. Downgrading to STRANGER(0) is the hazard this
  removes and upgrading to `system` would be worse, so neither happens.
- **Standalone Caravan has no `runAs` and no principal** — the handler is called
  directly, `ctx.app` is `undefined` and `ctx.auth.user` is `null`. That is the
  one case a handler tests for.
- `db.asSystem()` is still the wrong fix for any of this — it writes at the Data
  boundary, where nothing announces (`FJS-010`) and every open tab keeps the
  stale row.
- **`GET /jobs` pages at 50, newest first.** The queue accumulates every job every
  drive has ever run, so an unbounded scan stops before the row you are asking
  about and reads as "there is no such job". Pass `?limit=500`.
- The admin routes are raw `app.get`/`app.post` routes, and **`app.get` applies
  the app's `apiPrefix`** — an app under `/api` serves them at `/api/jobs`. They
  used to sit at `/jobs` regardless, which is what made a separate proxy entry
  necessary (`FJS-012`).
- An old `jobs.db` is migrated on open; the schema and the code used to disagree
  in both directions (a raw `UNIQUE constraint failed` out of an HTTP request one
  way, a job that silently never ran the other).
- **`PLANNED` in `db.ts` owns the SQL whose QUERY PLAN is load-bearing**, and
  the statements are prepared from it. A prepared statement stringifies with its
  parameters expanded to their last bound values — `status = ?` comes back as
  `status = NULL` — so its plan cannot be asked for after the fact, and a test
  holding a copy of the string grades SQLite rather than this module. Two rules
  fall out of it. **A filter that can be null needs its own statement**: one
  statement is planned before anything is bound, so `($q IS NULL OR queue = $q)`
  never seeks on `queue`, and no index fixes it. And **an inert clause is not
  free** — `status IN (<every status>)` selected nothing out and cost a scrape
  1009ms at 1M rows by steering the planner (`FJS-698`).
- **`PRAGMA auto_vacuum` must precede the WAL switch**, and it reports success
  either way. Set after it, the connection that set it reads back 2 and the next
  open reads 0, so the sweep's reclaim is a silent no-op for the life of the
  file. An existing database keeps whatever it has; changing it means a full
  VACUUM.
- **The cleanup sweep is a loop, and the yield is half of the point.** The
  statement deletes one batch; batching without yielding to the event loop
  slices the write lock and still holds this process for the whole sweep. The
  batch size is measured and not monotonic — see `CLEANUP_BATCH`.

## Proving a change

`bun run test`, then `example`: `bun run verify:jobs` — API only, no browser.
The principal is not visible in those assertions; read `example/db/audit/`
afterwards, where a `book-courier` write names the staff member who shipped and
a sweep cancel names `system`.
