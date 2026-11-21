# Choosing a field

Two questions pick the attribute for a value: is there a column, and who computes it, and when?

The answers decide whether a caller can write it and whether a query can name it.

```lite
model Line {
  id        Int      @id
  title     String                         // the caller supplies it
  qty       Int      @default(1)           // the caller may, SQLite fills it otherwise
  number    String   @immutable            // the caller, once, at create
  amount    Int      @generated(qty * 2)   // SQLite, from this row
  late      Boolean  @derived(qty > 5)     // SQLite, in the SELECT
  coupon    String?  @transient            // input only, nothing stores it
}
```

```js
const l = await db.line.create({ data: { title: 'Rope', number: 'L-1', qty: 4 } })
const flagged = await db.line.findMany({ where: { late: false }, orderBy: { amount: 'desc' } })
if (l.amount !== 8 || flagged.length !== 1) throw new Error('unexpected row')
```

## What else it can do

| Attribute | Column | Caller writes | Filter and sort | Computed by |
| --- | --- | --- | --- | --- |
| plain field | yes | yes | yes | the caller |
| `@default(...)` | yes | yes | yes | SQLite, on insert |
| `@system` | yes | no, the app names it | yes | the application |
| `@immutable` | yes | at create only | yes | the caller, once |
| `@guarded` | yes | `asSystem()` only | `asSystem()` only | the application |
| `@generated` | yes | no | yes | SQLite, per read or write |
| `@derived` | no | no | yes | SQLite, in the SELECT |
| `@from(Model, ...)` | no | no | yes, but no `groupBy` | SQLite, a subquery |
| `@computed` | no | no | no | JavaScript, after the read |
| `@transient` | no | yes, nothing stores it | no | nobody |

Every no in the write column is a refusal that names the attribute.

`@system` and `@guarded` are access rules, so a schema holding either refuses every model with no `@@gate`, `@@allow` or `@@deny` below `asSystem()`, the model carrying the column included. `@@gate(0)` on a model declares it public.

**In depth:** [Modeling § Which feature makes this field?](../../modeling.md#which-feature-makes-this-field)
