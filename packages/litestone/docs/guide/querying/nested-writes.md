# Nested writes

A write can create, connect or disconnect related rows in the same call, so a parent and its children go in together. Litestone writes them in the order the foreign keys need.

```lite
model Author {
  id    Int    @id
  name  String
  posts Post[]
}

model Post {
  id       Int      @id
  title    String
  author   Author   @relation(fields: [authorId], references: [id])
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
const ann = await db.author.create({ data: { name: 'Ann', posts: { create: [{ title: 'One' }, { title: 'Two' }] } } })
if (await db.post.count({ where: { authorId: ann.id } }) !== 2) throw new Error('children were not created')

const bob  = await db.author.create({ data: { name: 'Bob' } })
const post = await db.post.create({ data: { title: 'Three', author: { connect: { id: bob.id } } } })

await db.tag.createMany({ data: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] })
await db.post.update({ where: { id: post.id }, data: { tags: { connect: [{ id: 1 }, { id: 2 }] } } })
await db.post.update({ where: { id: post.id }, data: { tags: { disconnect: [{ id: 2 }] } } })

const loaded = await db.post.findFirst({ where: { id: post.id }, include: { tags: true } })
if (loaded.tags.length !== 1 || loaded.tags[0].label !== 'a') throw new Error('connect/disconnect disagree')
```

## What else it can do

- `create` on a to-one makes the parent first, and `connect` points at one that exists
- `create` on a to-many makes the children after the parent
- `connect` and `disconnect` take a list on a many-to-many
- The whole call is one write, so a refused child leaves nothing behind
- A foreign key is enforced, so a parent named by id has to exist

**In depth:** [Relations § Nested writes](../../relations.md#nested-writes)
