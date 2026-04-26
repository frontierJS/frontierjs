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
