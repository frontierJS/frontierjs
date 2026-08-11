// example/api/app.ts — the API half.
//
//   bun run example:api        (from packages/sierra)
//
// This is deliberately close to junction/example/fullstack/app.ts: the point of
// THIS example is not the server, it is what Sierra does with the same
// db/schema.lite on the other side of the wire. Read that example for the API
// story; read ../web/src/resources/leads.mesa for this one.

import { readFileSync } from 'node:fs'
import { join }         from 'node:path'

import {
  createApp, channels, healthPlugin, sessionGateLevel,
  type App, type IAuth,
} from '@frontierjs/junction'

import { createClient, autoMigrate, GatePlugin } from '@frontierjs/litestone'

const HERE = import.meta.dir
const PORT = 8130

// ─── 1. Data ──────────────────────────────────────────────────────────────
// The SAME file the Vite build reads to seed the browser. Neither side restates
// it, which is the entire claim this example exists to test.

const db = await createClient({
  db:     ':memory:',
  schema: readFileSync(join(HERE, '../db/schema.lite'), 'utf8'),
  plugins: [new GatePlugin({ getLevel: sessionGateLevel })],
})

autoMigrate(db)

type Sys = { asSystem(): Record<string, {
  count(): Promise<number>
  createMany(a: { data: Record<string, unknown>[] }): Promise<unknown>
}> }
const sys = (db as unknown as Sys).asSystem()

if (await sys.account.count() === 0) {
  await sys.account.createMany({ data: [
    { id: 1, name: 'Acme Corp' },
    { id: 2, name: 'Globex' },
  ] })
  await sys.tag.createMany({ data: [
    { id: 1, name: 'inbound' },
    { id: 2, name: 'referral' },
  ] })
  // Note what is NOT here: `tags`. An implicit m2m relation is not a column, so
  // it is not part of a create payload. Before the generator was fixed it was
  // emitted as a required array-of-string and this seed would have 400'd.
  await sys.lead.createMany({ data: [
    { name: 'Ada Lovelace',  email: 'ada@acme.test',   stage: 'qualified', value: 4200, accountId: 1, slug: 'ada' },
    { name: 'Grace Hopper',  email: 'grace@acme.test', stage: 'won',       value: 9100, accountId: 1 },
    { name: 'Alan Turing',   email: 'alan@globex.test', stage: 'new',      value: 0,    accountId: 2 },
  ] })
}

// ─── 2. Auth ──────────────────────────────────────────────────────────────
// The dumbest thing that works. @@gate("0.4.4.5") is what makes reads public
// and writes authenticated — no service declares any of it. Real apps use
// @frontierjs/auth.

const sessions = new Map<string, { userId: string; admin: boolean }>()

const auth = {
  async verifySession(token: string) {
    const s = sessions.get(token)
    if (!s) return null
    return {
      userId: s.userId, userType: 'user', role: 'user', authMethod: 'session' as const,
      // sessionGateLevel grades a plain session as USER(4): enough to create and
      // update, one short of the 5 this schema wants for DELETE. Signing in as
      // admin lifts it to ADMINISTRATOR(5) — which is what the UI's disabled
      // delete button is predicting from x-gate.
      isAdmin: s.admin,
    }
  },
} as unknown as IAuth

// ─── 3. API ───────────────────────────────────────────────────────────────

const app = createApp({
  db,
  auth,
  config: { name: 'sierra-example', port: PORT, apiPrefix: '/api' },
})

app.configure(healthPlugin())
app.configure(channels((a: App) => {
  a.channels!.on('connection', (_session, conn) => { a.channel!('leads').join(conn) })
}))

// ─── 4. Demo login ────────────────────────────────────────────────────────
// POST /login { admin: true } to get a token that clears the delete gate.

app.post('/login', async ctx => {
  // A raw route's ctx is a TransportContext: the parsed body is `ctx.body`.
  // Re-reading the request (ctx.$raw.$req.json()) silently yields nothing,
  // which showed up here as "sign in as admin" quietly granting level 4.
  const body  = (ctx.body ?? {}) as { admin?: boolean }
  const token = crypto.randomUUID()
  sessions.set(token, { userId: 'demo@example.com', admin: body.admin === true })
  // The browser needs the level to decide what to render. The SERVER is what
  // enforces it; this is only so the UI can avoid offering a button that 403s.
  return ctx.json({ token, level: body.admin ? 5 : 4 })
})

await app.start()

console.log(`
  ─────────────────────────────────────────────
    API   http://localhost:${PORT}/api/leads
    UI    bun run example        → http://localhost:8030

    curl http://localhost:${PORT}/api/leads
    curl -X POST http://localhost:${PORT}/api/leads \\
         -H 'content-type: application/json' \\
         -d '{"name":"From curl"}'      # 401 — @@gate says writes need a user
  ─────────────────────────────────────────────
`)
