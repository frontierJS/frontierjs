// transport/health.ts
// Built-in /health and /metrics endpoints.
//
// /health  — liveness + readiness check for load balancers and orchestrators.
//            Returns 200 OK or 503 Service Unavailable.
//
// /metrics — detailed runtime snapshot for dashboards and alerting.
//            Always returns 200 (the data describes health, not the endpoint itself).
//
// `collectHealth()` and `collectMetrics()` are the bodies of those two answers,
// exported because the endpoint is not the only reader: the devtools console
// runs on its own port and used to hand-build a metrics object of its own,
// which never consulted the plugin registry — so a queue that contributed its
// stats through `registerMetricsSource` appeared at /metrics and nowhere else
// (`FJS-414`). One owner per answer; a route is a caller.
//
// Both are registered as a plugin:
//
//   app.configure(healthPlugin())
//   app.configure(healthPlugin({ path: '/_internal', token: process.env.METRICS_TOKEN }))
//
// Auth: pass a static bearer token or a custom check function.
// If no auth is configured the endpoints are public — fine for internal
// networks, should be locked down for internet-facing deployments.

import type { App }              from '../core/app.ts'
import type { TransportContext } from './types.ts'

// ─── Options ──────────────────────────────────────────────────────────────

export interface HealthPluginOptions {
  // URL path prefix. Defaults to '' → /health and /metrics
  // Set to e.g. '/_internal' → /_internal/health and /_internal/metrics
  path?: string

  // Optional auth guard — either a static bearer token or an async function.
  // If omitted, endpoints are public.
  token?:   string
  authFn?:  (ctx: TransportContext) => boolean | Promise<boolean>

  // Custom readiness checks — called on every /health request.
  // Return true if the check passes, false (or throw) if it fails.
  // The check name appears in the response body.
  //
  // Example:
  //   checks: {
  //     redis: async () => { await redisClient.ping(); return true },
  //     thirdParty: async () => { ... }
  //   }
  checks?: Record<string, () => boolean | Promise<boolean>>
}

// ─── Response shapes ──────────────────────────────────────────────────────

export interface HealthResponse {
  status:   'ok' | 'degraded' | 'down'
  app:      string
  version:  string
  uptime:   number           // seconds since app.start()
  checks:   Record<string, CheckResult>
  ts:       string           // ISO timestamp
}

export interface CheckResult {
  status:   'ok' | 'fail'
  latencyMs?: number
  error?:   string
}

export interface MetricsResponse {
  app:      string
  version:  string
  uptime:   number
  ts:       string
  process: {
    memoryMb:    number      // RSS in MB
    heapUsedMb:  number
    heapTotalMb: number
    pid:         number
    nodeVersion: string
  }
  http: {
    requests:  Record<string, number>   // total, get, post… blocked
    responses: Record<string, number>   // json, html, text… error
    online:    number                   // active WebSocket connections
  }
  services: {
    registered: string[]
    count:      number
    details:    Record<string, {
      customMethods: string[]
      /** Everything callable, CRUD and custom, after the `methods:` policy. */
      methods:   string[]
      allowBulk: boolean
    }>
  }
  cache: {
    hits:    number
    misses:  number
    sets:    number
    evicts:  number
    size:    number
    hitRate: string          // e.g. "94.3%"
  }
  /** Additional stats contributed by plugins (e.g. Caravan job queue stats). */
  [key: string]: unknown
}

// ─── Collectors ───────────────────────────────────────────────────────────
// The two answers, separated from the routes that serve them.

/** A check's result, timed and named — a throw is a failure carrying its message. */
async function timedCheck(fn: () => boolean | Promise<boolean>): Promise<CheckResult> {
  const t = Date.now()
  try {
    const ok = await fn()
    return { status: ok ? 'ok' : 'fail', latencyMs: Date.now() - t }
  } catch (err) {
    return { status: 'fail', latencyMs: Date.now() - t, error: (err as Error).message }
  }
}

/**
 * Every readiness check that applies to this app: the built-in database probe,
 * the ones plugins registered, then the ones the app author declared.
 *
 * App-declared last so a name it states wins — the plugin registered its check
 * without knowing what the app knows about the same resource.
 *
 * It takes no `checks` argument: `healthPlugin({ checks })` puts them on the
 * APP, so every reader answers the same set. Held in the plugin's closure they
 * were invisible to the devtools console, which answers readiness on its own
 * port and therefore reported a healthy app while `/health` was still deciding
 * — two surfaces disagreeing about one question, which is the whole of what
 * `FJS-414` was.
 */
export async function collectHealth(app: App, startedAt: number): Promise<HealthResponse> {
  const results: Record<string, CheckResult> = {}

  // Built-in: database check — only for a raw bun:sqlite handle (db.db.query).
  // Other clients don't expose that shape; probing them here reported a
  // healthy app as degraded. They skip the built-in and declare their own
  // check instead. The shape probe itself must sit inside the try — a
  // Litestone proxy throws on unknown property access rather than returning
  // undefined.
  const dbCheck = (() => {
    try {
      const rawDb = app.db as { db?: { query?: (s: string) => { get: () => unknown } } } | undefined
      const query = rawDb?.db?.query
      return typeof query === 'function' ? { query: query.bind(rawDb!.db) } : null
    } catch { return null }
  })()
  if (dbCheck) results.database = await timedCheck(() => { dbCheck.query('SELECT 1').get(); return true })

  for (const [name, fn] of app._healthChecks    ?? new Map()) results[name] = await timedCheck(fn)
  for (const [name, fn] of app._healthChecksApp ?? new Map()) results[name] = await timedCheck(fn)

  const anyFail = Object.values(results).some(c => c.status === 'fail')

  // Read per REQUEST rather than off `app.config` directly. The app's own name
  // is the shape a tenant varies — one deployment, many customers, each of whom
  // thinks it is theirs — and `configFor` is where that becomes true for every
  // reader at once instead of for whichever one was found again (`FJS-D126`).
  //
  // Not `$.config`: a health route is a raw route and holds no service call.
  const cfg = app.configFor?.() ?? app.config

  return {
    status:  anyFail ? 'degraded' : 'ok',
    app:     cfg?.name    ?? 'junction',
    version: cfg?.version ?? '',
    uptime:  Math.floor((Date.now() - startedAt) / 1000),
    checks:  results,
    ts:      new Date().toISOString(),
  }
}

/**
 * The runtime snapshot, plugin sections included.
 *
 * Every field is read defensively: this runs against the devtools' own view of
 * an app as well as a fully started one, and a metrics answer that throws is
 * worth less than one missing a number.
 */
export function collectMetrics(app: App, startedAt: number): MetricsResponse {
  const mem      = process.memoryUsage()
  const stats    = app.http?.stats
  const cache    = app.cache?.stats?.() ?? { hits: 0, misses: 0, sets: 0, evicts: 0, size: 0 }
  const hitRate  = cache.hits + cache.misses > 0
    ? ((cache.hits / (cache.hits + cache.misses)) * 100).toFixed(1) + '%'
    : 'n/a'
  const services = app.services?.list() ?? []

  const cfg = app.configFor?.() ?? app.config

  const body: MetricsResponse = {
    app:     cfg?.name    ?? 'junction',
    version: cfg?.version ?? '',
    uptime:  Math.floor((Date.now() - startedAt) / 1000),
    ts:      new Date().toISOString(),

    process: {
      memoryMb:    +(mem.rss       / 1024 / 1024).toFixed(2),
      heapUsedMb:  +(mem.heapUsed  / 1024 / 1024).toFixed(2),
      heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
      pid:         process.pid,
      nodeVersion: process.version,
    },

    http: {
      requests:  { ...(stats?.request  ?? {}) },
      responses: { ...(stats?.response ?? {}) },
      online:    stats?.performance.online ?? 0,
    },

    services: {
      registered: services,
      count:      services.length,
      // Per-service detail: custom method names and bulk-operation flag.
      // Powers the REPL `services` command's full route display.
      details: Object.fromEntries(
        services.map(name => {
          const d = app.services.get(name)!.describe()
          return [name, {
            // describe() is the one answer, shared with /manifest and the
            // OpenAPI generator. This used to read a key no service has,
            // so /metrics reported an empty list for every service,
            // always, while /manifest listed them correctly.
            // Policy-filtered, so a method a `methods:` allow-list
            // withholds is not reported as available.
            customMethods: d.customMethods.filter(m => d.methods.includes(m)),
            methods:   d.methods,
            allowBulk: d.allowBulk,
          }]
        })
      ),
    },

    cache: {
      hits:   cache.hits,
      misses: cache.misses,
      sets:   cache.sets,
      evicts: cache.evicts,
      size:   cache.size,
      hitRate,
    },
  }

  // Plugin sections — a broken source must not take the whole answer down.
  for (const [key, fn] of app._metricsSources ?? new Map()) {
    try { body[key] = fn() } catch { /* one bad source is not an outage */ }
  }

  return body
}

// ─── Plugin factory ───────────────────────────────────────────────────────

export function healthPlugin(opts: HealthPluginOptions = {}) {

  const prefix    = opts.path ?? ''
  const startedAt = Date.now()

  // ── Auth guard ──────────────────────────────────────────────────
  async function isAuthorized(ctx: TransportContext): Promise<boolean> {
    if (!opts.token && !opts.authFn) return true

    if (opts.authFn) return opts.authFn(ctx)

    const auth = ctx.headers['authorization'] ?? ''
    const key  = ctx.headers['x-api-key']     ?? ''
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : key
    return provided === opts.token
  }

  // ── Plugin ──────────────────────────────────────────────────────

  return {
    name: 'health',

    register(app: App): void {

      // The app's own checks go onto the app, not into this closure. Assigned
      // one at a time rather than by replacing the map: two health plugins is a
      // strange shape but not an error, and a wholesale assignment would make
      // the second one silently the only one.
      for (const [name, fn] of Object.entries(opts.checks ?? {}))
        app._healthChecksApp.set(name, fn)


      // ── GET /health ──────────────────────────────────────────────
      // Returns 200 if all checks pass, 503 if any fail.
      // Suitable as a Kubernetes readinessProbe / livenessProbe target,
      // or as a load balancer health check URL.

      app.get(`${prefix}/health`, async (ctx: TransportContext) => {
        if (!await isAuthorized(ctx))
          return ctx.json({ error: 'Unauthorized' }, 401)

        const body = await collectHealth(app, startedAt)
        return ctx.json(body, body.status === 'ok' ? 200 : 503)
      })

      // ── GET /metrics ─────────────────────────────────────────────
      // Full runtime snapshot. Always 200 — the data describes health,
      // the endpoint itself is always reachable.

      app.get(`${prefix}/metrics`, async (ctx: TransportContext) => {
        if (!await isAuthorized(ctx))
          return ctx.json({ error: 'Unauthorized' }, 401)

        return ctx.json(collectMetrics(app, startedAt), 200)
      })
    }
  }
}
