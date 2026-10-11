# Sequences

## Overview

`@sequence` provides per-scope auto-increment — a counter that restarts for each unique value of a scope field. The canonical use case is per-account document numbers that start at 1 and increment independently per account.

```lite
model Invoice {
  id            Int @id
  accountId     Int
  invoiceNumber Int @sequence(scope: accountId)
  amount        Float
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

## Written at create, never after

A create may state the number, and the counter moves up to it when it is ahead of the counter (a stated number behind the counter is written as given and moves nothing). A create whose scope column is null gets no number — there is no counter to draw from — and the column stays `null`. An update that names the column is refused (a `ValidationError` naming the field), for `asSystem()` too, and the update JSON Schema marks it `readOnly` so a generated edit form draws no box for it. On a model with a `@seals` move the column is frozen from create rather than from the seal. A renumbered row takes a value the counter has not reached yet, so the next create collides with it, and the failed insert rolls the counter back to that same number.

## Formatting

Sequence values are plain integers. Format them in application code:

```js
const inv1 = await db.invoice.create({ data: { accountId: 1, amount: 100 } })

// Zero-padded
const padded = String(inv1.invoiceNumber).padStart(5, '0')          // → '00001'

// With prefix
const prefixed = `INV-${String(inv1.invoiceNumber).padStart(4, '0')}` // → 'INV-0001'

// With year
const dated = `${new Date().getFullYear()}-${inv1.invoiceNumber}`     // → '2026-1'
```

## How it works

On create, Litestone bumps a counter row in `_litestone_sequences`, keyed by `(model, field, scope)` and created on every database that holds a `@sequence` field, with one `INSERT … ON CONFLICT DO UPDATE … RETURNING` inside the write transaction. SQLite serializes writers, so two creates in one scope cannot draw the same number, and a create that fails rolls its bump back with the row — the next create in that scope takes the number the failed one would have.

## Adding a sequence to a table with rows

A new `@sequence` column is `NOT NULL` with no default, so `migrate create` blocks the section instead of writing it. The blocked section names the recipe: number the existing rows per scope with `ROW_NUMBER() OVER (PARTITION BY <scope> ORDER BY …)` in the rebuild's copy, then seed the counter. A backfill that skips the seed leaves `_litestone_sequences` without a row for the scope, and the next create restarts at 1 beside rows numbered higher, with no error since nothing makes the column unique. The `ORDER BY` in the generated text is the primary key; replace it with the order the rows really arrived in.

## Multiple sequence fields

A model can have multiple `@sequence` fields with different scopes:

```lite
model Document {
  id          Int @id
  accountId   Int
  projectId   Int
  docNumber   Int @sequence(scope: accountId)    // per-account
  taskNumber  Int @sequence(scope: projectId)    // per-project
}
```

## Scope on composite FK

Use a compound scope by passing an array:

```lite failing
// FJS-2302 — the parser does not accept a list here yet
model LineItem {
  id         Int @id
  accountId  Int
  orderId    Int
  lineNumber Int @sequence(scope: [accountId, orderId])
}
```

Each `(accountId, orderId)` pair gets its own counter. The parser does not accept the list form yet (`FJS-2302`); until it does, a sequence scopes on one column.

## Interaction with createMany

`createMany` assigns sequences correctly — each row in the batch gets the next value in its scope's sequence, in the order the rows appear in the data array. The batch is processed inside a single transaction.
