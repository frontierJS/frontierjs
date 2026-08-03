// transport/health.ts
// Built-in /health and /metrics endpoints.
//
// /health  — liveness + readiness check for load balancers and orchestrators.
//            Returns 200 OK or 503 Service Unavailable.
//
// /metrics — detailed runtime snapshot for dashboards and alerting.
//            Always returns 200 (the data describes health, not the endpoint itself).
//
// Both are registered as a plugin:
//
//   app.configure(healthPlugin())
//   app.configure(healthPlugin({ path: '/_internal', token: process.env.METRICS_TOKEN }))
//
// Auth: pass a static bearer token or a custom check function.
// If no auth is configured the endpoints are public — fine for internal
// networks, should be locked down for internet-facing deployments.

import { customMethodNames }     from '../core/service.ts'
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
      actions:   string[]
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

  // ── Built-in checks ─────────────────────────────────────────────
  // Returns {name → result} for all checks (built-in + user-supplied).

  async function runChecks(
    app: App
  ): Promise<Record<string, CheckResult>> {
    const results: Record<string, CheckResult> = {}

    // Built-in: database check — only for a raw bun:sqlite handle (db.db.query).
    // Other clients don't expose that shape; probing them here reported a
    // healthy app as degraded. They skip the built-in and declare their own
    // check via opts.checks instead. The shape probe itself must sit inside
    // the try — a Litestone proxy throws on unknown property access rather
    // than returning undefined.
    const dbCheck = (() => {
      try {
        const rawDb = app.db as { db?: { query?: (s: string) => { get: () => unknown } } } | undefined
        const query = rawDb?.db?.query
        return typeof query === 'function' ? { query: query.bind(rawDb!.db) } : null
      } catch { return null }
    })()
    if (dbCheck) {
      const t = Date.now()
      try {
        // Cheapest possible round-trip — confirms the connection is live.
        dbCheck.query('SELECT 1').get()
        results.database = { status: 'ok', latencyMs: Date.now() - t }
      } catch (err) {
        results.database = {
          status: 'fail',
          latencyMs: Date.now() - t,
          error: (err as Error).message,
        }
      }
    }

    // User-supplied checks
    for (const [name, fn] of Object.entries(opts.checks ?? {})) {
      const t = Date.now()
      try {
        const ok = await fn()
        results[name] = { status: ok ? 'ok' : 'fail', latencyMs: Date.now() - t }
      } catch (err) {
        results[name] = {
          status: 'fail',
          latencyMs: Date.now() - t,
          error: (err as Error).message,
        }
      }
    }

    return results
  }

  // ── Plugin ──────────────────────────────────────────────────────

  return {
    name: 'health',

    register(app: App): void {

      // ── GET /health ──────────────────────────────────────────────
      // Returns 200 if all checks pass, 503 if any fail.
      // Suitable as a Kubernetes readinessProbe / livenessProbe target,
      // or as a load balancer health check URL.

      app.get(`${prefix}/health`, async (ctx: TransportContext) => {
        if (!await isAuthorized(ctx))
          return ctx.json({ error: 'Unauthorized' }, 401)

        const checks  = await runChecks(app)
        const anyFail = Object.values(checks).some(c => c.status === 'fail')

        const body: HealthResponse = {
          status:  anyFail ? 'degraded' : 'ok',
          app:     app.config.name,
          version: app.config.version,
          uptime:  Math.floor((Date.now() - startedAt) / 1000),
          checks,
          ts:      new Date().toISOString(),
        }

        return ctx.json(body, anyFail ? 503 : 200)
      })

      // ── GET /metrics ─────────────────────────────────────────────
      // Full runtime snapshot. Always 200 — the data describes health,
      // the endpoint itself is always reachable.

      app.get(`${prefix}/metrics`, async (ctx: TransportContext) => {
        if (!await isAuthorized(ctx))
          return ctx.json({ error: 'Unauthorized' }, 401)

        const mem      = process.memoryUsage()
        const stats    = app.http.stats
        const cache    = app.cache.stats()
        const hitRate  = cache.hits + cache.misses > 0
          ? ((cache.hits / (cache.hits + cache.misses)) * 100).toFixed(1) + '%'
          : 'n/a'

        const body: MetricsResponse = {
          app:     app.config.name,
          version: app.config.version,
          uptime:  Math.floor((Date.now() - startedAt) / 1000),
          ts:      new Date().toISOString(),

          process: {
            memoryMb:    +(mem.rss         / 1024 / 1024).toFixed(2),
            heapUsedMb:  +(mem.heapUsed    / 1024 / 1024).toFixed(2),
            heapTotalMb: +(mem.heapTotal   / 1024 / 1024).toFixed(2),
            pid:         process.pid,
            nodeVersion: process.version,
          },

          http: {
            requests:  { ...stats.request  },
            responses: { ...stats.response },
            online:    stats.performance.online,
          },

          services: {
            registered: app.services.list(),
            count:      app.services.list().length,
            // Per-service detail: custom action names and bulk-operation flag.
            // Powers the REPL `services` command's full route display.
            details: Object.fromEntries(
              app.services.list().map(name => {
                const svc = app.services.get(name)!
                return [name, {
                  // customMethodNames() is the ONE predicate for "is this an
                  // action", shared with the manifest and OpenAPI plugins.
                  // This used to read `svc.actions`, a key no service has —
                  // createService copies custom methods straight onto the
                  // service object — so /metrics reported `actions: []` for
                  // every service, always, while /manifest listed them
                  // correctly. Two answers to one question; now one.
                  actions:   customMethodNames(svc),
                  allowBulk: !!(svc as unknown as { allowBulk?: boolean }).allowBulk,
                }]
              })
            ),
          },

          cache: {
            hits:    cache.hits,
            misses:  cache.misses,
            sets:    cache.sets,
            evicts:  cache.evicts,
            size:    cache.size,
            hitRate,
          },
        }

        // Merge in stats from any registered plugin providers (e.g. Caravan)
        const providers = (app as unknown as { _metricsProviders?: Map<string, () => unknown> })._metricsProviders
        if (providers?.size) {
          for (const [key, fn] of providers) {
            try { body[key] = fn() } catch { /* provider error — skip silently */ }
          }
        }

        return ctx.json(body, 200)
      })
    }
  }
}
