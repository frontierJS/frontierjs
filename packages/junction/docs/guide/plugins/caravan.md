# Jobs with Caravan

`@frontierjs/caravan` is a SQLite-backed job queue that mounts on the app as `app.jobs`. A job survives a restart, retries on failure, and runs as whoever dispatched it. Jobs, queues and schedules are the package's own doc; this page shows the shortest run.

```ts
import { caravan } from '@frontierjs/caravan'

const queue = caravan({ db: ':memory:', pollInterval: 20 })
app.configure(queue)

const done: string[] = []
const finished = new Promise<void>(resolve => {
  queue.handle('send-email', async (ctx) => {
    done.push(ctx.data.to)
    resolve()
  }, { maxAttempts: 3 })
})

await queue.start()
await queue.dispatch('send-email', { to: 'alice@example.com' })
await finished
await queue.stop()

if (done[0] !== 'alice@example.com') throw new Error(`expected the job to run, got ${JSON.stringify(done)}`)
```

## What else it can do

- A `jobs/send-email.job.ts` file with `defineJob({ queue, maxAttempts, handler })` loads on its own, and its default export is the dispatch handle
- `dispatch(job, data, { queue, delay, priority, unique })` queues onto a named queue, later, sooner, or once at a time
- `cron: '0 3 * * *'` on a job file runs it on a schedule that survives a restart
- A handler runs as the principal in scope at dispatch, and a timer runs as `createApp({ system })`
- `retryDelay` sets the backoff, and a job that runs out of attempts is `dead` until `retry(id)`
- `cancel(id)`, `stats()` and pausing a queue manage work in flight
- Job counts appear in `GET /metrics` under `jobs`
- `ctx.enqueue(job, payload)` inside a service call [writes the job with the transaction](../writes/enqueue.md)

**In depth:** [Caravan README § Quick start](../../../../caravan/README.md#quick-start)
