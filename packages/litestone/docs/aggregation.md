# Aggregation

The examples on this page use this schema:

```lite
model Order {
  id        Int      @id
  accountId Int
  status    String   @default("pending")
  amount    Float
  total     Float    @default(0)
  ref       String?
  placedAt  DateTime @default(now())
  createdAt DateTime @default(now())

  @@gate(0)
}

model Post {
  id        Int      @id
  status    String   @default("draft")
  createdAt DateTime @default(now())

  @@gate(0)
}

model Person {
  id     Int   @id
  name   String
  salary Float @guarded

  @@gate(1.5.5.5)
}
```

## aggregate()

Returns a single object of computed values across all matching rows.

```js
// Basic aggregates
const stats = await db.order.aggregate({
  where:  { status: 'completed' },
  _count: true,
  _sum:   { amount: true },
  _avg:   { amount: true },
  _min:   { amount: true, createdAt: true },
  _max:   { amount: true },
})
// → { _count: 142, _sum: { amount: 98432.50 }, _avg: { amount: 693.19 }, ... }

// COUNT(DISTINCT field)
const r = await db.order.aggregate({ _count: { distinct: 'accountId' } })
// → { _count: 47 }  (47 distinct accounts)

// string_agg / group_concat
const r2 = await db.order.aggregate({
  _stringAgg: { field: 'status', separator: ', ', orderBy: 'status' }
})
// → { _stringAgg: { status: 'paid, pending, refund' } }
```

Over no rows `_count` is `0` and every other value is `null`.

## Named aggregates + FILTER

Any `_`-prefixed key whose value is an object with a `count`/`sum`/`avg`/`min`/`max` key is a named aggregate. Named aggregates support `FILTER (WHERE ...)` for single-pass pivot queries:

```js
const pivot = await db.order.aggregate({
  _count:        true,
  _countPaid:    { count: true,   filter: sql`status = 'paid'` },
  _countRefund:  { count: true,   filter: sql`status = 'refund'` },
  _sumPaid:      { sum: 'amount', filter: sql`status = 'paid'` },
  _avgPaid:      { avg: 'amount', filter: sql`status = 'paid'` },
  _totalRevenue: { sum: 'amount' },   // named without filter also works
})
// → {
//     _count: 100,
//     _countPaid: 72,  _countRefund: 8,
//     _sumPaid: 3200,  _avgPaid: 44.4,
//     _totalRevenue: 4500
//   }
```

This is one SQL round trip, not multiple queries. `FILTER (WHERE ...)` is a SQLite aggregate modifier — only rows matching the filter condition enter that aggregate.

## groupBy()

Returns an array of rows — each row represents a group with its aggregate values.

```js
// Group by single field
const byStatus = await db.order.groupBy({
  by:      ['status'],
  _count:  true,
  _sum:    { amount: true },
  having:  { _count: { gt: 5 } },       // post-aggregation filter
  orderBy: { _count: 'desc' },
})
// → [{ status: 'paid', _count: 80, _sum: { amount: 4000 } }, ...]

// Group by multiple fields
await db.order.groupBy({
  by:     ['status', 'accountId'],
  _count: true,
})

// Per-group named aggregates with FILTER
await db.order.groupBy({
  by:          ['accountId'],
  _count:      true,
  _countPaid:  { count: true,   filter: sql`status = 'paid'` },
  _sumPaid:    { sum: 'amount', filter: sql`status = 'paid'` },
  orderBy:     { accountId: 'asc' },
})

// COUNT(DISTINCT) per group
await db.order.groupBy({
  by:     ['status'],
  _count: { distinct: 'accountId' },   // distinct accounts per status
})

// string_agg per group
await db.order.groupBy({
  by:         ['accountId'],
  _stringAgg: { field: 'status', separator: ' | ' },
})
```

## Time-series bucketing

Group by a DateTime field at a calendar interval with automatic gap filling:

```js
await db.order.createMany({ data: [
  { accountId: 1, amount: 4200, createdAt: '2024-01-05T00:00:00.000Z' },
  { accountId: 1, amount: 900,  createdAt: '2024-03-20T00:00:00.000Z' },
] })

const monthly = await db.order.groupBy({
  by:       ['createdAt'],
  interval: { createdAt: 'month' },  // year | quarter | month | week | day | hour
  where:    { createdAt: { gte: '2024-01-01', lte: '2024-03-31' } },
  fillGaps: true,     // default when interval present — no missing months
  orderBy:  { createdAt: 'asc' },
  _count:   true,
  _sum:     { amount: true },
})
// → [{ createdAt: '2024-01', _count: 1, _sum: { amount: 4200 } },
//    { createdAt: '2024-02', _count: 0, _sum: { amount: 0 } },  // gap filled
//    { createdAt: '2024-03', _count: 1, _sum: { amount: 900 } }]

// Explicit gap range
await db.order.groupBy({
  by:       ['createdAt'],
  interval: { createdAt: 'day' },
  fillGaps: { start: '2024-01-01', end: '2024-01-31' },
  orderBy:  { createdAt: 'asc' },
  _count:   true,
})

// Disable gap fill (sparse results)
await db.order.groupBy({
  by:       ['createdAt'],
  interval: { createdAt: 'month' },
  fillGaps: false,
  _count:   true,
})
```

Gap fill uses a recursive CTE to generate the full sequence of intervals — no calendar table needed.
Each bound must be a date or an instant (a string `Date.parse` reads, epoch milliseconds or a
`Date`); anything else is a `ValidationError`, and the bound is passed to SQLite as a parameter,
never written into the statement (`FJS-1650`). **Bucket order is not implied**: without an
`orderBy` on the bucket field the filled rows come back before the real ones.

### In a time zone

A month is a place's month: an order at 23:30 UTC on 31 January is February's in Tokyo.
`timeZone` (IANA) cuts the interval on that zone's wall clock:

```js
await db.order.groupBy({
  by:       ['placedAt'],
  interval: { placedAt: 'month' },
  timeZone: 'Asia/Tokyo',
  _sum:     { amount: true },
})
```

SQLite has no zone database, so the zone reaches it as the fixed offsets it keeps across the
rows the call reads — toolbelt's `offsetSpans`, one `CASE` arm per summer-time change, over
only the UTC years that hold rows, named by one extra `DISTINCT` read over the same `where`. A
`9999-12-31` "never" date costs its own year, not the eight thousand between. A gap fill's bounds become that zone's calendar
dates — an instant's date there, and a bound written as a date (`'2026-01-01'`) that date, never
UTC midnight moved west into December. An `hour` bucket on the night the clock goes back holds both 01:00 hours. `timeZone`
without `interval` is refused.

### Weeks

A `week` bucket is labelled by its first date, so a week across New Year is one bucket, not two.
It starts on Monday; `weekStart: 'sunday'` is for a business whose week does. `weekStart` beside
any other unit is refused.

```js
await db.order.groupBy({
  by:        ['placedAt'],
  interval:  { placedAt: 'week' },
  weekStart: 'sunday',
  fillGaps:  false,
  _count:    true,
})
// → [{ placedAt: '2025-12-28', _count: 7 }, { placedAt: '2026-01-04', _count: 3 }]
```

## HAVING

Post-aggregation filter — applied after `GROUP BY`, before `LIMIT`:

```js
await db.order.groupBy({
  by:     ['accountId'],
  _count: true,
  _sum:   { amount: true },
  having: {
    _count: { gte: 10 },
    _sum:   { amount: { gt: 1000 } },
  }
})
```

## findManyAndCount

Returns both the page of rows and the total count in a single query. Both use identical WHERE/policy context — guaranteed consistent.

```js
const { rows, total } = await db.post.findManyAndCount({
  where:   { status: 'published' },
  orderBy: { createdAt: 'desc' },
  limit:   20,
  offset:  40,
})
// total = count ignoring limit/offset — use for pagination UI
// rows  = the page of rows
```

## query() dispatcher

Routes a single args object based on shape — useful for an API handler that hands `req.query` straight through:

```js
await db.order.query({ where: { status: 'paid' }, limit: 20 })          // → findMany
await db.order.query({ _count: true, _sum: { amount: true } })           // → aggregate
await db.order.query({ by: ['status'], _count: true })                   // → groupBy
await db.order.query({ _countPaid: { count: true, filter: sql`status = 'paid'` } })  // → aggregate (named agg)
await db.order.query({ window: { rn: { rowNumber: true, orderBy: { id: 'asc' } } } })  // → findMany + window
```

**Routing rules (checked in order):**
1. `args.by` present → `groupBy(args)`
2. `_count`/`_sum`/`_avg`/`_min`/`_max`/`_stringAgg` or any named agg present → `aggregate(args)`
3. Everything else → `findMany(args)`

All standard args pass through unchanged: `where`, `orderBy`, `limit`, `offset`, `select`, `include`, `window`, `distinct`, `withDeleted`, `$raw`.

---

## What an aggregate may name

An aggregate names a column and takes the value straight out of SQLite. It
builds no row, so neither of the two things `read()` does for a row happens
here — resolving the name, and stripping what the caller may not see — and both
had to be done by hand. Every name is now checked, at every argument that can
carry one:

```js
await db.order.aggregate({ _max: { total: true } })          // _min _max _sum _avg
await db.order.aggregate({ _stringAgg: { field: 'ref', orderBy: 'ref' } })
await db.order.aggregate({ _paid: { max: 'total' } })        // a named aggregate's field
await db.order.aggregate({ _count: { distinct: 'status' } })
await db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'month' } })
```

**Why it matters more here than in a `where`.** SQLite reads a double-quoted
identifier it cannot resolve as a **string constant**, so nothing fails:

```js throws
await db.order.aggregate({ _max: { totl: true } })
// once:  { _max: { totl: 'totl' } }   ← MAX of the one-element set {'totl'}
// now:   ValidationError — Unknown aggregate field 'totl' on Order. Did you mean: total?
```

`_sum` was worse, because it answered `0` — a plausible number with nothing
about it to notice.

Two tiers, and which one an argument takes is what a caller does with the answer:

| Tier | Arguments | Refuses |
| --- | --- | --- |
| naming | `by`, `_count: { distinct }`, `interval` | not a column: `@computed`, `@from`, a relation, a typo |
| value | `_min` `_max` `_sum` `_avg`, `_stringAgg`, a named aggregate's field | the above, **and** a column whose stored text is a storage detail |

A `by:` over an array or `Json` column is kept, because grouping stored text is
self-consistent — every distinct value is its own group, and the group key is
hydrated back into the shape a row read gives it. `MAX` over the same column is
refused: it orders that text, so `['10']` ranks below `['9']`, and `SUM` answers
`0`. Same bucket the [sorting](sorting.md) rules use, said for an aggregate.

### A protected column is protected here too

`@guarded`, `@omit(all)` and `@encrypted` are stripped from a row by `read()`.
They were not stripped from an aggregate, so a signed-in caller could ask for
the maximum salary on a table whose rows never show one — and `_stringAgg` and
`by:` are not aggregates at all in this respect, since one answers every value
joined with commas and the other answers every distinct value with a count.

```js throws
const user = db.$setAuth({ id: 1, role: 'admin' })
await user.person.aggregate({ _max: { salary: true } })
// ValidationError — Cannot aggregate 'salary' on Person — it is @guarded — a
// system-context column. Use asSystem() for a read that is not a caller's.
```

```js
await db.asSystem().person.aggregate({ _max: { salary: true } })   // { _max: { salary: 900 } }
```

A field-level `@allow('read', …)` is **refused rather than evaluated**: it is a
predicate over a row, and an aggregate has no row to decide it against, so there
is no honest answer over some rows and not others.

`@hashed` is refused for everyone, `asSystem()` included — there is no value to
aggregate, only digests.
