# Trees

A model related to itself, such as a task with subtasks, is walked with `recursive`: the whole subtree, the path to the root, or a nested tree, in one read.

```lite
model Task {
  id       Int    @id
  title    String
  parentId Int?
  parent   Task?  @relation(fields: [parentId], references: [id])
  children Task[]
}
```

```js
await db.task.createMany({ data: [
  { id: 5, title: 'root' }, { id: 6, title: 'a', parentId: 5 }, { id: 7, title: 'b', parentId: 6 },
] })

const below = await db.task.findMany({ where: { id: 5 }, recursive: true })
const above = await db.task.findMany({ where: { id: 7 }, recursive: { direction: 'ancestors' } })

if (below.length !== 2 || below.find(t => t.id === 7)._depth !== 2) throw new Error('expected two descendants')
if (above.map(t => t.id).sort().join() !== '5,6') throw new Error('expected the path to the root')
```

Every row carries `_depth`, its distance from the anchor, and the anchor itself is never in its own result.

## What else it can do

- `direction: 'descendants'` is the default, `'ancestors'` walks up
- `nested: true` returns each node with a `children` array, and `maxDepth` bounds the walk
- `via` names which self-relation to follow when a model has two
- `orderBy: { _depth: 'desc' }` sorts a tree read by distance
- The gate, row policies and soft delete apply at every level, so a hidden node takes its branch with it
- `select`, `include`, `@computed` and `@from` behave as on any read
- Over Junction's API the same option is `$recursive`
- Only `findMany` walks a tree; `count`, `aggregate` and the rest refuse `recursive` by name
- A write that would make a row its own ancestor is refused, naming the field

**In depth:** [Relations § Recursive tree queries](../../relations.md#recursive-tree-queries), [§ A tree read is an ordinary read](../../relations.md#a-tree-read-is-an-ordinary-read), [§ Cycles](../../relations.md#cycles)
