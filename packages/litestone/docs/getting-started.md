# Getting Started

## Install

```bash
bun add @frontierjs/litestone
```

## Scaffold

```bash
bunx litestone init              # creates schema.lite + litestone.config.js
bunx litestone migrate create initial
bunx litestone migrate apply
bunx litestone studio            # browser UI at http://localhost:5001
```

## Quick start

```js
import { createClient } from '@frontierjs/litestone'

const db = await createClient({ path: './schema.lite', db: './app.db' })

// Create
const user = await db.user.create({
  data: { email: 'alice@example.com', name: 'Alice', accountId: 1 }
})

// Read
const users = await db.user.findMany({
  where:   { role: 'admin' },
  include: { account: true },
  orderBy: { createdAt: 'desc' },
  limit:   20,
})

// Update
await db.user.update({ where: { id: user.id }, data: { name: 'Alice Smith' } })

// Delete (soft if @@softDelete, hard otherwise)
await db.user.remove({ where: { id: user.id } })
```

## createClient options

```js
const db = await createClient({
  // Schema source — pick one
  path:    './schema.lite',        // path to .lite file
  // parsed: parseResult,          // pre-parsed result (for multi-file schemas)
  // schema: `model t { id Integer @id }`, // inline schema string

  db:            './app.db',       // DB path (omit if schema has database blocks)
  encryptionKey: process.env.ENC_KEY,  // 64-char hex = 32 bytes (required for @encrypted/@secret)
  computed:      './db/computed.js',   // app-layer computed fields

  plugins: [
    new GatePlugin({ getLevel }),
    FileStorage({ provider: 'r2', ... }),
  ],

  // Production query logging
  onQuery: (event) => logger.debug(event),

  // Lifecycle hooks
  hooks: {
    before: { setters: [fn], update: [fn], all: [fn] },
    after:  { getters: [fn], all: [fn] },
  },

  // Event listeners (fires after commit)
  onEvent: { create: fn, update: fn, remove: fn, change: fn },

  // Global query filters — applied to all reads on these models
  filters: {
    post:  { status: 'published' },
    user:  (ctx) => ({ tenantId: ctx.auth?.tenantId }),
  },

  // Audit log enrichment
  onLog: (entry, ctx) => ({
    actorId:   ctx.auth?.id,
    actorType: ctx.auth?.type,
    meta:      { requestId: ctx.requestId },
  }),

  // Open all SQLite databases read-only — writes throw immediately
  // readOnly: true,
})
```

## Auth scoping

Every request should use a scoped client so policies and field rules see the current user:

```js
// Middleware
app.use((req, res, next) => {
  req.db = db.$setAuth(req.user)
  next()
})

// Route handler
app.get('/posts', async (req) => {
  return req.db.post.findMany()  // policies applied
})

// System bypass — use sparingly
const sysDb = db.asSystem()   // bypasses @@gate, @@allow/@@deny, @guarded fields
```

## Multi-file schemas

If your schema uses `import` statements, use `parseFile()` so paths resolve correctly:

```js
import { parseFile, createClient } from '@frontierjs/litestone'

const result = parseFile('./schema.lite')
const db     = await createClient({ parsed: result })
```

See [schema.md](./schema.md) for the full schema reference.
