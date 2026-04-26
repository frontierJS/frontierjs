# Window Functions

Window functions add computed columns to each row based on a surrounding set of rows (the "window"). Unlike `aggregate()`, they don't reduce rows — every input row appears in the output with extra computed columns alongside it.

Pass a `window` object to `findMany`:

```js
const rows = await db.order.findMany({
  where:   { accountId: 1 },
  orderBy: { id: 'asc' },
  window:  { rn: { rowNumber: true, orderBy: { id: 'asc' } } }
})
// rows[0] → { id: 1, amount: 10, status: 'paid', rn: 1 }
// rows[1] → { id: 2, amount: 30, status: 'paid', rn: 2 }
```

Each key in `window` becomes a computed column on every row.

## Positional functions

Row number, rank, dense rank — require `orderBy` in the window spec:

```js
window: {
  rn:        { rowNumber: true, orderBy: { id: 'asc' } },
  rank:      { rank: true,      orderBy: { score: 'desc' } },
  denseRank: { denseRank: true, orderBy: { score: 'desc' } },
  cumeDist:  { cumeDist: true,  orderBy: { score: 'desc' } },
  pctRank:   { percentRank: true, orderBy: { score: 'desc' } },
  quartile:  { ntile: 4,        orderBy: { score: 'desc' } },
}
```

`rank` assigns the same rank to ties and skips the next ranks (1, 1, 3). `denseRank` assigns the same rank to ties without gaps (1, 1, 2).

## Partition BY

Restart the computation for each partition — like running separate window functions per group:

```js
window: {
  rn: {
    rowNumber: true,
    partitionBy: 'accountId',   // restart row numbers for each account
    orderBy:     { id: 'asc' },
  },
  rank: {
    rank: true,
    partitionBy: ['status', 'accountId'],  // multiple fields
    orderBy:     { score: 'desc' },
  }
}
```

## Adjacent row functions

Access values from the previous or next row in the window ordering:

```js
window: {
  prev:     { lag:  'amount', offset: 1, default: 0, orderBy: { id: 'asc' } },
  prev2:    { lag:  'amount', offset: 2,              orderBy: { id: 'asc' } },
  next:     { lead: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } },
  first:    { firstValue: 'amount', orderBy: { id: 'asc' } },
  last:     { lastValue:  'amount', orderBy: { id: 'asc' } },
  second:   { nthValue: 'amount', n: 2, orderBy: { id: 'asc' } },
}
```

`lag`/`lead` `offset` defaults to 1. `default` is returned when there's no row at that offset (e.g. first row for `lag`, last row for `lead`).

## Running aggregates

`sum`, `avg`, `min`, `max`, `count` as window functions produce a running/cumulative value:

```js
window: {
  runningTotal: { sum:   'amount', orderBy: { id: 'asc' } },
  runningCount: { count: true,     orderBy: { id: 'asc' } },
  runningMin:   { min:   'price',  orderBy: { id: 'asc' } },
  runningMax:   { max:   'price',  orderBy: { id: 'asc' } },
}
```

## Rolling window (frame spec)

Control which rows are included in the aggregate using `rows` or `range`:

```js
window: {
  // 7-period moving average (current row + 6 preceding)
  ma7: { avg: 'price', orderBy: { date: 'asc' }, rows: [-6, 0] },

  // 30-period rolling min
  min30: { min: 'price', orderBy: { date: 'asc' }, rows: [-29, 0] },

  // Cumulative from start of partition to current row (default for running aggs)
  cumul: { sum: 'amount', orderBy: { id: 'asc' }, rows: [null, 0] },

  // Entire partition (unbounded both sides)
  total: { sum: 'amount', rows: [null, null] },

  // Centered window: 3 preceding + current + 3 following
  centered: { avg: 'price', orderBy: { date: 'asc' }, rows: [-3, 3] },
}
```

Frame spec values:
- `null` → `UNBOUNDED PRECEDING` / `UNBOUNDED FOLLOWING`
- `0` → `CURRENT ROW`
- negative number → n `PRECEDING`
- positive number → n `FOLLOWING`

Use `range` instead of `rows` for value-based frames (rather than row-count-based).

## FILTER (WHERE)

Restrict which rows enter an aggregate window function:

```js
window: {
  paidRunning: {
    sum:    'amount',
    filter: sql`status = 'paid'`,
    orderBy: { id: 'asc' },
  },
  countActive: {
    count:  true,
    filter: sql`deletedAt IS NULL`,
    orderBy: { id: 'asc' },
  }
}
```

`FILTER` is only valid on aggregate window functions (`sum`, `avg`, `min`, `max`, `count`). Positional and offset functions (`rank`, `lag`, etc.) do not support it.

## Combined example

Rankings, running totals, period comparison, and filtered aggregates in a single query:

```js
const rows = await db.order.findMany({
  where:   { accountId: 1 },
  orderBy: { id: 'asc' },
  window:  {
    rn:          { rowNumber: true,  partitionBy: 'status', orderBy: { id: 'asc' } },
    rankByAmt:   { rank: true,       partitionBy: 'status', orderBy: { amount: 'desc' } },
    prevAmount:  { lag: 'amount', offset: 1, default: 0, orderBy: { id: 'asc' } },
    pctChange:   { lead: 'amount', offset: 1, orderBy: { id: 'asc' } },
    runningTotal: { sum: 'amount', orderBy: { id: 'asc' } },
    ma3:          { avg: 'amount', orderBy: { id: 'asc' }, rows: [-2, 0] },
    paidTotal:    { sum: 'amount', filter: sql`status = 'paid'`, orderBy: { id: 'asc' } },
  }
})
```

## Performance

When there is no `limit`/`offset`, window functions are inlined directly into the `SELECT` clause — no subquery needed. When pagination is present, a wrapping subquery is used so `LIMIT`/`OFFSET` applies after window computation (correct behavior — otherwise `LIMIT 10` would reduce rows before `RANK()` is computed).
