// example/app.ts
// ─────────────────────────────────────────────────────────────────────────
// Junction Demo API
//
// Demonstrates every major framework feature in one runnable app:
//   • Services with full CRUD, custom actions, and hook pipeline
//   • Schema validation, timestamps, protect hooks
//   • Authentication (token-based demo auth)
//   • Role-based access control via requireRole()
//   • Circuit breaker on a service that calls an external API
//   • Real-time WebSocket channels + bidirectional service calls
//   • app.ws() with {param} path routing
//   • Server-Sent Events (ctx.sse)
//   • ctx.paginate() response helper
//   • Correlation IDs on every request
//   • Health + metrics endpoints (healthPlugin)
//   • Webhook delivery (webhooks plugin)
//   • OpenAPI + Swagger UI
//   • Scheduler jobs
//   • Event bus auto-events
//
// ─── Quick start ──────────────────────────────────────────────────────────
//
//   bun run dev                       # starts with --watch
//   bun run repl                      # interactive REPL
//   open http://localhost:3000/api/docs  # Swagger UI
//
// ─── Seed users ───────────────────────────────────────────────────────────
//
//   # Admin (pre-seeded, token = 'demo-admin-token')
//   # Regular user (create via POST /api/users)
//
// ─── Example curl commands ────────────────────────────────────────────────
//
//   # Health check
//   curl http://localhost:3000/health
//
//   # Metrics
//   curl http://localhost:3000/metrics
//
//   # Create a user
//   curl -s -X POST http://localhost:3000/api/users \
//     -H "Content-Type: application/json" \
//     -d '{"name":"Alice","email":"alice@example.com"}'
//   # → { id, name, email, token }  ← save the token
//
//   # Create a note (requires auth)
//   curl -s -X POST http://localhost:3000/api/notes \
//     -H "Content-Type: application/json" \
//     -H "Authorization: Bearer <token>" \
//     -d '{"title":"Hello Junction","body":"Framework with batteries included.","tags":["demo"]}'
//
//   # List notes with pagination
//   curl "http://localhost:3000/api/notes?$limit=5&$skip=0"
//
//   # Note summary action (custom action — dispatched via X-Service-Method header)
//   curl -X POST http://localhost:3000/api/notes/<id> \
//     -H 'x-service-method: summary'
//
//   # Server-Sent Events stream
//   curl http://localhost:3000/events
//
//   # Live stock price stream (SSE demo)
//   curl http://localhost:3000/prices/AAPL
//
//   # WebSocket (requires wscat: npm i -g wscat)
//   wscat -c "ws://localhost:3000/ws"
//   wscat -c "ws://localhost:3000/chat/general"
//
//   # Register a webhook
//   curl -s -X POST http://localhost:3000/api/webhooks \
//     -H "Content-Type: application/json" \
//     -d '{"url":"https://webhook.site/<your-id>","events":["notes:created"]}'
//
//   # OpenAPI spec
//   curl http://localhost:3000/api/openapi.json

import {
  createApp, loadConfig, createLogger,
  channels, openapi, healthPlugin, webhooks,
  authenticate, requireRole, protect, timestamps, circuitBreaker,
  publish,
  correlationId, rateLimit, requestLogger,
  createSchema, v,
  createService,
} from '../index.ts'

import { createUsersService, verifyDemoToken } from './services/users.service.ts'
import { createNotesService }                  from './services/notes.service.ts'

import type { App }            from '../src/core/app.ts'
import type { IAuth }          from '../src/auth/types.ts'
import type { WsContext }      from '../src/transport/types.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

// ─── Logger ───────────────────────────────────────────────────────────────

const log = createLogger({ ns: 'demo' })

// ─── Config ───────────────────────────────────────────────────────────────

const config = await loadConfig(new URL('./config', import.meta.url).pathname)

// ─── Auth ─────────────────────────────────────────────────────────────────
// Token-based demo auth: token is returned on user creation.
// Pre-seeded admin: token = 'demo-admin-token'
// In production: swap for createBetterAuthAdapter()

const auth: IAuth = {
  async verifySession(token) { return verifyDemoToken(token) },
  async login(email) {
    const sess = verifyDemoToken(email)
    if (!sess) throw Object.assign(new Error('User not found'), { code: 401 })
    return { token: email, user: sess }
  },
  async logout()         { return },
  async createUser()     { return { userId: '', userType: 'user', authMethod: 'session' as const, role: 'user', scopes: [] } },
  async deleteUser()     { return },
  async createApiKey(id) { return { key: `key-${id}`, id: `key-${id}` } },
  async revokeApiKey()   { return },
  async verifyApiKey(k)  { return verifyDemoToken(k) },
}

// ─── Create app ───────────────────────────────────────────────────────────

// autoload: false — this demo registers its services manually below;
// without it, default auto-discovery would find ./services and (harmlessly
// but noisily) skip them as duplicates.
const app = createApp({ config, auth, autoload: false })

// ─── Database (in-memory for demo — swap url in config for persistence) ───

if (app.db) {
  app.db.db.run(`
    CREATE TABLE IF NOT EXISTS notes (
      id         TEXT    PRIMARY KEY,
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL DEFAULT '',
      tags       TEXT    NOT NULL DEFAULT '[]',
      author_id  TEXT,
      created_at TEXT    NOT NULL,
      updated_at TEXT    NOT NULL
    )
  `)
}

// ─── Plugins ──────────────────────────────────────────────────────────────

// Global middleware — applied to all routes (register first so they cover everything)
app.configure(correlationId())           // X-Request-ID on every response
app.configure(requestLogger())           // method path status ms - ip
app.configure(rateLimit({ limit: 200, window: 60_000 }))

// Health + metrics at /health and /metrics
app.configure(healthPlugin({
  checks: {
    // Add your own readiness checks here:
    // database: async () => { app.db?.db.query('SELECT 1').get(); return true },
  },
}))

// Real-time WebSocket channels (the channels() plugin mounts /ws)
app.configure(channels((a: App & { channels?: ReturnType<typeof import('../src/transport/channels.ts').createChannelManager> }) => {
  a.channels?.on('connection', (_session, conn) => {
    a.channel?.('all').join(conn)
    a.channel?.('notes').join(conn)
  })
}))

// OpenAPI + Swagger UI
app.configure(openapi({
  title:       'Junction Demo API',
  version:     config.version,
  description: 'Demonstrates framework features: hooks, channels, actions, SSE, webhooks',
  ui:          '/api/docs',
}))

// Webhooks — fans out service events to registered HTTP endpoints
app.configure(webhooks({
  events: ['notes:created', 'notes:patched', 'notes:removed', 'users:created'],
}))

// ─── Services ─────────────────────────────────────────────────────────────

app.services.register(createUsersService(app))
app.services.register(createNotesService(app))

// ─── External API simulator service ───────────────────────────────────────
// Demonstrates circuitBreaker() protecting a service that calls an external API.
// The /api/prices service wraps a (simulated) slow/unreliable upstream.

let priceCallFailRate = 0   // 0–1, controllable via POST /api/prices/fail-rate

app.services.register(
  createService({
    name: 'prices',

    async find(ctx: ServiceContext) {
      // Simulate occasional upstream failures for circuit breaker demo
      if (Math.random() < priceCallFailRate) {
        throw new Error('Upstream price feed unavailable')
      }
      const symbols = ['AAPL', 'MSFT', 'GOOG', 'AMZN', 'TSLA']
      return symbols.map(s => ({
        symbol: s,
        price:  +(100 + Math.random() * 900).toFixed(2),
        change: +((Math.random() - 0.5) * 10).toFixed(2),
        ts:     Date.now(),
      }))
    },

    async get(ctx: ServiceContext) {
      if (Math.random() < priceCallFailRate) {
        throw new Error('Upstream price feed unavailable')
      }
      const symbol = String(ctx.id).toUpperCase()
      return {
        symbol,
        price:  +(100 + Math.random() * 900).toFixed(2),
        change: +((Math.random() - 0.5) * 10).toFixed(2),
        ts:     Date.now(),
      }
    },

    hooks: {
      around: {
        all: [circuitBreaker({
          threshold: 5,
          timeout:   15_000,
          onOpen:    (ctx) => log.warn(`Circuit OPEN: prices.${ctx.method}`),
          onClose:   (ctx) => log.info(`Circuit CLOSED: prices.${ctx.method}`),
        })],
      },
    },
  })
)

// ─── App-level hooks ──────────────────────────────────────────────────────

app.hooks({
  around: {
    all: [async (ctx, next) => {
      const t = Date.now()
      await next()
      log.debug(`${ctx.service}.${ctx.method} ${Date.now() - t}ms`)
    }],
  },
  after: {
    // Real-time push: broadcast note mutations to the 'notes' channel
    create: [publish((_result, ctx) => ctx.service === 'notes' ? app.channel?.('notes') ?? null : null)],
    patch:  [publish((_result, ctx) => ctx.service === 'notes' ? app.channel?.('notes') ?? null : null)],
    remove: [publish((_result, ctx) => ctx.service === 'notes' ? app.channel?.('notes') ?? null : null)],
  },
  error: {
    all: [async (ctx) => {
      log.error(`${ctx.service}.${ctx.method} error`, { code: ctx.error?.code, msg: ctx.error?.message })
    }],
  },
})

// ─── Custom HTTP routes ────────────────────────────────────────────────────

// Root — API index
app.get('/', ctx => ctx.json({
  name:    config.name,
  version: config.version,
  docs:    '/api/docs',
  links: {
    health:    '/health',
    metrics:   '/metrics',
    openapi:   '/api/openapi.json',
    users:     '/api/users',
    notes:     '/api/notes',
    prices:    '/api/prices',
    webhooks:  '/api/webhooks',
    events:    '/events',
    ws:        'ws://localhost:3000/ws',
    chat:      'ws://localhost:3000/chat/{room}',
  },
}))

// Login helper — returns a token for a pre-created user
// POST /login { "email": "alice@example.com" }
app.post('/login', async ctx => {
  const { email } = (ctx.body ?? {}) as { email?: string }
  if (!email) return ctx.json({ error: 'email required' }, 400)
  const sess = verifyDemoToken(email)
  if (!sess) return ctx.json({ error: 'Unknown email — create a user via POST /api/users first' }, 401)
  return ctx.json({ token: email, user: sess })
})

// ── Server-Sent Events ────────────────────────────────────────────────────

// GET /events — broadcast of all note mutations as a live stream
// Try: curl http://localhost:3000/events
app.get('/events', ctx => {
  const { response, send, onDisconnect } = ctx.sse()

  // Send a welcome event immediately
  send({ event: 'connected', data: { ts: Date.now(), msg: 'Listening for note events' } })

  // Forward note events to this SSE stream
  const offCreated = app.events.on('notes:created', (note) => send({ event: 'note:created', data: note }))
  const offPatched = app.events.on('notes:patched', (note) => send({ event: 'note:patched', data: note }))
  const offRemoved = app.events.on('notes:removed', (note) => send({ event: 'note:removed', data: note }))

  // Heartbeat every 30s so proxies don't close the connection
  const heartbeat = setInterval(() => send({ event: 'ping', data: { ts: Date.now() } }), 30_000)

  // Clean up when the client disconnects — no more hard 5-minute timeout needed
  onDisconnect(() => {
    clearInterval(heartbeat)
    if (typeof offCreated === 'function') offCreated()
    if (typeof offPatched === 'function') offPatched()
    if (typeof offRemoved === 'function') offRemoved()
  })

  return response
})

// GET /prices/:symbol — live price stream for one symbol via SSE
// Try: curl http://localhost:3000/prices/AAPL
app.get('/prices/{symbol}', ctx => {
  const { response, send, close } = ctx.sse()
  const symbol = ctx.params.symbol.toUpperCase()

  let ticks = 0
  const interval = setInterval(async () => {
    ticks++
    if (ticks > 60) { close(); clearInterval(interval); return }  // max 60 ticks
    try {
      const svc    = app.services.get('prices')!
      const { bridge: b } = await import('../src/transport/bridge.ts')
      const svcCtx = b.internal('prices', 'get', null)
      svcCtx.id    = symbol
      const { callService } = await import('../src/core/service.ts')
      await callService(svc, svcCtx)
      send({ event: 'price', data: svcCtx.result })
    } catch (err) {
      send({ event: 'error', data: { message: (err as Error).message } })
    }
  }, 1000)

  send({ event: 'subscribed', data: { symbol, msg: `Streaming ${symbol} every 1s` } })

  return response
})

// POST /api/prices/fail-rate — control the simulated failure rate (demo only)
// Body: { "rate": 0.5 }   ← 50% failure probability
app.post('/api/prices/fail-rate', async ctx => {
  const { rate } = (ctx.body ?? {}) as { rate?: number }
  if (typeof rate !== 'number' || rate < 0 || rate > 1)
    return ctx.json({ error: 'rate must be a number between 0 and 1' }, 400)
  priceCallFailRate = rate
  return ctx.json({ ok: true, failRate: priceCallFailRate, msg: `${Math.round(rate * 100)}% of price calls will now fail` })
})

// ── WebSocket routes ──────────────────────────────────────────────────────

// ws://localhost:3000/chat/{room}
// Demonstrates app.ws() with {param} path routing and WsContext.
// Messages: { type: 'message', text: '...' }
// Server broadcasts to all connections in the same room.

const chatRooms = new Map<string, Set<WsContext>>()

app.ws('/chat/{room}', {
  open(ctx) {
    const room = ctx.params.room
    if (!chatRooms.has(room)) chatRooms.set(room, new Set())
    chatRooms.get(room)!.add(ctx)

    ctx.send({ type: 'joined', room, online: chatRooms.get(room)!.size })
    log.debug(`ws:chat/${room} joined`, { user: ctx.user?.userId ?? 'anon' })
  },

  message(ctx, msg) {
    const room = ctx.params.room
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(typeof msg === 'string' ? msg : msg.toString()) }
    catch { ctx.send({ type: 'error', msg: 'invalid JSON' }); return }

    if (parsed.type !== 'message') return

    // Broadcast to everyone in the room
    const payload = {
      type:   'message',
      room,
      from:   ctx.user?.userId ?? 'anonymous',
      text:   String(parsed.text ?? ''),
      ts:     Date.now(),
    }
    for (const conn of chatRooms.get(room) ?? []) {
      try { conn.send(payload) } catch {}
    }
  },

  close(ctx) {
    const room = ctx.params.room
    chatRooms.get(room)?.delete(ctx)
    log.debug(`ws:chat/${room} left`)
  },
})

// ─── Scheduler ────────────────────────────────────────────────────────────

// Log active connections every minute
app.scheduler.every('1 minute', async () => {
  const stats = (app as unknown as { channels?: { stats(): { connections: number } } }).channels?.stats()
  if (stats?.connections) log.info('ws', { connections: stats.connections })
})

// Demo: emit a periodic heartbeat event (shows up in SSE /events stream)
app.scheduler.every('30 seconds', async () => {
  app.events.emit('heartbeat', { ts: Date.now(), services: app.services.list().length })
})

// ─── Start ────────────────────────────────────────────────────────────────

await app.start()

// ─────────────────────────────────────────────────────────────────────────
// REPL QUICKSTART
// ─────────────────────────────────────────────────────────────────────────
//
// bun run repl
//
//   health
//   metrics
//   services
//
//   post /api/users {"name":"Alice","email":"alice@example.com"}
//   auth <token from above>
//
//   post /api/notes {"title":"Hello","body":"My first note","tags":["demo"]}
//   get /api/notes
//   set id = $_.data[0].id
//   get /api/notes/$id
//   post /api/notes/$id --header "x-service-method: summary"
//   patch /api/notes/$id {"title":"Updated title"}
//
//   get /api/prices
//   post /api/prices/fail-rate {"rate":0.8}   ← trigger circuit breaker
//   get /api/prices                            ← watch it open after 5 failures
//   post /api/prices/fail-rate {"rate":0}      ← recover
//
//   watch /health 2000
//   watch /api/notes 3000
//
//   webhooks
//   webhooks add https://webhook.site/<id> notes:created notes:patched
//   post /api/notes {"title":"Webhook test","body":"Should trigger delivery"}
//   webhooks deliveries
