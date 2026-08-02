// example/elegant.ts
// ─────────────────────────────────────────────────────────────────────────
// The 80% path, spelled the short way: schema in, API out.
//
// Everything below the schema is wiring you write once per app, not per
// service. The service itself is six lines plus one custom action.
//
// What you get without writing it:
//   • Full CRUD at /api/leads          (createService + model)
//   • 400s from the schema's own rules (@length, @email, @gte)
//   • 401s from the model's @@gate     (read public, write user, delete admin)
//   • Pagination + result envelope     ($limit/$offset, { object, data, total })
//   • Live WebSocket events            (publish hook → 'leads' channel)
//   • /health and /metrics             (healthPlugin)
//
// ─── Try ──────────────────────────────────────────────────────────────────
//
//   bun run example/elegant.ts
//
//   curl http://localhost:3200/api/leads                     # public read
//   curl -X POST http://localhost:3200/api/leads \
//     -H 'content-type: application/json' -d '{"name":"Acme"}'   # → 401 (gate)
//
//   TOKEN=$(curl -s -X POST http://localhost:3200/login \
//     -H 'content-type: application/json' -d '{"email":"a@b.co"}' | jq -r .data.token)
//
//   curl -X POST http://localhost:3200/api/leads \
//     -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
//     -d '{"name":"Acme","email":"not-an-email","value":10}'     # → 400 (schema)
//
//   curl -X POST http://localhost:3200/api/leads \
//     -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
//     -d '{"name":"Acme","email":"buy@acme.com","value":12000}'  # → 201
//
//   curl -X POST http://localhost:3200/api/leads \
//     -H 'x-service-method: getStats'                            # custom action

import { createApp, createService, publish, channels, healthPlugin } from '../index.ts'
import type { App, IAuth } from '../index.ts'
import { createClient, GatePlugin, LEVELS } from '@frontierjs/litestone'

// ─── Schema — the seed. Field rules become 400s, the gate becomes 401s. ───
// (Scalar names match the published litestone 1.0.x — Integer/Text/Real.
// The next litestone renames them Int/String/Float; see single-file.ts's
// dialect note.)

const db = await createClient({
  db: ':memory:',
  schema: `
    enum LeadStatus { new active closed }

    model Lead {
      id        Integer    @id
      name      Text       @length(1, 200) @trim
      email     Text       @email
      status    LeadStatus @default(new)
      value     Real       @gte(0)
      createdAt DateTime   @default(now())

      @@gate("0.4.4.5")
    }
  `,
  plugins: [new GatePlugin({
    async getLevel(user) {
      if (!user) return LEVELS.STRANGER
      return (user as { role?: string }).role === 'admin' ? LEVELS.ADMINISTRATOR : LEVELS.USER
    },
  })],
})

await db.asSystem().lead.createMany({ data: [
  { name: 'Acme Corp',  email: 'contact@acme.com', status: 'new',    value: 12000 },
  { name: 'Globex Inc', email: 'info@globex.com',  status: 'active', value: 8500  },
]})

// ─── Auth — one method is all this demo needs. ────────────────────────────
// (IAuth requires the full provider surface; real apps use @frontierjs/auth.
// The cast is the one rough edge left in this file.)

const sessions = new Map<string, { userId: string }>()

const auth = {
  async verifySession(token: string) {
    const s = sessions.get(token)
    return s ? { userId: s.userId, userType: 'user', role: 'user', authMethod: 'session' as const } : null
  },
} as IAuth

// ─── App ──────────────────────────────────────────────────────────────────
// createApp({ db }) installs per-request Litestone scoping automatically —
// row policies and gates see the calling user with no extra wiring.

const app = createApp({
  db,
  auth,
  config: { name: 'leads-demo', port: 3200, apiPrefix: '/api' },
})

app.configure(healthPlugin())
app.configure(channels((a: App) => {
  a.channels!.on('connection', (_session, conn) => a.channel!('leads').join(conn))
}))

// ─── The service. ─────────────────────────────────────────────────────────
// CRUD, validation, auth, and pagination are derived from the model.
// `live` broadcasts every mutation to WebSocket subscribers.

const live = publish(() => app.channel!('leads'))

app.services.register(createService({
  name:  'leads',
  model: 'lead',

  hooks: { after: { create: [live], patch: [live], remove: [live] } },

  // POST /api/leads + X-Service-Method: getStats
  async getStats(ctx) {
    const scoped = ctx.locals.db as typeof db
    const leads  = await scoped.lead.findMany()
    const total  = leads.reduce((sum, l) => sum + Number(l.value ?? 0), 0)
    return { count: leads.length, totalValue: total, avgValue: leads.length ? Math.round(total / leads.length) : 0 }
  },
}))

// ─── Demo login — swap for @frontierjs/auth in a real app. ────────────────

app.post('/login', async ctx => {
  const { email } = (ctx.body ?? {}) as { email?: string }
  if (!email) return ctx.json({ error: 'email required' }, 400)
  const token = crypto.randomUUID()
  sessions.set(token, { userId: email })
  return ctx.json({ token })
})

await app.start()
