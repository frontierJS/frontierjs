# Sorting

The examples on this page use this schema:

```lite
model Client {
  id         Int      @id
  name       String
  createdAt  DateTime @default(now())
  notes      Note[]
  noteCount  Int      @from(Note, count: true)
  chattiness Int      @computed
}

model Note {
  id       Int    @id
  clientId Int
  client   Client @relation(fields: [clientId], references: [id])
}

model Country {
  id        Int       @id
  name      String
  companies Company[]
}

model Company {
  id        Int     @id
  countryId Int
  country   Country @relation(fields: [countryId], references: [id])
  users     User[]
}

model User {
  id        Int      @id
  companyId Int?
  company   Company? @relation(fields: [companyId], references: [id])
}

model Author {
  id    Int    @id
  name  String
  books Book[]
  posts Post[]
  tags  Tag[]
}

model Book {
  id       Int    @id
  price    Float
  rating   Float?
  authorId Int
  author   Author @relation(fields: [authorId], references: [id])
}

model Tag {
  id      Int      @id
  authors Author[]
}

model Post {
  id        Int      @id
  title     String
  status    String   @default("draft")
  createdAt DateTime @default(now())
  authorId  Int
  author    Author   @relation(fields: [authorId], references: [id])
}

model Task {
  id           Int       @id
  name         String?
  status       String    @default("open")
  priority     Int?
  weight       Int       @default(1)
  dueAt        DateTime?
  snoozedUntil DateTime?
  deletedAt    DateTime?
}

model Order {
  id        Int      @id
  accountId Int
  status    String
  amount    Float
  createdAt DateTime @default(now())
}
```

## What can be sorted

An `orderBy` key must be something SQLite can put in an `ORDER BY`: a stored
column, a `@generated` column, a `@from` field (a correlated subquery aliased
into the SELECT list), or a relation — see the two relation sections below.

**A `@computed` field cannot be sorted.** It is a JS function applied to a row
that has already been fetched, so SQLite has never heard of it and cannot order
or paginate by it. Sorting by one throws, naming what is sortable:

```js throws
await db.client.findMany({ orderBy: { chattiness: 'asc' } })
// ValidationError: orderBy.chattiness: Cannot orderBy 'chattiness' on
// Client.findMany — it is a @computed field, which is a JS function over a row,
// so SQLite can neither sort nor paginate by it. To sort by a derived value make
// it @from or @generated, or store it. Sortable: createdAt, id, name, noteCount
```

An unknown key throws too, with a typo suggestion — as an unknown `where` key
does.

To sort by a derived value, move the derivation into SQL — `@from` for anything
that counts or sums a relation, `@generated` for an expression over the row's own
columns — or store the value in a real column and write it on change.

**A column whose stored text is a storage detail cannot be sorted either.** The
column exists and SQLite will happily order by what is in it — which is a
serialization or an encoding, not the value:

| Column | Ordering by its text means |
| --- | --- |
| `String[]` · `Int[]` · `Enum[]` | the JSON document, so `[10]` sorts before `[9]` and a re-serialized row moves |
| `Json` (typed or not) | whichever key serialized first |
| `File` | the storage reference, not the file |
| `@encrypted` | ciphertext — meaningless, and stable only where the IV is derived from the value |
| `@hashed` | the digest — stable and equally meaningless |

Sorting *within* an array has no definition here; the question is only whether
the column may be a sort key at all, and the answer is no. Sort by a column that
holds the value itself — for an array that usually means a `@from` count, or a
denormalized column written on change.

### Asking without running the query

```js
await db.$checkOrderBy('client', { chattiness: 'asc' })
// → [{ key: 'chattiness', reason: 'computed', suggestion: null,
//      sortable: ['createdAt', 'id', 'name', 'noteCount'], message: 'Cannot orderBy …' }]
```

`$checkWhere`'s sibling, same contract: `[]` means no problems, an unknown
accessor also answers `[]` (*I cannot judge this* is not *this is wrong*), and
every flavor of client — root, `$setAuth`, `asSystem`, `$scopedBy` — answers
identically, because sortability is a fact about the schema. `reason` is
`'computed'`, `'opaque'` or `'unknown'`, so a boundary can say different
sentences for "no such field", "that field is derived in JS" and "that column
stores a serialization, so its text is not the value". Junction's `autoSort` hook
calls it and turns a problem into a 400.

## Basic orderBy

```js
// Single field
await db.post.findMany({ orderBy: { createdAt: 'desc' } })

// Multiple fields — array, applied left-to-right
await db.post.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }] })
```

## NULLS FIRST / LAST

By default SQLite sorts NULLs first on ASC and last on DESC — a NULL is smaller than every value. Override with the object form:

```js
// NULLs sorted to the end regardless of direction
await db.task.findMany({ orderBy: { deletedAt: { dir: 'asc',  nulls: 'last'  } } })
await db.task.findMany({ orderBy: { priority:  { dir: 'desc', nulls: 'first' } } })

// Mixed in a multi-field sort
await db.task.findMany({
  orderBy: [
    { name:  { dir: 'asc', nulls: 'last' } },
    { dueAt: 'desc' },   // plain string still works
  ]
})
```

## Relation field orderBy (belongsTo)

Sort by a field on a related model. Emits a `LEFT JOIN` — no row duplication, composes with all other args:

```js
// Single hop — sort posts by author name
await db.post.findMany({ orderBy: { author: { name: 'asc' } } })

// Two-hop — sort users by their company's country name
await db.user.findMany({ orderBy: { company: { country: { name: 'asc' } } } })

// Mixed flat + relation
await db.post.findMany({
  orderBy: [
    { author:    { name: 'asc' } },
    { createdAt: 'desc' },
  ]
})
```

**Restriction:** only `belongsTo` (FK on this model's table) relations work. `hasMany` is inherently ambiguous for sorting. Use aggregate orderBy instead.

A `select` beside a relation sort can name a column both tables carry:

```js
await db.post.findMany({ orderBy: { author: { name: 'asc' } }, select: { id: true } })
```

## Relation aggregate orderBy (hasMany / manyToMany)

Sort by COUNT/SUM/AVG/MIN/MAX of a related collection. Uses a correlated subquery — no row duplication, works on any table size:

```js
// Sort authors by number of books (hasMany)
await db.author.findMany({ orderBy: { books: { _count: 'desc' } } })

// Sort authors by total revenue (hasMany _sum)
await db.author.findMany({ orderBy: { books: { _sum: { price: 'desc' } } } })

// Sort authors by highest-rated book (hasMany _max)
await db.author.findMany({ orderBy: { books: { _max: { rating: 'asc' } } } })

// Sort authors by number of tags (manyToMany — _count only)
await db.author.findMany({ orderBy: { tags: { _count: 'asc' } } })
```

**Available:** `_count` on `hasMany` and `manyToMany`. `_sum`, `_avg`, `_min`, `_max` on `hasMany` only (aggregating a scalar through a join table requires specifying which field, which manyToMany doesn't have).

## Window function orderBy

Window function `orderBy` uses the same syntax, including NULLS FIRST/LAST:

```js
await db.order.findMany({
  window: {
    rn: {
      rowNumber: true,
      partitionBy: 'accountId',
      orderBy: { createdAt: { dir: 'desc', nulls: 'last' } },
    }
  }
})
```

See [window-functions.md](./window-functions.md).

## groupBy orderBy

```js
await db.order.groupBy({
  by:      ['status'],
  _count:  true,
  _sum:    { amount: true },
  orderBy: { _count: 'desc' },            // by aggregate
  // orderBy: { _sum: { amount: 'asc' } } // by aggregate field
  // orderBy: { status: 'asc' }           // by group field
})

// An array is terms in written order, as in findMany — a total order over two keys
await db.order.groupBy({ by: ['accountId', 'status'], _count: true,
  orderBy: [{ accountId: 'desc' }, { status: 'asc' }] })
```

## `orderBy: { $raw }` — the escape hatch

`where` has had `$raw` all along; the sort side had nothing. Everything
monotonic in a stored column already sorts, and what does not — *snoozed last
regardless of due date*, a weighted score — could not be said at all.

```js
import { sql, now } from '@frontierjs/litestone'

await db.task.findMany({
  orderBy: { $raw: sql`CASE WHEN "snoozedUntil" > ${now()} THEN 1 ELSE 0 END ASC, "dueAt" ASC` },
})

await db.task.findMany({ orderBy: { $raw: sql`("weight" * ${10} + "id") DESC` } })
```

The fragment is the **whole ORDER BY tail**, direction included, because a sort
no builder can express usually needs several keys in an order only the caller
knows. It composes with ordinary keys in the position it is written:

```js
await db.task.findMany({ orderBy: [{ status: 'asc' }, { $raw: sql`"weight" DESC` }] })
```

**It must be a `sql` tag. A plain string is refused by name.** The tag's static
text is written by the app author and its interpolations are bound as
parameters, so a caller-supplied value never enters the pattern (Invariant 8). A
bare string is exactly how a caller-supplied one would arrive, so accepting it
would turn the hatch into an injection.

```js throws
await db.task.findMany({ orderBy: { $raw: '"weight" DESC' } })
// Error: orderBy $raw must be a sql`` tag, not a string — the tag binds its
// values, a string would put them in the pattern.
```

Two places refuse it, because it cannot mean anything there:

| | why |
| --- | --- |
| `findManyCursor` | a cursor encodes every sort key's value off the last row and compares against it. An expression is not a column it can read back — use `limit`/`offset` for a computed sort |
| `groupBy` | its ORDER BY is over the group keys and aggregates, not over the table's columns |

`$checkOrderBy` passes `$raw` through: the fragment names its own columns, so
there is nothing to check — the same standing `where`'s `$raw` has.
