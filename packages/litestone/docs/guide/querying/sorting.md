# Sorting

`orderBy` takes a field and a direction, or an array of them applied left to right. It can also sort by a related row's field or by an aggregate of a relation.

```lite
model Author {
  id    Int    @id
  name  String
  books Book[]
}

model Book {
  id       Int     @id
  title    String
  pages    Int?
  author   Author  @relation(fields: [authorId], references: [id])
  authorId Int
}
```

```js
const zed = await db.author.create({ data: { name: 'Zed' } })
const amy = await db.author.create({ data: { name: 'Amy' } })
await db.book.createMany({ data: [
  { title: 'B', pages: 200, authorId: zed.id },
  { title: 'C', authorId: zed.id },
  { title: 'A', pages: 100, authorId: amy.id },
] })

const byTitle  = await db.book.findMany({ orderBy: { title: 'desc' } })
const byAuthor = await db.book.findMany({ orderBy: [{ author: { name: 'asc' } }, { title: 'asc' }] })
const busiest  = await db.author.findMany({ orderBy: { books: { _count: 'desc' } } })
const pages    = await db.book.findMany({ orderBy: { pages: { dir: 'desc', nulls: 'last' } } })

if (byTitle[0].title !== 'C' || byAuthor[0].title !== 'A' || busiest[0].name !== 'Zed' || pages[2].pages !== null) throw new Error('order disagrees')
```

## What else it can do

- `{ dir: 'asc', nulls: 'first' }` places NULLs explicitly
- `{ author: { company: { name: 'asc' } } }` sorts across several to-one hops
- `_count` on a to-many relation, and `_sum`, `_avg`, `_min` and `_max` on a has-many
- `orderBy` on `groupBy` sorts by a group field or an aggregate
- A window function takes the same `orderBy`
- `orderBy: { $raw }` is the escape hatch
- `@collate` on a field sets how text compares

**In depth:** [Sorting § Basic orderBy](../../sorting.md#basic-orderby), [§ NULLS FIRST / LAST](../../sorting.md#nulls-first--last), [§ Relation field orderBy](../../sorting.md#relation-field-orderby-belongsto), [§ Relation aggregate orderBy](../../sorting.md#relation-aggregate-orderby-hasmany--manytomany)
