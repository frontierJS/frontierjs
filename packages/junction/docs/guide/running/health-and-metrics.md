# Health and metrics

`health()` mounts the probes an orchestrator asks and `GET /metrics` for the numbers. Readiness is `/health`, liveness is `/health/live`, and a check you name decides which of the two answers `503`.

```ts
import { health, request } from '@frontierjs/junction'

let cacheUp = true
app.configure(health({
  checks: { cache: async () => cacheUp },
}))

const ready = await request(app).get('/health')
if (ready.status !== 200) throw new Error(`expected 200, got ${ready.status}`)

cacheUp = false
const down = await request(app).get('/health')
if (down.status !== 503) throw new Error(`expected 503, got ${down.status}`)

// Liveness consults no check: the process is up even when a dependency is not
const live = await request(app).get('/health/live')
if (live.status !== 200) throw new Error(`expected 200, got ${live.status}`)
```

## What else it can do

- Point a `readinessProbe` at `/health` and a `livenessProbe` at `/health/live`
- `health({ path, token, checks })` moves the path and gates the endpoints with a bearer token
- There is no built-in database check, so name your client's in `checks`
- `GET /metrics` reports memory, request counts, WebSocket connections, cache hit rate and the service registry
- Outside development `/metrics` is not mounted until `token` or `authFn` is set
- `app.registerMetricsSource(name, fn)` adds a block to `/metrics`, as Caravan does for `jobs`
- `app.registerReadiness(name, fn)` adds a check beside the app's, as the outbox does
- `otlp({ endpoint })` from `@frontierjs/junction/otlp` exports spans, the log and every metric to an OpenTelemetry collector
- `app.registerDevService(name, { url, note })` puts a sidecar you started on the boot banner and in `/manifest`

**In depth:** [README § Health and metrics](../../../README.md#health-and-metrics)
