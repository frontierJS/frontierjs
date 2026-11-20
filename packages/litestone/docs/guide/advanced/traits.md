# Traits

A `trait` is a reusable fragment of fields and model attributes, spliced into a model with `@@trait(T)`. Nothing outside the parser needs to know it existed.

```lite
trait Dates {
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([createdAt])
}

trait SoftDelete {
  deletedAt DateTime?
  @@softDelete
}

model Post {
  id    Int    @id
  title String

  @@trait(Dates)
  @@trait(SoftDelete)
}
```

```js
const post = await db.post.create({ data: { title: 'Hello' } })
if (!post.createdAt || post.deletedAt !== null) throw new Error('expected the trait fields')

await db.post.remove({ where: { id: post.id } })
if ((await db.post.count()) !== 0 || (await db.post.count({ withDeleted: true })) !== 1) throw new Error('expected a soft delete')
```

`Post` is exactly what you would get writing the fields inline, so adding a field to a trait changes every model that uses it.

## What else it can do

- A trait may hold fields, validators, relations, `@@allow`, `@@gate`, `@@trail`, `@@index` and `@@unique`
- A trait may include other traits
- `@@createdBy` and `@@updatedBy` stamp authorship from the principal
- A host replaces a trait's field only with `@override`
- Two traits supplying the same field is a parse error
- Model-level attributes are additive, spliced in declaration order with the host's own last
- `@id`, `@@id`, `@@map`, `@@db` and `@@fts` stay with the host and are refused in a trait
- `extend model` adds fields to a model from the other direction

**In depth:** [Traits § Use site](../../traits.md#use-site--traitt), [§ Conflict resolution](../../traits.md#conflict-resolution), [§ Nested traits](../../traits.md#nested-traits), [§ `extend model`](../../traits.md#extend-model--the-other-direction)
