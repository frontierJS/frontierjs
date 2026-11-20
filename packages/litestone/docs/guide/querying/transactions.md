# Transactions

`$transaction` runs several writes as one unit. If the callback throws, every write inside it is rolled back.

```lite
model Account {
  id      Int    @id
  name    String
  balance Int    @default(0)
}
```

```js
const a = await db.account.create({ data: { name: 'A', balance: 100 } })
const b = await db.account.create({ data: { name: 'B' } })

await db.$transaction(async (tx) => {
  await tx.account.update({ where: { id: a.id }, data: { balance: { decrement: 40 } } })
  await tx.account.update({ where: { id: b.id }, data: { balance: { increment: 40 } } })
})

try {
  await db.$transaction(async (tx) => {
    await tx.account.update({ where: { id: a.id }, data: { balance: 0 } })
    throw new Error('abort')
  })
} catch (e) { if (e.message !== 'abort') throw e }

const after = await db.account.findUnique({ where: { id: a.id } })
if (after.balance !== 60) throw new Error('the aborted write should not stand: ' + after.balance)
```

## What else it can do

- The callback's return value is the transaction's result
- The callback gets `tx`, with the same accessors as `db`
- Transactions open with `BEGIN IMMEDIATE`, so there is no mid-transaction lock upgrade
- A transaction inside a transaction joins the outer one
- Any throw rolls the whole unit back
- A scoped client keeps its policies inside the transaction

**In depth:** [Querying § Transactions](../../querying.md#transactions)
