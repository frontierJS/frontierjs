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

An array field (`String[]`, `Int[]`, `Enum[]`) is a JSON column, and every
operator below reads its elements.

```js
{ tags: { has: 'sqlite' } }                  // contains this element
{ tags: { hasEvery: ['sqlite', 'bun'] } }    // contains all of them
{ tags: { hasSome: ['sqlite', 'mysql'] } }   // contains at least one
{ tags: { hasNone: ['mysql'] } }             // contains none of them
{ tags: { in:     ['sqlite', 'mysql'] } }    // same question as hasSome
{ tags: { notIn:  ['mysql'] } }              // same question as hasNone
{ tags: { isEmpty: true } }                  // no elements
{ tags: { equals: ['sqlite', 'bun'] } }      // IS exactly this, in this order
{ tags: { not:    ['sqlite', 'bun'] } }      // is anything else
```

`in` and `notIn` read the elements, like every other operator here — on a scalar
column they compare its one value, on an array column its several. That is what
makes the bare-array shorthand below exactly `in`, in both places.

### A bare array

The shorthand means the same thing on both kinds of column — **the column's
value is in this list**:

```js
{ status: ['active', 'pending'] }   // status IN (…)                one value
{ tags:   ['sqlite', 'bun'] }       // any element IN (…)           several
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

```
where clause: "has" is an array operator and "name" is not an array field
```

## Values a filter cannot take

A filter value has to be something SQLite can bind. An object is not, and it is
refused naming the field:

```js
db.post.findMany({ where: { views: { equals: { n: 1 } } } })
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

A key can be a real field and still be unfilterable, and the two cases fail the
same way — no rows, no error:

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
db.$checkWhere('post', { comp: 'A' })
// → [{ key: 'comp', reason: 'computed', suggestion: null,
//      allowed: [...], message: "'comp' is a @computed field on Post — …" }]
```

`$checkOrderBy`'s sibling, same contract: `[]` means no problems, an unknown
accessor also answers `[]` (*I cannot judge this* is not *this is wrong*), and
every flavour of client — root, `$setAuth`, `asSystem`, `$scopedBy` — answers
identically, because filterability is a fact about the schema. `reason` is
`'computed'`, `'encrypted'` or `'unknown'`, so a boundary can say different
sentences for each, and `allowed` lists only keys that can actually be filtered.

**An unfilterable key throws**, on reads and writes alike:

```js
db.post.findMany({ where: { comp: 'A' } })
// ValidationError: 'comp' is a @computed field on Post.findMany — it is derived
// in JS after the row is read, so SQLite cannot filter by it. …
```

An **unknown** key still only warns on a read (and throws on a write, as it
always did). The two are treated differently on purpose: a typo returns fewer
rows and leaves the caller something to notice, while a key that is real and
spelled correctly leaves nothing at all — `{ comp: 'A' }` answers `[]`, which
reads as *no data*, and `{ comp: 'comp' }` answers **every row**, because SQLite
compares two string constants. A filter that returns rows not matching it cannot
be reported by a warning in a log nobody is reading.

### Refused before the first query

Two places name a filter once and use it for every read, so a mistake there is
permanent and invisible. Both are checked when the client is built:

```js
createClient({ filters: { post: { comp: 'A' } } })
// Error: createClient: the global filter for "post" cannot match any row — …

// @@allow('read', owner == auth().email)  where owner is @encrypted
// Error: Doc: the @@allow('read', …) policy compares a value no row can
// satisfy, so every caller would read this model as empty — …
```

A policy predicate is compiled without the rewrite a `where` gets, so an
encrypted or hashed column cannot appear in one at all, in any mode (`FJS-214`).

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
