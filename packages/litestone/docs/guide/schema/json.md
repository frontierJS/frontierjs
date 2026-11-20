# Json with a shape

A `type` declares the shape of a JSON value. `Json @type(T)` validates that shape on every write and gives the field a real TypeScript interface instead of `unknown`.

```lite
type Address {
  street     String
  city       String
  postalCode String
  country    String @default("US")
}

model User {
  id      Int  @id
  name    String
  address Json @type(Address)
}
```

```js
const u = await db.user.create({ data: { name: 'Ann', address: { street: '1 Main', city: 'Boston', postalCode: '02101' } } })
if (u.address.country !== 'US') throw new Error('default did not fill')

const bostonians = await db.user.findMany({ where: { address: { city: 'Boston' } } })
if (bostonians.length !== 1) throw new Error('json filter failed')

try { await db.user.create({ data: { name: 'Bob', address: { street: 's', city: 'c' } } }) } // postalCode missing
catch (e) { if (e.name !== 'ValidationError') throw e }
```

## What else it can do

- A bad write is refused with a path into the document, such as `address.postalCode`
- `where` reaches into the JSON and compiles to `json_extract`
- Types nest, and a type may hold validators like `@email` or `@gte`
- `@type(Address[])` is a list of them
- `Json? @type(Address)` allows null
- `@type(Address, strict: false)` lets extra keys through
- Use a separate model when the shape has its own identity or is queried on its own

**In depth:** [Typed JSON columns](../../json-types.md), [Modeling § `Json` array or join table](../../modeling.md#should-this-be-a-json-array-of-ids-or-a-join-table)
