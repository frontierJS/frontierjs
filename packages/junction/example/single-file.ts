// example/single-file.ts
// ─────────────────────────────────────────────────────────────────────────
// A single-file Junction app, kitchen-sink edition.
//
// One file, no folders. Boots a working API in ~300 lines covering:
//   • Litestone schema, in-memory SQLite, gate-based authorization
//   • Service with full CRUD via createService()
//   • Custom service action (stats aggregation) — services aren't only CRUD
//   • Auth (token-based, swap for @frontierjs/auth in real apps)
//   • Built-in hooks: authenticate, protect (strips email from reads)
//   • WebSocket channels — clients get live CRUD events
//   • Scheduler — recurring background job
//   • Telemetry — subscribe to junction.* events
//   • Mailer stub — IMail implementation, no external service
//   • OpenAPI + Scalar UI at /api/docs
//   • Health + metrics endpoints
//   • App-level hooks for publish + audit logging
//   • Standard middleware (CORS, correlation IDs, request logger)
//
// The point of this file is to be a "show me what Junction looks like" demo
// you can read top-to-bottom. It is NOT the recommended layout for real
// apps — for that, use `fli init` to scaffold a proper folder structure.
//
// ─── Run ──────────────────────────────────────────────────────────────────
//
//   bun run src/example/single-file.ts
//
// ─── Try ──────────────────────────────────────────────────────────────────
//
//   # Login (any username + password works)
//   curl -s -X POST http://localhost:3000/auth/login \
//     -H 'content-type: application/json' \
//     -d '{"username":"alice","password":"x"}' | tee /tmp/login.json
//
//   TOKEN=$(jq -r .token /tmp/login.json)
//
//   # List leads (email field is stripped by the protect hook)
//   curl http://localhost:3000/api/leads
//
//   # Create a lead
//   curl -X POST http://localhost:3000/api/leads \
//     -H 'content-type: application/json' \
//     -H "authorization: Bearer $TOKEN" \
//     -d '{"name":"Wayne Enterprises","company":"Wayne Enterprises","email":"bruce@wayne.com","value":50000}'
//
//   # Custom action — stats aggregation across all leads
//   curl -X POST http://localhost:3000/api/leads \
//     -H 'x-service-method: getStats'
//
//   # Health + metrics + OpenAPI
//   curl http://localhost:3000/health
//   curl http://localhost:3000/metrics
//   open http://localhost:3000/api/docs       # Scalar UI
//
//   # Subscribe to live updates over WebSocket
//   wscat -c ws://localhost:3000
//   > {"type":"subscribe","channel":"leads"}
//
// ─── Imports ──────────────────────────────────────────────────────────────

import {
  createApp,
  createService,
  createLogger,
  channels,
  publish,
  authenticate,
  protect,
  openapi,
  healthPlugin,
  correlationId,
  requestLogger,
  cors,
  defaultConfig,
  mailerPlugin,
  type IMail, type MailMessage, type SendResult,
} from '../index.ts'

import { withLitestoneDb } from '../src/core/litestone.ts'

import {
  createClient,
  generateJsonSchema,
  GatePlugin,
  LEVELS,
} from '@frontierjs/litestone'

import type { App }            from '../src/core/app.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

// ─── Schema ───────────────────────────────────────────────────────────────
// Litestone schema as a string. See gate digits comment on the model.
//
// DIALECT NOTE: scalars are Int / String / Float / Bytes / Boolean /
// DateTime / Json / File. The pre-1.0 names (Integer/Text/Real/Blob) are
// REJECTED, not aliased — the parser errors with the new name to use. That
// was a deliberate hard cut; `litestone codemod` migrates .lite files.
// Junction resolves the workspace litestone (peer ^1.1.0), so this file needs
// the current dialect. npm's `latest` is still 1.0.3 and speaks the old one.

const SCHEMA = `
enum LeadStatus { new active closed }

model leads {
  id        Int    @id
  name      String       @length(1, 200) @trim
  company   String       @trim
  email     String       @email
  status    LeadStatus @default(new)
  value     Float       @gte(0)
  createdAt DateTime   @default(now())
  updatedAt DateTime   @updatedAt

  // RCUD = read, create, update, delete
  // 0 = stranger (public), 4 = user, 5 = administrator
  @@gate("0.4.4.5")
}
`

// ─── Database (in-memory) ─────────────────────────────────────────────────
// :memory: SQLite. Schema is passed inline to createClient — no migrations
// folder, no apply() step. Gate plugin maps the SessionContext shape to
// Litestone's authorization levels.

const log = createLogger({ ns: 'demo' })

const gate = new GatePlugin({
  async getLevel(user: unknown) {
    if (!user) return LEVELS.STRANGER
    if ((user as { role?: string }).role === 'admin') return LEVELS.ADMINISTRATOR
    return LEVELS.USER
  },
})

const db = await createClient({
  schema:  SCHEMA,
  db:      ':memory:',
  plugins: [gate],
})

// Seed a few leads so GET /api/leads returns something interesting.
await db.asSystem().leads.createMany({
  data: [
    { name: 'Acme Corp',    company: 'Acme Corp',    email: 'contact@acme.com',  status: 'new',    value: 12000 },
    { name: 'Globex Inc',   company: 'Globex Inc',   email: 'info@globex.com',   status: 'active', value: 8500  },
    { name: 'Initech',      company: 'Initech',      email: 'hello@initech.com', status: 'closed', value: 3200  },
  ],
})

const jsonSchema = generateJsonSchema(db.$schema)

// ─── Auth (token store) ───────────────────────────────────────────────────
// Trivial in-memory token map. Real apps: use @frontierjs/auth.
// Any username + any password works here.

const tokens = new Map<string, { userId: string; username: string; role: string }>()

function issueToken(username: string, role = 'user'): string {
  const token  = `tok-${username}-${Date.now()}`
  const userId = `user-${username}`
  tokens.set(token, { userId, username, role })
  return token
}

// ─── Mailer stub (logs to console) ────────────────────────────────────────
// IMail implementation that prints sends instead of hitting SMTP. Drop in
// createSmtpMailer or createResendMailer in production — the rest of the
// app talks to IMail, not the adapter.

const consoleMailer: IMail = {
  async send(msg: MailMessage): Promise<SendResult> {
    log.info('[mail] would send', { to: msg.to, subject: msg.subject })
    return { id: `mail-${Date.now()}`, accepted: Array.isArray(msg.to) ? msg.to : [msg.to] }
  },
  async batch(msgs) {
    return Promise.all(msgs.map(m => this.send(m)))
  },
}

// ─── App ──────────────────────────────────────────────────────────────────

const app = createApp({
  config: {
    ...defaultConfig,
    port:     3000,
    database: { url: '', log: false },   // we manage Litestone ourselves
  },

  auth: {
    async verifySession(token: string) {
      const entry = tokens.get(token)
      if (!entry) return null
      return {
        userId:     entry.userId,
        userType:   entry.role === 'admin' ? 'admin' : 'user',
        authMethod: 'session' as const,
        role:       entry.role,
        scopes:     [],
      }
    },
    async login()          { return { token: '', user: null as never } },   // unused — see /auth/login below
    async logout()         { return },
    async createUser()     { return { userId: '', userType: 'user', authMethod: 'session' as const, role: 'user', scopes: [] } },
    async deleteUser()     { return },
    async createApiKey(id) { return { key: `key-${id}`, id: `key-${id}` } },
    async revokeApiKey()   { return },
    async verifyApiKey(k)  {
      const entry = tokens.get(k)
      if (!entry) return null
      return { userId: entry.userId, userType: 'user', authMethod: 'session' as const, role: entry.role, scopes: [] }
    },
  },
})

// ─── Middleware ───────────────────────────────────────────────────────────

app.configure(cors({ origins: ['*'], credentials: true }))
app.configure(correlationId())
app.configure(requestLogger())

// ─── Health + metrics ─────────────────────────────────────────────────────
// Mounts GET /health and GET /metrics. /health returns liveness + readiness
// checks (add custom checks via the `checks` option); /metrics returns
// Prometheus-style counters. Both are public by default — for production,
// gate with the `token` or `authFn` option.

app.configure(healthPlugin({
  checks: {
    database: async () => {
      // Cheap readiness check — confirms the SQLite handle is alive.
      await db.asSystem().leads.count()
      return true
    },
  },
}))

// ─── OpenAPI + Scalar UI ──────────────────────────────────────────────────
// Auto-generates an OpenAPI 3.1 spec from registered services (their
// schemas, hooks, and method signatures). Scalar UI is mounted at
// /api/docs — open it in a browser for an interactive playground.

app.configure(openapi({
  title:       'Junction Demo API',
  version:     '1.0.0',
  description: 'Single-file Junction demo — leads CRUD with real-time updates',
  ui:          '/api/docs',
}))

// ─── Mailer ───────────────────────────────────────────────────────────────
// `app.mail` is now the consoleMailer — services and hooks can call it.

app.configure(mailerPlugin(consoleMailer))

// ─── WebSocket channels ───────────────────────────────────────────────────
// Mounts /ws (and the bare ws:// upgrade). New connections auto-join the
// 'leads' channel so they receive every lead create/patch/remove event.

app.configure(channels((a: App) => {
  a.channels?.on('connection', (_session, conn) => {
    a.channel?.('leads').join(conn)
  })
}))

// ─── Litestone db middleware ──────────────────────────────────────────────
// Builds a per-request auth-scoped db client and attaches it to ctx.params.db.
// Service code reads it via createService — no manual plumbing needed.

app.hooks({
  around: {
    all: [withLitestoneDb(db)],
  },
})

// ─── Leads service ────────────────────────────────────────────────────────
// Full CRUD on the `leads` model with a publish hook on every mutation.
// Schema gate is "0.4.4.5": reads are public, writes require auth, delete
// requires admin. The `authenticate` before-hook is technically redundant
// with the gate (Litestone enforces it) but makes the contract explicit
// at the Junction layer too.
//
// Hooks demonstrated:
//   • authenticate (before write) — rejects unauthenticated requests
//   • protect('email') (after read) — strips the email field from every
//     find/get response. Useful for "list this publicly but don't leak PII"
//     patterns. Tracked clients can still see the full record on their own
//     authenticated endpoints; the public list is sanitized.
//   • publish (after write) — broadcasts the change to WS subscribers.
//
// Custom action `getStats` demonstrates that services aren't only CRUD —
// any function on the service options object becomes a callable method,
// dispatched via the `X-Service-Method` header.

app.services.register(
  createService({
    name:   'leads',
    model:  'leads',
    schema: jsonSchema,

    hooks: {
      before: {
        create: [authenticate],
        patch:  [authenticate],
        remove: [authenticate],
      },
      after: {
        find:   [protect('email')],
        get:    [protect('email')],
        create: [publish((_r, _ctx) => app.channel?.('leads') ?? null)],
        patch:  [publish((_r, _ctx) => app.channel?.('leads') ?? null)],
        remove: [publish((_r, _ctx) => app.channel?.('leads') ?? null)],
      },
    },

    // Custom action: POST /api/leads with header `x-service-method: getStats`
    // Returns aggregate stats across all leads. The service has access to
    // the per-request scoped Litestone client via ctx.locals.db (set by
    // withLitestoneDb), so authorization is honoured automatically — a
    // STRANGER caller will only see what `0.4.4.5`'s read level allows.
    async getStats(ctx: ServiceContext) {
      const scopedDb = (ctx.params as { db?: typeof db }).db ?? db
      const all      = await scopedDb.asSystem().leads.findMany()

      const byStatus = all.reduce<Record<string, number>>((acc, lead) => {
        const k = String(lead.status)
        acc[k] = (acc[k] ?? 0) + 1
        return acc
      }, {})

      const totalValue = all.reduce<number>((sum, lead) => sum + Number(lead.value ?? 0), 0)
      const avgValue   = all.length > 0 ? totalValue / all.length : 0

      return {
        count:      all.length,
        byStatus,
        totalValue,
        avgValue:   Math.round(avgValue),
      }
    },
  })
)

// ─── App-level hooks ──────────────────────────────────────────────────────
// Audit log on every error; one place to centralize observability.

app.hooks({
  error: {
    all: [async (ctx: ServiceContext) => {
      log.error(`${ctx.service}.${ctx.method}`, {
        code: ctx.error?.code,
        msg:  ctx.error?.message,
      })
    }],
  },
})

// ─── Auth routes ──────────────────────────────────────────────────────────
// Plain HTTP routes — bypass the service pipeline since they don't touch
// any service.

app.post('/auth/login', async ctx => {
  const { username, password } = (ctx.body ?? {}) as { username?: string; password?: string }
  if (!username || !password) return ctx.json({ error: 'username and password required' }, 400)

  const token = issueToken(username, username === 'admin' ? 'admin' : 'user')
  const entry = tokens.get(token)!

  // Demo: send a "welcome" email through the mailer stub on first login.
  await app.mail?.send({
    to:      `${username}@example.com`,
    subject: 'Welcome to the Junction demo',
    html:    `<p>Hi ${username}, you're in. Your token is <code>${token}</code>.</p>`,
  })

  return ctx.json({ token, user: { id: entry.userId, username, role: entry.role } })
})

app.post('/auth/logout', async ctx => {
  const token = (ctx.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (token) tokens.delete(token)
  return ctx.json({ ok: true })
})

// ─── Telemetry subscriber ─────────────────────────────────────────────────
// Junction emits structured events for every service call, hook, WS event,
// and Litestone query — all correlated by telemetryId. Wire to your APM
// of choice; here we just log the slow ones.

app.telemetry.on('junction.call.end', (ev: unknown) => {
  const e = ev as { service?: string; method?: string; durationMs?: number; ok?: boolean }
  if (e.durationMs && e.durationMs > 100) {
    log.warn(`[slow] ${e.service}.${e.method} ${e.durationMs}ms`)
  }
})

app.telemetry.on('junction.channel.publish', (ev: unknown) => {
  const e = ev as { channel?: string; recipients?: number }
  log.debug(`[publish] ${e.channel} → ${e.recipients} clients`)
})

// ─── Scheduled job ────────────────────────────────────────────────────────
// Heartbeat that emits an event the channels plugin doesn't care about —
// a placeholder for "send digest emails", "rotate API keys", etc.

app.scheduler.every('30 seconds', async () => {
  const count = await db.asSystem().leads.count()
  log.info(`[heartbeat] ${count} leads in db`)
})

// ─── Start ────────────────────────────────────────────────────────────────

await app.start()

log.info('demo app running')
log.info('  HTTP → http://localhost:3000')
log.info('  WS   → ws://localhost:3000')
log.info('  POST /auth/login        — { username, password } → { token }')
log.info('  GET  /api/leads         — list (public, email stripped)')
log.info('  POST /api/leads         — create (auth required)')
log.info('  PATCH/DELETE /api/leads/:id — update/delete (auth required)')
log.info('  POST /api/leads + x-service-method: getStats — aggregate stats')
log.info('  GET  /health            — liveness + readiness checks')
log.info('  GET  /metrics           — Prometheus-style counters')
log.info('  GET  /api/docs          — Scalar API explorer')
