# Circuit breaker

A service that calls something unreliable can stop calling it once it keeps failing. `circuitBreaker()` is an `around` hook that opens after a run of failures, answers `503` without running the method, and probes again after a timeout.

```ts
import { circuitBreaker } from '@frontierjs/junction/hooks'

let calls = 0
app.services.register(createService({
  name: 'rates',
  async find() { calls++; throw new Error('upstream is down') },
  hooks: {
    around: { all: [circuitBreaker({ threshold: 2, timeout: 30_000 })] },
  },
}))

const rates = app.service('rates')
for (let i = 0; i < 2; i++) await rates.find({}).catch(() => {})

let status = 0
await rates.find({}).catch(e => { status = e.status ?? e.code })
if (status !== 503) throw new Error(`expected 503 from an open circuit, got ${status}`)
if (calls !== 2) throw new Error(`the open circuit still called the method (${calls} calls)`)
```

## What else it can do

- `threshold` is the consecutive failures that open it, and `timeout` is how long to wait before probing again
- After the timeout one call goes through, and a success closes the circuit while a failure reopens it
- `onOpen(ctx)`, `onHalfOpen(ctx)` and `onClose(ctx)` observe the change, for a log line or an alert
- The open answer is `Unavailable` (503), so error hooks and logging still run
- One hook instance is one circuit: it counts the failures of every method it wraps together

**In depth:** [README § Circuit breaker](../../../README.md#circuit-breaker)
