# Guide: Audit Trail

Set up a complete audit trail that records every write, captures before/after images, attributes changes to actors, and is queryable through the ORM.

---

## What we're building

- Every write to sensitive models logged automatically
- Before/after images on single-row writes
- Actor attribution (who made the change)
- Custom metadata (request ID, IP address)
- Query API on the audit log
- Retention-based pruning

---

## Schema

```lite
// schema.lite
database audit {
  path      "./audit/"
  driver    trail
  retention 365d    // keep 1 year of audit history
}

model User {
  id        Int @id
  email     String    @unique
  name      String?
  role      String    @default("member")

  @@trail(audit)     // log every create/update/delete

  @@gate(0)
}

model Order {
  id        Int  @id
  userId    Int
  amount    Float
  status    String     @default("pending")
  deletedAt DateTime?

  @@softDelete
  @@trail(audit)

  @@gate(0)
}
```

A `driver trail` database synthesizes its own model, named after the database:
`audit` becomes the model `AuditTrail`, read as `db.auditTrail`.

---

## onLog callback

`onLog` enriches every audit entry with actor and request metadata. Return the fields to merge in:

```js
// lib/db.js
import { createClient } from '@frontierjs/litestone'

export const db = await createClient({
  path:  './schema.lite',
  db:    './app.db',
  onLog: (entry, ctx) => ({ meta: { plan: ctx.auth?.plan } }),
})
```

`actorId` and `actorType` come from the principal without it. `onLog` runs
synchronously inside the write; the entry is appended one tick later.

---

## Passing request context

`ctx` in `onLog` is the client's, so `ctx.auth` is whatever `$setAuth` was given
and there is no `ctx.ip`. Where the write came from is `logContext`'s: a function
the client calls per write, whose answer fills the entry's own columns —
`correlationId`, `source`, `origin`, `ip`, `userAgent`, `tenant`.

```js
// lib/db.js
import { AsyncLocalStorage } from 'node:async_hooks'
export const requestStore = new AsyncLocalStorage()

export const db = await createClient({
  path:       './schema.lite',
  db:         './app.db',
  logContext: () => requestStore.getStore() ?? null,
})

// middleware/db.js
export function dbMiddleware(req, res, next) {
  req.db = db.$setAuth(req.user)
  const from = { correlationId: req.id, ip: req.ip, userAgent: req.headers['user-agent'] }
  requestStore.run(from, next)
}
```

Junction installs a `logContext` itself, so a Junction app writes none.

---

## What gets logged

Every `create`, `update`, and `delete` on `@@trail` models produces an entry.
A single-row write carries the whole row as its image — `after` on a create,
`before` and `after` on an update, `before` on a delete — and a bulk write
(`createMany`, `updateMany`, `deleteMany`) carries the ids alone:

```js
const db = await createClient({
  path:       './schema.lite',
  db:         './app.db',
  logContext: () => ({ correlationId: 'req_abc', ip: '1.2.3.4' }),
})
const me = db.$setAuth({ id: 42 })
await me.user.create({ data: { id: 1, email: 'ada@example.com' } })
await me.user.update({ where: { id: 1 }, data: { role: 'admin' } })

await new Promise(r => setImmediate(r))   // the entry lands one tick later
const [, entry] = await db.asSystem().auditTrail.findMany({ orderBy: { createdAt: 'asc' } })
// {
//   operation:     'update',
//   model:         'User',       // the model name, as a $audit event spells it
//   field:         null,         // model-level entry (not field-level)
//   transition:    null,         // the move's name, where the update was one
//   records:       [1],          // ids of affected rows
//   before:        { id: 1, email: 'ada@example.com', name: null, role: 'member' },
//   after:         { id: 1, email: 'ada@example.com', name: null, role: 'admin' },
//   actorId:       42,
//   actorType:     'user',
//   correlationId: 'req_abc',
//   ip:            '1.2.3.4',
//   meta:          null,
//   createdAt:     '2024-01-15T10:30:00.000Z',
// }
if (entry.operation !== 'update' || entry.actorId !== 42 || entry.correlationId !== 'req_abc') throw new Error(JSON.stringify(entry))
```

A protected field never reaches an image as its value: `@encrypted`,
`@guarded`, `@secret` and `@hashed` log as `'[redacted]'` and `@personal` as
`'[personal]'`.

The trail's `records`, `before`, `after` and `meta` read back as the values
above, not as JSON text:

```js
const db = await createClient({ path: './schema.lite', db: './app.db' })
await db.asSystem().user.create({ data: { id: 1, email: 'ada@example.com' } })
await new Promise(r => setImmediate(r))
const [entry] = await db.asSystem().auditTrail.findMany()
if (!Array.isArray(entry.records)) throw new Error(`records is ${typeof entry.records}: ${entry.records}`)
```

---

## Querying the audit log

```js
const db = await createClient({ path: './schema.lite', db: './app.db' })
const me = db.$setAuth({ id: 42 })
const order = await me.order.create({ data: { id: 5, userId: 42, amount: 9.5 } })
await me.order.update({ where: { id: order.id }, data: { status: 'paid' } })
await me.order.remove({ where: { id: order.id } })
await new Promise(r => setImmediate(r))

const trail = db.asSystem().auditTrail

// All writes to orders in the last 24 hours
const recent = await trail.findMany({
  where: {
    model:     'Order',
    createdAt: { gte: new Date(Date.now() - 86400000).toISOString() },
  },
  orderBy: { createdAt: 'desc' },
  limit:   100,
})
// → [{ operation: 'update', model: 'Order', records: [5], ... }, ...]

// All changes by a specific actor
const actorHistory = await trail.findMany({
  where:   { actorId: 42 },
  orderBy: { createdAt: 'desc' },
})

// How many deletes
const deletes = await trail.count({ where: { operation: 'delete' } })

if (recent.length !== 3 || actorHistory.length !== 3 || deletes !== 1) throw new Error(`${recent.length} ${actorHistory.length} ${deletes}`)
```

A soft delete (`remove()`) is logged as a `delete`, with the row as its
`before` image, exactly as a hard `delete()` is.

The trail model answers `findMany`, `findFirst`, `findUnique`, `count` and
`findManyCursor`; it has no `aggregate` or `groupBy`, so a per-day count is
the application's loop over a windowed `findMany`.

**A `$raw` predicate on the trail is refused by name**: a `where` on a
`driver trail` or `driver jsonl` model answers the scalar operators only, and
`$raw` is SQL over a column. The full history of one record is therefore not a
`json_extract` over `records`:

```js throws
import { sql } from '@frontierjs/litestone'

const db = await createClient({ path: './schema.lite', db: './app.db' })
const sys = db.asSystem()
await sys.order.create({ data: { id: 5, userId: 1, amount: 1 } })
await sys.order.create({ data: { id: 6, userId: 1, amount: 1 } })
await new Promise(r => setImmediate(r))

await sys.auditTrail.findMany({
  where:   { model: 'Order', $raw: sql`json_extract(records, '$[0]') = ${5}` },
  orderBy: { createdAt: 'asc' },
})
```

---

## Field-level logging

Log reads and writes of a specific field, not the whole model:

```lite
database audit {
  path   "./audit/"
  driver trail
}

model User {
  id     Int    @id
  email  String @unique
  salary Float? @trail(audit)    // log every read and write of salary
}
```

Produces entries with `field: 'salary'` — a `read` entry for every read that
selects the column, by any caller, and a write entry whose `after` is the new
value. `@trail(audit, reads: false)` logs writes only and
`@trail(audit, writes: false)` reads only. Combined with `@@trail` on the
model, you get both model-level and field-level granularity.

---

## @secret — automatic logging

`@secret` fields are logged automatically — no `@@trail` needed:

```lite
database audit {
  path   "./audit/"
  driver trail
}

model User {
  id     Int     @id
  apiKey String? @secret    // @encrypted + @guarded + @trail(audit, reads: false)
}
```

`@secret` expands to `@encrypted @guarded` plus a `@trail` on the schema's
first trail database, writes only: every write produces a field-level entry
whose value is `'[redacted]'`. Reads are not logged unless the field declares
`@trail(audit, reads: true)` itself.

---

## Retention

The `retention` config on the trail database prunes old entries on startup:

```lite
database audit {
  path      "./audit/"
  driver    trail
  retention 365d
}
```

Accepts `30d`, `90d`, `365d`, `24h`, `2w`, `1mo`, `1y`. Pruning is synchronous and runs once at `createClient` time.
