# Relationship rules

`@@relator` declares a row that is a relationship, a membership or a subscription, and states the one thing a reader cannot derive: may the same pair appear twice.

```lite
model Workspace {
  id      Int               @id
  members WorkspaceMember[]
}

model User {
  id          Int               @id
  memberships WorkspaceMember[]
}

model WorkspaceMember {
  id          Int       @id
  workspaceId Int
  workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
  userId      Int
  user        User      @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@relator([workspaceId, userId], once)
}
```

```js
await db.workspace.create({ data: { id: 1 } })
await db.user.create({ data: { id: 1 } })
await db.workspaceMember.create({ data: { workspaceId: 1, userId: 1 } })

let refused = false
try {
  await db.workspaceMember.create({ data: { workspaceId: 1, userId: 1 } })
} catch (e) {
  if (!/unique|already/i.test(e.message)) throw e
  refused = true
}
if (!refused) throw new Error('the same member should not join twice')
```

`once` emits the unique key. The repeatability argument is required, so the question is always answered on purpose.

## What else it can do

- `many, by: column` lets a column tell two rows apart, such as a replica index
- A bare `many` emits no key, for a row that is repeatable
- An index is added on every relatum the key does not already cover
- An optional relatum, or one with `onDelete: SetNull`, is refused
- `upsert` refuses to address a repeatable pair
- `@@arc([a, b])` says exactly one of several optional foreign keys is set, with `optional: true` for at most one
- `@minItems(n)` and `@maxItems(n)` on a relation bound its child rows, graded when the write unit commits
- `@from` derives a parent's column, or an aggregate over children, onto a row

**In depth:** [Relations § @@relator](../../relations.md#relator--can-this-relationship-happen-twice), [§ @from](../../relations.md#from--derived-relation-fields), [Schema § Exclusive foreign keys](../../schema.md#exclusive-foreign-keys-arc), [§ @minItems / @maxItems on a relation](../../schema.md#minitems--maxitems-on-a-relation--how-many-children)
