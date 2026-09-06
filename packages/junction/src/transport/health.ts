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

  /** ms a single readiness check may take before it is a failure naming
   *  itself. Default 2000. A check calls something this process does not own,
   *  so the only alternative to a bound is a probe that never answers — which
   *  an orchestrator reads as the process being dead. */
  checkTimeout?: number
}

/**
 * The two questions an orchestrator asks, which are not one question.
 *
 * `live`  — should this process be RESTARTED? Nothing it depends on is
 *           consulted, because restarting cannot fix somebody else's database
 *           and doing it to every replica at once turns a blip into an outage.
 *           A DRAINING process is still alive: killing it mid-drain is exactly
 *           what the drain exists to avoid.
 * `ready` — should traffic be SENT here? Every check, and draining is a no.
 */
export type HealthMode = 'live' | 'ready'

// ─── Response shapes ──────────────────────────────────────────────────────

export interface HealthResponse {
  // `draining` is not a degree of unwell — it is *this process is leaving*,
  // which is a different instruction to whatever is choosing between replicas.
  status:   'ok' | 'degraded' | 'down' | 'draining'
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

export const DEFAULT_CHECK_TIMEOUT = 2000

/**
 * A check's result, timed, named and BOUNDED — a throw is a failure carrying
 * its message, and so is taking too long.
 *
 * Nothing here cancels the check: a promise cannot be cancelled, so a hung
 * probe goes on hanging and this stops WAITING for it. That is the same answer
 * `http.requestTimeout` gives, for the same reason — announcing a deadline is
 * possible, enforcing one is not.
 */
function timedCheck(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<CheckResult> {
  const t = Date.now()
  return new Promise<CheckResult>(resolve => {
    let settled = false
    const finish = (r: CheckResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }

    const timer = setTimeout(
      () => finish({ status: 'fail', latencyMs: Date.now() - t, error: `timed out after ${timeoutMs}ms` }),
      timeoutMs,
    )
    if (timer.unref) timer.unref()

    // `Promise.resolve().then(fn)` rather than calling fn() here: a check that
    // throws SYNCHRONOUSLY would otherwise escape this promise entirely and
    // reject the whole collection instead of being one failed row.
    Promise.resolve().then(fn).then(
      ok  => finish({ status: ok ? 'ok' : 'fail', latencyMs: Date.now() - t }),
      err => finish({ status: 'fail', latencyMs: Date.now() - t, error: (err as Error).message }),
    )
  })
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
export async function collectHealth(
  app: App,
  startedAt: number,
  opts: { mode?: HealthMode; checkTimeout?: number } = {},
): Promise<HealthResponse> {

  const mode      = opts.mode ?? 'ready'
  const timeoutMs = opts.checkTimeout ?? DEFAULT_CHECK_TIMEOUT

  // Read per REQUEST rather than off `app.config` directly. The app's own name
  // is the shape a tenant varies — one deployment, many customers, each of whom
  // thinks it is theirs — and `configFor` is where that becomes true for every
  // reader at once instead of for whichever one was found again (`FJS-D126`).
  //
  // Not `$.config`: a health route is a raw route and holds no service call.
  const cfg  = app.configFor?.() ?? app.config
  // Field order follows `HealthResponse`'s own declaration, `checks` before
  // `ts`, so the type and the wire read the same way round.
  const meta = {
    app:     cfg?.name    ?? 'junction',
    version: cfg?.version ?? '',
    uptime:  Math.floor((Date.now() - startedAt) / 1000),
  }
  const ts = () => new Date().toISOString()

  // Liveness consults NOTHING. Answering here is the whole check: a process
  // that runs this line is one a restart cannot improve. Draining is still
  // alive on purpose — an orchestrator that kills a draining process is
  // destroying the in-flight requests the drain exists to finish.
  if (mode === 'live') return { status: 'ok', ...meta, checks: {}, ts: ts() }

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

  // Collected into a Map before any of them runs, because the ORDER and the
  // last-wins rule are properties of the list rather than of the running: a
  // Map keeps a re-set key in its original position, so an app-declared name
  // still replaces the plugin's without moving in the answer.
  const entries = new Map<string, () => boolean | Promise<boolean>>()
  if (dbCheck) entries.set('database', () => { dbCheck.query('SELECT 1').get(); return true })
  for (const [name, fn] of app._healthChecks    ?? new Map()) entries.set(name, fn)
  for (const [name, fn] of app._healthChecksApp ?? new Map()) entries.set(name, fn)

  // Concurrently. Sequentially, a probe's latency was the SUM of every check,
  // so an app grows its own timeout by adding a dependency — and one check
  // that never settled meant the endpoint never answered at all, which reads
  // to an orchestrator as a dead process rather than an unwell one.
  const settled = await Promise.all(
    [...entries].map(async ([name, fn]) => [name, await timedCheck(fn, timeoutMs)] as const),
  )
  const results: Record<string, CheckResult> = Object.fromEntries(settled)

  const anyFail = Object.values(results).some(c => c.status === 'fail')

  // A process that is leaving is not ready, whatever its checks say. Without
  // this a request arriving during the drain was answered 200 and `/health`
  // stayed 200 throughout, so a load balancer went on choosing a process that
  // had already stopped accepting connections (`FJS-693`). Ahead of `anyFail`
  // because it is the more specific answer: *going away* rather than *unwell*.
  return {
    status: app.draining ? 'draining' : anyFail ? 'degraded' : 'ok',
    ...meta,
    checks: results,
    ts:     ts(),
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

// ─── Prometheus exposition ────────────────────────────────────────────────
// `/metrics` is a CONVENTION before it is a path, and the convention carries a
// format: a scraper sends `Accept: application/openmetrics-text…` and is handed
// JSON, which it cannot read (measured). So the same resource answers in two
// representations chosen by `Accept` — one collector, two renderings, rather
// than a second endpoint with a second idea of what the numbers are.
//
// The mapping is one rule and it is deliberately narrow: **a number is a
// metric and nothing else is**. A string (`nodeVersion`, `ts`) and an array
// (the service list) are skipped rather than counted or stringified, because
// the alternative is inventing a value the collector never stated. That rule
// also bounds what a plugin's `registerMetricsSource` section can produce: a
// per-service object of names and booleans emits nothing at all, so a section
// cannot turn into a series per service by accident.
//
// No `# TYPE` is emitted. Whether a number is a counter or a gauge is not
// derivable from its name, and a wrong TYPE is worse than an absent one —
// Prometheus reads an untyped metric correctly and a mislabelled counter it
// does not.

const METRIC_PREFIX = 'junction_'

/** A path through the metrics object becomes one metric name. */
function metricName(path: string[]): string {
  return METRIC_PREFIX + path
    .join('_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
}

export function renderPrometheus(m: MetricsResponse): string {
  const lines: string[] = []

  const walk = (value: unknown, path: string[]): void => {
    if (typeof value === 'number') {
      // A non-finite number has no exposition form that means what it says.
      if (Number.isFinite(value)) lines.push(`${metricName(path)} ${value}`)
      return
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, [...path, k])
  }

  walk(m, [])
  return lines.join('\n') + '\n'
}

/**
 * Does this caller want the exposition format?
 *
 * Matching `text/plain` is what separates a scraper from a browser: a browser
 * leads with `text/html` and never names text/plain, and curl sends the
 * wildcard alone — so both keep the JSON that every existing reader of this
 * endpoint (the devtools console, `fli gui`) is written against.
 *
 * The wildcard cannot be spelled in this comment: it ends with the two
 * characters that close a block comment, so writing it here is a parse error
 * pointing at a line further down.
 */
export function wantsPrometheus(accept: string | undefined): boolean {
  return /openmetrics-text|text\/plain/i.test(accept ?? '')
}

// ─── Plugin factory ───────────────────────────────────────────────────────

export function healthPlugin(opts: HealthPluginOptions = {}) {

  const prefix       = opts.path ?? ''
  const startedAt    = Date.now()
  const checkTimeout = opts.checkTimeout ?? DEFAULT_CHECK_TIMEOUT

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


      // ── GET /health · /health/ready · /health/live ────────────────
      //
      // Two questions, and an orchestrator acts on them differently: a failed
      // LIVENESS probe restarts the process, a failed READINESS probe stops
      // sending it traffic. One endpoint could only ever answer one of them,
      // so a third-party dependency going down restarted every replica — which
      // cannot fix the third party and takes the app down with it.
      //
      // `/health` keeps answering readiness. It is what every deployment
      // already points at, and readiness is the answer that was right for a
      // load balancer all along; the split adds the two named paths rather
      // than moving the one that exists.

      const answer = async (ctx: TransportContext, mode: HealthMode) => {
        if (!await isAuthorized(ctx))
          return ctx.json({ error: 'Unauthorized' }, 401)

        const body = await collectHealth(app, startedAt, { mode, checkTimeout })
        if (body.status === 'ok') return ctx.json(body, 200)
        if (body.status !== 'draining') return ctx.json(body, 503)

        // `Connection: close` on the way out, so a client holding a keep-alive
        // socket opens a new one somewhere else rather than sending another
        // request into a process that is closing. Built here rather than
        // through `ctx.json`, which takes a status and no headers — widening
        // that signature for one header on one route is the wrong end to
        // change. Only while draining: a degraded app is still serving and its
        // sockets are still good.
        return new Response(JSON.stringify(body), {
          status:  503,
          headers: { 'content-type': 'application/json', connection: 'close' },
        })
      }

      app.get(`${prefix}/health`,       ctx => answer(ctx as TransportContext, 'ready'))
      app.get(`${prefix}/health/ready`, ctx => answer(ctx as TransportContext, 'ready'))
      app.get(`${prefix}/health/live`,  ctx => answer(ctx as TransportContext, 'live'))

      // ── GET /metrics ─────────────────────────────────────────────
      // Full runtime snapshot. Always 200 — the data describes health,
      // the endpoint itself is always reachable.

      app.get(`${prefix}/metrics`, async (ctx: TransportContext) => {
        if (!await isAuthorized(ctx))
          return ctx.json({ error: 'Unauthorized' }, 401)

        const body = collectMetrics(app, startedAt)
        if (!wantsPrometheus(ctx.headers['accept'])) return ctx.json(body, 200)

        return new Response(renderPrometheus(body), {
          status:  200,
          headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
        })
      })
    }
  }
}
