# Aggregation

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
const monthly = await db.order.groupBy({
  by:       ['createdAt'],
  interval: { createdAt: 'month' },  // year | quarter | month | week | day | hour
  where:    { createdAt: { gte: '2024-01-01', lte: '2024-12-31' } },
  fillGaps: true,     // default when interval present — no missing months
  _count:   true,
  _sum:     { amount: true },
})
// → [{ createdAt: '2024-01', _count: 18, _sum: { amount: 4200 } },
//    { createdAt: '2024-02', _count: 0,  _sum: { amount: 0 } },  // gap filled
//    ...]

// Explicit gap range
await db.order.groupBy({
  by:       ['date'],
  interval: { date: 'day' },
  fillGaps: { start: '2024-01-01', end: '2024-01-31' },
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

Routes a single args object based on shape — useful for generic API handlers:

```js
// API handler that handles all query types
app.get('/orders', async (req) => {
  return db.order.query(req.query)
})

db.order.query({ where: { status: 'paid' }, limit: 20 })          // → findMany
db.order.query({ _count: true, _sum: { amount: true } })           // → aggregate
db.order.query({ by: ['status'], _count: true })                   // → groupBy
db.order.query({ _countPaid: { count: true, filter: sql`...` } })  // → aggregate (named agg)
db.order.query({ window: { rn: { rowNumber: true, ... } } })       // → findMany + window
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
db.order.aggregate({ _max: { total: true } })          // _min _max _sum _avg
db.order.aggregate({ _stringAgg: { field: 'ref', orderBy: 'ref' } })
db.order.aggregate({ _paid: { max: 'total' } })        // a named aggregate's field
db.order.aggregate({ _count: { distinct: 'status' } })
db.order.groupBy({ by: ['status'], interval: { placedAt: 'month' } })
```

**Why it matters more here than in a `where`.** SQLite reads a double-quoted
identifier it cannot resolve as a **string constant**, so nothing fails:

```js
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

```js
const user = db.$setAuth(req.user)
await user.person.aggregate({ _max: { salary: true } })
// ValidationError — Cannot aggregate 'salary' on Person: it is @guarded, a
// system-context column. Use asSystem() for a read that is not a caller's.

await db.asSystem().person.aggregate({ _max: { salary: true } })   // 900
```

A field-level `@allow('read', …)` is **refused rather than evaluated**: it is a
predicate over a row, and an aggregate has no row to decide it against, so there
is no honest answer over some rows and not others.

`@hashed` is refused for everyone, `asSystem()` included — there is no value to
aggregate, only digests.
