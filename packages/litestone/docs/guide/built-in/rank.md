# Rank

`@rank` is a position a person drags, such as a card in a column. The value is a short fractional key, so a row can always be placed between two neighbors by writing that one row.

```lite
model Issue {
  id      Int    @id
  title   String
  stateId Int
  rank    String @rank(scope: stateId)

  @@index([stateId, rank])
}
```

```js
import { between } from '@frontierjs/toolbelt/rank'

const a = await db.issue.create({ data: { id: 1, title: 'First',  stateId: 1 } })
const b = await db.issue.create({ data: { id: 2, title: 'Second', stateId: 1 } })
await db.issue.create({ data: { id: 3, title: 'Dragged', stateId: 2 } })

await db.issue.update({ where: { id: 3 }, data: { stateId: 1, rank: between(a.rank, b.rank) } })

const list = await db.issue.findMany({ where: { stateId: 1 }, orderBy: { rank: 'asc' } })
if (list.map(i => i.id).join() !== '1,3,2') throw new Error(`expected 1,3,2 got ${list.map(i => i.id)}`)
```

A create with no key lands at the end of its scope.

## What else it can do

- `scope: [workspaceId, parentId]` takes a list, and a null `parentId` is one shared scope for a tree's top level
- `jittered(a, b)` mints a key at a random point in the gap, so two simultaneous drops rarely collide
- `rebalance({ where })` rewrites a scope's keys evenly spaced, keeping the order
- A read sorted by the rank breaks ties on the primary key
- Moving a row to another scope without stating `rank` puts it at the end of the new one
- A key you state must be one the toolbelt could mint, or it is refused
- `updateMany` cannot move rows between scopes without stating `rank`
- The `@@index` over scope and rank is yours to declare

**In depth:** [Rank](../../rank.md), [§ Minting a key yourself](../../rank.md#minting-a-key-yourself), [§ Rebalancing](../../rank.md#rebalancing), [§ The scope](../../rank.md#the-scope)
