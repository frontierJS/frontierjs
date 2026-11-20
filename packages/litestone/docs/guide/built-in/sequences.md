# Sequences

`@sequence` is a counter that restarts for each value of a scope field, so each account's invoices are numbered 1, 2, 3 on their own.

```lite
model Invoice {
  id            Int   @id
  accountId     Int
  invoiceNumber Int   @sequence(scope: accountId)
  amount        Float
}
```

```js
const a1 = await db.invoice.create({ data: { accountId: 1, amount: 100 } })
const a2 = await db.invoice.create({ data: { accountId: 1, amount: 200 } })
const b1 = await db.invoice.create({ data: { accountId: 2, amount: 50 } })

if (a1.invoiceNumber !== 1 || a2.invoiceNumber !== 2 || b1.invoiceNumber !== 1) throw new Error('each account counts on its own')
```

## What else it can do

- `scope: [accountId, orderId]` keeps one counter per pair
- A model can carry several `@sequence` fields, each with its own scope
- Two creates in one scope never draw the same number
- A failed create gives its number back
- `createMany` numbers rows in array order
- A create may state the number, and the counter moves up to it if it is ahead
- A row whose scope column is null gets no number
- An update that names the column is refused, `asSystem()` too
- Values are plain integers, so `String(n).padStart(5, '0')` formats them in your own code
- Adding one to a table with rows needs a backfill, and `migrate create` shows the recipe

**In depth:** [Sequences](../../sequences.md), [§ Written at create, never after](../../sequences.md#written-at-create-never-after), [§ Adding a sequence to a table with rows](../../sequences.md#adding-a-sequence-to-a-table-with-rows)
