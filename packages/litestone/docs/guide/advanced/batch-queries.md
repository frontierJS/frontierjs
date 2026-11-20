# Batch queries

`db.query(spec)` runs many per-model queries in one snapshot transaction and returns them under the names you gave. It is a whole screen's data in one call.

```lite
model Order {
  id     Int    @id
  status String @default("open")
  amount Int
}
```

```js
await db.order.createMany({ data: [
  { amount: 10 }, { amount: 20, status: 'paid' }, { amount: 30, status: 'paid' },
] })

const { paid, open, revenue } = await db.query({
  paid:    { model: 'order', where: { status: 'paid' } },
  open:    { model: 'order', where: { status: 'open' } },
  revenue: { model: 'order', _sum: { amount: true } },
})
if (paid.length !== 2 || open.length !== 1 || revenue._sum.amount !== 60) throw new Error('batch answered wrong')
```

Each entry routes through the model's `query()`, which picks `findMany`, `aggregate` or `groupBy` from the shape of its arguments.

## What else it can do

- A key that is a model accessor name queries that model; any other name takes `model: 'accessor'`
- Every entry reads from the same snapshot, so related results agree
- One failing entry fails the whole batch and rolls it back
- `$setAuth()` and `asSystem()` give their own `query()`, so policies, gates and guarded fields apply per entry
- The spec is plain JSON, so a handler can pass a posted body straight to `db.$setAuth(user).query(body)`
- `db.<model>.query(args)` is the same dispatcher for one model

**In depth:** [Querying § Unified dispatcher](../../querying.md#unified-dispatcher), [§ Multi-model batch](../../querying.md#multi-model-batch--dbqueryspec), [§ Snapshot consistency](../../querying.md#snapshot-consistency), [§ Failure semantics](../../querying.md#failure-semantics), [§ Auth scoping composes](../../querying.md#auth-scoping-composes)
