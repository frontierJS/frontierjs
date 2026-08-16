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
