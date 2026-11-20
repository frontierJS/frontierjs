# Ids and keys

A model's identity is its `@id`. An `Int @id` is SQLite's own row id and costs nothing; reach for a `uuid()` when the id must be known before the insert or appear in a URL.

```lite
model Customer {
  id    Int    @id
  email String @unique
}

model Invoice {
  id    String @id @default(uuid())
  code  String
}

model Membership {
  orgId  String
  userId String
  role   String

  @@id([orgId, userId])
}
```

```js
const c = await db.customer.create({ data: { email: 'a@example.com' } })
const inv = await db.invoice.create({ data: { code: 'INV-1' } })
await db.membership.create({ data: { orgId: 'o1', userId: 'u1', role: 'admin' } })
const m = await db.membership.findUnique({ where: { orgId: 'o1', userId: 'u1' } })
if (c.id !== 1 || inv.id.length !== 36 || m.role !== 'admin') throw new Error('unexpected ids')
```

## What else it can do

- `@default(uuid())`, `@default(ulid())`, `@default(cuid())` and `@default(nanoid())` mint string ids
- `@unique` is a single-column constraint; `@@unique([a, b])` is a composite one
- `@@unique([employeeId], where: effectiveTo == null)` constrains only the rows the predicate admits
- `@@id([a, b])` makes the tuple the key; `findUnique` takes every member
- Two `@id` fields are the same composite key, minus the column order

**In depth:** [Schema § Identity & constraints](../../schema.md#identity--constraints), [§ A key that is a tuple](../../schema.md#a-key-that-is-a-tuple-id), [§ Conditional uniqueness](../../schema.md#conditional-uniqueness-uniquewhere), [Modeling § uuid or `Int`](../../modeling.md#should-this-id-be-a-uuid-or-an-int), [§ natural key](../../modeling.md#can-the-natural-key-be-the-primary-key)
