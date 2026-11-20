# Raw SQL

For a predicate the structured `where` cannot say, `$raw` takes a `sql` tagged template. Values are bound as parameters and never concatenated into the statement.

```lite
model Product {
  id    Int    @id
  name  String
  price Float
  state String
}
```

```js
import { sql } from '@frontierjs/litestone'

await db.product.createMany({ data: [
  { name: 'A', price: 30, state: 'CA' },
  { name: 'B', price: 10, state: 'CA' },
  { name: 'C', price: 120, state: 'NY' },
] })

const state = 'CA'
const minPrice = 20
const rows = await db.product.findMany({
  where: { $raw: sql`price > iif(state = ${state}, ${minPrice}, 100)` },
  orderBy: { name: 'asc' },
})
if (rows.map(r => r.name).join() !== 'A,C') throw new Error('expected A and C')
```

A value in `${...}` is a bound `?`, so a caller's text cannot change the shape of the query.

## What else it can do

- `$raw` sits beside structured filters, ANDed with them, or inside `AND` and `OR`
- It works wherever `where` does: reads, updates, deletes, `count`, `aggregate` and `groupBy`
- Only a `sql` tag value is accepted, at any depth; a plain string is refused by name
- `now()` emits the clock in the format a `DateTime` column holds, and `datetime('now')` is refused
- `json_extract` and `julianday` work as in SQLite
- `$raw` keeps the model's policies, since it is only a predicate inside the where
- `db.sql` runs a whole statement, and on a schema with access rules it needs `asSystem()`

**In depth:** [Filtering § Raw SQL](../../filtering.md#raw-sql--raw), [§ The clock](../../filtering.md#the-clock--now)
