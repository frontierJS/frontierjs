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
  `cron:<job>:<epoch-minute>` is the dispatch id, so every instance fires its
  own schedule and all but the first are the no-op a stated id already is. There
  is no leader on purpose — a lease-held leader misses fires whenever the lease
  is between owners. The assumption instead is that two clocks agree to within a
  minute, which cron already makes.
- **The database opens on first use and the workers are built by `start()`.**
  Nothing reads an option until it is needed, which is what makes every key of
  the `caravan` section of `junction.config.js` settable. The cost: a dispatch
  before `app.configure(…)` opens the queue at the DEFAULT path and a configured
  one can no longer apply — `register()` warns by path. `stop()` closes that
  database and the pool forgets its workers, so a restart builds both again.
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
  write, so nothing can interleave.
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

## Proving a change

`bun run test`, then `example`: `bun run verify:jobs` — API only, no browser.
The principal is not visible in those assertions; read `example/db/audit/`
afterwards, where a `book-courier` write names the staff member who shipped and
a sweep cancel names `system`.
