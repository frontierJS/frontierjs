# Relations

A relation links two models through a foreign key. The model holding the key declares `@relation`; the other side names the model and is inferred.

```lite
model Author {
  id    Int    @id
  name  String
  posts Post[]
}

model Post {
  id       Int      @id
  title    String
  author   Author   @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId Int
  tags     Tag[]
}

model Tag {
  id    Int    @id
  label String
  posts Post[]
}
```

```js
const ann = await db.author.create({ data: { name: 'Ann', posts: { create: [{ title: 'Hello', tags: { create: [{ label: 'intro' }] } }] } } })

const posts = await db.post.findMany({ include: { author: true, tags: true } })
if (posts[0].author.name !== 'Ann' || posts[0].tags[0].label !== 'intro') throw new Error('relations did not load')
```

`Post[]` and `Tag[]` on both sides make a many-to-many, and the join table is written for you.

## What else it can do

- A one-to-one is a foreign key that is `@unique`, with a bare `Profile?` on the other side
- `onDelete: Cascade`, `SetNull` and the other referential actions
- `@relation("name")` labels a relation when two run between the same models
- The implicit join table is an ordinary table, `_post_tag` here, named from the two models
- A foreign key is enforced, so the parent must exist
- `include`, `select` and nested writes read and write across a relation

**In depth:** [Relations § Defining relations](../../relations.md#defining-relations), [§ One-to-one](../../relations.md#one-to-one), [§ The implicit join table](../../relations.md#the-implicit-join-table)
