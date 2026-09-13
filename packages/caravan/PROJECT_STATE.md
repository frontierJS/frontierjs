# Caravan — Project State

_Verified 2026-08-02 by running the code. Everything below marked **verified** was
reproduced; anything else is labeled as unconfirmed._

> Drop this file into a fresh session to pick up Caravan cold.
> Read `../../CLAUDE.md` first for repo-wide vocabulary and landmines.

---

## What it is

`@frontierjs/caravan` v0.1.4 — a SQLite-backed job queue and cron scheduler,
exposed as a Junction plugin that attaches `app.jobs`.

Realm: **D5**. Sits beside Junction, not under it — Junction is inbound
(routing, hooks, services), Caravan is deferred work.

```
src/index.ts     createCaravan(), defineJob(), the Junction plugin, admin routes
src/db.ts        SQLite schema + queries
src/worker.ts    the polling worker loop
src/cron.ts      cron expression scheduling
src/autoload.ts  scans a directory for *.job.ts
src/types.ts     public types
bin/caravan.ts   the bin entry — argv, JSON, an exit code; finds a running app's
                 jobs.db through /proc, narrowed with --pid on a shared machine
tests/caravan.test.ts             queue + cron logic, direct
tests/autoload.test.ts            autoload against a real fixture directory
tests/junction-integration.test.ts  the plugin against a real booted Junction app
tests/job-context.test.ts         who a job runs as, against a real app + auth
tests/declaration.test.ts         what a job file declares: its cron, and its name
tests/hardening.test.ts           the admin surface, and four processes on one jobs.db
tests/ownership.test.ts           two instances: heartbeat, recovery, one cron fire
tests/timeout.test.ts             a bounded attempt, and the orphan it announces
tests/stated-id.test.ts           dispatch({ id }) as the idempotency `unique` is not
tests/outbox-relay.test.ts        junction's outbox handed over under the row's id
tests/cron-dst.test.ts            the hours a clock change adds and removes
tests/cron-grammar.test.ts        what a five-field expression means, the toolbelt kit
tests/scale.test.ts               the query plans /metrics, /health and list depend on
tests/queue-operator.test.ts      pause/resume/drain, a real file, a second instance
tests/correlation.test.ts         a dispatched job's trace context, carried through
tests/bin.test.ts                 spawns bin/caravan.ts for real — argv, JSON, exit code
tests/fixtures/jobs/              committed *.job.ts fixtures for autoload
tests/fixtures/cron-jobs/         a job file that declares its own schedule
tests/fixtures/bad-jobs/          a job whose name disagrees with its file
```

## Verified state

| | |
|---|---|
| Tests | **220 pass, 0 fail**, 12 files (`bun run test`) — verified. See `CHANGES.md` 2026-08-06 for the three defects `example/` found, 2026-08-16 for the job principal, 2026-09-02 for what two processes on one jobs.db could not survive, and 2026-09-03 for what the admin surface cost at 1M rows |
| Known flake | `tests/cron-dst.test.ts` › the two *two instances over one jobs.db* cases fail intermittently, with `unable to open database file` under them. Pre-existing and measured against a HEAD copy — `FJS-729` |
| Typecheck | **clean, 0 errors, no baseline** (`bun run typecheck`) — verified |
| Public exports | `createCaravan`, `defineJob`, plus types — verified |
| Who a job runs as | the principal recorded at `dispatch()`, **re-resolved** through `app.runAs` when it runs. Nobody asked → `createApp({ system })`. `tests/job-context.test.ts` |
| Plugin seam | `register()` claims `app.jobs`, calls `app.registerMetricsSource('jobs', …)`, and optionally mounts admin routes — all three now asserted against a real app |

Reproduce: `cd packages/caravan && bun run test && bun run typecheck`.

`bun run test` is now bare `bun test` (it used to name one file, so a new test
file would not have run).

---

## The `junction.config.js` caravan section

Open defects are in `../../ISSUES.md`; add a new item there, not here.

Junction publishes `JunctionCaravanConfig` with `db`, `jobsDir`, `pollInterval`,
`cleanupAfter`, `queues` and `admin` (`src/config/index.ts`), and `register()`
honors every one of them, opts always winning.

**The database opens on first use and the workers are built in `start()`**,
after autoload — nothing reads an option until the moment it needs it, which is
what makes a config file able to set any of them (`FJS-048`).

Two things follow from that and are worth knowing:

- A dispatch or a read **before** `app.configure(createCaravan(…))` opens the
  database at the default path, and a configured path can no longer take effect.
  `register()` says so by path rather than running against a file the app did
  not name.
- `stop()` closes the database, so the pool forgets its workers — they hold that
  handle and its prepared statements. A `start()` after a `stop()` builds both
  again.

---

## Conventions that apply here

- Run tests with **`bun run test`** — here that runs bare `bun test`, but use
  the script rather than invoking the runner directly, since that is what CI
  and every other package's convention expects.
- The plugin protocol is `{ name, register, boot, ready, shutdown }` —
  `packages/junction/src/core/app.ts`.
- Raw admin routes: params are `{id}`, headers are `ctx.headers`, and a denial
  is a thrown error carrying a numeric `status`. The first two were bugs; the
  third works only because Junction's error boundary was fixed to read it.
- If you add an `app.<thing>` from this package, augment an **interface**
  Junction exports; do not redeclare the property.
- `app.registerMetricsSource` is a declared seam rather than the private-field
  reach-in this used to be (`FJS-D06`). The call is still optional, because
  Caravan runs against hosts that are not Junction apps — so the integration
  test against a real app is what proves the seam is really there.

## Unconfirmed

- Whether the worker's polling loop leaks timers on `shutdown()`. The
  integration test asserts no *further jobs are processed* after shutdown, which
  is the observable behavior; it does not inspect timer handles. The interval
  timers are `unref()`'d, so they would not hold the process open regardless.
- Whether `defineJob()`'s `__caravanJob` marker survives a bundler.
- Retry/backoff timing under real failure load is covered only by the direct
  unit tests, not end-to-end.
