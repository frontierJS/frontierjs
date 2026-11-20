# Aggregates and group-by

`aggregate` computes counts, sums and averages over the matching rows and returns one object. `groupBy` does the same per group and returns one row for each.

```lite
model Order {
  id        Int    @id
  accountId Int
  status    String @default("pending")
  amount    Float
}
```

```js
await db.order.createMany({ data: [
  { accountId: 1, status: 'paid',    amount: 10 },
  { accountId: 1, status: 'paid',    amount: 30 },
  { accountId: 2, status: 'pending', amount: 5 },
] })

const total = await db.order.aggregate({ where: { status: 'paid' }, _count: true, _sum: { amount: true }, _avg: { amount: true } })
if (total._count !== 2 || total._sum.amount !== 40 || total._avg.amount !== 20) throw new Error('aggregate: ' + JSON.stringify(total))

const byStatus = await db.order.groupBy({ by: ['status'], _count: true, _sum: { amount: true }, orderBy: { _count: 'desc' } })
if (byStatus[0].status !== 'paid' || byStatus[0]._count !== 2) throw new Error('groupBy: ' + JSON.stringify(byStatus))

const big = await db.order.groupBy({ by: ['accountId'], _sum: { amount: true }, having: { _sum: { amount: { gt: 20 } } } })
if (big.length !== 1 || big[0].accountId !== 1) throw new Error('having: ' + JSON.stringify(big))
```

## What else it can do

- `_min` and `_max` take fields, such as `_max: { createdAt: true }`
- `_count: { distinct: 'accountId' }` counts distinct values
- `_stringAgg` joins values into one string
- A named aggregate takes a `filter`, so one pass answers several questions
- `having` filters groups after they are formed
- `by` takes several fields, and `orderBy` sorts by a group field or an aggregate
- `groupBy` can bucket a `DateTime` by day, week or month, with gaps filled
- Over no rows, `_count` is `0` and every other value is `null`
- A protected column cannot be aggregated by a caller who cannot read it

**In depth:** [Aggregation § aggregate()](../../aggregation.md#aggregate), [§ Named aggregates + FILTER](../../aggregation.md#named-aggregates--filter), [§ groupBy()](../../aggregation.md#groupby), [§ HAVING](../../aggregation.md#having)
