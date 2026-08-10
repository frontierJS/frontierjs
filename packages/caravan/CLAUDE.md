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

- **`unique` is a lock on work IN FLIGHT, not an idempotency key.** Once a job is
  terminal the key is free and the same work can be queued again later. A key
  built from a row id is not idempotent either — SQLite reuses ids, so
  `book-courier:4` names two different orders months apart.
- **A background job has no principal, and no principal is STRANGER(0).** A job
  writing back through `app.service('x').patch(…)` is refused by the model's own
  `@@gate` unless you pass one: `{ auth: { user: SYSTEM } }`, graded in the app's
  `getLevel`. `example/api/gate.ts` is the pattern. `db.asSystem()` is the wrong
  fix — it writes at the Data boundary, where nothing announces (`FJS-010`) and
  every open tab keeps the stale row.
- **`GET /jobs` pages at 50, newest first.** The queue accumulates every job every
  drive has ever run, so an unbounded scan stops before the row you are asking
  about and reads as "there is no such job". Pass `?limit=500`.
- Raw routes here take **no `apiPrefix`** — it is `/jobs`, not `/api/jobs`. An
  app proxying to the API needs its own entry for that path.
- An old `jobs.db` is migrated on open; the schema and the code used to disagree
  in both directions (a raw `UNIQUE constraint failed` out of an HTTP request one
  way, a job that silently never ran the other).

## Proving a change

`bun run test`, then `example`: `bun run verify:jobs` — API only, no browser.
