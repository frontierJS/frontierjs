# Querying

## Read operations

```js
// Return all matching rows
db.user.findMany({ where, orderBy, limit, offset, include, select })

// Soft-delete options (@@softDelete models)
db.user.findMany({ withDeleted: true })    // include soft-deleted rows
db.user.findMany({ onlyDeleted: true })    // only soft-deleted rows

// SELECT DISTINCT
db.user.findMany({ select: { role: true }, distinct: true })

// Return first match or null
const user = await db.user.findFirst({ where: { role: 'admin' }, orderBy: { createdAt: 'desc' } })
// → { id: 7, email: 'alice@example.com', role: 'admin', ... } | null

// Return by unique field or null
const alice = await db.user.findUnique({ where: { email: 'alice@example.com' } })
// → { id: 1, email: 'alice@example.com', ... } | null

// Throw if not found
db.user.findFirstOrThrow({ where })   // throws { code: 'NOT_FOUND', model: 'users' }
db.user.findUniqueOrThrow({ where })

// Count
const n = await db.user.count({ where: { role: 'admin' } })
// → 3

// Boolean existence check — SELECT 1 LIMIT 1, faster than count > 0
const exists = await db.user.exists({ where: { email: 'alice@example.com' } })
// → true | false

// Pagination with total — single query
const { rows, total } = await db.user.findManyAndCount({
  where:  { role: 'member' },
  limit:  20,
  offset: 40,
})
// → { rows: [...20 users...], total: 142 }
```

## Include (relations)

```js
// Eager load related rows
const posts = await db.post.findMany({
  include: { author: true, tags: true }
})
// posts[0].author → { id, name, email, ... }
// posts[0].tags   → [{ id, label }, ...]

// Nested include
const users = await db.user.findMany({
  include: { account: { include: { plan: true } } }
})

// Count relations without fetching
const posts = await db.post.findMany({
  include: { _count: true }   // adds _count: { comments: 3, tags: 1 }
})

// Filtered relation count
const posts = await db.post.findMany({
  include: {
    _count: { select: { comments: { where: { approved: true } } } }
  }
})
```

## Select (column projection)

```js
// Only return specific fields
const users = await db.user.findMany({
  select: { id: true, email: true, name: true }
})

// Include relations in select
const posts = await db.post.findMany({
  select: { title: true, author: true }
})

// Skip RETURNING — fastest write path (no row returned)
await db.order.update({ where: { id: 1 }, data: { status: 'paid' }, select: false })
await db.order.create({ data: { amount: 100 }, select: false })
```

## Cursor pagination

O(log n) pagination — uses an index comparison instead of `OFFSET`. Suitable for infinite scroll, large datasets:

```js
const page1 = await db.post.findManyCursor({
  limit:   50,
  orderBy: { createdAt: 'desc' },
})
// → { rows: [...], nextCursor: 'eyJ...', hasMore: true }

const page2 = await db.post.findManyCursor({
  limit:   50,
  orderBy: { createdAt: 'desc' },
  cursor:  page1.nextCursor,
})
```

The cursor encodes all `orderBy` field values from the last row. Multi-field ordering is supported:

```js
db.post.findManyCursor({
  orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
  limit:   25,
})
```

## Full-text search

Requires `@@fts` on the model:

```js
const results = await db.post.search('sqlite full text', {
  where:     { status: 'published' },
  limit:     10,
  highlight: { fields: ['title', 'body'], tags: ['<b>', '</b>'] },
  snippet:   { fields: ['body'], length: 64 },
})
// results[0] has: title, body, _highlight: { title: '...', body: '...' }, _snippet: { body: '...' }
```

Use `db.post.optimizeFts()` periodically to merge FTS5 index segments for better read performance.

## Unified dispatcher

`query()` routes a single args object to `findMany`, `groupBy`, or `aggregate` based on its shape — useful for API layers:

```js
app.get('/orders', async (req) => {
  return db.order.query(req.query)
})

db.order.query({ where: { status: 'paid' }, limit: 20 })     // → findMany
db.order.query({ _count: true, _sum: { amount: true } })      // → aggregate
db.order.query({ by: ['status'], _count: true })              // → groupBy
```

Routing: `by` present → `groupBy`; `_count/_sum/_avg/_min/_max/_stringAgg` or named agg → `aggregate`; everything else → `findMany`.

See [aggregation.md](./aggregation.md) for the full aggregate/groupBy API.

## Multi-model batch — `db.query(spec)`

`db.query(spec)` runs many per-model queries in one snapshot transaction and returns a named-result object. Each spec entry routes through the per-model `query()` dispatcher above, so the same shape rules apply per entry.

```js
const { user, order, revenue } = await db.query({
  user:    { where: { status: 'active' }, limit: 10 },          // → findMany
  order:   { where: { status: 'open' }, orderBy: { createdAt: 'desc' } },
  revenue: { model: 'order', _count: true, _sum: { amount: true } },  // → aggregate
})
```

The keys of the result object match the keys of the spec, in spec order.

### Spec keys

A spec key is either:

- **A model accessor name** (e.g. `user`, `serviceAgreement`) — runs `db.<key>.query(args)`
- **Any name** plus an explicit `model: '<accessor>'` field on the value — runs `db.<args.model>.query(rest)`. Use this when you want to query the same model multiple times with different args:

```js
const { paid, pending, refunded } = await db.query({
  paid:     { model: 'order', where: { status: 'paid' } },
  pending:  { model: 'order', where: { status: 'pending' } },
  refunded: { model: 'order', where: { status: 'refunded' } },
})
```

### Snapshot consistency

All entries run inside a single `$transaction`, so reads observe the same point-in-time. A row appearing in `user` will agree with related rows fetched in `order`, even if a writer commits between the start and end of the batch.

### Failure semantics

The whole batch fails if any single query throws — the transaction rolls back and `db.query()` rejects with the original error. This is the right default for "load the data for this page" use cases where partial results would be misleading.

If you want per-entry tolerance, call `db.<model>.query()` per model and use `Promise.allSettled` yourself.

### Auth scoping composes

`$setAuth()` and `asSystem()` both produce their own multi-model `query()`. Each batched query inherits the proxy's auth context — so policies, guarded fields, and gate levels all apply per-entry as you'd expect:

```js
const userDb = db.$setAuth(req.user)
const data = await userDb.query({
  posts:    { where: { published: true } },   // policies enforced for req.user
  comments: { orderBy: { createdAt: 'desc' } },
})

// Bypass policies for trusted server work
const sysData = await db.asSystem().query({
  jobs:     { where: { status: 'pending' } },
  alerts:   { _count: true },
})
```

### As an HTTP endpoint

The spec is JSON-shaped (no method calls, no promises, just args), so the simplest possible read API is a single endpoint:

```js
app.post('/query', async (req, res) => {
  const data = await db.$setAuth(req.user).query(req.body)
  res.json(data)
})
```

The frontend posts a query spec, the backend executes it under the user's auth context, returns named results. Policies, validators, and guarded fields are all enforced per-model. No tRPC, no GraphQL, no per-page endpoint.

For untrusted input you'll likely want to validate the spec shape and bound `limit`/`offset` before dispatch — see the security note in [access-control.md](./access-control.md).

## Scopes

Scopes are named, reusable query fragments registered per model. They're plain data — an object shaped like findMany args, optionally with a function as the `where` for dynamic filters that depend on auth context.

```js
// api/src/models/customer.model.js
export const active = {
  where: { status: 'active' },
}

export const premium = {
  where: { tier: 'premium' },
}

// Dynamic where — receives ctx at call time
export const mine = {
  where: (ctx) => ({ ownerId: ctx.auth?.id }),
}
```

Register at `createClient`:

```js
import * as CustomerScopes from './models/customer.model.js'

const db = await createClient({
  schema: './schema.lite',
  scopes: {
    Customer: CustomerScopes,
  },
})
```

### Calling scopes

Each scope appears as a callable function-with-properties on the table accessor.

```js
// Default call → findMany
await db.customer.active()

// Caller args layered on top
await db.customer.active({ limit: 10, orderBy: { name: 'asc' } })

// All read methods work under the scope
await db.customer.active.count()
await db.customer.active.findFirst()
await db.customer.active.aggregate({ _count: true, _sum: { revenue: true } })
await db.customer.active.groupBy({ by: ['tier'], _count: true })
await db.customer.active.query({ ...args })           // routes by shape

// Search composes — scope where AND'd with FTS query
await db.customer.active.search('alice')
```

### Chaining

Scopes chain. Each step appends to the scope stack and returns a new scoped accessor.

```js
await db.customer.active.premium()                       // both filters apply
await db.customer.active.premium.recent.findMany()       // three scopes deep
```

### Merge rules

When scope args and caller args combine:

| Key | Rule |
|---|---|
| `where` | All scope wheres + caller where AND-merged |
| `orderBy` | Last scope wins; caller overrides all |
| `limit`, `offset` | Last scope wins; caller overrides all |
| `include`, `select` | Last scope wins; caller overrides all |
| `distinct`, `withDeleted`, `onlyDeleted` | Last scope wins; caller overrides all |

`where` is always AND'd — you cannot override a scope's where by passing your own.

### Dynamic where + auth scoping

If `where` is a function, it's called with the current `ctx` at query time. Combined with `$setAuth()`, this gives you per-request scoping for free:

```js
const userDb = db.$setAuth(req.user)
await userDb.customer.mine()              // where evaluated with req.user as ctx.auth
await userDb.customer.mine.premium()      // chains correctly
```

Each call re-resolves the dynamic `where`, so passing the same scope accessor to multiple users (e.g. across requests) is safe.

### Soft-delete

Soft-delete filtering still applies under scopes — only live rows are returned by default. To include deleted rows, pass `withDeleted: true` as a caller arg or in the scope itself.

```js
const archived = { where: { deletedAt: { not: null } }, withDeleted: true }
```

### Conflict guard

`createClient` validates scope names at startup and throws if any of these collide:

- A built-in table method (`findMany`, `create`, `update`, etc.)
- A relation field on the same model
- A name starting with `$` or `_`

```
ScopeError: "Customer.create" conflicts with a built-in table method.
```

### Scopes are not policies

Scopes are *opt-in* convenience — you have to call them. Policies (`@@allow` / `@@deny`) are *enforced* — they apply to every query whether you remember them or not. If a `where` clause must apply for security reasons, write it as a policy. Use scopes for the everyday "show me active customers" patterns where forgetting them is a bug, not a vulnerability.

### Parameterised scopes

Not supported. Write a function that returns a `where` clause and pass it as a caller override:

```js
const olderThan = (days) => ({
  createdAt: { lt: new Date(Date.now() - days * 86400000) },
})

await db.customer.active({ where: olderThan(30) })
```

This keeps the scope registry to a single mental model: scopes are static, parameters are caller args.

### TypeScript

Scope names are runtime-registered, so the default types don't know about them. The standard workaround is module augmentation:

```ts
declare module '@frontierjs/litestone' {
  interface CustomerScopes {
    active: () => unknown
    premium: () => unknown
    mine: () => unknown
  }
}
```

Full type inference for scope return types and chained-method propagation is on the roadmap.

## Transactions

```js
const result = await db.$transaction(async (tx) => {
  const account = await tx.account.create({ data: { name: 'Acme' } })
  const user    = await tx.user.create({ data: {
    accountId: account.id,
    email:     'alice@acme.com',
  }})
  return { account, user }
})
```

Transactions use `BEGIN IMMEDIATE` — no mid-transaction write-lock deadlocks. Throws on any error and automatically rolls back.

## Write operations

```js
// Create — returns the inserted row
const user = await db.user.create({ data: { email: 'a@b.com', accountId: 1 } })
// → { id: 1, email: 'a@b.com', accountId: 1, role: 'member', createdAt: '...', ... }

// Create many — returns { count }
await db.user.createMany({ data: [{ email: 'a@b.com' }, { email: 'b@b.com' }] })
// → { count: 2 }

// Update — returns updated row or null (null if no match or policy blocked)
const updated = await db.user.update({ where: { id: 1 }, data: { name: 'Alice' } })
// → { id: 1, name: 'Alice', ... } | null

// Update many — returns { count }
await db.user.updateMany({ where: { role: 'viewer' }, data: { role: 'member' } })
// → { count: 14 }

// Upsert — create if not exists, update if exists
const post = await db.post.upsert({
  where:  { slug: 'hello-world' },
  create: { slug: 'hello-world', title: 'Hello World', authorId: 1 },
  update: { title: 'Hello World Updated' },
})
// → { id: 5, slug: 'hello-world', title: 'Hello World Updated', ... }

// Upsert many — bulk, one SQL statement
await db.product.upsertMany({
  data:           [{ sku: 'abc', price: 9.99 }, { sku: 'def', price: 14.99 }],
  conflictTarget: ['sku'],
  update:         ['price'],   // only update these on conflict
})
// → { count: 2 }

// Remove (soft delete if @@softDelete, else hard delete)
await db.user.remove({ where: { id: 1 } })
// → { id: 1, deletedAt: '2024-01-15T...', ... }

// Remove many
await db.user.removeMany({ where: { accountId: 5 } })
// → { count: 7 }

// Restore soft-deleted rows
await db.user.restore({ where: { id: 1 } })
// → [{ id: 1, deletedAt: null, ... }]

// Hard delete (always, even on @@softDelete models)
await db.user.delete({ where: { id: 1 } })
// → { id: 1, ... }

// Hard delete many
await db.user.deleteMany({ where: { accountId: 5 } })
// → { count: 3 }
```

Bulk ops (`createMany`, `updateMany`, `upsertMany`, `removeMany`, `deleteMany`) return `{ count }` only — no row data. This is intentional: `RETURNING *` on thousands of rows negates the performance reason for bulk ops. Use `$transaction` + single-row ops when you need the modified rows.
