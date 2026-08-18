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

queue.handle('send-email', async (ctx) => {
  await mailer.send(ctx.data)
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

A job file declares everything about that job: what it does, which queue it runs
on, how it retries, and — with `cron` — when it runs on its own. Nothing about a
job belongs in `app.ts`.

```ts
// jobs/send-email.job.ts
import { defineJob } from '@frontierjs/caravan'

export default defineJob<{ to: string }>('send-email', async (ctx) => {
  // ctx.app is the running Junction app — reach the service layer from here.
  await mailer.send(ctx.data)
}, {
  queue:       'email',
  maxAttempts: 5,
  retryDelay:  [60_000, 300_000, 1_800_000, 7_200_000],
})
```

**A job in `jobsDir` is named by its file.** `send-email.job.ts` is
`send-email`, and a `defineJob` name that disagrees is refused at load, naming
both — a handler answering to `send-emial` while every dispatch says
`send-email` fails as a job that silently never runs, which is the worst way
this package can break. Rename the file, or register the job by hand with
`queue.handle()` from outside `jobsDir`.

**The default export is also the dispatch handle.** Import it and the name is
stated nowhere else:

```ts
import sendEmail from './jobs/send-email.job.ts'

await app.jobs.dispatch(sendEmail, { to: 'alice@example.com' })  // typed payload
```

## API

### `createCaravan(opts?)`

| Option | Default | Description |
|--------|---------|-------------|
| `db` | `'./db/jobs.db'` | SQLite file path. Use `':memory:'` for tests. |
| `queues` | `{ default: { concurrency: 2 } }` | Named queue config |
| `pollInterval` | `1000` | How often to poll for new jobs (ms) |
| `jobsDir` | — | Directory to autoload `*.job.ts` files from |
| `cleanupAfter` | 7 days | How long terminal jobs are kept. `0` disables the sweep |
| `admin` | `false` | Mount the admin routes. `{ path, secret }` to configure them |
| `heartbeat` | `5000` | How often this instance says it is alive (ms) — also how often abandoned work is reclaimed |
| `lease` | `30000` | How long an instance may go quiet before its running jobs are treated as abandoned (ms) |

Every one of these can come from the `caravan` section of `junction.config.js`
instead, with an option stated here winning. The database opens on first use and
the workers are built by `start()`, so nothing is spent before the app hands its
config over — but a dispatch made *before* `app.configure(…)` does open it, at
the default path, and `register()` warns by path rather than running against a
file the app did not name.

### `queue.dispatch(job, data, opts?)`

Enqueue a job. Takes a definition — the import from its file — or the name in
one. Returns the job ID.

```ts
import sendEmail from './jobs/send-email.job.ts'

await queue.dispatch(sendEmail, { to: 'alice@example.com' })  // name from the file
await queue.dispatch('send-email', { to: 'alice@example.com' })
await queue.dispatch('deploy', { version: '1.2.3' }, {
  queue:    'critical',
  delay:    5_000,      // run after 5 seconds
  priority: 10,         // higher = sooner
  unique:   'deploy:1.2.3',  // idempotency key — see below
  actor:    'usr_123',       // whose behalf. Default: whoever is in scope
})
```

`unique` is a lock on work **in flight**: if a job with that key is pending or
running, the dispatch is a no-op and returns that job's id. Two clicks a second
apart book one courier. Once the job finishes the key is free, so the same work
can be queued again later — this is "only one of these at a time", not an
idempotency key. A key built from a row id is not one either: SQLite reuses ids,
so `book-courier:4` can name two different orders months apart.

`actor` almost never needs stating — see **Who a job runs as** below.

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

### `queue.handle(name, handler, opts?)` · `queue.handle(definition)`

Register a handler for a job type. Must be called before `start()`.

```ts
queue.handle('send-email', async (ctx) => {
  // ctx.id, ctx.queue, ctx.name, ctx.data, ctx.attempts
  // ctx.app, ctx.auth, ctx.actorId — see "Who a job runs as" below
  await mailer.send(ctx.data)
}, {
  queue:       'email',
  maxAttempts: 3,
  retryDelay:  [60_000, 300_000, 1_800_000],
  cron:        '0 3 * * *',   // optional — see Recurring work
  timeZone:    'Europe/London',
})

queue.handle(sendEmail)   // a definition already states all of the above
```

## Recurring work

`cron` on a registration is the whole declaration. A `*.job.ts` file carrying
one is scheduled by being autoloaded; the fire dispatches the job with an empty
payload, onto the queue that same registration names, as the application itself
(`actor: null` — a timer never inherits whatever request happened to be in
scope).

```ts
// jobs/sweep-abandoned.job.ts
export default defineJob('sweep-abandoned', sweep, { cron: '0 3 * * *' })
```

`queue.schedule(name, expr, handler, opts?)` is sugar over the same
registration, for a handler that is not a job file — a closure, or a function
imported from outside `jobsDir`. A name is one schedule: registering it again
replaces it rather than firing the job twice.

`queue.nextRuns()` answers `{ name, cron, nextRun }` per schedule, which proves
a schedule exists and nothing about the handler behind it —
`POST /jobs/run/{name}` is how the behaviour gets exercised.

### `queue.cancel(id)`

Cancel a job. Works on pending or running jobs. Returns `true` if cancelled, `false` if not found or already terminal (done/failed/cancelled). For running jobs, the cancel is recorded immediately — the handler may still complete its current attempt, but the job's status is `cancelled` from that point forward.

### `queue.retry(id)`

Re-queue a `failed` or `cancelled` job (resets attempts to 0, clears error). Returns `true` if re-queued.

### `queue.stats()`

```ts
{
  queues: {
    default:  { pending: 4,  running: 2, done: 91,  failed: 1, cancelled: 0 },
    critical: { pending: 0,  running: 1, done: 12,  failed: 0, cancelled: 0 },
    email:    { pending: 12, running: 1, done: 340, failed: 3, cancelled: 1 },
  },
  total: { pending: 16, running: 4, done: 443, failed: 4, cancelled: 1 }
}
```

`done` is the retention window, not all time — the cleanup sweep deletes
terminal jobs past `cleanupAfter`, which is what makes it a rate rather than a
total. It is also the only number here that distinguishes a busy queue from an
idle one, which matters because Junction's `/metrics` reads this same source.

### `queue.start()` / `queue.stop()`

Start/stop the worker polling loop. `stop()` waits for in-flight jobs to finish (up to 30s).

## Who a job runs as

Deferred work runs long after the request that asked for it, so by the time a
handler runs there is no session to inherit. A job used to get no principal at
all — and no principal is `STRANGER(0)`, refused by the model's own `@@gate` —
so every job carried a hand-written `{ auth: { user: SYSTEM } }`, which *also*
meant work a customer asked for was done with the authority of the application.

Now `dispatch()` records who asked and the worker runs the handler on their
behalf:

```ts
// In a service, handling a signed-in caller's request:
await app.jobs.dispatch('book-courier', { orderId })

// In the handler — no `auth`, no module-level app reference:
export default defineJob('book-courier', async (ctx) => {
  const code = await courier.book(ctx.data)
  await ctx.app.service('orders').call('recordTracking', ctx.data.orderId, { trackingCode: code })
})
```

The service call names no principal and inherits the one the job runs as, the
same way any nested call does. The audit trail names the person who asked.

**An id is stored, not a session.** The standing is re-resolved when the job
runs, through `IAuth.sessionFor(userId)`. A caller demoted, suspended or stripped
of a role between asking and running is graded at what they hold *now* — a
replayed snapshot would be a privilege that outlives its own revocation, for as
long as the retry schedule runs.

| At dispatch | The handler runs as |
| --- | --- |
| a request is in scope | that caller, re-resolved |
| nothing is in scope — a cron fire, boot | the app's own `createApp({ system })` |
| `{ actor: 'usr_123' }` | that user, re-resolved |
| `{ actor: null }` | the app's own `system`, even inside a request |
| standalone Caravan (no Junction) | nobody — `ctx.auth.user` is `null` |

An actor that cannot be resolved — a deleted user, or an auth provider with no
`sessionFor` — **fails the job by name**. Falling back to no principal is the
defect this removes; falling back to the system principal would be worse.

An app that declares no `system` gets `null` rather than an invented privileged
identity, which is the right answer for an app whose background work touches
nothing gated.

### The context a handler receives

| | |
| --- | --- |
| `ctx.id` · `ctx.queue` · `ctx.name` · `ctx.data` · `ctx.attempts` | the job |
| `ctx.app` | the running Junction app. `undefined` standalone |
| `ctx.auth.user` | the principal this runs as. `null` when there is none |
| `ctx.actorId` | the id recorded at dispatch. `null` when nobody asked |

## Retry behaviour

Retry delays are configured per handler as an array of millisecond values. Index 0 is the delay before the 2nd attempt, index 1 before the 3rd, etc. If attempts exceed the array length, the last value is reused.

```ts
retryDelay: [60_000, 300_000, 1_800_000]
// attempt 2: wait 1m
// attempt 3: wait 5m
// attempt 4+: wait 30m
```

Jobs that exhaust `maxAttempts` are marked `failed` and kept in the database for inspection. Use `queue.retry(id)` to re-queue them. Jobs cancelled via `queue.cancel(id)` are marked `cancelled` and can also be re-queued with `queue.retry(id)`.

## Crash recovery, and more than one instance

A jobs database can be opened by more than one process — two replicas behind a
load balancer, a web process beside a worker one — so *is this `running` row
being executed by anybody?* is a real question rather than an assumption.

Every instance takes an id when it is created, writes it onto each row it
claims, and says it is alive on the `heartbeat` timer. That timer also does the
recovery: a `running` row whose owner has not been heard from within `lease` is
work nothing is doing, so it goes back to `pending` and someone claims it. A row
owned by an instance that is still heartbeating is left alone, and a completion
only lands if the instance writing it still owns the row. A clean `stop()` hands
this instance's ownership back immediately rather than making everyone wait out
the lease.

Cron needs no leader for the same reason. Every instance fires its own schedule
and dispatches under an id naming the job and the minute — `cron:sweep:29123456`
— so the second fire in that minute is a no-op rather than a second row. Leader
election would instead miss fires whenever the lease was between owners.

Two limits, both about the clock. Instances must agree on the time to within a
minute, which is what cron already assumes to fire at the right time at all. And
the heartbeat is a timer: a handler that **blocks** the event loop for longer
than `lease` stalls its own heartbeat and has its work reclaimed under it — work
that does not yield is work this queue cannot supervise.

## Tests

```bash
bun test
```
