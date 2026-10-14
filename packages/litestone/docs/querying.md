# Querying

The examples on this page use this schema:

```lite
model Account {
  id       Int     @id
  name     String
  settings Json?
  planId   Int?
  plan     Plan?   @relation(fields: [planId], references: [id])
  users    User[]
}

model Plan {
  id       Int       @id
  name     String
  accounts Account[]
}

model User {
  id        Int       @id
  email     String    @unique
  name      String?
  role      String    @default("member")
  status    String    @default("active")
  accountId Int?
  account   Account?  @relation(fields: [accountId], references: [id])
  posts     Post[]
  createdAt DateTime  @default(now())
  deletedAt DateTime?

  @@softDelete
}

model Post {
  id        Int       @id
  slug      String    @unique
  title     String
  body      String?
  status    String    @default("draft")
  views     Int       @default(0)
  rating    Float     @default(1)
  labels    String[]
  authorId  Int
  author    User      @relation(fields: [authorId], references: [id])
  tags      Tag[]
  comments  Comment[]
  createdAt DateTime  @default(now())

  @@fts([title, body])
  @@label(title)
}

model Tag {
  id    Int    @id
  label String
  posts Post[]
}

model Comment {
  id       Int     @id
  body     String
  approved Boolean @default(false)
  postId   Int
  post     Post    @relation(fields: [postId], references: [id])
}

model Order {
  id        Int      @id
  status    String   @default("pending")
  amount    Float
  createdAt DateTime @default(now())
}

model Product {
  id    Int    @id
  sku   String @unique
  price Float
}

model Customer {
  id        Int      @id
  name      String
  status    String   @default("active")
  tier      String   @default("basic")
  revenue   Float    @default(0)
  ownerId   Int?
  createdAt DateTime @default(now())

  @@fts([name])
  @@label(name)
}

model Contact {
  id      Int     @id
  name    String
  type    String  @default("lead")
  ownerId Int?
  shared  Boolean @default(false)
}

type Commute {
  source  String
  minutes Int
}

type Prefs {
  theme   String?
  commute Json? @type(Commute)
}

model Trip {
  id    Int  @id
  prefs Json @type(Prefs) @default("{}")
}
```

## Read operations

```js
const where   = { role: 'admin' }
const orderBy = { createdAt: 'desc' }

// Return all matching rows
await db.user.findMany({ where, orderBy, limit: 20, offset: 0, include: { account: true } })

// Soft-delete options (@@softDelete models)
await db.user.findMany({ withDeleted: true })    // include soft-deleted rows
await db.user.findMany({ onlyDeleted: true })    // only soft-deleted rows

// SELECT DISTINCT — a boolean, and it dedupes the whole PROJECTED row, so it is
// paired with `select`. SQLite has no DISTINCT ON: a column list is refused by
// name, and one whole row per value is `groupBy`, which also says which row.
await db.user.findMany({ select: { role: true }, distinct: true })

// Return first match or null
const user = await db.user.findFirst({ where: { role: 'admin' }, orderBy: { createdAt: 'desc' } })
// → { id: 7, email: 'alice@example.com', role: 'admin', ... } | null

// Return by unique field or null
const alice = await db.user.findUnique({ where: { email: 'alice@example.com' } })
// → { id: 1, email: 'alice@example.com', ... } | null

// Throw if not found
await db.user.findFirstOrThrow({ where }).catch(e => e.code)    // 'NOT_FOUND', with e.model = 'user'
await db.user.findUniqueOrThrow({ where: { email: 'nobody@example.com' } }).catch(e => e.code)

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
const counted = await db.post.findMany({
  include: { _count: true }   // adds _count: { comments: 3, tags: 1 }
})

// Filtered relation count
const approved = await db.post.findMany({
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
await db.order.create({ data: { amount: 100 }, select: false })
await db.order.update({ where: { id: 1 }, data: { status: 'paid' }, select: false })
```

An object is the only spelling, and `false` on a write is the one exception.
Anything else is refused by name — a list projects no columns and would answer
`{}` with no error, and the list is the WIRE form (`$select=id,title`), which
the API boundary converts before a read.

```js throws
await db.user.findMany({ select: ['id', 'email'] })
// Refused: 'select' on User.findMany must be an object naming columns — got an array
```

```js throws
await db.user.findFirst({ select: false })
// Refused: 'select' on User.findFirst must be an object naming columns — got boolean
```

## Cursor pagination

O(log n) pagination — uses an index comparison instead of `OFFSET`. Suitable for infinite scroll, large datasets:

```js
const page1 = await db.post.findManyCursor({
  limit:   50,
  orderBy: { createdAt: 'desc' },
})
// → { items: [...], nextCursor: 'eyJ...' | null, hasMore: true }

const page2 = await db.post.findManyCursor({
  limit:   50,
  orderBy: { createdAt: 'desc' },
  cursor:  page1.nextCursor,
})
```

The cursor encodes all `orderBy` field values from the last row, and `nextCursor` is `null` on the last page. Multi-field ordering is supported:

```js
await db.post.findManyCursor({
  orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
  limit:   25,
})
```

## Full-text search

Requires `@@fts` on the model. `highlight` and `snippet` each name ONE indexed
field and come back as `_highlight` and `_snippet` strings on the row, beside
`_rank`:

```js
const results = await db.post.search('sqlite full text', {
  where:     { status: 'published' },
  limit:     10,
  highlight: { field: 'title', open: '<b>', close: '</b>' },
  snippet:   { field: 'body', length: 16 },    // length is in tokens; default 15
})
// results[0] → { id, title, body, ..., _rank: -1.2, _highlight: '<b>SQLite</b> …', _snippet: '… <mark>full</mark> …' }
```

The tags default to `<mark>` / `</mark>`, and a snippet's gap marker is `ellipsis` (default `…`).

Use `db.post.optimizeFts()` periodically to merge FTS5 index segments for better read performance.

## Unified dispatcher

`query()` routes a single args object to `findMany`, `groupBy`, or `aggregate` based on its shape — useful for an API handler that hands `req.query` straight through:

```js
await db.order.query({ where: { status: 'paid' }, limit: 20 })     // → findMany
await db.order.query({ _count: true, _sum: { amount: true } })      // → aggregate
await db.order.query({ by: ['status'], _count: true })              // → groupBy
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

- **A model accessor name** (e.g. `user`, `serviceAgreement`) — runs `db.<key>.query(args)`. A plural (`users`) is not an accessor and is refused by name.
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
const req    = { user: { id: 1, accountId: 1 } }
const userDb = db.$setAuth(req.user)
const data = await userDb.query({
  post:    { where: { status: 'published' } },   // policies enforced for req.user
  comment: { orderBy: { id: 'desc' } },
})

// Bypass policies for trusted server work
const sysData = await db.asSystem().query({
  order:   { where: { status: 'pending' } },
  comment: { _count: true },
})
```

### As an HTTP endpoint

The spec is JSON-shaped (no method calls, no promises, just args), so the simplest possible read API is a single endpoint — a handler that takes the signed-in user and the posted body:

```js
const handleQuery = (user, body) => db.$setAuth(user).query(body)

const data = await handleQuery({ id: 1 }, { post: { where: { status: 'published' }, limit: 20 } })
```

The frontend posts a query spec, the backend executes it under the user's auth context, returns named results. Policies, validators, and guarded fields are all enforced per-model. No tRPC, no GraphQL, no per-page endpoint.

For untrusted input you'll likely want to validate the spec shape and bound `limit`/`offset` before dispatch — see the security note in [access-control.md](./access-control.md).

## Scopes

Scopes are named, reusable query fragments registered per model. They're plain data — an object shaped like findMany args, optionally with a function as the `where` for dynamic filters that depend on auth context. They are registered at `createClient`, keyed by MODEL name:

```js
const CustomerScopes = {
  active:  { where: { status: 'active' } },
  premium: { where: { tier: 'premium' } },
  recent:  { where: { createdAt: { gte: '2020-01-01' } } },

  // Dynamic where — receives ctx at call time
  mine:    { where: (ctx) => ({ ownerId: ctx.auth?.id }) },
}

const db = await createClient({
  path:   './schema.lite',
  db:     ':memory:',
  scopes: { Customer: CustomerScopes },
})
```

A module that exports each scope works the same way — `import * as CustomerScopes from './models/customer.model.js'`.

### Calling scopes

Each scope appears as a callable function-with-properties on the table accessor.

```js
const db = await createClient({ path: './schema.lite', db: ':memory:', scopes: { Customer: {
  active:  { where: { status: 'active' } },
  premium: { where: { tier: 'premium' } },
  recent:  { where: { createdAt: { gte: '2020-01-01' } } },
} } })

// Default call → findMany
await db.customer.active()

// Caller args layered on top
await db.customer.active({ limit: 10, orderBy: { name: 'asc' } })

// All read methods work under the scope
await db.customer.active.count()
await db.customer.active.findFirst()
await db.customer.active.aggregate({ _count: true, _sum: { revenue: true } })
await db.customer.active.groupBy({ by: ['tier'], _count: true })
await db.customer.active.query({ limit: 5 })                  // routes by shape

// Search composes — scope where AND'd with FTS query
await db.customer.active.search('alice')

// Scopes chain: each step appends to the scope stack and returns a new scoped accessor
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

### Writes

Scopes apply to writes too, so a scope behaves like a filtered *view* you can also write through — ideal for a `type`-column model (`Contact` with `lead`/`client`/`vendor`).

**create / createMany** stamp the scope as a data default. For a flat-equality `where` like `{ type: 'lead' }`, the equalities become the create default, so `db.contact.leads.create({ data: { name } })` inserts `type: 'lead'` for free. Caller data always wins.

```js
const ContactScopes = {
  leads:   { where: { type: 'lead' } },
  clients: { where: { type: 'client' } },
}
const db = await createClient({ path: './schema.lite', db: ':memory:', scopes: { Contact: ContactScopes } })

await db.contact.leads.create({ data: { name: 'Acme' } })               // → type: 'lead'
await db.contact.leads.create({ data: { name: 'X', type: 'vendor' } })  // caller wins → 'vendor'
await db.contact.clients.createMany({ data: [{ name: 'A' }, { name: 'B' }] })  // both 'client'
```

Only flat equalities are inferred — operators (`gte`, `in`, …), `AND`/`OR`/`NOT`, and complex wheres stamp nothing. To filter *without* stamping, give the scope an explicit empty `data: {}`; to stamp more (or differently) than the filter, give it an explicit `data`.

```js
const cutoff    = new Date(Date.now() - 30 * 86400000)
const recent    = { where: { createdAt: { gte: cutoff } } }              // filters, stamps nothing (operator)
const draftOnly = { where: { status: 'draft' }, data: {} }               // filters, stamps nothing (explicit)
const owned     = { where: { ownerId: 5 }, data: { ownerId: 5, shared: false } }  // stamp more than the filter
```

Dynamic wheres stamp too, which pairs naturally with auth — "create a record owned by me":

```js
const mine = { where: (ctx) => ({ ownerId: ctx.auth?.id }) }
const db   = await createClient({ path: './schema.lite', db: ':memory:', scopes: { Contact: { mine } } })
const user = { id: 9 }

await db.$setAuth(user).contact.mine.create({ data: { name: 'Acme' } })  // ownerId = 9
```

**update / updateMany / delete / deleteMany / remove / restore** AND-merge the scope `where`, so a write can only touch rows *inside* the subset — updating a client through the leads scope is a no-op:

```js
const db = await createClient({ path: './schema.lite', db: ':memory:', scopes: { Contact: { leads: { where: { type: 'lead' } } } } })
const aClient = await db.contact.create({ data: { name: 'Globex', type: 'client' } })

await db.contact.leads.update({ where: { id: aClient.id }, data: { name: 'Nope' } })  // matches nothing → null
```

**upsert / upsertMany** stamp the create branch's data default (the conflict-target `where` is left untouched so conflict detection still works). The base accessor `db.contact.*` is always unscoped — scoped writes only happen through a scope name.

### Dynamic where + auth scoping

If `where` is a function, it's called with the current `ctx` at query time. Combined with `$setAuth()`, this gives you per-request scoping for free:

```js
const db = await createClient({ path: './schema.lite', db: ':memory:', scopes: { Customer: {
  mine:    { where: (ctx) => ({ ownerId: ctx.auth?.id }) },
  premium: { where: { tier: 'premium' } },
} } })
const req = { user: { id: 7 } }

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

```js throws
await createClient({ path: './schema.lite', db: ':memory:', scopes: { Customer: { create: { where: {} } } } })
// Error: scopes: "Customer.create" conflicts with a built-in table method. Pick another name.
```

### Scopes are not policies

Scopes are *opt-in* convenience — you have to call them. Policies (`@@allow` / `@@deny`) are *enforced* — they apply to every query whether you remember them or not. If a `where` clause must apply for security reasons, write it as a policy. Use scopes for the everyday "show me active customers" patterns where forgetting them is a bug, not a vulnerability.

### Parameterized scopes

Not supported. Write a function that returns a `where` clause and pass it as a caller override:

```js
const db = await createClient({ path: './schema.lite', db: ':memory:', scopes: { Customer: { active: { where: { status: 'active' } } } } })

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
await db.account.create({ data: { id: 1, name: 'Acme' } })

// Create — returns the inserted row
const user = await db.user.create({ data: { email: 'a@b.com', accountId: 1 } })
// → { id: 1, email: 'a@b.com', accountId: 1, role: 'member', createdAt: '...', ... }

// Create many — returns { count }
await db.user.createMany({ data: [{ email: 'b@b.com' }, { email: 'c@b.com' }] })
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
await db.user.remove({ where: { id: 2 } })
// → { id: 2, deletedAt: '2024-01-15T...', ... }

// Remove many
await db.user.removeMany({ where: { accountId: 5 } })
// → { count: 7 }

// Restore soft-deleted rows
await db.user.restore({ where: { id: 2 } })
// → [{ id: 2, deletedAt: null, ... }]

// Hard delete (always, even on @@softDelete models)
await db.user.delete({ where: { id: 2 } })
// → { id: 2, ... }

// Hard delete many
await db.user.deleteMany({ where: { accountId: 5 } })
// → { count: 3 }
```

### Atomic update operators

A counter written as read-modify-write loses one of two concurrent increments,
and `@version` only turns that into a thrown conflict the caller has to retry.
These compile to one statement that needs no read and cannot race:

```js
await db.user.create({ data: { id: 1, email: 'a@b.com' } })
await db.post.create({ data: { id: 1, slug: 'p', title: 'P', authorId: 1 } })

await db.post.update({ where: { id: 1 }, data: {
  views:  { increment: 1 },     // "views" = "views" + ?
  rating: { multiply: 1.1 },    // decrement and divide too
  labels: { push: 'featured' }, // json_insert at the end; push: ['a','b'] for several
} })
// → { ..., views: 1, rating: 1.1, labels: ['featured'] }
```

| Operator | Column it needs |
| --- | --- |
| `increment` `decrement` `multiply` `divide` | `Int` `Float` `BigInt` `Decimal` |
| `push` | any array column — `String[]`, `Int[]`, an enum array |
| `$merge` | any `Json` column — see below |

**The declared type decides.** `{ addr: { city: 'x' } }` on a `Json @type(Addr)`
column is still a value, because that column can carry an object; the same shape
on a numeric column is an operator. Anything that is neither is refused by name
rather than guessed at, including:

- an operator on a column whose type cannot carry it
- an operator on `create`, `createMany`, `upsert` or `upsertMany` — there is no
  value to change, and upsert's two paths could not agree about one
- `divide: 0`, which SQLite answers as `NULL` with no error
- two operators on one column, or an operator mixed with anything else
- an enum array pushed a member the enum does not declare
- **a column carrying `@lt` `@lte` `@gt` `@gte` `@maxItems` `@uniqueItems`** —
  the new value is computed inside SQLite where no validator can see it, and a
  validator that quietly stops applying is worse than one that says it cannot.
  Read the row, change it and write it back; that path validates.

#### `$merge` — changing one key of a document

```js
const { id } = await db.account.create({ data: { name: 'Acme', settings: { theme: 'dark' } } })

await db.account.update({ where: { id }, data: {
  settings: { $merge: { commute: { source: 'bus' } } },   // json_patch(settings, ?)
} })
// → settings: { theme: 'dark', commute: { source: 'bus' } }
```

**It wears a `$` and the others do not.** The rule above — *the declared type
decides* — is what makes a bare `increment` safe, because a numeric column
cannot hold an object. A `Json` column can, so a document's own key could be
spelled `merge` and there would be no way to tell.

> **Watch out: on a `Json` column, an operator name is a document key.**
>
> ```js
> await db.a.update({ where: { id }, data: { doc: { increment: 1 } } })
> // doc is now {"increment":1} — the document was replaced by the operator
> await db.a.update({ where: { id }, data: { doc: { push: 'x' } } })
> // doc is now {"push":"x"}
> ```
>
> This is the rule above doing its job — the column decides, and a `Json`
> column carries objects, so these are values and not operators. Nothing warns,
> because nothing can: `{ increment: 1 }` is a document somebody might mean.
>
> The five bare names (`increment`, `decrement`, `multiply`, `divide`, `push`)
> are the ones to watch. `$merge` is the only operator a `Json` column takes,
> and it is spelled with a `$` for exactly this reason.

It is RFC 7396 merge-patch, so three of its rules are worth knowing before you
reach for it:

| the patch holds | what happens |
| --- | --- |
| `null` | **deletes the key** — not *sets it to null* |
| an array | replaces it whole; there is no element merge and no path-push |
| an object, target absent | **replaces** rather than merges |

**A `Json @type(T)` column grades the patch; a plain `Json` column has nothing
to grade.** An undescribed column declares no shape, so no merge can break it.
A described one is checked key by key against the type's own rules, and a `null`
on a key the type requires is refused by name.

The third row of that table is the one that decides how a described patch is
graded, and it is not obvious. Because `json_patch` REPLACES an absent or null
target, a patch aimed at something optional is a **create** however partial it
looks — so the required keys of that type are not optional after all. In the
schema above, `Prefs.commute` is `Json? @type(Commute)`, and `Commute` requires
`source` AND `minutes`:

```js throws
const { id } = await db.trip.create({ data: { prefs: { theme: 'dark' } } })

await db.trip.update({ where: { id }, data: { prefs: { $merge: { commute: { source: 'car' } } } } })
// Refused — prefs.commute.minutes: is required — the value being merged
//   into may not be there, and json_patch replaces rather than merges when it is
//   absent, so this write creates a whole Commute and needs every required key
```

A **required** field is present in every valid parent, so a patch into it really
is partial and absent keys keep their stored value. The whole rule is decidable
from the schema, which is what lets the operator keep the property it exists
for: it never reads the row.

The same applies one level up — a `Json? @type(T)` **column** may stand at
`null`, so its patch is graded as a create; a `Json @type(T)` column cannot, so
its patch is partial.

`$merge` is refused on an `@encrypted` or `@secret` column: what is stored there
is ciphertext, and patching that produces something that is neither.

Bulk ops (`createMany`, `updateMany`, `upsertMany`, `removeMany`, `deleteMany`) return `{ count }` only — no row data. This is intentional: `RETURNING *` on thousands of rows negates the performance reason for bulk ops. Use `$transaction` + single-row ops when you need the modified rows.
