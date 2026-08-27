# Exact numbers — `@scale` and `@money`

`.lite` has `Int` and `Float` and nothing between them, and SQLite has no
fixed-point type to put there. So an exact quantity — a price, a reorder point,
a rate — gets modelled as a float and hoped over.

`Int @scale(n)` is the fix, and `@money` is a step on top of it. Ruled in
`FJS-D142`.

## `@scale(n)` — the point sits n places in

```
model StockLine {
  id            Int @id @default(autoincrement())
  weeklyDemand  Int @scale(6)     // 1_500_000 is 1.5
  safetyStock   Int @scale(4)
}
```

The column is an `INTEGER` and stays one. Nothing about the DDL changes, and the
type is true: an attribute that quietly turned an `Int` into a scaled `Float`
would mean `Float` meant two things depending on a token further down the line.

**What a caller sends and reads back is the whole number of minor units.** A
value with a fraction is refused by name:

```
db.stockLine.create({ data: { weeklyDemand: 1.5 } })
// ValidationError — weeklyDemand: must be a whole number of minor units —
//                   the column holds 6 decimal place(s), so 12.99 is 1299
```

That refusal is most of the feature. Without it the same write is stopped by
SQLite saying `cannot store REAL value in INTEGER column stock_line.weekly_demand`
— true, about a physical column, and no help at all.

At most **9 places**. A signed 64-bit integer holds about 9.2 × 10¹⁸, so nine
places still leaves nine figures in front of the point; past that the headroom
goes somewhere nobody is looking.

## `@money` — the currency declares the scale

```
model Order {
  id        Int    @id @default(autoincrement())
  total     Int    @money(USD)              // scale 2
  tip       Int    @money(JPY)              // scale 0 — the yen has no minor unit
  refund    Int    @money(field: currency)  // the code is on the row
  currency  String @length(3, 3) @upper
  fee       Int    @money                   // the app's default currency
}
```

**Scale is not a free parameter for money.** JPY has no minor unit, USD has two,
KWD has three. An author asked for a number has to know the ISO 4217 table by
heart; the currency already knows it. That is what makes `@money` its own
attribute rather than `@scale` with an argument prefilled — and `@scale` and
`@money` together are refused, because they would be two answers to where the
point is.

**The table is not shipped here.** Both facts come from ICU:

| | |
| --- | --- |
| the minor units | `Intl.NumberFormat(…).resolvedOptions().maximumFractionDigits` |
| whether the code is real | `Intl.supportedValuesOf('currency')` — 306 of them |

The second is load-bearing. `Intl.NumberFormat` does **not** throw on an unknown
code — `ZZZ` and `BTC` both resolve to two decimals in silence — so a mistyped
`@money(UDS)` would take scale 2 and be wrong by a factor of a hundred wherever
the real currency has none. Litestone refuses an unrecognised code at parse.

### Per-row currency

`@money(field: currency)` names a sibling `String` column holding the code. One
declaration, two columns — the shape django-money settled on, and the one a shop
taking more than one currency needs. The scale is then not statically known, so
nothing derives it at parse; the column is validated as a whole number and the
reader resolves the currency from the row.

## What comes back in JS

The integer. `1299`, not `12.99`.

Every prior art returns something exact — Rails a `Money`, Prisma a `Decimal`,
Django a `Decimal`, Stripe an integer — and none of them returns a float.
Reading back `12.99` would put a float back at the boundary the column exists to
move it off, and would make `total Int @money(GBP)` a column the Data boundary
happily adds to a float.

Formatting is `formatMoney` in `@frontierjs/toolbelt/units`, which turns on the
same minor-unit fact:

```js
import { formatMoney, minorUnits } from '@frontierjs/toolbelt/units'

const scale = minorUnits('USD')            // 2
formatMoney(order.total / 10 ** scale, 'USD')   // '$12.99'
```

## What this does NOT do

**Rounding and allocation are the application's.** `@scale` makes the stored
value exact and refuses a fraction at the boundary. It does not decide
round-half-up against banker's rounding, and it does not decide which line of a
split bill gets the leftover penny. Every prior art keeps those in a value
object, and so does this: see `example/api/src/pricing.ts`, which owns one
`round2()` for the whole shop.

**Changing `n` is a migration that rescales every stored row**, and nothing here
does it for you. `@@transitions` and `@encrypted` both changed a column's
meaning without rewriting bytes; this one would.

**Aggregating across currencies is not prevented.** `SUM` over a `@money(field:)`
column adds unlike things, and the schema cannot see it. Group by the currency
column.

## On the wire

`x-scale` and `x-money` travel in the JSON Schema beside `type: 'integer'`:

```json
{ "type": "integer", "x-scale": 6 }
{ "type": "integer", "x-money": { "currency": "USD" } }
{ "type": "integer", "x-money": { "field": "currency" } }
{ "type": "integer", "x-money": {} }
```

The scale is **not** resolved into `x-money` for the `field:` form — it is not
knowable from the schema there, and a number that is right two thirds of the
time is worse than an absent one.

## See also

- `docs/schema.md` — the rest of the field attributes
- `packages/toolbelt/src/units/units.js` — `formatMoney`, `minorUnits`
- `DECISIONS.md` § `FJS-D142` — why an attribute rather than a `Decimal` scalar,
  and why the aggregate argument for it was retired after measurement
