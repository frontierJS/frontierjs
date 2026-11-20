# Numbers and money

An exact quantity is an `Int` with a decimal point declared, never a `Float`. `@money(USD)` is the common case: the currency sets the scale.

```lite
model Order {
  id     Int    @id
  total  Int    @money(USD)
  tip    Int    @money(JPY)
  rate   Int    @scale(4) @lte(1000000)
  size   Int    @unit(MB)
}
```

```js
const o = await db.order.create({ data: { total: 1299, tip: 500, rate: 25000, size: 12 } })
if (o.total !== 1299) throw new Error('money is the whole number of minor units: 1299 is 12.99')

try { await db.order.create({ data: { total: 12.99, tip: 0, rate: 0, size: 1 } }) }
catch (e) { if (e.name !== 'ValidationError') throw e }
```

The column stays an `INTEGER`. What you send and read back is the whole number of minor units, so `1299` is $12.99, and a fraction is refused by name.

## What else it can do

- `@scale(n)` puts the point `n` places in, up to 9
- `@money(USD)` takes its scale from the currency; `@money(field: currency)` reads the code off the row
- `@big` holds values past 2^53, read and written as digit strings
- `@unit(s)` says what a number counts, from a closed table of durations, sizes, lengths and masses
- Bounds like `@gte` and `@lte` compare minor units
- `formatMoney` in `@frontierjs/toolbelt/units` turns minor units into text
- Aggregating a per-row currency across currencies is refused

**In depth:** [Numbers](../../exact-numbers.md)
