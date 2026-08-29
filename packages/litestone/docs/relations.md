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

### One-to-one

The side holding the foreign key declares it; the other side names the model and
nothing else. No label is needed, exactly as with a list back-reference.

```lite
model User {
  id      String   @id @default(cuid())
  profile Profile?
}

model Profile {
  id     String @id @default(cuid())
  userId String @unique
  user   User   @relation(fields: [userId], references: [id])
}
```

**The foreign key must be unique**, and that is what separates a one-to-one from
a to-many written as one — without it many rows point back and `user.profile`
would answer one of them arbitrarily, so it is refused by name. A field
`@unique`, an exactly-matching `@@unique`, or the column being the primary key
all count:

```lite
model CalVideoSettings {
  eventTypeId Int       @id                                     // the FK is the PK
  eventType   EventType @relation(fields: [eventTypeId], references: [id])
}
```

`include` answers the row itself and `null` where there is none — never a list of
one. Where two relations run between the same pair of models, label both ends the
way you would a list.

### The implicit join table

A mutual `Model[]` pair generates the join table for you — you never write it,
but it is an ordinary table and worth knowing the shape of:

```sql
CREATE TABLE "_post_tag" (
  "postId" TEXT NOT NULL REFERENCES "post"("slug") ON DELETE CASCADE,
  "tagId"  TEXT NOT NULL REFERENCES "tag"("code")  ON DELETE CASCADE,
  PRIMARY KEY ("postId", "tagId")
) STRICT
```

Each column takes the **name and type of that model's own `@id`** — a uuid key
is `TEXT`, an `Int @id` is `INTEGER`, and the two sides may differ. A key named
something other than `id` is referenced by its real name. Naming:
`_modela_modelb` alphabetically with `modelaId` / `modelbId` columns, or
`_<label>` with columns `"A"` / `"B"` when the relation is labeled with
`@relation("name")` — the labeled layout is Prisma's, byte for byte.

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

The row is a **properly read row**: it carries the target's own `@computed` and `@from`
fields and is stripped of its `@guarded`, `@omit` and `@encrypted` ones, exactly as a
direct read or an `include` of that row would be. The subquery resolves the row's id and
one batched query fetches the rows — so a `findMany` of a hundred parents costs one extra
query, not a hundred.

Two consequences worth knowing. The target's **row policy applies**, the same way it does
to an `include`, so a `@@allow` on the target can make the field `null`. And because the
pick happens in SQL before the policy is known, a row the caller may not read makes the
field `null` rather than falling through to the next visible one (`FJS-224`).

`@from` fields appear automatically in query results — no extra `include` needed. They are
not stored in SQLite and they disable the `findUnique` fast path (see `performance.md`).
**Read-only means a write naming one is refused**, by name and with the reason, like every
other virtual field kind — the value has nowhere to land and the next read answers the
aggregate, so a caller who seeded a count would otherwise read back the real one and
believe they had set it.

**A composite key correlates on all of it.** A relation declaring
`@relation(fields: [workspaceId, userId], references: [workspaceId, userId])` joins on both
columns, in the aggregate, in a `first`/`last` repick under a row policy, and in a `select`
that names only the derived field. Nothing about a wrong answer here would look wrong: a
join on the first column alone is still a count of real rows.

The declared relation is what `@from` joins on, and a schema without one is a parse error:

```
Model 'Account', field 'orderCount': @from(Order, ...) — no relation from 'Order' back to
'Account'. Declare 'Order.account Account @relation(fields: [...], references: [...])'
```

The correlation is inferred from the target's `@relation`, so it follows `references:` rather
than assuming the primary key — an FK pointing at a non-PK `@unique` column works. The
subquery aliases the target, so a model may derive from **itself** — a task counting its
own subtasks correlates a table to itself, and without the alias the correlation is
captured by the subquery's own `FROM` and every row answers `0`.

### `via:` — which relation, when there is more than one

Two relations can join one pair of models, and then the target model name is not enough to
say which one a `@from` reads. That is **refused**, naming both and the cure:

```
Model 'User', field 'msgCount': @from(Message, ...) is ambiguous — 2 relations join
'User' and 'Message' (Message.sender, Message.recipient). Say which with via: —
@from(Message, ..., via: sender)
```

```prisma
model User {
  id       Int       @id
  sent     Message[] @relation("sent")
  received Message[] @relation("received")

  sentCount Int @from(Message, count: true, via: sent)        // the field on THIS model
  gotCount  Int @from(Message, count: true, via: recipient)   // or the field on the target
}
```

`via` names either side — the relation field on this model, the one on the target, the
`@relation` name they share, or the FK column itself. A name matching none of them is
refused with the candidates listed.

This is routine on a self-relational model: `parent` + `children` is **one** relation and
needs no `via`, but add a second (`blocker`/`blocked`) and both need naming. Picking the
first that fits was the old behaviour, and the count it returned answered a different
question with nothing in the value to say so.

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

A model with a relation to itself — a task with subtasks, a category with
subcategories — is walked with `recursive`:

```prisma
model Task {
  id       Int    @id
  title    String
  parentId Int?
  parent   Task?  @relation(fields: [parentId], references: [id])
  children Task[]
}
```

```js
// Everything below task 5
const subtree = await db.task.findMany({ where: { id: 5 }, recursive: true })

// The path up to the root — a breadcrumb
const path = await db.task.findMany({
  where:     { id: 42 },
  recursive: { direction: 'ancestors' },
})

// A tree: each node carries a `children` array
const tree = await db.task.findMany({
  where:     { parentId: null },
  recursive: { direction: 'descendants', nested: true, maxDepth: 3 },
})

// Two self-relations on one model — say which
const reports = await db.employee.findMany({
  where:     { id: 1 },
  recursive: { direction: 'descendants', via: 'reports' },
})
```

Every row carries `_depth`, its distance from the anchor — `1` for a direct
child or the immediate parent, counting outward in both directions. The anchor
itself is never in its own result, and `orderBy: { _depth: 'desc' }` sorts by it
(only on a tree read; `_depth` is not a column).

### A tree read is an ordinary read

The `@@gate`, the `@@allow` row policies and `@@softDelete` all apply, and they
apply **at every level, not just to the row you named**. A node the caller
cannot see hides its whole subtree:

```js
// @@allow('read', ownerId == auth().id)
await me.task.findMany({ where: { id: 1 }, recursive: true })
// → the walk stops at the first row the policy refuses; its children are not
//   reachable through it. Same for a soft-deleted node — `withDeleted: true`
//   opts the walk back in, exactly as it does a flat read.
```

That is the deliberate reading of a hidden node: it takes its branch with it,
matching what `@@softDelete(cascade)` already does on the write side. The
alternative — reparenting orphans up to the visible tree — would hand back the
children of a row the caller was refused.

`select`, `include`, `@computed` and `@from` all behave as they do on any other
`findMany`, because the tree query resolves ids and the rows come back through
the ordinary read path.

### What it will not do

Only `findMany` walks a tree. `count`, `findFirst`, `findUnique`, `exists`,
`aggregate` and `groupBy` **refuse `recursive` by name** rather than quietly
answering about the anchor row alone. `nested: true` refuses `limit`/`offset`
for the same reason — they would cut branches out of the middle of a tree. Use
`maxDepth`, or page the flat result.

### Cycles

A row cannot be made its own ancestor. The write is refused, naming the field:

```js
await db.task.update({ where: { id: 1 }, data: { parentId: 1 } })
// ValidationError: parentId points at the row itself — a row cannot be its own parent

await db.task.update({ where: { id: 1 }, data: { parentId: 3 } })   // 3 is below 1
// ValidationError: parentId would make "1" its own ancestor — the parent chain
// above 3 already passes through it
```

Refused at the write because that is the only place that can name the field
that was wrong. A loop already in the table — written before this guard, or
through raw SQL — is survived rather than trusted: the walk tracks the path it
came by and visits each row once.

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
