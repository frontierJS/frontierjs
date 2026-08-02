// example/server.js
// A complete Bun HTTP API server backed by Litestone.
// One file — boots the DB, applies the schema, and serves a REST API.
//
// Run:    bun example/server.js
// Try:    curl http://localhost:3000/accounts
//         curl -X POST http://localhost:3000/accounts \
//              -H "Content-Type: application/json" \
//              -d '{"name":"Acme"}'

import { createClient, autoMigrate, GatePlugin, LEVELS } from '../src/index.js'
import { dirname, resolve } from 'path'
import { fileURLToPath }    from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH   = resolve(__dirname, 'server-demo.db')
const PORT      = 3000

// ─── 1. Schema ────────────────────────────────────────────────────────────────
// Model names are PascalCase and singular — always. The client accessor is the
// camelCase of the model name: model Account → db.account.
// Gates use the named form; the digit form ("0.4.4.5") is the compact
// equivalent — see docs/access-control.md.

const SCHEMA = `
  enum Plan { starter pro enterprise }
  enum Role { admin member viewer }

  model Account {
    id        Int      @id
    name      String
    plan      Plan     @default(starter)
    createdAt DateTime @default(now())

    @@gate(read: VISITOR, write: ADMINISTRATOR, delete: OWNER)
  }

  model User {
    id        Int      @id
    account   Account  @relation(fields: [accountId], references: [id])
    accountId Int
    email     String   @unique @email @lower
    role      Role     @default(member)
    createdAt DateTime @default(now())
    deletedAt DateTime?

    @@gate(read: READER, write: USER, delete: ADMINISTRATOR)
  }

  model Post {
    id        Int      @id
    account   Account  @relation(fields: [accountId], references: [id])
    accountId Int
    title     String
    body      String?
    published Boolean  @default(false)
    createdAt DateTime @default(now())
    deletedAt DateTime?

    @@gate(read: STRANGER, write: USER, delete: ADMINISTRATOR)
  }
`

// ─── 2. Boot ──────────────────────────────────────────────────────────────────
// createClient opens the connections; autoMigrate() syncs the SQLite file to
// the schema (idempotent — a DDL-hash fast path makes it free on every start).
// No hand-written DDL, no existsSync dance.
//
// Because the schema declares @@gate, enforcement is on by default (using the
// standard FrontierGateGetLevel resolver). This demo installs its OWN
// GatePlugin instead — the header-role auth below doesn't carry the
// verifiedAt/activatedAt fields the default resolver reads.

const db = await createClient({
  db:     DB_PATH,
  schema: SCHEMA,
  plugins: [
    new GatePlugin({
      getLevel(user, _model) {
        // In a real app: decode JWT, look up role, return level.
        if (!user)                  return LEVELS.STRANGER
        if (user.role === 'admin')  return LEVELS.ADMINISTRATOR
        if (user.role === 'member') return LEVELS.USER
        return LEVELS.READER
      }
    })
  ]
})

autoMigrate(db)

// Seed once — plain ORM calls, no raw SQL.
if (await db.asSystem().account.count() === 0) {
  const sys = db.asSystem()
  await sys.account.createMany({ data: [
    { id: 1, name: 'Acme Corp', plan: 'pro' },
    { id: 2, name: 'Beta Corp', plan: 'starter' },
  ]})
  await sys.user.createMany({ data: [
    { id: 1, accountId: 1, email: 'alice@acme.com', role: 'admin'  },
    { id: 2, accountId: 1, email: 'bob@acme.com',   role: 'member' },
  ]})
  await sys.post.createMany({ data: [
    { id: 1, accountId: 1, title: 'Hello World', body: 'Our first post', published: true },
    { id: 2, accountId: 1, title: 'Draft post',  published: false },
  ]})
  console.log('Database seeded.')
}

// ─── 3. Auth helper ───────────────────────────────────────────────────────────
// In a real app you'd verify a JWT, check a session cookie, etc.
// Here we just read an X-User-Role header for demonstration.
// $setAuth() returns a new scoped client — same DB, same connections,
// but with ctx.auth set so the GatePlugin knows who's asking.

function getAuthClient(req) {
  const role = req.headers.get('x-user-role') ?? null
  const user = role ? { role } : null
  return db.$setAuth(user)
}

// ─── 4. Router ────────────────────────────────────────────────────────────────
// Bun.serve() handles all HTTP. We do our own minimal routing —
// match method + pathname, map the plural REST segment to the singular
// accessor, call Litestone, return JSON.

const RESOURCES = {
  accounts: 'account',
  users:    'user',
  posts:    'post',
}

async function handleRequest(req) {
  const url      = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const [resource, id] = segments          // e.g. ['accounts', '1']
  const client   = getAuthClient(req)
  const accessor = RESOURCES[resource]

  try {

    if (!accessor) return notFound(`Unknown resource: ${resource ?? '/'}`)
    const table = client[accessor]

    // ── GET /accounts ─────────────────────────────────────────────────────────
    // List all records. Supports ?limit=N. The gate silently blocks the whole
    // request if the user's level is below the model's read requirement.

    if (req.method === 'GET' && !id) {
      const limit = parseInt(url.searchParams.get('limit') ?? '50')
      return json(await table.findMany({ limit }))
    }

    // ── GET /accounts/1 ───────────────────────────────────────────────────────

    if (req.method === 'GET' && id) {
      return json(await table.findUniqueOrThrow({ where: { id: parseInt(id) } }))
    }

    // ── POST /accounts ────────────────────────────────────────────────────────
    // Create. Litestone validates types, runs @email / @lower / @default
    // transforms, checks the gate's create level, and silently strips any
    // unknown keys in the body (mass-assignment protection).

    if (req.method === 'POST' && !id) {
      const created = await table.create({ data: await req.json() })
      return json(created, 201)
    }

    // ── PATCH /accounts/1 ────────────────────────────────────────────────────

    if (req.method === 'PATCH' && id) {
      return json(await table.update({
        where: { id: parseInt(id) },
        data:  await req.json(),
      }))
    }

    // ── DELETE /accounts/1 ───────────────────────────────────────────────────
    // Hard delete (or soft delete if the model has deletedAt).

    if (req.method === 'DELETE' && id) {
      await table.delete({ where: { id: parseInt(id) } })
      return json({ deleted: true })
    }

    return notFound('Route not found')

  } catch (e) {

    // ── Error handling ────────────────────────────────────────────────────────
    // AccessDeniedError — thrown when the gate rejects the op.
    // NOT_FOUND        — thrown by findUniqueOrThrow when no row matches.
    // ValidationError  — thrown when @email / @gte / required fields fail.
    // Everything else  — 500.

    if (e.code === 'ACCESS_DENIED')
      return json({ error: 'Access denied', required: e.required, got: e.got }, 403)

    if (e.code === 'NOT_FOUND')
      return json({ error: e.message }, 404)

    if (e.name === 'ValidationError')
      return json({ error: e.message }, 422)

    console.error(e)
    return json({ error: 'Internal server error' }, 500)
  }
}

// ─── 5. Response helpers ──────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function notFound(msg) {
  return json({ error: msg }, 404)
}

// ─── 6. Start the server ──────────────────────────────────────────────────────
// Bun.serve() is non-blocking. Every request gets a fresh $setAuth() client —
// auth context is per-request; the underlying connections are shared.

Bun.serve({
  port: PORT,
  fetch: handleRequest,
})

console.log(`
╔══════════════════════════════════════════════════════╗
║  Litestone API server running                        ║
╠══════════════════════════════════════════════════════╣
║  http://localhost:${PORT}                               ║
║                                                      ║
║  Try:                                                ║
║  curl http://localhost:${PORT}/accounts                 ║
║  curl http://localhost:${PORT}/posts                    ║
║  curl http://localhost:${PORT}/accounts/1               ║
║                                                      ║
║  With auth (member can create):                      ║
║  curl -X POST http://localhost:${PORT}/posts \\          ║
║    -H "x-user-role: member" \\                        ║
║    -H "Content-Type: application/json" \\             ║
║    -d '{"accountId":1,"title":"New post"}'           ║
║                                                      ║
║  Admin-only (delete):                                ║
║  curl -X DELETE http://localhost:${PORT}/posts/1 \\      ║
║    -H "x-user-role: admin"                           ║
║                                                      ║
║  Will be denied (no auth):                           ║
║  curl -X DELETE http://localhost:${PORT}/posts/1        ║
║                                                      ║
║  Ctrl+C to stop                                      ║
╚══════════════════════════════════════════════════════╝
`)
