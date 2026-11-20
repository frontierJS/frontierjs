# Soft delete

`@@softDelete` turns `remove()` into stamping a `deletedAt` column. Every read then hides the row, and `restore()` brings it back.

```lite
model Post {
  id        Int       @id
  title     String
  deletedAt DateTime?

  @@softDelete
}
```

```js
await db.post.create({ data: { id: 1, title: 'Hello' } })
await db.post.remove({ where: { id: 1 } })

const live    = await db.post.count()
const all     = await db.post.count({ withDeleted: true })
const trashed = await db.post.findMany({ onlyDeleted: true })
if (live !== 0 || all !== 1 || trashed.length !== 1) throw new Error('remove should hide the row, not delete it')

await db.post.restore({ where: { id: 1 } })
if (await db.post.count() !== 1) throw new Error('restore should bring it back')
```

The model must declare an optional `deletedAt`, and a schema without one is refused at parse.

## What else it can do

- `findMany`, `count` and `exists` take `withDeleted: true` or `onlyDeleted: true`
- `delete()` still removes the row physically
- `@@softDelete(cascade)` stamps every foreign-key child that is soft-deleting too
- `@hardDelete` on a relation field removes that child's rows when the parent is removed
- `@keep` on a relation field leaves the children live on purpose, and silences the footgun warning
- `restore()` reverses the cascade, bringing back only the children it stamped
- A soft-deleted row keeps its `@unique` values, and reusing one raises `SoftDeletedUniqueError` with a 409
- Releasing a value is a choice: update the deleted row, or `delete()` it for good
- An `@@index` on the model is partial to live rows, and a `@unique` is not
- `@@deny(delete, ...)` can require a state before removal, because `remove()` honors row policies but not the state machine
- A `driver trail` log files `remove` as a `delete` entry with the row as `before`
- `asSystem()` does not lift the soft-delete filter

**In depth:** [Soft delete](../../soft-delete.md), [§ Cascading soft delete](../../soft-delete.md#cascading-soft-delete), [§ @keep on a relation field](../../soft-delete.md#keep-on-a-relation-field--the-children-outlive-the-parent), [§ @unique and a deleted row](../../soft-delete.md#unique-and-a-deleted-row)
