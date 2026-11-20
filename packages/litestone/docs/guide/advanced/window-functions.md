# Window functions

A `window` adds computed columns to each row from the rows around it: rankings, running totals, the previous row's value. Unlike `aggregate()`, no row is collapsed.

```lite
model Order {
  id        Int    @id
  accountId Int
  amount    Float
}
```

```js
await db.order.createMany({ data: [
  { accountId: 1, amount: 10 },
  { accountId: 1, amount: 30 },
  { accountId: 1, amount: 20 },
] })

const rows = await db.order.findMany({
  where:   { accountId: 1 },
  orderBy: { id: 'asc' },
  window:  {
    rn:      { rowNumber: true, orderBy: { id: 'asc' } },
    running: { sum: 'amount',   orderBy: { id: 'asc' } },
  },
})
if (rows.length !== 3 || rows[2].rn !== 3 || rows[2].running !== 60) throw new Error('window columns are wrong')
```

Each key in `window` becomes a column on every row, alongside the row's own fields.

## What else it can do

- `rank`, `denseRank`, `percentRank`, `cumeDist` and `ntile` number rows by an `orderBy`
- `partitionBy` restarts the computation per group, on one field or several
- `lag` and `lead` read the previous or next row, with `offset` and `default`
- `firstValue`, `lastValue` and `nthValue` pick a row from the window
- `sum`, `avg`, `min`, `max` and `count` run over the window
- `rows: [-6, 0]` and `range: [-1, 1]` set a rolling frame, with `null` for unbounded
- `filter` restricts which rows enter an aggregate window
- A `limit` applies after the window is computed, so numbering is right on every page
- A `select` keeps a window column only if it names it

**In depth:** [Window functions § Positional functions](../../window-functions.md#positional-functions), [§ Partition BY](../../window-functions.md#partition-by), [§ Adjacent row functions](../../window-functions.md#adjacent-row-functions), [§ Running aggregates](../../window-functions.md#running-aggregates), [§ Rolling window](../../window-functions.md#rolling-window-frame-spec), [§ FILTER (WHERE)](../../window-functions.md#filter-where)
