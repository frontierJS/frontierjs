# Writing rows

`create`, `update`, `upsert` and `remove` each write one row and return it. The `Many` forms return `{ count }`. An explicit `null` clears a field; a key left out is untouched.

```lite
model Contact {
  id    Int     @id
  email String  @unique
  name  String
  phone String?
  views Int     @default(0)
}
```

```js
const c = await db.contact.create({ data: { email: 'ann@example.com', name: 'Ann', phone: '555-0100' } })

const cleared = await db.contact.update({ where: { id: c.id }, data: { phone: null } })
if (cleared.phone !== null || cleared.name !== 'Ann') throw new Error('null should clear phone and leave name')

const same = await db.contact.update({ where: { id: c.id }, data: { name: undefined, views: { increment: 1 } } })
if (same.name !== 'Ann' || same.views !== 1) throw new Error('undefined is omitted, increment is atomic')

await db.contact.upsert({ where: { email: 'ann@example.com' }, create: { email: 'ann@example.com', name: 'New' }, update: { name: 'Annie' } })
const bulk = await db.contact.updateMany({ where: { name: 'Annie' }, data: { name: 'Ann' } })
if (bulk.count !== 1) throw new Error('updateMany returns a count')

await db.contact.delete({ where: { id: c.id } })
if (await db.contact.count() !== 0) throw new Error('row should be gone')
```

## What else it can do

- `create` returns the inserted row, and `createMany` returns `{ count }`
- `update` returns `null` when nothing matched
- `updateMany`, `upsertMany`, `removeMany` and `deleteMany` return `{ count }` only
- `upsertMany` takes a `conflictTarget` and the columns to `update`
- `remove` soft-deletes on a `@@softDelete` model, and `restore` brings a row back
- `delete` always removes the row, even on a soft-delete model
- `increment`, `decrement`, `multiply` and `divide` change a number in one statement
- `push` appends to an array column, and `$merge` patches one key of a `Json` document

**In depth:** [Querying § Write operations](../../querying.md#write-operations), [§ Atomic update operators](../../querying.md#atomic-update-operators), [§ $merge](../../querying.md#merge--changing-one-key-of-a-document)
