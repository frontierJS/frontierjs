# Extensible columns

`@@extensible` lets a customer of your app declare their own fields at runtime, without a migration. A Json column holds the values, and a model of declarations says what a form offers.

```lite
enum CustomFieldType { text number }

model CustomField {
  id    Int             @id
  model String          @length(1, 40)
  key   String          @lower @length(1, 40)
  type  CustomFieldType

  @@unique([model, key])
}

model Product {
  id     Int  @id
  name   String
  fields Json @default("{}")

  @@extensible(fields, declaredBy: CustomField)
}
```

```js
await db.customField.create({ data: { model: 'Product', key: 'color', type: 'text' } })
await db.customField.create({ data: { model: 'Other',   key: 'size',  type: 'text' } })

await db.product.create({ data: { name: 'Mug', fields: { color: 'red' } } })

const declared = await db.product.$declaredFields()
if (declared.length !== 1 || declared[0].key !== 'color') throw new Error('expected only the Product declaration')
```

The app writes no hook and no allocator, and the declaring model takes derived CRUD like any other.

## What else it can do

- An undeclared key is still accepted: declaring says what a form offers, not what may be written
- `max: { text: 8, number: 4 }` buys a pool of indexed slots, so a declared key can be filtered without a scan
- The slot is allocated at the Data boundary, first free of the matching kind
- A key declared once the pool is full still stores and displays, and only a query naming it scans
- `$declaredFields()` is scoped to the model and read under the caller's own access
- Under `strategy row` the declarations and the pool are per tenant
- `scope: databaseId` keys declarations per parent row, for a table that owns its own columns
- The column cannot also carry `@type`; a closed, typed column is a second column

**In depth:** [Extensible columns § Declaring is not a whitelist](../../extensible-columns.md#declaring-is-not-a-whitelist), [§ Reading the declarations](../../extensible-columns.md#reading-the-declarations), [§ Making a declared key filterable](../../extensible-columns.md#making-a-declared-key-filterable--max), [§ Per parent row](../../extensible-columns.md#per-parent-row--scope)
