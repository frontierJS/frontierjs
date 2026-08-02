# Filtering

## Basic operators

```js
// Equality
{ id: 1 }
{ status: 'active' }
{ deletedAt: null }          // IS NULL

// Comparisons
{ score:  { gt: 0 } }
{ score:  { gte: 0, lte: 100 } }
{ price:  { lt: 50 } }
{ amount: { not: null } }    // IS NOT NULL
{ status: { not: 'archived' } }

// List
{ status: { in: ['active', 'pending'] } }
{ id:     { notIn: [1, 2, 3] } }         // includes rows where id IS NULL

// String
{ name:  { contains: 'smith' } }         // LIKE %smith%
{ email: { startsWith: 'alice' } }       // LIKE alice%
{ path:  { endsWith: '.pdf' } }          // LIKE %.pdf
```

## Logical operators

```js
// AND — all conditions must match
{ AND: [{ status: 'active' }, { role: 'admin' }] }

// OR — at least one must match
{ OR: [{ status: 'active' }, { status: 'pending' }] }

// NOT — inverse
{ NOT: { status: 'archived' } }

// Nested
{
  AND: [
    { status: 'active' },
    { OR: [{ role: 'admin' }, { role: 'owner' }] },
  ]
}
```

## Array fields

```js
// JSON array fields (String[] etc.)
{ tags: { has: 'sqlite' } }                  // contains element
{ tags: { hasEvery: ['sqlite', 'bun'] } }    // contains all
{ tags: { hasSome: ['sqlite', 'mysql'] } }   // contains at least one
{ tags: { isEmpty: true } }                  // empty array
```

## Soft delete

```js
// Default: live rows only
db.user.findMany({ where: { accountId: 1 } })

// Include deleted rows
db.user.findMany({ where: { accountId: 1 }, withDeleted: true })

// Only deleted rows
db.user.findMany({ where: { accountId: 1 }, onlyDeleted: true })
```

## Raw SQL — `$raw`

For predicates the structured builder can't express. Uses the `sql` tagged template for safe parameter binding — values are extracted as `?` params, never concatenated:

```js
import { sql } from '@frontierjs/litestone'

// Simple raw predicate
db.product.findMany({
  where: { $raw: sql`price > IF(state = ${state}, ${minPrice}, 100)` }
})

// json_extract
db.order.findMany({
  where: { $raw: sql`json_extract(meta, '$.tier') = ${3}` }
})

// Date arithmetic
db.subscriptions.findMany({
  where: { $raw: sql`julianday('now') - julianday(createdAt) > ${30}` }
})

// Mixed with structured where — ANDed together
db.order.findMany({
  where: {
    status: 'active',
    $raw:   sql`json_extract(meta, '$.tier') = ${3}`,
  }
})

// Composed inside AND / OR
db.user.findMany({
  where: {
    AND: [
      { accountId: 1 },
      { $raw: sql`DATEDIFF(next_review_dt, added_dt) <= ${30}` },
    ]
  }
})
```

`$raw` works everywhere `where:` is accepted: `findMany`, `findFirst`, `count`, `exists`, `update`, `updateMany`, `remove`, `removeMany`, `aggregate`, `groupBy`.

Plain string also works for parameterless expressions:

```js
db.user.findMany({ where: { $raw: 'deletedAt IS NULL' } })
```

## Row-level policies

When using `$setAuth(user)`, `@@allow` and `@@deny` policies are automatically injected as SQL WHERE conditions. They run in SQLite, not JS — no accidental data exposure from forgetting a filter.

```js
const userDb = db.$setAuth({ id: 1, accountId: 5, role: 'member' })

// @@allow('read', accountId == auth().accountId) → WHERE "accountId" = 5
const posts = await userDb.posts.findMany()

// Bypass all policies
const all = await db.asSystem().posts.findMany()
```

See [access-control.md](./access-control.md) for the full policy syntax.

## Global filters

Apply a filter to every query on a model, regardless of call site:

```js
const db = await createClient({
  path:    './schema.lite',
  filters: {
    posts: { status: 'published' },
    users: (ctx) => ({ tenantId: ctx.auth?.tenantId }),
  },
})

// Every db.post.findMany() automatically adds WHERE status = 'published'
// Every db.user.findMany() automatically adds WHERE tenantId = <auth tenantId>
```

Dynamic filters (function form) receive `ctx` so they can reference `ctx.auth`.

## Relation filters

Filter parent rows by conditions on a related model — compiles to a correlated
`EXISTS` subquery (no join, no row duplication):

```js
// authors who have at least one published post
db.author.findMany({ where: { posts: { some: { published: true } } } })

// authors with no published posts (or no posts at all)
db.author.findMany({ where: { posts: { none: { published: true } } } })

// authors whose posts are ALL published (vacuously true when they have none)
db.author.findMany({ where: { posts: { every: { published: true } } } })
```

`some` / `every` / `none` work on `hasMany` and implicit many-to-many relations.
For a to-one (`belongsTo`) relation use `is` / `isNot`:

```js
db.post.findMany({ where: { author: { is:    { name: 'Ann' } } } })
db.post.findMany({ where: { author: { isNot: { name: 'Ann' } } } })
```

Relation filters compose with scalar filters and `AND`/`OR`/`NOT`, and nest
(a relation filter's inner `where` can itself contain relation filters).

## Filtering an include

`include` accepts a `where` to filter the related rows that come back — the
parent is still returned, but only matching children are attached:

```js
const author = await db.author.findFirst({
  where:   { id: 1 },
  include: { posts: { where: { published: true } } },   // only published posts
})
// author.posts → just the published ones
```

Works on `hasMany` and many-to-many includes. On a `belongsTo` include a
non-matching `where` yields `null` for that relation.
