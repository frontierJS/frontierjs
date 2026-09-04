// junction/devtools/index.ts
//
// A lightweight API admin console that runs on a separate port.
// Subscribes to app.telemetry for service call data, streams live
// to connected admin clients over WebSocket.
//
// Usage:
//   import { devtools } from './devtools/index.ts'
//
//   app.configure(devtools())
//
// In production, pass an auth gate:
//   app.configure(devtools({
//     auth: (req) => req.headers.get('x-admin-key') === process.env.ADMIN_KEY
//   }))
//
// Then open http://localhost:8503

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { isListResult } from '../../core/envelope.ts'
import { collectHealth, collectMetrics } from '../../transport/health.ts'

export interface DevtoolsOptions {
  /**
   * Default 8503 — the console's slot in the framework's global tooling block
   * (8500-8509, `packages/cli/core/ports.js`). A literal rather than an import
   * because junction does not depend on the CLI; the number is assigned there
   * and restated here, so moving it means moving both.
   *
   * It is a GLOBAL tooling port and not one derived from the app, because a
   * person runs this beside whatever they are working on and types the URL
   * from memory: an app-derived number would move with the app.
   */
  port?:       number
  /**
   * Default `127.0.0.1`. The console serves request logs, request PARAMS, the
   * event stream, a live WS feed and a POST that runs a job by name, and it
   * used to bind every interface whenever `NODE_ENV` was not exactly
   * `production` — which is unset, `staging` and `test` (`FJS-691`). Loopback
   * is the safe default everywhere; binding anywhere else REQUIRES `auth`,
   * regardless of `NODE_ENV`, because the environment variable was never the
   * thing that made it reachable.
   */
  hostname?:   string
  maxEntries?: number      // ring buffer size, default 200
  // Auth gate — called for every HTTP + WS request. Required whenever
  // `hostname` is not a loopback address; the server refuses to bind otherwise.
  auth?:       (req: Request) => boolean | Promise<boolean>
  // Field names whose values should be replaced with '***' in captured params.
  redact?:     string[]
}

// ─── The job queue, as this console needs it ─────────────────────────────────
//
// `AppJobs` is empty here — Caravan augments it, and Junction only peers on
// that package — so the console states the slice it calls and casts once.
// Every method is optional but `list`/`find`/`retry`/`cancel`/`dispatch`: a
// queue that cannot answer those is not one this panel can drive, and is
// reported as absent rather than rendered half-working.

export interface JobsView {
  list(opts?: { queue?: string; status?: string; limit?: number; offset?: number }): unknown[]
  find(id: string): unknown
  retry(id: string): Promise<boolean>
  cancel(id: string): Promise<boolean>
  dispatch(name: string, data: unknown): Promise<string>
  stats?(): unknown
  registrations?(): Array<{ name: string; queue: string; cron: string | null }>
  nextRuns?(): Array<{ name: string; cron: string; nextRun: Date | null }>
}

// ─── Entry types ──────────────────────────────────────────────────────────────

export interface RequestEntry {
  id:          string
  ts:          number           // epoch ms
  service:     string
  method:      string
  transport:   string           // 'http' | 'websocket' | 'internal'
  user:        string | null
  ip:          string
  durationMs:  number
  status:      'ok' | 'error'
  errorMsg?:   string
  errorCode?:  number
  query:       Record<string, unknown>
  data:        Record<string, unknown> | null
  resultSummary: string         // e.g. "list(18)" or "{ id: 42 }"
}

export interface ConnectionEntry {
  id:          string
  connectedAt: number
  user:        string | null
  ip:          string
}

export interface EventEntry {
  ts:    number
  name:  string
  brief: string   // short description of payload
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_REDACT = ['password', 'token', 'secret', 'apikey', 'apiKey', 'authorization']

function redactObj(
  obj: Record<string, unknown> | null | undefined,
  fields: string[]
): Record<string, unknown> {
  if (!obj) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = fields.includes(k.toLowerCase()) ? '***' : v
  }
  return out
}

function summarize(result: unknown): string {
  if (result === null || result === undefined) return 'null'
  if (typeof result !== 'object') return String(result)
  const r = result as Record<string, unknown>
  if (isListResult(result)) {
    return `list(${(result.data as unknown[]).length})`
  }
  if (Array.isArray(result)) return `array(${result.length})`
  const keys = Object.keys(r)
  if (keys.length === 0) return '{}'
  if ('id' in r) return `{ id: ${r.id} }`
  return `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }`
}

function brief(payload: unknown): string {
  try {
    const s = JSON.stringify(payload)
    return s.length > 80 ? s.slice(0, 77) + '…' : s
  } catch {
    return String(payload)
  }
}

export interface LogEntry {
  level:   string
  message: string
  time:    string
  ns?:     string
  data?:   Record<string, unknown>
  error?:  { message: string; stack?: string; name: string }
}

// ─── Ring buffer ──────────────────────────────────────────────────────────────

class RingBuffer<T> {
  private buf: T[] = []
  constructor(private max: number) {}
  push(item: T): void {
    this.buf.push(item)
    if (this.buf.length > this.max) this.buf.shift()
  }
  all(): T[] { return [...this.buf] }
}

// Loopback by NAME, because that is what a person writes. `::` and `0.0.0.0`
// are the wildcards and are deliberately absent: they are every interface.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

// ─── Cross-site refusal ───────────────────────────────────────────────────
//
// A `text/plain` POST is a SIMPLE request: no preflight, so a page on any
// origin could run a job by name on a console listening beside it, and the
// browser would send it happily. Measured: `POST /api/jobs/run/send-invoices`
// from `Origin: https://evil` answered `{"ok":true,"id":"d1"}` (`FJS-691`).
//
// `Sec-Fetch-Site` is the modern answer and `Origin` the fallback; a request
// carrying NEITHER is not a browser and is left alone, which is what keeps
// `curl` and the drives working. Same rule on the WS upgrade, which has no
// preflight at all.
function crossSite(req: Request, selfOrigins: string[]): boolean {
  const fetchSite = req.headers.get('sec-fetch-site')
  if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none'
  const origin = req.headers.get('origin')
  if (!origin) return false
  return !selfOrigins.includes(origin)
}

// ─── Plugin ───────────────────────────────────────────────────────────────────

export function devtools(opts: DevtoolsOptions = {}) {
  const port       = opts.port       ?? 8503
  const hostname   = opts.hostname   ?? '127.0.0.1'
  const maxEntries = opts.maxEntries ?? 200
  const redactKeys = [...DEFAULT_REDACT, ...(opts.redact ?? [])].map(k => k.toLowerCase())
  const isProd     = process.env.NODE_ENV === 'production'
  const isLoopback = LOOPBACK.has(hostname)

  const requests:    RingBuffer<RequestEntry>    = new RingBuffer(maxEntries)
  const events:      RingBuffer<EventEntry>      = new RingBuffer(200)
  const logs:        RingBuffer<LogEntry & { ts: number }> = new RingBuffer(500)
  const connections: Map<string, ConnectionEntry> = new Map()

  // Connected admin clients — each is a Bun ServerWebSocket
  const adminSockets: Set<import('bun').ServerWebSocket<unknown>> = new Set()

  function broadcast(msg: unknown): void {
    const text = JSON.stringify(msg)
    for (const ws of adminSockets) {
      try { ws.send(text) } catch {}
    }
  }

  // ── Log writer ────────────────────────────────────────────────────────
  // Compose into your app logger via multiWriter:
  //   const logger = createLogger({ writers: [consoleWriter(), dt.writer] })
  const writer = (entry: import('../../core/logger.ts').LogEntry): void => {
    const stamped = { ...entry, ts: Date.now() }
    logs.push(stamped)
    broadcast({ type: 'log', data: stamped })
  }

  let adminServer: ReturnType<typeof Bun.serve> | null = null
  let appRef: import('../../core/app.ts').App | null = null
  // Unsubscribe fns for every bus/telemetry/channel subscription made in
  // register() — drained by shutdown() so nothing outlives the plugin.
  const _unsubs: Array<() => void> = []
  const startedAt = Date.now()

  return {
    name: 'devtools',

    register(app: import('../../core/app.ts').App): void {
      appRef = app

      // ── Instrument all service calls via app.telemetry ──────────────
      // No longer uses an around hook — subscribes to the telemetry bus instead.
      // This means devtools captures calls regardless of hook pipeline state,
      // and does not add latency to the call path.
      // Every subscription's unsubscribe fn is collected in _unsubs so
      // shutdown() can fully detach — previously all of these (and a
      // bus.emit monkey-patch) survived shutdown.
      _unsubs.push(app.telemetry.on('junction.call', (event: unknown) => {
        const e = event as import('../../core/service.ts').TelemetryEvent
        const entry: RequestEntry = {
          id:            crypto.randomUUID(),
          ts:            Date.now() - e.durationMs,
          service:       e.service,
          method:        e.method,
          transport:     e.transport,
          user:          e.userId,
          ip:            '',   // not in TelemetryEvent — transport-level detail
          durationMs:    e.durationMs,
          status:        e.status,
          errorMsg:      e.error?.message,
          errorCode:     e.error?.code,
          query:         {},   // not in TelemetryEvent — subscribe ctx hooks if needed
          data:          null,
          resultSummary: '',
        }
        requests.push(entry)
        broadcast({ type: 'request', data: entry })
      }))

      // ── Forward fine-grained telemetry for Sierra toolbar waterfall ─
      // junction.call (end) is already forwarded above as 'request'.
      // These additional events let the Sierra toolbar render per-hook
      // timing bars and Litestone query rows grouped by telemetryId.
      _unsubs.push(app.telemetry.on('junction.call.start', (event: unknown) => {
        broadcast({ type: 'call_start', data: event })
      }))

      _unsubs.push(app.telemetry.on('junction.hook', (event: unknown) => {
        broadcast({ type: 'hook', data: event })
      }))

      _unsubs.push(app.telemetry.on('litestone.query', (event: unknown) => {
        broadcast({ type: 'query', data: event })
      }))

      // ── Track app events ───────────────────────────────────────────
      // Observe via onAny() — the bus API built for exactly this — instead
      // of monkey-patching bus.emit (which was never reverted and wrapped
      // every emit for the life of the process).
      const bus = (app as unknown as Record<string, unknown>).events as
        import('../../events/index.ts').IEventBus | undefined

      if (bus?.onAny) {
        _unsubs.push(bus.onAny((name: string, data: unknown) => {
          const entry: EventEntry = {
            ts:    Date.now(),
            name,
            brief: brief(data),
          }
          events.push(entry)
          broadcast({ type: 'event', data: entry })
        }))
      }

      // ── Track WS connections via channels plugin ───────────────────
      const channelManager = (app as unknown as Record<string, unknown>).channels as
        { on?: (event: string, handler: (...a: unknown[]) => void) => (() => void) | void } | undefined

      if (channelManager?.on) {
        const u1 = channelManager.on('connection', (session: unknown, conn: unknown) => {
          const c = conn as Record<string, unknown>
          const s = session as Record<string, unknown> | null
          const entry: ConnectionEntry = {
            id:          String(c?.id ?? '?'),
            connectedAt: Date.now(),
            user:        s ? String(s.email ?? s.userId ?? '?') : null,
            ip:          String((c?.data as Record<string, unknown>)?.ip ?? ''),
          }
          connections.set(entry.id, entry)
          broadcast({ type: 'connection', data: entry })
          const connEvt: EventEntry = { ts: Date.now(), name: 'ws:connect', brief: entry.user ?? 'anonymous' }
          events.push(connEvt); broadcast({ type: 'event', data: connEvt })
        })
        if (typeof u1 === 'function') _unsubs.push(u1)

        // NOTE: disconnect handlers are invoked with (conn) as the FIRST
        // argument (see ChannelManager.handleDisconnect) — the old callback
        // read the second parameter and always saw undefined.
        const u2 = channelManager.on('disconnect', (conn: unknown) => {
          const c = conn as Record<string, unknown>
          const id = String(c?.id ?? '')
          const existing = connections.get(id)
          connections.delete(id)
          broadcast({ type: 'disconnect', data: { id } })
          const discEvt: EventEntry = { ts: Date.now(), name: 'ws:disconnect', brief: existing?.user ?? 'anonymous' }
          events.push(discEvt); broadcast({ type: 'event', data: discEvt })
        })
        if (typeof u2 === 'function') _unsubs.push(u2)
      }

      appRef = app
    },

    // The server binds in ready(), not register(). `ready-hooks` is a
    // `needsHost` start phase, so a boot without a port — `_startForTest()`,
    // and every snapshot generator through it — skips this entirely. It used to
    // bind in register(), which meant `junction surface` opened a real listener
    // on 8503 as a side effect of describing an app, and would have thrown
    // outright had anything else held the port (`FJS-419`).
    ready(app: import('../../core/app.ts').App): void {
      // ── Start admin server ─────────────────────────────────────────
      // Fail CLOSED: in production the admin surface (request logs, params,
      // event stream, live WS feed) must never be served without an auth
      // gate. If no `auth` option was configured, refuse to bind at all
      // rather than silently serving unauthenticated.
      // Two refusals and they are not the same one. Production with no gate is
      // the old rule and stands. Binding OFF LOOPBACK with no gate is the one
      // that was missing: `NODE_ENV` is not what makes this reachable, an
      // interface is, and an unset variable is the common case rather than the
      // odd one (`FJS-691`).
      if (isProd && !opts.auth) {
        app._devtools = { status: 'refused', reason: 'production, no auth gate' }
        console.warn(
          '[Junction devtools] NODE_ENV=production and no `auth` option configured — ' +
          'devtools admin server NOT started. Pass devtools({ auth: async (req) => boolean }) to enable it in production.'
        )
        return
      }
      if (!isLoopback && !opts.auth) {
        const why = `hostname '${hostname}' is not loopback and no auth gate is configured`
        app._devtools = { status: 'refused', reason: why }
        console.warn(
          `[Junction devtools] ${why} — devtools admin server NOT started. The console serves ` +
          'request params, a live event feed and a POST that runs a job by name; on a reachable ' +
          'interface that needs a gate. Pass devtools({ auth: async (req) => boolean }), or drop ' +
          '`hostname` to bind 127.0.0.1.'
        )
        return
      }

      const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'admin.html')

      // A held port is the failure this must not be quiet about. `ready()` errors
      // are caught and logged by the start phase, so an EADDRINUSE here left the
      // app running with the console reporting `disabled` — which is a lie: it
      // was asked for and it failed. Worse, the port is held by a PREVIOUS run
      // of the same console, so anything pointed at 8503 gets stale data from a
      // process nobody meant to be talking to (`FJS-420`). Measured: a drive
      // asserted against the last run's queue and reported half its checks red.
      try {
      const selfOrigins = [`http://${hostname}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`]

      adminServer = Bun.serve({
        port,
        // Stated rather than defaulted. Bun binds `0.0.0.0` when this is
        // omitted, so the console was on every interface of every machine that
        // ran it (`FJS-691`).
        hostname,

        async fetch(req, server) {
          // Auth gate — when an auth fn is configured it applies in EVERY
          // environment it's provided for; in production the server refuses
          // to start without one (checked at boot), so there is no
          // unauthenticated production path.
          if (opts.auth) {
            const allowed = await opts.auth(req)
            if (!allowed) return new Response('Unauthorized', { status: 401 })
          }

          const url = new URL(req.url)

          // WebSocket upgrade. `data` is stated because bun-types infers the
          // socket's data type from the `websocket` block and then requires the
          // options argument; nothing here reads `ws.data`.
          //
          // The boolean matters: a refused upgrade used to fall through to
          // `undefined as unknown as Response`, which is a lie to both the type
          // system and Bun. Answering 400 is what a client can act on.
          if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            // A WS upgrade has no preflight, so the only thing standing between
            // a page on another origin and the live request feed is this.
            if (crossSite(req, selfOrigins)) return new Response('Forbidden', { status: 403 })
            if (server.upgrade(req, { data: undefined })) return undefined as unknown as Response
            return new Response('WebSocket upgrade failed', { status: 400 })
          }

          // Everything that ACTS is a POST, and a `text/plain` POST needs no
          // preflight — so a cross-site one reaches here with the browser's
          // blessing unless it is refused by name.
          if (req.method !== 'GET' && req.method !== 'HEAD' && crossSite(req, selfOrigins))
            return new Response('Forbidden', { status: 403 })

          // REST state snapshot
          if (url.pathname === '/api/state') {
            return Response.json({
              app:         { name: app.config?.name ?? 'junction', version: app.config?.version ?? '' },
              services:    app.services.list(),
              connections: [...connections.values()],
              requests:    requests.all(),
              events:      events.all(),
              logs:        logs.all(),
              // The same object /metrics answers, plugin sections included.
              // Building a second one here is what kept Caravan's queue stats
              // out of this console for its whole life (`FJS-414`).
              metrics:     collectMetrics(app, startedAt),
            })
          }

          // Readiness — the built-in probe, plugin-registered checks, and
          // whatever the app declared through healthPlugin({ checks }). The
          // last of those is the plugin's own option and unreachable from
          // here, so what this shows is every check with a registered owner.
          if (url.pathname === '/api/health')
            return Response.json(await collectHealth(app, startedAt))

          // ── Jobs ────────────────────────────────────────────────────
          // Read straight off `app.jobs` rather than through Caravan's own
          // admin routes: those are opt-in (`admin: true`), live on the app's
          // port behind its apiPrefix, and are cross-origin from here. The
          // queue object is already in reach, so the console works whether or
          // not an app chose to publish that surface.
          //
          // Duck-typed for the same reason Caravan duck-types the app: this
          // file must not import a package Junction only peers on.
          if (url.pathname.startsWith('/api/jobs')) {
            const q = app.jobs as unknown as JobsView | undefined
            if (!q || typeof q.list !== 'function')
              return Response.json({ error: 'No job queue installed' }, { status: 501 })

            const rest = url.pathname.slice('/api/jobs'.length)
            const p    = url.searchParams

            if (req.method === 'GET' && (rest === '' || rest === '/')) {
              return Response.json({
                stats:         q.stats?.()         ?? { queues: {}, total: null },
                registrations: q.registrations?.() ?? [],
                nextRuns:      q.nextRuns?.()      ?? [],
                jobs: q.list({
                  queue:  p.get('queue')  || undefined,
                  status: p.get('status') || undefined,
                  limit:  p.get('limit')  ? parseInt(p.get('limit')!)  : 50,
                  offset: p.get('offset') ? parseInt(p.get('offset')!) : 0,
                }),
              })
            }

            // Everything below acts on the queue, so it is POST-only — a
            // retry reachable by GET is a retry a link preview can fire.
            if (req.method === 'POST') {
              const m = /^\/([^/]+)\/(retry|cancel)$/.exec(rest)
              if (m) return Response.json({ ok: await q[m[2] as 'retry' | 'cancel'](m[1]) })

              const run = /^\/run\/([^/]+)$/.exec(rest)
              if (run) {
                // The body, if any, is the job's data — same shape dispatch()
                // takes, so a scheduled handler that reads a parameter can be
                // given a different one by hand.
                const known = (q.registrations?.() ?? []).some(r => r.name === run[1])
                if (!known)
                  return Response.json({ error: `No handler registered for '${run[1]}'` }, { status: 404 })
                const data = await req.json().catch(() => ({}))
                return Response.json({ ok: true, id: await q.dispatch(run[1], data) })
              }
            }

            const one = /^\/([^/]+)$/.exec(rest)
            if (req.method === 'GET' && one) {
              const job = q.find(one[1])
              return job
                ? Response.json(job)
                : Response.json({ error: `Job '${one[1]}' not found` }, { status: 404 })
            }

            return new Response('Not found', { status: 404 })
          }

          // Serve admin.html
          try {
            const file = Bun.file(htmlPath)
            return new Response(file, {
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                // No validators and no directive means heuristic caching, and
                // this page is the one place that is actively misleading: it is
                // served BY the socket's own server, so a cached copy loads
                // perfectly while the server is down and the only symptom is
                // the badge reading `disconnected` — which reads as a broken
                // console rather than an app that is not running (`FJS-421`).
                'Cache-Control': 'no-store',
              },
            })
          } catch {
            return new Response('Admin UI not found', { status: 404 })
          }
        },

        websocket: {
          open(ws) {
            adminSockets.add(ws)
            // Send full state snapshot on connect
            const services = app.services.list()
            ws.send(JSON.stringify({
              type: 'state',
              data: {
                app:         { name: app.config?.name ?? 'junction', version: app.config?.version ?? '' },
                services,
                connections: [...connections.values()],
                requests:    requests.all(),
                events:      events.all(),
                logs:        logs.all(),
              }
            }))
          },
          close(ws) {
            adminSockets.delete(ws)
          },
          message() {},
        },
      })

      // The banner is the one place an app says what it is serving, and this
      // server is not on the router it is derived from. Reported there rather
      // than only here, where a line printed mid-boot scrolls away above it —
      // and where an app with the console switched OFF said nothing at all.
      app._devtools = { status: 'on', url: `http://${isLoopback ? 'localhost' : hostname}:${adminServer.port}` }
      } catch (err) {
        const e = err as { code?: string }
        const why = e?.code === 'EADDRINUSE'
          ? `port ${port} already in use — another console is running there`
          : `could not bind port ${port}: ${(err as Error).message}`
        app._devtools = { status: 'refused', reason: why }
        console.warn(`[Junction devtools] ${why}`)
      }
    },

    shutdown() {
      // Detach every observer registered in register() — telemetry
      // subscriptions, the events onAny tap, and channel listeners.
      for (const unsub of _unsubs.splice(0)) {
        try { unsub() } catch {}
      }

      // Close any connected admin clients before stopping the server.
      for (const ws of adminSockets) {
        try { ws.close(1001, 'devtools shutting down') } catch {}
      }
      adminSockets.clear()

      adminServer?.stop()
      adminServer = null
      appRef = null
    },

    writer,
  }
}
