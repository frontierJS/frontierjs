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

At most **9 places**, and the range is bounded at both ends.

## The range — and it is not int64

SQLite's `INTEGER` is 64-bit, but the value arrives and leaves as a JS `number`,
and `bun:sqlite` returns one on every path — a column read and an aggregate
alike. So the ceiling is **2^53**, not 2^63, and past it the rounded double is
stored and a *different* number is read back with nothing raised:

```
stored 12345678900000001  →  read back 12345678900000000
stored  9007199254740993  →  read back  9007199254740992
```

That is the same failure `prisma#20635` records for `Decimal` on SQLite, one
layer up, and it is the failure this attribute exists to prevent — so the range
is enforced rather than assumed:

| | exact up to (value) | exact up to (minor units) |
| --- | --- | --- |
| `@scale(2)`, `@money(USD)` | 90,071,992,547,409 | 9,007,199,254,740,991 |
| `@scale(6)` | 9,007,199,254 | 9,007,199,254,740,991 |
| `@scale(9)` | **9,007,199** | 9,007,199,254,740,991 |

Money never meets it: two places leaves ninety trillion. Nine places leaves
**seven** figures in front of the point, which is room for any per-unit rate and
not for a running total.

A value past the bound is refused by name at the boundary, and the column
carries a `CHECK` besides:

```sql
"price" INTEGER NOT NULL CHECK ("price" BETWEEN -9007199254740991 AND 9007199254740991)
```

The `CHECK` is there because four writers never reach the boundary — a
migration, a seed, a raw statement, and `asSystem()`, which drops the gate, the
row policies and `@@softDelete` and cannot drop a rule that is in the table.

**A plain `Int` is not bounded**, and has the same ceiling. It makes no
exactness promise, and bounding every integer column in every app to buy back
one is the wrong trade — but a snowflake id kept in an `Int` is the same hazard,
and nothing here reports it.

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

**Rounding and allocation are the application's, and the tools for them are not
here.** `@scale` makes the stored value exact and refuses a fraction at the
boundary. It does not decide round-half-up against banker's rounding, and it
does not decide which line of a split bill gets the leftover penny; a rounding
policy is not a fact about a table. Both live in `@frontierjs/toolbelt/units` as
pure functions over minor units — `roundMinor(value, { mode })` and
`allocate(amount, ratios)` — ruled as `FJS-D154`, with no value object and
nothing handed out by the seed. `example/api/src/pricing.ts` is the worked
caller: one rounding for the whole shop, applied at the two multiplications a
basket cannot avoid — a percentage discount and a tax rate.

**Changing `n` is a migration that rescales every stored row**, and nothing here
does it for you. `@@transitions` and `@encrypted` both changed a column's
meaning without rewriting bytes; this one would.

**More than nine places is not expressible, and that is a shape rather than a
limit to raise.** A per-unit rate wants many places and a small magnitude; a
running total wants the opposite, and no 64-bit integer holds both at once —
`FJS-575`. Postgres answers it with `NUMERIC`; Stripe answers it with two fields,
an integer `unit_amount` beside a `unit_amount_decimal` string of at most twelve
places. Here the rate is `@scale(9)` and the total is the application's, rounded
once — which is the same split, said in one column fewer.

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
