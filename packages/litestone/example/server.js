// example/server.js
// A complete Bun HTTP API server backed by Litestone.
// One file — boots the DB, applies the schema, and serves a REST API.
//
// Run:    bun example/server.js
// Try:    curl http://localhost:3000/accounts
//         curl -X POST http://localhost:3000/accounts \
//              -H "Content-Type: application/json" \
//              -d '{"name":"Acme"}'

import { createClient, GatePlugin, LEVELS, AccessDeniedError } from '../src/index.js'
import { parse }            from '../src/core/parser.js'
import { generateDDL }      from '../src/core/ddl.js'
import { splitStatements }  from '../src/core/migrate.js'
import { Database }         from 'bun:sqlite'
import { dirname, resolve } from 'path'
import { fileURLToPath }    from 'url'
import { existsSync }       from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH   = resolve(__dirname, 'server-demo.db')
const PORT      = 3000

// ─── 1. Schema ────────────────────────────────────────────────────────────────
// Define your data models as a .lite string (or point parse() at a file).
// This schema is inlined here so the file is fully self-contained —
// in a real project you'd use:  const parseResult = parseFile('./schema.lite')

const SCHEMA = `
  enum Plan { starter pro enterprise }
  enum Role { admin member viewer }

  model accounts {
    id        Integer @id
    name      Text
    plan      Plan    @default(starter)
    createdAt DateTime @default(now())

    @@gate(read: VISITOR, write: ADMINISTRATOR, delete: OWNER)
  }

  model users {
    id        Integer  @id
    account   accounts @relation(fields: [accountId], references: [id])
    accountId Integer
    email     Text     @unique @email @lower
    role      Role     @default(member)
    createdAt DateTime @default(now())
    deletedAt DateTime?

    @@gate(read: READER, write: USER, delete: ADMINISTRATOR)
  }

  model posts {
    id        Integer  @id
    account   accounts @relation(fields: [accountId], references: [id])
    accountId Integer
    title     Text
    body      Text?
    published Boolean  @default(false)
    createdAt DateTime @default(now())
    deletedAt DateTime?

    @@gate(read: VISITOR, write: USER, delete: ADMINISTRATOR)
  }
`

// ─── 2. Boot the database ─────────────────────────────────────────────────────
// Parse the schema, generate DDL, and apply it to the SQLite file.
// IF NOT EXISTS means this is safe to call every time — it's idempotent.
// On first run it creates the tables; on subsequent runs it's a no-op.

const parseResult = parse(SCHEMA)
if (!parseResult.valid) {
  console.error('Schema errors:\n' + parseResult.errors.join('\n'))
  process.exit(1)
}

if (!existsSync(DB_PATH)) {
  // First run — create the DB and seed some data
  console.log('Creating database...')
  const seed = new Database(DB_PATH)
  for (const stmt of splitStatements(generateDDL(parseResult.schema)))
    if (!stmt.startsWith('PRAGMA')) seed.run(stmt)
  seed.run(`INSERT INTO accounts VALUES (1, 'Acme Corp',  'pro',        datetime('now'))`)
  seed.run(`INSERT INTO accounts VALUES (2, 'Beta Corp',  'starter',    datetime('now'))`)
  seed.run(`INSERT INTO users VALUES    (1, 1, 'alice@acme.com',  'admin',  datetime('now'), NULL)`)
  seed.run(`INSERT INTO users VALUES    (2, 1, 'bob@acme.com',    'member', datetime('now'), NULL)`)
  seed.run(`INSERT INTO posts VALUES    (1, 1, 'Hello World', 'Our first post', 1, datetime('now'), NULL)`)
  seed.run(`INSERT INTO posts VALUES    (2, 1, 'Draft post',  NULL,            0, datetime('now'), NULL)`)
  seed.close()
  console.log('Database seeded.')
}

// ─── 3. Create the Litestone client ───────────────────────────────────────────
// One client instance shared across ALL requests — createClient is called once
// at startup, not per-request. It opens two SQLite connections (read + write)
// and caches prepared statements.
//
// The GatePlugin enforces @@gate policies on every operation.
// The getLevel() function is called once per model per request and cached —
// in a real app this would look up the user's role from the session/JWT.

const db = await createClient(DB_PATH, parseResult, {
  plugins: [
    new GatePlugin({
      getLevel(user, _model) {
        // In a real app: decode JWT, look up role, return level.
        // Here we just read from the user object set by $setAuth().
        if (!user)              return LEVELS.STRANGER
        if (user.role === 'admin')  return LEVELS.ADMINISTRATOR
        if (user.role === 'member') return LEVELS.USER
        return LEVELS.READER
      }
    })
  ]
})

// ─── 4. Auth helper ───────────────────────────────────────────────────────────
// In a real app you'd verify a JWT, check a session cookie, etc.
// Here we just read an X-User-Role header for demonstration.
// $setAuth() returns a new scoped client — same DB, same connections,
// but with ctx.auth set so the GatePlugin knows who's asking.

function getAuthClient(req) {
  const role = req.headers.get('x-user-role') ?? null
  const user = role ? { role } : null
  return db.$setAuth(user)
}

// ─── 5. Router ────────────────────────────────────────────────────────────────
// Bun.serve() handles all HTTP. We do our own minimal routing —
// match method + pathname prefix, parse params, call Litestone, return JSON.

async function handleRequest(req) {
  const url      = new URL(req.url)
  const segments = url.pathname.split('/').filter(Boolean)
  const [resource, id] = segments          // e.g. ['accounts', '1']
  const client   = getAuthClient(req)

  try {

    // ── GET /accounts ─────────────────────────────────────────────────────────
    // List all records. Supports ?limit=N and ?search=q query params.
    // The GatePlugin silently blocks the whole request if the user's level
    // is below the model's @@gate read requirement.

    if (req.method === 'GET' && resource && !id) {
      const table  = client[resource]
      if (!table) return notFound(`Unknown resource: ${resource}`)

      const limit  = parseInt(url.searchParams.get('limit') ?? '50')
      const rows   = await table.findMany({ limit })
      return json(rows)
    }

    // ── GET /accounts/1 ───────────────────────────────────────────────────────
    // Fetch a single record by ID. Throws NOT_FOUND if missing.

    if (req.method === 'GET' && resource && id) {
      const table = client[resource]
      if (!table) return notFound(`Unknown resource: ${resource}`)

      const row = await table.findUniqueOrThrow({ where: { id: parseInt(id) } })
      return json(row)
    }

    // ── POST /accounts ────────────────────────────────────────────────────────
    // Create a new record. Body is JSON. Litestone validates types, runs
    // @email / @lower / @default transforms, and checks @@gate create level.
    // Auto-increments @id if not provided.

    if (req.method === 'POST' && resource && !id) {
      const table = client[resource]
      if (!table) return notFound(`Unknown resource: ${resource}`)

      const data    = await req.json()
      const created = await table.create({ data })
      return json(created, 201)
    }

    // ── PATCH /accounts/1 ────────────────────────────────────────────────────
    // Partial update — only the fields in the body are changed.
    // @@gate update level is checked before any SQL runs.

    if (req.method === 'PATCH' && resource && id) {
      const table = client[resource]
      if (!table) return notFound(`Unknown resource: ${resource}`)

      const data    = await req.json()
      const updated = await table.update({
        where: { id: parseInt(id) },
        data,
      })
      return json(updated)
    }

    // ── DELETE /accounts/1 ───────────────────────────────────────────────────
    // Hard delete (or soft delete if the model has deletedAt).
    // @@gate delete level — this is the most restrictive position.

    if (req.method === 'DELETE' && resource && id) {
      const table = client[resource]
      if (!table) return notFound(`Unknown resource: ${resource}`)

      await table.delete({ where: { id: parseInt(id) } })
      return json({ deleted: true })
    }

    return notFound('Route not found')

  } catch (e) {

    // ── Error handling ────────────────────────────────────────────────────────
    // AccessDeniedError — thrown by the GatePlugin when @@gate rejects the op.
    // NOT_FOUND        — thrown by findUniqueOrThrow when no row matches.
    // ValidationError  — thrown when @email / @gte / @maxLength etc. fail.
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

// ─── 6. Response helpers ──────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function notFound(msg) {
  return json({ error: msg }, 404)
}

// ─── 7. Start the server ──────────────────────────────────────────────────────
// Bun.serve() is non-blocking. The process stays alive serving requests.
// Every request gets a fresh $setAuth() client — auth context is per-request,
// not shared. The underlying DB connections are shared and connection-pooled.

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
