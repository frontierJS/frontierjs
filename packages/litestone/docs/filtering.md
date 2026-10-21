# Filtering

The examples on this page use this schema:

```lite
model Lead {
  id         Int       @id
  name       String
  email      String?
  role       String    @default("member")
  status     String    @default("active")
  score      Int?
  price      Float?
  amount     Float?
  attachment String?
  tags       String[]
  deletedAt  DateTime?

  @@gate(0)
}

model Author {
  id    Int    @id
  name  String
  posts Post[]

  @@gate(0)
}

model Post {
  id        Int      @id
  title     String
  published Boolean  @default(false)
  views     Int      @default(0)
  tags      String[]
  comp      String   @computed
  authorId  Int?
  author    Author?  @relation(fields: [authorId], references: [id])

  @@gate(0)
}

type Addr {
  city String
  zip  String
}

model Place {
  id   Int  @id
  addr Json @type(Addr)

  @@gate(0)
}

model User {
  id        Int       @id
  email     String
  accountId Int?
  deletedAt DateTime?

  @@softDelete
  @@auth

  @@gate(0)
}

model Doc {
  id    Int    @id
  owner String @hashed

  @@allow(read, owner == auth().email)
}

model Invoice {
  id        Int @id
  accountId Int

  @@allow(read, accountId == auth().accountId)
}

model Product {
  id    Int    @id
  price Float
  state String

  @@gate(0)
}

model Order {
  id     Int    @id
  status String
  meta   Json?

  @@gate(0)
}

model Subscription {
  id        Int      @id
  createdAt DateTime @default(now())

  @@gate(0)
}

model Task {
  id          Int       @id
  dueAt       DateTime?
  startedAt   DateTime?
  completedAt DateTime?

  @@gate(0)
}

model Issue {
  id     Int          @id
  labels IssueLabel[]

  @@gate(0)
}

model Label {
  id     Int          @id
  name   String
  issues IssueLabel[]

  @@gate(0)
}

model IssueLabel {
  id      Int   @id
  issueId Int
  issue   Issue @relation(fields: [issueId], references: [id])
  labelId Int
  label   Label @relation(fields: [labelId], references: [id])

  @@gate(0)
}
```

## Basic operators

```js
const wheres = [
  // Equality
  { id: 1 },
  { status: 'active' },
  { deletedAt: null },          // IS NULL

  // Comparisons
  { score:  { gt: 0 } },
  { score:  { gte: 0, lte: 100 } },
  { price:  { lt: 50 } },
  { amount: { not: null } },    // IS NOT NULL
  { status: { not: 'archived' } },

  // List
  { status: { in: ['active', 'pending'] } },
  { id:     { notIn: [1, 2, 3] } },         // includes rows where id IS NULL

  // String
  { name:       { contains: 'smith' } },    // LIKE %smith%
  { email:      { startsWith: 'alice' } },  // LIKE alice%
  { attachment: { endsWith: '.pdf' } },     // LIKE %.pdf
]

for (const where of wheres) await db.lead.findMany({ where })
```

## Logical operators

```js
const wheres = [
  // AND — all conditions must match
  { AND: [{ status: 'active' }, { role: 'admin' }] },

  // OR — at least one must match
  { OR: [{ status: 'active' }, { status: 'pending' }] },

  // NOT — inverse
  { NOT: { status: 'archived' } },

  // Nested
  {
    AND: [
      { status: 'active' },
      { OR: [{ role: 'admin' }, { role: 'owner' }] },
    ]
  },
]

for (const where of wheres) await db.lead.findMany({ where })
```

## Array fields

An array field (`String[]`, `Int[]`, `Enum[]`) is a JSON column, and every
operator below reads its elements.

```js
await db.post.createMany({ data: [
  { title: 'a', tags: ['sqlite', 'bun'] },
  { title: 'b', tags: ['mysql'] },
  { title: 'c', tags: [] },
] })

const wheres = [
  { tags: { has: 'sqlite' } },                  // contains this element
  { tags: { hasEvery: ['sqlite', 'bun'] } },    // contains all of them
  { tags: { hasSome: ['sqlite', 'mysql'] } },   // contains at least one
  { tags: { hasNone: ['mysql'] } },             // contains none of them
  { tags: { in:     ['sqlite', 'mysql'] } },    // same question as hasSome
  { tags: { notIn:  ['mysql'] } },              // same question as hasNone
  { tags: { isEmpty: true } },                  // no elements
  { tags: { equals: ['sqlite', 'bun'] } },      // IS exactly this, in this order
  { tags: { not:    ['sqlite', 'bun'] } },      // is anything else
]

for (const where of wheres) await db.post.findMany({ where })
```

`in` and `notIn` read the elements, like every other operator here — on a scalar
column they compare its one value, on an array column its several. That is what
makes the bare-array shorthand below exactly `in`, in both places.

### A bare array

The shorthand means the same thing on both kinds of column — **the column's
value is in this list**:

```js
await db.lead.findMany({ where: { status: ['active', 'pending'] } })   // status IN (…)         one value
await db.post.findMany({ where: { tags:   ['sqlite', 'bun'] } })       // any element IN (…)    several
```

A scalar column has one value to test; an array column supplies its elements, so
the `IN` moves inside `json_each`. On an array column it is therefore the same
question as `hasSome`, reached without a new word.

**It is not `equals`.** `{ tags: ['sqlite', 'bun'] }` matches a row tagged
`['sqlite', 'bun', 'wal']`; `{ tags: { equals: [...] } }` does not. Prisma reads
the bare array the other way, as an exact match — worth knowing if you are coming
from it. Litestone chose the wider reading because the two mistakes fail
differently: asking for a set and getting a superset is visible, and asking for
membership and getting an empty result is not.

`equals` and `not` compare the whole document, so they are **order-sensitive**:
`['bun', 'sqlite']` does not match a row stored as `['sqlite', 'bun']`. For an
order-independent exact match, pair `hasEvery` with a length check.

An array operator on a column that is not an array is refused by name:

```js throws
await db.post.findMany({ where: { title: { has: 'x' } } })
// ValidationError: where.title: "has" is an array operator and "title" is not an array field
```

### A string operator asks about text

`contains` / `startsWith` / `endsWith` compile to `LIKE`, so they ask a question
about the column's TEXT. Where the stored text is not the value, the answer used
to be plausible and wrong rather than an error — on an array column `contains`
substring-matched the stored document, which **looks** like `has`: it matched
`["x"]`, and also `["xylophone"]`; `contains: '","'` matched every array of two
or more elements and `contains: '['` matched all of them. It is refused now,
naming the operator that was meant:

```js throws
await db.post.findMany({ where: { tags: { contains: 'x' } } })
// ValidationError: where.tags: "tags" holds a JSON array, so "contains" would
// substring-match the stored document rather than its elements — use "has" for
// an element, or "hasSome"/"hasEvery" for several
```

All four kinds are refused:

| Column | Because |
| --- | --- |
| array | it would substring-match the document — use `has` / `hasSome` / `hasEvery` |
| `Json` | it would match the serialized text, punctuation included — declare `@type(...)` to filter by a path |
| `File` | it would match the reference document, not anything about the file |
| `Boolean` | the value is stored as 0/1, so it can never match — compare to `true` / `false` |

**`Int` and `DateTime` are deliberately left alone.** SQLite's coercion answers
the question that was asked there, and `{ when: { contains: '2024-01' } }`
against an ISO column is a genuinely useful way to ask for a month.

A path INTO a typed `Json` column is untouched — that operand really is text:

```js
await db.place.findMany({ where: { addr: { city: { contains: 'Bos' } } } })   // fine
```

## Values a filter cannot take

A filter value has to be something SQLite can bind. An object is not, and it is
refused naming the field:

```js throws
await db.post.findMany({ where: { views: { equals: { n: 1 } } } })
// Error: where clause: field "views" was given an object where a value was
// expected — an operator object belongs one level up (`views: { gt: 1 }`), and
// a nested object needs @type(...) on the column
```

This is worth a rule of its own because of how it used to fail. `bun:sqlite`
reads a plain object as a bag of **named** parameters; a statement built with
positional `?` matches none of its keys, so it ran with *every* binding dropped —
including the WHERE — and raised nothing. The read answered `[]` and the
equivalent write changed nothing while reporting "no such row".

## What cannot be filtered

A key can be a real field and still be unfilterable. Both cases are refused by
name, because unrefused each would answer wrong with no error:

| | why |
| --- | --- |
| `@computed` | not a column. SQLite reads an unresolvable `"comp"` as the **string literal** `'comp'`, so the predicate compares two constants: `{ comp: 'A' }` matches nothing and `{ comp: 'comp' }` matches **everything** |
| `@encrypted` (random IV) | the column holds AES-GCM ciphertext under a random IV, so no plaintext can equal it |

`@encrypted(deterministic: true)` and `@hashed` **are** filterable by equality — the
query value is encoded the same way the column was before comparing. Both answer
`equals` / `not` / `in` / `notIn` and the bare-array shorthand, and both **refuse**
anything else by name (`contains`, `startsWith`, `gt`, …), because an encoding
preserves equality and nothing else.

### Asking without running the query

```js
await db.$checkWhere('post', { comp: 'A' })
// → [{ key: 'comp', path: 'comp', model: 'Post', reason: 'computed', suggestion: null,
//      allowed: ['author', 'authorId', 'id', 'published', 'tags', 'title', 'views'],
//      message: "'comp' is a @computed field on Post — …" }]
```

`$checkOrderBy`'s sibling, same contract: `[]` means no problems, an unknown
accessor also answers `[]` (*I cannot judge this* is not *this is wrong*), and
every flavor of client — root, `$setAuth`, `asSystem`, `$scopedBy` — answers
identically, because filterability is a fact about the schema. `reason` is
`'computed'`, `'encrypted'` or `'unknown'`, so a boundary can say different
sentences for each; `suggestion` carries the *Did you mean* for an unknown key,
and `allowed` lists only keys that can actually be filtered.

**An unfilterable key throws**, on reads and writes alike:

```js throws
await db.post.findMany({ where: { comp: 'A' } })
// ValidationError: where.comp: 'comp' is a @computed field on Post.findMany — it
// is derived in JS after the row is read, so SQLite cannot filter by it. …
```

An **unknown** key throws the same way, with a *Did you mean*, and so does an
unknown operator (`{ email: { contians: 'a' } }`) and an `in` given a string.

### Refused before the first query

Two places name a filter once and use it for every read, so a mistake there is
permanent and invisible. Both are checked when the client is built:

```js throws
await createClient({ path: './schema.lite', db: ':memory:', filters: { post: { comp: 'A' } } })
// Error: createClient: the global filter for "post" cannot be applied — 'comp'
// is a @computed field on Post — …
```

```js throws
await createClient({ db: ':memory:', encryptionKey: 'a'.repeat(64), schema: `
  model Doc {
    id    Int    @id
    owner String @encrypted
    @@allow(read, owner == auth().email)
  }
` })
// Error: Doc: the @@allow(read, …) policy compares a value no row can
// satisfy, so every caller would read this model as empty — "owner" is
// @encrypted under a random IV, so the same value stores different bytes on
// every write and no operand can be encoded to match it — declare it
// @encrypted(deterministic: true) or @hashed to compare it here
```

### An encoded column inside a policy

A policy predicate takes the same operand rewrite a `where` does — the value is
encoded the way the column was, then compared byte to byte — so
`@encrypted(deterministic: true)` and `@hashed` columns work in `@@allow` /
`@@deny` exactly as they work in a filter. `Doc` in the page schema is one:

```lite fragment
model Doc {
  id    Int    @id
  owner String @hashed

  @@allow(read, owner == auth().email)
}
```

The three shapes with no answer are refused when the client is built, because a
policy that matches nothing reads as a table with no data:

| Shape | Why |
| --- | --- |
| plain `@encrypted` | a random IV, so the same value stores different bytes on every write and no operand can be encoded to match it |
| any operator but `==` / `!=` | both encodings preserve equality and nothing else |
| column compared to column | neither side is a value the policy can encode |

`@@allow(create, …)` is exempt — it is evaluated in JS against the data as
written, which is still plaintext. `@@allow(postUpdate, …)` is refused
instead: it reads the row back through the field policy, which strips an
encrypted column, so the comparison would deny every write.

## Soft delete

```js
// Default: live rows only
await db.user.findMany({ where: { accountId: 1 } })

// Include deleted rows
await db.user.findMany({ where: { accountId: 1 }, withDeleted: true })

// Only deleted rows
await db.user.findMany({ where: { accountId: 1 }, onlyDeleted: true })
```

## Row-level policies

When using `$setAuth(user)`, `@@allow` and `@@deny` policies are automatically injected as SQL WHERE conditions. They run in SQLite, not JS — no accidental data exposure from forgetting a filter.

```js
const userDb = db.$setAuth({ id: 1, accountId: 5, role: 'member' })

// @@allow(read, accountId == auth().accountId) → WHERE "accountId" = 5
const mine = await userDb.invoice.findMany()

// Bypass all policies
const all = await db.asSystem().invoice.findMany()
```

See [access-control.md](./access-control.md) for the full policy syntax.

## Global filters

Apply a filter to every query on a model, regardless of call site. The key is
the model's ACCESSOR (`post`, `user` — singular):

```js
const db = await createClient({
  path:    './schema.lite',
  db:      ':memory:',
  filters: {
    post: { published: true },
    user: (ctx) => ({ accountId: ctx.auth?.accountId }),
  },
})

// Every db.post.findMany() automatically adds WHERE published = 1
// Every db.user.findMany() automatically adds WHERE accountId = <auth accountId>
```

Dynamic filters (function form) receive `ctx` so they can reference `ctx.auth`.
A static filter naming a field the model does not have is refused when the
client is built — see *Refused before the first query* above — and so is a key
that is no model's accessor (`posts`, `Post`), which would otherwise filter nothing.

## Relation filters

Filter parent rows by conditions on a related model — compiles to a correlated
`EXISTS` subquery (no join, no row duplication):

```js
// authors who have at least one published post
await db.author.findMany({ where: { posts: { some: { published: true } } } })

// authors with no published posts (or no posts at all)
await db.author.findMany({ where: { posts: { none: { published: true } } } })

// authors whose posts are ALL published (vacuously true when they have none)
await db.author.findMany({ where: { posts: { every: { published: true } } } })
```

`some` / `every` / `none` work on `hasMany` and implicit many-to-many relations.
For a to-one (`belongsTo`) relation use `is` / `isNot`:

```js
await db.post.findMany({ where: { author: { is:    { name: 'Ann' } } } })
await db.post.findMany({ where: { author: { isNot: { name: 'Ann' } } } })
```

Relation filters compose with scalar filters and `AND`/`OR`/`NOT`, and nest
(a relation filter's inner `where` can itself contain relation filters).
Each nested key resolves against the model it sits in, so a tag-shaped
relation is filtered by anything on the tag, not only its id:

```js
// Issue → IssueLabel → Label
await db.issue.findMany({ where: { labels: { some: { label: { is: { name: 'bug' } } } } } })
```

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

## Raw SQL — `$raw`

For predicates the structured builder can't express. Uses the `sql` tagged template for safe parameter binding — values are extracted as `?` params, never concatenated:

```js
import { sql } from '@frontierjs/litestone'

const state    = 'CA'
const minPrice = 20

// Simple raw predicate
await db.product.findMany({
  where: { $raw: sql`price > iif(state = ${state}, ${minPrice}, 100)` }
})

// json_extract
await db.order.findMany({
  where: { $raw: sql`json_extract(meta, '$.tier') = ${3}` }
})

// Date arithmetic
await db.subscription.findMany({
  where: { $raw: sql`julianday('now') - julianday(createdAt) > ${30}` }
})

// Mixed with structured where — ANDed together
await db.order.findMany({
  where: {
    status: 'active',
    $raw:   sql`json_extract(meta, '$.tier') = ${3}`,
  }
})

// Composed inside AND / OR
await db.task.findMany({
  where: {
    AND: [
      { completedAt: null },
      { $raw: sql`julianday(dueAt) - julianday(startedAt) <= ${30}` },
    ]
  }
})
```

`$raw` works everywhere `where:` is accepted: `findMany`, `findFirst`, `count`, `exists`, `update`, `updateMany`, `remove`, `removeMany`, `aggregate`, `groupBy`.

**Only a `sql` tag value is accepted, at any depth.** A plain string, or an object shaped like the tag's result, is refused with a `ValidationError` naming its path (`FJS-D613`). A string is how a caller's text arrives — `?NOT[$raw]=…` parses to `{ NOT: { $raw: '…' } }`, below where the API's `$` refusal looks — and JSON cannot produce the tag's brand. With nothing to interpolate, the tag is still the spelling: ``sql`deletedAt IS NULL` ``.

### The clock — `now()`

**`datetime('now')` is refused by name, and this is why.** `DateTime` is stored
as ISO-8601 TEXT — `2026-08-13T07:38:31.984Z` — and every comparison against it
is string-wise. SQLite answers `datetime('now')` as `2026-08-13 07:38:31`: space
separator, no milliseconds, no zone. `'T'` (0x54) sorts above a space (0x20), so
**every row stored today compares greater than a same-day `datetime('now')`**.
The predicate is right for yesterday's rows and wrong for this morning's, which
is why it survives a demo: seed it with last week's data and it passes.

```js
import { sql, now } from '@frontierjs/litestone'

await db.task.findMany({ where: { $raw: sql`dueAt < ${now()} AND completedAt IS NULL` } })
await db.task.findMany({ where: { $raw: sql`startedAt > ${now('-7 days')}` } })
await db.task.findMany({ where: { $raw: sql`dueAt < ${now('start of day')}` } })
```

`now()` emits SQLite's clock in the format the column holds, so every occurrence
in one statement is the same instant — SQLite fixes `'now'` for the duration of a
statement, which two `new Date()` calls cannot promise. The consequence is that
`createClient({ now })` does **not** reach it: that clock belongs to the policy
evaluator, and a test that needs a frozen instant binds its own ISO string.

Modifiers are **bound as parameters**, not spliced, so a caller-supplied string
never enters the SQL pattern.

`now()` also works written as a **token** in the `sql` tag, and in a
`@from(where: …)` — the expression language, compiled once — where it reads
the clock `createClient({ now })` was given:

```lite
model Account {
  id           Int    @id
  tasks        Task[]
  overdueCount Int    @from(Task, count: true, where: dueAt < now())
}

model Task {
  id        Int       @id
  dueAt     DateTime?
  accountId Int?
  account   Account?  @relation(fields: [accountId], references: [id])
}
```

```js
await db.task.findMany({ where: { $raw: sql`dueAt < now()` } })
```

Six spellings are refused — `datetime('now')`, `date('now')`, `time('now')`,
`CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME` — in the `sql` tag.
Each produces a format no stored `DateTime` can equal, so a comparison against
one does not return too few rows; it answers a different question.

```js throws
await db.task.findMany({ where: { $raw: sql`dueAt < datetime('now')` } })
// Error: raw SQL: `datetime('now')` cannot match a stored DateTime. …
```

**`julianday()` is untouched.** It answers a number, so
`julianday('now') - julianday(createdAt) > 30` compares like with like — which is
why the date-arithmetic example above is correct as written.

## `@@scope` — a named predicate

A scope is a `where` the schema names, asked for by that name:

```lite
model Task {
  id          Int       @id
  ownerId     Int
  status      String
  dueAt       DateTime?
  completedAt DateTime?

  @@scope(overdue, dueAt < now() && completedAt == null)
  @@scope(mine,    ownerId == auth().id)
  @@scope(active,  status == 'open' || status == 'review')
}
```

```js
await db.task.findMany({ where: { $scope: 'overdue' } })
await db.task.findMany({ where: { $scope: ['overdue', 'mine'] } })     // AND
await db.task.findMany({ where: { $scope: 'mine', status: 'open' } })  // AND
await db.task.findMany({ where: { OR: [{ $scope: 'overdue' }, { id: 5 }] } })
```

The body is the expression language `@@allow` uses, so this is the policy
compiler **named and made explicit** rather than implicit and always-on.
`now()` resolves to one instant for the whole statement, and `auth()` is the
calling client's principal — so `mine` means whoever is asking.

**Why it exists when `createClient({ scopes })` already chains.** A browser
cannot invoke `db.task.overdue()`. A client sends a `where` **object** over
HTTP, so a scope declared in JavaScript is server-only; `$scope` is the one
spelling that travels. Which tier to reach for:

| | |
| --- | --- |
| the UI ever RENDERS the value | `@derived` — it becomes a real property |
| it only ever appears in a `WHERE` | `@@scope` |
| the server alone ever asks for it | `createClient({ scopes })` |

A disjunction is written **inside** a scope (`@@scope(active, a \|\| b)`), where
both compilers can see it — several `$scope` names always AND.

### Safety

The value of `$scope` is caller-supplied, and it is a **name looked up in the
declared table** — never text interpolated into a pattern (Invariant 8). An
unknown name is refused before any SQL is built, and the refusal lists what the
model declares:

```js throws
await db.task.findMany({ where: { $scope: 'ovrdue' } })
// ValidationError: where.$scope: Unknown scope 'ovrdue' — Task.findMany declares: active, mine, overdue
```

`db.$scopes('task')` publishes the same list as `{ name: 'source text' }`, which
is what `$checkWhere` validates against, so a UI offering scopes and the client
refusing one cannot disagree. Everything the schema can decide is decided at
startup: a name declared twice, or a predicate naming a column the model does
not have — which would otherwise reach SQLite as a quoted identifier it reads as
a string constant, silently admitting or excluding every row.

```js
await db.$scopes('task')
// → { overdue: 'dueAt < now() && completedAt == null', mine: 'ownerId == auth().id', active: "status == 'open' || status == 'review'" }
```
