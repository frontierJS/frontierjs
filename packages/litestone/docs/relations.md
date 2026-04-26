# Relations

## Defining relations

```prisma
model Account {
  id    Integer @id
  name  Text
  users users[]      // hasMany (inferred from the other side)
}

model User {
  id        Integer  @id
  account   accounts @relation(fields: [accountId], references: [id], onDelete: Cascade)
  accountId Integer
  posts     posts[]
}

model Post {
  id       Integer @id
  author   users   @relation(fields: [authorId], references: [id])
  authorId Integer
  tags     tags[]  // implicit many-to-many (no join model needed)
}

model Tag {
  id    Integer @id
  label Text
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
  id         Integer  @id
  name       Text
  userCount  Integer  @from(users, count: true)
  revenue    Real     @from(orders, sum: amount)
  lastOrder  DateTime @from(orders, last: true)
  hasOverdue Boolean  @from(invoices, exists: true, where: "due_at < date('now') AND paid = 0")
}
```

`@from` fields appear automatically in query results — no extra include needed. They're read-only and not stored in SQLite.

Supported: `count`, `sum`, `max`, `min`, `first`, `last`, `exists`. All accept an optional `where` SQL fragment.

## Recursive tree queries

Self-referential relations support CTE-based tree traversal:

```prisma
model Category {
  id       Integer     @id
  name     Text
  parent   categories? @relation(fields: [parentId], references: [id])
  parentId Integer?
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
