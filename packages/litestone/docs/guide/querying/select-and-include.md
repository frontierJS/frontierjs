# `select` and `include`

`select` returns only the columns you name, and `include` loads related rows alongside. Both nest, and `include` can count relations without fetching them.

```lite
model Author {
  id    Int    @id
  name  String
  email String
  posts Post[]
}

model Post {
  id       Int    @id
  title    String
  author   Author @relation(fields: [authorId], references: [id])
  authorId Int
}
```

```js
const ann = await db.author.create({ data: { name: 'Ann', email: 'ann@example.com', posts: { create: [{ title: 'One' }, { title: 'Two' }] } } })

const slim  = await db.author.findMany({ select: { id: true, name: true } })
const posts = await db.post.findMany({ include: { author: { select: { name: true } } } })
const withN = await db.author.findMany({ include: { _count: true } })

if ('email' in slim[0]) throw new Error('select returned a column it was not asked for')
if (posts[0].author.name !== 'Ann' || 'email' in posts[0].author) throw new Error('include did not project')
if (withN[0]._count.posts !== 2) throw new Error('count missing')

try { await db.author.findMany({ select: ['id'] }) } catch (e) { if (!/select/.test(e.message)) throw e }
```

## What else it can do

- `select` takes an object only; a list is refused by name
- `select: { author: true }` includes a relation from inside a `select`
- `include` nests: `{ account: { include: { plan: true } } }`
- `include: { posts: { where: {...} } }` attaches only matching children
- `_count: { select: { comments: { where: {...} } } }` is a filtered count
- `select: false` on a write skips returning the row, the fastest write path

**In depth:** [Querying § Include](../../querying.md#include-relations), [§ Select](../../querying.md#select-column-projection), [Relations § Include](../../relations.md#include-eager-loading), [§ Relation counts](../../relations.md#relation-counts)
