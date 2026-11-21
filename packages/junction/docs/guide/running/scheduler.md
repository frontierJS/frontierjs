# The scheduler

`app.scheduler` runs a function on a clock inside the process: every interval, on a cron expression, or once after a delay. It is for light housekeeping, and each call returns a handle you can pause or stop.

```ts
let ticks = 0
const every = app.scheduler.every('20ms', async () => { ticks++ })

// A cron expression is checked when it is registered, and the clock it reads is UTC
app.scheduler.cron('0 2 * * *', async () => { /* nightly backup */ })

const warmed = new Promise<void>(resolve => app.scheduler.once('20ms', () => resolve()))

app.scheduler.arm()
await warmed
await new Promise(r => setTimeout(r, 100))
every.stop()

if (ticks < 2) throw new Error(`expected the interval to fire, got ${ticks}`)
if (app.scheduler.stats().errors !== 0) throw new Error('a job failed')
```

## What else it can do

- `every('5 minutes', fn)` takes `'30s'`, `'1 hour'` and the like, and refuses a zero or unreadable interval
- `cron('0 2 * * *', fn)` takes a five-field expression and refuses one that can never fire
- `once('30 seconds', fn)` runs one time and drops itself
- A handle has `pause()`, `resume()`, `stop()` and `start()`
- A tick that arrives while the last run is still going is dropped and counted in `stats().skipped`
- `stats()` counts executions and errors, and `describe()` lists what this process runs on a clock
- Timers hold no row, no retry and no principal, so work that must survive a restart is a [Caravan](../plugins/caravan.md) job
- Put a timer in `work()`, not `boot()`, or every one-shot process starts it

**In depth:** [README § Scheduler](../../../README.md#scheduler)
