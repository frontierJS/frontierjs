# Guide: Audit Trail

Set up a complete audit trail that records every write, captures before/after snapshots, attributes changes to actors, and is queryable through the ORM.

---

## What we're building

- Every write to sensitive models logged automatically
- Before/after snapshots on single-row updates
- Actor attribution (who made the change)
- Custom metadata (request ID, IP address)
- Full query API on the audit log
- Retention-based pruning

---

## Schema

```prisma
// schema.lite
database audit {
  path      "./audit/"
  driver    logger
  retention 365d    // keep 1 year of audit history
}

model User {
  id        Integer @id
  email     Text    @unique
  name      Text?
  role      Text    @default("member")
  apiKey    Text?   @secret           // @encrypted + @guarded(all) + auto-logged to audit

  @@log(audit)     // log every create/update/delete
}

model Order {
  id        Integer  @id
  userId    Integer
  amount    Real
  status    Text     @default("pending")
  deletedAt DateTime?

  @@softDelete
  @@log(audit)
}
```

---

## onLog callback

`onLog` enriches every audit entry with actor and request metadata. Return the fields to merge in:

```js
// lib/db.js
import { createClient } from '@frontierjs/litestone'

export const db = await createClient({
  path:  './schema.lite',
  onLog: (entry, ctx) => ({
    actorId:   ctx.auth?.id     ?? null,
    actorType: ctx.auth?.type   ?? 'system',
    meta: {
      requestId: ctx.requestId,
      ip:        ctx.ip,
      userAgent: ctx.userAgent,
    },
  }),
})
```

`onLog` fires asynchronously via `setImmediate` — never blocks the write.

---

## Passing request context

The `ctx` object in `onLog` comes from `$setAuth`. You can attach extra fields:

```js
// middleware/db.js
export function dbMiddleware(req, res, next) {
  req.db = db.$setAuth({
    ...req.user,
    requestId: req.id,
    ip:        req.ip,
    userAgent: req.headers['user-agent'],
  })
  next()
}
```

---

## What gets logged

Every `create`, `update`, and `delete` on `@@log` models produces an entry:

```js
// After: db.user.update({ where: { id: 1 }, data: { role: 'admin' } })
{
  operation:  'update',
  model:      'users',
  field:      null,           // model-level entry (not field-level)
  records:    [1],            // IDs of affected rows
  before:     { role: 'member' },
  after:      { role: 'admin' },
  actorId:    42,
  actorType:  'user',
  meta:       { requestId: 'req_abc', ip: '1.2.3.4' },
  createdAt:  '2024-01-15T10:30:00.000Z',
}
```

`before`/`after` are included for single-row `update()` calls only. `updateMany()` and `createMany()` log `{ records: [ids...] }` without snapshots.

---

## Querying the audit log

```js
// All writes to orders in the last 24 hours
const recent = await db.asSystem().auditLogs.findMany({
  where: {
    model:     'orders',
    createdAt: { gte: new Date(Date.now() - 86400000).toISOString() },
  },
  orderBy: { createdAt: 'desc' },
  limit:   100,
})
// → [{ operation: 'update', model: 'orders', records: [5], ... }]

// All changes by a specific actor
const actorHistory = await db.asSystem().auditLogs.findMany({
  where:   { actorId: 42 },
  orderBy: { createdAt: 'desc' },
})

// Full history for a specific record
const sql = await import('@frontierjs/litestone').then(m => m.sql)
const recordHistory = await db.asSystem().auditLogs.findMany({
  where: {
    model: 'orders',
    $raw:  sql`json_extract(records, '$[0]') = ${orderId}`,
  },
  orderBy: { createdAt: 'asc' },
})
// → [{ operation: 'create', ... }, { operation: 'update', before: {...}, after: {...} }, ...]

// Count deletes per day (audit analytics)
const deletesPerDay = await db.asSystem().auditLogs.groupBy({
  by:       ['createdAt'],
  interval: { createdAt: 'day' },
  where:    { operation: 'delete' },
  _count:   true,
})
// → [{ createdAt: '2024-01-15', _count: 3 }, ...]
```

---

## Field-level logging

Log reads/writes of a specific field, not the whole model:

```prisma
model User {
  salary Real? @log(audit)    // log every read and write of salary
}
```

Produces entries with `field: 'salary'` for reads (via `asSystem()`) and writes. Combined with `@@log` on the model, you get both model-level and field-level granularity.

---

## @secret — automatic logging

`@secret` fields are logged automatically — no `@@log` needed:

```prisma
model User {
  apiKey Text? @secret    // @encrypted + @guarded(all) + auto-logged
}
```

Every access (read via `asSystem()`) and every write produces an audit entry.

---

## Retention

The `retention` config on the logger database prunes old entries on startup:

```prisma
database audit {
  path      "./audit/"
  driver    logger
  retention 365d
}
```

Accepts: `30d`, `90d`, `365d`, `24h`, `2w`, `1y`. Pruning is synchronous and runs once at `createClient` time.
