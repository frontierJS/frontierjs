# Changes — @frontierjs/caravan

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
