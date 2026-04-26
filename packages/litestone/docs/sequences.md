# Sequences

## Overview

`@sequence` provides per-scope auto-increment — a counter that restarts for each unique value of a scope field. The canonical use case is per-account document numbers that start at 1 and increment independently per account.

```prisma
model Invoice {
  id            Integer @id
  accountId     Integer
  invoiceNumber Integer @sequence(scope: accountId)
  amount        Real
  createdAt     DateTime @default(now())
}
```

```js
const inv1 = await db.invoice.create({ data: { accountId: 1, amount: 100 } })
const inv2 = await db.invoice.create({ data: { accountId: 1, amount: 200 } })
const inv3 = await db.invoice.create({ data: { accountId: 2, amount: 50 } })

inv1.invoiceNumber  // → 1  (first for account 1)
inv2.invoiceNumber  // → 2  (second for account 1)
inv3.invoiceNumber  // → 1  (first for account 2 — independent counter)
```

## Formatting

Sequence values are plain integers. Format them in application code:

```js
// Zero-padded
String(inv1.invoiceNumber).padStart(5, '0')  // → '00001'

// With prefix
`INV-${String(inv1.invoiceNumber).padStart(4, '0')}`  // → 'INV-0001'

// With year
`${new Date().getFullYear()}-${inv1.invoiceNumber}`    // → '2024-1'
```

## How it works

On create, Litestone runs a `SELECT MAX(sequenceField) + 1` scoped to the FK value inside the write transaction — no separate sequence table, no gaps from rollbacks on other records. The value is computed and locked atomically within the SQLite write transaction.

## Multiple sequence fields

A model can have multiple `@sequence` fields with different scopes:

```prisma
model Document {
  id          Integer @id
  accountId   Integer
  projectId   Integer
  docNumber   Integer @sequence(scope: accountId)    // per-account
  taskNumber  Integer @sequence(scope: projectId)    // per-project
}
```

## Scope on composite FK

Use a compound scope by passing an array:

```prisma
model LineItem {
  id         Integer @id
  accountId  Integer
  orderId    Integer
  lineNumber Integer @sequence(scope: [accountId, orderId])
}
```

Each `(accountId, orderId)` pair gets its own counter.

## Interaction with createMany

`createMany` assigns sequences correctly — each row in the batch gets the next value in its scope's sequence, in the order the rows appear in the data array. The batch is processed inside a single transaction.
