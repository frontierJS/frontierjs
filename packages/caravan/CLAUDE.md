# caravan — package map

**The deferred-work realm.** A SQLite-backed job queue plus cron, surfaced as
`app.jobs`. `bun run test` (bun).

---

## Where things are

`docs/layout.md` is the file-by-file map; read it when a change touches a file
this list does not name. The owners that matter on most turns:

- `src/index.ts` is `caravan()` — the public surface, queue + admin routes (raw `app.get`/`app.post`, under the app's `apiPrefix`).
- `src/db.ts` is the jobs database: schema, claim/complete/fail, migration on open; `PLANNED` owns the SQL whose query plan is load-bearing.
- `src/worker.ts` is the worker loop — claim, heartbeat, lease sweep, `ctx.signal`.
- `src/cron.ts` is `CronScheduler` — `_tickFixed` walks, `_tickWildcard` samples.
- `src/autoload.ts` finds `*.job.ts` files and stamps each with its filename; `src/types.ts` is the job/queue types.
- `bin/caravan.ts` is the operator verbs from a shell (`caravan queue …`, JSON out) — what `fli deploy:pause` runs inside the serving container.

## What bites here

The ones that bite most; the full catalog is `docs/hazards.md`, read it before
touching the claim, cron, the admin routes or the database open.

- **A job is named by its file, and a mismatch throws at load** (`FJS-2953`); a name that cannot be a filename is stated as `name:` beside a dash-spelled file.
- **`cron` is a `handle()` option, not a `schedule()` feature**, and a name is one schedule — registering twice replaces. `unschedule(name)` is only for a schedule that came from a ROW and unbinds the clock only (`FJS-D36`).
- **A running row is OWNED, and only an owner's silence releases it** — lease 30s, heartbeat 5s; a handler that blocks the event loop past the lease has its work taken (`FJS-294`, `FJS-295`).
- **A cron fire is named by its minute** (`cron:<job>:<minute>`), no leader; a wildcard schedule by the epoch minute, a fixed-time one by the WALL CLOCK minute (`FJS-525`).
- **A fixed-time schedule is WALKED, a wildcard one is SAMPLED** (`FJS-D144`); the mark only moves forward, and a wildcard schedule is never compensated. `caravan({ cronClock })` is how a test moves the clock (`FJS-3077`).
- **The database opens on first use, WAL + `synchronous = NORMAL`**, held against a concurrent cold start by bounded retries; a dispatch before `app.configure(…)` opens the DEFAULT path. `dispatchMany` is the one-transaction answer.
- **`stop()` marks the workers closed BEFORE it closes the database**; a completion after the handle is gone no-ops and the row waits for the lease.
- **A process claims only names it has a handler for, and a claim it cannot run is RELEASED** back to `pending` — never a terminal failure.
- **Every timer callback catches its own throw** — `database is locked` out of a `setInterval` is a dead process.
- **The admin routes are refused in production without an `authorize`**; `{ secret }` is a development shortcut, `data` is `[redacted]` unless `?data=1`, and `GET /jobs` pages at 50 newest first (pass `?limit=500`).
- **A pause is a ROW read inside the claim statement**; dispatch still queues into a paused queue; `'*'` is every queue and a row of its own with a `holder`. `purge()` DELETES pending rows and nothing else.
- **`pause`, `resume`, `drain`, `purge` are operator verbs** (`FJS-D198`) — ADMINISTRATOR over HTTP (`FJS-D308`), ungated as a function, which is why `fli check`'s `queue-operator-verb` refuses them in a service or job file; `queue('typo')` refuses by name, never through `ensureQueue`.
- **`unique` locks work IN FLIGHT; `dispatch({ id })` IS the idempotency key** and is dropped in silence while its row exists — `cleanupAfter` (7 days) is the replay window (`FJS-D35`). Both catch the cross-process race on the insert.
- **A handler takes ONE `JobContext`**; `ctx.signal` is the only stop (`FJS-1523`, `FJS-2885`); `ctx.progress()` is a fraction 0–1 or throws; the db route is `ctx.app.withDb((db) => …)` (`FJS-3089`), never the module client and never `db.asSystem()` (`FJS-384`).
- **A job runs as whoever dispatched it, re-resolved by id** through `app.runAs(actorId, { tenant }, fn)`; nobody asked → `createApp({ system })`; `actor`/`tenant` absent is not null (`in`); an actor that cannot be resolved FAILS the job by name. Standalone Caravan has no `runAs` — `ctx.app` is `undefined`.
- **The bin finds its database by asking `/proc`** and refuses two candidates; `test/bin.test.ts` narrows with `--pid`.
- **`PRAGMA auto_vacuum` must precede the WAL switch**, a nullable filter needs its own prepared statement, and an inert `status IN (…)` clause is not free (`FJS-698`).

---

## Proving a change

`bun run test`, then `example`: `bun run verify:jobs` — API only, no browser.
The principal is not visible in those assertions; read `example/db/audit/`
afterwards, where a `courier-book` write names the staff member who shipped and
a sweep cancel names `system`.

A change to the claim or to a pause is `test/queue-operator.test.ts`, whose
cross-instance rows use a real FILE — `:memory:` is a database per instance and
agrees with any bug — and whose statement row asks the SQL directly, with an
unpaused queue beside it. A change to the bin is `test/bin.test.ts`, which
SPAWNS it, and then `bun run ci -- --phase deploy`, whose `pauseQueueCycle` is
the only place the bin runs inside a container with no `--pid`.

<!-- layout-named: the file names fli done grades a new module against, kept here because done.js reads this file by path. The map itself is docs/layout.md.
autoload.ts caravan.ts cron.ts db.ts index.ts types.ts worker.ts
-->
