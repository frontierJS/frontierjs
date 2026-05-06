// junction/devtools/index.ts
//
// A lightweight API admin console that runs on a separate port.
// Subscribes to app.telemetry for service call data, streams live
// to connected admin clients over WebSocket.
//
// Usage:
//   import { devtools } from './devtools/index.ts'
//
//   app.configure(devtools({ port: 4000 }))
//
// In production, pass an auth gate:
//   app.configure(devtools({
//     port: 4000,
//     auth: (req) => req.headers.get('x-admin-key') === process.env.ADMIN_KEY
//   }))
//
// Then open http://localhost:4000

import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export interface DevtoolsOptions {
  port?:       number      // default 4000
  maxEntries?: number      // ring buffer size, default 200
  // Auth gate — called for every HTTP + WS request.
  // In dev (NODE_ENV !== 'production') this is skipped automatically.
  auth?:       (req: Request) => boolean | Promise<boolean>
  // Field names whose values should be replaced with '***' in captured params.
  redact?:     string[]
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

function summarise(result: unknown): string {
  if (result === null || result === undefined) return 'null'
  if (typeof result !== 'object') return String(result)
  const r = result as Record<string, unknown>
  if (r.object === 'list' && Array.isArray(r.data)) {
    return `list(${(r.data as unknown[]).length})`
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

// ─── Plugin ───────────────────────────────────────────────────────────────────

export function devtools(opts: DevtoolsOptions = {}) {
  const port       = opts.port       ?? 4000
  const maxEntries = opts.maxEntries ?? 200
  const redactKeys = [...DEFAULT_REDACT, ...(opts.redact ?? [])].map(k => k.toLowerCase())
  const isProd     = process.env.NODE_ENV === 'production'

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
  const startedAt = Date.now()

  return {
    name: 'devtools',

    register(app: import('../../core/app.ts').App): void {
      appRef = app

      // ── Instrument all service calls via app.telemetry ──────────────
      // No longer uses an around hook — subscribes to the telemetry bus instead.
      // This means devtools captures calls regardless of hook pipeline state,
      // and does not add latency to the call path.
      app.telemetry.on('junction.call', (event: unknown) => {
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
      })

      // ── Forward fine-grained telemetry for Sierra toolbar waterfall ─
      // junction.call (end) is already forwarded above as 'request'.
      // These additional events let the Sierra toolbar render per-hook
      // timing bars and Litestone query rows grouped by telemetryId.
      app.telemetry.on('junction.call.start', (event: unknown) => {
        broadcast({ type: 'call_start', data: event })
      })

      app.telemetry.on('junction.hook', (event: unknown) => {
        broadcast({ type: 'hook', data: event })
      })

      app.telemetry.on('litestone.query', (event: unknown) => {
        broadcast({ type: 'query', data: event })
      })

      // ── Track app events ───────────────────────────────────────────
      // Use wildcard if the event bus supports it, otherwise known events
      const bus = (app as unknown as Record<string, unknown>).events as
        import('../../events/index.ts').IEventBus | undefined

      if (bus?.on) {
        const origEmit = bus.emit.bind(bus)
        bus.emit = (name: string, ...args: unknown[]) => {
          const entry: EventEntry = {
            ts:    Date.now(),
            name,
            brief: brief(args[0]),
          }
          events.push(entry)
          broadcast({ type: 'event', data: entry })
          return origEmit(name, ...args)
        }
      }

      // ── Track WS connections via channels plugin ───────────────────
      const channelManager = (app as unknown as Record<string, unknown>).channels as
        { on?: (event: string, handler: (...a: unknown[]) => void) => void } | undefined

      if (channelManager?.on) {
        channelManager.on('connection', (session: unknown, conn: unknown) => {
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

        channelManager.on('disconnect', (_session: unknown, conn: unknown) => {
          const c = conn as Record<string, unknown>
          const id = String(c?.id ?? '')
          const existing = connections.get(id)
          connections.delete(id)
          broadcast({ type: 'disconnect', data: { id } })
          const discEvt: EventEntry = { ts: Date.now(), name: 'ws:disconnect', brief: existing?.user ?? 'anonymous' }
          events.push(discEvt); broadcast({ type: 'event', data: discEvt })
        })
      }

      // ── Start admin server ─────────────────────────────────────────
      const htmlPath = join(dirname(fileURLToPath(import.meta.url)), 'admin.html')

      adminServer = Bun.serve({
        port,

        async fetch(req, server) {
          // Auth gate
          if (isProd && opts.auth) {
            const allowed = await opts.auth(req)
            if (!allowed) return new Response('Unauthorized', { status: 401 })
          }

          const url = new URL(req.url)

          // WebSocket upgrade
          if (req.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            server.upgrade(req)
            return undefined as unknown as Response
          }

          // REST state snapshot
          if (url.pathname === '/api/state') {
            const services = app.services.list()
            const mem      = process.memoryUsage()
            const stats    = (app as Record<string, unknown>).http as
              { stats?: { request: Record<string, number>; response: Record<string, number>; performance: { online: boolean } } } | undefined
            const httpStats = stats?.stats
            const cache    = (app as Record<string, unknown>).cache as
              { stats?: () => Record<string, unknown> } | undefined
            const cStats   = cache?.stats?.() ?? {}
            const hits     = (cStats.hits as number) ?? 0
            const misses   = (cStats.misses as number) ?? 0
            const hitRate  = hits + misses > 0
              ? ((hits / (hits + misses)) * 100).toFixed(1) + '%'
              : 'n/a'

            return Response.json({
              app:         { name: app.config?.name ?? 'junction', version: app.config?.version ?? '' },
              services,
              connections: [...connections.values()],
              requests:    requests.all(),
              events:      events.all(),
              logs:        logs.all(),
              metrics: {
                app:     app.config?.name ?? 'junction',
                version: app.config?.version ?? '',
                uptime:  Math.floor((Date.now() - startedAt) / 1000),
                ts:      new Date().toISOString(),
                process: {
                  memoryMb:    +(mem.rss / 1024 / 1024).toFixed(2),
                  heapUsedMb:  +(mem.heapUsed / 1024 / 1024).toFixed(2),
                  heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
                  pid:         process.pid,
                  nodeVersion: process.version,
                },
                http: {
                  requests:  httpStats?.request  ?? {},
                  responses: httpStats?.response ?? {},
                  online:    httpStats?.performance.online ?? false,
                },
                services: { registered: services, count: services.length },
                cache: {
                  hits, misses, hitRate,
                  sets:   (cStats.sets   as number) ?? 0,
                  evicts: (cStats.evicts as number) ?? 0,
                  size:   (cStats.size   as number) ?? 0,
                },
              },
            })
          }

          // Serve admin.html
          try {
            const file = Bun.file(htmlPath)
            return new Response(file, {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
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

      console.log(`  ◈  Devtools:  http://localhost:${port}`)
    },

    shutdown() {
      adminServer?.stop()
    },

    writer,
  }
}
