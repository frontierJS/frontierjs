# Relations

## Defining relations

The examples on this page use this schema unless a section declares its own:

```lite
model Account {
  id     Int    @id
  name   String
  planId Int?
  plan   Plan?  @relation(fields: [planId], references: [id])
  users  User[]      // hasMany (inferred from the other side)
}

model Plan {
  id       Int       @id
  name     String
  accounts Account[]
}

model User {
  id        Int     @id
  name      String?
  email     String
  account   Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
  accountId Int
  posts     Post[]
}

model Post {
  id       Int       @id
  title    String
  views    Int       @default(0)
  author   User      @relation(fields: [authorId], references: [id])
  authorId Int
  tags     Tag[]     // implicit many-to-many (no join model needed)
  comments Comment[]
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
```

The `@relation` attribute lives on the **belongsTo** side (the model with the FK column). The reverse side (`User[]`, `Post[]`) is inferred and doesn't need `@relation`. A relation field names the MODEL — `Account`, `Post[]` — never a table or a plural.

## Include (eager loading)

```js
await db.account.create({ data: { name: 'Acme', users: { create: [{ email: 'ann@example.com', name: 'Ann',
  posts: { create: [{ title: 'Hello', tags: { create: [{ label: 'intro' }] } }] } }] } } })

// Single level
const posts = await db.post.findMany({
  include: { author: true, tags: true }
})
// posts[0].author → { id, name, email, accountId }
// posts[0].tags   → [{ id, label }, ...]

// Nested
const users = await db.user.findMany({
  include: { account: { include: { plan: true } } }
})

// Select specific fields on included relations
const authored = await db.post.findMany({
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

Create related records in a single call. A foreign key is enforced, so a parent named by id has to exist:

```js
await db.account.create({ data: { id: 1, name: 'Acme' } })
const existing = await db.user.create({ data: { email: 'bob@example.com', accountId: 1 } })

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
    author: { connect: { id: existing.id } }
  }
})

// create with nested hasMany (children created after parent)
const user = await db.user.create({
  data: {
    email: 'carol@example.com',
    accountId: 1,
    posts: {
      create: [
        { title: 'First post' },
        { title: 'Second post' },
      ]
    }
  }
})

// `select: false` is honored and still returns null, but it does NOT skip the
// RETURNING when there are children: a hasMany create needs the parent's id, so
// the row is fetched internally and simply not handed back (`FJS-615`).

// update: connect / disconnect on manyToMany
await db.tag.createMany({ data: [{ id: 1, label: 'a' }, { id: 2, label: 'b' }, { id: 3, label: 'c' }] })
await db.post.update({
  where: { id: post.id },
  data: {
    tags: {
      connect:    [{ id: 1 }, { id: 2 }],
      disconnect: [{ id: 3 }],
    }
  }
})
```

## Relation orderBy

Sort by a field on a related model (LEFT JOIN, no row duplication):

```js
// Sort posts by author name
await db.post.findMany({ orderBy: { author: { name: 'asc' } } })

// Two-hop: sort posts by their author's account name
await db.post.findMany({ orderBy: { author: { account: { name: 'asc' } } } })
```

Sort by relation aggregate (correlated subquery):

```js
await db.user.findMany({ orderBy: { posts: { _count: 'desc' } } })
await db.user.findMany({ orderBy: { posts: { _sum: { views: 'desc' } } } })
await db.post.findMany({ orderBy: { tags:  { _count: 'asc' } } })  // manyToMany
```

See [sorting.md](./sorting.md) for the full sorting reference. One combination is a filed defect — a relation sort beside `select: { id: true }`:

```js failing
// FJS-2299
await db.post.findMany({ orderBy: { author: { name: 'asc' } }, select: { id: true } })
// ambiguous column name: id
```

## One-to-one

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
model EventType {
  id       Int               @id
  settings CalVideoSettings?
}

model CalVideoSettings {
  eventTypeId Int       @id                                     // the FK is the PK
  eventType   EventType @relation(fields: [eventTypeId], references: [id])
}
```

`include` answers the row itself and `null` where there is none — never a list of
one. Where two relations run between the same pair of models, label both ends the
way you would a list.

```js throws
await createClient({ db: ':memory:', schema: `
  model User    { id Int @id  profile Profile? }
  model Profile { id Int @id  userId Int  user User @relation(fields: [userId], references: [id]) }
` })
// Model 'User', field 'profile': 'Profile.user' is not unique, so many 'Profile'
// rows can point back — write 'profile Profile[]' for a to-many, or add @unique
// to 'Profile.userId' for a one-to-one.
```

## The implicit join table

A mutual `Model[]` pair generates the join table for you — you never write it,
but it is an ordinary table and worth knowing the shape of. For
`model Post { slug String @id  tags Tag[] }` and `model Tag { code String @id  posts Post[] }`:

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

## @@relator — can this relationship happen twice

A membership, a placement, a subscription: a relationship that is a ROW. It is
**existentially dependent** on the things it relates, so it cannot outlive one
of them — and the one thing about it a reader cannot derive is whether the same
pair may appear again.

```lite
model Workspace {
  id      String            @id @default(uuid())
  members WorkspaceMember[]
}

model User {
  id          String            @id @default(uuid())
  memberships WorkspaceMember[]
}

model WorkspaceMember {
  id          String    @id @default(uuid())
  workspaceId String
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId      String
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@relator([workspaceId, userId], once)
}
```

**The repeatability argument is required.** `@@relator([workspaceId, userId])`
is a parse error naming the three choices, because `once` and a bare `many` are
distinguished by an absence — a default would answer in silence the one question
the word exists to ask.

| form | means | emits |
| --- | --- | --- |
| `once` | the relata identify the row | `UNIQUE(relata)` |
| `many: <column>` | the column tells two apart | `UNIQUE(relata + column)` |
| `many` | nothing tells two apart | no key |

**Plus an index on every relatum the emitted key does not already cover.** A
key is prefix-matched, so `once` and `many: <column>` leave only the trailing
relata uncovered; a bare `many` emits no key, so it indexes all of them. This is
the half `@@unique` cannot do on its own: both ends of a relator are entrances,
and a composite leading with one side leaves the other with nothing to use —
which is a foreign key scan on every cascade, once per deleted parent.

Nothing is emitted where the model already answers it. An `@@index` that LEADS
with a relatum is already the reverse index and is doing more besides, and a
composite primary key over exactly the relata already IS the key — which is what
a side table promoted by `litestone edge eject` has, since an edge keys both
dimensions and is therefore `once` by construction.

**`many` with no discriminator usually means the row is not a relator at all.**
Something that happens rather than a standing fact — a run, a movement, a
reading — and the tell is that such a row COPIES what it read: the script as
run, the price as charged, the period as calculated. A relator carries no copies,
because it does not outlive its relata and so has nothing to preserve them
against.

### What it refuses

- **An optional relatum, or one whose relation is `onDelete: SetNull`.** A
  relator with a missing relatum is not a relationship that lost a participant;
  it is a row that never meant anything. `Cascade` and `Restrict` both pass —
  they honor the dependence and differ only on who wins.
- **Fewer than two distinct relations.** Counted over relations rather than
  columns: a composite foreign key is two columns naming one thing.
- **A `@@unique` or an `@@index` over columns it already emits.** One origin, or
  the two drift.
- **A discriminator that is optional, is already a relatum, or has no column.**

What it cannot refuse is a `@@relator` on a row whose foreign keys are
OWNERSHIP rather than mediation — an API key belonging to a workspace and a
user is not a relationship between them. That is a modeling judgment and the
parser has no access to it.

### What reads it

**`upsert` refuses to be addressed by a repeatable pair.** `upsert`'s
single-statement path needs one unique column, so a pair never reaches it and
the call falls to find-then-update — which on a `many` relator matches every
occurrence there has ever been and overwrites the oldest instead of recording a
new one. The declaration is what makes that refusable: a relator states how its
rows are identified, so an upsert addressing them any other way is provably not
the write the caller meant.

```lite
model Recipe { id Int @id  runs RecipeRun[] }
model Server { id Int @id  runs RecipeRun[]  apps AppServer[] }
model App    { id Int @id  servers AppServer[] }

model RecipeRun {
  id       Int    @id
  recipeId Int
  recipe   Recipe @relation(fields: [recipeId], references: [id], onDelete: Cascade)
  serverId Int
  server   Server @relation(fields: [serverId], references: [id], onDelete: Cascade)

  @@relator([recipeId, serverId], many)
}

model AppServer {
  id           Int    @id
  appId        Int
  app          App    @relation(fields: [appId], references: [id], onDelete: Cascade)
  serverId     Int
  server       Server @relation(fields: [serverId], references: [id], onDelete: Cascade)
  replicaIndex Int

  @@relator([appId, serverId], many: replicaIndex)
}
```

```js throws
// @@relator([recipeId, serverId], many)
await db.recipeRun.upsert({ where: { recipeId: 1, serverId: 2 }, create: { recipeId: 1, serverId: 2 }, update: {} })
// ValidationError: …the same pair may happen any number of times and there is
// no row for these columns to name. Use create(), or address the row by its id.
```

```js throws
// @@relator([appId, serverId], many: replicaIndex)
await db.appServer.upsert({ where: { appId: 1, serverId: 2 }, create: { appId: 1, serverId: 2, replicaIndex: 0 }, update: {} })
// ValidationError: …what identifies a row is appId + serverId + replicaIndex,
// and this where names replicaIndex nowhere.
```

`once` is unaffected — the relata ARE the conflict target — and so is any upsert
addressed by the row's own id.

**`verifyConstraints` grades the answer, and `litestone mutate` grades the
check.** The derived suite writes a row, writes the same tuple again, and
compares what happened against what the word says: `once` must refuse it, `many`
must take it, and `many: <column>` must refuse the identical tuple while
accepting the same pair under a different value. That second case is the one
worth having — without it, tightening `many: replicaIndex` to `once` looks
correct from the outside, which is precisely the change that costs an app the
ability to run two replicas of one thing on one machine.

## @from — derived relation fields

Computed aggregates from related models, declared in the schema and evaluated at query time:

```lite
model Account {
  id         Int      @id
  name       String
  orders     Order[]                                   // the relation @from reads
  orderCount Int      @from(Order, count: true)
  revenue    Float    @from(Order, sum: amount)
  biggest    Float?   @from(Order, max: amount)
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

The target's **read gate applies** to every `@from` kind. A caller whose level does not
clear it reads the field as `null` — a `last:` row, a `count:` and an `exists:` alike — and a
`where` or `orderBy` naming the field is refused with the target's own *requires level*
error, as an `include` of the relation is (`FJS-1646`). A row policy reaches `first:`/`last:`
only, below; an aggregate still counts rows the policy hides (`FJS-1647`).

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

```js throws
await db.account.update({ where: { id: 1 }, data: { orderCount: 5 } })
// ValidationError: orderCount is @from(Order, count) — it is a subquery over
// Order evaluated on read, not a column, so it cannot be written. Write the
// Order rows it counts instead
```

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

Against the `Account` / `Order` schema above, with one account holding orders of 50, 120 and 30 and a second holding none:

```js
await db.account.createMany({ data: [{ id: 1, name: 'Acme' }, { id: 2, name: 'Empty' }] })
await db.order.createMany({ data: [
  { accountId: 1, amount: 50 }, { accountId: 1, amount: 120 }, { accountId: 1, amount: 30 },
] })

await db.account.findMany({ select: { name: true, orderCount: true, revenue: true, biggest: true, hasBig: true, lastOrder: true } })
// → [{ name: 'Acme',  orderCount: 3, revenue: 200, biggest: 120,  hasBig: true,  lastOrder: { id: 3, accountId: 1, amount: 30 } },
//    { name: 'Empty', orderCount: 0, revenue: 0,   biggest: null, hasBig: false, lastOrder: null }]
```

Note the two different empties: `sum` coalesces to `0`, `max` stays `null`.

### `via:` — which relation, when there is more than one

Two relations can join one pair of models, and then the target model name is not enough to
say which one a `@from` reads. That is **refused**, naming both and the cure:

```
Model 'User', field 'msgCount': @from(Message, ...) is ambiguous — 2 relations join
'User' and 'Message' (Message.sender, Message.recipient). Say which with via: —
@from(Message, ..., via: sender)
```

```lite
model User {
  id       Int       @id
  sent     Message[] @relation("sent")
  received Message[] @relation("received")

  sentCount Int @from(Message, count: true, via: sent)        // the field on THIS model
  gotCount  Int @from(Message, count: true, via: recipient)   // or the field on the target
}

model Message {
  id          Int  @id
  senderId    Int
  sender      User @relation("sent", fields: [senderId], references: [id])
  recipientId Int
  recipient   User @relation("received", fields: [recipientId], references: [id])
}
```

`via` names either side — the relation field on this model, the one on the target, the
`@relation` name they share, or the FK column itself. A name matching none of them is
refused with the candidates listed.

This is routine on a self-relational model: `parent` + `children` is **one** relation and
needs no `via`, but add a second (`blocker`/`blocked`) and both need naming. Picking the
first that fits was the old behavior, and the count it returned answered a different
question with nothing in the value to say so.

## Recursive tree queries

A model with a relation to itself — a task with subtasks, a category with
subcategories — is walked with `recursive`:

```lite
model Task {
  id       Int    @id
  title    String
  parentId Int?
  parent   Task?  @relation(fields: [parentId], references: [id])
  children Task[]
}

model Employee {
  id        Int        @id
  name      String
  managerId Int?
  manager   Employee?  @relation("reports", fields: [managerId], references: [id])
  reports   Employee[] @relation("reports")
  mentorId  Int?
  mentor    Employee?  @relation("mentees", fields: [mentorId], references: [id])
  mentees   Employee[] @relation("mentees")
}

model Folder {
  id       Int      @id
  name     String
  ownerId  Int
  parentId Int?
  parent   Folder?  @relation(fields: [parentId], references: [id])
  children Folder[]

  @@allow('read', ownerId == auth().id)
}
```

```js
await db.task.createMany({ data: [
  { id: 5, title: 'root' }, { id: 6, title: 'a', parentId: 5 }, { id: 7, title: 'b', parentId: 6 },
] })

// Everything below task 5
const subtree = await db.task.findMany({ where: { id: 5 }, recursive: true })
// → [{ id: 6, …, _depth: 1 }, { id: 7, …, _depth: 2 }]

// The path up to the root — a breadcrumb
const path = await db.task.findMany({
  where:     { id: 7 },
  recursive: { direction: 'ancestors' },
})
// → [{ id: 5, …, _depth: 2 }, { id: 6, …, _depth: 1 }]

// A tree: each node carries a `children` array
const tree = await db.task.findMany({
  where:     { parentId: null },
  recursive: { direction: 'descendants', nested: true, maxDepth: 3 },
})

// Two self-relations on one model — `via` names the belongsTo field or its FK
// column; without it the walk follows every self-relation at once
const reports = await db.employee.findMany({
  where:     { id: 1 },
  recursive: { direction: 'descendants', via: 'manager' },
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
// Folder declares @@allow('read', ownerId == auth().id)
await db.asSystem().folder.createMany({ data: [
  { id: 1, name: 'mine',   ownerId: 1 },
  { id: 2, name: 'theirs', ownerId: 2, parentId: 1 },
  { id: 3, name: 'deep',   ownerId: 1, parentId: 2 },   // mine, but below a row I cannot see
  { id: 4, name: 'also',   ownerId: 1, parentId: 1 },
] })

const me = db.$setAuth({ id: 1 })
await me.folder.findMany({ where: { id: 1 }, recursive: true })
// → [{ id: 4, name: 'also', … }] — the walk stops at the first row the policy
//   refuses; its children are not reachable through it. Same for a
//   soft-deleted node — `withDeleted: true` opts the walk back in, exactly as
//   it does a flat read.
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

```js throws
await db.task.count({ where: { id: 5 }, recursive: true })
// ValidationError: recursive: count() does not take 'recursive' — only findMany walks a tree.
```

### Cycles

A row cannot be made its own ancestor. The write is refused, naming the field:

```js throws
await db.task.create({ data: { id: 1, title: 'root' } })
await db.task.update({ where: { id: 1 }, data: { parentId: 1 } })
// ValidationError: parentId points at the row itself — a row cannot be its own parent
```

```js throws
await db.task.createMany({ data: [{ id: 1, title: 'root' }, { id: 2, title: 'a', parentId: 1 }, { id: 3, title: 'b', parentId: 2 }] })
await db.task.update({ where: { id: 1 }, data: { parentId: 3 } })   // 3 is below 1
// ValidationError: parentId would make "1" its own ancestor — the parent chain
// above 3 already passes through it
```

Refused at the write because that is the only place that can name the field
that was wrong. A loop already in the table — written before this guard, or
through raw SQL — is survived rather than trusted: the walk tracks the path it
came by and visits each row once.
