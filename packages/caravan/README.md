# @frontierjs/caravan

SQLite-backed job queue for Bun. Zero external dependencies. First-party Junction plugin.

## Install

```bash
bun add @frontierjs/caravan
```

## Quick start

```ts
import { createCaravan } from '@frontierjs/caravan'

const queue = createCaravan({
  db:          './jobs.db',   // default
  pollInterval: 1_000,        // ms
  queues: {
    default:  { concurrency: 2 },
    critical: { concurrency: 5 },
    email:    { concurrency: 1 },
  },
})

queue.handle('send-email', async (job) => {
  await mailer.send(job.data)
}, { queue: 'email', maxAttempts: 5, retryDelay: [60_000, 300_000, 1_800_000] })

await queue.start()
await queue.dispatch('send-email', { to: 'alice@example.com' })
```

## As a Junction plugin

```ts
import { createCaravan } from '@frontierjs/caravan'

const queue = createCaravan({ jobsDir: './jobs' })

app.configure(queue)
// Now available as app.jobs
// Job stats automatically added to GET /metrics
```

## File-based handlers

```ts
// jobs/send-email.job.ts
import { defineJob } from '@frontierjs/caravan'

export default defineJob('send-email', async (job) => {
  await mailer.send(job.data)
}, {
  queue:       'email',
  maxAttempts: 5,
  retryDelay:  [60_000, 300_000, 1_800_000, 7_200_000],
})
```

## API

### `createCaravan(opts?)`

| Option | Default | Description |
|--------|---------|-------------|
| `db` | `'./jobs.db'` | SQLite file path. Use `':memory:'` for tests. |
| `queues` | `{ default: { concurrency: 2 } }` | Named queue config |
| `pollInterval` | `1000` | How often to poll for new jobs (ms) |
| `jobsDir` | — | Directory to autoload `*.job.ts` files from |

### `queue.dispatch(name, data, opts?)`

Enqueue a job. Returns the job ID.

```ts
await queue.dispatch('send-email', { to: 'alice@example.com' })
await queue.dispatch('deploy', { version: '1.2.3' }, {
  queue:    'critical',
  delay:    5_000,      // run after 5 seconds
  priority: 10,         // higher = sooner
  unique:   'deploy:1.2.3',  // idempotency key — see below
})
```

`unique` is a lock on work **in flight**: if a job with that key is pending or
running, the dispatch is a no-op and returns that job's id. Two clicks a second
apart book one courier. Once the job finishes the key is free, so the same work
can be queued again later — this is "only one of these at a time", not an
idempotency key. A key built from a row id is not one either: SQLite reuses ids,
so `book-courier:4` can name two different orders months apart.

### `POST /jobs/run/{name}` — run a registered job now

Part of the admin routes. Dispatches a registered handler immediately; the
request body becomes the job's data, so a scheduled handler can be given a
different parameter by hand. Answers 404 for a name with no handler, rather than
queueing work no worker will pick up.

```bash
curl -X POST localhost:3000/jobs/run/sweep-abandoned -d '{"days":0}'
# → { "ok": true, "id": "…" }
```

This is how a cron's *behaviour* gets tested. `nextRuns()` only proves a
schedule was registered.

### `queue.handle(name, handler, opts?)`

Register a handler for a job type. Must be called before `start()`.

```ts
queue.handle('send-email', async (job) => {
  // job.id, job.queue, job.name, job.data, job.attempts
  await mailer.send(job.data)
}, {
  queue:       'email',
  maxAttempts: 3,
  retryDelay:  [60_000, 300_000, 1_800_000],
})
```

### `queue.cancel(id)`

Cancel a job. Works on pending or running jobs. Returns `true` if cancelled, `false` if not found or already terminal (done/failed/cancelled). For running jobs, the cancel is recorded immediately — the handler may still complete its current attempt, but the job's status is `cancelled` from that point forward.

### `queue.retry(id)`

Re-queue a `failed` or `cancelled` job (resets attempts to 0, clears error). Returns `true` if re-queued.

### `queue.stats()`

```ts
{
  queues: {
    default:  { pending: 4, running: 2, failed: 1, cancelled: 0 },
    critical: { pending: 0, running: 1, failed: 0, cancelled: 0 },
    email:    { pending: 12, running: 1, failed: 3, cancelled: 1 },
  },
  total: { pending: 16, running: 4, failed: 4, cancelled: 1 }
}
```

### `queue.start()` / `queue.stop()`

Start/stop the worker polling loop. `stop()` waits for in-flight jobs to finish (up to 30s).

## Retry behaviour

Retry delays are configured per handler as an array of millisecond values. Index 0 is the delay before the 2nd attempt, index 1 before the 3rd, etc. If attempts exceed the array length, the last value is reused.

```ts
retryDelay: [60_000, 300_000, 1_800_000]
// attempt 2: wait 1m
// attempt 3: wait 5m
// attempt 4+: wait 30m
```

Jobs that exhaust `maxAttempts` are marked `failed` and kept in the database for inspection. Use `queue.retry(id)` to re-queue them. Jobs cancelled via `queue.cancel(id)` are marked `cancelled` and can also be re-queued with `queue.retry(id)`.

## Crash recovery

On `start()`, Caravan resets any jobs stuck in `running` state back to `pending`. This handles the case where the process crashed mid-execution.

## Tests

```bash
bun test
```
