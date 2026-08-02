// example/server.ts — Junction smoke-test server (Litestone-backed)
//
// Run:  bun run example/server.ts
//
// Endpoints:
//   POST /auth/login   { username, password } → { token, user }
//   POST /auth/logout  → { ok }
//   GET    /api/leads
//   POST   /api/leads        (auth required)
//   GET    /api/leads/:id
//   PATCH  /api/leads/:id    (auth required)
//   DELETE /api/leads/:id    (auth required)
//
// WebSocket:
//   ws://localhost:3000  — real-time lead events

import {
  createApp,
  createService,
  createLogger,
  channels,
  authenticate,
  publish,
  correlationId,
  requestLogger,
  defaultConfig,
  cors,
} from '../index.ts'

import { withLitestoneDb } from '../src/core/litestone.ts'

import {
  createClient,
  generateJsonSchema,
  GatePlugin,
  LEVELS,
} from '@frontierjs/litestone'

import type { App } from '../src/core/app.ts'

const log = createLogger({ ns: 'smoke' })

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
enum LeadStatus {
  new
  active
  closed
}

model leads {
  id        Integer    @id
  name      Text       @length(1, 200) @trim
  company   Text       @trim
  email     Text       @email
  status    LeadStatus @default(new)
  value     Real       @gte(0)
  createdAt DateTime   @default(now())
  updatedAt DateTime   @default(now()) @updatedAt

  @@gate("4.4.4.6")   // R/C/U=USER  D=OWNER
}
`

// ─── DB ───────────────────────────────────────────────────────────────────────

const gate = new GatePlugin({
  async getLevel(user: unknown) {
    if (!user) return LEVELS.STRANGER
    return LEVELS.USER
  },
})

const db = await createClient('./smoke.db', SCHEMA, { plugins: [gate] })

// Apply migrations / create tables on first run
const { apply } = await import('@frontierjs/litestone')
await apply(db, { schema: SCHEMA, migrations: './smoke-migrations' })

// Seed some leads if the table is empty
const count = await db.asSystem().leads.count()
if (count === 0) {
  await db.asSystem().leads.createMany({ data: [
    { name: 'Acme Corp',    company: 'Acme Corp',    email: 'contact@acme.com',  status: 'new',    value: 12000 },
    { name: 'Globex Inc',   company: 'Globex Inc',   email: 'info@globex.com',   status: 'active', value: 8500  },
    { name: 'Initech',      company: 'Initech',      email: 'hello@initech.com', status: 'closed', value: 3200  },
    { name: 'Umbrella LLC', company: 'Umbrella LLC', email: 'biz@umbrella.com',  status: 'new',    value: 21000 },
    { name: 'Vandelay',     company: 'Vandelay',     email: 'art@vandelay.com',  status: 'active', value: 6700  },
  ]})
}

const jsonSchema = generateJsonSchema(db.$schema)

// ─── Token store ──────────────────────────────────────────────────────────────
// Any username + any password works — this is a smoke test.

const tokens = new Map<string, { username: string; userId: string }>()

function issueToken(username: string): string {
  const token   = `smoke-${username}-${Date.now()}`
  const userId = `user-${username}`
  tokens.set(token, { username, userId })
  return token
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = createApp({
  config: {
    ...defaultConfig,
    port:     3000,
    database: { url: '', log: false },
  },
  auth: {
    async verifySession(token: string) {
      const entry = tokens.get(token)
      if (!entry) return null
      return {
        userId:     entry.userId,
        userType:   'user',
        authMethod: 'session' as const,
        role:        'user',
        scopes:      [],
      }
    },
    async login()          { return { token: '', user: null as never } },
    async logout()         { return },
    async createUser()     { return { userId: '', userType: 'user', authMethod: 'session' as const, role: 'user', scopes: [] } },
    async deleteUser()     { return },
    async createApiKey(id) { return { key: `key-${id}`, id: `key-${id}` } },
    async revokeApiKey()   { return },
    async verifyApiKey(k)  {
      const entry = tokens.get(k)
      if (!entry) return null
      return { userId: entry.userId, userType: 'user', authMethod: 'session' as const, role: 'user', scopes: [] }
    },
  },
})

// ─── Middleware ───────────────────────────────────────────────────────────────

app.configure(cors({ origins: ['http://localhost:5173'], credentials: true }))
app.configure(correlationId())
app.configure(requestLogger())

// ─── Real-time channels ───────────────────────────────────────────────────────

app.configure(
  channels((a: App) => {
    a.channels?.on('connection', (_session, conn) => {
      a.channel?.('leads').join(conn)
    })
  })
)

// ─── Litestone db middleware ──────────────────────────────────────────────────
// Builds a per-request auth-scoped db client on ctx.params.db.

app.hooks({
  around: {
    all: [
      withLitestoneDb(db),
    ],
  },
})

// ─── Leads service ────────────────────────────────────────────────────────────

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
        create: [publish((_r, ctx) => app.channel?.('leads') ?? null)],
        patch:  [publish((_r, ctx) => app.channel?.('leads') ?? null)],
        remove: [publish((_r, ctx) => app.channel?.('leads') ?? null)],
      },
    },
  })
)

// ─── App-level hooks ──────────────────────────────────────────────────────────

app.hooks({
  error: {
    all: [async (ctx) => {
      log.error(`${ctx.service}.${ctx.method}`, { code: ctx.error?.code, msg: ctx.error?.message })
    }],
  },
})

// ─── Auth routes ──────────────────────────────────────────────────────────────

app.post('/auth/login', async ctx => {
  const { username, password } = (ctx.body ?? {}) as { username?: string; password?: string }
  if (!username || !password)
    return ctx.json({ message: 'username and password required' }, 400)

  const token = issueToken(username)
  const entry = tokens.get(token)!
  return ctx.json({ token, user: { id: entry.userId, username: entry.username } })
})

app.post('/auth/logout', async ctx => {
  const token = (ctx.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()
  if (token) tokens.delete(token)
  return ctx.json({ ok: true })
})

// ─── Start ────────────────────────────────────────────────────────────────────

await app.start()

log.info('smoke server running (Litestone-backed)')
log.info('  HTTP → http://localhost:3000')
log.info('  WS   → ws://localhost:3000')
log.info('  POST /auth/login { username, password }')
log.info('  GET  /api/leads')
