# Getting Started

## Install

```bash
bun add @frontierjs/litestone
```

## Scaffold

```bash
bunx litestone init              # creates schema.lite, litestone.config.js and migrations/
bunx litestone migrate create initial
bunx litestone migrate apply     # builds ./development.db — the config's default db
bunx litestone studio            # browser UI at http://localhost:5502
```

`init` writes one model to start from; the rest of this page runs against it:

```lite
model User {
  id        Int      @id
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
  deletedAt DateTime?

  @@softDelete
  @@index([email])
}
```

## Quick start

```js
import { createClient } from '@frontierjs/litestone'

const db = await createClient({ path: './schema.lite', db: './development.db' })

// Create
const user = await db.user.create({
  data: { email: 'alice@example.com', name: 'Alice' }
})

// Read
const users = await db.user.findMany({
  where:   { name: 'Alice' },
  orderBy: { createdAt: 'desc' },
  limit:   20,
})

// Update
await db.user.update({ where: { id: user.id }, data: { name: 'Alice Smith' } })

// Delete (soft if @@softDelete, hard otherwise)
await db.user.remove({ where: { id: user.id } })
```

A database file that is not there yet is created with the schema's tables, so
the quick start also runs against a path `migrate apply` never built. Under
`@@softDelete` the removed row keeps its `@unique` email, so running this twice
against the same file refuses the second create by name — `restore` it, or
`delete({ …, withDeleted: true })`.

## createClient options

```js fragment
const db = await createClient({
  // Schema source — pick one
  path:    './schema.lite',        // path to .lite file
  // parsed: parseResult,          // pre-parsed result (for multi-file schemas)
  // schema: `model t { id Int @id }`, // inline schema string

  db:            './app.db',       // path for MAIN — overrides a declared `database main`
  encryptionKey: process.env.ENC_KEY,  // 64-char hex = 32 bytes (required for @encrypted/@secret)
  computed:      './db/computed.js',   // app-layer computed fields

  plugins: [
    new GatePlugin({ getLevel }),
    FileStorage({ provider: 'r2', ... }),   // from '@frontierjs/litestone/storage'
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

  // Audit trail enrichment
  // `ctx` is the client's, so `ctx.auth` is the principal; where the request
  // came from (ip, userAgent, correlationId) is `logContext`'s, not this
  onLog: (entry, ctx) => ({
    meta: { plan: ctx.auth?.plan },
  }),

  // Open all SQLite databases read-only — writes throw immediately
  // readOnly: true,

  // ms to wait for another PROCESS's write lock before SQLITE_BUSY.
  // Default 5000; `0` fails immediately. `{ default: 5000, audit: 250 }` per
  // database. Or LITESTONE_BUSY_TIMEOUT for a process that builds no client.
  // busyTimeout: 15_000,   // see docs/concurrency.md
})
```

### Where the database file comes from

Four things can decide it, most specific first:

| | |
| --- | --- |
| `databases: ':memory:'` | every SQLite database in the schema, plus a tmpdir for each jsonl/trail one |
| `databases: { name: { path } }` | one named database |
| `db: './app.db'` | **main only** — a second declared database keeps its declared path |
| `database main { path ... }` | the schema's own declaration |

`db` overrides the declaration, so `db: ':memory:'` is the in-memory client to
reach for in a test. Use `databases: ':memory:'` when the schema declares more
than one database and the test should touch no file at all.

### A schema that is data

Schema text the app did not write — a row holding a landing schema, a model a
tenant defined — is built with `untrusted: true`:

```js
const row = { id: 7, schemaText: 'model Note { id Int @id\n body String }' }   // read from a table, say
const landing = await createClient({ schema: row.schemaText, db: `./landing/${row.id}.db`, untrusted: true })
await landing.note.create({ data: { body: 'hello' } })
```

The text is parsed as text (a one-line string ending in `.lite` is never read
from disk) and held to the one `db` given: a `database` block, an `import`,
`tenancy`, a `function`, an `extend`, a claim read off a model, and a model's
`@@auth`, `@@external`, `@@db`, `@@trail` or `@@tenant` are refused by name, all
in one error. Built as an ordinary client, such text could name any file and
write it (`FJS-1633`). Models, views, enums, types, traits, value sets, scopes
and bare `claim`s are what it may hold; it grades with the gates and policies it
declares, under the plugins the app passes.

Every client also prepares each of its views when it is built, so a view whose
`@@sql` names a column or table that is not there fails `createClient` naming
the view, rather than the first read (`FJS-1632`).

## Auth scoping

Every request should use a scoped client so policies and field rules see the current user:

```js
// One scoped client per request — a handler never sees the unscoped one
const forRequest = (user) => db.$setAuth(user)

const alice = await db.user.create({ data: { email: 'alice@example.com' } })
const users = await forRequest(alice).user.findMany()   // policies applied

// System bypass — use sparingly
const sysDb = db.asSystem()   // bypasses @@gate, @@allow/@@deny, @guarded fields
```

## Multi-file schemas

If your schema uses `import` statements, use `parseFile()` so paths resolve correctly:

```js
import { parseFile, createClient } from '@frontierjs/litestone'

const result = parseFile('./schema.lite')
const db     = await createClient({ parsed: result, db: './development.db' })
```

See [schema.md](./schema.md) for the full schema reference.
