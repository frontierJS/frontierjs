# Policies across relations

A row policy can lean on a related model. `check(parent)` says whatever the parent's policy decides, decide that here, so a child's access follows its parent's.

```lite
model User { id Int @id  @@auth }

model App {
  id      Int      @id
  ownerId Int
  deploys Deploy[]
  @@allow(read, ownerId == auth().id)
}

model Deploy {
  id    Int @id
  app   App @relation(fields: [appId], references: [id])
  appId Int
  @@allow(read, check(app))
}
```

```js
const sys = db.asSystem()
await sys.app.create({ data: { id: 1, ownerId: 1 } })
await sys.deploy.create({ data: { id: 1, appId: 1 } })

const owner = await db.$setAuth({ id: 1 }).deploy.findMany()
const other = await db.$setAuth({ id: 2 }).deploy.findMany()
if (owner.length !== 1 || other.length !== 0) throw new Error('deploys should follow their app')
```

It compiles to one correlated subquery, so the rule is evaluated inside SQLite with the read.

## What else it can do

- `check(parent, 'update')` asks the parent for a named operation instead of the rule's own
- `!check(parent, ...)` is the exact complement, and a field `@allow(write, check(...))` takes one too
- `relation.column` names a column one relation away: `@@allow(read, order.userId == auth().id)`
- `relation.some(condition)` asks whether any child row matches: `members.some(userId == auth().id)`
- `this.col` inside a `.some(...)` names a column of the row the rule is declared on
- `@@require` states a rule about the data that holds for every writer, `asSystem()` included
- An `include` applies the target's policy, so children, counts and gated models follow their own rules
- One hop only: a longer path is refused at parse, naming the rule
- A cycle of delegations is refused at startup

**In depth:** [Access control § Reaching a model through `include`](../../access-control.md#reaching-a-model-through-include), [§ Delegating to another model](../../access-control.md#delegating-to-another-model--checkfield), [§ `relation.column`](../../access-control.md#naming-a-column-one-relation-away--relationcolumn), [§ `relation.some`](../../access-control.md#any-row-of-a-to-many--relationsomecondition), [§ `@@require`](../../access-control.md#a-rule-about-the-data-for-every-writer--require)
