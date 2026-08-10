# Relations

## Defining relations

```prisma
model Account {
  id    Int @id
  name  String
  users users[]      // hasMany (inferred from the other side)
}

model User {
  id        Int  @id
  account   accounts @relation(fields: [accountId], references: [id], onDelete: Cascade)
  accountId Int
  posts     posts[]
}

model Post {
  id       Int @id
  author   users   @relation(fields: [authorId], references: [id])
  authorId Int
  tags     tags[]  // implicit many-to-many (no join model needed)
}

model Tag {
  id    Int @id
  label String
  posts posts[]
}
```

The `@relation` attribute lives on the **belongsTo** side (the model with the FK column). The reverse side (`users[]`, `posts[]`) is inferred and doesn't need `@relation`.

## Include (eager loading)

```js
// Single level
const posts = await db.post.findMany({
  include: { author: true, tags: true }
})
// posts[0].author → { id, name, email }
// posts[0].tags   → [{ id, label }, ...]

// Nested
const users = await db.user.findMany({
  include: { account: { include: { plan: true } } }
})

// Select specific fields on included relations
const posts = await db.post.findMany({
  include: {
    author: { select: { id: true, name: true } }
  }
})
```

## Relation counts

```js
// Count all relations
const posts = await db.post.findMany({
  include: { _count: true }
})
// posts[0]._count → { comments: 3, tags: 1 }

// Count specific relations only
const posts2 = await db.post.findMany({
  include: { _count: { select: { comments: true } } }
})

// Filtered count
const posts3 = await db.post.findMany({
  include: {
    _count: {
      select: {
        comments: { where: { approved: true } }
      }
    }
  }
})
```

## Nested writes

Create related records in a single call:

```js
// create with nested belongs-to (parent created first)
const post = await db.post.create({
  data: {
    title:    'Hello World',
    author: {
      create: { name: 'Alice', email: 'alice@example.com', accountId: 1 }
    }
  }
})

// create with connect (use existing parent)
const post2 = await db.post.create({
  data: {
    title:    'Hello World',
    author: { connect: { id: existingUserId } }
  }
})

// create with nested hasMany (children created after parent)
const user = await db.user.create({
  data: {
    email: 'alice@example.com',
    accountId: 1,
    posts: {
      create: [
        { title: 'First post' },
        { title: 'Second post' },
      ]
    }
  }
})

// update: connect / disconnect on manyToMany
await db.post.update({
  where: { id: 1 },
  data: {
    tags: {
      connect:    [{ id: 1 }, { id: 2 }],
      disconnect: [{ id: 3 }],
    }
  }
})
```

## @from — derived relation fields

Computed aggregates from related models, declared in the schema and evaluated at query time:

```prisma
model Account {
  id         Int      @id
  name       String
  orders     Order[]                                   // the relation @from reads
  orderCount Int      @from(Order, count: true)
  revenue    Float    @from(Order, sum: amount)
  biggest    Float    @from(Order, max: amount)
  lastOrder  Order?   @from(Order, last: true)         // the whole row, not a column
  hasBig     Boolean  @from(Order, exists: true, where: "amount > 100")
}

model Order {
  id        Int     @id
  accountId Int
  account   Account @relation(fields: [accountId], references: [id])
  amount    Float
}
```

Two things trip people up, and both are validation errors rather than silent wrong answers:

**The first argument is the target MODEL name, PascalCase** — `@from(Order, …)`, not the
name of the relation field. `@from(orders, …)` fails with *"unknown model 'orders'"*.

**`first:`/`last:` return the whole related row**, so the field is typed as the target
model — `Order?`, not `DateTime`. Reach into it in application code (`account.lastOrder.createdAt`).

`@from` fields appear automatically in query results — no extra `include` needed. They are
read-only, are not stored in SQLite, and disable the `findUnique` fast path (see `performance.md`).

The declared relation is what `@from` joins on, and a schema without one is a parse error:

```
Model 'Account', field 'orderCount': @from(Order, ...) — no relation from 'Order' back to
'Account'. Declare 'Order.account Account @relation(fields: [...], references: [...])'
```

The correlation is inferred from the target's `@relation`, so it follows `references:` rather
than assuming the primary key — an FK pointing at a non-PK `@unique` column works.

### Operations

Exactly one is required.

| Operation | Field type must be | Result |
| --- | --- | --- |
| `count: true` | `Int` | `COUNT(*)`, `0` when there are no rows |
| `sum: field` | `Int` / `Float` | `COALESCE(SUM(field), 0)` — `0`, never null |
| `max: field` / `min: field` | matches the target field | `null` when there are no rows |
| `first: true` / `last: true` | the target model, e.g. `Order?` | the whole row, or `null` |
| `exists: true` | `Boolean` | `true` / `false` |

Options: `where: "sql"` filters the rows considered; `orderBy: field` picks what `first`/`last`
order by (default is `id`).

Against the schema above, with one account holding orders of 50, 120 and 30 and a second holding none:

```js
{ name: 'Acme',  orderCount: 3, revenue: 200, biggest: 120,  hasBig: true,  lastOrder: { id: 3, accountId: 1, amount: 30 } }
{ name: 'Empty', orderCount: 0, revenue: 0,   biggest: null, hasBig: false, lastOrder: null }
```

Note the two different empties: `sum` coalesces to `0`, `max` stays `null`.

## Recursive tree queries

Self-referential relations support CTE-based tree traversal:

```prisma
model Category {
  id       Int     @id
  name     String
  parent   categories? @relation(fields: [parentId], references: [id])
  parentId Int?
  children categories[]
}
```

```js
// All descendants of node 5
const subtree = await db.category.findMany({
  where:     { id: 5 },
  recursive: true,   // direction: 'descendants' (default)
})

// All ancestors (breadcrumb path to root)
const path = await db.category.findMany({
  where:     { id: 42 },
  recursive: { direction: 'ancestors' },
})

// Nested structure — each node has a children array
const tree = await db.category.findMany({
  where:     { parentId: null },
  recursive: { direction: 'descendants', nested: true, maxDepth: 3 },
})

// Multiple self-relations — disambiguate with via:
const reports = await db.employees.findMany({
  where:     { id: 1 },
  recursive: { direction: 'descendants', via: 'reports' },
})
```

## Relation orderBy

Sort by a field on a related model (LEFT JOIN, no row duplication):

```js
// Sort posts by author name
db.post.findMany({ orderBy: { author: { name: 'asc' } } })

// Two-hop: sort users by their company's country
db.user.findMany({ orderBy: { company: { country: { name: 'asc' } } } })
```

Sort by relation aggregate (correlated subquery):

```js
db.authors.findMany({ orderBy: { books: { _count: 'desc' } } })
db.authors.findMany({ orderBy: { books: { _sum: { price: 'desc' } } } })
db.authors.findMany({ orderBy: { tags:  { _count: 'asc' } } })  // manyToMany
```

See [sorting.md](./sorting.md) for the full sorting reference.
