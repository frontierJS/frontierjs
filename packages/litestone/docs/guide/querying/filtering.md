# Filtering

`where` takes plain objects: a value means equals, an operator object means more, and `AND`, `OR` and `NOT` combine them. A filter can also reach through a relation.

```lite
model Author {
  id    Int    @id
  name  String
  posts Post[]
}

model Post {
  id        Int      @id
  title     String
  published Boolean  @default(false)
  views     Int      @default(0)
  tags      String[]
  author    Author   @relation(fields: [authorId], references: [id])
  authorId  Int
}
```

```js
const ann = await db.author.create({ data: { name: 'Ann' } })
const bob = await db.author.create({ data: { name: 'Bob' } })
await db.post.createMany({ data: [
  { title: 'Intro to SQLite', published: true,  views: 120, tags: ['sqlite', 'bun'], authorId: ann.id },
  { title: 'Draft',           published: false, views: 0,   tags: [],                authorId: ann.id },
  { title: 'Other',           published: true,  views: 5,   tags: ['mysql'],         authorId: bob.id },
] })

const popular = await db.post.findMany({ where: { published: true, views: { gte: 100 } } })
const either  = await db.post.findMany({ where: { OR: [{ views: 0 }, { title: { contains: 'Other' } }] } })
const tagged  = await db.post.findMany({ where: { tags: { has: 'sqlite' } } })
const writers = await db.author.findMany({ where: { posts: { some: { published: true } } } })
const anns    = await db.post.findMany({ where: { author: { is: { name: 'Ann' } } } })

if (popular.length !== 1 || either.length !== 2 || tagged.length !== 1 || writers.length !== 2 || anns.length !== 2) throw new Error('filters disagree')
```

## What else it can do

- `gt`, `gte`, `lt`, `lte`, `in`, `notIn` and `not` compare values, and `null` means `IS NULL`
- `contains`, `startsWith` and `endsWith` match text
- `has`, `hasSome`, `hasEvery`, `hasNone`, `isEmpty` and `equals` read an array column
- A bare array, `{ status: ['a', 'b'] }`, means the value is in the list
- `none` and `every` complete `some` on a to-many relation, and `isNot` completes `is`
- `include` takes a `where` to filter the related rows that come back
- `$raw` writes a SQL fragment into a `where`
- Soft-deleted rows, row policies and a model's global `filters` apply without being asked

**In depth:** [Filtering § Basic operators](../../filtering.md#basic-operators), [§ Logical operators](../../filtering.md#logical-operators), [§ Array fields](../../filtering.md#array-fields), [§ Relation filters](../../filtering.md#relation-filters)
